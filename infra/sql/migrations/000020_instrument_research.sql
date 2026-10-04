CREATE TABLE research_manifests (
  manifest_hash TEXT PRIMARY KEY CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
  config_hash TEXT NOT NULL REFERENCES trading_configuration_snapshots(effective_hash),
  canonical_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(manifest_hash,config_hash)
);
CREATE TABLE research_authority (
  config_hash TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  adopted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE TABLE research_authority_history (
  id BIGSERIAL PRIMARY KEY,
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  previous_hash TEXT,
  entries_disabled BOOLEAN NOT NULL CHECK(entries_disabled),
  adopted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE TABLE research_observations (
  process_id TEXT PRIMARY KEY,
  service TEXT NOT NULL CHECK(service IN ('execution-engine','llm-agent')),
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  trading_enabled BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '30 seconds'),
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE TABLE research_snapshots (
  id UUID PRIMARY KEY,
  snapshot_hash TEXT NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence>0),
  canonical_json TEXT NOT NULL,
  stored_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(config_hash,manifest_hash,instrument_id,sequence),
  UNIQUE(id,config_hash,manifest_hash,instrument_id,sequence),
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE TABLE research_snapshot_heads (
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  snapshot_id UUID,
  sequence BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(config_hash,manifest_hash,instrument_id),
  CHECK((snapshot_id IS NULL AND sequence=0) OR (snapshot_id IS NOT NULL AND sequence>0)),
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash),
  FOREIGN KEY(snapshot_id,config_hash,manifest_hash,instrument_id,sequence) REFERENCES research_snapshots(id,config_hash,manifest_hash,instrument_id,sequence)
);
CREATE TABLE research_bindings (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id),
  client_order_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  snapshot_id UUID NOT NULL,
  snapshot_hash TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(snapshot_id,config_hash,manifest_hash,instrument_id,sequence) REFERENCES research_snapshots(id,config_hash,manifest_hash,instrument_id,sequence)
);
CREATE TABLE research_call_reservations (
  call_key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('source','model')),
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  reserved_cost_micros BIGINT NOT NULL CHECK(reserved_cost_micros>=0),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deadline_at TIMESTAMPTZ NOT NULL,
  budget_day DATE NOT NULL,
  CHECK(budget_day=(reserved_at AT TIME ZONE 'UTC')::date),
  CHECK(deadline_at>reserved_at AND deadline_at<=reserved_at+interval '10 seconds'),
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE INDEX research_calls_budget ON research_call_reservations(account_id,provider,budget_day);
CREATE TABLE research_call_outcomes (
  call_key TEXT PRIMARY KEY REFERENCES research_call_reservations(call_key),
  outcome TEXT NOT NULL CHECK(outcome IN ('SUCCEEDED','FAILED','UNKNOWN')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE research_refresh_slots (
  slot_key TEXT PRIMARY KEY CHECK(length(slot_key) BETWEEN 1 AND 1000),
  snapshot_id UUID NOT NULL REFERENCES research_snapshots(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION research_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'RESEARCH_IMMUTABLE'; END $$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['research_manifests','research_authority_history','research_snapshots','research_bindings','research_call_reservations','research_call_outcomes','research_refresh_slots'] LOOP
    EXECUTE format('CREATE TRIGGER research_no_mutation BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION research_immutable()',t);
    EXECUTE format('CREATE TRIGGER research_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION research_immutable()',t);
  END LOOP;
END $$;
CREATE FUNCTION research_monotonic_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.config_hash,NEW.manifest_hash,NEW.instrument_id) IS DISTINCT FROM ROW(OLD.config_hash,OLD.manifest_hash,OLD.instrument_id)
    OR NEW.sequence<>OLD.sequence+1 THEN RAISE EXCEPTION 'RESEARCH_HEAD_NOT_MONOTONIC'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER research_head_guard BEFORE UPDATE ON research_snapshot_heads FOR EACH ROW EXECUTE FUNCTION research_monotonic_head();
CREATE TRIGGER research_head_no_delete BEFORE DELETE ON research_snapshot_heads FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_head_no_truncate BEFORE TRUNCATE ON research_snapshot_heads FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_authority_no_delete BEFORE DELETE ON research_authority FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_authority_no_truncate BEFORE TRUNCATE ON research_authority FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
