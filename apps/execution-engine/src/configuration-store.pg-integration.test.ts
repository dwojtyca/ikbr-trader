import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { Pool } from "pg";
import { InstrumentBindingAuthority, InstrumentRegistry } from "@ikbr/shared";
import { TradingConfigurationStore, createTradingConfigurationRuntime, createLegacyManagementSnapshot, computeTradingConfigurationHash, loadTradingConfiguration, parseTradingConfiguration,
  buildTradingConfigurationProjection, TRADING_CONFIGURATION_SERVICES, type LoadedTradingConfiguration } from "@ikbr/shared/trading-config";
import { runMigrations } from "./migrations.js";
import { ExecutionRepository } from "./repository.js";
import { focusedSubmissionTestSessionGuard } from "./session-entry-guard.fixture.js";
import { fixture } from "./lifecycle/close-test-fixture.js";

const url = process.env.TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
function raw() { return JSON.parse(readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8")); }
function bundle(input = raw(), legacySourceHash?: string): LoadedTradingConfiguration {
  const parsed = parseTradingConfiguration(input); assert.equal(parsed.ok, true); if (!parsed.ok) throw Error("fixture");
  return loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json", TRADING_CONFIG_EXPECTED_HASH: computeTradingConfigurationHash(parsed.configuration), TRADING_CONFIG_LEGACY_SOURCE_HASH: legacySourceHash }, { readFile: () => JSON.stringify(input) });
}
async function isolated(fn: (pool: Pool) => Promise<void>) {
  const dbName = `pp1_config_${randomUUID().replaceAll("-", "")}`, target = new URL(url!);
  target.pathname = "/postgres"; const admin = new Pool({ connectionString: target.toString() });
  await admin.query(`CREATE DATABASE ${dbName}`); target.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: target.toString() });
  try { await runMigrations(pool); await fn(pool); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${dbName}`); await admin.end(); }
}
function legacyAuthority() {
  const b = fixture().context.bound!;
  return new InstrumentBindingAuthority(new InstrumentRegistry([b.instrument]), [{ instrumentId: b.instrumentId, conId: b.conId, localSymbol: b.localSymbol, tradingClass: b.tradingClass, exchange: b.exchange, currency: b.currency, minTick: b.minTick }]);
}
async function prepare(pool: Pool) {
  const store = new TradingConfigurationStore(pool), authority = legacyAuthority();
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "legacy", TRADING_CONFIG_MIGRATION_PREPARE: "true", TRADING_ENABLED: "false" });
  const runtimes = TRADING_CONFIGURATION_SERVICES.map(service => createTradingConfigurationRuntime({ service, store, loaded, legacyAuthority: authority, tradingEnabled: false }));
  for (const runtime of runtimes) await runtime.initialize();
  await runtimes[0].heartbeat();
  return { store, authority, sourceHash: createLegacyManagementSnapshot(authority).sourceHash, runtimes };
}
suite("PP1 durable configuration authority on isolated PostgreSQL", () => {
  test("fresh bundle persists snapshots/revisions and sticky drift across restart without permitting entries", async () => isolated(async pool => {
    const store = new TradingConfigurationStore(pool), loaded = bundle();
    const enabled = createTradingConfigurationRuntime({ service: "execution-engine", store, loaded, tradingEnabled: true });
    await assert.rejects(() => enabled.initialize(), /DISABLED_WRITES/);
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM trading_configuration_snapshots")).rows[0].n), 0);
    const runtimes = TRADING_CONFIGURATION_SERVICES.map(service => createTradingConfigurationRuntime({ service, store, loaded, tradingEnabled: false }));
    for (const runtime of runtimes) await runtime.initialize();
    const matched = await runtimes[0].admission(); assert.equal(matched.allowed, false); assert.ok(!matched.reasons.includes("CONFIG_DRIFT"));
    const changed = raw(); changed.instruments[0].entryEnabled = false;
    const concurrent = createTradingConfigurationRuntime({ service: "ingestion", store, loaded: bundle(changed), tradingEnabled: false });
    await concurrent.initialize(); assert.ok((await runtimes[0].admission()).reasons.includes("CONFIG_DRIFT"));
    const modified = raw(); modified.strategyInstances[0].parameters = { dailyReturn20MinPct: 9 };
    await assert.rejects(() => createTradingConfigurationRuntime({ service: "signal-engine", store, loaded: bundle(modified), tradingEnabled: false }).initialize(), /INSTANCE_REVISION_REUSED/);
    await assert.rejects(() => pool.query("UPDATE trading_configuration_snapshots SET canonical_json='{}'"), /immutable/);
    await assert.rejects(() => pool.query("UPDATE trading_configuration_rollout SET bundle_latched=FALSE"), /cannot be reset/);
    await pool.query("UPDATE trading_configuration_observations SET expires_at=clock_timestamp()-interval '1 second'");
    assert.ok((await runtimes[0].admission()).reasons.includes("CONFIG_SERVICE_UNAVAILABLE"));
    const legacy = createTradingConfigurationRuntime({ service: "llm-agent", store, loaded: loadTradingConfiguration({}), tradingEnabled: false });
    await legacy.initialize(); assert.ok((await legacy.admission()).reasons.includes("CONFIG_DRIFT"));
  }));
  test("four-process preparation holds providers/entries and retained ownership survives removed instrument restart", async () => isolated(async pool => {
    const f = fixture();
    await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,execution_account_id,execution_attempted_at,client_order_hash)
      VALUES('TEST','test','123','BUY','LMT',1,100,99,102,'fixture',1,'PASS','UNKNOWN','test_strategy','DU_TEST',clock_timestamp(),$1)`, [f.evidence.clientOrderHash]);
    const before = (await pool.query("SELECT client_order_hash,status,execution_attempted_at FROM proposed_orders")).rows;
    const store = new TradingConfigurationStore(pool), noSource = createTradingConfigurationRuntime({ service: "execution-engine", store, loaded: bundle(), tradingEnabled: false });
    await assert.rejects(() => noSource.initialize(), /SNAPSHOT_REQUIRED/);
    const prepared = await prepare(pool);
    assert.equal(prepared.runtimes[0].diagnostics().preparationPending, false);
    for (const runtime of prepared.runtimes) assert.equal((await runtime.admission()).allowed, false);
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM trading_configuration_management_snapshots")).rows[0].n), 1);
    const loaded = bundle(raw(), prepared.sourceHash);
    const conversionWithWrites = createTradingConfigurationRuntime({ service: "execution-engine", store, loaded, tradingEnabled: true });
    await assert.rejects(() => conversionWithWrites.initialize(), /DISABLED_WRITES/);
    const runtime = createTradingConfigurationRuntime({ service: "execution-engine", store, loaded, tradingEnabled: false });
    await runtime.initialize();
    const restarted = createTradingConfigurationRuntime({ service: "execution-engine", store: new TradingConfigurationStore(pool), loaded, tradingEnabled: true });
    await restarted.initialize();
    assert.equal(restarted.resolveManagementInstrument("test")?.instrument.trading.executionEnabled, true);
    assert.equal(restarted.resolveManagementInstrument("test")?.instrument.executionPolicy?.strategyId, "test_strategy");
    if (loaded.mode !== "bundle") throw Error("fixture");
    const monitoring = restarted.monitoringAuthority(buildTradingConfigurationProjection(loaded.configuration).authority);
    assert.equal(monitoring.getBoundInstrument("test")?.instrument.trading.monitoringEnabled, true);
    assert.equal(monitoring.getBoundInstrument("test")?.instrument.trading.executionEnabled, false);
    assert.deepEqual((await pool.query("SELECT client_order_hash,status,execution_attempted_at FROM proposed_orders")).rows, before);
    assert.equal((await restarted.admission()).allowed, false);
    const old = prepared.authority.getBoundInstrument("test")!;
    const changedLegacy = new InstrumentBindingAuthority(new InstrumentRegistry([old.instrument]), [{ instrumentId: "test", conId: 999,
      localSymbol: "TEST", tradingClass: "TEST", exchange: "SMART", currency: "USD", minTick: .01 }]);
    await assert.rejects(() => createTradingConfigurationRuntime({ service: "execution-engine", store, loaded: loadTradingConfiguration({}),
      legacyAuthority: changedLegacy, tradingEnabled: false }).initialize(), /IDENTITY_CONFLICT/);
    const foreign = bundle(raw(), "a".repeat(64));
    await assert.rejects(() => createTradingConfigurationRuntime({ service: "execution-engine", store, loaded: foreign, tradingEnabled: false }).initialize(), /SOURCE_CHANGED/);
  }));
  test("repository holds dispatch permit through an awaited final configuration check", async () => isolated(async pool => {
    const repo = new ExecutionRepository(pool, undefined, undefined, focusedSubmissionTestSessionGuard);
    let writes = 0, checked = false;
    await assert.rejects(() => repo.withEntryDispatchPermit(fixture().order, "DU_TEST", () => { writes++; }, async () => {
      await Promise.resolve(); checked = true; throw Error("CONFIG_DRIFT");
    }), /CONFIG_DRIFT/);
    assert.equal(checked, true); assert.equal(writes, 0);
    await repo.withEntryDispatchPermit(fixture().order, "DU_TEST", () => { writes++; }, async () => { await Promise.resolve(); });
    assert.equal(writes, 1);
    const latestDeadline = Date.now() + 60_000;
    const deadlineRepo = new ExecutionRepository(pool, undefined, undefined, async () => ({ ok: true, generation: 1, endsAtMs: latestDeadline }));
    const originalNow = Date.now;
    try {
      await assert.rejects(() => deadlineRepo.withEntryDispatchPermit(fixture().order, "DU_TEST", () => { writes++; }, async () => {
        await Promise.resolve(); Date.now = () => latestDeadline;
      }), /session_dispatch_expired/);
    } finally { Date.now = originalNow; }
    assert.equal(writes, 1);
  }));
  test("standalone attempted close is retained state, never a fresh installation", async () => isolated(async pool => {
    await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,position_effect,order_type,quantity,entry,reason,confidence,risk_check_status,status,execution_attempted_at)
      VALUES('TEST','test','123','SELL','CLOSE_OR_REDUCE','LMT',1,100,'fixture',1,'PASS','UNKNOWN',clock_timestamp())`);
    const runtime = createTradingConfigurationRuntime({ service: "execution-engine", store: new TradingConfigurationStore(pool), loaded: bundle(), tradingEnabled: false });
    await assert.rejects(() => runtime.initialize(), /SNAPSHOT_REQUIRED/);
    assert.equal((await pool.query("SELECT bundle_latched FROM trading_configuration_rollout")).rows[0].bundle_latched, false);
  }));
  test("fresh install cannot treat failed retained-state query as an empty database", async () => isolated(async pool => {
    await pool.query("ALTER TABLE proposed_orders RENAME TO unavailable_proposals");
    const runtime = createTradingConfigurationRuntime({ service: "execution-engine", store: new TradingConfigurationStore(pool), loaded: bundle(), tradingEnabled: false });
    await assert.rejects(() => runtime.initialize());
    assert.equal((await pool.query("SELECT bundle_latched FROM trading_configuration_rollout")).rows[0].bundle_latched, false);
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM trading_configuration_snapshots")).rows[0].n), 0);
    assert.equal((await runtime.admission()).allowed, false);
  }));
  test("startup fails closed before migration and after DB read outage; no caller fallback", async () => isolated(async pool => {
    const store = new TradingConfigurationStore(pool), loaded = bundle();
    const runtime = createTradingConfigurationRuntime({ service: "ingestion", store, loaded, tradingEnabled: false });
    await runtime.initialize();
    await pool.query("ALTER TABLE trading_configuration_observations RENAME TO unavailable_observations");
    assert.equal((await runtime.admission()).allowed, false);
    assert.ok((await runtime.admission()).reasons.includes("CONFIG_STORE_UNAVAILABLE"));
    await assert.rejects(() => runtime.heartbeat());
    assert.equal(runtime.resolveManagementInstrument("test"), undefined);
    assert.equal(runtime.diagnostics().initialized, false);
  }));
});
