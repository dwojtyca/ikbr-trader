/**
 * PR15 — reconciliation scheduler.
 *
 * See docs/implementation/phase2/PR15_PLAN.md §7.
 *
 * - Non-overlapping: an in-process `AsyncMutex` drops overlapping
 *   ticks; the authoritative serialiser is
 *   `pg_try_advisory_lock(hashtext('recon:<accountId>'))` held on
 *   a dedicated `PoolClient` inside `ReconciliationRunner`.
 * - `AbortSignal` cancellation on run timeout so pending broker
 *   listeners can be cleaned up.
 * - Graceful shutdown: `stop()` awaits any in-flight run.
 * - Reconnect: `triggerNow()` fires an immediate extra tick.
 */

import type { Logger } from "pino";

import type { ReconciliationRunner, RunReport, RunnerContext } from "./runner.js";

export interface SchedulerConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly startupDelayMs: number;
  readonly minIntervalMs: number;
  readonly sourceTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly executionSafetyMarginMs: number;
}

export interface AccountResolver {
  currentContext(): RunnerContext | null;
}

export class ReconciliationScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #stopping = false;
  #inflight: Promise<RunReport | null> | null = null;
  #lastRun: RunReport | null = null;
  #lastError: Error | null = null;

  constructor(
    private readonly runner: ReconciliationRunner,
    private readonly resolveAccount: AccountResolver,
    private readonly config: SchedulerConfig,
    private readonly logger: Pick<Logger, "info" | "warn" | "error"> = console as unknown as Logger,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      this.logger.info("reconciliation scheduler disabled by config");
      return;
    }
    if (this.#timer) return;
    const delay = Math.max(0, this.config.startupDelayMs);
    this.logger.info(
      `reconciliation scheduler starting; first tick in ${delay}ms`,
    );
    const interval = Math.max(
      this.config.minIntervalMs,
      this.config.intervalMs,
    );
    const tick = () => {
      void this.#tick();
    };
    setTimeout(() => {
      tick();
      this.#timer = setInterval(tick, interval);
    }, delay);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#inflight) {
      await this.#inflight.catch(() => undefined);
    }
  }

  /**
   * Fire an extra tick immediately (used on broker reconnect,
   * manual /reconciliation/run trigger).
   */
  async triggerNow(): Promise<RunReport | null> {
    return this.#tick();
  }

  async triggerFresh(): Promise<RunReport | null> {
    // Await the old capture rather than treating its completion as a new observation.
    while (this.#inflight) await this.#inflight;
    return this.#tick();
  }

  lastRun(): RunReport | null {
    return this.#lastRun;
  }
  lastError(): Error | null {
    return this.#lastError;
  }

  async #tick(): Promise<RunReport | null> {
    if (this.#running) {
      // Drop overlapping tick (§7 Non-overlapping).
      return null;
    }
    if (this.#stopping) return null;
    const context = this.resolveAccount.currentContext();
    if (!context) {
      // No active broker account yet — quietly skip.
      return null;
    }
    this.#running = true;
    this.#lastError = null;
    const promise = (async () => {
      try {
        const report = await this.runner.runOnce(context, {
          runTimeoutMs: this.config.runTimeoutMs,
          sourceTimeoutMs: this.config.sourceTimeoutMs,
          executionSafetyMarginMs: this.config.executionSafetyMarginMs,
        });
        if (report) {
          this.#lastRun = report;
          this.logger.info(
            {
              runId: report.runId,
              status: report.status,
              matches: report.matches,
              mismatches: report.mismatches,
              exposureComplete: report.exposureComplete,
              recoveryComplete: report.recoveryComplete,
            },
            "reconciliation run finished",
          );
        }
        return report;
      } catch (err) {
        this.#lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          { err: this.#lastError.message },
          "reconciliation tick failed",
        );
        return null;
      } finally {
        this.#running = false;
        this.#inflight = null;
      }
    })();
    this.#inflight = promise;
    return promise;
  }
}
