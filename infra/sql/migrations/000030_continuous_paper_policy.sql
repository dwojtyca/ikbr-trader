-- V3 changes only explicit recurring authority. Historical rows and quotas remain durable.
ALTER TABLE paper_run_proposals ADD COLUMN session_binding jsonb;
ALTER TABLE paper_run_proposals DROP CONSTRAINT paper_run_proposals_check;
ALTER TABLE paper_run_proposals ADD CONSTRAINT paper_run_proposals_interval CHECK(ends_at>starts_at);

CREATE FUNCTION paper_recurring_manifest_valid(r paper_runs) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE m jsonb := r.manifest; item jsonb; config jsonb; instruments jsonb; caps jsonb; k text;
BEGIN
 IF m IS DISTINCT FROM r.canonical_manifest::jsonb OR r.manifest_hash IS DISTINCT FROM encode(sha256(convert_to(r.canonical_manifest,'UTF8')),'hex') OR m->>'version' IS DISTINCT FROM '3' OR m->>'kind' IS DISTINCT FROM 'recurring_sessions' OR
    m->>'runId' IS DISTINCT FROM r.run_id OR m->>'accountId' IS DISTINCT FROM r.account_id OR
    m->>'effectiveConfigHash' IS DISTINCT FROM r.effective_config_hash OR m->>'accountDayTimeZone' IS DISTINCT FROM 'Europe/Warsaw' OR
    NOT (m ? 'maxAttemptsPerAccountDay') OR jsonb_typeof(m->'maxAttemptsPerAccountDay') IS DISTINCT FROM 'null' OR
    NOT (m ? 'maxAttemptsPerInstrumentDay') OR jsonb_typeof(m->'maxAttemptsPerInstrumentDay') IS DISTINCT FROM 'null' OR
    jsonb_typeof(m->'instruments') IS DISTINCT FROM 'array' OR jsonb_typeof(m->'currencyCaps') IS DISTINCT FROM 'object' OR
    jsonb_typeof(m->'exitBeforeCloseMinutes') IS DISTINCT FROM 'number' OR (m->>'exitBeforeCloseMinutes') !~ '^[0-9]+$' OR
    (m->>'exitBeforeCloseMinutes')::integer NOT BETWEEN 15 AND 60 OR
    COALESCE(m->>'effectiveAccountDate','') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' OR
    COALESCE(m->>'adoptionDeadlineAccountDate','') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['runId','accountId','effectiveConfigHash','accountDayTimeZone','kind','effectiveAccountDate','adoptionDeadlineAccountDate'] LOOP
   IF jsonb_typeof(m->k) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 END LOOP;
 IF (m->>'adoptionDeadlineAccountDate')::date < (m->>'effectiveAccountDate')::date OR jsonb_array_length(m->'instruments') NOT BETWEEN 1 AND 2 THEN RETURN false; END IF;
 SELECT canonical_json::jsonb->'configuration' INTO config FROM trading_configuration_snapshots WHERE effective_hash=r.effective_config_hash;
 instruments := config->'instruments';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(instruments) i JOIN jsonb_array_elements(config->'accountPolicies') a ON a->>'id'=i->>'accountPolicyId' WHERE i->>'entryEnabled'='true' AND (a->>'maxOpenPositions')::integer<jsonb_array_length(m->'instruments')) THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(m))<>13 OR jsonb_typeof(m->'version') IS DISTINCT FROM 'number' OR instruments IS NULL OR (SELECT count(DISTINCT x->>'conId') FROM jsonb_array_elements(m->'instruments') x)<>jsonb_array_length(m->'instruments') THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(m->'instruments') LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>2 OR jsonb_typeof(item->'instrumentId') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'conId') IS DISTINCT FROM 'number' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(instruments) i JOIN jsonb_array_elements(config->'entryPolicies') p ON p->>'id'=i->>'entryPolicyId'
     WHERE i->>'id'=item->>'instrumentId' AND i->'contract'->'conId'=item->'conId' AND i->>'entryEnabled'='true'
       AND p->>'kind'='recurring_sessions' AND p ? 'maxAttemptsPerAccountDay' AND jsonb_typeof(p->'maxAttemptsPerAccountDay')='null') THEN RETURN false; END IF;
 END LOOP;
 FOR k,caps IN SELECT key,value FROM jsonb_each(m->'currencyCaps') LOOP
   IF k NOT IN ('PLN','USD') OR jsonb_typeof(caps)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(caps))<>4 THEN RETURN false; END IF;
   FOREACH k IN ARRAY ARRAY['maxNotional','maxStopRisk','feeReserve','maxDailyLoss'] LOOP
     IF jsonb_typeof(caps->k) IS DISTINCT FROM 'number' OR (caps->>k)::numeric<=0 THEN RETURN false; END IF;
   END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(instruments) i WHERE i->>'entryEnabled'='true' AND
   (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(m->'instruments') x WHERE x->>'instrumentId'=i->>'id' AND x->'conId'=i->'contract'->'conId') OR NOT (m->'currencyCaps' ? (i->'contract'->>'currency')))) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE FUNCTION paper_proposal_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r paper_runs; b jsonb := NEW.session_binding; e jsonb; s record; interval_row jsonb; now_stamp timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO r FROM paper_runs WHERE run_id=NEW.run_id;
 IF r.manifest->>'version'<>'3' THEN
   IF NEW.ends_at>NEW.starts_at+interval '60 minutes' OR b IS NOT NULL THEN RAISE EXCEPTION 'PAPER_BUDGET_LEGACY_WINDOW_INVALID'; END IF;
   RETURN NEW;
 END IF;
 IF NOT paper_recurring_manifest_valid(r) OR b IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.manifest->'instruments') i WHERE i->>'instrumentId'=NEW.instrument_id AND i->>'conId'=NEW.conid) THEN RAISE EXCEPTION 'PAPER_BUDGET_SESSION_BINDING_INVALID'; END IF;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR jsonb_typeof(b->'evidence') IS DISTINCT FROM 'object' OR jsonb_typeof(b->'canonical') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'hash') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'PAPER_BUDGET_SESSION_EVIDENCE_INVALID'; END IF;
 e:=b->'evidence';
 SELECT * INTO s FROM instrument_session_schedules WHERE instrument_id=NEW.instrument_id AND conid=NEW.conid AND use_rth=true FOR SHARE;
 IF NOT FOUND OR jsonb_typeof(e->'generation') IS DISTINCT FROM 'number' OR jsonb_typeof(e->'updatedAt') IS DISTINCT FROM 'string' OR s.status IS DISTINCT FROM 'READY' OR e->>'status' IS DISTINCT FROM 'READY' OR (e->>'generation')::bigint IS DISTINCT FROM s.generation OR e->'schedule' IS DISTINCT FROM s.evidence OR
    (e->>'updatedAt')::timestamptz IS DISTINCT FROM s.updated_at OR b->>'canonical' IS NULL OR (b->>'canonical')::jsonb IS DISTINCT FROM e OR
    b->>'hash' IS DISTINCT FROM encode(sha256(convert_to(b->>'canonical','UTF8')),'hex') OR
    s.updated_at>now_stamp OR s.updated_at<now_stamp-interval '6 hours' OR (s.evidence->>'receivedAt')::timestamptz>now_stamp OR (s.evidence->>'receivedAt')::timestamptz<now_stamp-interval '6 hours' OR
    s.evidence->'identity'->>'instrumentId' IS DISTINCT FROM NEW.instrument_id OR s.evidence->'identity'->>'conId' IS DISTINCT FROM NEW.conid OR s.evidence->'identity'->>'timeZone' IS DISTINCT FROM NEW.session_timezone OR
    b->>'exitBeforeCloseMinutes' IS DISTINCT FROM r.manifest->>'exitBeforeCloseMinutes' THEN RAISE EXCEPTION 'PAPER_BUDGET_SESSION_EVIDENCE_INVALID'; END IF;
 SELECT x INTO interval_row FROM jsonb_array_elements(s.evidence->'sessions') x WHERE x->>'date'=b->>'sessionDate' AND x->>'start'=b->>'sessionStart' AND x->>'end'=b->>'sessionEnd';
 IF interval_row IS NULL OR NEW.starts_at<>(b->>'sessionStart')::timestamptz OR NEW.ends_at<>(b->>'sessionEnd')::timestamptz-make_interval(mins=>(b->>'exitBeforeCloseMinutes')::integer) OR now_stamp<NEW.starts_at OR now_stamp>=NEW.ends_at OR
    (NEW.starts_at AT TIME ZONE 'Europe/Warsaw')::date<>(((b->>'sessionEnd')::timestamptz-interval '1 millisecond') AT TIME ZONE 'Europe/Warsaw')::date THEN RAISE EXCEPTION 'PAPER_BUDGET_SESSION_INTERVAL_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paper_proposal_session_guard BEFORE INSERT ON paper_run_proposals FOR EACH ROW EXECUTE FUNCTION paper_proposal_session_guard();

