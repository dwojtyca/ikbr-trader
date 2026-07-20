/**
 * PR15 — reconciliation runner (Phase A / Phase B / Phase C).
 *
 * See docs/implementation/phase2/PR15_PLAN.md §5, §6, §7.
 *
 * Phase A (short DB tx, dedicated PoolClient holding session-scoped
 * `recon:<accountId>` lock, briefly holds `snap:<accountId>` xact
 * lock): sweep abandoned RUNNING rows and INSERT a fresh
 * `status='RUNNING'` row. Commit and release `snap:` — `recon:`
 * remains on the same connection.
 *
 * Phase B (NO DB transaction, NO locks): `broker.capture(...)`
 * — bounded per-source timeouts, `AbortSignal` handed in so the
 * scheduler timeout branch can cancel + clean up.
 *
 * Phase C (short DB tx on the same connection, briefly holds
 * `snap:<accountId>` xact lock): UPDATE the run row to its final
 * status and UPSERT any hold changes. Between Phase A COMMIT and
 * Phase C COMMIT, submissions see `status='RUNNING'` and return
 * `RECONCILIATION_UNAVAILABLE`.
 *
 * Timeout / ABANDONED finalisation lives in a third short tx on
 * the same connection.
 */

import type { Pool, PoolClient } from "pg";
import type { Logger } from "pino";

import type { ExecutionRepository } from "../repository.js";
import type {
  BrokerReconciliationAdapter,
  BrokerReconciliationSnapshot,
  BrokerOrderRow,
  BrokerExecutionRow,
} from "./broker-adapter.js";
import {
  canonicaliseIdentity,
  type CanonicalIdentity,
} from "./identity.js";
import type {
  BrokerOrderObservationInsert,
  HoldInsert,
  HoldResolve,
  LifecycleWriteback,
  ReconciliationHoldRow,
  ReconciliationRepository,
  ReconciliationRunStatus,
} from "./repository.js";

export interface ReconciliationRunnerConfig {
  readonly runTimeoutMs: number;
  readonly sourceTimeoutMs: number;
  readonly executionSafetyMarginMs: number;
}

export interface RunnerContext {
  readonly accountId: string;
  readonly sessionId: string;
  readonly sessionStartedAt: Date;
}

export interface RunReport {
  readonly runId: number;
  readonly status: ReconciliationRunStatus;
  readonly exposureComplete: boolean;
  readonly recoveryComplete: boolean;
  readonly matches: number;
  readonly mismatches: number;
  readonly holdsCreated: number;
  readonly holdsResolved: number;
  readonly error: string | null;
}

export class ReconciliationRunner {
  constructor(
    private readonly pool: Pool,
    private readonly repo: ExecutionRepository,
    private readonly reconRepo: ReconciliationRepository,
    private readonly broker: BrokerReconciliationAdapter,
    private readonly logger: Pick<Logger, "info" | "warn" | "error"> = console as unknown as Logger,
  ) {}

