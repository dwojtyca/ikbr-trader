CREATE TABLE research_wsh_read_recoveries (
 id UUID PRIMARY KEY, account_id TEXT NOT NULL, config_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL,
 instrument_id TEXT NOT NULL, source_id TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL,
 canonical_json TEXT NOT NULL, record_hash TEXT NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE TABLE research_wsh_read_recovery_predecessors (
 recovery_id UUID NOT NULL REFERENCES research_wsh_read_recoveries(id), kind TEXT NOT NULL CHECK(kind IN ('WSH_ATTEMPT','WSH_ACQUISITION')),
 predecessor_id UUID NOT NULL, identity_hash TEXT NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(kind,predecessor_id)
);
CREATE TABLE research_wsh_read_recovery_challenges (
 recovery_id UUID NOT NULL REFERENCES research_wsh_read_recoveries(id), challenge_id UUID PRIMARY KEY REFERENCES research_recovery_challenges(id),
 challenge_hash TEXT NOT NULL CHECK(challenge_hash ~ '^[a-f0-9]{64}$')
);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['research_wsh_read_recoveries','research_wsh_read_recovery_predecessors','research_wsh_read_recovery_challenges'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION research_immutable()',t||'_immutable',t);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION research_immutable()',t||'_no_truncate',t);
 END LOOP;
END $$;

CREATE FUNCTION research_wsh_read_candidates() RETURNS SETOF JSONB LANGUAGE sql STABLE AS $$
 WITH attempts AS (
  SELECT a.*,c.account_id,c.ledger_key,c.config_hash,c.manifest_hash,c.instrument_id,c.source_id,c.next_regular_at,c.started_at AS cycle_started_at
  FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
  WHERE (a.state='STARTED' OR a.cleanup_state='UNKNOWN')
   AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.attempt_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors p WHERE p.kind='WSH_ATTEMPT' AND p.predecessor_id=a.id)
 ), acquisitions AS (
  SELECT a.* FROM research_wsh_acquisitions a
  WHERE ((a.state IN ('PENDING','UNKNOWN') AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts t WHERE t.acquisition_id=a.id))
    OR EXISTS(SELECT 1 FROM attempts t WHERE t.acquisition_id=a.id))
   AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.acquisition_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors p WHERE p.kind='WSH_ACQUISITION' AND p.predecessor_id=a.id)
 )
 SELECT jsonb_build_object('kind','WSH_ATTEMPT','id',a.id,'endpointId',a.endpoint_id,'ledgerKey',a.ledger_key,
  'configHash',a.config_hash,'manifestHash',a.manifest_hash,'instrumentId',a.instrument_id,'sourceId',a.source_id,
  'accountIds',jsonb_build_array(a.account_id),'pacingStartedAt',a.cycle_started_at,'startedAt',a.started_at,'deadlineAt',a.deadline_at,'nextRegularAt',a.next_regular_at,
  'identityHash',research_recovery_identity_hash('WSH_ATTEMPT',a.id),'original',to_jsonb(t),'calls','[]'::jsonb)
 FROM attempts a JOIN research_wsh_refresh_attempts t ON t.id=a.id
 UNION ALL
 SELECT jsonb_build_object('kind','WSH_ACQUISITION','id',a.id,'endpointId',a.endpoint_id,'ledgerKey',a.ledger_key,
  'configHash',a.config_hash,'manifestHash',a.manifest_hash,'instrumentId',a.instrument_id,'sourceId',a.source_id,
  'accountIds',coalesce((SELECT jsonb_agg(DISTINCT r.account_id) FROM research_wsh_acquisition_calls c JOIN research_call_reservations r USING(call_key) WHERE c.acquisition_id=a.id),'[]'::jsonb),
  'pacingStartedAt',coalesce((SELECT c.started_at FROM research_wsh_refresh_attempts t JOIN research_wsh_refresh_cycles c ON c.id=t.cycle_id WHERE t.acquisition_id=a.id),a.started_at),'startedAt',a.started_at,'deadlineAt',greatest(coalesce((SELECT t.deadline_at FROM research_wsh_refresh_attempts t WHERE t.acquisition_id=a.id),a.started_at+interval '35 seconds'),(SELECT max(r.deadline_at) FROM research_wsh_acquisition_calls c JOIN research_call_reservations r USING(call_key) WHERE c.acquisition_id=a.id)),
  'nextRegularAt',NULL,
  'identityHash',research_recovery_identity_hash('WSH_ACQUISITION',a.id),'original',to_jsonb(a),
  'calls',coalesce((SELECT jsonb_agg(jsonb_build_object('reservation',to_jsonb(r),'outcome',to_jsonb(o)) ORDER BY r.call_key)
    FROM research_wsh_acquisition_calls c JOIN research_call_reservations r USING(call_key) LEFT JOIN research_call_outcomes o USING(call_key) WHERE c.acquisition_id=a.id),'[]'::jsonb))
 FROM acquisitions a
