import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { AccountingAuthority, AccountingCaptureReference } from './accounting/types.js';

export interface PaperDailyLossEvidence {
  accountId: string; sessionId: string; connectionGeneration: number; positionGeneration: number;
  reconciliationRunId: number; accountDate: string; periodStart: string; coveredThrough: string;
  capturedAt: string; debits: Record<'USD' | 'PLN', number>; fingerprint: string;
  accounting?: AccountingCaptureReference;
}
export interface PaperDailyLossContext {
  accountId: string; sessionId: string; connectionGeneration: number; nowMs: number;
  lastBrokerFillObservedAt: number;
  accounting?: AccountingAuthority;
}
export interface PaperDailyLossRows { run: unknown; sync: unknown; fills: unknown[] }
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const time = (v: unknown): number => v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e100;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const side = (v: unknown) => v === 'BOT' || v === 'BUY' ? 'BUY' : v === 'SLD' || v === 'SELL' ? 'SELL' : null;
export function paperAccountDate(nowMs: number): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(nowMs).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function paperAccountDayStart(nowMs: number): number {
  const day = paperAccountDate(nowMs);
  const utc = Date.parse(`${day}T00:00:00Z`);
  // Warsaw's midnight always exists; determine its UTC offset at the candidate.
  for (const hours of [1, 2]) {
    const candidate = utc - hours * 3_600_000;
    if (paperAccountDate(candidate) === day && paperAccountDate(candidate - 1) !== day) return candidate;
  }
  throw new Error('paper_account_day_invalid');
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function buildPaperDailyLoss(rows: PaperDailyLossRows, context: PaperDailyLossContext):
  { ok: true; evidence: PaperDailyLossEvidence } | { ok: false; reason: string } {
  const fail = (detail: string) => ({ ok: false as const, reason: `paper_daily_loss_${detail}` });
  const { accountId, sessionId, connectionGeneration, nowMs } = context;
  if (!accountId || !sessionId || !integer(connectionGeneration) || !Number.isFinite(nowMs)) return fail('context_invalid');
  const start = paperAccountDayStart(nowMs);
  const fresh = (v: unknown) => Number.isFinite(time(v)) && time(v) >= start && time(v) <= nowMs && nowMs - time(v) < 10_000;
  const run = object(rows.run), sync = object(rows.sync), snapshot = object(run?.broker_snapshot);
  if (!run || !sync || !snapshot || run.account_id !== accountId || run.session_id !== sessionId ||
      run.status !== 'CLEAN' || run.snapshot_complete !== true || !fresh(run.completed_at) || !fresh(snapshot.capturedAt) ||
      snapshot.accountId !== accountId || snapshot.sessionId !== sessionId || snapshot.connectionGeneration !== connectionGeneration ||
      snapshot.exposureComplete !== true || snapshot.recoveryComplete !== true || !integer(Number(run.id)) ||
      sync.account_id !== accountId || sync.session_id !== sessionId || sync.complete !== true ||
      !integer(Number(sync.generation)) || Number(run.position_generation) !== Number(sync.generation)) return fail('reconciliation_unavailable');
  const coverage = object(snapshot.sourceCoverage), executions = object(coverage?.executions), window = object(executions?.window);
  // A requested start plus reqExecutionsEnd does not prove the API supplied older history.
  if (!coverage || !isDeepStrictEqual(coverage, run.source_coverage) || executions?.available !== true || executions.timedOut !== false ||
      window?.exposureWindowComplete !== true || window.recoveryWindowComplete !== true ||
      !Number.isFinite(time(window.certifiedFrom)) || time(window.certifiedFrom) > start ||
      !Number.isFinite(time(window.from)) || time(window.from) > start || time(window.certifiedFrom) > time(window.from) ||
      !fresh(window.to) || time(window.to) > time(snapshot.capturedAt) || time(run.completed_at) < time(snapshot.capturedAt) ||
      !Array.isArray(snapshot.executions) || executions.count !== snapshot.executions.length) return fail('coverage_unavailable');
  for (const name of ['positions', 'openOrders', 'completedOrders', 'session']) {
    const source = object(coverage[name]);
    if (!source || source.available !== true || source.timedOut !== false || source.boundedWindow !== true ||
        !Number.isSafeInteger(source.count) || Number(source.count) < (name === 'session' ? 1 : 0) ||
        (name !== 'session' && (!Array.isArray(snapshot[name]) || source.count !== (snapshot[name] as unknown[]).length))) return fail('coverage_unavailable');
  }
  const accounting = snapshot.accounting as AccountingCaptureReference | undefined;
  if (context.accounting) {
    if (!accounting || accounting.reconciliationRunId !== Number(run.id) || accounting.positionGeneration !== Number(sync.generation)) return fail('coverage_unavailable');
    try { context.accounting.assertCurrent(accounting); } catch { return fail('changed'); }
  } else if (!finite(context.lastBrokerFillObservedAt) || context.lastBrokerFillObservedAt >= time(window.to)) return fail('changed');
  const broker = new Map<string, Record<string, unknown>>();
  for (const raw of snapshot.executions) {
    const row = object(raw);
    if (!row || row.accountId !== accountId || typeof row.execId !== 'string' || !row.execId ||
        !Number.isFinite(time(row.executedAt)) || time(row.executedAt) > time(window.to)) return fail('execution_invalid');
    if (time(row.executedAt) < start) continue;
    if (broker.has(row.execId)) return fail('execution_duplicate');
    broker.set(row.execId, row);
  }
  const fills = rows.fills.map(object);
  if (fills.some(row => !row) || new Set(fills.map(row => row!.exec_id)).size !== fills.length || fills.length !== broker.size) return fail('accounting_incomplete');
  const debits = { USD: 0, PLN: 0 };
  for (const row of fills) {
    const execution = broker.get(String(row!.exec_id));
    if (!execution || row!.account_id !== accountId || row!.conid !== execution.conId || !integer(Number(row!.conid)) ||
        row!.sec_type !== execution.secType || !['STK', 'FUT', 'OPT', 'CASH'].includes(String(row!.sec_type)) || row!.sec_type_conflict === true ||
        row!.broker_order_id !== execution.brokerOrderId || !side(row!.side) || side(row!.side) !== side(execution.side) ||
        row!.shares !== execution.shares || !finite(row!.shares) || row!.shares <= 0 || row!.price !== execution.price || !finite(row!.price) || row!.price <= 0 ||
        row!.currency !== execution.currency || (row!.currency !== 'USD' && row!.currency !== 'PLN') ||
        time(row!.executed_at) !== time(execution.executedAt) || row!.commission_currency !== row!.currency ||
        !finite(row!.commission) || !finite(row!.realized_pnl)) return fail('accounting_incomplete');
    const currency = row!.currency as 'USD' | 'PLN';
    debits[currency] += Math.max(0, -row!.realized_pnl) + Math.max(0, row!.commission);
    if (!finite(debits[currency])) return fail('accounting_invalid');
  }
  const identity = { accountId, sessionId, connectionGeneration, positionGeneration: Number(sync.generation),
    reconciliationRunId: Number(run.id), accountDate: paperAccountDate(nowMs), periodStart: new Date(start).toISOString(),
    coveredThrough: new Date(time(window.to)).toISOString(), capturedAt: new Date(time(snapshot.capturedAt)).toISOString(), debits,
    ...(accounting ? { accounting } : {}) };
  return { ok: true, evidence: { ...identity, fingerprint: digest({ identity, coverage, fills: [...fills].sort((a, b) => String(a!.exec_id).localeCompare(String(b!.exec_id))) }) } };
}

export function assessPaperDailyLoss(value: unknown, context: { accountId: string; sessionId: string; quoteCurrency: 'USD' | 'PLN'; maxDailyLoss: number; nowMs: number; connectionGeneration?: number }):
  { ok: true; evidence: PaperDailyLossEvidence; validUntilMs: number } | { ok: false; reason: string } {
  const row = object(value), debits = object(row?.debits);
  if (!row || !debits || row.accountId !== context.accountId || row.sessionId !== context.sessionId ||
      !integer(context.connectionGeneration) || row.connectionGeneration !== context.connectionGeneration ||
      !integer(row.positionGeneration) || !integer(row.reconciliationRunId) || !Number.isFinite(context.nowMs) ||
      row.accountDate !== paperAccountDate(context.nowMs) || time(row.periodStart) !== paperAccountDayStart(context.nowMs) ||
      !Number.isFinite(time(row.coveredThrough)) || !Number.isFinite(time(row.capturedAt)) || time(row.coveredThrough) < time(row.periodStart) ||
      time(row.coveredThrough) > time(row.capturedAt) || time(row.capturedAt) > context.nowMs || context.nowMs - time(row.coveredThrough) >= 10_000 ||
      !finite(debits.USD) || debits.USD < 0 || !finite(debits.PLN) || debits.PLN < 0 ||
      !finite(context.maxDailyLoss) || context.maxDailyLoss <= 0 || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint))
    return { ok: false, reason: 'paper_daily_loss_unavailable' };
  if (Number(debits[context.quoteCurrency]) >= context.maxDailyLoss) return { ok: false, reason: 'paper_daily_loss_exceeded' };
  return { ok: true, evidence: value as PaperDailyLossEvidence, validUntilMs: time(row.coveredThrough) + 10_000 };
}

