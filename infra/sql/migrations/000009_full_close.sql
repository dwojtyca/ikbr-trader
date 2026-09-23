CREATE TABLE lifecycle_close_operations (
 id BIGSERIAL PRIMARY KEY,
 original_proposal_id BIGINT NOT NULL UNIQUE REFERENCES proposed_orders(id),
 request_id UUID NOT NULL UNIQUE,
 account_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 client_id INTEGER NOT NULL,
 socket_generation BIGINT NOT NULL,
 original_hash TEXT NOT NULL,
 instrument_id TEXT NOT NULL,
 conid TEXT NOT NULL,
 limit_price NUMERIC NOT NULL CHECK (limit_price>0),
 owner UUID NOT NULL,
 actor TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PREPARING','CANCEL_UNKNOWN','BLOCKED','SUBMISSION_UNKNOWN','SUBMITTED','COMPLETED')),
 cancel_attempts JSONB NOT NULL DEFAULT '[]',
 terminals JSONB NOT NULL DEFAULT '[]',
 barrier_at TIMESTAMPTZ,
 close_proposal_id BIGINT UNIQUE REFERENCES proposed_orders(id),
 risk_evidence JSONB,
 prepared_plan JSONB,
 submission_attempted_at TIMESTAMPTZ,
 observation JSONB,
 failure_reason TEXT,
 alerted_reason TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX lifecycle_close_account_reservation ON lifecycle_close_operations(account_id) WHERE state<>'COMPLETED';

ALTER TABLE reconciliation_runs ADD COLUMN position_generation BIGINT;
