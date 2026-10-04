import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LifecycleFaultCode, LifecycleFaultInput, LifecycleFaultSink } from "./fault-contract.js";

export type LifecycleDeliveryStatus = "PENDING" | "SENDING" | "DELIVERED" | "FAILED" | "UNKNOWN" | "DISABLED";

export interface LifecycleTransport {
  readonly enabled: boolean;
  send(text: string): Promise<{ status: "DELIVERED"; messageId: string } | { status: "FAILED" | "UNKNOWN"; errorCode: string }>;
}

export interface LifecycleAlertStatus {
  accountId: string;
  faults: Array<{ id: number; proposalId: number | null; code: LifecycleFaultCode; evidence: Record<string, unknown>; firstObservedAt: Date; lastObservedAt: Date; occurrences: number; active: boolean; resolvedAt: Date | null; delivery: LifecycleDeliveryStatus; attempts: number; providerMessageId: string | null }>;
  probes: Array<{ processId: string; heartbeatAt: Date | null; heartbeatFresh: boolean; transportEnabled: boolean; delivery: LifecycleDeliveryStatus; attempts: number; deliveredAt: Date | null }>;
  deliveryAttempts: Array<{ outboxId: number; faultId: number | null; probeProcessId: string | null; attemptNumber: number; status: "SENDING" | "DELIVERED" | "FAILED" | "UNKNOWN"; startedAt: Date; endedAt: Date | null; providerMessageId: string | null; errorCode: string | null }>;
  transport: "UNVERIFIED" | "VERIFIED" | "DISABLED";
}

type OutboxRow = { id: string; account_id: string; fault_id: string | null; probe_process_id: string | null; code: string | null; attempts: number; lease_token: string };

function safeEvidence(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeEvidence(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/token|secret|chat|url|body|error|password|credential/i.test(key))
      .slice(0, 30).map(([key, item]) => [key, safeEvidence(item, depth + 1)]));
  }
  return null;
}

