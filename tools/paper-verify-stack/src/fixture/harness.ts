/**
 * PR15.1 follow-up — self-contained verification harness.
 *
 * Runs the real `paper-verify-stack` CLI (via the in-process
 * `run()` entrypoint) against a dynamically-ported fixture
 * stack and asserts every acceptance criterion for the
 * fixture path:
 *
 *  - opt-out exit 0, 13 requests, all GET, all allowlisted,
 *    no `/execution/account/summary`;
 *  - opt-in  exit 0, 14 requests, all GET, all allowlisted,
 *    account-summary precedes kill-switch;
 *  - stdout parses as JSON;
 *  - the synthetic fake token never appears in the CLI output;
 *  - the raw account ID never appears; only the masked form.
 *
 * The harness only touches the fixture. It never contacts
 * the real Docker Compose services on `3101` / `3102` /
 * `3103` — it uses the fixture's dynamically-allocated
 * loopback ports. The Bearer token is a compile-time fake;
 * `EXECUTION_API_TOKEN` and any other repository secret are
 * never referenced.
 */

import assert from "node:assert/strict";
import { run } from "../index.js";
import { ENDPOINTS, type EndpointKey } from "../endpoints.js";
import {
  FIXTURE_ACCOUNT_ID,
  startFixtureStack,
  type FixtureHandle,
  type FixtureRequest,
} from "./fixture-stack.js";

/**
 * Synthetic token. Deliberately long and structured so that
 * a substring leak would be obvious. Never a real secret.
 */
export const FAKE_TOKEN =
  "fixture-harness-fake-token-DO-NOT-LEAK-abcdefghijklmnop-1234567890";

export type Mode = "opt-out" | "opt-in";

const OPT_OUT_EXPECTED: readonly EndpointKey[] = [
  "INGESTION_HEALTH",
  "INGESTION_WATCHLIST",
  "SIGNAL_HEALTH",
  "SIGNAL_RUNTIME_HEALTH",
  "SIGNAL_RUNTIME_READY",
  "SIGNAL_EXECUTE_READY",
  "SIGNAL_LOOP_STATUS",
  "SIGNAL_LOOP_READY",
  "EXECUTION_HEALTH",
  "EXECUTION_READY",
  "RECON_LATEST",
  "RECON_HOLDS_ACTIVE",
  "EXECUTION_KILL_SWITCH",
];

const OPT_IN_EXPECTED: readonly EndpointKey[] = [
  "INGESTION_HEALTH",
  "INGESTION_WATCHLIST",
  "SIGNAL_HEALTH",
  "SIGNAL_RUNTIME_HEALTH",
  "SIGNAL_RUNTIME_READY",
  "SIGNAL_EXECUTE_READY",
  "SIGNAL_LOOP_STATUS",
  "SIGNAL_LOOP_READY",
  "EXECUTION_HEALTH",
  "EXECUTION_READY",
  "RECON_LATEST",
  "RECON_HOLDS_ACTIVE",
  "EXECUTION_ACCOUNT_SUMMARY",
  "EXECUTION_KILL_SWITCH",
];

const ALL_ALLOWLISTED_KEYS: ReadonlySet<EndpointKey> = new Set(
  Object.keys(ENDPOINTS) as EndpointKey[],
);

export interface FixtureRunResult {
  readonly mode: Mode;
  readonly exitCode: 0 | 10 | 20 | 30 | 40;
  readonly output: string;
  readonly requests: readonly FixtureRequest[];
}

function envFor(mode: Mode, stack: FixtureHandle): Record<string, string> {
  const base: Record<string, string> = {
    PAPER_VERIFY_INGESTION_URL: stack.ingestionUrl,
    PAPER_VERIFY_SIGNAL_URL: stack.signalUrl,
    PAPER_VERIFY_EXECUTION_URL: stack.executionUrl,
    PAPER_VERIFY_EXECUTION_TOKEN: FAKE_TOKEN,
    PAPER_VERIFY_RUNTIME_EXPECTED_STATE: "registered",
    PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
    PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "disabled",
    // PR15.3 r3 — fixture stack reports `tradingEnabled=false`
    // (see `fixture-stack.ts`), matching the Phase A / writes-off
    // baseline. Explicitly asserting the expected state locks the
    // check in place; any regression that flips the fixture to
    // `tradingEnabled=true` (or drops the expected-state
    // comparison) turns UNHEALTHY.
    PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE: "disabled",
  };
  if (mode === "opt-in") {
    base.PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY = "true";
  }
  return base;
}

export async function runAgainstFixture(
  stack: FixtureHandle,
  mode: Mode,
): Promise<FixtureRunResult> {
  stack.clearRequestLog();
  const result = await run(["--json"], envFor(mode, stack));
  const requests = stack.requestLog().slice();
  return {
    mode,
    exitCode: result.exitCode,
    output: result.output,
    requests,
  };
}

