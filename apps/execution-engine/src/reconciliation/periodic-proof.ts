import type { Pool } from 'pg';
import type { AccountingSource } from '../accounting/source-service.js';
import type { RunnerContext } from './runner.js';
import type { SchedulerCoordination } from './scheduler.js';
import { canonicalRunId } from './run-id.js';

export async function readPeriodicProof(dependencies: {
  db: Pick<Pool, 'query'>;
  currentIdentity: SchedulerCoordination['currentIdentity'];
  accounting: () => Pick<AccountingSource, 'assertCurrent'> | undefined;
}, context: RunnerContext, runId: unknown): Promise<{ generation: number; acquiredAt: number } | null> {
  const requestedRunId = canonicalRunId(runId);
  if (requestedRunId === null) return null;
  const initial = dependencies.currentIdentity();
  if (!initial.connected || initial.accountId !== context.accountId) return null;
  const row = (await dependencies.db.query(`SELECT r.*,clock_timestamp() AS now,
    (SELECT count(*) FROM reconciliation_holds WHERE account_id=$1 AND active) AS holds
    FROM reconciliation_runs r WHERE account_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1`, [context.accountId])).rows[0];
  const snapshot = row?.broker_snapshot, generation = dependencies.currentIdentity().generation;
  const latestRunId = canonicalRunId(row?.id);
  const acquiredAt = Date.parse(snapshot?.originalAcquisitionStartedAt ?? '');
  const now = row ? new Date(row.now).getTime() : NaN;
  const accounting = dependencies.accounting();
  if (!row || latestRunId === null || latestRunId !== requestedRunId || row.status !== 'CLEAN' || row.session_id !== context.sessionId || Number(row.holds) !== 0
    || !snapshot || snapshot.accountId !== context.accountId || snapshot.sessionId !== context.sessionId || snapshot.connectionGeneration !== generation
    || snapshot.exposureComplete !== true || snapshot.recoveryComplete !== true || !Number.isFinite(acquiredAt) || acquiredAt > now || now - acquiredAt > 5000
    || !accounting || !snapshot.accounting) return null;
  try { accounting.assertCurrent(snapshot.accounting); } catch { return null; }
  return { generation, acquiredAt };
}
