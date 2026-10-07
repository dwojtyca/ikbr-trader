import { test } from "node:test";
import assert from "node:assert/strict";
import { marketauxFixture } from "./research-marketaux.testfixture.js";
import { marketauxRecordSetHash, parseMarketauxPage } from "./research-marketaux.js";
import { researchHash } from "@ikbr/shared/instrument-research";

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

test("V1 keeps its legacy output and record-set hash projection when provider enrichment appears", () => {
  const f = marketauxFixture();
  const article = { ...f.article(1), description: "new description", snippet: "new snippet", sentiment_score: 0.7 };
  const parsed = parseMarketauxPage({ meta: { found: 1, returned: 1, limit: 2, page: 1 }, data: [article] }, f.newsConfig, f.descriptor);
  assert.deepEqual(parsed.records[0], {
    uuid: article.uuid, title: article.title, url: article.url,
    publishedAt: new Date(Date.parse(article.published_at)).toISOString(), originalPublishedAt: article.published_at,
    entity: { ...f.newsConfig.entity }, inWindow: true,
  });
  const { uuid, title, url, originalPublishedAt, entity } = parsed.records[0];
  assert.equal(marketauxRecordSetHash(parsed.records), researchHash([{ uuid, title, url, originalPublishedAt, entity }]));
});

test("V2 preserves bounded text and only sentiment from the exact matched entity, and hashes enrichment", () => {
  const f = marketauxFixture();
  const article = { ...f.article(1), description: "description\nline", snippet: "snippet\tvalue", entities: [
    { symbol: "OTHER", name: "Other Issuer", type: "equity", country: "us", exchange: null, sentiment_score: 1 },
    { ...f.newsConfig.entity, sentiment_score: -0.25 },
  ] };
  const parse = (item: unknown) => parseMarketauxPage({ meta: { found: 1, returned: 1, limit: 2, page: 1 }, data: [item] }, f.newsConfig, f.descriptor, 2);
  const parsed = parse(article);
  assert.deepEqual(parsed.records[0].enrichment, {
    description: article.description, snippet: article.snippet, providerSentiment: { status: "PROVIDED", score: -0.25 },
  });
  assert.notEqual(marketauxRecordSetHash(parsed.records), marketauxRecordSetHash(parse({ ...article, description: "updated" }).records));
  assert.notEqual(marketauxRecordSetHash(parsed.records), marketauxRecordSetHash(parse({ ...article, snippet: "updated" }).records));
  assert.notEqual(marketauxRecordSetHash(parsed.records), marketauxRecordSetHash(parse({ ...article, entities: [{ ...f.newsConfig.entity, sentiment_score: 0.25 }] }).records));
});

test("V2 represents missing enrichment explicitly and distinguishes absent sentiment from zero", () => {
  const f = marketauxFixture();
  const parse = (item: unknown) => parseMarketauxPage({ meta: { found: 1, returned: 1, limit: 2, page: 1 }, data: [item] }, f.newsConfig, f.descriptor, 2).records[0];
  const absent = parse(f.article(1));
  const zero = parse({ ...f.article(1), entities: [{ ...f.newsConfig.entity, sentiment_score: 0 }] });
  assert.deepEqual(absent.enrichment, { description: null, snippet: null, providerSentiment: { status: "NOT_PROVIDED" } });
  assert.deepEqual(zero.enrichment, { description: null, snippet: null, providerSentiment: { status: "PROVIDED", score: 0 } });
  assert.notEqual(marketauxRecordSetHash([absent]), marketauxRecordSetHash([zero]));
  const wrongEntityOnly = parse({ ...f.article(1), entities: [{ symbol: "OTHER", name: "Other", type: "equity", country: "us", exchange: null, sentiment_score: 0.8 }, { ...f.newsConfig.entity }] });
  assert.deepEqual(wrongEntityOnly.enrichment?.providerSentiment, { status: "NOT_PROVIDED" });
});

test("V2 rejects invalid enrichment types, control characters, oversized text, and sentiment", () => {
  const f = marketauxFixture();
  const parse = (item: unknown) => parseMarketauxPage({ meta: { found: 1, returned: 1, limit: 2, page: 1 }, data: [item] }, f.newsConfig, f.descriptor, 2);
  for (const item of [
    { ...f.article(1), description: 4 },
    { ...f.article(1), snippet: "bad\u0000text" },
    { ...f.article(1), description: "x".repeat(8001) },
    { ...f.article(1), entities: [{ ...f.newsConfig.entity, sentiment_score: 1.01 }] },
    { ...f.article(1), entities: [{ ...f.newsConfig.entity, sentiment_score: "0.5" }] },
    { ...f.article(1), entities: [{ ...f.newsConfig.entity, sentiment_score: Number.NaN }] },
  ]) assert.throws(() => parse(item), /RESEARCH_MARKETAUX_PAYLOAD_INVALID/);
});
