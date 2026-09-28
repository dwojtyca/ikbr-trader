CREATE TABLE paper_entry_migration_holds (
  evidence_key TEXT PRIMARY KEY,
  account_id TEXT,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE paper_entry_budget_adoptions (
  account_id TEXT PRIMARY KEY,
  account_day_timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw' CHECK(account_day_timezone='Europe/Warsaw'),
  adopted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  entries_disabled BOOLEAN NOT NULL CHECK(entries_disabled)
);
CREATE TABLE paper_runs (
  run_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES paper_entry_budget_adoptions(account_id),
  effective_config_hash TEXT NOT NULL REFERENCES trading_configuration_snapshots(effective_hash),
  manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
  canonical_manifest TEXT NOT NULL,
  manifest JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE paper_run_proposals (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id),
  run_id TEXT NOT NULL REFERENCES paper_runs(run_id),
  instrument_id TEXT NOT NULL,
  conid TEXT NOT NULL CHECK(conid ~ '^[1-9][0-9]*$'),
  session_timezone TEXT NOT NULL CHECK(session_timezone IN ('Europe/Warsaw','America/New_York')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '60 minutes')
);
CREATE TABLE paper_entry_attempts (
  proposed_order_id BIGINT PRIMARY KEY REFERENCES proposed_orders(id),
  account_id TEXT NOT NULL,
  broker TEXT NOT NULL CHECK(broker='ibkr'),
  conid TEXT NOT NULL CHECK(conid ~ '^[1-9][0-9]*$'),
  account_date DATE NOT NULL,
  session_date DATE NOT NULL,
  session_timezone TEXT NOT NULL CHECK(session_timezone IN ('Europe/Warsaw','America/New_York')),
  attempted_at TIMESTAMPTZ NOT NULL,
  run_id TEXT REFERENCES paper_runs(run_id),
  source TEXT NOT NULL CHECK(source IN ('generic','legacy')),
  CHECK(account_date=(attempted_at AT TIME ZONE 'Europe/Warsaw')::date),
  CHECK(session_date=(attempted_at AT TIME ZONE session_timezone)::date)
);
CREATE INDEX paper_entry_account_day ON paper_entry_attempts(account_id,account_date);
CREATE INDEX paper_entry_contract_day ON paper_entry_attempts(account_id,broker,conid,session_date);
CREATE TABLE paper_entry_legacy_day_debts (
  proposed_order_id BIGINT NOT NULL REFERENCES proposed_orders(id),
  account_id TEXT NOT NULL,
  charged_date DATE NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY(proposed_order_id,account_id,charged_date,source)
);

CREATE FUNCTION paper_budget_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PAPER_BUDGET_IMMUTABLE'; END $$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['paper_entry_migration_holds','paper_entry_budget_adoptions','paper_runs','paper_run_proposals','paper_entry_attempts','paper_entry_legacy_day_debts'] LOOP
    EXECUTE format('CREATE TRIGGER paper_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION paper_budget_immutable()',t);
    EXECUTE format('CREATE TRIGGER paper_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION paper_budget_immutable()',t);
  END LOOP;
END $$;

-- Re-run under the disabled-write adoption table barrier to capture legacy writers
-- that ran after migration 19. Original rows and charged local days are retained.
CREATE FUNCTION import_paper_entry_legacy() RETURNS void LANGUAGE plpgsql AS $$
DECLARE p RECORD; accounts TEXT[]; contracts TEXT[]; zones TEXT[]; times TIMESTAMPTZ[];
  account TEXT; contract TEXT; zone TEXT; stamp TIMESTAMPTZ; problem TEXT;
BEGIN
  FOR p IN SELECT po.* FROM proposed_orders po WHERE
    po.execution_attempted_at IS NOT NULL OR
    EXISTS(SELECT 1 FROM gpw_windows w WHERE w.consumed_proposal_id=po.id) OR
    EXISTS(SELECT 1 FROM aapl_windows w WHERE w.consumed_proposal_id=po.id)
  LOOP
    IF p.position_effect='CLOSE_OR_REDUCE' THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM paper_entry_attempts a WHERE a.proposed_order_id=p.id AND a.source='generic') THEN CONTINUE; END IF;
    SELECT array_agg(DISTINCT value) INTO accounts FROM (
      SELECT nullif(p.execution_account_id,'') AS value
      UNION ALL SELECT account_id FROM gpw_windows WHERE consumed_proposal_id=p.id
      UNION ALL SELECT account_id FROM aapl_windows WHERE consumed_proposal_id=p.id
      UNION ALL SELECT account_id FROM proposal_ai_reviews WHERE proposed_order_id=p.id
      UNION ALL SELECT account_id FROM broker_order_links WHERE proposed_order_id=p.id
    ) x WHERE value IS NOT NULL;
    SELECT array_agg(DISTINCT value) INTO contracts FROM (
      SELECT nullif(p.conid,'') AS value
      UNION ALL SELECT '35146360' FROM gpw_windows WHERE consumed_proposal_id=p.id
      UNION ALL SELECT '265598' FROM aapl_windows WHERE consumed_proposal_id=p.id
      UNION ALL SELECT conid FROM proposal_ai_reviews WHERE proposed_order_id=p.id
    ) x WHERE value IS NOT NULL;
    SELECT array_agg(DISTINCT value ORDER BY value) INTO times FROM (
      SELECT p.execution_attempted_at AS value
      UNION ALL SELECT consumed_at FROM gpw_windows WHERE consumed_proposal_id=p.id
      UNION ALL SELECT consumed_at FROM aapl_windows WHERE consumed_proposal_id=p.id
    ) x WHERE value IS NOT NULL;
    account := CASE WHEN cardinality(accounts)=1 AND accounts[1] ~ '^[a-zA-Z0-9_-]{1,80}$' THEN accounts[1] ELSE NULL END;
    contract := CASE WHEN cardinality(contracts)=1 THEN contracts[1] ELSE NULL END;
    SELECT array_agg(DISTINCT value) INTO zones FROM (
      SELECT 'Europe/Warsaw' AS value FROM gpw_windows WHERE consumed_proposal_id=p.id
      UNION ALL SELECT 'America/New_York' FROM aapl_windows WHERE consumed_proposal_id=p.id
      UNION ALL SELECT i->'session'->>'timeZone' FROM trading_configuration_snapshots s,
        jsonb_array_elements(s.canonical_json::jsonb->'configuration'->'instruments') i
        WHERE s.effective_hash=p.strategy_configuration_hash AND i->'contract'->>'conId'=contract
    ) x WHERE value IS NOT NULL;
    zone := CASE WHEN cardinality(zones)=1 THEN zones[1] ELSE NULL END;
    stamp := p.execution_attempted_at;
    IF stamp IS NULL AND cardinality(times)=1 THEN stamp:=times[1]; END IF;
    problem := CASE WHEN account IS NULL THEN 'LEGACY_ACCOUNT_IDENTITY_MISSING_OR_CONFLICTING'
      WHEN contract IS NULL OR contract !~ '^[1-9][0-9]*$' THEN 'LEGACY_CONTRACT_IDENTITY_MISSING_OR_CONFLICTING'
      WHEN zone IS NULL OR zone NOT IN ('Europe/Warsaw','America/New_York') THEN 'LEGACY_SESSION_TIMEZONE_MISSING_OR_CONFLICTING'
      WHEN stamp IS NULL OR NOT isfinite(stamp) OR EXISTS(SELECT 1 FROM unnest(times) t WHERE NOT isfinite(t)) THEN 'LEGACY_ATTEMPT_TIME_MISSING_OR_CONFLICTING'
      WHEN EXISTS(SELECT 1 FROM (SELECT consumed_at,starts_at,ends_at FROM gpw_windows WHERE consumed_proposal_id=p.id
        UNION ALL SELECT consumed_at,starts_at,ends_at FROM aapl_windows WHERE consumed_proposal_id=p.id) w
        WHERE w.consumed_at>stamp OR w.consumed_at<w.starts_at OR w.consumed_at>=w.ends_at OR stamp<w.starts_at OR stamp>=w.ends_at
          OR (w.consumed_at AT TIME ZONE 'Europe/Warsaw')::date<>(stamp AT TIME ZONE 'Europe/Warsaw')::date
          OR (w.consumed_at AT TIME ZONE zone)::date<>(stamp AT TIME ZONE zone)::date) THEN 'LEGACY_ATTEMPT_TIME_CONFLICTING'
      ELSE NULL END;
    IF problem IS NOT NULL THEN
      INSERT INTO paper_entry_migration_holds(evidence_key,account_id,reason,evidence)
        VALUES('legacy:'||p.id||':'||problem,account,problem,jsonb_build_object('proposalId',p.id,'accounts',accounts,'contracts',contracts,'times',times,'zones',zones))
        ON CONFLICT DO NOTHING;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM paper_entry_attempts WHERE proposed_order_id=p.id) THEN
      INSERT INTO paper_entry_attempts(proposed_order_id,account_id,broker,conid,account_date,session_date,session_timezone,attempted_at,source)
        VALUES(p.id,account,'ibkr',contract,(stamp AT TIME ZONE 'Europe/Warsaw')::date,(stamp AT TIME ZONE zone)::date,zone,stamp,'legacy') ON CONFLICT DO NOTHING;
      END IF;
      IF EXISTS(SELECT 1 FROM paper_entry_attempts a WHERE a.proposed_order_id=p.id AND
        ROW(a.account_id,a.conid,a.session_timezone,a.attempted_at) IS DISTINCT FROM ROW(account,contract,zone,stamp)) THEN
        INSERT INTO paper_entry_migration_holds(evidence_key,account_id,reason,evidence)
          VALUES('legacy_changed:'||p.id,NULL,'LEGACY_IMPORTED_IDENTITY_CHANGED',jsonb_build_object('proposalId',p.id)) ON CONFLICT DO NOTHING;
      END IF;
    END IF;
    INSERT INTO paper_entry_legacy_day_debts(proposed_order_id,account_id,charged_date,source)
      SELECT p.id,w.account_id,w.trade_date,'gpw' FROM gpw_windows w WHERE w.consumed_proposal_id=p.id
        AND NOT EXISTS(SELECT 1 FROM paper_entry_attempts a WHERE a.proposed_order_id=p.id AND a.account_id=w.account_id AND a.account_date=w.trade_date)
      UNION ALL SELECT p.id,w.account_id,w.trade_date,'aapl' FROM aapl_windows w WHERE w.consumed_proposal_id=p.id
        AND NOT EXISTS(SELECT 1 FROM paper_entry_attempts a WHERE a.proposed_order_id=p.id AND a.account_id=w.account_id AND a.account_date=w.trade_date)
      ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
