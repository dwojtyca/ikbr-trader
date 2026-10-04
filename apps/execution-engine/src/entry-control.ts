import type { Pool, PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getExecutionAuthContext } from "./auth.js";
import { deriveCompletenessFlags, type BrokerReconciliationSnapshot } from "./reconciliation/broker-adapter.js";

export class EntryControlError extends Error {
  readonly statusCode = 423;
}

export interface EntryControlContext {
  accountId: string;
  sessionId: string;
  entriesPaused: boolean;
  automationEnabled: boolean;
}

export interface EntryControlPermit {
  validUntilMs: number;
  assertCurrent(): void;
}

export class EntryControlStore {
  constructor(private readonly pool: Pool) {}

  private async locked<T>(accountId: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`snap:${accountId}`]);
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { db.release(); }
  }

  async adopt(accountId: string, tradingEnabled: boolean): Promise<void> {
    await this.locked(accountId, async db => {
      if ((await db.query("SELECT 1 FROM execution_entry_controls WHERE account_id=$1", [accountId])).rowCount) return;
      if (tradingEnabled) throw new EntryControlError("ENTRY_CONTROL_DISABLED_ADOPTION_REQUIRED");
      await db.query("INSERT INTO execution_entry_controls(account_id) VALUES($1)", [accountId]);
      await db.query(`INSERT INTO execution_entry_control_events(account_id,revision,paused,actor,reason)
        VALUES($1,1,true,'migration:pp5','disabled_adoption')`, [accountId]);
    });
  }

  async setPaused(accountId: string, paused: boolean, actor: string, reason: string,
    resumeGate?: (db: PoolClient) => Promise<EntryControlPermit>): Promise<void> {
    await this.locked(accountId, async db => {
      const row = await db.query("SELECT revision FROM execution_entry_controls WHERE account_id=$1 FOR UPDATE", [accountId]);
      if (!row.rowCount) throw new EntryControlError("ENTRY_CONTROL_UNADOPTED");
      if (!paused && !resumeGate) throw new EntryControlError("ENTRY_RESUME_GATE_REQUIRED");
      const permit = !paused ? await resumeGate!(db) : null;
      permit?.assertCurrent();
      if (permit && Date.now() >= permit.validUntilMs) throw new EntryControlError("ENTRY_RESUME_EVIDENCE_EXPIRED");
      const result = await db.query(`UPDATE execution_entry_controls SET paused=$2,revision=revision+1,
        updated_at=clock_timestamp() WHERE account_id=$1 RETURNING revision`, [accountId, paused]);
      await db.query(`INSERT INTO execution_entry_control_events(account_id,revision,paused,actor,reason)
        VALUES($1,$2,$3,$4,$5)`, [accountId, result.rows[0].revision, paused, actor, reason]);
      // A failed final fence rolls back both the state change and its audit.
      permit?.assertCurrent();
      if (permit && Date.now() >= permit.validUntilMs) throw new EntryControlError("ENTRY_RESUME_EVIDENCE_EXPIRED");
    });
  }

  async read(accountId: string) {
    const result = await this.pool.query(`SELECT account_id,paused,revision,created_at,updated_at
      FROM execution_entry_controls WHERE account_id=$1`, [accountId]);
    const events = await this.pool.query(`SELECT revision,paused,actor,reason,created_at
      FROM execution_entry_control_events WHERE account_id=$1 ORDER BY revision DESC LIMIT 50`, [accountId]);
    return { control: result.rows[0] ?? null, events: events.rows };
  }

  async permit(db: PoolClient, context: EntryControlContext, deps: {
    assertCurrent(): void;
    alertFailure(db: PoolClient, accountId: string, sessionId: string): Promise<string | null>;
  }, options: { resuming?: boolean } = {}): Promise<EntryControlPermit> {
    deps.assertCurrent();
    if (context.entriesPaused) throw new EntryControlError("EXECUTION_ENTRIES_PAUSED_BY_CONFIGURATION");
    if (!context.automationEnabled) throw new EntryControlError("LIFECYCLE_AUTOMATION_DISABLED");
    const control = await db.query("SELECT paused FROM execution_entry_controls WHERE account_id=$1", [context.accountId]);
    if (!control.rowCount) throw new EntryControlError("ENTRY_CONTROL_UNADOPTED");
    if (!options.resuming && control.rows[0].paused) throw new EntryControlError("EXECUTION_ENTRIES_PAUSED");
    const alertFailure = await deps.alertFailure(db, context.accountId, context.sessionId);
    if (alertFailure) throw new EntryControlError(alertFailure);
    const health = await db.query(`SELECT session_id,healthy,observed_at,clock_timestamp() AS database_now
      FROM lifecycle_observer_health WHERE account_id=$1`, [context.accountId]);
    const h = health.rows[0], now = h ? new Date(h.database_now).getTime() : NaN;
    const observed = h ? new Date(h.observed_at).getTime() : NaN;
    if (!h || h.session_id !== context.sessionId || h.healthy !== true || !Number.isFinite(observed) ||
      !Number.isFinite(now) || observed > now || now - observed >= 15_000)
      throw new EntryControlError("LIFECYCLE_OBSERVER_UNHEALTHY");
    const recon = await db.query(`SELECT r.status,r.session_id,r.completed_at,r.source_coverage,
      EXISTS(SELECT 1 FROM reconciliation_holds WHERE account_id=$1 AND active) AS held,
      EXISTS(SELECT 1 FROM lifecycle_close_operations WHERE account_id=$1 AND state <> 'COMPLETED') AS closing,
      clock_timestamp() AS database_now FROM reconciliation_runs r WHERE account_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1`,
    [context.accountId]);
    const r = recon.rows[0], completed = r ? new Date(r.completed_at).getTime() : NaN;
    const finalNow = r ? new Date(r.database_now).getTime() : NaN;
    if (!r || r.status !== "CLEAN" || r.session_id !== context.sessionId || r.held || r.closing ||
      !r.completed_at || !Number.isFinite(completed) || completed > finalNow || finalNow - completed >= 10_000)
      throw new EntryControlError("LIFECYCLE_RECONCILIATION_UNAVAILABLE");
    const coverage = r.source_coverage as BrokerReconciliationSnapshot["sourceCoverage"] | null;
    if (!coverage?.positions || !coverage.openOrders || !coverage.executions?.window || !coverage.session ||
      !deriveCompletenessFlags(coverage).exposureComplete ||
      [coverage.positions, coverage.openOrders, coverage.executions, coverage.session].some(source => source.timedOut !== false))
      throw new EntryControlError("LIFECYCLE_RECONCILIATION_INCOMPLETE");
    const alertHealth = await db.query(`SELECT heartbeat_at,clock_timestamp() AS database_now
      FROM lifecycle_alert_workers WHERE account_id=$1 AND process_id=$2`, [context.accountId, context.sessionId]);
    const alert = alertHealth.rows[0], heartbeat = alert ? new Date(alert.heartbeat_at).getTime() : NaN;
    const alertNow = alert ? new Date(alert.database_now).getTime() : NaN;
    if (!Number.isFinite(heartbeat) || heartbeat > alertNow || alertNow - heartbeat >= 15_000)
      throw new EntryControlError("LIFECYCLE_ALERT_WORKER_STALE");
    deps.assertCurrent();
    const validUntilMs = Math.min(observed + 15_000, completed + 10_000, heartbeat + 15_000);
    if (Date.now() >= validUntilMs) throw new EntryControlError("LIFECYCLE_ENTRY_EVIDENCE_EXPIRED");
    return { validUntilMs, assertCurrent: deps.assertCurrent };
  }

  async check(context: EntryControlContext, deps: Parameters<EntryControlStore["permit"]>[2]): Promise<void> {
    const db = await this.pool.connect();
    try { await this.permit(db, context, deps); }
    finally { db.release(); }
  }
}

export function registerEntryControlRoutes(app: FastifyInstance, deps: {
  store: EntryControlStore;
  context(): EntryControlContext;
  assertAccount(): void;
  resumeGate(db: PoolClient): Promise<EntryControlPermit>;
}) {
  const body = z.object({ reason: z.string().trim().min(1).max(240) }).strict();
  app.get("/execution/entry-control", async () => {
    deps.assertAccount();
    const context = deps.context();
    return { configuredPause: context.entriesPaused, automationEnabled: context.automationEnabled,
      ...await deps.store.read(context.accountId) };
  });
  for (const action of ["pause", "resume"] as const) {
    app.post(`/execution/entry-control/${action}`, async (request, reply) => {
      deps.assertAccount();
      const parsed = body.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_entry_control_request" });
      const context = deps.context();
      await deps.store.setPaused(context.accountId, action === "pause",
        `operator:${getExecutionAuthContext(request)?.tokenFingerprint ?? "unknown"}`, parsed.data.reason, deps.resumeGate);
      return deps.store.read(context.accountId);
    });
  }
}
