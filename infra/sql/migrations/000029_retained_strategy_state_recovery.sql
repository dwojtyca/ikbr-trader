CREATE TABLE strategy_retained_state_recoveries (
  source_hash TEXT PRIMARY KEY REFERENCES trading_configuration_snapshots(effective_hash),
  legacy_authority_hash TEXT NOT NULL CHECK(legacy_authority_hash ~ '^[a-f0-9]{64}$'),
  legacy_authority_canonical TEXT NOT NULL,
  account_hash TEXT NOT NULL CHECK(account_hash ~ '^[a-f0-9]{64}$'),
  state_capture JSONB NOT NULL CHECK(jsonb_typeof(state_capture)='array'),
  state_digest TEXT NOT NULL CHECK(state_digest ~ '^[a-f0-9]{64}$'),
  history_count BIGINT NOT NULL CHECK(history_count>0),
  history_digest TEXT NOT NULL CHECK(history_digest ~ '^[a-f0-9]{64}$'),
  inspection_digest TEXT NOT NULL CHECK(inspection_digest ~ '^[a-f0-9]{64}$'),
  capture_semantics TEXT NOT NULL CHECK(capture_semantics='present_legacy_state_not_historical_ownership_v1'),
  capture_transaction BIGINT NOT NULL DEFAULT txid_current(),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER retained_state_recovery_immutable BEFORE UPDATE OR DELETE ON strategy_retained_state_recoveries
FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
CREATE TRIGGER retained_state_recovery_no_truncate BEFORE TRUNCATE ON strategy_retained_state_recoveries
FOR EACH STATEMENT EXECUTE FUNCTION trading_configuration_immutable();

-- Includes proposal-backed reservations and unowned retained fills. Never touches budgets.
CREATE FUNCTION lock_retained_strategy_recovery() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('trading_configuration_v1')::bigint);
  LOCK TABLE proposed_orders IN EXCLUSIVE MODE;
  LOCK TABLE proposal_ai_reviews IN EXCLUSIVE MODE;
  LOCK TABLE broker_order_links,lifecycle_close_operations,broker_execution_fills IN SHARE MODE;
  LOCK TABLE broker_order_ref_map,strategy_trigger_fences,strategy_binding_state,strategy_binding_outcomes,
    strategy_runtime_conversion,strategy_binding_legacy_inheritance,strategy_retained_state_recoveries,
    research_bindings,proposal_ai_model_calls,proposal_ai_model_outcomes,proposal_ai_model_late_outcomes,
    paper_run_proposals,gpw_proposals,aapl_proposals,execution_audit_log,
    research_call_reservations,research_call_outcomes,research_wsh_acquisitions IN SHARE MODE;
  PERFORM pg_advisory_xact_lock(1820018);
  IF to_regclass('strategy_runtime_state') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE strategy_runtime_state IN SHARE ROW EXCLUSIVE MODE';
  END IF;
END $$;

CREATE FUNCTION retained_strategy_recovery_inventory() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE states JSONB; history JSONB; count_history BIGINT;
BEGIN
  IF to_regclass('strategy_runtime_state') IS NULL THEN RAISE EXCEPTION 'RETAINED_RECOVERY_STATE_UNAVAILABLE'; END IF;
  EXECUTE 'SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY strategy_id),''[]''::jsonb) FROM strategy_runtime_state s' INTO states;
  SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY exec_id),'[]'::jsonb),count(*) INTO history,count_history FROM broker_execution_fills f;
  RETURN jsonb_build_object('stateCapture',states,'stateDigest',encode(sha256(convert_to(states::text,'UTF8')),'hex'),
    'historyCount',count_history,'historyDigest',encode(sha256(convert_to(history::text,'UTF8')),'hex'));
END $$;

