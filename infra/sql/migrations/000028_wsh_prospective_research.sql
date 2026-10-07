CREATE TABLE research_wsh_endpoints (
  endpoint_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE research_wsh_acquisitions (
  id UUID PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES research_wsh_endpoints(endpoint_id),
  generation BIGINT NOT NULL CHECK (generation > 0),
  session_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  ledger_key TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  state TEXT NOT NULL CHECK (state IN ('PENDING','PUBLISHED','FAILED','UNKNOWN')),
  retired_at TIMESTAMPTZ,
  snapshot_id UUID REFERENCES research_snapshots(id),
  UNIQUE(endpoint_id,generation)
);
CREATE UNIQUE INDEX research_wsh_one_pending_endpoint ON research_wsh_acquisitions(endpoint_id) WHERE retired_at IS NULL AND state='PENDING';
CREATE INDEX research_wsh_issuer_history ON research_wsh_acquisitions(ledger_key,started_at DESC);
CREATE TABLE research_wsh_acquisition_calls (
  acquisition_id UUID NOT NULL REFERENCES research_wsh_acquisitions(id),
  call_key TEXT NOT NULL UNIQUE REFERENCES research_call_reservations(call_key),
  PRIMARY KEY(acquisition_id,call_key)
);
CREATE TABLE research_wsh_first_observations (
  ledger_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  version_hash TEXT NOT NULL CHECK (version_hash ~ '^[a-f0-9]{64}$'),
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  acquisition_id UUID NOT NULL REFERENCES research_wsh_acquisitions(id),
  PRIMARY KEY(ledger_key,event_key,version_hash)
);
CREATE TRIGGER research_wsh_first_observations_immutable BEFORE UPDATE OR DELETE ON research_wsh_first_observations
  FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_wsh_first_observations_no_truncate BEFORE TRUNCATE ON research_wsh_first_observations
  FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_wsh_calls_immutable BEFORE UPDATE OR DELETE ON research_wsh_acquisition_calls
  FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_wsh_calls_no_truncate BEFORE TRUNCATE ON research_wsh_acquisition_calls
  FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
