import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { AccountSnapshot } from "./tws-execution-client.js";
const object = (x: unknown): Record<string, unknown> | null => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null;
const stamp = (x: unknown) => typeof x === "string" || x instanceof Date ? new Date(x).getTime() : NaN;
export interface ZeroDayContext {
  accountId: string; sessionId: string; connectionGeneration: number; now: number;
  lastBrokerFillObservedAt: number; accountSnapshot: AccountSnapshot | null;
}
export interface ZeroDayRows { local_count: number; run: unknown; sync: unknown }
export async function readZeroDayRows(pool: Pool, accountId: string, since: Date): Promise<ZeroDayRows> {
  const result = await pool.query<ZeroDayRows>(`SELECT
    (SELECT count(*)::int FROM broker_execution_fills
      WHERE COALESCE(executed_at,created_at) >= $2 AND (account_id=$1 OR account_id IS NULL OR account_id='')) AS local_count,
    (SELECT row_to_json(r) FROM reconciliation_runs r WHERE r.account_id=$1 ORDER BY r.id DESC LIMIT 1) AS run,
    (SELECT row_to_json(s) FROM broker_snapshot_syncs s WHERE s.account_id=$1) AS sync`, [accountId, since]);
  return result.rows[0];
}
export function validateZeroDay(rows: ZeroDayRows, ctx: ZeroDayContext): { ok: boolean; reason: string; runId?: number } {
  const deny = (reason: string) => ({ ok: false, reason });
  if (rows.local_count !== 0) return deny("local_day_not_empty");
  const start = new Date(ctx.now); start.setUTCHours(0, 0, 0, 0);
  const fresh = (time: unknown) => Number.isFinite(stamp(time)) && stamp(time) >= start.getTime() && stamp(time) <= ctx.now && ctx.now - stamp(time) <= 60000;
  const run = object(rows.run), sync = object(rows.sync), snapshot = object(run?.broker_snapshot);
  if (!run || !sync || !snapshot || run.account_id !== ctx.accountId || run.session_id !== ctx.sessionId
    || run.status !== "CLEAN" || run.snapshot_complete !== true || !fresh(run.completed_at) || !fresh(snapshot.capturedAt)
    || snapshot.accountId !== ctx.accountId || snapshot.sessionId !== ctx.sessionId
    || snapshot.connectionGeneration !== ctx.connectionGeneration || snapshot.exposureComplete !== true || snapshot.recoveryComplete !== true)
    return deny("reconciliation_day_evidence_unavailable");
  if (sync.account_id !== ctx.accountId || sync.session_id !== ctx.sessionId || sync.complete !== true
    || run.position_generation == null || String(run.position_generation) !== String(sync.generation)) return deny("position_generation_changed");
  const coverage = object(snapshot.sourceCoverage), executions = object(coverage?.executions), window = object(executions?.window);
  const completed = object(coverage?.completedOrders), persisted = object(run.source_coverage);
  if (!coverage || !persisted || !isDeepStrictEqual(coverage, persisted)
    || executions?.available !== true || executions.timedOut !== false || executions.count !== 0
    || window?.exposureWindowComplete !== true || window.recoveryWindowComplete !== true
    || !Number.isFinite(stamp(window.from)) || stamp(window.from) > start.getTime() || !fresh(window.to)
    || stamp(window.to) > stamp(snapshot.capturedAt) || !Array.isArray(snapshot.executions) || snapshot.executions.length !== 0
    || completed?.available !== true || completed.boundedWindow !== true || completed.timedOut !== false
    || !Array.isArray(snapshot.completedOrders) || completed.count !== snapshot.completedOrders.length
    || snapshot.completedOrders.some(row => object(row)?.filled !== 0)) return deny("broker_day_not_proven_empty");
  for (const name of ["positions", "openOrders", "session"] as const) {
    const source = object(coverage[name]);
    if (source?.available !== true || source.boundedWindow !== true || source.timedOut !== false
      || !Number.isSafeInteger(source.count) || Number(source.count) < (name === "session" ? 1 : 0)
      || (name !== "session" && (!Array.isArray(snapshot[name]) || Number(source.count) < (snapshot[name] as unknown[]).length))) return deny("broker_coverage_invalid");
  }
  const accountReason = zeroAccountReason(ctx);
  if (accountReason) return deny(accountReason);
  if (ctx.lastBrokerFillObservedAt >= Math.min(stamp(window.to), stamp(ctx.accountSnapshot!.riskEvidence!.requestStartedAt))) return deny("broker_fill_after_evidence");
  return { ok: true, reason: "broker_confirmed_empty_utc_day", runId: Number(run.id) };
}

function zeroAccountReason(ctx: ZeroDayContext): string | null {
  const start = new Date(ctx.now); start.setUTCHours(0, 0, 0, 0);
  const fresh = (time: unknown) => Number.isFinite(stamp(time)) && stamp(time) >= start.getTime() && stamp(time) <= ctx.now && ctx.now - stamp(time) <= 60000;
  const account = ctx.accountSnapshot, evidence = account?.riskEvidence;
  if (account?.accountId !== ctx.accountId || !evidence || evidence.complete !== true
    || evidence.connectionGeneration !== ctx.connectionGeneration || !fresh(evidence.requestStartedAt) || !fresh(evidence.completedAt)
    || stamp(evidence.completedAt) < stamp(evidence.requestStartedAt)
    || evidence.realizedPnlByCurrency?.USD !== 0 || Object.values(evidence.realizedPnlByCurrency).some(value => value !== 0)
    || !Number.isFinite(evidence.usdMetrics.netLiquidation) || evidence.usdMetrics.netLiquidation! <= 0)
    return "explicit_zero_usd_pnl_unavailable";
  if (ctx.lastBrokerFillObservedAt >= stamp(evidence.requestStartedAt)) return "broker_fill_after_evidence";
  return null;
}

export async function evaluateZeroDay(input: {
  context: () => ZeroDayContext | null;
  read: (accountId: string, since: Date) => Promise<ZeroDayRows>;
  refresh: () => Promise<boolean>;
}): Promise<{ ok: boolean; reason: string; runId?: number }> {
  const initial = input.context();
  const original = initial ? { ...initial } : null;
  if (!original) return { ok: false, reason: "broker_session_unavailable" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = input.context();
    if (!before) return { ok: false, reason: "broker_session_unavailable" };
    const since = new Date(before.now); since.setUTCHours(0, 0, 0, 0);
    const rows = await input.read(before.accountId, since);
    const current = input.context();
    if (!current || current.accountId !== original.accountId || current.sessionId !== original.sessionId
      || current.connectionGeneration !== original.connectionGeneration) return { ok: false, reason: "broker_session_changed" };
    const result = validateZeroDay(rows, current);
    if (result.ok || attempt > 0 || rows.local_count !== 0 || zeroAccountReason(current)
      || !["position_generation_changed", "reconciliation_day_evidence_unavailable"].includes(result.reason)) return result;
    try { if (!await input.refresh()) return { ok: false, reason: "reconciliation_refresh_incomplete" }; }
    catch { return { ok: false, reason: "reconciliation_refresh_failed" }; }
  }
  return { ok: false, reason: "reconciliation_refresh_incomplete" };
}