$$;

CREATE FUNCTION research_wsh_read_recovery_record(p_identity JSONB,p_at TIMESTAMPTZ) RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE policy RECORD; source JSONB; initial_endpoint TEXT; found_predecessors JSONB; endpoints JSONB; issuers JSONB; challenges JSONB; pred JSONB; original RECORD; ch RECORD; normalized JSONB:='[]'::jsonb;
BEGIN
 SELECT * INTO policy FROM research_wsh_source_policy(p_identity->>'configHash',p_identity->>'manifestHash',p_identity->>'instrumentId',p_identity->>'sourceId');
 source:=policy.source_bytes::jsonb; initial_endpoint:=source->'parserConfig'->>'endpointId';
 WITH RECURSIVE candidates AS MATERIALIZED (SELECT v AS data FROM research_wsh_read_candidates() v), related AS (
  SELECT data FROM candidates WHERE data->>'endpointId'=initial_endpoint OR data->>'ledgerKey'=policy.ledger
  UNION
  SELECT c.data FROM candidates c JOIN related r ON c.data->>'endpointId'=r.data->>'endpointId' OR c.data->>'ledgerKey'=r.data->>'ledgerKey'
 ) SELECT coalesce(jsonb_agg(data ORDER BY data->>'kind',data->>'id'),'[]'::jsonb) INTO found_predecessors FROM related;
 IF jsonb_array_length(found_predecessors)>256 THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_SCOPE_LIMIT'; END IF;
 FOR pred IN SELECT * FROM jsonb_array_elements(found_predecessors) LOOP
  SELECT * INTO original FROM research_wsh_source_policy(pred->>'configHash',pred->>'manifestHash',pred->>'instrumentId',pred->>'sourceId');
  IF pred->>'kind'='WSH_ACQUISITION' THEN pred:=pred||jsonb_build_object('nextRegularAt',(pred->>'pacingStartedAt')::timestamptz+original.interval_ms*interval '1 millisecond'); END IF;
  IF original.ledger IS DISTINCT FROM pred->>'ledgerKey' OR original.source_bytes::jsonb->'parserConfig'->>'endpointId' IS DISTINCT FROM pred->>'endpointId'
   OR pred->'accountIds' IS DISTINCT FROM jsonb_build_array(p_identity->>'accountId')
   OR (pred->>'startedAt')::timestamptz>p_at OR (pred->>'deadlineAt')::timestamptz<(pred->>'startedAt')::timestamptz
   OR (pred->>'nextRegularAt')::timestamptz IS DISTINCT FROM (pred->>'pacingStartedAt')::timestamptz+original.interval_ms*interval '1 millisecond'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(pred->'calls') c WHERE c->'reservation'->>'account_id' IS DISTINCT FROM p_identity->>'accountId'
    OR c->'reservation'->>'config_hash' IS DISTINCT FROM pred->>'configHash' OR c->'reservation'->>'manifest_hash' IS DISTINCT FROM pred->>'manifestHash'
    OR c->'reservation'->>'provider' IS DISTINCT FROM 'ibkr-wsh' OR c->'reservation'->>'kind' IS DISTINCT FROM 'source'
    OR (c->'reservation'->>'reserved_at')::timestamptz>p_at OR (c->'reservation'->>'deadline_at')::timestamptz<(c->'reservation'->>'reserved_at')::timestamptz)
  THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_IDENTITY_INVALID'; END IF;
  normalized:=normalized||jsonb_build_array(pred);
 END LOOP;
 found_predecessors:=normalized;
 SELECT coalesce(jsonb_agg(jsonb_build_object('endpointId',x.endpoint_id,'predecessorGeneration',coalesce(e.generation,0),'successorGeneration',coalesce(e.generation,0)+1) ORDER BY x.endpoint_id),'[]'::jsonb)
 INTO endpoints FROM (SELECT DISTINCT p->>'endpointId' AS endpoint_id FROM jsonb_array_elements(found_predecessors) p) x LEFT JOIN research_wsh_endpoints e USING(endpoint_id);
 IF jsonb_array_length(endpoints)<>(SELECT count(DISTINCT p->>'endpointId') FROM jsonb_array_elements(found_predecessors) p) THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_ENDPOINT_MISSING'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('ledgerKey',ledger,'nextRegularAt',at) ORDER BY ledger),'[]'::jsonb) INTO issuers FROM
  (SELECT p->>'ledgerKey' AS ledger,max((p->>'nextRegularAt')::timestamptz) AS at FROM jsonb_array_elements(found_predecessors) p GROUP BY p->>'ledgerKey') i;
 challenges:='[]'::jsonb;
 FOR ch IN SELECT c.* FROM research_recovery_challenges c WHERE c.state='PREPARED' AND c.kind='WSH_ENDPOINT_RESET'
  AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_challenges d WHERE d.challenge_id=c.id)
  AND (c.endpoint_id IN (SELECT p->>'endpointId' FROM jsonb_array_elements(found_predecessors) p)
    OR c.ledger_key IN (SELECT p->>'ledgerKey' FROM jsonb_array_elements(found_predecessors) p)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.predecessors) p JOIN jsonb_array_elements(found_predecessors) r ON p->>'id'=r->>'id' AND p->>'kind'=r->>'kind')) ORDER BY c.id
 LOOP
  IF ch.account_id IS DISTINCT FROM p_identity->>'accountId' OR encode(sha256(convert_to(ch.canonical_json,'UTF8')),'hex') IS DISTINCT FROM ch.challenge_hash
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(ch.predecessors) p WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(found_predecessors) r
      WHERE r->>'id'=p->>'id' AND r->>'kind'=p->>'kind' AND r->>'identityHash'=p->>'identityHash'))
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(endpoints) e WHERE e->>'endpointId'=ch.endpoint_id AND (e->>'predecessorGeneration')::bigint=ch.endpoint_generation)
  THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_CHALLENGE_INVALID'; END IF;
  challenges:=challenges||jsonb_build_array(jsonb_build_object('id',ch.id,'hash',ch.challenge_hash));
 END LOOP;
 RETURN jsonb_build_object('version','WSH_READ_GENERATION_SUPERSEDED','identity',p_identity,'recordedAt',p_at,'endpoints',endpoints,'predecessors',found_predecessors,'issuers',issuers,'challenges',challenges);
