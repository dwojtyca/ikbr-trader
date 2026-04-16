import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Candle, IndicatorSnapshot, ProposedOrder, ProposedOrderStatus, RiskCheckStatus, Side } from '@ikbr/shared';

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
  position_effect: 'OPEN_OR_ADD' | 'CLOSE_OR_REDUCE' | null;
  order_type: 'MKT' | 'LMT';
  quantity: number;
  entry: number | null;
  stop: number | null;
  take_profit: number | null;
  reason: string;
  confidence: number;
  risk_check_status: RiskCheckStatus;
  status: 'PROPOSED' | 'REJECTED' | 'SUBMITTED' | 'FILLED' | 'CANCELLED' | 'EXECUTED';
  strategy: string | null;
  indicator_snapshot: IndicatorSnapshot | string | null;
  created_at: Date | string;
}

export interface ExposureSnapshot {
  exposure: number;
  openPositions: number;
  source: 'execution' | 'db';
  positionsBySymbol: Record<string, number>;
}

export class SignalRepository {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis
  ) {}

  async init(): Promise<void> {
    for (const table of ['candles_1m', 'candles_5m', 'candles_1h'] as const) {
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS conid TEXT;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS entry DOUBLE PRECISION;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PROPOSED';`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS strategy TEXT;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS indicator_snapshot JSONB;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS broker_order_id TEXT;`);
    await this.pool.query(`ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS position_effect TEXT;`);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_created_idx
      ON proposed_orders (created_at DESC);
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS proposed_orders_status_idx
      ON proposed_orders (status);
    `);
  }

  async getRecentCandles(symbol: string, timeframe: Candle['timeframe'], limit: number): Promise<Candle[]> {
    const table = this.tableForTimeframe(timeframe);
    const result = await this.pool.query(
      `
      SELECT conid, symbol, ts, open, high, low, close, volume
      FROM ${table}
      WHERE symbol = $1
      ORDER BY ts DESC
      LIMIT $2;
      `,
      [symbol, limit]
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
        volume: Number(row.volume)
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

  async getOpenExposureNotional(): Promise<number> {
    const positions = await this.getDbNetPositions();
    return positions.reduce((sum, row) => sum + Math.abs(row.netQty) * row.referencePrice, 0);
  }

  async getOpenPositionsCount(): Promise<number> {
    const positions = await this.getDbNetPositions();
    return positions.length;
  }

  async getExposureSnapshot(executionBaseUrl?: string): Promise<ExposureSnapshot> {
    if (executionBaseUrl) {
      const fromExecution = await this.tryLoadExposureFromExecution(executionBaseUrl);
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
      source: 'db',
      positionsBySymbol
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
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, NOW()
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
        JSON.stringify(order.indicators ?? null)
      ]
    );

    return Number(result.rows[0].id);
  }

  async cancelOpenProposalsForInstrument(instrument: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE proposed_orders
      SET status = 'CANCELLED'
      WHERE instrument = $1
        AND status = 'PROPOSED'
      `,
      [instrument]
    );
  }

  async getRecentSignals(limit: number): Promise<ProposedOrder[]> {
    const result = await this.pool.query(
      `
      SELECT id, instrument, conid, side, position_effect, order_type, quantity, entry, stop, take_profit,
             reason, confidence, risk_check_status, status, strategy, indicator_snapshot, created_at
      FROM proposed_orders
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return result.rows.map((row) => this.mapRow(row as ProposedOrderRow));
  }

  private mapRow(row: ProposedOrderRow): ProposedOrder {
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
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
      createdAt
    };
  }

  private normalizeIndicators(value: IndicatorSnapshot | string | null): IndicatorSnapshot | undefined {
    if (!value) return undefined;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as IndicatorSnapshot;
      } catch {
        return undefined;
      }
    }
    return value;
  }

  private normalizeStatus(status: ProposedOrderRow['status']): ProposedOrderStatus {
    if (status === 'EXECUTED') return 'SUBMITTED';
    return status;
  }

  private async tryLoadExposureFromExecution(executionBaseUrl: string): Promise<ExposureSnapshot | null> {
    try {
      const base = executionBaseUrl.endsWith('/') ? executionBaseUrl.slice(0, -1) : executionBaseUrl;
      const url = `${base}/execution/account/summary`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      try {
        const response = await fetch(url, { method: 'GET', signal: controller.signal });
        if (!response.ok) return null;

        const payload = (await response.json()) as {
          totals?: {
            grossExposure?: number | string;
            positionsCount?: number | string;
          };
          positions?: Array<{
            symbol?: string;
            position?: number | string;
          }>;
        };

        const exposure = Number(payload?.totals?.grossExposure);
        const openPositions = Number(payload?.totals?.positionsCount);

        if (!Number.isFinite(exposure) || !Number.isFinite(openPositions)) return null;
        const positionsBySymbol: Record<string, number> = {};
        for (const position of payload.positions ?? []) {
          if (!position?.symbol) continue;
          const qty = Number(position.position);
          if (!Number.isFinite(qty)) continue;
          positionsBySymbol[position.symbol.toUpperCase()] = qty;
        }

        return { exposure, openPositions, source: 'execution', positionsBySymbol };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  private async getDbNetPositions(): Promise<Array<{ instrument: string; netQty: number; referencePrice: number }>> {
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
          AND COALESCE(broker_order_id, '') NOT LIKE 'DRYRUN-%'
        GROUP BY UPPER(instrument)
      )
      SELECT
        instrument,
        net_qty,
        COALESCE(NULLIF(last_entry, 0), avg_entry, 0) AS reference_price
      FROM fills
      WHERE ABS(net_qty) > 1e-12
      `
    );

    return result.rows.map((row) => ({
      instrument: String(row.instrument),
      netQty: Number(row.net_qty),
      referencePrice: Number(row.reference_price)
    }));
  }

  private tableForTimeframe(timeframe: Candle['timeframe']): string {
    if (timeframe === '1m') return 'candles_1m';
    if (timeframe === '5m') return 'candles_5m';
    return 'candles_1h';
  }
}
