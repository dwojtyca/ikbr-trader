/**
 * PR15 — deterministic in-memory `BrokerReconciliationAdapter` for
 * tests, dry runs, and environments where the real IB module is
 * not connected. The runner and integration tests exercise this
 * adapter as their default port.
 */

import type {
  BrokerExecutionRow,
  BrokerOrderRow,
  BrokerPositionRow,
  BrokerReconciliationAdapter,
  BrokerReconciliationCaptureRequest,
  BrokerReconciliationSnapshot,
  ExecutionsCoverage,
  SourceCoverage,
} from "./broker-adapter.js";
import { deriveCompletenessFlags } from "./broker-adapter.js";

export interface FakeBrokerSeed {
  readonly positions?: readonly BrokerPositionRow[];
  readonly openOrders?: readonly BrokerOrderRow[];
  readonly completedOrders?: readonly BrokerOrderRow[];
  readonly executions?: readonly BrokerExecutionRow[];
  readonly completedOrdersSupported?: boolean;
  readonly executionsWindowLimit?: Date;
  readonly failSource?:
    | "positions"
    | "openOrders"
    | "completedOrders"
    | "executions"
    | "session";
  readonly sessionCoverage?: SourceCoverage;
}

export class FakeBrokerReconciliationAdapter
  implements BrokerReconciliationAdapter
{
  #seed: FakeBrokerSeed = {};
  #captureCount = 0;

  configure(seed: FakeBrokerSeed): void {
    this.#seed = { ...this.#seed, ...seed };
  }

  reset(): void {
    this.#seed = {};
    this.#captureCount = 0;
  }

  captureCount(): number {
    return this.#captureCount;
  }

  async capture(
    req: BrokerReconciliationCaptureRequest,
  ): Promise<BrokerReconciliationSnapshot> {
    this.#captureCount += 1;
    if (req.abortSignal.aborted) {
      throw new Error("aborted");
    }
    const seed = this.#seed;
    const timedOut = (kind: FakeBrokerSeed["failSource"]) =>
      seed.failSource === kind;

    const positions = seed.positions ?? [];
    const openOrders = seed.openOrders ?? [];
    const completedOrders = seed.completedOrders ?? [];
    const executions = seed.executions ?? [];

    const exposureFrom = new Date(
      req.sessionStartedAt.getTime() - req.safetyMarginMs,
    );
    const oldest = req.oldestAmbiguousAttemptedAt ?? null;
    const desiredRecoveryFrom = oldest
      ? new Date(Math.min(exposureFrom.getTime(), oldest.getTime() - req.safetyMarginMs))
      : exposureFrom;

    const brokerLimit = seed.executionsWindowLimit ?? null;
    const recoveryOk =
      !brokerLimit || desiredRecoveryFrom.getTime() >= brokerLimit.getTime();
    const executionsFrom =
      brokerLimit && !recoveryOk ? brokerLimit : desiredRecoveryFrom;

    const capturedAt = new Date();

    const sourceCoverage: BrokerReconciliationSnapshot["sourceCoverage"] = {
      positions: coverage(positions.length, timedOut("positions")),
      openOrders: coverage(openOrders.length, timedOut("openOrders")),
      completedOrders: completedOrdersCoverage(
        seed.completedOrdersSupported !== false,
        completedOrders.length,
        timedOut("completedOrders"),
      ),
      executions: executionsCoverage(
        executions.length,
        timedOut("executions"),
        executionsFrom,
        capturedAt,
        !timedOut("executions"),
        !timedOut("executions") && recoveryOk,
      ),
      session:
        seed.sessionCoverage ?? coverage(1, timedOut("session")),
    };

    const flags = deriveCompletenessFlags(sourceCoverage);

    return {
      exposureComplete: flags.exposureComplete,
      recoveryComplete: flags.recoveryComplete,
      capturedAt,
      accountId: req.accountId,
      sessionId: req.sessionId,
      sourceCoverage,
      positions,
      openOrders,
      completedOrders,
      executions,
    };
  }
}

function coverage(count: number, timedOut: boolean): SourceCoverage {
  return {
    available: !timedOut,
    boundedWindow: !timedOut,
    timedOut,
    count,
    reason: timedOut ? "timed_out" : undefined,
  };
}

function completedOrdersCoverage(
  supported: boolean,
  count: number,
  timedOut: boolean,
): SourceCoverage {
  if (!supported) {
    return {
      available: false,
      boundedWindow: false,
      timedOut: false,
      count: 0,
      reason: "unsupported_by_ib_module",
    };
  }
  return coverage(count, timedOut);
}

function executionsCoverage(
  count: number,
  timedOut: boolean,
  from: Date,
  to: Date,
  exposureWindowComplete: boolean,
  recoveryWindowComplete: boolean,
): ExecutionsCoverage {
  return {
    available: !timedOut,
    timedOut,
    count,
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      exposureWindowComplete,
      recoveryWindowComplete,
    },
    reason: !recoveryWindowComplete
      ? "window_predates_broker_limit"
      : undefined,
  };
}
