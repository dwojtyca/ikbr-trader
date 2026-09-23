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
