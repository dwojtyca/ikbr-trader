import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsExecutionClient } from "./tws-execution-client.js";

class FakeIb extends EventEmitter {
  requested: string[] = [];
  connect(): void { queueMicrotask(() => this.emit("nextValidId", 1)); }
  reqAccountUpdates(subscribe: boolean, account: string): void {
    if (subscribe) this.requested.push(account);
  }
}
function makeClient(ib: FakeIb): TwsExecutionClient {
  return new TwsExecutionClient({ host: "unused", port: 0, clientId: 1,
    securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
  () => {}, undefined, undefined, undefined, { ib });
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("account evidence waits for matching completion and preserves explicit USD metrics", async () => {
  const ib = new FakeIb();
  const client = makeClient(ib);
  const before = Date.now();
  const pending = client.getAccountSnapshot("PAPER_TEST");
  let settled = false;
  void pending.then(() => { settled = true; });
  await turn();
  for (const [key, value] of [["NetLiquidation", "10000"], ["AvailableFunds", "4000"], ["GrossPositionValue", "1000"]]) {
    ib.emit("updateAccountValue", key, value, "USD", "PAPER_TEST");
    ib.emit("updateAccountValue", key, "99999", "BASE", "PAPER_TEST");
    ib.emit("updateAccountValue", key, "88888", "USD", "OTHER");
  }
  ib.emit("accountDownloadEnd", "OTHER");
  await turn();
  assert.equal(settled, false);
  await assert.rejects(client.getAccountSnapshot("PAPER_TEST"), /already in flight/);
  ib.emit("accountDownloadEnd", "PAPER_TEST");
  const snapshot = await pending;
  assert.equal(snapshot.riskEvidence?.complete, true);
  assert.deepEqual(snapshot.riskEvidence?.usdMetrics, { netLiquidation: 10000, availableFunds: 4000, grossPositionValue: 1000 });
  assert.ok(Date.parse(snapshot.riskEvidence!.requestStartedAt) >= before);
  assert.ok(Date.parse(snapshot.riskEvidence!.completedAt) <= Date.now());
  assert.equal(ib.listenerCount("accountDownloadEnd"), 0);
  assert.equal(ib.requested.length, 1);
});

test("BASE, missing, empty and IB unset values cannot become execution USD evidence", async () => {
  const ib = new FakeIb();
  const client = makeClient(ib);
  for (const invalid of [undefined, "", "NaN", "Infinity", "1.7976931348623157e308"]) {
    const pending = client.getAccountSnapshot("PAPER_TEST");
    await turn();
    for (const key of ["NetLiquidation", "AvailableFunds", "GrossPositionValue"]) {
      ib.emit("updateAccountValue", key, "10000", "BASE", "PAPER_TEST");
      if (invalid !== undefined) ib.emit("updateAccountValue", key, invalid, "USD", "PAPER_TEST");
    }
    ib.emit("accountDownloadEnd", "PAPER_TEST");
    assert.deepEqual((await pending).riskEvidence?.usdMetrics, {
      netLiquidation: undefined, availableFunds: undefined, grossPositionValue: undefined,
    });
  }
});

test("currency evidence preserves explicit raw FX direction and matching-account cash only", async () => {
  const ib = new FakeIb(); const client = makeClient(ib);
  const pending = client.getAccountSnapshot("PAPER_TEST"); await turn();
  for (const [key, value, currency] of [
    ["ExchangeRate", "1", "USD"], ["ExchangeRate", "0.25", "PLN"],
    ["ExchangeRate", "1.2", "EUR"], ["CashBalance", "500", "PLN"],
    ["CashBalance", "-10", "GBP"], ["ExchangeRate", "1", "BASE"],
    ["CashBalance", "999999", ""],
  ]) ib.emit("updateAccountValue", key, value, currency, "PAPER_TEST");
  ib.emit("updateAccountValue", "CashBalance", "999999", "PLN", "FOREIGN");
  ib.emit("accountDownloadEnd", "PAPER_TEST");
  const evidence = (await pending).riskEvidence!;
  assert.deepEqual(evidence.exchangeRatesToBase, { USD: 1, PLN: .25, EUR: 1.2 });
  assert.deepEqual(evidence.cashByCurrency, { PLN: 500, GBP: -10 });
  const next = client.getAccountSnapshot("PAPER_TEST"); await turn();
  ib.emit("accountDownloadEnd", "PAPER_TEST");
  assert.deepEqual((await next).riskEvidence?.exchangeRatesToBase, {});
  assert.deepEqual((await next).riskEvidence?.cashByCurrency, {});
});

test("invalid latest currency data cannot preserve an earlier valid value", async () => {
  const ib = new FakeIb(); const client = makeClient(ib);
  for (const invalid of ["", " ", "NaN", "Infinity", "1.7976931348623157e308", "0x20", "1_000", "1,2"]) {
    const pending = client.getAccountSnapshot("PAPER_TEST"); await turn();
    for (const key of ["ExchangeRate", "CashBalance"]) {
      ib.emit("updateAccountValue", key, "100", "PLN", "PAPER_TEST");
      ib.emit("updateAccountValue", key, invalid, "PLN", "PAPER_TEST");
    }
    ib.emit("accountDownloadEnd", "PAPER_TEST");
    const evidence = (await pending).riskEvidence!;
    assert.deepEqual(evidence.exchangeRatesToBase, {}, invalid);
    assert.deepEqual(evidence.cashByCurrency, {}, invalid);
  }
});
