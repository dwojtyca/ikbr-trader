import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalTicket } from "@ikbr/shared";
import type { PreparedBrokerOrder } from "../tws-execution-client.js";
import { deriveParentOrderRef } from "../reconciliation/order-ref.js";
import { fixture, nowMs } from "./close-test-fixture.js";
import { assessCloseRisk, validatePreparedClose } from "./close-risk.js";
function setup() {
  const f = fixture();
  const context = { ...f.context, accountId: "DU_TEST", clientId: 7, generation: 1 };
  const ticket: SignalTicket = { instrument: "TEST", instrumentId: "test", conid: "123", side: "SELL", quantity: 1,
    entry: 100, orderType: "LMT", positionEffect: "CLOSE_OR_REDUCE", reason: "close", confidence: 1,
    riskCheckStatus: "PASS", timestamp: new Date(nowMs).toISOString() };
  const quote = { conid: "123", bid: 100, ask: 100.1, marketDataType: 1,
    bidObservedAt: new Date(nowMs - 100).toISOString(), askObservedAt: new Date(nowMs - 100).toISOString() };
  const watchlist = { connected: true, watchlist: [{ instrumentId: "test", conid: "123", subscribed: true, marketState: quote }] };
  const bound = f.context.bound!;
  const assess = () => assessCloseRisk(ticket, bound, context, watchlist);
  const ref = deriveParentOrderRef("close-test");
  const prepared: PreparedBrokerOrder = { contract: { symbol: "TEST", conId: 123, secType: "STK", currency: "USD", exchange: "SMART" },
    normalizedTicket: { ...ticket }, legs: [{ role: "PARENT", roleOrdinal: 0, brokerOrderId: "200", orderRef: ref }],
    plan: { parentOrderId: 200, relatedOrderIds: new Set([200]), orders: [{ orderId: 200, order: {
      action: "SELL", totalQuantity: 1, orderType: "LMT", lmtPrice: 100, tif: "DAY", account: "DU_TEST", transmit: true, orderRef: ref } }] } };
  const validate = () => validatePreparedClose(prepared, ticket, "DU_TEST", "close-test", bound);
  return { ...f, context, ticket, quote, watchlist, bound, assess, prepared, validate };
}
test("SELL risk uses live bid and persists immutable identity plus quote expiry", () => {
  const f = setup(), risk = f.assess(); assert.equal(risk.ok, true); assert.equal(risk.expiresAt, new Date(nowMs + 9900).toISOString());
  assert.equal(f.validate(), null);
});
for (const [name, mutate] of [
  ["BUY", (f: ReturnType<typeof setup>) => { f.ticket.side = "BUY"; }],
  ["market", f => { f.ticket.orderType = "MKT"; }],
  ["fraction", f => { f.ticket.quantity = .5; }],
  ["multi", f => { f.ticket.quantity = 2; }],
  ["bracket", f => { f.ticket.stop = 99; }],
  ["entry effect", f => { f.ticket.positionEffect = "OPEN_OR_ADD"; }],
  ["off tick", f => { f.ticket.entry = 100.001; }],
  ["tick mismatch", f => { Object.assign(f.bound, { minTick: .05 }); }],
  ["wrong quote conid", f => { f.quote.conid = "99"; }],
  ["delayed", f => { f.quote.marketDataType = 3; }],
  ["stale", f => { f.quote.bidObservedAt = new Date(nowMs - 10000).toISOString(); }],
  ["future", f => { f.quote.askObservedAt = new Date(nowMs + 1).toISOString(); }],
  ["crossed", f => { f.quote.ask = 99; }],
  ["wide", f => { f.quote.ask = 102; }],
  ["slippage", f => { f.ticket.entry = 98; }],
  ["disconnected", f => { f.watchlist.connected = false; }],
  ["duplicate", f => { f.watchlist.watchlist.push(f.watchlist.watchlist[0]); }],
  ["outsideRth policy", f => { Object.assign(f.bound.instrument.executionPolicy!, { outsideRth: true }); }],
] as Array<[string, (f: ReturnType<typeof setup>) => void]>) test(`close risk rejects ${name}`, () => {
  const f = setup(); mutate(f); assert.equal(f.assess().ok, false);
});
for (const [name, mutate] of [
  ["normalized price", (f: ReturnType<typeof setup>) => { f.prepared.normalizedTicket.entry = 99; }],
  ["normalized instrumentId", f => { f.prepared.normalizedTicket.instrumentId = "other"; }],
  ["contract", f => { f.prepared.contract.conId = 999; }],
  ["extra order", f => { f.prepared.plan.orders.push(f.prepared.plan.orders[0]); }],
  ["extra ID", f => { f.prepared.plan.relatedOrderIds.add(201); }],
  ["wire quantity", f => { f.prepared.plan.orders[0].order.totalQuantity = 2; }],
  ["wire price", f => { f.prepared.plan.orders[0].order.lmtPrice = 99; }],
  ["wire account", f => { f.prepared.plan.orders[0].order.account = "OTHER"; }],
  ["wire action", f => { f.prepared.plan.orders[0].order.action = "BUY"; }],
  ["wire ref", f => { f.prepared.plan.orders[0].order.orderRef = "bad"; }],
  ["wire parent", f => { f.prepared.plan.orders[0].order.parentId = 1; }],
  ["wire OCA", f => { f.prepared.plan.orders[0].order.ocaGroup = "bad"; }],
  ["wire TIF", f => { f.prepared.plan.orders[0].order.tif = "GTC"; }],
  ["wire algo", f => { f.prepared.plan.orders[0].order.algoStrategy = "Adaptive"; }],
  ["wire orderId", f => { f.prepared.plan.orders[0].orderId = 201; }],
] as Array<[string, (f: ReturnType<typeof setup>) => void]>) test(`prepared close rejects ${name}`, () => {
  const f = setup(); mutate(f); assert.notEqual(f.validate(), null);
});