SELECT import_paper_entry_legacy();

CREATE FUNCTION paper_budget_check_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding RECORD;
BEGIN
  IF NEW.source='legacy' THEN
    IF EXISTS(SELECT 1 FROM paper_entry_budget_adoptions WHERE account_id=NEW.account_id) THEN RAISE EXCEPTION 'PAPER_LEGACY_WRITER_DISABLED'; END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('snap:'||NEW.account_id));
  PERFORM pg_advisory_xact_lock(hashtext('paper:'||NEW.account_id||':ibkr:'||NEW.conid));
  IF EXISTS(SELECT 1 FROM paper_entry_migration_holds WHERE account_id IS NULL OR account_id=NEW.account_id) THEN RAISE EXCEPTION 'PAPER_BUDGET_MIGRATION_HOLD'; END IF;
  SELECT b.*,r.account_id,r.run_id AS bound_run INTO binding FROM paper_run_proposals b JOIN paper_runs r USING(run_id) WHERE b.proposed_order_id=NEW.proposed_order_id;
  IF NOT FOUND OR ROW(binding.account_id,binding.conid,binding.session_timezone,binding.bound_run) IS DISTINCT FROM ROW(NEW.account_id,NEW.conid,NEW.session_timezone,NEW.run_id)
    OR NEW.attempted_at<binding.starts_at OR NEW.attempted_at>=binding.ends_at
    OR abs(extract(epoch FROM clock_timestamp()-NEW.attempted_at))>1 THEN RAISE EXCEPTION 'PAPER_BUDGET_ATTEMPT_BINDING_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM paper_entry_attempts WHERE account_id=NEW.account_id AND broker=NEW.broker AND conid=NEW.conid AND session_timezone<>NEW.session_timezone) THEN RAISE EXCEPTION 'PAPER_BUDGET_TIMEZONE_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM paper_entry_attempts WHERE account_id=NEW.account_id AND
      (account_date=NEW.account_date OR (broker=NEW.broker AND conid=NEW.conid AND session_date=NEW.session_date)))
    OR EXISTS(SELECT 1 FROM paper_entry_legacy_day_debts WHERE account_id=NEW.account_id AND charged_date=NEW.account_date)
    THEN RAISE EXCEPTION 'PAPER_BUDGET_CONSUMED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paper_attempt_guard BEFORE INSERT ON paper_entry_attempts FOR EACH ROW EXECUTE FUNCTION paper_budget_check_attempt();

