-- PR15 r8 — order-critical fields required by the canonical
-- clientOrderHash. Without these columns a persisted PROPOSED
-- row cannot round-trip a ticket that used a partial-take-profit
-- ladder or a trailing stop; the recomputed hash would differ
-- from the wire hash and every submission carrying these fields
-- would be refused as CLIENT_ORDER_HASH_MISMATCH.
--
-- Append-only. All columns are nullable so backfill is not
-- required.

ALTER TABLE proposed_orders
  ADD COLUMN IF NOT EXISTS partial_take_profits JSONB,
  ADD COLUMN IF NOT EXISTS trailing_stop_pct DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS trailing_stop_activation_r DOUBLE PRECISION;
