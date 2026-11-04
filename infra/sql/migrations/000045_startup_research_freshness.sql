-- Exact definitions read from a clean isolated database through migration44.
DO $$ DECLARE expected RECORD;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('research_marketaux_attempt_guard()','81bb85861c2cb1920cca8660c82d020bd07c7c2dcbf0c8baa11002985a46ce1a'),
  ('research_wsh_cycle_admission()','c3a5fb37ca6bd4942eb16d7fdf6a7299f9fe8db46aac52589220dbf2ff23c3d7'),
  ('research_wsh_read_predecessor_allows(text,uuid,text,timestamp with time zone,uuid)','4f4dd3849b0fbd8c40c4ecd591da6b49a0426ff47b733d53d390bcabdde211bd'),
  ('research_wsh_attempt_admission()','0670431368269e8bd82847e72de4ea5fd719e3d3f98bd2670ae5f4bef0ce64e3'),
  ('research_wsh_read_regular_boundary()','a54b90670267fd757929a6c2611f5c205488caea4bf2b530fb9fe0e6f7df2516'),
  ('research_wsh_refresh_attempt_guard()','7d02fa09ab5a236d7afdd1636e94fb7eac3d0dce2a27606f1ecdb2cb2f855d5c'),
  ('research_wsh_successor_guard()','16ba73f31445feed2a8187a7198d4ebb330d5579c8358494a9510b8c9f6efc05'),
  ('research_marketaux_call_guard()','77a198d42b9762e07afe43ed0c3f6f2ef1752c6d3a93a2f6489c6cc8ab915493')
 ) AS v(signature,hash) LOOP
  IF encode(sha256(convert_to(pg_get_functiondef(to_regprocedure(expected.signature)),'UTF8')),'hex') IS DISTINCT FROM expected.hash
  THEN RAISE EXCEPTION 'RESEARCH_DEMAND_BASELINE_FUNCTION_MISMATCH: %',expected.signature;END IF;
 END LOOP;
END $$;
-- Acquisition admission changes; historical receipts and deadlines stay unchanged.
ALTER TABLE research_marketaux_attempts ADD COLUMN admission_kind TEXT NOT NULL DEFAULT 'REGULAR'
 CHECK(admission_kind IN ('REGULAR','DEMAND'));
ALTER TABLE research_marketaux_attempts ADD COLUMN demand_request_id BIGINT REFERENCES research_repair_requests(id);
ALTER TABLE research_marketaux_attempts ADD CONSTRAINT research_marketaux_demand_link
 CHECK((admission_kind='REGULAR')=(demand_request_id IS NULL));
ALTER TABLE research_marketaux_attempts ADD COLUMN provider_refusal JSONB;
ALTER TABLE research_marketaux_attempts ADD COLUMN provider_not_before TIMESTAMPTZ;
ALTER TABLE research_marketaux_attempts ADD COLUMN provider_retry_invalid BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE research_wsh_refresh_cycles ADD COLUMN admission_kind TEXT NOT NULL DEFAULT 'REGULAR'
 CHECK(admission_kind IN ('REGULAR','DEMAND'));
ALTER TABLE research_wsh_refresh_cycles ADD COLUMN demand_request_id BIGINT REFERENCES research_repair_requests(id);
ALTER TABLE research_wsh_refresh_cycles ADD CONSTRAINT research_wsh_demand_link
 CHECK((admission_kind='REGULAR')=(demand_request_id IS NULL));
DO $$ DECLARE n TEXT; d TEXT;
BEGIN
 SELECT conname,pg_get_constraintdef(oid) INTO STRICT n,d FROM pg_constraint
 WHERE conrelid='research_marketaux_attempts'::regclass AND contype='u';
 IF d<>'UNIQUE (account_id, ledger_key, slot)' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_SLOT_CONSTRAINT_MISMATCH'; END IF;
 EXECUTE format('ALTER TABLE research_marketaux_attempts DROP CONSTRAINT %I',n);
END $$;
CREATE UNIQUE INDEX research_marketaux_regular_slot ON research_marketaux_attempts(account_id,ledger_key,slot) WHERE admission_kind='REGULAR';

