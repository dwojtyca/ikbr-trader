DO $$ DECLARE expected RECORD;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('research_source_demand(text,text,text,text,text,timestamp with time zone)','794b68709128cda10da3c266eac95910054427041ec91646473946ab2fd4c4a4'),
  ('research_source_demand_admission(bigint,text,text,text,text,text,timestamp with time zone)','476f27f763b61428133eba7698fd59496535149d660930c71ccc83cae2e0168a')
 ) AS v(signature,hash) LOOP
  IF encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(expected.signature)),'UTF8')),'hex') IS DISTINCT FROM expected.hash
  THEN RAISE EXCEPTION 'RESEARCH_STARTUP_BASELINE_MISMATCH: %',expected.signature;END IF;
 END LOOP;
END $$;
-- Explicit startup observation is one-shot authority; historical source rows remain intact.
CREATE TABLE research_startup_source_requests (
 id BIGSERIAL PRIMARY KEY,
 account_id TEXT NOT NULL,
 pause_revision BIGINT NOT NULL,
 config_hash TEXT NOT NULL,
 manifest_hash TEXT NOT NULL,
 instrument_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('news','calendar')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 predecessor_id UUID,
 head_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('PENDING','FRESH','JOINED','CLAIMED','SUPERSEDED')),
 attempt_id UUID,
 disposed_at TIMESTAMPTZ,
 FOREIGN KEY(account_id,pause_revision) REFERENCES execution_entry_control_events(account_id,revision),
 FOREIGN KEY(config_hash,manifest_hash) REFERENCES research_manifests(config_hash,manifest_hash),
 UNIQUE(account_id,pause_revision,config_hash,manifest_hash,instrument_id,source_id,role),
 CHECK((state='PENDING')=(disposed_at IS NULL)),
 CHECK((state IN ('JOINED','CLAIMED'))=(attempt_id IS NOT NULL))
);
CREATE INDEX research_startup_pending_source ON research_startup_source_requests(account_id,config_hash,manifest_hash,instrument_id,source_id) WHERE state='PENDING';
CREATE INDEX research_startup_claimed_attempt ON research_startup_source_requests(attempt_id) WHERE state='CLAIMED';

