/**
 * PR15 — reconciliation persistence: `reconciliation_runs`,
 * `reconciliation_holds`, `broker_order_links`,
 * `broker_order_ref_map`.
 *
 * See docs/implementation/phase2/PR15_PLAN.md §1, §5, §6, §7.
 * Uses raw `pg` — no ORM, matching the rest of the codebase.
 */

import type { Pool, PoolClient } from "pg";
import type {
  BrokerReconciliationSnapshot,
} from "./broker-adapter.js";

/**
 * PR15 §9 — lifecycle writeback derived from broker evidence.
 * Only unambiguous transitions are proposed; the repo applies
 * them atomically inside the Phase C transaction. Defined here
 * (not in runner.ts) to keep repository → runner dependency
 * acyclic.
 *
 * `authorizeHoldIds` binds the transition to the specific holds
 * whose `auto_broker_match` resolution depends on it succeeding.
 * If the status UPDATE rowCount === 0 the transition failed
 * (row already terminal, wrong status, deleted) — every listed
 * hold stays active and the runner reports the failed match in
 * `lifecycleSkipped` for audit.
 */
export interface LifecycleWriteback {
  readonly proposedOrderId: number;
  readonly brokerOrderId: string | null;
  readonly matchedBy: string;
  readonly transition: "SUBMITTED" | "FILLED" | "CANCELLED" | "REJECTED";
  readonly authorizeHoldIds: readonly number[];
}

export interface LifecycleSkip {
  readonly proposedOrderId: number;
  readonly transition: LifecycleWriteback["transition"];
  readonly reason: string;
}

export type ReconciliationRunStatus =
  | "RUNNING"
  | "CLEAN"
  | "MISMATCH"
  | "FAILED"
  | "INCOMPLETE"
  | "ABANDONED";

export type HoldReason =
  | "position_mismatch"
  | "orphan_broker_order"
  | "unknown_submission"
  | "recovery_source_missing"
  | "identity_ambiguous"
  | "manual";

export type HoldSeverity = "warn" | "error" | "critical";

export type ResolvedKind =
  | "auto_snapshot_clean"
  | "auto_broker_match"
  | "operator_resolve";

export interface ReconciliationRunRow {
  readonly id: number;
  readonly accountId: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly status: ReconciliationRunStatus;
  readonly snapshotCapturedAt: Date | null;
  readonly snapshotComplete: boolean;
  readonly sourceCoverage: Record<string, unknown>;
  readonly expectedPositionsCount: number | null;
  readonly brokerPositionsCount: number | null;
  readonly matches: number | null;
  readonly mismatchesCount: number | null;
  readonly error: string | null;
  readonly report: Record<string, unknown> | null;
}

export interface ReconciliationHoldRow {
  readonly id: number;
  readonly accountId: string;
  readonly instrument: string;
  readonly conId: string | null;
  readonly secType: string | null;
  readonly exchange: string | null;
  readonly currency: string | null;
  readonly identityKey: string;
  readonly reason: HoldReason;
  readonly severity: HoldSeverity;
  readonly reconciliationRunId: number;
  readonly active: boolean;
  readonly payload: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgeNote: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedKind: ResolvedKind | null;
  readonly resolutionNote: string | null;
}

export interface BrokerOrderLinkRow {
  readonly id: number;
  readonly proposedOrderId: number;
  readonly accountId: string;
  readonly role: "PARENT" | "TP" | "SL";
  readonly roleOrdinal: number;
  readonly brokerOrderId: string | null;
  readonly permId: string | null;
  readonly parentPermId: string | null;
  readonly orderRef: string;
  readonly status: string | null;
  readonly observedAt: Date;
}

export interface PlanLegDraft {
  readonly role: "PARENT" | "TP" | "SL";
  readonly roleOrdinal: number;
  readonly orderRef: string;
}

export interface InsertPlanLegsInput {
  readonly proposedOrderId: number;
  readonly clientOrderId: string;
  readonly accountId: string;
  readonly legs: readonly PlanLegDraft[];
}

export interface InsertPlanLegsResult {
  readonly ok: boolean;
  readonly collidedRefs: readonly string[];
}