END $$;

CREATE FUNCTION research_wsh_read_recovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data JSONB; expected JSONB; e JSONB; key BIGINT;
BEGIN
 data:=NEW.canonical_json::jsonb;
 IF NEW.canonical_json IS DISTINCT FROM research_recovery_canonical(data) OR encode(sha256(convert_to(NEW.canonical_json,'UTF8')),'hex') IS DISTINCT FROM NEW.record_hash
  OR data->'identity' IS DISTINCT FROM jsonb_build_object('accountId',NEW.account_id,'configHash',NEW.config_hash,'manifestHash',NEW.manifest_hash,'instrumentId',NEW.instrument_id,'sourceId',NEW.source_id)
  OR (data->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at OR NEW.recorded_at>clock_timestamp() OR NEW.recorded_at<clock_timestamp()-interval '3 seconds'
  OR NOT EXISTS(SELECT 1 FROM research_authority WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash)
 THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_INVALID'; END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(data->'endpoints') LOOP
  key:=hashtext('research-wsh-endpoint:'||(e->>'endpointId'))::bigint;
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND objsubid=1 AND classid=((key>>32)&4294967295)::oid AND objid=(key&4294967295)::oid)
  THEN RAISE EXCEPTION 'RESEARCH_WSH_LOCK_LOST'; END IF;
 END LOOP;
 LOCK TABLE research_recovery_challenges IN SHARE MODE;
 PERFORM 1 FROM research_authority WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESEARCH_AUTHORITY_MISMATCH'; END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(data->'endpoints') ORDER BY value->>'endpointId' LOOP
  PERFORM 1 FROM research_wsh_endpoints WHERE endpoint_id=e->>'endpointId' FOR UPDATE;
 END LOOP;
 FOR e IN SELECT * FROM jsonb_array_elements(data->'issuers') ORDER BY value->>'ledgerKey' LOOP
  PERFORM pg_advisory_xact_lock(hashtext('research-wsh-issuer:'||(e->>'ledgerKey'))::bigint);
 END LOOP;
 FOR e IN SELECT * FROM jsonb_array_elements(data->'predecessors') ORDER BY value->>'id',value->>'kind' LOOP
  IF e->>'kind'='WSH_ATTEMPT' THEN PERFORM 1 FROM research_wsh_refresh_attempts WHERE id=(e->>'id')::uuid FOR UPDATE;
  ELSE PERFORM 1 FROM research_wsh_acquisitions WHERE id=(e->>'id')::uuid FOR UPDATE; END IF;
 END LOOP;
 expected:=research_wsh_read_recovery_record(data->'identity',NEW.recorded_at);
 IF data IS DISTINCT FROM expected OR jsonb_array_length(data->'predecessors')=0
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(data->'predecessors') p WHERE (p->>'deadlineAt')::timestamptz>NEW.recorded_at)
 THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_NOT_EXPIRED_OR_CHANGED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_read_recovery_guard BEFORE INSERT ON research_wsh_read_recoveries FOR EACH ROW EXECUTE FUNCTION research_wsh_read_recovery_guard();