CREATE FUNCTION paper_budget_check_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.execution_attempted_at IS NOT NULL AND EXISTS(SELECT 1 FROM paper_entry_attempts WHERE proposed_order_id=OLD.id) AND
    ROW(NEW.execution_attempted_at,NEW.execution_account_id,NEW.conid,NEW.position_effect) IS DISTINCT FROM ROW(OLD.execution_attempted_at,OLD.execution_account_id,OLD.conid,OLD.position_effect)
    THEN RAISE EXCEPTION 'PAPER_ATTEMPT_IDENTITY_IMMUTABLE'; END IF;
  IF NEW.execution_attempted_at IS NOT NULL AND (TG_OP='INSERT' OR OLD.execution_attempted_at IS NULL) AND NEW.position_effect IS DISTINCT FROM 'CLOSE_OR_REDUCE' THEN
    PERFORM pg_advisory_xact_lock(hashtext('snap:'||coalesce(NEW.execution_account_id,'')));
    IF EXISTS(SELECT 1 FROM paper_entry_budget_adoptions WHERE account_id=NEW.execution_account_id OR NEW.execution_account_id IS NULL)
      OR EXISTS(SELECT 1 FROM paper_run_proposals WHERE proposed_order_id=NEW.id) THEN
      IF NOT EXISTS(SELECT 1 FROM paper_entry_attempts a WHERE a.proposed_order_id=NEW.id AND a.source='generic'
        AND a.account_id=NEW.execution_account_id AND a.conid=NEW.conid AND a.run_id IS NOT NULL AND a.attempted_at=NEW.execution_attempted_at) THEN RAISE EXCEPTION 'PAPER_LEGACY_WRITER_DISABLED'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paper_writer_guard BEFORE INSERT OR UPDATE ON proposed_orders FOR EACH ROW EXECUTE FUNCTION paper_budget_check_writer();
CREATE FUNCTION paper_budget_check_legacy_window() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('snap:'||NEW.account_id));
  IF NEW.consumed_proposal_id IS NOT NULL AND EXISTS(SELECT 1 FROM paper_entry_budget_adoptions WHERE account_id=NEW.account_id) THEN RAISE EXCEPTION 'PAPER_LEGACY_WRITER_DISABLED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paper_gpw_writer_guard BEFORE INSERT OR UPDATE ON gpw_windows FOR EACH ROW EXECUTE FUNCTION paper_budget_check_legacy_window();
CREATE TRIGGER paper_aapl_writer_guard BEFORE INSERT OR UPDATE ON aapl_windows FOR EACH ROW EXECUTE FUNCTION paper_budget_check_legacy_window();