export class ReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Phase A publication (§7). Runs on a caller-owned `PoolClient`
   * that ALREADY holds the session-scoped `recon:<account>`
   * advisory lock.
   *
   * Wraps the sweep of abandoned RUNNING rows AND the INSERT of
   * the new RUNNING row in a single short transaction guarded by
   * `snap:<accountId>`.
   */
  async publishRunning(
    client: PoolClient,
    input: {
      readonly accountId: string;
      readonly sessionId: string;
      readonly runTimeoutMs: number;
    },
  ): Promise<{ runId: number }> {
    await client.query("BEGIN");
    try {
      await acquireSnapLock(client, input.accountId);
      // Sweep abandoned rows: prior-session RUNNING and
      // current-session RUNNING that exceeded the run timeout.
      await client.query(
        `UPDATE reconciliation_runs
           SET status = 'ABANDONED',
               completed_at = COALESCE(completed_at, NOW()),
               error = 'orphaned RUNNING row from prior session'
         WHERE status = 'RUNNING'
           AND account_id = $1
           AND session_id <> $2`,
        [input.accountId, input.sessionId],
      );
      await client.query(
        `UPDATE reconciliation_runs
           SET status = 'ABANDONED',
               completed_at = COALESCE(completed_at, NOW()),
               error = 'run_timeout'
         WHERE status = 'RUNNING'
           AND account_id = $1
           AND session_id = $2
           AND started_at < NOW() - ($3::BIGINT || ' milliseconds')::interval`,
        [input.accountId, input.sessionId, input.runTimeoutMs],
      );
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO reconciliation_runs (account_id, session_id, status, position_generation)
         VALUES ($1, $2, 'RUNNING', (SELECT generation FROM broker_snapshot_syncs WHERE account_id=$1)) RETURNING id`,
        [input.accountId, input.sessionId],
      );
      await client.query("COMMIT");
      return { runId: inserted.rows[0].id };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }

  /** Phase C publication (§7): finalise the run + upsert holds. */
  async publishResult(
    client: PoolClient,
    input: {
      readonly runId: number;
      readonly accountId: string;
      readonly finalStatus: ReconciliationRunStatus;
      readonly snapshot: BrokerReconciliationSnapshot | null;
      readonly matches: number;
      readonly mismatchesCount: number;
      readonly expectedPositionsCount: number;
      readonly brokerPositionsCount: number;
      readonly report: Record<string, unknown>;
      readonly error: string | null;
      readonly holdInserts: readonly HoldInsert[];
      readonly holdResolves: readonly HoldResolve[];
      readonly pendingLifecycle?: readonly LifecycleWriteback[];
      /**
       * PR15 r5 §1 — correlated broker-order observations. Every
       * record represents ONE broker row from ONE source; the
       * atomic operator link path REQUIRES all identifiers to
       * originate from the SAME row.
       */
      readonly brokerOrderObservations?: readonly BrokerOrderObservationInsert[];
    },
  ): Promise<void> {
    await client.query("BEGIN");
    try {
      await acquireSnapLock(client, input.accountId);
      await client.query(
        `UPDATE reconciliation_runs
           SET status = $1,
               completed_at = NOW(),
               snapshot_captured_at = $2,
               snapshot_complete = $3,
               source_coverage = $4::jsonb,
               expected_positions_count = $5,
               broker_positions_count = $6,
               matches = $7,
               mismatches_count = $8,
               error = $9,
               report = $10::jsonb,
               broker_snapshot = $12::jsonb
         WHERE id = $11`,
        [
          input.finalStatus,
          input.snapshot?.capturedAt ?? null,
          input.snapshot
            ? input.snapshot.exposureComplete && input.snapshot.recoveryComplete
            : false,
          JSON.stringify(input.snapshot?.sourceCoverage ?? {}),
          input.expectedPositionsCount,
          input.brokerPositionsCount,
          input.matches,
          input.mismatchesCount,
          input.error,
          JSON.stringify(input.report ?? {}),
          input.runId,
          input.snapshot ? JSON.stringify(input.snapshot) : null,
        ],
      );
      for (const insert of input.holdInserts) {
        await client.query(
          `INSERT INTO reconciliation_holds (
             account_id, instrument, conid, sec_type, exchange, currency,
             identity_key, reason, severity, reconciliation_run_id, payload
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
           ON CONFLICT (account_id, identity_key, reason)
             WHERE active
             DO UPDATE SET
               reconciliation_run_id = EXCLUDED.reconciliation_run_id,
               payload = EXCLUDED.payload,
               severity = EXCLUDED.severity`,
          [
            insert.accountId,
            insert.instrument,
            insert.conId,
            insert.secType,
            insert.exchange,
            insert.currency,
            insert.identityKey,
            insert.reason,
            insert.severity,
            input.runId,
            JSON.stringify(insert.payload ?? {}),
          ],
        );
      }
      // PR15 §9 — apply lifecycle transitions BEFORE resolving
      // any holds. Every transition returns the affected row so
      // we can tell whether the UPDATE actually landed. If the
      // rowCount is 0 (row already terminal / wrong state) we
      // skip the transition AND the holds that depended on it
      // — they stay active for operator review.
      const authorisedHoldIds = new Set<number>();
      const skipped: LifecycleSkip[] = [];
      for (const lc of input.pendingLifecycle ?? []) {
        let updated: { rowCount: number | null };
        if (lc.transition === "FILLED") {
          updated = await client.query(
            `UPDATE proposed_orders
                SET status = 'FILLED',
                    executed_at = COALESCE(executed_at, NOW()),
                    broker_order_id = COALESCE(broker_order_id, $1)
              WHERE id = $2 AND status = 'PROPOSED'
              RETURNING id`,
            [lc.brokerOrderId, lc.proposedOrderId],
          );
        } else if (lc.transition === "SUBMITTED") {
          updated = await client.query(
            `UPDATE proposed_orders
                SET status = 'SUBMITTED',
                    broker_order_id = COALESCE(broker_order_id, $1)
              WHERE id = $2 AND status = 'PROPOSED'
              RETURNING id`,
            [lc.brokerOrderId, lc.proposedOrderId],
          );
        } else if (lc.transition === "CANCELLED") {
          updated = await client.query(
            `UPDATE proposed_orders
                SET status = 'CANCELLED',
                    broker_order_id = COALESCE(broker_order_id, $1)
              WHERE id = $2 AND status IN ('PROPOSED', 'SUBMITTED')
              RETURNING id`,
            [lc.brokerOrderId, lc.proposedOrderId],
          );
        } else {
          updated = await client.query(
            `UPDATE proposed_orders
                SET status = 'REJECTED',
                    last_error = 'reconciliation: broker terminal ApiCancelled/Inactive',
                    broker_order_id = COALESCE(broker_order_id, $1)
              WHERE id = $2 AND status IN ('PROPOSED', 'SUBMITTED')
              RETURNING id`,
            [lc.brokerOrderId, lc.proposedOrderId],
          );
        }
        if ((updated.rowCount ?? 0) === 0) {
          skipped.push({
            proposedOrderId: lc.proposedOrderId,
            transition: lc.transition,
            reason: "transition_no_row_updated",
          });
          continue; // hold stays active — auto_broker_match refused
        }
        // Update leg links now that the transition succeeded.
        if (lc.brokerOrderId) {
          await client.query(
            `UPDATE broker_order_links
                SET broker_order_id = COALESCE(broker_order_id, $1),
                    status = $2,
                    observed_at = NOW(),
                    updated_at = NOW()
              WHERE proposed_order_id = $3
                AND role = 'PARENT'`,
            [lc.brokerOrderId, lc.transition, lc.proposedOrderId],
          );
        }
        for (const hid of lc.authorizeHoldIds) authorisedHoldIds.add(hid);
      }
      for (const r of input.holdResolves) {
        // Only apply hold resolves whose underlying transition
        // actually landed. Bare hold resolves (no linked
        // transition — e.g. `auto_snapshot_clean`) always run.
        if (r.resolvedKind === "auto_broker_match" && !authorisedHoldIds.has(r.holdId)) {
          skipped.push({
            proposedOrderId: 0,
            transition: "SUBMITTED",
            reason: `hold_resolve_refused: hold=${r.holdId} — required transition did not land`,
          });
          continue;
        }
        await client.query(
          `UPDATE reconciliation_holds
             SET active = FALSE,
                 resolved_at = NOW(),
                 resolved_by = $1,
                 resolved_kind = $2,
                 resolution_note = $3
           WHERE id = $4 AND active`,
          [r.resolvedBy, r.resolvedKind, r.resolutionNote, r.holdId],
        );
      }
      // PR15 r5 §1 — persist correlated broker-order observations
      // as full rows (source-tagged, one row per broker record).
      // The operator LINK_TO_BROKER_ORDER path matches on a
      // single row; independent OR-set lookups are forbidden.
      for (const obs of input.brokerOrderObservations ?? []) {
        await client.query(
          `INSERT INTO reconciliation_broker_order_observations (
             reconciliation_run_id, account_id, session_id, source,
             broker_order_id, perm_id, order_ref, broker_status,
             observed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.runId,
            obs.accountId,
            obs.sessionId,
            obs.source,
            obs.brokerOrderId,
            obs.permId,
            obs.orderRef,
            obs.brokerStatus,
            obs.observedAt,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }

  async failRunningRun(
    client: PoolClient,
    input: { readonly runId: number; readonly accountId: string; readonly sessionId: string; readonly reason: string },
  ): Promise<boolean> {
    await client.query("BEGIN");
    try {
      await acquireSnapLock(client, input.accountId);
      const result = await client.query(
        `UPDATE reconciliation_runs
           SET status = 'FAILED', completed_at = NOW(), snapshot_complete = false,
               snapshot_captured_at = NULL, broker_snapshot = NULL,
               source_coverage = '{}'::jsonb, error = $4, report = jsonb_build_object('error', $4::text)
         WHERE id = $1 AND account_id = $2 AND session_id = $3 AND status = 'RUNNING'`,
        [input.runId, input.accountId, input.sessionId, input.reason],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  /** Finalise a still-RUNNING row as ABANDONED (§7 timeout path). */
  async abandonRun(
    client: PoolClient,
    input: {
      readonly runId: number;
      readonly accountId: string;
      readonly reason: string;
    },
  ): Promise<void> {
    await client.query("BEGIN");
    try {
      await acquireSnapLock(client, input.accountId);
      await client.query(
        `UPDATE reconciliation_runs
           SET status = 'ABANDONED',
               completed_at = NOW(),
               error = $1
         WHERE id = $2 AND status = 'RUNNING'`,
        [input.reason, input.runId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  }

  async getLatestRunForSession(
    accountId: string,
    sessionId: string,
  ): Promise<ReconciliationRunRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM reconciliation_runs
       WHERE account_id = $1 AND session_id = $2
       ORDER BY started_at DESC LIMIT 1`,
      [accountId, sessionId],
    );
    return res.rowCount === 0 ? null : mapRun(res.rows[0]);
  }

  async getReadinessEvidence(accountId: string, sessionId: string): Promise<{
    running: boolean; latest: ReconciliationRunRow | null;
  }> {
    const result = await this.pool.query(`SELECT
      EXISTS(SELECT 1 FROM reconciliation_runs WHERE account_id=$1 AND session_id=$2 AND status='RUNNING') AS running,
      (SELECT row_to_json(r) FROM reconciliation_runs r WHERE account_id=$1 ORDER BY started_at DESC, id DESC LIMIT 1) AS latest`,
    [accountId, sessionId]);
    return { running: result.rows[0].running, latest: result.rows[0].latest ? mapRun(result.rows[0].latest) : null };
  }

  async getLatestRunOverall(
    accountId: string,
  ): Promise<ReconciliationRunRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM reconciliation_runs
       WHERE account_id = $1
       ORDER BY started_at DESC LIMIT 1`,
      [accountId],
    );
    return res.rowCount === 0 ? null : mapRun(res.rows[0]);
  }

  async getRunningRow(
    accountId: string,
    sessionId: string,
  ): Promise<ReconciliationRunRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM reconciliation_runs
       WHERE account_id = $1 AND session_id = $2 AND status = 'RUNNING'
       ORDER BY started_at DESC LIMIT 1`,
      [accountId, sessionId],
    );
    return res.rowCount === 0 ? null : mapRun(res.rows[0]);
  }

  async listActiveHolds(
    accountId?: string,
  ): Promise<readonly ReconciliationHoldRow[]> {
    const res = accountId
      ? await this.pool.query(
          `SELECT * FROM reconciliation_holds
           WHERE account_id = $1 AND active
           ORDER BY created_at DESC`,
          [accountId],
        )
      : await this.pool.query(
          `SELECT * FROM reconciliation_holds
           WHERE active
           ORDER BY created_at DESC`,
        );
    return res.rows.map(mapHold);
  }

  async listAllHolds(
    accountId: string,
    limit = 200,
  ): Promise<readonly ReconciliationHoldRow[]> {
    const res = await this.pool.query(
      `SELECT * FROM reconciliation_holds
       WHERE account_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [accountId, limit],
    );
    return res.rows.map(mapHold);
  }

  async getHoldById(id: number): Promise<ReconciliationHoldRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM reconciliation_holds WHERE id = $1`,
      [id],
    );
    return res.rowCount === 0 ? null : mapHold(res.rows[0]);
  }

  /**
   * Authoritative check used inside the PR14 submission tx.
   * Callers hold `snap:<accountId>` for consistency vs. the runner's
   * Phase A / Phase C.
   */
  async findActiveHoldForIdentity(
    client: PoolClient | Pool,
    accountId: string,
    identityKey: string,
  ): Promise<ReconciliationHoldRow | null> {
    const res = await client.query(
      `SELECT * FROM reconciliation_holds
       WHERE account_id = $1 AND identity_key = $2 AND active
       ORDER BY created_at DESC LIMIT 1`,
      [accountId, identityKey],
    );
    return res.rowCount === 0 ? null : mapHold(res.rows[0]);
  }

  async acknowledgeHold(input: {
    readonly holdId: number;
    readonly acknowledgedBy: string;
    readonly note: string | null;
  }): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE reconciliation_holds
         SET acknowledged_at = NOW(),
             acknowledged_by = $1,
             acknowledge_note = $2
       WHERE id = $3
       RETURNING id`,
      [input.acknowledgedBy, input.note, input.holdId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async operatorResolveHold(input: {
    readonly holdId: number;
    readonly resolvedBy: string;
    readonly resolutionNote: string;
    readonly resolutionIntent?: string;
  }): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE reconciliation_holds
         SET active = FALSE,
             resolved_at = NOW(),
             resolved_by = $1,
             resolved_kind = 'operator_resolve',
             resolution_note = $2,
             payload = COALESCE(payload, '{}'::jsonb)
               || jsonb_build_object('resolutionIntent', $3::text)
       WHERE id = $4 AND active
       RETURNING id`,
      [
        input.resolvedBy,
        input.resolutionNote,
        input.resolutionIntent ?? null,
        input.holdId,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Mark KEEP_BLOCKED as an acknowledgement without deactivating. */
  async markHoldKeepBlocked(input: {
    readonly holdId: number;
    readonly acknowledgedBy: string;
    readonly note: string;
  }): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE reconciliation_holds
         SET acknowledged_at = NOW(),
             acknowledged_by = $1,
             acknowledge_note = $2,
             payload = COALESCE(payload, '{}'::jsonb)
               || jsonb_build_object('resolutionIntent', 'KEEP_BLOCKED')
       WHERE id = $3 AND active
       RETURNING id`,
      [input.acknowledgedBy, input.note, input.holdId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Insert planned legs + ref-map rows in the SAME open transaction.
   * The `broker_order_ref_map` primary-key clash is the atomic
   * collision detector (see §4). A collision returns `ok=false`.
   *
   * Caller MUST have BEGIN'd the transaction on `client` before
   * calling this and MUST ROLLBACK on `ok=false`.
   */
  async insertPlanLegsAndRefs(
    client: PoolClient,
    input: InsertPlanLegsInput,
  ): Promise<InsertPlanLegsResult> {
    for (const leg of input.legs) {
      await client.query(
        `INSERT INTO broker_order_links (
           proposed_order_id, account_id, role, role_ordinal,
           order_ref, status
         ) VALUES ($1,$2,$3,$4,$5,'PLANNED')
         ON CONFLICT (proposed_order_id, order_ref) DO NOTHING`,
        [
          input.proposedOrderId,
          input.accountId,
          leg.role,
          leg.roleOrdinal,
          leg.orderRef,
        ],
      );
    }
    const refs = input.legs.map((l) => l.orderRef);
    const clientOrderIds = refs.map(() => input.clientOrderId);
    const proposedIds = refs.map(() => input.proposedOrderId);
    const roles = input.legs.map((l) => l.role);
    const inserted = await client.query<{ broker_order_ref: string }>(
      `INSERT INTO broker_order_ref_map (
         broker_order_ref, client_order_id, proposed_order_id, role
       )
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::bigint[], $4::text[]
       )
       ON CONFLICT (broker_order_ref) DO NOTHING
       RETURNING broker_order_ref`,
      [refs, clientOrderIds, proposedIds, roles],
    );
    const insertedRefs = new Set(inserted.rows.map((r) => r.broker_order_ref));
    const collidedRefs: string[] = [];
    for (const ref of refs) {
      if (!insertedRefs.has(ref)) collidedRefs.push(ref);
    }
    if (collidedRefs.length > 0) {
      return { ok: false, collidedRefs };
    }
    return { ok: true, collidedRefs: [] };
  }

  async listLinksForOrder(proposedOrderId: number): Promise<
    readonly BrokerOrderLinkRow[]
  > {
    const res = await this.pool.query(
      `SELECT * FROM broker_order_links
       WHERE proposed_order_id = $1
       ORDER BY role_ordinal ASC`,
      [proposedOrderId],
    );
    return res.rows.map(mapLink);
  }

  async lookupRef(ref: string): Promise<{
    readonly clientOrderId: string;
    readonly proposedOrderId: number;
    readonly role: string;
  } | null> {
    const res = await this.pool.query(
      `SELECT client_order_id, proposed_order_id, role
         FROM broker_order_ref_map WHERE broker_order_ref = $1`,
      [ref],
    );
    if (res.rowCount === 0) return null;
    return {
      clientOrderId: String(res.rows[0].client_order_id),
      proposedOrderId: Number(res.rows[0].proposed_order_id),
      role: String(res.rows[0].role),
    };
  }

  /**
   * PR15 §6 — atomic `LINK_TO_BROKER_ORDER` operator resolution.
   *
   * All under one transaction guarded by `snap:<accountId>`:
   *   1. verify the hold exists, is active, and belongs to
   *      `accountId`;
   *   2. verify the target broker order is not already linked to
   *      a DIFFERENT `proposed_order_id`;
   *   3. UPSERT the `broker_order_links` PARENT row;
   *   4. UPSERT the `broker_order_ref_map` row (if orderRef given);
   *   5. flip the hold to resolved.
   * Any failure rolls back — no partial link, no partial resolve.
   */
  async atomicOperatorLinkAndResolve(input: {
    readonly holdId: number;
    readonly proposedOrderId: number;
    readonly accountId: string;
    readonly brokerOrderId: string;
    readonly permId: string | null;
    readonly orderRef: string | null;
    readonly resolvedBy: string;
    readonly resolutionNote: string;
    /**
     * PR15 §4 — the operator link is only accepted if the
     * declared identifiers show up in the LATEST successful
     * reconciliation run for this exact session. Fresh run,
     * complete snapshot, matching sessionId. Anything else
     * (`broker_order_not_observed`) refuses the link and leaves
     * the hold active.
     */
    readonly currentSessionId: string;
    /**
     * Maximum age (seconds) of the reference reconciliation run.
     * Older = considered stale, link refused.
     */
    readonly snapshotMaxAgeSeconds: number;
  }): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [`snap:${input.accountId}`],
      );
      const holdRes = await client.query<{
        id: number;
        account_id: string;
        active: boolean;
      }>(
        `SELECT id, account_id, active FROM reconciliation_holds
          WHERE id = $1 FOR UPDATE`,
        [input.holdId],
      );
      if ((holdRes.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "hold_not_found" };
      }
      const holdRow = holdRes.rows[0];
      if (!holdRow.active) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "hold_already_resolved" };
      }
      if (holdRow.account_id !== input.accountId) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "hold_account_mismatch" };
      }
      // PR15 r5 §2 — snapshot verification via a SINGLE correlated
      // broker-order observation record. Every declared identifier
      // (brokerOrderId + optional permId + optional orderRef) MUST
      // originate from the SAME row of
      // `reconciliation_broker_order_observations`. We look up the
      // newest complete session run FIRST, then narrow the
      // observation match to that run.
      const runRes = await client.query<{
        id: number;
        completed_at: string;
      }>(
        `SELECT id, completed_at
           FROM reconciliation_runs
          WHERE account_id = $1
            AND session_id = $2
            AND snapshot_complete = TRUE
            AND status IN ('CLEAN', 'MISMATCH')
          ORDER BY completed_at DESC NULLS LAST
          LIMIT 1`,
        [input.accountId, input.currentSessionId],
      );
      if ((runRes.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "no_complete_snapshot_for_session" };
      }
      const runRow = runRes.rows[0];
      const runId = Number(runRow.id);
      const completedAt = new Date(runRow.completed_at);
      const ageMs = Date.now() - completedAt.getTime();
      if (ageMs > input.snapshotMaxAgeSeconds * 1000) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "snapshot_stale" };
      }
      // PR15 r6 §7 — fetch EVERY observation row for the same
      // (run, account, brokerOrderId). We must aggregate — a
      // single broker order can produce openOrder + completedOrder
      // + execution rows, each carrying a subset of identifiers.
      // Correlation invariants:
      //   * all rows share account_id + session_id + run + bid
      //     (SELECT already restricts to those);
      //   * any two non-null perm_id values on the group MUST
      //     agree;
      //   * any two non-null order_ref values on the group MUST
      //     agree;
      //   * any operator-supplied permId MUST have at least one
      //     row observing that same permId (non-null match);
      //   * any operator-supplied orderRef MUST have at least one
      //     row observing that same orderRef (non-null match).
      // Any violation → CORRELATION_CONFLICT. Absence of the
      // demanded correlation → CORRELATION_NOT_FOUND. Identifiers
      // are NEVER combined across different broker_order_id / run
      // / account / session.
      const obsRes = await client.query<{
        broker_order_id: string;
        perm_id: string | null;
        order_ref: string | null;
        session_id: string;
      }>(
        `SELECT broker_order_id, perm_id, order_ref, session_id
           FROM reconciliation_broker_order_observations
          WHERE reconciliation_run_id = $1
            AND account_id = $2
            AND session_id = $3
            AND broker_order_id = $4`,
        [runId, input.accountId, input.currentSessionId, input.brokerOrderId],
      );
      if ((obsRes.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "broker_order_not_observed" };
      }
      const permIds = new Set<string>();
      const orderRefs = new Set<string>();
      for (const r of obsRes.rows) {
        if (r.perm_id !== null && String(r.perm_id).length > 0)
          permIds.add(String(r.perm_id));
        if (r.order_ref !== null && String(r.order_ref).length > 0)
          orderRefs.add(String(r.order_ref));
      }
      if (permIds.size > 1) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "CORRELATION_CONFLICT" };
      }
      if (orderRefs.size > 1) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "CORRELATION_CONFLICT" };
      }
      if (input.permId !== null) {
        if (permIds.size === 0 || !permIds.has(input.permId)) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "CORRELATION_NOT_FOUND" };
        }
      }
      if (input.orderRef !== null) {
        if (orderRefs.size === 0 || !orderRefs.has(input.orderRef)) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "CORRELATION_NOT_FOUND" };
        }
      }
      // Ensure the target broker order is not already linked to a
      // DIFFERENT proposed_order_id (or ref map entry). We now use
      // ONLY the observation-verified values downstream (§2:
      // "zapisuj wartości z observation, a nie niezweryfikowane
      // wartości requestu").
      const verifiedBrokerOrderId = input.brokerOrderId;
      const verifiedPermId =
        permIds.size === 1 ? Array.from(permIds)[0] : null;
      const verifiedOrderRef =
        orderRefs.size === 1 ? Array.from(orderRefs)[0] : null;
      const dupRef = verifiedOrderRef
        ? await client.query<{ proposed_order_id: number }>(
            `SELECT proposed_order_id FROM broker_order_ref_map
              WHERE broker_order_ref = $1`,
            [verifiedOrderRef],
          )
        : { rowCount: 0, rows: [] as Array<{ proposed_order_id: number }> };
      if (
        (dupRef.rowCount ?? 0) > 0 &&
        Number(dupRef.rows[0].proposed_order_id) !== input.proposedOrderId
      ) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "order_ref_already_linked" };
      }
      const dupBid = await client.query<{ proposed_order_id: number }>(
        `SELECT proposed_order_id FROM broker_order_links
          WHERE broker_order_id = $1 AND account_id = $2`,
        [verifiedBrokerOrderId, input.accountId],
      );
      if (
        (dupBid.rowCount ?? 0) > 0 &&
        Number(dupBid.rows[0].proposed_order_id) !== input.proposedOrderId
      ) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "broker_order_already_linked" };
      }
      const effectiveOrderRef =
        verifiedOrderRef ??
        `operator-${input.proposedOrderId}-${verifiedBrokerOrderId}`;
      await client.query(
        `INSERT INTO broker_order_links (
           proposed_order_id, account_id, role, role_ordinal,
           broker_order_id, perm_id, order_ref, status
         ) VALUES ($1, $2, 'PARENT', 0, $3, $4, $5, 'OPERATOR_LINKED')
         ON CONFLICT (proposed_order_id, order_ref) DO UPDATE
           SET broker_order_id = COALESCE(EXCLUDED.broker_order_id, broker_order_links.broker_order_id),
               perm_id = COALESCE(EXCLUDED.perm_id, broker_order_links.perm_id),
               status = EXCLUDED.status,
               updated_at = NOW()`,
        [
          input.proposedOrderId,
          input.accountId,
          verifiedBrokerOrderId,
          verifiedPermId,
          effectiveOrderRef,
        ],
      );
      if (verifiedOrderRef) {
        await client.query(
          `INSERT INTO broker_order_ref_map (
             broker_order_ref, client_order_id, proposed_order_id, role
           )
           SELECT $1, COALESCE(client_order_id, 'operator'), id, 'PARENT'
             FROM proposed_orders WHERE id = $2
           ON CONFLICT (broker_order_ref) DO NOTHING`,
          [verifiedOrderRef, input.proposedOrderId],
        );
      }
      await client.query(
        `UPDATE reconciliation_holds
            SET active = FALSE,
                resolved_at = NOW(),
                resolved_by = $1,
                resolved_kind = 'operator_resolve',
                resolution_note = $2,
                payload = COALESCE(payload, '{}'::jsonb)
                  || jsonb_build_object(
                       'resolutionIntent', 'LINK_TO_BROKER_ORDER',
                       'brokerOrderId', $3::text,
                       'permId', $4::text,
                       'orderRef', $5::text,
                       'reconciliationRunId', $6::bigint
                     )
          WHERE id = $7`,
        [
          input.resolvedBy,
          input.resolutionNote,
          verifiedBrokerOrderId,
          verifiedPermId ?? "",
          verifiedOrderRef ?? "",
          runId,
          input.holdId,
        ],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * PR15 §6 — atomic `CONFIRMED_NOT_SUBMITTED` operator
   * resolution. Runs one transaction under `snap:<accountId>`:
   *   1. verify the hold + account;
   *   2. refuse if any positive broker link exists for the
   *      proposed order (positive match means it WAS submitted);
   *   3. mark the proposed_order REJECTED (never clearing
   *      `execution_attempted_at`);
   *   4. resolve the hold.
   */
  async atomicOperatorConfirmNotSubmitted(input: {
    readonly holdId: number;
    readonly proposedOrderId: number;
    readonly accountId: string;
    readonly resolvedBy: string;
    readonly resolutionNote: string;
  }): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [`snap:${input.accountId}`],
      );
      const holdRes = await client.query<{
        account_id: string;
        active: boolean;
      }>(
        `SELECT account_id, active FROM reconciliation_holds
          WHERE id = $1 FOR UPDATE`,
        [input.holdId],
      );
      if ((holdRes.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "hold_not_found" };
      }
      if (holdRes.rows[0].account_id !== input.accountId) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "hold_account_mismatch" };
      }
      if (!holdRes.rows[0].active) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "hold_already_resolved" };
      }
      const links = await client.query<{ status: string; broker_order_id: string | null; perm_id: string | null }>(
        `SELECT status, broker_order_id, perm_id
           FROM broker_order_links
          WHERE proposed_order_id = $1`,
        [input.proposedOrderId],
      );
      const hasPositive = links.rows.some(
        (r) =>
          (r.broker_order_id != null && r.status !== "PLANNED") ||
          r.perm_id != null,
      );
      if (hasPositive) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "positive_broker_match_exists" };
      }
      const rejected = await client.query(
        `UPDATE proposed_orders
            SET status = 'REJECTED',
                last_error = 'operator: confirmed not submitted'
          WHERE id = $1
            AND status = 'PROPOSED'
          RETURNING id`,
        [input.proposedOrderId],
      );
      if ((rejected.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "proposed_order_not_in_proposed_state" };
      }
      await client.query(
        `UPDATE reconciliation_holds
            SET active = FALSE,
                resolved_at = NOW(),
                resolved_by = $1,
                resolved_kind = 'operator_resolve',
                resolution_note = $2,
                payload = COALESCE(payload, '{}'::jsonb)
                  || jsonb_build_object('resolutionIntent', 'CONFIRMED_NOT_SUBMITTED')
          WHERE id = $3`,
        [input.resolvedBy, input.resolutionNote, input.holdId],
      );
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

