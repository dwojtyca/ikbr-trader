import type { Pool, PoolClient } from "pg";
import { deriveCompletenessFlags, type BrokerReconciliationSnapshot } from "./broker-adapter.js";

export interface ReconciliationFill {
  execId: string; accountId: string | null; conId: string | null;
  symbol: string | null; currency: string | null; side: string | null;
  shares: number; secType: string | null; conflict: boolean;
}
export class CashClassificationConflict extends Error {
  constructor() { super("reconciliation_security_type_conflict"); }
}
const normalized = (value: string | null | undefined) => value?.trim().toUpperCase() || null;
const side = (value: string | null | undefined) => ["BUY", "BOT"].includes(normalized(value) ?? "") ? "BUY"
  : ["SELL", "SLD", "SSHORT"].includes(normalized(value) ?? "") ? "SELL" : null;
const identity = (account: string | null | undefined, conId: string | null | undefined) =>
  account && conId && /^[1-9]\d*$/.test(conId) ? `conid:${account}|${conId}` : null;

export function classifyCashFills(fills: readonly ReconciliationFill[], snapshot: BrokerReconciliationSnapshot,
  context: { accountId: string; sessionId: string; sessionStartedAt: Date }) {
  if (fills.some(fill => fill.conflict)) throw new CashClassificationConflict();
  const current = snapshot.accountId === context.accountId && snapshot.sessionId === context.sessionId
    && snapshot.capturedAt.getTime() >= context.sessionStartedAt.getTime()
    && Date.now() - snapshot.capturedAt.getTime() >= -1000 && Date.now() - snapshot.capturedAt.getTime() <= 60000;
  const coverage = deriveCompletenessFlags(snapshot.sourceCoverage);
  const complete = current && coverage.exposureComplete && coverage.recoveryComplete && snapshot.exposureComplete && snapshot.recoveryComplete
    && snapshot.sourceCoverage.executions.available && !snapshot.sourceCoverage.executions.timedOut
    && snapshot.sourceCoverage.executions.window.exposureWindowComplete
    && snapshot.sourceCoverage.executions.window.recoveryWindowComplete;
  const excluded: ReconciliationFill[] = [];
  const records = [...snapshot.positions, ...snapshot.openOrders, ...snapshot.completedOrders, ...snapshot.executions];
  const cashKeys = new Set<string>();
  const unsafeKeys = new Set<string>();
  const nonCashKeys = new Set<string>();
  for (const record of records) {
    const key = identity(record.accountId, record.conId);
    if (record.accountId !== context.accountId || !key) continue;
    if (normalized(record.secType) === "CASH") cashKeys.add(key); else {
      unsafeKeys.add(key);
      if (normalized(record.secType)) nonCashKeys.add(key);
    }
  }
  for (const key of cashKeys) if (nonCashKeys.has(key)) throw new CashClassificationConflict();
  for (const fill of fills) {
    const key = identity(fill.accountId, fill.conId);
    const known = normalized(fill.secType);
    if (key && known && known !== "CASH" && cashKeys.has(key)) throw new CashClassificationConflict();
    const candidates = snapshot.executions.filter(row => row.execId === fill.execId);
    const exact = candidates.filter(row => row.accountId === fill.accountId && row.conId === fill.conId
      && normalized(row.symbol) === normalized(fill.symbol) && normalized(row.currency) === normalized(fill.currency)
      && side(row.side) === side(fill.side) && row.shares === fill.shares);
    const types = new Set(exact.map(row => normalized(row.secType)).filter(value => value !== null));
    if (types.size > 1 || (known && [...types].some(type => type !== known))
      || (known === "CASH" && (unsafeKeys.has(key ?? "") || candidates.length !== exact.length))) throw new CashClassificationConflict();
    const valid = fill.accountId === context.accountId && key && normalized(fill.symbol) && normalized(fill.currency)
      && side(fill.side) && Number.isFinite(fill.shares) && fill.shares > 0 && fill.shares < Number.MAX_SAFE_INTEGER;
    const proved = valid && (known === "CASH" || (!known && complete && !unsafeKeys.has(key) && candidates.length > 0
      && candidates.length === exact.length && exact.every(row => normalized(row.secType) === "CASH")));
    if (proved) excluded.push(fill); else {
      const unsafe = identity(fill.accountId ?? context.accountId, fill.conId);
      if (unsafe) unsafeKeys.add(unsafe);
    }
  }
  for (const key of unsafeKeys) cashKeys.delete(key);
  return { excluded, resolvableKeys: complete ? cashKeys : new Set<string>() };
}

export async function readReconciliationFills(database: Pool | PoolClient, accountId: string): Promise<ReconciliationFill[]> {
  const { rows } = await database.query(`SELECT exec_id, account_id, conid, symbol, currency, side,
    shares, sec_type, sec_type_conflict FROM broker_execution_fills
    WHERE account_id=$1 OR account_id IS NULL ORDER BY exec_id`, [accountId]);
  return rows.map(row => ({ execId: row.exec_id, accountId: row.account_id, conId: row.conid,
    symbol: row.symbol, currency: row.currency, side: row.side, shares: Number(row.shares),
    secType: row.sec_type, conflict: row.sec_type_conflict }));
}
