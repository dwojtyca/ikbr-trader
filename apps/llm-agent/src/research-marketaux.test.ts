import { test } from "node:test";
import assert from "node:assert/strict";
import { marketauxFixture } from "./research-marketaux.testfixture.js";
import { marketauxRecordSetHash, parseMarketauxPage } from "./research-marketaux.js";

test("real provider envelope maps positive records and detects substituted or changed UUID contents", () => {
  const f = marketauxFixture();
  const page = (items: unknown[]) => parseMarketauxPage({ meta: { found: 2, returned: 2, limit: 2, page: 1 }, data: items }, f.newsConfig, f.descriptor);
  const a = page([f.article(1), f.article(2)]), b = page([f.article(2), f.article(1)]);
  assert.equal(marketauxRecordSetHash(a.records), marketauxRecordSetHash(b.records));
  assert.notEqual(marketauxRecordSetHash(a.records), marketauxRecordSetHash(page([f.article(1), f.article(3)]).records));
  assert.notEqual(marketauxRecordSetHash(a.records), marketauxRecordSetHash(page([f.article(1), { ...f.article(2), title: "changed" }]).records));
  assert.throws(() => marketauxRecordSetHash([...a.records, a.records[0]]), /DUPLICATE_UUID/);
});

test("publication margins preserve microseconds and exact closed window membership", () => {
  const f = marketauxFixture();
  const parse = (at: string) => parseMarketauxPage({ meta: { found: 1, returned: 1, limit: 2, page: 1 }, data: [f.article(1, at)] }, f.newsConfig, f.descriptor).records[0];
  assert.equal(parse(f.descriptor.asOf).inWindow, true);
  assert.equal(parse(f.descriptor.asOf.replace(".000Z", ".000001Z")).inWindow, false);
  assert.equal(parse(f.descriptor.windowStart).inWindow, true);
  assert.equal(parse(new Date(Date.parse(f.descriptor.windowStart) - 1).toISOString()).inWindow, false);
  assert.throws(() => parse(new Date(Date.parse(f.descriptor.asOf) + 1001).toISOString()), /OUTSIDE_QUERY/);
  for (const at of ["2026-02-30T00:00:00Z", "2026-10-07T25:00:00Z", "2026-10-07", "2026-10-07T00:00:00.1234567Z", "2026-10-07T00:00:00+01:00"]) assert.throws(() => parse(at), /PAYLOAD_INVALID/);
});

test("malformed, incomplete and ambiguous records fail whole page instead of disappearing", () => {
  const f = marketauxFixture();
  const base = { meta: { found: 1, returned: 1, limit: 2, page: 1 }, data: [f.article(1)] };
  const mutations: ((v: any) => void)[] = [v => v.error = {}, v => v.meta.found = 21, v => v.meta.returned = 0, v => v.meta.page = 2, v => v.meta.limit = 3,
    v => v.meta.found = 3, v => v.data[0].uuid = "not-uuid", v => v.data[0].title = "", v => v.data[0].url = "https://127.0.0.1/private",
    v => v.data[0].entities[0].symbol = "OTHER", v => v.data[0].entities[0].exchange = "UNKNOWN", v => v.data[0].entities.push(v.data[0].entities[0]),
    v => v.data[0].similar = [{}], v => v.data[0].published_at = null];
  for (const mutate of mutations) { const changed = structuredClone(base); mutate(changed); assert.throws(() => parseMarketauxPage(changed, f.newsConfig, f.descriptor), /RESEARCH_MARKETAUX/); }
  const duplicate = { meta: { found: 2, returned: 2, limit: 2, page: 1 }, data: [f.article(1), f.article(1)] };
  assert.throws(() => parseMarketauxPage(duplicate, f.newsConfig, f.descriptor), /DUPLICATE_UUID/);
});