export async function readPaperDailyLoss(db: Pick<Pool | PoolClient, 'query'>, context: PaperDailyLossContext, lockAccounting = false) {
  const result = await db.query<PaperDailyLossRows>(`SELECT
    (SELECT row_to_json(r) FROM reconciliation_runs r WHERE r.account_id=$1 ORDER BY r.id DESC LIMIT 1) AS run,
    (SELECT row_to_json(s) FROM broker_snapshot_syncs s WHERE s.account_id=$1) AS sync,
    COALESCE((SELECT json_agg(f ORDER BY f.exec_id) FROM broker_execution_fills f
      WHERE (f.account_id=$1 OR f.account_id IS NULL OR f.account_id='')
      AND (f.executed_at IS NULL OR f.executed_at >= $2)), '[]'::json) AS fills`,
  [context.accountId, new Date(paperAccountDayStart(context.nowMs))]);
  const rows = result.rows[0];
  if (context.accounting) {
    const snapshot = object(object(rows.run)?.broker_snapshot), reference = snapshot?.accounting as AccountingCaptureReference | undefined;
    if (!reference) return { ok: false as const, reason: 'paper_daily_loss_coverage_unavailable' };
    try {
      const capture = await context.accounting.readCapture(db, reference, lockAccounting);
      const fees = new Map(capture.commissions.map(f => [f.execId, f]));
      rows.fills = capture.executions.map(e => ({ exec_id: e.execId, account_id: e.accountId, conid: e.conId, sec_type: e.secType,
        broker_order_id: e.brokerOrderId, side: e.side, shares: e.shares, price: e.price, currency: e.currency,
        executed_at: e.executedAt, commission_currency: fees.get(e.execId)?.currency,
        commission: fees.get(e.execId)?.commission, realized_pnl: fees.get(e.execId)?.realizedPnL }));
    } catch { return { ok: false as const, reason: 'paper_daily_loss_changed' }; }
  }
  return buildPaperDailyLoss(rows, context);
}
export async function assertPaperDailyLossUnchanged(db: Pick<Pool | PoolClient, 'query'>, expected: PaperDailyLossEvidence, context: PaperDailyLossContext): Promise<void> {
  const current = await readPaperDailyLoss(db, context, true);
  if (!current.ok || current.evidence.fingerprint !== expected.fingerprint) throw new Error('paper_daily_loss_changed');
}
