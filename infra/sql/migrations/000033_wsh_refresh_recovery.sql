CREATE TABLE research_wsh_refresh_cycles (
 id UUID PRIMARY KEY,
 ledger_key TEXT NOT NULL,
 config_hash TEXT NOT NULL,
 manifest_hash TEXT NOT NULL,
 instrument_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 source_policy_hash TEXT NOT NULL CHECK(source_policy_hash ~ '^[a-f0-9]{64}$'),
 started_at TIMESTAMPTZ NOT NULL,
 next_regular_at TIMESTAMPTZ NOT NULL,
 CHECK(next_regular_at=started_at+interval '15 minutes'),
 FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE INDEX research_wsh_refresh_cycles_issuer ON research_wsh_refresh_cycles(ledger_key,started_at DESC);
CREATE TABLE research_wsh_refresh_attempts (
 id UUID PRIMARY KEY,
 cycle_id UUID NOT NULL REFERENCES research_wsh_refresh_cycles(id),
 ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
 predecessor_id UUID REFERENCES research_wsh_refresh_attempts(id),
 endpoint_id TEXT NOT NULL,
 session_id TEXT NOT NULL UNIQUE,
 started_at TIMESTAMPTZ NOT NULL,
 deadline_at TIMESTAMPTZ NOT NULL,
 finished_at TIMESTAMPTZ,
 preflight_complete BOOLEAN NOT NULL DEFAULT FALSE,
 verified_local_closure BOOLEAN NOT NULL DEFAULT FALSE,
 acquisition_id UUID UNIQUE REFERENCES research_wsh_acquisitions(id),
 state TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','FAILED','UNKNOWN')),
 failure_class TEXT CHECK(failure_class IN ('TRANSIENT','HARD','UNCERTAIN','BUSY','ABORTED','BUDGET')),
 failure_reason TEXT,
 failure_stage TEXT CHECK(failure_stage IN ('connect','metadata','events','normalize','publish','cleanup')),
 source_error JSONB,
 provider_error JSONB,
 cleanup_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(cleanup_state IN ('CONFIRMED','UNKNOWN','NOT_NEEDED')),
 cleanup_completed_at TIMESTAMPTZ,
 cancellation_attempted_at TIMESTAMPTZ,
 disconnect_requested_at TIMESTAMPTZ,
 local_closed_at TIMESTAMPTZ,
 cleanup_error JSONB,
 retry_due_at TIMESTAMPTZ,
 retained BOOLEAN NOT NULL DEFAULT FALSE,
 result_hash TEXT CHECK(result_hash ~ '^[a-f0-9]{64}$'),
 result_snapshot_id UUID REFERENCES research_snapshots(id),
 UNIQUE(cycle_id,ordinal),
 CHECK((ordinal=0)=(predecessor_id IS NULL)),
 CHECK(deadline_at=started_at+interval '35 seconds'),
 CHECK((state='STARTED')=(finished_at IS NULL)),
 CHECK(finished_at IS NULL OR finished_at>=started_at),
 CHECK((state IN ('FAILED','UNKNOWN'))=(failure_class IS NOT NULL AND failure_reason IS NOT NULL AND failure_stage IS NOT NULL)),
 CHECK(state<>'SUCCEEDED' OR acquisition_id IS NOT NULL),
 CHECK(retry_due_at IS NULL OR (state='FAILED' AND failure_class='TRANSIENT' AND cleanup_state IN ('CONFIRMED','NOT_NEEDED') AND ordinal<2)),
 CHECK(NOT verified_local_closure OR local_closed_at IS NOT NULL),
 CHECK(cleanup_state<>'NOT_NEEDED' OR NOT verified_local_closure),
 CHECK(acquisition_id IS NULL OR preflight_complete),
 CHECK(cleanup_state<>'CONFIRMED' OR (verified_local_closure AND local_closed_at IS NOT NULL AND cleanup_completed_at IS NOT NULL)),
 CHECK(state<>'UNKNOWN' OR failure_class='UNCERTAIN'),
 CHECK(cleanup_state<>'NOT_NEEDED' OR acquisition_id IS NULL),
 CHECK(cleanup_completed_at IS NULL OR ((local_closed_at IS NULL OR local_closed_at<=cleanup_completed_at) AND (cancellation_attempted_at IS NULL OR cancellation_attempted_at<=cleanup_completed_at) AND (disconnect_requested_at IS NULL OR disconnect_requested_at<=cleanup_completed_at))),
 CHECK(NOT retained OR state IN ('FAILED','UNKNOWN'))
);
CREATE INDEX research_wsh_refresh_attempts_due ON research_wsh_refresh_attempts(retry_due_at) WHERE retry_due_at IS NOT NULL;
CREATE FUNCTION research_wsh_refresh_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'STARTED' THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_IMMUTABLE'; END IF;
 IF ROW(NEW.id,NEW.cycle_id,NEW.ordinal,NEW.predecessor_id,NEW.endpoint_id,NEW.session_id,NEW.started_at,NEW.deadline_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.cycle_id,OLD.ordinal,OLD.predecessor_id,OLD.endpoint_id,OLD.session_id,OLD.started_at,OLD.deadline_at)
   OR (OLD.preflight_complete AND NOT NEW.preflight_complete)
   OR (OLD.acquisition_id IS NOT NULL AND NEW.acquisition_id IS DISTINCT FROM OLD.acquisition_id)
 THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_IDENTITY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_refresh_attempt_guard BEFORE UPDATE OR DELETE ON research_wsh_refresh_attempts FOR EACH ROW EXECUTE FUNCTION research_wsh_refresh_attempt_guard();
CREATE TRIGGER research_wsh_refresh_attempt_no_truncate BEFORE TRUNCATE ON research_wsh_refresh_attempts FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_wsh_refresh_cycle_immutable BEFORE UPDATE OR DELETE ON research_wsh_refresh_cycles FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_wsh_refresh_cycle_no_truncate BEFORE TRUNCATE ON research_wsh_refresh_cycles FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
CREATE FUNCTION research_wsh_cycle_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior TIMESTAMPTZ;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('research-wsh-issuer:'||NEW.ledger_key)::bigint);
 SELECT max(next_regular_at) INTO prior FROM research_wsh_refresh_cycles WHERE ledger_key=NEW.ledger_key;
 IF prior IS NOT NULL AND NEW.started_at<prior THEN RAISE EXCEPTION 'RESEARCH_WSH_SLOT_TOO_EARLY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_cycle_admission BEFORE INSERT ON research_wsh_refresh_cycles FOR EACH ROW EXECUTE FUNCTION research_wsh_cycle_admission();
