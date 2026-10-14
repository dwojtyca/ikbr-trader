import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WshSocketTransport, loadWshRuntimeConfiguration, type WshEventRequest, type WshLocalSocket } from "./research-wsh-transport.js";

const options = { enabled: true, endpointId: "fixture", host: "127.0.0.1", port: 7497, clientId: 97, accountId: "DU_FIXTURE" };
const request: WshEventRequest = { conId: 123, filter: "", fillWatchlist: false, fillPortfolio: false, fillCompetitors: false,
  startDate: "20261001", endDate: "20261125", totalLimit: 100 };
const deadline = () => new Date(Date.now() + 1000).toISOString();
class LocalSocket extends EventEmitter implements WshLocalSocket {
  closed = false; destroyed = false; destroys = 0;
  destroy() { this.destroys++; this.destroyed = true; this.close(); }
  close() { this.closed = true; this.emit('close'); }
}
class Socket extends EventEmitter {
  local = new LocalSocket();
  localSocket = (): WshLocalSocket | null => this.local;
  serverVersion = 193;
  disconnected = 0;
  requests: number[] = [];
  cancellations: string[] = [];
  reqCancelWshMetaData(id: number) { this.cancellations.push(`metadata:${id}`); this.emit("sent", [101, id]); }
  reqCancelWshEventData(id: number) { this.cancellations.push(`events:${id}`); this.emit("sent", [103, id]); }
  autoReply = true;
  account = "DU_FIXTURE";
  connect() { this.emit("managedAccounts", this.account); this.emit("nextValidId", 1); }
  disconnect() { this.disconnected++; this.emit("disconnected"); this.local.destroy(); }
  reqWshMetaData(id: number) { this.requests.push(id); if (this.autoReply) this.emit("wshMetaData", id, '{"meta_data":{}}'); }
  reqWshEventData(id: number) { this.requests.push(id); if (this.autoReply) this.emit("wshEventData", id, "[]"); }
}

test("WSH runtime is disabled by default and requires an explicit dedicated endpoint/client", () => {
  assert.equal(loadWshRuntimeConfiguration({}).enabled, false);
  for (const env of [{ RESEARCH_WSH_ENABLED: "yes" }, { RESEARCH_WSH_ENABLED: "true" },
    { RESEARCH_WSH_ENABLED: "true", RESEARCH_WSH_ENDPOINT_ID: "test", IB_SOCKET_PORT: "7497", RESEARCH_WSH_CLIENT_ID: "0" }])
    assert.throws(() => loadWshRuntimeConfiguration(env), /RUNTIME_INVALID/);
  assert.equal(loadWshRuntimeConfiguration({ RESEARCH_WSH_ENABLED: "true", RESEARCH_WSH_ENDPOINT_ID: "test", IB_SOCKET_PORT: "7497", RESEARCH_WSH_CLIENT_ID: "97" }).port, 7497);
});

test("transport validates account/protocol and metadata precedes event request", async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline());
  await assert.rejects(transport.events(2, request, deadline(), 100), /REQUEST_INVALID/);
  await transport.metadata(1, deadline(), 100);
  assert.equal(await transport.events(2, request, deadline(), 100), "[]");
  assert.deepEqual(socket.requests, [1, 2]);
  await assert.rejects(transport.events(2, request, deadline(), 100), /TRANSPORT_UNAVAILABLE/);
  await transport.close(); assert.equal(socket.disconnected, 1);
  assert.deepEqual(socket.cancellations, ["events:2", "metadata:1"]);
  assert.equal("placeOrder" in transport, false);
  for (const kind of ["account", "protocol"] as const) {
    const bad = new Socket(); if (kind === "account") bad.account = "U_OTHER"; else bad.serverVersion = 172;
    const client = new WshSocketTransport(options, () => bad);
    await assert.rejects(client.connect(deadline()), /ACCOUNT_MISMATCH|PROTOCOL_UNSUPPORTED/);
    await client.close();
    assert.equal(bad.requests.length, 0); assert.equal(bad.disconnected, 1);
  }
});

