import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { createMarketauxFetch, sanitizeMarketauxError } from "./research-marketaux-fetch.js";
import { ResearchSourceFailure } from "@ikbr/shared/instrument-research";
import { marketauxFixture } from "./research-marketaux.testfixture.js";

test("Marketaux authenticates only transport URL and pins public DNS with no redirects", async () => {
  const f = marketauxFixture(), token = "synthetic-secret-transport-only";
  const seen: URL[] = [];
  const fake = ((url: URL, options: any, callback: (res: any) => void) => {
    seen.push(url); assert.equal(options.headers.Accept, "application/json"); assert.equal(options.agent, false);
    options.lookup("api.marketaux.com", {}, (_error: unknown, address: string) => assert.equal(address, "8.8.8.8"));
    const req = new EventEmitter() as any; req.destroy = () => {};
    req.end = () => { const res = new EventEmitter() as any; res.statusCode = 200; res.headers = { "content-type": "application/json; charset=utf-8" }; res.destroy = () => {};
      callback(res); res.emit("data", Buffer.from("{}")); res.emit("end"); };
    return req;
  }) as typeof request;
  await createMarketauxFetch(token, { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: fake })(f.source, f.descriptor, new Date(Date.now() + 9000).toISOString());
  assert.equal(seen.length, 1); assert.equal(seen[0].searchParams.get("api_token"), token);
  assert.ok(!JSON.stringify(f.source).includes(token)); assert.ok(!JSON.stringify(f.descriptor).includes(token));
});

test("missing keys, altered authority and raw token-bearing errors never leak or connect", async () => {
  const f = marketauxFixture(), secret = "synthetic-token"; let connections = 0;
  const fetch = createMarketauxFetch(secret, { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: (() => { connections++; throw new Error(`request https://api.marketaux.com?api_token=${secret}`); }) as unknown as typeof request });
  const deadline = () => new Date(Date.now() + 9000).toISOString();
  await assert.rejects(fetch(f.source, f.descriptor, deadline()), error => {
    assert.ok(error instanceof ResearchSourceFailure); assert.equal(error.message, "RESEARCH_MARKETAUX_ACQUISITION_FAILED");
    assert.match(error.sourceError.message, /request/); assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!String(error.cause).includes(secret)); return true;
  });
  assert.equal(connections, 1);
  await assert.rejects(createMarketauxFetch(undefined)(f.source, f.descriptor, deadline()), /KEY_MISSING/);
  for (const sourceUrl of [f.source.urls[0] + "&api_token=x", "https://127.0.0.1/", "https://api.marketaux.com/v1/entity/search"])
    await assert.rejects(fetch(f.source, { ...f.descriptor, sourceUrl }, deadline()), /REQUEST_INVALID/);
  assert.equal(connections, 1);
  assert.equal(sanitizeMarketauxError(new Error("RESEARCH_MARKETAUX_SYNTHETIC_SECRET_TOKEN")), "RESEARCH_MARKETAUX_ACQUISITION_FAILED");
});

test("authenticated transport rejects redirect, HTTP quota and non-JSON content without following links", async () => {
  for (const mode of ["redirect", "quota", "content"] as const) {
    const f = marketauxFixture(); let calls = 0;
    const fake = ((_url: URL, _options: unknown, callback: (res: any) => void) => {
      calls++; const req = new EventEmitter() as any; req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter() as any; res.statusCode = mode === "quota" ? 429 : 200;
        res.headers = mode === "redirect" ? { location: "https://127.0.0.1/private" } : { "content-type": mode === "content" ? "text/html" : "application/json" }; res.destroy = () => {};
        callback(res); if (mode === "quota") { res.emit("data", Buffer.from(JSON.stringify({error:{code:"rate_limit_reached",message:"Too many requests"}}))); res.emit("end"); } if (mode === "content") { res.emit("data", Buffer.from("private provider error body")); res.emit("end"); }
      }; return req;
    }) as typeof request;
    await assert.rejects(createMarketauxFetch("synthetic-secret", { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: fake })(f.source, f.descriptor, new Date(Date.now() + 9000).toISOString()),
      new RegExp(mode === "redirect" ? "RESEARCH_SOURCE_REDIRECT" : mode === "quota" ? "RESEARCH_SOURCE_HTTP_429" : "RESEARCH_MARKETAUX_CONTENT_TYPE_INVALID"));
    assert.equal(calls, 1);
  }
});


