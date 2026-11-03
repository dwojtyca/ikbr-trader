import { test } from "node:test";
import assert from "node:assert/strict";
import { marketauxFixture } from "./research-marketaux.testfixture.js";
import { marketauxRecordSetHash, parseMarketauxPage } from "./research-marketaux.js";
import { captureResearchSourceError, ResearchSourceFailure, researchHash, type MarketauxNewsConfig, type MarketauxRequest } from "@ikbr/shared/instrument-research";

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
      assert.deepEqual(captureResearchSourceError(error), { name: "MarketauxPayloadValidationError", code: null, message: `Local Marketaux payload validation; constraint=meta.${key}.nonnegative_safe_integer; pass=1; page=1` });
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


test("payload diagnostics identify only fixed predicates while retaining rejection precedence", () => {
  const f = marketauxFixture();
  const base = () => ({ meta: { found: 1, returned: 1, limit: 2, page: 1 }, data: [f.article(1)] });
  const cases: [string, (value: any) => unknown][] = [
    ["root.object", () => null],
    ["meta.object", v => ({ ...v, meta: null })],
    ["root.provider_error_envelope", v => ({ ...v, error: "private-provider-error", data: null })],
    ["data.array", v => ({ ...v, data: null })],
    ["meta.limit.request_match", v => ({ ...v, meta: { ...v.meta, limit: 3, page: 2 } })],
    ["meta.page.request_match", v => ({ ...v, meta: { ...v.meta, page: 2 } })],
    ["meta.returned.data_length", v => ({ ...v, meta: { ...v.meta, returned: 0 } })],
    ["meta.returned.page_cardinality", v => ({ ...v, meta: { ...v.meta, found: 2 } })],
    ["article.object", v => ({ ...v, data: [null] })],
    ["article.uuid.format", v => { v.data[0].uuid = "private-uuid"; v.data[0].title = ""; return v; }],
    ["article.title.string", v => { v.data[0].title = 3; return v; }],
    ["article.title.nonempty", v => { v.data[0].title = " "; return v; }],
    ["article.title.max_length", v => { v.data[0].title = "x".repeat(1001); return v; }],
    ["article.title.control_characters", v => { v.data[0].title = "private-title\u0000"; return v; }],
    ["article.url.safe_public_url", v => { v.data[0].url = "https://127.0.0.1/private-api-token"; return v; }],
    ["article.entities.array", v => { v.data[0].entities = null; return v; }],
    ["article.similar.empty_array", v => { v.data[0].similar = [{ private: "provider-copy" }]; return v; }],
    ["article.entity.object", v => { v.data[0].entities = [null]; return v; }],
    ["published_at.string", v => { v.data[0].published_at = null; return v; }],
    ["published_at.utc_format", v => { v.data[0].published_at = "private-timestamp"; return v; }],
    ["published_at.calendar_date", v => { v.data[0].published_at = "2026-02-30T00:00:00Z"; return v; }],
    ["matched_entity.sentiment_score.finite_unit_range", v => { v.data[0].entities[0].sentiment_score = "private-sentiment"; v.data[0].description = 3; return v; }],
    ["description.string", v => { v.data[0].description = {}; return v; }],
    ["description.max_length", v => { v.data[0].description = "x".repeat(8001); return v; }],
    ["description.control_characters", v => { v.data[0].description = "private-description\u0000"; return v; }],
    ["snippet.string", v => { v.data[0].snippet = {}; return v; }],
    ["snippet.max_length", v => { v.data[0].snippet = "x".repeat(8001); return v; }],
    ["snippet.control_characters", v => { v.data[0].snippet = "private-snippet\u0000"; return v; }],
  ];
  for (const [constraint, mutate] of cases) {
    const value = base();
    Object.assign(value.data[0], { description: "synthetic-secret-account-payload", snippet: "https://private.example/?api_token=secret" });
    assert.throws(() => parseMarketauxPage(mutate(value), f.newsConfig, f.descriptor, 2), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, "RESEARCH_MARKETAUX_PAYLOAD_INVALID");
      const record = !/^(root|meta|data)\./.test(constraint);
      const location = `; pass=1; page=1${record ? "; recordIndex=0" : ""}${constraint === "article.entity.object" || constraint.startsWith("matched_entity.") ? "; entityIndex=0" : ""}`;
      const url = constraint === "article.url.safe_public_url" ? "; urlPredicate=ip_host" : "";
      const expected = { name: "MarketauxPayloadValidationError", code: null, message: `Local Marketaux payload validation; constraint=${constraint}${url}${location}` };
      assert.deepEqual(captureResearchSourceError(error), expected);
      assert.deepEqual(captureResearchSourceError(new ResearchSourceFailure(error.message, error)), expected);
      assert.equal(JSON.stringify(captureResearchSourceError(error)).includes("private"), false);
      assert.equal(JSON.stringify(captureResearchSourceError(error)).includes("synthetic-secret"), false);
      return true;
    });
  }
  assert.throws(() => parseMarketauxPage({ meta: { found: 0, returned: 0, limit: 2, page: 2 }, data: [] }, f.newsConfig, { ...f.descriptor, page: 2 }), error => {
    assert.equal(captureResearchSourceError(error).message, "Local Marketaux payload validation; constraint=request.page.result_bound; pass=1; page=2");
    return true;
  });
});