CREATE FUNCTION assert_retained_strategy_recovery(source TEXT,account_digest TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE config JSONB; states JSONB; item JSONB; algorithm TEXT; peers JSONB; valid BOOLEAN;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM trading_configuration_rollout WHERE singleton AND bundle_latched AND legacy_source_hash IS NULL AND first_effective_hash=source) THEN
    RAISE EXCEPTION 'RETAINED_RECOVERY_ROLLOUT_MISMATCH'; END IF;
  SELECT canonical_json::jsonb->'configuration' INTO config FROM trading_configuration_snapshots WHERE effective_hash=source;
  IF config IS NULL THEN RAISE EXCEPTION 'RETAINED_RECOVERY_ROLLOUT_MISMATCH'; END IF;
  IF EXISTS(SELECT 1 FROM proposed_orders) OR EXISTS(SELECT 1 FROM proposal_ai_reviews)
    OR EXISTS(SELECT 1 FROM broker_order_links) OR EXISTS(SELECT 1 FROM broker_order_ref_map)
    OR EXISTS(SELECT 1 FROM lifecycle_close_operations) OR EXISTS(SELECT 1 FROM strategy_trigger_fences)
    OR EXISTS(SELECT 1 FROM strategy_binding_state) OR EXISTS(SELECT 1 FROM strategy_binding_outcomes)
    OR EXISTS(SELECT 1 FROM strategy_runtime_conversion) OR EXISTS(SELECT 1 FROM strategy_binding_legacy_inheritance)
    OR EXISTS(SELECT 1 FROM research_bindings) OR EXISTS(SELECT 1 FROM proposal_ai_model_calls)
    OR EXISTS(SELECT 1 FROM paper_run_proposals) OR EXISTS(SELECT 1 FROM gpw_proposals) OR EXISTS(SELECT 1 FROM aapl_proposals)
    OR EXISTS(SELECT 1 FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key)
      WHERE o.call_key IS NULL OR o.outcome='UNKNOWN')
    OR EXISTS(SELECT 1 FROM research_wsh_acquisitions WHERE state='UNKNOWN' OR state='PENDING' AND retired_at IS NULL) THEN
    RAISE EXCEPTION 'RETAINED_RECOVERY_OWNERSHIP_PRESENT'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) INTO peers FROM trading_configuration_observations o
    WHERE expires_at>clock_timestamp();
  FOREACH algorithm IN ARRAY ARRAY['ingestion','signal-engine','execution-engine','llm-agent'] LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(peers) p WHERE p->>'service'=algorithm) THEN
      RAISE EXCEPTION 'RETAINED_RECOVERY_PEER_MISMATCH'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(peers) p WHERE p->>'mode'<>'bundle' OR p->>'effective_hash' IS DISTINCT FROM source
    OR p->>'schema_version' IS DISTINCT FROM '1' OR p->>'canonical_version' IS DISTINCT FROM '1'
    OR (p->>'observed_at')::timestamptz>clock_timestamp() OR (p->>'observed_at')::timestamptz<=clock_timestamp()-interval '30 seconds'
    OR (p->>'expires_at')::timestamptz-(p->>'observed_at')::timestamptz>interval '30 seconds') THEN
    RAISE EXCEPTION 'RETAINED_RECOVERY_PEER_MISMATCH'; END IF;
  IF NOT EXISTS(SELECT 1 FROM broker_execution_fills) OR EXISTS(SELECT 1 FROM broker_execution_fills
    WHERE proposed_order_id IS NOT NULL OR account_id IS NULL OR btrim(account_id)='' OR conid IS NULL OR conid !~ '^[1-9][0-9]*$'
      OR executed_at IS NULL OR NOT isfinite(executed_at) OR encode(sha256(convert_to(account_id,'UTF8')),'hex')<>account_digest) THEN
    RAISE EXCEPTION 'RETAINED_RECOVERY_HISTORY_INVALID'; END IF;
  states := retained_strategy_recovery_inventory()->'stateCapture';
  IF jsonb_array_length(states)=0 THEN RAISE EXCEPTION 'RETAINED_RECOVERY_STATE_UNAVAILABLE'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(states) LOOP
    valid := jsonb_typeof(item->'enabled')='boolean' AND jsonb_typeof(item->'permanently_disabled')='boolean'
      AND item->>'strategy_id' IS NOT NULL AND length(item->>'strategy_id')>0
      AND item->>'consecutive_loss_count' ~ '^[0-9]+$' AND item->>'cooldown_count' ~ '^[0-9]+$';
    IF valid IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'RETAINED_RECOVERY_STATE_INVALID'; END IF;
    FOREACH algorithm IN ARRAY ARRAY['cooldown_until','last_evaluated_fill_at','last_state_change_at','updated_at'] LOOP
      IF (algorithm IN ('cooldown_until','last_evaluated_fill_at') AND NOT item ? algorithm) OR item ? algorithm AND item->algorithm<>'null'::jsonb AND NOT isfinite((item->>algorithm)::timestamptz) THEN
        RAISE EXCEPTION 'RETAINED_RECOVERY_STATE_INVALID'; END IF;
    END LOOP;
  END LOOP;
  FOR algorithm IN SELECT value->>'implementationId' FROM jsonb_array_elements(config->'strategyInstances') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(states) s WHERE s->>'strategy_id'=algorithm) THEN
      RAISE EXCEPTION 'RETAINED_RECOVERY_STATE_UNAVAILABLE'; END IF;
  END LOOP;
