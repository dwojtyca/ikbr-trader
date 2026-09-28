import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPaperDailyLoss, buildPaperDailyLoss, paperAccountDate, paperAccountDayStart, type PaperDailyLossRows } from './paper-daily-loss.js';
function fixture() {
  const nowMs = Date.parse('2026-09-28T12:00:00Z');
  const through = new Date(nowMs - 1000).toISOString();
  const source = (count: number) => ({ available: true, boundedWindow: true, timedOut: false, count });
  const coverage = { positions: source(0), openOrders: source(0), completedOrders: source(0), session: source(1), executions: {
    available: true, timedOut: false, count: 0, window: { from: '2026-09-27T22:00:00Z', certifiedFrom: '2026-09-27T22:00:00Z', to: through, exposureWindowComplete: true, recoveryWindowComplete: true } } };
  const snapshot = { accountId: 'paper', sessionId: 'session', connectionGeneration: 1, capturedAt: through, exposureComplete: true, recoveryComplete: true,
    sourceCoverage: coverage, positions: [], openOrders: [], completedOrders: [], executions: [] as Record<string, unknown>[] };
  const rows: PaperDailyLossRows = { run: { id: 1, account_id: 'paper', session_id: 'session', status: 'CLEAN', snapshot_complete: true, completed_at: through,
    broker_snapshot: snapshot, source_coverage: coverage, position_generation: 1 }, sync: { account_id: 'paper', session_id: 'session', complete: true, generation: 1 }, fills: [] };
  const context = { accountId: 'paper', sessionId: 'session', connectionGeneration: 1, nowMs, lastBrokerFillObservedAt: 0 };
  return { rows, context, coverage, snapshot, through };
}
test('Warsaw dates and midnight remain correct on both DST transitions and US mismatch weeks', () => {
  for (const [instant, start] of [['2026-03-29T08:00:00Z', '2026-03-28T23:00:00Z'], ['2026-10-25T08:00:00Z', '2026-10-24T22:00:00Z'], ['2026-03-16T08:00:00Z', '2026-03-15T23:00:00Z'], ['2026-10-28T08:00:00Z', '2026-10-27T23:00:00Z']])
    assert.equal(new Date(paperAccountDayStart(Date.parse(instant))).toISOString(), new Date(start).toISOString());
  assert.equal(paperAccountDate(Date.parse('2026-09-27T22:00:00Z')), '2026-09-28');
});
test('independently proven empty Warsaw day passes and cap equality refuses', () => {
  const f = fixture(); const result = buildPaperDailyLoss(f.rows, f.context); assert.equal(result.ok, true); if (!result.ok) return;
  assert.deepEqual(result.evidence.debits, { USD: 0, PLN: 0 });
  const risk = { ...f.context, quoteCurrency: 'USD' as const, maxDailyLoss: 5 };
  assert.equal(assessPaperDailyLoss(result.evidence, risk).ok, true);
  assert.equal(assessPaperDailyLoss({ ...result.evidence, debits: { USD: 5, PLN: 0 } }, risk).ok, false);
});
test('UTC-only or requested-but-uncertified history cannot prove the Warsaw day', () => {
  for (const patch of [{ certifiedFrom: undefined }, { certifiedFrom: '2026-09-28T00:00:00Z' }, { from: '2026-09-28T00:00:00Z' }]) {
    const f = fixture(); Object.assign(f.coverage.executions.window, patch);
    assert.equal(buildPaperDailyLoss(f.rows, f.context).ok, false);
  }
});
test('changed generation, fill observation and stale coverage refuse', () => {
  for (const patch of [{ connectionGeneration: 2 }, { lastBrokerFillObservedAt: Date.parse('2026-09-28T11:59:59Z') }, { nowMs: Date.parse('2026-09-28T12:00:09Z') }]) {
    const f = fixture(); assert.equal(buildPaperDailyLoss(f.rows, { ...f.context, ...patch }).ok, false);
  }
});
function withFill() {
  const f = fixture();
  const execution = { execId: 'e1', accountId: 'paper', conId: '123', secType: 'STK', brokerOrderId: '100', side: 'SLD', shares: 1, price: 20, currency: 'USD', executedAt: '2026-09-28T11:00:00Z' };
  f.snapshot.executions.push(execution); f.coverage.executions.count = 1;
  const fill = { exec_id: 'e1', account_id: 'paper', conid: '123', sec_type: 'STK', broker_order_id: '100', side: 'SELL', shares: 1, price: 20, currency: 'USD', executed_at: execution.executedAt, commission: 1, commission_currency: 'USD', realized_pnl: -2 };
  f.rows.fills.push(fill); return { ...f, fill };
}
test('losses plus positive fees debit currency budget without replenishment from gains', () => {
  const f = withFill(); let result = buildPaperDailyLoss(f.rows, f.context); assert.ok(result.ok); assert.equal(result.evidence.debits.USD, 3);
  f.fill.realized_pnl = 100; result = buildPaperDailyLoss(f.rows, f.context); assert.ok(result.ok); assert.equal(result.evidence.debits.USD, 1);
});
test('missing/foreign fees, unknown local fills and conflicting typed fills block accounting', () => {
  for (const patch of [{ commission: null }, { commission_currency: 'PLN' }, { realized_pnl: 1.7976931348623157e308 }, { sec_type_conflict: true }, { account_id: null }]) {
    const f = withFill(); Object.assign(f.fill, patch); assert.equal(buildPaperDailyLoss(f.rows, f.context).ok, false);
  }
  const f = fixture(); f.rows.fills.push({ exec_id: 'unknown', executed_at: null }); assert.equal(buildPaperDailyLoss(f.rows, f.context).ok, false);
});
test('late commission correction changes immutable evidence fingerprint', () => {
  const f = withFill(); const first = buildPaperDailyLoss(f.rows, f.context); assert.ok(first.ok);
  f.fill.commission = 2; const next = buildPaperDailyLoss(f.rows, f.context); assert.ok(next.ok);
  assert.notEqual(first.evidence.fingerprint, next.evidence.fingerprint);
});
test('daily evidence cannot cross account midnight or be relabelled to a new session', () => {
  const f = fixture(); const first = buildPaperDailyLoss(f.rows, f.context); assert.ok(first.ok);
  const base = { ...f.context, quoteCurrency: 'USD' as const, maxDailyLoss: 5 };
  assert.equal(assessPaperDailyLoss(first.evidence, { ...base, nowMs: Date.parse('2026-09-28T22:00:00Z') }).ok, false);
  assert.equal(assessPaperDailyLoss(first.evidence, { ...base, sessionId: 'new' }).ok, false);
});
