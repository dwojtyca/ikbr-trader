import { Pool, type PoolClient } from "pg";
import {
  AiDecision,
  DecisionSource,
  IndicatorSnapshot,
  ProposedOrder,
  ProposedOrderStatus,
  SignalTicket,
  Side,
  deriveOrderDiagnostics,
} from "@ikbr/shared";
import {
  BrokerCommissionReport,
  BrokerExecutionFill,
  BrokerOrderStatusUpdate,
} from "./tws-execution-client.js";
import { runMigrations } from "./migrations.js";

export type DecisionActor = "llm-agent" | "user" | "user_override";

interface ProposedOrderRow {
  id: number;
  instrument: string;
  conid: string | null;
  side: Side;
  position_effect: "OPEN_OR_ADD" | "CLOSE_OR_REDUCE" | null;
  order_type: "MKT" | "LMT" | "STP";
  quantity: number;
  entry: number | null;
  stop: number | null;
  take_profit: number | null;
  reason: string;
  confidence: number;
  risk_check_status: "PASS" | "REJECT";
  status: string;
  strategy: string | null;
  indicator_snapshot: string | null;
  decision_source: DecisionSource | null;
  decision_actor: DecisionActor | null;
  ai_decision: AiDecision | null;
  ai_reason: string | null;
  ai_model: string | null;
  ai_decision_confidence: number | null;
  llm_decision_id: number | null;
  source_error: string | null;
  processing_owner: string | null;
  processing_claimed_at: Date | string | null;
  broker_order_id: string | null;
  execution_account_id: string | null;
  execution_message: string | null;
  last_error: string | null;
  execution_attempted_at: Date | string | null;
  executed_at: Date | string | null;
  created_at: Date | string;
}

export interface CumulativeRealizedPnlSummary {
  pnl: number;
  missingCommissionReports: number;
  missingFxRates: number;
  complete: boolean;
}

export interface ExpectedNetPosition {
  symbol: string;
  netShares: number;
  longShares: number;
  shortShares: number;
  fillsCount: number;
  lastFillAt: Date | null;
}

export interface SystemAlertRow {
  id: number;
  severity: "info" | "warn" | "error" | "CRITICAL";
  kind: string;
  message: string;
  payload: Record<string, unknown> | null;
  deliveredToTelegram: boolean;
  createdAt: Date;
}

export interface OrderListFilters {
  instrument?: string;
  side?: Side;
  orderType?: "MKT" | "LMT" | "STP";
  qty?: number;
  status?: ProposedOrderStatus;
  riskCheckStatus?: "PASS" | "REJECT";
  decisionSource?: DecisionSource;
  aiDecision?: AiDecision;
}

/**
 * PR14 round-5/6 blocker — explicit availability for the atomic
 * open-position guard. Callers MUST hand this in on every write
 * path (fresh INSERT via `insertProposedFromTicket` AND resume
 * via `tryStartSubmissionWithExposureGuard`). The type is
 * REQUIRED — never optional — so no code path can bypass the
 * check.
 *
 *   - `"available"` — supply the active broker `accountId`, the
 *     current process' `sessionId` (must match the sessionId
 *     that wrote the snapshot — after a restart the old
 *     snapshot is rejected even if `observedAt` is still fresh)
 *     and `maxSnapshotAgeMs`. The guard verifies session,
 *     freshness, completeness, and open position under the SAME
 *     advisory lock that gates the write.
 *   - `"unavailable"` — the caller has no active broker account
 *     yet (bootstrap pending). Fail-closed: no INSERT, no
 *     marker, no broker call. Returns
 *     `POSITION_STATE_UNAVAILABLE` with `reason:
 *     "no_active_account"` and NO DB read at all.
 */
export type PositionGuardContext =
  | {
      readonly kind: "available";
      readonly accountId: string;
      readonly sessionId: string;
      readonly maxSnapshotAgeMs: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "no_active_account";
    };

/**
 * Reasons the atomic exposure guard refuses a write. Mirrored
 * across `insertProposedFromTicket` (fresh) and
 * `tryStartSubmissionWithExposureGuard` (resume) so callers
 * classify identically regardless of path.
 */
export type PositionGuardBlockedReason =
  | "missing"
  | "stale"
  | "incomplete"
  | "no_active_account"
  | "wrong_session";

export interface OrderDecisionMetadata {
  decisionSource?: DecisionSource;
  decisionActor?: DecisionActor;
  aiDecision?: AiDecision;
  aiReason?: string;
  aiModel?: string;
  aiDecisionConfidence?: number;
  llmDecisionId?: number;
  sourceError?: string;
}

export interface ActiveSubmittedOrder {
  id: number;
  instrument: string;
  brokerOrderId?: string;
  createdAt: Date;
}

export interface TradeLegFill {
  execId: string;
  brokerOrderId: string | null;
  shares: number;
  price: number;
  executedAt: Date;
  commission: number | null;
}

export interface Trade {
  tradeKey: string;
  symbol: string;
  currency: string | null;
  status: "OPEN" | "CLOSED";
  side: "LONG" | "SHORT";
  qtyOpened: number;
  qtyClosed: number;
  qtyOpenRemaining: number;
  avgEntryPrice: number;
  avgExitPrice: number | null;
  entryAt: Date;
  exitAt: Date | null;
  holdMs: number | null;
  entryCommission: number;
  exitCommission: number;
  realizedPnl: number;
  realizedPnlPct: number | null;
  stop: number | null;
  takeProfit: number | null;
  proposedOrderId: number | null;
  entryBrokerOrderId: string | null;
  exitBrokerOrderIds: string[];
  strategy: string | null;
  reason: string | null;
  aiReason: string | null;
  aiDecision: string | null;
  decisionSource: string | null;
  entryFillCount: number;
  exitFillCount: number;
}

export class ExecutionRepository {
  constructor(private readonly pool: Pool) {}

  private static readonly IBKR_UNSET_DOUBLE_THRESHOLD = 1e307;

  private toFiniteNumber(value: unknown, fallback = 0): number {
    if (typeof value === "number")
      return Number.isFinite(value) ? value : fallback;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return fallback;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
  }

  private normalizeBrokerRealizedPnl(value: unknown): number {
    const parsed = this.toFiniteNumber(value, NaN);
    if (!Number.isFinite(parsed)) return 0;
    if (Math.abs(parsed) >= ExecutionRepository.IBKR_UNSET_DOUBLE_THRESHOLD)
      return 0;
    return parsed;
  }

  private parseBrokerExecutionTime(value?: string): Date | null {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const direct = new Date(raw);
    if (!Number.isNaN(direct.getTime())) return direct;

    const compact = raw.match(
      /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
    );
    if (compact) {
      const [, year, month, day, hour, minute, second] = compact;
      return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    }

    return null;
  }

  async getCumulativeRealizedPnL(options: {
    baseCurrency: string;
    fxToBaseByCurrency?: Record<string, number | undefined>;
  }): Promise<CumulativeRealizedPnlSummary> {
    const result = await this.pool.query(
      `
      SELECT exec_id, commission, commission_currency, realized_pnl, currency
      FROM broker_execution_fills
      ORDER BY COALESCE(executed_at, created_at) ASC, exec_id ASC
      `,
    );

    return this.aggregateRealizedPnL(
      result.rows,
      options.baseCurrency,
      options.fxToBaseByCurrency,
    );
  }

  /**
   * Realized PnL for fills with executed_at (or created_at fallback)
   * greater or equal to `since`. Used by the daily-loss kill-switch in
   * the execution-engine. Returns a summary with the same shape as
   * `getCumulativeRealizedPnL` so callers can inspect FX gaps.
   */
  async getRealizedPnLSince(options: {
    baseCurrency: string;
    since: Date;
    fxToBaseByCurrency?: Record<string, number | undefined>;
  }): Promise<CumulativeRealizedPnlSummary> {
    const result = await this.pool.query(
      `
      SELECT exec_id, commission, commission_currency, realized_pnl, currency
      FROM broker_execution_fills
      WHERE COALESCE(executed_at, created_at) >= $1
      ORDER BY COALESCE(executed_at, created_at) ASC, exec_id ASC
      `,
      [options.since],
    );

    return this.aggregateRealizedPnL(
      result.rows,
      options.baseCurrency,
      options.fxToBaseByCurrency,
    );
  }

  private aggregateRealizedPnL(
    rows: ReadonlyArray<{
      exec_id: string;
      commission: number | null;
      commission_currency: string | null;
      realized_pnl: number | null;
      currency: string | null;
    }>,
    baseCurrencyRaw: string,
    fxToBaseByCurrency?: Record<string, number | undefined>,
  ): CumulativeRealizedPnlSummary {
    const baseCurrency = baseCurrencyRaw.trim().toUpperCase();
    let realizedPnL = 0;
    let missingCommissionReports = 0;
    let missingFxRates = 0;

    for (const row of rows) {
      const pnlCurrency = String(
        row.commission_currency ?? row.currency ?? baseCurrency,
      )
        .trim()
        .toUpperCase();
      const fxToBase = this.toFiniteNumber(
        fxToBaseByCurrency?.[pnlCurrency] ??
          (pnlCurrency === baseCurrency ? 1 : NaN),
        NaN,
      );
      if (!Number.isFinite(fxToBase) || fxToBase <= 0) {
        missingFxRates += 1;
        continue;
      }
      const commission = this.toFiniteNumber(row.commission, 0);
      const realized = this.normalizeBrokerRealizedPnl(row.realized_pnl);

      if (row.commission === null) {
        missingCommissionReports += 1;
      }

      realizedPnL += (realized - commission) * fxToBase;
    }

    return {
      pnl: realizedPnL,
      missingCommissionReports,
      missingFxRates,
      complete:
        rows.length !== 0 &&
        missingCommissionReports === 0 &&
        missingFxRates === 0,
    };
  }

