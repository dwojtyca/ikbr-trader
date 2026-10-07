import { test } from "node:test";
import assert from "node:assert/strict";
import { IbBrokerReconciliationAdapter } from "../reconciliation/ib-broker-adapter.js";
import type { TwsExecutionClient } from "../tws-execution-client.js";
import type { AccountingJoin } from "./types.js";
import type { BrokerReconciliationCaptureRequest } from "../reconciliation/broker-adapter.js";
test("production adapter binds source join to this run/generation and retains exit snapshot when accounting fails", async () => {
  const tws = { isConnected: () => true, getConnectionGeneration: () => 3, getManagedAccounts: async () => ["TEST"],
    reqPositionsSnapshot: async () => ({ ok: true, rows: [] }), reqAllOpenOrdersSnapshot: async () => ({ ok: true, rows: [] }),
    reqExecutionsSnapshot: async () => ({ ok: true, rows: [], endObserved: true }) } as unknown as TwsExecutionClient;
  const completed = { load: async () => ({ ok: true as const, rows: [], endObserved: true }) };
  const request: BrokerReconciliationCaptureRequest = { accountId: "TEST", sessionId: "session", sessionStartedAt: new Date(), safetyMarginMs: 1000,
    sourceTimeoutMs: 100, abortSignal: new AbortController().signal, reconciliationRunId: 71, positionGeneration: 8 };
  let calls = 0;
  const join: AccountingJoin = { join: async (snapshot, input) => {
    calls++; assert.equal(input.runId, 71); assert.equal(input.positionGeneration, 8); assert.equal(snapshot.connectionGeneration, 3);
    assert.equal(snapshot.exposureComplete, true); assert.equal(snapshot.recoveryComplete, true);
    return { ...snapshot, capturedAt: new Date(123) };
  } };
  const positive = await new IbBrokerReconciliationAdapter(tws, completed, join).capture(request);
  assert.equal(calls, 1); assert.equal(positive.capturedAt.getTime(), 123);
  const absent = await new IbBrokerReconciliationAdapter(tws, completed, join).capture({ ...request, reconciliationRunId: undefined });
  assert.equal(calls, 1); assert.equal(absent.accounting, undefined);
  const failed = await new IbBrokerReconciliationAdapter(tws, completed, { join: async () => { throw new Error("ACCOUNTING_SOURCE_GAP"); } }).capture(request);
  assert.equal(failed.exposureComplete, true); assert.equal(failed.recoveryComplete, true); assert.equal(failed.accounting, undefined);
});
