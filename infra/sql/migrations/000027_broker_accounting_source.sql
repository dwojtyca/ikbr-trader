CREATE TABLE broker_accounting_sources (
 source_id text PRIMARY KEY,
 account_id text NOT NULL UNIQUE,
 settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
 process_session_id text NOT NULL,
 connection_generation bigint NOT NULL DEFAULT 0,
 semantic_revision bigint NOT NULL DEFAULT 0 CHECK(semantic_revision>=0),
 qualification_id uuid,
 gap boolean NOT NULL DEFAULT true,
 hold text,
 lanes jsonb NOT NULL DEFAULT '{"accounting":{"received":0,"persisted":0,"pending":0},"execution":{"received":0,"persisted":0,"pending":0}}',
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE broker_accounting_observations (
 id uuid PRIMARY KEY,
 source_id text NOT NULL REFERENCES broker_accounting_sources(source_id),
 process_session_id text NOT NULL,
 connection_generation bigint NOT NULL,
 sequence bigserial NOT NULL UNIQUE,
 lane text NOT NULL CHECK(lane IN ('accounting','execution')),
 lane_sequence bigint NOT NULL,
 request_id bigint,
 kind text NOT NULL,
 event_key text,
 received_at timestamptz NOT NULL,
 payload jsonb NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX broker_accounting_observation_identity ON broker_accounting_observations(source_id,kind,event_key,sequence DESC);
CREATE TABLE broker_accounting_qualifications (
 id uuid PRIMARY KEY,
 source_id text NOT NULL REFERENCES broker_accounting_sources(source_id),
 inspection_id uuid NOT NULL REFERENCES broker_accounting_observations(id),
 record jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE broker_accounting_sources ADD CONSTRAINT broker_accounting_qualification_fk FOREIGN KEY(qualification_id) REFERENCES broker_accounting_qualifications(id);
CREATE TABLE broker_accounting_captures (
 id uuid PRIMARY KEY,
 source_id text NOT NULL REFERENCES broker_accounting_sources(source_id),
 qualification_id uuid NOT NULL REFERENCES broker_accounting_qualifications(id),
 receipt_id uuid NOT NULL REFERENCES broker_accounting_observations(id),
 reconciliation_run_id bigint NOT NULL REFERENCES reconciliation_runs(id),
 position_generation bigint NOT NULL,
 semantic_revision bigint NOT NULL,
 record jsonb NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION broker_accounting_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ACCOUNTING_APPEND_ONLY'; END $$;
CREATE TRIGGER accounting_observation_immutable BEFORE UPDATE OR DELETE ON broker_accounting_observations FOR EACH ROW EXECUTE FUNCTION broker_accounting_immutable();
CREATE TRIGGER accounting_observation_no_truncate BEFORE TRUNCATE ON broker_accounting_observations FOR EACH STATEMENT EXECUTE FUNCTION broker_accounting_immutable();
CREATE TRIGGER accounting_qualification_immutable BEFORE UPDATE OR DELETE ON broker_accounting_qualifications FOR EACH ROW EXECUTE FUNCTION broker_accounting_immutable();
CREATE TRIGGER accounting_qualification_no_truncate BEFORE TRUNCATE ON broker_accounting_qualifications FOR EACH STATEMENT EXECUTE FUNCTION broker_accounting_immutable();
CREATE TRIGGER accounting_capture_immutable BEFORE UPDATE OR DELETE ON broker_accounting_captures FOR EACH ROW EXECUTE FUNCTION broker_accounting_immutable();
CREATE TRIGGER accounting_capture_no_truncate BEFORE TRUNCATE ON broker_accounting_captures FOR EACH STATEMENT EXECUTE FUNCTION broker_accounting_immutable();
