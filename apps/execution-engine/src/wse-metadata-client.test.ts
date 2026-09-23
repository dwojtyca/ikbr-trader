import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { WseMetadataClient, type WseMetadataSocket } from "./wse-metadata-client.js";
import { wseTestBound as bound } from "./wse-market-rules.fixture.js";
const now = Date.parse("2026-09-24T12:00:00Z");
function details() { return { contract: { conId: bound.conId, symbol: "PKO", secType: "STK", exchange: "WSE", currency: "PLN", localSymbol: "PKO", tradingClass: "PKO" }, validExchanges: "SMART,,WSE", marketRuleIds: "2,,7", timeZoneId: "Europe/Warsaw", liquidHours: "20260924:0900-20260924:1700" }; }
class Fake extends EventEmitter implements WseMetadataSocket {
  calls: string[] = [];
  connect() { this.calls.push("connect"); }
  disconnect() { this.calls.push("disconnect"); this.emit("disconnected"); }
  reqManagedAccts() { this.calls.push("accounts"); }
  reqContractDetails() { this.calls.push("details"); }
  reqMarketRule(id: number) { this.calls.push(`rule:${id}`); }
}
async function start() {
  const socket = new Fake(); const client = new WseMetadataClient({ host: "localhost", port: 1, clientId: 2 }, { createSocket: () => socket, now: () => now, timeoutMs: 100 });
  const result = client.load(bound, "PAPER"); await Promise.resolve();
  return { socket, result };
}
function ready(s: Fake) { s.emit("nextValidId", 1); s.emit("managedAccounts", "OTHER,PAPER"); }
function contract(s: Fake) { s.emit("contractDetails", 1, details()); s.emit("contractDetailsEnd", 1); }
test("readiness and account membership precede requests; positional CSV blanks preserved; complete cleanup", async () => {
  const { socket: s, result } = await start();
  assert.deepEqual(s.calls, ["connect"]); s.emit("managedAccounts", "PAPER"); assert.deepEqual(s.calls, ["connect"]);
  s.emit("nextValidId", 1); assert.deepEqual(s.calls, ["connect", "accounts", "details"]);
  contract(s); assert.equal(s.calls.at(-1), "rule:7");
  s.emit("marketRule", 7, [{ lowEdge: 0, increment: 0.01 }]);
  const m = await result; assert.equal(m.accountId, "PAPER"); assert.equal(m.marketRuleId, 7); assert.equal(m.requestStartedAtMs, now);
  assert.equal(s.calls.at(-1), "disconnect"); assert.equal(s.eventNames().length, 0);
});
for (const [name, action] of Object.entries({
  account: (s: Fake) => s.emit("managedAccounts", "OTHER"),
  correlation: (s: Fake) => { ready(s); s.emit("contractDetails", 2, details()); },
  duplicate: (s: Fake) => { ready(s); s.emit("contractDetails", 1, details()); s.emit("contractDetails", 1, details()); },
  empty: (s: Fake) => { ready(s); s.emit("contractDetailsEnd", 1); },
  identity: (s: Fake) => { ready(s); const d = details(); d.contract.currency = "USD"; s.emit("contractDetails", 1, d); },
  csvLength: (s: Fake) => { ready(s); const d = details(); d.marketRuleIds = "2,7"; s.emit("contractDetails", 1, d); s.emit("contractDetailsEnd", 1); },
  csvDuplicate: (s: Fake) => { ready(s); const d = details(); d.validExchanges = "WSE,,WSE"; s.emit("contractDetails", 1, d); s.emit("contractDetailsEnd", 1); },
  csvMissing: (s: Fake) => { ready(s); const d = details(); d.marketRuleIds = "2,,"; s.emit("contractDetails", 1, d); s.emit("contractDetailsEnd", 1); },
  wrongRule: (s: Fake) => { ready(s); contract(s); s.emit("marketRule", 8, [{ lowEdge: 0, increment: 0.01 }]); },
  earlyRule: (s: Fake) => s.emit("marketRule", 7, [{ lowEdge: 0, increment: 0.01 }]),
  malformedBands: (s: Fake) => { ready(s); contract(s); s.emit("marketRule", 7, [null]); },
  duplicateBands: (s: Fake) => { ready(s); contract(s); s.emit("marketRule", 7, [{ lowEdge: 0, increment: 1 }, { lowEdge: 0, increment: 1 }]); },
  brokerError: (s: Fake) => s.emit("error", new Error("denied"), 200, 1),
  disconnected: (s: Fake) => s.emit("disconnected"),
})) test(`provider rejects ${name} and disconnects`, async () => {
  const { socket, result } = await start(); action(socket); await assert.rejects(result, /wse_metadata/);
  assert.equal(socket.calls.at(-1), "disconnect"); assert.equal(socket.eventNames().length, 0);
});
test("timeout cleans up and queued requests receive distinct lazy sockets", async () => {
  const sockets: Fake[] = []; const client = new WseMetadataClient({ host: "x", port: 1, clientId: 2 }, { timeoutMs: 10, createSocket: () => { const s = new Fake(); sockets.push(s); return s; } });
  const a = client.load(bound, "PAPER"), b = client.load(bound, "PAPER");
  const failures = Promise.all([assert.rejects(a, /timeout/), assert.rejects(b, /timeout/)]);
  await Promise.resolve(); assert.equal(sockets.length, 1);
  await failures; assert.equal(sockets.length, 2); for (const s of sockets) { assert.equal(s.eventNames().length, 0); assert.equal(s.calls.at(-1), "disconnect"); }
});
test("informational farm events do not fail metadata request", async () => {
  const { socket: s, result } = await start(); s.emit("error", new Error("farm"), 2104, -1); ready(s); contract(s); s.emit("marketRule", 7, [{ lowEdge: 0, increment: 0.01 }]); await result;
});