CREATE FUNCTION research_source_attempt_history(p_account TEXT,p_ledger TEXT,p_wsh BOOLEAN)
RETURNS TABLE(id UUID,started_at TIMESTAMPTZ,finished_at TIMESTAMPTZ,deadline_at TIMESTAMPTZ,state TEXT,
 failure_class TEXT,failure_reason TEXT,source_error JSONB,recovered_at TIMESTAMPTZ,retry_due_at TIMESTAMPTZ,
 cycle_end TIMESTAMPTZ,config_hash TEXT,manifest_hash TEXT,instrument_id TEXT,source_id TEXT)
LANGUAGE sql STABLE AS $$
 SELECT a.id,a.started_at,a.finished_at,a.deadline_at,a.state,a.failure_class,a.failure_reason,a.source_error,
  (SELECT max(r.recorded_at) FROM research_marketaux_recoveries r WHERE r.attempt_id=a.id),NULL::timestamptz,NULL::timestamptz,
  a.config_hash,a.manifest_hash,a.instrument_id,a.source_id
 FROM research_marketaux_attempts a WHERE NOT p_wsh AND a.account_id=p_account AND a.ledger_key=p_ledger
 UNION ALL
 SELECT a.id,a.started_at,a.finished_at,a.deadline_at,a.state,a.failure_class,a.failure_reason,a.source_error,
  greatest((SELECT max(r.recorded_at) FROM research_wsh_read_recovery_predecessors d JOIN research_wsh_read_recoveries r ON r.id=d.recovery_id WHERE d.kind='WSH_ATTEMPT' AND d.predecessor_id=a.id),
   (SELECT max(r.recorded_at) FROM research_wsh_recovery_predecessors d JOIN research_wsh_recovery_receipts r ON r.id=d.receipt_id WHERE d.attempt_id=a.id)),
  a.retry_due_at,c.next_regular_at,c.config_hash,c.manifest_hash,c.instrument_id,c.source_id
 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE p_wsh AND c.ledger_key=p_ledger
 UNION ALL
 SELECT a.id,a.started_at,coalesce(a.retired_at,a.started_at),a.started_at+interval '35 seconds',
  CASE a.state WHEN 'PUBLISHED' THEN 'SUCCEEDED' WHEN 'PENDING' THEN 'STARTED' ELSE a.state END,
  CASE a.state WHEN 'PUBLISHED' THEN NULL WHEN 'FAILED' THEN 'HARD' ELSE 'UNCERTAIN' END,
  CASE WHEN a.state='FAILED' THEN 'RESEARCH_WSH_ORPHAN_FAILURE_UNPROVED' ELSE NULL END,NULL::jsonb,
  greatest((SELECT max(r.recorded_at) FROM research_wsh_read_recovery_predecessors d JOIN research_wsh_read_recoveries r ON r.id=d.recovery_id WHERE d.kind='WSH_ACQUISITION' AND d.predecessor_id=a.id),
   (SELECT max(r.recorded_at) FROM research_wsh_recovery_predecessors d JOIN research_wsh_recovery_receipts r ON r.id=d.receipt_id WHERE d.acquisition_id=a.id)),
  NULL::timestamptz,NULL::timestamptz,a.config_hash,a.manifest_hash,a.instrument_id,a.source_id
 FROM research_wsh_acquisitions a WHERE p_wsh AND a.ledger_key=p_ledger
  AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts t WHERE t.acquisition_id=a.id)
$$;

