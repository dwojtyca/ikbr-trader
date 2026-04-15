import { Pool } from 'pg';
import { Candle, MarketState } from '@ikbr/shared';

export class MarketRepository {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    for (const timeframe of ['1m', '5m', '1h'] as const) {
      const table = this.tableForTimeframe(timeframe);
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
  }

  async upsertCandle(candle: Candle): Promise<void> {
    const table = this.tableForTimeframe(candle.timeframe);
    await this.pool.query(
      `
      INSERT INTO ${table} (conid, symbol, ts, open, high, low, close, volume)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (conid, ts)
      DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume;
      `,
      [
        candle.conid,
        candle.symbol,
        candle.ts,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume
      ]
    );
  }

  async writeMarketState(redis: { set: (k: string, v: string) => Promise<unknown> }, state: MarketState): Promise<void> {
    await redis.set(`market-state:${state.conid}`, JSON.stringify(state));
  }

  async readMarketState(redis: { get: (k: string) => Promise<string | null> }, conid: string): Promise<MarketState | null> {
    const raw = await redis.get(`market-state:${conid}`);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as {
        conid: string;
        symbol: string;
        lastPrice: number;
        bid?: number;
        ask?: number;
        spread?: number;
        ts: string;
      };

      return {
        conid: parsed.conid,
        symbol: parsed.symbol,
        lastPrice: Number(parsed.lastPrice),
        bid: parsed.bid,
        ask: parsed.ask,
        spread: parsed.spread,
        ts: new Date(parsed.ts)
      };
    } catch {
      return null;
    }
  }

  async getLatestCandles1mByConids(conids: string[]): Promise<Map<string, Candle>> {
    if (conids.length === 0) {
      return new Map();
    }

    const result = await this.pool.query(
      `
      SELECT DISTINCT ON (conid)
        conid, symbol, ts, open, high, low, close, volume
      FROM candles_1m
      WHERE conid = ANY($1::text[])
      ORDER BY conid, ts DESC
      `,
      [conids]
    );

    const map = new Map<string, Candle>();
    for (const row of result.rows) {
      map.set(String(row.conid), {
        conid: String(row.conid),
        symbol: String(row.symbol),
        timeframe: '1m',
        ts: new Date(row.ts),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume)
      });
    }

    return map;
  }

  private tableForTimeframe(timeframe: Candle['timeframe']): string {
    if (timeframe === '1m') return 'candles_1m';
    if (timeframe === '5m') return 'candles_5m';
    return 'candles_1h';
  }
}
