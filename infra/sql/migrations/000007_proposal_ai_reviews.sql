CREATE TABLE IF NOT EXISTS proposal_ai_reviews (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id) ON DELETE RESTRICT,
  client_order_hash TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  conid TEXT NOT NULL,
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '120 seconds'),
  claim_token UUID,
  claim_until TIMESTAMPTZ,
  decision_json JSONB,
  decided_at TIMESTAMPTZ,
  delivery_started_at TIMESTAMPTZ,
  delivery_outcome TEXT,
  risk_evidence JSONB,
  CHECK ((status <> 'APPROVED') OR (decision_json IS NOT NULL AND decided_at IS NOT NULL AND delivery_started_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS proposal_ai_reviews_pending ON proposal_ai_reviews (expires_at)
  WHERE status IN ('PENDING','APPROVED');

CREATE OR REPLACE FUNCTION protect_proposal_ai_review_identity() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.proposed_order_id,NEW.client_order_hash,NEW.instrument_id,NEW.conid,NEW.account_id,NEW.session_id,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.proposed_order_id,OLD.client_order_hash,OLD.instrument_id,OLD.conid,OLD.account_id,OLD.session_id,OLD.expires_at) THEN
    RAISE EXCEPTION 'AI review identity and deadline are immutable';
  END IF;
  IF OLD.decision_json IS NOT NULL AND ROW(NEW.decision_json,NEW.decided_at,NEW.delivery_started_at)
    IS DISTINCT FROM ROW(OLD.decision_json,OLD.decided_at,OLD.delivery_started_at) THEN
    RAISE EXCEPTION 'AI review decision is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS protect_proposal_ai_review_identity ON proposal_ai_reviews;
CREATE TRIGGER protect_proposal_ai_review_identity BEFORE UPDATE ON proposal_ai_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_proposal_ai_review_identity();