  async upsertBrokerExecutionFill(fill: BrokerExecutionFill): Promise<void> {
    const proposedOrderId =
      fill.orderId !== undefined
        ? await this.pool
            .query(
              `
          SELECT id
          FROM proposed_orders
          WHERE broker_order_id = $1
          ORDER BY created_at DESC
          LIMIT 1
          `,
              [String(fill.orderId)],
            )
            .then((result) =>
              result.rows[0]
                ? Number((result.rows[0] as { id: number }).id)
                : null,
            )
        : null;

    // Snapshot strategy/reason/ai_* onto the fill so Trades survive
    // any later deletion of the proposed_orders row.
    let snapshot: {
      strategy: string | null;
      entry_reason: string | null;
      ai_reason: string | null;
      ai_decision: string | null;
      decision_source: string | null;
    } | null = null;
    if (proposedOrderId !== null) {
      const snapRes = await this.pool.query(
        `SELECT strategy, reason, ai_reason, ai_decision, decision_source
         FROM proposed_orders WHERE id = $1`,
        [proposedOrderId],
      );
      const row = snapRes.rows[0] as
        | {
            strategy: string | null;
            reason: string | null;
            ai_reason: string | null;
            ai_decision: string | null;
            decision_source: string | null;
          }
        | undefined;
      if (row) {
        snapshot = {
          strategy: row.strategy,
          entry_reason: row.reason,
          ai_reason: row.ai_reason,
          ai_decision: row.ai_decision,
          decision_source: row.decision_source,
        };
      }
    }

    await this.pool.query(
      `
      INSERT INTO broker_execution_fills (
        exec_id,
        order_id,
        broker_order_id,
        proposed_order_id,
        account_id,
        conid,
        symbol,
        currency,
        exchange,
        side,
        shares,
        price,
        avg_price,
        executed_at,
        strategy,
        entry_reason,
        ai_reason,
        ai_decision,
        decision_source,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18, $19, NOW()
      )
      ON CONFLICT (exec_id) DO UPDATE
      SET order_id = COALESCE(EXCLUDED.order_id, broker_execution_fills.order_id),
          broker_order_id = COALESCE(EXCLUDED.broker_order_id, broker_execution_fills.broker_order_id),
          proposed_order_id = COALESCE(EXCLUDED.proposed_order_id, broker_execution_fills.proposed_order_id),
          account_id = COALESCE(EXCLUDED.account_id, broker_execution_fills.account_id),
          conid = COALESCE(EXCLUDED.conid, broker_execution_fills.conid),
          symbol = EXCLUDED.symbol,
          currency = COALESCE(EXCLUDED.currency, broker_execution_fills.currency),
          exchange = COALESCE(EXCLUDED.exchange, broker_execution_fills.exchange),
          side = EXCLUDED.side,
          shares = EXCLUDED.shares,
          price = EXCLUDED.price,
          avg_price = COALESCE(EXCLUDED.avg_price, broker_execution_fills.avg_price),
          executed_at = COALESCE(EXCLUDED.executed_at, broker_execution_fills.executed_at),
          strategy = COALESCE(EXCLUDED.strategy, broker_execution_fills.strategy),
          entry_reason = COALESCE(EXCLUDED.entry_reason, broker_execution_fills.entry_reason),
          ai_reason = COALESCE(EXCLUDED.ai_reason, broker_execution_fills.ai_reason),
          ai_decision = COALESCE(EXCLUDED.ai_decision, broker_execution_fills.ai_decision),
          decision_source = COALESCE(EXCLUDED.decision_source, broker_execution_fills.decision_source),
          updated_at = NOW()
      `,
      [
        fill.execId,
        fill.orderId ?? null,
        fill.orderId !== undefined ? String(fill.orderId) : null,
        proposedOrderId,
        fill.accountId ?? null,
        fill.conid ?? null,
        fill.symbol,
        fill.currency ?? null,
        fill.exchange ?? null,
        fill.side,
        fill.shares,
        fill.price,
        fill.avgPrice ?? null,
        this.parseBrokerExecutionTime(fill.executedAt),
        snapshot?.strategy ?? null,
        snapshot?.entry_reason ?? null,
        snapshot?.ai_reason ?? null,
        snapshot?.ai_decision ?? null,
        snapshot?.decision_source ?? null,
      ],
    );

    if (proposedOrderId !== null) {
      await this.reconcileFilledOrdersFromBrokerFills(proposedOrderId);
    }
  }

  async reconcileFilledOrdersFromBrokerFills(
    proposedOrderId?: number,
  ): Promise<number> {
    const params: number[] = [];
    const idFilter =
      proposedOrderId !== undefined
        ? `AND po.id = $${params.push(proposedOrderId)}`
        : "";

    const result = await this.pool.query(
      `
      WITH fill_totals AS (
        SELECT proposed_order_id,
               SUM(ABS(COALESCE(shares, 0))) AS filled_shares,
               MAX(COALESCE(executed_at, created_at)) AS latest_fill_at
        FROM broker_execution_fills
        WHERE proposed_order_id IS NOT NULL
        GROUP BY proposed_order_id
      )
      UPDATE proposed_orders po
      SET status = 'FILLED',
          execution_message = 'Broker execution fill reconciliation: filled=' || fill_totals.filled_shares || '/' || po.quantity,
          last_error = NULL,
          source_error = NULL,
          executed_at = COALESCE(po.executed_at, fill_totals.latest_fill_at, NOW()),
          processing_owner = NULL,
          processing_claimed_at = NULL
      FROM fill_totals
      WHERE po.id = fill_totals.proposed_order_id
        AND po.status <> 'FILLED'
        AND po.quantity > 0
        AND fill_totals.filled_shares >= po.quantity - 0.000001
        ${idFilter}
      RETURNING po.id
      `,
      params,
    );

    return result.rowCount ?? 0;
  }

