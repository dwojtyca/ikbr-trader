import test from "node:test";
import assert from "node:assert/strict";
import { IBApi } from "@stoqey/ib";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { WshSocketTransport, adaptWshSdkSocket, type WshEventRequest } from "./research-wsh-transport.js";

function frame(tokens: (string | number)[]): Buffer {
  const body = Buffer.from(tokens.join("\0") + "\0"), header = Buffer.alloc(4);
  header.writeInt32BE(body.length); return Buffer.concat([header, body]);
}
const request: WshEventRequest = { conId: 123, filter: "", fillWatchlist: false, fillPortfolio: false, fillCompetitors: false,
  startDate: "20261001", endDate: "20261125", totalLimit: 100 };

for (const stage of ["metadata", "events", "success", "timeout", "error", "peer-end", "cancel-error"] as const) {
  test(`installed SDK bounded owned cleanup: ${stage}`, { timeout: 5000 }, async () => {
    const trace: string[] = [];
    let peer: Socket | undefined;
    let requested!: () => void;
    const requestSeen = new Promise<void>(resolve => { requested = resolve; });
    let ended!: () => void;
    const closed = new Promise<void>(resolve => { ended = resolve; });
    const server = createServer(socket => {
      peer = socket;
      if (stage === 'cancel-error') socket.setNoDelay(true);
      let buffer = Buffer.alloc(0), handshake = false;
      socket.on("data", bytes => {
        buffer = Buffer.concat([buffer, bytes]);
        if (!handshake) {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(4);
          if (buffer.length < 8 + length) return;
          assert.equal(buffer.subarray(0, 4).toString(), "API\0");
          buffer = buffer.subarray(8 + length); handshake = true;
          socket.write(frame([180, "20261013 12:00:00"]));
        }
        while (buffer.length >= 4) {
          const length = buffer.readInt32BE();
          if (buffer.length < 4 + length) break;
          const tokens = buffer.subarray(4, 4 + length).toString().split("\0");
          buffer = buffer.subarray(4 + length);
          const code = Number(tokens[0]), id = Number(tokens[1]);
          if (code === 71) {
            socket.write(frame([15, 1, "DU_FIXTURE"])); socket.write(frame([9, 1, 1]));
          } else {
            trace.push(`${code}:${id}`);
            if (code === 100) {
              if (stage === "metadata" || stage === "timeout" || stage === "error" || stage === "peer-end") requested();
              else socket.write(frame([104, id, '{"meta_data":{}}']));
              if (stage === "error") socket.write(frame([4, 2, id, 10281, "Duplicate WSH metadata request"]));
              if (stage === "peer-end") socket.end();
            }
            if (code === 102) {
              requested();
              if (stage === "success") socket.write(frame([105, id, "[]"]));
              if (stage === 'cancel-error') socket.write(frame([4, 2, id, 10281, 'Duplicate WSH event data request', '']));
            }
            if (code === 49) socket.write(frame([49, 1, 1790000000]));
            if (code === 103 && stage === 'cancel-error') socket.write(frame([4, 2, id, 10284, 'Cancellation failed DU_FIXTURE', '']));
          }
        }
      });
      socket.on("end", () => { trace.push("end"); });
      socket.on("close", ended);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    const sdk = adaptWshSdkSocket(new IBApi({ host: "127.0.0.1", port, maxReqPerSec: 10 }));
    const disconnectProof: boolean[] = [];
    sdk.on('disconnected', () => { disconnectProof.push(sdk.localSocket?.()?.closed === true); });
    const transport = new WshSocketTransport({ enabled: true, endpointId: "loopback", host: "127.0.0.1", port,
      clientId: 97, accountId: "DU_FIXTURE", signal: controller.signal }, () => sdk);
    const deadline = () => new Date(Date.now() + (stage === "timeout" ? 100 : 1500)).toISOString();
    try {
      await transport.connect(deadline());
      let pending = transport.metadata(17, deadline(), 100);
      if (stage === "events" || stage === "success" || stage === 'cancel-error') { await pending; pending = transport.events(29, request, deadline(), 100); }
      const result = pending.then(value => ({ value }), error => ({ error }));
      await requestSeen;
      if (stage === "metadata" || stage === "events") controller.abort();
      const settled = await result;
      if (stage === "success") assert.deepEqual(settled, { value: "[]" });
      else assert.ok("error" in settled);
      const cleanup = await transport.close();
      assert.equal(cleanup.sessionId, transport.sessionId);
      assert.equal(cleanup.state, stage === 'peer-end' ? 'UNKNOWN' : 'CONFIRMED');
      assert.ok(cleanup.localClosedAt); assert.equal(sdk.localSocket?.()?.closed, true); await closed;
      assert.equal(cleanup.verifiedLocalClosure, true);
      if (stage === 'cancel-error') {
        assert.equal(('error' in settled ? settled.error as Error : null)?.message, 'RESEARCH_WSH_ERROR_10281');
        assert.deepEqual(cleanup.sourceError, { name: 'Error', code: 10284, message: 'Cancellation failed [UKRYTO]' });
      }
      if (stage === 'peer-end') {
        assert.equal(disconnectProof[0], false);
        assert.equal(trace[0], '100:17');
      } else assert.deepEqual(trace, stage === "events" || stage === "success" || stage === 'cancel-error'
        ? ["100:17", "102:29", "103:29", "101:17", "49:1", "end"] : ["100:17", "101:17", "49:1", "end"]);
    } finally { await transport.close(); peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test('installed SDK drains delayed cancellation before a same-client successor', { timeout: 8000 }, async () => {
  const trace: string[] = [], peers = new Set<Socket>();
  let sessionCount = 0, eventCount = 0, duplicateCount = 0, pendingWsh = false;
  const closures: Promise<void>[] = [];
  const server = createServer(socket => {
    peers.add(socket);
    const session = ++sessionCount;
    closures.push(new Promise(resolve => socket.once('close', () => { peers.delete(socket); resolve(); })));
    let buffer = Buffer.alloc(0), handshake = false, processing = Promise.resolve();
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (!handshake) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(4);
        if (buffer.length < 8 + length) return;
        buffer = buffer.subarray(8 + length); handshake = true;
        socket.write(frame([180, '20261103 12:00:00']));
      }
      while (buffer.length >= 4) {
        const length = buffer.readInt32BE();
        if (buffer.length < 4 + length) break;
        const tokens = buffer.subarray(4, 4 + length).toString().split('\0');
        buffer = buffer.subarray(4 + length);
        const code = Number(tokens[0]), id = Number(tokens[1]);
        if (code === 71) {
          assert.equal(Number(tokens[2]), 97);
          socket.write(frame([15, 1, 'DU_FIXTURE'])); socket.write(frame([9, 1, 1])); continue;
        }
        trace.push(`${session}:${code}:${id}`);
        if (code === 100) socket.write(frame([104, id, '{"meta_data":{}}']));
        if (code === 102) {
          eventCount++;
          if (pendingWsh) {
            duplicateCount++;
            socket.write(frame([4, 2, id, 10281, 'Duplicate WSH event data request', '']));
          } else {
            pendingWsh = true;
            if (session === 2) socket.write(frame([105, id, '[]']));
          }
        }
        if (code === 103) processing = new Promise(resolve => setTimeout(() => {
          // Model cancellation work abandoned by premature connection closure.
          if (!socket.destroyed) { pendingWsh = false; trace.push(`${session}:cancel-processed`); }
          resolve();
        }, 350));
        if (code === 49) void processing.then(() => {
          if (!socket.destroyed) { trace.push(`${session}:time-response`); socket.write(frame([49, 1, 1790000000])); }
        });
      }
    });
    socket.on('end', () => { trace.push(`${session}:end`); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const transports: WshSocketTransport[] = [];
  try {
    for (const session of [1, 2]) {
      const sdk = adaptWshSdkSocket(new IBApi({ host: '127.0.0.1', port, maxReqPerSec: 10 }));
      const transport = new WshSocketTransport({ enabled: true, endpointId: 'loopback', host: '127.0.0.1', port,
        clientId: 97, accountId: 'DU_FIXTURE' }, () => sdk);
      transports.push(transport);
      const deadline = () => new Date(Date.now() + 1500).toISOString();
      await transport.connect(deadline()); await transport.metadata(1, deadline(), 100);
      const result = transport.events(2, request, new Date(Date.now() + (session === 1 ? 150 : 1500)).toISOString(), 100);
      if (session === 1) await assert.rejects(result, /RESEARCH_WSH_TIMEOUT/);
      else assert.equal(await result, '[]');
      const cleanup = await transport.close(); await closures[session - 1];
      assert.equal(cleanup.state, 'CONFIRMED'); assert.equal(cleanup.sourceError, undefined);
      assert.equal(pendingWsh, false);
    }
    assert.equal(eventCount, 2); assert.equal(duplicateCount, 0);
    assert.deepEqual(trace, [1, 2].flatMap(session => [
      `${session}:100:1`, `${session}:102:2`, `${session}:103:2`, `${session}:101:1`, `${session}:49:1`,
      `${session}:cancel-processed`, `${session}:time-response`, `${session}:end`,
    ]));
  } finally {
    await Promise.all(transports.map(transport => transport.close()));
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
