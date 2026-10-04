/** Broker-derived, read-only entry context; never a display account summary. */
export interface ResearchOrderContextV1 {
  schemaVersion: 1;
  proposedOrderId: number;
  clientOrderHash: string;
  effectiveConfigHash: string;
  accountId: string;
  sessionId: string;
  instrumentId: string;
  conid: string;
  requestedAt: string;
  completedAt: string;
  validUntilMs: number;
  connectionGeneration: number;
  reconciliation: {
    runId: number; positionGeneration: number; requestStartedAt: string; completedAt: string;
    capturedAt: string; complete: true;
    positions: readonly { accountId: string; conId?: string | null; symbol: string; position: number; currency?: string | null; averageCost?: number | null; marketValue?: number | null }[];
    openOrders: readonly { accountId?: string | null; brokerOrderId: string | null; conId?: string | null; symbol?: string | null; status: string; currency?: string | null; action?: string | null; remaining?: number | null; filled?: number | null }[];
  };
  account: {
    requestStartedAt: string; completedAt: string; configuredBaseCurrency: string;
    cashByCurrency: Record<string, number>; exchangeRatesToBase: Record<string, number>;
    usdMetrics: { netLiquidation: number; availableFunds: number; grossPositionValue: number };
  };
  quote: { bid: number; ask: number; bidObservedAt: string; askObservedAt: string };
  valuation: { quoteCurrency: 'USD' | 'PLN'; valuationCurrency: 'USD'; quoteNotional: number;
    quoteStopRisk: number; fxToUsd: number; fxSource: 'same_currency' | 'ib_account_exchange_rate'; fxValuationBuffer: number };
  fees: { currency: 'USD' | 'PLN'; reserve: number; source: 'configured_risk_reserve'; estimateStatus: 'UNAVAILABLE' };
  risk: { ok: true; evidence: Record<string, unknown> & { accountId: string; sessionId: string;
    instrumentId: string; conid: string; assessedAtMs: number; validUntilMs: number } };
}

export interface ResearchOrderContextIdentity {
  proposedOrderId: number; clientOrderHash: string; effectiveConfigHash: string;
  accountId: string; sessionId: string; instrumentId: string; conid: string;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function validateResearchOrderContext(raw: unknown, identity: ResearchOrderContextIdentity, nowMs: number): ResearchOrderContextV1 {
  const fail = (): never => { throw new Error('RESEARCH_ORDER_CONTEXT_INVALID_OR_STALE'); };
  if (!object(raw) || raw.schemaVersion !== 1 || !Number.isFinite(nowMs)) return fail();
  for (const key of ['proposedOrderId', 'clientOrderHash', 'effectiveConfigHash', 'accountId', 'sessionId', 'instrumentId', 'conid'] as const) if (raw[key] !== identity[key]) return fail();
  if (['accountId', 'sessionId', 'instrumentId', 'conid'].some(key => typeof raw[key] !== 'string' || !(raw[key] as string).trim()) ||
      !/^[1-9]\d*$/.test(String(raw.conid))) return fail();
  if (!Number.isSafeInteger(raw.proposedOrderId) || Number(raw.proposedOrderId) <= 0 ||
      !/^[a-f0-9]{64}$/.test(String(raw.clientOrderHash)) || !/^[a-f0-9]{64}$/.test(String(raw.effectiveConfigHash)) ||
      !Number.isSafeInteger(raw.connectionGeneration) || Number(raw.connectionGeneration) < 0) return fail();
  const fresh = (value: unknown): number => {
    if (typeof value !== 'string') return fail();
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value || time > nowMs || nowMs - time >= 10_000) return fail();
    return time;
  };
  const requested = fresh(raw.requestedAt), completed = fresh(raw.completedAt);
  if (requested > completed) return fail();
  const recon = raw.reconciliation, account = raw.account, quote = raw.quote, valuation = raw.valuation, fees = raw.fees, risk = raw.risk;
  if (!object(recon) || !object(account) || !object(quote) || !object(valuation) || !object(fees) || !object(risk) || risk.ok !== true || !object(risk.evidence)) return fail();
  const evidence = risk.evidence;
  const times = [requested, completed, fresh(recon.requestStartedAt), fresh(recon.completedAt), fresh(recon.capturedAt),
    fresh(account.requestStartedAt), fresh(account.completedAt), fresh(quote.bidObservedAt), fresh(quote.askObservedAt)];
  if (times[2] > times[4] || times[4] > times[3] || times[5] > times[6] ||
      recon.complete !== true || !Number.isSafeInteger(recon.runId) || Number(recon.runId) <= 0 ||
      !Number.isSafeInteger(recon.positionGeneration) || Number(recon.positionGeneration) < 0 ||
      !Array.isArray(recon.positions) || !Array.isArray(recon.openOrders)) return fail();
  for (const position of recon.positions) if (!object(position) || position.accountId !== identity.accountId ||
    typeof position.symbol !== 'string' || !position.symbol || typeof position.conId !== 'string' || !/^\d+$/.test(position.conId) ||
    typeof position.position !== 'number' || !Number.isFinite(position.position)) return fail();
  for (const order of recon.openOrders) if (!object(order) || order.accountId !== identity.accountId || typeof order.brokerOrderId !== 'string' ||
    !order.brokerOrderId || typeof order.conId !== 'string' || !/^\d+$/.test(order.conId) || typeof order.status !== 'string' || !order.status) return fail();
  for (const key of ['accountId', 'sessionId', 'instrumentId', 'conid'] as const) if (evidence[key] !== identity[key]) return fail();
  if (!positive(evidence.validUntilMs) || evidence.validUntilMs <= nowMs || typeof evidence.assessedAtMs !== 'number' || !Number.isFinite(evidence.assessedAtMs) ||
      evidence.assessedAtMs > nowMs || nowMs - evidence.assessedAtMs >= 10_000 ||
      !positive(raw.validUntilMs) || raw.validUntilMs <= nowMs || raw.validUntilMs > Math.min(...times) + 10_000 ||
      raw.validUntilMs > evidence.validUntilMs) return fail();
  if (!positive(quote.bid) || !positive(quote.ask) || quote.ask < quote.bid || account.configuredBaseCurrency !== 'USD' ||
      !object(account.usdMetrics) || !positive(account.usdMetrics.netLiquidation) || !nonnegative(account.usdMetrics.availableFunds) ||
      !nonnegative(account.usdMetrics.grossPositionValue) || !object(account.cashByCurrency) || !object(account.exchangeRatesToBase)) return fail();
  if (Object.values(account.cashByCurrency).some(value => typeof value !== 'number' || !Number.isFinite(value)) ||
      Object.values(account.exchangeRatesToBase).some(value => !positive(value))) return fail();
  if (!['USD', 'PLN'].includes(String(valuation.quoteCurrency)) || valuation.valuationCurrency !== 'USD' ||
      !positive(valuation.quoteNotional) || !positive(valuation.quoteStopRisk) || !positive(valuation.fxToUsd) || !positive(valuation.fxValuationBuffer) ||
      (valuation.quoteCurrency === 'USD' ? valuation.fxSource !== 'same_currency' || valuation.fxToUsd !== 1 :
        valuation.fxSource !== 'ib_account_exchange_rate' || account.exchangeRatesToBase.PLN !== valuation.fxToUsd || account.exchangeRatesToBase.USD !== 1) ||
      fees.currency !== valuation.quoteCurrency || !positive(fees.reserve) || fees.source !== 'configured_risk_reserve' || fees.estimateStatus !== 'UNAVAILABLE') return fail();
  return raw as unknown as ResearchOrderContextV1;
}
