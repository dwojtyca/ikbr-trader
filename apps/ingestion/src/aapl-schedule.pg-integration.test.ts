import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { MarketRepository } from './db.js';
import { scheduleFixture } from './aapl-schedule-fixture.js';
const connection = process.env.TEST_POSTGRES_URL;
test('schedule PostgreSQL round trip fences older success/failure after invalidation and concurrent refresh', { skip: !connection }, async () => {
  const database = `aapl_schedule_${randomUUID().replaceAll('-', '')}`, url = new URL(connection!); url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`; const pool = new Pool({ connectionString: url.toString() });
  try {
    const repo = new MarketRepository(pool); await repo.init();
    assert.equal(await repo.getAaplSchedule(), null);
    const first = await repo.beginAaplSchedule('REFRESHING');
    assert.equal((await repo.getAaplSchedule())?.status, 'REFRESHING');
    const schedule = scheduleFixture().schedule!;
    assert.equal(await repo.finishAaplSchedule(first, schedule), true);
    assert.deepEqual((await repo.getAaplSchedule())?.schedule, schedule);
    assert.equal((await repo.getAaplSchedule())?.status, 'READY');
    const invalidated = await repo.beginAaplSchedule('FAILED');
    assert.ok(invalidated > first);
    assert.equal(await repo.finishAaplSchedule(first, schedule), false);
    assert.equal((await repo.getAaplSchedule())?.status, 'FAILED');
    const [a, b] = await Promise.all([repo.beginAaplSchedule('REFRESHING'), repo.beginAaplSchedule('REFRESHING')]);
    assert.notEqual(a, b);
    assert.equal(await repo.finishAaplSchedule(Math.min(a, b), schedule), false);
    assert.equal(await repo.finishAaplSchedule(Math.max(a, b), schedule), true);
    assert.equal(await repo.finishAaplSchedule(Math.min(a, b), null), false);
    assert.equal((await repo.getAaplSchedule())?.status, 'READY');
    const latest = await repo.beginAaplSchedule('REFRESHING');
    assert.equal(await repo.finishAaplSchedule(latest, null), true);
    const failed = await repo.getAaplSchedule();
    assert.equal(failed?.status, 'FAILED'); assert.deepEqual(failed?.schedule, schedule);
    await assert.rejects(pool.query("INSERT INTO aapl_schedule_state VALUES ('other', 1, 'READY', NULL, NOW())"));
  } finally {
    const disconnected = new Promise<void>(resolve => { let remaining = pool.totalCount;
      if (!remaining) return resolve(); pool.on('remove', () => { if (--remaining === 0) resolve(); }); });
    await pool.end(); await disconnected;
    try { await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }
});
