import type { CompletedOrdersClient } from "./completed-orders-client.js";
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
  constructor(private readonly tws: TwsExecutionClient, private readonly completed: Pick<CompletedOrdersClient, "load">) {}

  async capture(
    req: BrokerReconciliationCaptureRequest,
  ): Promise<BrokerReconciliationSnapshot> {
    if (req.abortSignal.aborted) throw new Error("aborted");

    const capturedAtStart = new Date();
    const generation = this.tws.getConnectionGeneration();

    // Session probe first — used to short-circuit further requests
    // when the socket is not connected. `getManagedAccounts` is
    // bounded by the ib client's own timeout, so we wrap it in the
    // same source timeout for consistency.
    let sessionCov = await captureSession(this.tws, {
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

    // Fire all four snapshot reads in parallel — each carries its
    // own timeout + abort handling so a single slow source cannot
    // stall the run past its overall RUN_TIMEOUT.
    const [posResult, openResult, execResult, completedResult] = await Promise.all([
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
      this.completed.load({ accountId: req.accountId, timeoutMs: req.sourceTimeoutMs, abortSignal: req.abortSignal }),
    ]);

    const finalSession = await captureSession(this.tws, {
      accountId: req.accountId, timeoutMs: req.sourceTimeoutMs, abortSignal: req.abortSignal,
    });
    if (!finalSession.available || !this.tws.isConnected() || generation !== this.tws.getConnectionGeneration()) {
      sessionCov = { available: false, boundedWindow: false, timedOut: finalSession.timedOut, count: 0,
        reason: "execution_session_changed_during_capture" };
    }

    if (req.abortSignal.aborted) throw new Error("aborted");

    // Executions coverage: exposureWindowComplete requires the end
    // event AND that the actual `since` we asked for covered
    // `exposureStart`. recoveryWindowComplete additionally requires
    // that the query started at or before recoveryStart.
    const executionsCov: ExecutionsCoverage = {
      available: execResult.ok,
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
      available: completedResult.ok,
      boundedWindow: completedResult.ok && !req.oldestAmbiguousAttemptedAt,
      timedOut: completedResult.error === "timeout",
      count: completedResult.rows.length,
      recoveryScope: "current_state_only",
      reason: !completedResult.ok ? completedResult.error : req.oldestAmbiguousAttemptedAt
        ? "completed_historical_window_unproven" : undefined,
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
      completedOrders: completedResult.rows,
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
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = () => finish(new Error("aborted"));
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    p.then(v => finish(undefined, v), e => finish(e instanceof Error ? e : new Error(String(e))));
  });
}
