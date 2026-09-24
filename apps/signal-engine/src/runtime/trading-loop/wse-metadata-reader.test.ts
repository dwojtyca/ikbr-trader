import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpWseStrategyMetadataReader } from "./wse-metadata-reader.js";
import type { BoundInstrument } from "@ikbr/shared";
const bound = { instrumentId: "pko_wse" } as BoundInstrument;
test("metadata reader uses scoped authenticated read-only endpoint", async () => {
  let calls = 0;
  const reader = new HttpWseStrategyMetadataReader({ engineUrl: "http://execution/", bearerToken: "token", requestTimeoutMs: 100,
    fetchFn: async (url, init) => { calls++; assert.equal(url, "http://execution/execution/instruments/pko_wse/market-rules");
      assert.equal(init?.method, undefined); assert.equal((init?.headers as Record<string,string>).authorization, "Bearer token");
      return new Response(JSON.stringify({ accountId: "DU-TEST", metadata: { marketRuleId: 1 } })); },
  });
  assert.equal((await reader.read(bound)).accountId, "DU-TEST"); assert.equal(calls, 1);
});
for (const body of [{}, { metadata: {} }, { accountId: "", metadata: {} }]) test(`metadata refuses malformed ${JSON.stringify(body)}`, async () => {
  const reader = new HttpWseStrategyMetadataReader({ engineUrl: "http://execution", bearerToken: "x", requestTimeoutMs: 100, fetchFn: async () => new Response(JSON.stringify(body)) });
  await assert.rejects(reader.read(bound));
});