async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export class LifecycleAlertStore implements LifecycleFaultSink {
  constructor(private readonly pool: Pool) {}

  async recordFault(input: LifecycleFaultInput): Promise<void> {
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`snap:${input.accountId}`]);
      const active = await db.query<{ id: string }>(
        `SELECT id FROM lifecycle_faults WHERE account_id=$1 AND original_proposal_id IS NOT DISTINCT FROM $2 AND code=$3 AND active FOR UPDATE`,
        [input.accountId, input.proposalId, input.code],
      );
      let id: string;
      if (active.rows[0]) {
        id = active.rows[0].id;
        await db.query(
          `UPDATE lifecycle_faults SET evidence=$2::jsonb, last_observed_at=clock_timestamp(), occurrences=occurrences+1 WHERE id=$1`,
          [id, JSON.stringify(safeEvidence(input.evidence))],
        );
      } else {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO lifecycle_faults(account_id,original_proposal_id,code,evidence) VALUES($1,$2,$3,$4::jsonb) RETURNING id`,
          [input.accountId, input.proposalId, input.code, JSON.stringify(safeEvidence(input.evidence))],
        );
        id = inserted.rows[0].id;
      }
      await db.query(
        `INSERT INTO lifecycle_alert_outbox(account_id,fault_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [input.accountId, id],
      );
    });
  }

  async resolveScope(accountId: string, proposalId: number | null, activeCodes: readonly LifecycleFaultCode[]): Promise<void> {
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`snap:${accountId}`]);
      await db.query(
        `UPDATE lifecycle_faults SET active=FALSE,resolved_at=clock_timestamp()
         WHERE account_id=$1 AND original_proposal_id IS NOT DISTINCT FROM $2 AND active AND NOT (code=ANY($3::text[]))`,
        [accountId, proposalId, activeCodes],
      );
    });
  }

  async startWorkerSession(accountId: string, processId: string): Promise<void> {
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`snap:${accountId}`]);
      await db.query(
        `INSERT INTO lifecycle_alert_workers(account_id,process_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [accountId, processId],
      );
      await db.query(
        `INSERT INTO lifecycle_alert_outbox(account_id,probe_process_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [accountId, processId],
      );
      await db.query(
        `INSERT INTO lifecycle_alert_outbox(account_id,fault_id)
         SELECT account_id,id FROM lifecycle_faults WHERE account_id=$1 AND active ON CONFLICT DO NOTHING`,
        [accountId],
      );
    });
  }

  async heartbeatWorker(accountId: string, processId: string, transportEnabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp(),transport_enabled=$3 WHERE account_id=$1 AND process_id=$2`,
      [accountId, processId, transportEnabled],
    );
  }

  async readStatus(accountId: string, processId?: string): Promise<LifecycleAlertStatus> {
    const [faults, probes, attempts] = await Promise.all([
      this.pool.query<{
        id: string; original_proposal_id: string | null; code: LifecycleFaultCode; evidence: Record<string, unknown>; first_observed_at: Date; last_observed_at: Date; occurrences: number; active: boolean; resolved_at: Date | null; status: LifecycleDeliveryStatus | null; attempts: number | null; provider_message_id: string | null;
      }>(`SELECT f.*,o.status,o.attempts,o.provider_message_id FROM lifecycle_faults f LEFT JOIN lifecycle_alert_outbox o ON o.fault_id=f.id WHERE f.account_id=$1 ORDER BY f.id DESC`, [accountId]),
      this.pool.query<{ process_id: string; heartbeat_at: Date | null; heartbeat_fresh: boolean; transport_enabled: boolean | null; status: LifecycleDeliveryStatus; attempts: number; delivered_at: Date | null }>(
        `SELECT o.probe_process_id AS process_id,w.heartbeat_at,
                COALESCE(w.heartbeat_at BETWEEN clock_timestamp()-interval '15 seconds' AND clock_timestamp(),FALSE) AS heartbeat_fresh,
                w.transport_enabled,o.status,o.attempts,o.delivered_at
         FROM lifecycle_alert_outbox o LEFT JOIN lifecycle_alert_workers w ON w.account_id=o.account_id AND w.process_id=o.probe_process_id
         WHERE o.account_id=$1 AND o.probe_process_id IS NOT NULL AND ($2::text IS NULL OR o.probe_process_id=$2) ORDER BY o.id DESC`, [accountId, processId ?? null],
      ),
      this.pool.query<{ outbox_id: string; fault_id: string | null; probe_process_id: string | null; attempt_number: number; status: "SENDING" | "DELIVERED" | "FAILED" | "UNKNOWN"; started_at: Date; ended_at: Date | null; provider_message_id: string | null; error_code: string | null }>(
        `SELECT a.outbox_id,o.fault_id,o.probe_process_id,a.attempt_number,a.status,a.started_at,a.ended_at,a.provider_message_id,a.error_code
         FROM lifecycle_alert_delivery_attempts a JOIN lifecycle_alert_outbox o ON o.id=a.outbox_id WHERE o.account_id=$1 ORDER BY a.id DESC`, [accountId],
      ),
    ]);
    return {
      accountId,
      faults: faults.rows.map((r) => ({ id: Number(r.id), proposalId: r.original_proposal_id === null ? null : Number(r.original_proposal_id), code: r.code, evidence: r.evidence, firstObservedAt: r.first_observed_at, lastObservedAt: r.last_observed_at, occurrences: r.occurrences, active: r.active, resolvedAt: r.resolved_at, delivery: r.status ?? "PENDING", attempts: r.attempts ?? 0, providerMessageId: r.provider_message_id })),
      probes: probes.rows.map((r) => ({ processId: r.process_id, heartbeatAt: r.heartbeat_at, heartbeatFresh: r.heartbeat_fresh, transportEnabled: r.transport_enabled ?? false, delivery: r.status, attempts: r.attempts, deliveredAt: r.delivered_at })),
      deliveryAttempts: attempts.rows.map((r) => ({ outboxId: Number(r.outbox_id), faultId: r.fault_id === null ? null : Number(r.fault_id), probeProcessId: r.probe_process_id, attemptNumber: r.attempt_number, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, providerMessageId: r.provider_message_id, errorCode: r.error_code })),
      transport: !probes.rows[0]?.heartbeat_fresh ? "UNVERIFIED" : probes.rows[0]?.transport_enabled === false ? "DISABLED" : probes.rows[0]?.status === "DELIVERED" ? "VERIFIED" : probes.rows[0]?.status === "DISABLED" ? "DISABLED" : "UNVERIFIED",
    };
  }

  async entryFailure(db: PoolClient, accountId: string, processId: string): Promise<string | null> {
    const result = await db.query<{ heartbeat_fresh: boolean; transport_enabled: boolean; probe_status: LifecycleDeliveryStatus | null; active_faults: string; pending_deliveries: string }>(
      `SELECT
        COALESCE((SELECT heartbeat_at BETWEEN clock_timestamp()-interval '15 seconds' AND clock_timestamp() FROM lifecycle_alert_workers WHERE account_id=$1 AND process_id=$2),FALSE) AS heartbeat_fresh,
        COALESCE((SELECT transport_enabled FROM lifecycle_alert_workers WHERE account_id=$1 AND process_id=$2),FALSE) AS transport_enabled,
        (SELECT status FROM lifecycle_alert_outbox WHERE account_id=$1 AND probe_process_id=$2) AS probe_status,
        (SELECT count(*)::text FROM lifecycle_faults WHERE account_id=$1 AND active) AS active_faults,
        (SELECT count(*)::text FROM lifecycle_alert_outbox o JOIN lifecycle_faults f ON f.id=o.fault_id WHERE f.account_id=$1 AND o.status<>'DELIVERED') AS pending_deliveries`,
      [accountId, processId],
    );
    const row = result.rows[0];
    if (!row.heartbeat_fresh) return "lifecycle_alert_worker_stale";
    if (!row.transport_enabled) return "lifecycle_alert_transport_disabled";
    if (row.probe_status !== "DELIVERED") return "lifecycle_alert_transport_unverified";
    if (Number(row.pending_deliveries) > 0) return "lifecycle_critical_delivery_unconfirmed";
    if (Number(row.active_faults) > 0) return "lifecycle_active_fault";
    return null;
  }

  async markDisabled(accountIds: readonly string[]): Promise<void> {
    await this.pool.query(`UPDATE lifecycle_alert_outbox SET status='DISABLED',last_error_code='transport_disabled' WHERE account_id=ANY($1::text[]) AND status IN ('PENDING','FAILED','UNKNOWN') AND attempts<3`, [accountIds]);
  }

  async claimNext(accountIds: readonly string[], processId: string): Promise<OutboxRow | null> {
    if (accountIds.length === 0) return null;
    return transaction(this.pool, async (db) => {
      const expired = await db.query<{ id: string; lease_token: string; attempts: number }>(
        `SELECT id,lease_token,attempts FROM lifecycle_alert_outbox
         WHERE account_id=ANY($1::text[]) AND (fault_id IS NOT NULL OR probe_process_id=$2)
           AND status='SENDING' AND lease_expires_at<=clock_timestamp()
         ORDER BY lease_expires_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [accountIds, processId],
      );
      if (expired.rows[0]) {
        const row = expired.rows[0];
        await db.query(`UPDATE lifecycle_alert_delivery_attempts SET status='UNKNOWN',ended_at=clock_timestamp(),error_code='lease_expired' WHERE outbox_id=$1 AND lease_token=$2 AND status='SENDING'`, [row.id, row.lease_token]);
        await db.query(`UPDATE lifecycle_alert_outbox SET status='UNKNOWN',lease_token=NULL,lease_expires_at=NULL,last_error_code='lease_expired',next_attempt_at=clock_timestamp()+($2::int * interval '1 second') WHERE id=$1`, [row.id, row.attempts === 1 ? 5 : 15]);
      }
      const due = await db.query<OutboxRow>(
        `SELECT o.id,o.account_id,o.fault_id,o.probe_process_id,f.code,o.attempts,o.lease_token
         FROM lifecycle_alert_outbox o LEFT JOIN lifecycle_faults f ON f.id=o.fault_id
         WHERE o.account_id=ANY($1::text[]) AND (o.fault_id IS NOT NULL OR o.probe_process_id=$2)
           AND o.status IN ('PENDING','FAILED','UNKNOWN','DISABLED') AND o.attempts<3 AND o.next_attempt_at<=clock_timestamp()
         ORDER BY o.next_attempt_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`, [accountIds, processId],
      );
      if (!due.rows[0]) return null;
      const row = due.rows[0];
      const token = randomUUID();
      const attempt = row.attempts + 1;
      await db.query(`UPDATE lifecycle_alert_outbox SET status='SENDING',attempts=$2,lease_token=$3,lease_expires_at=clock_timestamp()+interval '5 seconds',last_error_code=NULL WHERE id=$1`, [row.id, attempt, token]);
      await db.query(`INSERT INTO lifecycle_alert_delivery_attempts(outbox_id,attempt_number,lease_token,status) VALUES($1,$2,$3,'SENDING')`, [row.id, attempt, token]);
      return { ...row, attempts: attempt, lease_token: token };
    });
  }

  async complete(id: string, token: string, result: Awaited<ReturnType<LifecycleTransport["send"]>>): Promise<boolean> {
    return transaction(this.pool, async (db) => {
      const current = await db.query<{ attempts: number }>(`SELECT attempts FROM lifecycle_alert_outbox WHERE id=$1 AND lease_token=$2 AND status='SENDING' AND lease_expires_at>clock_timestamp() FOR UPDATE`, [id, token]);
      if (!current.rows[0]) return false;
      const status = result.status;
      const errorCode = status === "DELIVERED" ? null : result.errorCode;
      const messageId = status === "DELIVERED" ? result.messageId : null;
      await db.query(`UPDATE lifecycle_alert_delivery_attempts SET status=$3,ended_at=clock_timestamp(),provider_message_id=$4,error_code=$5 WHERE outbox_id=$1 AND lease_token=$2`, [id, token, status, messageId, errorCode]);
      await db.query(`UPDATE lifecycle_alert_outbox SET status=$3,lease_token=NULL,lease_expires_at=NULL,provider_message_id=$4,last_error_code=$5,delivered_at=CASE WHEN $3='DELIVERED' THEN clock_timestamp() ELSE delivered_at END,next_attempt_at=clock_timestamp()+($6::int * interval '1 second') WHERE id=$1 AND lease_token=$2`, [id, token, status, messageId, errorCode, current.rows[0].attempts === 1 ? 5 : 15]);
      return true;
    });
  }
}

