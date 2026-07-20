-- PR15 — Durable Reconciliation & Recovery
--
-- Introduces:
--   * reconciliation_runs — every reconciliation attempt.
--   * reconciliation_holds — per-instrument holds (mismatch,
--     orphan, unknown_submission, recovery_source_missing,
--     identity_ambiguous, manual). Server-side authoritative,
--     enforced under the PR14 submission advisory lock.
--   * broker_order_links — bracket-aware leg mapping (parent +
--     TP/SL children); each leg carries its own orderRef,
--     brokerOrderId, permId.
--   * broker_order_ref_map — short broker orderRef → clientOrderId
--     correlation. PRIMARY KEY on the ref is the atomic
--     collision detector in Phase 2 of the order-plan lifecycle.
--
-- Idempotent DDL only. Runs cleanly on fresh DB, post-001-init DB,
-- and post-PR14 DB.

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  snapshot_captured_at TIMESTAMPTZ,
  snapshot_complete BOOLEAN NOT NULL DEFAULT FALSE,
  source_coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_positions_count INTEGER,
  broker_positions_count INTEGER,
  matches INTEGER,
  mismatches_count INTEGER,
  error TEXT,
  report JSONB
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_account_session_started_idx
  ON reconciliation_runs (account_id, session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS reconciliation_runs_running_idx
  ON reconciliation_runs (account_id, started_at DESC)
  WHERE status = 'RUNNING';

CREATE TABLE IF NOT EXISTS reconciliation_holds (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  instrument TEXT NOT NULL,
  conid TEXT,
  sec_type TEXT,
  exchange TEXT,
  currency TEXT,
  identity_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL,
  reconciliation_run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  acknowledge_note TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolved_kind TEXT,
  resolution_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_holds_active_uidx
  ON reconciliation_holds (account_id, identity_key, reason)
  WHERE active;

CREATE INDEX IF NOT EXISTS reconciliation_holds_account_active_idx
  ON reconciliation_holds (account_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS broker_order_links (
  id BIGSERIAL PRIMARY KEY,
  proposed_order_id BIGINT NOT NULL REFERENCES proposed_orders(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  role_ordinal INTEGER NOT NULL DEFAULT 0,
  broker_order_id TEXT,
  perm_id TEXT,
  parent_perm_id TEXT,
  order_ref TEXT NOT NULL,
  status TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- broker permId is unique per broker account, not globally.
CREATE UNIQUE INDEX IF NOT EXISTS broker_order_links_perm_id_uidx
  ON broker_order_links (account_id, perm_id)
  WHERE perm_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS broker_order_links_ref_per_order_uidx
  ON broker_order_links (proposed_order_id, order_ref);

CREATE INDEX IF NOT EXISTS broker_order_links_by_order_role_idx
  ON broker_order_links (proposed_order_id, role, role_ordinal);

CREATE INDEX IF NOT EXISTS broker_order_links_account_ref_idx
  ON broker_order_links (account_id, order_ref);

CREATE TABLE IF NOT EXISTS broker_order_ref_map (
  broker_order_ref TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  proposed_order_id BIGINT NOT NULL REFERENCES proposed_orders(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS broker_order_ref_map_client_order_idx
  ON broker_order_ref_map (client_order_id);
