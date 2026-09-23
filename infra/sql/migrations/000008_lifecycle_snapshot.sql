ALTER TABLE reconciliation_runs ADD COLUMN IF NOT EXISTS broker_snapshot JSONB;
