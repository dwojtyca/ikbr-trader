import type { BoundClaim, BoundDecision, BoundReviewStore, DeliveryOutcome } from "./bound-review-repository.js";
import type { ResearchReviewStore, ModelReservation } from "./research-review-repository.js";
import { buildResearchModelRequest, validateResearchModelDecision, type ResearchModelRequest, type ResearchModelResult } from "./research-decision.js";
import { validateResearchOrderContext, type ResearchOrderContextV1 } from "@ikbr/shared/instrument-research";

interface BoundWorkerDependencies {
  assertEntryAllowed?: () => Promise<void>;
  repository: BoundReviewStore & Partial<ResearchReviewStore>;
  execution: {
    getAiContext?(id: number): Promise<unknown>;
    executeBoundProposed(id: number): Promise<DeliveryOutcome>;
  };
  researchDecider?: { isConfigured(): boolean; decide(request: ResearchModelRequest, signal: AbortSignal): Promise<ResearchModelResult> };
  model: string;
  promptVersion: string;

}

export class BoundReviewWorker {
  constructor(private readonly deps: BoundWorkerDependencies) {}
  async pollOnce(): Promise<boolean> {
    await this.deps.assertEntryAllowed?.();
    const claim = await this.deps.repository.claim();
    if (!claim) return false;
    const decision = await this.evaluate(claim);
    await this.deps.assertEntryAllowed?.();
    const mayDeliver = await this.deps.repository.finalize(claim, decision);
    if (mayDeliver) {
      await this.deps.assertEntryAllowed?.();
      let outcome: DeliveryOutcome = "UNKNOWN";
      try { outcome = await this.deps.execution.executeBoundProposed(claim.order.id); } catch { /* durable delivery marker forbids retry */ }
      await this.deps.repository.recordDelivery(claim, outcome);
    }
    return true;
  }
  private async evaluate(claim: BoundClaim): Promise<BoundDecision> {
    const started = Date.now();
    let request: ResearchModelRequest | undefined;
    let reservation: ModelReservation | undefined;
    const reject = (reason: string): BoundDecision => ({ decision: "REJECT", confidence: 0, reason,
      model: request?.model ?? this.deps.model, promptVersion: request?.promptVersion ?? this.deps.promptVersion,
      outputSchemaVersion: request?.outputSchemaVersion, riskFlags: [reason], evidenceRefs: [],
      context: request?.context ?? { identity: claim.identity, coverage: "UNAVAILABLE" },
      ...(reservation ? { contextHash: reservation.requestHash, research: request!.context.research.binding,
        timings: { startedAt: reservation.startedAt, completedAt: new Date().toISOString(), latencyMs: Date.now() - Date.parse(reservation.startedAt), outcome: reason } } : {}) });
    const repository = this.deps.repository;
    if (!repository.prepareResearch || !repository.reserveModel || !repository.recordModelOutcome || !this.deps.execution.getAiContext)
      return reject("RESEARCH_UNAVAILABLE");
    if (claim.order.riskCheckStatus !== "PASS") return reject("RISK_NOT_PASS");
    if (!this.deps.researchDecider?.isConfigured()) return reject("AI_NOT_CONFIGURED");
    try {
      await this.deps.assertEntryAllowed?.();
      const research = await repository.prepareResearch(claim);
      const raw = await bounded(this.deps.execution.getAiContext(claim.order.id), 8000, "AI_CONTEXT_TIMEOUT");
      const identity = { proposedOrderId: claim.order.id, clientOrderHash: claim.identity.clientOrderHash,
        effectiveConfigHash: research.binding.configHash, accountId: claim.identity.accountId, sessionId: claim.identity.sessionId,
        instrumentId: claim.identity.instrumentId, conid: claim.identity.conid };
      const context: ResearchOrderContextV1 = validateResearchOrderContext(raw, identity, Date.now());
      if (Date.now() - started >= 8000) return reject("AI_CONTEXT_TIMEOUT");
      request = buildResearchModelRequest(claim, research, context);
      await this.deps.assertEntryAllowed?.();
      reservation = await repository.reserveModel(claim, request);
      await this.deps.assertEntryAllowed?.();
      const remaining = Date.parse(reservation.deadlineAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        await repository.recordModelOutcome(claim, reservation, { kind: "DEADLINE_BEFORE_SEND", completedAt: new Date().toISOString() });
        return reject("AI_DEADLINE_EXHAUSTED");
      }
      const controller = new AbortController();
      let timedOut = false;
      const pending = this.deps.researchDecider.decide(request, controller.signal);
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
      let result: ResearchModelResult;
      try {
        result = await bounded(pending, remaining, "AI_MODEL_TIMEOUT");
        result.decision = validateResearchModelDecision(result.decision, research);
      } catch {
        controller.abort();
        await repository.recordModelOutcome(claim, reservation, { kind: "UNKNOWN_OR_INVALID", completedAt: new Date().toISOString() });
        const savedReservation = reservation;
        void pending.then(late => {
          if (timedOut) return repository.recordModelOutcome!(claim, savedReservation, { kind: "LATE_RESPONSE", completedAt: new Date().toISOString(), result: late });
        }).catch(() => undefined);
        return reject("AI_UNAVAILABLE_OR_INVALID");
      } finally { clearTimeout(timeout); }
      const completedAt = new Date().toISOString();
      const withinDeadline = Date.parse(completedAt) < Date.parse(reservation.deadlineAt);
      await repository.recordModelOutcome(claim, reservation, { kind: withinDeadline ? "COMPLETED" : "LATE_RESPONSE", completedAt, result });
      if (!withinDeadline) return reject("AI_MODEL_TIMEOUT");
      return { ...result.decision, model: request.model, actualModel: result.actualModel,
        promptVersion: request.promptVersion, outputSchemaVersion: request.outputSchemaVersion,
        context: request.context, contextHash: reservation.requestHash, research: research.binding,
        timings: { startedAt: reservation.startedAt, completedAt, latencyMs: Date.parse(completedAt) - Date.parse(reservation.startedAt), outcome: "COMPLETED" } };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : "RESEARCH_CONTEXT_UNAVAILABLE";
      if (reservation) await repository.recordModelOutcome(claim, reservation, { kind: code, completedAt: new Date().toISOString() });
      return reject(code);
    }
  }
}
async function bounded<T>(work: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