  /**
   * Try to run one reconciliation for `accountId` under `sessionId`.
   * Returns `null` when another runner already holds
   * `recon:<accountId>` (skip tick per §7 concurrency).
   */
  async runOnce(
    context: RunnerContext,
    config: ReconciliationRunnerConfig,
  ): Promise<RunReport | null> {
    const client = await this.pool.connect();
    try {
      const acquired = await this.#tryAcquireReconLock(
        client,
        context.accountId,
      );
      if (!acquired) return null;
      try {
        return await this.#runUnderLock(client, context, config);
      } finally {
        await this.#releaseReconLock(client, context.accountId);
      }
    } finally {
      client.release();
    }
  }

  async #runUnderLock(
    client: PoolClient,
    context: RunnerContext,
    config: ReconciliationRunnerConfig,
  ): Promise<RunReport> {
    // Phase A — publish RUNNING.
    const { runId } = await this.reconRepo.publishRunning(client, {
      accountId: context.accountId,
      sessionId: context.sessionId,
      runTimeoutMs: config.runTimeoutMs,
    });

    // Phase B — broker reads with bounded run timeout + AbortSignal.
    const controller = new AbortController();
    const runDeadline = setTimeout(
      () => controller.abort(),
      config.runTimeoutMs,
    );
    let snapshot: BrokerReconciliationSnapshot | null = null;
    let captureError: Error | null = null;
    try {
      const oldest = await this.#findOldestAmbiguousAttemptedAt();
      snapshot = await this.broker.capture({
        accountId: context.accountId,
        sessionId: context.sessionId,
        sessionStartedAt: context.sessionStartedAt,
        oldestAmbiguousAttemptedAt: oldest,
        safetyMarginMs: config.executionSafetyMarginMs,
        sourceTimeoutMs: config.sourceTimeoutMs,
        abortSignal: controller.signal,
      });
    } catch (err) {
      captureError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(runDeadline);
    }

    if (controller.signal.aborted) {
      await this.reconRepo.abandonRun(client, {
        runId,
        accountId: context.accountId,
        reason: "run_timeout",
      });
      return {
        runId,
        status: "ABANDONED",
        exposureComplete: false,
        recoveryComplete: false,
        matches: 0,
        mismatches: 0,
        holdsCreated: 0,
        holdsResolved: 0,
        error: "run_timeout",
      };
    }
    if (captureError || !snapshot) {
      await this.reconRepo.publishResult(client, {
        runId,
        accountId: context.accountId,
        finalStatus: "FAILED",
        snapshot: null,
        matches: 0,
        mismatchesCount: 0,
        expectedPositionsCount: 0,
        brokerPositionsCount: 0,
        report: { error: captureError?.message ?? "unknown_capture_error" },
        error: captureError?.message ?? "unknown_capture_error",
        holdInserts: [],
        holdResolves: [],
      });
      return {
        runId,
        status: "FAILED",
        exposureComplete: false,
        recoveryComplete: false,
        matches: 0,
        mismatches: 0,
        holdsCreated: 0,
        holdsResolved: 0,
        error: captureError?.message ?? "unknown_capture_error",
      };
    }

    // Phase C — reconcile + persist.
    const plan = await this.#reconcile(context, snapshot);
    // PR15 r5 §1 — correlated broker-order observations. One row
    // per broker source record; the operator link path requires
    // all identifiers to originate from the SAME observation row.
    const brokerOrderObservations: BrokerOrderObservationInsert[] = [];
    for (const r of snapshot.openOrders) {
      const bid = String(r.brokerOrderId ?? "");
      if (bid.length === 0) continue;
      brokerOrderObservations.push({
        accountId: context.accountId,
        sessionId: context.sessionId,
        source: "OPEN_ORDER",
        brokerOrderId: bid,
        permId: r.permId ? String(r.permId) : null,
        orderRef: r.orderRef ? String(r.orderRef) : null,
        brokerStatus: r.status ? String(r.status) : null,
        observedAt: r.observedAt ?? snapshot.capturedAt,
      });
    }
    for (const r of snapshot.completedOrders) {
      const bid = String(r.brokerOrderId ?? "");
      if (bid.length === 0) continue;
      brokerOrderObservations.push({
        accountId: context.accountId,
        sessionId: context.sessionId,
        source: "COMPLETED_ORDER",
        brokerOrderId: bid,
        permId: r.permId ? String(r.permId) : null,
        orderRef: r.orderRef ? String(r.orderRef) : null,
        brokerStatus: r.terminalStatus
          ? String(r.terminalStatus)
          : r.status
            ? String(r.status)
            : null,
        observedAt: r.observedAt ?? snapshot.capturedAt,
      });
    }
    for (const r of snapshot.executions) {
      const bid = String(r.brokerOrderId ?? "");
      if (bid.length === 0) continue;
      brokerOrderObservations.push({
        accountId: context.accountId,
        sessionId: context.sessionId,
        source: "EXECUTION",
        brokerOrderId: bid,
        permId: r.permId ? String(r.permId) : null,
        orderRef: r.orderRef ? String(r.orderRef) : null,
        brokerStatus: null,
        observedAt: r.executedAt ?? snapshot.capturedAt,
      });
    }
    await this.reconRepo.publishResult(client, {
      runId,
      accountId: context.accountId,
      finalStatus: plan.finalStatus,
      snapshot,
      matches: plan.matches,
      mismatchesCount: plan.mismatches.length,
      expectedPositionsCount: plan.expectedCount,
      brokerPositionsCount: plan.brokerCount,
      report: {
        matches: plan.matches,
        mismatches: plan.mismatches,
        exposureComplete: snapshot.exposureComplete,
        recoveryComplete: snapshot.recoveryComplete,
        ambiguousOrdersEvaluated: plan.ambiguousEvaluated,
        lifecycleTransitions: plan.pendingLifecycle.length,
        brokerOrderObservationCount: brokerOrderObservations.length,
      },
      error: null,
      holdInserts: plan.holdInserts,
      holdResolves: plan.holdResolves,
      pendingLifecycle: plan.pendingLifecycle,
      brokerOrderObservations,
    });
    return {
      runId,
      status: plan.finalStatus,
      exposureComplete: snapshot.exposureComplete,
      recoveryComplete: snapshot.recoveryComplete,
      matches: plan.matches,
      mismatches: plan.mismatches.length,
      holdsCreated: plan.holdInserts.length,
      holdsResolved: plan.holdResolves.length,
      error: null,
    };
  }

  async #findOldestAmbiguousAttemptedAt(): Promise<Date | null> {
    const res = await this.pool.query<{ ts: Date | null }>(
      `SELECT MIN(execution_attempted_at) AS ts
         FROM proposed_orders
        WHERE status = 'PROPOSED'
          AND execution_attempted_at IS NOT NULL
          AND executed_at IS NULL`,
    );
    const raw = res.rows[0]?.ts;
    if (!raw) return null;
    return raw instanceof Date ? raw : new Date(String(raw));
  }

  async #reconcile(
    context: RunnerContext,
    snapshot: BrokerReconciliationSnapshot,
  ): Promise<{
    finalStatus: ReconciliationRunStatus;
    matches: number;
    mismatches: Array<{
      identityKey: string;
      expected: number;
      broker: number;
      diff: number;
      symbol: string;
    }>;
    expectedCount: number;
    brokerCount: number;
    holdInserts: HoldInsert[];
    holdResolves: HoldResolve[];
    ambiguousEvaluated: number;
    pendingLifecycle: LifecycleWriteback[];
  }> {
    // 1) Position diff, identity-keyed.
    const expected = await this.repo.computeExpectedNetPositionsWithIdentity(
      context.accountId,
    );
    const expectedByKey = new Map<
      string,
      {
        identity: CanonicalIdentity;
        net: number;
      }
    >();
    for (const row of expected) {
      const identity = canonicaliseIdentity({
        accountId: row.accountId ?? context.accountId,
        conId: row.conId,
        symbol: row.symbol,
        secType: row.secType,
        exchange: row.exchange,
        currency: row.currency,
      });
      if (identity.ambiguous) continue; // never aggregate across accounts
      const prev = expectedByKey.get(identity.identityKey);
      expectedByKey.set(identity.identityKey, {
        identity,
        net: (prev?.net ?? 0) + row.netShares,
      });
    }

    const brokerByKey = new Map<
      string,
      { identity: CanonicalIdentity; net: number }
    >();
    for (const pos of snapshot.positions) {
      const identity = canonicaliseIdentity({
        accountId: pos.accountId,
        conId: pos.conId,
        symbol: pos.symbol,
        secType: pos.secType,
        exchange: pos.exchange,
        currency: pos.currency,
      });
      if (identity.ambiguous) continue;
      const prev = brokerByKey.get(identity.identityKey);
      brokerByKey.set(identity.identityKey, {
        identity,
        net: (prev?.net ?? 0) + pos.position,
      });
    }

    const allKeys = new Set<string>([
      ...expectedByKey.keys(),
      ...brokerByKey.keys(),
    ]);

    const holdInserts: HoldInsert[] = [];
    const holdResolves: HoldResolve[] = [];
    const pendingLifecycle: LifecycleWriteback[] = [];
    const mismatches: Array<{
      identityKey: string;
      expected: number;
      broker: number;
      diff: number;
      symbol: string;
    }> = [];
    let matches = 0;

    const activeHolds = await this.reconRepo.listActiveHolds(context.accountId);
    const holdsByKeyReason = new Map<string, ReconciliationHoldRow>();
    for (const h of activeHolds) {
      holdsByKeyReason.set(`${h.identityKey}|${h.reason}`, h);
    }

    for (const key of allKeys) {
      const exp = expectedByKey.get(key);
      const brk = brokerByKey.get(key);
      const identity = (exp?.identity ?? brk?.identity)!;
      const diff = (brk?.net ?? 0) - (exp?.net ?? 0);
      if (Math.abs(diff) < 0.000001) {
        matches += 1;
        // Position clean — auto-resolve any active position_mismatch
        // on this identity when exposureComplete=true.
        if (snapshot.exposureComplete) {
          const existing = holdsByKeyReason.get(`${key}|position_mismatch`);
          if (existing) {
            holdResolves.push({
              holdId: existing.id,
              resolvedBy: "system",
              resolvedKind: "auto_snapshot_clean",
              resolutionNote: `resolved by run over identity=${key}`,
            });
          }
        }
        continue;
      }
      if (!snapshot.exposureComplete) continue; // do not create holds on incomplete exposure
      mismatches.push({
        identityKey: key,
        expected: exp?.net ?? 0,
        broker: brk?.net ?? 0,
        diff,
        symbol: identity.symbol,
      });
      holdInserts.push({
        accountId: context.accountId,
        instrument: identity.symbol,
        conId: identity.conId,
        secType: identity.secType,
        exchange: identity.exchange,
        currency: identity.currency,
        identityKey: key,
        reason: "position_mismatch",
        severity: "error",
        payload: {
          expected: exp?.net ?? 0,
          broker: brk?.net ?? 0,
          diff,
        },
      });
    }

    // 2) Orphan broker orders (open orders NOT owned by us).
    if (snapshot.exposureComplete) {
      const orphans = await this.#findOrphanOpenOrders(
        context.accountId,
        snapshot.openOrders,
      );
      for (const o of orphans) {
        const identity = canonicaliseIdentity({
          accountId: context.accountId,
          conId: o.conId,
          symbol: o.symbol ?? "",
          secType: o.secType,
          exchange: o.exchange,
          currency: o.currency,
        });
        if (identity.ambiguous) continue;
        holdInserts.push({
          accountId: context.accountId,
          instrument: identity.symbol,
          conId: identity.conId,
          secType: identity.secType,
          exchange: identity.exchange,
          currency: identity.currency,
          identityKey: identity.identityKey,
          reason: "orphan_broker_order",
          severity: "warn",
          payload: {
            brokerOrderId: o.brokerOrderId,
            orderRef: o.orderRef ?? null,
            clientId: o.clientId ?? null,
            status: o.status,
          },
        });
      }
    }

    // 3) Ambiguous PROPOSED recovery.
    const ambiguousRows = await this.#loadAmbiguousProposed(context.accountId);
    // Load per-row (NOT global) authoritative identifiers so a
    // spoofed / mis-attributed match cannot resolve the WRONG
    // ambiguous row: row A must only be matchable against A's
    // own persisted refs / permIds / broker order IDs.
    const identifiersByOrder = await this.#loadIdentifiersByProposedOrder(
      ambiguousRows,
    );
    let ambiguousEvaluated = 0;
    for (const row of ambiguousRows) {
      ambiguousEvaluated += 1;
      const ownIds =
        identifiersByOrder.get(row.proposedOrderId) ?? emptyIdentifiers();
      const match = this.#matchAmbiguousToBroker(row, snapshot, ownIds);
      if (match.kind === "positive") {
        // Derive the target status transition from broker evidence.
        // Conservative: only unambiguous signals allowed. Missing /
        // conflicting signals leave the row PROPOSED (hold stays).
        const brokerRow = allOrders(snapshot).find(
          (o) =>
            o.brokerOrderId === match.brokerOrderId ||
            (typeof o.orderRef === "string" && ownIds.orderRefs.has(o.orderRef)),
        );
        // Execution-only recovery: match by ANY of our persisted
        // brokerOrderIds — the openOrder may have already been
        // removed by the broker while executions are still visible.
        const execs = snapshot.executions.filter(
          (e) =>
            e.brokerOrderId === match.brokerOrderId ||
            ownIds.brokerOrderIds.has(e.brokerOrderId),
        );
        const statusTransition = deriveStatusFromBroker(
          brokerRow,
          execs,
          row.quantity,
        );
        if (statusTransition === null) {
          // Conflicting / insufficient evidence — do NOT resolve the
          // hold; leave the row PROPOSED. This is intentionally
          // strict: an unknown_submission hold with a partial match
          // is worse than no auto-recovery.
          continue;
        }
        const authorizeHoldIds: number[] = [];
        const hold = holdsByKeyReason.get(
          `${row.identityKey}|unknown_submission`,
        );
        if (hold) {
          authorizeHoldIds.push(hold.id);
          holdResolves.push({
            holdId: hold.id,
            resolvedBy: "system",
            resolvedKind: "auto_broker_match",
            resolutionNote: `matched via ${match.matchedBy} → ${statusTransition}`,
          });
        }
        const recovHold = holdsByKeyReason.get(
          `${row.identityKey}|recovery_source_missing`,
        );
        if (recovHold) {
          authorizeHoldIds.push(recovHold.id);
          holdResolves.push({
            holdId: recovHold.id,
            resolvedBy: "system",
            resolvedKind: "auto_broker_match",
            resolutionNote: `matched via ${match.matchedBy} → ${statusTransition}`,
          });
        }
        // Persist status writeback + hold resolves atomically.
        // The `authorizeHoldIds` binding tells the repo that
        // these holds may only be resolved if the transition
        // UPDATE actually lands (rowCount > 0).
        pendingLifecycle.push({
          proposedOrderId: row.proposedOrderId,
          brokerOrderId: match.brokerOrderId,
          matchedBy: match.matchedBy,
          transition: statusTransition,
          authorizeHoldIds,
        });
      } else if (
        match.kind === "no_match" &&
        snapshot.exposureComplete &&
        snapshot.recoveryComplete
      ) {
        holdInserts.push({
          accountId: context.accountId,
          instrument: row.instrument,
          conId: row.conId,
          secType: row.secType,
          exchange: row.exchange,
          currency: row.currency,
          identityKey: row.identityKey,
          reason: "unknown_submission",
          severity: "critical",
          payload: {
            proposedOrderId: row.proposedOrderId,
            clientOrderId: row.clientOrderId,
            executionAttemptedAt: row.executionAttemptedAt?.toISOString() ?? null,
          },
        });
      } else if (
        match.kind === "no_match" &&
        snapshot.exposureComplete &&
        !snapshot.recoveryComplete
      ) {
        holdInserts.push({
          accountId: context.accountId,
          instrument: row.instrument,
          conId: row.conId,
          secType: row.secType,
          exchange: row.exchange,
          currency: row.currency,
          identityKey: row.identityKey,
          reason: "recovery_source_missing",
          severity: "warn",
          payload: {
            proposedOrderId: row.proposedOrderId,
            clientOrderId: row.clientOrderId,
            reason:
              snapshot.sourceCoverage.completedOrders.reason ??
              "recovery_source_missing",
          },
        });
      }
    }

    const finalStatus: ReconciliationRunStatus = !snapshot.exposureComplete
      ? "INCOMPLETE"
      : !snapshot.recoveryComplete
        ? "INCOMPLETE"
        : mismatches.length > 0 || holdInserts.length > 0
          ? "MISMATCH"
          : "CLEAN";

    return {
      finalStatus,
      matches,
      mismatches,
      expectedCount: expectedByKey.size,
      brokerCount: brokerByKey.size,
      holdInserts,
      holdResolves,
      ambiguousEvaluated,
      pendingLifecycle,
    };
  }

  async #loadAmbiguousProposed(accountId: string): Promise<
    Array<{
      proposedOrderId: number;
      clientOrderId: string | null;
      instrument: string;
      conId: string | null;
      secType: string | null;
      exchange: string | null;
      currency: string | null;
      brokerOrderId: string | null;
      executionAttemptedAt: Date | null;
      identityKey: string;
      quantity: number;
    }>
  > {
    const res = await this.pool.query(
      `SELECT id, client_order_id, instrument, conid, broker_order_id,
              execution_attempted_at, execution_account_id, quantity
         FROM proposed_orders
        WHERE status = 'PROPOSED'
          AND execution_attempted_at IS NOT NULL
          AND executed_at IS NULL
          AND (execution_account_id IS NULL OR execution_account_id = $1)`,
      [accountId],
    );
    return res.rows.map((row) => {
      const identity = canonicaliseIdentity({
        accountId,
        conId: row.conid,
        symbol: row.instrument,
      });
      return {
        proposedOrderId: Number(row.id),
        clientOrderId:
          row.client_order_id == null ? null : String(row.client_order_id),
        instrument: String(row.instrument),
        conId: row.conid == null ? null : String(row.conid),
        secType: null,
        exchange: null,
        currency: null,
        brokerOrderId:
          row.broker_order_id == null ? null : String(row.broker_order_id),
        executionAttemptedAt: row.execution_attempted_at
          ? row.execution_attempted_at instanceof Date
            ? row.execution_attempted_at
            : new Date(String(row.execution_attempted_at))
          : null,
        identityKey: identity.identityKey,
        quantity: Number(row.quantity ?? 0),
      };
    });
  }

  #matchAmbiguousToBroker(
    row: {
      proposedOrderId: number;
      clientOrderId: string | null;
      brokerOrderId: string | null;
    },
    snapshot: BrokerReconciliationSnapshot,
    ownIds: PerOrderIdentifiers,
  ):
    | { kind: "positive"; matchedBy: string; brokerOrderId: string | null }
    | { kind: "no_match" }
    | { kind: "insufficient_coverage" } {
    // Priority: exact orderRef → persisted permId → persisted
    // brokerOrderId → execution linked by one of the above.
    // Each check consults the ROW'S OWN authoritative identifiers
    // only — row A cannot be matched against row B's orderRef.
    if (ownIds.orderRefs.size > 0) {
      const hit = allOrders(snapshot).find(
        (o) => typeof o.orderRef === "string" && ownIds.orderRefs.has(o.orderRef),
      );
      if (hit) {
        return {
          kind: "positive",
          matchedBy: "orderRef",
          brokerOrderId: hit.brokerOrderId,
        };
      }
    }
    if (ownIds.permIds.size > 0) {
      const hit = allOrders(snapshot).find(
        (o) => typeof o.permId === "string" && ownIds.permIds.has(o.permId),
      );
      if (hit) {
        return {
          kind: "positive",
          matchedBy: "permId",
          brokerOrderId: hit.brokerOrderId,
        };
      }
    }
    const brokerIds = new Set<string>(ownIds.brokerOrderIds);
    if (row.brokerOrderId) brokerIds.add(row.brokerOrderId);
    if (brokerIds.size > 0) {
      const hit = allOrders(snapshot).find(
        (o) => brokerIds.has(o.brokerOrderId),
      );
      if (hit) {
        return {
          kind: "positive",
          matchedBy: "brokerOrderId",
          brokerOrderId: hit.brokerOrderId,
        };
      }
      const execHit = snapshot.executions.find(
        (e: BrokerExecutionRow) => brokerIds.has(e.brokerOrderId),
      );
      if (execHit) {
        return {
          kind: "positive",
          matchedBy: "execution",
          brokerOrderId: execHit.brokerOrderId,
        };
      }
    }
    if (!snapshot.exposureComplete) return { kind: "insufficient_coverage" };
    return { kind: "no_match" };
  }

  async #loadIdentifiersByProposedOrder(
    rows: readonly { readonly proposedOrderId: number; readonly brokerOrderId: string | null }[],
  ): Promise<ReadonlyMap<number, PerOrderIdentifiers>> {
    const out = new Map<number, PerOrderIdentifiers>();
    if (rows.length === 0) return out;
    const ids = rows.map((r) => r.proposedOrderId);
    // Seed the map so each row starts with an empty (but present)
    // entry — the matcher can then safely default to `emptyIdentifiers`.
    for (const r of rows) {
      out.set(r.proposedOrderId, emptyIdentifiers());
      if (r.brokerOrderId) out.get(r.proposedOrderId)!.brokerOrderIds.add(r.brokerOrderId);
    }
    const refs = await this.pool.query<{
      broker_order_ref: string;
      proposed_order_id: number;
    }>(
      `SELECT broker_order_ref, proposed_order_id FROM broker_order_ref_map
        WHERE proposed_order_id = ANY($1::bigint[])`,
      [ids],
    );
    for (const row of refs.rows) {
      const entry = out.get(Number(row.proposed_order_id));
      if (entry) entry.orderRefs.add(String(row.broker_order_ref));
    }
    const links = await this.pool.query<{
      proposed_order_id: number;
      broker_order_id: string | null;
      perm_id: string | null;
    }>(
      `SELECT proposed_order_id, broker_order_id, perm_id
         FROM broker_order_links
        WHERE proposed_order_id = ANY($1::bigint[])`,
      [ids],
    );
    for (const row of links.rows) {
      const entry = out.get(Number(row.proposed_order_id));
      if (!entry) continue;
      if (row.broker_order_id) entry.brokerOrderIds.add(String(row.broker_order_id));
      if (row.perm_id) entry.permIds.add(String(row.perm_id));
    }
    return out;
  }

  async #findOrphanOpenOrders(
    accountId: string,
    openOrders: readonly BrokerOrderRow[],
  ): Promise<readonly BrokerOrderRow[]> {
    if (openOrders.length === 0) return [];
    const refs = openOrders
      .map((o) => o.orderRef)
      .filter((r): r is string => typeof r === "string" && r.length > 0);
    const owned = new Set<string>();
    if (refs.length > 0) {
      const res = await this.pool.query<{ broker_order_ref: string }>(
        `SELECT broker_order_ref FROM broker_order_ref_map
          WHERE broker_order_ref = ANY($1::text[])`,
        [refs],
      );
      for (const r of res.rows) owned.add(String(r.broker_order_ref));
    }
    const orphans: BrokerOrderRow[] = [];
    for (const o of openOrders) {
      if (o.orderRef && owned.has(o.orderRef)) continue;
      orphans.push(o);
    }
    void accountId;
    return orphans;
  }

  async #tryAcquireReconLock(
    client: PoolClient,
    accountId: string,
  ): Promise<boolean> {
    const res = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
      [`recon:${accountId}`],
    );
    return res.rows[0]?.ok === true;
  }

  async #releaseReconLock(
    client: PoolClient,
    accountId: string,
  ): Promise<void> {
    await client
      .query(`SELECT pg_advisory_unlock(hashtext($1))`, [`recon:${accountId}`])
      .catch(() => undefined);
  }
}

