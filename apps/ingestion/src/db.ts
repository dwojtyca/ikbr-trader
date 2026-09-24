import { Pool } from "pg";
import { AAPL_NATIVE_SOURCE, sessionNativeSource, validateSessionSchedule, type InstrumentSessionIdentity, type SessionSchedule, type SessionScheduleEvidence, type AaplSchedule, type AaplScheduleEvidence, Candle, InstrumentContract, MarketState } from "@ikbr/shared";

export class MarketRepository {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Same lock as the execution migration runner: startup DDL must not race versioned migrations.
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x69_6b_62_72_31_34_32n.toString()]);
    await client.query(`CREATE TABLE IF NOT EXISTS aapl_schedule_state (
  instrument_id text PRIMARY KEY CHECK (instrument_id = 'aapl_nasdaq'),
  generation bigint NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('READY', 'REFRESHING', 'FAILED')),
  evidence jsonb,
  updated_at timestamptz NOT NULL
);
`);
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
      await client.query(`
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

      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source text`);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${table}_symbol_ts_idx
        ON ${table} (symbol, ts DESC);
      `);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS instrument_session_schedules (
  instrument_id text NOT NULL,
  conid text NOT NULL,
  use_rth boolean NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('READY', 'REFRESHING', 'FAILED')),
  evidence jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (instrument_id, conid, use_rth)
);
CREATE TABLE IF NOT EXISTS instrument_contracts (
  symbol text NOT NULL,
  conid text PRIMARY KEY,
  sec_type text NOT NULL,
  exchange text,
  primary_exchange text,
  currency text,
  local_symbol text,
  trading_class text,
  min_tick double precision,
  display_name text,
  contract_json jsonb,
  details_json jsonb,
  source text NOT NULL,
  resolved_at timestamptz NOT NULL DEFAULT NOW()
);
DO $$
DECLARE primary_name text;
BEGIN
  SELECT c.conname INTO primary_name FROM pg_constraint c
    WHERE c.conrelid = 'instrument_contracts'::regclass AND c.contype = 'p'
      AND pg_get_constraintdef(c.oid) <> 'PRIMARY KEY (conid)';
  IF primary_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE instrument_contracts DROP CONSTRAINT %I', primary_name);
    ALTER TABLE instrument_contracts ADD PRIMARY KEY (conid);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS instrument_contracts_symbol_idx ON instrument_contracts (symbol);
`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }

  }

  async getSessionSchedule(identity: InstrumentSessionIdentity): Promise<SessionScheduleEvidence | null> {
    const { rows } = await this.pool.query(`SELECT generation, status, evidence, updated_at FROM instrument_session_schedules
      WHERE instrument_id=$1 AND conid=$2 AND use_rth=$3`, [identity.instrumentId, String(identity.conId), identity.useRTH]);
    const row = rows[0];
    return row ? { generation: Number(row.generation), status: row.status, schedule: row.evidence, updatedAt: new Date(row.updated_at).toISOString() } : null;
  }
  async beginSessionSchedule(identity: InstrumentSessionIdentity, status: 'REFRESHING' | 'FAILED'): Promise<number> {
    const { rows } = await this.pool.query(`INSERT INTO instrument_session_schedules (instrument_id, conid, use_rth, generation, status, evidence, updated_at)
      VALUES ($1,$2,$3,1,$4,NULL,clock_timestamp()) ON CONFLICT (instrument_id,conid,use_rth) DO UPDATE
      SET generation=instrument_session_schedules.generation+1,status=EXCLUDED.status,updated_at=clock_timestamp() RETURNING generation`,
      [identity.instrumentId, String(identity.conId), identity.useRTH, status]);
    return Number(rows[0].generation);
  }
  async finishSessionSchedule(identity: InstrumentSessionIdentity, generation: number, schedule: SessionSchedule | null): Promise<boolean> {
    if (schedule) validateSessionSchedule(schedule, identity);
    const result = await this.pool.query(`UPDATE instrument_session_schedules SET status=$5,evidence=COALESCE($6::jsonb,evidence),updated_at=clock_timestamp()
      WHERE instrument_id=$1 AND conid=$2 AND use_rth=$3 AND generation=$4 AND status='REFRESHING'`,
      [identity.instrumentId, String(identity.conId), identity.useRTH, generation, schedule ? 'READY' : 'FAILED', schedule ? JSON.stringify(schedule) : null]);
    return result.rowCount === 1;
  }
  async getSessionCandles(identity: InstrumentSessionIdentity, timeframe: Candle['timeframe'], limit: number): Promise<Candle[]> {
    const { rows } = await this.pool.query(`SELECT conid,symbol,ts,open,high,low,close,volume,source FROM ${this.tableForTimeframe(timeframe)}
      WHERE conid=$1 AND symbol=$2 AND source=$3 ORDER BY ts DESC LIMIT $4`, [String(identity.conId), identity.symbol, sessionNativeSource(identity), limit]);
    return rows.map(row => ({ conid: row.conid, symbol: row.symbol, timeframe, ts: new Date(row.ts), open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume), source: row.source })).reverse();
  }

  async getAaplSchedule(): Promise<AaplScheduleEvidence | null> {
    const { rows } = await this.pool.query("SELECT generation, status, evidence, updated_at FROM aapl_schedule_state WHERE instrument_id = 'aapl_nasdaq'");
    const row = rows[0];
    return row ? { generation: Number(row.generation), status: row.status, schedule: row.evidence, updatedAt: new Date(row.updated_at).toISOString() } : null;
  }

  async beginAaplSchedule(status: 'REFRESHING' | 'FAILED'): Promise<number> {
    const { rows } = await this.pool.query(`INSERT INTO aapl_schedule_state (instrument_id, generation, status, evidence, updated_at)
      VALUES ('aapl_nasdaq', 1, $1, NULL, clock_timestamp()) ON CONFLICT (instrument_id) DO UPDATE
      SET generation = aapl_schedule_state.generation + 1, status = EXCLUDED.status, updated_at = clock_timestamp() RETURNING generation`, [status]);
    return Number(rows[0].generation);
  }

  async finishAaplSchedule(generation: number, schedule: AaplSchedule | null): Promise<boolean> {
    const result = await this.pool.query(`UPDATE aapl_schedule_state SET status = $2, evidence = COALESCE($3::jsonb, evidence),
      updated_at = clock_timestamp() WHERE instrument_id = 'aapl_nasdaq' AND generation = $1 AND status = 'REFRESHING'`,
      [generation, schedule ? 'READY' : 'FAILED', schedule ? JSON.stringify(schedule) : null]);
    return result.rowCount === 1;
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
      ON CONFLICT (conid)
      DO UPDATE SET
        symbol = EXCLUDED.symbol,
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
        volume = EXCLUDED.volume, source = EXCLUDED.source,
        symbol = CASE WHEN EXCLUDED.source IN ('ibkr_aapl_rth_native_v1', 'ibkr_session_rth_native_v1', 'ibkr_session_full_native_v1') THEN EXCLUDED.symbol ELSE ${table}.symbol END
      WHERE (${table}.source IS NULL OR ${table}.source NOT IN ('ibkr_aapl_rth_native_v1', 'ibkr_session_rth_native_v1', 'ibkr_session_full_native_v1'))
        OR EXCLUDED.source IN ('ibkr_session_rth_native_v1', 'ibkr_session_full_native_v1')
        OR (${table}.source = 'ibkr_aapl_rth_native_v1' AND EXCLUDED.source = 'ibkr_aapl_rth_native_v1');
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
  async getNativeAaplCandles(conid: string, timeframe: Candle["timeframe"], limit: number): Promise<Candle[]> {
    const rows = await this.pool.query(`SELECT conid, symbol, ts, open, high, low, close, volume, source
      FROM ${this.tableForTimeframe(timeframe)} WHERE conid=$1 AND source=$2 ORDER BY ts DESC LIMIT $3`, [conid, AAPL_NATIVE_SOURCE, limit]);
    return rows.rows.map(row => ({ conid: row.conid, symbol: row.symbol, timeframe, ts: new Date(row.ts),
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), source: row.source })).reverse();
  }

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
