import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsExecutionClient } from "./tws-execution-client.js";

const account = "PRIVATE_ACCOUNT_VALUE";
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
class FakeIb extends EventEmitter {
  requests: boolean[] = [];
  autoSent = true;
  throwSubscribe = false;
  connect(): void { queueMicrotask(() => this.emit("nextValidId", 1)); }
  disconnect(): void {}
  reqAccountUpdates(subscribe: boolean, id: string): void {
    this.requests.push(subscribe);
    if (subscribe && this.throwSubscribe) throw new Error("send failed");
    if (this.autoSent) this.emit("sent", [6, 2, subscribe ? 1 : 0, id], "PRIVATE_RAW_FRAME");
  }
}
function fixture(throwTrace = false) {
  const ib = new FakeIb(), logs: string[] = [];
  const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 1,
    securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
  line => { if (throwTrace && line.startsWith("execution account-update trace ")) throw new Error("logger failed"); logs.push(line); },
  undefined, undefined, undefined, { ib });
  const traces = () => logs.filter(l => l.startsWith("execution account-update trace ")).map(l => JSON.parse(l.slice("execution account-update trace ".length)));
  return { ib, client, logs, traces };
}

test("account trace distinguishes local sends, matching completion and later warning without leaking payloads", async () => {
  const { ib, client, logs, traces } = fixture();
  const pending = client.getAccountSnapshot(account); await turn();
  ib.emit("accountDownloadEnd", "OTHER");
  assert.equal(traces().length, 2);
  ib.emit("accountDownloadEnd", account); await pending;
  ib.emit("error", new Error("API client has been unsubscribed from account data."), { code: 2100, id: -1 });
  assert.deepEqual(traces().map(t => t.event), ["subscribe_invoked", "subscribe_sent", "download_end", "unsubscribe_invoked", "unsubscribe_sent", "broker_2100"]);
  const warning = traces().at(-1);
  assert.equal(warning.phase, "unsubscribe_sent"); assert.equal(warning.observedDuringSequence, 1);
  assert.ok(warning.sinceUnsubscribeSentMs >= 0); assert.ok(warning.sinceSubscribeSentMs >= warning.sinceUnsubscribeSentMs);
  assert.equal(traces()[3].cleanupReason, "download_end");
  assert.ok(logs.includes("execution TWS error code=2100 reqId=-1: API client has been unsubscribed from account data."));
  assert.deepEqual(ib.requests, [true, false]);
  assert.ok(!logs.join("\n").includes(account)); assert.ok(!logs.join("\n").includes("PRIVATE_RAW_FRAME"));
});

test("late wire notifications show observation context rather than fabricated broker request attribution", async () => {
  const { ib, client, traces } = fixture(); ib.autoSent = false;
  const first = client.getAccountSnapshot(account); await turn(); ib.emit("accountDownloadEnd", account); await first;
  ib.emit("sent", [6, 2, 0, account]);
  const second = client.getAccountSnapshot(account); await turn();
  ib.emit("sent", [6, 2, 0, account]);
  ib.emit("error", new Error("subscription replaced"), { code: 2100, id: -1 });
  assert.equal(traces().at(-1).observedDuringSequence, 2);
  assert.equal(traces().at(-1).phase, "unsubscribe_sent");
  assert.equal(traces().at(-1).sinceSubscribeSentMs, undefined);
  ib.emit("sent", [6, 2, 1, account]);
  ib.emit("error", new Error("account subscription rejected"), { code: 2101, id: -1 });
  assert.equal(traces().at(-1).event, "broker_2101"); assert.equal(traces().at(-1).phase, "subscribe_sent");
  ib.emit("accountDownloadEnd", account); await second;
});

for (const failure of ["timeout", "broker_error", "send_error"] as const) test(`account trace preserves ${failure} rejection and cleanup`, async t => {
  const { ib, client, traces } = fixture(); await client.connect();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  ib.throwSubscribe = failure === "send_error";
  const pending = client.getAccountSnapshot(account);
  const rejected = assert.rejects(pending, failure === "timeout" ? /Timed out/ : failure === "broker_error" ? /original failure.*502/ : /send failed/);
  await turn();
  if (failure === "timeout") t.mock.timers.tick(10001);
  if (failure === "broker_error") ib.emit("error", new Error("original failure"), { code: 502, id: -1 });
  await rejected;
  assert.deepEqual(ib.requests, [true, false]);
  assert.equal(traces().find(t => t.event === "unsubscribe_invoked").cleanupReason, failure);
  assert.equal(ib.listenerCount("accountDownloadEnd"), 0);
});

for (const transition of ["manual_disconnect", "disconnected", "connected", "nextValidId"] as const) test(`account trace cannot reuse previous generation after ${transition}`, async () => {
  const { ib, client, traces } = fixture();
  const first = client.getAccountSnapshot(account); await turn(); ib.emit("accountDownloadEnd", account); await first;
  const generation = traces().at(-1).generation;
  if (transition === "manual_disconnect" || transition === "nextValidId") client.disconnect();
  else ib.emit(transition);
  if (transition === "nextValidId") await client.connect();
  ib.emit("error", new Error("subscription replaced"), { code: 2100, id: -1 });
  const warning = traces().at(-1);
  assert.ok(warning.generation > generation);
  for (const key of ["observedDuringSequence", "snapshotElapsedMs", "sinceSubscribeSentMs", "sinceUnsubscribeSentMs", "phase"]) assert.equal(warning[key], undefined, key);
});

test("new snapshot resets old connection wire timing even without an intervening warning", async () => {
  const { ib, client, traces } = fixture();
  const first = client.getAccountSnapshot(account); await turn(); ib.emit("accountDownloadEnd", account); await first;
  client.disconnect(); ib.autoSent = false;
  const second = client.getAccountSnapshot(account); await turn();
  assert.equal(traces().at(-1).sinceUnsubscribeSentMs, undefined);
  assert.equal(traces().at(-1).sinceSubscribeSentMs, undefined);
  ib.emit("accountDownloadEnd", account); await second;
});

test("unrelated or malformed sent frames are ignored and throwing trace logger cannot prevent snapshot completion", async () => {
  const { ib, traces } = fixture();
  for (const tokens of [null, {}, [], [6], [6, 2, 3, account], [6, 2, true, account], [6, 1, 1, account], [6, 2, 1, account, "extra"], [7, 2, 1, account], ["6", 2, 1, account]]) ib.emit("sent", tokens, "PRIVATE_RAW_FRAME");
  assert.equal(traces().length, 0);
  const throwing = fixture(true);
  const pending = throwing.client.getAccountSnapshot(account); await turn();
  throwing.ib.emit("accountDownloadEnd", account);
  assert.equal((await pending).riskEvidence?.complete, true);
  assert.deepEqual(throwing.ib.requests, [true, false]);
});
