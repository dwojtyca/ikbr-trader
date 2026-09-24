import { EventEmitter } from "node:events";
import { CompletedOrdersClient } from "./completed-orders-client.js";
import { IbBrokerReconciliationAdapter } from "./ib-broker-adapter.js";
import type { TwsExecutionClient } from "../tws-execution-client.js";
export const completedRecord = () => [
  { conId: 123, symbol: "TEST", secType: "STK", currency: "PLN", exchange: "WSE" },
  { account: "DU-TEST", permId: 987, action: "BUY", totalQuantity: 1, filledQuantity: 1, orderRef: "test-ref" },
  { status: "Filled", completedStatus: "Filled" },
] as const;
export class CompletedSocketFixture extends EventEmitter {
  connections = 0; disconnects = 0; requests: boolean[] = [];
  accounts = "DU-TEST";
  handle: () => void = () => this.emit("completedOrdersEnd");
  connect() { this.connections++; queueMicrotask(() => this.emit("nextValidId", 1)); }
  disconnect() { this.disconnects++; this.emit("disconnected"); }
  reqManagedAccts() { this.emit("managedAccounts", this.accounts); }
  reqCompletedOrders(apiOnly: boolean) { this.requests.push(apiOnly); this.handle(); }
}
export function completedFixture(socket = new CompletedSocketFixture()) {
  let generation = 1, connected = true, accounts = ["DU-TEST"];
  const tws = {
    getConnectionGeneration: () => generation, isConnected: () => connected, getManagedAccounts: async () => accounts,
    reqPositionsSnapshot: async () => ({ ok: true, endObserved: true, rows: [] }),
    reqAllOpenOrdersSnapshot: async () => ({ ok: true, endObserved: true, rows: [] }),
    reqExecutionsSnapshot: async () => ({ ok: true, endObserved: true, rows: [] }),
  } as unknown as TwsExecutionClient;
  const client = new CompletedOrdersClient({ host: "unused", port: 1, clientId: 120 }, { createSocket: () => socket });
  return { socket, client, adapter: new IbBrokerReconciliationAdapter(tws, client),
    reconnect: () => { generation++; }, disconnect: () => { connected = false; }, changeAccount: () => { accounts = ["OTHER"]; } };
}
export const captureRequest = () => ({ accountId: "DU-TEST", sessionId: "session", sessionStartedAt: new Date(),
  safetyMarginMs: 1000, sourceTimeoutMs: 1000, abortSignal: new AbortController().signal });
