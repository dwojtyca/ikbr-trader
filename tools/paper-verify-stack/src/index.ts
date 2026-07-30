/**
 * PR15.1 — `@ikbr/paper-verify-stack` CLI entry.
 *
 * Read-only, allowlist-bound, GET-only verifier for the
 * paper stack. Never submits, cancels, or modifies orders;
 * never writes to reconciliation. See
 * docs/runbooks/PAPER_STACK_VERIFICATION.md for usage.
 *
 * Exit codes (plan §4):
 *   0  HEALTHY / DISABLED
 *   10 CONFIG_ERROR
 *   20 UNREACHABLE
 *   30 UNHEALTHY
 *   40 DEGRADED
 */

import { parseConfig } from "./config.js";
import { createTransport } from "./http.js";
import { createRedactor } from "./mask.js";
import { aggregate, type CheckResult } from "./checks/types.js";
import { runIngestionChecks } from "./checks/ingestion.js";
import { runSignalChecks } from "./checks/signal.js";
import { runExecutionChecks } from "./checks/execution.js";
import { renderJson, renderTable } from "./report.js";

export async function run(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  now = Date.now(),
): Promise<{
  readonly exitCode: 0 | 10 | 20 | 30 | 40;
  readonly output: string;
}> {
  const wantsJson = argv.includes("--json");
  const cfgResult = parseConfig(env, argv);
  if (!cfgResult.ok) {
    const payload = {
      overall: "CONFIG_ERROR",
      exitCode: 10,
      reason: cfgResult.reason,
    };
    const output = wantsJson
      ? JSON.stringify(payload, null, 2)
      : `CONFIG_ERROR: ${cfgResult.reason}`;
    return { exitCode: 10, output };
  }
  const cfg = cfgResult.config;
  const redact = createRedactor(cfg.executionToken);
  const transport = createTransport({
    ingestionUrl: cfg.ingestionUrl,
    signalUrl: cfg.signalUrl,
    executionUrl: cfg.executionUrl,
    token: cfg.executionToken,
    timeoutMs: cfg.timeoutMs,
  });
  const results: CheckResult[] = [];
  results.push(...(await runIngestionChecks(transport, cfg, now)));
  results.push(...(await runSignalChecks(transport, cfg, now)));
  results.push(...(await runExecutionChecks(transport, cfg, now)));
  const summary = aggregate(results);
  const output = cfg.json
    ? renderJson(results, summary, redact)
    : renderTable(results, summary, redact);
  return { exitCode: summary.exitCode, output };
}

/**
 * Format a top-level fatal error for stderr. The redactor is
 * applied structurally — an unexpected rejection MUST NOT
 * surface the configured Bearer token or account IDs, even
 * when the error was constructed by code that did not go
 * through `renderTable` / `renderJson`.
 *
 * Exported so the guarantee is unit-testable independent of a
 * live rejection path (see `index.test.ts` / launcher tests).
 */
export function formatFatalError(
  err: unknown,
  token: string | undefined,
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redact = createRedactor(token);
  return `paper-verify-stack: ${redact(raw)}`;
}

// Node entrypoint guard.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].replace(/^\//, "/")));

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  // Extract the configured token BEFORE calling `run`, so that
  // even a rejection from inside `run` (which never returns a
  // config object on failure) is redacted structurally.
  const bootstrapToken =
    (process.env.PAPER_VERIFY_EXECUTION_TOKEN &&
      process.env.PAPER_VERIFY_EXECUTION_TOKEN.length > 0
      ? process.env.PAPER_VERIFY_EXECUTION_TOKEN
      : process.env.EXECUTION_API_TOKEN) || undefined;
  run(argv, process.env).then(
    (r) => {
      process.stdout.write(`${r.output}\n`);
      process.exit(r.exitCode);
    },
    (err: unknown) => {
      process.stderr.write(`${formatFatalError(err, bootstrapToken)}\n`);
      process.exit(30);
    },
  );
}
