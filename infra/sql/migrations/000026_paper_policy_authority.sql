CREATE TABLE paper_policy_events (
 id bigserial PRIMARY KEY,
 account_id text NOT NULL REFERENCES paper_entry_budget_adoptions(account_id),
 revision bigint NOT NULL CHECK(revision>0),
 request_id uuid NOT NULL UNIQUE,
 action text NOT NULL CHECK(action IN ('SCHEDULE','CANCEL','ADOPT')),
 request jsonb NOT NULL,
 active_run_id text NOT NULL REFERENCES paper_runs(run_id),
 pending_run_id text REFERENCES paper_runs(run_id),
 effective_date date,
 expires_after_date date,
 actor text NOT NULL,
 evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,revision),
 CHECK((pending_run_id IS NULL AND effective_date IS NULL AND expires_after_date IS NULL) OR
       (pending_run_id IS NOT NULL AND effective_date IS NOT NULL AND expires_after_date>=effective_date))
);
CREATE TRIGGER paper_policy_event_immutable BEFORE UPDATE OR DELETE ON paper_policy_events FOR EACH ROW EXECUTE FUNCTION paper_budget_immutable();
CREATE TRIGGER paper_policy_event_no_truncate BEFORE TRUNCATE ON paper_policy_events FOR EACH STATEMENT EXECUTE FUNCTION paper_budget_immutable();
CREATE TABLE paper_policy_authorities (
 account_id text PRIMARY KEY REFERENCES paper_entry_budget_adoptions(account_id),
 revision bigint NOT NULL CHECK(revision>0),
 active_run_id text NOT NULL REFERENCES paper_runs(run_id),
 pending_run_id text REFERENCES paper_runs(run_id),
 effective_date date,
 expires_after_date date,
 FOREIGN KEY(account_id,revision) REFERENCES paper_policy_events(account_id,revision)
);
CREATE FUNCTION paper_policy_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e paper_policy_events; prior paper_runs; target paper_runs; today date := (clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAPER_POLICY_AUTHORITY_DURABLE'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('snap:'||NEW.account_id));
 SELECT * INTO e FROM paper_policy_events WHERE account_id=NEW.account_id AND revision=NEW.revision;
 IF NOT FOUND OR ROW(NEW.active_run_id,NEW.pending_run_id,NEW.effective_date,NEW.expires_after_date)
   IS DISTINCT FROM ROW(e.active_run_id,e.pending_run_id,e.effective_date,e.expires_after_date)
   OR (TG_OP='INSERT' AND NEW.revision<>1) OR (TG_OP='UPDATE' AND (NEW.account_id<>OLD.account_id OR NEW.revision<>OLD.revision+1))
 THEN RAISE EXCEPTION 'PAPER_POLICY_AUTHORITY_EVENT_MISMATCH'; END IF;
 SELECT * INTO prior FROM paper_runs WHERE run_id=NEW.active_run_id;
 IF prior.account_id<>NEW.account_id THEN RAISE EXCEPTION 'PAPER_POLICY_ACCOUNT_MISMATCH'; END IF;
 IF TG_OP='INSERT' AND (e.action<>'SCHEDULE' OR prior.manifest->>'version'<>'1' OR prior.manifest->>'kind'<>'supervised_one_attempt') THEN RAISE EXCEPTION 'PAPER_POLICY_PRIOR_REQUIRED'; END IF;
 IF e.action='SCHEDULE' THEN
   SELECT * INTO target FROM paper_runs WHERE run_id=NEW.pending_run_id;
   IF NOT FOUND OR target.account_id<>NEW.account_id OR NEW.effective_date<=today OR
      (TG_OP='UPDATE' AND (OLD.pending_run_id IS NOT NULL OR NEW.active_run_id<>OLD.active_run_id))
   THEN RAISE EXCEPTION 'PAPER_POLICY_SCHEDULE_CONFLICT'; END IF;
 ELSIF TG_OP='INSERT' OR OLD.pending_run_id IS NULL OR NEW.pending_run_id IS NOT NULL THEN
   RAISE EXCEPTION 'PAPER_POLICY_PENDING_REQUIRED';
 ELSIF e.action='CANCEL' THEN
   IF today>=OLD.effective_date OR NEW.active_run_id<>OLD.active_run_id THEN RAISE EXCEPTION 'PAPER_POLICY_CANCEL_TOO_LATE'; END IF;
 ELSIF e.action='ADOPT' THEN
   IF today<OLD.effective_date OR today>OLD.expires_after_date OR NEW.active_run_id<>OLD.pending_run_id THEN RAISE EXCEPTION 'PAPER_POLICY_ADOPTION_OUTSIDE_DATES'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_policy_authority_guard BEFORE INSERT OR UPDATE OR DELETE ON paper_policy_authorities FOR EACH ROW EXECUTE FUNCTION paper_policy_authority_guard();
CREATE TRIGGER paper_policy_authority_no_truncate BEFORE TRUNCATE ON paper_policy_authorities FOR EACH STATEMENT EXECUTE FUNCTION paper_budget_immutable();

CREATE FUNCTION paper_policy_cap(account text, run text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE a paper_policy_authorities; r paper_runs; today date := (clock_timestamp() AT TIME ZONE 'Europe/Warsaw')::date;
BEGIN
 SELECT * INTO r FROM paper_runs WHERE run_id=run AND account_id=account;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAPER_POLICY_RUN_UNREGISTERED'; END IF;
 SELECT * INTO a FROM paper_policy_authorities WHERE account_id=account;
 IF NOT FOUND THEN
   IF r.manifest->>'version'='1' AND r.manifest->>'kind'='supervised_one_attempt' AND r.manifest->>'maxAttemptsPerAccountDay'='1' THEN RETURN 1; END IF;
   RAISE EXCEPTION 'PAPER_POLICY_ADOPTION_REQUIRED';
 END IF;
 IF a.active_run_id<>run OR (a.pending_run_id IS NOT NULL AND today>=a.effective_date) THEN RAISE EXCEPTION 'PAPER_POLICY_AUTHORITY_MISMATCH'; END IF;
 IF r.manifest->>'version'='1' AND r.manifest->>'kind'='supervised_one_attempt' AND r.manifest->>'maxAttemptsPerAccountDay'='1' THEN RETURN 1; END IF;
 IF r.manifest->>'version'='2' AND r.manifest->>'kind'='bounded_scheduled' AND r.manifest->>'maxAttemptsPerAccountDay'='2'
   AND today BETWEEN (r.manifest->>'effectiveAccountDate')::date AND (r.manifest->>'expiresAfterAccountDate')::date THEN RETURN 2; END IF;
 RAISE EXCEPTION 'PAPER_POLICY_EXPIRED_OR_INVALID';
END $$;

CREATE OR REPLACE FUNCTION paper_budget_check_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding RECORD; cap integer;
BEGIN
  IF NEW.source='legacy' THEN
    IF EXISTS(SELECT 1 FROM paper_entry_budget_adoptions WHERE account_id=NEW.account_id) THEN RAISE EXCEPTION 'PAPER_LEGACY_WRITER_DISABLED'; END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('snap:'||NEW.account_id));
  PERFORM pg_advisory_xact_lock(hashtext('paper:'||NEW.account_id||':ibkr:'||NEW.conid));
  IF EXISTS(SELECT 1 FROM paper_entry_migration_holds WHERE account_id IS NULL OR account_id=NEW.account_id) THEN RAISE EXCEPTION 'PAPER_BUDGET_MIGRATION_HOLD'; END IF;
  SELECT b.*,r.account_id,r.run_id AS bound_run INTO binding FROM paper_run_proposals b JOIN paper_runs r USING(run_id) WHERE b.proposed_order_id=NEW.proposed_order_id;
  IF NOT FOUND OR ROW(binding.account_id,binding.conid,binding.session_timezone,binding.bound_run) IS DISTINCT FROM ROW(NEW.account_id,NEW.conid,NEW.session_timezone,NEW.run_id)
    OR NEW.attempted_at<binding.starts_at OR NEW.attempted_at>=binding.ends_at
    OR abs(extract(epoch FROM clock_timestamp()-NEW.attempted_at))>1 THEN RAISE EXCEPTION 'PAPER_BUDGET_ATTEMPT_BINDING_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM paper_entry_attempts WHERE account_id=NEW.account_id AND broker=NEW.broker AND conid=NEW.conid AND session_timezone<>NEW.session_timezone) THEN RAISE EXCEPTION 'PAPER_BUDGET_TIMEZONE_CHANGED'; END IF;
  cap := paper_policy_cap(NEW.account_id,NEW.run_id);
  IF (SELECT count(*) FROM paper_entry_attempts WHERE account_id=NEW.account_id AND account_date=NEW.account_date)>=cap
    OR EXISTS(SELECT 1 FROM paper_entry_attempts WHERE account_id=NEW.account_id AND broker=NEW.broker AND conid=NEW.conid
      AND (account_date=NEW.account_date OR session_date=NEW.session_date))
    OR EXISTS(SELECT 1 FROM paper_entry_legacy_day_debts WHERE account_id=NEW.account_id AND charged_date=NEW.account_date)
    THEN RAISE EXCEPTION 'PAPER_BUDGET_CONSUMED'; END IF;
  IF cap=2 AND EXISTS(SELECT 1 FROM paper_entry_attempts a LEFT JOIN lifecycle_supervision s ON s.original_proposal_id=a.proposed_order_id
    WHERE a.account_id=NEW.account_id AND (s.original_proposal_id IS NULL OR s.status NOT IN ('FLAT','TERMINAL_UNFILLED') OR s.terminal_proof IS NULL))
    THEN RAISE EXCEPTION 'PAPER_BUDGET_ACTIVE_ATTEMPT'; END IF;
  RETURN NEW;
END $$;
