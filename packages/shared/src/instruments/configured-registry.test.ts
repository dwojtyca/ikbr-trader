import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfiguredInstrumentRegistry } from './configured-registry.js';
import { defaultInstrumentRegistry } from './definitions.js';
test('GPW configuration opts in only PKO and never mutates default seeds', () => {
  assert.equal(buildConfiguredInstrumentRegistry({}), defaultInstrumentRegistry);
  const registry = buildConfiguredInstrumentRegistry({GPW_PROFILE_ENABLED:'true',IBKR_ENVIRONMENT:'paper'});
  assert.deepEqual(registry.listExecutionEnabled().map(i=>i.id),['pko_wse']);
  assert.equal(registry.getInstrument('pko_wse')!.executionPolicy!.quantity,1);
  assert.equal(defaultInstrumentRegistry.getInstrument('pko_wse')!.trading.executionEnabled,false);
  assert.throws(()=>buildConfiguredInstrumentRegistry({GPW_PROFILE_ENABLED:'TRUE'}));
  assert.throws(()=>buildConfiguredInstrumentRegistry({GPW_PROFILE_ENABLED:'true',IBKR_ENVIRONMENT:'live'}));
});
