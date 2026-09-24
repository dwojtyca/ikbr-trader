import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HttpReadyProbe } from "./ready-probe.js";
const token = "test-token-".repeat(4);
test("internal readiness authenticates protected HTTP endpoint without enabling writes", async () => {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ready: true, environment: "paper", tradingEnabled: false, checks: { accountMatchesEnvironment: true } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const options = { engineUrl: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 1000 };
    assert.deepEqual(await new HttpReadyProbe({ ...options, bearerToken: token }).probeReady(),
      { kind: "ok", ready: true, environment: "paper", tradingEnabled: false, accountMatchesEnvironment: true });
    assert.deepEqual(await new HttpReadyProbe({ ...options, bearerToken: "wrong" }).probeReady(), { kind: "error", message: "/ready HTTP 401" });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test("missing token never contacts network and fetch errors cannot leak token", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => { calls++; assert.equal(init?.redirect, "error"); throw new Error(`failed Bearer ${token}`); };
  assert.equal((await new HttpReadyProbe({ engineUrl: "http://unused", requestTimeoutMs: 1000, fetchImpl }).probeReady()).kind, "error");
  assert.equal(calls, 0);
  const result = await new HttpReadyProbe({ engineUrl: "http://unused", requestTimeoutMs: 1000, fetchImpl, bearerToken: token }).probeReady();
  assert.equal(result.kind, "error"); assert.ok(!JSON.stringify(result).includes(token));
});
for (const mode of ["503", "401", "302", "bad_json", "bad_environment", "inconsistent503"] as const) test(`readiness rejects invalid HTTP/body and retains legitimate503: ${mode}`, async () => {
  const status = (mode === "503" || mode === "inconsistent503") ? 503 : mode === "401" ? 401 : mode === "302" ? 302 : 200;
  const fetchImpl: typeof fetch = async () => new Response(mode === "bad_json" ? "invalid" : JSON.stringify({ ready: mode === "inconsistent503",
    environment: mode === "bad_environment" ? "unknown" : "paper", tradingEnabled: false, checks: { accountMatchesEnvironment: true } }), { status });
  const result = await new HttpReadyProbe({ engineUrl: "http://unused", requestTimeoutMs: 1000, fetchImpl, bearerToken: token }).probeReady();
  assert.equal(result.kind, mode === "503" ? "ok" : "error");
});
