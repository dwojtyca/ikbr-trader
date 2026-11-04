import test from 'node:test';
import assert from 'node:assert/strict';
import { researchDemandSlotKey } from './source-demand.js';
import { researchRefreshSlotKey } from './repair.js';

test('demand publication identities separate attempts, sources and manifests from hourly publications', () => {
 const base = ['a'.repeat(64), 'aapl_smart', 'news', '00000000-0000-4000-8000-000000000001'] as const;
 const original = researchDemandSlotKey(...base);
 assert.equal(original, researchDemandSlotKey(...base));
 const variants = [
  researchDemandSlotKey(base[0], base[1], base[2], '00000000-0000-4000-8000-000000000002'),
  researchDemandSlotKey(base[0], base[1], 'calendar', base[3]),
  researchDemandSlotKey(base[0], 'pko_wse', base[2], base[3]),
  researchDemandSlotKey('b'.repeat(64), base[1], base[2], base[3]),
  researchRefreshSlotKey(base[0], base[1], base[2], 'news', 500000),
 ];
 assert.equal(new Set([original, ...variants]).size, 6);
});
