import { Pool, type PoolClient } from "pg";
import type { Candle, InstrumentContract } from "@ikbr/shared";
import { listStrategyProfiles } from "@ikbr/shared";
import type {
  BacktestCandleSymbolSummary,
  BacktestDataset,
  BacktestFillRecord,
  BacktestFxRate,
  BacktestFuturesContractMetadata,
  BacktestOrderRecord,
  BacktestRun,
  BacktestSignalDiagnosticRecord,
  LoadedBacktestData,
} from "./types.js";
import type { ResearchScenarioMetrics } from "./research-run-request.js";
import {
  databaseNameFromUrl,
  RESEARCH_DATABASE_NAME,
} from "./research-dataset-schema.js";

function mapDataset(row: any): BacktestDataset {
  return {
    id: Number(row.id),
    dateFrom: new Date(row.date_from).toISOString(),
    dateTo: new Date(row.date_to).toISOString(),
    status: String(row.status),
    symbols: Array.isArray(row.symbols) ? row.symbols.map(String) : [],
    candlesCount: Number(row.candles_count ?? 0),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at
      ? new Date(row.finished_at).toISOString()
      : undefined,
    error: row.error ?? undefined,
  };
}

function mapRun(row: any): BacktestRun {
  return {
    id: Number(row.id),
    datasetId: Number(row.dataset_id),
    mode: row.mode === "isolated" ? "isolated" : "bot",
    status: String(row.status),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at
      ? new Date(row.finished_at).toISOString()
      : undefined,
    error: row.error ?? undefined,
    totalPnl:
      row.total_pnl === null || row.total_pnl === undefined
        ? undefined
        : Number(row.total_pnl),
    trades:
      row.trades === null || row.trades === undefined
        ? undefined
        : Number(row.trades),
    winRate:
      row.win_rate === null || row.win_rate === undefined
        ? undefined
        : Number(row.win_rate),
    progressCurrent:
      row.progress_current === null || row.progress_current === undefined
        ? undefined
        : Number(row.progress_current),
    progressTotal:
      row.progress_total === null || row.progress_total === undefined
        ? undefined
        : Number(row.progress_total),
    progressLabel: row.progress_label ?? undefined,
    progressUpdatedAt: row.progress_updated_at
      ? new Date(row.progress_updated_at).toISOString()
      : undefined,
  };
}

function mapFxRate(row: any): BacktestFxRate {
  return {
    date: new Date(row.rate_date).toISOString().slice(0, 10),
    baseCurrency: String(row.base_currency).toUpperCase(),
    quoteCurrency: String(row.quote_currency).toUpperCase(),
    rateToBase: Number(row.rate_to_base),
    source: String(row.source),
  };
}

