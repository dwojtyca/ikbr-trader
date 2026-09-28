CREATE TABLE strategy_binding_legacy_inheritance (
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  implementation_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  permanently_disabled BOOLEAN NOT NULL,
  cooldown_until TIMESTAMPTZ CHECK(cooldown_until IS NULL OR isfinite(cooldown_until)),
  consecutive_loss_count INTEGER NOT NULL CHECK(consecutive_loss_count >= 0),
  cooldown_count INTEGER NOT NULL CHECK(cooldown_count >= 0),
  last_evaluated_fill_at TIMESTAMPTZ CHECK(last_evaluated_fill_at IS NULL OR isfinite(last_evaluated_fill_at)),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(captured_at)),
  PRIMARY KEY(source_hash, implementation_id)
);
CREATE TRIGGER strategy_binding_inheritance_immutable BEFORE UPDATE OR DELETE ON strategy_binding_legacy_inheritance
FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();

CREATE FUNCTION capture_strategy_binding_inheritance(source_hash TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  has_history BOOLEAN;
  has_momentum BOOLEAN;
  has_invalid_dates BOOLEAN;
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
      RAISE EXCEPTION 'LEGACY_STATE_SOURCE_UNPROVEN';
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

CREATE TABLE strategy_binding_state (
  account_id TEXT NOT NULL,
  broker TEXT NOT NULL CHECK(broker='ibkr'),
  conid TEXT NOT NULL,
  implementation_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  permanently_disabled BOOLEAN NOT NULL,
  cooldown_until TIMESTAMPTZ CHECK(cooldown_until IS NULL OR isfinite(cooldown_until)),
  consecutive_loss_count INTEGER NOT NULL CHECK(consecutive_loss_count >= 0),
  cooldown_count INTEGER NOT NULL CHECK(cooldown_count >= 0),
  last_exit_at TIMESTAMPTZ CHECK(last_exit_at IS NULL OR isfinite(last_exit_at)),
  last_proposal_id BIGINT,
  hold_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
  PRIMARY KEY(account_id,broker,conid,implementation_id),
  FOREIGN KEY(source_hash,implementation_id) REFERENCES strategy_binding_legacy_inheritance(source_hash,implementation_id)
);
CREATE TABLE strategy_binding_outcomes (
  original_proposal_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL,
  broker TEXT NOT NULL CHECK(broker='ibkr'),
  conid TEXT NOT NULL,
  implementation_id TEXT NOT NULL,
  final_exit_at TIMESTAMPTZ NOT NULL CHECK(isfinite(final_exit_at)),
  net_amount DOUBLE PRECISION NOT NULL CHECK(net_amount > '-Infinity'::float8 AND net_amount < 'Infinity'::float8),
  currency TEXT NOT NULL CHECK(currency IN ('PLN','USD')),
  economic_fingerprint TEXT NOT NULL CHECK(economic_fingerprint ~ '^[a-f0-9]{64}$'),
  economic_evidence JSONB NOT NULL,
  completion_report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
  FOREIGN KEY(account_id,broker,conid,implementation_id) REFERENCES strategy_binding_state(account_id,broker,conid,implementation_id)
);
CREATE TRIGGER strategy_binding_outcomes_immutable BEFORE UPDATE OR DELETE ON strategy_binding_outcomes
FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();
