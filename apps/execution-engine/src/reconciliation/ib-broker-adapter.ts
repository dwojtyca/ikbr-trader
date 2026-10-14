import { emitBrokerPhase, type BrokerPhaseDiagnostics } from "./phase-diagnostics.js";
import type { CompletedOrdersClient } from "./completed-orders-client.js";
import type { TwsExecutionClient } from "../tws-execution-client.js";
import { paperAccountDayStart } from "../paper-daily-loss.js";
import type {
  BrokerReconciliationAdapter,
  BrokerReconciliationCaptureRequest,
  BrokerReconciliationSnapshot,
  ExecutionsCoverage,
  SourceCoverage,
} from "./broker-adapter.js";
import { deriveCompletenessFlags } from "./broker-adapter.js";
import type { AccountingJoin } from "../accounting/types.js";

export class IbBrokerReconciliationAdapter
  implements BrokerReconciliationAdapter
{
  constructor(private readonly tws: TwsExecutionClient, private readonly completed: Pick<CompletedOrdersClient, "load">,
    private readonly accounting?: AccountingJoin,
    private readonly hooks?: { diagnostics?: BrokerPhaseDiagnostics; checkpoint?: (snapshot: BrokerReconciliationSnapshot,
      request: BrokerReconciliationCaptureRequest, startedAt: Date, sources: Record<string,string>)=>Promise<void> }) {}

  async capture(
    req: BrokerReconciliationCaptureRequest,
  ): Promise<BrokerReconciliationSnapshot> {
    const totalStarted=performance.now();
    let totalFailed=false;
    try {
    if (req.abortSignal.aborted) throw new Error("aborted");

    const capturedAtStart = new Date();
    const generation = this.tws.getConnectionGeneration();
    const sourceCompletedAt:Record<string,string>={};
    const phase=async<T>(name:string,job:()=>Promise<T>):Promise<T>=>{
      const started=performance.now();
      try {
        const value=await job();
        const result=value as {ok?:boolean;available?:boolean;error?:unknown;reason?:unknown}|null;
        const failed=result?.ok===false||result?.available===false;
        totalFailed ||= failed;
        const reason=typeof result?.error==='string'?result.error:typeof result?.reason==='string'?result.reason:undefined;
        emitBrokerPhase(this.hooks?.diagnostics,`capture.${name}`,failed?'error':'ok',
          {runId:req.reconciliationRunId,generation,reason},performance.now()-started);
        sourceCompletedAt[name]=new Date().toISOString(); return value;
      } catch(error) {
        totalFailed=true;
        emitBrokerPhase(this.hooks?.diagnostics,`capture.${name}`,'error',{runId:req.reconciliationRunId,generation},performance.now()-started,error);
        throw error;
      }
    };

    // Session probe first — used to short-circuit further requests
    // when the socket is not connected. `getManagedAccounts` is
    // bounded by the ib client's own timeout, so we wrap it in the
    // same source timeout for consistency.
    let sessionCov = await phase('sessionBefore',()=>captureSession(this.tws, {
      accountId: req.accountId,
      timeoutMs: req.sourceTimeoutMs,
      abortSignal: req.abortSignal,
      onError:error=>emitBrokerPhase(this.hooks?.diagnostics,'capture.sessionBefore.cause','error',{runId:req.reconciliationRunId,generation},undefined,error),
    }));

    // Executions window: exposureStart = sessionStart - safetyMargin;
    // recoveryStart also includes Warsaw midnight and any older ambiguous attempt.
    const exposureStart = new Date(
      req.sessionStartedAt.getTime() - req.safetyMarginMs,
    );
    const accountDayStart = paperAccountDayStart(capturedAtStart.getTime());
    const recoveryStart = req.oldestAmbiguousAttemptedAt
      ? new Date(
          Math.min(
            accountDayStart,
            exposureStart.getTime(),
            req.oldestAmbiguousAttemptedAt.getTime() - req.safetyMarginMs,
          ),
        )
      : new Date(Math.min(exposureStart.getTime(), accountDayStart));

    // Fire all four snapshot reads in parallel — each carries its
    // own timeout + abort handling so a single slow source cannot
    // stall the run past its overall RUN_TIMEOUT.
    const [posResult, openResult, execResult, completedResult] = await Promise.all([
      phase('positions',()=>this.tws.reqPositionsSnapshot({
        timeoutMs: req.sourceTimeoutMs,
        abortSignal: req.abortSignal,
      })),
      phase('openOrders',()=>this.tws.reqAllOpenOrdersSnapshot({
        timeoutMs: req.sourceTimeoutMs,
        abortSignal: req.abortSignal,
      })),
      phase('executions',()=>this.tws.reqExecutionsSnapshot({
        accountId: req.accountId,
        since: recoveryStart,
        timeoutMs: req.sourceTimeoutMs,
        abortSignal: req.abortSignal,
      })).then(result => ({ ...result, completedAt: new Date() })),
      phase('completedOrders',()=>this.completed.load({ accountId: req.accountId, timeoutMs: req.sourceTimeoutMs, abortSignal: req.abortSignal })),
    ]);

    const finalSession = await phase('sessionAfter',()=>captureSession(this.tws, {
      accountId: req.accountId, timeoutMs: req.sourceTimeoutMs, abortSignal: req.abortSignal,
      onError:error=>emitBrokerPhase(this.hooks?.diagnostics,'capture.sessionAfter.cause','error',{runId:req.reconciliationRunId,generation},undefined,error),
    }));
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
        to: execResult.completedAt.toISOString(),
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
      orderType: r.orderType ?? null, limitPrice: r.limitPrice ?? null, stopPrice: r.stopPrice ?? null,
      totalQuantity: r.totalQuantity ?? null, parentId: r.parentId ?? null, ocaGroup: r.ocaGroup ?? null, ocaType: r.ocaType ?? null, tif: r.tif ?? null,
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

    const snapshot: BrokerReconciliationSnapshot = {
      originalAcquisitionStartedAt: capturedAtStart.toISOString(),
      connectionGeneration: generation,
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
    if (this.hooks?.checkpoint && !req.abortSignal.aborted && this.tws.isConnected() && generation===this.tws.getConnectionGeneration()) {
      try { await phase('notificationCheckpoint',()=>this.hooks!.checkpoint!(snapshot,req,capturedAtStart,sourceCompletedAt)); }
      catch { /* Notification persistence never authorizes or invalidates broker reconciliation. */ }
    }
    if (!this.accounting || !req.reconciliationRunId || !req.positionGeneration) return snapshot;
    try {
      return await phase('accountingJoin',()=>this.accounting!.join(snapshot, { runId: req.reconciliationRunId!, positionGeneration: req.positionGeneration!,
        recoveryStart, timeoutMs: req.sourceTimeoutMs, abortSignal: req.abortSignal }));
    } catch {
      // Accounting failure denies entries through its authority; retain reconciliation for exits.
      return snapshot;
    }
    } catch(error) {
      totalFailed=true;
      throw error;
    } finally {
      emitBrokerPhase(this.hooks?.diagnostics,'capture.total',totalFailed?'error':'ok',{runId:req.reconciliationRunId},performance.now()-totalStarted);
    }
  }
}

async function captureSession(
  tws: TwsExecutionClient,
  opts: { accountId: string; timeoutMs: number; abortSignal: AbortSignal; onError?: (error:unknown)=>void },
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
    opts.onError?.(err);
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
