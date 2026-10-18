import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AccountingSourceOwner, canonicalAccountingEndpoint } from "./source-owner.js";
import type { SourceSettingsV1 } from "./types.js";

const url = process.env.TEST_POSTGRES_URL;
const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", environment: "paper", accountId: "TEST-OWNER",
  endpoint: { host: "127.0.0.1", port: 45678 }, sourceClientId: 0, executionTimeZone: "Europe/Warsaw" };
test("canonical ownership key unifies DNS aliases and loopback transports", async () => {
  const key = await canonicalAccountingEndpoint(settings.endpoint);
  for (const host of ["localhost", "LOCALHOST.", "::1", "[::1]", "::ffff:127.0.0.1"]) assert.equal(await canonicalAccountingEndpoint({ host, port: settings.endpoint.port }), key);
  assert.notEqual(await canonicalAccountingEndpoint({ ...settings.endpoint, port: 45679 }), key);
});
test("session ownership excludes other accounts and durable retirement prevents unsafe crash takeover", { skip: !url }, async () => {
  const schema = `owner_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
  const owners: AccountingSourceOwner[] = [];
  const create = (accountId = "TEST-OWNER", onLost?: () => void) => {
    const owner = new AccountingSourceOwner(pool, { ...settings, accountId }, onLost); owners.push(owner); return owner;
  };
  try {
    await pool.query(`CREATE TABLE accounting_source_owners(endpoint_key text PRIMARY KEY,owner_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),
      retirement_state text NOT NULL CHECK(retirement_state IN ('ACTIVE','RETIRED','UNKNOWN')),acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      retired_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const first = create(); await first.acquire(); const firstFence = first.fence();
    await assert.rejects(create("OTHER-ACCOUNT").acquire(), /SOURCE_OWNER_CONFLICT/);
    await new Promise(resolve => setTimeout(resolve, 600));
    await first.verifyCurrent();
    await first.retire(true);
    first.assertHeld(); assert.throws(() => first.assertCurrent(), /SOURCE_OWNER_LOST/);
    const persistence = await pool.connect();
    try {
      await persistence.query('BEGIN'); await first.assertInTransaction(persistence); await persistence.query('COMMIT');
    } finally { persistence.release(); }
    await new Promise(resolve => setTimeout(resolve, 2200)); first.assertHeld();
    assert.throws(() => first.assertCurrent(), /SOURCE_OWNER_LOST/);
    await first.activate(); assert.deepEqual(first.fence(), firstFence);
    await first.retire(true); await first.release();
    let lost = 0;
    const second = create("TEST-OWNER", () => { lost++; }); await second.acquire(); assert.equal(second.fence().generation, firstFence.generation + 1);
    const key = BigInt(`0x${createHash("sha256").update(second.fence().endpointKey).digest("hex").slice(0, 16)}`);
    const killed = await pool.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype='advisory'
      AND classid=$1::oid AND objid=$2::oid AND objsubid=1`, [(key >> 32n).toString(), (key & 0xffffffffn).toString()]);
    assert.equal(killed.rows[0]?.terminated, true);
    for (let i = 0; i < 100 && !lost; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(lost, 1); assert.throws(() => second.assertCurrent(), /SOURCE_OWNER_LOST/); assert.throws(() => second.assertHeld(), /SOURCE_OWNER_LOST/);
    await assert.rejects(create().acquire(), /SOURCE_OWNER_UNRETIRED/);
    await second.retire(true); await second.release();
    const third = create(); await third.acquire();
    await assert.rejects(third.retire(false), /SOURCE_RETIREMENT_UNKNOWN/);
    assert.throws(() => third.assertCurrent(), /SOURCE_OWNER_LOST/); assert.throws(() => third.assertHeld(), /SOURCE_OWNER_LOST/); await third.release();
    await assert.rejects(create().acquire(), /SOURCE_OWNER_UNRETIRED/);
    // Only the acknowledged owner can persist proof that its socket has ended.
    await assert.rejects(second.retire(true), /SOURCE_OWNER_LOST/);
  } finally {
    for (const owner of owners) await owner.release();
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