END $$;

CREATE FUNCTION retained_strategy_inspection_digest(source TEXT,authority TEXT,account_digest TEXT,inventory JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(format('{"accountHash":%s,"historyCount":%s,"historyDigest":%s,"legacyAuthorityHash":%s,"schemaVersion":1,"sourceHash":%s,"stateCount":%s,"stateDigest":%s}',
    to_jsonb(account_digest),inventory->'historyCount',inventory->'historyDigest',to_jsonb(authority),to_jsonb(source),
    jsonb_array_length(inventory->'stateCapture'),inventory->'stateDigest'),'UTF8')),'hex')
$$;

CREATE FUNCTION validate_retained_strategy_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inventory JSONB; authority JSONB;
BEGIN
  PERFORM lock_retained_strategy_recovery();
  PERFORM assert_retained_strategy_recovery(NEW.source_hash,NEW.account_hash);
  inventory := retained_strategy_recovery_inventory();
  authority := NEW.legacy_authority_canonical::jsonb;
  IF (jsonb_typeof(authority)='object' AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(authority) k)=ARRAY['bindings','canonicalVersion','instruments']
    AND authority->>'canonicalVersion'='1' AND jsonb_typeof(authority->'instruments')='array' AND jsonb_typeof(authority->'bindings')='array') IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'RETAINED_RECOVERY_LEGACY_EVIDENCE_INVALID'; END IF;
  IF jsonb_array_length(authority->'instruments')=0 OR jsonb_array_length(authority->'instruments')<>jsonb_array_length(authority->'bindings') THEN
    RAISE EXCEPTION 'RETAINED_RECOVERY_LEGACY_EVIDENCE_INVALID'; END IF;
  IF NEW.capture_transaction<>txid_current() OR NEW.captured_at<statement_timestamp() OR NEW.captured_at>clock_timestamp()
    OR NEW.inspection_digest<>retained_strategy_inspection_digest(NEW.source_hash,NEW.legacy_authority_hash,NEW.account_hash,inventory)
    OR NEW.state_capture<>inventory->'stateCapture'
    OR NEW.state_digest<>inventory->>'stateDigest' OR NEW.history_count<>(inventory->>'historyCount')::bigint
    OR NEW.history_digest<>inventory->>'historyDigest'
    OR NEW.legacy_authority_hash<>encode(sha256(convert_to(NEW.legacy_authority_canonical,'UTF8')),'hex') THEN
    RAISE EXCEPTION 'RETAINED_RECOVERY_EVIDENCE_CHANGED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retained_state_recovery_valid BEFORE INSERT ON strategy_retained_state_recoveries
FOR EACH ROW EXECUTE FUNCTION validate_retained_strategy_recovery();