  async applyBrokerCommissionReport(
    report: BrokerCommissionReport,
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO broker_execution_fills (
        exec_id,
        commission,
        commission_currency,
        realized_pnl,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (exec_id) DO UPDATE
      SET commission = COALESCE(EXCLUDED.commission, broker_execution_fills.commission),
          commission_currency = COALESCE(EXCLUDED.commission_currency, broker_execution_fills.commission_currency),
          realized_pnl = COALESCE(EXCLUDED.realized_pnl, broker_execution_fills.realized_pnl),
          updated_at = NOW()
      `,
      [
        report.execId,
        report.commission ?? null,
        report.currency ?? null,
        report.realizedPnL !== undefined &&
        Math.abs(report.realizedPnL) <
          ExecutionRepository.IBKR_UNSET_DOUBLE_THRESHOLD
          ? report.realizedPnL
          : null,
      ],
    );
  }

  private executionMessagePriority(message?: string | null): number {
    const normalized = String(message ?? "").trim();
    if (!normalized) return 0;
    if (/^Broker accepted order, status=/i.test(normalized)) return 1;
    if (/^Broker order status update: /i.test(normalized)) return 1;
    if (
      /submitted-timeout|locate-held|held while securities are located|will not be placed at the exchange until|broker rejected order|not accepted by broker/i.test(
        normalized,
      )
    ) {
      return 3;
    }
    return 2;
  }

  private choosePreferredMessage(
    existing?: string | null,
    incoming?: string | null,
  ): string | null {
    const existingPriority = this.executionMessagePriority(existing);
    const incomingPriority = this.executionMessagePriority(incoming);
    if (incomingPriority > existingPriority) return incoming ?? null;
    if (incomingPriority < existingPriority) return existing ?? null;

    const existingText = String(existing ?? "").trim();
    const incomingText = String(incoming ?? "").trim();
    if (!incomingText) return existingText || null;
    if (!existingText) return incomingText || null;
    return incomingText.length >= existingText.length
      ? incomingText
      : existingText;
  }

  /**
   * PR14.2 — schema is now managed by the versioned migration
   * runner. This method is a thin compatibility wrapper kept for
   * callers (and PG integration tests) that were written against
   * the previous dynamic-DDL model. It MUST NOT contain a copy of
   * the schema; the migrations under `infra/sql/migrations/` are
   * the single source of truth, with checksum enforcement in
   * `schema_migrations` blocking accidental drift.
   */
  async init(): Promise<void> {
    await runMigrations(this.pool);
  }

  /**
   * PR14 round-4 — persist a broker position snapshot for the
   * given account. Legacy single-shot writer kept for callers
   * that already have a complete snapshot in hand and do not
   * need the two-phase begin/complete semantics.
   *
   * The write-path (`insertProposedFromTicket` /
   * `tryStartSubmissionWithExposureGuard`) MUST use the two-phase
   * pair (`beginPositionSnapshotRefresh` +
   * `completePositionSnapshotRefresh`) so that during an
   * in-flight refresh the guard sees `complete=false` and
   * fail-closes with `POSITION_STATE_UNAVAILABLE (incomplete)`.
   * A single-shot upsert cannot express that window.
   */
  async upsertPositionSnapshot(input: {
    readonly accountId: string;
    readonly sessionId: string;
    readonly observedAt: Date;
    readonly complete: boolean;
    readonly positions: ReadonlyArray<{
      readonly instrument: string;
      readonly conid?: string;
      readonly quantity: number;
    }>;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM broker_position_snapshots WHERE account_id = $1",
        [input.accountId],
      );
      for (const pos of input.positions) {
        await client.query(
          `
          INSERT INTO broker_position_snapshots
            (account_id, instrument, conid, quantity, session_id, observed_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            input.accountId,
            pos.instrument,
            pos.conid ?? null,
            pos.quantity,
            input.sessionId,
            input.observedAt,
          ],
        );
      }
      await client.query(
        `
        INSERT INTO broker_snapshot_syncs (account_id, session_id, observed_at, complete)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (account_id) DO UPDATE
        SET session_id = EXCLUDED.session_id,
            observed_at = EXCLUDED.observed_at,
            complete = EXCLUDED.complete
        `,
        [input.accountId, input.sessionId, input.observedAt, input.complete],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * PR14 round-7/8 blocker — mark the snapshot for `accountId`
   * as `complete=false`, atomically bump the monotonic
   * `generation` counter, and return the new generation. Every
   * write-path exposure guard consulted between this call and
   * the matching `completePositionSnapshotRefresh` fail-closes
   * with `POSITION_STATE_UNAVAILABLE (incomplete)`.
   *
   * Round-8 lock protocol: acquires the account-level advisory
   * lock (`hashtext('snap:' || account_id)`) so refresh cannot
   * interleave with a submission guard that already holds the
   * same lock. Submission always acquires the account lock
   * BEFORE the instrument lock — refresh only takes the
   * account lock — deadlock-free.
   *
   * Rationale: the account-summary endpoint (and any broker-
   * driven refresh — fill event, reconnect, startup) MUST close
   * the window during which a stale flat snapshot could be
   * consulted while the broker has already reported a fill.
   * Two-phase begin/complete with a generation fence makes that
   * window explicit AND resistant to slow-refresh clobbering
   * (see `completePositionSnapshotRefresh`).
   */
  async beginPositionSnapshotRefresh(input: {
    readonly accountId: string;
    readonly sessionId: string;
    readonly observedAt: Date;
  }): Promise<{ readonly generation: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        `snap:${input.accountId}`,
      ]);
      const result = await client.query(
        `
        INSERT INTO broker_snapshot_syncs
          (account_id, session_id, observed_at, complete, generation)
        VALUES ($1, $2, $3, FALSE, 1)
        ON CONFLICT (account_id) DO UPDATE
        SET session_id = EXCLUDED.session_id,
            observed_at = EXCLUDED.observed_at,
            complete = FALSE,
            generation = broker_snapshot_syncs.generation + 1
        RETURNING generation
        `,
        [input.accountId, input.sessionId, input.observedAt],
      );
      await client.query("COMMIT");
      return { generation: Number(result.rows[0].generation) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * PR14 round-7/8 blocker — complete a snapshot refresh
   * started by `beginPositionSnapshotRefresh`. Atomically:
   *
   *   1. Acquires the account-level advisory lock (same key as
   *      begin) — serialises with concurrent submissions and
   *      refresh starts.
   *   2. Reads the CURRENT generation. If it does not match the
   *      caller-supplied `generation` (a newer refresh started
   *      after this one), skips the write and returns
   *      `{ kind: "stale_generation" }`. The newer refresh
   *      remains in-flight; the write path stays fail-closed
   *      until IT completes.
   *   3. Otherwise replaces every position row for the account
   *      AND flips `complete=true` in the same transaction.
   *      Returns `{ kind: "completed" }`. The write path can
   *      immediately proceed.
   */
  async completePositionSnapshotRefresh(input: {
    readonly accountId: string;
    readonly sessionId: string;
    readonly observedAt: Date;
    readonly generation: number;
    readonly positions: ReadonlyArray<{
      readonly instrument: string;
      readonly conid?: string;
      readonly quantity: number;
    }>;
  }): Promise<
    | { readonly kind: "completed" }
    | { readonly kind: "stale_generation"; readonly currentGeneration: number }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        `snap:${input.accountId}`,
      ]);
      const genRow = await client.query(
        "SELECT generation FROM broker_snapshot_syncs WHERE account_id = $1",
        [input.accountId],
      );
      const currentGeneration = genRow.rows[0]
        ? Number(genRow.rows[0].generation)
        : 0;
      if (currentGeneration !== input.generation) {
        // A newer `beginPositionSnapshotRefresh` ran AFTER our
        // begin but BEFORE our complete. Our data is stale
        // relative to the newer refresh's begin timestamp;
        // committing it would clobber the newer in-flight
        // window. Skip.
        await client.query("ROLLBACK");
        return { kind: "stale_generation", currentGeneration };
      }
      await client.query(
        "DELETE FROM broker_position_snapshots WHERE account_id = $1",
        [input.accountId],
      );
      for (const pos of input.positions) {
        await client.query(
          `
          INSERT INTO broker_position_snapshots
            (account_id, instrument, conid, quantity, session_id, observed_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            input.accountId,
            pos.instrument,
            pos.conid ?? null,
            pos.quantity,
            input.sessionId,
            input.observedAt,
          ],
        );
      }
      await client.query(
        `
        UPDATE broker_snapshot_syncs
        SET session_id = $2,
            observed_at = $3,
            complete = TRUE
        WHERE account_id = $1
        `,
        [input.accountId, input.sessionId, input.observedAt],
      );
      await client.query("COMMIT");
      return { kind: "completed" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * PR14 round-8 blocker — cheap invalidation without a full
   * refresh cycle. Acquires the account lock, bumps generation,
   * sets `complete=false`. Every write-path guard fail-closes
   * with `POSITION_STATE_UNAVAILABLE (incomplete)` until a
   * subsequent `completePositionSnapshotRefresh` succeeds.
   *
   * Callers use this to enforce the invariant "any broker-side
   * event that MAY have changed exposure invalidates the
   * snapshot BEFORE the local order-lifecycle transition
   * unblocks a new intent". Awaited by the fill / status-update
   * / partial-fill / reconciliation code paths.
   *
   * Returns the new generation so a follow-up
   * `refreshBrokerPositionSnapshot` can use it as its begin
   * generation (avoiding a redundant bump).
   */
  async invalidatePositionSnapshot(input: {
    readonly accountId: string;
    readonly sessionId: string;
    readonly observedAt: Date;
  }): Promise<{ readonly generation: number }> {
    return this.beginPositionSnapshotRefresh(input);
  }

  /**
   * PR14 round-7/9 blocker — readiness probe: returns the
   * health of the broker-position snapshot for the given
   * account. Round-9 exposes `generation` alongside `complete`
   * so the refresh coordinator can distinguish:
   *   - `complete=true` at OUR generation → we are healthy.
   *   - `complete=false` at a NEWER generation → someone
   *     invalidated after us; rerun needed.
   *   - `complete=true` at a NEWER generation → a newer refresh
   *     already completed on our behalf; we can exit healthy
   *     without another broker fetch.
   */
  async getPositionSnapshotStatus(accountId: string): Promise<
    | { readonly kind: "missing" }
    | {
        readonly kind: "present";
        readonly sessionId: string;
        readonly observedAt: Date;
        readonly complete: boolean;
        readonly generation: number;
      }
  > {
    const result = await this.pool.query(
      `
      SELECT session_id, observed_at, complete, generation
      FROM broker_snapshot_syncs
      WHERE account_id = $1
      `,
      [accountId],
    );
    const row = result.rows[0];
    if (!row) return { kind: "missing" };
    return {
      kind: "present",
      sessionId: String(row.session_id),
      observedAt: new Date(row.observed_at as string),
      complete: row.complete === true,
      generation: Number(row.generation),
    };
  }

  /**
   * PR14 blocker fix — atomic instrument-level exposure guard.
   *
   * The `execute-ticket` fresh-INSERT path is the ONLY place the
   * PR13/PR14 write flow creates a new `proposed_orders` row.
   * Before the INSERT commits, the same transaction:
   *
   *   1. Takes a Postgres transaction-scoped advisory lock keyed
   *      on `hashtext(instrument)`. Concurrent inserts for the
   *      SAME instrument serialise; inserts for different
   *      instruments proceed in parallel.
   *   2. Checks whether any NON-terminal row already exists for
   *      this instrument (`status IN ('PROPOSED', 'SUBMITTED')`).
   *   3. If found — and it's NOT the same `client_order_id`
   *      currently trying to insert (which is handled by the
   *      idempotency layer / UNIQUE constraint) — returns
   *      `{ kind: "active_intent_exists" }`. NO INSERT. The
   *      orchestrator surfaces this as HTTP 409
   *      `ACTIVE_INTENT_EXISTS`.
   *
   * This closes the race that PR13's UNIQUE(client_order_id)
   * alone does NOT cover: two requests with DIFFERENT
   * `clientOrderId`s but the SAME instrument, evaluated concurrently
   * by the process-local exposure guard in signal-engine, would
   * previously both pass the guard and both create a
   * `proposed_orders` row. The advisory lock + status probe here
   * is the AUTHORITATIVE enforcement point (single-writer per
   * instrument), independent of caller count.
   *
   * Bracket protection is preserved — bracket legs are encoded on
   * the parent row's `stop` / `take_profit` fields (see PR13
   * ticket mapper). Only one PROPOSED / SUBMITTED row exists per
   * instrument's active intent.
   *
   * Excluded from the block: rows with the SAME `client_order_id`
   * as the incoming insert. Those rows are the RESUME target that
   * the idempotency path already routes through
   * `tryStartSubmission`; the caller is not creating a competing
   * intent. If the incoming request has no idempotency triple
   * (legacy path), every non-terminal row for the instrument
   * blocks — the caller must supply an explicit new intent.
   */
  async insertProposedFromTicket(
    ticket: SignalTicket,
    strategy = "manual_ticket",
    idempotency:
      | {
          readonly clientOrderId: string;
          readonly clientOrderHash: string;
        }
      | undefined,
    positionGuard: PositionGuardContext,
    options?: { readonly allowCrossContractExposure?: boolean },
  ): Promise<
    | { readonly kind: "inserted"; readonly id: number }
    | {
        readonly kind: "active_intent_exists";
        readonly existingOrderId: number;
        readonly existingStatus: ProposedOrderStatus;
        readonly existingClientOrderId: string | null;
      }
    | {
        /**
         * PR14 round-4 blocker — broker reports a non-zero
         * position for this instrument. Refuses even when every
         * proposed_order for the instrument is terminal.
         */
        readonly kind: "open_position_exists";
        readonly accountId: string;
        readonly quantity: number;
        readonly observedAt: Date;
      }
    | {
        /**
         * PR14 round-4/5/6 blocker — the persisted broker snapshot
         * is missing, stale, incomplete, from a different session,
         * OR there is no active broker account at all
         * (`positionGuard.kind === "unavailable"`). Fail-closed:
         * no INSERT.
         */
        readonly kind: "position_state_unavailable";
        readonly accountId: string | null;
        readonly reason: PositionGuardBlockedReason;
      }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // PR14 round-8 lock protocol: account lock FIRST, then
      // instrument lock. Submissions and refreshes both take
      // the account lock (submission also takes the instrument
      // lock) — refresh never takes the instrument lock —
      // deadlock-free. Order is stable so two concurrent
      // submissions for different instruments on the same
      // account still serialise on the account lock.
      if (positionGuard.kind === "available") {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
          [`snap:${positionGuard.accountId}`],
        );
      }
      // Transaction-scoped advisory lock on hashtext(instrument).
      // Serialises concurrent inserts for the same instrument
      // without any table-level locking. Released automatically at
      // COMMIT / ROLLBACK.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        ticket.instrument,
      ]);

      // Look for any non-terminal row that is NOT the resume
      // target of the current caller (same client_order_id).
      const existing = await client.query(
        `
        SELECT id, status, client_order_id
        FROM proposed_orders
        WHERE instrument = $1
          AND status IN ('PROPOSED', 'SUBMITTED')
          AND (
            $2::text IS NULL
            OR client_order_id IS NULL
            OR client_order_id <> $2
          )
        LIMIT 1
        `,
        [ticket.instrument, idempotency?.clientOrderId ?? null],
      );

      const conflictRow = existing.rows[0];
      if (conflictRow) {
        await client.query("ROLLBACK");
        return {
          kind: "active_intent_exists",
          existingOrderId: Number(conflictRow.id),
          existingStatus: conflictRow.status as ProposedOrderStatus,
          existingClientOrderId:
            typeof conflictRow.client_order_id === "string"
              ? conflictRow.client_order_id
              : null,
        };
      }

      // PR14 round-4/5/6 blocker — authoritative exposure guard.
      // Under the SAME advisory lock, verify the active account,
      // snapshot session identity, freshness, completeness, and
      // open-position status. Refuses the write when any layer
      // trips.
      const guarded = await this.#runExposureGuard(client, {
        instrument: ticket.instrument,
        conid: ticket.conid ?? null,
        allowCrossContractExposure:
          options?.allowCrossContractExposure ?? false,
        guard: positionGuard,
      });
      if (guarded.kind !== "ok") {
        await client.query("ROLLBACK");
        return guarded.outcome;
      }

      const result = await client.query(
        `
        INSERT INTO proposed_orders (
          instrument,
          conid,
          side,
          position_effect,
          order_type,
          quantity,
          entry,
          stop,
          take_profit,
          reason,
          confidence,
          risk_check_status,
          status,
          strategy,
          decision_source,
          client_order_id,
          client_order_hash,
          created_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, 'PROPOSED', $13, 'user',
          $14, $15, NOW()
        )
        RETURNING id
        `,
        [
          ticket.instrument,
          ticket.conid ?? null,
          ticket.side,
          ticket.positionEffect ?? null,
          ticket.orderType,
          ticket.quantity,
          ticket.entry ?? null,
          ticket.stop ?? null,
          ticket.takeProfit ?? null,
          ticket.reason,
          ticket.confidence,
          ticket.riskCheckStatus,
          strategy,
          idempotency?.clientOrderId ?? null,
          idempotency?.clientOrderHash ?? null,
        ],
      );

      await client.query("COMMIT");
      return { kind: "inserted", id: Number(result.rows[0].id) };
    } catch (error) {
      // Any error — including UNIQUE(client_order_id) violation
      // when a concurrent process just inserted the same key —
      // rolls back and re-throws so the orchestrator's existing
      // isUniqueViolation classifier can route through the racy
      // re-consult path.
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Look up a proposed order previously inserted with the given
   * `client_order_id`, plus its stored `client_order_hash`. Returns
   * `null` if no such row exists. Used by the `execute-ticket`
   * handler on a UNIQUE-index collision. The `order` (via
   * `mapRow`) carries `status`, `executionAttemptedAt` and
   * `brokerOrderId` — every field the idempotency helper needs to
   * decide between `duplicate_replay`, `duplicate_terminal`,
   * `resume` and `conflict`.
   */
  async getIdempotencyRecord(
    clientOrderId: string,
  ): Promise<{ order: ProposedOrder; clientOrderHash: string | null } | null> {
    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
             decision_source, decision_actor, ai_decision, ai_reason, ai_model, ai_decision_confidence,
             llm_decision_id, source_error, processing_owner, processing_claimed_at,
             broker_order_id, execution_account_id, execution_message, last_error,
             execution_attempted_at, executed_at, created_at,
             client_order_hash
      FROM proposed_orders
      WHERE client_order_id = $1
      LIMIT 1
      `,
      [clientOrderId],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      order: this.mapRow(row as ProposedOrderRow),
      clientOrderHash:
        typeof row.client_order_hash === "string"
          ? row.client_order_hash
          : null,
    };
  }

  async getProposedOrderById(id: number): Promise<ProposedOrder | null> {
    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
             decision_source, decision_actor, ai_decision, ai_reason, ai_model, ai_decision_confidence,
             llm_decision_id, source_error, processing_owner, processing_claimed_at,
             broker_order_id, execution_account_id, execution_message, last_error,
             execution_attempted_at, executed_at, created_at
      FROM proposed_orders
      WHERE id = $1
      `,
      [id],
    );

    if (!result.rows[0]) return null;
    return this.mapRow(result.rows[0] as ProposedOrderRow);
  }

  async getProposedOrderByBrokerOrderId(
    brokerOrderId: string,
  ): Promise<ProposedOrder | null> {
    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
             decision_source, decision_actor, ai_decision, ai_reason, ai_model, ai_decision_confidence,
             llm_decision_id, source_error, processing_owner, processing_claimed_at,
             broker_order_id, execution_account_id, execution_message, last_error,
             execution_attempted_at, executed_at, created_at
      FROM proposed_orders
      WHERE broker_order_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [brokerOrderId],
    );

    if (!result.rows[0]) return null;
    return this.mapRow(result.rows[0] as ProposedOrderRow);
  }

  async findActiveSubmittedByInstrument(
    instrument: string,
    excludeId?: number,
  ): Promise<ActiveSubmittedOrder | null> {
    const normalized = instrument.trim();
    if (!normalized) return null;

    const params: Array<string | number> = [normalized];
    let excludeSql = "";
    if (excludeId !== undefined) {
      params.push(excludeId);
      excludeSql = `AND id <> $${params.length}`;
    }

    const result = await this.pool.query(
      `
      SELECT id, instrument, broker_order_id, created_at
      FROM proposed_orders
      WHERE upper(instrument) = upper($1)
        AND status = 'SUBMITTED'
        ${excludeSql}
      ORDER BY created_at DESC
      LIMIT 1
      `,
      params,
    );

    const row = result.rows[0] as
      | {
          id: number;
          instrument: string;
          broker_order_id: string | null;
          created_at: Date | string;
        }
      | undefined;
    if (!row) return null;

    return {
      id: Number(row.id),
      instrument: String(row.instrument),
      brokerOrderId: row.broker_order_id ?? undefined,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    };
  }

  async listOrders(
    limit: number,
    filters: OrderListFilters = {},
  ): Promise<ProposedOrder[]> {
    const safeLimit = Math.max(1, Math.min(500, limit));

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (filters.instrument) {
      params.push(`%${filters.instrument}%`);
      where.push(`instrument ILIKE $${params.length}`);
    }

    if (filters.side) {
      params.push(filters.side);
      where.push(`side = $${params.length}`);
    }

    if (filters.orderType) {
      params.push(filters.orderType);
      where.push(`order_type = $${params.length}`);
    }

    if (filters.qty !== undefined) {
      params.push(filters.qty);
      where.push(`quantity = $${params.length}`);
    }

    if (filters.status) {
      params.push(filters.status);
      where.push(`status = $${params.length}`);
    }

    if (filters.riskCheckStatus) {
      params.push(filters.riskCheckStatus);
      where.push(`risk_check_status = $${params.length}`);
    }

    if (filters.decisionSource) {
      params.push(filters.decisionSource);
      where.push(`decision_source = $${params.length}`);
    }

    if (filters.aiDecision) {
      params.push(filters.aiDecision);
      where.push(`ai_decision = $${params.length}`);
    }

    params.push(safeLimit);
    const limitParam = `$${params.length}`;
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
             decision_source, decision_actor, ai_decision, ai_reason, ai_model, ai_decision_confidence,
             llm_decision_id, source_error, processing_owner, processing_claimed_at,
             broker_order_id, execution_account_id, execution_message, last_error,
             execution_attempted_at, executed_at, created_at
      FROM proposed_orders
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${limitParam}
      `,
      params,
    );

    return result.rows.map((row) => this.mapRow(row as ProposedOrderRow));
  }

  async markExecutionAttempt(
    id: number,
    accountId: string,
    metadata?: OrderDecisionMetadata,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET execution_attempted_at = NOW(),
          execution_account_id = $2,
          decision_source = COALESCE($3, decision_source),
          decision_actor = COALESCE($4, decision_actor),
          ai_decision = COALESCE($5, ai_decision),
          ai_reason = COALESCE($6, ai_reason),
          ai_model = COALESCE($7, ai_model),
          ai_decision_confidence = COALESCE($8, ai_decision_confidence),
          llm_decision_id = COALESCE($9, llm_decision_id),
          source_error = COALESCE($10, source_error)
      WHERE id = $1
      `,
      [
        id,
        accountId,
        metadata?.decisionSource ?? null,
        metadata?.decisionActor ?? null,
        metadata?.aiDecision ?? null,
        metadata?.aiReason ?? null,
        metadata?.aiModel ?? null,
        metadata?.aiDecisionConfidence ?? null,
        metadata?.llmDecisionId ?? null,
        metadata?.sourceError ?? null,
      ],
    );
  }

  /**
   * PR13 — atomic submission claim with a fencing marker.
   *
   * Every broker submission — fresh INSERT **and** resume — MUST
   * acquire this claim before any broker call. The UNIQUE
   * constraint on `client_order_id` alone does NOT prevent two
   * concurrent broker submissions:
   *
   *   1. Request A INSERTs and pauses before submission.
   *   2. Request B sees the clean PROPOSED row (either via the
   *      up-front idempotency lookup, or via the racy-INSERT
   *      re-lookup after UNIQUE violation) and calls
   *      `tryStartSubmission`.
   *   3. WITHOUT this method being called on BOTH paths, A and B
   *      would each proceed to `executePersistedOrder` and the
   *      broker would receive TWO orders under the same
   *      idempotency key.
   *
   * The `execution_attempted_at IS NULL` clause in the WHERE
   * combined with the SET `execution_attempted_at = NOW()`
   * guarantees at-most-once broker submission ACROSS EVERY
   * possible race — fresh INSERT vs resume, resume vs resume, or
   * fresh vs racing-fresh-via-unique-violation:
   *
   *   1. Two callers `A`, `B` observe a `PROPOSED` row with no
   *      marker.
   *   2. Both call `tryStartSubmission`. PostgreSQL serialises
   *      the two UPDATEs.
   *   3. The winner flips `execution_attempted_at` to NOW()
   *      atomically with the claim and receives its id in
   *      RETURNING.
   *   4. The loser observes the row now has
   *      `execution_attempted_at != NULL` → its WHERE clause
   *      excludes the row → UPDATE affects zero rows → returns
   *      false → orchestrator surfaces
   *      `duplicate_pending_ambiguous` / `duplicate_submitted` /
   *      `duplicate_terminal` (whichever matches the freshest
   *      state on re-read) and NEVER contacts the broker.
   *
   * This works EVEN IF the winner pauses arbitrarily long between
   * the claim and the broker call. A pure TTL lease would let a
   * second caller take over after the TTL expires; the marker
   * prevents that.
   *
   *   UPDATE proposed_orders
   *   SET processing_owner = $owner,
   *       processing_claimed_at = NOW(),
   *       execution_attempted_at = NOW()
   *   WHERE id = $id
   *     AND status = 'PROPOSED'
   *     AND execution_attempted_at IS NULL
   *     AND broker_order_id IS NULL
   *   RETURNING id
   *
   * Consequence: a `PROPOSED` row can be SUBMITTED at most ONCE.
   * If the winner crashes AFTER the atomic claim but BEFORE a
   * terminal transition, the row becomes permanently ambiguous
   * (status=PROPOSED, executionAttemptedAt set, no brokerOrderId)
   * and reconciliation is the ONLY recovery path. This is the
   * intentional safety trade-off: we prefer "requires human /
   * reconciliation intervention" over "broker gets two orders".
   *
   * `processing_owner` and `processing_claimed_at` are still
   * written for observability. Every terminal transition
   * (`markSubmitted`, `markFilled`, `markCancelled`,
   * `markRejected`) clears them.
   */
  async tryStartSubmission(input: {
    readonly id: number;
    readonly owner: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE proposed_orders
      SET processing_owner = $2,
          processing_claimed_at = NOW(),
          execution_attempted_at = NOW()
      WHERE id = $1
        AND status = 'PROPOSED'
        AND execution_attempted_at IS NULL
        AND broker_order_id IS NULL
      RETURNING id
      `,
      [input.id, input.owner],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * PR14 round-6 blocker — unified pre-submission gate for the
   * RESUME path. `insertProposedFromTicket` already runs the
   * atomic exposure guard on fresh inserts, but the resume path
   * (existing clean `PROPOSED` row) previously only acquired the
   * fencing marker via the raw `tryStartSubmission` primitive,
   * bypassing the account / session / snapshot / open-position
   * check. This leaves a hole: a retry with the same
   * `clientOrderId` after the account went inactive (or a fresh
   * broker fill landed for the instrument) could submit anyway.
   *
   * The atomic sequence under a single Postgres transaction and
   * a single `pg_advisory_xact_lock(hashtext(instrument))`:
   *
   *   1. Take the advisory lock — serialises with any concurrent
   *      fresh INSERT / resume claim for the same instrument.
   *   2. Run the SAME exposure guard used by
   *      `insertProposedFromTicket` (`#runExposureGuard`).
   *   3. On a blocking outcome — ROLLBACK, return the outcome
   *      unchanged. NO marker, NO broker call.
   *   4. Otherwise atomically UPDATE ... WHERE ... RETURNING to
   *      acquire the fencing marker exactly the same way
   *      `tryStartSubmission` does.
   *   5. COMMIT. Only after this returns `{ kind: "claimed" }` is
   *      the caller permitted to invoke `executePersistedOrder`.
   *
   * Two concurrent resume requests for the same `id` serialise
   * through the advisory lock: one wins the marker, the other
   * observes the guard result of the winner (or its own guard if
   * state changed) and returns `not_claimed`.
   */
  async tryStartSubmissionWithExposureGuard(input: {
    readonly id: number;
    readonly owner: string;
    readonly instrument: string;
    readonly conid: string | null;
    readonly allowCrossContractExposure: boolean;
    readonly positionGuard: PositionGuardContext;
  }): Promise<
    | { readonly kind: "claimed" }
    | { readonly kind: "not_claimed" }
    | {
        readonly kind: "open_position_exists";
        readonly accountId: string;
        readonly quantity: number;
        readonly observedAt: Date;
      }
    | {
        readonly kind: "position_state_unavailable";
        readonly accountId: string | null;
        readonly reason: PositionGuardBlockedReason;
      }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Round-8 lock protocol: account lock FIRST (same as
      // insertProposedFromTicket) so a concurrent snapshot
      // refresh cannot flip `complete` between our guard read
      // and our marker acquisition.
      if (input.positionGuard.kind === "available") {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
          [`snap:${input.positionGuard.accountId}`],
        );
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
        input.instrument,
      ]);

      const guarded = await this.#runExposureGuard(client, {
        instrument: input.instrument,
        conid: input.conid,
        allowCrossContractExposure: input.allowCrossContractExposure,
        guard: input.positionGuard,
      });
      if (guarded.kind !== "ok") {
        await client.query("ROLLBACK");
        return guarded.outcome;
      }

      const result = await client.query(
        `
        UPDATE proposed_orders
        SET processing_owner = $2,
            processing_claimed_at = NOW(),
            execution_attempted_at = NOW()
        WHERE id = $1
          AND status = 'PROPOSED'
          AND execution_attempted_at IS NULL
          AND broker_order_id IS NULL
        RETURNING id
        `,
        [input.id, input.owner],
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { kind: "not_claimed" };
      }
      await client.query("COMMIT");
      return { kind: "claimed" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * PR14 round-6 blocker — shared exposure-guard body. Runs
   * inside an OPEN transaction that already holds
   * `pg_advisory_xact_lock(hashtext(instrument))`. Caller is
   * responsible for BEGIN, the lock, COMMIT / ROLLBACK, and for
   * mapping the returned outcome to its wire shape.
   *
   * Ordering:
   *   1. `guard.kind === "unavailable"` — fail-closed, no DB read.
   *   2. `broker_snapshot_syncs` — missing → `missing`.
   *   3. session identity mismatch (`sync.session_id !==
   *      guard.sessionId`) — `wrong_session`. Prevents the
   *      previous process' snapshot from being trusted after a
   *      restart, even if `observedAt` is still within
   *      `maxSnapshotAgeMs`.
   *   4. `observedAt` in the future by more than a small
   *      tolerance (clock skew) — treated as `stale` (defensive).
   *   5. `observedAt` older than `maxSnapshotAgeMs` — `stale`.
   *   6. `complete === false` — `incomplete`.
   *   7. `broker_position_snapshots` — non-zero position on the
   *      logical instrument (respecting
   *      `allowCrossContractExposure` semantics) →
   *      `open_position_exists`.
   */
  async #runExposureGuard(
    client: PoolClient,
    input: {
      readonly instrument: string;
      readonly conid: string | null;
      readonly allowCrossContractExposure: boolean;
      readonly guard: PositionGuardContext;
    },
  ): Promise<
    | { readonly kind: "ok" }
    | {
        readonly kind: "blocked";
        readonly outcome:
          | {
              readonly kind: "open_position_exists";
              readonly accountId: string;
              readonly quantity: number;
              readonly observedAt: Date;
            }
          | {
              readonly kind: "position_state_unavailable";
              readonly accountId: string | null;
              readonly reason: PositionGuardBlockedReason;
            };
      }
  > {
    if (input.guard.kind === "unavailable") {
      return {
        kind: "blocked",
        outcome: {
          kind: "position_state_unavailable",
          accountId: null,
          reason: input.guard.reason,
        },
      };
    }
    const g = input.guard;
    const sync = await client.query(
      `
      SELECT session_id, observed_at, complete
      FROM broker_snapshot_syncs
      WHERE account_id = $1
      `,
      [g.accountId],
    );
    const syncRow = sync.rows[0];
    if (!syncRow) {
      return {
        kind: "blocked",
        outcome: {
          kind: "position_state_unavailable",
          accountId: g.accountId,
          reason: "missing",
        },
      };
    }
    // Round-6 blocker: after a process restart the previous
    // session's snapshot MUST be rejected even if it's still
    // within maxSnapshotAgeMs. Only the sessionId that wrote the
    // snapshot may be trusted to reason about the account state.
    if (
      typeof syncRow.session_id !== "string" ||
      syncRow.session_id !== g.sessionId
    ) {
      return {
        kind: "blocked",
        outcome: {
          kind: "position_state_unavailable",
          accountId: g.accountId,
          reason: "wrong_session",
        },
      };
    }
    const syncObservedAt = new Date(syncRow.observed_at as string);
    const nowMs = Date.now();
    const ageMs = nowMs - syncObservedAt.getTime();
    // Defensive: reject snapshots dated non-trivially in the
    // future (clock skew / bad clock). 5 s tolerance.
    if (ageMs < -5_000) {
      return {
        kind: "blocked",
        outcome: {
          kind: "position_state_unavailable",
          accountId: g.accountId,
          reason: "stale",
        },
      };
    }
    if (ageMs > g.maxSnapshotAgeMs) {
      return {
        kind: "blocked",
        outcome: {
          kind: "position_state_unavailable",
          accountId: g.accountId,
          reason: "stale",
        },
      };
    }
    if (syncRow.complete !== true) {
      return {
        kind: "blocked",
        outcome: {
          kind: "position_state_unavailable",
          accountId: g.accountId,
          reason: "incomplete",
        },
      };
    }
    // Round-6 blocker: position identity policy. When the
    // strategy does NOT opt into cross-contract exposure any
    // non-zero position on the LOGICAL instrument (broker
    // symbol) blocks — regardless of conId. This prevents
    // pyramiding across futures rollover / share class
    // migrations when the strategy did not explicitly authorise
    // parallel exposure. When the strategy opts in, the guard
    // narrows to the exact conId (or symbol-only when the
    // ticket has no conId).
    let posRes;
    if (!input.allowCrossContractExposure) {
      posRes = await client.query(
        `
        SELECT quantity, observed_at, conid
        FROM broker_position_snapshots
        WHERE account_id = $1
          AND instrument = $2
        ORDER BY (CASE WHEN quantity <> 0 THEN 0 ELSE 1 END)
        LIMIT 1
        `,
        [g.accountId, input.instrument],
      );
    } else if (input.conid !== null) {
      posRes = await client.query(
        `
        SELECT quantity, observed_at, conid
        FROM broker_position_snapshots
        WHERE account_id = $1 AND conid = $2
        `,
        [g.accountId, input.conid],
      );
    } else {
      posRes = await client.query(
        `
        SELECT quantity, observed_at, conid
        FROM broker_position_snapshots
        WHERE account_id = $1
          AND instrument = $2
          AND conid IS NULL
        `,
        [g.accountId, input.instrument],
      );
    }
    const posRow = posRes.rows[0];
    if (posRow) {
      const quantity = Number(posRow.quantity);
      if (Number.isFinite(quantity) && quantity !== 0) {
        return {
          kind: "blocked",
          outcome: {
            kind: "open_position_exists",
            accountId: g.accountId,
            quantity,
            observedAt: new Date(posRow.observed_at as string),
          },
        };
      }
    }
    return { kind: "ok" };
  }

  async markSubmitted(
    id: number,
    accountId: string,
    brokerOrderId: string,
    executionMessage: string,
    metadata?: OrderDecisionMetadata,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'SUBMITTED',
          execution_account_id = $2,
          broker_order_id = $3,
          execution_message = $4,
          last_error = NULL,
          source_error = NULL,
          executed_at = NULL,
          execution_attempted_at = COALESCE(execution_attempted_at, NOW()),
          decision_source = COALESCE($5, decision_source),
          decision_actor = COALESCE($6, decision_actor),
          ai_decision = COALESCE($7, ai_decision),
          ai_reason = COALESCE($8, ai_reason),
          ai_model = COALESCE($9, ai_model),
          ai_decision_confidence = COALESCE($10, ai_decision_confidence),
          llm_decision_id = COALESCE($11, llm_decision_id),
          processing_owner = NULL,
          processing_claimed_at = NULL
      WHERE id = $1
      `,
      [
        id,
        accountId,
        brokerOrderId,
        executionMessage,
        metadata?.decisionSource ?? null,
        metadata?.decisionActor ?? null,
        metadata?.aiDecision ?? null,
        metadata?.aiReason ?? null,
        metadata?.aiModel ?? null,
        metadata?.aiDecisionConfidence ?? null,
        metadata?.llmDecisionId ?? null,
      ],
    );
  }

  async markFilled(
    id: number,
    accountId: string,
    brokerOrderId: string,
    executionMessage: string,
    metadata?: OrderDecisionMetadata,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'FILLED',
          execution_account_id = $2,
          broker_order_id = $3,
          execution_message = $4,
          last_error = NULL,
          source_error = NULL,
          executed_at = COALESCE(executed_at, NOW()),
          execution_attempted_at = COALESCE(execution_attempted_at, NOW()),
          decision_source = COALESCE($5, decision_source),
          decision_actor = COALESCE($6, decision_actor),
          ai_decision = COALESCE($7, ai_decision),
          ai_reason = COALESCE($8, ai_reason),
          ai_model = COALESCE($9, ai_model),
          ai_decision_confidence = COALESCE($10, ai_decision_confidence),
          llm_decision_id = COALESCE($11, llm_decision_id),
          processing_owner = NULL,
          processing_claimed_at = NULL
      WHERE id = $1
      `,
      [
        id,
        accountId,
        brokerOrderId,
        executionMessage,
        metadata?.decisionSource ?? null,
        metadata?.decisionActor ?? null,
        metadata?.aiDecision ?? null,
        metadata?.aiReason ?? null,
        metadata?.aiModel ?? null,
        metadata?.aiDecisionConfidence ?? null,
        metadata?.llmDecisionId ?? null,
      ],
    );
  }

  async markRejected(
    id: number,
    reason: string,
    metadata?: OrderDecisionMetadata,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'REJECTED',
          last_error = $2,
          execution_message = $2,
          execution_attempted_at = COALESCE(execution_attempted_at, NOW()),
          decision_source = COALESCE($3, decision_source),
          decision_actor = COALESCE($4, decision_actor),
          ai_decision = COALESCE($5, ai_decision),
          ai_reason = COALESCE($6, ai_reason),
          ai_model = COALESCE($7, ai_model),
          ai_decision_confidence = COALESCE($8, ai_decision_confidence),
          llm_decision_id = COALESCE($9, llm_decision_id),
          source_error = COALESCE($10, source_error),
          processing_owner = NULL,
          processing_claimed_at = NULL
      WHERE id = $1
      `,
      [
        id,
        reason,
        metadata?.decisionSource ?? null,
        metadata?.decisionActor ?? null,
        metadata?.aiDecision ?? null,
        metadata?.aiReason ?? null,
        metadata?.aiModel ?? null,
        metadata?.aiDecisionConfidence ?? null,
        metadata?.llmDecisionId ?? null,
        metadata?.sourceError ?? null,
      ],
    );
  }

  async markCancelled(id: number, reason: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'CANCELLED',
          last_error = $2,
          execution_message = $2,
          execution_attempted_at = COALESCE(execution_attempted_at, NOW()),
          processing_owner = NULL,
          processing_claimed_at = NULL
      WHERE id = $1
      `,
      [id, reason],
    );
  }

  async setDecisionMetadata(
    id: number,
    metadata: OrderDecisionMetadata,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET decision_source = COALESCE($2, decision_source),
          decision_actor = COALESCE($3, decision_actor),
          ai_decision = COALESCE($4, ai_decision),
          ai_reason = COALESCE($5, ai_reason),
          ai_model = COALESCE($6, ai_model),
          ai_decision_confidence = COALESCE($7, ai_decision_confidence),
          llm_decision_id = COALESCE($8, llm_decision_id),
          source_error = COALESCE($9, source_error)
      WHERE id = $1
      `,
      [
        id,
        metadata.decisionSource ?? null,
        metadata.decisionActor ?? null,
        metadata.aiDecision ?? null,
        metadata.aiReason ?? null,
        metadata.aiModel ?? null,
        metadata.aiDecisionConfidence ?? null,
        metadata.llmDecisionId ?? null,
        metadata.sourceError ?? null,
      ],
    );
  }

  async applyBrokerStatusUpdate(
    update: BrokerOrderStatusUpdate,
  ): Promise<void> {
    const status = update.status.toUpperCase();

    if (status === "FILLED") {
      await this.pool.query(
        `
        UPDATE proposed_orders
        SET status = 'FILLED',
            execution_message = $2,
            last_error = NULL,
            source_error = NULL,
            executed_at = COALESCE(executed_at, NOW()),
            processing_owner = NULL,
            processing_claimed_at = NULL
        WHERE broker_order_id = $1
        `,
        [update.brokerOrderId, update.message],
      );
      return;
    }

    if (
      status === "SUBMITTED" ||
      status === "PRESUBMITTED" ||
      status === "PENDINGSUBMIT"
    ) {
      await this.pool.query(
        `
        UPDATE proposed_orders
        SET status = 'SUBMITTED',
            execution_message = $2,
            last_error = NULL,
            source_error = NULL
        WHERE broker_order_id = $1
          AND status IN ('PROPOSED', 'SUBMITTED', 'EXECUTED')
        `,
        [update.brokerOrderId, update.message],
      );
      return;
    }

    if (
      status === "INACTIVE" ||
      status === "CANCELLED" ||
      status === "APICANCELLED"
    ) {
      const current = await this.pool.query(
        `
        SELECT execution_message, last_error
        FROM proposed_orders
        WHERE broker_order_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [update.brokerOrderId],
      );
      const existing = current.rows[0] as
        | { execution_message?: string | null; last_error?: string | null }
        | undefined;
      const preferredMessage = this.choosePreferredMessage(
        existing?.execution_message,
        update.message,
      );
      const preferredError = this.choosePreferredMessage(
        existing?.last_error,
        update.message,
      );

      await this.pool.query(
        `
        UPDATE proposed_orders
        SET status = 'CANCELLED',
            execution_message = $2,
            last_error = $2,
            processing_owner = NULL,
            processing_claimed_at = NULL
        WHERE broker_order_id = $1
          AND status <> 'FILLED'
        `,
        [
          update.brokerOrderId,
          this.choosePreferredMessage(preferredMessage, preferredError),
        ],
      );
    }
  }

  private mapRow(row: ProposedOrderRow): ProposedOrder {
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at);
    const indicators = this.normalizeIndicators(row.indicator_snapshot);

    const out: ProposedOrder = {
      id: row.id,
      instrument: row.instrument,
      conid: row.conid ?? undefined,
      side: row.side,
      positionEffect: row.position_effect ?? undefined,
      orderType: row.order_type,
      quantity: row.quantity,
      entry: row.entry ?? undefined,
      stop: row.stop ?? undefined,
      takeProfit: row.take_profit ?? undefined,
      reason: row.reason,
      confidence: row.confidence,
      timestamp: createdAt.toISOString(),
      riskCheckStatus: row.risk_check_status,
      status: this.normalizeStatus(row.status),
      strategy: row.strategy ?? undefined,
      indicators,
      decisionSource: row.decision_source ?? undefined,
      aiDecision: row.ai_decision ?? undefined,
      aiReason: row.ai_reason ?? undefined,
      aiModel: row.ai_model ?? undefined,
      aiDecisionConfidence: row.ai_decision_confidence ?? undefined,
      llmDecisionId: row.llm_decision_id ?? undefined,
      sourceError: row.source_error ?? undefined,
      createdAt,
    };

    if (row.broker_order_id !== null) out.brokerOrderId = row.broker_order_id;
    if (row.execution_account_id !== null)
      out.executionAccountId = row.execution_account_id;
    if (row.execution_message !== null)
      out.executionMessage = row.execution_message;
    if (row.last_error !== null) out.lastError = row.last_error;
    if (row.execution_attempted_at !== null) {
      out.executionAttemptedAt =
        row.execution_attempted_at instanceof Date
          ? row.execution_attempted_at
          : new Date(row.execution_attempted_at);
    }
    if (row.executed_at !== null) {
      out.executedAt =
        row.executed_at instanceof Date
          ? row.executed_at
          : new Date(row.executed_at);
    }

    Object.assign(out, deriveOrderDiagnostics(out));

    return out;
  }

  private normalizeIndicators(
    value: IndicatorSnapshot | string | null,
  ): IndicatorSnapshot | undefined {
    if (!value) return undefined;
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as IndicatorSnapshot;
      } catch {
        return undefined;
      }
    }
    return value;
  }

  private normalizeStatus(status: string): ProposedOrderStatus {
    const normalized = String(status || "").toUpperCase();
    if (normalized === "PROPOSED") return "PROPOSED";
    if (normalized === "REJECTED") return "REJECTED";
    if (
      normalized === "SUBMITTED" ||
      normalized === "PRESUBMITTED" ||
      normalized === "PENDINGSUBMIT"
    )
      return "SUBMITTED";
    if (normalized === "FILLED") return "FILLED";
    if (
      normalized === "CANCELLED" ||
      normalized === "APICANCELLED" ||
      normalized === "INACTIVE"
    )
      return "CANCELLED";
    if (normalized === "SUPERSEDED") return "SUPERSEDED";
    if (normalized === "EXPIRED") return "EXPIRED";
    // Legacy compatibility.
    if (normalized === "EXECUTED") return "SUBMITTED";
    return "REJECTED";
  }

  async insertSystemAlert(input: {
    severity: "info" | "warn" | "error" | "CRITICAL";
    kind: string;
    message: string;
    payload?: Record<string, unknown>;
  }): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `
      INSERT INTO system_alerts (severity, kind, message, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING id
      `,
      [
        input.severity,
        input.kind,
        input.message,
        input.payload ? JSON.stringify(input.payload) : null,
      ],
    );
    return Number(result.rows[0].id);
  }

  async markSystemAlertDelivered(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE system_alerts SET delivered_to_telegram = TRUE WHERE id = $1`,
      [id],
    );
  }

  /**
   * Persists a single row into the Phase 1 execution audit log. Called
   * fire-and-forget by the auth Fastify plugin's onResponse hook. All
   * fields except `correlation_id`, `route`, `method`, `actor_kind`, and
   * `outcome` are optional; empty strings are stored as NULL.
   */
  async insertExecutionAuditLog(input: {
    correlationId: string;
    route: string;
    method: string;
    actorKind: "authenticated" | "unauthenticated";
    tokenFingerprint: string | null;
    ip: string | null;
    requestHash: string | null;
    outcome: "ALLOW" | "DENY_AUTH" | "DENY_GUARD" | "ERROR";
    reason: string | null;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO execution_audit_log (
        correlation_id, route, method, actor_kind,
        token_fingerprint, ip, request_hash, outcome, reason
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        input.correlationId,
        input.route,
        input.method,
        input.actorKind,
        input.tokenFingerprint || null,
        input.ip || null,
        input.requestHash || null,
        input.outcome,
        input.reason || null,
      ],
    );
  }

  async listSystemAlerts(limit = 100): Promise<SystemAlertRow[]> {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const result = await this.pool.query(
      `
      SELECT id, severity, kind, message, payload, delivered_to_telegram, created_at
      FROM system_alerts
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      severity: row.severity as "info" | "warn" | "error" | "CRITICAL",
      kind: String(row.kind),
      message: String(row.message),
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      deliveredToTelegram: Boolean(row.delivered_to_telegram),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    }));
  }

  /**
   * Reconstructs trades (entries + matched exits) from
   * broker_execution_fills using per-symbol FIFO matching. A trade is
   * one BUY-side proposed_order plus the SELL fills that closed the
   * shares it bought (TP/SL legs of the bracket, or manual flatten).
   * Returns CLOSED + OPEN trades, newest first by entryAt.
   */
  async listTrades(limit = 100): Promise<Trade[]> {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const fills = await this.pool.query(
      `
      SELECT exec_id, broker_order_id, proposed_order_id, symbol, currency,
             side, shares, price, avg_price, executed_at, commission, realized_pnl,
             strategy, entry_reason, ai_reason, ai_decision, decision_source
      FROM broker_execution_fills
      WHERE symbol IS NOT NULL AND shares IS NOT NULL AND shares > 0
      ORDER BY symbol ASC,
               COALESCE(executed_at, created_at) ASC,
               exec_id ASC
      `,
    );
    type FillRow = {
      exec_id: string;
      broker_order_id: string | null;
      proposed_order_id: number | string | null;
      symbol: string;
      currency: string | null;
      side: "BUY" | "SELL";
      shares: number;
      price: number | null;
      avg_price: number | null;
      executed_at: Date | string | null;
      commission: number | null;
      realized_pnl: number | null;
      strategy: string | null;
      entry_reason: string | null;
      ai_reason: string | null;
      ai_decision: string | null;
      decision_source: string | null;
    };
    const rows = (fills.rows as FillRow[]).map((r) => ({
      ...r,
      proposed_order_id:
        r.proposed_order_id != null ? Number(r.proposed_order_id) : null,
    }));

    type TradeSide = "LONG" | "SHORT";
    interface OpenLot {
      tradeKey: string;
      side: TradeSide;
      symbol: string;
      currency: string | null;
      proposedOrderId: number | null;
      entryBrokerOrderId: string | null;
      entryAt: Date;
      remaining: number;
      qtyOpened: number;
      entryNotional: number; // shares * price (price = buy price for LONG, sell price for SHORT)
      entryCommission: number;
      entryFillCount: number;
      strategy: string | null;
      entryReason: string | null;
      aiReason: string | null;
      aiDecision: string | null;
      decisionSource: string | null;
    }
    interface AccTrade {
      tradeKey: string;
      side: TradeSide;
      symbol: string;
      currency: string | null;
      proposedOrderId: number | null;
      entryBrokerOrderId: string | null;
      entryAt: Date;
      exitAt: Date | null;
      qtyOpened: number;
      qtyClosed: number;
      qtyOpenRemaining: number;
      entryNotional: number;
      exitNotional: number;
      entryCommission: number;
      exitCommission: number;
      realizedPnl: number;
      exitBrokerOrderIds: Set<string>;
      entryFillCount: number;
      exitFillCount: number;
      strategy: string | null;
      entryReason: string | null;
      aiReason: string | null;
      aiDecision: string | null;
      decisionSource: string | null;
    }

    const tradesByKey = new Map<string, AccTrade>();
    // Separate FIFO queues per direction so SELL-to-open (short) does not
    // get matched against existing LONG lots and vice versa.
    const openLongsBySymbol = new Map<string, OpenLot[]>();
    const openShortsBySymbol = new Map<string, OpenLot[]>();

    const ensureTrade = (lot: OpenLot): AccTrade => {
      let t = tradesByKey.get(lot.tradeKey);
      if (!t) {
        t = {
          tradeKey: lot.tradeKey,
          side: lot.side,
          symbol: lot.symbol,
          currency: lot.currency,
          proposedOrderId: lot.proposedOrderId,
          entryBrokerOrderId: lot.entryBrokerOrderId,
          entryAt: lot.entryAt,
          exitAt: null,
          qtyOpened: 0,
          qtyClosed: 0,
          qtyOpenRemaining: 0,
          entryNotional: 0,
          exitNotional: 0,
          entryCommission: 0,
          exitCommission: 0,
          realizedPnl: 0,
          exitBrokerOrderIds: new Set(),
          entryFillCount: 0,
          exitFillCount: 0,
          strategy: lot.strategy,
          entryReason: lot.entryReason,
          aiReason: lot.aiReason,
          aiDecision: lot.aiDecision,
          decisionSource: lot.decisionSource,
        };
        tradesByKey.set(lot.tradeKey, t);
      }
      return t;
    };

    const openOrExtendLot = (
      openLotsBySymbol: Map<string, OpenLot[]>,
      side: TradeSide,
      row: Omit<FillRow, "proposed_order_id"> & {
        proposed_order_id: number | null;
      },
      executedAt: Date,
      symbol: string,
      qty: number,
      price: number,
      commission: number,
    ): void => {
      const tradeKeyPrefix = side === "LONG" ? "prop" : "short-prop";
      const brokerPrefix = side === "LONG" ? "broker" : "short-broker";
      const tradeKey = row.proposed_order_id
        ? `${tradeKeyPrefix}-${row.proposed_order_id}`
        : `${brokerPrefix}-${row.broker_order_id ?? row.exec_id}`;
      const lots = openLotsBySymbol.get(symbol) ?? [];
      const lastLot = lots.length > 0 ? lots[lots.length - 1] : undefined;
      let lot: OpenLot;
      if (!lastLot || lastLot.tradeKey !== tradeKey) {
        lot = {
          tradeKey,
          side,
          symbol,
          currency: row.currency,
          proposedOrderId: row.proposed_order_id,
          entryBrokerOrderId: row.broker_order_id,
          entryAt: executedAt,
          remaining: 0,
          qtyOpened: 0,
          entryNotional: 0,
          entryCommission: 0,
          entryFillCount: 0,
          strategy: row.strategy,
          entryReason: row.entry_reason,
          aiReason: row.ai_reason,
          aiDecision: row.ai_decision,
          decisionSource: row.decision_source,
        };
        lots.push(lot);
        openLotsBySymbol.set(symbol, lots);
      } else {
        lot = lastLot;
      }
      lot.remaining += qty;
      lot.qtyOpened += qty;
      lot.entryNotional += qty * price;
      lot.entryCommission += commission;
      lot.entryFillCount += 1;

      const trade = ensureTrade(lot);
      trade.qtyOpened += qty;
      trade.qtyOpenRemaining += qty;
      trade.entryNotional += qty * price;
      trade.entryCommission += commission;
      trade.entryFillCount += 1;
    };

    for (const row of rows) {
      const executedAt =
        row.executed_at instanceof Date
          ? row.executed_at
          : row.executed_at
            ? new Date(row.executed_at)
            : new Date();
      const price = Number(row.price ?? row.avg_price ?? 0);
      const shares = Number(row.shares);
      const commission = row.commission != null ? Number(row.commission) : 0;
      const symbol = row.symbol;
      const realizedFromBroker = row.realized_pnl;

      // BUY closes existing SHORT lots first (cover), then opens/extends LONG.
      // SELL closes existing LONG lots first, then opens/extends SHORT.
      const closingLots =
        row.side === "BUY"
          ? (openShortsBySymbol.get(symbol) ?? [])
          : (openLongsBySymbol.get(symbol) ?? []);

      let toClose = shares;
      while (toClose > 0 && closingLots.length > 0) {
        const lot = closingLots[0];
        const close = Math.min(toClose, lot.remaining);
        const trade = tradesByKey.get(lot.tradeKey);
        if (!trade) break;
        const commAlloc = shares > 0 ? commission * (close / shares) : 0;
        trade.qtyClosed += close;
        trade.qtyOpenRemaining -= close;
        trade.exitNotional += close * price;
        trade.exitCommission += commAlloc;
        trade.exitFillCount += 1;
        if (row.broker_order_id) {
          trade.exitBrokerOrderIds.add(row.broker_order_id);
        }
        if (!trade.exitAt || executedAt > trade.exitAt) {
          trade.exitAt = executedAt;
        }
        if (realizedFromBroker != null && shares > 0) {
          trade.realizedPnl += Number(realizedFromBroker) * (close / shares);
        }
        lot.remaining -= close;
        toClose -= close;
        if (lot.remaining <= 0) closingLots.shift();
      }

      if (toClose > 0) {
        const qty = toClose;
        const commAlloc = shares > 0 ? commission * (qty / shares) : commission;
        if (row.side === "BUY") {
          openOrExtendLot(
            openLongsBySymbol,
            "LONG",
            row,
            executedAt,
            symbol,
            qty,
            price,
            commAlloc,
          );
        } else {
          openOrExtendLot(
            openShortsBySymbol,
            "SHORT",
            row,
            executedAt,
            symbol,
            qty,
            price,
            commAlloc,
          );
        }
      }
    }

    // Materialize trades.
    const result: Trade[] = [];
    for (const trade of tradesByKey.values()) {
      const closed = trade.qtyOpenRemaining <= 0.0001 && trade.qtyClosed > 0;
      const avgEntry =
        trade.qtyOpened > 0 ? trade.entryNotional / trade.qtyOpened : 0;
      const avgExit =
        trade.qtyClosed > 0 ? trade.exitNotional / trade.qtyClosed : null;
      // If broker realized_pnl missing, compute from prices and commissions.
      // For LONG: (sell - buy) * matched; for SHORT: (sell - buy) where
      // entryNotional was sell-side and exitNotional was buy-side.
      let realized = trade.realizedPnl;
      if (realized === 0 && trade.qtyClosed > 0 && avgExit !== null) {
        const gross =
          trade.side === "LONG"
            ? (avgExit - avgEntry) * trade.qtyClosed
            : (avgEntry - avgExit) * trade.qtyClosed;
        const buyCommAlloc =
          trade.qtyOpened > 0
            ? trade.entryCommission * (trade.qtyClosed / trade.qtyOpened)
            : 0;
        realized = gross - buyCommAlloc - trade.exitCommission;
      }
      const pnlPct =
        avgEntry > 0 && trade.qtyClosed > 0
          ? (realized / (avgEntry * trade.qtyClosed)) * 100
          : null;
      result.push({
        tradeKey: trade.tradeKey,
        symbol: trade.symbol,
        currency: trade.currency,
        status: closed ? "CLOSED" : "OPEN",
        side: trade.side,
        qtyOpened: trade.qtyOpened,
        qtyClosed: trade.qtyClosed,
        qtyOpenRemaining: trade.qtyOpenRemaining,
        avgEntryPrice: avgEntry,
        avgExitPrice: avgExit,
        entryAt: trade.entryAt,
        exitAt: trade.exitAt,
        holdMs: trade.exitAt
          ? trade.exitAt.getTime() - trade.entryAt.getTime()
          : null,
        entryCommission: trade.entryCommission,
        exitCommission: trade.exitCommission,
        realizedPnl: realized,
        realizedPnlPct: pnlPct,
        stop: null,
        takeProfit: null,
        proposedOrderId: trade.proposedOrderId,
        entryBrokerOrderId: trade.entryBrokerOrderId,
        exitBrokerOrderIds: Array.from(trade.exitBrokerOrderIds),
        strategy: trade.strategy,
        reason: trade.entryReason,
        aiReason: trade.aiReason,
        aiDecision: trade.aiDecision,
        decisionSource: trade.decisionSource,
        entryFillCount: trade.entryFillCount,
        exitFillCount: trade.exitFillCount,
      });
    }

    result.sort((a, b) => b.entryAt.getTime() - a.entryAt.getTime());
    const trimmed = result.slice(0, safeLimit);

    // Enrich with stop / take_profit from the originating proposed_orders.
    const proposedOrderIds = Array.from(
      new Set(
        trimmed
          .map((t) => t.proposedOrderId)
          .filter((id): id is number => id != null),
      ),
    );
    if (proposedOrderIds.length > 0) {
      const bracketRows = await this.pool.query(
        `SELECT id, stop, take_profit FROM proposed_orders WHERE id = ANY($1::int[])`,
        [proposedOrderIds],
      );
      const bracketById = new Map<
        number,
        { stop: number | null; takeProfit: number | null }
      >();
      for (const row of bracketRows.rows as Array<{
        id: number;
        stop: number | string | null;
        take_profit: number | string | null;
      }>) {
        bracketById.set(Number(row.id), {
          stop: row.stop != null ? Number(row.stop) : null,
          takeProfit: row.take_profit != null ? Number(row.take_profit) : null,
        });
      }
      for (const trade of trimmed) {
        if (trade.proposedOrderId != null) {
          const bracket = bracketById.get(trade.proposedOrderId);
          if (bracket) {
            trade.stop = bracket.stop;
            trade.takeProfit = bracket.takeProfit;
          }
        }
      }
    }

    return trimmed;
  }

  /**
   * Aggregates broker_execution_fills into per-symbol net positions
   * (signed shares: +qty for BUY, -qty for SELL). Symbols that net to
   * exactly zero are omitted. Used by the startup reconciliation routine
   * to compare what the execution-engine believes it holds vs what TWS
   * reports via reqPositions. We rely on broker fills (not proposed
   * orders) because they are the broker's authoritative view of what
   * actually filled.
   */
  async computeExpectedNetPositions(): Promise<ExpectedNetPosition[]> {
    const result = await this.pool.query(
      `
      SELECT
        upper(symbol) AS symbol,
        SUM(
          CASE
            WHEN upper(side) IN ('BUY', 'BOT') THEN COALESCE(shares, 0)
            WHEN upper(side) IN ('SELL', 'SLD', 'SSHORT') THEN -COALESCE(shares, 0)
            ELSE 0
          END
        ) AS net_shares,
        SUM(
          CASE WHEN upper(side) IN ('BUY', 'BOT') THEN COALESCE(shares, 0) ELSE 0 END
        ) AS long_shares,
        SUM(
          CASE WHEN upper(side) IN ('SELL', 'SLD', 'SSHORT') THEN COALESCE(shares, 0) ELSE 0 END
        ) AS short_shares,
        COUNT(*) AS fills_count,
        MAX(COALESCE(executed_at, created_at)) AS last_fill_at
      FROM broker_execution_fills
      WHERE symbol IS NOT NULL AND symbol <> ''
      GROUP BY upper(symbol)
      HAVING ABS(SUM(
        CASE
          WHEN upper(side) IN ('BUY', 'BOT') THEN COALESCE(shares, 0)
          WHEN upper(side) IN ('SELL', 'SLD', 'SSHORT') THEN -COALESCE(shares, 0)
          ELSE 0
        END
      )) > 0.000001
      ORDER BY upper(symbol) ASC
      `,
    );
    return result.rows.map((row) => ({
      symbol: String(row.symbol),
      netShares: Number(row.net_shares ?? 0),
      longShares: Number(row.long_shares ?? 0),
      shortShares: Number(row.short_shares ?? 0),
      fillsCount: Number(row.fills_count ?? 0),
      lastFillAt: row.last_fill_at
        ? row.last_fill_at instanceof Date
          ? row.last_fill_at
          : new Date(row.last_fill_at)
        : null,
    }));
  }
}
