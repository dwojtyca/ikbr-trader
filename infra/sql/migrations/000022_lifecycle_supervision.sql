CREATE TABLE IF NOT EXISTS lifecycle_supervision (
 original_proposal_id bigint PRIMARY KEY REFERENCES proposed_orders(id),
 account_id text NOT NULL, original_hash text NOT NULL, instrument_id text NOT NULL, conid text NOT NULL,
 config_hash text, session_identity jsonb NOT NULL, policy_source text NOT NULL CHECK (policy_source IN ('ENTRY_RESERVATION','DISABLED_ADOPTION')),
 exit_before_close_minutes integer NOT NULL CHECK (exit_before_close_minutes BETWEEN 15 AND 60),
 session_date text NOT NULL, session_start timestamptz NOT NULL, session_end timestamptz NOT NULL,
 exit_deadline timestamptz NOT NULL, session_generation bigint NOT NULL,
 status text NOT NULL DEFAULT 'UNAVAILABLE', observation jsonb, observed_at timestamptz,
 terminal_proof jsonb, terminal_fingerprint text,
 automatic_request_id uuid, automatic_limit_price double precision, automatic_claimed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (session_start < exit_deadline AND exit_deadline < session_end),
 CHECK ((automatic_request_id IS NULL AND automatic_limit_price IS NULL AND automatic_claimed_at IS NULL) OR
        (automatic_request_id IS NOT NULL AND automatic_limit_price > 0 AND automatic_claimed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lifecycle_supervision_account ON lifecycle_supervision(account_id);
CREATE TABLE IF NOT EXISTS lifecycle_observer_health (
 account_id text PRIMARY KEY, session_id text NOT NULL, observed_at timestamptz NOT NULL,
 healthy boolean NOT NULL, reason text
);
CREATE OR REPLACE FUNCTION protect_lifecycle_supervision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'lifecycle supervision is durable'; END IF;
 IF ROW(NEW.original_proposal_id,NEW.account_id,NEW.original_hash,NEW.instrument_id,NEW.conid,NEW.config_hash,NEW.session_identity,NEW.policy_source,NEW.exit_before_close_minutes,NEW.session_date,NEW.session_start)
 IS DISTINCT FROM ROW(OLD.original_proposal_id,OLD.account_id,OLD.original_hash,OLD.instrument_id,OLD.conid,OLD.config_hash,OLD.session_identity,OLD.policy_source,OLD.exit_before_close_minutes,OLD.session_date,OLD.session_start)
 OR NEW.exit_deadline > OLD.exit_deadline OR NEW.session_end > OLD.session_end
 OR (OLD.automatic_request_id IS NOT NULL AND ROW(NEW.automatic_request_id,NEW.automatic_limit_price,NEW.automatic_claimed_at) IS DISTINCT FROM ROW(OLD.automatic_request_id,OLD.automatic_limit_price,OLD.automatic_claimed_at))
 OR (OLD.terminal_proof IS NOT NULL AND ROW(NEW.terminal_proof,NEW.terminal_fingerprint) IS DISTINCT FROM ROW(OLD.terminal_proof,OLD.terminal_fingerprint))
 THEN RAISE EXCEPTION 'lifecycle policy identity is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lifecycle_supervision_immutable ON lifecycle_supervision;
CREATE TRIGGER lifecycle_supervision_immutable BEFORE UPDATE OR DELETE ON lifecycle_supervision FOR EACH ROW EXECUTE FUNCTION protect_lifecycle_supervision();
