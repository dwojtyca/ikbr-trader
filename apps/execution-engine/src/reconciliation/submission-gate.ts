/**
 * PR15 — build the authoritative reconciliation submission gate
 * that repository methods (`insertProposedFromTicket`,
 * `tryStartSubmissionWithExposureGuard`) invoke inside the SAME
 * transaction + advisory locks (`snap:<account>` →
 * `hashtext(instrument)`) as the PR14 exposure guard.
 *
 * The gate never opens its own connection — it uses the caller's
 * `PoolClient`. Runs plain SELECTs; the runner's writes to
 * `reconciliation_runs` / `reconciliation_holds` are made visible
 * by the shared `snap:<account>` serialisation on the runner side
 * (§7 Phase A / Phase C).
 */

import type { PoolClient } from "pg";

import type {
  ReconciliationSubmissionGate,
  ReconciliationSubmissionGateOutcome,
} from "../repository.js";
import { canonicaliseIdentity } from "./identity.js";

export interface SubmissionGateConfig {
  readonly maxAgeSeconds: number;
}

export function buildReconciliationSubmissionGate(
  config: SubmissionGateConfig,
): ReconciliationSubmissionGate {
  return async (client, ctx) => {
    return evaluate(client, ctx, config);
  };
}

async function evaluate(
  client: PoolClient,
  ctx: {
    accountId: string;
    sessionId: string;
    instrument: string;
    conId: string | null;
    nowMs: number;
  },
  config: SubmissionGateConfig,
): Promise<ReconciliationSubmissionGateOutcome | null> {
  // Any RUNNING row for the current session ⇒ unavailable
  // (`reconciliation_running`).
  const running = await client.query<{ id: number }>(
    `SELECT id FROM reconciliation_runs
     WHERE account_id = $1 AND session_id = $2 AND status = 'RUNNING'
     LIMIT 1`,
    [ctx.accountId, ctx.sessionId],
  );
  if ((running.rowCount ?? 0) > 0) {
    return { kind: "unavailable", reason: "reconciliation_running" };
  }

  const latest = await client.query<{
    status: string;
    session_id: string;
    completed_at: Date | null;
    started_at: Date;
    source_coverage: Record<string, unknown> | null;
  }>(
    `SELECT status, session_id, completed_at, started_at, source_coverage
       FROM reconciliation_runs
      WHERE account_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [ctx.accountId],
  );
  if ((latest.rowCount ?? 0) === 0) {
    return {
      kind: "unavailable",
      reason: "reconciliation_never_ran_in_session",
    };
  }
  const row = latest.rows[0];
  if (row.session_id !== ctx.sessionId) {
    return { kind: "unavailable", reason: "reconciliation_wrong_session" };
  }
  switch (row.status) {
    case "FAILED":
      return { kind: "unavailable", reason: "reconciliation_failed" };
    case "ABANDONED":
      return { kind: "unavailable", reason: "reconciliation_abandoned" };
    case "RUNNING":
      return { kind: "unavailable", reason: "reconciliation_running" };
  }
  if (!exposureCompleteFromCoverage(row.source_coverage)) {
    return {
      kind: "unavailable",
      reason: "reconciliation_incomplete_exposure",
    };
  }
  const finalisedAt = row.completed_at ?? row.started_at;
  const ageSeconds = Math.floor(
    (ctx.nowMs - new Date(finalisedAt).getTime()) / 1000,
  );
  if (ageSeconds > config.maxAgeSeconds) {
    return { kind: "stale", ageSeconds };
  }

  // Per-identity hold check.
  const identity = canonicaliseIdentity({
    accountId: ctx.accountId,
    conId: ctx.conId,
    symbol: ctx.instrument,
  });
  const hold = await client.query<{
    id: number;
    reason: string;
    severity: string;
  }>(
    `SELECT id, reason, severity FROM reconciliation_holds
      WHERE account_id = $1 AND identity_key = $2 AND active
      ORDER BY created_at DESC
      LIMIT 1`,
    [ctx.accountId, identity.identityKey],
  );
  if ((hold.rowCount ?? 0) > 0) {
    const h = hold.rows[0];
    return {
      kind: "hold",
      holdId: Number(h.id),
      reason: String(h.reason),
      severity: String(h.severity),
    };
  }
  return null;
}

function exposureCompleteFromCoverage(
  raw: Record<string, unknown> | null,
): boolean {
  if (!raw || typeof raw !== "object") return false;
  const positions = source(raw.positions);
  const openOrders = source(raw.openOrders);
  const executions = executionsSource(raw.executions);
  const session = source(raw.session);
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

function source(raw: unknown): { available: boolean; boundedWindow: boolean } {
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
