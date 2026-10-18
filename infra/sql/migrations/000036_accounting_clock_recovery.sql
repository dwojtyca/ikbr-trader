CREATE TABLE IF NOT EXISTS broker_accounting_clock_episodes (
  id UUID PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES broker_accounting_sources(source_id),
  origin_observation_id UUID NOT NULL REFERENCES broker_accounting_observations(id),
  state TEXT NOT NULL CHECK(state IN ('WAITING','RECOVERING','VERIFYING','BACKOFF','OPERATOR_REQUIRED','OUTCOME_UNKNOWN','RECOVERED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  owner_session_id TEXT NOT NULL,
  fencing_generation BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  first_error TEXT NOT NULL,
  first_error_at TIMESTAMPTZ NOT NULL,
  last_error TEXT NOT NULL,
  last_cause JSONB,
  receipt_id UUID REFERENCES broker_accounting_observations(id),
  capture_id UUID REFERENCES broker_accounting_captures(id),
  verifying_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS broker_accounting_clock_active
 ON broker_accounting_clock_episodes(source_id) WHERE state <> 'RECOVERED';
CREATE TABLE IF NOT EXISTS broker_accounting_clock_attempts (
  id UUID PRIMARY KEY,
  episode_id UUID NOT NULL REFERENCES broker_accounting_clock_episodes(id),
  source_id TEXT NOT NULL REFERENCES broker_accounting_sources(source_id),
  owner_session_id TEXT NOT NULL,
  fencing_generation BIGINT NOT NULL,
  automatic BOOLEAN NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS broker_accounting_clock_attempt_window ON broker_accounting_clock_attempts(source_id,started_at);
CREATE TABLE IF NOT EXISTS broker_accounting_clock_outcomes (
  attempt_id UUID PRIMARY KEY REFERENCES broker_accounting_clock_attempts(id),
  outcome TEXT NOT NULL,
  error TEXT,
  receipt_id UUID REFERENCES broker_accounting_observations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS accounting_source_owners (
  endpoint_key TEXT PRIMARY KEY,
  owner_id UUID NOT NULL,
  generation BIGINT NOT NULL CHECK(generation>0),
  retirement_state TEXT NOT NULL CHECK(retirement_state IN ('ACTIVE','RETIRED','UNKNOWN')),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS accounting_clock_attempt_immutable ON broker_accounting_clock_attempts;
CREATE TRIGGER accounting_clock_attempt_immutable BEFORE UPDATE OR DELETE ON broker_accounting_clock_attempts
FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
DROP TRIGGER IF EXISTS accounting_clock_outcome_immutable ON broker_accounting_clock_outcomes;
CREATE TRIGGER accounting_clock_outcome_immutable BEFORE UPDATE OR DELETE ON broker_accounting_clock_outcomes
FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