CREATE FUNCTION research_source_failure_retryable(p_id UUID,p_wsh BOOLEAN) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE a RECORD; calls_valid BOOLEAN; has_success BOOLEAN; has_failed BOOLEAN; raw JSONB; max_used BIGINT; max_cost BIGINT; next_cost BIGINT; used BIGINT; cost BIGINT;
BEGIN
 IF NOT p_wsh THEN
  SELECT * INTO a FROM research_marketaux_attempts WHERE id=p_id;
  IF NOT FOUND OR a.state<>'FAILED' THEN RETURN FALSE;END IF;
  SELECT NOT EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_reservations r USING(call_key)
   LEFT JOIN research_call_outcomes o USING(call_key) LEFT JOIN research_marketaux_response_receipts receipt USING(call_key)
   WHERE c.attempt_id=p_id AND (o.outcome IS NULL OR o.outcome NOT IN ('SUCCEEDED','FAILED') OR receipt.recorded_at IS DISTINCT FROM o.recorded_at
    OR o.recorded_at>a.finished_at OR (o.outcome='SUCCEEDED' AND receipt.content_hash IS NULL) OR (o.outcome='FAILED' AND receipt.content_hash IS NOT NULL)
    OR ROW(r.account_id,r.provider,r.config_hash,r.manifest_hash) IS DISTINCT FROM ROW(a.account_id,a.provider,a.config_hash,a.manifest_hash))) INTO calls_valid;
  IF NOT calls_valid THEN RETURN FALSE;END IF;
  SELECT EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=p_id AND o.outcome='SUCCEEDED'),
   EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=p_id AND o.outcome='FAILED') INTO has_success,has_failed;
  IF a.failure_class='HARD' AND a.failure_reason='RESEARCH_PROVIDER_USAGE_HOLD' THEN RETURN (NOT has_failed AND a.provider_refusal->>'reason'='RESEARCH_PROVIDER_USAGE_HOLD' AND (a.provider_refusal->>'recordedAt')::timestamptz<=a.finished_at AND NOT research_marketaux_usage_hold(a.account_id)) IS TRUE;END IF;
  IF a.failure_class='HARD' AND a.failure_reason='RESEARCH_SOURCE_HTTP_402' AND a.source_error->>'httpStatus'='402' THEN RETURN has_failed AND NOT research_marketaux_usage_hold(a.account_id);END IF;
  IF a.failure_class='HARD' THEN RETURN has_success AND a.failure_reason=ANY(ARRAY['RESEARCH_MARKETAUX_PAYLOAD_INVALID','RESEARCH_MARKETAUX_CONTENT_TYPE_INVALID','RESEARCH_MARKETAUX_BYTES_EXCEEDED','RESEARCH_MARKETAUX_RESULT_LIMIT','RESEARCH_MARKETAUX_RESULT_CHANGED','RESEARCH_MARKETAUX_DUPLICATE_UUID','RESEARCH_MARKETAUX_PUBLICATION_OUTSIDE_QUERY']);END IF;
  IF a.failure_class='TRANSIENT' THEN RETURN ((a.source_error->>'httpStatus' IN ('429','500','502','503','504') AND a.failure_reason='RESEARCH_SOURCE_HTTP_'||(a.source_error->>'httpStatus') AND has_failed)
   OR (a.failure_reason='RESEARCH_PROVIDER_COOLDOWN' AND research_marketaux_local_cooldown(a.id,a.account_id,a.finished_at))) IS TRUE;END IF;
  IF a.failure_class='BUDGET' THEN RETURN a.failure_reason='RESEARCH_BUDGET_EXHAUSTED' AND EXISTS(SELECT 1 FROM research_marketaux_budget_denials WHERE attempt_id=a.id) AND NOT has_failed;END IF;
  RETURN FALSE;
 END IF;
 SELECT t.*,c.account_id,c.config_hash,c.manifest_hash INTO a FROM research_wsh_refresh_attempts t JOIN research_wsh_refresh_cycles c ON c.id=t.cycle_id WHERE t.id=p_id;
 IF NOT FOUND OR a.state<>'FAILED' OR a.cleanup_state NOT IN ('CONFIRMED','NOT_NEEDED') THEN RETURN FALSE;END IF;
 IF a.acquisition_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM research_wsh_acquisitions ac WHERE ac.id=a.acquisition_id AND ac.state='FAILED' AND ac.retired_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM research_wsh_acquisition_calls c JOIN research_call_reservations r USING(call_key) LEFT JOIN research_call_outcomes o USING(call_key)
   WHERE c.acquisition_id=a.acquisition_id AND (o.outcome IS NULL OR o.outcome NOT IN ('SUCCEEDED','FAILED') OR o.recorded_at>a.finished_at
    OR ROW(r.account_id,r.provider,r.config_hash,r.manifest_hash) IS DISTINCT FROM ROW(a.account_id,'ibkr-wsh'::text,a.config_hash,a.manifest_hash)))) THEN RETURN FALSE;END IF;
 IF a.failure_class='HARD' THEN RETURN a.acquisition_id IS NOT NULL AND EXISTS(SELECT 1 FROM research_wsh_acquisition_calls WHERE acquisition_id=a.acquisition_id)
  AND a.failure_stage IN ('metadata','events','normalize') AND a.failure_reason=ANY(ARRAY['RESEARCH_WSH_PAYLOAD_INVALID','RESEARCH_WSH_METADATA_INVALID','RESEARCH_WSH_ROW_INVALID','RESEARCH_WSH_ROW_COUNT_INVALID','RESEARCH_WSH_DATE_INVALID','RESEARCH_WSH_STATUS_INVALID']);END IF;
 IF a.failure_class='BUSY' THEN RETURN (a.failure_reason='RESEARCH_WSH_ERROR_10281' AND a.provider_error->'code'='10281'::jsonb AND a.cleanup_state='CONFIRMED') IS TRUE;END IF;
 IF a.failure_class='TRANSIENT' THEN RETURN (a.failure_stage IN ('connect','metadata','events') AND
  (a.failure_reason IN ('RESEARCH_WSH_TIMEOUT','RESEARCH_WSH_DISCONNECTED')
   OR (a.failure_reason IN ('RESEARCH_WSH_ERROR_502','RESEARCH_WSH_CONNECT_FAILED') AND a.provider_error->'code'='502'::jsonb)
   OR (a.failure_reason='RESEARCH_WSH_SEND_FAILED' AND a.failure_stage<>'connect' AND (a.provider_error->'code'='502'::jsonb OR a.source_error->'code'='502'::jsonb OR a.source_error->>'code' IN ('ECONNRESET','ECONNREFUSED','ENOTCONN','EPIPE','ETIMEDOUT'))))) IS TRUE;END IF;
 IF a.failure_class='ABORTED' THEN RETURN a.failure_reason='RESEARCH_WSH_ABORTED';END IF;
 IF a.failure_class='BUDGET' AND a.failure_reason IN ('RESEARCH_BUDGET_EXHAUSTED','RESEARCH_CALL_BUDGET_EXHAUSTED') THEN
  SELECT canonical_json::jsonb INTO raw FROM research_manifests WHERE config_hash=a.config_hash AND manifest_hash=a.manifest_hash;
  SELECT min((s->>'maxRequestsPerDay')::bigint),min((s->>'maxCostMicrosPerDay')::bigint),max((s->>'costMicrosPerCall')::bigint)
   INTO max_used,max_cost,next_cost FROM jsonb_array_elements(raw->'instruments') i CROSS JOIN LATERAL jsonb_array_elements(i->'sources') s WHERE s->>'provider'='ibkr-wsh';
  SELECT count(*),coalesce(sum(reserved_cost_micros),0) INTO used,cost FROM research_call_reservations
   WHERE account_id=a.account_id AND provider='ibkr-wsh' AND budget_day=(a.finished_at AT TIME ZONE 'UTC')::date AND reserved_at<=a.finished_at;
  RETURN used>=max_used OR cost+next_cost>max_cost;
 END IF;
 RETURN FALSE;
