import { test } from "node:test";
import assert from "node:assert/strict";
import { configurationSessionIdentity, evaluateTradingConfigurationBrokerEvidence as evaluate } from "./broker-evidence.js";
import type { TradingInstrumentV1 } from "./types.js";
import type { TradingConfigurationBrokerObservation } from "./broker-evidence.js";

const now = Date.parse("2026-09-28T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const instrument: TradingInstrumentV1 = {
  id: "fixture_quartz", assetClass: "stock", contract: { broker: "ibkr", symbol: "QZTEST", conId: 992211,
    exchange: "SMART", primaryExchange: "NYSE", currency: "USD", localSymbol: "QZTEST", tradingClass: "QZT", expectedMinTick: .01 },
  session: { useRTH: true, timeZone: "America/New_York" }, monitoringEnabled: true, entryEnabled: false,
  strategySelection: { mode: "single", instanceIds: [] }, accountPolicyId: "account", entryPolicyId: "entry",
  executionPolicyId: "execution", riskPolicyId: "risk", researchPolicyId: "research", issuerMappingId: "issuer",
};
function observation() {
  const { broker: _broker, expectedMinTick: minTick, ...contract } = instrument.contract;
  return {
    requestStartedAt: iso(now - 100), observedAt: iso(now),
    candidates: [{ contract: { ...contract, secType: "STK" }, minTick, validExchanges: ["NYSE", "SMART"], marketRuleIds: [27, 26] }],
    marketRule: { id: 26, bands: [{ lowEdge: 0, increment: .0001 }, { lowEdge: 1, increment: .01 }] },
    sessionEvidence: { generation: 1, status: "READY" as const, updatedAt: iso(now), schedule: {
      source: "ibkr_session_schedule_v1" as const, identity: configurationSessionIdentity(instrument),
      coverageStart: "2026-09-01T00:00:00.000Z", coverageEnd: "2026-09-30T00:00:00.000Z",
      requestedAt: iso(now - 100), receivedAt: iso(now),
      sessions: [{ date: "2026-09-28", start: "2026-09-28T13:30:00.000Z", end: "2026-09-28T20:00:00.000Z" }],
    } },
    quote: { instrumentId: instrument.id, conId: instrument.contract.conId, source: "ibkr" as const, marketDataType: 1,
      bid: 20, ask: 20.01, bidObservedAt: iso(now - 200), askObservedAt: iso(now - 100) },
  };
}

test("third stock verifies each real evidence component and selects SMART route, independently from NYSE listing", () => {
  const result = evaluate(instrument, observation(), now);
  for (const key of ["identity", "session", "priceGrid", "quote"] as const) assert.equal(result[key].status, "verified");
  assert.equal(result.sessionOpen, true);
  assert.ok(Object.isFrozen(result));
  const wrongRule = observation(); wrongRule.marketRule.id = 27;
  assert.equal(evaluate(instrument, wrongRule, now).priceGrid.status, "mismatch");
});
test("expectations alone are unknown; zero/multiple matches and missing details cannot verify identity or grid", () => {
  const missing = evaluate(instrument, undefined, now);
  for (const key of ["identity", "session", "priceGrid", "quote"] as const) assert.equal(missing[key].status, "unknown");
  assert.equal(evaluate(instrument, { ...observation(), candidates: [] }, now).identity.status, "unavailable");
  const data = observation(); data.candidates.push(structuredClone(data.candidates[0]));
  assert.equal(evaluate(instrument, data, now).identity.status, "mismatch");
  assert.notEqual(evaluate(instrument, data, now).priceGrid.status, "verified");
  const noSymbol = observation(); Reflect.deleteProperty(noSymbol.candidates[0].contract, "symbol");
  assert.equal(evaluate(instrument, noSymbol, now).identity.status, "unknown");
  noSymbol.candidates[0].contract.conId++;
  assert.equal(evaluate(instrument, noSymbol, now).identity.status, "mismatch");
});
for (const field of ["conId", "symbol", "secType", "exchange", "primaryExchange", "currency", "localSymbol", "tradingClass"] as const)
  test(`returned ${field} mismatch is never replaced with requested identity`, () => {
    const data = observation(); Object.assign(data.candidates[0].contract, { [field]: field === "conId" ? 123 : "WRONG" });
    assert.equal(evaluate(instrument, data, now).identity.status, "mismatch");
    assert.notEqual(evaluate(instrument, data, now).priceGrid.status, "verified");
  });
test("primaryExchange aliases may agree but cannot conflict", () => {
  const data = observation(); Object.assign(data.candidates[0].contract, { primaryExch: "NASDAQ" });
  assert.equal(evaluate(instrument, data, now).identity.reason, "BROKER_PRIMARY_LISTING_MISMATCH");
  Object.assign(data.candidates[0].contract, { primaryExch: "NYSE" });
  assert.equal(evaluate(instrument, data, now).identity.status, "verified");
});
for (const [label, patch] of Object.entries({ stale: { requestStartedAt: iso(now - 60_001) },
  reverse: { requestStartedAt: iso(now + 1) }, future: { observedAt: iso(now + 1) }, malformed: { observedAt: "2026-09-28" } }))
  test(`metadata ${label} denies identity and grid while not rewriting quote source age`, () => {
    const result = evaluate(instrument, { ...observation(), ...patch }, now);
    assert.equal(result.identity.status, "unavailable"); assert.notEqual(result.priceGrid.status, "verified");
    assert.equal(result.quote.status, "verified");
  });