CREATE FUNCTION research_startup_current(p_account TEXT,p_revision BIGINT,p_lock BOOLEAN DEFAULT FALSE) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
 IF p_lock THEN
  SELECT * INTO c FROM execution_entry_controls WHERE account_id=p_account FOR SHARE NOWAIT;
 ELSE SELECT * INTO c FROM execution_entry_controls WHERE account_id=p_account; END IF;
 RETURN (c.paused AND c.revision=p_revision AND EXISTS(SELECT 1 FROM execution_entry_control_events e
  WHERE e.account_id=p_account AND e.revision=p_revision AND e.paused
   AND e.reason ~* '^paper-start:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) IS TRUE;
END $$;

CREATE FUNCTION research_startup_history(p_account TEXT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT)
RETURNS TABLE(id UUID,started_at TIMESTAMPTZ,deadline_at TIMESTAMPTZ,state TEXT,retry_due_at TIMESTAMPTZ,cycle_end TIMESTAMPTZ,recovered_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
 SELECT h.id,h.started_at,h.deadline_at,h.state,h.retry_due_at,h.cycle_end,h.recovered_at
 FROM research_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.canonical_json::jsonb->'instruments') i
 CROSS JOIN LATERAL jsonb_array_elements(i->'sources') s
 CROSS JOIN LATERAL research_source_attempt_history(p_account,
  CASE WHEN s->>'adapter'='ibkr-wsh' THEN 'ibkr-wsh:'||(s->'parserConfig'->>'isin')
   ELSE 'marketaux:ibkr-conid:'||(s->'parserConfig'->'qualification'->>'conId') END,s->>'adapter'='ibkr-wsh') h
 WHERE m.config_hash=p_config AND m.manifest_hash=p_manifest AND i->>'instrumentId'=p_instrument AND s->>'id'=p_source
 AND ROW(h.config_hash,h.manifest_hash,h.instrument_id,h.source_id)=ROW(p_config,p_manifest,p_instrument,p_source)
 AND (s->>'adapter'<>'ibkr-wsh' OR EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE a.id=h.id AND c.account_id=p_account))
 ORDER BY h.started_at DESC,h.id DESC
$$;

CREATE FUNCTION research_startup_wsh_refusal(p_id UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
 JOIN research_wsh_acquisitions ac ON ac.id=a.acquisition_id
 JOIN research_snapshots snap ON snap.id=a.result_snapshot_id
 WHERE a.id=p_id AND a.state='FAILED' AND a.failure_class='HARD'
 AND a.failure_stage IN ('metadata','events') AND a.cleanup_state IN ('CONFIRMED','NOT_NEEDED')
 AND a.failure_reason IN ('RESEARCH_WSH_ERROR_10276','RESEARCH_WSH_ERROR_10277')
 AND a.provider_error->'code'=to_jsonb(replace(a.failure_reason,'RESEARCH_WSH_ERROR_','')::integer)
 AND ac.state='FAILED' AND ac.retired_at IS NOT NULL AND ac.snapshot_id=a.result_snapshot_id
 AND ROW(snap.config_hash,snap.manifest_hash,snap.instrument_id)=ROW(c.config_hash,c.manifest_hash,c.instrument_id)
 AND a.cleanup_completed_at IS NOT NULL AND a.cleanup_completed_at<=a.finished_at
 AND (a.cleanup_state='NOT_NEEDED' OR a.verified_local_closure AND a.local_closed_at IS NOT NULL AND a.local_closed_at<=a.cleanup_completed_at)
 AND (SELECT count(*) FROM research_wsh_acquisition_calls x WHERE x.acquisition_id=ac.id)=CASE a.failure_stage WHEN 'metadata' THEN 1 ELSE 2 END
 AND (a.failure_stage='metadata' OR EXISTS(SELECT 1 FROM research_wsh_acquisition_calls x JOIN research_call_reservations r USING(call_key) JOIN research_call_outcomes o USING(call_key) WHERE x.acquisition_id=ac.id AND o.outcome='SUCCEEDED' AND o.recorded_at<r.deadline_at AND o.recorded_at<=(SELECT min(r2.reserved_at) FROM research_wsh_acquisition_calls x2 JOIN research_call_reservations r2 USING(call_key) JOIN research_call_outcomes o2 USING(call_key) WHERE x2.acquisition_id=ac.id AND o2.outcome='FAILED')))
 AND ROW(ac.config_hash,ac.manifest_hash,ac.instrument_id,ac.source_id,ac.session_id,ac.endpoint_id)
  =ROW(c.config_hash,c.manifest_hash,c.instrument_id,c.source_id,a.session_id,a.endpoint_id)
 AND encode(sha256(convert_to(snap.canonical_json,'UTF8')),'hex')=snap.snapshot_hash
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(snap.canonical_json::jsonb->'coverage') v
  WHERE v->>'sourceId'=c.source_id AND v->>'status'='ERROR' AND v->>'complete'='false'
   AND v->>'reason'=a.failure_reason AND v->'providerError'=a.provider_error)
 AND EXISTS(SELECT 1 FROM research_wsh_acquisition_calls x JOIN research_call_outcomes o USING(call_key)
  WHERE x.acquisition_id=ac.id AND o.outcome='FAILED')
 AND NOT EXISTS(SELECT 1 FROM research_wsh_acquisition_calls x LEFT JOIN research_call_reservations r USING(call_key)
  LEFT JOIN research_call_outcomes o USING(call_key) WHERE x.acquisition_id=ac.id AND
  (o.outcome IS NULL OR o.outcome NOT IN ('SUCCEEDED','FAILED') OR o.recorded_at>a.finished_at
   OR ROW(r.account_id,r.provider,r.config_hash,r.manifest_hash) IS DISTINCT FROM ROW(c.account_id,'ibkr-wsh'::text,c.config_hash,c.manifest_hash))))
$$;

