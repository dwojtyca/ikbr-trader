CREATE OR REPLACE FUNCTION research_recovery_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE challenge research_recovery_challenges%ROWTYPE; evidence JSONB; target research_recovery_challenges%ROWTYPE; producer JSONB; created_time TIMESTAMPTZ; checked_time TIMESTAMPTZ;
BEGIN
 SELECT * INTO STRICT challenge FROM research_recovery_challenges WHERE id=NEW.challenge_id;
 IF NEW.action='PREPARE' THEN
  IF NEW.operation_id<>challenge.operation_id OR NEW.result_json->>'id'<>challenge.id::text OR NEW.result_json->>'challengeHash'<>challenge.challenge_hash
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
 ELSE
  evidence:=NEW.evidence_json::jsonb;
  IF NEW.action='SUPERSEDE' THEN SELECT * INTO STRICT target FROM research_recovery_challenges WHERE id=challenge.predecessor_challenge_id;
  ELSE target:=challenge; END IF;
  IF ROW(evidence->>'challengeId',evidence->>'challengeHash',evidence->>'nonce',evidence->>'kind')
    IS DISTINCT FROM ROW(target.id::text,target.challenge_hash,target.nonce::text,CASE WHEN NEW.action='SUPERSEDE' THEN 'PRODUCER_QUIESCENCE' ELSE target.kind END)
   OR evidence->>'version' IS DISTINCT FROM 'local-research-recovery-v1' OR evidence->>'platform' IS DISTINCT FROM 'darwin'
   OR evidence->'runningProducerIds' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(evidence->'producers') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'producers') NOT BETWEEN 1 AND 16
   OR (NEW.action='COMMIT' AND (challenge.state<>'PREPARED' OR NEW.result_json->>'challengeId' IS DISTINCT FROM challenge.id::text OR NEW.result_json->>'kind' IS DISTINCT FROM challenge.kind
     OR NEW.result_json->>'evidenceHash' IS DISTINCT FROM NEW.evidence_hash OR NEW.result_json->>'predecessorHash' IS DISTINCT FROM challenge.predecessor_hash))
  THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
  FOR producer IN SELECT value FROM jsonb_array_elements(evidence->'producers') LOOP
   IF producer->>'service' IS DISTINCT FROM 'llm-agent'
     OR jsonb_typeof(producer->'state') IS DISTINCT FROM 'string'
     OR producer->>'state' NOT IN ('created','exited','dead')
   THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
   IF producer->>'state'='created' THEN
    IF jsonb_typeof(producer) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(producer))<>8
      OR NOT producer ?& ARRAY['containerId','imageId','project','service','state','createdAt','startedAt','finishedAt']
      OR jsonb_typeof(producer->'containerId') IS DISTINCT FROM 'string' OR NOT COALESCE(producer->>'containerId' ~ '^[a-f0-9]{64}$',false)
      OR jsonb_typeof(producer->'imageId') IS DISTINCT FROM 'string' OR NOT COALESCE(producer->>'imageId' ~ '^sha256:[a-f0-9]{64}$',false)
      OR jsonb_typeof(producer->'project') IS DISTINCT FROM 'string' OR NOT COALESCE(producer->>'project' ~ '^[A-Za-z0-9_.-]{1,100}$',false)
      OR producer->'startedAt' IS DISTINCT FROM 'null'::jsonb OR producer->'finishedAt' IS DISTINCT FROM 'null'::jsonb
      OR jsonb_typeof(producer->'createdAt') IS DISTINCT FROM 'string'
      OR NOT COALESCE(producer->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$',false)
      OR jsonb_typeof(evidence->'producerCheckedAt') IS DISTINCT FROM 'string'
      OR NOT COALESCE(evidence->>'producerCheckedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$',false)
    THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
    BEGIN
     created_time:=(producer->>'createdAt')::timestamptz;
     checked_time:=(evidence->>'producerCheckedAt')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
     RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID';
    END;
    IF NOT isfinite(created_time) OR NOT isfinite(checked_time) OR created_time>checked_time
      OR to_char(created_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM producer->>'createdAt'
      OR replace(to_char(checked_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'.000Z','Z') IS DISTINCT FROM replace(evidence->>'producerCheckedAt','.000Z','Z')
    THEN RAISE EXCEPTION 'RESEARCH_RECOVERY_AUDIT_INVALID'; END IF;
   END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
