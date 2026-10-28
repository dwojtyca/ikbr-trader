import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountingSourceRuntime } from './source-runtime.js';
import type { AccountingSourceService } from './source-service.js';
import type { SourceSettingsV1 } from './types.js';
const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: 'TEST',
  endpoint: { host: '127.0.0.1', port: 4002 }, sourceClientId: 0, executionTimeZone: 'UTC' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const sessions: string[] = [], losses: Array<() => void> = [], services: Array<{ starts: number; closes: number; held: boolean; init: () => Promise<void>; inspection: () => Promise<unknown> }> = [];
  const runtime = new AccountingSourceRuntime(settings, 'a'.repeat(64), (session, onLost) => {
    sessions.push(session); losses.push(onLost);
    const control = { starts: 0, closes: 0, held: false, init: async () => { control.held = true; }, inspection: async (): Promise<unknown> => ({ id: session }) };
    services.push(control);
    return { initialize: () => control.init(), start: () => { control.starts++; }, close: async () => { control.closes++; control.held = false; },
      assertRuntimeOwnerCurrent: () => { if (!control.held) throw Error('ACCOUNTING_SOURCE_OWNER_LOST'); },
      assertRuntimeOwnerInTransaction: async () => { if (!control.held) throw Error('ACCOUNTING_SOURCE_OWNER_LOST'); },
      inspect: () => control.inspection(), status: () => ({ hold: null }) } as unknown as AccountingSourceService;
  });
  return { runtime, sessions, losses, services };
}
test('initialization failures preserve diagnostic service and retry unresolved acquisition identity', async () => {
  let tries = 0; const ids: string[] = [];
  const runtime = new AccountingSourceRuntime(settings, 'a'.repeat(64), id => {
    ids.push(id); const attempt = ++tries;
    return { initialize: async () => { if (attempt === 1) throw Object.assign(Error('database disconnected'), { code: '08006' }); }, start: () => {}, close: async () => {},
      assertRuntimeOwnerCurrent: () => { if (attempt === 1) throw Error('unknown owner'); }, status: () => ({ hold: null }) } as unknown as AccountingSourceService;
  });
  await runtime.initialize(); assert.equal(runtime.status().runtime.state, 'BACKOFF');
  assert.equal(runtime.status().runtime.originalCause?.code, '08006');
  assert.throws(() => runtime.captureRuntimeOwner(), /SOURCE_UNINITIALIZED/);
  await runtime.tick(); assert.equal(ids[0], ids[1]); runtime.assertRuntimeOwnerCurrent(); await runtime.close();
});
test('loss immediately invalidates captured guards and successor gets distinct source session', async () => {
  const f = fixture(); await f.runtime.initialize(); const guard = f.runtime.captureRuntimeOwner(); guard.assertCurrent();
  f.losses[0](); assert.throws(guard.assertCurrent, /SOURCE_OWNER_LOST/);
  await f.runtime.tick(); assert.notEqual(f.sessions[0], f.sessions[1]); f.runtime.captureRuntimeOwner().assertCurrent();
  f.losses[0](); f.runtime.assertRuntimeOwnerCurrent(); assert.throws(guard.assertCurrent, /SOURCE_OWNER_LOST/); await f.runtime.close();
});
test('late predecessor result cannot escape through the stable facade', async () => {
  const f = fixture(); await f.runtime.initialize(); const response = deferred<unknown>(); f.services[0].inspection = () => response.promise;
  const inspection = f.runtime.inspect(); const rejected = assert.rejects(inspection, /SOURCE_OWNER_LOST/);
  f.losses[0](); await f.runtime.tick(); response.resolve({ id: 'old-capture' }); await rejected; await f.runtime.close();
});
test('concurrent recovery calls share one attempt and shutdown fences late initialization', async () => {
  const blocked = deferred<void>(); let starts = 0, calls = 0;
  const runtime = new AccountingSourceRuntime(settings, 'a'.repeat(64), () => {
    calls++; return { initialize: () => blocked.promise, start: () => { starts++; }, close: async () => {}, assertRuntimeOwnerCurrent: () => {} } as unknown as AccountingSourceService;
  });
  const one = runtime.initialize(); assert.equal(runtime.tick(), one); const closing = runtime.close(); blocked.resolve(); await Promise.all([one, closing]);
  assert.equal(starts, 0); assert.equal(calls, 1); await runtime.tick(); assert.equal(calls, 1); assert.equal(runtime.status().runtime.state, 'STOPPING');
});
test('legacy execution persistence continues while source is unavailable', async () => {
  const f = fixture(); let persisted = 0;
  f.runtime.observeExecution({} as never, async () => { persisted++; });
  f.runtime.observeCommission({} as never, async () => { persisted++; });
  await Promise.resolve(); assert.equal(persisted, 2); await f.runtime.close();
});

test('factory failure remains retryable instead of rejecting background tick', async () => {
  let calls = 0;
  const runtime = new AccountingSourceRuntime(settings, 'a'.repeat(64), () => { calls++; throw Error('fixture factory unavailable'); });
  await runtime.initialize(); assert.equal(runtime.status().runtime.state, 'BACKOFF');
  await runtime.tick(); assert.equal(calls, 2); assert.equal(runtime.status().runtime.originalCause?.message, 'fixture factory unavailable'); await runtime.close();
});
test('unresolved teardown is bounded and cannot prevent a new fenced generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const runtime = new AccountingSourceRuntime(settings, 'a'.repeat(64), () => {
    const call = ++calls;
    return { initialize: async () => { if (call === 1) throw Error('fixture startup failure'); }, close: () => new Promise<void>(() => {}), start: () => {},
      assertRuntimeOwnerCurrent: () => { if (call === 1) throw Error('owner unavailable'); }, status: () => ({ hold: null }) } as unknown as AccountingSourceService;
  });
  const first=runtime.initialize(); await new Promise<void>(resolve=>setImmediate(resolve)); t.mock.timers.tick(2000); await first;
  await runtime.tick(); assert.equal(calls,2); runtime.assertRuntimeOwnerCurrent();
  const stopped=runtime.close(); await new Promise<void>(resolve=>setImmediate(resolve)); t.mock.timers.tick(2000); await stopped;
});

test('only a definitively inactive acquisition rotates the unresolved retry identity', async () => {
  for (const reason of ['ACCOUNTING_SOURCE_OWNER_ACQUISITION_RESOLVED_INACTIVE', 'ACCOUNTING_SOURCE_OWNER_LOST']) {
    const ids: string[] = [];
    const runtime = new AccountingSourceRuntime(settings, 'a'.repeat(64), id => {
      ids.push(id); const attempt = ids.length;
      return { initialize: async () => { if (attempt === 1) throw Error('unknown COMMIT acknowledgement'); if (attempt === 2) throw Error(reason); },
        close: async () => {}, start: () => {}, status: () => ({ hold: null }),
        assertRuntimeOwnerCurrent: () => { if (attempt < 3) throw Error('owner unresolved'); } } as unknown as AccountingSourceService;
    });
    await runtime.initialize(); await runtime.tick(); await runtime.tick();
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[1] === ids[2], reason !== 'ACCOUNTING_SOURCE_OWNER_ACQUISITION_RESOLVED_INACTIVE');
    runtime.assertRuntimeOwnerCurrent(); await runtime.close();
  }
});