/** Structural assertions applied to a single fixture run. */
export function assertFixtureRun(result: FixtureRunResult): void {
  assert.equal(result.exitCode, 0, `${result.mode}: exit=${result.exitCode}`);

  // stdout parses as JSON
  const parsed: unknown = JSON.parse(result.output);
  assert.ok(
    parsed && typeof parsed === "object" && "overall" in parsed,
    `${result.mode}: output is not a JSON object with 'overall'`,
  );

  // Each request must satisfy the full allowlist contract:
  //   1. method === GET
  //   2. key is one of the closed 14 allowlist keys
  //   3. service matches ENDPOINTS[key].service
  //   4. raw URL exactly equals ENDPOINTS[key].path (query
  //      string included).
  for (const req of result.requests) {
    assert.equal(
      req.method,
      "GET",
      `${result.mode}: non-GET request observed: ${req.method} ${req.url}`,
    );
    assert.ok(
      req.key !== null && ALL_ALLOWLISTED_KEYS.has(req.key),
      `${result.mode}: request not in allowlist: ${req.url}`,
    );
    const descriptor = ENDPOINTS[req.key];
    assert.equal(
      req.service,
      descriptor.service,
      `${result.mode}: ${req.key} hit wrong service (${req.service} vs ${descriptor.service})`,
    );
    assert.equal(
      req.url,
      descriptor.path,
      `${result.mode}: ${req.key} raw URL differs from allowlist (${req.url} vs ${descriptor.path})`,
    );
  }

  // Token / raw account ID must not appear in stdout.
  assert.equal(
    result.output.includes(FAKE_TOKEN),
    false,
    `${result.mode}: FAKE_TOKEN leaked into stdout`,
  );
  assert.equal(
    result.output.includes(FIXTURE_ACCOUNT_ID),
    false,
    `${result.mode}: raw account ID leaked into stdout`,
  );
  // Masked form should be present so we know the redactor
  // actually fired (as opposed to the payload being empty).
  assert.match(
    result.output,
    /DU-\*\*\*567/,
    `${result.mode}: expected masked account form in output`,
  );

  // Mode-specific request expectations.
  const observedKeys = result.requests
    .map((r) => r.key)
    .filter((k): k is EndpointKey => k !== null);
  if (result.mode === "opt-out") {
    assert.equal(
      result.requests.length,
      13,
      `opt-out: expected 13 requests, got ${result.requests.length}`,
    );
    assert.deepEqual(
      [...observedKeys].sort(),
      [...OPT_OUT_EXPECTED].sort(),
      "opt-out: observed endpoint keys diverge from expected set",
    );
    assert.equal(
      observedKeys.includes("EXECUTION_ACCOUNT_SUMMARY"),
      false,
      "opt-out: account-summary must NOT be called",
    );
  } else {
    assert.equal(
      result.requests.length,
      14,
      `opt-in: expected 14 requests, got ${result.requests.length}`,
    );
    assert.deepEqual(
      [...observedKeys].sort(),
      [...OPT_IN_EXPECTED].sort(),
      "opt-in: observed endpoint keys diverge from expected set",
    );
    const summaryIdx = observedKeys.indexOf("EXECUTION_ACCOUNT_SUMMARY");
    const killIdx = observedKeys.indexOf("EXECUTION_KILL_SWITCH");
    assert.ok(
      summaryIdx >= 0 && killIdx >= 0 && summaryIdx < killIdx,
      "opt-in: account-summary must precede kill-switch",
    );
  }
}

export interface VerifyFixtureFlowResult {
  readonly optOut: FixtureRunResult;
  readonly optIn: FixtureRunResult;
}

/**
 * Verify against an already-created `FixtureHandle`. This
 * function does **not** own the handle — the caller is
 * responsible for `shutdown()`. Suitable for the CLI, which
 * owns the handle so its signal handlers can await shutdown.
 */
export async function verifyFixtureWithHandle(
  stack: FixtureHandle,
): Promise<VerifyFixtureFlowResult> {
  const optOut = await runAgainstFixture(stack, "opt-out");
  assertFixtureRun(optOut);
  const optIn = await runAgainstFixture(stack, "opt-in");
  assertFixtureRun(optIn);
  return { optOut, optIn };
}

/**
 * End-to-end flow: start dynamic-port fixture, run opt-out
 * then opt-in against it, assert both, and always shut the
 * fixture down (including on assertion failure or CLI throw).
 *
 * Convenience wrapper for callers (e.g. unit tests) that do
 * not need signal-shutdown coordination. The CLI does its
 * own explicit handle ownership; see `cli.ts`.
 */
export async function verifyFixtureFlow(): Promise<VerifyFixtureFlowResult> {
  const stack = await startFixtureStack();
  try {
    return await verifyFixtureWithHandle(stack);
  } finally {
    await stack.shutdown();
  }
}
