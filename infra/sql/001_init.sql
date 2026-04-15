CREATE TABLE IF NOT EXISTS candles_1m (
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

CREATE TABLE IF NOT EXISTS candles_5m (
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

CREATE TABLE IF NOT EXISTS candles_1h (
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

CREATE INDEX IF NOT EXISTS candles_1m_symbol_ts_idx ON candles_1m (symbol, ts DESC);
CREATE INDEX IF NOT EXISTS candles_5m_symbol_ts_idx ON candles_5m (symbol, ts DESC);
CREATE INDEX IF NOT EXISTS candles_1h_symbol_ts_idx ON candles_1h (symbol, ts DESC);

CREATE TABLE IF NOT EXISTS proposed_orders (
  id BIGSERIAL PRIMARY KEY,
  instrument TEXT NOT NULL,
  conid TEXT,
  side TEXT NOT NULL,
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
  broker_order_id TEXT,
  execution_account_id TEXT,
  execution_message TEXT,
  last_error TEXT,
  execution_attempted_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS conid TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS entry DOUBLE PRECISION;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PROPOSED';
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS strategy TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS indicator_snapshot JSONB;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS broker_order_id TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_account_id TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_message TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS execution_attempted_at TIMESTAMPTZ;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS signal_outcomes (
  id BIGSERIAL PRIMARY KEY,
  proposed_order_id BIGINT NOT NULL REFERENCES proposed_orders(id),
  evaluated_at TIMESTAMPTZ NOT NULL,
  pnl_pct DOUBLE PRECISION,
  hit_stop BOOLEAN,
  hit_take_profit BOOLEAN,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS proposed_orders_created_idx
ON proposed_orders (created_at DESC);

CREATE INDEX IF NOT EXISTS proposed_orders_status_idx
ON proposed_orders (status);
