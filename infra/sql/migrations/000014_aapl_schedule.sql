CREATE TABLE IF NOT EXISTS aapl_schedule_state (
  instrument_id text PRIMARY KEY CHECK (instrument_id = 'aapl_nasdaq'),
  generation bigint NOT NULL CHECK (generation > 0),
  status text NOT NULL CHECK (status IN ('READY', 'REFRESHING', 'FAILED')),
  evidence jsonb,
  updated_at timestamptz NOT NULL
);
