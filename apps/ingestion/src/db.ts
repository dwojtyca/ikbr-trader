import { Pool } from "pg";
import { Candle, InstrumentContract, MarketState } from "@ikbr/shared";

export class MarketRepository {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    for (const timeframe of [
      "1m",
      "5m",
      "1h",
      "4h",
      "12h",
      "1d",
      "1w",
    ] as const) {
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

      await this.pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source text`);
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
  }

  async upsertInstrumentContract(contract: InstrumentContract): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO instrument_contracts (
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

  async upsertCandle(candle: Candle): Promise<void> {
    const table = this.tableForTimeframe(candle.timeframe);
    await this.pool.query(
      `
      INSERT INTO ${table} (conid, symbol, ts, open, high, low, close, volume, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (conid, ts)
      DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume, source = EXCLUDED.source;
      `,
      [
        candle.conid,
        candle.symbol,
        candle.ts,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
        candle.source ?? null,
      ],
    );
  }

  async writeMarketState(
    redis: { set: (k: string, v: string) => Promise<unknown> },
    state: MarketState,
  ): Promise<void> {
    await redis.set(`market-state:${state.conid}`, JSON.stringify(state));
  }

  async readMarketState(
    redis: { get: (k: string) => Promise<string | null> },
    conid: string,
  ): Promise<MarketState | null> {
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
        bidObservedAt?: string;
        askObservedAt?: string;
        marketDataType?: number;
        ts: string;
      };

      return {
        conid: parsed.conid,
        symbol: parsed.symbol,
        lastPrice: Number(parsed.lastPrice),
        bid: parsed.bid,
        ask: parsed.ask,
        bidObservedAt: parsed.bidObservedAt,
        askObservedAt: parsed.askObservedAt,
        marketDataType: parsed.marketDataType,
        spread: parsed.spread,
        ts: new Date(parsed.ts),
      };
    } catch {
      return null;
    }
  }

  /**
   * Returns the most recent candle timestamp per conid for the given
   * timeframe. Used by the bootstrap to skip historical re-fetches for
   * (symbol, timeframe) pairs that already have fresh data in the DB,
   * staying under IBKR's 60-historical-requests/10-minute pacing cap.
   */
  async getNativeWseCandles(conid: string, timeframe: Candle["timeframe"], limit: number): Promise<Candle[]> {
    const rows = await this.pool.query(`SELECT conid, symbol, ts, open, high, low, close, volume, source
      FROM ${this.tableForTimeframe(timeframe)} WHERE conid=$1 AND source='ibkr_wse_native_v1' ORDER BY ts DESC LIMIT $2`, [conid, limit]);
    return rows.rows.map(row => ({ conid: row.conid, symbol: row.symbol, timeframe, ts: new Date(row.ts),
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), source: row.source })).reverse();
  }

  async getLatestCandleTsByConids(
    timeframe: Candle["timeframe"],
    conids: string[],
  ): Promise<Map<string, Date>> {
    if (conids.length === 0) {
      return new Map();
    }
    const table = this.tableForTimeframe(timeframe);
    const result = await this.pool.query(
      `
      SELECT conid, MAX(ts) AS ts
      FROM ${table}
      WHERE conid = ANY($1::text[])
      GROUP BY conid
      `,
      [conids],
    );
    const map = new Map<string, Date>();
    for (const row of result.rows) {
      map.set(String(row.conid), new Date(row.ts));
    }
    return map;
  }

  async getLatestCandles1mByConids(
    conids: string[],
  ): Promise<Map<string, Candle>> {
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
      [conids],
    );

    const map = new Map<string, Candle>();
    for (const row of result.rows) {
      map.set(String(row.conid), {
        conid: String(row.conid),
        symbol: String(row.symbol),
        timeframe: "1m",
        ts: new Date(row.ts),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      });
    }

    return map;
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
