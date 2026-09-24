ALTER TABLE broker_execution_fills ADD COLUMN IF NOT EXISTS sec_type text;
ALTER TABLE broker_execution_fills ADD COLUMN IF NOT EXISTS sec_type_conflict boolean NOT NULL DEFAULT false;
