import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WshSocketTransport, loadWshRuntimeConfiguration, type WshEventRequest } from "./research-wsh-transport.js";

const options = { enabled: true, endpointId: "fixture", host: "127.0.0.1", port: 7497, clientId: 97, accountId: "DU_FIXTURE" };
const request: WshEventRequest = { conId: 123, filter: "", fillWatchlist: false, fillPortfolio: false, fillCompetitors: false,
  startDate: "20261001", endDate: "20261125", totalLimit: 100 };
const deadline = () => new Date(Date.now() + 1000).toISOString();
class Socket extends EventEmitter {
  serverVersion = 193;
  disconnected = 0;
  requests: number[] = [];
  autoReply = true;
  account = "DU_FIXTURE";
  connect() { this.emit("managedAccounts", this.account); this.emit("nextValidId", 1); }
  disconnect() { this.disconnected++; this.emit("disconnected"); }
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
  transport.close(); assert.equal(socket.disconnected, 1);
  assert.equal("placeOrder" in transport, false);
  for (const kind of ["account", "protocol"] as const) {
    const bad = new Socket(); if (kind === "account") bad.account = "U_OTHER"; else bad.serverVersion = 172;
    const client = new WshSocketTransport(options, () => bad);
    await assert.rejects(client.connect(deadline()), /ACCOUNT_MISMATCH|PROTOCOL_UNSUPPORTED/);
    assert.equal(bad.requests.length, 0); assert.equal(bad.disconnected, 1);
  }
});

test("wrong IDs cannot satisfy a call; timeout retires local client and late callback cannot revive it", async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline()); socket.autoReply = false;
  const promise = transport.metadata(1, new Date(Date.now() + 30).toISOString(), 100);
  socket.emit("wshMetaData", 8, "{}");
  await assert.rejects(promise, /TIMEOUT/); assert.equal(socket.disconnected, 1);
  socket.emit("wshMetaData", 1, "{}");
  await assert.rejects(transport.metadata(2, deadline(), 100), /TRANSPORT_UNAVAILABLE/);
  const next = new WshSocketTransport(options, () => new Socket());
  assert.notEqual(next.sessionId, transport.sessionId); await next.connect(deadline()); await next.metadata(1, deadline(), 100); next.close();
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
    assert.equal(socket.disconnected, 1);
  }
});

test("serial request IDs, duplicate callbacks and absolute deadlines do not cause duplicate send", async () => {
  const socket = new Socket(), transport = new WshSocketTransport(options, () => socket);
  await transport.connect(deadline()); socket.autoReply = false;
  const pending = transport.metadata(1, deadline(), 100);
  await assert.rejects(transport.metadata(2, deadline(), 100), /TRANSPORT_UNAVAILABLE/);
  socket.emit("wshMetaData", 1, "{}"); socket.emit("wshMetaData", 1, "{}"); await pending;
  await assert.rejects(transport.events(3, request, new Date(Date.now() - 1).toISOString(), 100), /DEADLINE_INVALID/);
  assert.deepEqual(socket.requests, [1]); transport.close();
});