CREATE FUNCTION research_wsh_attempt_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle research_wsh_refresh_cycles%ROWTYPE; previous research_wsh_refresh_attempts%ROWTYPE;
BEGIN
 SELECT * INTO STRICT cycle FROM research_wsh_refresh_cycles WHERE id=NEW.cycle_id;
 PERFORM pg_advisory_xact_lock(hashtext('research-wsh-issuer:'||cycle.ledger_key)::bigint);
 IF NEW.state<>'STARTED' OR NEW.preflight_complete OR NEW.verified_local_closure OR NEW.started_at<cycle.started_at OR NEW.started_at>=cycle.next_regular_at
    OR EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE (c.ledger_key=cycle.ledger_key OR a.endpoint_id=NEW.endpoint_id) AND a.state='STARTED')
 THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_ACTIVE_OR_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE (c.ledger_key=cycle.ledger_key OR a.endpoint_id=NEW.endpoint_id) AND a.state<>'STARTED' AND a.cleanup_state='UNKNOWN' AND (NOT a.verified_local_closure OR NEW.ordinal>0 OR NEW.started_at<c.next_regular_at)) THEN RAISE EXCEPTION 'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED'; END IF;
 IF NEW.ordinal=0 THEN
   IF NEW.started_at<>cycle.started_at THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_IDENTITY'; END IF;
 ELSE
   SELECT * INTO STRICT previous FROM research_wsh_refresh_attempts WHERE id=NEW.predecessor_id;
   IF previous.cycle_id<>NEW.cycle_id OR previous.ordinal<>NEW.ordinal-1 OR previous.retry_due_at IS NULL OR NEW.started_at<previous.retry_due_at
   THEN RAISE EXCEPTION 'RESEARCH_WSH_RETRY_UNAVAILABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_attempt_admission BEFORE INSERT ON research_wsh_refresh_attempts FOR EACH ROW EXECUTE FUNCTION research_wsh_attempt_admission();
