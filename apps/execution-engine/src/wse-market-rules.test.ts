import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalTicket } from "@ikbr/shared";
import { validateWseOrder } from "./wse-market-rules.js";
import { wseMetadataFixture, wseTestBound as bound, wseTestTicket as ticket } from "./wse-market-rules.fixture.js";
const now = Date.parse("2026-09-24T12:00:00Z");
function fixture() { return wseMetadataFixture(bound, "PAPER", now); }
test("valid evidence expires from request start; every bracket leg uses its own price band", () => {
  const m = fixture(); m.priceIncrements = [{ lowEdge: 0, increment: 0.01 }, { lowEdge: 100, increment: 0.1 }];
  const result = validateWseOrder(m, bound, "PAPER", ticket, now);
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.expiresAtMs, now + 59900);
  assert.equal(validateWseOrder(m, bound, "PAPER", { ...ticket, takeProfit: 101.01 }, now).ok, false);
  assert.equal(validateWseOrder(m, bound, "PAPER", { ...ticket, entry: 100.1 }, now).ok, true);
});
for (const [name, mutate] of Object.entries({
  account: (m: ReturnType<typeof fixture>) => { m.accountId = "OTHER"; },
  conid: (m: ReturnType<typeof fixture>) => { m.conId++; },
  localSymbol: (m: ReturnType<typeof fixture>) => { m.localSymbol = "OTHER"; },
  tradingClass: (m: ReturnType<typeof fixture>) => { m.tradingClass = "OTHER"; },
  stale: (m: ReturnType<typeof fixture>) => { m.requestStartedAtMs = now - 60000; },
  future: (m: ReturnType<typeof fixture>) => { m.receivedAtMs = now + 1; },
  reversedTime: (m: ReturnType<typeof fixture>) => { m.requestStartedAtMs = now; },
  empty: (m: ReturnType<typeof fixture>) => { m.priceIncrements = []; },
  nonzeroFirst: (m: ReturnType<typeof fixture>) => { m.priceIncrements[0].lowEdge = 1; },
  zeroIncrement: (m: ReturnType<typeof fixture>) => { m.priceIncrements[0].increment = 0; },
  infinity: (m: ReturnType<typeof fixture>) => { m.priceIncrements[0].increment = Infinity; },
  duplicate: (m: ReturnType<typeof fixture>) => { m.priceIncrements.push({ lowEdge: 0, increment: 0.1 }); },
  unsorted: (m: ReturnType<typeof fixture>) => { m.priceIncrements.push({ lowEdge: 10, increment: 0.1 }, { lowEdge: 5, increment: 0.1 }); },
  timezone: (m: ReturnType<typeof fixture>) => { m.timeZoneId = "UTC"; },
  closed: (m: ReturnType<typeof fixture>) => { m.liquidHours = "20260924:CLOSED"; },
  missing: (m: ReturnType<typeof fixture>) => { m.liquidHours = "20260925:0900-20260925:1700"; },
  badDate: (m: ReturnType<typeof fixture>) => { m.liquidHours += ";20260230:CLOSED"; },
  badTime: (m: ReturnType<typeof fixture>) => { m.liquidHours = "20260924:0900-20260924:2560"; },
  legacy: (m: ReturnType<typeof fixture>) => { m.liquidHours = "20260924:0900-1700"; },
  overlap: (m: ReturnType<typeof fixture>) => { m.liquidHours = "20260924:0900-20260924:1500,1400-20260924:1700"; },
  reversed: (m: ReturnType<typeof fixture>) => { m.liquidHours = "20260924:1700-20260924:0900"; },
})) test(`reject ${name}`, () => { const m = fixture(); mutate(m); assert.equal(validateWseOrder(m, bound, "PAPER", ticket, now).ok, false); });
for (const raw of [null, {}, [], { priceIncrements: [null] }]) test(`malformed metadata ${JSON.stringify(raw)}`, () => assert.equal(validateWseOrder(raw, bound, "PAPER", ticket, now).ok, false));
for (const patch of [{ quantity: 0.5 }, { orderType: "MKT" }, { side: "SELL" }, { trailingStopPct: 1 }, { takeProfit: 90 }, { entry: NaN }]) test(`unsupported shape ${JSON.stringify(patch)}`, () => assert.equal(validateWseOrder(fixture(), bound, "PAPER", { ...ticket, ...patch } as SignalTicket, now).ok, false));
test("close is single exact limit with no bracket", () => {
  const close: SignalTicket = { ...ticket, side: "SELL", positionEffect: "CLOSE_OR_REDUCE", stop: undefined, takeProfit: undefined };
  assert.equal(validateWseOrder(fixture(), bound, "PAPER", close, now).ok, true);
  assert.equal(validateWseOrder(fixture(), bound, "PAPER", { ...close, stop: 99 }, now).ok, false);
});
for (const [stamp, allowed] of [
  ["2026-09-24T07:04:59Z", false], ["2026-09-24T07:05:00Z", true], ["2026-09-24T14:44:59Z", true], ["2026-09-24T14:45:00Z", false],
  ["2026-01-15T08:05:00Z", true], ["2026-01-15T07:05:00Z", false], ["2026-09-26T12:00:00Z", false],
] as const) test(`Warsaw DST and window ${stamp}`, () => {
  const time = Date.parse(stamp); const m = wseMetadataFixture(bound, "PAPER", time); m.timeZoneId = "Poland";
  const result = validateWseOrder(m, bound, "PAPER", ticket, time); assert.equal(result.ok, allowed);
  if (result.ok && stamp === "2026-09-24T14:44:59Z") assert.equal(result.expiresAtMs, time + 1000);
});
test("broker interval end fences expiry and gap denies", () => {
  const m = fixture(); m.liquidHours = "20260924:0900-20260924:1401,1500-20260924:1700";
  const time = now + 59000; m.requestStartedAtMs = time - 100; m.receivedAtMs = time - 50;
  const result = validateWseOrder(m, bound, "PAPER", ticket, time); assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.expiresAtMs, now + 60000);
  m.requestStartedAtMs = now + 60000; m.receivedAtMs = now + 60000;
  assert.equal(validateWseOrder(m, bound, "PAPER", ticket, now + 60000).ok, false);
});
test("metadata result is an immutable detached snapshot", () => {
  const m = fixture(); const result = validateWseOrder(m, bound, "PAPER", ticket, now); assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.isFrozen(result.metadata), true); assert.equal(Object.isFrozen(result.metadata.priceIncrements), true); assert.equal(Object.isFrozen(result.metadata.priceIncrements[0]), true);
  m.priceIncrements[0].increment = 100; assert.equal(result.metadata.priceIncrements[0].increment, 0.01);
});
test("pinned registry identity cannot be replaced by a self-consistent forged binding and metadata", () => {
  const forged = { ...bound, instrument: { ...bound.instrument, conId: 123 } };
  assert.equal(validateWseOrder(fixture(), forged, "PAPER", ticket, now).ok, false);
});
