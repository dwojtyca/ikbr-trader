import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Pool } from "pg";
import { TradingConfigurationStore, TRADING_CONFIGURATION_SERVICES, computeTradingConfigurationHash,
  loadTradingConfiguration, parseTradingConfiguration } from "@ikbr/shared/trading-config";
import { resolveMigrationsDir, runMigrations } from "./migrations.js";

const url = process.env.TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
async function isolated(run: (pool: Pool) => Promise<void>, migrationsDir?: string) {
  const name = `pp2_conversion_${randomUUID().replaceAll("-", "")}`, target = new URL(url!);
  target.pathname = "/postgres"; const admin = new Pool({ connectionString: target.toString() });
  await admin.query(`CREATE DATABASE ${name}`); target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.toString() });
  try { await runMigrations(pool, { migrationsDir }); await run(pool); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function prepared(pool: Pool) {
  const raw = readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8");
  const parsed = parseTradingConfiguration(raw); if (!parsed.ok) throw Error("fixture");
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json",
    TRADING_CONFIG_EXPECTED_HASH: computeTradingConfigurationHash(parsed.configuration) }, { readFile: () => raw });
  const store = new TradingConfigurationStore(pool);
  for (const service of TRADING_CONFIGURATION_SERVICES) await store.register({ service, processId: randomUUID(), loaded, tradingEnabled: false });
  return { store, loaded };
}
const insertLegacy = `INSERT INTO proposed_orders(instrument,side,order_type,quantity,entry,reason,confidence,risk_check_status,status,strategy,position_effect)
  VALUES('QZXP','BUY','LMT',1,100,'fixture',1,'PASS','PROPOSED','momentum_breakout_long_v1',$1) RETURNING id`;

