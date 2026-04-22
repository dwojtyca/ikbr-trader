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

ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS conid TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS position_effect TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS entry DOUBLE PRECISION;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PROPOSED';
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS strategy TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS indicator_snapshot JSONB;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS decision_source TEXT NOT NULL DEFAULT 'signal';
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS decision_actor TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_decision TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_reason TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_model TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS ai_decision_confidence DOUBLE PRECISION;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS llm_decision_id BIGINT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS source_error TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS processing_owner TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS processing_claimed_at TIMESTAMPTZ;
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

CREATE INDEX IF NOT EXISTS proposed_orders_decision_source_idx
ON proposed_orders (decision_source);

CREATE INDEX IF NOT EXISTS proposed_orders_processing_claim_idx
ON proposed_orders (processing_claimed_at DESC);

CREATE TABLE IF NOT EXISTS llm_order_decisions (
  id BIGSERIAL PRIMARY KEY,
  proposed_order_id BIGINT NOT NULL REFERENCES proposed_orders(id),
  symbol TEXT NOT NULL,
  decision TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  decision_confidence DOUBLE PRECISION,
  news_count INTEGER NOT NULL DEFAULT 0,
  position_snapshot_json JSONB,
  news_snapshot_json JSONB,
  source_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS llm_order_decisions_order_idx
ON llm_order_decisions (proposed_order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS llm_order_decisions_symbol_idx
ON llm_order_decisions (symbol, created_at DESC);
