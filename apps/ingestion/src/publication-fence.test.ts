import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PublicationFence } from './publication-fence.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('an admitted old Redis write drains before a successor can publish', async () => {
  const fence = new PublicationFence(() => true), entered = deferred(), release = deferred();
  const writes: string[] = [];
  const old = fence.run(async current => {
    entered.resolve(); await release.promise; writes.push('old-admitted-write');
    if (current()) writes.push('old-followup');
  });
  await entered.promise; fence.invalidate();
  const newer = fence.run(async () => { writes.push('new'); });
  let drained = false; const draining = fence.idle().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false); assert.deepEqual(writes, []);
  release.resolve(); await Promise.all([old, newer, draining]);
  assert.deepEqual(writes, ['old-admitted-write', 'new']); assert.equal(drained, true);
});

test('queued work captured before invalidation never reaches storage', async () => {
  const fence = new PublicationFence(() => true), entered = deferred(), release = deferred();
  let staleWrites = 0, newWrites = 0;
  const running = fence.run(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const queued = fence.run(async () => { staleWrites++; }); fence.invalidate();
  const successor = fence.run(async () => { newWrites++; });
  release.resolve(); await Promise.all([running, queued, successor]);
  assert.equal(staleWrites, 0); assert.equal(newWrites, 1);
});

test('failed storage remains observable to caller without poisoning subsequent queue', async () => {
  const fence = new PublicationFence(() => true); let writes = 0;
  await assert.rejects(fence.run(async () => { throw new Error('redis_unavailable'); }), /redis_unavailable/);
  await fence.run(async () => { writes++; }); await fence.idle(); assert.equal(writes, 1);
});

test('a scheduling interruption during an await prevents subsequent persistence', async () => {
  let uninterrupted = true, writes = 0;
  const fence = new PublicationFence(() => uninterrupted), entered = deferred(), release = deferred();
  const running = fence.run(async current => {
    entered.resolve(); await release.promise;
    if (current()) writes++;
  });
  await entered.promise; uninterrupted = false; release.resolve(); await running;
  await fence.run(async () => { writes++; }); assert.equal(writes, 0);
});

test('continuity check that revokes generation cannot admit buffered work', async () => {
  let revoke = true, writes = 0;
  const fence: PublicationFence = new PublicationFence(() => {
    if (revoke) { revoke = false; fence.invalidate(); }
    return true;
  });
  await fence.run(async () => { writes++; }); assert.equal(writes, 0);
  await fence.run(async () => { writes++; }); assert.equal(writes, 1);
});