END $$;

CREATE FUNCTION research_wsh_source_projection(p_raw TEXT,p_source TEXT) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('coverage',coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(p_raw::jsonb->'coverage') v WHERE v->>'sourceId'=p_source),'[]'::jsonb),
  'evidence',coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(p_raw::jsonb->'evidence') v WHERE v->>'sourceId'=p_source),'[]'::jsonb),
  'events',coalesce((SELECT jsonb_agg(v) FROM jsonb_array_elements(p_raw::jsonb->'events') v WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p_raw::jsonb->'evidence') e WHERE e->>'sourceId'=p_source AND e->>'ref'=v->>'evidenceRef')),'[]'::jsonb))
$$;

CREATE FUNCTION research_marketaux_usage_hold(p_account TEXT,p_at TIMESTAMPTZ DEFAULT clock_timestamp()) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 WITH latest AS (
  SELECT a.finished_at FROM research_marketaux_attempts a WHERE a.account_id=p_account AND a.finished_at<=p_at
   AND a.state IN ('FAILED','UNKNOWN') AND a.failure_reason='RESEARCH_SOURCE_HTTP_402' AND a.source_error->>'httpStatus'='402'
   AND EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_reservations r USING(call_key)
    JOIN research_call_outcomes o USING(call_key) JOIN research_marketaux_response_receipts receipt USING(call_key)
    WHERE c.attempt_id=a.id AND r.account_id=p_account AND r.provider=a.provider AND o.outcome='FAILED'
     AND receipt.content_hash IS NULL AND receipt.recorded_at=o.recorded_at AND o.recorded_at<=a.finished_at)
   ORDER BY a.finished_at DESC,a.id DESC LIMIT 1
 ) SELECT EXISTS(SELECT 1 FROM latest WHERE NOT EXISTS(
  SELECT 1 FROM research_call_reservations r JOIN research_marketaux_attempt_calls c USING(call_key)
   JOIN research_marketaux_attempts a ON a.id=c.attempt_id JOIN research_call_outcomes o USING(call_key)
   JOIN research_marketaux_response_receipts receipt USING(call_key)
  WHERE r.account_id=p_account AND r.provider='https://api.marketaux.com' AND a.account_id=p_account AND a.provider=r.provider
   AND r.reserved_at>latest.finished_at AND o.outcome='SUCCEEDED' AND receipt.content_hash IS NOT NULL
   AND receipt.recorded_at=o.recorded_at AND o.recorded_at>=r.reserved_at AND o.recorded_at<r.deadline_at AND o.recorded_at<=p_at))
