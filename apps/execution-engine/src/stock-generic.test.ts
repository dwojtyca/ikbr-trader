import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { getSupportedStockCapability, validateStockOrder, parseTradingConfiguration, type ProposedOrder, type StockMarketMetadata } from '@ikbr/shared';
import { buildTradingConfigurationProjection, buildStrategyAttribution, readOriginalStockManagementInstrument, canonicalizeTradingConfiguration, stockMetadataFromObservation } from '@ikbr/shared/trading-config';
import { assessAiEntryRisk } from './ai-entry-risk.js';
import { assessCloseRisk } from './lifecycle/close-risk.js';
import { stockMetadataFixture } from './stock-market-test-fixture.js';
import { paperAccountDate, paperAccountDayStart } from './paper-daily-loss.js';
import { computeClientOrderHash } from '@ikbr/shared/client-order-hash';
import { roundTrip } from './lifecycle/round-trip-test-fixture.js';
import { evaluateRoundTrip } from './lifecycle/round-trip-evidence.js';
import { TwsExecutionClient } from './tws-execution-client.js';
const parsed = parseTradingConfiguration(readFileSync(new URL('../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json', import.meta.url), 'utf8'));
assert.ok(parsed.ok);
const configuration = parsed.configuration;
function fixture(index = 2, nowMs = Date.now()) {
  const row = configuration.instruments[index], bound = buildTradingConfigurationProjection(configuration).authority.getBoundInstrument(row.id)!;
  const attr = buildStrategyAttribution(configuration, row.id, row.strategySelection.instanceIds[0]);
  const iso = (delta = 0) => new Date(nowMs + delta).toISOString();
  const order = { id: 42, instrument: bound.brokerSymbol, instrumentId: bound.instrumentId, conid: String(bound.conId), strategy: attr.implementationId,
    strategyAttribution: attr, strategyTrigger: { version: 1, source: 'evaluation_bucket', timeframe: '1m', observedAt: iso(), bucketStartMs: Math.floor(nowMs / 60000) * 60000 },
    side: 'BUY', orderType: 'LMT', quantity: 1, entry: 100, stop: 99, takeProfit: 102, reason: 'fixture', riskCheckStatus: 'PASS', confidence: .8, timestamp: iso(), status: 'PROPOSED' } as ProposedOrder;
  const accountId = 'paper', sessionId = 'session';
  const stockMetadata = stockMetadataFixture(bound, accountId, nowMs);
  const currency = bound.currency as 'USD' | 'PLN';
  const watchlist = { connected: true, watchlist: [{ instrumentId: bound.instrumentId, symbol: bound.brokerSymbol, conid: order.conid, subscribed: true,
    marketState: { conid: order.conid, ts: iso(), marketDataType: 1, bid: 100, ask: 100, bidObservedAt: iso(-100), askObservedAt: iso(-100) } }] };
  const snapshot = { accountId, retrievedAt: iso(), metrics: {}, totals: { positionsCount: 0, longExposure: 0, shortExposure: 0, grossExposure: 0, netExposure: 0, unrealizedPnL: 0, realizedPnL: 0 }, positions: [], riskEvidence: { requestStartedAt: iso(-100), completedAt: iso(), complete: true as const,
    configuredBaseCurrency: 'USD', connectionGeneration: 1, cashByCurrency: { USD: 1000, PLN: 1000 }, exchangeRatesToBase: { USD: 1, PLN: .25 },
    usdMetrics: { netLiquidation: 10000, availableFunds: 1000, grossPositionValue: 0 } } };
  const dailyLossEvidence = { accountId, sessionId, connectionGeneration: 1, positionGeneration: 1, reconciliationRunId: 1, accountDate: paperAccountDate(nowMs),
    periodStart: new Date(paperAccountDayStart(nowMs)).toISOString(), coveredThrough: iso(-100), capturedAt: iso(), debits: { USD: 0, PLN: 0 }, fingerprint: 'a'.repeat(64) };
  return { order, bound, accountId, sessionId, nowMs, stockMetadata, watchlist, snapshot, dailyLossEvidence, effectiveConfigHash: attr.effectiveConfigHash,
    limits: { maxNotionalPct: 10, maxStopRiskPct: 1, maxExposurePct: 25, quoteCurrency: { currency, maxNotional: 500, maxStopRisk: 10, feeReserve: 5, maxDailyLoss: 20 } } };
}
for (const index of [0, 1, 2]) test(`configured stock ${index} uses common risk, metadata and full-close validator`, () => {
  const f = fixture(index); assert.ok(getSupportedStockCapability(f.bound));
  const risk = assessAiEntryRisk(f); assert.ok(risk.ok, JSON.stringify(risk));
  assert.equal(risk.evidence.quoteCurrency, f.bound.currency); assert.equal(risk.evidence.quoteCashBalance, 1000);
  const close = { ...f.order, side: 'SELL' as const, positionEffect: 'CLOSE_OR_REDUCE' as const, stop: undefined, takeProfit: undefined };
  const result = assessCloseRisk(close, f.bound, { accountId: f.accountId, sessionId: f.sessionId, generation: 1, clientId: 2, nowMs: f.nowMs, bound: f.bound }, f.watchlist, f.stockMetadata);
  assert.ok(result.ok, JSON.stringify(result));
});
for (const [name, change] of [
  ['missing metadata', (f: ReturnType<typeof fixture>) => { f.stockMetadata = undefined as unknown as StockMarketMetadata; }],
  ['stale metadata', f => { f.stockMetadata.requestStartedAtMs = f.nowMs - 60000; }],
  ['wrong primary listing', f => { f.stockMetadata.primaryExchange = 'NASDAQ'; }],
  ['foreign routing', f => { f.stockMetadata.exchange = 'WSE'; }],
  ['off-grid protective price', f => { f.order.stop = 99.005; }],
  ['invalid band order', f => { f.stockMetadata.priceIncrements = [{ lowEdge: 0, increment: .01 }, { lowEdge: 0, increment: .05 }]; }],
  ['closed calendar', f => { f.stockMetadata.sessionEvidence.schedule!.sessions[0].end = new Date(f.nowMs).toISOString(); }],
  ['stale calendar', f => { f.stockMetadata.sessionEvidence.updatedAt = new Date(f.nowMs - 6 * 3600000 - 1).toISOString(); }],
  ['wrong calendar identity', f => { f.stockMetadata.sessionEvidence.schedule!.identity.primaryExchange = 'NASDAQ'; }],
  ['foreign config', f => { f.effectiveConfigHash = 'b'.repeat(64); }],
  ['missing account generation', f => { f.snapshot.riskEvidence.connectionGeneration = undefined as unknown as number; }],
  ['missing USD cash', f => { f.snapshot.riskEvidence.cashByCurrency.USD = undefined as unknown as number; }],
  ['missing daily coverage', f => { f.dailyLossEvidence = undefined as unknown as typeof f.dailyLossEvidence; }],
  ['daily cap equality', f => { f.dailyLossEvidence.debits.USD = 20; }],
  ['wrong cap currency', f => { f.limits.quoteCurrency.currency = 'PLN'; }],
  ['two shares', f => { f.order.quantity = 2; }],
] as Array<[string, (f: ReturnType<typeof fixture>) => void]>) test(`generic stock rejects ${name}`, () => {
  const f = fixture(); change(f); assert.equal(assessAiEntryRisk(f).ok, false);
});
test('generic stock capability cannot infer venue from USD or accept ETF', () => {
  const f = fixture();
  for (const change of [{ primaryExchange: 'LSE' }, { assetClass: 'etf' }, { conId: 1 }, { localSymbol: 'OTHER' }])
    assert.equal(getSupportedStockCapability({ ...f.bound, instrument: { ...f.bound.instrument, ...change } } as typeof f.bound), null);
});
test('market-rule band boundary applies independently to entry, stop and target', () => {
  const f = fixture(); f.stockMetadata.priceIncrements = [{ lowEdge: 0, increment: .01 }, { lowEdge: 100, increment: .05 }];
  assert.ok(validateStockOrder(f.stockMetadata, f.bound, f.accountId, f.order, f.nowMs).ok);
  f.order.takeProfit = 102.01; assert.equal(validateStockOrder(f.stockMetadata, f.bound, f.accountId, f.order, f.nowMs).ok, false);
});
test('metadata adapter verifies unique contract and route-to-rule mapping', () => {
  const f = fixture();
  const observation = { requestStartedAt: new Date(f.nowMs - 100).toISOString(), observedAt: new Date(f.nowMs).toISOString(), sessionEvidence: f.stockMetadata.sessionEvidence,
    candidates: [{ contract: { conId: f.bound.conId, symbol: f.bound.brokerSymbol, secType: 'STK', exchange: f.bound.exchange, primaryExch: f.bound.instrument.primaryExchange,
      currency: f.bound.currency, localSymbol: f.bound.localSymbol, tradingClass: f.bound.tradingClass }, minTick: .01, validExchanges: ['SMART'], marketRuleIds: [1] }], marketRule: { id: 1, bands: [{ lowEdge: 0, increment: .01 }] } };
  assert.ok(validateStockOrder(stockMetadataFromObservation(f.bound, f.accountId, observation), f.bound, f.accountId, f.order, f.nowMs).ok);
  assert.throws(() => stockMetadataFromObservation(f.bound, f.accountId, { ...observation, candidates: [...observation.candidates, ...observation.candidates] }));
  assert.throws(() => stockMetadataFromObservation(f.bound, f.accountId, { ...observation, marketRule: { ...observation.marketRule, id: 2 } }));
});
test('management uses immutable original policies despite no current assignment', async () => {
  const f = fixture();
  const original = await readOriginalStockManagementInstrument({ query: async () => ({ rows: [{ canonical_json: canonicalizeTradingConfiguration(configuration), instance_hash: f.order.strategyAttribution!.instanceHash }] }) }, f.order.strategyAttribution!);
  assert.equal(original.instrumentId, f.bound.instrumentId); assert.ok(original.instrument.trading.executionEnabled);
  assert.equal(original.instrument.executionPolicy!.strategyId, f.order.strategy);
  await assert.rejects(readOriginalStockManagementInstrument({ query: async () => ({ rows: [] }) }, f.order.strategyAttribution!), /SNAPSHOT_UNAVAILABLE/);
});
class FakeIb extends EventEmitter {
  writes: unknown[] = [];
  connect() { queueMicrotask(() => this.emit('nextValidId', 100)); }
  disconnect() { this.emit('disconnected'); }
  placeOrder(id: number, contract: unknown, order: unknown) { this.writes.push({ id, contract, order }); queueMicrotask(() => this.emit('orderStatus', id, 'Submitted', 0, 1, 0, 1000 + id, 0, 0, 4)); }
}
function broker(f: ReturnType<typeof fixture>, loader?: () => Promise<StockMarketMetadata>) {
  const ib = new FakeIb();
  const client = new TwsExecutionClient({ host: 'fixture', port: 0, clientId: 4, securityType: 'STK', exchange: 'SMART', currency: 'USD', environment: 'paper', orderTimeoutMs: 100 }, () => {}, undefined, undefined, undefined,
    { ib, resolveBoundInstrument: () => f.bound, resolveManagementInstrument: async () => f.bound, loadStockMetadata: loader ?? (async () => f.stockMetadata) });
  return { ib, client };
}
for (const index of [0, 1, 2]) test(`configured stock ${index} plans and sends common exact bracket and close`, async () => {
  const f = fixture(index), { ib, client } = broker(f);
  const prepared = await client.prepareBrokerOrderPlan(f.order, f.accountId, 'DAY', { proposedOrderId: 42, clientOrderId: 'fixture' });
  assert.equal(prepared.contract.primaryExch, f.bound.instrument.primaryExchange); assert.equal(prepared.plan.orders.length, 3);
  await client.dispatchPreparedOrder(prepared, Date.now() + 30000, async send => send()); assert.equal(ib.writes.length, 3);
  const close = { ...f.order, side: 'SELL' as const, positionEffect: 'CLOSE_OR_REDUCE' as const, stop: undefined, takeProfit: undefined };
  const exit = await client.prepareBrokerOrderPlan(close, f.accountId, 'DAY', { proposedOrderId: 42, clientOrderId: 'close' });
  await client.dispatchPreparedClose(exit, client.getConnectionGeneration(), Date.now() + 10000); assert.equal(ib.writes.length, 4);
});
test('changed plan and metadata deadline at permit callback cause zero broker writes', async () => {
  for (const kind of ['plan', 'expiry']) {
    const f = fixture(), { ib, client } = broker(f);
    const prepared = await client.prepareBrokerOrderPlan(f.order, f.accountId, 'DAY', { proposedOrderId: 42 });
    if (kind === 'plan') prepared.plan.orders[0].order.lmtPrice = 100.01;
    const realNow = Date.now;
    try {
      await assert.rejects(client.dispatchPreparedOrder(prepared, realNow() + 120000, async send => { if (kind === 'expiry') Date.now = () => f.nowMs + 60000; send(); }));
    } finally { Date.now = realNow; }
    assert.equal(ib.writes.length, 0);
  }
});
test('disconnect during awaited original management lookup prevents preparation', async () => {
  const f = fixture(), ib = new FakeIb();
  const client: TwsExecutionClient = new TwsExecutionClient({ host: 'fixture', port: 0, clientId: 4, securityType: 'STK', exchange: 'SMART', currency: 'USD', orderTimeoutMs: 100 }, () => {}, undefined, undefined, undefined,
    { ib, resolveManagementInstrument: async () => { await Promise.resolve(); client.disconnect(); return f.bound; }, loadStockMetadata: async () => f.stockMetadata });
  const close = { ...f.order, side: 'SELL' as const, positionEffect: 'CLOSE_OR_REDUCE' as const, stop: undefined, takeProfit: undefined };
  await assert.rejects(client.prepareBrokerOrderPlan(close, f.accountId, 'DAY', { proposedOrderId: 42 })); assert.equal(ib.writes.length, 0);
});

