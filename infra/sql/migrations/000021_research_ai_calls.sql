CREATE TABLE IF NOT EXISTS proposal_ai_model_calls (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id) ON DELETE RESTRICT,
  claim_token UUID NOT NULL,
  call_key TEXT NOT NULL UNIQUE,
  request_json JSONB NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  research_snapshot_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  output_schema_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deadline_at TIMESTAMPTZ NOT NULL,
  CHECK (deadline_at > started_at AND deadline_at <= started_at + interval '10 seconds')
);
CREATE TABLE IF NOT EXISTS proposal_ai_model_outcomes (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposal_ai_model_calls(proposed_order_id) ON DELETE RESTRICT,
  outcome_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION protect_research_ai_audit() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Research AI request and outcome audit is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER protect_research_ai_call BEFORE UPDATE OR DELETE ON proposal_ai_model_calls
  FOR EACH ROW EXECUTE FUNCTION protect_research_ai_audit();
CREATE TRIGGER protect_research_ai_outcome BEFORE UPDATE OR DELETE ON proposal_ai_model_outcomes
  FOR EACH ROW EXECUTE FUNCTION protect_research_ai_audit();
CREATE TABLE IF NOT EXISTS proposal_ai_model_late_outcomes (
  proposed_order_id BIGINT NOT NULL REFERENCES proposal_ai_model_calls(proposed_order_id) ON DELETE RESTRICT,
  outcome_hash TEXT NOT NULL,
  outcome_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(proposed_order_id,outcome_hash)
);
CREATE TRIGGER protect_research_ai_late_outcome BEFORE UPDATE OR DELETE ON proposal_ai_model_late_outcomes
  FOR EACH ROW EXECUTE FUNCTION protect_research_ai_audit();

CREATE TRIGGER protect_research_ai_call_truncate BEFORE TRUNCATE ON proposal_ai_model_calls
  FOR EACH STATEMENT EXECUTE FUNCTION protect_research_ai_audit();
CREATE TRIGGER protect_research_ai_outcome_truncate BEFORE TRUNCATE ON proposal_ai_model_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION protect_research_ai_audit();
CREATE TRIGGER protect_research_ai_late_outcome_truncate BEFORE TRUNCATE ON proposal_ai_model_late_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION protect_research_ai_audit();