$$;

CREATE FUNCTION research_source_demand(p_account TEXT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT,p_at TIMESTAMPTZ)
RETURNS TABLE(state TEXT,reason TEXT,next_at TIMESTAMPTZ) LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
DECLARE raw JSONB; policy JSONB; source JSONB; cfg JSONB; wsh BOOLEAN; ledger TEXT; sp RECORD; h RECORD;
 snap RECORD; coverage JSONB; valid BOOLEAN:=FALSE; invalidated BOOLEAN:=FALSE; last_good TIMESTAMPTZ; delay INTEGER;
 at_time TIMESTAMPTZ; cooldown TIMESTAMPTZ; expiry TIMESTAMPTZ; rec JSONB; used BIGINT; cost BIGINT; max_used BIGINT; max_cost BIGINT; next_cost BIGINT;
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
  IF h.state='FAILED' AND h.recovered_at IS NULL AND research_source_failure_retryable(h.id,wsh) IS NOT TRUE THEN reason:='RESEARCH_SOURCE_FAILURE_UNPROVED';RETURN NEXT;RETURN;END IF;
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
 next_at:=greatest(p_at,at_time+CASE delay WHEN 0 THEN interval '0 seconds' WHEN 1 THEN interval '30 seconds' WHEN 2 THEN interval '120 seconds' ELSE interval '10 minutes' END);
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

CREATE FUNCTION research_source_demand_admission(p_request BIGINT,p_account TEXT,p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT,p_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE r RECORD; d RECORD;
BEGIN
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

CREATE FUNCTION research_demand_metadata_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refused_at TIMESTAMPTZ; refusal TEXT;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.admission_kind,NEW.demand_request_id) IS DISTINCT FROM ROW(OLD.admission_kind,OLD.demand_request_id)
 THEN RAISE EXCEPTION 'RESEARCH_DEMAND_ADMISSION_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='research_marketaux_attempts' THEN
  IF TG_OP='INSERT' AND NEW.provider_refusal IS NOT NULL THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_REFUSAL_INVALID';END IF;
  IF TG_OP='UPDATE' AND NEW.provider_refusal IS DISTINCT FROM OLD.provider_refusal THEN
   IF OLD.provider_refusal IS NOT NULL THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_REFUSAL_IMMUTABLE';END IF;
   PERFORM pg_advisory_xact_lock(hashtext('research-budget:'||NEW.account_id||':'||NEW.provider)::bigint);
   refused_at:=(NEW.provider_refusal->>'recordedAt')::timestamptz;refusal:=NEW.provider_refusal->>'reason';
   IF (OLD.state='STARTED' AND clock_timestamp()<OLD.deadline_at AND refused_at>=OLD.started_at
    AND refused_at<=clock_timestamp() AND refused_at>=clock_timestamp()-interval '1 second'
    AND NEW.provider_refusal=jsonb_build_object('reason',refusal,'recordedAt',refused_at)
    AND (to_jsonb(NEW)-'provider_refusal')=(to_jsonb(OLD)-'provider_refusal')
    AND ((refusal='RESEARCH_PROVIDER_COOLDOWN' AND EXISTS(SELECT 1 FROM research_marketaux_attempts a WHERE a.account_id=NEW.account_id AND a.provider_not_before>refused_at))
     OR (refusal='RESEARCH_PROVIDER_USAGE_HOLD' AND NEW.admission_kind='DEMAND' AND research_marketaux_usage_hold(NEW.account_id,refused_at)))) IS NOT TRUE
   THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_REFUSAL_INVALID';END IF;
  END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.provider_not_before,NEW.provider_retry_invalid) IS DISTINCT FROM ROW(OLD.provider_not_before,OLD.provider_retry_invalid) OR NEW.state IN ('FAILED','UNKNOWN') AND NEW.source_error->>'httpStatus'='402') THEN PERFORM pg_advisory_xact_lock(hashtext('research-budget:'||NEW.account_id||':'||NEW.provider)::bigint);END IF;
  IF TG_OP='INSERT' AND (NEW.provider_not_before IS NOT NULL OR NEW.provider_retry_invalid)
   OR TG_OP='UPDATE' AND ROW(NEW.provider_not_before,NEW.provider_retry_invalid) IS DISTINCT FROM ROW(OLD.provider_not_before,OLD.provider_retry_invalid)
    AND (OLD.state='FINALIZING' AND NEW.state IN ('FAILED','UNKNOWN') AND NEW.finished_at IS NOT NULL
     AND NEW.provider_not_before>=NEW.finished_at
     AND (NOT NEW.provider_retry_invalid OR NEW.provider_not_before>=NEW.finished_at+interval '10 minutes')) IS NOT TRUE
  THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_COOLDOWN_INVALID';END IF;
  IF TG_OP='UPDATE' AND NEW.state IN ('FAILED','UNKNOWN') AND NEW.source_error->>'httpStatus'='429'
   AND (NEW.provider_not_before>=NEW.finished_at+interval '60 seconds') IS NOT TRUE
  THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_COOLDOWN_INVALID';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_demand_metadata_guard BEFORE INSERT OR UPDATE ON research_marketaux_attempts FOR EACH ROW EXECUTE FUNCTION research_demand_metadata_guard();