export class LifecycleAlertWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly store: LifecycleAlertStore, private readonly transport: LifecycleTransport, private readonly deps: { accountIds: readonly string[]; processId: string; tickMs?: number }) {}

  async start(): Promise<void> {
    if (this.timer) return;
    for (const accountId of this.deps.accountIds) await this.store.startWorkerSession(accountId, this.deps.processId);
    await this.triggerNow();
    this.timer = setInterval(() => { void this.triggerNow().catch(() => undefined); }, this.deps.tickMs ?? 5000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }

  triggerNow(): Promise<void> {
    if (this.running) return this.running;
    const work = this.tick();
    this.running = work.finally(() => { this.running = null; });
    return this.running;
  }

  private async tick(): Promise<void> {
    for (const accountId of this.deps.accountIds) await this.store.heartbeatWorker(accountId, this.deps.processId, this.transport.enabled);
    if (!this.transport.enabled) { await this.store.markDisabled(this.deps.accountIds); return; }
    const claimed = await this.store.claimNext(this.deps.accountIds, this.deps.processId);
    if (!claimed) return;
    const text = claimed.fault_id
      ? `🚨 Lifecycle fault LF-${claimed.fault_id} account ${claimed.account_id}: ${claimed.code ?? "UNKNOWN"}`
      : `Lifecycle transport check account ${claimed.account_id} process ${claimed.probe_process_id}`;
    let result: Awaited<ReturnType<LifecycleTransport["send"]>>;
    try { result = await this.transport.send(text); }
    catch { result = { status: "UNKNOWN", errorCode: "transport_exception" }; }
    await this.store.complete(claimed.id, claimed.lease_token, result);
  }
}

