DO $$
DECLARE original_name TEXT; original_definition TEXT;
BEGIN
 SELECT conname,pg_get_constraintdef(oid) INTO STRICT original_name,original_definition
 FROM pg_constraint WHERE conrelid='research_wsh_refresh_attempts'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%retry_due_at IS NULL%';
 IF original_definition IS DISTINCT FROM
  'CHECK (((retry_due_at IS NULL) OR ((state = ''FAILED''::text) AND (failure_class = ''TRANSIENT''::text) AND (cleanup_state = ANY (ARRAY[''CONFIRMED''::text, ''NOT_NEEDED''::text])) AND (ordinal < 2))))'
 THEN RAISE EXCEPTION 'RESEARCH_WSH_RETRY_CONSTRAINT_MISMATCH'; END IF;
 EXECUTE format('ALTER TABLE research_wsh_refresh_attempts DROP CONSTRAINT %I',original_name);
END $$;

ALTER TABLE research_wsh_refresh_attempts ADD CONSTRAINT research_wsh_retry_known_failure CHECK (
 retry_due_at IS NULL OR (
  state='FAILED' AND ordinal<2 AND (
   (failure_class='TRANSIENT' AND cleanup_state IN ('CONFIRMED','NOT_NEEDED'))
   OR ((failure_class='BUSY' AND failure_reason='RESEARCH_WSH_ERROR_10281'
    AND cleanup_state='CONFIRMED' AND jsonb_typeof(provider_error)='object'
    AND jsonb_typeof(provider_error->'code')='number' AND provider_error->'code'='10281'::jsonb) IS TRUE)
  )
 )
);

CREATE FUNCTION research_wsh_busy_retry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate research_wsh_refresh_attempts%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' AND NEW.ordinal>0 THEN
  SELECT * INTO STRICT candidate FROM research_wsh_refresh_attempts WHERE id=NEW.predecessor_id;
 ELSE candidate:=NEW;
 END IF;
 IF candidate.retry_due_at IS NOT NULL AND candidate.failure_class='BUSY'
  AND candidate.acquisition_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM research_wsh_acquisitions WHERE id=candidate.acquisition_id AND state='FAILED'
  ) THEN RAISE EXCEPTION 'RESEARCH_WSH_BUSY_ACQUISITION_UNRESOLVED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER research_wsh_busy_retry_guard BEFORE INSERT OR UPDATE ON research_wsh_refresh_attempts
 FOR EACH ROW EXECUTE FUNCTION research_wsh_busy_retry_guard();
