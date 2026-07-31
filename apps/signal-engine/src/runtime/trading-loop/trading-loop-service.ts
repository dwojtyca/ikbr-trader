/**
 * Trading Loop — core service.
 *
 * Owns the scheduler lifecycle inside `apps/signal-engine`. NO
 * HTTP dependency (routes are a thin wrapper), NO ambient
 * `setInterval` in module scope (the timer is owned by an instance
 * that can be cleanly stopped for tests and shutdown).
 *
 * ## Round-2 blocker fixes
 *
 * 1. **Every non-terminal `PROPOSED` blocks a new trade intent.**
 *    A clean orphan `PROPOSED` (no marker) is safe to RESUME under
 *    its own `clientOrderId` but MUST NOT be shadowed by a fresh
 *    insert under a NEW `clientOrderId`. Reconciliation (PR15)
 *    owns orphan recovery.
 *
 * 2. **Idempotency key is anchored to the trade INTENT, not the
 *    wall clock.** We call `MarketDataRuntime.dryRun` ONCE per
 *    instrument tick, extract a stable trigger identity from
 *    `snapshot.sections.price.observedAt`, build the key, and
 *    hand the pre-computed pipeline result to
 *    `ExecutionRuntime.executePrepared` — no double pipeline
 *    invocation.
 *
 * 3. **Exposure reads are strictly schema-validated.** Malformed
 *    or partial responses from execution-engine surface as
 *    `TradingExposureReadError` and the loop skips fail-closed.
 *
 * ## Invariants
 *
 *   - Per-instrument non-overlap: `Map<instrumentId, Promise<void>>`
 *   - Global concurrency cap; missed ticks NEVER queued
 *   - Tick returns quickly (does NOT await instrument runs)
 *   - `stop()` refuses new work, waits for in-flight up to timeout
 *   - Loop NEVER contacts the broker directly
 *   - Loop NEVER opens a second position when any exposure flag is set
 *   - Loop NEVER runs the pipeline twice for a single instrument cycle
 */

import { randomUUID } from "node:crypto";

import type {
  ExecutionTicketPolicy,
  Instrument,
  InstrumentBindingAuthority,
  InstrumentExecutionPolicy,
  InstrumentRegistry,
} from "@ikbr/shared";
import { mapAssetClassToIbkrSecType } from "@ikbr/shared";
import type { FastifyBaseLogger } from "fastify";

import type { DryRunResult, MarketDataRuntime } from "../runtime.js";
import type { ExecutionRuntime } from "../execution/execution-runtime.js";

import type { TradingLoopConfig } from "./config.js";
import { TradingLoopIdempotencyKeyBuilder } from "./idempotency-key.js";
import type {
  TradingExposure,
  TradingExposureReader,
  TradingLoopCycleReport,
  TradingLoopInstrumentOutcome,
  TradingLoopInstrumentReport,
  TradingLoopStatus,
  TriggerIdentity,
} from "./types.js";
import type { ReconciliationReader } from "./reconciliation-reader.js";

