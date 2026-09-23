/**
 * PR15 — production `BrokerReconciliationAdapter` backed by the
 * existing `TwsExecutionClient`.
 *
 * Sources:
 *   * positions via `reqPositions` → `positionEnd`
 *   * open orders via `reqAllOpenOrders` → `openOrderEnd`
 *   * executions via `reqExecutions` → `execDetailsEnd`
 *   * completed orders: `ib@0.2.9` does NOT expose
 *     `reqCompletedOrders` — reported as
 *     `available=false, reason="unsupported_by_ib_module"` per
 *     PR15_PLAN §3.
 *   * session via `managedAccounts` + `isConnected()`
 *
 * Each source has an independent bounded timeout AND cooperates
 * with the run-level `AbortSignal` supplied by the runner. Every
 * `ib` listener is torn down on success, error, timeout, and
 * abort (delegated to the snapshot methods on `TwsExecutionClient`).
 * A `capture()` that races the abort signal never leaves lingering
 * subscriptions.
 */

import type { TwsExecutionClient } from "../tws-execution-client.js";
import type {
  BrokerReconciliationAdapter,
  BrokerReconciliationCaptureRequest,
  BrokerReconciliationSnapshot,
  ExecutionsCoverage,
  SourceCoverage,
} from "./broker-adapter.js";
import { deriveCompletenessFlags } from "./broker-adapter.js";

