-- PR15.2 — persist the authoritative registry `instrumentId` on
-- every new `proposed_orders` row created via the Phase 2 write
-- endpoint (`POST /execution/execute-ticket`).
--
-- Legacy compatibility:
--   - The column is NULL-able. Existing rows and the legacy
--     proposal path (`/execution/execute-proposed/:id`, llm-agent
--     EXECUTE/REJECT gate, backtest simulator writes) continue
--     to work with `instrument_id IS NULL`.
--   - No backfill by symbol. Symbol → registry id inference is
--     ambiguous (e.g. one broker symbol maps to many futures
--     expirations, several stocks share a display symbol), so
--     the migration deliberately leaves historical rows NULL.
--
-- Enforcement:
--   - The application layer (`insertProposedFromTicket`) writes
--     `instrument_id` whenever the incoming ticket carries an
--     `instrumentId`.
--   - The atomic identity re-check inside
--     `tryStartSubmissionWithPlan` compares the stored
--     `instrument_id` to the incoming payload — a mismatch
--     rolls back with `submission_identity_mismatch`.
--
-- Append-only migration; safe to run against fresh and drifted
-- deployments (`ADD COLUMN IF NOT EXISTS`).

ALTER TABLE proposed_orders
  ADD COLUMN IF NOT EXISTS instrument_id TEXT;

-- Non-unique index — `instrument_id` is NOT a natural key
-- (multiple entries share `es_front` over time, one per trade
-- intent) but the reconciliation reader and operator queries
-- filter on it frequently enough to warrant an index.
CREATE INDEX IF NOT EXISTS proposed_orders_instrument_id_idx
  ON proposed_orders (instrument_id)
  WHERE instrument_id IS NOT NULL;