export interface TradingLoopServiceOptions {
  readonly config: TradingLoopConfig;
  readonly registry: InstrumentRegistry;
  /**
   * PR15.2 — server-side authority mapping logical `instrumentId`
   * to the exact operator-selected IBKR contract. Optional in
   * test wiring so pre-PR15.2 fakes keep working; production
   * MUST supply one via `INSTRUMENT_BINDINGS_JSON`. When
   * present, the loop refuses to run any instrument that lacks
   * a binding — no symbol-only fallback for market data,
   * reconciliation, or ticket assembly.
   */
  readonly bindingAuthority?: InstrumentBindingAuthority;
  readonly marketDataRuntime: MarketDataRuntime;
  readonly executionRuntime: ExecutionRuntime;
  readonly exposureReader: TradingExposureReader;
  /**
   * PR15 — optional fail-closed reconciliation pre-check. When
   * provided, runs BEFORE the exposure guard for every instrument
   * tick; any non-`pass` outcome skips the instrument with a
   * `RECONCILIATION_*` reason. Left `undefined` in unit tests
   * that pre-date PR15.
   */
  readonly reconciliationReader?: ReconciliationReader;
  readonly logger: Pick<FastifyBaseLogger, "info" | "warn" | "error" | "debug">;
  /** Test hook. Defaults to `new Date()`. */
  readonly clock?: () => Date;
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

const HISTORY_LIMIT = 100;

/**
 * PR15 §4 — trusted mapping from the shared `AssetClass` union
 * to IBKR `secType`. Signal-engine never guesses / infers this
 * from string prefixes; the reconciliation identity fallback
 * requires a mapped value AND the full symbol/exchange/currency
 * tuple.
 *
 * PR15.2 hostile-review round-3 — delegated to the shared
 * `mapAssetClassToIbkrSecType` so ingestion and signal-engine
 * cannot drift apart. Kept as a thin adapter so existing
 * call-sites continue to see the `string | null` shape.
 */
function mapAssetClassToSecType(
  assetClass: Instrument["assetClass"],
): string | null {
  try {
    return mapAssetClassToIbkrSecType(assetClass);
  } catch {
    return null;
  }
}

export class TradingLoopService {
  readonly #config: TradingLoopConfig;
  readonly #registry: InstrumentRegistry;
  readonly #bindingAuthority: InstrumentBindingAuthority | null;
  readonly #marketDataRuntime: MarketDataRuntime;
  readonly #executionRuntime: ExecutionRuntime;
  readonly #exposureReader: TradingExposureReader;
  readonly #reconciliationReader: ReconciliationReader | null;
  readonly #logger: TradingLoopServiceOptions["logger"];
  readonly #clock: () => Date;
  readonly #setTimeoutFn: typeof setTimeout;
  readonly #clearTimeoutFn: typeof clearTimeout;
  readonly #setIntervalFn: typeof setInterval;
  readonly #clearIntervalFn: typeof clearInterval;
  readonly #keyBuilder: TradingLoopIdempotencyKeyBuilder;

  #startupTimer: ReturnType<typeof setTimeout> | null = null;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #startedAt: Date | null = null;
  #lastCycleAt: Date | null = null;
  #nextCycleAt: Date | null = null;
  #stopping = false;
  #cycleCount = 0;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #lastOutcomes = new Map<string, TradingLoopInstrumentReport>();

  constructor(options: TradingLoopServiceOptions) {
    if (!options?.config)
      throw new Error("TradingLoopService: config is required");
    if (!options.registry)
      throw new Error("TradingLoopService: registry is required");
    if (!options.marketDataRuntime) {
      throw new Error("TradingLoopService: marketDataRuntime is required");
    }
    if (!options.executionRuntime) {
      throw new Error("TradingLoopService: executionRuntime is required");
    }
    if (!options.exposureReader) {
      throw new Error("TradingLoopService: exposureReader is required");
    }
    if (!options.logger)
      throw new Error("TradingLoopService: logger is required");
    this.#config = options.config;
    this.#registry = options.registry;
    this.#bindingAuthority = options.bindingAuthority ?? null;
    this.#marketDataRuntime = options.marketDataRuntime;
    this.#executionRuntime = options.executionRuntime;
    this.#exposureReader = options.exposureReader;
    this.#reconciliationReader = options.reconciliationReader ?? null;
    this.#logger = options.logger;
    this.#clock = options.clock ?? (() => new Date());
    this.#setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.#clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.#setIntervalFn = options.setIntervalFn ?? setInterval;
    this.#clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.#keyBuilder = new TradingLoopIdempotencyKeyBuilder();
  }

