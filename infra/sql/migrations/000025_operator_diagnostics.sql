-- Diagnostic copies only. Trading audits and broker evidence have independent retention.
CREATE TABLE IF NOT EXISTS diagnostic_evaluations (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  process_id TEXT NOT NULL,
  cycle_id UUID NOT NULL,
  instrument_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  outcome TEXT NOT NULL,
  evaluation_kind TEXT,
  reason TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  entry_blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  assigned_instances JSONB NOT NULL DEFAULT '[]'::jsonb,
  config_hash TEXT,
  conid TEXT,
  symbol TEXT,
  listing TEXT,
  implementation_id TEXT,
  instance_id TEXT,
  revision BIGINT,
  evaluation_id TEXT,
  proposal_id BIGINT,
  UNIQUE (cycle_id, instrument_id)
);
CREATE INDEX IF NOT EXISTS diagnostic_evaluations_scope_time
  ON diagnostic_evaluations(account_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS diagnostic_evaluations_instrument_time
  ON diagnostic_evaluations(account_id, instrument_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS diagnostic_process_heartbeats (
  process_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  expected_interval_ms INTEGER NOT NULL CHECK(expected_interval_ms BETWEEN 1000 AND 3600000),
  enabled BOOLEAN NOT NULL,
  failure_count BIGINT NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS diagnostic_process_heartbeats_scope
  ON diagnostic_process_heartbeats(account_id, started_at);

CREATE TABLE IF NOT EXISTS diagnostic_coverage_gaps (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  process_id TEXT,
  kind TEXT NOT NULL,
  from_at TIMESTAMPTZ NOT NULL,
  to_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(from_at <= to_at)
);
CREATE INDEX IF NOT EXISTS diagnostic_coverage_gaps_scope_time
  ON diagnostic_coverage_gaps(account_id, from_at, to_at);

CREATE TABLE IF NOT EXISTS diagnostic_retention (
  account_id TEXT PRIMARY KEY,
  pruned_through_at TIMESTAMPTZ,
  pruned_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
