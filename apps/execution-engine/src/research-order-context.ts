import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { BoundInstrument, ProposedOrder } from '@ikbr/shared';
import { validateResearchOrderContext, type ResearchOrderContextV1 } from '@ikbr/shared/instrument-research';
import type { AccountSnapshot } from './tws-execution-client.js';
import type { AiEntryRiskEvidence } from './ai-entry-risk.js';
import { validatePersistedOrderIdentity, type ExecutionRepository } from './repository.js';
import { deriveCompletenessFlags, type BrokerReconciliationSnapshot } from './reconciliation/broker-adapter.js';

export interface ContextReconciliation {
  id: number; account_id: string; session_id: string; status: string; started_at: Date; completed_at: Date | null;
  snapshot_complete: boolean; broker_snapshot: BrokerReconciliationSnapshot | null;
  position_generation: number; current_position_generation: number; position_complete: boolean;
  position_session_id: string;
}

export function buildResearchOrderContext(input: {
  order: ProposedOrder; clientOrderHash: string; effectiveConfigHash: string;
  accountId: string; sessionId: string; connectionGeneration: number;
  requestedAt: string; nowMs: number; snapshot: AccountSnapshot;
  risk: AiEntryRiskEvidence; reconciliation: ContextReconciliation | null;
}): ResearchOrderContextV1 {
  const { order, risk, snapshot, reconciliation: recon } = input;
  if (!order.id || order.status !== 'PROPOSED' || order.executionAttemptedAt || order.brokerOrderId ||
      !order.strategyAttribution || order.strategyAttribution.effectiveConfigHash !== input.effectiveConfigHash ||
      !validatePersistedOrderIdentity(order, input.clientOrderHash).ok ||
      order.riskCheckStatus !== 'PASS' || !order.instrumentId || !order.conid ||
      order.positionEffect === 'CLOSE_OR_REDUCE') throw new Error('RESEARCH_CONTEXT_PROPOSAL_INVALID');
  if (input.nowMs - Date.parse(input.requestedAt) > 8_000) throw new Error('RESEARCH_CONTEXT_PREPARATION_TIMEOUT');
  const account = snapshot.riskEvidence, broker = recon?.broker_snapshot;
  if (!account || account.complete !== true || snapshot.accountId !== input.accountId || account.connectionGeneration !== input.connectionGeneration ||
      !recon || !broker || !recon.snapshot_complete || !['CLEAN', 'MISMATCH'].includes(recon.status) || !recon.completed_at ||
      recon.account_id !== input.accountId || recon.session_id !== input.sessionId ||
      !recon.position_complete || recon.position_session_id !== input.sessionId || Number(recon.position_generation) !== Number(recon.current_position_generation) ||
      broker.accountId !== input.accountId || broker.sessionId !== input.sessionId || broker.connectionGeneration !== input.connectionGeneration ||
      !broker.sourceCoverage || !broker.exposureComplete || !broker.recoveryComplete ||
      !deriveCompletenessFlags(broker.sourceCoverage).recoveryComplete ||
      Object.values(broker.sourceCoverage).some(source => source.timedOut) ||
      broker.sourceCoverage.positions.count !== broker.positions.length || broker.sourceCoverage.openOrders.count !== broker.openOrders.length)
    throw new Error('RESEARCH_CONTEXT_BROKER_COVERAGE_UNAVAILABLE');
  if (risk.strategyEffectiveConfigHash !== input.effectiveConfigHash || !risk.quoteFeeReserve ||
      risk.accountRequestStartedAt !== account.requestStartedAt || risk.accountCompletedAt !== account.completedAt ||
      risk.dailyLossEvidence?.reconciliationRunId !== Number(recon.id) || risk.dailyLossEvidence?.positionGeneration !== Number(recon.position_generation))
    throw new Error('RESEARCH_CONTEXT_RISK_GENERATION_MISMATCH');
  const capturedAt = new Date(broker.capturedAt).toISOString();
  const oldest = Math.min(Date.parse(input.requestedAt), recon.started_at.getTime(), Date.parse(capturedAt));
  const context: ResearchOrderContextV1 = {
    schemaVersion: 1, proposedOrderId: order.id, clientOrderHash: input.clientOrderHash, effectiveConfigHash: input.effectiveConfigHash,
    accountId: input.accountId, sessionId: input.sessionId, instrumentId: order.instrumentId, conid: order.conid,
    requestedAt: input.requestedAt, completedAt: new Date(input.nowMs).toISOString(),
    validUntilMs: Math.min(risk.validUntilMs, oldest + 10_000), connectionGeneration: input.connectionGeneration,
    reconciliation: { runId: Number(recon.id), positionGeneration: Number(recon.position_generation), complete: true,
      requestStartedAt: recon.started_at.toISOString(), completedAt: recon.completed_at.toISOString(), capturedAt,
      positions: broker.positions, openOrders: broker.openOrders },
    account: { requestStartedAt: account.requestStartedAt, completedAt: account.completedAt,
      configuredBaseCurrency: account.configuredBaseCurrency, cashByCurrency: account.cashByCurrency ?? {},
      exchangeRatesToBase: account.exchangeRatesToBase ?? {}, usdMetrics: { netLiquidation: risk.netLiquidation,
        availableFunds: risk.availableFunds, grossPositionValue: risk.grossPositionValue } },
    quote: { bid: risk.bid, ask: risk.ask, bidObservedAt: risk.bidObservedAt, askObservedAt: risk.askObservedAt },
    valuation: { quoteCurrency: risk.quoteCurrency, valuationCurrency: risk.valuationCurrency, quoteNotional: risk.quoteNotional,
      quoteStopRisk: risk.quoteStopRisk, fxToUsd: risk.fxToUsd, fxSource: risk.fxSource, fxValuationBuffer: risk.fxValuationBuffer },
    fees: { currency: risk.quoteCurrency, reserve: risk.quoteFeeReserve, source: 'configured_risk_reserve', estimateStatus: 'UNAVAILABLE' },
    risk: { ok: true, evidence: { ...risk } },
  };
  return validateResearchOrderContext(context, context, input.nowMs);
}

