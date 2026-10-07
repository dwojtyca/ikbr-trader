import type { Pool, PoolClient } from "pg";
import { ResearchStore, researchHash, validateResearchOrderContext, validateResearchAiRequest, type ValidatedResearchBinding, type ResearchManifest } from "@ikbr/shared/instrument-research";
import { canonicalJson } from "@ikbr/shared/trading-config";
import { BoundReviewRepository, type BoundClaim, type BoundDecision, type BoundReviewStore } from "./bound-review-repository.js";
import { validateResearchModelDecision, type ResearchModelRequest, type ResearchModelResult } from "./research-decision.js";

export interface ModelReservation { startedAt: string; deadlineAt: string; requestHash: string; callKey: string }
export interface ResearchReviewStore extends BoundReviewStore {
  prepareResearch(claim: BoundClaim): Promise<ValidatedResearchBinding>;
  reserveModel(claim: BoundClaim, request: ResearchModelRequest): Promise<ModelReservation>;
  recordModelOutcome(claim: BoundClaim, reservation: ModelReservation, outcome: { kind: string; completedAt: string; result?: ResearchModelResult }): Promise<void>;
}

export class ResearchBoundReviewRepository extends BoundReviewRepository implements ResearchReviewStore {
  private readonly researchStore: ResearchStore;
  constructor(pool: Pool, private readonly research: { manifest: ResearchManifest; hash: string } | null) {
    super(pool, { effectiveConfigHash: research?.manifest.configHash });
    this.researchStore = new ResearchStore(pool);
  }
  private identity(claim: BoundClaim) {
    if (!this.research || claim.identity.strategyAttribution?.effectiveConfigHash !== this.research.manifest.configHash)
      throw new Error("RESEARCH_CONFIGURATION_UNAVAILABLE");
    return { proposalId: claim.order.id, clientOrderHash: claim.identity.clientOrderHash, instrumentId: claim.identity.instrumentId,
      configHash: this.research.manifest.configHash, manifestHash: this.research.hash };
  }
  private async lockClaim(client: PoolClient, claim: BoundClaim) {
    const proposal = await client.query("SELECT * FROM proposed_orders WHERE id=$1 FOR UPDATE", [claim.order.id]);
    const row = proposal.rows[0];
    if (!row || row.status !== "PROPOSED" || row.execution_attempted_at || row.broker_order_id || row.client_order_hash !== claim.identity.clientOrderHash)
      throw new Error("AI_CLAIM_INVALID");
    await this.validateStrategyIdentity(client, row);
    const result = await client.query(`SELECT *,clock_timestamp() AS now FROM proposal_ai_reviews
      WHERE proposed_order_id=$1 AND claim_token=$2 AND status='PENDING'
      AND claim_until>clock_timestamp() AND expires_at>clock_timestamp() AND delivery_started_at IS NULL FOR UPDATE`, [claim.order.id, claim.token]);
    if (!result.rows[0]) throw new Error("AI_CLAIM_EXPIRED");
    const review = result.rows[0];
    if (review.account_id !== claim.identity.accountId || review.session_id !== claim.identity.sessionId ||
      review.conid !== claim.identity.conid || review.instrument_id !== claim.identity.instrumentId || review.client_order_hash !== claim.identity.clientOrderHash)
      throw new Error("AI_CLAIM_IDENTITY_MISMATCH");
    return review;
  }
  async prepareResearch(claim: BoundClaim): Promise<ValidatedResearchBinding> {
    return this.transaction(async client => {
      await this.lockClaim(client, claim);
      const identity = this.identity(claim);
      await this.researchStore.bind(identity, client);
      return this.researchStore.validateBinding(identity, client, true);
    });
  }
  async reserveModel(claim: BoundClaim, request: ResearchModelRequest): Promise<ModelReservation> {
    return this.transaction(async client => {
      const review = await this.lockClaim(client, claim);
      const identity = this.identity(claim);
      const validated = await this.researchStore.validateBinding(identity, client, true);
      if (canonicalJson(validated) !== canonicalJson(request.context.research) || canonicalJson(request.context.identity) !== canonicalJson(claim.identity))
        throw new Error("AI_CONTEXT_RESEARCH_MISMATCH");
      const nowMs = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
      validateResearchOrderContext(request.context.orderContext, { proposedOrderId: claim.order.id,
        clientOrderHash: identity.clientOrderHash, effectiveConfigHash: identity.configHash, accountId: claim.identity.accountId,
        sessionId: claim.identity.sessionId, instrumentId: identity.instrumentId, conid: claim.identity.conid }, nowMs);
      const model = validated.manifest.model;
      validateResearchAiRequest(request as unknown as Record<string, unknown>, model);
      const deadlineMs = Math.min(nowMs + 10_000, review.claim_until.getTime() - 1000, review.expires_at.getTime() - 1000);
      if (deadlineMs <= nowMs + 100) throw new Error("AI_DEADLINE_EXHAUSTED");
      const requestHash = researchHash(request), callKey = `model:proposal:${claim.order.id}`;
      const reserved = await this.researchStore.reserveCall({ ...identity, accountId: claim.identity.accountId, provider: model.provider, kind: "model",
        callKey, requestHash, reservedCostMicros: model.maxCostMicrosPerCall, maxRequestsPerDay: model.maxRequestsPerDay,
        maxCostMicrosPerDay: model.maxCostMicrosPerDay, deadlineAt: new Date(deadlineMs).toISOString() }, client);
      const startedAt = Date.parse(reserved.reservedAt);
      validateResearchOrderContext(request.context.orderContext, { proposedOrderId: claim.order.id,
        clientOrderHash: identity.clientOrderHash, effectiveConfigHash: identity.configHash, accountId: claim.identity.accountId,
        sessionId: claim.identity.sessionId, instrumentId: identity.instrumentId, conid: claim.identity.conid }, startedAt);
      if (startedAt >= Math.min(review.claim_until.getTime(), review.expires_at.getTime(), Date.parse(validated.eligibility.expiresAt!)))
        throw new Error("AI_DEADLINE_EXHAUSTED");
      const result = await client.query(`INSERT INTO proposal_ai_model_calls
        (proposed_order_id,claim_token,call_key,request_json,request_hash,research_snapshot_id,model,prompt_version,output_schema_version,started_at,deadline_at)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11) RETURNING started_at,deadline_at`,
        [claim.order.id, claim.token, callKey, JSON.stringify(request), requestHash, validated.binding.snapshotId, model.model,
          model.promptVersion, model.outputSchemaVersion, new Date(startedAt), new Date(deadlineMs)]);
      return { requestHash, callKey, startedAt: result.rows[0].started_at.toISOString(), deadlineAt: result.rows[0].deadline_at.toISOString() };
    });
  }
  async recordModelOutcome(claim: BoundClaim, reservation: ModelReservation, outcome: { kind: string; completedAt: string; result?: ResearchModelResult }): Promise<void> {
    await this.transaction(async client => {
      const call = (await client.query(`SELECT * FROM proposal_ai_model_calls
        WHERE proposed_order_id=$1 AND claim_token=$2 AND request_hash=$3 AND call_key=$4 FOR UPDATE`,
      [claim.order.id, claim.token, reservation.requestHash, reservation.callKey])).rows[0];
      if (!call) throw new Error("AI_OUTCOME_RESERVATION_MISMATCH");
      const saved = await client.query(`INSERT INTO proposal_ai_model_outcomes(proposed_order_id,outcome_json)
        VALUES($1,$2::jsonb) ON CONFLICT(proposed_order_id) DO NOTHING RETURNING proposed_order_id`,
      [claim.order.id, JSON.stringify(outcome)]);
      if (saved.rowCount) {
        await this.researchStore.recordCallOutcome(reservation.callKey, outcome.kind === "COMPLETED" ? "SUCCEEDED" : "UNKNOWN", client);
      } else {
        await client.query(`INSERT INTO proposal_ai_model_late_outcomes(proposed_order_id,outcome_hash,outcome_json)
          VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [claim.order.id, researchHash(outcome), JSON.stringify(outcome)]);
      }
    });
  }
  protected override async validateDecision(client: PoolClient, claim: BoundClaim, decision: BoundDecision): Promise<boolean> {
    if (decision.decision === "REJECT") return true;
    try {
      const validated = await this.researchStore.validateBinding(this.identity(claim), client, true);
      const result = await client.query(`SELECT c.*,o.outcome_json,clock_timestamp() AS now FROM proposal_ai_model_calls c
        JOIN proposal_ai_model_outcomes o USING(proposed_order_id) WHERE c.proposed_order_id=$1 AND c.claim_token=$2`, [claim.order.id,claim.token]);
      const call = result.rows[0];
      if (!decision.timings || !call || call.outcome_json.kind !== "COMPLETED" || decision.contextHash !== call.request_hash || researchHash(call.request_json) !== call.request_hash ||
          canonicalJson(decision.context) !== canonicalJson(call.request_json.context) || canonicalJson(decision.research) !== canonicalJson(validated.binding) ||
          canonicalJson(call.request_json.context.research.stored) !== canonicalJson(validated.stored) ||
          decision.model !== call.model || decision.promptVersion !== call.prompt_version || decision.outputSchemaVersion !== call.output_schema_version ||
          decision.timings?.startedAt !== call.started_at.toISOString() || decision.timings.completedAt !== call.outcome_json.completedAt ||
          Date.parse(decision.timings.completedAt) >= call.deadline_at.getTime() || Date.parse(decision.timings.completedAt) < call.started_at.getTime() ||
          decision.timings.latencyMs !== Date.parse(decision.timings.completedAt) - call.started_at.getTime()) return false;
      const normalized = validateResearchModelDecision({ decision: decision.decision, reason: decision.reason, confidence: decision.confidence,
        riskFlags: decision.riskFlags, evidenceRefs: decision.evidenceRefs }, validated);
      if (canonicalJson(normalized) !== canonicalJson(call.outcome_json.result.decision)) return false;
      return true;
    } catch { return false; }
  }
  protected override async expire(client: PoolClient): Promise<void> {
    const rows = await client.query(`SELECT p.id,c.call_key FROM proposed_orders p JOIN proposal_ai_reviews r ON r.proposed_order_id=p.id
      JOIN proposal_ai_model_calls c ON c.proposed_order_id=p.id
      WHERE p.status='PROPOSED' AND p.execution_attempted_at IS NULL AND p.broker_order_id IS NULL AND r.status='PENDING'
      AND (r.claim_until<=clock_timestamp() OR r.expires_at<=clock_timestamp() OR c.deadline_at<=clock_timestamp()) ORDER BY p.id FOR UPDATE OF p SKIP LOCKED`);
    for (const row of rows.rows) {
      await client.query("SELECT proposed_order_id FROM proposal_ai_model_calls WHERE proposed_order_id=$1 FOR UPDATE", [row.id]);
      await client.query("UPDATE proposal_ai_reviews SET status='EXPIRED' WHERE proposed_order_id=$1 AND status='PENDING'",[row.id]);
      await client.query("UPDATE proposed_orders SET status='EXPIRED',last_error='ai_model_call_expired_no_retry' WHERE id=$1",[row.id]);
      const saved = await client.query(`INSERT INTO proposal_ai_model_outcomes(proposed_order_id,outcome_json)
        VALUES($1,jsonb_build_object('kind','LEASE_OR_DEADLINE_EXPIRED','completedAt',clock_timestamp()))
        ON CONFLICT(proposed_order_id) DO NOTHING RETURNING proposed_order_id`, [row.id]);
      if (saved.rowCount) await this.researchStore.recordCallOutcome(row.call_key, "UNKNOWN", client);
    }
    await super.expire(client);
  }
}
