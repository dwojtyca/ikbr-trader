CREATE TABLE trading_configuration_snapshots (
  effective_hash TEXT PRIMARY KEY CHECK (effective_hash ~ '^[a-f0-9]{64}$'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  canonical_version INTEGER NOT NULL CHECK (canonical_version = 1),
  canonical_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trading_configuration_instance_revisions (
  instance_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  instance_hash TEXT NOT NULL CHECK (instance_hash ~ '^[a-f0-9]{64}$'),
  first_effective_hash TEXT NOT NULL REFERENCES trading_configuration_snapshots(effective_hash),
  PRIMARY KEY(instance_id, revision)
);
CREATE TABLE trading_configuration_management_snapshots (
  source_hash TEXT PRIMARY KEY CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  canonical_json TEXT NOT NULL,
  entries_disabled BOOLEAN NOT NULL CHECK (entries_disabled),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE trading_configuration_rollout (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  bundle_latched BOOLEAN NOT NULL DEFAULT FALSE,
  legacy_source_hash TEXT REFERENCES trading_configuration_management_snapshots(source_hash),
  first_effective_hash TEXT REFERENCES trading_configuration_snapshots(effective_hash),
  latched_at TIMESTAMPTZ,
  CHECK ((NOT bundle_latched AND first_effective_hash IS NULL AND latched_at IS NULL) OR
    (bundle_latched AND first_effective_hash IS NOT NULL AND latched_at IS NOT NULL))
);
INSERT INTO trading_configuration_rollout(singleton) VALUES(TRUE);
CREATE TABLE trading_configuration_observations (
  process_id UUID PRIMARY KEY,
  service TEXT NOT NULL CHECK (service IN ('ingestion','signal-engine','execution-engine','llm-agent')),
  mode TEXT NOT NULL CHECK (mode IN ('legacy','bundle')),
  schema_version INTEGER,
  canonical_version INTEGER,
  effective_hash TEXT,
  migration_prepared BOOLEAN NOT NULL DEFAULT FALSE,
  legacy_source_hash TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '30 seconds')
);
CREATE INDEX trading_configuration_observations_fresh ON trading_configuration_observations(expires_at);
CREATE TABLE trading_configuration_transitions (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('LEGACY_PREPARED','BUNDLE_ACTIVATED')),
  old_hash TEXT,
  new_hash TEXT NOT NULL,
  entries_disabled BOOLEAN NOT NULL CHECK (entries_disabled),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(kind, new_hash)
);
CREATE FUNCTION trading_configuration_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'configuration audit records are immutable';
END $$;
CREATE TRIGGER trading_configuration_snapshots_immutable BEFORE UPDATE OR DELETE ON trading_configuration_snapshots FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
CREATE TRIGGER trading_configuration_revisions_immutable BEFORE UPDATE OR DELETE ON trading_configuration_instance_revisions FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
CREATE TRIGGER trading_configuration_management_immutable BEFORE UPDATE OR DELETE ON trading_configuration_management_snapshots FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
CREATE TRIGGER trading_configuration_transitions_immutable BEFORE UPDATE OR DELETE ON trading_configuration_transitions FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
CREATE FUNCTION trading_configuration_rollout_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.bundle_latched THEN
    RAISE EXCEPTION 'configuration rollout latch cannot be reset or changed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trading_configuration_rollout_monotonic BEFORE UPDATE OR DELETE ON trading_configuration_rollout FOR EACH ROW EXECUTE FUNCTION trading_configuration_rollout_monotonic();