CREATE FUNCTION research_marketaux_local_cooldown(p_id UUID,p_account TEXT,p_at TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM research_marketaux_attempts a WHERE a.id=p_id AND a.account_id=p_account AND a.provider_refusal->>'reason'='RESEARCH_PROVIDER_COOLDOWN' AND (a.provider_refusal->>'recordedAt')::timestamptz<=p_at)
  AND NOT EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c LEFT JOIN research_call_outcomes o USING(call_key)
   LEFT JOIN research_marketaux_response_receipts r USING(call_key) WHERE c.attempt_id=p_id
    AND (o.outcome IS DISTINCT FROM 'SUCCEEDED' OR r.content_hash IS NULL OR r.recorded_at IS DISTINCT FROM o.recorded_at OR o.recorded_at>p_at))
$$;
CREATE OR REPLACE FUNCTION research_marketaux_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy RECORD; prior RECORD; snapshot RECORD; now_at TIMESTAMPTZ; coverage JSONB; receipt JSONB; receipt_page JSONB; call RECORD; n INTEGER;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.provider_refusal IS NULL AND NEW.provider_refusal IS NOT NULL AND OLD.state='STARTED' AND (to_jsonb(NEW)-'provider_refusal')=(to_jsonb(OLD)-'provider_refusal') THEN RETURN NEW;END IF;
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
    IF NEW.failure_class='TRANSIENT' AND ((NEW.failure_reason='RESEARCH_PROVIDER_COOLDOWN' AND research_marketaux_local_cooldown(NEW.id,NEW.account_id,NEW.finished_at)) OR (NEW.source_error->>'httpStatus' IN ('429','500','502','503','504') AND NEW.failure_reason='RESEARCH_SOURCE_HTTP_'||(NEW.source_error->>'httpStatus')
      AND EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=NEW.id AND o.outcome='FAILED'))) IS NOT TRUE
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
    OR NEW.failure_class='TRANSIENT' AND NOT (NEW.failure_reason='RESEARCH_PROVIDER_COOLDOWN' AND research_marketaux_local_cooldown(NEW.id,NEW.account_id,NEW.finished_at)) AND NOT EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_outcomes o USING(call_key) WHERE c.attempt_id=NEW.id AND o.outcome='FAILED'))
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
 PERFORM pg_advisory_xact_lock(hashtext('research-budget:'||NEW.account_id||':'||NEW.provider)::bigint);
 now_at:=clock_timestamp();
 IF NEW.started_at>now_at OR NEW.started_at<now_at-interval '3 seconds' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ADMISSION_TIME_INVALID'; END IF;
 FOR prior IN SELECT * FROM research_marketaux_attempts WHERE account_id=NEW.account_id AND ledger_key=NEW.ledger_key LOOP
  IF prior.state IN ('STARTED','FINALIZING','UNKNOWN') AND NOT EXISTS(SELECT 1 FROM research_marketaux_recoveries r WHERE r.attempt_id=prior.id) THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED'; END IF;
  IF NEW.admission_kind='REGULAR' AND NEW.started_at<prior.started_at+interval '1 hour' THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_SLOT_TOO_EARLY'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM research_marketaux_attempts a WHERE a.account_id=NEW.account_id AND a.provider_not_before>NEW.started_at) THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_COOLDOWN';END IF;
 IF NEW.admission_kind='DEMAND' AND NOT research_source_demand_admission(NEW.demand_request_id,NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id,NEW.started_at) THEN RAISE EXCEPTION 'RESEARCH_SOURCE_DEMAND_DENIED';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION research_wsh_cycle_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior TIMESTAMPTZ; policy RECORD;
