import { Pool } from "pg";
import { Redis } from "ioredis";
import {
  Candle,
  CandleTimeframe,
  IndicatorSnapshot,
  InstrumentContract,
  ProposedOrder,
  ProposedOrderStatus,
  RiskCheckStatus,
  Side,
} from "@ikbr/shared";

interface StoredMarketState {
  conid: string;
  symbol: string;
  lastPrice: number;
  bid?: number;
  ask?: number;
  spread?: number;
  ts: string;
}

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
  risk_check_status: RiskCheckStatus;
  status:
    | "PROPOSED"
    | "REJECTED"
    | "SUBMITTED"
    | "FILLED"
    | "CANCELLED"
    | "SUPERSEDED"
    | "EXPIRED"
    | "EXECUTED";
  strategy: string | null;
  indicator_snapshot: IndicatorSnapshot | string | null;
  execution_attempted_at: Date | string | null;
  executed_at: Date | string | null;
  generated_from_candle_ts: Date | string | null;
  lifecycle_reason: string | null;
  superseded_by_order_id: number | null;
  created_at: Date | string;
}

interface SignalOutcomeRow {
  proposed_order_id: number;
  instrument: string;
  strategy: string | null;
  side: Side;
  confidence: number;
  entry: number | null;
  stop: number | null;
  take_profit: number | null;
  executed_at: Date | string | null;
  conid: string | null;
}

export interface SignalOutcomeSummary {
  scope: "symbol" | "strategy";
  key: string;
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  avgPnlPct?: number;
  medianPnlPct?: number;
}

export interface SignalPerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPct?: number;
  medianPnlPct?: number;
  expectancyPct?: number;
}

export interface StrategyRuntimeState {
  strategyId: string;
  enabled: boolean;
  permanentlyDisabled: boolean;
  cooldownUntil?: Date;
  consecutiveLossCount: number;
  cooldownCount: number;
  reason?: string;
}

export interface SignalReportOverview {
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  totalPnl?: number;
  grossPnl?: number;
  commissions?: number;
  avgPnl?: number;
  avgPnlPct?: number;
  medianPnlPct?: number;
  avgConfidence?: number;
  takeProfitHits: number;
  stopHits: number;
}

export interface SignalReportAggregate {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  strategyEnabled?: boolean;
  strategyPermanentlyDisabled?: boolean;
  strategyCooldownUntil?: string;
  strategyReason?: string;
  totalPnl?: number;
  grossPnl?: number;
  commissions?: number;
  avgPnl?: number;
  avgPnlPct?: number;
  medianPnlPct?: number;
  avgConfidence?: number;
  takeProfitHits: number;
  stopHits: number;
}

export interface SignalReportTrade {
  orderId: number;
  instrument: string;
  strategy: string;
  side: Side;
  directionalRegime: string;
  volatilityRegime: string;
  confidence: number;
  pnl?: number;
  grossPnl?: number;
  commissions?: number;
  pnlPct?: number;
  notes: string;
  executedAt: string;
}

export interface SignalReport {
  generatedAt: string;
  limit: number;
  source: "broker_fills";
  overview: SignalReportOverview;
  bySymbol: SignalReportAggregate[];
  byStrategy: SignalReportAggregate[];
  byStrategySymbolSide: SignalReportAggregate[];
  bySide: SignalReportAggregate[];
  byDirectionalRegime: SignalReportAggregate[];
  byVolatilityRegime: SignalReportAggregate[];
  worstTrades: SignalReportTrade[];
}

export interface ExposureSnapshot {
  exposure: number;
  openPositions: number;
  source: "execution" | "db";
  positionsBySymbol: Record<string, number>;
  accountEquity?: number;
  fxToBaseByCurrency?: Record<string, number>;
  longExposure?: number;
  shortExposure?: number;
  positionContextsBySymbol?: Record<
    string,
    {
      quantity: number;
      averageCost?: number;
      marketPrice?: number;
      marketValue?: number;
      unrealizedPnL?: number;
    }
  >;
}

export interface LatestFilledOrderContext {
  instrument: string;
  side: Side;
  quantity: number;
  entry?: number;
  stop?: number;
  takeProfit?: number;
  executedAt: Date;
  createdAt: Date;
  strategy?: string;
}

