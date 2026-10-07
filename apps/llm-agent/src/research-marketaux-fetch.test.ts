import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { createMarketauxFetch, sanitizeMarketauxError } from "./research-marketaux-fetch.js";
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
  await assert.rejects(fetch(f.source, f.descriptor, deadline()), error => error instanceof Error && error.message === "RESEARCH_MARKETAUX_ACQUISITION_FAILED");
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
        callback(res); if (mode === "content") { res.emit("data", Buffer.from("private provider error body")); res.emit("end"); }
      }; return req;
    }) as typeof request;
    await assert.rejects(createMarketauxFetch("synthetic-secret", { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: fake })(f.source, f.descriptor, new Date(Date.now() + 9000).toISOString()),
      new RegExp(mode === "redirect" ? "RESEARCH_SOURCE_REDIRECT" : mode === "quota" ? "RESEARCH_SOURCE_HTTP_429" : "RESEARCH_MARKETAUX_CONTENT_TYPE_INVALID"));
    assert.equal(calls, 1);
  }
});
