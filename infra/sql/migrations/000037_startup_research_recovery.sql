ALTER TABLE research_marketaux_attempts ADD COLUMN recovery_protocol TEXT,
 ADD COLUMN clock_domain_id TEXT, ADD COLUMN clock_db_at TIMESTAMPTZ, ADD COLUMN clock_wall_at TIMESTAMPTZ;
ALTER TABLE research_marketaux_attempts ADD CONSTRAINT research_marketaux_clock_proof CHECK (
 (recovery_protocol IS NULL AND clock_domain_id IS NULL AND clock_db_at IS NULL AND clock_wall_at IS NULL) OR
 (recovery_protocol='DEADLINE_FENCED_HTTP_V1' AND clock_db_at IS NOT NULL AND clock_wall_at IS NOT NULL
 AND abs(extract(epoch FROM clock_db_at-clock_wall_at))<=1 AND (clock_domain_id IS NULL OR clock_domain_id ~ '^[a-f0-9]{64}$')));
CREATE TABLE research_recovery_challenges (
 id UUID PRIMARY KEY, operation_id UUID NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('MARKETAUX_PRODUCER_QUIESCENCE','WSH_ENDPOINT_RESET')),
 account_id TEXT NOT NULL, config_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, instrument_id TEXT NOT NULL, source_id TEXT NOT NULL,
 ledger_key TEXT NOT NULL, endpoint_id TEXT, endpoint_generation BIGINT, pause_revision BIGINT NOT NULL CHECK(pause_revision>0), execution_process_id TEXT NOT NULL,
 nonce UUID NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 predecessors JSONB NOT NULL CHECK(jsonb_typeof(predecessors)='array' AND jsonb_array_length(predecessors) BETWEEN 1 AND 256),
 predecessor_hash TEXT NOT NULL CHECK(predecessor_hash ~ '^[a-f0-9]{64}$'), canonical_json TEXT NOT NULL,
 challenge_hash TEXT NOT NULL UNIQUE CHECK(challenge_hash ~ '^[a-f0-9]{64}$'),
 state TEXT NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','COMMITTED','CANCELLED')), receipt_id UUID,
 predecessor_challenge_id UUID UNIQUE REFERENCES research_recovery_challenges(id), successor_challenge_id UUID UNIQUE REFERENCES research_recovery_challenges(id),
 CHECK(expires_at=created_at+interval '15 minutes'),
 CHECK((kind='WSH_ENDPOINT_RESET')=(endpoint_id IS NOT NULL AND endpoint_generation IS NOT NULL)),
 CHECK((state='COMMITTED')=(receipt_id IS NOT NULL)), CHECK((state='CANCELLED')=(successor_challenge_id IS NOT NULL)),
 FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
