import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BoundInstrument, SignalTicket } from "@ikbr/shared";
import { TwsExecutionClient } from "./tws-execution-client.js";
import { fixture } from "./lifecycle/close-test-fixture.js";
import { wseMetadataFixture } from "./wse-market-rules.fixture.js";

class FakeIb extends EventEmitter {
  writes: number[] = [];
  connect() { queueMicrotask(() => this.emit("nextValidId", 20)); }
  disconnect() { this.emit("disconnected"); }
  placeOrder(id: number) { this.writes.push(id); queueMicrotask(() => this.emit("orderStatus", id, "Submitted", 0, 1, 0, id + 100, 0, 0, 4)); }
}
for (const present of [false, true]) test(`retained WSE close resolver handles ${present ? "disabled" : "removed"} current binding; entry never consults it`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-24T10:00:00Z") });
  const original = fixture().context.bound!;
  Object.assign(original, { exchange: "WSE", currency: "PLN" });
  Object.assign(original.instrument, { exchange: "WSE", currency: "PLN" });
  const current: BoundInstrument | undefined = present ? { ...original, instrument: { ...original.instrument, executionPolicy: undefined,
    trading: { monitoringEnabled: false, executionEnabled: false, signalGenerationEnabled: false, aiAnalysisEnabled: false } } } : undefined;
  let managementReads = 0, entryChecks = 0, metadataReads = 0;
  const ib = new FakeIb(), client = new TwsExecutionClient({ host: "fixture", port: 0, clientId: 4, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 }, () => {}, undefined, undefined, undefined, {
    ib, resolveBoundInstrument: () => current,
    resolveManagementInstrument: () => { managementReads++; return original; },
    assertEntryAllowed: async () => { entryChecks++; throw Error("CONFIG_DRIFT"); },
    loadWseMetadata: async bound => { metadataReads++; assert.equal(bound, original); return wseMetadataFixture(bound, "PAPER", Date.now()); },
  });
  t.after(() => client.disconnect());
  const close: SignalTicket = { instrumentId: original.instrumentId, conid: String(original.conId), instrument: original.brokerSymbol,
    positionEffect: "CLOSE_OR_REDUCE", side: "SELL", quantity: 1, entry: 100, orderType: "LMT", reason: "fixture", confidence: 1, riskCheckStatus: "PASS", timestamp: new Date().toISOString() };
  const prepared = await client.prepareBrokerOrderPlan(close, "PAPER", "DAY", { proposedOrderId: 42, clientOrderId: "fixture-close" });
  await client.dispatchPreparedClose(prepared, client.getConnectionGeneration(), Date.now() + 10000);
  assert.equal(entryChecks, 0); assert.ok(managementReads > 0); assert.equal(metadataReads, 1); assert.equal(ib.writes.length, 1);
  const oldManagementReads = managementReads;
  const entry = { ...close, side: "BUY" as const, positionEffect: "OPEN_OR_ADD" as const, stop: 99, takeProfit: 102 };
  await assert.rejects(() => client.prepareBrokerOrderPlan(entry, "PAPER", "DAY", { proposedOrderId: 43, clientOrderId: "fixture-entry" }), /CONFIG_DRIFT/);
  assert.equal(managementReads, oldManagementReads); assert.equal(metadataReads, 1); assert.equal(ib.writes.length, 1);
  assert.throws(() => client.dispatchPreparedClose({ ...prepared, normalizedTicket: entry }, client.getConnectionGeneration()), /CLOSE_POSITION_EFFECT_REQUIRED/);
  assert.equal(ib.writes.length, 1);
});