CREATE FUNCTION research_wsh_read_disposition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data JSONB;
BEGIN
 SELECT canonical_json::jsonb INTO STRICT data FROM research_wsh_read_recoveries WHERE id=NEW.recovery_id;
 IF TG_TABLE_NAME='research_wsh_read_recovery_predecessors' THEN
  IF NEW.identity_hash IS DISTINCT FROM research_recovery_identity_hash(NEW.kind,NEW.predecessor_id)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(data->'predecessors') p WHERE p->>'kind'=NEW.kind AND p->>'id'=NEW.predecessor_id::text AND p->>'identityHash'=NEW.identity_hash)
  THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_PREDECESSOR_INVALID'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM research_recovery_challenges c WHERE c.id=NEW.challenge_id AND c.state='PREPARED' AND c.kind='WSH_ENDPOINT_RESET'
    AND c.challenge_hash=NEW.challenge_hash AND EXISTS(SELECT 1 FROM jsonb_array_elements(data->'challenges') p WHERE p->>'id'=c.id::text AND p->>'hash'=c.challenge_hash))
  THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_CHALLENGE_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_read_predecessor_guard BEFORE INSERT ON research_wsh_read_recovery_predecessors FOR EACH ROW EXECUTE FUNCTION research_wsh_read_disposition_guard();
CREATE TRIGGER research_wsh_read_challenge_guard BEFORE INSERT ON research_wsh_read_recovery_challenges FOR EACH ROW EXECUTE FUNCTION research_wsh_read_disposition_guard();

CREATE FUNCTION research_wsh_read_recovery_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data JSONB; p JSONB; current_row JSONB; expected JSONB; calls JSONB;
BEGIN
 data:=NEW.canonical_json::jsonb;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(data->'endpoints') e WHERE NOT EXISTS(SELECT 1 FROM research_wsh_endpoints x WHERE x.endpoint_id=e->>'endpointId' AND x.generation=(e->>'successorGeneration')::bigint))
  OR (SELECT count(*) FROM research_wsh_read_recovery_predecessors WHERE recovery_id=NEW.id)<>jsonb_array_length(data->'predecessors')
  OR (SELECT count(*) FROM research_wsh_read_recovery_challenges WHERE recovery_id=NEW.id)<>jsonb_array_length(data->'challenges')
 THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_INCOMPLETE'; END IF;
 FOR p IN SELECT * FROM jsonb_array_elements(data->'predecessors') LOOP
  expected:=p->'original';
  IF p->>'kind'='WSH_ATTEMPT' THEN
   SELECT to_jsonb(a) INTO current_row FROM research_wsh_refresh_attempts a WHERE id=(p->>'id')::uuid;
   IF expected->>'state'='STARTED' THEN expected:=expected||jsonb_build_object('state','UNKNOWN','finished_at',NEW.recorded_at,'failure_class','UNCERTAIN','failure_reason','RESEARCH_WSH_READ_GENERATION_SUPERSEDED','failure_stage','cleanup'); END IF;
  ELSE
   SELECT to_jsonb(a) INTO current_row FROM research_wsh_acquisitions a WHERE id=(p->>'id')::uuid;
   IF expected->>'state'='PENDING' THEN expected:=expected||jsonb_build_object('state','UNKNOWN'); END IF;
   IF expected->>'retired_at' IS NULL THEN expected:=expected||jsonb_build_object('retired_at',NEW.recorded_at); END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_object('reservation',to_jsonb(r),'outcome',to_jsonb(o)) ORDER BY r.call_key),'[]'::jsonb) INTO calls
    FROM research_wsh_acquisition_calls c JOIN research_call_reservations r USING(call_key) LEFT JOIN research_call_outcomes o USING(call_key) WHERE c.acquisition_id=(p->>'id')::uuid;
   IF calls IS DISTINCT FROM p->'calls' THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_CALLS_CHANGED'; END IF;
  END IF;
  IF current_row IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_RECOVERY_INCOMPLETE'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER research_wsh_read_recovery_complete AFTER INSERT ON research_wsh_read_recoveries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION research_wsh_read_recovery_complete();

