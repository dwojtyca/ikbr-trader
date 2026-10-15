-- Existing rows retain their exact deadlines and canonical identities.
DO $$
DECLARE original TEXT;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO original FROM pg_constraint
 WHERE conrelid='research_wsh_refresh_cycles'::regclass AND conname='research_wsh_refresh_cycles_check' AND contype='c';
 IF original IS DISTINCT FROM 'CHECK ((next_regular_at = (started_at + ''00:15:00''::interval)))'
 THEN RAISE EXCEPTION 'RESEARCH_WSH_LEGACY_CONSTRAINT_MISMATCH'; END IF;
END $$;
ALTER TABLE research_wsh_refresh_cycles DROP CONSTRAINT research_wsh_refresh_cycles_check;
ALTER TABLE research_wsh_refresh_cycles ADD CONSTRAINT research_wsh_refresh_cycles_interval
 CHECK(next_regular_at=started_at+interval '15 minutes' OR next_regular_at=started_at+interval '1 hour');

-- json preserves the already-canonical lexical subtree; jsonb is only for semantic checks.
CREATE FUNCTION research_wsh_source_policy(p_config TEXT,p_manifest TEXT,p_instrument TEXT,p_source TEXT)
RETURNS TABLE(ledger TEXT, interval_ms INTEGER, policy_hash TEXT, source_bytes TEXT) LANGUAGE plpgsql STABLE AS $$
DECLARE raw TEXT; cfg TEXT; policy JSON; src JSON; instrument JSON; n INTEGER;
BEGIN
 SELECT canonical_json INTO raw FROM research_manifests WHERE config_hash=p_config AND manifest_hash=p_manifest;
 SELECT canonical_json INTO cfg FROM trading_configuration_snapshots WHERE effective_hash=p_config;
 IF raw IS NULL OR cfg IS NULL OR encode(sha256(convert_to(raw,'UTF8')),'hex')<>p_manifest
  OR encode(sha256(convert_to(cfg,'UTF8')),'hex')<>p_config THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_IDENTITY'; END IF;
 SELECT count(*) INTO n FROM json_array_elements(raw::json->'instruments') v WHERE v->>'instrumentId'=p_instrument;
 IF n<>1 THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_IDENTITY'; END IF;
 SELECT v INTO policy FROM json_array_elements(raw::json->'instruments') v WHERE v->>'instrumentId'=p_instrument;
 SELECT count(*) INTO n FROM json_array_elements(policy->'sources') v WHERE v->>'id'=p_source;
 IF n<>1 THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_IDENTITY'; END IF;
 SELECT v INTO src FROM json_array_elements(policy->'sources') v WHERE v->>'id'=p_source;
 SELECT count(*) INTO n FROM json_array_elements(cfg::json->'configuration'->'instruments') v WHERE v->>'id'=p_instrument;
 IF n<>1 THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_IDENTITY'; END IF;
 SELECT v INTO instrument FROM json_array_elements(cfg::json->'configuration'->'instruments') v WHERE v->>'id'=p_instrument;
 IF (src->>'adapter'='ibkr-wsh' AND src->>'provider'='ibkr-wsh'
   AND (src->'roles')::jsonb='["calendar"]'::jsonb AND (src->'urls')::jsonb='[]'::jsonb
   AND src->'parserConfig'->>'kind'='ibkr-wsh-v1'
   AND src->'issuerIdentifier'->>'scheme'='ISIN'
   AND length(src->'parserConfig'->>'isin')>0
   AND src->'parserConfig'->>'isin'=src->'issuerIdentifier'->>'value'
   AND (policy->'identifiers')::jsonb @> jsonb_build_array(jsonb_build_object('scheme','ISIN','value',src->'parserConfig'->>'isin'))
   AND json_typeof(src->'parserConfig'->'conId')='number'
   AND (src->'parserConfig'->'conId')::jsonb=(policy->'listing'->'conId')::jsonb
   AND (policy->'listing')::jsonb=(instrument->'contract')::jsonb
   AND EXISTS(SELECT 1 FROM json_array_elements(cfg::json->'configuration'->'issuerMappings') m
      WHERE m->>'id'=instrument->>'issuerMappingId' AND m->>'issuerId'=policy->>'issuerId')
   AND json_typeof(src->'parserConfig'->'refreshIntervalMs')='number'
   AND ((src->'parserConfig'->>'refreshIntervalMs'='900000' AND src->'parserConfig'->>'maxAgeMs' IN ('900000','86400000'))
     OR (src->'parserConfig'->>'refreshIntervalMs'='3600000' AND src->'parserConfig'->>'maxAgeMs'='86400000'))
   AND json_typeof(src->'parserConfig'->'maxAgeMs')='number') IS NOT TRUE
 THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_IDENTITY'; END IF;
 ledger:='ibkr-wsh:'||(src->'parserConfig'->>'isin');
 interval_ms:=(src->'parserConfig'->>'refreshIntervalMs')::integer;
 source_bytes:=src::text;policy_hash:=encode(sha256(convert_to(source_bytes,'UTF8')),'hex');RETURN NEXT;
END $$;

CREATE FUNCTION research_wsh_regular_not_before(p_ledger TEXT,p_interval INTEGER,p_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql VOLATILE AS $$
DECLARE due TIMESTAMPTZ; ac RECORD; original RECORD;
BEGIN
 IF p_interval NOT IN (900000,3600000) OR p_interval IS NULL OR p_at IS NULL THEN RAISE EXCEPTION 'RESEARCH_WSH_BOUNDS_INVALID'; END IF;
 SELECT max(greatest(next_regular_at,started_at+p_interval*interval '1 millisecond')) INTO due
 FROM research_wsh_refresh_cycles WHERE ledger_key=p_ledger;
 FOR ac IN SELECT a.* FROM research_wsh_acquisitions a WHERE a.ledger_key=p_ledger
   AND a.started_at>p_at-interval '1 hour'
   AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts t WHERE t.acquisition_id=a.id)
 LOOP
   SELECT * INTO original FROM research_wsh_source_policy(ac.config_hash,ac.manifest_hash,ac.instrument_id,ac.source_id);
   IF original.ledger IS DISTINCT FROM p_ledger THEN RAISE EXCEPTION 'RESEARCH_WSH_POLICY_IDENTITY'; END IF;
   due:=greatest(due,ac.started_at+greatest(original.interval_ms,p_interval)*interval '1 millisecond');
 END LOOP;
 RETURN due;
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
 prior:=research_wsh_regular_not_before(NEW.ledger_key,policy.interval_ms,NEW.started_at);
 IF prior IS NOT NULL AND NEW.started_at<prior THEN RAISE EXCEPTION 'RESEARCH_WSH_SLOT_TOO_EARLY'; END IF;
 RETURN NEW;
END $$;