CREATE TABLE research_recovery_audit (
 operation_id UUID PRIMARY KEY, challenge_id UUID NOT NULL REFERENCES research_recovery_challenges(id),
 action TEXT NOT NULL CHECK(action IN ('PREPARE','COMMIT','SUPERSEDE')), actor TEXT NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), evidence_json TEXT, evidence_hash TEXT,
 result_json JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((action='PREPARE')=(evidence_json IS NULL AND evidence_hash IS NULL)),
 CHECK(evidence_json IS NULL OR octet_length(evidence_json)<=32768 AND encode(sha256(convert_to(evidence_json,'UTF8')),'hex')=evidence_hash)
);
CREATE TABLE research_marketaux_recoveries (
 id UUID PRIMARY KEY, attempt_id UUID NOT NULL UNIQUE REFERENCES research_marketaux_attempts(id),
 account_id TEXT NOT NULL, ledger_key TEXT NOT NULL, identity_hash TEXT NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'), original_state TEXT NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('EXPIRED_FENCED_DEADLINE','OPERATOR_PRODUCERS_STOPPED')),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), original_deadline TIMESTAMPTZ NOT NULL,
 original_protocol TEXT, clock_domain_id TEXT, clock_wall_at TIMESTAMPTZ,
 challenge_id UUID REFERENCES research_recovery_challenges(id), evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE research_wsh_recovery_receipts (
 id UUID PRIMARY KEY, challenge_id UUID NOT NULL UNIQUE REFERENCES research_recovery_challenges(id),
 endpoint_id TEXT NOT NULL, prior_generation BIGINT NOT NULL, resulting_generation BIGINT NOT NULL,
 method TEXT NOT NULL CHECK(method='OPERATOR_OBSERVED_LOCAL_GATEWAY_RESTART'),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
 reconnect_session_id UUID NOT NULL UNIQUE, cleanup JSONB NOT NULL,
 CHECK(resulting_generation>prior_generation), CHECK(cleanup->>'state'='CONFIRMED' AND cleanup->>'verifiedLocalClosure'='true' AND cleanup->>'sessionId'=reconnect_session_id::text)
);
CREATE TABLE research_wsh_recovery_predecessors (
 receipt_id UUID NOT NULL REFERENCES research_wsh_recovery_receipts(id),
 attempt_id UUID UNIQUE REFERENCES research_wsh_refresh_attempts(id), acquisition_id UUID UNIQUE REFERENCES research_wsh_acquisitions(id),
 identity_hash TEXT NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 CHECK((attempt_id IS NULL)<>(acquisition_id IS NULL))
);
CREATE TABLE research_wsh_recovery_successors (
 receipt_id UUID PRIMARY KEY REFERENCES research_wsh_recovery_receipts(id), attempt_id UUID NOT NULL REFERENCES research_wsh_refresh_attempts(id)
);
CREATE FUNCTION research_recovery_held(p_account TEXT,p_ledger TEXT,p_endpoint TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM research_recovery_challenges c WHERE c.state='PREPARED' AND
 ((c.kind='MARKETAUX_PRODUCER_QUIESCENCE' AND (p_account IS NULL OR c.account_id=p_account) AND c.ledger_key=p_ledger) OR
 (c.kind='WSH_ENDPOINT_RESET' AND (c.endpoint_id=p_endpoint OR c.ledger_key=p_ledger OR EXISTS(
 SELECT 1 FROM jsonb_array_elements(c.predecessors) p WHERE p->>'ledgerKey'=p_ledger)))))
$$;
-- Only fixed recovery identity projections use this canonical encoder: ASCII keys,
-- strings, integers, nulls and arrays; provider payloads never enter it.
CREATE FUNCTION research_recovery_canonical(value JSONB) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result TEXT;
BEGIN
 CASE jsonb_typeof(value)
 WHEN 'object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||research_recovery_canonical(v),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) e(key,v);
 WHEN 'array' THEN SELECT '['||coalesce(string_agg(research_recovery_canonical(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY e(v,n);
 ELSE result:=value::text;
 END CASE;
 RETURN result;
END $$;
CREATE FUNCTION research_recovery_identity_hash(kind TEXT,identifier UUID) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE rowdata RECORD; identity JSONB;
BEGIN
 IF kind='MARKETAUX_ATTEMPT' THEN
  SELECT * INTO STRICT rowdata FROM research_marketaux_attempts WHERE id=identifier;
  identity:=jsonb_build_object('id',rowdata.id,'accountId',rowdata.account_id,'configHash',rowdata.config_hash,'manifestHash',rowdata.manifest_hash,
   'instrumentId',rowdata.instrument_id,'sourceId',rowdata.source_id,'sourceHash',rowdata.source_hash,'ledgerKey',rowdata.ledger_key,
   'startedAt',to_char(rowdata.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'deadlineAt',to_char(rowdata.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 ELSE
  IF kind='WSH_ATTEMPT' THEN
   SELECT a.*,c.ledger_key,c.config_hash,c.manifest_hash,c.instrument_id,c.source_id,ac.generation INTO STRICT rowdata
    FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id LEFT JOIN research_wsh_acquisitions ac ON ac.id=a.acquisition_id WHERE a.id=identifier;
  ELSIF kind='WSH_ACQUISITION' THEN SELECT * INTO STRICT rowdata FROM research_wsh_acquisitions WHERE id=identifier;
  ELSE RAISE EXCEPTION 'RESEARCH_RECOVERY_PREDECESSOR_INVALID'; END IF;
  identity:=jsonb_build_object('id',rowdata.id,'endpointId',rowdata.endpoint_id,'sessionId',rowdata.session_id,'ledgerKey',rowdata.ledger_key,'configHash',rowdata.config_hash,
   'manifestHash',rowdata.manifest_hash,'instrumentId',rowdata.instrument_id,'sourceId',rowdata.source_id,'startedAt',to_char(rowdata.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'generation',rowdata.generation);
 END IF;
 RETURN encode(sha256(convert_to(research_recovery_canonical(identity),'UTF8')),'hex');
END $$;
CREATE FUNCTION research_recovery_challenge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data JSONB; pred JSONB; source JSONB; policy RECORD;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.state<>'PREPARED' OR NEW.state NOT IN ('COMMITTED','CANCELLED') OR
    (to_jsonb(NEW)-ARRAY['state','receipt_id','successor_challenge_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','receipt_id','successor_challenge_id'])
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_CHALLENGE_IMMUTABLE'; END IF;
  IF NEW.state='CANCELLED' AND NOT EXISTS(SELECT 1 FROM research_recovery_challenges c WHERE c.id=NEW.successor_challenge_id AND c.predecessor_challenge_id=OLD.id AND c.state='PREPARED'
    AND ROW(c.account_id,c.kind,c.ledger_key,c.endpoint_id) IS NOT DISTINCT FROM ROW(OLD.account_id,OLD.kind,OLD.ledger_key,OLD.endpoint_id))
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_REPLACEMENT_INVALID'; END IF;
  IF NEW.state='COMMITTED' AND (NOT EXISTS(SELECT 1 FROM research_recovery_audit a WHERE a.challenge_id=NEW.id AND a.action='COMMIT' AND a.result_json->>'id'=NEW.receipt_id::text)
   OR (NEW.kind='MARKETAUX_PRODUCER_QUIESCENCE' AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.predecessors) p WHERE NOT EXISTS(SELECT 1 FROM research_marketaux_recoveries r WHERE r.challenge_id=NEW.id AND r.attempt_id::text=p->>'id' AND r.identity_hash=p->>'identityHash')))
   OR (NEW.kind='WSH_ENDPOINT_RESET' AND (NOT EXISTS(SELECT 1 FROM research_wsh_recovery_receipts r WHERE r.id=NEW.receipt_id AND r.challenge_id=NEW.id)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.predecessors) p WHERE NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors r WHERE r.receipt_id=NEW.receipt_id AND coalesce(r.attempt_id,r.acquisition_id)::text=p->>'id' AND r.identity_hash=p->>'identityHash')))))
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_RECEIPT_INVALID'; END IF;
 ELSE
  data:=NEW.canonical_json::jsonb;
  IF NEW.state<>'PREPARED' OR encode(sha256(convert_to(NEW.canonical_json,'UTF8')),'hex')<>NEW.challenge_hash
   OR NEW.canonical_json::jsonb->>'id'<>NEW.id::text OR NEW.canonical_json::jsonb->>'accountId'<>NEW.account_id
   OR NEW.canonical_json::jsonb->>'kind'<>NEW.kind OR NEW.canonical_json::jsonb->'predecessors' IS DISTINCT FROM NEW.predecessors
   OR NOT EXISTS(SELECT 1 FROM execution_entry_controls WHERE account_id=NEW.account_id AND paused AND revision=NEW.pause_revision)
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_CHALLENGE_INVALID'; END IF;
  IF ROW(data->>'operationId',data->>'configHash',data->>'manifestHash',data->>'instrumentId',data->>'sourceId',data->>'endpointId',
    (data->>'endpointGeneration')::bigint,(data->>'pauseRevision')::bigint,data->>'executionProcessId',data->>'nonce',(data->>'createdAt')::timestamptz,(data->>'expiresAt')::timestamptz,data->>'predecessorHash',data->>'state',data->>'receiptId')
   IS DISTINCT FROM ROW(NEW.operation_id::text,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id,NEW.endpoint_id,NEW.endpoint_generation,NEW.pause_revision,NEW.execution_process_id,NEW.nonce::text,NEW.created_at,NEW.expires_at,NEW.predecessor_hash,'PREPARED'::text,NULL::text)
   OR encode(sha256(convert_to((NEW.canonical_json::json->'predecessors')::text,'UTF8')),'hex')<>NEW.predecessor_hash
   OR NEW.created_at>clock_timestamp() OR NEW.created_at<clock_timestamp()-interval '3 seconds'
   OR (data->>'actor' ~ '^[A-Za-z0-9_.:-]{1,80}$') IS NOT TRUE
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_CHALLENGE_INVALID'; END IF;
  IF NEW.kind='MARKETAUX_PRODUCER_QUIESCENCE' THEN
   SELECT * INTO policy FROM research_marketaux_source_policy(NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id);
   IF NEW.ledger_key IS DISTINCT FROM policy.ledger THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_SCOPE_INVALID'; END IF;
  ELSE
   SELECT src INTO source FROM research_manifests m CROSS JOIN LATERAL jsonb_array_elements(m.canonical_json::jsonb->'instruments') i
    CROSS JOIN LATERAL jsonb_array_elements(i->'sources') src WHERE m.manifest_hash=NEW.manifest_hash AND m.config_hash=NEW.config_hash AND i->>'instrumentId'=NEW.instrument_id AND src->>'id'=NEW.source_id;
   IF source->>'adapter' IS DISTINCT FROM 'ibkr-wsh' OR source->'parserConfig'->>'endpointId' IS DISTINCT FROM NEW.endpoint_id
    OR 'ibkr-wsh:'||(source->'parserConfig'->>'isin') IS DISTINCT FROM NEW.ledger_key
   THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_SCOPE_INVALID'; END IF;
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(NEW.predecessors))<>(SELECT count(DISTINCT (p->>'kind',p->>'id')) FROM jsonb_array_elements(NEW.predecessors) p) THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_PREDECESSOR_INVALID'; END IF;
  FOR pred IN SELECT * FROM jsonb_array_elements(NEW.predecessors) LOOP
   IF pred->>'identityHash' IS DISTINCT FROM research_recovery_identity_hash(pred->>'kind',(pred->>'id')::uuid) OR
    (NEW.kind='MARKETAUX_PRODUCER_QUIESCENCE' AND (pred->>'kind'<>'MARKETAUX_ATTEMPT' OR NOT EXISTS(SELECT 1 FROM research_marketaux_attempts a WHERE a.id=(pred->>'id')::uuid AND a.account_id=NEW.account_id AND a.ledger_key=NEW.ledger_key AND a.state IN ('STARTED','FINALIZING','UNKNOWN') AND a.deadline_at<=clock_timestamp()))) OR
    (NEW.kind='WSH_ENDPOINT_RESET' AND (pred->>'kind' NOT IN ('WSH_ATTEMPT','WSH_ACQUISITION') OR pred->>'endpointId' IS DISTINCT FROM NEW.endpoint_id
     OR (pred->>'kind'='WSH_ATTEMPT' AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
       LEFT JOIN research_wsh_acquisitions ac ON ac.id=a.acquisition_id WHERE a.id=(pred->>'id')::uuid AND a.endpoint_id=NEW.endpoint_id
       AND (a.endpoint_id=NEW.endpoint_id OR c.ledger_key=NEW.ledger_key) AND (a.state='STARTED' AND a.deadline_at<=clock_timestamp() OR a.cleanup_state='UNKNOWN')
       AND ROW(pred->>'state',pred->>'ledgerKey',pred->>'sessionId',(pred->>'generation')::bigint) IS NOT DISTINCT FROM ROW(a.state,c.ledger_key,a.session_id,ac.generation)))
     OR (pred->>'kind'='WSH_ACQUISITION' AND NOT EXISTS(SELECT 1 FROM research_wsh_acquisitions a WHERE a.id=(pred->>'id')::uuid AND a.endpoint_id=NEW.endpoint_id AND a.state IN ('PENDING','UNKNOWN')
       AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts t WHERE t.acquisition_id=a.id)
       AND ROW(pred->>'state',pred->>'ledgerKey',pred->>'sessionId',(pred->>'generation')::bigint) IS NOT DISTINCT FROM ROW(a.state,a.ledger_key,a.session_id,a.generation)))))
   THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_PREDECESSOR_INVALID'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_recovery_challenge_guard BEFORE INSERT OR UPDATE ON research_recovery_challenges FOR EACH ROW EXECUTE FUNCTION research_recovery_challenge_guard();
