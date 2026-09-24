import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Pool } from "pg";
import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { TwsExecutionClient, type BrokerExecutionFill } from "../tws-execution-client.js";
import { ReconciliationRepository } from "./repository.js";
import { ReconciliationRunner } from "./runner.js";
import { FakeBrokerReconciliationAdapter } from "./fake-broker-adapter.js";
import type { BrokerReconciliationSnapshot } from "./broker-adapter.js";
const connection = process.env.TEST_POSTGRES_URL;
const context = { accountId: "DU-CASH", sessionId: "cash-session", sessionStartedAt: new Date(Date.now() - 1000) };
const cfg = { runTimeoutMs: 5000, sourceTimeoutMs: 1000, executionSafetyMarginMs: 1000 };
const fill: BrokerExecutionFill = { execId: "cash-fill", accountId: context.accountId, conid: "123", symbol: "EUR", currency: "USD",
  exchange: "IDEALPRO", side: "SELL", shares: 7, price: 1.1, executedAt: new Date().toISOString() };
async function db(fn: (pool: Pool, repo: ExecutionRepository) => Promise<void>) {
  const url = new URL(connection!); url.pathname = "/postgres"; const admin = new Pool({ connectionString: url.toString() });
  const name = `cash_${randomUUID().replaceAll("-", "")}`; await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`; const pool = new Pool({ connectionString: url.toString() });
  try { await runMigrations(pool); await fn(pool, new ExecutionRepository(pool)); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
function runner(pool: Pool, mutate?: (s: BrokerReconciliationSnapshot) => BrokerReconciliationSnapshot, reconciliation = new ReconciliationRepository(pool)) {
  const fake = new FakeBrokerReconciliationAdapter();
  return new ReconciliationRunner(pool, new ExecutionRepository(pool), reconciliation, {
    capture: async request => { const s = await fake.capture(request); const next = { ...s,
      positions: [{ accountId: context.accountId, conId: "123", symbol: "EUR", currency: "USD", secType: "CASH", position: 0 }],
      executions: [{ execId: fill.execId, accountId: context.accountId, conId: "123", symbol: "EUR", currency: "USD",
        side: "SLD", shares: 7, secType: "CASH", brokerOrderId: "11", executedAt: new Date() }] };
      return mutate ? mutate(next) : next; },
  });
}
async function seedHold(pool: Pool) {
  const old = await new ReconciliationRunner(pool, new ExecutionRepository(pool), new ReconciliationRepository(pool),
    new FakeBrokerReconciliationAdapter()).runOnce(context, cfg);
  assert.equal(old?.status, "MISMATCH");
  return (await pool.query("SELECT * FROM reconciliation_holds WHERE reason='position_mismatch'")).rows[0];
}
test("actual callback persists security type, commission-first enrichment and missing-type replay", { skip: !connection }, async () => db(async (pool, repo) => {
  await repo.applyBrokerCommissionReport({ execId: "callback-fill", commission: 1, currency: "USD" });
  const ib = new EventEmitter(), pending: Promise<void>[] = [];
  new TwsExecutionClient({ host: "unused", port: 0, clientId: 1, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
    () => {}, undefined, f => { pending.push(repo.upsertBrokerExecutionFill(f)); }, undefined, { ib });
  ib.emit("execDetails", 1, { conId: 123, symbol: "EUR", secType: " cash ", currency: "USD" },
    { execId: "callback-fill", acctNumber: context.accountId, shares: 7, side: "SLD", price: 1.1 });
  await Promise.all(pending); await repo.upsertBrokerExecutionFill({ ...fill, execId: "callback-fill" });
  const row = (await pool.query("SELECT sec_type,sec_type_conflict,shares,commission FROM broker_execution_fills")).rows[0];
  assert.equal(row.sec_type, "CASH"); assert.equal(row.sec_type_conflict, false);
  assert.equal(Number(row.shares), 7); assert.equal(Number(row.commission), 1);
}));
for (const kind of ["legacy", "typed"] as const) test(`${kind} CASH retains audit and resolves exact old hold without changing proposal`, { skip: !connection }, async () => db(async (pool, repo) => {
  await repo.upsertBrokerExecutionFill(fill); const hold = await seedHold(pool);
  if (kind === "typed") await repo.upsertBrokerExecutionFill({ ...fill, secType: "CASH" });
  const proposal = (await pool.query(`INSERT INTO proposed_orders
    (instrument,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,client_order_id,execution_account_id)
    VALUES ('AAPL','265598','BUY','LMT',1,100,99,102,'test',0.9,'PASS','PROPOSED','unrelated','DU-CASH') RETURNING *`)).rows[0];
  const before = (await pool.query("SELECT * FROM broker_execution_fills")).rows;
  const result = await runner(pool).runOnce(context, cfg); assert.equal(result?.status, "CLEAN"); assert.equal(result?.holdsResolved, 1);
  assert.deepEqual((await pool.query("SELECT * FROM broker_execution_fills")).rows, before);
  assert.deepEqual((await pool.query("SELECT * FROM proposed_orders WHERE id=$1", [proposal.id])).rows[0], proposal);
  const after = (await pool.query("SELECT * FROM reconciliation_holds WHERE id=$1", [hold.id])).rows[0];
  assert.equal(after.resolved_kind, "auto_snapshot_clean"); assert.match(after.resolution_note, /CASH/); assert.ok(after.resolved_at);
  const s = (await pool.query("SELECT broker_snapshot FROM reconciliation_runs WHERE id=$1", [result!.runId])).rows[0].broker_snapshot;
  assert.equal(s.executions[0].shares, 7); assert.equal(s.positions[0].secType, "CASH");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM reconciliation_broker_order_observations WHERE reconciliation_run_id=$1", [result!.runId])).rows[0].n, 1);
  for (const table of ["broker_order_links", "broker_order_ref_map"]) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  assert.equal((await runner(pool).runOnce(context, cfg))?.holdsResolved, 0);
}));
for (const mode of ["type", "untyped-account", "untyped-conid", "untyped-symbol", "untyped-currency", "zero-net"] as const) {
  test(`typed replay conflict is durable and checked before net aggregation: ${mode}`, { skip: !connection }, async () => db(async (pool, repo) => {
    await repo.upsertBrokerExecutionFill({ ...fill, secType: "CASH" });
    const replay: BrokerExecutionFill = { ...fill, secType: undefined };
    if (mode === "type" || mode === "zero-net") replay.secType = "STK";
    if (mode === "untyped-account") replay.accountId = "FOREIGN";
    if (mode === "untyped-conid") replay.conid = "999";
    if (mode === "untyped-symbol") replay.symbol = "OTHER";
    if (mode === "untyped-currency") replay.currency = "PLN";
    await repo.upsertBrokerExecutionFill(replay);
    if (mode === "zero-net") await repo.upsertBrokerExecutionFill({ ...fill, execId: "offset", side: "BUY" });
    await repo.upsertBrokerExecutionFill({ ...fill, secType: "CASH" });
    const row = (await pool.query("SELECT account_id,conid,sec_type,sec_type_conflict FROM broker_execution_fills WHERE exec_id=$1", [fill.execId])).rows[0];
    assert.equal(row.sec_type_conflict, true); assert.equal(row.account_id, context.accountId); assert.equal(row.conid, "123");
    await assert.rejects(repo.computeExpectedNetPositionsWithIdentity(context.accountId), /security_type_conflict/);
    const result = await runner(pool).runOnce(context, cfg);
    assert.equal(result?.status, "FAILED"); assert.equal(result?.error, "reconciliation_security_type_conflict");
  }));
}
for (const mode of ["partial", "ambiguous", "foreign-proof", "mixed-fill", "stock-eur"] as const) {
  test(`CASH exemption cannot clear protected hold: ${mode}`, { skip: !connection }, async () => db(async (pool, repo) => {
    await repo.upsertBrokerExecutionFill(fill); const hold = await seedHold(pool);
    if (mode === "mixed-fill") await repo.upsertBrokerExecutionFill({ ...fill, execId: "unobserved" });
    if (mode === "ambiguous") await pool.query(`INSERT INTO proposed_orders
      (instrument,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,client_order_id,execution_account_id,execution_attempted_at)
      VALUES ('AAPL','265598','BUY','LMT',1,100,99,102,'test',0.9,'PASS','PROPOSED','ambiguous','DU-CASH',NOW())`);
    const result = await runner(pool, s => mode === "partial" ? { ...s, exposureComplete: false } : mode === "ambiguous"
      ? { ...s, sourceCoverage: { ...s.sourceCoverage, completedOrders: { ...s.sourceCoverage.completedOrders, recoveryScope: "current_state_only" } } }
      : mode === "foreign-proof" ? { ...s, executions: s.executions.map(e => ({ ...e, accountId: "FOREIGN" })) }
      : mode === "stock-eur" ? { ...s, positions: s.positions.map(p => ({ ...p, secType: "STK" })), executions: s.executions.map(e => ({ ...e, secType: "STK" })) } : s).runOnce(context, cfg);
    assert.notEqual(result?.status, "CLEAN");
    assert.equal((await pool.query("SELECT resolved_at FROM reconciliation_holds WHERE id=$1", [hold.id])).rows[0].resolved_at, null);
  }));
}

for (const mode of ["late-ambiguity", "late-coverage"] as const) test(`cash hold publication rechecks ${mode}`, { skip: !connection }, async () => db(async (pool, repo) => {
  await repo.upsertBrokerExecutionFill(fill); const hold = await seedHold(pool);
  class ChangedPublication extends ReconciliationRepository {
    override async publishResult(...args: Parameters<ReconciliationRepository["publishResult"]>): Promise<void> {
      if (mode === "late-ambiguity") await pool.query(`INSERT INTO proposed_orders
        (instrument,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,client_order_id,execution_account_id,execution_attempted_at)
        VALUES ('AAPL','265598','BUY','LMT',1,100,99,102,'test',0.9,'PASS','PROPOSED','late-ambiguous','DU-CASH',NOW())`);
      if (mode === "late-coverage") args[1] = { ...args[1], snapshot: { ...args[1].snapshot!, recoveryComplete: false } };
      await super.publishResult(...args);
    }
  }
  assert.equal((await runner(pool, undefined, new ChangedPublication(pool)).runOnce(context, cfg))?.status, "FAILED");
  assert.equal((await pool.query("SELECT resolved_at FROM reconciliation_holds WHERE id=$1", [hold.id])).rows[0].resolved_at, null);
}));

for (const mode of ["late-fill", "late-conflict", "late-commission"] as const) {
  for (const hadHold of [true, false]) test(`cash publication fences ${mode}, old hold=${hadHold}`, { skip: !connection }, async () => db(async (pool, repo) => {
    await repo.upsertBrokerExecutionFill(fill);
    const hold = hadHold ? await seedHold(pool) : undefined;
    class LateFillPublication extends ReconciliationRepository {
      override async publishResult(...args: Parameters<ReconciliationRepository["publishResult"]>): Promise<void> {
        if (mode === "late-fill") await repo.upsertBrokerExecutionFill({ ...fill, execId: "late-unknown" });
        if (mode === "late-conflict") {
          await repo.upsertBrokerExecutionFill({ ...fill, secType: "CASH" });
          await repo.upsertBrokerExecutionFill({ ...fill, secType: "STK" });
        }
        if (mode === "late-commission") await repo.applyBrokerCommissionReport({ execId: "commission-first", commission: 1 });
        await super.publishResult(...args);
      }
    }
    assert.equal((await runner(pool, undefined, new LateFillPublication(pool)).runOnce(context, cfg))?.status, "FAILED");
    if (hold) assert.equal((await pool.query("SELECT resolved_at FROM reconciliation_holds WHERE id=$1", [hold.id])).rows[0].resolved_at, null);
  }));
}
test("normal fill and commission writers serialize with CASH publication evidence locks", { skip: !connection }, async () => db(async (pool, repo) => {
  await repo.upsertBrokerExecutionFill({ ...fill, secType: "CASH" });
  const client = await pool.connect();
  const observer = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('cash:unattributed-fill'))");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`snap:${context.accountId}`]);
  const updates = [repo.upsertBrokerExecutionFill({ ...fill, secType: undefined }),
    repo.upsertBrokerExecutionFill({ ...fill, execId: "new-fill", secType: "CASH" }),
    repo.applyBrokerCommissionReport({ execId: "new-commission", commission: 1 })];
  try {
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const locks = await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
      if (locks.rows[0].n >= 3) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(blocked, true);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM broker_execution_fills")).rows[0].n, 1);
  } finally {
    await client.query("COMMIT"); client.release(); observer.release();
    await Promise.all(updates);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM broker_execution_fills")).rows[0].n, 3);
}));