function mapCandle(row: any, timeframe: Candle["timeframe"]): Candle {
  return {
    conid: String(row.conid),
    symbol: String(row.symbol),
    timeframe,
    ts: new Date(row.ts),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

function pctMedian(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function ensureBacktestDatabase(
  adminUrl: string,
  targetUrl: string,
): Promise<void> {
  const target = new URL(targetUrl);
  const dbName = target.pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9_]+$/.test(dbName))
    throw new Error(`Unsafe backtest database name: ${dbName}`);

  const pool = new Pool({ connectionString: adminUrl });
  try {
    const existing = await pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    if (existing.rowCount === 0) {
      await pool.query(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await pool.end();
  }
}

export async function backtestDatabaseExists(
  adminUrl: string,
  targetUrl: string,
): Promise<boolean> {
  const target = new URL(targetUrl);
  const dbName = target.pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9_]+$/.test(dbName))
    throw new Error(`Unsafe backtest database name: ${dbName}`);
  const pool = new Pool({ connectionString: adminUrl });
  try {
    const result = await pool.query("SELECT 1 FROM pg_database WHERE datname=$1", [dbName]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    await pool.end();
  }
}

export class BacktestRepository {
  private readonly pool: Pool;
  private readonly protectedResearchDatabase: boolean;
  private researchClaimClient: PoolClient | null = null;
  private researchClaimLockKey: string | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, options: "-c search_path=public" });
    this.protectedResearchDatabase =
      databaseNameFromUrl(connectionString) === RESEARCH_DATABASE_NAME;
  }

  private assertLegacyDatasetWriteAllowed(): void {
    if (this.protectedResearchDatabase)
      throw new Error("Legacy dataset writes are forbidden on the PR15.5C research database");
  }

  async close(): Promise<void> {
    if (this.researchClaimClient && this.researchClaimLockKey) {
      await this.researchClaimClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
        this.researchClaimLockKey,
      ]);
      this.researchClaimClient.release();
      this.researchClaimClient = null;
      this.researchClaimLockKey = null;
    }
    await this.pool.end();
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_datasets (
        id BIGSERIAL PRIMARY KEY,
        date_from TIMESTAMPTZ NOT NULL,
        date_to TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL,
        symbols TEXT[] NOT NULL DEFAULT '{}',
        candles_count BIGINT NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        error TEXT
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_candles_1m (
        symbol TEXT NOT NULL,
        conid TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (symbol, ts)
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_candles_5m (LIKE backtest_candles_1m INCLUDING ALL);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_candles_1h (LIKE backtest_candles_1m INCLUDING ALL);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_candles_4h (LIKE backtest_candles_1m INCLUDING ALL);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_candles_12h (LIKE backtest_candles_1m INCLUDING ALL);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_candles_1d (LIKE backtest_candles_1m INCLUDING ALL);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_candles_1w (LIKE backtest_candles_1m INCLUDING ALL);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_fx_rates (
        rate_date DATE NOT NULL,
        base_currency TEXT NOT NULL,
        quote_currency TEXT NOT NULL,
        rate_to_base DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (rate_date, base_currency, quote_currency)
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_instrument_contracts (
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
      CREATE UNIQUE INDEX IF NOT EXISTS backtest_instrument_contracts_conid_idx
      ON backtest_instrument_contracts (conid);
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_futures_contracts (
        conid TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        local_symbol TEXT NOT NULL,
        trading_class TEXT NOT NULL,
        last_trade_at TIMESTAMPTZ NOT NULL,
        UNIQUE (symbol, local_symbol)
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_runs (
        id BIGSERIAL PRIMARY KEY,
        dataset_id BIGINT NOT NULL REFERENCES backtest_datasets(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'bot',
        status TEXT NOT NULL,
        config_json JSONB NOT NULL DEFAULT '{}',
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        error TEXT,
        total_pnl DOUBLE PRECISION,
        trades INTEGER,
        win_rate DOUBLE PRECISION
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_research_experiments (
        experiment_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_json JSONB NOT NULL,
        canonical_result JSONB,
        result_sha256 TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_orders (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
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
        partial_take_profits JSONB,
        trailing_stop_pct DOUBLE PRECISION,
        trailing_stop_activation_r DOUBLE PRECISION,
        generated_from_candle_ts TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);
    await this.pool.query(
      `ALTER TABLE backtest_orders ADD COLUMN IF NOT EXISTS partial_take_profits JSONB;`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_orders ADD COLUMN IF NOT EXISTS trailing_stop_pct DOUBLE PRECISION;`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_orders ADD COLUMN IF NOT EXISTS trailing_stop_activation_r DOUBLE PRECISION;`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_fills (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES backtest_orders(id) ON DELETE CASCADE,
        instrument TEXT NOT NULL,
        conid TEXT,
        strategy TEXT NOT NULL,
        side TEXT NOT NULL,
        directional_regime TEXT NOT NULL DEFAULT 'unknown',
        volatility_regime TEXT NOT NULL DEFAULT 'unknown',
        confidence DOUBLE PRECISION NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        exit_price DOUBLE PRECISION NOT NULL,
        entry_at TIMESTAMPTZ NOT NULL,
        exit_at TIMESTAMPTZ NOT NULL,
        gross_pnl DOUBLE PRECISION NOT NULL,
        commission DOUBLE PRECISION NOT NULL,
        net_pnl DOUBLE PRECISION NOT NULL,
        pnl_pct DOUBLE PRECISION NOT NULL,
        exit_reason TEXT NOT NULL
      );
    `);
    for (const statement of [
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS entry_reference_price DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS entry_fill_price DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS exit_reference_price DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS exit_fill_price DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS multiplier DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS tick_size DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS entry_slippage DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS exit_slippage DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS slippage_cost DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS commission_per_contract_side DOUBLE PRECISION;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS entry_conid TEXT;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS exit_conid TEXT;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS execution_model_version TEXT;`,
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS calendar_version TEXT;`,
    ]) await this.pool.query(statement);
    await this.pool.query(
      `ALTER TABLE backtest_fills DROP COLUMN IF EXISTS regime;`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS directional_regime TEXT NOT NULL DEFAULT 'unknown';`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_fills ADD COLUMN IF NOT EXISTS volatility_regime TEXT NOT NULL DEFAULT 'unknown';`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_strategy_state (
        run_id BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
        strategy_id TEXT NOT NULL,
        enabled BOOLEAN NOT NULL,
        permanently_disabled BOOLEAN NOT NULL,
        cooldown_until TIMESTAMPTZ,
        reason TEXT,
        PRIMARY KEY (run_id, strategy_id)
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_signal_diagnostics (
        run_id BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
        strategy TEXT NOT NULL,
        instrument TEXT NOT NULL,
        side TEXT NOT NULL,
        stage TEXT NOT NULL,
        reason_group TEXT NOT NULL,
        samples BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, strategy, instrument, side, stage, reason_group)
      );
    `);
    await this.pool.query(
      `ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'bot';`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_current BIGINT NOT NULL DEFAULT 0;`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_total BIGINT;`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_label TEXT;`,
    );
    await this.pool.query(
      `ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ;`,
    );
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS backtest_orders_run_idx ON backtest_orders(run_id, created_at DESC);",
    );
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS backtest_fills_run_idx ON backtest_fills(run_id, exit_at DESC);",
    );
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS backtest_signal_diagnostics_run_idx ON backtest_signal_diagnostics(run_id, samples DESC);",
    );
  }

  async resetHistoricalData(
    dateFrom: Date,
    dateTo: Date,
    symbols: string[],
  ): Promise<BacktestDataset> {
    this.assertLegacyDatasetWriteAllowed();
    await this.pool.query(`
      TRUNCATE backtest_signal_diagnostics, backtest_fills, backtest_orders, backtest_strategy_state, backtest_runs,
               backtest_candles_1m, backtest_candles_5m, backtest_candles_1h,
               backtest_candles_4h, backtest_candles_12h, backtest_candles_1d, backtest_candles_1w, backtest_fx_rates,
               backtest_datasets
      RESTART IDENTITY CASCADE;
    `);
    const result = await this.pool.query(
      `INSERT INTO backtest_datasets (date_from, date_to, status, symbols)
       VALUES ($1, $2, 'fetching', $3)
       RETURNING *`,
      [dateFrom, dateTo, symbols],
    );
    return mapDataset(result.rows[0]);
  }

  async finishDataset(
    datasetId: number,
    status: "ready" | "failed",
    error?: string,
  ): Promise<BacktestDataset> {
    this.assertLegacyDatasetWriteAllowed();
    const countResult = await this.pool.query(
      "SELECT COUNT(*) AS count FROM backtest_candles_1m",
    );
    const result = await this.pool.query(
      `UPDATE backtest_datasets
       SET status=$2, finished_at=NOW(), error=$3, candles_count=$4
       WHERE id=$1
       RETURNING *`,
      [
        datasetId,
        status,
        error ?? null,
        Number(countResult.rows[0]?.count ?? 0),
      ],
    );
    return mapDataset(result.rows[0]);
  }

  async resumeDataset(datasetId: number): Promise<BacktestDataset> {
    this.assertLegacyDatasetWriteAllowed();
    const countResult = await this.pool.query(
      "SELECT COUNT(*) AS count FROM backtest_candles_1m",
    );
    const result = await this.pool.query(
      `UPDATE backtest_datasets
       SET status='fetching', finished_at=NULL, error=NULL, candles_count=$2
       WHERE id=$1
       RETURNING *`,
      [datasetId, Number(countResult.rows[0]?.count ?? 0)],
    );
    return mapDataset(result.rows[0]);
  }

  async listCandleSymbolSummaries(): Promise<BacktestCandleSymbolSummary[]> {
    const result = await this.pool.query(
      `SELECT symbol, COUNT(*) AS candles, MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM backtest_candles_1m
       GROUP BY symbol
       ORDER BY symbol ASC`,
    );
    return result.rows.map((row) => ({
      symbol: String(row.symbol),
      candles: Number(row.candles ?? 0),
      firstTs: row.first_ts ? new Date(row.first_ts).toISOString() : undefined,
      lastTs: row.last_ts ? new Date(row.last_ts).toISOString() : undefined,
    }));
  }

  async upsertInstrumentContract(contract: InstrumentContract): Promise<void> {
    this.assertLegacyDatasetWriteAllowed();
    await this.pool.query(
      `
      INSERT INTO backtest_instrument_contracts (
        symbol, conid, sec_type, exchange, primary_exchange, currency,
        local_symbol, trading_class, min_tick, display_name,
        contract_json, details_json, source, resolved_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (symbol)
      DO UPDATE SET
        conid = EXCLUDED.conid,
        sec_type = EXCLUDED.sec_type,
        exchange = EXCLUDED.exchange,
        primary_exchange = EXCLUDED.primary_exchange,
        currency = EXCLUDED.currency,
        local_symbol = EXCLUDED.local_symbol,
        trading_class = EXCLUDED.trading_class,
        min_tick = EXCLUDED.min_tick,
        display_name = EXCLUDED.display_name,
        contract_json = EXCLUDED.contract_json,
        details_json = EXCLUDED.details_json,
        source = EXCLUDED.source,
        resolved_at = NOW();
      `,
      [
        contract.symbol.toUpperCase(),
        contract.conid,
        contract.secType,
        contract.exchange ?? null,
        contract.primaryExchange ?? null,
        contract.currency ?? null,
        contract.localSymbol ?? null,
        contract.tradingClass ?? null,
        contract.minTick ?? null,
        contract.displayName ?? null,
        contract.contractJson ?? null,
        contract.detailsJson ?? null,
        contract.source,
      ],
    );
  }

  async getSecTypeBySymbol(): Promise<Record<string, string>> {
    const result = await this.pool.query(`
      SELECT symbol, sec_type
      FROM backtest_instrument_contracts
    `);
    const out: Record<string, string> = {};
    for (const row of result.rows) {
      out[String(row.symbol).toUpperCase()] = String(
        row.sec_type,
      ).toUpperCase();
    }
    return out;
  }

  async getFuturesContractMetadata(): Promise<Map<string, BacktestFuturesContractMetadata>> {
    const result = await this.pool.query(`
      SELECT symbol, conid, local_symbol, trading_class, last_trade_at
      FROM backtest_futures_contracts
    `);
    const out = new Map<string, BacktestFuturesContractMetadata>();
    for (const row of result.rows) {
      if (!row.last_trade_at) continue;
      out.set(String(row.conid), {
        conid: String(row.conid), symbol: String(row.symbol).toUpperCase(),
        localSymbol: String(row.local_symbol ?? ""),
        tradingClass: String(row.trading_class ?? "").toUpperCase(),
        lastTradeAt: new Date(row.last_trade_at),
      });
    }
    return out;
  }

  async upsertFuturesContractMetadata(metadata: BacktestFuturesContractMetadata): Promise<void> {
    this.assertLegacyDatasetWriteAllowed();
    await this.pool.query(
      `INSERT INTO backtest_futures_contracts (conid, symbol, local_symbol, trading_class, last_trade_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (conid) DO UPDATE SET symbol=EXCLUDED.symbol,
         local_symbol=EXCLUDED.local_symbol, trading_class=EXCLUDED.trading_class,
         last_trade_at=EXCLUDED.last_trade_at`,
      [metadata.conid, metadata.symbol.toUpperCase(), metadata.localSymbol,
        metadata.tradingClass.toUpperCase(), metadata.lastTradeAt],
    );
  }

  async insertCandles1m(candles: Candle[]): Promise<void> {
    this.assertLegacyDatasetWriteAllowed();
    const chunkSize = 1000;
    for (let offset = 0; offset < candles.length; offset += chunkSize) {
      const chunk = candles.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const placeholders = chunk.map((candle, index) => {
        const base = index * 8;
        values.push(
          candle.symbol,
          candle.conid,
          candle.ts,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      });

      await this.pool.query(
        `INSERT INTO backtest_candles_1m (symbol, conid, ts, open, high, low, close, volume)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (symbol, ts) DO UPDATE SET
           conid=EXCLUDED.conid,
           open=EXCLUDED.open,
           high=EXCLUDED.high,
           low=EXCLUDED.low,
           close=EXCLUDED.close,
           volume=EXCLUDED.volume`,
        values,
      );
    }
  }

  async insertFxRates(rates: BacktestFxRate[]): Promise<void> {
    this.assertLegacyDatasetWriteAllowed();
    if (rates.length === 0) return;

    const uniqueRates = Array.from(
      rates
        .reduce((map, rate) => {
          const key = `${rate.date}|${rate.baseCurrency.toUpperCase()}|${rate.quoteCurrency.toUpperCase()}`;
          map.set(key, {
            ...rate,
            baseCurrency: rate.baseCurrency.toUpperCase(),
            quoteCurrency: rate.quoteCurrency.toUpperCase(),
          });
          return map;
        }, new Map<string, BacktestFxRate>())
        .values(),
    );

    const chunkSize = 1000;
    for (let offset = 0; offset < uniqueRates.length; offset += chunkSize) {
      const chunk = uniqueRates.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const placeholders = chunk.map((rate, index) => {
        const base = index * 5;
        values.push(
          rate.date,
          rate.baseCurrency,
          rate.quoteCurrency,
          rate.rateToBase,
          rate.source,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      });

      await this.pool.query(
        `INSERT INTO backtest_fx_rates (rate_date, base_currency, quote_currency, rate_to_base, source)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (rate_date, base_currency, quote_currency) DO UPDATE SET
           rate_to_base=EXCLUDED.rate_to_base,
           source=EXCLUDED.source`,
        values,
      );
    }
  }

  async countFxRates(
    baseCurrency: string,
    quoteCurrencies: string[],
    dateFrom: Date,
    dateTo: Date,
  ): Promise<number> {
    if (quoteCurrencies.length === 0) return 0;
    const result = await this.pool.query(
      `
      SELECT COUNT(*) AS count
      FROM backtest_fx_rates
      WHERE base_currency=$1
        AND quote_currency = ANY($2::text[])
        AND rate_date BETWEEN $3::date AND $4::date
      `,
      [
        baseCurrency.toUpperCase(),
        quoteCurrencies.map((value) => value.toUpperCase()),
        dateFrom,
        dateTo,
      ],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async rebuildAggregates(): Promise<void> {
    this.assertLegacyDatasetWriteAllowed();
    await this.pool.query(
      "TRUNCATE backtest_candles_5m, backtest_candles_1h, backtest_candles_4h, backtest_candles_12h, backtest_candles_1d, backtest_candles_1w;",
    );
    await this.aggregateCandles("backtest_candles_5m", 300);
    await this.aggregateCandles("backtest_candles_1h", 3600);
    await this.aggregateCandles("backtest_candles_4h", 4 * 3600);
    await this.aggregateCandles("backtest_candles_12h", 12 * 3600);
    await this.aggregateCandles("backtest_candles_1d", 24 * 3600);
    await this.aggregateCandles("backtest_candles_1w", 7 * 24 * 3600);
  }

  async latestDataset(): Promise<BacktestDataset | null> {
    const result = await this.pool.query(
      "SELECT * FROM backtest_datasets ORDER BY id DESC LIMIT 1",
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : null;
  }

  /**
   * Merges new symbols into the symbols TEXT[] of an existing dataset
   * (idempotent, case-insensitive via uppercase). Used by the per-symbol
   * top-up endpoint so that subsequent runs see the freshly added
   * tickers as part of the dataset.
   */
  async appendDatasetSymbols(
    datasetId: number,
    symbols: string[],
  ): Promise<BacktestDataset | null> {
    this.assertLegacyDatasetWriteAllowed();
    const normalized = Array.from(
      new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)),
    );
    if (normalized.length === 0) return null;
    const result = await this.pool.query(
      `UPDATE backtest_datasets
       SET symbols = (
         SELECT ARRAY(
           SELECT DISTINCT upper(s)
           FROM unnest(COALESCE(symbols, ARRAY[]::text[]) || $2::text[]) AS s
           WHERE s IS NOT NULL AND s <> ''
           ORDER BY 1
         )
       )
       WHERE id = $1
       RETURNING *`,
      [datasetId, normalized],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : null;
  }

  /**
   * Refresh the cached candles_count on a dataset. Used after a partial
   * top-up so /backtest/dataset reflects the new total without forcing
   * a full status transition.
   */
  async refreshDatasetCandlesCount(
    datasetId: number,
  ): Promise<BacktestDataset | null> {
    this.assertLegacyDatasetWriteAllowed();
    const countResult = await this.pool.query(
      "SELECT COUNT(*) AS count FROM backtest_candles_1m",
    );
    const result = await this.pool.query(
      `UPDATE backtest_datasets SET candles_count = $2 WHERE id = $1 RETURNING *`,
      [datasetId, Number(countResult.rows[0]?.count ?? 0)],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : null;
  }

  async listRuns(): Promise<BacktestRun[]> {
    const result = await this.pool.query(
      "SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 50",
    );
    return result.rows.map(mapRun);
  }

  async failRunningRuns(error: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE backtest_runs
       SET status='failed', finished_at=NOW(), error=$1
       WHERE status='running'
       RETURNING id`,
      [error],
    );
    return result.rowCount ?? 0;
  }

  async updateRunProgress(
    runId: number,
    progress: { current: number; total?: number; label?: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_runs
       SET progress_current=$2,
           progress_total=$3,
           progress_label=$4,
           progress_updated_at=NOW()
       WHERE id=$1 AND status='running'`,
      [
        runId,
        Math.max(0, Math.floor(progress.current)),
        progress.total === undefined
          ? null
          : Math.max(0, Math.floor(progress.total)),
        progress.label ?? null,
      ],
    );
  }

  async loadBacktestData(symbols?: string[]): Promise<LoadedBacktestData> {
    const dataset = await this.latestDataset();
    if (!dataset || dataset.status !== "ready")
      throw new Error("No ready historical dataset. Fetch history first.");
    const normalizedSymbols = Array.from(
      new Set(
        (symbols ?? [])
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    let targetSymbols: string[];
    if (normalizedSymbols.length > 0) {
      targetSymbols = normalizedSymbols;
    } else {
      const distinct = await this.pool.query<{ symbol: string }>(
        "SELECT DISTINCT symbol FROM backtest_candles_1m ORDER BY symbol ASC",
      );
      targetSymbols = distinct.rows.map((r) => r.symbol);
    }
    const timeframes: Array<{
      tf: "1m" | "5m" | "1h" | "4h" | "12h" | "1d" | "1w";
      table: string;
    }> = [
      { tf: "1m", table: "backtest_candles_1m" },
      { tf: "5m", table: "backtest_candles_5m" },
      { tf: "1h", table: "backtest_candles_1h" },
      { tf: "4h", table: "backtest_candles_4h" },
      { tf: "12h", table: "backtest_candles_12h" },
      { tf: "1d", table: "backtest_candles_1d" },
      { tf: "1w", table: "backtest_candles_1w" },
    ];
    const maps: Record<string, Map<string, Candle[]>> = {};
    for (const { tf } of timeframes) maps[tf] = new Map();
    let candleCount1m = 0;
    for (const symbol of targetSymbols) {
      for (const { tf, table } of timeframes) {
        const result = await this.pool.query(
          `SELECT * FROM ${table} WHERE symbol = $1 ORDER BY ts ASC`,
          [symbol],
        );
        const rows = result.rows;
        if (rows.length === 0) continue;
        const mapped: Candle[] = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
          mapped[i] = mapCandle(rows[i], tf);
        }
        maps[tf].set(symbol, mapped);
        if (tf === "1m") candleCount1m += mapped.length;
      }
    }
    const fxRates = await this.pool.query(
      "SELECT * FROM backtest_fx_rates ORDER BY rate_date ASC, quote_currency ASC",
    );
    return {
      dataset,
      candles1m: maps["1m"],
      candles5m: maps["5m"],
      candles1h: maps["1h"],
      candles4h: maps["4h"],
      candles12h: maps["12h"],
      candles1d: maps["1d"],
      candles1w: maps["1w"],
      candleCount1m,
      fxRates: fxRates.rows.map(mapFxRate),
    };
  }

  async createRun(
    datasetId: number,
    configJson: Record<string, unknown>,
    mode: "bot" | "isolated" = "bot",
  ): Promise<BacktestRun> {
    const result = await this.pool.query(
      `INSERT INTO backtest_runs (dataset_id, mode, status, config_json)
       VALUES ($1, $2, 'running', $3)
       RETURNING *`,
      [datasetId, mode, configJson],
    );
    return mapRun(result.rows[0]);
  }

  async createResearchScenarioRun(
    datasetId: number,
    configJson: Record<string, unknown> & {
      experimentId: string;
      scenario: "primary" | "stress" | "primary_reproduction";
    },
  ): Promise<BacktestRun> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [configJson.experimentId]);
      const existing = await client.query(
        `SELECT id FROM backtest_runs
         WHERE config_json->>'experimentId'=$1 AND config_json->>'scenario'=$2`,
        [configJson.experimentId, configJson.scenario],
      );
      if ((existing.rowCount ?? 0) > 0)
        throw new Error(`Research scenario already exists: ${configJson.scenario}`);
      const result = await client.query(
        `INSERT INTO backtest_runs (dataset_id,mode,status,config_json)
         VALUES ($1,'isolated','running',$2) RETURNING *`,
        [datasetId, configJson],
      );
      await client.query("COMMIT");
      return mapRun(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async getResearchScenarioMetrics(
    runId: number,
    scenario: "primary" | "stress",
    datasetFingerprintBefore: string,
    datasetFingerprintAfter: string,
  ): Promise<ResearchScenarioMetrics> {
    const [fillsResult, pendingResult, stateResult, diagnosticsResult] = await Promise.all([
      this.pool.query(`SELECT quantity,entry_price,exit_price,gross_pnl,commission,net_pnl,
        slippage_cost,fills.multiplier,tick_size,entry_conid,exit_conid,execution_model_version,
        calendar_version,entry_at,exit_at,exit_reason,directional_regime,volatility_regime,
        entry_contract.valid_from AS entry_valid_from,entry_contract.valid_to AS entry_valid_to,
        exit_contract.valid_from AS exit_valid_from,exit_contract.valid_to AS exit_valid_to
        FROM backtest_fills fills
        LEFT JOIN backtest_futures_contracts entry_contract ON entry_contract.conid=fills.entry_conid
        LEFT JOIN backtest_futures_contracts exit_contract ON exit_contract.conid=fills.exit_conid
        WHERE run_id=$1 ORDER BY exit_at,fills.id`, [runId]),
      this.pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='PROPOSED') AS pending,
        COUNT(*) FILTER (WHERE status='FILLED' AND NOT EXISTS
          (SELECT 1 FROM backtest_fills f WHERE f.order_id=backtest_orders.id)) AS unclosed
        FROM backtest_orders WHERE run_id=$1`, [runId]),
      this.pool.query(`SELECT permanently_disabled FROM backtest_strategy_state
        WHERE run_id=$1 AND strategy_id='momentum_breakout_long_v1'`, [runId]),
      this.pool.query(`SELECT stage,reason_group,SUM(samples) AS samples
        FROM backtest_signal_diagnostics WHERE run_id=$1 AND stage IN ('rejected','rejected_detail')
        GROUP BY stage,reason_group ORDER BY stage,reason_group`, [runId]),
    ]);
    const rows = fillsResult.rows;
    const net = rows.map((row) => Number(row.net_pnl));
    const wins = net.filter((value) => value > 0);
    const losses = net.filter((value) => value <= 0);
    const grossWins = wins.reduce((sum, value) => sum + value, 0);
    const grossLosses = Math.abs(losses.reduce((sum, value) => sum + value, 0));
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const value of net) {
      cumulative += value;
      peak = Math.max(peak, cumulative);
      maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
    }
    const invariantViolations: string[] = [];
    if (stateResult.rowCount !== 1)
      invariantViolations.push("missing_or_duplicate_strategy_state");
    for (const row of rows) {
      const quantity = Number(row.quantity);
      const tick = Number(row.tick_size);
      const onGrid = (value: unknown) => Math.abs(Number(value) / 0.25 - Math.round(Number(value) / 0.25)) < 1e-8;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) invariantViolations.push("non_whole_contract_quantity");
      if (Number(row.multiplier) !== 50 || tick !== 0.25) invariantViolations.push("invalid_es_economics");
      if (!onGrid(row.entry_price) || !onGrid(row.exit_price)) invariantViolations.push("off_tick_fill");
      if (!row.entry_conid || !row.exit_conid) invariantViolations.push("missing_contract_identity");
      const within = (value: unknown, from: unknown, to: unknown) =>
        Boolean(from && to) && new Date(String(value)).getTime() >= new Date(String(from)).getTime() &&
        new Date(String(value)).getTime() <= new Date(String(to)).getTime();
      if (!within(row.entry_at, row.entry_valid_from, row.entry_valid_to) ||
        !within(row.exit_at, row.exit_valid_from, row.exit_valid_to))
        invariantViolations.push("fill_outside_contract_validity");
      if (row.execution_model_version !== "pr15.5b-v1") invariantViolations.push("execution_model_mismatch");
      if (row.calendar_version !== "cme-equity-index-2024-2026-v1") invariantViolations.push("calendar_mismatch");
    }
    const sorted = [...net].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length === 0 ? 0 : sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
    const pending = Number(pendingResult.rows[0]?.pending ?? 0);
    const unclosed = Number(pendingResult.rows[0]?.unclosed ?? 0);
    const countBy = (key: string, transform: (value: unknown, row: any) => string = String) => {
      const counts: Record<string, number> = {};
      for (const row of rows) {
        const value = transform(row[key], row);
        counts[value] = (counts[value] ?? 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
    };
    const signalRejections = Object.fromEntries(diagnosticsResult.rows.map((row) =>
      [`${String(row.stage)}:${String(row.reason_group)}`, Number(row.samples)]));
    const countsByExitReason = countBy("exit_reason");
    return {
      scenario,
      closedTrades: rows.length,
      wins: wins.length,
      losses: losses.length,
      winRate: net.length ? wins.length / net.length : 0,
      grossPnl: rows.reduce((sum, row) => sum + Number(row.gross_pnl), 0),
      grossWins,
      grossLosses,
      commissions: rows.reduce((sum, row) => sum + Number(row.commission), 0),
      slippageCost: rows.reduce((sum, row) => sum + Number(row.slippage_cost ?? 0), 0),
      netPnl: net.reduce((sum, value) => sum + value, 0),
      meanNetPnl: net.length ? net.reduce((sum, value) => sum + value, 0) / net.length : 0,
      medianNetPnl: median,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : undefined,
      maxDrawdown,
      largestWinningTrade: wins.length ? Math.max(...wins) : 0,
      largestLosingTrade: losses.length ? Math.min(...losses) : 0,
      countsByMonth: countBy("exit_at", (value) => new Date(String(value)).toISOString().slice(0, 7)),
      countsByContract: countBy("exit_conid"),
      countsByExitReason,
      countsByDirectionalRegime: countBy("directional_regime"),
      countsByVolatilityRegime: countBy("volatility_regime"),
      signalRejections,
      lifecycleExitCounts: Object.fromEntries(
        ["contract_roll", "expiry", "dataset_end"].map((reason) =>
          [reason, countsByExitReason[reason] ?? 0]),
      ),
      openPositions: unclosed,
      pendingOrders: pending,
      unclosedFills: unclosed,
      strategyPermanentlyDisabled: stateResult.rows[0]?.permanently_disabled === true,
      invariantViolations: [...new Set(invariantViolations)].sort(),
      datasetFingerprintBefore,
      datasetFingerprintAfter,
    };
  }

  async saveResearchExperimentArtifact(
    experimentId: string,
    result: Record<string, unknown>,
    resultSha256: string,
  ): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE backtest_research_experiments
       SET status='finished', canonical_result=$2::jsonb, result_sha256=$3,
           finished_at=NOW()
       WHERE experiment_id=$1 AND status='running'`,
      [experimentId, JSON.stringify(result), resultSha256],
    );
    if (updated.rowCount !== 1)
      throw new Error("Unable to persist the canonical research artifact");
  }

  async getResearchExperimentResult(experimentId: string): Promise<unknown | null> {
    const result = await this.pool.query(
      `SELECT canonical_result AS result, result_sha256
       FROM backtest_research_experiments
       WHERE experiment_id=$1 AND canonical_result IS NOT NULL`,
      [experimentId],
    );
    if ((result.rowCount ?? 0) === 0 || !result.rows[0]?.result) return null;
    return { result: result.rows[0].result, resultSha256: result.rows[0].result_sha256 };
  }

  async researchExperimentExists(experimentId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM backtest_research_experiments WHERE experiment_id=$1
       ) AS present`,
      [experimentId],
    );
    return result.rows[0]?.present === true;
  }

  async claimResearchExperiment(
    experimentId: string,
    request: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.researchClaimClient)
      throw new Error("This repository already owns a research experiment claim");
    const client = await this.pool.connect();
    const lockKey = `backtest-research-experiment:${experimentId}`;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [lockKey],
      );
      if (lock.rows[0]?.acquired !== true) return false;
      const inserted = await client.query(
        `INSERT INTO backtest_research_experiments (experiment_id,status,request_json)
         VALUES ($1,'running',$2::jsonb)
         ON CONFLICT (experiment_id) DO NOTHING
         RETURNING experiment_id`,
        [experimentId, JSON.stringify(request)],
      );
      if (inserted.rowCount !== 1) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
        return false;
      }
      this.researchClaimClient = client;
      this.researchClaimLockKey = lockKey;
      return true;
    } finally {
      if (this.researchClaimClient !== client) client.release();
    }
  }

  async recoverAbandonedResearchExperiment(
    experimentId: string,
    buildArtifact: (request: unknown) => {
      result: Record<string, unknown>;
      resultSha256: string;
    },
  ): Promise<boolean> {
    const client = await this.pool.connect();
    const lockKey = `backtest-research-experiment:${experimentId}`;
    let lockAcquired = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [lockKey],
      );
      if (lock.rows[0]?.acquired !== true) return false;
      lockAcquired = true;
      await client.query("BEGIN");
      try {
        const claim = await client.query<{ request_json: unknown }>(
          `SELECT request_json FROM backtest_research_experiments
           WHERE experiment_id=$1 AND status='running' FOR UPDATE`,
          [experimentId],
        );
        if (claim.rowCount !== 1) {
          await client.query("COMMIT");
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
          lockAcquired = false;
          return false;
        }
        const artifact = buildArtifact(claim.rows[0].request_json);
        const recovered = await client.query(
          `UPDATE backtest_research_experiments
           SET status='finished', canonical_result=$2::jsonb, result_sha256=$3,
               finished_at=NOW()
           WHERE experiment_id=$1 AND status='running'
           RETURNING experiment_id`,
          [experimentId, JSON.stringify(artifact.result), artifact.resultSha256],
        );
        if (recovered.rowCount === 1) {
          await client.query(
            `UPDATE backtest_runs SET status='failed', finished_at=NOW(),
               error='Backtest engine restarted before research experiment completed'
             WHERE status='running' AND config_json->>'experimentId'=$1`,
            [experimentId],
          );
        }
        await client.query("COMMIT");
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
        lockAcquired = false;
        return recovered.rowCount === 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      if (lockAcquired)
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      client.release();
    }
  }

  async finishRun(
    runId: number,
    status: "completed" | "failed",
    metrics: {
      totalPnl?: number;
      trades?: number;
      winRate?: number;
      error?: string;
    },
  ): Promise<BacktestRun> {
    const result = await this.pool.query(
      `UPDATE backtest_runs
       SET status=$2,
           finished_at=NOW(),
           total_pnl=$3,
           trades=$4,
           win_rate=$5,
           error=$6,
           progress_current=CASE
             WHEN $2='completed' AND progress_total IS NOT NULL THEN progress_total
             ELSE progress_current
           END,
           progress_label=CASE
             WHEN $2='completed' THEN 'completed'
             WHEN $2='failed' THEN 'failed'
             ELSE progress_label
           END,
           progress_updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [
        runId,
        status,
        metrics.totalPnl ?? null,
        metrics.trades ?? null,
        metrics.winRate ?? null,
        metrics.error ?? null,
      ],
    );
    return mapRun(result.rows[0]);
  }

  async insertOrder(order: BacktestOrderRecord): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO backtest_orders (
        run_id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
        reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
        partial_take_profits, trailing_stop_pct, trailing_stop_activation_r, generated_from_candle_ts, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      ) RETURNING id`,
      [
        order.runId,
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
        order.indicatorSnapshot
          ? JSON.stringify(order.indicatorSnapshot)
          : null,
        order.partialTakeProfits
          ? JSON.stringify(order.partialTakeProfits)
          : null,
        order.trailingStopPct ?? null,
        order.trailingStopActivationR ?? null,
        order.generatedFromCandleTs ?? null,
        order.createdAt,
      ],
    );
    return Number(result.rows[0].id);
  }

  async updateOrderStatus(
    orderId: number,
    status: string,
    reason?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_orders
       SET status=$2, reason=CASE WHEN $3::text IS NULL THEN reason ELSE reason || ' | ' || $3::text END
       WHERE id=$1`,
      [orderId, status, reason ?? null],
    );
  }

  async insertFill(fill: BacktestFillRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_fills (
        run_id, order_id, instrument, conid, strategy, side, directional_regime, volatility_regime, confidence, quantity,
        entry_price, exit_price, entry_at, exit_at, gross_pnl, commission, net_pnl, pnl_pct, exit_reason,
        entry_reference_price, entry_fill_price, exit_reference_price, exit_fill_price,
        multiplier, tick_size, entry_slippage, exit_slippage, slippage_cost,
        commission_per_contract_side, entry_conid, exit_conid, execution_model_version, calendar_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`,
      [
        fill.runId,
        fill.orderId,
        fill.instrument,
        fill.conid ?? null,
        fill.strategy,
        fill.side,
        fill.directionalRegime,
        fill.volatilityRegime,
        fill.confidence,
        fill.quantity,
        fill.entryPrice,
        fill.exitPrice,
        fill.entryAt,
        fill.exitAt,
        fill.grossPnl,
        fill.commission,
        fill.netPnl,
        fill.pnlPct,
        fill.exitReason,
        fill.entryReferencePrice ?? null,
        fill.entryFillPrice ?? null,
        fill.exitReferencePrice ?? null,
        fill.exitFillPrice ?? null,
        fill.multiplier ?? null,
        fill.tickSize ?? null,
        fill.entrySlippage ?? null,
        fill.exitSlippage ?? null,
        fill.slippageCost ?? null,
        fill.commissionPerContractSide ?? null,
        fill.entryConid ?? null,
        fill.exitConid ?? null,
        fill.executionModelVersion ?? null,
        fill.calendarVersion ?? null,
      ],
    );
  }

  async upsertStrategyStates(
    runId: number,
    states: Array<{
      strategyId: string;
      enabled: boolean;
      permanentlyDisabled: boolean;
      cooldownUntil?: Date;
      reason?: string;
    }>,
  ): Promise<void> {
    for (const state of states) {
      await this.pool.query(
        `INSERT INTO backtest_strategy_state (run_id, strategy_id, enabled, permanently_disabled, cooldown_until, reason)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (run_id, strategy_id) DO UPDATE SET
           enabled=EXCLUDED.enabled,
           permanently_disabled=EXCLUDED.permanently_disabled,
           cooldown_until=EXCLUDED.cooldown_until,
           reason=EXCLUDED.reason`,
        [
          runId,
          state.strategyId,
          state.enabled,
          state.permanentlyDisabled,
          state.cooldownUntil ?? null,
          state.reason ?? null,
        ],
      );
    }
  }

  async upsertSignalDiagnostics(
    records: BacktestSignalDiagnosticRecord[],
  ): Promise<void> {
    const filtered = records.filter((record) => record.samples > 0);
    if (filtered.length === 0) return;

    const chunkSize = 500;
    for (let offset = 0; offset < filtered.length; offset += chunkSize) {
      const chunk = filtered.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const placeholders = chunk.map((record, index) => {
        const base = index * 7;
        values.push(
          record.runId,
          record.strategy,
          record.instrument.toUpperCase(),
          record.side,
          record.stage,
          record.reasonGroup,
          Math.max(0, Math.floor(record.samples)),
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
      });

      await this.pool.query(
        `INSERT INTO backtest_signal_diagnostics (run_id, strategy, instrument, side, stage, reason_group, samples)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (run_id, strategy, instrument, side, stage, reason_group) DO UPDATE SET
           samples=backtest_signal_diagnostics.samples + EXCLUDED.samples`,
        values,
      );
    }
  }

  async getReport(runId?: number): Promise<any> {
    const selectedRun = runId
      ? (
          await this.pool.query("SELECT * FROM backtest_runs WHERE id=$1", [
            runId,
          ])
        ).rows[0]
      : (
          await this.pool.query(
            "SELECT * FROM backtest_runs WHERE status='completed' ORDER BY id DESC LIMIT 1",
          )
        ).rows[0];
    if (!selectedRun) throw new Error("No completed backtest run found.");

    const selectedRunId = Number(selectedRun.id);
    const [fillsResult, statesResult, diagnosticsResult] = await Promise.all([
      this.pool.query(
        `SELECT f.*, o.indicator_snapshot
         FROM backtest_fills f
         JOIN backtest_orders o ON o.id = f.order_id
         WHERE f.run_id=$1
         ORDER BY f.exit_at DESC`,
        [selectedRunId],
      ),
      this.pool.query("SELECT * FROM backtest_strategy_state WHERE run_id=$1", [
        selectedRunId,
      ]),
      this.pool.query(
        `SELECT strategy, instrument, side, stage, reason_group, samples
         FROM backtest_signal_diagnostics
         WHERE run_id=$1
         ORDER BY samples DESC
         LIMIT 1000`,
        [selectedRunId],
      ),
    ]);

    const fills = fillsResult.rows.map((row) => {
      const indicators =
        typeof row.indicator_snapshot === "string"
          ? JSON.parse(row.indicator_snapshot)
          : row.indicator_snapshot;

      return {
        orderId: Number(row.order_id),
        instrument: String(row.instrument),
        strategy: String(row.strategy),
        side: String(row.side),
        directionalRegime: String(
          indicators?.directionalRegime ?? row.directional_regime ?? "unknown",
        ),
        volatilityRegime: String(
          indicators?.volatilityRegime ?? row.volatility_regime ?? "unknown",
        ),
        regimeScore:
          indicators?.regimeScore === undefined
            ? undefined
            : Number(indicators.regimeScore),
        regimeConfidence:
          indicators?.regimeConfidence === undefined
            ? undefined
            : Number(indicators.regimeConfidence),
        confidence: Number(row.confidence),
        pnl: Number(row.net_pnl),
        grossPnl: Number(row.gross_pnl),
        commissions: Number(row.commission),
        pnlPct: Number(row.pnl_pct),
        notes: String(row.exit_reason),
        executedAt: new Date(row.exit_at).toISOString(),
      };
    });

    const stateByStrategy = new Map<string, any>();
    for (const row of statesResult.rows)
      stateByStrategy.set(String(row.strategy_id), row);

    const aggregate = (
      keyFn: (fill: (typeof fills)[number]) => string,
      keys?: string[],
    ) => {
      const map = new Map<string, typeof fills>();
      for (const fill of fills) {
        const key = keyFn(fill);
        map.set(key, [...(map.get(key) ?? []), fill]);
      }
      for (const key of keys ?? []) {
        if (!map.has(key)) map.set(key, []);
      }
      return Array.from(map.entries())
        .map(([key, rows]) => {
          const wins = rows.filter((row) => row.pnl > 0).length;
          const losses = rows.filter((row) => row.pnl <= 0).length;
          const totalPnl = rows.reduce((sum, row) => sum + row.pnl, 0);
          const grossPnl = rows.reduce((sum, row) => sum + row.grossPnl, 0);
          const commissions = rows.reduce(
            (sum, row) => sum + row.commissions,
            0,
          );
          const state = stateByStrategy.get(key);
          const grossWins = rows
            .filter((row) => row.pnl > 0)
            .reduce((sum, row) => sum + row.pnl, 0);
          const grossLosses = Math.abs(
            rows
              .filter((row) => row.pnl <= 0)
              .reduce((sum, row) => sum + row.pnl, 0),
          );
          let cumulative = 0;
          let peak = 0;
          let maxDrawdown = 0;
          for (const row of [...rows].sort(
            (a, b) =>
              new Date(a.executedAt).getTime() -
              new Date(b.executedAt).getTime(),
          )) {
            cumulative += row.pnl;
            peak = Math.max(peak, cumulative);
            maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
          }

          return {
            key,
            trades: rows.length,
            wins,
            losses,
            open: 0,
            winRate: rows.length > 0 ? wins / rows.length : 0,
            totalPnl,
            grossPnl,
            commissions,
            avgPnl: average(rows.map((row) => row.pnl)),
            avgPnlPct: average(rows.map((row) => row.pnlPct)),
            medianPnlPct: pctMedian(rows.map((row) => row.pnlPct)),
            avgConfidence: average(rows.map((row) => row.confidence)),
            avgRegimeScore: average(
              rows
                .map((row) => row.regimeScore)
                .filter((value): value is number => value !== undefined),
            ),
            avgRegimeConfidence: average(
              rows
                .map((row) => row.regimeConfidence)
                .filter((value): value is number => value !== undefined),
            ),
            profitFactor:
              grossLosses > 0
                ? grossWins / grossLosses
                : grossWins > 0
                  ? 999
                  : undefined,
            maxDrawdown,
            symbolsTraded: new Set(rows.map((row) => row.instrument)).size,
            takeProfitHits: rows.filter((row) => row.notes === "take_profit")
              .length,
            stopHits: rows.filter((row) => row.notes === "stop").length,
            strategyEnabled: state ? state.enabled !== false : undefined,
            strategyPermanentlyDisabled: state
              ? state.permanently_disabled === true
              : undefined,
            strategyCooldownUntil: state?.cooldown_until
              ? new Date(state.cooldown_until).toISOString()
              : undefined,
            strategyReason: state?.reason ?? undefined,
          };
        })
        .sort(
          (a, b) =>
            b.trades - a.trades || (a.totalPnl ?? 0) - (b.totalPnl ?? 0),
        );
    };

    const wins = fills.filter((row) => row.pnl > 0).length;
    const totalPnl = fills.reduce((sum, row) => sum + row.pnl, 0);
    const diagnostics = diagnosticsResult.rows.map((row) => ({
      strategy: String(row.strategy),
      instrument: String(row.instrument),
      side: String(row.side),
      stage: String(row.stage),
      reasonGroup: String(row.reason_group),
      samples: Number(row.samples ?? 0),
    }));

    return {
      generatedAt: new Date().toISOString(),
      limit: fills.length,
      source: "backtest",
      runId: selectedRunId,
      runMode: selectedRun.mode === "isolated" ? "isolated" : "bot",
      overview: {
        trades: fills.length,
        wins,
        losses: fills.length - wins,
        open: 0,
        winRate: fills.length > 0 ? wins / fills.length : 0,
        totalPnl,
        grossPnl: fills.reduce((sum, row) => sum + row.grossPnl, 0),
        commissions: fills.reduce((sum, row) => sum + row.commissions, 0),
        avgPnl: average(fills.map((row) => row.pnl)),
        avgPnlPct: average(fills.map((row) => row.pnlPct)),
        medianPnlPct: pctMedian(fills.map((row) => row.pnlPct)),
        avgConfidence: average(fills.map((row) => row.confidence)),
        avgRegimeScore: average(
          fills
            .map((row) => row.regimeScore)
            .filter((value): value is number => value !== undefined),
        ),
        avgRegimeConfidence: average(
          fills
            .map((row) => row.regimeConfidence)
            .filter((value): value is number => value !== undefined),
        ),
        takeProfitHits: fills.filter((row) => row.notes === "take_profit")
          .length,
        stopHits: fills.filter((row) => row.notes === "stop").length,
      },
      bySymbol: aggregate((fill) => fill.instrument),
      byStrategy: aggregate(
        (fill) => fill.strategy,
        listStrategyProfiles().map((profile) => profile.id),
      ),
      byStrategySymbolSide: aggregate(
        (fill) => `${fill.strategy} / ${fill.instrument} / ${fill.side}`,
      ),
      bySide: aggregate((fill) => fill.side),
      byDirectionalRegime: aggregate((fill) => fill.directionalRegime),
      byVolatilityRegime: aggregate((fill) => fill.volatilityRegime),
      diagnostics,
      worstTrades: [...fills].sort((a, b) => a.pnl - b.pnl).slice(0, 25),
    };
  }

  private async aggregateCandles(
    targetTable: string,
    bucketSeconds: number,
  ): Promise<void> {
    await this.pool.query(`
      INSERT INTO ${targetTable} (symbol, conid, ts, open, high, low, close, volume)
      SELECT
        symbol,
        conid,
        to_timestamp(floor(extract(epoch from ts) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
        (array_agg(open ORDER BY ts ASC))[1] AS open,
        MAX(high) AS high,
        MIN(low) AS low,
        (array_agg(close ORDER BY ts DESC))[1] AS close,
        SUM(volume) AS volume
      FROM backtest_candles_1m
      GROUP BY symbol, conid, bucket
      ON CONFLICT (symbol, ts) DO UPDATE SET
        conid=EXCLUDED.conid,
        open=EXCLUDED.open,
        high=EXCLUDED.high,
        low=EXCLUDED.low,
        close=EXCLUDED.close,
        volume=EXCLUDED.volume;
    `);
  }
}
