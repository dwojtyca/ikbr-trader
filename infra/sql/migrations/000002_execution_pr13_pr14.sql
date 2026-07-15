-- PR14.2 — PR13/PR14 execution-engine schema.
--
-- Everything `ExecutionRepository.init()` used to create dynamically
-- beyond the ingestion baseline (`000001_baseline.sql`):
--
--   * `broker_execution_fills` + denormalised context columns +
--     nullable/ON DELETE SET NULL FK relaxation + backfill.
--   * `system_alerts`.
--   * `execution_audit_log`.
--   * `broker_position_snapshots` + partial unique indexes (conid /
--     symbol split identity, round-5).
--   * `broker_snapshot_syncs` + monotonic `generation` column
--     (round-8).
--   * PR13 idempotency columns `client_order_id` + `client_order_hash`
--     + partial UNIQUE index.
--   * Historical status normalisation
--     (`EXECUTED` → `SUBMITTED`, stale `executed_at` reset).
--
-- Every DDL is idempotent so this migration is safe against every
-- combination of "fresh DB", "DB where only 001_init.sql ran", and
-- "DB that was previously initialised by `repo.init()`". Data
-- migrations (`UPDATE` / backfill) are convergent.

CREATE TABLE IF NOT EXISTS broker_execution_fills (
  exec_id TEXT PRIMARY KEY,
  order_id BIGINT,
  broker_order_id TEXT,
  proposed_order_id BIGINT REFERENCES proposed_orders(id),
  account_id TEXT,
  conid TEXT,
  symbol TEXT,
  currency TEXT,
  exchange TEXT,
  side TEXT,
  shares DOUBLE PRECISION,
  price DOUBLE PRECISION,
  avg_price DOUBLE PRECISION,
  executed_at TIMESTAMPTZ,
  commission DOUBLE PRECISION,
  commission_currency TEXT,
  realized_pnl DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Historical schema drift: some deployments created these columns
-- NOT NULL; PR13 loosened them to NULL. `ALTER COLUMN ... DROP NOT
-- NULL` is a no-op if the column is already nullable, so this is
-- safe on both fresh baselines and drifted DBs. A genuine error
-- (missing column, permission denied) MUST fail the migration
-- rather than be silently swallowed.
ALTER TABLE broker_execution_fills ALTER COLUMN symbol DROP NOT NULL;
ALTER TABLE broker_execution_fills ALTER COLUMN side DROP NOT NULL;
ALTER TABLE broker_execution_fills ALTER COLUMN shares DROP NOT NULL;
ALTER TABLE broker_execution_fills ALTER COLUMN price DROP NOT NULL;

-- Denormalised context columns so Trades survive proposed_orders
-- retention deletion.
ALTER TABLE broker_execution_fills ADD COLUMN IF NOT EXISTS strategy TEXT;
ALTER TABLE broker_execution_fills ADD COLUMN IF NOT EXISTS entry_reason TEXT;
ALTER TABLE broker_execution_fills ADD COLUMN IF NOT EXISTS ai_reason TEXT;
ALTER TABLE broker_execution_fills ADD COLUMN IF NOT EXISTS ai_decision TEXT;
ALTER TABLE broker_execution_fills ADD COLUMN IF NOT EXISTS decision_source TEXT;

-- Loosen FK so retention deletes on proposed_orders don't cascade or
-- block. Trades have already snapshotted the context they need.
ALTER TABLE broker_execution_fills
  DROP CONSTRAINT IF EXISTS broker_execution_fills_proposed_order_id_fkey;
ALTER TABLE broker_execution_fills
  ADD CONSTRAINT broker_execution_fills_proposed_order_id_fkey
  FOREIGN KEY (proposed_order_id)
  REFERENCES proposed_orders(id)
  ON DELETE SET NULL;

-- One-time backfill of denormalised context columns from the parent
-- proposed_orders row. Convergent — a follow-up run finds nothing to
-- update.
UPDATE broker_execution_fills f
SET strategy = COALESCE(f.strategy, po.strategy),
    entry_reason = COALESCE(f.entry_reason, po.reason),
    ai_reason = COALESCE(f.ai_reason, po.ai_reason),
    ai_decision = COALESCE(f.ai_decision, po.ai_decision),
    decision_source = COALESCE(f.decision_source, po.decision_source)
FROM proposed_orders po
WHERE f.proposed_order_id = po.id
  AND (f.strategy IS NULL
       OR f.entry_reason IS NULL
       OR f.ai_reason IS NULL
       OR f.ai_decision IS NULL
       OR f.decision_source IS NULL);

-- Sanitise legacy sentinel values from broker `realizedPnL` (IB
-- returns 1.7976931348623157e+308 when unset).
UPDATE broker_execution_fills
SET realized_pnl = NULL
WHERE realized_pnl IS NOT NULL
  AND ABS(realized_pnl) >= 1e307;

-- Indexes on broker_execution_fills.
CREATE INDEX IF NOT EXISTS broker_execution_fills_order_idx
  ON broker_execution_fills (broker_order_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS broker_execution_fills_exec_ts_idx
  ON broker_execution_fills (executed_at DESC);

-- PR13 end-to-end idempotency columns + partial unique index.
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS client_order_id TEXT;
ALTER TABLE proposed_orders ADD COLUMN IF NOT EXISTS client_order_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS proposed_orders_client_order_id_uidx
  ON proposed_orders (client_order_id)
  WHERE client_order_id IS NOT NULL;

-- Legacy status cleanup: remove old EXECUTED semantics.
UPDATE proposed_orders
SET status = 'SUBMITTED',
    executed_at = NULL
WHERE status = 'EXECUTED';

-- SUBMITTED rows are not yet FILLED — clear any stale executed_at.
UPDATE proposed_orders
SET executed_at = NULL
WHERE status = 'SUBMITTED'
  AND executed_at IS NOT NULL;

-- Reconcile FILLED status from persisted broker fills. Convergent.
WITH fill_totals AS (
  SELECT proposed_order_id,
         SUM(ABS(COALESCE(shares, 0))) AS filled_shares,
         MAX(COALESCE(executed_at, created_at)) AS latest_fill_at
  FROM broker_execution_fills
  WHERE proposed_order_id IS NOT NULL
  GROUP BY proposed_order_id
)
UPDATE proposed_orders po
SET status = 'FILLED',
    execution_message = 'Broker execution fill reconciliation: filled='
                        || fill_totals.filled_shares || '/' || po.quantity,
    last_error = NULL,
    source_error = NULL,
    executed_at = COALESCE(po.executed_at, fill_totals.latest_fill_at, NOW()),
    processing_owner = NULL,
    processing_claimed_at = NULL
FROM fill_totals
WHERE po.id = fill_totals.proposed_order_id
  AND po.status <> 'FILLED'
  AND po.quantity > 0
  AND fill_totals.filled_shares >= po.quantity;

-- PR1/PR2 system alerts + per-request audit log.
CREATE TABLE IF NOT EXISTS system_alerts (
  id BIGSERIAL PRIMARY KEY,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  payload JSONB,
  delivered_to_telegram BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS system_alerts_created_idx
  ON system_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS system_alerts_kind_idx
  ON system_alerts (kind, created_at DESC);

CREATE TABLE IF NOT EXISTS execution_audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id UUID NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  token_fingerprint TEXT,
  ip TEXT,
  request_hash TEXT,
  outcome TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS execution_audit_log_ts_idx
  ON execution_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS execution_audit_log_correlation_idx
  ON execution_audit_log (correlation_id);
CREATE INDEX IF NOT EXISTS execution_audit_log_outcome_idx
  ON execution_audit_log (outcome, ts DESC);

-- PR14 round-4/5 — persisted broker-position snapshots. Split conid /
-- symbol identity via partial unique indexes prevents futures
-- rollover being shadowed by the old contract.
CREATE TABLE IF NOT EXISTS broker_position_snapshots (
  account_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  conid TEXT,
  quantity NUMERIC NOT NULL,
  session_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL
);
-- Drop the pre-round-5 PRIMARY KEY (account_id, instrument) if a dev
-- database still carries it.
ALTER TABLE broker_position_snapshots
  DROP CONSTRAINT IF EXISTS broker_position_snapshots_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS broker_position_snapshots_conid_uidx
  ON broker_position_snapshots (account_id, conid)
  WHERE conid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS broker_position_snapshots_symbol_uidx
  ON broker_position_snapshots (account_id, instrument)
  WHERE conid IS NULL;

CREATE TABLE IF NOT EXISTS broker_snapshot_syncs (
  account_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT TRUE
);
-- PR14 round-8 — generation fence for refresh coalescing.
ALTER TABLE broker_snapshot_syncs
  ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 0;