BEGIN
 PERFORM 1 FROM research_authority WHERE config_hash=NEW.config_hash AND manifest_hash=NEW.manifest_hash FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_AUTHORITY'; END IF;
 SELECT * INTO policy FROM research_wsh_source_policy(NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id);
 IF NEW.ledger_key IS DISTINCT FROM policy.ledger OR NEW.source_policy_hash IS DISTINCT FROM policy.policy_hash
   OR NEW.next_regular_at IS DISTINCT FROM NEW.started_at+policy.interval_ms*interval '1 millisecond'
 THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_IDENTITY'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('research-wsh-issuer:'||NEW.ledger_key)::bigint);
 IF NEW.admission_kind='DEMAND' AND (NEW.started_at>clock_timestamp() OR NEW.started_at<clock_timestamp()-interval '3 seconds') THEN RAISE EXCEPTION 'RESEARCH_WSH_ADMISSION_TIME_INVALID';END IF;
 prior:=research_wsh_regular_not_before(NEW.ledger_key,policy.interval_ms,NEW.started_at);
 IF NEW.admission_kind='REGULAR' AND prior IS NOT NULL AND NEW.started_at<prior THEN RAISE EXCEPTION 'RESEARCH_WSH_SLOT_TOO_EARLY'; END IF;
 IF NEW.admission_kind='DEMAND' AND NOT research_source_demand_admission(NEW.demand_request_id,NEW.account_id,NEW.config_hash,NEW.manifest_hash,NEW.instrument_id,NEW.source_id,NEW.started_at) THEN RAISE EXCEPTION 'RESEARCH_SOURCE_DEMAND_DENIED';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION research_wsh_read_predecessor_allows(p_kind TEXT,p_id UUID,p_ledger TEXT,p_started TIMESTAMPTZ,p_cycle UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors d JOIN research_wsh_read_recoveries r ON r.id=d.recovery_id
  WHERE d.kind=p_kind AND d.predecessor_id=p_id AND p_started>=r.recorded_at
   AND (EXISTS(SELECT 1 FROM research_wsh_refresh_cycles c WHERE c.id=p_cycle AND c.admission_kind='DEMAND' AND c.ledger_key=p_ledger AND c.started_at=p_started) OR p_started>=coalesce((SELECT (i->>'nextRegularAt')::timestamptz FROM jsonb_array_elements(r.canonical_json::jsonb->'issuers') i WHERE i->>'ledgerKey'=p_ledger),r.recorded_at))
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
   (NEW.ordinal=0 AND (NEW.started_at>=c.next_regular_at OR cycle.admission_kind='DEMAND')) OR EXISTS(SELECT 1 FROM research_wsh_recovery_successors s
    JOIN research_wsh_refresh_attempts first_attempt ON first_attempt.id=s.attempt_id WHERE s.receipt_id=p.receipt_id AND first_attempt.started_at<=NEW.started_at))) AND NOT research_wsh_read_predecessor_allows('WSH_ATTEMPT',a.id,cycle.ledger_key,cycle.started_at,cycle.id)) THEN RAISE EXCEPTION 'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED'; END IF;
 IF cycle.admission_kind='DEMAND' AND (NEW.ordinal<>0 OR NEW.retry_due_at IS NOT NULL) THEN RAISE EXCEPTION 'RESEARCH_WSH_DEMAND_RETRY_INVALID';END IF;
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