async function acquireSnapLock(
  client: PoolClient,
  accountId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    [`snap:${accountId}`],
  );
}

export interface HoldInsert {
  readonly accountId: string;
  readonly instrument: string;
  readonly conId: string | null;
  readonly secType: string | null;
  readonly exchange: string | null;
  readonly currency: string | null;
  readonly identityKey: string;
  readonly reason: HoldReason;
  readonly severity: HoldSeverity;
  readonly payload: Record<string, unknown>;
}

export interface HoldResolve {
  readonly holdId: number;
  readonly resolvedBy: string;
  readonly resolvedKind: ResolvedKind;
  readonly resolutionNote: string;
}

/**
 * PR15 r5 §1 — one row per broker order/execution observed in
 * a reconciliation run. Written atomically with `publishResult`.
 */
export interface BrokerOrderObservationInsert {
  readonly accountId: string;
  readonly sessionId: string;
  readonly source: "OPEN_ORDER" | "COMPLETED_ORDER" | "EXECUTION";
  readonly brokerOrderId: string;
  readonly permId: string | null;
  readonly orderRef: string | null;
  readonly brokerStatus: string | null;
  readonly observedAt: Date;
}

function mapRun(row: Record<string, unknown>): ReconciliationRunRow {
  return {
    id: Number(row.id),
    accountId: String(row.account_id),
    sessionId: String(row.session_id),
    startedAt: asDate(row.started_at)!,
    completedAt: asDate(row.completed_at),
    status: String(row.status) as ReconciliationRunStatus,
    snapshotCapturedAt: asDate(row.snapshot_captured_at),
    snapshotComplete: row.snapshot_complete === true,
    sourceCoverage: (row.source_coverage as Record<string, unknown>) ?? {},
    expectedPositionsCount: asNumberOrNull(row.expected_positions_count),
    brokerPositionsCount: asNumberOrNull(row.broker_positions_count),
    matches: asNumberOrNull(row.matches),
    mismatchesCount: asNumberOrNull(row.mismatches_count),
    error: row.error == null ? null : String(row.error),
    report: (row.report as Record<string, unknown>) ?? null,
  };
}

