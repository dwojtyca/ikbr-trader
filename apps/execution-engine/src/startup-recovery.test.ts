import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { runMigrations } from "./migrations.js";
import { drainShutdown, initializeWithDatabaseRetry, isDatabaseUnavailable } from "./startup-recovery.js";

test("database startup retries sequentially with bounded backoff and no broker work before success", async () => {
  let attempts = 0, active = 0, brokerStarts = 0;
  const waits: number[] = [];
  await initializeWithDatabaseRetry(async () => {
    assert.equal(++active, 1);
    try { if (++attempts <= 7) throw Object.assign(new Error("unavailable"), { code: "ECONNREFUSED" }); }
    finally { active--; }
  }, { signal: new AbortController().signal, onRetry: () => assert.equal(brokerStarts, 0),
    wait: async ms => { waits.push(ms); } });
  brokerStarts++;
  assert.deepEqual(waits, [1000, 2000, 5000, 10000, 30000, 30000, 30000]);
  assert.equal(attempts, 8);
  assert.equal(brokerStarts, 1);
});

test("schema integrity failure never retries migration and stopping prevents late startup", async () => {
  let attempts = 0;
  const controller = new AbortController();
  await assert.rejects(initializeWithDatabaseRetry(async () => { attempts++; throw new Error("migration checksum mismatch"); },
    { signal: controller.signal, onRetry: () => assert.fail("must not retry") }), /checksum/);
  assert.equal(attempts, 1);
  await assert.rejects(initializeWithDatabaseRetry(async () => { controller.abort(); },
    { signal: controller.signal, onRetry: () => assert.fail("must not retry") }), /abort/i);
});

test("shutdown DB outage and stuck worker still close HTTP and both pools with failure result", async () => {
  const closed: string[] = [], failures: string[] = [];
  const healthy = await drainShutdown([
    { name: "source", close: async () => { throw new Error("database unavailable"); } },
    { name: "worker", close: () => new Promise<void>(() => {}) },
    ...["http", "diagnostic-pool", "operational-pool"].map(name => ({ name, close: () => { closed.push(name); } })),
  ], name => failures.push(name), 5);
  assert.equal(healthy, false);
  assert.deepEqual(failures, ["source", "worker"]);
  assert.deepEqual(closed, ["http", "diagnostic-pool", "operational-pool"]);
});

test("actual migration failure retains the database cause and retries, but SQL integrity failures do not", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-recovery-'));
  const sql = 'SELECT fixture_migration'; writeFileSync(join(dir, '000001_fixture.sql'), sql);
  try {
    for (const code of ['08006', '42601']) {
      const cause = Object.assign(new Error('fixture failure'), { code });
      let attempts = 0, rollbacks = 0, commits = 0; const retries: unknown[] = [];
      const pool = { connect: async () => ({ query: async (text: string) => {
        if (text === sql && ++attempts === 1) throw cause;
        if (text === 'ROLLBACK') rollbacks++;
        if (text === 'COMMIT') commits++;
        return { rows: [] };
      }, release: () => {} }) } as unknown as Pool;
      const started = initializeWithDatabaseRetry(async () => { await runMigrations(pool, { migrationsDir: dir }); }, {
        signal: new AbortController().signal, onRetry: error => { retries.push(error); }, wait: async ms => { assert.equal(ms, 1000); },
      });
      if (code === '08006') {
        await started; assert.equal(attempts, 2); assert.equal(commits, 1);
        assert.equal((retries[0] as Error).cause, cause);
      } else {
        await assert.rejects(started, error => error instanceof Error && error.cause === cause);
        assert.equal(attempts, 1); assert.equal(commits, 0); assert.equal(retries.length, 0);
      }
      assert.equal(rollbacks, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("database cause classification is bounded and cannot override an integrity SQLSTATE", () => {
  const transient = Object.assign(new Error('unavailable'), { code: '08006' });
  assert.equal(isDatabaseUnavailable(new Error('wrapper', { cause: transient })), true);
  assert.equal(isDatabaseUnavailable(Object.assign(new Error('syntax', { cause: transient }), { code: '42601' })), false);
  const cycle = new Error('cycle'); cycle.cause = cycle; assert.equal(isDatabaseUnavailable(cycle), false);
  let deep: Error = transient; for (let i = 0; i < 9; i++) deep = new Error('wrapper', { cause: deep });
  assert.equal(isDatabaseUnavailable(deep), false);
});