test("ongoing Marketaux rejects invalid operation deadlines and preserves provider denial", async () => {
  const f = marketauxFixture();
  for (const name of ["qualification", "entitlement"]) Object.assign(f.source.parserConfig[name] as object, { expiresAt: null,
    validity: { mode: "OPERATOR_CONFIRMED_ONGOING", confirmedAt: new Date(Date.now() - 1000).toISOString(), confirmationRef: "fixture-confirmation", confirmationHash: "a".repeat(64) } });
  let calls = 0;
  const fake = ((_url: URL, _options: unknown, callback: (res: any) => void) => {
    calls++; const req = new EventEmitter() as any; req.destroy = () => {};
    req.end = () => { const res = new EventEmitter() as any; res.statusCode = 403; res.headers = { "content-type": "application/json" }; res.destroy = () => {};
      callback(res); res.emit("data", Buffer.from(JSON.stringify({ error: { code: "access_denied", message: "Subscription access denied" } }))); res.emit("end"); };
    return req;
  }) as typeof request;
  const fetch = createMarketauxFetch("synthetic-secret", { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: fake });
  for (const deadline of ["invalid", "Infinity", new Date(Date.now() - 1000).toISOString()])
    await assert.rejects(fetch(f.source, f.descriptor, deadline), /RESEARCH_SOURCE_DEADLINE_INVALID/);
  assert.equal(calls, 0);
  await assert.rejects(fetch(f.source, f.descriptor, new Date(Date.now() + 9000).toISOString()), error => {
    assert.ok(error instanceof ResearchSourceFailure); assert.equal(error.message, "RESEARCH_SOURCE_HTTP_403");
    assert.equal(error.sourceError.providerMessage, "Subscription access denied"); return true;
  });
  assert.equal(calls, 1);
});

test("v2 transport keeps DB deadlines opaque and uses its reserved monotonic budget and trusted dispatch guard", async t => {
  const f = marketauxFixture(Date.parse("2026-10-15T12:30:00.000Z"));
  Object.assign(f.source.parserConfig, { kind: "marketaux-news-v2", refreshIntervalMs: 3600000, maxAgeMs: 86400000, queryLookbackMs: 86400000 });
  const { marketauxWindow } = await import("@ikbr/shared/instrument-research");
  const slot = Math.floor(f.now / 3600000);
  const descriptor = { sourceUrl: f.source.urls[0], ...marketauxWindow(slot, f.source.parserConfig as any), pass: 1 as const, page: 1,
    kind: "marketaux-news-v2" as const, attemptId: "00000000-0000-0000-0000-000000000001", slot };
  let calls = 0;
  const fake = ((_url: URL, _options: unknown, callback: (res: any) => void) => {
    calls++; const req = new EventEmitter() as any; req.destroy = () => {};
    req.end = () => { const res = new EventEmitter() as any; res.statusCode = 200; res.headers = { "content-type": "application/json" }; res.destroy = () => {};
      callback(res); res.emit("data", Buffer.from("{}")); res.emit("end"); };
    return req;
  }) as typeof request;
  const fetch = createMarketauxFetch("synthetic-secret", { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: fake });
  const derivedHostDate = new Date(f.now + 9000).toISOString();
  t.mock.method(Date, "now", () => f.now - 86400000 * 10);
  let checks = 0;
  await fetch(f.source, descriptor, derivedHostDate, 1024, performance.now() + 9000, { assertActive: () => { checks++; } });
  assert.equal(checks, 4);
  assert.equal(calls, 1);
  await assert.rejects(fetch(f.source, descriptor, derivedHostDate, 1024, performance.now() + 9000), /RESEARCH_MARKETAUX_DISPATCH_GUARD_REQUIRED/);
  for (const deadline of [undefined, NaN, Infinity, performance.now() - 1])
    await assert.rejects(fetch(f.source, descriptor, derivedHostDate, 1024, deadline), /RESEARCH_SOURCE_DEADLINE_INVALID/);
  assert.equal(calls, 1);
});

test("v2 monotonic admission expires during DNS without sending a request", async () => {
  const f = marketauxFixture();
  Object.assign(f.source.parserConfig, { kind: "marketaux-news-v2", refreshIntervalMs: 3600000, maxAgeMs: 86400000, queryLookbackMs: 86400000 });
  const { marketauxWindow } = await import("@ikbr/shared/instrument-research");
  const slot = Math.floor(f.now / 3600000);
  const descriptor = { sourceUrl: f.source.urls[0], ...marketauxWindow(slot, f.source.parserConfig as any), pass: 1 as const, page: 1,
    kind: "marketaux-news-v2" as const, attemptId: "00000000-0000-0000-0000-000000000001", slot };
  let calls = 0;
  const fetch = createMarketauxFetch("synthetic-secret", { resolveAddress: async () => new Promise(resolve => setTimeout(() => resolve({ address: "8.8.8.8", family: 4 }), 50)),
    httpsRequest: (() => { calls++; throw new Error("unexpected HTTP request"); }) as unknown as typeof request });
  await assert.rejects(fetch(f.source, descriptor, new Date(Date.now() + 9000).toISOString(), 1024, performance.now() + 20, { assertActive: () => {} }), /RESEARCH_SOURCE_TIMEOUT/);
  assert.equal(calls, 0);
});