test("metadata age boundary uses request start, not just completion", () => {
  assert.equal(evaluate(instrument, { ...observation(), requestStartedAt: iso(now - 60_000) }, now).identity.status, "verified");
  assert.equal(evaluate(instrument, { ...observation(), requestStartedAt: iso(now - 60_001) }, now).identity.status, "unavailable");
});
for (const [label, mutate] of Object.entries({
  duplicates: (d: ReturnType<typeof observation>) => { d.candidates[0].validExchanges = ["SMART", "SMART"]; },
  cardinality: (d: ReturnType<typeof observation>) => { d.candidates[0].marketRuleIds.pop(); },
  missingRoute: (d: ReturnType<typeof observation>) => { d.candidates[0].validExchanges[1] = "AMEX"; },
  badRule: (d: ReturnType<typeof observation>) => { d.candidates[0].marketRuleIds[1] = 0; },
  wrongRule: (d: ReturnType<typeof observation>) => { d.marketRule.id = 99; },
  noZero: (d: ReturnType<typeof observation>) => { d.marketRule.bands[0].lowEdge = .1; },
  order: (d: ReturnType<typeof observation>) => { d.marketRule.bands.reverse(); },
  duplicatesBands: (d: ReturnType<typeof observation>) => { d.marketRule.bands.push({ lowEdge: 1, increment: .01 }); },
  nan: (d: ReturnType<typeof observation>) => { d.marketRule.bands[0].increment = NaN; },
  zero: (d: ReturnType<typeof observation>) => { d.marketRule.bands[0].increment = 0; },
})) test(`grid ${label} is mismatch despite matching minTick`, () => {
  const data = observation(); mutate(data);
  const result = evaluate(instrument, data, now); assert.equal(result.identity.status, "verified"); assert.equal(result.priceGrid.status, "mismatch");
});
test("no rule API or mapping remains unavailable", () => {
  assert.equal(evaluate(instrument, { ...observation(), marketRule: undefined }, now).priceGrid.status, "unavailable");
  const data = observation(); Reflect.deleteProperty(data.candidates[0], "validExchanges");
  assert.equal(evaluate(instrument, data, now).priceGrid.status, "unavailable");
});
for (const [label, mutate, status] of [
  ["delayed", (d: ReturnType<typeof observation>) => { d.quote.marketDataType = 3; }, "unavailable"],
  ["frozen", (d: ReturnType<typeof observation>) => { d.quote.marketDataType = 2; }, "unavailable"],
  ["missing type", (d: ReturnType<typeof observation>) => { Reflect.deleteProperty(d.quote, "marketDataType"); }, "unknown"],
  ["missing source", (d: ReturnType<typeof observation>) => { Reflect.deleteProperty(d.quote, "source"); }, "unknown"],
  ["identity", (d: ReturnType<typeof observation>) => { d.quote.conId++; }, "mismatch"],
  ["instrument", (d: ReturnType<typeof observation>) => { d.quote.instrumentId = "wrong"; }, "mismatch"],
  ["crossed", (d: ReturnType<typeof observation>) => { d.quote.ask = 19; }, "mismatch"],
  ["boundary", (d: ReturnType<typeof observation>) => { d.quote.bidObservedAt = iso(now - 10_000); }, "unavailable"],
  ["future", (d: ReturnType<typeof observation>) => { d.quote.askObservedAt = iso(now + 1); }, "unavailable"],
] as const) test(`quote ${label} never verifies`, () => {
  const data = observation(); mutate(data); assert.equal(evaluate(instrument, data, now).quote.status, status);
});
test("session is verified but closed outside intervals; stale/foreign/absent schedule cannot synthesize readiness", () => {
  const closed = observation(); closed.sessionEvidence.schedule.sessions[0].start = "2026-09-28T16:00:00.000Z";
  const result = evaluate(instrument, closed, now); assert.equal(result.session.status, "verified"); assert.equal(result.sessionOpen, false);
  assert.equal(result.session.reason, "SESSION_CLOSED");
  const old = observation(); old.sessionEvidence.schedule.receivedAt = iso(now - 6 * 3600_000 - 1);
  old.sessionEvidence.schedule.requestedAt = old.sessionEvidence.schedule.receivedAt;
  assert.equal(evaluate(instrument, old, now).session.status, "unavailable");
  const foreign = observation(); foreign.sessionEvidence.schedule.identity.conId++;
  assert.equal(evaluate(instrument, foreign, now).session.status, "mismatch");
  assert.equal(evaluate(instrument, { ...observation(), sessionEvidence: undefined }, now).session.status, "unknown");
});
test("readiness recomputes cached evidence expiry without refreshing timestamps", () => {
  const data: TradingConfigurationBrokerObservation = observation();
  assert.equal(evaluate(instrument, data, now + 10_000).quote.status, "unavailable");
  assert.equal(evaluate(instrument, data, now + 60_001).identity.status, "unavailable");
  assert.equal(data.observedAt, iso(now));
});
