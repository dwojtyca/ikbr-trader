import type { PoolClient } from 'pg';
import type { ProposedOrder } from '@ikbr/shared';
import { canonicalJson } from '@ikbr/shared/trading-config';
import { researchHash, validateResearchOrderContext, type ResearchStore, type ResearchIdentity } from '@ikbr/shared/instrument-research';
import { aiApprovalFailure, readAiProposalReview } from './ai-proposal-review.js';

export interface ResearchEntryPermit { validUntilMs: number; assertCurrent: () => void }
export type ResearchEntryValidator = (input: {
  db: PoolClient; order: ProposedOrder; clientOrderHash: string; accountId: string; sessionId: string;
}) => Promise<ResearchEntryPermit>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createResearchEntryValidator(options: { store: Pick<ResearchStore, 'validateBinding' | 'assertAuthority'>; loadedIdentity: () => ResearchIdentity | null }): ResearchEntryValidator {
  return async ({ db, order, clientOrderHash, accountId, sessionId }) => {
    const identity = options.loadedIdentity();
    if (!identity || !order.id || !order.instrumentId || !order.strategyAttribution || order.strategyAttribution.effectiveConfigHash !== identity.configHash)
      throw new Error('RESEARCH_ENTRY_IDENTITY_UNAVAILABLE');
    const review = await readAiProposalReview(db, order.id, true);
    const approval = aiApprovalFailure(review, order, clientOrderHash, accountId, sessionId);
    if (approval) throw new Error(approval);
    const authority = await options.store.assertAuthority(identity, db);
    const validated = await options.store.validateBinding({ ...identity, proposalId: order.id, clientOrderHash, instrumentId: order.instrumentId }, db, true);
    const { rows } = await db.query(`SELECT c.*,o.outcome_json,o.received_at,clock_timestamp() AS database_now FROM proposal_ai_model_calls c
      JOIN proposal_ai_model_outcomes o USING(proposed_order_id) WHERE proposed_order_id=$1`, [order.id]);
    const call = rows[0];
    if (!call || !object(call.request_json) || researchHash(call.request_json) !== call.request_hash ||
        call.research_snapshot_id !== validated.binding.snapshotId) throw new Error('RESEARCH_MODEL_REQUEST_INVALID');
    const request = call.request_json, context = request.context;
    const outcome = call.outcome_json;
    if (!object(outcome) || outcome.kind !== 'COMPLETED' || !object(outcome.result) || !object(outcome.result.decision))
      throw new Error('RESEARCH_MODEL_OUTCOME_INVALID');
    const decision = review!.decision_json as unknown as Record<string, unknown>;
    const evidenceRefs = decision.evidenceRefs;
    if (!object(context) || !object(context.research) || !object(context.identity) ||
        canonicalJson(context.research.binding) !== canonicalJson(validated.binding) ||
        canonicalJson(context.research.stored) !== canonicalJson(validated.stored) ||
        canonicalJson(context.research.manifest) !== canonicalJson(validated.manifest) ||
        canonicalJson(decision.research) !== canonicalJson(validated.binding) ||
        canonicalJson(decision.context) !== canonicalJson(context) || decision.contextHash !== call.request_hash ||
        request.schemaVersion !== 'pp4-ai-request-v1' || request.model !== call.model ||
        request.promptVersion !== call.prompt_version || request.outputSchemaVersion !== call.output_schema_version ||
        decision.model !== call.model || decision.promptVersion !== call.prompt_version || decision.outputSchemaVersion !== call.output_schema_version ||
        call.model !== validated.manifest.model.model || call.prompt_version !== validated.manifest.model.promptVersion ||
        call.output_schema_version !== validated.manifest.model.outputSchemaVersion ||
        typeof decision.reason !== 'string' || decision.reason.trim().length < 3 || decision.reason.length > 1400 ||
        !Array.isArray(decision.riskFlags) || decision.riskFlags.length > 30 || decision.riskFlags.some(flag => typeof flag !== 'string' || flag.trim().length < 1 || flag.length > 160) ||
        !Array.isArray(evidenceRefs) || evidenceRefs.length > 200 || evidenceRefs.some(ref => typeof ref !== 'string' || ref.length < 1 || ref.length > 200) ||
        new Set(evidenceRefs).size !== evidenceRefs.length ||
        evidenceRefs.some(ref => !validated.stored.snapshot.evidence.some(evidence => evidence.ref === ref)) ||
        validated.eligibility.requiredEvidenceRefs.some(ref => !evidenceRefs.includes(ref)))
      throw new Error('RESEARCH_DECISION_MEMBERSHIP_INVALID');
    if (canonicalJson({ decision: decision.decision, reason: decision.reason, confidence: decision.confidence,
      riskFlags: decision.riskFlags, evidenceRefs }) !== canonicalJson(outcome.result.decision))
      throw new Error('RESEARCH_MODEL_OUTCOME_MISMATCH');
    const claimIdentity = context.identity;
    if (claimIdentity.clientOrderHash !== clientOrderHash || claimIdentity.instrumentId !== order.instrumentId || claimIdentity.conid !== order.conid ||
        claimIdentity.accountId !== accountId || claimIdentity.sessionId !== sessionId ||
        canonicalJson(claimIdentity.strategyAttribution) !== canonicalJson(order.strategyAttribution) ||
        canonicalJson(claimIdentity.strategyTrigger) !== canonicalJson(order.strategyTrigger)) throw new Error('RESEARCH_CONTEXT_IDENTITY_INVALID');
    const started = new Date(call.started_at).getTime(), deadline = new Date(call.deadline_at).getTime(), now = new Date(call.database_now).getTime();
    const timings = decision.timings;
    if (!Number.isFinite(started) || started > now || !Number.isFinite(deadline) || deadline <= started || deadline - started > 10_000 ||
        !object(timings) || typeof timings.startedAt !== 'string' || typeof timings.completedAt !== 'string' ||
        Date.parse(timings.startedAt) !== started || !Number.isFinite(Date.parse(timings.completedAt)) ||
        timings.completedAt !== outcome.completedAt || timings.latencyMs !== Date.parse(timings.completedAt) - started ||
        Date.parse(timings.completedAt) < started || Date.parse(timings.completedAt) > now || Date.parse(timings.completedAt) >= deadline)
      throw new Error('RESEARCH_DECISION_TIMING_INVALID');
    validateResearchOrderContext(context.orderContext, { proposedOrderId: order.id, clientOrderHash, effectiveConfigHash: identity.configHash,
      accountId, sessionId, instrumentId: order.instrumentId, conid: order.conid! }, started);
    const expires = Date.parse(validated.eligibility.expiresAt ?? '');
    if (!Number.isFinite(expires) || expires <= now) throw new Error('RESEARCH_ENTRY_EXPIRED');
    return { validUntilMs: Math.min(expires, authority.validUntilMs, review!.expires_at.getTime()), assertCurrent: () => {
      if (canonicalJson(options.loadedIdentity()) !== canonicalJson(identity)) throw new Error('RESEARCH_LOCAL_IDENTITY_CHANGED');
    } };
  };
}
