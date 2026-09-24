import type { AccountSnapshot } from "./tws-execution-client.js";
import type { ZeroDayContext, ZeroDayRows } from "./daily-loss-evidence.js";
export function zeroDayFixture() {
  const now = Date.now(), time = new Date(now - 1000).toISOString(), start = new Date(now); start.setUTCHours(0,0,0,0);
  const source = { available: true, boundedWindow: true, timedOut: false, count: 0 };
  const coverage = { positions: source, openOrders: source, session: { ...source, count: 1 }, completedOrders: source,
    executions: { available: true, timedOut: false, count: 0, window: { from: start.toISOString(), to: time, exposureWindowComplete: true, recoveryWindowComplete: true } } };
  const snapshot = { accountId: "DU-ZERO", sessionId: "session", capturedAt: time, exposureComplete: true, recoveryComplete: true,
    connectionGeneration: 1, sourceCoverage: coverage, positions: [], openOrders: [], completedOrders: [], executions: [] };
  const run = { id: 1, account_id: "DU-ZERO", session_id: "session", completed_at: time, snapshot_complete: true, status: "CLEAN", position_generation: "1", source_coverage: coverage, broker_snapshot: snapshot };
  const sync = { account_id: "DU-ZERO", session_id: "session", complete: true, generation: "1", observed_at: time };
  const accountSnapshot = { accountId: "DU-ZERO", riskEvidence: { requestStartedAt: time, completedAt: time, complete: true, connectionGeneration: 1,
    realizedPnlByCurrency: { USD: 0 }, usdMetrics: { netLiquidation: 10000 } } } as unknown as AccountSnapshot;
  const ctx: ZeroDayContext = { accountId: "DU-ZERO", sessionId: "session", connectionGeneration: 1, now, lastBrokerFillObservedAt: 0, accountSnapshot };
  return { rows: { local_count: 0, run, sync } satisfies ZeroDayRows, ctx, run, sync, snapshot, coverage, accountSnapshot };
}
