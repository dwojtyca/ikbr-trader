import type { BoundInstrument, SignalTicket } from "@ikbr/shared";
import {
  CloseConflict,
  CloseRepository,
  closeOptions,
} from "./close-repository.js";
import type {
  CloseContext,
  CloseEvaluator,
  CloseLegIdentity,
  CloseOperation,
  ClosePrepared,
  CloseRisk,
  CloseTerminalEvidence,
} from "./close-types.js";
export interface FullCloseDependencies {
  context(instrumentId: string): CloseContext | null;
  refresh(): Promise<void>;
  evaluate: CloseEvaluator;
  assessRisk(
    ticket: SignalTicket,
    bound: BoundInstrument,
    context: CloseContext,
  ): Promise<CloseRisk>;
  prepare(
    ticket: SignalTicket,
    clientOrderId: string,
    originalProposalId: number,
  ): Promise<ClosePrepared>;
  validatePrepared(
    prepared: ClosePrepared,
    ticket: SignalTicket,
    context: CloseContext,
  ): void;
  cancel(
    leg: CloseLegIdentity,
    context: CloseContext,
  ): Promise<CloseTerminalEvidence>;
  dispatch(
    prepared: ClosePrepared,
    operation: CloseOperation,
    context: CloseContext,
  ): Promise<void>;
  alert(operation: CloseOperation, reason: string): Promise<void>;
}
export class FullCloseService {
  constructor(
    readonly repo: CloseRepository,
    readonly deps: FullCloseDependencies,
  ) {}
  get(id: number) {
    return this.repo.get(id);
  }
  private context(instrumentId: string): CloseContext {
    const c = this.deps.context(instrumentId);
    if (!c?.bound || !c.accountId || !c.sessionId)
      throw new CloseConflict("close_broker_context_unavailable");
    return c;
  }
  private unchanged(op: CloseOperation): CloseContext {
    const c = this.context(op.instrumentId);
    if (
      c.accountId !== op.accountId ||
      c.sessionId !== op.sessionId ||
      c.clientId !== op.clientId ||
      c.generation !== op.generation
    )
      throw new CloseConflict("close_connection_changed");
    return c;
  }
  private async alertUnresolved(op: CloseOperation) {
    if (op.failureReason && (await this.repo.claimAlert(op, op.failureReason)))
      await this.deps.alert(op, op.failureReason);
  }
  private async observeAndAlert(op: CloseOperation) {
    const observed = await this.repo.observe(
      op,
      this.context(op.instrumentId),
      this.deps.evaluate,
    );
    await this.alertUnresolved(observed);
    return observed;
  }
  async reconcile(id: number) {
    const op = await this.repo.get(id);
    if (!op) throw new CloseConflict("close_operation_missing");
    if (op.state === "COMPLETED") return op;
    await this.deps.refresh();
    return this.observeAndAlert(op);
  }
  async request(
    id: number,
    requestId: string,
    limitPrice: number,
    actor: string,
  ): Promise<CloseOperation> {
    const prior = await this.repo.get(id);
    if (prior) {
      if (prior.requestId !== requestId || prior.limitPrice !== limitPrice)
        throw new CloseConflict("close_request_conflict");
      return prior;
    }
    const original = await this.repo.execution.getLifecycleEvidence(id, null);
    if (!original?.order.instrumentId)
      throw new CloseConflict("original_proposal_missing");
    const initial = this.context(original.order.instrumentId);
    await this.deps.refresh();
    const fresh = this.context(original.order.instrumentId);
    if (
      initial.accountId !== fresh.accountId ||
      initial.sessionId !== fresh.sessionId ||
      initial.generation !== fresh.generation ||
      initial.clientId !== fresh.clientId
    )
      throw new CloseConflict("close_connection_changed");
    const reserved = await this.repo.reserve(
      id,
      requestId,
      limitPrice,
      actor,
      fresh,
      this.deps.evaluate,
    );
    let op = reserved.operation;
    if (!reserved.created || op.state === "COMPLETED") return op;
    let cancellationInFlight = false;
    try {
      for (const role of ["PARENT", "TP", "SL"] as const) {
        const c = this.unchanged(op);
        const evidence = await this.repo.evidence(op);
        if (!evidence) throw new CloseConflict("original_missing");
        const report = this.deps.evaluate(
          evidence,
          c,
          closeOptions(op, "cancelling"),
        );
        if (!report.ok) throw new CloseConflict(report.reasons.join(","));
        if (report.canComplete)
          return await this.repo.observe(op, c, this.deps.evaluate);
        const leg = report.legs.find((v) => v.role === role);
        if (!leg) throw new CloseConflict("original_leg_missing");
        if (!leg.working) continue;
        await this.repo.markCancel(
          op,
          leg,
          this.unchanged(op),
          this.deps.evaluate,
        );
        cancellationInFlight = true;
        const terminal = await this.deps.cancel(leg, this.unchanged(op));
        this.unchanged(op);
        await this.repo.recordTerminal(op, terminal);
        cancellationInFlight = false;
        op = (await this.repo.get(id))!;
        await this.deps.refresh();
        this.unchanged(op);
      }
      // Even if all original legs were filled, capture starts after the cancellation loop.
      await this.deps.refresh();
      const c = this.unchanged(op);
      const evidence = await this.repo.evidence(op);
      if (!evidence) throw new CloseConflict("original_missing");
      const report = this.deps.evaluate(
        evidence,
        c,
        closeOptions(op, "after_cancel"),
      );
      if (report.ok && report.canComplete)
        return await this.repo.observe(op, c, this.deps.evaluate);
      if (!report.ok || !report.allTerminal || report.quantity !== 1)
        throw new CloseConflict(
          report.reasons.join(",") || "close_not_authorized",
        );
      const ticket: SignalTicket = {
        instrument: evidence.order.instrument,
        instrumentId: op.instrumentId,
        conid: op.conid,
        side: "SELL",
        positionEffect: "CLOSE_OR_REDUCE",
        orderType: "LMT",
        quantity: 1,
        entry: op.limitPrice,
        reason: `Full close of proposal ${id}; operation ${op.id}`,
        confidence: 1,
        riskCheckStatus: "PASS",
        timestamp: new Date().toISOString(),
      };
      const firstRisk = await this.deps.assessRisk(ticket, c.bound!, c);
      if (!firstRisk.ok) throw new CloseConflict(firstRisk.reasons.join(","));
      const prepared = await this.deps.prepare(
        ticket,
        `close-${op.requestId}`,
        op.originalProposalId,
      );
      this.deps.validatePrepared(prepared, ticket, this.unchanged(op));
      await this.deps.refresh();
      const claimContext = this.unchanged(op);
      const risk = await this.deps.assessRisk(
        ticket,
        claimContext.bound!,
        claimContext,
      );
      op = await this.repo.claim(
        op,
        ticket,
        prepared,
        risk,
        claimContext,
        this.deps.evaluate,
        () => this.deps.validatePrepared(prepared, ticket, this.unchanged(op)),
      );
      await this.deps.dispatch(prepared, op, this.unchanged(op));
      op = await this.repo.submitted(op);
      await this.deps.refresh();
      return await this.observeAndAlert(op);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Read committed state because a DB/network error may follow a successful claim commit.
      const durable = await this.repo.get(id);
      if (durable) op = durable;
      op = await this.repo.block(
        op,
        op.submissionAttemptedAt
          ? "SUBMISSION_UNKNOWN"
          : cancellationInFlight
            ? "CANCEL_UNKNOWN"
            : "BLOCKED",
        reason,
      );
      await this.alertUnresolved(op);
      try {
        await this.deps.refresh();
        op = await this.repo.observe(
          op,
          this.context(op.instrumentId),
          this.deps.evaluate,
        );
      } catch {
        /* The durable reservation remains until authoritative observation succeeds. */
      }
      return op;
    }
  }
}