CREATE OR REPLACE FUNCTION paper_policy_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
   IF NOT FOUND OR target.account_id<>NEW.account_id OR (CASE WHEN target.manifest->>'version'='3' THEN NOT paper_recurring_manifest_valid(target) OR NEW.effective_date>today OR NEW.expires_after_date<today OR NEW.effective_date<>(target.manifest->>'effectiveAccountDate')::date OR NEW.expires_after_date<>(target.manifest->>'adoptionDeadlineAccountDate')::date ELSE NEW.effective_date<=today END) OR
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

CREATE OR REPLACE FUNCTION paper_policy_cap(account text, run text) RETURNS integer LANGUAGE plpgsql AS $$
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
 IF paper_recurring_manifest_valid(r) AND today >= (r.manifest->>'effectiveAccountDate')::date THEN RETURN NULL; END IF;
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
  IF (cap IS NOT NULL AND ((SELECT count(*) FROM paper_entry_attempts WHERE account_id=NEW.account_id AND account_date=NEW.account_date)>=cap
    OR EXISTS(SELECT 1 FROM paper_entry_attempts WHERE account_id=NEW.account_id AND broker=NEW.broker AND conid=NEW.conid
      AND (account_date=NEW.account_date OR session_date=NEW.session_date))
    ))
    OR EXISTS(SELECT 1 FROM paper_entry_legacy_day_debts WHERE account_id=NEW.account_id AND charged_date=NEW.account_date)
    THEN RAISE EXCEPTION 'PAPER_BUDGET_CONSUMED'; END IF;
  IF (cap=2 OR cap IS NULL) AND EXISTS(SELECT 1 FROM paper_entry_attempts a LEFT JOIN lifecycle_supervision s ON s.original_proposal_id=a.proposed_order_id
    WHERE a.account_id=NEW.account_id AND (cap IS NOT NULL OR a.conid=NEW.conid OR s.status IS DISTINCT FROM 'PROTECTED' OR s.observed_at IS NULL OR s.observed_at > clock_timestamp() OR s.observed_at < clock_timestamp()-interval '10 seconds') AND (s.original_proposal_id IS NULL OR s.status NOT IN ('FLAT','TERMINAL_UNFILLED') OR s.terminal_proof IS NULL))
    THEN RAISE EXCEPTION 'PAPER_BUDGET_ACTIVE_ATTEMPT'; END IF;
  RETURN NEW;
END $$;