CREATE FUNCTION research_wsh_read_publication_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p JSONB; recorded TIMESTAMPTZ; expected JSONB;
BEGIN
 IF TG_TABLE_NAME IN ('research_wsh_refresh_attempts','research_wsh_acquisitions') THEN
  SELECT pred,r.recorded_at INTO p,recorded FROM research_wsh_read_recovery_predecessors d JOIN research_wsh_read_recoveries r ON r.id=d.recovery_id
   CROSS JOIN LATERAL jsonb_array_elements(r.canonical_json::jsonb->'predecessors') pred
   WHERE d.kind=CASE WHEN TG_TABLE_NAME='research_wsh_refresh_attempts' THEN 'WSH_ATTEMPT' ELSE 'WSH_ACQUISITION' END AND d.predecessor_id=OLD.id
   AND pred->>'id'=d.predecessor_id::text AND pred->>'kind'=d.kind;
  IF p IS NULL THEN RETURN NEW; END IF;
  expected:=p->'original';
  IF to_jsonb(OLD) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RESEARCH_WSH_GENERATION_RETIRED'; END IF;
  IF TG_TABLE_NAME='research_wsh_refresh_attempts' AND expected->>'state'='STARTED' THEN
   expected:=expected||jsonb_build_object('state','UNKNOWN','finished_at',recorded,'failure_class','UNCERTAIN','failure_reason','RESEARCH_WSH_READ_GENERATION_SUPERSEDED','failure_stage','cleanup');
  ELSIF TG_TABLE_NAME='research_wsh_acquisitions' THEN
   IF expected->>'state'='PENDING' THEN expected:=expected||jsonb_build_object('state','UNKNOWN'); END IF;
   IF expected->>'retired_at' IS NULL THEN expected:=expected||jsonb_build_object('retired_at',recorded); END IF;
  ELSE RAISE EXCEPTION 'RESEARCH_WSH_GENERATION_RETIRED'; END IF;
  IF to_jsonb(NEW) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RESEARCH_WSH_GENERATION_RETIRED'; END IF;
 ELSIF TG_TABLE_NAME='research_wsh_acquisition_calls' THEN
  PERFORM 1 FROM research_wsh_acquisitions WHERE id=NEW.acquisition_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors WHERE kind='WSH_ACQUISITION' AND predecessor_id=NEW.acquisition_id) THEN RAISE EXCEPTION 'RESEARCH_WSH_GENERATION_RETIRED'; END IF;
 ELSIF TG_TABLE_NAME='research_call_outcomes' THEN
  PERFORM 1 FROM research_wsh_acquisitions a JOIN research_wsh_acquisition_calls c ON c.acquisition_id=a.id WHERE c.call_key=NEW.call_key FOR UPDATE OF a;
  IF EXISTS(SELECT 1 FROM research_wsh_acquisition_calls c JOIN research_wsh_read_recovery_predecessors d ON d.kind='WSH_ACQUISITION' AND d.predecessor_id=c.acquisition_id WHERE c.call_key=NEW.call_key) THEN RAISE EXCEPTION 'RESEARCH_WSH_GENERATION_RETIRED'; END IF;
 ELSIF TG_TABLE_NAME='research_snapshots' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.canonical_json::jsonb->'coverage') c JOIN research_wsh_read_recovery_predecessors d ON d.kind='WSH_ACQUISITION' AND d.predecessor_id::text=c->'wshAcquisition'->>'acquisitionId') THEN RAISE EXCEPTION 'RESEARCH_WSH_GENERATION_RETIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_read_attempt_fence BEFORE UPDATE ON research_wsh_refresh_attempts FOR EACH ROW EXECUTE FUNCTION research_wsh_read_publication_fence();