CREATE FUNCTION research_startup_request_eligible(p_account TEXT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT,p_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE r research_startup_source_requests%ROWTYPE; h RECORD;
BEGIN
 SELECT q.* INTO r FROM research_startup_source_requests q JOIN execution_entry_controls c ON c.account_id=q.account_id AND c.revision=q.pause_revision AND c.paused
 WHERE q.account_id=p_account AND q.config_hash=p_config AND q.manifest_hash=p_manifest AND q.instrument_id=p_instrument AND q.source_id=p_source AND q.state='PENDING';
 IF NOT FOUND OR r.created_at>p_at OR NOT research_startup_current(p_account,r.pause_revision)
  OR NOT EXISTS(SELECT 1 FROM research_authority WHERE config_hash=p_config AND manifest_hash=p_manifest) THEN RETURN FALSE; END IF;
 SELECT * INTO h FROM research_startup_history(p_account,p_config,p_manifest,p_instrument,p_source) LIMIT 1;
 IF FOUND AND h.id IS DISTINCT FROM r.predecessor_id THEN RETURN FALSE; END IF;
 RETURN TRUE;
END $$;

-- Preserve an unmodified ordinary evaluator for the atomic initial observation.
ALTER FUNCTION research_source_demand(TEXT,TEXT,TEXT,TEXT,TEXT,TIMESTAMPTZ) RENAME TO research_source_demand_ordinary;
CREATE OR REPLACE FUNCTION research_source_demand(p_account TEXT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT,p_at TIMESTAMPTZ)
RETURNS TABLE(state TEXT,reason TEXT,next_at TIMESTAMPTZ) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE raw JSONB; policy JSONB; source JSONB; cfg JSONB; wsh BOOLEAN; ledger TEXT; sp RECORD; h RECORD;
 snap RECORD; coverage JSONB; valid BOOLEAN:=FALSE; invalidated BOOLEAN:=FALSE; last_good TIMESTAMPTZ; delay INTEGER;
 startup BOOLEAN:=FALSE; at_time TIMESTAMPTZ; cooldown TIMESTAMPTZ; expiry TIMESTAMPTZ; rec JSONB; used BIGINT; cost BIGINT; max_used BIGINT; max_cost BIGINT; next_cost BIGINT;
BEGIN
 state:='HOLD'; reason:='RESEARCH_SOURCE_DEMAND_UNAVAILABLE'; next_at:=NULL;
 SELECT canonical_json::jsonb INTO raw FROM research_manifests WHERE config_hash=p_config AND manifest_hash=p_manifest;
 IF raw->>'researchPolicy' IS DISTINCT FROM 'TWO_SOURCE_HOURLY_V1' OR raw->>'refreshEnabled' IS DISTINCT FROM 'true'
  OR NOT EXISTS(SELECT 1 FROM research_authority WHERE config_hash=p_config AND manifest_hash=p_manifest) THEN RETURN NEXT; RETURN; END IF;
 SELECT v INTO policy FROM jsonb_array_elements(raw->'instruments') v WHERE v->>'instrumentId'=p_instrument;
 SELECT v INTO source FROM jsonb_array_elements(policy->'sources') v WHERE v->>'id'=p_source;
 cfg:=source->'parserConfig'; wsh:=source->>'adapter'='ibkr-wsh';
 IF (source->>'automation'='PERMITTED' AND source->>'retention'='FACTS_AND_REFERENCES'
  AND policy->'verification'->>'outcome'='VERIFIED' AND (policy->'verification'->>'verifiedAt')::timestamptz<=p_at) IS NOT TRUE
 THEN reason:='RESEARCH_PERMISSION_UNVERIFIED';RETURN NEXT;RETURN;END IF;
 FOR rec IN SELECT cfg->'qualification' UNION ALL SELECT cfg->'entitlement' LOOP
  IF (coalesce(rec->>'validFrom',rec->>'verifiedAt')::timestamptz<=p_at AND (wsh OR rec->>'outcome'='VERIFIED') AND
   ((rec->>'expiresAt' IS NOT NULL AND (rec->>'expiresAt')::timestamptz>p_at) OR
    (rec->'expiresAt'='null'::jsonb AND rec->'validity'->>'mode'='OPERATOR_CONFIRMED_ONGOING'
     AND (rec->'validity'->>'confirmedAt')::timestamptz<=p_at))) IS NOT TRUE
  THEN reason:='RESEARCH_SOURCE_QUALIFICATION_UNAVAILABLE';RETURN NEXT;RETURN;END IF;
  expiry:=least(expiry,(rec->>'expiresAt')::timestamptz);
 END LOOP;
 IF wsh THEN SELECT * INTO sp FROM research_wsh_source_policy(p_config,p_manifest,p_instrument,p_source);
 ELSE SELECT * INTO sp FROM research_marketaux_source_policy(p_config,p_manifest,p_instrument,p_source);END IF;
 ledger:=sp.ledger;
 startup:=research_startup_request_eligible(p_account,p_config,p_manifest,p_instrument,p_source,p_at);
 IF research_recovery_held(p_account,ledger,CASE WHEN wsh THEN cfg->>'endpointId' ELSE NULL END)
 THEN reason:='RESEARCH_RECOVERY_MAINTENANCE_HOLD';RETURN NEXT;RETURN;END IF;
 FOR h IN SELECT * FROM research_source_attempt_history(p_account,ledger,wsh)
  WHERE state IN ('STARTED','FINALIZING','UNKNOWN') AND recovered_at IS NULL ORDER BY started_at DESC LOOP
  reason:='RESEARCH_SOURCE_READ_RECOVERY_PENDING';
  IF h.state='STARTED' AND h.deadline_at>p_at THEN state:='WAITING';next_at:=h.deadline_at;END IF;
  RETURN NEXT;RETURN;
 END LOOP;
 IF wsh AND EXISTS(SELECT 1 FROM research_wsh_read_candidates() v WHERE v->>'ledgerKey'=ledger OR v->>'endpointId'=cfg->>'endpointId')
 THEN reason:='RESEARCH_SOURCE_READ_RECOVERY_PENDING';RETURN NEXT;RETURN;END IF;
 SELECT * INTO h FROM research_source_attempt_history(p_account,ledger,wsh)
  WHERE config_hash=p_config AND manifest_hash=p_manifest AND instrument_id=p_instrument AND source_id=p_source ORDER BY started_at DESC,id DESC LIMIT 1;
 IF FOUND AND h.state<>'SUCCEEDED' THEN
  SELECT EXISTS(SELECT 1 FROM research_source_attempt_history(p_account,ledger,wsh) bad
   WHERE bad.config_hash=p_config AND bad.manifest_hash=p_manifest AND bad.instrument_id=p_instrument AND bad.source_id=p_source
    AND (bad.failure_class IN ('HARD','UNKNOWN','UNCERTAIN') OR bad.recovered_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM research_source_attempt_history(p_account,ledger,wsh) good WHERE good.config_hash=p_config AND good.manifest_hash=p_manifest AND good.instrument_id=p_instrument AND good.source_id=p_source AND good.state='SUCCEEDED' AND good.started_at>bad.started_at)) INTO invalidated;
  IF h.state='FAILED' AND h.recovered_at IS NULL AND research_source_failure_retryable(h.id,wsh) IS NOT TRUE AND NOT (startup AND wsh AND research_startup_wsh_refusal(h.id) AND EXISTS(SELECT 1 FROM research_startup_history(p_account,p_config,p_manifest,p_instrument,p_source) own WHERE own.id=h.id)) THEN reason:='RESEARCH_SOURCE_FAILURE_UNPROVED';RETURN NEXT;RETURN;END IF;
 END IF;
 SELECT s.* INTO snap FROM research_snapshot_heads head JOIN research_snapshots s ON s.id=head.snapshot_id
  WHERE head.config_hash=p_config AND head.manifest_hash=p_manifest AND head.instrument_id=p_instrument;
 IF FOUND THEN
  IF encode(sha256(convert_to(snap.canonical_json,'UTF8')),'hex')<>snap.snapshot_hash THEN reason:='RESEARCH_SOURCE_PROVENANCE_INVALID';RETURN NEXT;RETURN;END IF;
  SELECT v INTO coverage FROM jsonb_array_elements(snap.canonical_json::jsonb->'coverage') v WHERE v->>'sourceId'=p_source;
  IF coverage IS NOT NULL AND ((coverage->>'checkedAt')::timestamptz>p_at OR (coverage->>'windowEnd')::timestamptz>(coverage->>'checkedAt')::timestamptz)
  THEN reason:='RESEARCH_SOURCE_FUTURE';RETURN NEXT;RETURN;END IF;
  IF coverage->>'complete'='true' AND coverage->>'status' IN ('AVAILABLE','EMPTY') THEN
   IF wsh THEN
    valid:=EXISTS(SELECT 1 FROM research_wsh_acquisitions a JOIN research_snapshots original ON original.id=a.snapshot_id WHERE a.id::text=coverage->'wshAcquisition'->>'acquisitionId'
      AND a.state='PUBLISHED' AND a.config_hash=p_config AND a.manifest_hash=p_manifest AND a.instrument_id=p_instrument AND a.source_id=p_source
      AND encode(sha256(convert_to(original.canonical_json,'UTF8')),'hex')=original.snapshot_hash
      AND research_wsh_source_projection(snap.canonical_json,p_source)=research_wsh_source_projection(original.canonical_json,p_source));
   ELSE
    valid:=EXISTS(SELECT 1 FROM research_marketaux_attempts a WHERE a.id::text=coverage->'acquisition'->>'attemptId'
      AND a.state='SUCCEEDED' AND a.account_id=p_account AND a.config_hash=p_config AND a.manifest_hash=p_manifest AND a.instrument_id=p_instrument AND a.source_id=p_source
      AND a.projection_hash=research_marketaux_projection_hash(snap.canonical_json,p_source));
   END IF;
   IF NOT valid THEN reason:='RESEARCH_SOURCE_PROVENANCE_INVALID';RETURN NEXT;RETURN;END IF;
   IF NOT invalidated AND (coverage->>'checkedAt')::timestamptz+interval '24 hours'>p_at AND (expiry IS NULL OR expiry>p_at)
   THEN state:='READY';reason:='RESEARCH_SOURCE_FRESH';RETURN NEXT;RETURN;END IF;
  ELSIF coverage IS NOT NULL THEN
   IF h.id IS NULL THEN reason:='RESEARCH_SOURCE_PROVENANCE_INVALID';RETURN NEXT;RETURN;END IF;
   IF NOT wsh AND NOT EXISTS(SELECT 1 FROM research_marketaux_attempts a WHERE a.id=h.id AND a.state='FAILED'
    AND a.snapshot_id IS NOT NULL AND a.projection_hash=research_marketaux_projection_hash(snap.canonical_json,p_source))
    AND h.recovered_at IS NULL THEN reason:='RESEARCH_SOURCE_PROVENANCE_INVALID';RETURN NEXT;RETURN;END IF;
   IF wsh AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_snapshots original ON original.id=a.result_snapshot_id
    WHERE a.id=h.id AND a.state='FAILED' AND EXISTS(SELECT 1 FROM jsonb_array_elements(original.canonical_json::jsonb->'coverage') c WHERE c->>'sourceId'=p_source AND c=coverage))
    AND h.recovered_at IS NULL THEN reason:='RESEARCH_SOURCE_PROVENANCE_INVALID';RETURN NEXT;RETURN;END IF;
  END IF;
 END IF;
 IF NOT wsh AND research_marketaux_usage_hold(p_account) THEN reason:='RESEARCH_PROVIDER_USAGE_HOLD';RETURN NEXT;RETURN;END IF;
  IF h.retry_due_at IS NOT NULL AND h.cycle_end>p_at AND h.recovered_at IS NULL
  THEN state:='WAITING';reason:='RESEARCH_SOURCE_EXISTING_RETRY';next_at:=greatest(p_at,h.retry_due_at);RETURN NEXT;RETURN;END IF;
 SELECT max(started_at) INTO last_good FROM research_source_attempt_history(p_account,ledger,wsh) WHERE state='SUCCEEDED';
 SELECT count(*) INTO delay FROM (SELECT 1 FROM research_source_attempt_history(p_account,ledger,wsh)
  WHERE started_at>coalesce(last_good,'-infinity'::timestamptz) AND (state='FAILED' OR recovered_at IS NOT NULL)
  ORDER BY started_at DESC LIMIT 3) q;
 SELECT greatest(finished_at,recovered_at) INTO at_time FROM research_source_attempt_history(p_account,ledger,wsh)
  WHERE state='FAILED' OR recovered_at IS NOT NULL ORDER BY started_at DESC,id DESC LIMIT 1;
 next_at:=CASE WHEN startup THEN p_at ELSE greatest(p_at,at_time+CASE delay WHEN 0 THEN interval '0 seconds' WHEN 1 THEN interval '30 seconds' WHEN 2 THEN interval '120 seconds' ELSE interval '10 minutes' END) END;
 IF NOT wsh THEN
  SELECT max(provider_not_before) INTO cooldown FROM research_marketaux_attempts WHERE account_id=p_account;
  next_at:=greatest(next_at,cooldown);
 END IF;
 SELECT min((s->>'maxRequestsPerDay')::bigint),min((s->>'maxCostMicrosPerDay')::bigint),max((s->>'costMicrosPerCall')::bigint)
  INTO max_used,max_cost,next_cost FROM jsonb_array_elements(raw->'instruments') i CROSS JOIN LATERAL jsonb_array_elements(i->'sources') s WHERE s->>'provider'=source->>'provider';
 SELECT count(*),coalesce(sum(reserved_cost_micros),0) INTO used,cost FROM research_call_reservations
  WHERE account_id=p_account AND provider=source->>'provider' AND budget_day=(p_at AT TIME ZONE 'UTC')::date;
 state:='WAITING';reason:='RESEARCH_SOURCE_DEMAND';
 IF used>=max_used OR cost+next_cost>max_cost THEN reason:='RESEARCH_BUDGET_EXHAUSTED';next_at:=greatest(next_at,((p_at AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC');END IF;
 RETURN NEXT;
END $$;

CREATE FUNCTION research_startup_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h RECORD; d RECORD; head TEXT; active BOOLEAN; valid_attempt BOOLEAN;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RESEARCH_STARTUP_HISTORY_IMMUTABLE';END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.account_id,NEW.pause_revision,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id,NEW.role,NEW.created_at,NEW.predecessor_id,NEW.head_id)
   IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.pause_revision,OLD.config_hash,OLD.manifest_hash,OLD.instrument_id,OLD.source_id,OLD.role,OLD.created_at,OLD.predecessor_id,OLD.head_id)
   OR OLD.state<>'PENDING' OR NEW.state='PENDING' OR NEW.disposed_at IS NULL OR NEW.disposed_at<NEW.created_at OR NEW.disposed_at>clock_timestamp()
  THEN RAISE EXCEPTION 'RESEARCH_STARTUP_HISTORY_IMMUTABLE'; END IF;
  IF NEW.state='SUPERSEDED' THEN
   IF research_startup_current(NEW.account_id,NEW.pause_revision) AND EXISTS(SELECT 1 FROM research_authority WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash)
   THEN RAISE EXCEPTION 'RESEARCH_STARTUP_DISPOSITION_INVALID';END IF;
  ELSIF NEW.state='FRESH' THEN
   SELECT * INTO d FROM research_source_demand_ordinary(NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id,clock_timestamp());
   IF d.state IS DISTINCT FROM 'READY' THEN RAISE EXCEPTION 'RESEARCH_STARTUP_DISPOSITION_INVALID';END IF;
  ELSE
   SELECT EXISTS(SELECT 1 FROM research_startup_history(NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id) a
    WHERE a.id=NEW.attempt_id AND a.id IS DISTINCT FROM NEW.predecessor_id AND a.started_at>=NEW.created_at) INTO valid_attempt;
   IF NOT valid_attempt THEN RAISE EXCEPTION 'RESEARCH_STARTUP_DISPOSITION_INVALID';END IF;
   IF NEW.state='CLAIMED' AND NOT (EXISTS(SELECT 1 FROM research_marketaux_attempts a WHERE a.id=NEW.attempt_id AND a.admission_kind='DEMAND'
     AND ROW(a.account_id,a.config_hash,a.manifest_hash,a.instrument_id,a.source_id)=ROW(NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id) AND a.started_at>=NEW.created_at)
    OR EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE a.id=NEW.attempt_id AND c.admission_kind='DEMAND'
     AND ROW(c.account_id,c.config_hash,c.manifest_hash,c.instrument_id,c.source_id)=ROW(NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id) AND a.started_at>=NEW.created_at))
   THEN RAISE EXCEPTION 'RESEARCH_STARTUP_DISPOSITION_INVALID';END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NOT research_startup_current(NEW.account_id,NEW.pause_revision,TRUE) OR NOT EXISTS(SELECT 1 FROM research_authority WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash)
 THEN RAISE EXCEPTION 'RESEARCH_STARTUP_AUTHORITY_INVALID';END IF;
 IF NEW.created_at>clock_timestamp() OR NEW.created_at<clock_timestamp()-interval '3 seconds' THEN RAISE EXCEPTION 'RESEARCH_STARTUP_TIME_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM research_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.canonical_json::jsonb->'instruments') i
 CROSS JOIN LATERAL jsonb_array_elements(i->'sources') s WHERE m.config_hash=NEW.config_hash AND m.manifest_hash=NEW.manifest_hash
  AND m.canonical_json::jsonb->>'researchPolicy'='TWO_SOURCE_HOURLY_V1' AND i->>'instrumentId'=NEW.instrument_id AND s->>'id'=NEW.source_id
  AND s->'roles'=jsonb_build_array(NEW.role)) THEN RAISE EXCEPTION 'RESEARCH_STARTUP_IDENTITY_INVALID';END IF;
 SELECT * INTO h FROM research_startup_history(NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id) LIMIT 1;
 SELECT snapshot_id::text INTO head FROM research_snapshot_heads WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash AND instrument_id=NEW.instrument_id;
 IF NEW.predecessor_id IS DISTINCT FROM h.id OR NEW.head_id IS DISTINCT FROM head THEN RAISE EXCEPTION 'RESEARCH_STARTUP_OBSERVATION_CHANGED';END IF;
 SELECT * INTO d FROM research_source_demand_ordinary(NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id,NEW.created_at);
 active:=h.state='STARTED' AND h.deadline_at>NEW.created_at AND h.recovered_at IS NULL OR h.retry_due_at IS NOT NULL AND h.cycle_end>NEW.created_at AND h.recovered_at IS NULL;
 IF d.state='READY' THEN
  IF NEW.state<>'FRESH' OR NEW.attempt_id IS NOT NULL OR NEW.disposed_at IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'RESEARCH_STARTUP_DISPOSITION_INVALID';END IF;
 ELSIF active IS TRUE THEN
  IF NEW.state<>'JOINED' OR NEW.attempt_id IS DISTINCT FROM h.id OR NEW.disposed_at IS DISTINCT FROM NEW.created_at THEN RAISE EXCEPTION 'RESEARCH_STARTUP_DISPOSITION_INVALID';END IF;
 ELSIF NEW.state<>'PENDING' OR NEW.attempt_id IS NOT NULL OR NEW.disposed_at IS NOT NULL THEN RAISE EXCEPTION 'RESEARCH_STARTUP_DISPOSITION_INVALID';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_startup_request_guard BEFORE INSERT OR UPDATE OR DELETE ON research_startup_source_requests FOR EACH ROW EXECUTE FUNCTION research_startup_request_guard();
