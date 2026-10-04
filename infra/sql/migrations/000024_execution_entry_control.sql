CREATE TABLE IF NOT EXISTS execution_entry_controls (
  account_id TEXT PRIMARY KEY CHECK (length(account_id)>0),
  paused BOOLEAN NOT NULL DEFAULT true,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS execution_entry_control_events (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES execution_entry_controls(account_id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL,
  paused BOOLEAN NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,revision)
);
CREATE OR REPLACE FUNCTION protect_execution_entry_control() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'entry control records cannot be removed'; END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.revision <> OLD.revision+1 THEN RAISE EXCEPTION 'entry control identity/revision immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER protect_execution_entry_control BEFORE UPDATE OR DELETE ON execution_entry_controls
  FOR EACH ROW EXECUTE FUNCTION protect_execution_entry_control();
CREATE TRIGGER protect_execution_entry_control_truncate BEFORE TRUNCATE ON execution_entry_controls
  FOR EACH STATEMENT EXECUTE FUNCTION protect_execution_entry_control();
CREATE OR REPLACE FUNCTION protect_execution_entry_control_event() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'entry control audit is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER protect_execution_entry_control_event BEFORE UPDATE OR DELETE ON execution_entry_control_events
  FOR EACH ROW EXECUTE FUNCTION protect_execution_entry_control_event();
CREATE TRIGGER protect_execution_entry_control_event_truncate BEFORE TRUNCATE ON execution_entry_control_events
  FOR EACH STATEMENT EXECUTE FUNCTION protect_execution_entry_control_event();

CREATE OR REPLACE FUNCTION fence_paused_entry_attempt() RETURNS trigger AS $$
BEGIN
  IF OLD.execution_attempted_at IS NULL AND NEW.execution_attempted_at IS NOT NULL
    AND COALESCE(NEW.position_effect,'OPEN_OR_ADD') <> 'CLOSE_OR_REDUCE'
    AND EXISTS(SELECT 1 FROM execution_entry_controls WHERE account_id=NEW.execution_account_id) THEN
    PERFORM pg_advisory_xact_lock(hashtext('snap:'||NEW.execution_account_id));
    IF EXISTS(SELECT 1 FROM execution_entry_controls WHERE account_id=NEW.execution_account_id AND paused)
      THEN RAISE EXCEPTION 'EXECUTION_ENTRIES_PAUSED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM lifecycle_supervision WHERE original_proposal_id=NEW.id
      AND account_id=NEW.execution_account_id AND exit_deadline > clock_timestamp())
      THEN RAISE EXCEPTION 'LIFECYCLE_ENTRY_DEADLINE_UNAVAILABLE'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fence_paused_entry_attempt BEFORE UPDATE OF execution_attempted_at ON proposed_orders
  FOR EACH ROW EXECUTE FUNCTION fence_paused_entry_attempt();