test("payload diagnostics locate later records and nested entities without provider strings", () => {
  const f = marketauxFixture();
  const request = { ...f.descriptor, pass: 2 as const, page: 2 };
  const secret = "synthetic-secret-DU_TEST";
  const parse = (second: unknown) => parseMarketauxPage({ meta: { found: 4, returned: 2, limit: 2, page: 2 }, data: [f.article(1), second] }, f.newsConfig, request, 2);
  const badEntity = { ...f.article(2), entities: [{ symbol: "OTHER" }, null] };
  const sentiment = { ...f.article(2), entities: [{ symbol: "OTHER" }, { ...f.newsConfig.entity, sentiment_score: secret }] };
  const cases: [unknown, string][] = [
    [{ ...f.article(2), url: `https://publisher.com/article?api_token=${secret}#${secret}` }, "article.url.safe_public_url; urlPredicate=fragment; pass=2; page=2; recordIndex=1"],
    [badEntity, "article.entity.object; pass=2; page=2; recordIndex=1; entityIndex=1"],
    [sentiment, "matched_entity.sentiment_score.finite_unit_range; pass=2; page=2; recordIndex=1; entityIndex=1"],
    [{ ...f.article(2), published_at: secret }, "published_at.utc_format; pass=2; page=2; recordIndex=1"],
    [{ ...f.article(2), description: secret + "\u0000" }, "description.control_characters; pass=2; page=2; recordIndex=1"],
  ];
  for (const [item, detail] of cases) assert.throws(() => parse(item), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, "RESEARCH_MARKETAUX_PAYLOAD_INVALID");
    const captured = captureResearchSourceError(new ResearchSourceFailure(error.message, error));
    assert.deepEqual(captured, { name: "MarketauxPayloadValidationError", code: null, message: `Local Marketaux payload validation; constraint=${detail}` });
    for (const privateValue of [secret, "publisher.com", f.article(2).uuid]) assert.equal(JSON.stringify(captured).includes(privateValue), false);
    return true;
  });
});

test("payload diagnostics omit invalid request location without trusting string values", () => {
  const f = marketauxFixture();
  for (const value of ["synthetic-secret", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    const request = { ...f.descriptor, pass: value, page: value } as unknown as MarketauxRequest;
    assert.throws(() => parseMarketauxPage(null, f.newsConfig, request), error => {
      assert.equal(captureResearchSourceError(error).message, "Local Marketaux payload validation; constraint=root.object");
      return true;
    });
  }
});
