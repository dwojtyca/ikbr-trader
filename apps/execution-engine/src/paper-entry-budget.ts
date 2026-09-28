import type { Pool, PoolClient } from 'pg';
import { canonicalJson } from '@ikbr/shared/trading-config';
import { paperLocalDate, type PaperRunPolicy, type PaperRunWindow } from './paper-run-policy.js';
import { unavailableSessionEntryGuard, type SessionEntryGuard, type SessionEntryOrder } from './session-entry-guard.js';
type Db = Pick<Pool | PoolClient, 'query'>;
type Entry = SessionEntryOrder & { id?: number };
export type PaperBudgetResult = { ok: true; endsAtMs: number; window: PaperRunWindow } | { ok: false; reason: string };
const deny = (reason: string): PaperBudgetResult => ({ ok: false, reason: `paper_budget_${reason}` });
export function paperWindowForOrder(policy: PaperRunPolicy, order: Entry): PaperRunWindow | undefined {
  if (order.positionEffect === 'CLOSE_OR_REDUCE') return undefined;
  return policy.windows.find(w => w.instrumentId === order.instrumentId && String(w.conId) === order.conid && w.instrument === order.instrument);
}
async function persistPaperRun(client: PoolClient, policy: PaperRunPolicy): Promise<void> {
  await client.query(`INSERT INTO paper_runs(run_id,account_id,effective_config_hash,manifest_hash,canonical_manifest,manifest)
    VALUES($1,$2,$3,$4,$5::text,$5::text::jsonb) ON CONFLICT DO NOTHING`, [policy.runId, policy.accountId, policy.effectiveConfigHash, policy.manifestHash, policy.canonicalManifest]);
  const run = (await client.query('SELECT * FROM paper_runs WHERE run_id=$1', [policy.runId])).rows[0];
  if (run.manifest_hash !== policy.manifestHash || run.canonical_manifest !== policy.canonicalManifest || run.account_id !== policy.accountId || run.effective_config_hash !== policy.effectiveConfigHash || canonicalJson(run.manifest) !== policy.canonicalManifest) throw new Error('PAPER_BUDGET_RUN_ID_REUSED');
}
export async function adoptPaperEntryBudget(client: PoolClient, policy: PaperRunPolicy, options: { tradingEnabled: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('snap:'||$1))", [policy.accountId]);
  const adoption = (await client.query('SELECT account_day_timezone,entries_disabled FROM paper_entry_budget_adoptions WHERE account_id=$1', [policy.accountId])).rows[0];
  if (!adoption) {
    if (options.tradingEnabled) throw new Error('PAPER_BUDGET_ADOPTION_REQUIRES_DISABLED_WRITES');
    // The initial table barrier captures legacy writers before the durable latch.
    await client.query('LOCK TABLE proposed_orders,gpw_windows,aapl_windows IN SHARE ROW EXCLUSIVE MODE NOWAIT');
    await client.query('SELECT import_paper_entry_legacy()');
  } else if (adoption.account_day_timezone !== policy.accountDayTimeZone || adoption.entries_disabled !== true) {
    throw new Error('PAPER_BUDGET_ADOPTION_IDENTITY_CHANGED');
  }
  const held = await client.query('SELECT 1 FROM paper_entry_migration_holds WHERE account_id IS NULL OR account_id=$1 LIMIT 1', [policy.accountId]);
  if (held.rowCount) return { ok: false, reason: 'PAPER_BUDGET_MIGRATION_HOLD' };
  if (!adoption) await client.query('INSERT INTO paper_entry_budget_adoptions(account_id,entries_disabled) VALUES($1,TRUE)', [policy.accountId]);
  await persistPaperRun(client, policy);
  return { ok: true };
}
export async function checkPaperEntryBudget(db: Db, policy: PaperRunPolicy | undefined, accountId: string, order: Entry,
  options: { proposalId?: number; dispatch?: boolean } = {}, sessionGuard: SessionEntryGuard = unavailableSessionEntryGuard): Promise<PaperBudgetResult> {
  if (!policy) return deny('unconfigured');
  if (policy.accountId !== accountId) return deny('account_mismatch');
  const window = paperWindowForOrder(policy, order);
  if (!window) return deny('instrument_mismatch');
  const status = await db.query(`SELECT clock_timestamp() AS now,
    EXISTS(SELECT 1 FROM paper_entry_budget_adoptions WHERE account_id=$1) AS adopted,
    EXISTS(SELECT 1 FROM paper_entry_migration_holds WHERE account_id IS NULL OR account_id=$1) AS held`, [accountId]);
  if (!status.rows[0]?.adopted) return deny('adoption_required');
  if (status.rows[0].held) return deny('migration_hold');
  const now = new Date(status.rows[0].now).getTime();
  if (now < Date.parse(window.startsAt) || now >= Date.parse(window.endsAt)) return deny('outside_window');
  const run = await db.query('SELECT manifest_hash,canonical_manifest,account_id,effective_config_hash FROM paper_runs WHERE run_id=$1', [policy.runId]);
  if (run.rows.length && (run.rows[0].manifest_hash !== policy.manifestHash || run.rows[0].canonical_manifest !== policy.canonicalManifest || run.rows[0].account_id !== accountId || run.rows[0].effective_config_hash !== policy.effectiveConfigHash)) return deny('configuration_changed');
  if (options.proposalId !== undefined) {
    const binding = await db.query('SELECT * FROM paper_run_proposals WHERE proposed_order_id=$1', [options.proposalId]);
    const row = binding.rows[0];
    if (!row || row.run_id !== policy.runId || row.instrument_id !== window.instrumentId || row.conid !== String(window.conId) || row.session_timezone !== window.sessionTimeZone || new Date(row.starts_at).toISOString() !== window.startsAt || new Date(row.ends_at).toISOString() !== window.endsAt) return deny('proposal_binding_mismatch');
  }
  const session = await sessionGuard(db, order, { startsAt: window.startsAt, endsAt: new Date(Date.parse(window.endsAt) + 15 * 60000).toISOString() });
  if (!session.ok) return deny(session.reason);
  const fresh = new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  if (!Number.isFinite(session.endsAtMs) || fresh < Date.parse(window.startsAt) || fresh >= Math.min(Date.parse(window.endsAt), session.endsAtMs)) return deny('outside_window');
  const accountDate = paperLocalDate(fresh, 'Europe/Warsaw'), sessionDate = paperLocalDate(fresh, window.sessionTimeZone);
  const zones = await db.query('SELECT DISTINCT session_timezone FROM paper_entry_attempts WHERE account_id=$1 AND broker=$2 AND conid=$3', [accountId, 'ibkr', String(window.conId)]);
  if (zones.rows.some(row => row.session_timezone !== window.sessionTimeZone)) return deny('timezone_changed');
  const attempts = await db.query(`SELECT proposed_order_id,run_id,source FROM paper_entry_attempts WHERE account_id=$1
    AND (account_date=$2 OR (broker='ibkr' AND conid=$3 AND session_date=$4))`, [accountId, accountDate, String(window.conId), sessionDate]);
  const debts = await db.query('SELECT proposed_order_id FROM paper_entry_legacy_day_debts WHERE account_id=$1 AND charged_date=$2', [accountId, accountDate]);
  if (options.dispatch) {
    if (options.proposalId === undefined || attempts.rows.length !== 1 || debts.rows.length || Number(attempts.rows[0].proposed_order_id) !== options.proposalId || attempts.rows[0].run_id !== policy.runId || attempts.rows[0].source !== 'generic') return deny('claim_missing');
  } else if (attempts.rows.length || debts.rows.length) return deny('consumed');
  return { ok: true, endsAtMs: Math.min(Date.parse(window.endsAt), session.endsAtMs), window };
}
export async function bindPaperProposal(client: PoolClient, policy: PaperRunPolicy, proposalId: number, order: Entry): Promise<void> {
  const window = paperWindowForOrder(policy, order);
  if (!window) throw new Error('PAPER_BUDGET_INSTRUMENT_MISMATCH');
  await persistPaperRun(client, policy);
  const zone = await client.query('SELECT DISTINCT session_timezone FROM paper_entry_attempts WHERE account_id=$1 AND broker=$2 AND conid=$3', [policy.accountId, 'ibkr', String(window.conId)]);
  if (zone.rows.some(row => row.session_timezone !== window.sessionTimeZone)) throw new Error('PAPER_BUDGET_TIMEZONE_CHANGED');
  await client.query(`INSERT INTO paper_run_proposals(proposed_order_id,run_id,instrument_id,conid,session_timezone,starts_at,ends_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [proposalId, policy.runId, window.instrumentId, String(window.conId), window.sessionTimeZone, window.startsAt, window.endsAt]);
}
export async function reservePaperEntryAttempt(client: PoolClient, policy: PaperRunPolicy, accountId: string, order: Entry,
  sessionGuard: SessionEntryGuard = unavailableSessionEntryGuard): Promise<PaperBudgetResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('snap:'||$1))", [accountId]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('paper:'||$1||':ibkr:'||$2))", [accountId, order.conid]);
  if (!Number.isSafeInteger(order.id) || Number(order.id) <= 0) return deny('proposal_required');
  const result = await checkPaperEntryBudget(client, policy, accountId, order, { proposalId: order.id }, sessionGuard);
  if (!result.ok) return result;
  await client.query(`INSERT INTO paper_entry_attempts(proposed_order_id,account_id,broker,conid,account_date,session_date,session_timezone,attempted_at,run_id,source)
    SELECT $1,$2,'ibkr',$3,(t AT TIME ZONE 'Europe/Warsaw')::date,(t AT TIME ZONE $4)::date,$4,t,$5,'generic' FROM (SELECT clock_timestamp() t) stamp`,
  [order.id, accountId, order.conid, result.window.sessionTimeZone, policy.runId]);
  return result;
}
export async function readPaperEntryEvidence(db: Db, proposalId: number) {
  const result = await db.query(`SELECT a.*,a.account_date::text AS account_date,a.session_date::text AS session_date,b.instrument_id,b.starts_at,b.ends_at,r.manifest_hash,r.effective_config_hash,r.manifest
    FROM paper_entry_attempts a LEFT JOIN paper_run_proposals b USING(proposed_order_id) LEFT JOIN paper_runs r ON r.run_id=a.run_id
    WHERE a.proposed_order_id=$1`, [proposalId]);
  return result.rows[0] ?? null;
}
export async function readPaperRoundTripWindow(db: Db, proposalId: number) {
  const row = await readPaperEntryEvidence(db, proposalId);
  if (!row || row.source !== 'generic' || !row.run_id || !row.instrument_id) return null;
  const date = (value: Date | string): string => value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  return {
    source: 'paper' as const, instrumentId: String(row.instrument_id), conid: String(row.conid),
    effectiveConfigHash: String(row.effective_config_hash), runPolicyHash: String(row.manifest_hash),
    policyKind: 'supervised_one_attempt' as const, attemptId: String(row.proposed_order_id),
    accountDate: date(row.account_date), instrumentSessionDate: date(row.session_date),
    runId: String(row.run_id), accountId: String(row.account_id), startsAt: row.starts_at as Date,
    endsAt: row.ends_at as Date, consumedProposalId: Number(row.proposed_order_id), consumedAt: row.attempted_at as Date,
  };
}