test("wrong IDs cannot satisfy a call; timeout retires local client and late callback cannot revive it", async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline()); socket.autoReply = false;
  const promise = transport.metadata(1, new Date(Date.now() + 30).toISOString(), 100);
  socket.emit("wshMetaData", 8, "{}");
  await assert.rejects(promise, error => {
    assert.equal((error as Error).message, 'RESEARCH_WSH_TIMEOUT');
    assert.deepEqual((error as any).sourceError, { name: 'WshTimeoutError', code: 'RESEARCH_WSH_TIMEOUT', message: 'Local WSH metadata deadline expired' });
    assert.equal((error as any).providerError, undefined);
    return true;
  }); await transport.close(); assert.equal(socket.disconnected, 1);
  socket.emit("wshMetaData", 1, "{}");
  await assert.rejects(transport.metadata(2, deadline(), 100), /TIMEOUT/);
  const next = new WshSocketTransport(options, () => new Socket());
  assert.notEqual(next.sessionId, transport.sessionId); await next.connect(deadline()); await next.metadata(1, deadline(), 100); await next.close();
});

test("correlated errors, disconnection and oversized data produce no usable receipt", async () => {
  for (const kind of ["error", "disconnect", "bytes"] as const) {
    const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
    await transport.connect(deadline()); socket.autoReply = false;
    const promise = transport.metadata(1, deadline(), 20);
    if (kind === "error") socket.emit("error", new Error("private provider text"), 10304, 1);
    if (kind === "disconnect") socket.emit("disconnected");
    if (kind === "bytes") socket.emit("wshMetaData", 1, "é".repeat(11));
    await assert.rejects(promise, /RESEARCH_WSH_ERROR_10304|DISCONNECTED|PAYLOAD_LIMIT/);
    await transport.close(); assert.equal(socket.disconnected, 1);
  }
});

test("serial request IDs, duplicate callbacks and absolute deadlines do not cause duplicate send", async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline()); socket.autoReply = false;
  const pending = transport.metadata(1, deadline(), 100);
  await assert.rejects(transport.metadata(2, deadline(), 100), /TRANSPORT_UNAVAILABLE/);
  socket.emit("wshMetaData", 1, "{}"); socket.emit("wshMetaData", 1, "{}"); await pending;
  await assert.rejects(transport.events(3, request, new Date(Date.now() - 1).toISOString(), 100), /DEADLINE_INVALID/);
  assert.deepEqual(socket.requests, [1]); await transport.close();
});


test("abort cancels only attempted owned requests exactly once and ignores late errors", async () => {
  for (const stage of ["before", "connect", "metadata", "events"] as const) {
    const controller = new AbortController(), socket = new Socket();
    if (stage === "before") controller.abort();
    if (stage === "connect") socket.connect = () => {};
    const transport = new WshSocketTransport({ ...options, signal: controller.signal }, () => socket);
    if (stage === "before") await assert.rejects(transport.connect(deadline()), /ABORTED/);
    else {
      let pending: Promise<unknown> = transport.connect(deadline());
      if (stage !== "connect") {
        await pending;
        if (stage === "events") await transport.metadata(11, deadline(), 100);
        socket.autoReply = false;
        pending = stage === "metadata" ? transport.metadata(11, deadline(), 100) : transport.events(22, request, deadline(), 100);
      }
      controller.abort();
      await assert.rejects(pending, /ABORTED/);
    }
    await Promise.all([transport.close(), transport.close()]);
    assert.equal(socket.disconnected, 1);
    assert.deepEqual(socket.cancellations, stage === "events" ? ["events:22", "metadata:11"] : stage === "metadata" ? ["metadata:11"] : []);
    socket.emit("wshMetaData", 11, "{}"); socket.emit("error", new Error("late"), 502, -1);
    await assert.rejects(transport.metadata(33, deadline(), 100), /ABORTED/);
  }
});