function allOrders(
  snapshot: BrokerReconciliationSnapshot,
): readonly BrokerOrderRow[] {
  return [...snapshot.openOrders, ...snapshot.completedOrders];
}

interface PerOrderIdentifiers {
  readonly orderRefs: Set<string>;
  readonly permIds: Set<string>;
  readonly brokerOrderIds: Set<string>;
}
function emptyIdentifiers(): PerOrderIdentifiers {
  return {
    orderRefs: new Set<string>(),
    permIds: new Set<string>(),
    brokerOrderIds: new Set<string>(),
  };
}

/**
 * PR15 §9 — lifecycle writeback re-export. The canonical type
 * lives in `./repository.ts` to avoid a circular import between
 * repository → runner. Re-exported here for callers that already
 * pull the runner types.
 */
export type { LifecycleWriteback } from "./repository.js";

/**
 * Conservative broker → local transition table (§9). Missing or
 * conflicting broker evidence returns `null` — the runner then
 * leaves the row PROPOSED and the hold active.
 *
 * `expectedQuantity` is the local `proposed_orders.quantity`.
 * It enables execution-only recovery when the broker order has
 * disappeared from `openOrders` and `completedOrders` is
 * unsupported: if `sum(|shares|) >= expectedQuantity` we can
 * still conclude FILLED; a smaller positive sum is SUBMITTED
 * (partial). Zero executions with no other signal returns
 * `null`.
 */