export class SignalRepository {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
  ) {}

  async init(): Promise<void> {
    for (const table of [
      "candles_1m",
      "candles_5m",
      "candles_1h",
      "candles_4h",
      "candles_12h",
      "candles_1d",
      "candles_1w",
    ] as const) {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          conid TEXT NOT NULL,
          symbol TEXT NOT NULL,
          ts TIMESTAMPTZ NOT NULL,
          open DOUBLE PRECISION NOT NULL,
          high DOUBLE PRECISION NOT NULL,
          low DOUBLE PRECISION NOT NULL,
          close DOUBLE PRECISION NOT NULL,
          volume DOUBLE PRECISION NOT NULL,
          PRIMARY KEY (conid, ts)
        );
      `);

      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS ${table}_symbol_ts_idx
        ON ${table} (symbol, ts DESC);
      `);
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS instrument_contracts (
        symbol TEXT PRIMARY KEY,
        conid TEXT NOT NULL,
        sec_type TEXT NOT NULL,
        exchange TEXT,
        primary_exchange TEXT,
        currency TEXT,
        local_symbol TEXT,
        trading_class TEXT,
        min_tick DOUBLE PRECISION,
        display_name TEXT,
        contract_json JSONB,
        details_json JSONB,
        source TEXT NOT NULL,
        resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS instrument_contracts_conid_idx
      ON instrument_contracts (conid);
    `);

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
        status TEXT NOT NULL,
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
        generated_from_candle_ts TIMESTAMPTZ,
        lifecycle_reason TEXT,
        superseded_by_order_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS conid TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS entry DOUBLE PRECISION;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PROPOSED';`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS strategy TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS indicator_snapshot JSONB;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS broker_order_id TEXT;`,
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
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_attempted_at TIMESTAMPTZ;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS generated_from_candle_ts TIMESTAMPTZ;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS partial_take_profits JSONB;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS trailing_stop_pct DOUBLE PRECISION;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS trailing_stop_activation_r DOUBLE PRECISION;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS lifecycle_reason TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS superseded_by_order_id BIGINT;`,
    );

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_created_idx
      ON proposed_orders (created_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_status_idx
      ON proposed_orders (status);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_instrument_status_side_created_idx
      ON proposed_orders (instrument, status, side, created_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_signal_candle_idx
      ON proposed_orders (instrument, generated_from_candle_ts DESC);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS signal_outcomes (
        id BIGSERIAL PRIMARY KEY,
        proposed_order_id BIGINT NOT NULL REFERENCES proposed_orders(id),
        evaluated_at TIMESTAMPTZ NOT NULL,
        pnl_pct DOUBLE PRECISION,
        hit_stop BOOLEAN,
        hit_take_profit BOOLEAN,
        notes TEXT
      );
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS signal_outcomes_order_idx
      ON signal_outcomes (proposed_order_id, evaluated_at DESC);
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS strategy_runtime_state (
        strategy_id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        permanently_disabled BOOLEAN NOT NULL DEFAULT FALSE,
        cooldown_until TIMESTAMPTZ,
        consecutive_loss_count INTEGER NOT NULL DEFAULT 0,
        cooldown_count INTEGER NOT NULL DEFAULT 0,
        last_evaluated_fill_at TIMESTAMPTZ,
        last_state_change_at TIMESTAMPTZ,
        reason TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      DROP TABLE IF EXISTS strategy_symbol_policy;
    `);
  }

  async getRecentCandles(
    symbol: string,
    timeframe: CandleTimeframe,
    limit: number,
  ): Promise<Candle[]> {
    const table = this.tableForTimeframe(timeframe);
    const result = await this.pool.query(
      `
      SELECT conid, symbol, ts, open, high, low, close, volume
      FROM ${table}
      WHERE symbol = $1
      ORDER BY ts DESC
      LIMIT $2;
      `,
      [symbol, limit],
    );

    return result.rows
      .map((row) => ({
        conid: row.conid as string,
        symbol: row.symbol as string,
        timeframe,
        ts: new Date(row.ts),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }))
      .reverse();
  }

  async getMarketState(conid: string): Promise<StoredMarketState | null> {
    const raw = await this.redis.get(`market-state:${conid}`);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as StoredMarketState;
    } catch {
      return null;
    }
  }

  async getInstrumentContract(
    symbol: string,
    conid?: string,
  ): Promise<InstrumentContract | null> {
    const result = await this.pool.query(
      `
      SELECT symbol, conid, sec_type, exchange, primary_exchange, currency,
             local_symbol, trading_class, min_tick, display_name,
             contract_json, details_json, source, resolved_at
      FROM instrument_contracts
      WHERE UPPER(symbol) = UPPER($1)
         OR ($2::text IS NOT NULL AND conid = $2::text)
      ORDER BY CASE WHEN UPPER(symbol) = UPPER($1) THEN 0 ELSE 1 END
      LIMIT 1
      `,
      [symbol, conid ?? null],
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
      symbol: String(row.symbol),
      conid: String(row.conid),
      secType: String(row.sec_type),
      exchange: row.exchange ?? undefined,
      primaryExchange: row.primary_exchange ?? undefined,
      currency: row.currency ?? undefined,
      localSymbol: row.local_symbol ?? undefined,
      tradingClass: row.trading_class ?? undefined,
      minTick:
        row.min_tick === null || row.min_tick === undefined
          ? undefined
          : Number(row.min_tick),
      displayName: row.display_name ?? undefined,
      contractJson: row.contract_json ?? undefined,
      detailsJson: row.details_json ?? undefined,
      source: row.source === "override_fallback" ? "override_fallback" : "ibkr",
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
    };
  }

  async getOpenExposureNotional(): Promise<number> {
    const positions = await this.getDbNetPositions();
    return positions.reduce(
      (sum, row) => sum + Math.abs(row.netQty) * row.referencePrice,
      0,
    );
  }

  async getOpenPositionsCount(): Promise<number> {
    const positions = await this.getDbNetPositions();
    return positions.length;
  }

  async getExposureSnapshot(
    executionBaseUrl?: string,
  ): Promise<ExposureSnapshot> {
    if (executionBaseUrl) {
      const fromExecution =
        await this.tryLoadExposureFromExecution(executionBaseUrl);
      if (fromExecution) return fromExecution;
    }

    const positions = await this.getDbNetPositions();
    const positionsBySymbol: Record<string, number> = {};
    let exposure = 0;
    for (const row of positions) {
      positionsBySymbol[row.instrument] = row.netQty;
      exposure += Math.abs(row.netQty) * row.referencePrice;
    }

    return {
      exposure,
      openPositions: positions.length,
      source: "db",
      positionsBySymbol,
    };
  }

  async getLatestFilledOrderContext(
    instrument: string,
  ): Promise<LatestFilledOrderContext | null> {
    const result = await this.pool.query(
      `
      SELECT instrument, side, quantity, entry, stop, take_profit, executed_at, created_at, strategy
      FROM proposed_orders
      WHERE UPPER(instrument) = UPPER($1)
        AND status = 'FILLED'
      ORDER BY COALESCE(executed_at, created_at) DESC
      LIMIT 1
      `,
      [instrument],
    );

    const row = result.rows[0] as
      | {
          instrument: string;
          side: Side;
          quantity: number;
          entry: number | null;
          stop: number | null;
          take_profit: number | null;
          executed_at: Date | string | null;
          created_at: Date | string;
          strategy: string | null;
        }
      | undefined;

    if (!row) return null;

    const executedAtRaw = row.executed_at ?? row.created_at;
    const executedAt =
      executedAtRaw instanceof Date ? executedAtRaw : new Date(executedAtRaw);
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at);
    if (Number.isNaN(executedAt.getTime()) || Number.isNaN(createdAt.getTime()))
      return null;

    return {
      instrument: row.instrument,
      side: row.side,
      quantity: Number(row.quantity),
      entry: row.entry === null ? undefined : Number(row.entry),
      stop: row.stop === null ? undefined : Number(row.stop),
      takeProfit:
        row.take_profit === null ? undefined : Number(row.take_profit),
      executedAt,
      createdAt,
      strategy: row.strategy ?? undefined,
    };
  }

  async getOpenPositionBySymbol(
    symbol: string,
  ): Promise<{ strategyId: string; entryPrice: number | null } | null> {
    const result = await this.pool.query(
      `
      SELECT strategy, entry
      FROM proposed_orders
      WHERE UPPER(symbol) = UPPER($1)
        AND position_effect = 'OPEN_OR_ADD'
        AND status = 'FILLED'
      ORDER BY executed_at DESC
      LIMIT 1
      `,
      [symbol],
    );

    const row = result.rows[0] as
      | {
          strategy: string | null;
          entry: number | null;
        }
      | undefined;

    if (!row || !row.strategy) return null;

    return {
      strategyId: row.strategy,
      entryPrice: row.entry !== null ? Number(row.entry) : null,
    };
  }

  async syncStrategyRuntimeStates(
    strategyIds: string[],
    cooldownMs: number,
  ): Promise<void> {
    if (strategyIds.length === 0) return;

    const existingResult = await this.pool.query(
      `
      SELECT strategy_id, enabled, permanently_disabled, cooldown_until, consecutive_loss_count,
        cooldown_count, last_evaluated_fill_at, reason
      FROM strategy_runtime_state
      WHERE strategy_id = ANY($1)
      `,
      [strategyIds],
    );

    const states = new Map<
      string,
      {
        strategyId: string;
        enabled: boolean;
        permanentlyDisabled: boolean;
        cooldownUntil: Date | null;
        consecutiveLossCount: number;
        cooldownCount: number;
        lastEvaluatedFillAt: Date | null;
        reason: string | null;
        changed: boolean;
      }
    >();

    for (const strategyId of strategyIds) {
      states.set(strategyId, {
        strategyId,
        enabled: true,
        permanentlyDisabled: false,
        cooldownUntil: null,
        consecutiveLossCount: 0,
        cooldownCount: 0,
        lastEvaluatedFillAt: null,
        reason: null,
        changed: false,
      });
    }

    for (const row of existingResult.rows) {
      const state = states.get(String(row.strategy_id));
      if (!state) continue;
      state.enabled = row.enabled !== false;
      state.permanentlyDisabled = row.permanently_disabled === true;
      state.cooldownUntil = row.cooldown_until
        ? new Date(row.cooldown_until)
        : null;
      state.consecutiveLossCount = Number(row.consecutive_loss_count ?? 0);
      state.cooldownCount = Number(row.cooldown_count ?? 0);
      state.lastEvaluatedFillAt = row.last_evaluated_fill_at
        ? new Date(row.last_evaluated_fill_at)
        : null;
      state.reason = row.reason ?? null;
    }

    const outcomesResult = await this.pool.query(
      `
      WITH broker_orders AS (
        SELECT
          bef.proposed_order_id,
          SUM(COALESCE(bef.realized_pnl, 0) - COALESCE(bef.commission, 0)) AS pnl,
          MAX(bef.executed_at) AS executed_at
        FROM broker_execution_fills bef
        WHERE bef.proposed_order_id IS NOT NULL
        GROUP BY bef.proposed_order_id
      )
      SELECT po.strategy, broker_orders.proposed_order_id, broker_orders.pnl, broker_orders.executed_at
      FROM broker_orders
      JOIN proposed_orders po ON po.id = broker_orders.proposed_order_id
      WHERE po.strategy = ANY($1)
        AND po.strategy <> 'manual_ticket'
        AND broker_orders.executed_at IS NOT NULL
      ORDER BY broker_orders.executed_at ASC, broker_orders.proposed_order_id ASC
      `,
      [strategyIds],
    );

    const cooldownDuration = Math.max(0, cooldownMs);
    for (const row of outcomesResult.rows) {
      const strategyId = String(row.strategy);
      const state = states.get(strategyId);
      if (!state) continue;

      const executedAt =
        row.executed_at instanceof Date
          ? row.executed_at
          : new Date(row.executed_at);
      if (Number.isNaN(executedAt.getTime())) continue;
      if (state.lastEvaluatedFillAt && executedAt <= state.lastEvaluatedFillAt)
        continue;
      if (state.permanentlyDisabled) {
        state.lastEvaluatedFillAt = executedAt;
        state.changed = true;
        continue;
      }

      const pnl = Number(row.pnl ?? 0);
      if (pnl < 0) {
        state.consecutiveLossCount += 1;
      } else if (pnl > 0) {
        state.consecutiveLossCount = 0;
      }

      if (state.consecutiveLossCount >= 3) {
        if (state.cooldownCount >= 1) {
          state.enabled = false;
          state.permanentlyDisabled = true;
          state.cooldownUntil = null;
          state.reason = `Strategy OFF after second 3-loss streak; last pnl=${pnl.toFixed(2)}`;
        } else {
          state.cooldownCount += 1;
          state.cooldownUntil = new Date(Date.now() + cooldownDuration);
          state.reason = `Strategy cooldown after 3 consecutive losses; last pnl=${pnl.toFixed(2)}`;
        }
        state.consecutiveLossCount = 0;
      }

      state.lastEvaluatedFillAt = executedAt;
      state.changed = true;
    }

    for (const state of states.values()) {
      if (
        !state.changed &&
        existingResult.rows.some(
          (row) => String(row.strategy_id) === state.strategyId,
        )
      )
        continue;

      await this.pool.query(
        `
        INSERT INTO strategy_runtime_state (
          strategy_id, enabled, permanently_disabled, cooldown_until, consecutive_loss_count,
          cooldown_count, last_evaluated_fill_at, last_state_change_at, reason, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, NOW())
        ON CONFLICT (strategy_id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          permanently_disabled = EXCLUDED.permanently_disabled,
          cooldown_until = EXCLUDED.cooldown_until,
          consecutive_loss_count = EXCLUDED.consecutive_loss_count,
          cooldown_count = EXCLUDED.cooldown_count,
          last_evaluated_fill_at = EXCLUDED.last_evaluated_fill_at,
          last_state_change_at = CASE
            WHEN strategy_runtime_state.enabled IS DISTINCT FROM EXCLUDED.enabled
              OR strategy_runtime_state.permanently_disabled IS DISTINCT FROM EXCLUDED.permanently_disabled
              OR strategy_runtime_state.cooldown_until IS DISTINCT FROM EXCLUDED.cooldown_until
            THEN NOW()
            ELSE strategy_runtime_state.last_state_change_at
          END,
          reason = EXCLUDED.reason,
          updated_at = NOW()
        `,
        [
          state.strategyId,
          state.enabled,
          state.permanentlyDisabled,
          state.cooldownUntil,
          state.consecutiveLossCount,
          state.cooldownCount,
          state.lastEvaluatedFillAt,
          state.reason,
        ],
      );
    }
  }

  async getStrategyRuntimeState(
    strategyId: string,
  ): Promise<StrategyRuntimeState> {
    const result = await this.pool.query(
      `
      SELECT strategy_id, enabled, permanently_disabled, cooldown_until, consecutive_loss_count,
        cooldown_count, reason
      FROM strategy_runtime_state
      WHERE strategy_id = $1
      `,
      [strategyId],
    );

    const row = result.rows[0];
    if (!row) {
      return {
        strategyId,
        enabled: true,
        permanentlyDisabled: false,
        consecutiveLossCount: 0,
        cooldownCount: 0,
      };
    }

    return {
      strategyId: String(row.strategy_id),
      enabled: row.enabled !== false,
      permanentlyDisabled: row.permanently_disabled === true,
      cooldownUntil: row.cooldown_until
        ? new Date(row.cooldown_until)
        : undefined,
      consecutiveLossCount: Number(row.consecutive_loss_count ?? 0),
      cooldownCount: Number(row.cooldown_count ?? 0),
      reason: row.reason ?? undefined,
    };
  }

  async setStrategyManualEnabled(
    strategyId: string,
    enabled: boolean,
  ): Promise<StrategyRuntimeState> {
    const permanentlyDisabled = !enabled;
    const reason = enabled ? "Manual ON from report" : "Manual OFF from report";

    await this.pool.query(
      `
      INSERT INTO strategy_runtime_state (
        strategy_id, enabled, permanently_disabled, cooldown_until, consecutive_loss_count,
        cooldown_count, last_evaluated_fill_at, last_state_change_at, reason, updated_at
      )
      VALUES ($1, $2, $3, NULL, 0, 0, NOW(), NOW(), $4, NOW())
      ON CONFLICT (strategy_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        permanently_disabled = EXCLUDED.permanently_disabled,
        cooldown_until = NULL,
        consecutive_loss_count = 0,
        cooldown_count = 0,
        last_evaluated_fill_at = COALESCE(strategy_runtime_state.last_evaluated_fill_at, NOW()),
        last_state_change_at = NOW(),
        reason = EXCLUDED.reason,
        updated_at = NOW()
      `,
      [strategyId, enabled, permanentlyDisabled, reason],
    );

    return this.getStrategyRuntimeState(strategyId);
  }

  async getSignalPerformance(input: {
    instrument?: string;
    strategy: string;
    side: Exclude<Side, "HOLD">;
    limit?: number;
  }): Promise<SignalPerformanceStats> {
    const limit = Math.max(5, Math.min(100, input.limit ?? 40));
    const params: Array<string | number> = [input.strategy, input.side, limit];
    const instrumentFilter = input.instrument
      ? `AND UPPER(po.instrument) = UPPER($${params.push(input.instrument)})`
      : "";

    const result = await this.pool.query(
      `
      SELECT pnl_pct
      FROM (
        SELECT so.pnl_pct, so.evaluated_at
        FROM signal_outcomes so
        JOIN proposed_orders po ON po.id = so.proposed_order_id
        WHERE po.strategy = $1
          AND po.side = $2
          AND so.pnl_pct IS NOT NULL
          ${instrumentFilter}
        ORDER BY so.evaluated_at DESC
        LIMIT $3
      ) recent
      ORDER BY evaluated_at ASC
      `,
      params,
    );

    const values = result.rows
      .map((row: { pnl_pct: number | string | null }) => Number(row.pnl_pct))
      .filter((value: number) => Number.isFinite(value));
    const trades = values.length;
    if (trades === 0) {
      return { trades: 0, wins: 0, losses: 0, winRate: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const midpoint = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
        : sorted[midpoint];
    const wins = values.filter((value) => value > 0).length;
    const losses = trades - wins;
    const avg = values.reduce((sum, value) => sum + value, 0) / trades;
    const avgWin =
      wins > 0
        ? values
            .filter((value) => value > 0)
            .reduce((sum, value) => sum + value, 0) / wins
        : 0;
    const avgLoss =
      losses > 0
        ? Math.abs(
            values
              .filter((value) => value <= 0)
              .reduce((sum, value) => sum + value, 0) / losses,
          )
        : 0;
    const winRate = wins / trades;
    const expectancy = avgWin * winRate - avgLoss * (1 - winRate);

    return {
      trades,
      wins,
      losses,
      winRate,
      avgPnlPct: avg,
      medianPnlPct: median,
      expectancyPct: expectancy,
    };
  }

  async insertProposedOrder(order: ProposedOrder): Promise<number> {
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
        indicator_snapshot,
        decision_source,
        decision_actor,
        ai_decision,
        ai_reason,
        ai_model,
        ai_decision_confidence,
        llm_decision_id,
        source_error,
        processing_owner,
        processing_claimed_at,
        generated_from_candle_ts,
        lifecycle_reason,
        superseded_by_order_id,
        partial_take_profits,
        trailing_stop_pct,
        trailing_stop_activation_r,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        'signal', NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL,
        $16, $17, $18, $19, $20, $21, NOW()
      )
      RETURNING id
      `,
      [
        order.instrument,
        order.conid ?? null,
        order.side,
        order.positionEffect ?? null,
        order.orderType,
        order.quantity,
        order.entry ?? null,
        order.stop ?? null,
        order.takeProfit ?? null,
        order.reason,
        order.confidence,
        order.riskCheckStatus,
        order.status,
        order.strategy ?? null,
        JSON.stringify(order.indicators ?? null),
        order.generatedFromCandleTs ?? null,
        order.lifecycleReason ?? null,
        order.supersededByOrderId ?? null,
        order.partialTakeProfits
          ? JSON.stringify(order.partialTakeProfits)
          : null,
        order.trailingStopPct ?? null,
        order.trailingStopActivationR ?? null,
      ],
    );

    return Number(result.rows[0].id);
  }

  async supersedePendingSignalsForInstrument(
    instrument: string,
    supersededByOrderId: number,
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'SUPERSEDED',
          lifecycle_reason = COALESCE(lifecycle_reason, 'Superseded by newer signal for instrument'),
          superseded_by_order_id = $2
      WHERE instrument = $1
        AND status = 'PROPOSED'
        AND id <> $2
        AND processing_owner IS NULL
      `,
      [instrument, supersededByOrderId],
    );
  }

  async expireStalePendingSignals(ttlMs: number): Promise<number> {
    if (!(ttlMs > 0)) return 0;

    const result = await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'EXPIRED',
          lifecycle_reason = COALESCE(lifecycle_reason, 'Signal expired before execution')
      WHERE status = 'PROPOSED'
        AND processing_owner IS NULL
        AND created_at < NOW() - (($1::BIGINT || ' milliseconds')::interval)
      `,
      [ttlMs],
    );

    return Number(result.rowCount ?? 0);
  }

  /**
   * Deletes proposed_orders older than `retentionDays`, regardless of status.
   * proposed_orders is treated as a rolling signal/decision log; the
   * authoritative trade history lives in broker_execution_fills which has
   * its own denormalized snapshot of strategy/reason/ai_* fields and an
   * ON DELETE SET NULL FK back to proposed_orders.
   */
  async cleanupExpiredProposals(retentionDays: number): Promise<number> {
    if (!(retentionDays > 0)) return 0;
    const result = await this.pool.query(
      `
      DELETE FROM proposed_orders
      WHERE created_at < NOW() - (($1::INT || ' days')::interval)
      `,
      [Math.floor(retentionDays)],
    );
    return Number(result.rowCount ?? 0);
  }

  async getRecentSignals(limit: number): Promise<ProposedOrder[]> {
    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
             execution_attempted_at, executed_at, generated_from_candle_ts, lifecycle_reason, superseded_by_order_id,
             created_at
      FROM proposed_orders
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit],
    );

    return result.rows.map((row) => this.mapRow(row as ProposedOrderRow));
  }

  async refreshSignalOutcomes(limit = 500): Promise<number> {
    const candidates = await this.pool.query(
      `
      SELECT po.id AS proposed_order_id, po.instrument, po.strategy, po.side, po.confidence, po.entry, po.stop, po.take_profit,
             COALESCE(po.executed_at, po.execution_attempted_at, po.created_at) AS executed_at,
             po.conid
      FROM proposed_orders po
      LEFT JOIN LATERAL (
        SELECT so.id
        FROM signal_outcomes so
        WHERE so.proposed_order_id = po.id
        ORDER BY so.evaluated_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE po.status = 'FILLED'
        AND po.entry IS NOT NULL
        AND latest.id IS NULL
      ORDER BY COALESCE(po.executed_at, po.execution_attempted_at, po.created_at) ASC
      LIMIT $1
      `,
      [limit],
    );

    let inserted = 0;
    for (const row of candidates.rows as SignalOutcomeRow[]) {
      const executedAtRaw =
        row.executed_at instanceof Date
          ? row.executed_at
          : row.executed_at
            ? new Date(row.executed_at)
            : null;
      if (!executedAtRaw || Number.isNaN(executedAtRaw.getTime())) continue;

      const candles = await this.pool.query(
        `
        SELECT ts, high, low, close
        FROM candles_1m
        WHERE symbol = $1
          AND ts >= $2
        ORDER BY ts ASC
        LIMIT 500
        `,
        [row.instrument, executedAtRaw],
      );

      const entry = Number(row.entry ?? NaN);
      if (!Number.isFinite(entry) || entry <= 0) continue;

      const stop = row.stop !== null ? Number(row.stop) : undefined;
      const takeProfit =
        row.take_profit !== null ? Number(row.take_profit) : undefined;
      let pnlPct: number | null = null;
      let hitStop = false;
      let hitTakeProfit = false;
      let notes = "mark_to_market";

      for (const candle of candles.rows as Array<{
        ts: Date | string;
        high: number;
        low: number;
        close: number;
      }>) {
        const high = Number(candle.high);
        const low = Number(candle.low);

        if (row.side === "BUY") {
          if (takeProfit !== undefined && high >= takeProfit) {
            pnlPct = ((takeProfit - entry) / entry) * 100;
            hitTakeProfit = true;
            notes = "take_profit_hit";
            break;
          }
          if (stop !== undefined && low <= stop) {
            pnlPct = ((stop - entry) / entry) * 100;
            hitStop = true;
            notes = "stop_hit";
            break;
          }
        } else if (row.side === "SELL") {
          if (takeProfit !== undefined && low <= takeProfit) {
            pnlPct = ((entry - takeProfit) / entry) * 100;
            hitTakeProfit = true;
            notes = "take_profit_hit";
            break;
          }
          if (stop !== undefined && high >= stop) {
            pnlPct = ((entry - stop) / entry) * 100;
            hitStop = true;
            notes = "stop_hit";
            break;
          }
        }
      }

      if (pnlPct === null && candles.rows.length > 0) {
        const lastCandle = candles.rows[candles.rows.length - 1] as {
          close: number;
        };
        const close = Number(lastCandle.close);
        if (Number.isFinite(close) && close > 0) {
          pnlPct =
            row.side === "BUY"
              ? ((close - entry) / entry) * 100
              : ((entry - close) / entry) * 100;
        }
      }

      await this.pool.query(
        `
        INSERT INTO signal_outcomes (proposed_order_id, evaluated_at, pnl_pct, hit_stop, hit_take_profit, notes)
        VALUES ($1, NOW(), $2, $3, $4, $5)
        `,
        [row.proposed_order_id, pnlPct, hitStop, hitTakeProfit, notes],
      );
      inserted += 1;
    }

    return inserted;
  }

  async getSignalOutcomeSummary(limit = 20): Promise<SignalOutcomeSummary[]> {
    const result = await this.pool.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (so.proposed_order_id)
          so.proposed_order_id,
          so.pnl_pct,
          so.notes
        FROM signal_outcomes so
        ORDER BY so.proposed_order_id, so.evaluated_at DESC
      ),
      base AS (
        SELECT
          po.instrument,
          COALESCE(po.strategy, 'n/a') AS strategy,
          latest.pnl_pct,
          latest.notes
        FROM latest
        JOIN proposed_orders po ON po.id = latest.proposed_order_id
      ),
      symbol_stats AS (
        SELECT
          'symbol'::text AS scope,
          instrument AS key,
          COUNT(*)::int AS trades,
          COUNT(*) FILTER (WHERE pnl_pct > 0)::int AS wins,
          COUNT(*) FILTER (WHERE pnl_pct < 0)::int AS losses,
          COUNT(*) FILTER (WHERE notes = 'mark_to_market')::int AS open,
          AVG(pnl_pct) AS avg_pnl_pct,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median_pnl_pct
        FROM base
        GROUP BY instrument
      ),
      strategy_stats AS (
        SELECT
          'strategy'::text AS scope,
          strategy AS key,
          COUNT(*)::int AS trades,
          COUNT(*) FILTER (WHERE pnl_pct > 0)::int AS wins,
          COUNT(*) FILTER (WHERE pnl_pct < 0)::int AS losses,
          COUNT(*) FILTER (WHERE notes = 'mark_to_market')::int AS open,
          AVG(pnl_pct) AS avg_pnl_pct,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median_pnl_pct
        FROM base
        GROUP BY strategy
      )
      SELECT *
      FROM (
        SELECT * FROM symbol_stats
        UNION ALL
        SELECT * FROM strategy_stats
      ) stats
      ORDER BY trades DESC, key ASC
      LIMIT $1
      `,
      [limit],
    );

    return result.rows.map((row) => ({
      scope: row.scope,
      key: row.key,
      trades: Number(row.trades),
      wins: Number(row.wins),
      losses: Number(row.losses),
      open: Number(row.open),
      winRate:
        Number(row.trades) > 0 ? Number(row.wins) / Number(row.trades) : 0,
      avgPnlPct: row.avg_pnl_pct === null ? undefined : Number(row.avg_pnl_pct),
      medianPnlPct:
        row.median_pnl_pct === null ? undefined : Number(row.median_pnl_pct),
    }));
  }

  async getSignalReport(
    limit = 300,
    strategyIds: string[] = [],
  ): Promise<SignalReport> {
    const boundedLimit = Math.min(Math.max(limit, 20), 2000);
    const baseCte = `
      WITH broker_orders AS (
        SELECT
          COALESCE(bef.proposed_order_id, -bef.order_id) AS report_order_id,
          MAX(bef.proposed_order_id) AS proposed_order_id,
          MAX(bef.order_id) AS broker_numeric_order_id,
          MAX(bef.symbol) AS instrument,
          MAX(bef.side) AS side,
          SUM(COALESCE(bef.realized_pnl, 0)) AS gross_pnl,
          SUM(COALESCE(bef.commission, 0)) AS commissions,
          SUM(COALESCE(bef.realized_pnl, 0) - COALESCE(bef.commission, 0)) AS pnl,
          SUM(ABS(COALESCE(bef.shares, 0) * COALESCE(bef.price, bef.avg_price, 0))) AS notional,
          MAX(bef.executed_at) AS executed_at
        FROM broker_execution_fills bef
        GROUP BY COALESCE(bef.proposed_order_id, -bef.order_id)
      ),
      base AS (
        SELECT
          COALESCE(po.id, broker_orders.report_order_id) AS order_id,
          COALESCE(po.instrument, broker_orders.instrument, 'n/a') AS instrument,
          COALESCE(po.strategy, 'n/a') AS strategy,
          COALESCE(po.side, broker_orders.side, 'n/a') AS side,
          COALESCE(po.indicator_snapshot ->> 'directionalRegime', 'unknown') AS directional_regime,
          COALESCE(po.indicator_snapshot ->> 'volatilityRegime', 'unknown') AS volatility_regime,
          po.confidence,
          broker_orders.pnl,
          broker_orders.gross_pnl,
          broker_orders.commissions,
          CASE
            WHEN broker_orders.notional > 0 THEN (broker_orders.pnl / broker_orders.notional) * 100
            ELSE NULL
          END AS pnl_pct,
          'broker_fill' AS notes,
          false AS hit_stop,
          false AS hit_take_profit,
          broker_orders.executed_at
        FROM broker_orders
        LEFT JOIN proposed_orders po ON po.id = broker_orders.proposed_order_id
        WHERE broker_orders.executed_at IS NOT NULL
        ORDER BY broker_orders.executed_at DESC
        LIMIT $1
      )
    `;

    const overviewResult = await this.pool.query(
      `
      ${baseCte}
      SELECT
        COUNT(*)::int AS trades,
        COUNT(*) FILTER (WHERE pnl > 0)::int AS wins,
        COUNT(*) FILTER (WHERE pnl < 0)::int AS losses,
        0::int AS open,
        SUM(pnl) AS total_pnl,
        SUM(gross_pnl) AS gross_pnl,
        SUM(commissions) AS commissions,
        AVG(pnl) AS avg_pnl,
        AVG(pnl_pct) AS avg_pnl_pct,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median_pnl_pct,
        AVG(confidence) AS avg_confidence,
        COUNT(*) FILTER (WHERE hit_take_profit)::int AS take_profit_hits,
        COUNT(*) FILTER (WHERE hit_stop)::int AS stop_hits
      FROM base
      `,
      [boundedLimit],
    );

    const aggregateResults = await Promise.all([
      this.queryReportAggregate(baseCte, boundedLimit, "instrument"),
      this.queryReportAggregate(baseCte, boundedLimit, "strategy", strategyIds),
      this.queryReportAggregate(baseCte, boundedLimit, "strategy_symbol_side"),
      this.queryReportAggregate(baseCte, boundedLimit, "side"),
      this.queryReportAggregate(baseCte, boundedLimit, "directional_regime"),
      this.queryReportAggregate(baseCte, boundedLimit, "volatility_regime"),
    ]);

    const worstTradesResult = await this.pool.query(
      `
      ${baseCte}
      SELECT
        order_id,
        instrument,
        strategy,
        side,
        directional_regime,
        volatility_regime,
        confidence,
        pnl,
        gross_pnl,
        commissions,
        pnl_pct,
        notes,
        executed_at
      FROM base
      WHERE pnl IS NOT NULL
      ORDER BY pnl ASC, executed_at DESC
      LIMIT 12
      `,
      [boundedLimit],
    );

    const overviewRow = overviewResult.rows[0] ?? {};
    const trades = Number(overviewRow.trades ?? 0);
    const wins = Number(overviewRow.wins ?? 0);

    return {
      generatedAt: new Date().toISOString(),
      limit: boundedLimit,
      source: "broker_fills",
      overview: {
        trades,
        wins,
        losses: Number(overviewRow.losses ?? 0),
        open: Number(overviewRow.open ?? 0),
        winRate: trades > 0 ? wins / trades : 0,
        totalPnl:
          overviewRow.total_pnl === null || overviewRow.total_pnl === undefined
            ? undefined
            : Number(overviewRow.total_pnl),
        grossPnl:
          overviewRow.gross_pnl === null || overviewRow.gross_pnl === undefined
            ? undefined
            : Number(overviewRow.gross_pnl),
        commissions:
          overviewRow.commissions === null ||
          overviewRow.commissions === undefined
            ? undefined
            : Number(overviewRow.commissions),
        avgPnl:
          overviewRow.avg_pnl === null || overviewRow.avg_pnl === undefined
            ? undefined
            : Number(overviewRow.avg_pnl),
        avgPnlPct:
          overviewRow.avg_pnl_pct === null ||
          overviewRow.avg_pnl_pct === undefined
            ? undefined
            : Number(overviewRow.avg_pnl_pct),
        medianPnlPct:
          overviewRow.median_pnl_pct === null ||
          overviewRow.median_pnl_pct === undefined
            ? undefined
            : Number(overviewRow.median_pnl_pct),
        avgConfidence:
          overviewRow.avg_confidence === null ||
          overviewRow.avg_confidence === undefined
            ? undefined
            : Number(overviewRow.avg_confidence),
        takeProfitHits: Number(overviewRow.take_profit_hits ?? 0),
        stopHits: Number(overviewRow.stop_hits ?? 0),
      },
      bySymbol: aggregateResults[0],
      byStrategy: aggregateResults[1],
      byStrategySymbolSide: aggregateResults[2],
      bySide: aggregateResults[3],
      byDirectionalRegime: aggregateResults[4],
      byVolatilityRegime: aggregateResults[5],
      worstTrades: worstTradesResult.rows.map((row) => ({
        orderId: Number(row.order_id),
        instrument: String(row.instrument),
        strategy: String(row.strategy),
        side: row.side as Side,
        directionalRegime: String(row.directional_regime),
        volatilityRegime: String(row.volatility_regime),
        confidence: Number(row.confidence ?? 0),
        pnl:
          row.pnl === null || row.pnl === undefined
            ? undefined
            : Number(row.pnl),
        grossPnl:
          row.gross_pnl === null || row.gross_pnl === undefined
            ? undefined
            : Number(row.gross_pnl),
        commissions:
          row.commissions === null || row.commissions === undefined
            ? undefined
            : Number(row.commissions),
        pnlPct:
          row.pnl_pct === null || row.pnl_pct === undefined
            ? undefined
            : Number(row.pnl_pct),
        notes: String(row.notes ?? "n/a"),
        executedAt: new Date(row.executed_at).toISOString(),
      })),
    };
  }

  private mapRow(row: ProposedOrderRow): ProposedOrder {
    const createdAt =
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at);
    const indicators = this.normalizeIndicators(row.indicator_snapshot);

    return {
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
      executionAttemptedAt: row.execution_attempted_at
        ? new Date(row.execution_attempted_at)
        : undefined,
      executedAt: row.executed_at ? new Date(row.executed_at) : undefined,
      generatedFromCandleTs: row.generated_from_candle_ts
        ? new Date(row.generated_from_candle_ts)
        : undefined,
      lifecycleReason: row.lifecycle_reason ?? undefined,
      supersededByOrderId: row.superseded_by_order_id ?? undefined,
      createdAt,
    };
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

  private normalizeStatus(
    status: ProposedOrderRow["status"],
  ): ProposedOrderStatus {
    if (status === "EXECUTED") return "SUBMITTED";
    return status;
  }

  private async queryReportAggregate(
    baseCte: string,
    limit: number,
    dimension:
      | "instrument"
      | "strategy"
      | "strategy_symbol_side"
      | "side"
      | "directional_regime"
      | "volatility_regime",
    strategyIds: string[] = [],
  ): Promise<SignalReportAggregate[]> {
    const keySqlByDimension = {
      instrument: "instrument",
      strategy: "strategy",
      strategy_symbol_side: "strategy || ' / ' || instrument || ' / ' || side",
      side: "side",
      directional_regime: "directional_regime",
      volatility_regime: "volatility_regime",
    } satisfies Record<typeof dimension, string>;
    const strategyStatusJoin =
      dimension === "strategy" ? "srs.strategy_id = aggregate.key" : "false";

    if (dimension === "strategy" && strategyIds.length > 0) {
      const aggregateLimit = Math.max(100, strategyIds.length + 12);
      const result = await this.pool.query(
        `
        ${baseCte},
        aggregate AS (
        SELECT
          strategy AS key,
          COUNT(*)::int AS trades,
          COUNT(*) FILTER (WHERE pnl > 0)::int AS wins,
          COUNT(*) FILTER (WHERE pnl < 0)::int AS losses,
          0::int AS open,
          SUM(pnl) AS total_pnl,
          SUM(gross_pnl) AS gross_pnl,
          SUM(commissions) AS commissions,
          AVG(pnl) AS avg_pnl,
          AVG(pnl_pct) AS avg_pnl_pct,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median_pnl_pct,
          AVG(confidence) AS avg_confidence,
          COUNT(*) FILTER (WHERE hit_take_profit)::int AS take_profit_hits,
          COUNT(*) FILTER (WHERE hit_stop)::int AS stop_hits
        FROM base
        GROUP BY 1
        ),
        aggregate_keys AS (
          SELECT unnest($2::text[]) AS key
          UNION
          SELECT key FROM aggregate
        )
        SELECT
          aggregate_keys.key,
          COALESCE(aggregate.trades, 0)::int AS trades,
          COALESCE(aggregate.wins, 0)::int AS wins,
          COALESCE(aggregate.losses, 0)::int AS losses,
          COALESCE(aggregate.open, 0)::int AS open,
          aggregate.total_pnl,
          aggregate.gross_pnl,
          aggregate.commissions,
          aggregate.avg_pnl,
          aggregate.avg_pnl_pct,
          aggregate.median_pnl_pct,
          aggregate.avg_confidence,
          COALESCE(aggregate.take_profit_hits, 0)::int AS take_profit_hits,
          COALESCE(aggregate.stop_hits, 0)::int AS stop_hits,
          srs.enabled AS strategy_enabled,
          srs.permanently_disabled AS strategy_permanently_disabled,
          srs.cooldown_until AS strategy_cooldown_until,
          srs.reason AS strategy_reason
        FROM aggregate_keys
        LEFT JOIN aggregate ON aggregate.key = aggregate_keys.key
        LEFT JOIN strategy_runtime_state srs ON srs.strategy_id = aggregate_keys.key
        ORDER BY trades DESC, aggregate_keys.key ASC
        LIMIT ${aggregateLimit}
        `,
        [limit, strategyIds],
      );

      return this.mapReportAggregateRows(result.rows);
    }

    const aggregateLimit = dimension === "strategy_symbol_side" ? 50 : 12;
    const result = await this.pool.query(
      `
      ${baseCte},
      aggregate AS (
      SELECT
        ${keySqlByDimension[dimension]} AS key,
        COUNT(*)::int AS trades,
        COUNT(*) FILTER (WHERE pnl > 0)::int AS wins,
        COUNT(*) FILTER (WHERE pnl < 0)::int AS losses,
        0::int AS open,
        SUM(pnl) AS total_pnl,
        SUM(gross_pnl) AS gross_pnl,
        SUM(commissions) AS commissions,
        AVG(pnl) AS avg_pnl,
        AVG(pnl_pct) AS avg_pnl_pct,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_pct) AS median_pnl_pct,
        AVG(confidence) AS avg_confidence,
        COUNT(*) FILTER (WHERE hit_take_profit)::int AS take_profit_hits,
        COUNT(*) FILTER (WHERE hit_stop)::int AS stop_hits
      FROM base
      GROUP BY 1
      )
      SELECT
        aggregate.*,
        srs.enabled AS strategy_enabled,
        srs.permanently_disabled AS strategy_permanently_disabled,
        srs.cooldown_until AS strategy_cooldown_until,
        srs.reason AS strategy_reason
      FROM aggregate
      LEFT JOIN strategy_runtime_state srs ON ${strategyStatusJoin}
      ORDER BY trades DESC, key ASC
      LIMIT ${aggregateLimit}
      `,
      [limit],
    );

    return this.mapReportAggregateRows(result.rows);
  }

  private mapReportAggregateRows(rows: any[]): SignalReportAggregate[] {
    return rows.map((row) => {
      const trades = Number(row.trades ?? 0);
      const wins = Number(row.wins ?? 0);

      return {
        key: String(row.key),
        trades,
        wins,
        losses: Number(row.losses ?? 0),
        open: Number(row.open ?? 0),
        winRate: trades > 0 ? wins / trades : 0,
        strategyEnabled:
          row.strategy_enabled === null || row.strategy_enabled === undefined
            ? undefined
            : row.strategy_enabled !== false,
        strategyPermanentlyDisabled:
          row.strategy_permanently_disabled === null ||
          row.strategy_permanently_disabled === undefined
            ? undefined
            : row.strategy_permanently_disabled === true,
        strategyCooldownUntil:
          row.strategy_cooldown_until === null ||
          row.strategy_cooldown_until === undefined
            ? undefined
            : new Date(row.strategy_cooldown_until).toISOString(),
        strategyReason: row.strategy_reason ?? undefined,
        totalPnl:
          row.total_pnl === null || row.total_pnl === undefined
            ? undefined
            : Number(row.total_pnl),
        grossPnl:
          row.gross_pnl === null || row.gross_pnl === undefined
            ? undefined
            : Number(row.gross_pnl),
        commissions:
          row.commissions === null || row.commissions === undefined
            ? undefined
            : Number(row.commissions),
        avgPnl:
          row.avg_pnl === null || row.avg_pnl === undefined
            ? undefined
            : Number(row.avg_pnl),
        avgPnlPct:
          row.avg_pnl_pct === null || row.avg_pnl_pct === undefined
            ? undefined
            : Number(row.avg_pnl_pct),
        medianPnlPct:
          row.median_pnl_pct === null || row.median_pnl_pct === undefined
            ? undefined
            : Number(row.median_pnl_pct),
        avgConfidence:
          row.avg_confidence === null || row.avg_confidence === undefined
            ? undefined
            : Number(row.avg_confidence),
        takeProfitHits: Number(row.take_profit_hits ?? 0),
        stopHits: Number(row.stop_hits ?? 0),
      };
    });
  }

  private async tryLoadExposureFromExecution(
    executionBaseUrl: string,
  ): Promise<ExposureSnapshot | null> {
    try {
      const base = executionBaseUrl.endsWith("/")
        ? executionBaseUrl.slice(0, -1)
        : executionBaseUrl;
      const url = `${base}/execution/account/summary`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      try {
        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
        });
        if (!response.ok) return null;

        const payload = (await response.json()) as {
          metrics?: {
            netLiquidation?: number | string;
            equityWithLoanValue?: number | string;
          };
          totals?: {
            grossExposure?: number | string;
            longExposure?: number | string;
            shortExposure?: number | string;
            positionsCount?: number | string;
          };
          positions?: Array<{
            symbol?: string;
            position?: number | string;
            averageCost?: number | string;
            marketPrice?: number | string;
            marketValue?: number | string;
            unrealizedPnL?: number | string;
          }>;
          fxToBaseByCurrency?: Record<string, number | string | undefined>;
        };

        const exposure = Number(payload?.totals?.grossExposure);
        const longExposure = Number(payload?.totals?.longExposure);
        const shortExposure = Number(payload?.totals?.shortExposure);
        const openPositions = Number(payload?.totals?.positionsCount);
        const accountEquityRaw =
          payload?.metrics?.netLiquidation ??
          payload?.metrics?.equityWithLoanValue;
        const accountEquity = Number(accountEquityRaw);

        if (!Number.isFinite(exposure) || !Number.isFinite(openPositions))
          return null;
        const positionsBySymbol: Record<string, number> = {};
        const positionContextsBySymbol: Record<
          string,
          {
            quantity: number;
            averageCost?: number;
            marketPrice?: number;
            marketValue?: number;
            unrealizedPnL?: number;
          }
        > = {};
        for (const position of payload.positions ?? []) {
          if (!position?.symbol) continue;
          const qty = Number(position.position);
          if (!Number.isFinite(qty)) continue;
          const key = position.symbol.toUpperCase();
          positionsBySymbol[key] = qty;
          positionContextsBySymbol[key] = {
            quantity: qty,
            averageCost: Number.isFinite(Number(position.averageCost))
              ? Number(position.averageCost)
              : undefined,
            marketPrice: Number.isFinite(Number(position.marketPrice))
              ? Number(position.marketPrice)
              : undefined,
            marketValue: Number.isFinite(Number(position.marketValue))
              ? Number(position.marketValue)
              : undefined,
            unrealizedPnL: Number.isFinite(Number(position.unrealizedPnL))
              ? Number(position.unrealizedPnL)
              : undefined,
          };
        }

        return {
          exposure,
          openPositions,
          source: "execution",
          positionsBySymbol,
          accountEquity:
            Number.isFinite(accountEquity) && accountEquity > 0
              ? accountEquity
              : undefined,
          fxToBaseByCurrency: Object.fromEntries(
            Object.entries(payload.fxToBaseByCurrency ?? {})
              .map(([currency, rate]) => [currency.toUpperCase(), Number(rate)])
              .filter(([, rate]) => Number.isFinite(rate) && Number(rate) > 0),
          ),
          longExposure: Number.isFinite(longExposure)
            ? longExposure
            : undefined,
          shortExposure: Number.isFinite(shortExposure)
            ? shortExposure
            : undefined,
          positionContextsBySymbol,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  private async getDbNetPositions(): Promise<
    Array<{ instrument: string; netQty: number; referencePrice: number }>
  > {
    const result = await this.pool.query(
      `
      WITH fills AS (
        SELECT
          UPPER(instrument) AS instrument,
          SUM(
            CASE
              WHEN side = 'BUY' THEN quantity
              WHEN side = 'SELL' THEN -quantity
              ELSE 0
            END
          ) AS net_qty,
          MAX(COALESCE(entry, 0)) AS last_entry,
          AVG(COALESCE(entry, 0)) AS avg_entry
        FROM proposed_orders
        WHERE status IN ('FILLED', 'EXECUTED')
        GROUP BY UPPER(instrument)
      )
      SELECT
        instrument,
        net_qty,
        COALESCE(NULLIF(last_entry, 0), avg_entry, 0) AS reference_price
      FROM fills
      WHERE ABS(net_qty) > 1e-12
      `,
    );

    return result.rows.map((row) => ({
      instrument: String(row.instrument),
      netQty: Number(row.net_qty),
      referencePrice: Number(row.reference_price),
    }));
  }

  private tableForTimeframe(timeframe: Candle["timeframe"]): string {
    if (timeframe === "1m") return "candles_1m";
    if (timeframe === "5m") return "candles_5m";
    if (timeframe === "1h") return "candles_1h";
    if (timeframe === "4h") return "candles_4h";
    if (timeframe === "12h") return "candles_12h";
    if (timeframe === "1d") return "candles_1d";
    return "candles_1w";
  }
}
