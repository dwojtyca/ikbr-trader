/**
 * Trading Loop — configuration schema.
 *
 * PR14 adds a paper-only scheduler that periodically drives the
 * PR13 ExecutionRuntime. Every knob below is namespaced with
 * `TRADING_LOOP_*`; nothing here can enable Live trading (the
 * paper-only enforcement lives in `execution-runtime` and
 * `PaperGuard`).
 *
 * Defaults are chosen so a fresh checkout with `docker compose up`
 * does NOT run the loop; enabling requires explicit opt-in.
 */

import { z } from "zod";

/**
 * Hard floor on the scheduler interval. Prevents accidentally
 * ticking at 100 ms and hammering execution-engine. 5 s matches
 * the "safe minimum" in the PR14 spec.
 */
export const TRADING_LOOP_INTERVAL_MIN_MS = 5_000;

export const tradingLoopSchema = z.object({
  /**
   * Master kill-switch. Default `"false"` — the loop lifecycle is
   * NOT started, `setInterval` is not scheduled, no exposure reads
   * happen. The status endpoint reports `enabled: false`.
   */
  TRADING_LOOP_ENABLED: z.string().default("false"),
  /**
   * Ticker interval in milliseconds. A tick returns quickly (does
   * NOT await instrument runs) so `setInterval` cannot pile up
   * backlog. Runs still-in-progress are guarded by
   * `TradingLoopService`'s per-instrument map — the interval only
   * controls how often new runs are considered.
   */
  TRADING_LOOP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(TRADING_LOOP_INTERVAL_MIN_MS)
    .default(30_000),
  /**
   * Delay from `start()` to the first tick. Gives the underlying
   * runtimes (market data + execution) time to warm up before the
   * loop attempts any submission.
   */
  TRADING_LOOP_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(1_000),
  /**
   * Global concurrency cap across all instruments. Additional
   * instruments in the same tick are skipped with
   * `CONCURRENCY_CAP` and re-considered on the next tick — no
   * queuing.
   */
  TRADING_LOOP_MAX_CONCURRENT_INSTRUMENTS: z.coerce
    .number()
    .int()
    .min(1)
    .default(2),
  /**
   * CSV of instrument IDs to constrain the loop scope. Empty →
   * scope is `registry.listExecutionEnabled() ∩ listSignalEnabled()
   * ∩ listMonitoringEnabled()`. IDs outside the registry are
   * ignored with a startup warning; the loop NEVER accepts
   * arbitrary symbols.
   */
  TRADING_LOOP_INSTRUMENT_IDS: z.string().default(""),
  /**
   * Grace period on shutdown to wait for in-flight instrument
   * runs. On timeout the process still exits — reconciliation
   * (later PR) resolves any ambiguous state.
   */
  TRADING_LOOP_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(10_000),
  /**
   * Timeout for a single `TradingExposureReader.readExposure` call.
   * On timeout the loop fails-closed (skip = `EXPOSURE_READ_FAILED`),
   * NEVER submits.
   */
  TRADING_LOOP_EXPOSURE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(3_000),
});

export type TradingLoopEnv = z.infer<typeof tradingLoopSchema>;

export interface TradingLoopConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly startupDelayMs: number;
  readonly maxConcurrentInstruments: number;
  readonly instrumentIds: readonly string[];
  readonly shutdownTimeoutMs: number;
  readonly exposureTimeoutMs: number;
}

/**
 * Parse a "true"/"false" style flag with case-insensitive matching.
 * Same helper as `execution-runtime` for consistency.
 */
function toBoolean(raw: string): boolean {
  return raw.trim().toLowerCase() === "true";
}

/**
 * Split a CSV string into a de-duplicated list of trimmed non-empty
 * ids. Whitespace around commas is tolerated.
 */
function parseCsvIds(raw: string): readonly string[] {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return Array.from(new Set(parts));
}

export function buildTradingLoopConfig(input: {
  readonly env: TradingLoopEnv;
}): TradingLoopConfig {
  const env = input.env;
  return {
    enabled: toBoolean(env.TRADING_LOOP_ENABLED),
    intervalMs: env.TRADING_LOOP_INTERVAL_MS,
    startupDelayMs: env.TRADING_LOOP_STARTUP_DELAY_MS,
    maxConcurrentInstruments: env.TRADING_LOOP_MAX_CONCURRENT_INSTRUMENTS,
    instrumentIds: parseCsvIds(env.TRADING_LOOP_INSTRUMENT_IDS),
    shutdownTimeoutMs: env.TRADING_LOOP_SHUTDOWN_TIMEOUT_MS,
    exposureTimeoutMs: env.TRADING_LOOP_EXPOSURE_TIMEOUT_MS,
  };
}
