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

for (const profile of ['pko_mild_v1','pko_moderate_v1']) test(`named momentum profile ${profile} requires exact opt-in and affects only PKO`,()=>{
  assert.throws(()=>buildConfiguredInstrumentRegistry({GPW_MOMENTUM_PROFILE:profile}));
  assert.throws(()=>buildConfiguredInstrumentRegistry({GPW_MOMENTUM_PROFILE:profile,GPW_PROFILE_ENABLED:'true',IBKR_ENVIRONMENT:'live'}));
  const r=buildConfiguredInstrumentRegistry({GPW_MOMENTUM_PROFILE:profile,GPW_PROFILE_ENABLED:'true',IBKR_ENVIRONMENT:'paper'});
  assert.equal(r.getInstrumentOrThrow('pko_wse').executionPolicy?.momentumBreakoutProfile,profile);
  for(const i of r.listAll().filter(i=>i.id!=='pko_wse'))assert.deepEqual(i,defaultInstrumentRegistry.getInstrumentOrThrow(i.id));
});
test('invalid momentum profile fails startup',()=>assert.throws(()=>buildConfiguredInstrumentRegistry({GPW_PROFILE_ENABLED:'true',GPW_MOMENTUM_PROFILE:'unknown'})));

test('AAPL is explicit paper-only, mutually exclusive and default strategy only', () => {
  const r = buildConfiguredInstrumentRegistry({ AAPL_PROFILE_ENABLED: 'true', IBKR_ENVIRONMENT: 'paper' });
  assert.deepEqual(r.listExecutionEnabled().map(i => i.id), ['aapl_nasdaq']);
  const i = r.getInstrumentOrThrow('aapl_nasdaq');
  assert.equal(i.conId, 265598); assert.equal(i.executionPolicy?.quantity, 1);
  assert.equal(i.executionPolicy?.momentumBreakoutProfile, 'default');
  assert.equal(i.executionPolicy?.outsideRth, false);
  assert.equal(defaultInstrumentRegistry.getInstrumentOrThrow(i.id).trading.executionEnabled, false);
  for (const env of [{ AAPL_PROFILE_ENABLED: 'TRUE' }, { AAPL_PROFILE_ENABLED: 'true', IBKR_ENVIRONMENT: 'live' },
    { AAPL_PROFILE_ENABLED: 'true', GPW_PROFILE_ENABLED: 'true' },
    { AAPL_PROFILE_ENABLED: 'true', GPW_MOMENTUM_PROFILE: 'pko_mild_v1' }]) assert.throws(() => buildConfiguredInstrumentRegistry(env));
});