export function createTelegramLifecycleTransport(config: { botToken?: string; chatId?: string; fetch?: typeof globalThis.fetch }): LifecycleTransport {
  const token = config.botToken;
  const chatId = config.chatId;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  return {
    enabled: Boolean(token && chatId),
    async send(message) {
      if (!token || !chatId) return { status: "FAILED", errorCode: "transport_disabled" };
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("deadline"), { name: "AbortError" })); }, 5000);
      });
      try {
        const request = async () => {
          const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
          signal: controller.signal,
          redirect: "error",
          });
          const size = Number(response.headers.get("content-length"));
          if (Number.isFinite(size) && size > 65_536) return { status: "UNKNOWN" as const, errorCode: "provider_response_oversize" };
          if (!response.body) return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" };
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > 65_536) { void reader.cancel().catch(() => undefined); return { status: "UNKNOWN" as const, errorCode: "provider_response_oversize" }; }
            chunks.push(part.value);
          }
          let payload: unknown;
          try { payload = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
          catch { return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" }; }
          if (typeof payload !== "object" || payload === null) return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" };
          const ack = payload as { ok?: unknown; result?: { message_id?: unknown } };
          if (ack.ok === false) return { status: "FAILED" as const, errorCode: "provider_rejected" };
          if (!response.ok || ack.ok !== true || !Number.isSafeInteger(ack.result?.message_id) || Number(ack.result?.message_id) <= 0) return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" };
          return { status: "DELIVERED" as const, messageId: String(ack.result!.message_id) };
        };
        return await Promise.race([request(), deadline]);
      } catch (error) {
        return { status: "UNKNOWN", errorCode: error instanceof Error && error.name === "AbortError" ? "transport_timeout" : "provider_request_uncertain" };
      } finally { clearTimeout(timeout); }
    },
  };
}
