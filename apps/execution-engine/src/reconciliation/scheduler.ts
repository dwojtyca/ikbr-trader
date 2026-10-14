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
import { performance } from 'node:perf_hooks';
import { emitBrokerPhase, type BrokerPhaseDiagnostics } from './phase-diagnostics.js';

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
export interface SchedulerCoordination {
  currentIdentity(): { connected: boolean; accountId: string | null; sessionId: string; generation: number };
  periodicProof(context: RunnerContext, runId: number): Promise<{ generation: number; acquiredAt: number } | null>;
  diagnostics?: BrokerPhaseDiagnostics;
  monotonicNow?: () => number;
  wallNow?: () => number;
}
interface PeriodicReceipt { context: RunnerContext; runId: number; started: number; wallStarted: number; generation: number; acquiredAt: number }

export class ReconciliationScheduler {
  #timer: NodeJS.Timeout | null = null;
  #startupTimer: NodeJS.Timeout | null = null;
  #running = false;
  #stopping = false;
  #inflight: Promise<RunReport | null> | null = null;
  #lastRun: RunReport | null = null;
  #lastError: Error | null = null;
  #receipt: PeriodicReceipt | null = null;

  constructor(
    private readonly runner: ReconciliationRunner,
    private readonly resolveAccount: AccountResolver,
    private readonly config: SchedulerConfig,
    private readonly logger: Pick<Logger, "info" | "warn" | "error"> = console as unknown as Logger,
    private readonly coordination?: SchedulerCoordination,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      this.logger.info("reconciliation scheduler disabled by config");
      return;
    }
    if (this.#timer || this.#startupTimer || this.#stopping) return;
    const delay = Math.max(0, this.config.startupDelayMs);
    this.logger.info(
      `reconciliation scheduler starting; first tick in ${delay}ms`,
    );
    const interval = Math.max(
      this.config.minIntervalMs,
      this.config.intervalMs,
    );
    const tick = () => {
      void this.#tick('periodic');
    };
    this.#startupTimer = setTimeout(() => {
      this.#startupTimer = null;
      if (this.#stopping) return;
      tick();
      this.#timer = setInterval(tick, interval);
    }, delay);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#startupTimer) { clearTimeout(this.#startupTimer); this.#startupTimer = null; }
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
    return this.#tick('explicit');
  }

  async triggerFresh(): Promise<RunReport | null> {
    // Await the old capture rather than treating its completion as a new observation.
    const started = performance.now();
    while (this.#inflight) await this.#inflight;
    emitBrokerPhase(this.coordination?.diagnostics, 'scheduler.wait', 'ok', { caller: 'fresh' }, performance.now() - started);
    return this.#tick('fresh');
  }

  lastRun(): RunReport | null {
    return this.#lastRun;
  }
  lastError(): Error | null {
    return this.#lastError;
  }

  private monotonicNow() { return this.coordination?.monotonicNow?.() ?? performance.now(); }
  private wallNow() { return this.coordination?.wallNow?.() ?? Date.now(); }
  private identityMatches(context: RunnerContext, generation: number): boolean {
    const identity = this.coordination?.currentIdentity(), current = this.resolveAccount.currentContext();
    return !!identity?.connected && identity.accountId === context.accountId && identity.sessionId === context.sessionId
      && identity.generation === generation && current?.accountId === context.accountId && current.sessionId === context.sessionId;
  }
  private receiptFresh(receipt: PeriodicReceipt): boolean {
    const elapsed = this.monotonicNow() - receipt.started, wall = this.wallNow();
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 5000 && wall >= receipt.wallStarted
      && wall - receipt.wallStarted <= 5000 && Number.isFinite(receipt.acquiredAt) && receipt.acquiredAt >= receipt.wallStarted
      && receipt.acquiredAt <= wall && wall - receipt.acquiredAt <= 5000;
  }
  private async skipPeriodic(context: RunnerContext): Promise<boolean> {
    const receipt = this.#receipt;
    if (!this.coordination || !receipt || receipt.context.accountId !== context.accountId || receipt.context.sessionId !== context.sessionId
      || !this.receiptFresh(receipt) || !this.identityMatches(context, receipt.generation)) return false;
    try {
      const proof = await this.coordination.periodicProof(context, receipt.runId);
      if (!proof || proof.generation !== receipt.generation || proof.acquiredAt !== receipt.acquiredAt
        || !this.receiptFresh(receipt) || !this.identityMatches(context, receipt.generation)) return false;
      emitBrokerPhase(this.coordination.diagnostics, 'scheduler.capture', 'skipped', { caller: 'periodic', runId: receipt.runId,
        generation: receipt.generation, reason: 'recent_complete_capture' });
      return true;
    } catch (error) {
      emitBrokerPhase(this.coordination.diagnostics, 'scheduler.periodic_proof', 'error', { caller: 'periodic', runId: receipt.runId }, undefined, error);
      return false;
    }
  }
  async #tick(caller: 'periodic' | 'explicit' | 'fresh'): Promise<RunReport | null> {
    if (this.#running) {
      // Drop overlapping tick (§7 Non-overlapping).
      emitBrokerPhase(this.coordination?.diagnostics, 'scheduler.capture', 'skipped', { caller, reason: 'capture_in_progress' });
      return null;
    }
    if (this.#stopping) return null;
    const context = this.resolveAccount.currentContext();
    if (!context) {
      this.#receipt = null;
      // No active broker account yet — quietly skip.
      return null;
    }
    this.#running = true;
    this.#lastError = null;
    let settle!: (report: RunReport | null) => void;
    const promise = new Promise<RunReport | null>(resolve => { settle = resolve; });
    this.#inflight = promise;
    void (async () => {
      try {
        if (caller === 'periodic' && await this.skipPeriodic(context)) return null;
        if (this.#stopping) return null;
        this.#receipt = null;
        const started = this.monotonicNow(), wallStarted = this.wallNow();
        const initialGeneration = this.coordination?.currentIdentity().generation;
        const captureStarted = performance.now();
        let report: RunReport | null;
        try {
          report = await this.runner.runOnce(context, {
            runTimeoutMs: this.config.runTimeoutMs,
            sourceTimeoutMs: this.config.sourceTimeoutMs,
            executionSafetyMarginMs: this.config.executionSafetyMarginMs,
          });
          emitBrokerPhase(this.coordination?.diagnostics, 'scheduler.capture', !report ? 'skipped' : report.status === 'CLEAN' ? 'ok' : 'error',
            { caller, runId: report?.runId, reason: report?.status ?? 'run_unavailable' }, performance.now() - captureStarted,
            report?.error ? { message: report.error } : undefined);
        } catch (error) {
          emitBrokerPhase(this.coordination?.diagnostics, 'scheduler.capture', 'error', { caller }, performance.now() - captureStarted, error);
          throw error;
        }
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
          if (this.coordination && initialGeneration !== undefined && report.status === 'CLEAN' && report.exposureComplete
            && report.recoveryComplete && !report.error && report.mismatches === 0 && report.holdsCreated === 0
            && this.identityMatches(context, initialGeneration)) {
            try {
              const proof = await this.coordination.periodicProof(context, report.runId);
              const receipt = proof && { context, runId: report.runId, started, wallStarted, ...proof };
              if (receipt && proof.generation === initialGeneration && this.receiptFresh(receipt) && this.identityMatches(context, initialGeneration)) this.#receipt = receipt;
            } catch (error) {
              emitBrokerPhase(this.coordination.diagnostics, 'scheduler.periodic_proof', 'error', { caller, runId: report.runId }, undefined, error);
            }
          }
        }
        return report;
      } catch (err) {
        this.#lastError = err instanceof Error ? err : new Error(String(err));
        emitBrokerPhase(this.coordination?.diagnostics, 'scheduler.tick', 'error', { caller }, undefined, err);
        this.logger.error(
          { caller },
          "reconciliation tick failed",
        );
        return null;
      } finally {
        this.#running = false;
        this.#inflight = null;
      }
    })().then(settle, () => settle(null));
    return promise;
  }
}
