import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { parseTradingConfiguration } from "@ikbr/shared";
import { evaluateTradingConfigurationBrokerEvidence } from "@ikbr/shared/trading-config";
import { ConfigurationMetadataClient, type ConfigurationMetadataSocket } from "./configuration-metadata-client.js";
import { configurationQuoteFromWatchlist, registerConfigurationMetadataRoutes } from "./configuration-metadata-routes.js";
import { AuthFailureBurstTracker, registerExecutionAuth } from "./auth.js";

const parsed = parseTradingConfiguration(readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8"));
if (!parsed.ok) throw new Error("invalid test fixture");
const instrument = parsed.configuration.instruments.find(row => row.id === "xyz_nyse")!;
const now = Date.parse("2026-09-28T15:00:00.000Z"), token = "configuration-test-token-".repeat(3);
function detail() {
  const c = instrument.contract;
  return { contract: { conId: c.conId, symbol: c.symbol, secType: "STK", exchange: c.exchange,
    primaryExch: c.primaryExchange, currency: c.currency, localSymbol: c.localSymbol, tradingClass: c.tradingClass },
  minTick: c.expectedMinTick, validExchanges: "NYSE,SMART", marketRuleIds: "27,26" };
}
class FakeSocket extends EventEmitter implements ConfigurationMetadataSocket {
  requests: Array<{ id: number; contract: unknown }> = [];
  ruleRequests: number[] = [];
  disconnected = false;
  constructor(readonly mode = "valid") { super(); }
  connect() { if (this.mode === "connect failure") throw new Error("private broker text"); this.emit("nextValidId", 1); }
  disconnect() { this.disconnected = true; this.emit("disconnected"); }
  reqManagedAccts() { this.emit("managedAccounts", this.mode === "foreign account" ? "FOREIGN" : "PAPER"); }
  reqContractDetails(id: number, contract: unknown) {
    this.requests.push({ id, contract });
    if (this.mode === "timeout") return;
    if (this.mode === "disconnect") { this.emit("disconnected"); return; }
    this.emit("contractDetails", id + 1, { contract: {} });
    if (this.mode !== "empty") {
      const d = detail();
      if (this.mode === "wrong primary") d.contract.primaryExch = "NASDAQ";
      if (this.mode === "missing symbol") Reflect.deleteProperty(d.contract, "symbol");
      if (this.mode === "wrong routing") d.validExchanges = "NYSE,AMEX";
      this.emit("contractDetails", id, d);
      if (this.mode === "duplicate") this.emit("contractDetails", id, d);
    }
    this.emit("contractDetailsEnd", id);
  }
  reqMarketRule(id: number) {
    this.ruleRequests.push(id);
    this.emit("marketRule", id + 1, []);
    this.emit("marketRule", id, [{ lowEdge: 0, increment: .0001 }, { lowEdge: 1, increment: .01 }]);
  }
}
for (const [mode, status] of [
  ["valid", "verified"], ["empty", "unavailable"], ["duplicate", "mismatch"], ["wrong primary", "mismatch"],
  ["missing symbol", "unknown"], ["foreign account", "unavailable"], ["disconnect", "unavailable"],
  ["connect failure", "unavailable"], ["timeout", "unavailable"],
] as const) test(`generic read-only socket ${mode}`, async () => {
  const socket = new FakeSocket(mode);
  const client = new ConfigurationMetadataClient({ host: "unused", port: 1, clientId: 155 }, { createSocket: () => socket, now: () => now, timeoutMs: 10 });
  const raw = await client.load(instrument, "PAPER");
  const result = evaluateTradingConfigurationBrokerEvidence(instrument, raw, now);
  assert.equal(result.identity.status, status);
  assert.equal(socket.disconnected, true);
  for (const event of ["nextValidId", "managedAccounts", "contractDetails", "contractDetailsEnd", "marketRule", "disconnected"]) assert.equal(socket.listenerCount(event), 0);
  if (mode === "valid") {
    assert.deepEqual(socket.ruleRequests, [26]); assert.equal(result.priceGrid.status, "verified");
    assert.equal((socket.requests[0].contract as Record<string, unknown>).primaryExch, "NYSE");
    assert.equal((socket.requests[0].contract as Record<string, unknown>).exchange, "SMART");
  }
  if (mode === "foreign account") assert.equal(socket.requests.length, 0);
  assert.equal(JSON.stringify(raw).includes("private broker text"), false);
});
test("missing market rule API preserves verified contract but never verifies price grid", async () => {
  const socket = new FakeSocket(); Object.assign(socket, { reqMarketRule: undefined });
  const client = new ConfigurationMetadataClient({ host: "unused", port: 1, clientId: 155 }, { createSocket: () => socket, now: () => now });
  const result = evaluateTradingConfigurationBrokerEvidence(instrument, await client.load(instrument, "PAPER"), now);
  assert.equal(result.identity.status, "verified"); assert.equal(result.priceGrid.status, "unavailable");
});
test("serialized metadata requests never overlap clients with the same socket identity", async () => {
  let active = 0, maximum = 0;
  const client = new ConfigurationMetadataClient({ host: "unused", port: 1, clientId: 155 }, {
    now: () => now, createSocket: () => {
      const socket = new FakeSocket();
      socket.connect = () => { maximum = Math.max(maximum, ++active); queueMicrotask(() => socket.emit("nextValidId", 1)); };
      socket.disconnect = () => { active--; };
      return socket;
    },
  });
  await Promise.all([client.load(instrument, "PAPER"), client.load(instrument, "PAPER")]);
  assert.equal(maximum, 1); assert.equal(active, 0);
});
function watchlist() {
  return { connected: true, watchlist: [{ instrumentId: instrument.id, symbol: instrument.contract.symbol,
    conid: String(instrument.contract.conId), subscribed: true, marketState: { conid: String(instrument.contract.conId),
      marketDataType: 1, bid: 20, ask: 20.01, bidObservedAt: new Date(now - 100).toISOString(), askObservedAt: new Date(now - 200).toISOString() } }] };
}
test("quote provenance requires connected, subscribed exact identity; source stamps are preserved", () => {
  const good = watchlist();
  const quote = configurationQuoteFromWatchlist(instrument, good) as Record<string, unknown>;
  assert.equal(quote.source, "ibkr"); assert.equal(quote.bidObservedAt, good.watchlist[0].marketState.bidObservedAt);
  for (const mutate of [
    (w: ReturnType<typeof watchlist>) => { w.connected = false; },
    (w: ReturnType<typeof watchlist>) => { w.watchlist[0].subscribed = false; },
    (w: ReturnType<typeof watchlist>) => { w.watchlist[0].conid = "other"; },
    (w: ReturnType<typeof watchlist>) => { w.watchlist[0].marketState.conid = "other"; },
    (w: ReturnType<typeof watchlist>) => { w.watchlist.push(w.watchlist[0]); },
  ]) { const data = watchlist(); mutate(data); assert.equal(configurationQuoteFromWatchlist(instrument, data), undefined); }
});
test("production route auth, trusted readers, cache expiry and account-change refusal", async () => {
  let calls = 0, account = "PAPER", clock = now, changeAccount = false;
  const app = Fastify();
  registerExecutionAuth(app, { token, publicPaths: new Set(), writeAudit: async () => {},
    burstTracker: new AuthFailureBurstTracker(() => {}), logger: { warn: () => {} } });
  const client = new ConfigurationMetadataClient({ host: "unused", port: 1, clientId: 155 }, { createSocket: () => new FakeSocket(), now: () => clock });
  const state = registerConfigurationMetadataRoutes(app, {
    instruments: () => [instrument], currentAccountId: () => account, assertAccountAllowed: value => assert.equal(value, "PAPER"),
    loadMetadata: async (item, value) => { calls++; if (changeAccount) account = "OTHER"; return client.load(item, value); },
    readSessionEvidence: async () => null, readWatchlist: async () => watchlist(), now: () => clock,
  });
  try {
    const url = `/execution/configuration/instruments/${instrument.id}/broker-evidence`;
    assert.equal(state.evidence().get(instrument.id)?.identity.status, "unknown"); assert.equal(calls, 0);
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401); assert.equal(calls, 0);
    const response = await app.inject({ method: "GET", url: `${url}?source=attacker&marketDataType=1`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().evidence.identity.status, "verified");
    assert.equal(response.json().evidence.quote.status, "verified"); assert.equal(calls, 1);
    clock += 10_000;
    assert.equal(state.evidence().get(instrument.id)?.quote.status, "unavailable"); assert.equal(calls, 1);
    account = "OTHER";
    assert.equal(state.evidence().get(instrument.id)?.identity.status, "unknown");
    account = "PAPER";
    assert.equal(state.evidence().get(instrument.id)?.identity.status, "unknown");
    assert.equal(calls, 1);
    changeAccount = true;
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } })).statusCode, 503);
    assert.equal(state.evidence().get(instrument.id)?.identity.status, "unknown");
  } finally { await app.close(); }
});
