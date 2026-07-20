-- PR15 r5 §1 — correlated broker order observations.
--
-- Replaces the r4 approach of storing three independent
-- `observed{BrokerOrderIds,PermIds,OrderRefs}` arrays in
-- `reconciliation_runs.report`, which allowed
-- `LINK_TO_BROKER_ORDER` to mix identifiers from unrelated
-- broker rows via three independent OR-set lookups.
--
-- Each row here is one atomic broker-order observation from a
-- single source (openOrders / completedOrders / executions).
-- The operator link path REQUIRES that every identifier the
-- operator submits refers to the SAME row.

CREATE TABLE IF NOT EXISTS reconciliation_broker_order_observations (
  id                    BIGSERIAL PRIMARY KEY,
  reconciliation_run_id BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  account_id            TEXT   NOT NULL,
  session_id            TEXT   NOT NULL,
  source                TEXT   NOT NULL CHECK (source IN ('OPEN_ORDER','COMPLETED_ORDER','EXECUTION')),
  broker_order_id       TEXT   NOT NULL,
  perm_id               TEXT,
  order_ref             TEXT,
  broker_status         TEXT,
  observed_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Look up all observations of a single run.
CREATE INDEX IF NOT EXISTS
  reconciliation_broker_order_observations_run_idx
  ON reconciliation_broker_order_observations (reconciliation_run_id);

-- Fast per-identifier lookup during atomicOperatorLinkAndResolve.
-- Composite includes account_id so cross-account contamination is
-- impossible even if a broker_order_id is reused across accounts.
CREATE INDEX IF NOT EXISTS
  reconciliation_broker_order_observations_acct_bid_idx
  ON reconciliation_broker_order_observations (account_id, broker_order_id);

CREATE INDEX IF NOT EXISTS
  reconciliation_broker_order_observations_acct_perm_idx
  ON reconciliation_broker_order_observations (account_id, perm_id)
  WHERE perm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  reconciliation_broker_order_observations_acct_ref_idx
  ON reconciliation_broker_order_observations (account_id, order_ref)
  WHERE order_ref IS NOT NULL;
