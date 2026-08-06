/**
 * PR15.1 — env parsing + expected-state validation.
 * Zod-driven, fail-closed. `CONFIG_ERROR` reasons match
 * PR15_1_PLAN §3.3.
 */

import { z } from "zod";

export type RuntimeExpectedState = "registered" | "absent";
export type ExecutionRuntimeExpectedState = "registered" | "absent";
export type TradingLoopExpectedState = "enabled" | "disabled" | "absent";
/**
 * PR15.3 r3 (hostile-review Finding 2) — administrative write
 * gate expected by the operator running the verifier. Distinct
 * from the runtime-registered check: `disabled` means "runtime
 * is wired but `TRADING_ENABLED=false` — Phase A of the Paper
 * Entry E2E runbook", `enabled` means "runtime is wired AND
 * `TRADING_ENABLED=true` — Phase B write window". `absent`
 * means the verifier has no expectation (execution runtime is
 * itself expected absent, so the write gate is not applicable).
 */
export type ExecutionWriteExpectedState = "enabled" | "disabled" | "absent";

export interface ToolConfig {
  readonly ingestionUrl: string;
  readonly signalUrl: string;
  readonly executionUrl: string;
  readonly executionToken: string;
  readonly timeoutMs: number;
  readonly allowNonLoopback: boolean;
  readonly includeAccountSummary: boolean;
  readonly runtimeExpected: RuntimeExpectedState;
  readonly executionRuntimeExpected: ExecutionRuntimeExpectedState;
  readonly tradingLoopExpected: TradingLoopExpectedState;
  readonly executionWriteExpected: ExecutionWriteExpectedState;
  readonly maxTickAgeMs: number;
  readonly maxCandleAgeMs: number;
  readonly maxMarketStateAgeMs: number;
  readonly maxAccountSnapshotAgeMs: number;
  readonly loopStartupGraceMs: number;
  readonly json: boolean;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: ToolConfig }
  | { readonly ok: false; readonly reason: string };

const BooleanFromStringSchema = z
  .union([z.literal("true"), z.literal("false")])
  .transform((v) => v === "true");

const RuntimeStateSchema = z.enum(["registered", "absent"]).default("registered");
const ExecutionRuntimeStateSchema = z
  .enum(["registered", "absent"])
  .default("absent");
const TradingLoopStateSchema = z
  .enum(["enabled", "disabled", "absent"])
  .default("absent");
// PR15.3 r3 — default is `absent` (no expectation) so pre-existing
// callers that never set the flag keep working. When the operator
// explicitly asserts `disabled` (Phase A) or `enabled` (Phase B),
// the verifier compares against execution-engine's
// `/ready.tradingEnabled` field.
const ExecutionWriteExpectedStateSchema = z
  .enum(["enabled", "disabled", "absent"])
  .default("absent");

const EnvSchema = z.object({
  PAPER_VERIFY_INGESTION_URL: z.string().default("http://127.0.0.1:3101"),
  PAPER_VERIFY_SIGNAL_URL: z.string().default("http://127.0.0.1:3102"),
  PAPER_VERIFY_EXECUTION_URL: z.string().default("http://127.0.0.1:3103"),
  PAPER_VERIFY_EXECUTION_TOKEN: z.string().optional(),
  EXECUTION_API_TOKEN: z.string().optional(),
  PAPER_VERIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  PAPER_VERIFY_ALLOW_NON_LOOPBACK: BooleanFromStringSchema.default("false"),
  PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY:
    BooleanFromStringSchema.default("false"),
  PAPER_VERIFY_RUNTIME_EXPECTED_STATE: RuntimeStateSchema,
  PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: ExecutionRuntimeStateSchema,
  PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: TradingLoopStateSchema,
  PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE:
    ExecutionWriteExpectedStateSchema,
  PAPER_VERIFY_MAX_TICK_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),
  PAPER_VERIFY_MAX_CANDLE_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(180_000),
  PAPER_VERIFY_MAX_MARKET_STATE_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),
  PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  PAPER_VERIFY_LOOP_STARTUP_GRACE_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(0),
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function validateUrl(raw: string, allowNonLoopback: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return "url_carries_credentials";
  }
  if (!allowNonLoopback && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return "url_not_loopback";
  }
  return null;
}

