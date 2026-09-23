/**
 * PR15 — BrokerReconciliationAdapter port + shared types.
 *
 * The runner acquires this port to build a snapshot of the broker's
 * authoritative state (positions, open orders, executions, and —
 * where the underlying `ib` module supports it — completed orders).
 *
 * `exposureComplete` gates the global write path.
 * `recoveryComplete` gates the negative "never submitted" conclusion.
 *
 * See docs/implementation/phase2/PR15_PLAN.md §3.
 */

export interface SourceCoverage {
  readonly available: boolean;
  /**
   * Whether the source honours a bounded window (openOrders /
   * completedOrders / positions do; executions has its own shape
   * — see `ExecutionsCoverage`).
   * NOT consulted for executions decisions.
   */
  readonly boundedWindow: boolean;
  readonly timedOut: boolean;
  readonly count: number;
  readonly reason?: string;
}

export interface ExecutionsCoverage
  extends Omit<SourceCoverage, "boundedWindow"> {
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly exposureWindowComplete: boolean;
    readonly recoveryWindowComplete: boolean;
  };
}

export interface BrokerPositionRow {
  readonly accountId: string;
  readonly symbol: string;
  readonly conId?: string | null;
  readonly secType?: string | null;
  readonly exchange?: string | null;
  readonly currency?: string | null;
  readonly position: number;
  readonly averageCost?: number | null;
  readonly marketValue?: number | null;
}

export interface BrokerOrderRow {
  readonly accountId?: string | null;
  readonly brokerOrderId: string;
  readonly permId?: string | null;
  readonly parentPermId?: string | null;
  readonly clientId?: number | null;
  readonly orderRef?: string | null;
  readonly status: string;
  readonly symbol?: string | null;
  readonly conId?: string | null;
  readonly secType?: string | null;
  readonly exchange?: string | null;
  readonly currency?: string | null;
  readonly filled?: number | null;
  readonly remaining?: number | null;
  readonly action?: string | null;
  /**
   * Only populated by `completedOrders`. `null` for orders still
   * live in `openOrders`.
   */
  readonly terminalStatus?: string | null;
  readonly observedAt: Date;
}

export interface BrokerExecutionRow {
  readonly execId: string;
  readonly brokerOrderId: string;
  readonly permId?: string | null;
  readonly orderRef?: string | null;
  readonly accountId: string;
  readonly symbol?: string | null;
  readonly conId?: string | null;
  readonly secType?: string | null;
  readonly exchange?: string | null;
  readonly currency?: string | null;
  readonly side?: string | null;
  readonly shares: number;
  readonly price?: number | null;
  readonly executedAt: Date;
}

export interface BrokerReconciliationSnapshot {
  readonly exposureComplete: boolean;
  readonly recoveryComplete: boolean;
  readonly capturedAt: Date;
  readonly accountId: string;
  readonly sessionId: string;
  readonly sourceCoverage: {
    readonly positions: SourceCoverage;
    readonly openOrders: SourceCoverage;
    readonly executions: ExecutionsCoverage;
    readonly completedOrders: SourceCoverage;
    readonly session: SourceCoverage;
  };
  readonly positions: readonly BrokerPositionRow[];
  readonly openOrders: readonly BrokerOrderRow[];
  readonly completedOrders: readonly BrokerOrderRow[];
  readonly executions: readonly BrokerExecutionRow[];
}

export interface BrokerReconciliationCaptureRequest {
  readonly accountId: string;
  readonly sessionId: string;
  readonly sessionStartedAt: Date;
  /**
   * When set, the runner has ambiguous PROPOSED rows whose oldest
   * `execution_attempted_at` is `oldestAmbiguousAttemptedAt`.
   * The adapter should attempt to widen its executions window to
   * cover the recovery window; if the broker refuses, it must
   * flip `recoveryWindowComplete=false`.
   */
  readonly oldestAmbiguousAttemptedAt?: Date | null;
  readonly safetyMarginMs: number;
  readonly sourceTimeoutMs: number;
  readonly abortSignal: AbortSignal;
}

export interface BrokerReconciliationAdapter {
  capture(
    request: BrokerReconciliationCaptureRequest,
  ): Promise<BrokerReconciliationSnapshot>;
}

/**
 * Convenience helper: derive the effective exposureComplete /
 * recoveryComplete flags from the individual source coverages so
 * callers can reuse the same rule everywhere.
 */
export function deriveCompletenessFlags(
  coverage: BrokerReconciliationSnapshot["sourceCoverage"],
): { exposureComplete: boolean; recoveryComplete: boolean } {
  const exposureComplete =
    coverage.positions.available &&
    coverage.positions.boundedWindow &&
    coverage.openOrders.available &&
    coverage.openOrders.boundedWindow &&
    coverage.executions.available &&
    coverage.executions.window.exposureWindowComplete &&
    coverage.session.available;
  const recoveryComplete =
    exposureComplete &&
    coverage.executions.window.recoveryWindowComplete &&
    coverage.completedOrders.available &&
    coverage.completedOrders.boundedWindow;
  return { exposureComplete, recoveryComplete };
}
