CREATE TABLE IF NOT EXISTS lifecycle_faults (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  original_proposal_id BIGINT,
  code TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_faults_active_identity
  ON lifecycle_faults (account_id, COALESCE(original_proposal_id, -1), code)
  WHERE active;
CREATE INDEX IF NOT EXISTS lifecycle_faults_account_active
  ON lifecycle_faults (account_id, active);

CREATE TABLE IF NOT EXISTS lifecycle_alert_outbox (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  fault_id BIGINT REFERENCES lifecycle_faults(id),
  probe_process_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SENDING','DELIVERED','FAILED','UNKNOWN','DISABLED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at TIMESTAMPTZ,
  CHECK ((fault_id IS NOT NULL) <> (probe_process_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_alert_outbox_fault_unique
  ON lifecycle_alert_outbox (fault_id) WHERE fault_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_alert_outbox_probe_unique
  ON lifecycle_alert_outbox (account_id, probe_process_id)
  WHERE probe_process_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lifecycle_alert_outbox_due
  ON lifecycle_alert_outbox (next_attempt_at, id)
  WHERE status IN ('PENDING','FAILED','UNKNOWN','DISABLED','SENDING');

CREATE TABLE IF NOT EXISTS lifecycle_alert_delivery_attempts (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT NOT NULL REFERENCES lifecycle_alert_outbox(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  lease_token UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('SENDING','DELIVERED','FAILED','UNKNOWN')),
  provider_message_id TEXT,
  error_code TEXT,
  UNIQUE (outbox_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS lifecycle_alert_workers (
  account_id TEXT NOT NULL,
  process_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  transport_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (account_id, process_id)
);
