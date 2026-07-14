/**
 * Execution Runtime — configuration.
 *
 * PR13 adds a paper-only write endpoint (`POST /runtime/execute`)
 * inside `apps/signal-engine`. The knobs below are the ONLY ones
 * introduced by PR13.
 *
 * Live impossibility: `EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT` is
 * schema-enforced to the literal string `"paper"`. Any other value
 * fails startup. Enabling live requires a code change plus the
 * paper-guard runtime check.
 */

import { z } from "zod";

/**
 * Zod schema exported so callers (`apps/signal-engine/src/config.ts`)
 * can merge it into the top-level schema. Kept as a separate module
 * so the tests can validate it in isolation without loading the
 * full signal-engine config surface.
 */
export const executionRuntimeSchema = z.object({
  /**
   * Kill-switch for the write endpoint. Default `"false"` — the
   * write path is OFF by default. Even setting it to `"true"` alone
   * cannot enable live trading (see `EXPECTED_ENVIRONMENT`).
   */
  EXECUTION_RUNTIME_ENABLED: z.string().default("false"),
  /**
   * URL of the execution-engine. Optional — when omitted we fall
   * back to the signal-engine's existing `SIGNAL_EXECUTION_BASE_URL`
   * so no additional config is required in the common case.
   */
  EXECUTION_RUNTIME_ENGINE_URL: z.string().optional(),
  /**
   * Total HTTP timeout in milliseconds for a single call to
   * `POST /execution/execute-ticket`. On timeout the runtime does
   * NOT retry — the outcome is reported as `UNKNOWN` and a manual
   * reconciliation pass (later PR) will determine broker state.
   */
  EXECUTION_RUNTIME_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(5_000),
  /**
   * Paper-only guard. Hard-coded literal — this env is INTENTIONALLY
   * not switchable to "live" because PR13 does not implement any
   * live-trading logic. A future live PR must remove this literal
   * AND satisfy the checklist in
   * `docs/implementation/phase2/PHASE_2_ROADMAP.md` (PR18).
   */
  EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT: z.literal("paper").default("paper"),
});

export type ExecutionRuntimeEnv = z.infer<typeof executionRuntimeSchema>;

/**
 * Derived runtime config with normalised units. Consumed by the
 * runtime factory in `apps/signal-engine/src/index.ts`.
 */
export interface ExecutionRuntimeConfig {
  readonly enabled: boolean;
  readonly engineUrl: string;
  readonly requestTimeoutMs: number;
  readonly expectedEnvironment: "paper";
}

export function buildExecutionRuntimeConfig(input: {
  readonly env: ExecutionRuntimeEnv;
  /** Fallback URL when `EXECUTION_RUNTIME_ENGINE_URL` is unset. */
  readonly fallbackEngineUrl: string;
}): ExecutionRuntimeConfig {
  return {
    enabled: input.env.EXECUTION_RUNTIME_ENABLED.toLowerCase() === "true",
    engineUrl:
      input.env.EXECUTION_RUNTIME_ENGINE_URL ?? input.fallbackEngineUrl,
    requestTimeoutMs: input.env.EXECUTION_RUNTIME_REQUEST_TIMEOUT_MS,
    expectedEnvironment: input.env.EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT,
  };
}