suite("PP2 conversion barrier on full migrated PostgreSQL", () => {
  test("upgrade from PP1 preserves legacy proposals, AI, close ownership and consumed daily budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pp2-pre-upgrade-")), source = resolveMigrationsDir();
    for (const file of readdirSync(source).filter(file => /^\d+.*\.sql$/.test(file) && Number(file.split("_")[0]) < 17))
      copyFileSync(join(source, file), join(dir, file));
    try { await isolated(async pool => {
      const id = (await pool.query(insertLegacy, ["OPEN_OR_ADD"])).rows[0].id;
      await pool.query(`UPDATE proposed_orders SET status='FILLED',client_order_hash='legacy-golden-hash',
        execution_attempted_at=clock_timestamp(),execution_account_id='DU_PP2' WHERE id=$1`, [id]);
      await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,status,expires_at,decision_json,decided_at,delivery_started_at)
        VALUES($1,'legacy-golden-hash','xyz_nyse','987654','DU_PP2','session','APPROVED',clock_timestamp()+interval '5 minutes','{"decision":"EXECUTE"}',clock_timestamp(),clock_timestamp())`, [id]);
      await pool.query(`INSERT INTO broker_order_links(proposed_order_id,account_id,role,broker_order_id,order_ref)
        VALUES($1,'DU_PP2','PARENT','123','legacy-ref')`, [id]);
      await pool.query(`INSERT INTO lifecycle_close_operations(original_proposal_id,request_id,account_id,session_id,client_id,socket_generation,
        original_hash,instrument_id,conid,limit_price,owner,actor,state)
        VALUES($1,$2,'DU_PP2','session',12,1,'legacy-golden-hash','xyz_nyse','987654',100,$3,'owner','COMPLETED')`, [id, randomUUID(), randomUUID()]);
      await pool.query(`INSERT INTO gpw_windows(run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
        VALUES('used','DU_PP2','2026-09-28',clock_timestamp(),clock_timestamp()+interval '10 minutes',$1,clock_timestamp())`, [id]);
      const tables = ["proposed_orders", "proposal_ai_reviews", "broker_order_links", "lifecycle_close_operations", "gpw_windows"];
      const before = await Promise.all(tables.map(async table => (await pool.query(`SELECT to_jsonb(t) row FROM ${table} t`)).rows[0].row));
      const result = await runMigrations(pool); assert.deepEqual(result.applied.map(name => Number(name.split("_")[0])), [17,18]);
      for (let i=0;i<tables.length;i++) {
        const row = (await pool.query(`SELECT to_jsonb(t) row FROM ${tables[i]} t`)).rows[0].row;
        for (const [key,value] of Object.entries(before[i])) assert.deepEqual(row[key],value,`${tables[i]}.${key}`);
      }
      assert.equal((await pool.query("SELECT client_order_hash_version,strategy_attribution FROM proposed_orders")).rows[0].client_order_hash_version,1);
      assert.equal((await pool.query("SELECT strategy_attribution FROM proposed_orders")).rows[0].strategy_attribution,null);
      await assert.rejects(() => pool.query(`INSERT INTO gpw_windows(run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
        SELECT 'duplicate',account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at FROM gpw_windows`), /duplicate key/);
    }, dir); } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  test("disabled four-peer conversion drains only safe proposals and freezes inheritance/cutoff", async () => isolated(async pool => {
    const { store, loaded } = await prepared(pool);
    await pool.query(insertLegacy, ["OPEN_OR_ADD"]);
    await assert.rejects(() => store.prepareStrategyRuntime(loaded, true), /DISABLED_WRITES/);
    const before = Date.now(); const result = await store.prepareStrategyRuntime(loaded, false);
    assert.ok(result.notBeforeBucketMs > before && result.notBeforeBucketMs % 60000 === 0);
    assert.equal((await pool.query("SELECT status,last_error FROM proposed_orders")).rows[0].status, "EXPIRED");
    const inheritance = (await pool.query("SELECT * FROM strategy_binding_legacy_inheritance")).rows;
    assert.equal(inheritance.length, 1); assert.equal(inheritance[0].consecutive_loss_count, 0);
    assert.deepEqual(await new TradingConfigurationStore(pool).prepareStrategyRuntime(loaded, true), result);
    assert.deepEqual((await pool.query("SELECT * FROM strategy_binding_legacy_inheritance")).rows, inheritance);
    await assert.rejects(() => pool.query("UPDATE strategy_runtime_conversion SET v2_not_before_bucket_ms=v2_not_before_bucket_ms+60000"), /immutable/);
    await assert.rejects(() => pool.query(insertLegacy, ["OPEN_OR_ADD"]), /LEGACY_ENTRY_AFTER_STRATEGY_CONVERSION/);
    await assert.rejects(() => pool.query("UPDATE proposed_orders SET execution_attempted_at=clock_timestamp()"), /LEGACY_ENTRY_AFTER_STRATEGY_CONVERSION/);
    await pool.query(insertLegacy, ["CLOSE_OR_REDUCE"]);
    assert.equal((await store.readAdmissionState()).latched, true);
  }));
  test("unknown ownership or a live review lease rolls back every conversion mutation", async () => isolated(async pool => {
    const { store, loaded } = await prepared(pool);
    const id = (await pool.query(insertLegacy, ["OPEN_OR_ADD"])).rows[0].id;
    await pool.query("UPDATE proposed_orders SET status='UNKNOWN' WHERE id=$1", [id]);
    await assert.rejects(() => store.prepareStrategyRuntime(loaded, false), /UNRESOLVED_OWNERSHIP/);
    assert.equal((await pool.query("SELECT status FROM proposed_orders")).rows[0].status, "UNKNOWN");
    assert.equal((await pool.query("SELECT * FROM strategy_runtime_conversion")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM strategy_binding_legacy_inheritance")).rowCount, 0);
    await pool.query("UPDATE proposed_orders SET status='PROPOSED' WHERE id=$1", [id]);
    await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,status,expires_at,claim_until)
      VALUES($1,'hash','xyz_nyse','987654','DU_PP2','session','PENDING',clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '30 seconds')`, [id]);
    await assert.rejects(() => store.prepareStrategyRuntime(loaded, false), /UNRESOLVED_OWNERSHIP/);
    assert.equal((await pool.query("SELECT status FROM proposed_orders")).rows[0].status, "PROPOSED");
  }));
  test("a stale legacy producer waiting behind the conversion table barrier cannot insert", async () => isolated(async pool => {
    const { loaded } = await prepared(pool);
    if (loaded.mode !== "bundle") throw Error("fixture");
    const barrier = await pool.connect(), producer = await pool.connect();
    try {
      await barrier.query("BEGIN"); await barrier.query("LOCK TABLE proposed_orders IN EXCLUSIVE MODE");
      const pid = (await producer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      const pending = producer.query(insertLegacy, ["OPEN_OR_ADD"]);
      const rejection = assert.rejects(pending, /LEGACY_ENTRY_AFTER_STRATEGY_CONVERSION/);
      let blocked = false;
      for (let n=0;n<100;n++) {
        const state = await barrier.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
        if (state.rows[0]?.wait_event_type === "Lock") { blocked=true; break; }
      }
      assert.equal(blocked, true);
      await barrier.query(`INSERT INTO strategy_runtime_conversion(singleton,source_hash,v2_not_before_bucket_ms)
        VALUES(TRUE,$1,(floor(extract(epoch FROM clock_timestamp())/60)+1)*60000)`, [loaded.effectiveHash]);
      await barrier.query("COMMIT"); await rejection;
      assert.equal((await pool.query("SELECT * FROM proposed_orders")).rowCount, 0);
    } finally { await barrier.query("ROLLBACK"); barrier.release(); producer.release(); }
  }));
});
