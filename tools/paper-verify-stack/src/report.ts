/**
 * PR15.1 — result rendering (table + JSON).
 * Every rendered string is passed through the redactor
 * so account IDs and any Bearer token substring never
 * appear verbatim.
 */

import type { CheckResult, AggregateSummary } from "./checks/types.js";

type Redactor = (value: string) => string;

export function renderTable(
  results: readonly CheckResult[],
  summary: AggregateSummary,
  redact: Redactor,
): string {
  const rows = results.map((r) => ({
    status: r.status,
    id: r.id,
    summary: redact(r.summary),
  }));
  const colStatus = Math.max(12, ...rows.map((r) => r.status.length));
  const colId = Math.max(4, ...rows.map((r) => r.id.length));
  const lines: string[] = [];
  lines.push(
    `${"STATUS".padEnd(colStatus)}  ${"ID".padEnd(colId)}  SUMMARY`,
  );
  lines.push(
    `${"".padEnd(colStatus, "-")}  ${"".padEnd(colId, "-")}  -------`,
  );
  for (const r of rows) {
    lines.push(
      `${r.status.padEnd(colStatus)}  ${r.id.padEnd(colId)}  ${r.summary}`,
    );
  }
  lines.push("");
  lines.push(
    `overall: ${summary.overall} (exit=${summary.exitCode}) — ` +
      `HEALTHY=${summary.counts.HEALTHY} ` +
      `DEGRADED=${summary.counts.DEGRADED} ` +
      `UNHEALTHY=${summary.counts.UNHEALTHY} ` +
      `UNREACHABLE=${summary.counts.UNREACHABLE} ` +
      `CONFIG_ERROR=${summary.counts.CONFIG_ERROR} ` +
      `DISABLED=${summary.counts.DISABLED}`,
  );
  return lines.join("\n");
}

export function renderJson(
  results: readonly CheckResult[],
  summary: AggregateSummary,
  redact: Redactor,
): string {
  const payload = {
    overall: summary.overall,
    exitCode: summary.exitCode,
    counts: summary.counts,
    results: results.map((r) => ({
      id: r.id,
      service: r.service,
      status: r.status,
      summary: redact(r.summary),
      reasons: r.reasons.map(redact),
      details: r.details ?? null,
    })),
  };
  const raw = JSON.stringify(payload, null, 2);
  return redact(raw);
}