  start(): void {
    if (!this.#config.enabled) {
      this.#logger.info(
        { component: "trading-loop" },
        "trading-loop: disabled by config, scheduler not started",
      );
      return;
    }
    if (this.#startedAt !== null) {
      this.#logger.warn(
        { component: "trading-loop" },
        "trading-loop: start() called twice, ignoring",
      );
      return;
    }
    this.#startedAt = this.#clock();
    this.#nextCycleAt = new Date(
      this.#startedAt.getTime() + this.#config.startupDelayMs,
    );
    this.#logger.info(
      {
        component: "trading-loop",
        intervalMs: this.#config.intervalMs,
        startupDelayMs: this.#config.startupDelayMs,
        maxConcurrentInstruments: this.#config.maxConcurrentInstruments,
        instrumentCsv: this.#config.instrumentIds,
      },
      "trading-loop: starting scheduler",
    );
    this.#startupTimer = this.#setTimeoutFn(() => {
      this.#startupTimer = null;
      if (this.#stopping) return;
      void this.#safeTick();
      this.#tickTimer = this.#setIntervalFn(
        () => void this.#safeTick(),
        this.#config.intervalMs,
      );
    }, this.#config.startupDelayMs);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.#startupTimer !== null) {
      this.#clearTimeoutFn(this.#startupTimer);
      this.#startupTimer = null;
    }
    if (this.#tickTimer !== null) {
      this.#clearIntervalFn(this.#tickTimer);
      this.#tickTimer = null;
    }
    this.#nextCycleAt = null;
    const timeoutMs = this.#config.shutdownTimeoutMs;
    const runs = Array.from(this.#inFlight.values());
    if (runs.length === 0) {
      this.#logger.info(
        { component: "trading-loop" },
        "trading-loop: stopped (no in-flight runs)",
      );
      return;
    }
    this.#logger.info(
      { component: "trading-loop", inFlight: runs.length, timeoutMs },
      "trading-loop: waiting for in-flight runs to drain",
    );
    const drain = Promise.allSettled(runs).then(() => "drained" as const);
    const timeout = new Promise<"timeout">((resolve) => {
      const t = this.#setTimeoutFn(() => resolve("timeout"), timeoutMs);
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
    });
    const result = await Promise.race([drain, timeout]);
    if (result === "timeout") {
      this.#logger.warn(
        { component: "trading-loop", inFlight: this.#inFlight.size },
        "trading-loop: shutdown drain timed out, exiting with in-flight runs",
      );
    } else {
      this.#logger.info(
        { component: "trading-loop" },
        "trading-loop: stopped (drained)",
      );
    }
  }

  async runOnce(): Promise<TradingLoopCycleReport> {
    if (this.#stopping) {
      const now = this.#clock();
      return {
        cycleId: randomUUID(),
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        reports: [],
      };
    }
    return this.#runCycle();
  }

  status(): TradingLoopStatus {
    const lastOutcomes: Record<string, TradingLoopInstrumentReport> = {};
    for (const [id, report] of this.#lastOutcomes.entries()) {
      lastOutcomes[id] = report;
    }
    return {
      enabled: this.#config.enabled,
      running:
        this.#config.enabled && this.#startedAt !== null && !this.#stopping,
      startedAt: this.#startedAt,
      lastCycleAt: this.#lastCycleAt,
      nextCycleAt: this.#nextCycleAt,
      activeInstruments: Array.from(this.#inFlight.keys()),
      lastOutcomes,
      cycleCount: this.#cycleCount,
    };
  }

  // ------------------------------------------------------------------
  // Internal — cycle + per-instrument run
  // ------------------------------------------------------------------

  async #safeTick(): Promise<void> {
    try {
      await this.#runCycle();
    } catch (error) {
      this.#logger.error(
        {
          component: "trading-loop",
          err: error instanceof Error ? error.message : String(error),
        },
        "trading-loop: unexpected tick failure",
      );
    }
  }

  async #runCycle(): Promise<TradingLoopCycleReport> {
    const cycleId = randomUUID();
    const startedAt = this.#clock();
    this.#lastCycleAt = startedAt;
    this.#cycleCount += 1;
    this.#nextCycleAt = this.#config.enabled
      ? new Date(startedAt.getTime() + this.#config.intervalMs)
      : null;

    const instruments = this.#selectInstruments();
    const reports: TradingLoopInstrumentReport[] = [];
    const promises: Promise<void>[] = [];

    for (const instrument of instruments) {
      if (this.#stopping) {
        this.#recordSkip(cycleId, instrument.id, "LOOP_DISABLED", reports);
        continue;
      }
      if (this.#inFlight.has(instrument.id)) {
        this.#recordSkip(cycleId, instrument.id, "RUN_IN_PROGRESS", reports);
        continue;
      }
      if (this.#inFlight.size >= this.#config.maxConcurrentInstruments) {
        this.#recordSkip(cycleId, instrument.id, "CONCURRENCY_CAP", reports);
        continue;
      }
      const runPromise = this.#runInstrument(cycleId, instrument)
        .then((report) => {
          reports.push(report);
        })
        .catch((error) => {
          this.#logger.error(
            {
              component: "trading-loop",
              cycleId,
              instrumentId: instrument.id,
              err: error instanceof Error ? error.message : String(error),
            },
            "trading-loop: unexpected instrument run failure",
          );
          reports.push({
            cycleId,
            instrumentId: instrument.id,
            startedAt: this.#clock(),
            finishedAt: this.#clock(),
            durationMs: 0,
            outcome: {
              kind: "ERROR",
              instrumentId: instrument.id,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        })
        .finally(() => {
          this.#inFlight.delete(instrument.id);
        });
      this.#inFlight.set(instrument.id, runPromise);
      promises.push(runPromise);
    }

    await Promise.all(promises);
    const finishedAt = this.#clock();
    for (const report of reports) {
      this.#lastOutcomes.set(report.instrumentId, report);
    }
    while (this.#lastOutcomes.size > HISTORY_LIMIT) {
      const oldestKey = this.#lastOutcomes.keys().next().value;
      if (oldestKey === undefined) break;
      this.#lastOutcomes.delete(oldestKey);
    }
    return {
      cycleId,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      reports,
    };
  }

  async #runInstrument(
    cycleId: string,
    instrument: Instrument,
  ): Promise<TradingLoopInstrumentReport> {
    const startedAt = this.#clock();

    // ---- PR15.2 binding gate (fail-closed) --------------------------
    // The loop refuses to publish market-data / reconciliation
    // / ticket identity for any instrument that lacks an
    // authoritative binding. `SKIPPED / INSTRUMENT_BINDING_UNAVAILABLE`
    // surfaces at the status endpoint AND the pino log stream;
    // NO raw configuration payload is logged.
    const bound = this.#bindingAuthority
      ? this.#bindingAuthority.getBoundInstrument(instrument.id)
      : null;
    if (this.#bindingAuthority && !bound) {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "SKIPPED",
        instrumentId: instrument.id,
        reason: "INSTRUMENT_BINDING_UNAVAILABLE",
        message: `no binding configured for ${instrument.id}`,
      });
    }
    const boundConId = bound ? String(bound.conId) : null;

    // ---- PR15 reconciliation pre-check (fail-closed) ----------------
    // Fast skip BEFORE market-data / pipeline work. Execution-engine
    // remains the authoritative gate — this reader is an optimisation.
    if (this.#reconciliationReader) {
      let reconciliation:
        | Awaited<ReturnType<ReconciliationReader["checkInstrument"]>>
        | null = null;
      try {
        reconciliation = await this.#reconciliationReader.checkInstrument({
          instrument: instrument.brokerSymbol,
          // PR15.2 — reconciliation pre-check uses the bound
          // `conId` when available (never the registry
          // `Instrument.conId`, which is intentionally left
          // undefined on the front-month seed entries).
          conId:
            boundConId !== null
              ? boundConId
              : instrument.conId != null
                ? String(instrument.conId)
                : null,
          secType: mapAssetClassToSecType(instrument.assetClass),
          exchange: instrument.exchange,
          currency: instrument.currency,
        });
      } catch (err) {
        return this.#finalize(cycleId, instrument.id, startedAt, {
          kind: "SKIPPED",
          instrumentId: instrument.id,
          reason: "RECONCILIATION_UNAVAILABLE",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (reconciliation.kind !== "pass") {
        const reason =
          reconciliation.kind === "hold"
            ? "RECONCILIATION_HOLD"
            : reconciliation.kind === "stale"
              ? "RECONCILIATION_STALE"
              : "RECONCILIATION_UNAVAILABLE";
        return this.#finalize(cycleId, instrument.id, startedAt, {
          kind: "SKIPPED",
          instrumentId: instrument.id,
          reason,
          message:
            reconciliation.kind === "unavailable"
              ? reconciliation.reason
              : reconciliation.kind === "hold"
                ? reconciliation.reason
                : undefined,
        });
      }
    }

    // ---- Exposure guard (fail-closed) -------------------------------
    let exposure: TradingExposure;
    try {
      exposure = await this.#exposureReader.readExposure({
        instrumentId: instrument.id,
        brokerSymbol: instrument.brokerSymbol,
      });
    } catch (error) {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "SKIPPED",
        instrumentId: instrument.id,
        reason: "EXPOSURE_READ_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      exposure.hasOpenPosition ||
      exposure.hasActiveOrder ||
      exposure.hasAmbiguousSubmission ||
      exposure.hasPendingProposal
    ) {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "SKIPPED",
        instrumentId: instrument.id,
        reason: "EXPOSURE_BLOCKED",
        message: this.#formatExposureReason(exposure),
      });
    }

    // ---- Per-instrument policy (round-4 blocker) -------------------
    // Registry MUST supply an executionPolicy for every enabled
    // instrument — a single global default is no longer acceptable.
    // Fail-closed if missing or if the resolved shape violates the
    // instrument's own contract (e.g. tick size / allowed types).
    const policyResolution = resolveInstrumentPolicy(instrument);
    if (!policyResolution.ok) {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "NOT_SUBMITTED",
        instrumentId: instrument.id,
        idempotencyKey: "",
        runtime: {
          outcome: "NOT_SUBMITTED",
          pipeline: {
            outcome: "FAILURE",
            signal: null,
            ticket: null,
            blockers: [],
            warnings: [],
            failedStage: "UNKNOWN",
            durationMs: 0,
            metadata: { engineVersions: {}, ranAt: this.#clock() },
          } as unknown as DryRunResult["pipeline"],
          reason: "PIPELINE_FAILURE",
        },
        reason: "INSTRUMENT_POLICY_UNAVAILABLE",
        message: policyResolution.message,
      });
    }
    const { policy, executionPolicy } = policyResolution;

    // ---- Run pipeline ONCE to derive stable trigger identity --------
    let dryRunResult: DryRunResult;
    try {
      dryRunResult = await this.#marketDataRuntime.dryRun(
        instrument.id,
        policy,
      );
    } catch (error) {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "ERROR",
        instrumentId: instrument.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // NO_TRADE / FAILURE surface without a submission — no key needed.
    if (dryRunResult.pipeline.outcome === "NO_TRADE") {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "NOT_SUBMITTED",
        instrumentId: instrument.id,
        idempotencyKey: "",
        runtime: {
          outcome: "NOT_SUBMITTED",
          pipeline: dryRunResult.pipeline,
          reason: "NO_TRADE",
        },
        reason: "NO_TRADE",
      });
    }
    if (dryRunResult.pipeline.outcome !== "SUCCESS") {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "NOT_SUBMITTED",
        instrumentId: instrument.id,
        idempotencyKey: "",
        runtime: {
          outcome: "NOT_SUBMITTED",
          pipeline: dryRunResult.pipeline,
          reason: "PIPELINE_FAILURE",
        },
        reason: "PIPELINE_FAILURE",
      });
    }

    // ---- Trigger identity (round-4 blocker fix) --------------------
    // The v4 idempotency key separates strategy trigger identity
    // (strategyId + triggerId) from the trade intent hash. Trigger
    // identity is derived from `snapshot.sections.price.observedAt`
    // rounded to the strategy's timeframe boundary; a NEW closed
    // candle produces a new trigger even if the resulting ticket
    // is identical.
    const trigger = deriveTriggerIdentity(
      dryRunResult.snapshot,
      executionPolicy,
    );
    if (!trigger) {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "NOT_SUBMITTED",
        instrumentId: instrument.id,
        idempotencyKey: "",
        runtime: {
          outcome: "NOT_SUBMITTED",
          pipeline: dryRunResult.pipeline,
          reason: "PIPELINE_FAILURE",
        },
        reason: "TRIGGER_UNAVAILABLE",
        message:
          "snapshot.sections.price.observedAt is null — cannot derive triggerId",
      });
    }

    // Round-5 blocker fix: clientOrderId identifies the TRIGGER,
    // NOT the payload. Two evaluations of the same trigger that
    // emit different tickets get the SAME clientOrderId so
    // execution-engine's UNIQUE(client_order_id) surfaces a
    // legitimate CONFLICT on the mismatched hash. The payload
    // fingerprint lives exclusively in `clientOrderHash`, which
    // ExecutionRuntime computes itself from the ticket — the
    // loop does not forward a pre-computed hash (round-5 fix:
    // no trust of caller-supplied hash values downstream).
    const idempotencyKey = this.#keyBuilder.build({
      instrumentId: instrument.id,
      strategyId: trigger.strategyId,
      triggerId: trigger.triggerId,
    });

    // ---- Delegate to ExecutionRuntime with pre-computed dry-run -----
    let runtimeOutcome;
    try {
      runtimeOutcome = await this.#executionRuntime.executePrepared({
        dryRunResult,
        idempotencyKey,
        // PR15.2 — carry the bound broker identity through so
        // the ticket sent to execution-engine matches what
        // its server-side authority will verify.
        ...(bound ? { bound } : {}),
      });
    } catch (error) {
      return this.#finalize(cycleId, instrument.id, startedAt, {
        kind: "ERROR",
        instrumentId: instrument.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return this.#finalize(
      cycleId,
      instrument.id,
      startedAt,
      this.#classifyRuntimeOutcome(
        instrument.id,
        idempotencyKey,
        runtimeOutcome,
      ),
    );
  }

  #finalize(
    cycleId: string,
    instrumentId: string,
    startedAt: Date,
    outcome: TradingLoopInstrumentOutcome,
  ): TradingLoopInstrumentReport {
    const finishedAt = this.#clock();
    const report: TradingLoopInstrumentReport = {
      cycleId,
      instrumentId,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outcome,
    };
    this.#logInstrumentReport(report);
    return report;
  }

  #recordSkip(
    cycleId: string,
    instrumentId: string,
    reason: "RUN_IN_PROGRESS" | "CONCURRENCY_CAP" | "LOOP_DISABLED",
    reports: TradingLoopInstrumentReport[],
  ): void {
    const at = this.#clock();
    const report: TradingLoopInstrumentReport = {
      cycleId,
      instrumentId,
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      outcome: { kind: "SKIPPED", instrumentId, reason },
    };
    reports.push(report);
    this.#lastOutcomes.set(instrumentId, report);
    this.#logInstrumentReport(report);
  }

  #selectInstruments(): readonly Instrument[] {
    const enabled = this.#registry
      .listExecutionEnabled()
      .filter(
        (i) => i.trading.signalGenerationEnabled && i.trading.monitoringEnabled,
      );
    if (this.#config.instrumentIds.length === 0) {
      return enabled;
    }
    const allow = new Set(this.#config.instrumentIds);
    const filtered = enabled.filter((i) => allow.has(i.id));
    const known = new Set(filtered.map((i) => i.id));
    for (const id of allow) {
      if (!known.has(id)) {
        this.#logger.debug(
          { component: "trading-loop", instrumentId: id },
          "trading-loop: allow-list id not in registry-enabled scope, ignoring",
        );
      }
    }
    return filtered;
  }

  #classifyRuntimeOutcome(
    instrumentId: string,
    idempotencyKey: string,
    runtime: Awaited<ReturnType<ExecutionRuntime["executePrepared"]>>,
  ): TradingLoopInstrumentOutcome {
    switch (runtime.outcome) {
      case "SUBMITTED":
        return { kind: "SUBMITTED", instrumentId, idempotencyKey, runtime };
      case "DUPLICATE":
        return { kind: "DUPLICATE", instrumentId, idempotencyKey, runtime };
      case "PENDING":
        return { kind: "PENDING", instrumentId, idempotencyKey, runtime };
      case "CONFLICT":
        return { kind: "CONFLICT", instrumentId, idempotencyKey, runtime };
      case "UNKNOWN":
        return { kind: "UNKNOWN", instrumentId, idempotencyKey, runtime };
      case "NOT_SUBMITTED":
        return {
          kind: "NOT_SUBMITTED",
          instrumentId,
          idempotencyKey,
          runtime,
          reason: runtime.reason,
          ...(runtime.message !== undefined
            ? { message: runtime.message }
            : {}),
        };
    }
  }

  #formatExposureReason(exposure: TradingExposure): string {
    const flags: string[] = [];
    if (exposure.hasOpenPosition) {
      flags.push(
        `openPosition(${exposure.positionSide ?? "?"}, qty=${exposure.quantity ?? "?"})`,
      );
    }
    if (exposure.hasActiveOrder) flags.push("activeOrder");
    if (exposure.hasAmbiguousSubmission) flags.push("ambiguousSubmission");
    if (exposure.hasPendingProposal) flags.push("pendingProposal");
    return flags.join(", ");
  }

  #logInstrumentReport(report: TradingLoopInstrumentReport): void {
    const base = {
      component: "trading-loop",
      cycleId: report.cycleId,
      instrumentId: report.instrumentId,
      startedAt: report.startedAt.toISOString(),
      finishedAt: report.finishedAt.toISOString(),
      durationMs: report.durationMs,
      kind: report.outcome.kind,
    };
    switch (report.outcome.kind) {
      case "SUBMITTED":
      case "DUPLICATE":
      case "PENDING":
      case "CONFLICT":
      case "UNKNOWN":
        this.#logger.info(
          {
            ...base,
            idempotencyKey: report.outcome.idempotencyKey,
            runtimeOutcome: report.outcome.runtime.outcome,
          },
          `trading-loop: ${report.outcome.kind}`,
        );
        return;
      case "NOT_SUBMITTED":
        this.#logger.info(
          {
            ...base,
            idempotencyKey: report.outcome.idempotencyKey,
            reason: report.outcome.reason,
            message: report.outcome.message,
          },
          "trading-loop: NOT_SUBMITTED",
        );
        return;
      case "SKIPPED":
        this.#logger.info(
          {
            ...base,
            reason: report.outcome.reason,
            message: report.outcome.message,
          },
          "trading-loop: SKIPPED",
        );
        return;
      case "ERROR":
        this.#logger.error(
          { ...base, message: report.outcome.message },
          "trading-loop: ERROR",
        );
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-instrument execution policy resolution (round-4 blocker)
// ---------------------------------------------------------------------------