export async function readContextReconciliation(pool: Pool, accountId: string): Promise<ContextReconciliation | null> {
  const { rows } = await pool.query<ContextReconciliation>(`SELECT r.*,s.generation AS current_position_generation,
    s.complete AS position_complete,s.session_id AS position_session_id
    FROM reconciliation_runs r LEFT JOIN broker_snapshot_syncs s ON s.account_id=r.account_id
    WHERE r.account_id=$1 ORDER BY r.started_at DESC,r.id DESC LIMIT 1`, [accountId]);
  return rows[0] ?? null;
}

export function registerResearchOrderContextRoute(app: FastifyInstance, deps: {
  repo: Pick<ExecutionRepository, 'getExecutableProposedById'>;
  prepare: (order: ProposedOrder) => Promise<Omit<Parameters<typeof buildResearchOrderContext>[0], 'order' | 'clientOrderHash' | 'requestedAt' | 'nowMs'>>;
}) {
  app.get<{ Params: { id: string } }>('/execution/proposals/:id/ai-context', async (request, reply) => {
    const id = Number(request.params.id);
    if (!/^[1-9]\d*$/.test(request.params.id) || !Number.isSafeInteger(id)) return reply.code(400).send({ error: 'invalid_proposal_id' });
    const requestedAt = new Date().toISOString();
    const record = await deps.repo.getExecutableProposedById(id);
    if (!record) return reply.code(404).send({ error: 'proposal_not_found' });
    if (!record.clientOrderHash) return reply.code(409).send({ error: 'RESEARCH_CONTEXT_PROPOSAL_INVALID' });
    try {
      const prepared = await deps.prepare(record.order);
      const context = buildResearchOrderContext({ ...prepared, order: record.order, clientOrderHash: record.clientOrderHash, requestedAt, nowMs: Date.now() });
      return context;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : 'RESEARCH_CONTEXT_UNAVAILABLE' });
    }
  });
}

export type FreshAiRiskResult = { ok: true; evidence: AiEntryRiskEvidence; snapshot: AccountSnapshot } | { ok: false; reason: string };
export type FreshAiRiskReader = (order: ProposedOrder, bound: BoundInstrument, accountId: string, sessionId: string) => Promise<FreshAiRiskResult>;
