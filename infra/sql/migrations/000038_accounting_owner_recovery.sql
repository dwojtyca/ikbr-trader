CREATE TABLE accounting_owner_recovery_operations (
 operation_id uuid PRIMARY KEY,
 endpoint_key text NOT NULL,
 owner_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 nonce uuid NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN ('PREPARED','OBSERVED','COMMITTED','SUPERSEDED')),
 binding_digest text NOT NULL CHECK(binding_digest ~ '^[a-f0-9]{64}$'),
 prepared_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL CHECK(expires_at=prepared_at+interval '15 minutes'),
 record jsonb NOT NULL CHECK((jsonb_typeof(record)='object' AND record ?& ARRAY['version','operationId','nonce','state','owner','profile','pauseRevision','actor','preparedAt','expiresAt','bindingDigest','evidenceDigest','successorOperationId','receiptId'] AND record->'version'='1'::jsonb AND jsonb_typeof(record->'owner')='object' AND (record->'owner') ?& ARRAY['endpointKey','ownerId','generation','retirementState','acquiredAt','updatedAt'] AND record->'owner'->>'retirementState' IN ('ACTIVE','UNKNOWN')) IS TRUE),
 CHECK((record->>'operationId'=operation_id::text AND record->>'nonce'=nonce::text AND record->>'state'=state
   AND record->>'bindingDigest'=binding_digest AND record->'owner'->>'endpointKey'=endpoint_key
   AND record->'owner'->>'ownerId'=owner_id::text AND (record->'owner'->>'generation')::bigint=generation AND (record->>'preparedAt')::timestamptz=prepared_at AND (record->>'expiresAt')::timestamptz=expires_at AND jsonb_typeof(record->'profile')='object' AND jsonb_typeof(record->'actor')='string' AND (record->>'pauseRevision')::bigint>0) IS TRUE)
);
CREATE UNIQUE INDEX accounting_owner_recovery_one_pending ON accounting_owner_recovery_operations((true)) WHERE state IN ('PREPARED','OBSERVED');
CREATE TABLE accounting_owner_recovery_maintenance (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 pending_operation_id uuid REFERENCES accounting_owner_recovery_operations(operation_id)
);
INSERT INTO accounting_owner_recovery_maintenance(singleton,pending_operation_id) VALUES(true,NULL);
CREATE TABLE accounting_owner_recovery_events (
 event_id uuid PRIMARY KEY,
 request_id uuid NOT NULL UNIQUE,
 operation_id uuid NOT NULL REFERENCES accounting_owner_recovery_operations(operation_id),
 kind text NOT NULL CHECK(kind IN ('PREPARED','HANDSHAKE_DISPATCH','HANDSHAKE_CLOSED','OBSERVED','COMMITTED','SUPERSEDED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor text NOT NULL,
 binding_digest text NOT NULL CHECK(binding_digest ~ '^[a-f0-9]{64}$'),
 evidence_digest text CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL CHECK(octet_length(evidence::text)<=65536),
 UNIQUE(operation_id,kind)
);
CREATE TABLE accounting_owner_recovery_receipts (
 receipt_id uuid PRIMARY KEY,
 operation_id uuid NOT NULL UNIQUE REFERENCES accounting_owner_recovery_operations(operation_id),
 commit_request_id uuid NOT NULL UNIQUE REFERENCES accounting_owner_recovery_events(request_id),
 endpoint_key text NOT NULL,
 owner_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),
 committed_at timestamptz NOT NULL,
 record jsonb NOT NULL CHECK((jsonb_typeof(record)='object' AND record ?& ARRAY['version','receiptId','operationId','commitRequestId','owner','bindingDigest','evidenceDigest','actor','committedAt','retiredAt','retirementState','method'] AND record->'version'='1'::jsonb AND jsonb_typeof(record->'owner')='object' AND (record->'owner') ?& ARRAY['endpointKey','ownerId','generation','retirementState','acquiredAt','updatedAt']) IS TRUE),
 UNIQUE(endpoint_key,owner_id,generation),
 CHECK((record->>'receiptId'=receipt_id::text AND record->>'operationId'=operation_id::text
   AND record->>'commitRequestId'=commit_request_id::text AND record->'owner'->>'endpointKey'=endpoint_key
   AND record->'owner'->>'ownerId'=owner_id::text AND (record->'owner'->>'generation')::bigint=generation
   AND record->>'retirementState'='RETIRED' AND record->>'method'='OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1' AND (record->>'committedAt')::timestamptz=committed_at AND (record->>'retiredAt')::timestamptz=committed_at AND record->>'bindingDigest' ~ '^[a-f0-9]{64}$' AND record->>'evidenceDigest' ~ '^[a-f0-9]{64}$') IS TRUE)
);
CREATE FUNCTION accounting_owner_recovery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_IMMUTABLE'; END $$;
CREATE TRIGGER accounting_owner_recovery_event_immutable BEFORE UPDATE OR DELETE ON accounting_owner_recovery_events FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_recovery_event_no_truncate BEFORE TRUNCATE ON accounting_owner_recovery_events FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_recovery_receipt_immutable BEFORE UPDATE OR DELETE ON accounting_owner_recovery_receipts FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_recovery_receipt_no_truncate BEFORE TRUNCATE ON accounting_owner_recovery_receipts FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_recovery_operation_no_delete BEFORE DELETE ON accounting_owner_recovery_operations FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_recovery_operation_no_truncate BEFORE TRUNCATE ON accounting_owner_recovery_operations FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_recovery_maintenance_no_delete BEFORE DELETE ON accounting_owner_recovery_maintenance FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_recovery_maintenance_no_truncate BEFORE TRUNCATE ON accounting_owner_recovery_maintenance FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE FUNCTION accounting_owner_recovery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN ('COMMITTED','SUPERSEDED') OR NEW.operation_id<>OLD.operation_id OR NEW.endpoint_key<>OLD.endpoint_key
   OR NEW.owner_id<>OLD.owner_id OR NEW.generation<>OLD.generation OR NEW.nonce<>OLD.nonce
   OR NEW.binding_digest<>OLD.binding_digest OR NEW.prepared_at<>OLD.prepared_at OR NEW.expires_at<>OLD.expires_at
   OR (NEW.record - ARRAY['state','evidenceDigest','successorOperationId','receiptId']) IS DISTINCT FROM
      (OLD.record - ARRAY['state','evidenceDigest','successorOperationId','receiptId'])
   OR NOT ((OLD.state='PREPARED' AND NEW.state IN ('OBSERVED','SUPERSEDED')) OR (OLD.state='OBSERVED' AND NEW.state IN ('COMMITTED','SUPERSEDED')))
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_TRANSITION_INVALID'; END IF;
 IF OLD.state='OBSERVED' AND NEW.record->'evidenceDigest' IS DISTINCT FROM OLD.record->'evidenceDigest'
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_EVIDENCE_CHANGED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER accounting_owner_recovery_transition BEFORE UPDATE ON accounting_owner_recovery_operations FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_transition();
CREATE FUNCTION accounting_owner_recovery_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER accounting_owner_recovery_operation_consistent AFTER INSERT OR UPDATE ON accounting_owner_recovery_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_consistent();
CREATE CONSTRAINT TRIGGER accounting_owner_recovery_maintenance_consistent AFTER UPDATE ON accounting_owner_recovery_maintenance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_consistent();
CREATE CONSTRAINT TRIGGER accounting_owner_recovery_receipt_consistent AFTER INSERT ON accounting_owner_recovery_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_consistent();
CREATE FUNCTION fence_accounting_owner_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pending uuid; receipt jsonb;
BEGIN
 SELECT pending_operation_id INTO pending FROM accounting_owner_recovery_maintenance WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_MAINTENANCE_MISSING'; END IF;
 IF TG_OP='UPDATE' AND OLD.retirement_state='RETIRED' AND EXISTS(SELECT 1 FROM accounting_owner_recovery_receipts WHERE endpoint_key=OLD.endpoint_key AND owner_id=OLD.owner_id AND generation=OLD.generation)
    AND NEW.owner_id=OLD.owner_id AND NEW.generation=OLD.generation AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_RETIRED_OWNER_IMMUTABLE'; END IF;
 IF pending IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_MAINTENANCE_PENDING'; END IF;
 SELECT r.record INTO receipt FROM accounting_owner_recovery_receipts r
 JOIN accounting_owner_recovery_operations o ON o.operation_id=r.operation_id
 WHERE r.operation_id=pending AND o.state='COMMITTED' AND r.endpoint_key=OLD.endpoint_key
   AND r.owner_id=OLD.owner_id AND r.generation=OLD.generation;
 IF receipt IS NULL OR NEW.endpoint_key<>OLD.endpoint_key OR NEW.owner_id<>OLD.owner_id OR NEW.generation<>OLD.generation
   OR NEW.retirement_state<>'RETIRED' OR NEW.acquired_at<>OLD.acquired_at
   OR receipt->'owner'->>'retirementState'<>OLD.retirement_state
   OR (receipt->'owner'->>'acquiredAt')::timestamptz<>OLD.acquired_at
   OR (receipt->'owner'->>'updatedAt')::timestamptz<>OLD.updated_at
   OR NEW.retired_at IS DISTINCT FROM (receipt->>'retiredAt')::timestamptz OR NEW.updated_at IS DISTINCT FROM NEW.retired_at
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_MAINTENANCE_PENDING'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fence_accounting_owner_recovery BEFORE INSERT OR UPDATE ON accounting_source_owners FOR EACH ROW EXECUTE FUNCTION fence_accounting_owner_recovery();

CREATE FUNCTION accounting_owner_recovery_event_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op accounting_owner_recovery_operations%ROWTYPE;
BEGIN
 SELECT * INTO op FROM accounting_owner_recovery_operations WHERE operation_id=NEW.operation_id;
 IF NOT FOUND OR NEW.binding_digest IS DISTINCT FROM op.binding_digest OR length(NEW.actor) NOT BETWEEN 1 AND 200
  OR (NEW.kind<>'SUPERSEDED' AND NEW.actor IS DISTINCT FROM op.record->>'actor')
  OR (NEW.kind IN ('PREPARED','HANDSHAKE_DISPATCH','HANDSHAKE_CLOSED','OBSERVED') AND op.state<>'PREPARED')
  OR (NEW.kind='COMMITTED' AND op.state<>'OBSERVED')
  OR (NEW.kind='SUPERSEDED' AND op.state NOT IN ('PREPARED','OBSERVED'))
 THEN RAISE EXCEPTION 'ACCOUNTING_OWNER_RECOVERY_EVENT_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER accounting_owner_recovery_event_binding BEFORE INSERT ON accounting_owner_recovery_events FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_event_binding();

CREATE TRIGGER accounting_owner_no_recovery_delete BEFORE DELETE ON accounting_source_owners FOR EACH ROW EXECUTE FUNCTION accounting_owner_recovery_immutable();
CREATE TRIGGER accounting_owner_no_recovery_truncate BEFORE TRUNCATE ON accounting_source_owners FOR EACH STATEMENT EXECUTE FUNCTION accounting_owner_recovery_immutable();