function mapHold(row: Record<string, unknown>): ReconciliationHoldRow {
  return {
    id: Number(row.id),
    accountId: String(row.account_id),
    instrument: String(row.instrument),
    conId: row.conid == null ? null : String(row.conid),
    secType: row.sec_type == null ? null : String(row.sec_type),
    exchange: row.exchange == null ? null : String(row.exchange),
    currency: row.currency == null ? null : String(row.currency),
    identityKey: String(row.identity_key),
    reason: String(row.reason) as HoldReason,
    severity: String(row.severity) as HoldSeverity,
    reconciliationRunId: Number(row.reconciliation_run_id),
    active: row.active === true,
    payload: (row.payload as Record<string, unknown>) ?? null,
    createdAt: asDate(row.created_at)!,
    acknowledgedAt: asDate(row.acknowledged_at),
    acknowledgedBy:
      row.acknowledged_by == null ? null : String(row.acknowledged_by),
    acknowledgeNote:
      row.acknowledge_note == null ? null : String(row.acknowledge_note),
    resolvedAt: asDate(row.resolved_at),
    resolvedBy: row.resolved_by == null ? null : String(row.resolved_by),
    resolvedKind:
      row.resolved_kind == null
        ? null
        : (String(row.resolved_kind) as ResolvedKind),
    resolutionNote:
      row.resolution_note == null ? null : String(row.resolution_note),
  };
}

function mapLink(row: Record<string, unknown>): BrokerOrderLinkRow {
  return {
    id: Number(row.id),
    proposedOrderId: Number(row.proposed_order_id),
    accountId: String(row.account_id),
    role: String(row.role) as "PARENT" | "TP" | "SL",
    roleOrdinal: Number(row.role_ordinal),
    brokerOrderId: row.broker_order_id == null ? null : String(row.broker_order_id),
    permId: row.perm_id == null ? null : String(row.perm_id),
    parentPermId:
      row.parent_perm_id == null ? null : String(row.parent_perm_id),
    orderRef: String(row.order_ref),
    status: row.status == null ? null : String(row.status),
    observedAt: asDate(row.observed_at)!,
  };
}

function asDate(v: unknown): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(String(v));
}
function asNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
