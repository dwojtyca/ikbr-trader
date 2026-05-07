import { Pool } from 'pg';
import type { Candle } from '@ikbr/shared';
import { listStrategyProfiles } from '@ikbr/shared';
import type {
  BacktestCandleSymbolSummary,
  BacktestDataset,
  BacktestFillRecord,
  BacktestFxRate,
  BacktestOrderRecord,
  BacktestRun,
  LoadedBacktestData
} from './types.js';

function mapDataset(row: any): BacktestDataset {
  return {
    id: Number(row.id),
    dateFrom: new Date(row.date_from).toISOString(),
    dateTo: new Date(row.date_to).toISOString(),
    status: String(row.status),
    symbols: Array.isArray(row.symbols) ? row.symbols.map(String) : [],
    candlesCount: Number(row.candles_count ?? 0),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : undefined,
    error: row.error ?? undefined
  };
}

function mapRun(row: any): BacktestRun {
  return {
    id: Number(row.id),
    datasetId: Number(row.dataset_id),
    mode: row.mode === 'isolated' ? 'isolated' : 'bot',
    status: String(row.status),
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : undefined,
    error: row.error ?? undefined,
    totalPnl: row.total_pnl === null || row.total_pnl === undefined ? undefined : Number(row.total_pnl),
    trades: row.trades === null || row.trades === undefined ? undefined : Number(row.trades),
    winRate: row.win_rate === null || row.win_rate === undefined ? undefined : Number(row.win_rate),
    progressCurrent: row.progress_current === null || row.progress_current === undefined ? undefined : Number(row.progress_current),
    progressTotal: row.progress_total === null || row.progress_total === undefined ? undefined : Number(row.progress_total),
    progressLabel: row.progress_label ?? undefined,
    progressUpdatedAt: row.progress_updated_at ? new Date(row.progress_updated_at).toISOString() : undefined
  };
}

function mapFxRate(row: any): BacktestFxRate {
  return {
    date: new Date(row.rate_date).toISOString().slice(0, 10),
    baseCurrency: String(row.base_currency).toUpperCase(),
    quoteCurrency: String(row.quote_currency).toUpperCase(),
    rateToBase: Number(row.rate_to_base),
    source: String(row.source)
  };
}

function mapCandle(row: any, timeframe: Candle['timeframe']): Candle {
  return {
    conid: String(row.conid),
    symbol: String(row.symbol),
    timeframe,
    ts: new Date(row.ts),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume)
  };
}

function pctMedian(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function ensureBacktestDatabase(adminUrl: string, targetUrl: string): Promise<void> {
  const target = new URL(targetUrl);
  const dbName = target.pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`Unsafe backtest database name: ${dbName}`);

  const pool = new Pool({ connectionString: adminUrl });
  try {
    const existing = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount === 0) {
      await pool.query(`CREATE DATABASE ${dbName}`);
    }
  } finally {
    await pool.end();
  }
}