CREATE TRIGGER research_recovery_challenge_no_delete BEFORE DELETE ON research_recovery_challenges FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_recovery_challenge_no_truncate BEFORE TRUNCATE ON research_recovery_challenges FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
CREATE FUNCTION research_marketaux_recovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a research_marketaux_attempts%ROWTYPE;
BEGIN
 SELECT * INTO STRICT a FROM research_marketaux_attempts WHERE id=NEW.attempt_id FOR UPDATE;
 IF a.state NOT IN ('STARTED','FINALIZING','UNKNOWN') OR NEW.original_state<>a.state
 OR ROW(NEW.account_id,NEW.ledger_key,NEW.original_deadline,NEW.original_protocol) IS DISTINCT FROM ROW(a.account_id,a.ledger_key,a.deadline_at,a.recovery_protocol)
 OR NEW.identity_hash IS DISTINCT FROM research_recovery_identity_hash('MARKETAUX_ATTEMPT',a.id)
 OR NEW.recorded_at<a.deadline_at OR NEW.recorded_at>clock_timestamp() THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_ATTEMPT_INVALID'; END IF;
 IF NEW.method='EXPIRED_FENCED_DEADLINE' THEN
  IF a.recovery_protocol IS DISTINCT FROM 'DEADLINE_FENCED_HTTP_V1' OR a.clock_domain_id IS NULL OR NEW.clock_domain_id IS DISTINCT FROM a.clock_domain_id
   OR NEW.clock_wall_at IS NULL OR abs(extract(epoch FROM NEW.clock_wall_at-clock_timestamp()))>1 OR NEW.recorded_at<a.deadline_at+interval '5 seconds' OR NEW.challenge_id IS NOT NULL
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_CLOCK_UNPROVED'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM research_recovery_challenges c WHERE c.id=NEW.challenge_id AND c.state='PREPARED'
    AND c.kind='MARKETAUX_PRODUCER_QUIESCENCE' AND c.account_id=a.account_id AND c.ledger_key=a.ledger_key AND c.expires_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.predecessors) p WHERE p->>'id'=a.id::text AND p->>'kind'='MARKETAUX_ATTEMPT')
    AND EXISTS(SELECT 1 FROM research_recovery_audit e WHERE e.challenge_id=c.id AND e.action='COMMIT' AND e.evidence_hash=NEW.evidence_hash))
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_OPERATOR_PROOF_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_marketaux_recovery_guard BEFORE INSERT ON research_marketaux_recoveries FOR EACH ROW EXECUTE FUNCTION research_marketaux_recovery_guard();
CREATE FUNCTION research_wsh_recovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM research_recovery_challenges c JOIN research_recovery_audit e ON e.challenge_id=c.id AND e.action='COMMIT'
   WHERE c.id=NEW.challenge_id AND c.state='PREPARED' AND c.kind='WSH_ENDPOINT_RESET' AND c.endpoint_id=NEW.endpoint_id
    AND c.endpoint_generation=NEW.prior_generation AND c.expires_at>clock_timestamp() AND e.evidence_hash=NEW.evidence_hash
    AND e.result_json->>'id'=NEW.id::text AND e.result_json->>'challengeId'=c.id::text
    AND e.evidence_json::jsonb->'reconnect'->>'sessionId'=NEW.reconnect_session_id::text
    AND e.evidence_json::jsonb->'reconnect'->'cleanup'=NEW.cleanup
    AND NEW.resulting_generation=NEW.prior_generation+1 AND NEW.prior_generation=(SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=NEW.endpoint_id))
 THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_OPERATOR_PROOF_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_recovery_guard BEFORE INSERT ON research_wsh_recovery_receipts FOR EACH ROW EXECUTE FUNCTION research_wsh_recovery_guard();
