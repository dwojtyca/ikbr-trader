CREATE TABLE IF NOT EXISTS instrument_session_schedules (
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
