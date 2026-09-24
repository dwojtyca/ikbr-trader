CREATE TABLE aapl_windows (
  run_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  trade_date DATE NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  consumed_proposal_id BIGINT REFERENCES proposed_orders(id),
  consumed_at TIMESTAMPTZ,
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '60 minutes'),
  CHECK ((consumed_proposal_id IS NULL) = (consumed_at IS NULL))
);
CREATE UNIQUE INDEX aapl_one_entry_per_account_day ON aapl_windows(account_id, trade_date)
  WHERE consumed_proposal_id IS NOT NULL;
CREATE TABLE aapl_proposals (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id),
  run_id TEXT NOT NULL REFERENCES aapl_windows(run_id)
);