const TIMEFRAME_PATTERN = /^(\d+)(s|m|h|d)$/;

function timeframeToMs(timeframe: string): number | null {
  const m = TIMEFRAME_PATTERN.exec(timeframe);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  const factor =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : 86_400_000;
  return n * factor;
}

export type PolicyResolutionResult =
  | {
      readonly ok: true;
      readonly policy: ExecutionTicketPolicy;
      readonly executionPolicy: InstrumentExecutionPolicy;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

/**
 * Resolve the runtime `ExecutionTicketPolicy` for one instrument
 * from `Instrument.executionPolicy`. Fails closed when:
 *   - the instrument lacks an `executionPolicy`,
 *   - required fields are missing / invalid,
 *   - the resolved `orderType` is not in `allowedOrderTypes`,
 *   - the resolved `quantity` exceeds either the policy's own
 *     `maxQuantity` or the instrument's `risk.maxQuantity`.
 *
 * The loop refuses to fall back to a single global default —
 * `priceTickSize` in particular MUST come from validated broker
 * / registry metadata.
 */
export function resolveInstrumentPolicy(
  instrument: Instrument,
): PolicyResolutionResult {
  const ep = instrument.executionPolicy;
  if (!ep) {
    return {
      ok: false,
      message: `instrument ${instrument.id} has no executionPolicy — loop refuses to fall back to a global default`,
    };
  }
  if (!ep.strategyId) {
    return { ok: false, message: `strategyId missing for ${instrument.id}` };
  }
  if (!timeframeToMs(ep.timeframe)) {
    return {
      ok: false,
      message: `timeframe "${ep.timeframe}" is not one of <N>{s,m,h,d} for ${instrument.id}`,
    };
  }
  if (!ep.allowedOrderTypes.includes(ep.defaultOrderType)) {
    return {
      ok: false,
      message: `defaultOrderType "${ep.defaultOrderType}" is not in allowedOrderTypes for ${instrument.id}`,
    };
  }
  if (!(ep.priceTickSize > 0)) {
    return {
      ok: false,
      message: `priceTickSize must be > 0 for ${instrument.id}`,
    };
  }
  const quantity = Math.min(
    ep.quantity,
    ep.maxQuantity,
    instrument.risk.maxQuantity,
  );
  if (!(quantity > 0)) {
    return {
      ok: false,
      message: `resolved quantity <= 0 for ${instrument.id}`,
    };
  }
  const policy: ExecutionTicketPolicy = {
    quantity,
    orderType: ep.defaultOrderType,
    timeInForce: ep.timeInForce,
    outsideRth: ep.outsideRth,
    transmit: ep.transmit,
    priceTickSize: ep.priceTickSize,
    priceRoundingMode: ep.priceRoundingMode,
    ...(ep.stopLossDistance !== undefined
      ? { stopLossDistance: ep.stopLossDistance }
      : {}),
    ...(ep.takeProfitDistance !== undefined
      ? { takeProfitDistance: ep.takeProfitDistance }
      : {}),
  };
  return { ok: true, policy, executionPolicy: ep };
}

// ---------------------------------------------------------------------------
// Trigger identity derivation (round-4 blocker)
// ---------------------------------------------------------------------------

/**
 * Derive a stable per-trigger identity from the market snapshot
 * and the instrument's execution policy. The trigger id is
 * `evaluation.<timeframe>.<bucketStartMs>` where
 * `bucketStartMs` is `snapshot.sections.price.observedAt`
 * rounded DOWN to the strategy's timeframe boundary.
 *
 * Round-5 blocker fix: the label is `evaluation_bucket`, NOT
 * `candle_close`. `floor(observedAt / timeframe)` returns the
 * START of the current wall-clock bucket, not proof that the
 * underlying candle has closed — a real candle-close event
 * would come from ingestion. Once ingestion emits closed-candle
 * events the source will change to `candle_close`; until then
 * we don't claim more than we can prove.
 *
 * Returns `null` when the snapshot lacks a price observation
 * timestamp — the caller MUST refuse to submit under a
 * fabricated key.
 */
export function deriveTriggerIdentity(
  snapshot: DryRunResult["snapshot"],
  executionPolicy: InstrumentExecutionPolicy,
): TriggerIdentity | null {
  const observedAt = snapshot.sections.price.observedAt;
  if (!observedAt) return null;
  const timeframeMs = timeframeToMs(executionPolicy.timeframe);
  if (!timeframeMs) return null;
  const bucketStartMs =
    Math.floor(observedAt.getTime() / timeframeMs) * timeframeMs;
  return {
    strategyId: executionPolicy.strategyId,
    source: "evaluation_bucket",
    timeframe: executionPolicy.timeframe,
    triggerId: `evaluation.${executionPolicy.timeframe}.${bucketStartMs}`,
    observedAt,
  };
}
