ALTER TABLE proposed_orders
  ADD COLUMN client_order_hash_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN strategy_attribution JSONB,
  ADD COLUMN strategy_trigger JSONB,
  ADD COLUMN strategy_configuration_hash TEXT GENERATED ALWAYS AS (strategy_attribution->>'effectiveConfigHash') STORED,
  ADD CONSTRAINT proposed_strategy_configuration_fk FOREIGN KEY(strategy_configuration_hash) REFERENCES trading_configuration_snapshots(effective_hash),
  ADD CONSTRAINT proposed_strategy_identity_version CHECK (
    (client_order_hash_version=1 AND strategy_attribution IS NULL AND strategy_trigger IS NULL) OR
    (client_order_hash_version=2 AND strategy_attribution IS NOT NULL AND strategy_trigger IS NOT NULL
      AND jsonb_typeof(strategy_attribution)='object' AND jsonb_typeof(strategy_trigger)='object'
      AND instrument_id IS NOT NULL AND client_order_hash IS NOT NULL));

ALTER TABLE proposal_ai_reviews
  ADD COLUMN client_order_hash_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN strategy_attribution JSONB,
  ADD COLUMN strategy_trigger JSONB,
  ADD CONSTRAINT review_strategy_identity_version CHECK (
    (client_order_hash_version=1 AND strategy_attribution IS NULL AND strategy_trigger IS NULL) OR
    (client_order_hash_version=2 AND strategy_attribution IS NOT NULL AND strategy_trigger IS NOT NULL));

CREATE TABLE strategy_runtime_conversion (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  source_hash TEXT NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  v2_not_before_bucket_ms BIGINT NOT NULL CHECK(v2_not_before_bucket_ms >= 0 AND v2_not_before_bucket_ms % 60000 = 0),
  converted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER strategy_runtime_conversion_immutable BEFORE UPDATE OR DELETE ON strategy_runtime_conversion
  FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();

CREATE TABLE strategy_trigger_fences (
  account_id TEXT NOT NULL,
  broker TEXT NOT NULL CHECK(broker='ibkr'),
  conid TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
  source TEXT NOT NULL CHECK(source='evaluation_bucket'),
  timeframe TEXT NOT NULL CHECK(timeframe='1m'),
  bucket_start_ms BIGINT NOT NULL CHECK(bucket_start_ms>=0 AND bucket_start_ms%60000=0),
  proposed_order_id BIGINT NOT NULL UNIQUE REFERENCES proposed_orders(id) ON DELETE RESTRICT,
  client_order_hash TEXT NOT NULL,
  strategy_trigger JSONB NOT NULL,
  PRIMARY KEY(account_id,broker,conid,direction,source,timeframe,bucket_start_ms)
);
CREATE TRIGGER strategy_trigger_fences_immutable BEFORE UPDATE OR DELETE ON strategy_trigger_fences
  FOR EACH ROW EXECUTE FUNCTION trading_configuration_immutable();

CREATE FUNCTION protect_strategy_proposal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.client_order_hash_version=2 THEN RAISE EXCEPTION 'strategy proposal identity is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.client_order_hash_version=1 AND COALESCE(NEW.position_effect,'OPEN_OR_ADD')<>'CLOSE_OR_REDUCE'
    AND (TG_OP='INSERT' OR (OLD.execution_attempted_at IS NULL AND NEW.execution_attempted_at IS NOT NULL))
    AND EXISTS(SELECT 1 FROM strategy_runtime_conversion WHERE singleton=TRUE) THEN
    RAISE EXCEPTION 'LEGACY_ENTRY_AFTER_STRATEGY_CONVERSION';
  END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF (OLD.client_order_hash_version,OLD.strategy_attribution,OLD.strategy_trigger)
       IS DISTINCT FROM (NEW.client_order_hash_version,NEW.strategy_attribution,NEW.strategy_trigger)
    OR (OLD.client_order_hash_version=2 AND
      (OLD.client_order_id,OLD.client_order_hash,OLD.instrument_id,OLD.conid,OLD.instrument,OLD.strategy)
       IS DISTINCT FROM (NEW.client_order_id,NEW.client_order_hash,NEW.instrument_id,NEW.conid,NEW.instrument,NEW.strategy)) THEN
    RAISE EXCEPTION 'strategy proposal identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER proposed_strategy_identity_immutable BEFORE INSERT OR UPDATE OR DELETE ON proposed_orders
  FOR EACH ROW EXECUTE FUNCTION protect_strategy_proposal_identity();

CREATE FUNCTION protect_strategy_review_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND
    (OLD.client_order_hash_version,OLD.strategy_attribution,OLD.strategy_trigger)
      IS DISTINCT FROM (NEW.client_order_hash_version,NEW.strategy_attribution,NEW.strategy_trigger) THEN
    RAISE EXCEPTION 'strategy review identity is immutable';
  END IF;
  IF NEW.client_order_hash_version=2 AND NOT EXISTS (
    SELECT 1 FROM proposed_orders p WHERE p.id=NEW.proposed_order_id AND p.client_order_hash_version=2
      AND p.client_order_hash=NEW.client_order_hash AND p.strategy_attribution=NEW.strategy_attribution
      AND p.strategy_trigger=NEW.strategy_trigger AND p.instrument_id=NEW.instrument_id AND p.conid=NEW.conid
  ) THEN RAISE EXCEPTION 'strategy review identity mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_strategy_identity_immutable BEFORE INSERT OR UPDATE ON proposal_ai_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_strategy_review_identity();