CREATE OR REPLACE FUNCTION research_wsh_read_regular_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ledger TEXT; started TIMESTAMPTZ; due TIMESTAMPTZ; demand BOOLEAN:=FALSE;
BEGIN
 ledger:=NEW.ledger_key; started:=NEW.started_at;
 SELECT max((i->>'nextRegularAt')::timestamptz) INTO due FROM research_wsh_read_recoveries r CROSS JOIN LATERAL jsonb_array_elements(r.canonical_json::jsonb->'issuers') i WHERE i->>'ledgerKey'=ledger;
 IF TG_TABLE_NAME='research_wsh_refresh_cycles' THEN demand:=NEW.admission_kind='DEMAND';
 ELSE SELECT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE c.admission_kind='DEMAND' AND a.state='STARTED' AND a.preflight_complete AND a.session_id=NEW.session_id AND a.endpoint_id=NEW.endpoint_id AND c.ledger_key=NEW.ledger_key AND c.config_hash=NEW.config_hash AND c.manifest_hash=NEW.manifest_hash AND c.instrument_id=NEW.instrument_id AND c.source_id=NEW.source_id AND a.acquisition_id IS NULL AND a.deadline_at>clock_timestamp()) INTO demand;END IF;
 IF NOT demand AND due IS NOT NULL AND started<due THEN RAISE EXCEPTION 'RESEARCH_WSH_SLOT_TOO_EARLY'; END IF;
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

CREATE OR REPLACE FUNCTION research_wsh_refresh_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM research_wsh_refresh_cycles c WHERE c.id=NEW.cycle_id AND c.admission_kind='DEMAND') AND (NEW.ordinal<>0 OR NEW.retry_due_at IS NOT NULL) THEN RAISE EXCEPTION 'RESEARCH_WSH_DEMAND_RETRY_INVALID';END IF;
 IF TG_OP='DELETE' OR OLD.state<>'STARTED' THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_IMMUTABLE'; END IF;
 IF ROW(NEW.id,NEW.cycle_id,NEW.ordinal,NEW.predecessor_id,NEW.endpoint_id,NEW.session_id,NEW.started_at,NEW.deadline_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.cycle_id,OLD.ordinal,OLD.predecessor_id,OLD.endpoint_id,OLD.session_id,OLD.started_at,OLD.deadline_at)
   OR (OLD.preflight_complete AND NOT NEW.preflight_complete)
   OR (OLD.acquisition_id IS NOT NULL AND NEW.acquisition_id IS DISTINCT FROM OLD.acquisition_id)
 THEN RAISE EXCEPTION 'RESEARCH_WSH_ATTEMPT_IDENTITY'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION research_wsh_successor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM research_wsh_recovery_receipts r JOIN research_wsh_refresh_attempts a ON a.id=NEW.attempt_id
  JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id JOIN research_recovery_challenges ch ON ch.id=r.challenge_id
  WHERE r.id=NEW.receipt_id AND ch.state='COMMITTED' AND a.endpoint_id=r.endpoint_id AND a.ordinal=0 AND a.started_at>=r.recorded_at
   AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p JOIN research_wsh_refresh_attempts previous_attempt ON previous_attempt.id=p.attempt_id JOIN research_wsh_refresh_cycles oc ON oc.id=previous_attempt.cycle_id
     WHERE p.receipt_id=r.id AND c.admission_kind='REGULAR' AND a.started_at<oc.next_regular_at))
 THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_SUCCESSOR_INVALID'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION research_marketaux_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a RECORD; r RECORD;
BEGIN
 SELECT * INTO a FROM research_marketaux_attempts WHERE id=NEW.attempt_id FOR UPDATE;
 IF a.provider_refusal IS NOT NULL THEN RAISE EXCEPTION '%',a.provider_refusal->>'reason';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('research-budget:'||a.account_id||':'||a.provider)::bigint);
 IF EXISTS(SELECT 1 FROM research_marketaux_attempts other WHERE other.account_id=a.account_id AND other.provider_not_before>clock_timestamp()) THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_COOLDOWN';END IF;
 IF a.admission_kind='DEMAND' AND research_marketaux_usage_hold(a.account_id) THEN RAISE EXCEPTION 'RESEARCH_PROVIDER_USAGE_HOLD';END IF;
 SELECT * INTO r FROM research_call_reservations WHERE call_key=NEW.call_key;
 IF a.state<>'STARTED' OR ROW(a.account_id,a.provider,a.config_hash,a.manifest_hash) IS DISTINCT FROM ROW(r.account_id,r.provider,r.config_hash,r.manifest_hash)
  OR r.kind<>'source' OR r.reserved_at<a.started_at OR r.deadline_at>a.deadline_at OR clock_timestamp()>=r.deadline_at
 THEN RAISE EXCEPTION 'RESEARCH_MARKETAUX_CALL_INVALID'; END IF;
 RETURN NEW;
END $$;
