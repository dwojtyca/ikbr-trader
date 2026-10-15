import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { seedTwoSourceResearchStore } from "@ikbr/shared/instrument-research-testfixture";
import { ResearchBoundReviewRepository } from "./research-review-repository.js";
import { reviewFixture } from "./research-review.testfixture.js";

const connection = process.env.TEST_POSTGRES_URL;

test("AI preparation and hourly publication lock ledger before head and bind the new committed snapshot", { skip: !connection }, async () => {
  const url = new URL(connection!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) &&
    (url.port === "55432" || process.env.CI === "true" && url.port === "5432" && url.pathname === "/ikbr_trader_ci"));
  url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.href }), name = `research_ai_publish_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.href, options: "-c search_path=public,pg_catalog" });
  let releasePublisher!: () => void, signalPublisherAtHead!: () => void;
  const publisherAtHead = new Promise<void>(resolve => { signalPublisherAtHead = resolve; });
  const preliminaryRead = new Promise<void>(resolve => { releasePublisher = resolve; });
  let interleave = false, preliminarySnapshotId: string | undefined;
  const proxy = {
    query: (sql: string, args?: unknown[]) => pool.query(sql, args),
    connect: async () => {
      const raw = await pool.connect();
      let publisher = false;
      return {
        release: (destroy?: boolean) => raw.release(destroy),
        query: async (sql: string, args?: unknown[]) => {
          if (interleave && sql.startsWith("INSERT INTO research_snapshot_heads")) {
            publisher = true;
            signalPublisherAtHead();
            await preliminaryRead;
          }
          const result = await raw.query(sql, args);
          if (interleave && !publisher && preliminarySnapshotId === undefined && sql === "SELECT * FROM research_snapshots WHERE id=$1") {
            preliminarySnapshotId = result.rows[0]?.id;
            releasePublisher();
          }
          return result;
        },
      };
    },
  };
  try {
    await pool.query("CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)");
    await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
    const dir = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) await pool.query(readFileSync(new URL(file, dir), "utf8"));
    const f = await seedTwoSourceResearchStore(proxy);
    const original = (await f.store.latestSnapshot(f.identity))!;
    await pool.query("UPDATE fixture_clock SET offset_ms=3601000");
    await f.observe();
    const c = reviewFixture(await f.clock()).claim;
    await pool.query(`INSERT INTO proposed_orders(id,instrument,instrument_id,conid,side,position_effect,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,
      client_order_id,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger) VALUES(1,$1,$2,$3,'BUY','OPEN_OR_ADD','LMT',1,100,99,105,'fixture',.8,'PASS','PROPOSED',$4,
      'fixture',$5,2,$6,$7)`, [c.order.instrument,c.identity.instrumentId,c.identity.conid,c.order.strategy,c.identity.clientOrderHash,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger)]);
    await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger)
      VALUES(1,$1,$2,$3,'DU_TEST','session',2,$4,$5)`, [c.identity.clientOrderHash,c.identity.instrumentId,c.identity.conid,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger)]);
    const repo = new ResearchBoundReviewRepository(proxy as unknown as Pool, { manifest: f.manifest, hash: f.manifestHash });
    const claim = (await repo.claim())!; assert.ok(claim);
    interleave = true;
    const publication = f.publishNews();
    // The real terminal transaction already owns the ledger's ROW EXCLUSIVE lock.
    await Promise.race([publisherAtHead, publication.then(() => { throw new Error("publication missed interleaving gate"); })]);
    const [published, bound] = await Promise.all([publication, repo.prepareResearch(claim)]);
    interleave = false;
    assert.equal(preliminarySnapshotId, original.id);
    assert.notEqual(published.id, original.id);
    assert.equal(bound.binding.snapshotId, published.id);
    assert.equal(bound.binding.snapshotHash, published.hash);
    assert.equal(bound.binding.sequence, published.sequence);
    assert.equal(bound.eligibility.eligible, true);
    assert.equal((await f.store.latestSnapshot(f.identity))!.id, published.id);
    assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE state='FINALIZING'")).rows[0].n, 0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM proposal_ai_model_calls")).rows[0].n, 0);
  } finally {
    releasePublisher();
    await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end();
  }
});