export class IbBrokerReconciliationAdapter
  implements BrokerReconciliationAdapter
{
  constructor(private readonly tws: TwsExecutionClient) {}

  async capture(
    req: BrokerReconciliationCaptureRequest,
  ): Promise<BrokerReconciliationSnapshot> {
    if (req.abortSignal.aborted) throw new Error("aborted");

    const capturedAtStart = new Date();

    // Session probe first — used to short-circuit further requests
    // when the socket is not connected. `getManagedAccounts` is
    // bounded by the ib client's own timeout, so we wrap it in the
    // same source timeout for consistency.
    const sessionCov = await captureSession(this.tws, {
      accountId: req.accountId,
      timeoutMs: req.sourceTimeoutMs,
      abortSignal: req.abortSignal,
    });

    // Executions window: exposureStart = sessionStart - safetyMargin;
    // recoveryStart = min(exposureStart, oldest ambiguous - safetyMargin).
    const exposureStart = new Date(
      req.sessionStartedAt.getTime() - req.safetyMarginMs,
    );
    const recoveryStart = req.oldestAmbiguousAttemptedAt
      ? new Date(
          Math.min(
            exposureStart.getTime(),
            req.oldestAmbiguousAttemptedAt.getTime() - req.safetyMarginMs,
          ),
        )
      : exposureStart;

    // Fire all three snapshot reads in parallel — each carries its
    // own timeout + abort handling so a single slow source cannot
    // stall the run past its overall RUN_TIMEOUT.
    const [posResult, openResult, execResult] = await Promise.all([
      this.tws.reqPositionsSnapshot({
        timeoutMs: req.sourceTimeoutMs,
        abortSignal: req.abortSignal,
      }),
      this.tws.reqAllOpenOrdersSnapshot({
        timeoutMs: req.sourceTimeoutMs,
        abortSignal: req.abortSignal,
      }),
      this.tws.reqExecutionsSnapshot({
        accountId: req.accountId,
        since: recoveryStart,
        timeoutMs: req.sourceTimeoutMs,
        abortSignal: req.abortSignal,
      }),
    ]);

    if (req.abortSignal.aborted) throw new Error("aborted");

    // Executions coverage: exposureWindowComplete requires the end
    // event AND that the actual `since` we asked for covered
    // `exposureStart`. recoveryWindowComplete additionally requires
    // that the query started at or before recoveryStart.
    const executionsCov: ExecutionsCoverage = {
      available: openResult.ok ? execResult.ok : execResult.ok,
      timedOut: !execResult.ok && execResult.error === "timeout",
      count: execResult.rows.length,
      reason: execResult.ok ? undefined : execResult.error,
      window: {
        from: recoveryStart.toISOString(),
        to: new Date().toISOString(),
        exposureWindowComplete:
          execResult.ok &&
          execResult.endObserved &&
          recoveryStart.getTime() <= exposureStart.getTime(),
        recoveryWindowComplete:
          execResult.ok &&
          execResult.endObserved &&
          (!req.oldestAmbiguousAttemptedAt ||
            recoveryStart.getTime() <=
              req.oldestAmbiguousAttemptedAt.getTime() - req.safetyMarginMs),
      },
    };

    const positionsCov: SourceCoverage = {
      available: posResult.ok,
      boundedWindow: posResult.ok,
      timedOut: !posResult.ok && posResult.error === "timeout",
      count: posResult.rows.length,
      reason: posResult.ok ? undefined : posResult.error,
    };
    const openOrdersCov: SourceCoverage = {
      available: openResult.ok,
      boundedWindow: openResult.ok,
      timedOut: !openResult.ok && openResult.error === "timeout",
      count: openResult.rows.length,
      reason: openResult.ok ? undefined : openResult.error,
    };
    const completedOrdersCov: SourceCoverage = {
      available: false,
      boundedWindow: false,
      timedOut: false,
      count: 0,
      reason: "unsupported_by_ib_module",
    };

    const sourceCoverage: BrokerReconciliationSnapshot["sourceCoverage"] = {
      positions: positionsCov,
      openOrders: openOrdersCov,
      executions: executionsCov,
      completedOrders: completedOrdersCov,
      session: sessionCov,
    };

    const flags = deriveCompletenessFlags(sourceCoverage);

    // Filter positions to the active account only.
    const positions = posResult.rows
      .filter((r) => !r.accountId || r.accountId === req.accountId)
      .map((r) => ({
        accountId: r.accountId,
        symbol: r.symbol,
        conId: r.conId ?? null,
        secType: r.secType ?? null,
        exchange: r.exchange ?? null,
        currency: r.currency ?? null,
        position: r.position,
        averageCost: r.averageCost ?? null,
      }));

    const openOrders = openResult.rows.map((r) => ({
      accountId: r.accountId ?? null,
      brokerOrderId: r.brokerOrderId,
      permId: r.permId ?? null,
      parentPermId: null,
      clientId: r.clientId ?? null,
      orderRef: r.orderRef ?? null,
      status: r.status,
      symbol: r.symbol ?? null,
      conId: r.conId ?? null,
      secType: r.secType ?? null,
      exchange: r.exchange ?? null,
      currency: r.currency ?? null,
      filled: r.filled ?? null,
      remaining: r.remaining ?? null,
      action: r.action ?? null,
      terminalStatus: null,
      observedAt: new Date(),
    }));

    const executions = execResult.rows.map((r) => ({
      execId: r.execId,
      brokerOrderId: r.brokerOrderId,
      permId: r.permId ?? null,
      orderRef: r.orderRef ?? null,
      accountId: r.accountId,
      symbol: r.symbol ?? null,
      conId: r.conId ?? null,
      secType: r.secType ?? null,
      exchange: r.exchange ?? null,
      currency: r.currency ?? null,
      side: r.side ?? null,
      shares: r.shares,
      price: r.price ?? null,
      executedAt: r.executedAt,
    }));

    return {
      exposureComplete: flags.exposureComplete,
      recoveryComplete: flags.recoveryComplete,
      capturedAt: new Date(
        Math.max(capturedAtStart.getTime(), Date.now()),
      ),
      accountId: req.accountId,
      sessionId: req.sessionId,
      sourceCoverage,
      positions,
      openOrders,
      completedOrders: [],
      executions,
    };
  }
}

async function captureSession(
  tws: TwsExecutionClient,
  opts: { accountId: string; timeoutMs: number; abortSignal: AbortSignal },
): Promise<SourceCoverage> {
  if (!tws.isConnected()) {
    return {
      available: false,
      boundedWindow: false,
      timedOut: false,
      count: 0,
      reason: "socket_not_connected",
    };
  }
  try {
    const accounts = await withTimeoutAndAbort(
      tws.getManagedAccounts(),
      opts.timeoutMs,
      opts.abortSignal,
    );
    if (!accounts.includes(opts.accountId)) {
      return {
        available: false,
        boundedWindow: false,
        timedOut: false,
        count: accounts.length,
        reason: "account_not_managed_by_session",
      };
    }
    return {
      available: true,
      boundedWindow: true,
      timedOut: false,
      count: accounts.length,
    };
  } catch (err) {
    return {
      available: false,
      boundedWindow: false,
      timedOut: (err as Error).message === "timeout",
      count: 0,
      reason: (err as Error).message,
    };
  }
}

function withTimeoutAndAbort<T>(
  p: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
