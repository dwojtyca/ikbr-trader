/**
 * PR15 — read-only helpers for `/latest` and `/ready`.
 *
 * NOTE: the AUTHORITATIVE submission gate that runs inside the
 * PR14 submission transaction lives in `./submission-gate.ts`.
 * This file only exposes the readiness classifier and the
 * (non-authoritative) HTTP `/latest` helper used by operator
 * diagnostics.
 */

import type {
  ReconciliationRepository,
  ReconciliationRunRow,
} from "./repository.js";

export type ReconciliationGateOutcome =
  | { readonly kind: "pass" }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "reconciliation_never_ran_in_session"
        | "reconciliation_wrong_session"
        | "reconciliation_running"
        | "reconciliation_failed"
        | "reconciliation_abandoned"
        | "reconciliation_incomplete_exposure";
    }
  | { readonly kind: "stale"; readonly ageSeconds: number };

export interface GateContext {
  readonly accountId: string;
  readonly sessionId: string;
  readonly nowMs: number;
  readonly maxAgeSeconds: number;
}

/**
 * Non-authoritative diagnostic helper used by `/execution/reconciliation/latest`
 * and readiness. Callers must NOT use this as the write-path
 * authoritative gate — see `./submission-gate.ts`.
 */
export async function evaluateReconciliationGate(
  reconRepo: ReconciliationRepository,
  ctx: GateContext,
): Promise<ReconciliationGateOutcome> {
  const running = await reconRepo.getRunningRow(ctx.accountId, ctx.sessionId);
  if (running) return { kind: "unavailable", reason: "reconciliation_running" };
  const latest = await reconRepo.getLatestRunOverall(ctx.accountId);
  if (!latest) {
    return { kind: "unavailable", reason: "reconciliation_never_ran_in_session" };
  }
  if (latest.sessionId !== ctx.sessionId) {
    return { kind: "unavailable", reason: "reconciliation_wrong_session" };
  }
  switch (latest.status) {
    case "FAILED":
      return { kind: "unavailable", reason: "reconciliation_failed" };
    case "ABANDONED":
      return { kind: "unavailable", reason: "reconciliation_abandoned" };
    case "RUNNING":
      return { kind: "unavailable", reason: "reconciliation_running" };
  }
  if (!isExposureComplete(latest)) {
    return { kind: "unavailable", reason: "reconciliation_incomplete_exposure" };
  }
  const finalisedAt = latest.completedAt ?? latest.startedAt;
  const ageSeconds = Math.floor((ctx.nowMs - finalisedAt.getTime()) / 1000);
  if (ageSeconds > ctx.maxAgeSeconds) return { kind: "stale", ageSeconds };
  return { kind: "pass" };
}

function isExposureComplete(run: ReconciliationRunRow): boolean {
  const cov = (run.sourceCoverage as Record<string, unknown>) ?? {};
  const positions = source(cov.positions);
  const openOrders = source(cov.openOrders);
  const executions = executionsSource(cov.executions);
  const session = source(cov.session);
  return (
    positions.available &&
    positions.boundedWindow &&
    openOrders.available &&
    openOrders.boundedWindow &&
    executions.available &&
    executions.exposureWindowComplete &&
    session.available
  );
}

function source(raw: unknown): {
  available: boolean;
  boundedWindow: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return { available: false, boundedWindow: false };
  }
  const r = raw as Record<string, unknown>;
  return {
    available: r.available === true,
    boundedWindow: r.boundedWindow === true,
  };
}

function executionsSource(raw: unknown): {
  available: boolean;
  exposureWindowComplete: boolean;
} {
  if (!raw || typeof raw !== "object") {
    return { available: false, exposureWindowComplete: false };
  }
  const r = raw as Record<string, unknown>;
  const window = (r.window as Record<string, unknown>) ?? {};
  return {
    available: r.available === true,
    exposureWindowComplete: window.exposureWindowComplete === true,
  };
}

/**
 * Derive the readiness `reconciliationRunHealth` input from the
 * latest runs. Returns `undefined` if the caller should skip this
 * check (unavailable account etc.); callers should default to
 * `none_in_session` in that case.
 */
export function classifyReadiness(
  runningInSession: boolean,
  latestOverall: ReconciliationRunRow | null,
  sessionId: string,
): {
  kind:
    | "none_in_session"
    | "running"
    | "wrong_session"
    | "failed"
    | "abandoned"
    | "incomplete_exposure"
    | "incomplete_recovery"
    | "healthy";
} {
  if (runningInSession) return { kind: "running" };
  if (!latestOverall) return { kind: "none_in_session" };
  if (latestOverall.sessionId !== sessionId) return { kind: "wrong_session" };
  switch (latestOverall.status) {
    case "FAILED":
      return { kind: "failed" };
    case "ABANDONED":
      return { kind: "abandoned" };
    case "RUNNING":
      return { kind: "running" };
  }
  if (!isExposureComplete(latestOverall)) return { kind: "incomplete_exposure" };
  const cov = (latestOverall.sourceCoverage as Record<string, unknown>) ?? {};
  const executions = executionsSource(cov.executions);
  const completedOrders = source(cov.completedOrders);
  const executionsRecovery = executionsRecoveryFlag(cov.executions);
  if (!completedOrders.available || !completedOrders.boundedWindow || !executionsRecovery) {
    return { kind: "incomplete_recovery" };
  }
  return { kind: "healthy" };
}

function executionsRecoveryFlag(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const window = ((raw as Record<string, unknown>).window as
    | Record<string, unknown>
    | undefined) ?? {};
  return window.recoveryWindowComplete === true;
}