test("provider diagnostics retain original code/text with explicit account/secret redaction", async () => {
  for (const code of [502, 10281]) {
    const socket = new Socket(), transport = new WshSocketTransport({ ...options, secrets: ["private-key"] }, () => socket);
    await transport.connect(deadline()); socket.autoReply = false;
    const pending = transport.metadata(7, deadline(), 100);
    socket.emit("error", Object.assign(new Error("Duplicate WSH DU_FIXTURE private-key\n\u001b[31m"), { name: 'ProviderSocketError' }), code, code === 502 ? -1 : 7);
    await assert.rejects(pending, error => {
      assert.equal((error as Error).message, `RESEARCH_WSH_ERROR_${code}`);
      assert.deepEqual((error as any).providerError, { code, message: "Duplicate WSH [UKRYTO] [UKRYTO]\\u000a\\u001b[31m" });
      assert.deepEqual((error as any).sourceError, { name: 'ProviderSocketError', code: null, message: "Duplicate WSH [UKRYTO] [UKRYTO]\\u000a\\u001b[31m" });
      return true;
    });
    await transport.close();
  }
});

test("a cancellation exception cannot replace original failure or skip the remaining cancellation", async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline()); await transport.metadata(1, deadline(), 100);
  socket.autoReply = false;
  const pending = transport.events(2, request, deadline(), 100);
  socket.reqCancelWshEventData = id => { socket.cancellations.push(`events:${id}`); throw new Error("cancel failed"); };
  socket.emit("error", new Error("duplicate request"), 10281, 2);
  await assert.rejects(pending, /RESEARCH_WSH_ERROR_10281/);
  await transport.close();
  assert.deepEqual(socket.cancellations, ["events:2", "metadata:1"]);
  assert.equal(socket.disconnected, 1);
});

test("synchronous SDK exceptions retain original description without inventing a provider code", async () => {
  for (const phase of ["connect", "send"] as const) {
    const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
    const fail = () => { throw Object.assign(new Error("SDK refused DU_FIXTURE"), { name: 'SdkSocketError', ...(phase === 'send' ? { code: 502 } : {}) }); };
    if (phase === "connect") socket.connect = fail;
    else { await transport.connect(deadline()); socket.reqWshMetaData = fail; }
    await assert.rejects(phase === "connect" ? transport.connect(deadline()) : transport.metadata(41, deadline(), 100), error => {
      assert.equal((error as Error).message, phase === "connect" ? "RESEARCH_WSH_CONNECT_FAILED" : "RESEARCH_WSH_SEND_FAILED");
      assert.deepEqual((error as any).providerError, { code: null, message: "SDK refused [UKRYTO]" });
      assert.deepEqual((error as any).sourceError, { name: 'SdkSocketError', code: phase === 'send' ? 502 : null, message: 'SDK refused [UKRYTO]' });
      return true;
    });
    await transport.close();
    assert.deepEqual(socket.cancellations, phase === "connect" ? [] : ["metadata:41"]);
  }
});


test("global provider failure between awaits survives the next request and duplicate cleanup", async () => {
  for (const stage of ["metadata", "events"] as const) {
    const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
    await transport.connect(deadline());
    if (stage === "events") await transport.metadata(1, deadline(), 100);
    socket.emit("error", new Error("Connection lost DU_FIXTURE"), 502, -1);
    socket.emit("error", new Error("secondary duplicate error"), 10281, -1);
    await transport.close();
    await assert.rejects(stage === "metadata" ? transport.metadata(1, deadline(), 100) : transport.events(2, request, deadline(), 100), error => {
      assert.equal((error as Error).message, "RESEARCH_WSH_ERROR_502");
      assert.deepEqual((error as any).providerError, { code: 502, message: "Connection lost [UKRYTO]" }); return true;
    });
    assert.deepEqual(socket.requests, stage === "metadata" ? [] : [1]);
    assert.deepEqual(socket.cancellations, stage === "metadata" ? [] : ["metadata:1"]);
  }
});

