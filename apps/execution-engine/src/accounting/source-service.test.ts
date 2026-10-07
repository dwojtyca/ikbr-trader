import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AccountingSourceService } from "./source-service.js";
import type { AccountingSourceStore, SourceControl, SourceObservation } from "./source-store.js";
import type { AccountingSocket } from "./source-collector.js";
import type { SourceSettingsV1 } from "./types.js";
import { TwsExecutionClient, type BrokerExecutionFill } from "../tws-execution-client.js";
const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", environment: "paper", accountId: "TEST",
  endpoint: { host: "unused", port: 1 }, sourceClientId: 0, executionTimeZone: "UTC" };
test("overflow bounds retained jobs, holds durably, and leaves legacy persistence running", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let appended = 0, legacy = 0; const holds: Array<string | undefined> = [];
  const control: SourceControl = { source_id: "test", process_session_id: "test", connection_generation: 0, semantic_revision: 0,
    qualification_id: null, gap: true, hold: null, settings_hash: "a", lanes: { accounting: { received: 0, persisted: 0, pending: 0 }, execution: { received: 0, persisted: 0, pending: 0 } } };
  const store = { sourceId: "test", sessionId: "test", begin: async () => control, qualification: async () => null, latestValues: async () => [],
    append: async (o: SourceObservation) => { await blocked; appended++; return { control, value: o.value }; },
    gap: async (_generation: number, hold?: string) => { holds.push(hold); return { ...control, hold: hold ?? null }; } } as unknown as AccountingSourceStore;
  const socket = new EventEmitter() as EventEmitter & AccountingSocket;
  Object.assign(socket, { serverVersion: 178, connect: () => {}, disconnect: () => {}, reqManagedAccts: () => {}, reqCurrentTime: () => {}, reqExecutions: () => {} });
  const service = new AccountingSourceService(store, settings, "a", () => ({ connected: true, accountId: "TEST", sessionId: "test", generation: 1 }), () => socket);
  await service.initialize();
  for (let n = 0; n < 20_000; n++) service.observeCommission({ execId: String(n), currency: "USD", commission: 1, realizedPnL: 0 }, async () => { legacy++; });
  assert.equal(service.status().pending, 10_000); assert.equal(legacy, 20_000); assert.throws(() => service.assertCurrent(), /PERSISTENCE_FAILED/);
  release(); await assert.rejects(service.close(), /PERSISTENCE_FAILED/);
  assert.equal(appended, 10_000); assert.ok(holds.includes("ACCOUNTING_BUFFER_OVERFLOW"));
});
test("execution callback preserves raw broker timestamp and attribution", () => {
  const socket = new EventEmitter(); let fill: BrokerExecutionFill | undefined;
  new TwsExecutionClient({ host: "unused", port: 0, clientId: 1, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100,
    executionTimeZone: "Europe/Warsaw" }, () => {}, undefined, value => { fill = value; }, undefined, { ib: socket });
  socket.emit("execDetails", 1, { conId: 123, symbol: "TEST", secType: "STK", currency: "USD", exchange: "NASDAQ" },
    { execId: "test", orderId: -2, acctNumber: "TEST", permId: 345, clientId: 0, orderRef: "manual", side: "BOT", shares: 1, price: 100, time: "20260115 15:30:21" });
  assert.equal(fill?.rawExecutionTime, "20260115 15:30:21"); assert.equal(fill?.executedAt, "2026-01-15T14:30:21.000Z");
  assert.equal(fill?.permId, 345); assert.equal(fill?.orderRef, "manual"); assert.equal(fill?.orderId, -2);
});
