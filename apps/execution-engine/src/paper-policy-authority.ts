import type { Pool, PoolClient } from 'pg';
import { canonicalJson } from '@ikbr/shared/trading-config';
import { paperLocalDate, type PaperRunPolicy } from './paper-run-policy.js';
import type { EntryControlPermit } from './entry-control.js';

export class PaperPolicyConflict extends Error { readonly statusCode = 409; }
export interface PolicyControlRequest {
  requestId: string;
  expectedRevision: number;
  manifestHash: string;
  priorManifestHash?: string;
  reason: string;
}
export interface PolicyReadiness extends EntryControlPermit { evidence: Record<string, unknown> }
export class PaperPolicyAuthority {
  constructor(private readonly pool: Pool, private readonly deps: {
    assertDisabledPaused(db: PoolClient, accountId: string): Promise<void>;
    readiness(db: PoolClient, accountId: string): Promise<PolicyReadiness>;
    policy(): PaperRunPolicy | undefined;
  }) {}

  async read(accountId: string) {
    const authority = (await this.pool.query(`SELECT a.*,r.manifest_hash AS active_manifest_hash,p.manifest_hash AS pending_manifest_hash
      FROM paper_policy_authorities a JOIN paper_runs r ON r.run_id=a.active_run_id LEFT JOIN paper_runs p ON p.run_id=a.pending_run_id WHERE a.account_id=$1`, [accountId])).rows[0] ?? null;
    const events = (await this.pool.query('SELECT * FROM paper_policy_events WHERE account_id=$1 ORDER BY revision DESC LIMIT 50', [accountId])).rows;
    return { authority, events };
  }

  async change(accountId: string, action: 'SCHEDULE' | 'CANCEL' | 'ADOPT', request: PolicyControlRequest, actor: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtext('snap:'||$1))", [accountId]);
      await this.deps.assertDisabledPaused(db, accountId);
      const body = JSON.parse(canonicalJson({ action, accountId, ...request }));
      const replay = (await db.query('SELECT * FROM paper_policy_events WHERE request_id=$1', [request.requestId])).rows[0];
      if (replay) {
        if (canonicalJson(replay.request) !== canonicalJson(body)) throw new PaperPolicyConflict('PAPER_POLICY_REQUEST_REUSED');
        await db.query('COMMIT'); return { revision: Number(replay.revision), replay: true };
      }
      const authority = (await db.query('SELECT *,effective_date::text AS effective_day,expires_after_date::text AS expiry_day FROM paper_policy_authorities WHERE account_id=$1 FOR UPDATE', [accountId])).rows[0];
      const revision = authority ? Number(authority.revision) : 0;
      if (revision !== request.expectedRevision) throw new PaperPolicyConflict('PAPER_POLICY_REVISION_CONFLICT');
      const today = paperLocalDate(new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime(), 'Europe/Warsaw');
      let active = authority?.active_run_id as string | undefined;
      let pending: string | null = null, effective: string | null = null, expiry: string | null = null;
      let permit: PolicyReadiness | undefined;
      if (action === 'SCHEDULE') {
        if (authority?.pending_run_id) throw new PaperPolicyConflict('PAPER_POLICY_TRANSITION_PENDING');
        const target = this.deps.policy();
        if (!target || target.accountId !== accountId || target.manifestHash !== request.manifestHash) throw new PaperPolicyConflict('PAPER_POLICY_CONFIGURED_TARGET_REQUIRED');
        const persisted = (await db.query('SELECT * FROM paper_runs WHERE account_id=$1 AND manifest_hash=$2', [accountId, request.manifestHash])).rows;
        if (persisted.length !== 1 || persisted[0].canonical_manifest !== target.canonicalManifest) throw new PaperPolicyConflict('PAPER_POLICY_TARGET_UNREGISTERED');
        const prior = (await db.query('SELECT * FROM paper_runs WHERE account_id=$1 AND manifest_hash=$2', [accountId, request.priorManifestHash])).rows;
        if (prior.length !== 1 || (active ? active !== prior[0].run_id : prior[0].manifest.version !== 1 || prior[0].manifest.kind !== 'supervised_one_attempt')) throw new PaperPolicyConflict('PAPER_POLICY_PRIOR_REQUIRED');
        active = prior[0].run_id;
        if (active === target.runId) throw new PaperPolicyConflict('PAPER_POLICY_UNCHANGED');
        effective = target.effectiveAccountDate ?? target.windows.map(w => w.accountDate).sort()[0]!;
        expiry = target.expiresAfterAccountDate ?? target.windows.map(w => w.accountDate).sort().at(-1)!;
        if (effective <= today || expiry < effective) throw new PaperPolicyConflict('PAPER_POLICY_SUBSEQUENT_DAY_REQUIRED');
        pending = target.runId;
        permit = await this.deps.readiness(db, accountId);
      } else {
        if (!authority?.pending_run_id) throw new PaperPolicyConflict('PAPER_POLICY_PENDING_REQUIRED');
        const pendingRun = (await db.query('SELECT manifest_hash FROM paper_runs WHERE run_id=$1', [authority.pending_run_id])).rows[0];
        if (pendingRun?.manifest_hash !== request.manifestHash) throw new PaperPolicyConflict('PAPER_POLICY_PENDING_MISMATCH');
        if (action === 'CANCEL') {
          if (today >= authority.effective_day) throw new PaperPolicyConflict('PAPER_POLICY_CANCEL_TOO_LATE');
        } else {
          if (today < authority.effective_day || today > authority.expiry_day) throw new PaperPolicyConflict('PAPER_POLICY_ADOPTION_OUTSIDE_DATES');
          const target = this.deps.policy();
          if (!target || target.accountId !== accountId || target.runId !== authority.pending_run_id || target.manifestHash !== request.manifestHash) throw new PaperPolicyConflict('PAPER_POLICY_CONFIGURED_TARGET_REQUIRED');
          active = authority.pending_run_id;
          permit = await this.deps.readiness(db, accountId);
        }
      }
      const assertFresh = async () => {
        await this.deps.assertDisabledPaused(db, accountId);
        permit?.assertCurrent();
        if (permit) {
          const fresh = await this.deps.readiness(db, accountId);
          if (canonicalJson(fresh.evidence) !== canonicalJson(permit.evidence)) throw new PaperPolicyConflict('PAPER_POLICY_READINESS_CHANGED');
          fresh.assertCurrent();
          permit = { ...fresh, validUntilMs: Math.min(fresh.validUntilMs, permit.validUntilMs) };
        }
        const now = new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
        if (permit && now >= permit.validUntilMs) throw new PaperPolicyConflict('PAPER_POLICY_READINESS_EXPIRED');
      };
      await assertFresh();
      await db.query(`INSERT INTO paper_policy_events(account_id,revision,request_id,action,request,active_run_id,pending_run_id,effective_date,expires_after_date,actor,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [accountId,revision+1,request.requestId,action,body,active,pending,effective,expiry,actor,permit?.evidence ?? {}]);
      if (authority) await db.query(`UPDATE paper_policy_authorities SET revision=$2,active_run_id=$3,pending_run_id=$4,effective_date=$5,expires_after_date=$6 WHERE account_id=$1`, [accountId,revision+1,active,pending,effective,expiry]);
      else await db.query(`INSERT INTO paper_policy_authorities(account_id,revision,active_run_id,pending_run_id,effective_date,expires_after_date)
        VALUES($1,$2,$3,$4,$5,$6)`, [accountId,revision+1,active,pending,effective,expiry]);
      await assertFresh();
      await db.query('COMMIT');
      return { revision: revision+1, replay: false };
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
}