CREATE TRIGGER research_wsh_read_acquisition_fence BEFORE UPDATE ON research_wsh_acquisitions FOR EACH ROW EXECUTE FUNCTION research_wsh_read_publication_fence();
CREATE TRIGGER research_wsh_read_call_fence BEFORE INSERT ON research_wsh_acquisition_calls FOR EACH ROW EXECUTE FUNCTION research_wsh_read_publication_fence();
CREATE TRIGGER research_wsh_read_outcome_fence BEFORE INSERT ON research_call_outcomes FOR EACH ROW EXECUTE FUNCTION research_wsh_read_publication_fence();
CREATE TRIGGER research_wsh_read_snapshot_fence BEFORE INSERT ON research_snapshots FOR EACH ROW EXECUTE FUNCTION research_wsh_read_publication_fence();

CREATE OR REPLACE FUNCTION research_recovery_held(p_account TEXT,p_ledger TEXT,p_endpoint TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM research_recovery_challenges c WHERE c.state='PREPARED' AND
 ((c.kind='MARKETAUX_PRODUCER_QUIESCENCE' AND (p_account IS NULL OR c.account_id=p_account) AND c.ledger_key=p_ledger) OR
 (c.kind='WSH_ENDPOINT_RESET' AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_challenges d WHERE d.challenge_id=c.id AND d.challenge_hash=c.challenge_hash)
 AND (c.endpoint_id=p_endpoint OR c.ledger_key=p_ledger OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.predecessors) p WHERE p->>'ledgerKey'=p_ledger)))))
$$;
CREATE FUNCTION research_wsh_read_challenge_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target UUID;
BEGIN
 IF TG_TABLE_NAME='research_recovery_challenges' THEN
  target:=CASE WHEN TG_OP='INSERT' THEN NEW.predecessor_challenge_id ELSE OLD.id END;
 ELSE target:=NEW.challenge_id; END IF;
 IF EXISTS(SELECT 1 FROM research_wsh_read_recovery_challenges WHERE challenge_id=target)
  OR TG_TABLE_NAME='research_recovery_audit' AND EXISTS(SELECT 1 FROM research_recovery_challenges c JOIN research_wsh_read_recovery_challenges d ON d.challenge_id=c.predecessor_challenge_id WHERE c.id=target)
 THEN RAISE EXCEPTION 'RESEARCH_WSH_READ_CHALLENGE_SUPERSEDED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_research_wsh_read_challenge_fence BEFORE INSERT OR UPDATE ON research_recovery_challenges FOR EACH ROW EXECUTE FUNCTION research_wsh_read_challenge_fence();
CREATE TRIGGER research_wsh_read_audit_fence BEFORE INSERT ON research_recovery_audit FOR EACH ROW EXECUTE FUNCTION research_wsh_read_challenge_fence();

CREATE FUNCTION research_wsh_read_predecessor_allows(p_kind TEXT,p_id UUID,p_ledger TEXT,p_started TIMESTAMPTZ,p_cycle UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors d JOIN research_wsh_read_recoveries r ON r.id=d.recovery_id
  WHERE d.kind=p_kind AND d.predecessor_id=p_id AND p_started>=r.recorded_at
   AND p_started>=coalesce((SELECT (i->>'nextRegularAt')::timestamptz FROM jsonb_array_elements(r.canonical_json::jsonb->'issuers') i WHERE i->>'ledgerKey'=p_ledger),r.recorded_at)
   AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a WHERE d.kind='WSH_ATTEMPT' AND a.id=d.predecessor_id AND a.cycle_id=p_cycle))