for (const mode of ['peer-end', 'destroyed', 'disconnect-throw', 'identity-change', 'missing-capability'] as const) {
  test(`local cleanup cannot be confirmed from ${mode} without exact owned close proof`, async () => {
    const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
    await transport.connect(deadline());
    socket.disconnect = () => { socket.disconnected++; socket.emit('disconnected'); if (mode === 'disconnect-throw') throw new Error('private cleanup DU_FIXTURE'); };
    socket.local.destroy = () => { socket.local.destroyed = true; };
    if (mode === 'destroyed') socket.local.destroyed = true;
    if (mode === 'identity-change') socket.localSocket = () => new LocalSocket();
    if (mode === 'missing-capability') Object.assign(socket, { localSocket: undefined });
    const closing = transport.close();
    let settled = false; void closing.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(settled, false);
    const result = await closing;
    assert.equal(result.state, 'UNKNOWN'); assert.equal(result.localClosedAt, null);
    assert.equal(result.sessionId, transport.sessionId);
    assert.equal(result.verifiedLocalClosure, false);
    assert.equal(socket.disconnected, 1); assert.equal(socket.local.listenerCount('close'), 0);
    socket.local.close();
    assert.deepEqual(await transport.close(), result);
    assert.doesNotMatch(JSON.stringify(result), /DU_FIXTURE/);
  });
}
test('actual delayed local close gates cleanup, peer end does not; duplicate close calls share receipt', async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline());
  socket.disconnect = () => { socket.disconnected++; socket.emit('disconnected'); };
  socket.local.destroy = () => { socket.local.destroyed = true; };
  const a = transport.close(), b = transport.close(); assert.equal(a, b);
  let settled = false; void a.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(settled, false);
  socket.local.close(); const result = await a;
  assert.equal(result.state, 'CONFIRMED'); assert.ok(result.localClosedAt); assert.equal(socket.disconnected, 1);
  assert.equal(result.sessionId, transport.sessionId);
  assert.equal(result.verifiedLocalClosure, true);
});
test('already closed exact socket qualifies, while verified no socket is NOT_NEEDED', async () => {
  for (const allocated of [true, false]) {
    const socket = new Socket(); if (allocated) socket.local.close(); else socket.localSocket = () => null;
    const transport = new WshSocketTransport(options, () => socket);
    const result = await transport.close(); assert.equal(result.state, allocated ? 'CONFIRMED' : 'NOT_NEEDED');
    assert.equal(result.sessionId, transport.sessionId);
    assert.equal(result.verifiedLocalClosure, allocated);
  }
});
test('cancellation throw retains original failure and makes cleanup UNKNOWN despite real local close', async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline()); await transport.metadata(1, deadline(), 100);
  socket.reqCancelWshMetaData = () => { throw new Error('cancel DU_FIXTURE failed'); };
  const result = await transport.close(); assert.equal(result.state, 'UNKNOWN'); assert.ok(result.localClosedAt);
  assert.equal(result.verifiedLocalClosure, true);
  assert.match(result.sourceError!.message!, /cancel/); assert.doesNotMatch(JSON.stringify(result), /DU_FIXTURE/);
});
test('a close timestamp from the original socket cannot prove stable closure after identity or capability loss', async () => {
  for (const mode of ['pointer', 'capability'] as const) {
    const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
    await transport.connect(deadline()); socket.local.close();
    if (mode === 'pointer') socket.localSocket = () => new LocalSocket();
    else Object.assign(socket, { localSocket: undefined });
    const result = await transport.close(); assert.ok(result.localClosedAt);
    assert.equal(result.state, 'UNKNOWN'); assert.equal(result.verifiedLocalClosure, false);
  }
});
