/**
 * PR15.1 — shared check types + HTTP response classifier.
 *
 * Severity taxonomy (plan §4):
 *   CONFIG_ERROR > UNREACHABLE > UNHEALTHY > DEGRADED > HEALTHY
 *   DISABLED is neutral in aggregation.
 *
 * Aggregate exit codes:
 *   HEALTHY=0, DISABLED=0, DEGRADED=40, UNHEALTHY=30,
 *   UNREACHABLE=20, CONFIG_ERROR=10.
 */

import { z } from "zod";
import type { EndpointKey } from "../endpoints.js";
import type { TransportOutcome } from "../http.js";

export type CheckStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "UNHEALTHY"
  | "UNREACHABLE"
  | "CONFIG_ERROR"
  | "DISABLED";

export type AggregateStatus = CheckStatus;

export interface CheckResult {
  readonly id: string;
  readonly service: "ingestion" | "signal" | "execution";
  readonly status: CheckStatus;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface HttpClassification {
  readonly ok: true;
  readonly status: number;
  readonly json: unknown;
}

export type HttpProblemReason =
  | "timeout"
  | "network"
  | "dns"
  | "unknown"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "server_error"
  | "unexpected_status"
  | "invalid_json"
  | "malformed_response";

export interface HttpProblem {
  readonly ok: false;
  readonly status: number | null;
  readonly reason: HttpProblemReason;
  readonly detail: string;
}

export type HttpOutcome = HttpClassification | HttpProblem;

/** Maps a transport-level HTTP problem to a CheckStatus per §4.1. */
export function severityForHttpProblem(
  problem: HttpProblem,
): "UNREACHABLE" | "CONFIG_ERROR" | "UNHEALTHY" {
  switch (problem.reason) {
    case "timeout":
    case "network":
    case "dns":
    case "unknown":
      return "UNREACHABLE";
    case "unauthorized":
    case "forbidden":
      return "CONFIG_ERROR";
    case "not_found":
    case "conflict":
    case "server_error":
    case "unexpected_status":
    case "invalid_json":
    case "malformed_response":
      return "UNHEALTHY";
  }
}

/** Reason token for an HTTP problem (safe: contains no secrets). */
export function reasonTokenForHttpProblem(problem: HttpProblem): string {
  switch (problem.reason) {
    case "unauthorized":
    case "forbidden":
      return "auth_rejected";
    case "not_found":
      return "endpoint_not_registered";
    case "conflict":
      return "http_409";
    case "malformed_response":
    case "invalid_json":
      return "malformed_response";
    case "timeout":
      return "timeout";
    case "network":
      return "connection_refused";
    case "dns":
      return "dns_failure";
    case "server_error":
      return `http_${problem.status ?? "5xx"}`;
    case "unexpected_status":
      return `http_${problem.status ?? "unexpected"}`;
    case "unknown":
      return "transport_error";
  }
}

export function classifyHttp<T>(
  outcome: TransportOutcome,
  schema: z.ZodType<T>,
): HttpOutcome {
  if (outcome.kind === "error") {
    return {
      ok: false,
      status: null,
      reason: outcome.reason,
      detail: outcome.detail,
    };
  }
  const { status, bodyText } = outcome;
  if (status === 401) {
    return { ok: false, status, reason: "unauthorized", detail: "" };
  }
  if (status === 403) {
    return { ok: false, status, reason: "forbidden", detail: "" };
  }
  if (status === 404) {
    return { ok: false, status, reason: "not_found", detail: "" };
  }
  if (status === 409) {
    return { ok: false, status, reason: "conflict", detail: "" };
  }
  if (status >= 500) {
    return { ok: false, status, reason: "server_error", detail: "" };
  }
  if (status !== 200) {
    return { ok: false, status, reason: "unexpected_status", detail: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (err) {
    return {
      ok: false,
      status,
      reason: "invalid_json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const check = schema.safeParse(parsed);
  if (!check.success) {
    return {
      ok: false,
      status,
      reason: "malformed_response",
      detail: check.error.issues
        .map((i) => `${i.path.join(".")}:${i.code}`)
        .join(","),
    };
  }
  return { ok: true, status, json: check.data };
}

/**
 * Readiness variant — accepts HTTP 200 AND HTTP 503 as
 * legitimate protocol-level responses and parses both
 * against the schema. Everything else routes through
 * `classifyHttp`.
 */
export function classifyReadiness<T>(
  outcome: TransportOutcome,
  schema: z.ZodType<T>,
): HttpOutcome {
  if (outcome.kind === "error") {
    return {
      ok: false,
      status: null,
      reason: outcome.reason,
      detail: outcome.detail,
    };
  }
  if (outcome.status !== 200 && outcome.status !== 503) {
    return classifyHttp(outcome, schema);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bodyText);
  } catch (err) {
    return {
      ok: false,
      status: outcome.status,
      reason: "invalid_json",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const check = schema.safeParse(parsed);
  if (!check.success) {
    return {
      ok: false,
      status: outcome.status,
      reason: "malformed_response",
      detail: check.error.issues
        .map((i) => `${i.path.join(".")}:${i.code}`)
        .join(","),
    };
  }
  return { ok: true, status: outcome.status, json: check.data };
}

const RANK: Record<CheckStatus, number> = {
  CONFIG_ERROR: 5,
  UNREACHABLE: 4,
  UNHEALTHY: 3,
  DEGRADED: 2,
  HEALTHY: 1,
  DISABLED: 0,
};

export interface AggregateSummary {
  readonly overall: AggregateStatus;
  readonly exitCode: 0 | 10 | 20 | 30 | 40;
  readonly total: number;
  readonly counts: Readonly<Record<CheckStatus, number>>;
}

const EXIT_CODES: Record<AggregateStatus, 0 | 10 | 20 | 30 | 40> = {
  HEALTHY: 0,
  DISABLED: 0,
  DEGRADED: 40,
  UNHEALTHY: 30,
  UNREACHABLE: 20,
  CONFIG_ERROR: 10,
};

export function aggregate(results: readonly CheckResult[]): AggregateSummary {
  const counts: Record<CheckStatus, number> = {
    HEALTHY: 0,
    DEGRADED: 0,
    UNHEALTHY: 0,
    UNREACHABLE: 0,
    CONFIG_ERROR: 0,
    DISABLED: 0,
  };
  for (const r of results) counts[r.status] += 1;
  const active = results.filter((r) => r.status !== "DISABLED");
  let overall: AggregateStatus;
  if (active.length === 0) {
    overall = results.length === 0 ? "HEALTHY" : "DISABLED";
  } else {
    let winner: CheckStatus = "HEALTHY";
    for (const r of active) {
      if (RANK[r.status] > RANK[winner]) winner = r.status;
    }
    overall = winner;
  }
  return {
    overall,
    exitCode: EXIT_CODES[overall],
    total: results.length,
    counts,
  };
}

export function endpointReasonToken(
  key: EndpointKey,
  problem: HttpProblem,
): string {
  return `${key}:${reasonTokenForHttpProblem(problem)}`;
}