export class BacktestRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
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
        generated_from_candle_ts TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS backtest_fills (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES backtest_orders(id) ON DELETE CASCADE,
        instrument TEXT NOT NULL,
        conid TEXT,
        strategy TEXT NOT NULL,
        side TEXT NOT NULL,
        regime TEXT NOT NULL,
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
    await this.pool.query(`ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'bot';`);
    await this.pool.query(`ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_current BIGINT NOT NULL DEFAULT 0;`);
    await this.pool.query(`ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_total BIGINT;`);
    await this.pool.query(`ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_label TEXT;`);
    await this.pool.query(`ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ;`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS backtest_orders_run_idx ON backtest_orders(run_id, created_at DESC);');
    await this.pool.query('CREATE INDEX IF NOT EXISTS backtest_fills_run_idx ON backtest_fills(run_id, exit_at DESC);');
  }

  async resetHistoricalData(dateFrom: Date, dateTo: Date, symbols: string[]): Promise<BacktestDataset> {
    await this.pool.query(`
      TRUNCATE backtest_fills, backtest_orders, backtest_strategy_state, backtest_runs,
               backtest_candles_1m, backtest_candles_5m, backtest_candles_1h,
               backtest_candles_4h, backtest_candles_12h, backtest_candles_1d, backtest_fx_rates,
               backtest_datasets
      RESTART IDENTITY CASCADE;
    `);
    const result = await this.pool.query(
      `INSERT INTO backtest_datasets (date_from, date_to, status, symbols)
       VALUES ($1, $2, 'fetching', $3)
       RETURNING *`,
      [dateFrom, dateTo, symbols]
    );
    return mapDataset(result.rows[0]);
  }

  async finishDataset(datasetId: number, status: 'ready' | 'failed', error?: string): Promise<BacktestDataset> {
    const countResult = await this.pool.query('SELECT COUNT(*) AS count FROM backtest_candles_1m');
    const result = await this.pool.query(
      `UPDATE backtest_datasets
       SET status=$2, finished_at=NOW(), error=$3, candles_count=$4
       WHERE id=$1
       RETURNING *`,
      [datasetId, status, error ?? null, Number(countResult.rows[0]?.count ?? 0)]
    );
    return mapDataset(result.rows[0]);
  }

  async resumeDataset(datasetId: number): Promise<BacktestDataset> {
    const countResult = await this.pool.query('SELECT COUNT(*) AS count FROM backtest_candles_1m');
    const result = await this.pool.query(
      `UPDATE backtest_datasets
       SET status='fetching', finished_at=NULL, error=NULL, candles_count=$2
       WHERE id=$1
       RETURNING *`,
      [datasetId, Number(countResult.rows[0]?.count ?? 0)]
    );
    return mapDataset(result.rows[0]);
  }

  async listCandleSymbolSummaries(): Promise<BacktestCandleSymbolSummary[]> {
    const result = await this.pool.query(
      `SELECT symbol, COUNT(*) AS candles, MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM backtest_candles_1m
       GROUP BY symbol
       ORDER BY symbol ASC`
    );
    return result.rows.map((row) => ({
      symbol: String(row.symbol),
      candles: Number(row.candles ?? 0),
      firstTs: row.first_ts ? new Date(row.first_ts).toISOString() : undefined,
      lastTs: row.last_ts ? new Date(row.last_ts).toISOString() : undefined
    }));
  }

  async insertCandles1m(candles: Candle[]): Promise<void> {
    const chunkSize = 1000;
    for (let offset = 0; offset < candles.length; offset += chunkSize) {
      const chunk = candles.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const placeholders = chunk.map((candle, index) => {
        const base = index * 8;
        values.push(candle.symbol, candle.conid, candle.ts, candle.open, candle.high, candle.low, candle.close, candle.volume);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      });

      await this.pool.query(
        `INSERT INTO backtest_candles_1m (symbol, conid, ts, open, high, low, close, volume)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (symbol, ts) DO UPDATE SET
           conid=EXCLUDED.conid,
           open=EXCLUDED.open,
           high=EXCLUDED.high,
           low=EXCLUDED.low,
           close=EXCLUDED.close,
           volume=EXCLUDED.volume`,
        values
      );
    }
  }

  async insertFxRates(rates: BacktestFxRate[]): Promise<void> {
    if (rates.length === 0) return;

    const uniqueRates = Array.from(
      rates.reduce((map, rate) => {
        const key = `${rate.date}|${rate.baseCurrency.toUpperCase()}|${rate.quoteCurrency.toUpperCase()}`;
        map.set(key, {
          ...rate,
          baseCurrency: rate.baseCurrency.toUpperCase(),
          quoteCurrency: rate.quoteCurrency.toUpperCase()
        });
        return map;
      }, new Map<string, BacktestFxRate>()).values()
    );

    const chunkSize = 1000;
    for (let offset = 0; offset < uniqueRates.length; offset += chunkSize) {
      const chunk = uniqueRates.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const placeholders = chunk.map((rate, index) => {
        const base = index * 5;
        values.push(rate.date, rate.baseCurrency, rate.quoteCurrency, rate.rateToBase, rate.source);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      });

      await this.pool.query(
        `INSERT INTO backtest_fx_rates (rate_date, base_currency, quote_currency, rate_to_base, source)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (rate_date, base_currency, quote_currency) DO UPDATE SET
           rate_to_base=EXCLUDED.rate_to_base,
           source=EXCLUDED.source`,
        values
      );
    }
  }

  async countFxRates(baseCurrency: string, quoteCurrencies: string[], dateFrom: Date, dateTo: Date): Promise<number> {
    if (quoteCurrencies.length === 0) return 0;
    const result = await this.pool.query(
      `
      SELECT COUNT(*) AS count
      FROM backtest_fx_rates
      WHERE base_currency=$1
        AND quote_currency = ANY($2::text[])
        AND rate_date BETWEEN $3::date AND $4::date
      `,
      [baseCurrency.toUpperCase(), quoteCurrencies.map((value) => value.toUpperCase()), dateFrom, dateTo]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async rebuildAggregates(): Promise<void> {
    await this.pool.query('TRUNCATE backtest_candles_5m, backtest_candles_1h, backtest_candles_4h, backtest_candles_12h, backtest_candles_1d;');
    await this.aggregateCandles('backtest_candles_5m', 300);
    await this.aggregateCandles('backtest_candles_1h', 3600);
    await this.aggregateCandles('backtest_candles_4h', 4 * 3600);
    await this.aggregateCandles('backtest_candles_12h', 12 * 3600);
    await this.aggregateCandles('backtest_candles_1d', 24 * 3600);
  }

  async latestDataset(): Promise<BacktestDataset | null> {
    const result = await this.pool.query('SELECT * FROM backtest_datasets ORDER BY id DESC LIMIT 1');
    return result.rows[0] ? mapDataset(result.rows[0]) : null;
  }

  async listRuns(): Promise<BacktestRun[]> {
    const result = await this.pool.query('SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 50');
    return result.rows.map(mapRun);
  }

  async failRunningRuns(error: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE backtest_runs
       SET status='failed', finished_at=NOW(), error=$1
       WHERE status='running'
       RETURNING id`,
      [error]
    );
    return result.rowCount ?? 0;
  }

  async updateRunProgress(runId: number, progress: { current: number; total?: number; label?: string }): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_runs
       SET progress_current=$2,
           progress_total=$3,
           progress_label=$4,
           progress_updated_at=NOW()
       WHERE id=$1 AND status='running'`,
      [runId, Math.max(0, Math.floor(progress.current)), progress.total === undefined ? null : Math.max(0, Math.floor(progress.total)), progress.label ?? null]
    );
  }

  async loadBacktestData(): Promise<LoadedBacktestData> {
    const dataset = await this.latestDataset();
    if (!dataset || dataset.status !== 'ready') throw new Error('No ready historical dataset. Fetch history first.');
    const [oneMinute, fiveMinute, oneHour, fourHour, twelveHour, oneDay, fxRates] = await Promise.all([
      this.pool.query('SELECT * FROM backtest_candles_1m ORDER BY ts ASC, symbol ASC'),
      this.pool.query('SELECT * FROM backtest_candles_5m ORDER BY ts ASC, symbol ASC'),
      this.pool.query('SELECT * FROM backtest_candles_1h ORDER BY ts ASC, symbol ASC'),
      this.pool.query('SELECT * FROM backtest_candles_4h ORDER BY ts ASC, symbol ASC'),
      this.pool.query('SELECT * FROM backtest_candles_12h ORDER BY ts ASC, symbol ASC'),
      this.pool.query('SELECT * FROM backtest_candles_1d ORDER BY ts ASC, symbol ASC'),
      this.pool.query('SELECT * FROM backtest_fx_rates ORDER BY rate_date ASC, quote_currency ASC')
    ]);
    return {
      dataset,
      candles1m: oneMinute.rows.map((row) => mapCandle(row, '1m')),
      candles5m: fiveMinute.rows.map((row) => mapCandle(row, '5m')),
      candles1h: oneHour.rows.map((row) => mapCandle(row, '1h')),
      candles4h: fourHour.rows.map((row) => mapCandle(row, '4h')),
      candles12h: twelveHour.rows.map((row) => mapCandle(row, '12h')),
      candles1d: oneDay.rows.map((row) => mapCandle(row, '1d')),
      fxRates: fxRates.rows.map(mapFxRate)
    };
  }

  async createRun(datasetId: number, configJson: Record<string, unknown>, mode: 'bot' | 'isolated' = 'bot'): Promise<BacktestRun> {
    const result = await this.pool.query(
      `INSERT INTO backtest_runs (dataset_id, mode, status, config_json)
       VALUES ($1, $2, 'running', $3)
       RETURNING *`,
      [datasetId, mode, configJson]
    );
    return mapRun(result.rows[0]);
  }

  async finishRun(runId: number, status: 'completed' | 'failed', metrics: { totalPnl?: number; trades?: number; winRate?: number; error?: string }): Promise<BacktestRun> {
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
      [runId, status, metrics.totalPnl ?? null, metrics.trades ?? null, metrics.winRate ?? null, metrics.error ?? null]
    );
    return mapRun(result.rows[0]);
  }

  async insertOrder(order: BacktestOrderRecord): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO backtest_orders (
        run_id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
        reason, confidence, risk_check_status, status, strategy, indicator_snapshot,
        generated_from_candle_ts, created_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
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
        order.indicatorSnapshot ? JSON.stringify(order.indicatorSnapshot) : null,
        order.generatedFromCandleTs ?? null,
        order.createdAt
      ]
    );
    return Number(result.rows[0].id);
  }

  async updateOrderStatus(orderId: number, status: string, reason?: string): Promise<void> {
    await this.pool.query(
      `UPDATE backtest_orders
       SET status=$2, reason=CASE WHEN $3::text IS NULL THEN reason ELSE reason || ' | ' || $3::text END
       WHERE id=$1`,
      [orderId, status, reason ?? null]
    );
  }

  async insertFill(fill: BacktestFillRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO backtest_fills (
        run_id, order_id, instrument, conid, strategy, side, regime, confidence, quantity,
        entry_price, exit_price, entry_at, exit_at, gross_pnl, commission, net_pnl, pnl_pct, exit_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        fill.runId,
        fill.orderId,
        fill.instrument,
        fill.conid ?? null,
        fill.strategy,
        fill.side,
        fill.regime,
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
        fill.exitReason
      ]
    );
  }

  async upsertStrategyStates(runId: number, states: Array<{ strategyId: string; enabled: boolean; permanentlyDisabled: boolean; cooldownUntil?: Date; reason?: string }>): Promise<void> {
    for (const state of states) {
      await this.pool.query(
        `INSERT INTO backtest_strategy_state (run_id, strategy_id, enabled, permanently_disabled, cooldown_until, reason)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (run_id, strategy_id) DO UPDATE SET
           enabled=EXCLUDED.enabled,
           permanently_disabled=EXCLUDED.permanently_disabled,
           cooldown_until=EXCLUDED.cooldown_until,
           reason=EXCLUDED.reason`,
        [runId, state.strategyId, state.enabled, state.permanentlyDisabled, state.cooldownUntil ?? null, state.reason ?? null]
      );
    }
  }

  async getReport(runId?: number): Promise<any> {
    const selectedRun = runId
      ? (await this.pool.query('SELECT * FROM backtest_runs WHERE id=$1', [runId])).rows[0]
      : (await this.pool.query("SELECT * FROM backtest_runs WHERE status='completed' ORDER BY id DESC LIMIT 1")).rows[0];
    if (!selectedRun) throw new Error('No completed backtest run found.');

    const selectedRunId = Number(selectedRun.id);
    const [fillsResult, statesResult] = await Promise.all([
      this.pool.query(
        `SELECT f.*, o.indicator_snapshot
         FROM backtest_fills f
         JOIN backtest_orders o ON o.id = f.order_id
         WHERE f.run_id=$1
         ORDER BY f.exit_at DESC`,
        [selectedRunId]
      ),
      this.pool.query('SELECT * FROM backtest_strategy_state WHERE run_id=$1', [selectedRunId])
    ]);

    const fills = fillsResult.rows.map((row) => ({
      orderId: Number(row.order_id),
      instrument: String(row.instrument),
      strategy: String(row.strategy),
      side: String(row.side),
      regime: String(row.regime),
      confidence: Number(row.confidence),
      pnl: Number(row.net_pnl),
      grossPnl: Number(row.gross_pnl),
      commissions: Number(row.commission),
      pnlPct: Number(row.pnl_pct),
      notes: String(row.exit_reason),
      executedAt: new Date(row.exit_at).toISOString()
    }));

    const stateByStrategy = new Map<string, any>();
    for (const row of statesResult.rows) stateByStrategy.set(String(row.strategy_id), row);

    const aggregate = (keyFn: (fill: typeof fills[number]) => string, keys?: string[]) => {
      const map = new Map<string, typeof fills>();
      for (const fill of fills) {
        const key = keyFn(fill);
        map.set(key, [...(map.get(key) ?? []), fill]);
      }
      for (const key of keys ?? []) {
        if (!map.has(key)) map.set(key, []);
      }
      return Array.from(map.entries()).map(([key, rows]) => {
        const wins = rows.filter((row) => row.pnl > 0).length;
        const losses = rows.filter((row) => row.pnl <= 0).length;
        const totalPnl = rows.reduce((sum, row) => sum + row.pnl, 0);
        const grossPnl = rows.reduce((sum, row) => sum + row.grossPnl, 0);
        const commissions = rows.reduce((sum, row) => sum + row.commissions, 0);
        const state = stateByStrategy.get(key);
        const grossWins = rows.filter((row) => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
        const grossLosses = Math.abs(rows.filter((row) => row.pnl <= 0).reduce((sum, row) => sum + row.pnl, 0));
        let cumulative = 0;
        let peak = 0;
        let maxDrawdown = 0;
        for (const row of [...rows].sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime())) {
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
          profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : undefined,
          maxDrawdown,
          symbolsTraded: new Set(rows.map((row) => row.instrument)).size,
          takeProfitHits: rows.filter((row) => row.notes === 'take_profit').length,
          stopHits: rows.filter((row) => row.notes === 'stop').length,
          strategyEnabled: state ? state.enabled !== false : undefined,
          strategyPermanentlyDisabled: state ? state.permanently_disabled === true : undefined,
          strategyCooldownUntil: state?.cooldown_until ? new Date(state.cooldown_until).toISOString() : undefined,
          strategyReason: state?.reason ?? undefined
        };
      }).sort((a, b) => (b.trades - a.trades) || ((a.totalPnl ?? 0) - (b.totalPnl ?? 0)));
    };

    const wins = fills.filter((row) => row.pnl > 0).length;
    const totalPnl = fills.reduce((sum, row) => sum + row.pnl, 0);

    return {
      generatedAt: new Date().toISOString(),
      limit: fills.length,
      source: 'backtest',
      runId: selectedRunId,
      runMode: selectedRun.mode === 'isolated' ? 'isolated' : 'bot',
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
        takeProfitHits: fills.filter((row) => row.notes === 'take_profit').length,
        stopHits: fills.filter((row) => row.notes === 'stop').length
      },
      bySymbol: aggregate((fill) => fill.instrument),
      byStrategy: aggregate((fill) => fill.strategy, listStrategyProfiles().map((profile) => profile.id)),
      byStrategySymbolSide: aggregate((fill) => `${fill.strategy} / ${fill.instrument} / ${fill.side}`),
      bySide: aggregate((fill) => fill.side),
      byRegime: aggregate((fill) => fill.regime),
      worstTrades: [...fills].sort((a, b) => a.pnl - b.pnl).slice(0, 25)
    };
  }

  private async aggregateCandles(targetTable: string, bucketSeconds: number): Promise<void> {
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
