/**
 * PR15 — FakeBrokerReconciliationAdapter behavioural tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeBrokerReconciliationAdapter } from "./fake-broker-adapter.js";

const now = new Date();

function req(overrides: Partial<Parameters<FakeBrokerReconciliationAdapter["capture"]>[0]> = {}) {
  return {
    accountId: "DU-1",
    sessionId: "sess-a",
    sessionStartedAt: new Date(now.getTime() - 60_000),
    safetyMarginMs: 300_000,
    sourceTimeoutMs: 8_000,
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("FakeBrokerReconciliationAdapter", () => {
  it("happy path with all sources yields exposureComplete && recoveryComplete", async () => {
    const adapter = new FakeBrokerReconciliationAdapter();
    adapter.configure({
      positions: [
        {
          accountId: "DU-1",
          symbol: "AAPL",
          conId: "123",
          position: 10,
        },
      ],
      openOrders: [],
      completedOrders: [],
      executions: [],
    });
    const snap = await adapter.capture(req());
    assert.equal(snap.exposureComplete, true);
    assert.equal(snap.recoveryComplete, true);
    assert.equal(snap.sourceCoverage.completedOrders.available, true);
  });

  it("completedOrders unsupported → exposureComplete=true, recoveryComplete=false", async () => {
    const adapter = new FakeBrokerReconciliationAdapter();
    adapter.configure({
      completedOrdersSupported: false,
      positions: [],
      openOrders: [],
      executions: [],
    });
    const snap = await adapter.capture(req());
    assert.equal(snap.exposureComplete, true);
    assert.equal(snap.recoveryComplete, false);
    assert.equal(snap.sourceCoverage.completedOrders.available, false);
    assert.equal(
      snap.sourceCoverage.completedOrders.reason,
      "unsupported_by_ib_module",
    );
  });

  it("timed-out positions source → exposureComplete=false", async () => {
    const adapter = new FakeBrokerReconciliationAdapter();
    adapter.configure({ failSource: "positions" });
    const snap = await adapter.capture(req());
    assert.equal(snap.exposureComplete, false);
    assert.equal(snap.sourceCoverage.positions.available, false);
    assert.equal(snap.sourceCoverage.positions.timedOut, true);
  });

  it("executions window predates broker limit → recoveryWindowComplete=false, exposureWindowComplete=true", async () => {
    const adapter = new FakeBrokerReconciliationAdapter();
    // Broker only keeps back to now-30s; the oldest ambiguous
    // execution_attempted_at is 10min old and we ask for it.
    adapter.configure({
      executionsWindowLimit: new Date(now.getTime() - 30_000),
    });
    const snap = await adapter.capture(
      req({
        oldestAmbiguousAttemptedAt: new Date(now.getTime() - 10 * 60_000),
      }),
    );
    assert.equal(snap.sourceCoverage.executions.window.exposureWindowComplete, true);
    assert.equal(snap.sourceCoverage.executions.window.recoveryWindowComplete, false);
    assert.equal(snap.exposureComplete, true);
    assert.equal(snap.recoveryComplete, false);
    assert.equal(
      snap.sourceCoverage.executions.reason,
      "window_predates_broker_limit",
    );
  });

  it("respects the abort signal — throws if aborted before capture", async () => {
    const adapter = new FakeBrokerReconciliationAdapter();
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () => adapter.capture(req({ abortSignal: ctrl.signal })),
      /aborted/,
    );
  });
});
