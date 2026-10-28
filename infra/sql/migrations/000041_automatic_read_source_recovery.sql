-- Read-source ownership is fenced independently of physical socket retirement.
ALTER TABLE accounting_source_owners ADD COLUMN process_session_id text;
ALTER TABLE accounting_source_owners ADD COLUMN settings_hash text CHECK(settings_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE accounting_source_owners ADD COLUMN account_id text;
CREATE TABLE accounting_source_handovers (
 id uuid PRIMARY KEY,
 endpoint_key text NOT NULL,
 owner_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 process_session_id text NOT NULL,
 settings_hash text NOT NULL CHECK(settings_hash ~ '^[a-f0-9]{64}$'),
 account_id text NOT NULL,
 predecessor jsonb,
 reason text NOT NULL CHECK(reason IN ('INITIAL','CLEAN_RELEASE','READ_SOURCE_FENCED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'),
 UNIQUE(endpoint_key,generation), UNIQUE(endpoint_key,owner_id),
 CHECK((reason='INITIAL')=(predecessor IS NULL))
);
CREATE TABLE accounting_read_recovery_dispositions (
 id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE REFERENCES accounting_owner_recovery_operations(operation_id),
 handover_id uuid NOT NULL REFERENCES accounting_source_handovers(id),
 predecessor_record jsonb NOT NULL,
 predecessor_hash text NOT NULL CHECK(predecessor_hash ~ '^[a-f0-9]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER accounting_source_handovers_immutable BEFORE UPDATE OR DELETE ON accounting_source_handovers FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_source_handovers_no_truncate BEFORE TRUNCATE ON accounting_source_handovers FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_read_dispositions_immutable BEFORE UPDATE OR DELETE ON accounting_read_recovery_dispositions FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_read_dispositions_no_truncate BEFORE TRUNCATE ON accounting_read_recovery_dispositions FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
ALTER TABLE accounting_owner_recovery_operations DROP CONSTRAINT accounting_owner_recovery_operations_state_check;
ALTER TABLE accounting_owner_recovery_operations ADD CONSTRAINT accounting_owner_recovery_operations_state_check CHECK(state IN ('PREPARED','OBSERVED','COMMITTED','SUPERSEDED','AUTO_SUPERSEDED'));
ALTER TABLE accounting_owner_recovery_events DROP CONSTRAINT accounting_owner_recovery_events_kind_check;
ALTER TABLE accounting_owner_recovery_events ADD CONSTRAINT accounting_owner_recovery_events_kind_check CHECK(kind IN ('PREPARED','PRE_RESET_PROBE_DISPATCH','PRE_RESET_PROBE_CLOSED','HANDSHAKE_DISPATCH','HANDSHAKE_CLOSED','OBSERVED','COMMITTED','SUPERSEDED','AUTO_SUPERSEDED'));

CREATE OR REPLACE FUNCTION accounting_owner_recovery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN ('COMMITTED','SUPERSEDED','AUTO_SUPERSEDED') OR NEW.operation_id<>OLD.operation_id OR NEW.endpoint_key<>OLD.endpoint_key
   OR NEW.owner_id<>OLD.owner_id OR NEW.generation<>OLD.generation OR NEW.nonce<>OLD.nonce
   OR NEW.binding_digest<>OLD.binding_digest OR NEW.prepared_at<>OLD.prepared_at OR NEW.expires_at<>OLD.expires_at
   OR (NEW.record - ARRAY['state','evidenceDigest','successorOperationId','receiptId']) IS DISTINCT FROM
      (OLD.record - ARRAY['state','evidenceDigest','successorOperationId','receiptId'])
   OR NOT ((OLD.state='PREPARED' AND NEW.state IN ('OBSERVED','SUPERSEDED','AUTO_SUPERSEDED')) OR (OLD.state='OBSERVED' AND NEW.state IN ('COMMITTED','SUPERSEDED','AUTO_SUPERSEDED')))
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_TRANSITION_INVALID'; END IF;
 IF OLD.state='OBSERVED' AND NEW.record->'evidenceDigest' IS DISTINCT FROM OLD.record->'evidenceDigest'
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_EVIDENCE_CHANGED'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION accounting_owner_recovery_event_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op accounting_owner_recovery_operations%ROWTYPE;
BEGIN
 SELECT * INTO op FROM accounting_owner_recovery_operations WHERE operation_id=NEW.operation_id;
 IF NOT FOUND OR NEW.binding_digest IS DISTINCT FROM op.binding_digest OR length(NEW.actor) NOT BETWEEN 1 AND 200
  OR (NEW.kind NOT IN ('SUPERSEDED','AUTO_SUPERSEDED') AND NEW.actor IS DISTINCT FROM op.record->>'actor')
  OR (NEW.kind IN ('PREPARED','PRE_RESET_PROBE_DISPATCH','PRE_RESET_PROBE_CLOSED','HANDSHAKE_DISPATCH','HANDSHAKE_CLOSED','OBSERVED') AND op.state<>'PREPARED')
  OR (NEW.kind='COMMITTED' AND op.state<>'OBSERVED')
  OR (NEW.kind IN ('SUPERSEDED','AUTO_SUPERSEDED') AND op.state NOT IN ('PREPARED','OBSERVED'))
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_EVENT_MISMATCH'; END IF;
 IF NEW.kind IN ('PRE_RESET_PROBE_DISPATCH','PRE_RESET_PROBE_CLOSED') AND op.record->'version'<>'2'::jsonb
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_VERSION_MISMATCH'; END IF;
 IF NEW.kind IN ('PRE_RESET_PROBE_CLOSED','HANDSHAKE_CLOSED') AND op.record->'version'='2'::jsonb THEN
   IF (NEW.evidence->'version'='2'::jsonb AND NEW.evidence->>'operationId'=op.operation_id::text
     AND NEW.evidence->>'nonce'=op.nonce::text AND NEW.evidence->'endpoint'=op.record->'profile'->'endpoint'
     AND NEW.evidence->'result'->'transportClosed'='true'::jsonb AND NEW.evidence->'result'->'clientId'='0'::jsonb
     AND NEW.evidence->'result'->>'accountId'=op.record->'profile'->>'accountId'
     AND NEW.evidence->>'phase'=CASE NEW.kind WHEN 'PRE_RESET_PROBE_CLOSED' THEN 'pre-reset' ELSE 'post-reset' END
     AND EXISTS(SELECT 1 FROM accounting_owner_recovery_events d WHERE d.operation_id=op.operation_id
       AND d.event_id::text=NEW.evidence->>'dispatchEventId' AND d.kind=CASE NEW.kind WHEN 'PRE_RESET_PROBE_CLOSED' THEN 'PRE_RESET_PROBE_DISPATCH' ELSE 'HANDSHAKE_DISPATCH' END)) IS NOT TRUE
   THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_CLOSURE_UNKNOWN'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION accounting_owner_recovery_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid; op accounting_owner_recovery_operations%ROWTYPE;
BEGIN
 SELECT pending_operation_id INTO pending FROM accounting_owner_recovery_maintenance WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_MAINTENANCE_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM accounting_owner_recovery_operations WHERE state IN ('PREPARED','OBSERVED') AND operation_id IS DISTINCT FROM pending)
   OR (pending IS NOT NULL AND NOT EXISTS(SELECT 1 FROM accounting_owner_recovery_operations WHERE operation_id=pending AND state IN ('PREPARED','OBSERVED')))
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_MAINTENANCE_INVALID'; END IF;
 IF TG_TABLE_NAME='accounting_owner_recovery_operations' THEN
   SELECT * INTO op FROM accounting_owner_recovery_operations WHERE operation_id=NEW.operation_id;
   IF NOT EXISTS(SELECT 1 FROM accounting_owner_recovery_events WHERE operation_id=op.operation_id AND kind=op.state AND binding_digest=op.binding_digest)
     THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_EVENT_REQUIRED'; END IF;
   IF (op.state='PREPARED' AND (op.record->'evidenceDigest' IS DISTINCT FROM 'null'::jsonb OR op.record->'receiptId' IS DISTINCT FROM 'null'::jsonb OR op.record->'successorOperationId' IS DISTINCT FROM 'null'::jsonb))
     OR (op.state='OBSERVED' AND (op.record->>'evidenceDigest' IS NULL OR op.record->'receiptId' IS DISTINCT FROM 'null'::jsonb OR op.record->'successorOperationId' IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM accounting_owner_recovery_events WHERE operation_id=op.operation_id AND kind='OBSERVED' AND evidence_digest=op.record->>'evidenceDigest')))
     OR (op.state='COMMITTED' AND (op.record->>'evidenceDigest' IS NULL OR op.record->>'receiptId' IS NULL OR op.record->'successorOperationId' IS DISTINCT FROM 'null'::jsonb))
     OR (op.state='SUPERSEDED' AND (op.record->'receiptId' IS DISTINCT FROM 'null'::jsonb OR NOT EXISTS(SELECT 1 FROM accounting_owner_recovery_operations successor WHERE successor.operation_id::text=op.record->>'successorOperationId' AND successor.operation_id<>op.operation_id AND successor.record->'owner'=op.record->'owner')))
     THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_STATE_INVALID'; END IF;
   IF op.state='AUTO_SUPERSEDED' AND (
      op.record->'receiptId' IS DISTINCT FROM 'null'::jsonb OR op.record->'successorOperationId' IS DISTINCT FROM 'null'::jsonb
      OR NOT EXISTS(SELECT 1 FROM accounting_read_recovery_dispositions d
        JOIN accounting_source_handovers h ON h.id=d.handover_id
        JOIN accounting_owner_recovery_events e ON e.operation_id=d.operation_id AND e.kind='AUTO_SUPERSEDED'
        WHERE d.operation_id=op.operation_id AND h.endpoint_key=op.endpoint_key
          AND h.generation=op.generation+1 AND h.predecessor->>'ownerId'=op.owner_id::text
          AND h.account_id=op.record->'profile'->>'accountId' AND h.predecessor->>'validatedSettingsHash'=op.record->'profile'->>'settingsHash'
          AND (d.predecessor_record-'state')=(op.record-'state') AND d.predecessor_record->>'state' IN ('PREPARED','OBSERVED')
          AND e.evidence->>'dispositionId'=d.id::text AND e.evidence->>'handoverId'=h.id::text))
      THEN RAISE EXCEPTION 'ACCOUNTING_READ_SUPERSESSION_INVALID'; END IF;
   IF op.state='COMMITTED' AND NOT EXISTS(SELECT 1 FROM accounting_owner_recovery_receipts r WHERE r.operation_id=op.operation_id AND r.record->'version'=op.record->'version')
     THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_VERSION_MISMATCH'; END IF;
   IF op.state IN ('OBSERVED','COMMITTED') AND op.record->'version'='2'::jsonb AND NOT EXISTS(
     SELECT 1 FROM accounting_owner_recovery_events pre
     JOIN accounting_owner_recovery_events post ON post.operation_id=pre.operation_id AND post.kind='HANDSHAKE_CLOSED'
     JOIN accounting_owner_recovery_events observed ON observed.operation_id=pre.operation_id AND observed.kind='OBSERVED'
     WHERE pre.operation_id=op.operation_id AND pre.kind='PRE_RESET_PROBE_CLOSED'
       AND pre.evidence->'result'->>'outcome'='FLAT' AND post.evidence->'result'->>'outcome'='FLAT'
       AND pre.evidence->>'sessionId'=post.evidence->>'sessionId'
       AND observed.evidence->'handshake'=post.evidence
       AND observed.evidence->'evidence'->>'preResetProbeDigest'=pre.evidence_digest
       AND observed.evidence->'evidence'->'version'='2'::jsonb)
     THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_API_PROOF_REQUIRED'; END IF;
   IF op.state='COMMITTED' AND clock_timestamp()>=op.expires_at THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_OBSERVATION_EXPIRED'; END IF;
   IF op.state='COMMITTED' AND NOT EXISTS(SELECT 1 FROM accounting_owner_recovery_receipts r
      JOIN accounting_owner_recovery_events e ON e.request_id=r.commit_request_id
      WHERE r.operation_id=op.operation_id AND r.receipt_id::text=op.record->>'receiptId' AND e.kind='COMMITTED'
      AND e.operation_id=op.operation_id AND r.record->>'bindingDigest'=op.binding_digest
      AND r.record->'evidenceDigest'=op.record->'evidenceDigest' AND r.record->'owner'=op.record->'owner')
     THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_RECEIPT_REQUIRED'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM accounting_owner_recovery_receipts r JOIN accounting_owner_recovery_operations o ON o.operation_id=r.operation_id JOIN accounting_owner_recovery_events e ON e.request_id=r.commit_request_id WHERE o.state<>'COMMITTED' OR o.record->>'receiptId'<>r.receipt_id::text OR r.record->'owner' IS DISTINCT FROM o.record->'owner' OR r.record->'evidenceDigest' IS DISTINCT FROM o.record->'evidenceDigest' OR e.kind<>'COMMITTED' OR e.operation_id<>o.operation_id OR e.evidence_digest IS DISTINCT FROM o.record->>'evidenceDigest' OR e.evidence IS DISTINCT FROM r.record OR (r.record->>'retiredAt')::timestamptz IS DISTINCT FROM r.committed_at OR (r.record->>'committedAt')::timestamptz IS DISTINCT FROM r.committed_at OR NOT EXISTS(SELECT 1 FROM accounting_source_owners a WHERE a.endpoint_key=r.endpoint_key AND (a.generation>r.generation OR (a.generation=r.generation AND a.owner_id=r.owner_id AND a.retirement_state='RETIRED' AND a.retired_at=r.committed_at AND a.updated_at=r.committed_at)))) THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_RECEIPT_MISMATCH'; END IF;
 RETURN NULL;
END $$;

CREATE TABLE accounting_clock_read_dispositions (
 id uuid PRIMARY KEY,
 episode_id uuid NOT NULL REFERENCES broker_accounting_clock_episodes(id),
 source_id text NOT NULL REFERENCES broker_accounting_sources(source_id),
 predecessor jsonb NOT NULL,
 successor_session_id text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(episode_id,successor_session_id)
);
CREATE TRIGGER accounting_clock_read_dispositions_immutable BEFORE UPDATE OR DELETE ON accounting_clock_read_dispositions FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_clock_read_dispositions_no_truncate BEFORE TRUNCATE ON accounting_clock_read_dispositions FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
