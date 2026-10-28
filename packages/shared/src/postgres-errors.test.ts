import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { assertPostgresClientUsable, observePostgresPoolErrors } from './postgres-errors.js';

test('checked-out errors remain observed, preserve owner listeners and permanently reject failed clients', () => {
  const pool = new EventEmitter(), client = new EventEmitter(), seen: Error[] = [];
  let lost = 0;
  observePostgresPoolErrors(pool, error => seen.push(error));
  observePostgresPoolErrors(pool, () => assert.fail('duplicate observer'));
  pool.emit('connect', client);
  client.on('error', () => { lost++; });
  const original = Object.assign(Error('connection lost'), { code: '08006' });
  assertPostgresClientUsable(client);
  client.emit('error', original); pool.emit('error', original);
  assert.equal(lost, 1); assert.deepEqual(seen, [original]);
  assert.throws(() => assertPostgresClientUsable(client), error => error === original);
  client.emit('error', Error('later failure'));
  assert.throws(() => assertPostgresClientUsable(client), error => error === original);
  const next = new EventEmitter(); pool.emit('connect', next); assertPostgresClientUsable(next);
});
