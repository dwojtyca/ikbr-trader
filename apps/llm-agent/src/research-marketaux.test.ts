import { test } from "node:test";
import assert from "node:assert/strict";
import { marketauxFixture } from "./research-marketaux.testfixture.js";
import { marketauxRecordSetHash, parseMarketauxPage } from "./research-marketaux.js";
import { captureResearchSourceError, researchHash, type MarketauxNewsConfig, type MarketauxRequest } from "@ikbr/shared/instrument-research";

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


test("local capacity diagnostics retain provider-reported count at the free-page boundary", () => {
  const f = marketauxFixture(), config = { ...f.newsConfig, pageSize: 3, maxPagesPerPass: 10, maxArticles: 30 };
  const envelope = (found: number) => ({ meta: { found, returned: 3, limit: 3, page: 1 }, data: [f.article(1), f.article(2), f.article(3)] });
  assert.equal(parseMarketauxPage(envelope(30), config, f.descriptor).found, 30);
  assert.throws(() => parseMarketauxPage(envelope(31), config, f.descriptor), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, "RESEARCH_MARKETAUX_RESULT_LIMIT");
    const detail = captureResearchSourceError(error);
    assert.deepEqual(detail, { name: "MarketauxCapacityLimitError", code: null,
      message: "Local Marketaux capacity validation; providerReportedFound=31; pageSize=3; requiredPages=11; maxPagesPerPass=10; maxArticles=30; pass=1; page=1; exceeded=maxArticles,maxPagesPerPass" });
    return true;
  });
});

for (const sample of [
  { label: "article cap", found: 3, pageSize: 3, maxPagesPerPass: 10, maxArticles: 2, exceeded: "maxArticles" },
  { label: "page cap", found: 31, pageSize: 3, maxPagesPerPass: 10, maxArticles: 100, exceeded: "maxPagesPerPass" },
  { label: "provider result bound", found: 20001, pageSize: 1, maxPagesPerPass: 30000, maxArticles: 30000, exceeded: "providerResultBound,expandedPageBound" },
  { label: "expanded final page", found: 20000, pageSize: 3, maxPagesPerPass: 30000, maxArticles: 30000, exceeded: "expandedPageBound" },
]) test(`capacity details preserve the existing ${sample.label} branch`, () => {
  const f = marketauxFixture(), config = { ...f.newsConfig, ...sample };
  assert.throws(() => parseMarketauxPage({ meta: { found: sample.found, returned: 0, limit: sample.pageSize, page: 1 }, data: [] }, config, f.descriptor), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, "RESEARCH_MARKETAUX_RESULT_LIMIT");
    assert.ok(captureResearchSourceError(error).message.endsWith(`exceeded=${sample.exceeded}`));
    return true;
  });
});

test("capacity diagnostics retain numeric-before-cap-before-consistency validation order", () => {
  const f = marketauxFixture(), config = { ...f.newsConfig, pageSize: 3, maxPagesPerPass: 10, maxArticles: 30 };
  const badLaterFields = { meta: { found: 31, returned: 3, limit: 2, page: 2 }, data: [] };
  assert.throws(() => parseMarketauxPage(badLaterFields, config, f.descriptor), /RESEARCH_MARKETAUX_RESULT_LIMIT/);
  assert.throws(() => parseMarketauxPage({ ...badLaterFields, meta: { ...badLaterFields.meta, found: 30 } }, config, f.descriptor), /RESEARCH_MARKETAUX_PAYLOAD_INVALID/);
  for (const key of ["found", "returned", "limit", "page"]) for (const invalid of ["31", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseMarketauxPage({ ...badLaterFields, meta: { ...badLaterFields.meta, [key]: invalid } }, config, f.descriptor), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "RESEARCH_MARKETAUX_PAYLOAD_INVALID");
      assert.equal(Object.hasOwn(error, "sourceError"), false);
      return true;
    });
  }
});

test("invalid diagnostic-only fields are omitted without interpolating payload or config text", () => {
  const f = marketauxFixture(), privateText = "synthetic-secret-account-payload";
  const config = { ...f.newsConfig, pageSize: privateText, maxPagesPerPass: privateText, maxArticles: 30 } as unknown as MarketauxNewsConfig;
  const request = { ...f.descriptor, pass: privateText, page: privateText } as unknown as MarketauxRequest;
  assert.throws(() => parseMarketauxPage({ meta: { found: 31, returned: 1, limit: 3, page: 1 }, data: [{ title: privateText }] }, config, request), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, "RESEARCH_MARKETAUX_RESULT_LIMIT");
    assert.deepEqual(captureResearchSourceError(error), { name: "MarketauxCapacityLimitError", code: null,
      message: "Local Marketaux capacity validation; providerReportedFound=31; maxArticles=30; exceeded=maxArticles" });
    return true;
  });
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null]) {
    const bad = { ...f.newsConfig, pageSize: invalid, maxPagesPerPass: invalid, maxArticles: 30 } as unknown as MarketauxNewsConfig;
    const descriptor = { ...f.descriptor, pass: invalid, page: invalid } as unknown as MarketauxRequest;
    assert.throws(() => parseMarketauxPage({ meta: { found: 31, returned: 0, limit: 3, page: 1 }, data: [] }, bad, descriptor), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "RESEARCH_MARKETAUX_RESULT_LIMIT");
      const detail = captureResearchSourceError(error);
      assert.equal(detail.message.includes("pageSize="), false); assert.equal(detail.message.includes("requiredPages="), false);
      assert.equal(detail.message.includes("maxPagesPerPass="), false); assert.equal(detail.message.includes("pass="), false); assert.equal(detail.message.includes("page="), false);
      return true;
    });
  }
});