function deriveStatusFromBroker(
  brokerRow:
    | {
        readonly status?: string;
        readonly filled?: number | null;
        readonly remaining?: number | null;
      }
    | undefined,
  executions: readonly { readonly shares: number }[],
  expectedQuantity: number,
): "SUBMITTED" | "FILLED" | "CANCELLED" | "REJECTED" | null {
  const status = String(brokerRow?.status ?? "").toLowerCase();
  const filled = Number(brokerRow?.filled ?? 0);
  const remaining = Number(brokerRow?.remaining ?? 0);
  const totalExec = executions.reduce(
    (acc, e) => acc + Math.abs(Number(e.shares ?? 0)),
    0,
  );
  if (status === "filled" && remaining === 0 && filled > 0) return "FILLED";
  if (
    expectedQuantity > 0 &&
    totalExec + 1e-9 >= expectedQuantity
  ) {
    // Execution-only path: broker openOrder gone, completedOrders
    // unsupported, but executions sum unambiguously covers the
    // expected quantity.
    return "FILLED";
  }
  if (status === "cancelled") return "CANCELLED";
  if (status === "apicancelled" || status === "inactive") return "REJECTED";
  if (status === "submitted" || status === "presubmitted") {
    return totalExec > 0 && totalExec < expectedQuantity ? "SUBMITTED" : "SUBMITTED";
  }
  if (filled > 0 && remaining > 0) return "SUBMITTED"; // partial fill on open
  if (totalExec > 0 && totalExec < expectedQuantity) return "SUBMITTED"; // partial via executions only
  return null;
}
