-- Preserve immutable historical qualifications; automatic evidence is generation-scoped.
ALTER TABLE broker_accounting_qualifications ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE broker_accounting_qualifications ADD CONSTRAINT accounting_qualification_expiry_kind
 CHECK ((record->'input'->>'schemaVersion' = '2' AND expires_at IS NULL AND record->>'expiresAt' IS NULL)
 OR (record->'input'->>'schemaVersion' = '1' AND expires_at IS NOT NULL));
