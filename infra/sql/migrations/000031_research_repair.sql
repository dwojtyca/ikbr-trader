CREATE TABLE research_repair_requests (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('reports','news','calendar')),
  state TEXT NOT NULL CHECK(state IN ('READY','WAITING','HOLD')),
  reasons JSONB NOT NULL,
  snapshot_id UUID REFERENCES research_snapshots(id),
  next_check_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id,config_hash,manifest_hash,instrument_id,source_id,role),
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash),
  CHECK((state='WAITING')=(next_check_at IS NOT NULL))
);
CREATE INDEX research_repair_due ON research_repair_requests(next_check_at) WHERE state='WAITING';
CREATE TABLE research_repair_events (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES research_repair_requests(id),
  state TEXT NOT NULL CHECK(state IN ('READY','WAITING','HOLD')),
  reasons JSONB NOT NULL,
  snapshot_id UUID REFERENCES research_snapshots(id),
  next_check_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER research_repair_events_no_mutation BEFORE UPDATE OR DELETE ON research_repair_events FOR EACH ROW EXECUTE FUNCTION research_immutable();
CREATE TRIGGER research_repair_events_no_truncate BEFORE TRUNCATE ON research_repair_events FOR EACH STATEMENT EXECUTE FUNCTION research_immutable();
CREATE TABLE proposal_research_waits (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id),
  config_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  snapshot_id UUID REFERENCES research_snapshots(id),
  next_check_at TIMESTAMPTZ NOT NULL,
  first_wait_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reasons JSONB NOT NULL,
  FOREIGN KEY(manifest_hash,config_hash) REFERENCES research_manifests(manifest_hash,config_hash)
);
