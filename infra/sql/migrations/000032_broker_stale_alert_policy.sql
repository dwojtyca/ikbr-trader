CREATE TABLE lifecycle_notification_checkpoints (
 account_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 connection_generation BIGINT NOT NULL CHECK(connection_generation>0),
 reconciliation_run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id),
 position_generation BIGINT NOT NULL CHECK(position_generation>0),
 acquisition_started_at TIMESTAMPTZ NOT NULL,
 sources_completed_at JSONB NOT NULL,
 captured_at TIMESTAMPTZ NOT NULL,
 snapshot JSONB NOT NULL,
 CHECK(captured_at>=acquisition_started_at)
);
ALTER TABLE lifecycle_alert_outbox DROP CONSTRAINT lifecycle_alert_outbox_status_check;
ALTER TABLE lifecycle_alert_outbox ADD CONSTRAINT lifecycle_alert_outbox_status_check
 CHECK(status IN ('PENDING','SENDING','DELIVERED','FAILED','UNKNOWN','DISABLED','COALESCED'));
ALTER TABLE lifecycle_alert_outbox ADD COLUMN notification_policy TEXT;
ALTER TABLE lifecycle_alert_outbox ADD COLUMN notification_deadline TIMESTAMPTZ;
ALTER TABLE lifecycle_alert_outbox ADD COLUMN checkpoint_run_id BIGINT REFERENCES reconciliation_runs(id);
ALTER TABLE lifecycle_alert_outbox ADD COLUMN coalesced_at TIMESTAMPTZ;
ALTER TABLE lifecycle_alert_outbox ADD COLUMN notification_session_id TEXT;
ALTER TABLE lifecycle_alert_outbox ADD COLUMN notification_generation BIGINT;
ALTER TABLE lifecycle_alert_outbox ADD COLUMN notification_promoted_at TIMESTAMPTZ;
ALTER TABLE lifecycle_alert_outbox ADD CONSTRAINT lifecycle_notification_policy_check CHECK((
 (notification_policy IS NULL AND notification_deadline IS NULL AND checkpoint_run_id IS NULL AND coalesced_at IS NULL AND notification_session_id IS NULL AND notification_generation IS NULL AND notification_promoted_at IS NULL AND status<>'COALESCED') OR
 (notification_policy='FLAT_WATCHDOG_V1' AND notification_session_id IS NOT NULL AND notification_generation>0 AND fault_id IS NOT NULL AND probe_process_id IS NULL AND notification_deadline IS NOT NULL AND checkpoint_run_id IS NOT NULL
 AND (status<>'COALESCED' OR (attempts=0 AND lease_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL AND provider_message_id IS NULL AND coalesced_at IS NOT NULL AND notification_promoted_at IS NULL)))) IS TRUE);
CREATE FUNCTION guard_coalesced_lifecycle_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='COALESCED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'LIFECYCLE_NOTIFICATION_COALESCED_IMMUTABLE'; END IF;
 IF NEW.status='COALESCED' THEN
  IF (TG_OP='UPDATE' AND OLD.status NOT IN ('PENDING','COALESCED')) OR
   EXISTS(SELECT 1 FROM lifecycle_alert_delivery_attempts WHERE outbox_id=NEW.id) OR
   NOT EXISTS(SELECT 1 FROM lifecycle_faults f WHERE f.id=NEW.fault_id AND f.account_id=NEW.account_id
    AND f.code='BROKER_STATE_STALE' AND f.original_proposal_id IS NULL AND NOT f.active
    AND f.resolved_at IS NOT NULL AND f.resolved_at<=NEW.notification_deadline AND NEW.coalesced_at<=NEW.notification_deadline
    AND NEW.notification_deadline=f.first_observed_at+interval '5 seconds') THEN
    RAISE EXCEPTION 'LIFECYCLE_NOTIFICATION_COALESCE_INVALID';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_coalesced_lifecycle_notification BEFORE INSERT OR UPDATE ON lifecycle_alert_outbox
 FOR EACH ROW EXECUTE FUNCTION guard_coalesced_lifecycle_notification();

CREATE FUNCTION guard_coalesced_lifecycle_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM lifecycle_alert_outbox WHERE id=NEW.outbox_id AND status='COALESCED') THEN
  RAISE EXCEPTION 'LIFECYCLE_NOTIFICATION_COALESCED_ATTEMPT';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_coalesced_lifecycle_attempt BEFORE INSERT OR UPDATE ON lifecycle_alert_delivery_attempts
 FOR EACH ROW EXECUTE FUNCTION guard_coalesced_lifecycle_attempt();
CREATE FUNCTION guard_coalesced_lifecycle_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM lifecycle_alert_outbox WHERE fault_id=OLD.id AND status='COALESCED') AND
   (NEW.active OR ROW(NEW.account_id,NEW.original_proposal_id,NEW.code,NEW.first_observed_at,NEW.resolved_at)
    IS DISTINCT FROM ROW(OLD.account_id,OLD.original_proposal_id,OLD.code,OLD.first_observed_at,OLD.resolved_at)) THEN
   RAISE EXCEPTION 'LIFECYCLE_NOTIFICATION_COALESCED_FAULT';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_coalesced_lifecycle_fault BEFORE UPDATE ON lifecycle_faults FOR EACH ROW EXECUTE FUNCTION guard_coalesced_lifecycle_fault();