CREATE FUNCTION research_wsh_recovery_predecessor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE challenge research_recovery_challenges%ROWTYPE; session TEXT; endpoint TEXT;
BEGIN
 SELECT c.* INTO STRICT challenge FROM research_recovery_challenges c JOIN research_wsh_recovery_receipts r ON r.challenge_id=c.id WHERE r.id=NEW.receipt_id;
 IF NEW.attempt_id IS NOT NULL THEN SELECT session_id,endpoint_id INTO session,endpoint FROM research_wsh_refresh_attempts WHERE id=NEW.attempt_id;
 ELSE SELECT session_id,endpoint_id INTO session,endpoint FROM research_wsh_acquisitions WHERE id=NEW.acquisition_id; END IF;
 IF NEW.identity_hash IS DISTINCT FROM research_recovery_identity_hash(CASE WHEN NEW.attempt_id IS NULL THEN 'WSH_ACQUISITION' ELSE 'WSH_ATTEMPT' END,coalesce(NEW.attempt_id,NEW.acquisition_id))
 OR endpoint IS DISTINCT FROM challenge.endpoint_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(challenge.predecessors) p WHERE p->>'id'=coalesce(NEW.attempt_id,NEW.acquisition_id)::text
 AND p->>'kind'=CASE WHEN NEW.attempt_id IS NULL THEN 'WSH_ACQUISITION' ELSE 'WSH_ATTEMPT' END AND p->>'identityHash'=NEW.identity_hash AND p->>'sessionId'=session)
 THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_PREDECESSOR_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_recovery_predecessor_guard BEFORE INSERT ON research_wsh_recovery_predecessors FOR EACH ROW EXECUTE FUNCTION research_wsh_recovery_predecessor_guard();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['research_recovery_audit','research_marketaux_recoveries','research_wsh_recovery_receipts','research_wsh_recovery_predecessors','research_wsh_recovery_successors'] LOOP
 EXECUTE format('CREATE TRIGGER research_recovery_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION research_immutable()',t);
 EXECUTE format('CREATE TRIGGER research_recovery_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION research_immutable()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION research_marketaux_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy RECORD; prior RECORD; snapshot RECORD; now_at TIMESTAMPTZ; coverage JSONB; receipt JSONB; receipt_page JSONB; call RECORD; n INTEGER;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.recovery_protocol,NEW.clock_domain_id,NEW.clock_db_at,NEW.clock_wall_at) IS DISTINCT FROM ROW(OLD.recovery_protocol,OLD.clock_domain_id,OLD.clock_db_at,OLD.clock_wall_at) THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ATTEMPT_IMMUTABLE'; END IF;
  IF ROW(NEW.id,NEW.account_id,NEW.provider,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id,NEW.ledger_key,NEW.source_hash,NEW.slot,NEW.started_at,NEW.deadline_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.account_id,OLD.provider,OLD.config_hash,OLD.manifest_hash,OLD.instrument_id,OLD.source_id,OLD.ledger_key,OLD.source_hash,OLD.slot,OLD.started_at,OLD.deadline_at)
   OR NOT ((OLD.state='STARTED' AND NEW.state IN ('FINALIZING','UNKNOWN')) OR (OLD.state='FINALIZING' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')))
  THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ATTEMPT_IMMUTABLE'; END IF;
  IF NEW.snapshot_id IS NOT NULL THEN
   SELECT * INTO snapshot FROM research_snapshots WHERE id=NEW.snapshot_id;
   IF ROW(snapshot.config_hash,snapshot.manifest_hash,snapshot.instrument_id) IS DISTINCT FROM ROW(NEW.config_hash,NEW.manifest_hash,NEW.instrument_id)
   THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_PUBLICATION_IDENTITY'; END IF;
  END IF;
  IF NEW.finished_at IS NOT NULL AND (NEW.finished_at<NEW.started_at OR NEW.finished_at>clock_timestamp()) THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
  IF NEW.snapshot_id IS NOT NULL THEN
    IF encode(sha256(convert_to(snapshot.canonical_json,'UTF8')),'hex')<>snapshot.snapshot_hash
      OR NEW.projection_hash IS DISTINCT FROM research_marketaux_projection_hash(snapshot.canonical_json,NEW.source_id)
    THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_PUBLICATION_IDENTITY'; END IF;
  END IF;
  IF NEW.state='SUCCEEDED' THEN
    IF clock_timestamp()>=NEW.deadline_at THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ATTEMPT_EXPIRED'; END IF;
    SELECT count(*) INTO n FROM jsonb_array_elements(snapshot.canonical_json::jsonb->'coverage') c WHERE c->>'sourceId'=NEW.source_id;
    IF n<>1 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
    SELECT c INTO coverage FROM jsonb_array_elements(snapshot.canonical_json::jsonb->'coverage') c WHERE c->>'sourceId'=NEW.source_id;
    receipt:=coverage->'acquisition';
    IF (coverage->>'complete'='true' AND coverage->>'status' IN ('AVAILABLE','EMPTY') AND receipt->>'kind'='marketaux-news-v2'
      AND receipt->>'attemptId'=NEW.id::text AND receipt->>'sourceHash'=NEW.source_hash AND (receipt->>'slot')::bigint=NEW.slot
      AND (receipt->>'startedAt')::timestamptz=NEW.started_at AND (receipt->>'completedAt')::timestamptz=NEW.finished_at
      AND coverage->>'checkedAt'=receipt->>'completedAt' AND jsonb_typeof(receipt->'pages')='array'
      AND jsonb_array_length(receipt->'pages')>=2 AND jsonb_array_length(receipt->'pages')%2=0) IS NOT TRUE
    THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
    SELECT count(*) INTO n FROM research_marketaux_attempt_calls WHERE attempt_id=NEW.id;
    IF n<>jsonb_array_length(receipt->'pages') THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
    FOR receipt_page IN SELECT * FROM jsonb_array_elements(receipt->'pages') LOOP
      SELECT c.pass,c.page,r.request_hash,r.deadline_at,o.outcome,o.recorded_at,p.content_hash,p.recorded_at AS receipt_at INTO call
      FROM research_marketaux_attempt_calls c JOIN research_call_reservations r USING(call_key)
      JOIN research_call_outcomes o USING(call_key) JOIN research_marketaux_response_receipts p USING(call_key)
      WHERE c.attempt_id=NEW.id AND c.call_key=receipt_page->>'callKey';
      IF NOT FOUND OR (call.outcome='SUCCEEDED' AND call.pass=(receipt_page->>'pass')::integer AND call.page=(receipt_page->>'page')::integer
        AND call.request_hash=receipt_page->>'requestHash' AND call.content_hash=receipt_page->>'contentHash'
        AND call.recorded_at=(receipt_page->>'fetchedAt')::timestamptz AND call.receipt_at=call.recorded_at
        AND call.recorded_at<call.deadline_at AND call.deadline_at<=NEW.deadline_at) IS NOT TRUE
      THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
    END LOOP;
  END IF;
  IF NEW.state='FAILED' AND NEW.failure_class IN ('TRANSIENT','BUDGET') THEN
    IF EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c LEFT JOIN research_call_outcomes o USING(call_key)
      LEFT JOIN research_marketaux_response_receipts r USING(call_key) WHERE c.attempt_id=NEW.id AND (o.outcome IS NULL OR o.outcome='UNKNOWN' OR r.call_key IS NULL OR r.recorded_at<>o.recorded_at OR o.recorded_at>NEW.finished_at))
    THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
    IF NEW.failure_class='TRANSIENT' AND (NEW.source_error->>'httpStatus' IN ('429','500','502','503','504') AND NEW.failure_reason='RESEARCH_SOURCE_HTTP_'||(NEW.source_error->>'httpStatus')
      AND EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=NEW.id AND o.outcome='FAILED')) IS NOT TRUE
    THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
    IF NEW.failure_class='BUDGET' AND (NEW.failure_reason IS DISTINCT FROM 'RESEARCH_BUDGET_EXHAUSTED' OR NEW.source_error ? 'httpStatus'
      OR NOT EXISTS(SELECT 1 FROM research_marketaux_budget_denials WHERE attempt_id=NEW.id AND recorded_at>=NEW.started_at AND recorded_at<=NEW.finished_at)
      OR EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=NEW.id AND o.outcome<>'SUCCEEDED'))
    THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
    IF NEW.retained THEN
      SELECT c INTO coverage FROM jsonb_array_elements(snapshot.canonical_json::jsonb->'coverage') c WHERE c->>'sourceId'=NEW.source_id;
      IF (coverage->>'complete'='true' AND coverage->>'status' IN ('AVAILABLE','EMPTY') AND coverage->'acquisition'->>'kind'='marketaux-news-v2'
        AND (coverage->>'checkedAt')::timestamptz<=NEW.finished_at AND (coverage->>'checkedAt')::timestamptz+interval '24 hours'>NEW.finished_at
        AND EXISTS(SELECT 1 FROM research_marketaux_attempts good WHERE good.id::text=coverage->'acquisition'->>'attemptId' AND good.state='SUCCEEDED' AND good.projection_hash=NEW.projection_hash
          AND good.account_id=NEW.account_id AND good.config_hash=NEW.config_hash AND good.manifest_hash=NEW.manifest_hash AND good.instrument_id=NEW.instrument_id AND good.source_id=NEW.source_id)) IS NOT TRUE
      THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_RETAINED_INVALID'; END IF;
    END IF;
  END IF;
  IF NEW.retained AND (NEW.failure_class NOT IN ('TRANSIENT','BUDGET') OR EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c LEFT JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=NEW.id AND (o.outcome IS NULL OR o.outcome='UNKNOWN'))
    OR NEW.failure_class='BUDGET' AND NOT EXISTS(SELECT 1 FROM research_marketaux_budget_denials WHERE attempt_id=NEW.id)
    OR NEW.failure_class='TRANSIENT' AND NOT EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=NEW.id AND o.outcome='FAILED'))
  THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_OUTCOME_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.recovery_protocol IS DISTINCT FROM 'DEADLINE_FENCED_HTTP_V1' OR abs(extract(epoch FROM NEW.clock_db_at-clock_timestamp()))>1 OR NEW.clock_db_at IS NULL THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_CLOCK_UNPROVED'; END IF;
 LOCK TABLE research_recovery_challenges IN SHARE MODE;
 IF research_recovery_held(NEW.account_id,NEW.ledger_key,NULL) THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_MAINTENANCE_HOLD'; END IF;
 PERFORM 1 FROM research_authority WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_AUTHORITY'; END IF;
 SELECT * INTO policy FROM research_marketaux_source_policy(NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id);
 IF NEW.ledger_key IS DISTINCT FROM policy.ledger OR NEW.source_hash IS DISTINCT FROM policy.policy_hash OR NEW.provider<>'https://api.marketaux.com'
  OR NEW.state<>'STARTED' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_IDENTITY'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('research-marketaux-issuer:'||NEW.account_id||':'||NEW.ledger_key)::bigint);
 now_at:=clock_timestamp();
 IF NEW.started_at>now_at OR NEW.started_at<now_at-interval '3 seconds' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ADMISSION_TIME_INVALID'; END IF;
 FOR prior IN SELECT * FROM research_marketaux_attempts WHERE account_id=NEW.account_id AND ledger_key=NEW.ledger_key LOOP
  IF prior.state IN ('STARTED','FINALIZING','UNKNOWN') AND NOT EXISTS(SELECT 1 FROM research_marketaux_recoveries r WHERE r.attempt_id=prior.id) THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED'; END IF;
  IF NEW.started_at<prior.started_at+interval '1 hour' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_SLOT_TOO_EARLY'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
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
    JOIN research_wsh_refresh_attempts first_attempt ON first_attempt.id=s.attempt_id WHERE s.receipt_id=p.receipt_id AND first_attempt.started_at<=NEW.started_at)))) THEN RAISE EXCEPTION 'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED'; END IF;
 IF NEW.ordinal=0 THEN
   IF NEW.started_at<>cycle.started_at THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_IDENTITY'; END IF;
 ELSE
   SELECT * INTO STRICT previous FROM research_wsh_refresh_attempts WHERE id=NEW.predecessor_id;
   IF previous.cycle_id<>NEW.cycle_id OR previous.ordinal<>NEW.ordinal-1 OR previous.retry_due_at IS NULL OR NEW.started_at<previous.retry_due_at
   THEN RAISE EXCEPTION 'RESEARCH_WSH_RETRY_UNAVAILABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION research_recovery_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE challenge research_recovery_challenges%ROWTYPE; evidence JSONB; target research_recovery_challenges%ROWTYPE;
