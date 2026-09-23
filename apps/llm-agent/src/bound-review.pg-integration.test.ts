import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { BoundReviewRepository, type BoundDecision } from "./bound-review-repository.js";
import { LlmAgentRepository } from "./repository.js";

const connection = process.env.TEST_POSTGRES_URL;
const decision: BoundDecision = { decision: "EXECUTE", reason: "supported", confidence: 0.8,
  model: "fake", promptVersion: "test", context: { news: [], retrievedAt: "2026-09-23T12:00:00Z" } };

describe("bound AI repository on real PostgreSQL", { skip: !connection }, () => {
  let admin: Pool;
  let pool: Pool;
  let repo: BoundReviewRepository;
  const database = `ikbr_ai_${randomUUID().replaceAll('-', '')}`;
  before(async () => {
    const url = new URL(connection!);
    url.pathname = "/postgres";
    admin = new Pool({ connectionString: url.toString() });
    await admin.query(`CREATE DATABASE ${database}`);
    url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    const migrations = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
      await pool.query(readFileSync(new URL(file, migrations), "utf8"));
    }
    repo = new BoundReviewRepository(pool);
  });
  after(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
  });
  beforeEach(async () => { await pool.query("TRUNCATE proposed_orders CASCADE"); });

  async function seed(expires = "clock_timestamp() + interval '120 seconds'") {
    const order = await pool.query(`INSERT INTO proposed_orders
      (instrument, instrument_id, conid, client_order_hash, side, order_type, quantity, entry, stop,
       take_profit, reason, confidence, risk_check_status, strategy)
      VALUES ('MSFT','msft','42','hash','BUY','LMT',1,100,99,102,'test',0.8,'PASS','test') RETURNING id`);
    const id = Number(order.rows[0].id);
    await pool.query(`INSERT INTO proposal_ai_reviews
      (proposed_order_id, client_order_hash, instrument_id, conid, account_id, session_id, expires_at)
      VALUES ($1,'hash','msft','42','DU1','session',${expires})`, [id]);
    return id;
  }

  it("competing claims have one owner; approval and delivery survive restart and are immutable", async () => {
    const id = await seed();
    const claims = await Promise.all([repo.claim(), repo.claim()]);
    const claim = claims.find(Boolean)!;
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claim.order.id, id);
    assert.equal(await repo.finalize(claim, decision), true);
    assert.equal(await repo.finalize(claim, { ...decision, decision: "REJECT" }), false);
    assert.equal(await new BoundReviewRepository(pool).claim(), null);
    await repo.recordDelivery(claim, "UNKNOWN");
    await repo.recordDelivery(claim, "SUBMITTED");
    const stored = (await pool.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id])).rows[0];
    assert.deepEqual(stored.decision_json, decision);
    assert.ok(stored.delivery_started_at);
    assert.equal(stored.delivery_outcome, "UNKNOWN");
    await assert.rejects(pool.query("UPDATE proposal_ai_reviews SET decision_json='{}' WHERE proposed_order_id=$1", [id]), /immutable/);
  });

  it("expired lease is reclaimed and stale worker cannot finalize", async () => {
    const id = await seed();
    const old = (await repo.claim())!;
    await pool.query("UPDATE proposal_ai_reviews SET claim_until=clock_timestamp()-interval '1 second' WHERE proposed_order_id=$1", [id]);
    const current = (await repo.claim())!;
    assert.notEqual(current.token, old.token);
    assert.equal(await repo.finalize(old, decision), false);
    assert.equal(await repo.finalize(current, decision), true);
  });

  it("expired pending row releases reservation without decision or delivery", async () => {
    const id = await seed("clock_timestamp()-interval '1 second'");
    assert.equal(await repo.claim(), null);
    const rows = await pool.query(`SELECT po.status, r.status AS review_status, r.decision_json
      FROM proposed_orders po JOIN proposal_ai_reviews r ON r.proposed_order_id=po.id WHERE po.id=$1`, [id]);
    assert.deepEqual(rows.rows[0], { status: "EXPIRED", review_status: "EXPIRED", decision_json: null });
  });

  it("expiry while awaiting AI fences finalization", async () => {
    await seed("clock_timestamp()+interval '200 milliseconds'");
    const claim = (await repo.claim())!;
    await pool.query("SELECT pg_sleep(0.25)");
    assert.equal(await repo.finalize(claim, decision), false);
    assert.equal(await repo.claim(), null);
  });

  it("unattempted approved expiry preserves decision and accepts late uncertain delivery audit", async () => {
    const id = await seed("clock_timestamp()+interval '200 milliseconds'");
    const claim = (await repo.claim())!;
    assert.equal(await repo.finalize(claim, decision), true);
    await pool.query("SELECT pg_sleep(0.25)");
    assert.equal(await repo.claim(), null);
    await repo.recordDelivery(claim, "UNKNOWN");
    const stored = (await pool.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id])).rows[0];
    assert.equal(stored.status, "EXPIRED");
    assert.deepEqual(stored.decision_json, decision);
    assert.ok(stored.delivery_started_at);
    assert.equal(stored.delivery_outcome, "UNKNOWN");
    assert.equal((await pool.query("SELECT status FROM proposed_orders WHERE id=$1", [id])).rows[0].status, "EXPIRED");
  });

  it("identity mismatch and submission marker prevent stale finalization", async () => {
    const id = await seed();
    const claim = (await repo.claim())!;
    assert.equal(await repo.finalize({ ...claim, identity: { ...claim.identity, accountId: "OTHER" } }, decision), false);
    await pool.query("UPDATE proposed_orders SET client_order_hash='changed' WHERE id=$1", [id]);
    assert.equal(await repo.finalize(claim, decision), false);
    await pool.query("UPDATE proposed_orders SET client_order_hash='hash', execution_attempted_at=clock_timestamp() WHERE id=$1", [id]);
    assert.equal(await repo.finalize(claim, { ...decision, decision: "REJECT" }), false);
    assert.equal((await pool.query("SELECT status FROM proposed_orders WHERE id=$1", [id])).rows[0].status, "PROPOSED");
  });

  it("reject atomically terminates proposal and legacy poll never claims bound rows", async () => {
    const id = await seed();
    assert.equal(await new LlmAgentRepository(pool).claimNextProposed("legacy", 30000), null);
    const claim = (await repo.claim())!;
    assert.equal(await repo.finalize(claim, { ...decision, decision: "REJECT" }), false);
    const stored = (await pool.query("SELECT status, delivery_started_at FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id])).rows[0];
    assert.equal(stored.status, "REJECTED");
    assert.equal(stored.delivery_started_at, null);
    assert.equal((await pool.query("SELECT status FROM proposed_orders WHERE id=$1", [id])).rows[0].status, "REJECTED");
  });
});
