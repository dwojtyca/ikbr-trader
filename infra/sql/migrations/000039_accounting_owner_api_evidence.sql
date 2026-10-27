-- Add automatic account evidence without changing historical V1 recovery semantics.
ALTER TABLE accounting_owner_recovery_operations DROP CONSTRAINT accounting_owner_recovery_operations_record_check;
ALTER TABLE accounting_owner_recovery_operations ADD CONSTRAINT accounting_owner_recovery_operations_record_check CHECK (
 (jsonb_typeof(record)='object' AND record ?& ARRAY['version','operationId','nonce','state','owner','profile','pauseRevision','actor','preparedAt','expiresAt','bindingDigest','evidenceDigest','successorOperationId','receiptId']
 AND record->'version' IN ('1'::jsonb,'2'::jsonb) AND jsonb_typeof(record->'owner')='object'
 AND (record->'owner') ?& ARRAY['endpointKey','ownerId','generation','retirementState','acquiredAt','updatedAt']
 AND record->'owner'->>'retirementState' IN ('ACTIVE','UNKNOWN')
 AND ((record->'version'='1'::jsonb AND NOT record ? 'coordination') OR (record->'version'='2'::jsonb
   AND jsonb_typeof(record->'coordination')='object' AND record->'coordination'->'version'='2'::jsonb
   AND record->'coordination'->>'actor'=record->>'actor'
   AND record->'coordination'->>'accountId'=record->'profile'->>'accountId'
   AND record->'coordination'->'endpoint'=record->'profile'->'endpoint'
   AND record->'coordination'->'settingsHash'=record->'profile'->'settingsHash'
   AND record->'coordination'->'deploymentHash'=record->'profile'->'deploymentHash'))) IS TRUE);
ALTER TABLE accounting_owner_recovery_events DROP CONSTRAINT accounting_owner_recovery_events_kind_check;
ALTER TABLE accounting_owner_recovery_events ADD CONSTRAINT accounting_owner_recovery_events_kind_check
 CHECK(kind IN ('PREPARED','PRE_RESET_PROBE_DISPATCH','PRE_RESET_PROBE_CLOSED','HANDSHAKE_DISPATCH','HANDSHAKE_CLOSED','OBSERVED','COMMITTED','SUPERSEDED'));
ALTER TABLE accounting_owner_recovery_receipts DROP CONSTRAINT accounting_owner_recovery_receipts_record_check;
ALTER TABLE accounting_owner_recovery_receipts ADD CONSTRAINT accounting_owner_recovery_receipts_record_check CHECK (
 (jsonb_typeof(record)='object' AND record ?& ARRAY['version','receiptId','operationId','commitRequestId','owner','bindingDigest','evidenceDigest','actor','committedAt','retiredAt','retirementState','method']
 AND record->'version' IN ('1'::jsonb,'2'::jsonb) AND jsonb_typeof(record->'owner')='object'
 AND (record->'owner') ?& ARRAY['endpointKey','ownerId','generation','retirementState','acquiredAt','updatedAt']) IS TRUE);
ALTER TABLE accounting_owner_recovery_receipts DROP CONSTRAINT accounting_owner_recovery_receipts_check;
ALTER TABLE accounting_owner_recovery_receipts ADD CONSTRAINT accounting_owner_recovery_receipts_check CHECK (
 (record->>'receiptId'=receipt_id::text AND record->>'operationId'=operation_id::text
 AND record->>'commitRequestId'=commit_request_id::text AND record->'owner'->>'endpointKey'=endpoint_key
 AND record->'owner'->>'ownerId'=owner_id::text AND (record->'owner'->>'generation')::bigint=generation
 AND record->>'retirementState'='RETIRED'
 AND ((record->'version'='1'::jsonb AND record->>'method'='OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1')
   OR (record->'version'='2'::jsonb AND record->>'method'='API_OBSERVED_LOCAL_TWS_RESET_V2'))
 AND (record->>'committedAt')::timestamptz=committed_at AND (record->>'retiredAt')::timestamptz=committed_at
 AND record->>'bindingDigest' ~ '^[a-f0-9]{64}$' AND record->>'evidenceDigest' ~ '^[a-f0-9]{64}$') IS TRUE);

CREATE OR REPLACE FUNCTION accounting_owner_recovery_event_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op accounting_owner_recovery_operations%ROWTYPE;
BEGIN
 SELECT * INTO op FROM accounting_owner_recovery_operations WHERE operation_id=NEW.operation_id;
 IF NOT FOUND OR NEW.binding_digest IS DISTINCT FROM op.binding_digest OR length(NEW.actor) NOT BETWEEN 1 AND 200
  OR (NEW.kind<>'SUPERSEDED' AND NEW.actor IS DISTINCT FROM op.record->>'actor')
  OR (NEW.kind IN ('PREPARED','PRE_RESET_PROBE_DISPATCH','PRE_RESET_PROBE_CLOSED','HANDSHAKE_DISPATCH','HANDSHAKE_CLOSED','OBSERVED') AND op.state<>'PREPARED')
  OR (NEW.kind='COMMITTED' AND op.state<>'OBSERVED')
  OR (NEW.kind='SUPERSEDED' AND op.state NOT IN ('PREPARED','OBSERVED'))
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