for (const index of [0, 1, 2]) test(`generic stock ${index} completion binds original run and currency without ticker aliases`, () => {
  const f = roundTrip(), generic = fixture(index, f.context.nowMs);
  f.context.bound = generic.bound;
  Object.assign(f.order, generic.order);
  const hash = computeClientOrderHash(f.order);
  f.evidence.lifecycle.clientOrderHash = hash;
  Object.assign(f.review, { instrument_id: generic.bound.instrumentId, conid: generic.order.conid, client_order_hash: hash,
    client_order_hash_version: 2, strategy_attribution: generic.order.strategyAttribution, strategy_trigger: generic.order.strategyTrigger });
  Object.assign((f.review as unknown as { risk_evidence: object }).risk_evidence, { instrumentId: generic.bound.instrumentId, conid: generic.order.conid, quoteCurrency: generic.bound.currency });
  for (const fill of f.snapshot.executions) Object.assign(fill, { conId: generic.order.conid!, currency: generic.bound.currency });
  for (const fill of f.evidence.fills) Object.assign(fill, { conid: generic.order.conid, currency: generic.bound.currency, commission_currency: generic.bound.currency });
  Object.assign(f.evidence.window!, { source: 'paper', instrumentId: generic.bound.instrumentId, conid: generic.order.conid,
    effectiveConfigHash: generic.effectiveConfigHash, runPolicyHash: 'c'.repeat(64), policyKind: 'supervised_one_attempt', attemptId: '42',
    accountDate: '2026-09-23', instrumentSessionDate: '2026-09-23' });
  const report = evaluateRoundTrip(f.evidence, f.context);
  assert.equal(report.status, 'COMPLETED', report.reasons.join(','));
  assert.deepEqual(report.netPnl, { currency: generic.bound.currency, amount: 1 });
  assert.equal(report.paperRunId, 'fixture-run'); assert.equal(report.gpwWindowRunId, null); assert.equal(report.aaplWindowRunId, null);
  Object.assign(f.evidence.window!, { policyKind: 'bounded_scheduled', policyVersion: 2 });
  assert.equal(evaluateRoundTrip(f.evidence, f.context).status, 'NOT_PROVEN');
  f.evidence.window!.policyAdopted = true;
  assert.equal(evaluateRoundTrip(f.evidence, f.context).status, 'COMPLETED');
  f.evidence.window!.attemptId = '43'; assert.equal(evaluateRoundTrip(f.evidence, f.context).status, 'NOT_PROVEN');
  f.evidence.window!.attemptId = '42'; f.evidence.window!.effectiveConfigHash = 'd'.repeat(64);
  assert.equal(evaluateRoundTrip(f.evidence, f.context).status, 'NOT_PROVEN');
});
