CREATE TABLE research_marketaux_attempts (
 id UUID PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL,
 config_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL, instrument_id TEXT NOT NULL, source_id TEXT NOT NULL,
 ledger_key TEXT NOT NULL, source_hash TEXT NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 slot BIGINT NOT NULL CHECK(slot>0), started_at TIMESTAMPTZ NOT NULL, deadline_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('STARTED','FINALIZING','SUCCEEDED','FAILED','UNKNOWN')),
 finished_at TIMESTAMPTZ, failure_class TEXT CHECK(failure_class IN ('TRANSIENT','BUDGET','HARD','UNKNOWN')), failure_reason TEXT, source_error JSONB,
 snapshot_id UUID REFERENCES research_snapshots(id), retained BOOLEAN NOT NULL DEFAULT FALSE,
 projection_hash TEXT CHECK(projection_hash ~ '^[a-f0-9]{64}$'),
 CHECK(deadline_at=started_at+interval '120 seconds'),
 CHECK(slot=floor(extract(epoch FROM started_at)/3600)::bigint),
 CHECK((state IN ('STARTED','FINALIZING') AND failure_class IS NULL AND source_error IS NULL AND finished_at IS NULL AND snapshot_id IS NULL AND failure_reason IS NULL AND NOT retained AND projection_hash IS NULL)
   OR (state='SUCCEEDED' AND failure_class IS NULL AND source_error IS NULL AND finished_at IS NOT NULL AND finished_at<deadline_at AND snapshot_id IS NOT NULL AND projection_hash IS NOT NULL AND failure_reason IS NULL AND NOT retained)
   OR (state='FAILED' AND failure_class IS NOT NULL AND failure_class IN ('TRANSIENT','BUDGET','HARD') AND finished_at IS NOT NULL AND failure_reason IS NOT NULL AND snapshot_id IS NOT NULL AND projection_hash IS NOT NULL)
   OR (state='UNKNOWN' AND failure_class IS NOT NULL AND failure_class='UNKNOWN' AND finished_at IS NOT NULL AND failure_reason IS NOT NULL AND NOT retained)),
 FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash),
 UNIQUE(account_id,ledger_key,slot)
);
CREATE INDEX research_marketaux_issuer_attempts ON research_marketaux_attempts(account_id,ledger_key,started_at DESC);
CREATE TABLE research_marketaux_attempt_calls (
 call_key TEXT PRIMARY KEY REFERENCES research_call_reservations(call_key),
 attempt_id UUID NOT NULL REFERENCES research_marketaux_attempts(id),
 pass INTEGER NOT NULL CHECK(pass IN (1,2)), page INTEGER NOT NULL CHECK(page>0),
 UNIQUE(attempt_id,pass,page)
);
CREATE TABLE research_marketaux_response_receipts (
 call_key TEXT PRIMARY KEY REFERENCES research_marketaux_attempt_calls(call_key),
 content_hash TEXT CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 recorded_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE research_marketaux_budget_denials (
 attempt_id UUID PRIMARY KEY REFERENCES research_marketaux_attempts(id), budget_day DATE NOT NULL, recorded_at TIMESTAMPTZ NOT NULL,
 requests_used BIGINT NOT NULL CHECK(requests_used>=0), cost_used BIGINT NOT NULL CHECK(cost_used>=0),
 max_requests BIGINT NOT NULL CHECK(max_requests>=0), max_cost BIGINT NOT NULL CHECK(max_cost>=0), next_cost BIGINT NOT NULL CHECK(next_cost>=0),
 CHECK(budget_day=(recorded_at AT TIME ZONE 'UTC')::date), CHECK(requests_used>=max_requests OR cost_used+next_cost>max_cost)
);

CREATE FUNCTION research_marketaux_budget_denial_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD; raw TEXT; cap_requests BIGINT; cap_cost BIGINT; call_cost BIGINT; used_requests BIGINT; used_cost BIGINT;
BEGIN
 SELECT * INTO a FROM research_marketaux_attempts WHERE id=NEW.attempt_id FOR UPDATE;
 IF NOT FOUND OR a.state<>'STARTED' OR NEW.recorded_at<a.started_at OR NEW.recorded_at>clock_timestamp() OR NEW.recorded_at>=a.deadline_at
 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_BUDGET_PROOF_INVALID'; END IF;
 SELECT canonical_json INTO raw FROM research_manifests WHERE manifest_hash=a.manifest_hash AND config_hash=a.config_hash;
 SELECT min((s->>'maxRequestsPerDay')::bigint),min((s->>'maxCostMicrosPerDay')::bigint),max((s->>'costMicrosPerCall')::bigint)
 INTO cap_requests,cap_cost,call_cost FROM jsonb_array_elements(raw::jsonb->'instruments') p CROSS JOIN LATERAL jsonb_array_elements(p->'sources') s WHERE s->>'provider'=a.provider;
 PERFORM pg_advisory_xact_lock(hashtext('research-budget:'||a.account_id||':'||a.provider)::bigint);
 SELECT count(*),coalesce(sum(reserved_cost_micros),0) INTO used_requests,used_cost FROM research_call_reservations
 WHERE account_id=a.account_id AND provider=a.provider AND budget_day=NEW.budget_day AND reserved_at<=NEW.recorded_at;
 IF ROW(NEW.max_requests,NEW.max_cost,NEW.next_cost,NEW.requests_used,NEW.cost_used)
   IS DISTINCT FROM ROW(cap_requests,cap_cost,call_cost,used_requests,used_cost)
 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_BUDGET_PROOF_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_marketaux_budget_denial_guard BEFORE INSERT ON research_marketaux_budget_denials FOR EACH ROW EXECUTE FUNCTION research_marketaux_budget_denial_guard();

CREATE FUNCTION research_marketaux_source_policy(p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT)
RETURNS TABLE(ledger TEXT,policy_hash TEXT,source_bytes TEXT) LANGUAGE plpgsql STABLE AS $$
DECLARE raw TEXT; cfg TEXT; policy JSON; src JSON; instrument JSON; n INTEGER;
BEGIN
 SELECT canonical_json INTO raw FROM research_manifests WHERE config_hash=p_config AND manifest_hash=p_manifest;
 SELECT canonical_json INTO cfg FROM trading_configuration_snapshots WHERE effective_hash=p_config;
 IF raw IS NULL OR cfg IS NULL OR encode(sha256(convert_to(raw,'UTF8')),'hex')<>p_manifest
  OR encode(sha256(convert_to(cfg,'UTF8')),'hex')<>p_config
  OR raw::json->>'researchPolicy' IS DISTINCT FROM 'TWO_SOURCE_HOURLY_V1'
  OR raw::json->>'schemaVersion' IS DISTINCT FROM '2' OR raw::json->>'refreshEnabled' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_IDENTITY'; END IF;
 SELECT count(*) INTO n FROM json_array_elements(raw::json->'instruments') v WHERE v->>'instrumentId'=p_instrument;
 IF n<>1 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_IDENTITY'; END IF;
 SELECT v INTO policy FROM json_array_elements(raw::json->'instruments') v WHERE v->>'instrumentId'=p_instrument;
 SELECT count(*) INTO n FROM json_array_elements(policy->'sources') v WHERE v->>'id'=p_source;
 IF n<>1 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_IDENTITY'; END IF;
 SELECT v INTO src FROM json_array_elements(policy->'sources') v WHERE v->>'id'=p_source;
 SELECT count(*) INTO n FROM json_array_elements(cfg::json->'configuration'->'instruments') v WHERE v->>'id'=p_instrument;
 IF n<>1 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_IDENTITY'; END IF;
 SELECT v INTO instrument FROM json_array_elements(cfg::json->'configuration'->'instruments') v WHERE v->>'id'=p_instrument;
 IF (src->>'adapter'='marketaux-news' AND src->>'provider'='https://api.marketaux.com'
  AND (src->'roles')::jsonb='["news"]'::jsonb AND src->'parserConfig'->>'kind'='marketaux-news-v2'
  AND src->'parserConfig'->>'refreshIntervalMs'='3600000' AND src->'parserConfig'->>'maxAgeMs'='86400000'
  AND src->'parserConfig'->>'queryLookbackMs'='86400000'
  AND (src->'parserConfig'->'qualification'->'issuerIdentifier')::jsonb=(src->'issuerIdentifier')::jsonb
  AND (policy->'identifiers')::jsonb @> jsonb_build_array((src->'issuerIdentifier')::jsonb)
  AND (src->'parserConfig'->'qualification'->'conId')::jsonb=(policy->'listing'->'conId')::jsonb
  AND (policy->'listing')::jsonb=(instrument->'contract')::jsonb
  AND EXISTS(SELECT 1 FROM json_array_elements(cfg::json->'configuration'->'issuerMappings') m
    WHERE m->>'id'=instrument->>'issuerMappingId' AND m->>'issuerId'=policy->>'issuerId')) IS NOT TRUE
 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_IDENTITY'; END IF;
 ledger:='marketaux:ibkr-conid:'||(policy->'listing'->>'conId');
 source_bytes:=src::text;policy_hash:=encode(sha256(convert_to(source_bytes,'UTF8')),'hex');RETURN NEXT;
END $$;

CREATE FUNCTION research_marketaux_projection_hash(raw TEXT, source_id TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
 SELECT encode(sha256(convert_to('{"coverage":[' ||
  coalesce((SELECT string_agg(c::text,',') FROM json_array_elements(raw::json->'coverage') c WHERE c->>'sourceId'=source_id),'') || '],"evidence":[' ||
  coalesce((SELECT string_agg(e::text,',') FROM json_array_elements(raw::json->'evidence') e WHERE e->>'sourceId'=source_id),'') || '],"news":[' ||
  coalesce((SELECT string_agg(n::text,',') FROM json_array_elements(raw::json->'news') n WHERE EXISTS(SELECT 1 FROM json_array_elements(raw::json->'evidence') e WHERE e->>'sourceId'=source_id AND e->>'ref'=n->>'evidenceRef')),'') || ']}','UTF8')),'hex');
$$;

CREATE FUNCTION research_marketaux_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy RECORD; prior RECORD; snapshot RECORD; now_at TIMESTAMPTZ; coverage JSONB; receipt JSONB; receipt_page JSONB; call RECORD; n INTEGER;
BEGIN
 IF TG_OP='UPDATE' THEN
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
 PERFORM 1 FROM research_authority WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_AUTHORITY'; END IF;
 SELECT * INTO policy FROM research_marketaux_source_policy(NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id);
 IF NEW.ledger_key IS DISTINCT FROM policy.ledger OR NEW.source_hash IS DISTINCT FROM policy.policy_hash OR NEW.provider<>'https://api.marketaux.com'
  OR NEW.state<>'STARTED' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_POLICY_IDENTITY'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('research-marketaux-issuer:'||NEW.account_id||':'||NEW.ledger_key)::bigint);
 now_at:=clock_timestamp();
 IF NEW.started_at>now_at OR NEW.started_at<now_at-interval '3 seconds' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ADMISSION_TIME_INVALID'; END IF;
 FOR prior IN SELECT * FROM research_marketaux_attempts WHERE account_id=NEW.account_id AND ledger_key=NEW.ledger_key LOOP
  IF prior.state IN ('STARTED','FINALIZING','UNKNOWN') THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED'; END IF;
  IF NEW.started_at<prior.started_at+interval '1 hour' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_SLOT_TOO_EARLY'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER research_marketaux_attempt_guard BEFORE INSERT OR UPDATE ON research_marketaux_attempts FOR EACH ROW EXECUTE FUNCTION research_marketaux_attempt_guard();
CREATE TRIGGER research_marketaux_attempt_no_delete BEFORE DELETE ON research_marketaux_attempts FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_marketaux_attempt_no_truncate BEFORE TRUNCATE ON research_marketaux_attempts FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();

CREATE FUNCTION research_marketaux_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD; r RECORD;
BEGIN
 SELECT * INTO a FROM research_marketaux_attempts WHERE id=NEW.attempt_id FOR UPDATE;
 SELECT * INTO r FROM research_call_reservations WHERE call_key=NEW.call_key;
 IF a.state<>'STARTED' OR ROW(a.account_id,a.provider,a.config_hash,a.manifest_hash) IS DISTINCT FROM ROW(r.account_id,r.provider,r.config_hash,r.manifest_hash)
  OR r.kind<>'source' OR r.reserved_at<a.started_at OR r.deadline_at>a.deadline_at OR clock_timestamp()>=r.deadline_at
 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_CALL_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_marketaux_call_guard BEFORE INSERT ON research_marketaux_attempt_calls FOR EACH ROW EXECUTE FUNCTION research_marketaux_call_guard();
CREATE FUNCTION research_marketaux_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD; r RECORD;
BEGIN
 SELECT * INTO o FROM research_call_outcomes WHERE call_key=NEW.call_key;
 SELECT * INTO r FROM research_call_reservations WHERE call_key=NEW.call_key;
 IF o.call_key IS NULL OR NEW.recorded_at IS DISTINCT FROM o.recorded_at OR (o.outcome='SUCCEEDED') IS DISTINCT FROM (NEW.content_hash IS NOT NULL)
  OR NEW.recorded_at<r.reserved_at OR (o.outcome='SUCCEEDED' AND NEW.recorded_at>=r.deadline_at)
 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_RECEIPT_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_marketaux_receipt_guard BEFORE INSERT ON research_marketaux_response_receipts FOR EACH ROW EXECUTE FUNCTION research_marketaux_receipt_guard();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['research_marketaux_attempt_calls','research_marketaux_response_receipts','research_marketaux_budget_denials'] LOOP
  EXECUTE format('CREATE TRIGGER research_no_mutation BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION research_immutable()',t);
  EXECUTE format('CREATE TRIGGER research_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION research_immutable()',t);
 END LOOP;
END $$;
