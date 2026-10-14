import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { ResearchStore, marketauxCallIdentity, marketauxWindow, researchHash, researchRefreshSlotKey, type ResearchPool } from "@ikbr/shared/instrument-research";
import { TradingConfigurationStore, loadTradingConfiguration } from "@ikbr/shared/trading-config";
import { marketauxFixture, marketauxResponse } from "./research-marketaux.testfixture.js";
import { ResearchRefreshScheduler } from "./research-refresh.js";

const connection = process.env.TEST_POSTGRES_URL;
type Mode = "partial" | "none" | "unknown" | "failed" | "missing" | "hash" | "account" | "provider" | "gap" | "late" | "no-slot" | "different-coverage" | "not-exhausted" | "cross-slot" | "midnight" | "cost" | "middle-gap" | "early-outcome" | "acquisition-too-long";
async function isolated(mode: Mode, run: (fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const name = `marketaux_budget_${randomUUID().replaceAll("-", "")}`, url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE DATABASE ${name}`); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    const dir = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) await pool.query(readFileSync(new URL(file, dir), "utf8"));
    await run(await seed(pool, mode));
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function seed(pool: Pool, mode: Mode) {
  const now = (await pool.query("SELECT clock_timestamp() now")).rows[0].now.getTime(), f = marketauxFixture(now);
  f.newsConfig.qualification.expiresAt = new Date(now + 3 * 86400000).toISOString(); f.newsConfig.entitlement.expiresAt = f.newsConfig.qualification.expiresAt;
  f.source.maxRequestsPerDay = mode === "cost" ? 10 : 3; f.source.maxCostMicrosPerDay = 3;
  f.manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = f.manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json", TRADING_CONFIG_EXPECTED_HASH: f.configHash }, { readFile: () => readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8") });
  await new TradingConfigurationStore(pool).register({ service: "execution-engine", processId: randomUUID(), loaded, tradingEnabled: false });
  const store = new ResearchStore(pool); await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const) await store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: service, tradingEnabled: false });
  const identity = { accountId: "DU_TEST", configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId };
  const yesterday = Date.parse(new Date(now).toISOString().slice(0, 10)) - 86400000;
  const start = yesterday + (mode === "midnight" ? 0 : 12 * 3600000), slot = start / 900000, window = marketauxWindow(slot);
  const failureAt = start + (mode === "cross-slot" ? 900001 : mode === "acquisition-too-long" ? 121001 : 30000);
  const coverage = { sourceId: f.source.id, role: "news" as const, status: "ERROR" as const, checkedAt: window.asOf, windowStart: window.windowStart, windowEnd: window.asOf, complete: false, evidenceRefs: [], reason: "RESEARCH_BUDGET_EXHAUSTED" };
  const original = structuredClone(f.snapshot); original.createdAt = new Date(failureAt).toISOString();
  for (const row of original.coverage) { row.checkedAt = new Date(start + 1).toISOString(); row.windowStart = new Date(start - 86400000).toISOString(); row.windowEnd = row.checkedAt; }
  for (const row of original.evidence) { row.fetchedAt = new Date(start + 1).toISOString(); row.observedAt = row.fetchedAt; row.published = { precision: "instant", at: new Date(start - 3600000).toISOString() }; }
  original.coverage.push(coverage);
  const saved = await store.storeSnapshot(original), slotKey = researchRefreshSlotKey(f.manifestHash, f.policy.instrumentId, f.source.id, "news", slot);
  if (mode !== "no-slot") await pool.query("INSERT INTO research_refresh_slots(slot_key,snapshot_id,published_at) VALUES($1,$2,$3)", [slotKey, saved.id, new Date(failureAt + 1)]);
  const current = structuredClone(f.snapshot); current.coverage.push({ ...coverage, ...(mode === "different-coverage" ? { sourceError: { name: null, code: null, message: "changed fixture" } } : {}) });
  await store.storeSnapshot(current);
  const callKeys: string[] = [];
  const sourcePages = mode === "none" ? [] : mode === "gap" ? [2] : mode === "middle-gap" ? [1, 3] : [1, 2];
  for (const page of sourcePages) {
    const call = marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, { sourceUrl: f.source.urls[0], ...window, pass: 1, page });
    callKeys.push(call.callKey);
    const reserved = start + page * 1000, outcome = mode === "late" && page === 2 ? reserved + 10001 : mode === "early-outcome" ? reserved - 1 : reserved + 100;
    await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
      VALUES($1,$2,$3,'source',$4,$5,$6,1,$7,$8,($7::timestamptz AT TIME ZONE 'UTC')::date)`, [call.callKey, mode === "account" ? "DU_OTHER" : identity.accountId, mode === "provider" ? "other-provider" : f.source.provider, f.configHash, f.manifestHash, mode === "hash" ? "f".repeat(64) : call.requestHash, new Date(reserved), new Date(reserved + 10000)]);
    if (mode !== "missing") await pool.query("INSERT INTO research_call_outcomes(call_key,outcome,recorded_at) VALUES($1,$2,$3)", [call.callKey, mode === "unknown" ? "UNKNOWN" : mode === "failed" ? "FAILED" : "SUCCEEDED", new Date(outcome)]);
  }
  const fillers = (mode === "not-exhausted" ? 2 : 3) - sourcePages.length;
  for (let i = 0; i < fillers; i++) await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
    VALUES($1,'DU_TEST',$2,'source',$3,$4,$5,1,$6,$7,($6::timestamptz AT TIME ZONE 'UTC')::date)`, [`other-instrument-${i}`, f.source.provider, f.configHash, f.manifestHash, "a".repeat(64), new Date(start + 500), new Date(start + 5000)]);
  await pool.query(`INSERT INTO research_repair_requests(account_id,config_hash,manifest_hash,instrument_id,source_id,role,state,reasons)
    VALUES('DU_TEST',$1,$2,$3,$4,'news','HOLD','["RESEARCH_NEWS_ERROR","RESEARCH_BUDGET_EXHAUSTED"]')`, [f.configHash, f.manifestHash, f.policy.instrumentId, f.source.id]);
  return { f, store, pool, identity, now, start, slot, saved, callKeys, failureAt };
}
const immutableRows = async (pool: Pool) => (await pool.query(`SELECT 'reservation' kind,row_to_json(r)::text data FROM research_call_reservations r
  UNION ALL SELECT 'outcome',row_to_json(o)::text FROM research_call_outcomes o
  UNION ALL SELECT 'snapshot',row_to_json(s)::text FROM research_snapshots s
  UNION ALL SELECT 'slot',row_to_json(s)::text FROM research_refresh_slots s ORDER BY kind,data`)).rows;

for (const mode of ["partial", "none", "midnight", "cost"] as const) test(`persisted local ${mode} exhaustion recovers only through fresh two-pass demand after UTC rollover`, { skip: !connection }, () => isolated(mode, async ({ f, pool, identity, start, failureAt }) => {
  const before = await immutableRows(pool), store = new ResearchStore(pool);
  const due = await store.dueRepairs(identity); assert.equal(due.length, 1);
  const prepared = await store.prepareRepair(identity); assert.equal(prepared.state, "WAITING", JSON.stringify(prepared));
  const source = prepared.sources.find(s => s.sourceId === f.source.id)!;
  assert.ok(source.reasons.includes("RESEARCH_MARKETAUX_BUDGET_RENEWED"));
  assert.equal(source.localBudget?.failedBudgetDay, new Date(start).toISOString().slice(0, 10));
  assert.equal(source.localBudget?.failureRecordedAt, new Date(failureAt).toISOString());
  assert.equal(source.localBudget?.recoveryProof, "VERIFIED");
  let calls = 0;
  const scheduler = new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash, accountId: identity.accountId, store: new ResearchStore(pool), marketauxOnDemand: true, marketauxApiKey: "fixture", marketauxFetch: async (_s, request) => { calls++; return marketauxResponse([], request.page, 0); } });
  await scheduler.tickRepairs(); assert.equal(calls, 2);
  assert.equal((await store.prepareRepair(identity)).state, "READY");
  const after = await immutableRows(pool); for (const row of before) assert.ok(after.some(other => other.kind === row.kind && other.data === row.data));
  const head = await store.latestSnapshot(identity); assert.equal(head?.snapshot.coverage.find(c => c.sourceId === f.source.id)?.reason, "RESEARCH_MARKETAUX_TWO_PASSES_COMPLETE");
}));

for (const mode of ["unknown", "failed", "missing", "hash", "account", "provider", "gap", "late", "no-slot", "different-coverage", "not-exhausted", "cross-slot", "middle-gap", "early-outcome", "acquisition-too-long"] as const) test(`local budget recovery refuses insufficient original provenance: ${mode}`, { skip: !connection }, () => isolated(mode, async ({ f, store, identity }) => {
  const result = await store.prepareRepair(identity); assert.equal(result.state, "HOLD");
  const diagnostic = result.sources.find(s => s.sourceId === f.source.id)?.localBudget;
  assert.equal(diagnostic?.recoveryProof, "UNAVAILABLE"); assert.equal(diagnostic?.failureRecordedAt, null);
}));

test("real reserveCall enforces shared current-day request cap concurrently and renewed recovery remains held when consumed", { skip: !connection }, () => isolated("partial", async ({ f, store, pool, identity }) => {
  assert.equal((await store.prepareRepair(identity)).state, "WAITING");
  const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => store.reserveCall({ ...identity, provider: f.source.provider, kind: "source", callKey: `current-other-instrument-${i}`, requestHash: "a".repeat(64), reservedCostMicros: 1, maxRequestsPerDay: 3, maxCostMicrosPerDay: 3, deadlineAt: new Date(Date.now() + 9000).toISOString() })));
  assert.equal(outcomes.filter(v => v.status === "fulfilled").length, 3);
  for (const outcome of outcomes.filter(v => v.status === "rejected")) assert.match(String(outcome.reason), /RESEARCH_BUDGET_EXHAUSTED/);
  const result = await store.prepareRepair(identity); assert.equal(result.state, "HOLD");
  assert.equal(result.sources.find(s => s.sourceId === f.source.id)?.localBudget?.requestsUsed, 3);
  let calls = 0;
  await new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash, accountId: identity.accountId, store: new ResearchStore(pool), marketauxOnDemand: true, marketauxApiKey: "fixture", marketauxFetch: async (_s, request) => { calls++; return marketauxResponse([], request.page, 0); } }).tickRepairs();
  assert.equal(calls, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date")).rows[0].n, 3);
}));

test("budget discovery cursor passes 100 stale candidates without throttling WAITING work", { skip: !connection }, () => isolated("none", async ({ store, pool, identity, f, now }) => {
  await pool.query("DELETE FROM research_repair_requests");
  for (let i = 0; i < 105; i++) await pool.query(`INSERT INTO research_repair_requests(account_id,config_hash,manifest_hash,instrument_id,source_id,role,state,reasons)
    VALUES('DU_TEST',$1,$2,$3,$4,'news','HOLD','["RESEARCH_BUDGET_EXHAUSTED"]')`, [f.configHash, f.manifestHash, f.policy.instrumentId, `stale-source-${i}`]);
  await pool.query(`INSERT INTO research_repair_requests(account_id,config_hash,manifest_hash,instrument_id,source_id,role,state,reasons)
    VALUES('DU_TEST',$1,$2,$3,$4,'news','HOLD','["RESEARCH_BUDGET_EXHAUSTED"]')`, [f.configHash, f.manifestHash, f.policy.instrumentId, f.source.id]);
  await pool.query(`INSERT INTO research_repair_requests(account_id,config_hash,manifest_hash,instrument_id,source_id,role,state,reasons,next_check_at)
    VALUES('DU_TEST',$1,$2,$3,'official','reports','WAITING','["RESEARCH_SOURCE_STALE"]',clock_timestamp()-interval '1 second')`, [f.configHash, f.manifestHash, f.policy.instrumentId]);
  let at = now; Object.defineProperty(store, "now", { value: async () => at });
  assert.deepEqual((await store.dueRepairs(identity)).map(r => r.sourceId), ["official"]);
  assert.deepEqual((await store.dueRepairs(identity)).map(r => r.sourceId), ["official"]);
  at += 60001;
  assert.deepEqual((await store.dueRepairs(identity)).map(r => r.sourceId), ["official", f.source.id]);
}));

test("failed budget discovery is retryable immediately; throttle resets at UTC midnight and on restart", { skip: !connection }, () => isolated("none", async ({ pool, identity, now }) => {
  let fail = true, scans = 0;
  const query: ResearchPool["query"] = async (sql, values) => {
    if (sql.includes("id>$4::bigint")) { scans++; if (fail) { fail = false; throw new Error("fixture query unavailable"); } }
    return pool.query(sql, values);
  };
  const store = new ResearchStore({ query, connect: () => pool.connect() });
  const midnight = Date.parse(new Date(now).toISOString().slice(0, 10)) + 86400000;
  let at = midnight - 10000; Object.defineProperty(store, "now", { value: async () => at });
  await assert.rejects(store.dueRepairs(identity), /fixture query unavailable/);
  assert.equal((await store.dueRepairs(identity)).length, 1); assert.equal(scans, 2);
  assert.equal((await store.dueRepairs(identity)).length, 0); assert.equal(scans, 2);
  at = midnight + 1;
  assert.equal((await store.dueRepairs(identity)).length, 1); assert.equal(scans, 4);
  assert.equal((await new ResearchStore(pool).dueRepairs(identity)).length, 1);
}));

test("UTC budget proof is independent of PostgreSQL session timezone", { skip: !connection }, () => isolated("midnight", async ({ pool, identity }) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
    const result = await new ResearchStore(pool).prepareRepair(identity, client);
    assert.equal(result.state, "WAITING", JSON.stringify(result));
  } finally { await client.query("ROLLBACK"); client.release(); }
}));


test("global transient reasons cannot bypass the sampled local-budget discovery branch", { skip: !connection }, () => isolated("none", async ({ pool, store, identity }) => {
  await pool.query(`UPDATE research_repair_requests SET reasons='["RESEARCH_NEWS_ERROR","RESEARCH_BUDGET_EXHAUSTED","RESEARCH_SOURCE_TIMEOUT"]'`);
  assert.equal((await store.dueRepairs(identity)).length, 1);
  assert.equal((await store.dueRepairs(identity)).length, 0);
}));


for (const mode of ["before-first", "partial"] as const) test(`actual reserveCall ${mode} rejection is published by scheduler, stays held the same day, and is reassessed on a later UTC day`, { skip: !connection }, () => isolated("none", async ({ f, store, pool, identity }) => {
  for (let i = 0; i < (mode === "before-first" ? 3 : 1); i++) await store.reserveCall({ ...identity, provider: f.source.provider, kind: "source", callKey: `real-budget-filler-${i}`, requestHash: "a".repeat(64), reservedCostMicros: 1, maxRequestsPerDay: 3, maxCostMicrosPerDay: 3, deadlineAt: new Date(Date.now() + 9000).toISOString() });
  const refreshStore = Object.create(store) as ResearchStore;
  refreshStore.hasRefreshSlot = async key => ["reports", "calendar"].some(role => key === researchRefreshSlotKey(f.manifestHash, f.policy.instrumentId, "official", role as "reports" | "calendar", Math.floor(Date.now() / 86400000))) || store.hasRefreshSlot(key);
  let calls = 0;
  const scheduler = new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash, accountId: identity.accountId, store: refreshStore, marketauxApiKey: "fixture", marketauxFetch: async (_s, request) => { calls++; return marketauxResponse(request.page === 1 ? [f.article(1), f.article(2)] : [f.article(3)], request.page, 3); } });
  await scheduler.tick(); assert.equal(calls, mode === "before-first" ? 0 : 2);
  const original = (await store.latestSnapshot(identity))!, coverage = original.snapshot.coverage.find(c => c.sourceId === f.source.id)!;
  assert.equal(coverage.reason, "RESEARCH_BUDGET_EXHAUSTED"); assert.equal(coverage.status, "ERROR"); assert.equal(coverage.complete, false);
  const held = await store.prepareRepair(identity), news = held.sources.find(s => s.sourceId === f.source.id)!;
  assert.equal(held.state, "HOLD"); assert.equal(news.state, "HOLD"); assert.ok(news.reasons.includes("RESEARCH_BUDGET_EXHAUSTED"));
  assert.equal(news.localBudget?.recoveryProof, "VERIFIED"); assert.equal(news.localBudget?.requestsUsed, 3);
  assert.equal(news.localBudget?.failedBudgetDay, news.localBudget?.currentBudgetDay);
  assert.ok(!held.reasons.includes("RESEARCH_SOURCE_FUTURE"));
  const before = await immutableRows(pool), events = (await pool.query("SELECT count(*)::int n FROM research_repair_events")).rows[0].n;
  await store.prepareRepair(identity); await new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash, accountId: identity.accountId, store: new ResearchStore(pool), marketauxOnDemand: true, marketauxApiKey: "fixture", marketauxFetch: async () => { throw new Error("same-day HOLD must not fetch"); } }).tickRepairs();
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_repair_events")).rows[0].n, events);
  assert.deepEqual(await immutableRows(pool), before);
  const nextDay = Date.parse(news.localBudget!.nextBudgetResetAt) + 1000;
  const restarted = new ResearchStore(pool); Object.defineProperty(restarted, "now", { value: async () => nextDay });
  const renewed = await restarted.prepareRepair(identity), renewedNews = renewed.sources.find(s => s.sourceId === f.source.id)!;
  assert.equal(renewedNews.state, "WAITING", JSON.stringify(renewed)); assert.ok(renewedNews.reasons.includes("RESEARCH_MARKETAUX_BUDGET_RENEWED"));
  assert.equal(renewedNews.localBudget?.requestsUsed, 0); assert.equal(renewedNews.localBudget?.failureRecordedAt, original.snapshot.createdAt);
  assert.deepEqual(await immutableRows(pool), before);
}));

test("database refuses inconsistent reservation budget day and invalid deadline before recovery can inspect them", { skip: !connection }, () => isolated("none", async ({ f, pool, start }) => {
  for (const mode of ["day", "deadline"] as const) await assert.rejects(pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
    VALUES($1,'DU_TEST',$2,'source',$3,$4,$5,1,$6,$7,$8)`, [`invalid-${mode}`, f.source.provider, f.configHash, f.manifestHash, "a".repeat(64), new Date(start), new Date(start + (mode === "deadline" ? 10001 : 1000)), new Date(start + (mode === "day" ? 86400000 : 0)).toISOString().slice(0, 10)]), /check constraint/);
}));
