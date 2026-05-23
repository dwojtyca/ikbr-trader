import { Pool } from "pg";
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
  severity: "info" | "warn" | "error";
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
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, NOW()
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

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS proposed_orders (
        id BIGSERIAL PRIMARY KEY,
        instrument TEXT NOT NULL,
        conid TEXT,
        side TEXT NOT NULL,
        position_effect TEXT,
        order_type TEXT NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        entry DOUBLE PRECISION,
        stop DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        reason TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        risk_check_status TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PROPOSED',
        strategy TEXT,
        indicator_snapshot JSONB,
        decision_source TEXT NOT NULL DEFAULT 'signal',
        decision_actor TEXT,
        ai_decision TEXT,
        ai_reason TEXT,
        ai_model TEXT,
        ai_decision_confidence DOUBLE PRECISION,
        llm_decision_id BIGINT,
        source_error TEXT,
        processing_owner TEXT,
        processing_claimed_at TIMESTAMPTZ,
        broker_order_id TEXT,
        execution_account_id TEXT,
        execution_message TEXT,
        last_error TEXT,
        execution_attempted_at TIMESTAMPTZ,
        executed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS broker_order_id TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_account_id TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_message TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS last_error TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_attempted_at TIMESTAMPTZ;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS position_effect TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS decision_source TEXT NOT NULL DEFAULT 'signal';`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS decision_actor TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_decision TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_reason TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_model TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_decision_confidence DOUBLE PRECISION;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS llm_decision_id BIGINT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS source_error TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS processing_owner TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS processing_claimed_at TIMESTAMPTZ;`,
    );

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS broker_execution_fills (
        exec_id TEXT PRIMARY KEY,
        order_id BIGINT,
        broker_order_id TEXT,
        proposed_order_id BIGINT REFERENCES proposed_orders(id),
        account_id TEXT,
        conid TEXT,
        symbol TEXT,
        currency TEXT,
        exchange TEXT,
        side TEXT,
        shares DOUBLE PRECISION,
        price DOUBLE PRECISION,
        avg_price DOUBLE PRECISION,
        executed_at TIMESTAMPTZ,
        commission DOUBLE PRECISION,
        commission_currency TEXT,
        realized_pnl DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool
      .query(
        `ALTER TABLE broker_execution_fills ALTER COLUMN symbol DROP NOT NULL;`,
      )
      .catch(() => undefined);
    await this.pool
      .query(
        `ALTER TABLE broker_execution_fills ALTER COLUMN side DROP NOT NULL;`,
      )
      .catch(() => undefined);
    await this.pool
      .query(
        `ALTER TABLE broker_execution_fills ALTER COLUMN shares DROP NOT NULL;`,
      )
      .catch(() => undefined);
    await this.pool
      .query(
        `ALTER TABLE broker_execution_fills ALTER COLUMN price DROP NOT NULL;`,
      )
      .catch(() => undefined);
    await this.pool.query(
      `
      UPDATE broker_execution_fills
      SET realized_pnl = NULL
      WHERE realized_pnl IS NOT NULL
        AND ABS(realized_pnl) >= $1
      `,
      [ExecutionRepository.IBKR_UNSET_DOUBLE_THRESHOLD],
    );

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_status_idx
      ON proposed_orders (status);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_created_idx
      ON proposed_orders (created_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_decision_source_idx
      ON proposed_orders (decision_source);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_processing_claim_idx
      ON proposed_orders (processing_claimed_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS broker_execution_fills_order_idx
      ON broker_execution_fills (broker_order_id, executed_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS broker_execution_fills_exec_ts_idx
      ON broker_execution_fills (executed_at DESC);
    `);

    // Legacy status cleanup: remove old EXECUTED semantics.
    await this.pool.query(`
      UPDATE proposed_orders
      SET status = 'SUBMITTED',
          executed_at = NULL
      WHERE status = 'EXECUTED'
    `);
    await this.pool.query(`
      UPDATE proposed_orders
      SET executed_at = NULL
      WHERE status = 'SUBMITTED'
        AND executed_at IS NOT NULL
    `);
    await this.reconcileFilledOrdersFromBrokerFills();

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS system_alerts (
        id BIGSERIAL PRIMARY KEY,
        severity TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        payload JSONB,
        delivered_to_telegram BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS system_alerts_created_idx
      ON system_alerts (created_at DESC);
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS system_alerts_kind_idx
      ON system_alerts (kind, created_at DESC);
    `);
  }

  async insertProposedFromTicket(
    ticket: SignalTicket,
    strategy = "manual_ticket",
  ): Promise<number> {
    const result = await this.pool.query(
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
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, 'PROPOSED', $13, 'user', NOW()
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
      ],
    );

    return Number(result.rows[0].id);
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
    severity: "info" | "warn" | "error";
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
      severity: row.severity as "info" | "warn" | "error",
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
             side, shares, price, avg_price, executed_at, commission, realized_pnl
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
    };
    const rows = (fills.rows as FillRow[]).map((r) => ({
      ...r,
      proposed_order_id:
        r.proposed_order_id != null ? Number(r.proposed_order_id) : null,
    }));

    // Collect proposed_order ids to enrich trades with strategy/reason.
    const proposedIds = Array.from(
      new Set(
        rows
          .map((r) => r.proposed_order_id)
          .filter((id): id is number => id !== null),
      ),
    );
    const proposedById = new Map<
      number,
      {
        strategy: string | null;
        reason: string | null;
        aiReason: string | null;
        aiDecision: string | null;
        decisionSource: string | null;
      }
    >();
    if (proposedIds.length > 0) {
      const propRes = await this.pool.query(
        `SELECT id, strategy, reason, ai_reason, ai_decision, decision_source
         FROM proposed_orders WHERE id = ANY($1::bigint[])`,
        [proposedIds],
      );
      for (const r of propRes.rows as Array<{
        id: number;
        strategy: string | null;
        reason: string | null;
        ai_reason: string | null;
        ai_decision: string | null;
        decision_source: string | null;
      }>) {
        proposedById.set(Number(r.id), {
          strategy: r.strategy,
          reason: r.reason,
          aiReason: r.ai_reason,
          aiDecision: r.ai_decision,
          decisionSource: r.decision_source,
        });
      }
    }

    interface OpenLot {
      tradeKey: string;
      symbol: string;
      currency: string | null;
      proposedOrderId: number | null;
      entryBrokerOrderId: string | null;
      entryAt: Date;
      remaining: number;
      qtyOpened: number;
      entryNotional: number; // shares * price
      entryCommission: number;
      entryFillCount: number;
    }
    interface AccTrade {
      tradeKey: string;
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
    }

    const tradesByKey = new Map<string, AccTrade>();
    const openLotsBySymbol = new Map<string, OpenLot[]>();

    const ensureTrade = (lot: OpenLot): AccTrade => {
      let t = tradesByKey.get(lot.tradeKey);
      if (!t) {
        t = {
          tradeKey: lot.tradeKey,
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
        };
        tradesByKey.set(lot.tradeKey, t);
      }
      return t;
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

      if (row.side === "BUY") {
        const tradeKey = row.proposed_order_id
          ? `prop-${row.proposed_order_id}`
          : `broker-${row.broker_order_id ?? row.exec_id}`;
        const lots = openLotsBySymbol.get(symbol) ?? [];
        // If most recent lot has same tradeKey, fold into it; else push new.
        let lot = lots.length > 0 ? lots[lots.length - 1] : undefined;
        if (!lot || lot.tradeKey !== tradeKey) {
          lot = {
            tradeKey,
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
          };
          lots.push(lot);
          openLotsBySymbol.set(symbol, lots);
        }
        lot.remaining += shares;
        lot.qtyOpened += shares;
        lot.entryNotional += shares * price;
        lot.entryCommission += commission;
        lot.entryFillCount += 1;

        const trade = ensureTrade(lot);
        trade.qtyOpened += shares;
        trade.qtyOpenRemaining += shares;
        trade.entryNotional += shares * price;
        trade.entryCommission += commission;
        trade.entryFillCount += 1;
      } else {
        // SELL: FIFO close against open lots
        let toClose = shares;
        let commissionRemaining = commission;
        const realizedFromBroker = row.realized_pnl;
        const lots = openLotsBySymbol.get(symbol) ?? [];
        while (toClose > 0 && lots.length > 0) {
          const lot = lots[0];
          const close = Math.min(toClose, lot.remaining);
          const trade = tradesByKey.get(lot.tradeKey);
          if (!trade) break;
          // Allocate exit commission proportionally to this slice.
          const commAlloc =
            shares > 0 ? commissionRemaining * (close / shares) : 0;
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
          // Prefer broker-supplied realized_pnl (FIFO, fee-aware) if present;
          // it is allocated proportionally for partial fills.
          if (realizedFromBroker != null && shares > 0) {
            trade.realizedPnl += Number(realizedFromBroker) * (close / shares);
          }
          lot.remaining -= close;
          toClose -= close;
          if (lot.remaining <= 0) lots.shift();
        }
        if (toClose > 0) {
          // SELL without matching BUY (short-open). Track as standalone trade.
          const tradeKey = `short-${row.broker_order_id ?? row.exec_id}`;
          const lot: OpenLot = {
            tradeKey,
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
          };
          const trade = ensureTrade(lot);
          // We don't model short positions deeply: mark qtyOpened as
          // negative-style and rely on broker realized_pnl.
          trade.qtyOpened += toClose;
          trade.entryNotional += toClose * price;
          trade.entryCommission += commission * (toClose / shares);
          trade.entryFillCount += 1;
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
      // If broker realized_pnl missing, compute (sell - buy) * matched - commissions.
      let realized = trade.realizedPnl;
      if (realized === 0 && trade.qtyClosed > 0 && avgExit !== null) {
        const gross = (avgExit - avgEntry) * trade.qtyClosed;
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
      const prop = trade.proposedOrderId
        ? proposedById.get(trade.proposedOrderId)
        : undefined;
      result.push({
        tradeKey: trade.tradeKey,
        symbol: trade.symbol,
        currency: trade.currency,
        status: closed ? "CLOSED" : "OPEN",
        side: "LONG",
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
        proposedOrderId: trade.proposedOrderId,
        entryBrokerOrderId: trade.entryBrokerOrderId,
        exitBrokerOrderIds: Array.from(trade.exitBrokerOrderIds),
        strategy: prop?.strategy ?? null,
        reason: prop?.reason ?? null,
        aiReason: prop?.aiReason ?? null,
        aiDecision: prop?.aiDecision ?? null,
        decisionSource: prop?.decisionSource ?? null,
        entryFillCount: trade.entryFillCount,
        exitFillCount: trade.exitFillCount,
      });
    }

    result.sort((a, b) => b.entryAt.getTime() - a.entryAt.getTime());
    return result.slice(0, safeLimit);
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