$$;
CREATE OR REPLACE FUNCTION research_wsh_attempt_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cycle research_wsh_refresh_cycles%ROWTYPE; previous research_wsh_refresh_attempts%ROWTYPE;
BEGIN
 LOCK TABLE research_recovery_challenges IN SHARE MODE;
 SELECT * INTO STRICT cycle FROM research_wsh_refresh_cycles WHERE id=NEW.cycle_id;
 IF research_recovery_held(cycle.account_id,cycle.ledger_key,NEW.endpoint_id) THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_MAINTENANCE_HOLD'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('research-wsh-issuer:'||cycle.ledger_key)::bigint);
 IF NEW.state<>'STARTED' OR NEW.preflight_complete OR NEW.verified_local_closure OR NEW.started_at<cycle.started_at OR NEW.started_at>=cycle.next_regular_at
    OR EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE (c.ledger_key=cycle.ledger_key OR a.endpoint_id=NEW.endpoint_id) AND a.state='STARTED')
 THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_ACTIVE_OR_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE (c.ledger_key=cycle.ledger_key OR a.endpoint_id=NEW.endpoint_id) AND a.state<>'STARTED' AND a.cleanup_state='UNKNOWN' AND (NOT a.verified_local_closure OR NEW.ordinal>0 OR NEW.started_at<c.next_regular_at) AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.attempt_id=a.id AND (
   (NEW.ordinal=0 AND NEW.started_at>=c.next_regular_at) OR EXISTS(SELECT 1 FROM research_wsh_recovery_successors s
    JOIN research_wsh_refresh_attempts first_attempt ON first_attempt.id=s.attempt_id WHERE s.receipt_id=p.receipt_id AND first_attempt.started_at<=NEW.started_at))) AND NOT research_wsh_read_predecessor_allows('WSH_ATTEMPT',a.id,cycle.ledger_key,cycle.started_at,cycle.id)) THEN RAISE EXCEPTION 'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED'; END IF;
 IF NEW.ordinal=0 THEN
   IF NEW.started_at<>cycle.started_at THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_IDENTITY'; END IF;
 ELSE
   SELECT * INTO STRICT previous FROM research_wsh_refresh_attempts WHERE id=NEW.predecessor_id;
   IF EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors d WHERE d.kind='WSH_ATTEMPT' AND d.predecessor_id=previous.id) THEN RAISE EXCEPTION 'RESEARCH_WSH_RETRY_UNAVAILABLE'; END IF;
   IF previous.cycle_id<>NEW.cycle_id OR previous.ordinal<>NEW.ordinal-1 OR previous.retry_due_at IS NULL OR NEW.started_at<previous.retry_due_at
   THEN RAISE EXCEPTION 'RESEARCH_WSH_RETRY_UNAVAILABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION research_wsh_read_regular_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ledger TEXT; started TIMESTAMPTZ; due TIMESTAMPTZ;
BEGIN
 ledger:=NEW.ledger_key; started:=NEW.started_at;
 SELECT max((i->>'nextRegularAt')::timestamptz) INTO due FROM research_wsh_read_recoveries r CROSS JOIN LATERAL jsonb_array_elements(r.canonical_json::jsonb->'issuers') i WHERE i->>'ledgerKey'=ledger;
 IF due IS NOT NULL AND started<due THEN RAISE EXCEPTION 'RESEARCH_WSH_SLOT_TOO_EARLY'; END IF;
 IF TG_TABLE_NAME='research_wsh_acquisitions' THEN
 IF EXISTS(SELECT 1 FROM research_wsh_read_recoveries r
   WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(r.canonical_json::jsonb->'endpoints') e WHERE e->>'endpointId'=NEW.endpoint_id)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.canonical_json::jsonb->'issuers') i WHERE i->>'ledgerKey'=ledger))
  AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
   WHERE a.state='STARTED' AND a.preflight_complete AND a.session_id=NEW.session_id AND a.endpoint_id=NEW.endpoint_id
    AND c.ledger_key=NEW.ledger_key AND c.config_hash=NEW.config_hash AND c.manifest_hash=NEW.manifest_hash AND c.instrument_id=NEW.instrument_id AND c.source_id=NEW.source_id
    AND a.acquisition_id IS NULL AND a.deadline_at>clock_timestamp())
 THEN RAISE EXCEPTION 'RESEARCH_WSH_REGULAR_ATTEMPT_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_read_cycle_boundary BEFORE INSERT ON research_wsh_refresh_cycles FOR EACH ROW EXECUTE FUNCTION research_wsh_read_regular_boundary();
CREATE TRIGGER research_wsh_read_acquisition_boundary BEFORE INSERT ON research_wsh_acquisitions FOR EACH ROW EXECUTE FUNCTION research_wsh_read_regular_boundary();