CREATE TRIGGER research_startup_request_truncate BEFORE TRUNCATE ON research_startup_source_requests FOR EACH STATEMENT EXECUTE FUNCTION protect_execution_entry_control_event();

CREATE FUNCTION research_startup_register(p_account TEXT,p_revision BIGINT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT,p_role TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE h RECORD; d RECORD; head TEXT; at_time TIMESTAMPTZ:=clock_timestamp(); disposition TEXT; active BOOLEAN;
BEGIN
 IF NOT research_startup_current(p_account,p_revision,TRUE) THEN RAISE EXCEPTION 'RESEARCH_STARTUP_AUTHORITY_INVALID';END IF;
 IF EXISTS(SELECT 1 FROM research_startup_source_requests WHERE account_id=p_account AND pause_revision=p_revision AND config_hash=p_config AND manifest_hash=p_manifest AND instrument_id=p_instrument AND source_id=p_source AND role=p_role) THEN RETURN;END IF;
 SELECT * INTO h FROM research_startup_history(p_account,p_config,p_manifest,p_instrument,p_source) LIMIT 1;
 SELECT snapshot_id::text INTO head FROM research_snapshot_heads WHERE config_hash=p_config AND manifest_hash=p_manifest AND instrument_id=p_instrument;
 SELECT * INTO d FROM research_source_demand_ordinary(p_account,p_config,p_manifest,p_instrument,p_source,at_time);
 active:=h.state='STARTED' AND h.deadline_at>at_time AND h.recovered_at IS NULL OR h.retry_due_at IS NOT NULL AND h.cycle_end>at_time AND h.recovered_at IS NULL;
 disposition:=CASE WHEN d.state='READY' THEN 'FRESH' WHEN active THEN 'JOINED' ELSE 'PENDING' END;
 INSERT INTO research_startup_source_requests(account_id,pause_revision,config_hash,manifest_hash,instrument_id,source_id,role,created_at,predecessor_id,head_id,state,attempt_id,disposed_at)
 VALUES(p_account,p_revision,p_config,p_manifest,p_instrument,p_source,p_role,at_time,h.id,head,disposition,CASE WHEN disposition='JOINED' THEN h.id ELSE NULL END,CASE WHEN disposition='PENDING' THEN NULL ELSE at_time END);
END $$;

CREATE FUNCTION research_startup_observe(p_account TEXT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE r RECORD; h RECORD; d RECORD;
BEGIN
 FOR r IN SELECT * FROM research_startup_source_requests WHERE account_id=p_account AND config_hash=p_config AND manifest_hash=p_manifest AND instrument_id=p_instrument AND source_id=p_source AND state='PENDING' FOR UPDATE LOOP
  IF NOT research_startup_current(r.account_id,r.pause_revision) OR NOT EXISTS(SELECT 1 FROM research_authority WHERE config_hash=p_config AND manifest_hash=p_manifest) THEN
   UPDATE research_startup_source_requests SET state='SUPERSEDED',disposed_at=clock_timestamp() WHERE id=r.id;CONTINUE;
  END IF;
  SELECT * INTO h FROM research_startup_history(p_account,p_config,p_manifest,p_instrument,p_source) LIMIT 1;
  IF h.id IS NOT NULL AND h.id IS DISTINCT FROM r.predecessor_id THEN
   UPDATE research_startup_source_requests SET state='JOINED',attempt_id=h.id,disposed_at=clock_timestamp() WHERE id=r.id;CONTINUE;
  END IF;
  SELECT * INTO d FROM research_source_demand_ordinary(p_account,p_config,p_manifest,p_instrument,p_source,clock_timestamp());
  IF d.state='READY' THEN UPDATE research_startup_source_requests SET state='FRESH',disposed_at=clock_timestamp() WHERE id=r.id;END IF;
 END LOOP;
END $$;

CREATE FUNCTION research_startup_consume_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity RECORD; r RECORD;
BEGIN
 IF TG_TABLE_NAME='research_marketaux_attempts' THEN identity:=NEW;
 ELSE SELECT c.* INTO identity FROM research_wsh_refresh_cycles c WHERE c.id=NEW.cycle_id;END IF;
 FOR r IN SELECT * FROM research_startup_source_requests WHERE account_id=identity.account_id AND config_hash=identity.config_hash AND manifest_hash=identity.manifest_hash AND instrument_id=identity.instrument_id AND source_id=identity.source_id AND state='PENDING' FOR UPDATE LOOP
  IF NOT research_startup_current(r.account_id,r.pause_revision,TRUE) THEN
   UPDATE research_startup_source_requests SET state='SUPERSEDED',disposed_at=clock_timestamp() WHERE id=r.id;
  ELSE
   UPDATE research_startup_source_requests SET state=CASE WHEN identity.admission_kind='DEMAND' THEN 'CLAIMED' ELSE 'JOINED' END,attempt_id=NEW.id,disposed_at=clock_timestamp() WHERE id=r.id;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER research_startup_consume_marketaux AFTER INSERT ON research_marketaux_attempts FOR EACH ROW EXECUTE FUNCTION research_startup_consume_attempt();
CREATE TRIGGER research_startup_consume_wsh AFTER INSERT ON research_wsh_refresh_attempts FOR EACH ROW EXECUTE FUNCTION research_startup_consume_attempt();

CREATE FUNCTION research_startup_dispatch(p_attempt UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
 SELECT * INTO r FROM research_startup_source_requests WHERE attempt_id=p_attempt AND state='CLAIMED';
 IF NOT FOUND THEN RETURN;END IF;
 IF NOT research_startup_current(r.account_id,r.pause_revision,TRUE) OR NOT EXISTS(SELECT 1 FROM research_authority WHERE config_hash=r.config_hash AND manifest_hash=r.manifest_hash)
 THEN RAISE EXCEPTION 'RESEARCH_STARTUP_SUPERSEDED';END IF;
END $$;
CREATE OR REPLACE FUNCTION research_source_demand_admission(p_request BIGINT,p_account TEXT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT,p_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE r RECORD; d RECORD; startup RECORD;
BEGIN
 SELECT q.* INTO startup FROM research_startup_source_requests q JOIN execution_entry_controls c ON c.account_id=q.account_id AND c.revision=q.pause_revision AND c.paused WHERE q.account_id=p_account AND q.config_hash=p_config AND q.manifest_hash=p_manifest AND q.instrument_id=p_instrument AND q.source_id=p_source AND q.state='PENDING';
 IF FOUND AND research_startup_request_eligible(p_account,p_config,p_manifest,p_instrument,p_source,p_at)
  AND NOT research_startup_current(p_account,startup.pause_revision,TRUE) THEN RETURN FALSE;END IF;
 SELECT * INTO r FROM research_repair_requests WHERE id=p_request;
 IF ROW(r.account_id,r.config_hash,r.manifest_hash,r.instrument_id,r.source_id,r.state)
  IS DISTINCT FROM ROW(p_account,p_config,p_manifest,p_instrument,p_source,'WAITING'::text)
  OR r.next_check_at IS NULL OR r.next_check_at>p_at OR NOT EXISTS(
   SELECT 1 FROM research_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.canonical_json::jsonb->'instruments') i
    CROSS JOIN LATERAL jsonb_array_elements(i->'sources') src WHERE m.config_hash=p_config AND m.manifest_hash=p_manifest
    AND i->>'instrumentId'=p_instrument AND src->>'id'=p_source AND src->'roles'=jsonb_build_array(r.role)) THEN RETURN FALSE;END IF;
 SELECT * INTO d FROM research_source_demand(p_account,p_config,p_manifest,p_instrument,p_source,p_at);
 RETURN d.state='WAITING' AND d.reason='RESEARCH_SOURCE_DEMAND' AND d.next_at<=p_at;
END $$;

CREATE FUNCTION research_startup_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt UUID;
BEGIN
 IF TG_TABLE_NAME='research_marketaux_attempt_calls' THEN attempt:=NEW.attempt_id;
 ELSE SELECT id INTO attempt FROM research_wsh_refresh_attempts WHERE acquisition_id=NEW.acquisition_id;END IF;
 PERFORM research_startup_dispatch(attempt);RETURN NEW;
END $$;
CREATE TRIGGER research_startup_marketaux_call BEFORE INSERT ON research_marketaux_attempt_calls FOR EACH ROW EXECUTE FUNCTION research_startup_call_guard();
CREATE TRIGGER research_startup_wsh_call BEFORE INSERT ON research_wsh_acquisition_calls FOR EACH ROW EXECUTE FUNCTION research_startup_call_guard();
CREATE FUNCTION research_startup_wsh_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD;
BEGIN
 SELECT * INTO c FROM research_wsh_refresh_cycles WHERE id=NEW.cycle_id;
 IF c.admission_kind='DEMAND' AND NEW.ordinal=0 THEN
  IF NEW.started_at>clock_timestamp() OR NEW.started_at<clock_timestamp()-interval '3 seconds'
   OR NOT research_source_demand_admission(c.demand_request_id,c.account_id,c.config_hash,c.manifest_hash,c.instrument_id,c.source_id,NEW.started_at)
  THEN RAISE EXCEPTION 'RESEARCH_SOURCE_DEMAND_DENIED';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_startup_wsh_attempt BEFORE INSERT ON research_wsh_refresh_attempts FOR EACH ROW EXECUTE FUNCTION research_startup_wsh_attempt_guard();