BEGIN
 SELECT * INTO STRICT challenge FROM research_recovery_challenges WHERE id=NEW.challenge_id;
 IF NEW.action='PREPARE' THEN
  IF NEW.operation_id<>challenge.operation_id OR NEW.result_json->>'id'<>challenge.id::text OR NEW.result_json->>'challengeHash'<>challenge.challenge_hash
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
 ELSE
  evidence:=NEW.evidence_json::jsonb;
  IF NEW.action='SUPERSEDE' THEN SELECT * INTO STRICT target FROM research_recovery_challenges WHERE id=challenge.predecessor_challenge_id;
  ELSE target:=challenge; END IF;
  IF ROW(evidence->>'challengeId',evidence->>'challengeHash',evidence->>'nonce',evidence->>'kind')
    IS DISTINCT FROM ROW(target.id::text,target.challenge_hash,target.nonce::text,CASE WHEN NEW.action='SUPERSEDE' THEN 'PRODUCER_QUIESCENCE' ELSE target.kind END)
   OR evidence->>'version' IS DISTINCT FROM 'local-research-recovery-v1' OR evidence->>'platform' IS DISTINCT FROM 'darwin'
   OR evidence->'runningProducerIds' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(evidence->'producers') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'producers') NOT BETWEEN 1 AND 16
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(evidence->'producers') p WHERE p->>'service' IS DISTINCT FROM 'llm-agent' OR p->>'state' NOT IN ('exited','dead'))
   OR (NEW.action='COMMIT' AND (challenge.state<>'PREPARED' OR NEW.result_json->>'challengeId' IS DISTINCT FROM challenge.id::text OR NEW.result_json->>'kind' IS DISTINCT FROM challenge.kind
     OR NEW.result_json->>'evidenceHash' IS DISTINCT FROM NEW.evidence_hash OR NEW.result_json->>'predecessorHash' IS DISTINCT FROM challenge.predecessor_hash))
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_recovery_audit_guard BEFORE INSERT ON research_recovery_audit FOR EACH ROW EXECUTE FUNCTION research_recovery_audit_guard();
CREATE FUNCTION research_wsh_successor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM research_wsh_recovery_receipts r JOIN research_wsh_refresh_attempts a ON a.id=NEW.attempt_id
  JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id JOIN research_recovery_challenges ch ON ch.id=r.challenge_id
  WHERE r.id=NEW.receipt_id AND ch.state='COMMITTED' AND a.endpoint_id=r.endpoint_id AND a.ordinal=0 AND a.started_at>=r.recorded_at
   AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p JOIN research_wsh_refresh_attempts previous_attempt ON previous_attempt.id=p.attempt_id JOIN research_wsh_refresh_cycles oc ON oc.id=previous_attempt.cycle_id
     WHERE p.receipt_id=r.id AND a.started_at<oc.next_regular_at))
 THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_SUCCESSOR_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_successor_guard BEFORE INSERT ON research_wsh_recovery_successors FOR EACH ROW EXECUTE FUNCTION research_wsh_successor_guard();
CREATE FUNCTION research_wsh_acquisition_recovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 LOCK TABLE research_recovery_challenges IN SHARE MODE;
 IF research_recovery_held(NULL,NEW.ledger_key,NEW.endpoint_id) THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_MAINTENANCE_HOLD'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_acquisition_recovery_guard BEFORE INSERT ON research_wsh_acquisitions FOR EACH ROW EXECUTE FUNCTION research_wsh_acquisition_recovery_guard();