CREATE OR REPLACE FUNCTION capture_strategy_binding_inheritance(source_hash TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  has_history BOOLEAN;
  has_momentum BOOLEAN;
  has_invalid_dates BOOLEAN;
  recovery strategy_retained_state_recoveries%ROWTYPE;
  inventory JSONB;
BEGIN
  IF source_hash IS NULL OR source_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'LEGACY_STATE_SOURCE_INVALID'; END IF;
  PERFORM pg_advisory_xact_lock(1820018);
  SELECT EXISTS(SELECT 1 FROM proposed_orders WHERE execution_attempted_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM broker_execution_fills)
    OR EXISTS(SELECT 1 FROM broker_order_links)
    OR EXISTS(SELECT 1 FROM lifecycle_close_operations) INTO has_history;
  IF NOT EXISTS(SELECT 1 FROM trading_configuration_management_snapshots WHERE trading_configuration_management_snapshots.source_hash=$1 AND entries_disabled=TRUE) THEN
    IF NOT EXISTS(SELECT 1 FROM trading_configuration_snapshots WHERE effective_hash=$1) THEN
      RAISE EXCEPTION 'LEGACY_STATE_SOURCE_UNPROVEN';
    END IF;
    IF has_history AND NOT EXISTS(SELECT 1 FROM strategy_binding_legacy_inheritance i WHERE i.source_hash=$1) THEN
      SELECT * INTO recovery FROM strategy_retained_state_recoveries r WHERE r.source_hash=$1 AND r.capture_transaction=txid_current();
      IF NOT FOUND THEN RAISE EXCEPTION 'LEGACY_STATE_SOURCE_UNPROVEN'; END IF;
      PERFORM assert_retained_strategy_recovery($1,recovery.account_hash);
      inventory := retained_strategy_recovery_inventory();
      IF recovery.state_capture<>inventory->'stateCapture' OR recovery.state_digest<>inventory->>'stateDigest'
        OR recovery.history_count<>(inventory->>'historyCount')::bigint OR recovery.history_digest<>inventory->>'historyDigest' THEN
        RAISE EXCEPTION 'RETAINED_RECOVERY_EVIDENCE_CHANGED'; END IF;
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM strategy_binding_legacy_inheritance i WHERE i.source_hash=$1) THEN RETURN; END IF;
  IF to_regclass('strategy_runtime_state') IS NULL THEN
    IF has_history THEN RAISE EXCEPTION 'LEGACY_STATE_UNAVAILABLE'; END IF;
  ELSE
    EXECUTE 'LOCK TABLE strategy_runtime_state IN SHARE ROW EXCLUSIVE MODE';
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM strategy_runtime_state WHERE
      (cooldown_until IS NOT NULL AND NOT isfinite(cooldown_until)) OR
      (last_evaluated_fill_at IS NOT NULL AND NOT isfinite(last_evaluated_fill_at)))' INTO has_invalid_dates;
    IF has_invalid_dates THEN RAISE EXCEPTION 'LEGACY_STATE_TIME_INVALID'; END IF;
    EXECUTE 'INSERT INTO strategy_binding_legacy_inheritance(source_hash,implementation_id,enabled,permanently_disabled,cooldown_until,consecutive_loss_count,cooldown_count,last_evaluated_fill_at)
      SELECT $1,strategy_id,enabled,permanently_disabled,cooldown_until,consecutive_loss_count,cooldown_count,last_evaluated_fill_at FROM strategy_runtime_state' USING source_hash;
  END IF;
  SELECT EXISTS(SELECT 1 FROM strategy_binding_legacy_inheritance i WHERE i.source_hash=$1 AND implementation_id='momentum_breakout_long_v1') INTO has_momentum;
  IF NOT has_momentum THEN
    IF has_history THEN RAISE EXCEPTION 'LEGACY_STATE_UNAVAILABLE'; END IF;
    INSERT INTO strategy_binding_legacy_inheritance(source_hash,implementation_id,enabled,permanently_disabled,consecutive_loss_count,cooldown_count)
      VALUES(source_hash,'momentum_breakout_long_v1',TRUE,FALSE,0,0);
  END IF;
END $$;