export function parseConfig(
  env: Record<string, string | undefined>,
  args: readonly string[] = [],
): ConfigResult {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    return { ok: false, reason: "env_parse_failed" };
  }
  const e = parsed.data;
  const jsonFlag = args.includes("--json");
  const urls: readonly [string, string][] = [
    ["ingestion", e.PAPER_VERIFY_INGESTION_URL],
    ["signal", e.PAPER_VERIFY_SIGNAL_URL],
    ["execution", e.PAPER_VERIFY_EXECUTION_URL],
  ];
  for (const [name, url] of urls) {
    const err = validateUrl(url, e.PAPER_VERIFY_ALLOW_NON_LOOPBACK);
    if (err) {
      return { ok: false, reason: `${err}:${name}` };
    }
  }
  const runtime = e.PAPER_VERIFY_RUNTIME_EXPECTED_STATE;
  const executionRuntime = e.PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE;
  const loop = e.PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE;
  // PR15_1_PLAN §3.3 — four allowed combinations.
  if (runtime === "absent" && executionRuntime === "registered") {
    return { ok: false, reason: "execution_runtime_requires_runtime" };
  }
  if (executionRuntime === "absent" && loop === "enabled") {
    return { ok: false, reason: "trading_loop_requires_execution_runtime" };
  }
  if (executionRuntime === "absent" && loop === "disabled") {
    return { ok: false, reason: "trading_loop_requires_execution_runtime" };
  }
  if (executionRuntime === "registered" && loop === "absent") {
    return {
      ok: false,
      reason:
        "trading_loop_endpoints_always_registered_with_execution_runtime",
    };
  }
  const write = e.PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE;
  // PR15.3 r3 — the write-state expectation is only meaningful
  // when the execution runtime is in scope. Reject the mismatch
  // early so operators cannot silently mis-configure the flag
  // with an absent runtime. When the runtime IS registered,
  // `absent` is still accepted (backwards-compat) — the operator
  // can leave the flag unset to keep the pre-PR15.3-r3 behaviour
  // where `tradingEnabled` is only echoed, not asserted. The
  // Paper Entry E2E runbook (Phase A / Phase B) MUST set the
  // flag explicitly.
  if (executionRuntime === "absent" && write !== "absent") {
    return {
      ok: false,
      reason: "execution_write_expected_requires_execution_runtime",
    };
  }
  const token =
    e.PAPER_VERIFY_EXECUTION_TOKEN && e.PAPER_VERIFY_EXECUTION_TOKEN.length > 0
      ? e.PAPER_VERIFY_EXECUTION_TOKEN
      : e.EXECUTION_API_TOKEN && e.EXECUTION_API_TOKEN.length > 0
        ? e.EXECUTION_API_TOKEN
        : undefined;
  // PR15_1_PLAN §3.3 — execution URL is always in scope; token
  // is mandatory. Fail-fast so no HTTP request ever fires.
  if (token === undefined) {
    return { ok: false, reason: "execution_token_missing" };
  }
  return {
    ok: true,
    config: {
      ingestionUrl: e.PAPER_VERIFY_INGESTION_URL,
      signalUrl: e.PAPER_VERIFY_SIGNAL_URL,
      executionUrl: e.PAPER_VERIFY_EXECUTION_URL,
      executionToken: token,
      timeoutMs: e.PAPER_VERIFY_TIMEOUT_MS,
      allowNonLoopback: e.PAPER_VERIFY_ALLOW_NON_LOOPBACK,
      includeAccountSummary: e.PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY,
      runtimeExpected: runtime,
      executionRuntimeExpected: executionRuntime,
      tradingLoopExpected: loop,
      executionWriteExpected: write,
      maxTickAgeMs: e.PAPER_VERIFY_MAX_TICK_AGE_MS,
      maxCandleAgeMs: e.PAPER_VERIFY_MAX_CANDLE_AGE_MS,
      maxMarketStateAgeMs: e.PAPER_VERIFY_MAX_MARKET_STATE_AGE_MS,
      maxAccountSnapshotAgeMs: e.PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS,
      loopStartupGraceMs: e.PAPER_VERIFY_LOOP_STARTUP_GRACE_MS,
      json: jsonFlag,
    },
  };
}
