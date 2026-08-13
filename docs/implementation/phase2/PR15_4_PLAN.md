# PR15.4 — Strategy Attribution & Direction Gate — PLAN (r15)

> **Status:** planned, awaiting approval
>
> **Gates on:** PR15.2 shipped (`1472a33`). PR15.3 remains `blocked, not ready`.
>
> **Scope:** Wire `StrategyPortfolioManager` into the trading loop so that a
> real `StrategySignal` is the necessary source of directional intent; propagate
> attribution through `SignalEvaluation.metadata.strategyId` and a typed
> `SignalBlocker`; enforce a fail-closed direction gate that fires before the
> Risk Engine; fix `proposed_orders.strategy`; sync strategy runtime states
> once per trading-loop cycle.
>
> **Business logic shared between Paper and Live. Operational verification:
> Paper only. Live remains disabled. No schema migration. No execution-engine
> write-path changes. No `es_front` activation. No Paper E2E.**

---

## 1. Problem Statement

### 1.1 Root cause (confirmed in code)

`SignalEngine.evaluate()` in `packages/shared/src/signal-engine/evaluator.ts`
calls `runSignalPipeline()`, which runs both Decision and Risk engines before
returning. It never sets `metadata.strategyId`. The trading-loop check fires on
every cycle because no upstream call sets the field.

### 1.2 PR15.4 scope for StrategySignal

PR15.4 authenticates strategy attribution and direction. It does NOT propagate
`StrategySignal` fields (entry, SL, TP, `suggestedEntry`) into
`ExecutionTicketBuilder`. Ticket parameters remain driven by
`InstrumentExecutionPolicy`. The strategy's directional decision is the
necessary pre-condition for any submission, not the source of ticket
construction.

---

## 2. Architecture

### 2.1 Canonical intent flow

```
TradingLoopService.#runCycle
  |
  |-- [NEW-0] repo.syncStrategyRuntimeStates(portfolioManager.strategyIds, cooldownMs)
  |     Called once per cycle before per-instrument work (shared by scheduler and runOnce)
  |     On error: full exception logged; each selected instrument gets a SKIPPED report;
  |               no #runInstrument() invoked; cycle returns normally
  |
  `-- for each instrument: #runInstrument(cycleId, instrument)

TradingLoopService.#runInstrument
  |
  |-- [existing] Binding gate             -> SKIPPED / INSTRUMENT_BINDING_UNAVAILABLE
  |-- [existing] Reconciliation gate      -> SKIPPED / RECONCILIATION_*
  |-- [existing] Exposure guard           -> SKIPPED / EXPOSURE_BLOCKED | EXPOSURE_READ_FAILED
  |-- [NEW-4] Exposure data contradiction
  |          hasOpenPosition === false but quantity non-zero
  |                                       -> SKIPPED / EXPOSURE_DATA_CONTRADICTION
  |-- [existing] Policy resolution        -> executionPolicy { strategyId, expectedDirection }
  |             executionPolicy.strategyId is REQUIRED; no undefined-strategyId path
  |             [NEW] expectedDirection must be "LONG" | "SHORT"
  |             missing/invalid           -> NOT_SUBMITTED / INSTRUMENT_POLICY_UNAVAILABLE
  |             (NOT_SUBMITTED: preserves existing gate behavior)
  |
  |-- [NEW-6] resolveActiveStrategyIds(symbol, ids, profileLookup, repo,
  |           { clock: this.#clock, onStateError: logger.error })
  |     -> kind:"ok" { activeIds, disabledReasons }
  |     -> kind:"error" { code:"STRATEGY_STATE_UNAVAILABLE", strategyId }
  |          onStateError(strategyId, error) invoked before returning kind:"error"
  |     DB error                          -> SKIPPED / STRATEGY_STATE_UNAVAILABLE
  |     No active IDs                     -> SKIPPED / NO_STRATEGY_SIGNAL
  |
  |-- [NEW-7] StrategyContextLoader.load(instrument, bound, positionQuantity, timeframes)
  |     Contract mismatch                 -> SKIPPED / STRATEGY_CONTRACT_MISMATCH
  |     Context unavailable               -> SKIPPED / STRATEGY_CONTEXT_UNAVAILABLE
  |
  |-- [NEW-8] portfolioManager.run(context, new Set(activeIds))
  |     -> kind:"ok" { selected, candidates, rejectionReasons }
  |     -> kind:"error" { errorCode, message }
  |       (onStrategyError callback invoked in catch; no raw error in result)
  |     kind:"error"                      -> SKIPPED / STRATEGY_EVALUATION_ERROR
  |     selected === null                 -> SKIPPED / NO_STRATEGY_SIGNAL
  |     LONG + SHORT candidates           -> SKIPPED / STRATEGY_CONFLICT
  |
  |-- [NEW-9] Full attribution chain verification (pre-dryRun)
  |     normalize(signal.symbol) === normalize(instrument.brokerSymbol)
  |     strategy.id === signal.strategyId
  |     strategy.id === executionPolicy.strategyId
  |     strategy.supportedDirections.includes(signal.direction)
  |     signal.direction === executionPolicy.expectedDirection
  |     signal.side === (direction === "LONG" ? "BUY" : "SELL")
  |     Any failure                       -> SKIPPED / STRATEGY_POLICY_MISMATCH
  |     -> attribution = { strategyId: winner.strategy.id,
  |                        intendedAction: winner.signal.direction }
  |
  |-- [NEW-10] MarketDataRuntime.dryRun(instrumentId, policy, attribution)
  |     -> TradingPipeline.run(snapshot, instrument, policy, attribution)
  |         -> SignalEngine.evaluate(snapshot, attribution)
  |             -> runSignalPipeline(inputs, attribution)
  |                 -> DecisionEngine.evaluate()
  |                 -> direction gate (pipeline.ts)
  |                   decision.action !== intendedAction
  |                     -> SignalBlocker { code:"STRATEGY_DIRECTION_UNCONFIRMED",
  |                                        source:"attribution" }
  |                     -> riskSkipped = true; Risk Engine NOT called
  |                 -> RiskEngine.evaluate()  <- only if direction confirmed
  |             <- PipelineOutcome { signalBlockers, ... }
  |             metadata.strategyId = attribution.strategyId (always, all statuses)
  |             signalBlockers.length > 0 -> BLOCKED
  |
  |-- TradingPipeline: signal.blockers with source:"attribution"
  |     -> failedStage: "ATTRIBUTION"
  |
  |-- [existing-11] PIPELINE_FAILURE("ATTRIBUTION") -> NOT_SUBMITTED
  |-- [existing] NO_TRADE / PIPELINE_FAILURE (other) -> NOT_SUBMITTED
  |-- [NEW post-pipeline defence-in-depth]
  |     pipeline.signal.metadata.strategyId === attribution.strategyId
  |     pipeline.signal.decision?.action === attribution.intendedAction
  |     Mismatch  -> SKIPPED / STRATEGY_POLICY_MISMATCH
  |     (dryRunResult exists but executePrepared not yet called; no ExecutionRuntimeOutcome)
  |-- [existing] Trigger identity / idempotency key (unchanged)
  |
  `-- [CHANGED] ExecutionRuntime.executePrepared({ ..., strategyId })
        strategyId invalid          -> STRATEGY_ATTRIBUTION_UNAVAILABLE
        pipeline non-SUCCESS        -> #submitFromDryRun (NO_TRADE or PIPELINE_FAILURE)
        metadata mismatch           -> STRATEGY_ATTRIBUTION_MISMATCH (independent check)
        SUCCESS + match             -> #submitFromDryRun (check(), mapper, hash, submitter)
        -> proposed_orders.strategy = strategyId
```

### 2.2 Submission paths

**Path A — trading loop** (this PR): strategy-first, full attribution gate.
`executePrepared` requires `strategyId` (non-optional, runtime-validated before
PaperGuard and submitter). No fallback label.

**Path B — `POST /runtime/execute`** -> `ExecutionRuntime.execute()`: paper-only,
bearer-protected manual write endpoint. Operator entry point, does NOT invoke
`StrategyPortfolioManager`. Uses generic rules only. `strategy` field =
`"execution-runtime"`. Explicitly documented as a separate, audited operator
path, not a dry-run endpoint.

### 2.3 Attribution preservation

| Outcome | `metadata.strategyId` | `proposed_orders.strategy` |
|---|---|---|
| PIPELINE_FAILURE ("ATTRIBUTION") | set | not written |
| PIPELINE_FAILURE (Decision blocked) | set | not written |
| PIPELINE_FAILURE (Risk rejected) | set | not written |
| NO_TRADE | set | not written |
| SUBMITTED | set | = strategyId |

---

## 3. Typed Attribution Carrier

### 3.1 New types in `packages/shared/src/signal-engine/types.ts`

```typescript
export type SignalBlockerCode = "STRATEGY_DIRECTION_UNCONFIRMED";

export interface SignalBlocker {
  readonly code: SignalBlockerCode;
  readonly message: string;
  readonly source: "attribution";
}
```

`SignalEvaluation` gains one new required field (default `[]` in all
construction sites):

```typescript
export interface SignalEvaluation {
  // ... all existing fields unchanged ...
  readonly blockers: readonly SignalBlocker[];
}
```

`SignalWarning.code` is and remains a plain `string` (existing contract).
`SignalBlocker.code` is a discriminated literal union — the two are distinct
types serving different classification purposes.

The `BLOCKED` status documentation in the types file is extended:
> `BLOCKED` — decision has at least one `blockedBy` entry, OR the pipeline
> emitted at least one `SignalBlocker` (e.g. attribution direction mismatch).

### 3.2 `PipelineOutcome` gains `signalBlockers`

In `packages/shared/src/signal-engine/pipeline.ts`:

```typescript
export interface PipelineOutcome {
  readonly decision: DecisionResult | null;
  readonly risk: RiskEvaluation | null;
  readonly warnings: readonly SignalWarning[];
  readonly riskSkipped: boolean;
  readonly errored: boolean;
  readonly signalBlockers: readonly SignalBlocker[];  // NEW
}
```

All existing return sites in `runSignalPipeline()` gain `signalBlockers: []`.
The direction-gate return site sets:

```typescript
signalBlockers: [{
  code: "STRATEGY_DIRECTION_UNCONFIRMED",
  message: `decision.action="${decision.action}" disagrees with intendedAction="${attribution.intendedAction}"`,
  source: "attribution",
}],
```

### 3.3 `PipelineInputs` gains optional attribution

```typescript
export interface PipelineInputs {
  readonly snapshot: MarketContextSnapshot;
  readonly decisionEngine: DecisionEngine;
  readonly riskEngine: RiskEngine;
  readonly instrumentResolver: InstrumentResolver;
  readonly attribution?: SignalAttributionContext;  // NEW
}
```

Inside `runSignalPipeline()`, the direction gate fires after the Decision block
and before instrument resolution:

```typescript
// Direction gate: fires only when decision is directional (not HOLD/BLOCKED)
if (inputs.attribution && decision && !decisionHasBlockers && !decisionIsHold) {
  if (decision.action !== inputs.attribution.intendedAction) {
    return {
      decision,
      risk: null,
      warnings,
      riskSkipped: true,
      errored: false,
      signalBlockers: [{
        code: "STRATEGY_DIRECTION_UNCONFIRMED",
        message: `decision.action="${decision.action}" disagrees with intendedAction="${inputs.attribution.intendedAction}"`,
        source: "attribution",
      }],
    };
  }
}
```

### 3.4 `deriveSignalStatus()` update in `result.ts`

New rule order (evaluated in this exact order):

1. `outcome.errored` -> `ERROR`
2. `outcome.signalBlockers.length > 0` -> `BLOCKED`
3. `decision.blockedBy.length > 0` -> `BLOCKED`
4. `decision.action === "HOLD"` -> `HOLD`
5. `outcome.risk && !outcome.risk.approved` -> `REJECTED`
6. otherwise -> `GENERATED`

`summarizeReason` for `BLOCKED`:

```typescript
case "BLOCKED":
  if (outcome.signalBlockers.length > 0) {
    return `BLOCKED -- ${outcome.signalBlockers.map(b => b.code).join(", ")}`;
  }
  return `BLOCKED -- ${listBlockerCodes(outcome.decision)}`;
```

### 3.5 `SignalEngine.evaluate()` updated signature

```typescript
evaluate(snapshot: MarketContextSnapshot, attribution?: SignalAttributionContext): SignalEvaluation
```

Passes `attribution` to `runSignalPipeline`. Always sets
`metadata.strategyId = attribution?.strategyId`. Propagates
`outcome.signalBlockers` to `evaluation.blockers`.

### 3.6 `deriveFailedStageFromSignal()` in `trading-pipeline/result.ts`

```typescript
export function deriveFailedStageFromSignal(
  signal: SignalEvaluation,
): TradingPipelineFailedStage {
  switch (signal.status) {
    case "BLOCKED":
      // Typed attribution blocker; no string searching
      if (signal.blockers.some(b => b.source === "attribution")) {
        return "ATTRIBUTION";
      }
      return "DECISION";
    case "REJECTED":
      return "RISK";
    case "ERROR": {
      const first = signal.warnings[0];
      if (!first) return "SIGNAL";
      switch (first.source) {
        case "decision-engine": return "DECISION";
        case "risk-engine":     return "RISK";
        default:                return "SIGNAL";
      }
    }
    case "HOLD":
    case "GENERATED":
      return "SIGNAL";
  }
}
```

`"ATTRIBUTION"` is added to `TradingPipelineFailedStage` in
`packages/shared/src/trading-pipeline/types.ts`.

`TradingPipelineFailure` documentation is extended:
> For `failedStage: "ATTRIBUTION"`, diagnostics live in
> `signal.blockers` (typed `SignalBlocker[]`).

### 3.7 `SignalEngineLike` contract in trading-pipeline

```typescript
export interface SignalEngineLike {
  evaluate(
    snapshot: MarketContextSnapshot,
    attribution?: SignalAttributionContext,
  ): SignalEvaluation;
}
```

### 3.8 Fixture updates — `blockers: []` required

`SignalEvaluation.blockers` becomes a required field. Every existing fixture or
helper that manually constructs a `SignalEvaluation` must add `blockers: []`.
Affected files:

- `packages/shared/src/signal-engine/evaluator.test.ts` — `build()` helper
- `packages/shared/src/trading-pipeline/pipeline.test.ts` — `buildSignal()` helper
- `packages/shared/src/execution-ticket/builder.test.ts` — `buildSignal()` helper
- Any runtime signal-engine test file that manually constructs `SignalEvaluation`
  or `TradingPipelineResult`

All these files are included in the file change list (§13).

### 3.9 Test: direction gate in `runSignalPipeline()`

**File:** `packages/shared/src/signal-engine/pipeline.test.ts` (NEW)
Tests `runSignalPipeline()` only — NOT the full `TradingPipeline`.

1. Decision LONG, intendedAction LONG -> `signalBlockers = []`; Risk called once
2. Decision LONG, intendedAction SHORT -> `signalBlockers[0].code = "STRATEGY_DIRECTION_UNCONFIRMED"`, `source = "attribution"`; `riskSkipped = true`; Risk NOT called
3. Decision HOLD, attribution provided -> `signalBlockers = []`; Risk skipped via existing HOLD path
4. Decision BLOCKED, attribution provided -> `signalBlockers = []`; Risk skipped via existing blocked path
5. No attribution provided -> `signalBlockers = []`; direction gate inactive

### 3.10 Test: full TradingPipeline attribution flow

**File:** `packages/shared/src/trading-pipeline/pipeline.test.ts` (EXISTING — extend)

Full test setup and verification described in §14.2.

---

## 4. SignalAttributionContext — Minimal Shared Contract

In `packages/shared/src/signal-engine/types.ts`:

```typescript
export interface SignalAttributionContext {
  readonly strategyId: string;
  readonly intendedAction: "LONG" | "SHORT";
}
```

No imports from app-specific strategy types. Exported from
`packages/shared/src/signal-engine/index.ts`.

---

## 4.5 Strategy Runtime State Sync

### 4.5.1 Why sync is required

`SignalEngine.runForSymbol()` calls `repo.syncStrategyRuntimeStates()` before
reading per-strategy state. The sync recalculates loss streaks, cooldowns, and
permanent-disable flags from the trades table. Without it, stale state can
cause strategies to run when they should be cooling down — or remain disabled
when they should have recovered.

The new `TradingLoopService` must perform this sync before resolving active
strategy IDs. It cannot delegate this responsibility to legacy
`SignalEngine.runForSymbol()` or to the UI endpoint.

### 4.5.2 Serialization in `SignalRepository`

`syncStrategyRuntimeStates()` performs a read–modify–write sequence on the
strategy runtime state table. Multiple callers share the same `SignalRepository`
instance — the scheduler, `runOnce()`, legacy `SignalEngine.runForSymbol()`,
and UI endpoints can all call `syncStrategyRuntimeStates()` concurrently.
Concurrent calls with the same fills can double-count losses, corrupt
cooldown timestamps, or trigger spurious permanent-disable.

Serialization is implemented inside `SignalRepository.syncStrategyRuntimeStates()`
itself — not in `TradingLoopService` — so that all callers are protected
regardless of call site:

```typescript
class SignalRepository {
  #syncMutex: Promise<void> = Promise.resolve();

  async syncStrategyRuntimeStates(
    strategyIds: string[],
    cooldownMs: number,
  ): Promise<void> {
    // Chain onto the existing tail; each call gets its own result/error
    const next = this.#syncMutex.then(
      () => this.#doSync(strategyIds, cooldownMs),
    );
    // The mutex tail advances on both success and error to avoid blocking
    this.#syncMutex = next.catch(() => {});
    return next;
  }

  async #doSync(strategyIds: string[], cooldownMs: number): Promise<void> {
    // ... existing implementation unchanged ...
  }
}
```

Properties of this design:
- Calls are serialized: `next` awaits the previous tail before starting
- No call is skipped or merged — different args are respected
- A failed call resolves the mutex (`catch(() => {})`) so later calls proceed
- Each caller receives its own `next` promise (success or rejection)
- No external library required

### 4.5.3 Placement: once per cycle in `#runCycle()`

```typescript
async #runCycle(): Promise<TradingLoopCycleReport> {
  const cycleId = randomUUID();
  const startedAt = this.#clock();
  // ...

  const instruments = this.#selectInstruments();
  const reports: TradingLoopInstrumentReport[] = [];

  // Sync before per-instrument work; shared by scheduler and runOnce()
  try {
    await this.#repo.syncStrategyRuntimeStates(
      this.#portfolioManager.strategyIds,
      this.#strategyCooldownMs,
    );
  } catch (err) {
    this.#logger.error(
      { component: "trading-loop", cycleId, err },
      "trading-loop: strategy runtime state sync failed",
    );
    // Emit one SKIPPED per selected instrument via the standard reporting path
    for (const instrument of instruments) {
      this.#recordSkip(
        cycleId,
        instrument.id,
        "STRATEGY_STATE_SYNC_UNAVAILABLE",
        reports,
        "strategy runtime state sync unavailable; check logs",
      );
    }
    this.#trimLastOutcomes();   // keep map bounded even on sync failure
    const finishedAt = this.#clock();
    return {
      cycleId,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      reports,
    };
  }

  // ... per-instrument work (unchanged); normal path calls #trimLastOutcomes()
  // after await Promise.all(promises)
}
```

`TradingLoopCycleReport` has no `kind` field — it is always a plain report
with a `reports` array.

### 4.5.4 New private helper `#trimLastOutcomes()`

The inline `while` loop that trims `#lastOutcomes` to `HISTORY_LIMIT` currently
appears only in the normal post-`Promise.all` path. The sync-error path returns
early before reaching it, so without the helper the map could grow unboundedly
on repeated sync failures.

Introduce a private helper and call it from both paths:

```typescript
#trimLastOutcomes(): void {
  while (this.#lastOutcomes.size > HISTORY_LIMIT) {
    const oldestKey = this.#lastOutcomes.keys().next().value;
    if (oldestKey === undefined) break;
    this.#lastOutcomes.delete(oldestKey);
  }
}
```

In the normal path, replace the inline loop with:

```typescript
// after await Promise.all(promises) and recording all reports:
this.#trimLastOutcomes();
```

`#recordSkip()` is responsible for pushing to `reports`, updating
`#lastOutcomes`, and calling `#logInstrumentReport`. It does NOT trim the map —
trimming is the caller's responsibility, done once per cycle at the end of both
the sync-error path and the normal path.

### 4.5.5 Extending `#recordSkip()` to accept any skip reason

The existing `#recordSkip()` only accepts the three pre-PR15.4 reasons.
In PR15.4 it is extended to accept any `TradingLoopSkipReason` and an optional
operator-safe `message`:

```typescript
#recordSkip(
  cycleId: string,
  instrumentId: string,
  reason: TradingLoopSkipReason,    // previously: 3-value literal union
  reports: TradingLoopInstrumentReport[],
  message?: string,                 // NEW — operator-safe; no raw exceptions
): void {
  const at = this.#clock();
  const report: TradingLoopInstrumentReport = {
    cycleId,
    instrumentId,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    outcome: { kind: "SKIPPED", instrumentId, reason, ...(message !== undefined ? { message } : {}) },
  };
  reports.push(report);
  this.#lastOutcomes.set(instrumentId, report);
  this.#logInstrumentReport(report);  // existing logger call
}
```

Trimming `#lastOutcomes` to `HISTORY_LIMIT` is done by `#trimLastOutcomes()`,
called once per cycle by the caller — not inside `#recordSkip()`.

### 4.5.6 New fields on `TradingLoopServiceOptions`

```typescript
readonly portfolioManager: StrategyPortfolioManager;    // NEW
readonly repo: StrategyRuntimeStateRepository;          // NEW
readonly strategyCooldownMs: number;                    // NEW — from SIGNAL_STRATEGY_COOLDOWN_MS
```

Two separate port interfaces are defined (§5.3 references the reader):

```typescript
/** Resolver only needs read access. */
export interface StrategyRuntimeStateReader {
  getStrategyRuntimeState(id: string): Promise<{
    enabled: boolean;
    permanentlyDisabled: boolean;
    cooldownUntil?: Date;
  }>;
}

/** TradingLoopService needs both read and sync. */
export interface StrategyRuntimeStateRepository
  extends StrategyRuntimeStateReader {
  syncStrategyRuntimeStates(
    strategyIds: string[],
    cooldownMs: number,
  ): Promise<void>;
}
```

The concrete `SignalRepository` class already implements both methods, so no
structural change to `repository.ts` is required beyond adding the mutex
serialization (§4.5.2).

### 4.5.7 Composition root wiring

```typescript
// Two separate managers built from the same strategies array
const portfolioManagerForLoop = new StrategyPortfolioManager(strategies, {
  onStrategyError: (strategyId, error) => {
    app.log.error(
      { strategyId, err: error },
      "trading-loop: strategy evaluation threw",
    );
  },
});

tradingLoopService = new TradingLoopService({
  // ... existing options ...
  portfolioManager: portfolioManagerForLoop,
  repo,                                         // existing repo instance
  strategyCooldownMs: config.SIGNAL_STRATEGY_COOLDOWN_MS,
});
```

`SignalEngine` keeps its own internal `StrategyPortfolioManager` (§8.7).
The two managers are built from the same `strategies` array but are separate
instances — `SignalEngine` does NOT share a manager with `TradingLoopService`.

---

## 5. Active-Strategy Resolver (Shared)

### 5.1 Location and purpose

**New file:** `apps/signal-engine/src/runtime/strategy/active-strategy-resolver.ts`

Extracts the activation logic inlined at `signal-engine.ts` ~lines 258-295 into
a deterministic, testable function. Both `SignalEngine.runForSymbol()` and the
new `TradingLoopService` use this function — no second implementation.

### 5.2 Discriminated return type

The resolver returns a discriminated union to distinguish success from runtime
errors and propagate them safely:

```typescript
export type ActiveStrategyResolution =
  | {
      readonly kind: "ok";
      readonly activeIds: readonly string[];
      readonly disabledReasons: readonly string[];
    }
  | {
      readonly kind: "error";
      readonly code: "STRATEGY_STATE_UNAVAILABLE";
      readonly strategyId: string;
      readonly message: string;  // operator-safe; never raw exception text
    };
```

When `getStrategyRuntimeState(strategyId)` throws, the resolver catches the
exception and returns `kind:"error"`. The exception is NOT propagated in the
result. The exception may be logged via callback (§5.4), but the return value
contains only the safe message.

### 5.3 Interface and signature

The resolver depends only on the read interface (§4.5.3):

```typescript
export interface ActiveStrategyResolverOptions {
  clock?: () => Date;
  /** Invoked with the full error before returning kind:"error"; used for logging. */
  onStateError?: (strategyId: string, error: unknown) => void;
}

export async function resolveActiveStrategyIds(
  brokerSymbol: string,
  allStrategyIds: readonly string[],
  profileLookup: (id: string) => StrategyProfile | undefined,
  repo: StrategyRuntimeStateReader,
  options?: ActiveStrategyResolverOptions,
): Promise<ActiveStrategyResolution>
```

`onStateError` is the sole path for logging full error details (stack, message).
The return value `kind:"error"` contains only the operator-safe `message`;
the raw exception is never stored in the discriminated result.

In `TradingLoopService`, the resolver is called as:

```typescript
const resolution = await resolveActiveStrategyIds(
  instrument.brokerSymbol,
  this.#portfolioManager.strategyIds,
  findStrategyProfile,
  this.#repo,   // StrategyRuntimeStateRepository satisfies StrategyRuntimeStateReader
  {
    clock: this.#clock,
    onStateError: (strategyId, err) => {
      this.#logger.error(
        { component: "trading-loop", strategyId, err },
        "resolver: strategy runtime state unavailable",
      );
    },
  },
);
```

In `SignalEngine.runForSymbol()`, the resolver is called with the
`onStrategyStateError` callback from `SignalEngineOptions`:

```typescript
const resolution = await resolveActiveStrategyIds(
  symbol,
  this.portfolioManager.strategyIds,
  findStrategyProfile,
  this.repo,
  {
    clock: () => new Date(),
    onStateError: this.options.onStrategyStateError,
  },
);
if (resolution.kind === "error") {
  return this.rejectedOrder(
    symbol,
    latest.conid,
    `strategy runtime state unavailable (${resolution.strategyId}); check logs`,
    indicators,
    "HOLD",
    generatedFromCandleTs,
  );
}
```

The rejected result does NOT contain `resolution.message` as-is nor any raw
error text. The callback receives the original error object.

### 5.4 Activation order (exact, per strategy)

Clock is evaluated exactly once before the loop:

```typescript
const evaluatedAt = (clock ?? (() => new Date()))().getTime();
```

For each `strategyId` in `allStrategyIds`:

1. Profile `excludedSymbols` check (UPPER(brokerSymbol) in UPPER(excluded)) -> disabled
2. Profile `includedSymbols` check (if defined and non-empty, UPPER(brokerSymbol) must match) -> disabled
3. `runtimeState = await repo.getStrategyRuntimeState(strategyId)`
   — **if this throws, return immediately as `kind:"error"` with the strategyId and operator-safe message**
4. `runtimeState.enabled === false` -> disabled
5. `runtimeState.permanentlyDisabled === true` -> disabled
6. `runtimeState.cooldownUntil && runtimeState.cooldownUntil.getTime() > evaluatedAt` -> disabled
7. Otherwise -> active

### 5.5 Fail-closed error propagation

If `getStrategyRuntimeState()` throws for strategy `S`, the `onStateError`
callback is best-effort — if it also throws, the resolver still returns
`kind:"error"`:

```typescript
try {
  options?.onStateError?.(strategyId, caughtError);
} catch {
  // callback errors are silenced; domain result is unchanged
}
return {
  kind: "error",
  code: "STRATEGY_STATE_UNAVAILABLE",
  strategyId: S,
  message: "strategy runtime state unavailable; check logs",
};
```

The raw exception is never in the result. `TradingLoopService` maps `kind:"error"`
to `SKIPPED / STRATEGY_STATE_UNAVAILABLE`:

```typescript
if (resolution.kind === "error") {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED",
    instrumentId: instrument.id,
    reason: "STRATEGY_STATE_UNAVAILABLE",
    message: resolution.message,
  });
}
```

### 5.6 `STRATEGY_STATE_UNAVAILABLE` added to `TradingLoopSkipReason`

Added to `TradingLoopSkipReason` in `apps/signal-engine/src/runtime/trading-loop/types.ts`.

### 5.7 Resolution in TradingLoopService (per cycle, per instrument)

Called every instrument cycle — not cached at startup. Runtime state can change
without a restart.

```typescript
// resolution already shown in §5.3
if (resolution.kind === "error") {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED",
    instrumentId: instrument.id,
    reason: "STRATEGY_STATE_UNAVAILABLE",
    message: resolution.message,
  });
}
if (resolution.activeIds.length === 0) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED",
    instrumentId: instrument.id,
    reason: "NO_STRATEGY_SIGNAL",
    message: resolution.disabledReasons.join("; "),
  });
}
const activeInstances = resolution.activeIds
  .map(id => this.#portfolioManager.getStrategy(id))
  .filter((s): s is Strategy => s !== undefined);
```

### 5.8 requiredTimeframes union

```typescript
const strategyTimeframes = new Set<CandleTimeframe>();
for (const strategy of activeInstances) {
  for (const tf of strategy.requiredTimeframes) {  // readonly CandleTimeframe[]
    strategyTimeframes.add(tf);
  }
}
```

`Strategy.requiredTimeframes` type stays `readonly CandleTimeframe[]`
(no change to existing interface).

### 5.9 Composition root wiring (`apps/signal-engine/src/index.ts`)

`strategies` is the variable already created at line ~50 of `index.ts`.

`SignalEngine` keeps its own internal `StrategyPortfolioManager` (§8.7).
`TradingLoopService` receives a separate manager built from the same `strategies`
array but constructed independently. See §4.5.7 for the full snippet.

---

## 6. Timeframe Dependencies

### 6.1 Two explicit sets

```typescript
// Fixed — required by buildTimeframeSnapshot() in signal-engine.ts
// and by hasRequiredIndicators() which uses 1m candles as the primary set
const INDICATOR_REQUIRED_TIMEFRAMES = [
  "1m", "5m", "1h", "4h", "12h", "1d", "1w",
] as const;
```

`strategyRequiredTimeframes` is computed per cycle from active strategy
instances (§5.7). The loader receives both and fetches their union.

Currently enabled strategies declare:
- `momentum_breakout_long_v1`: `["1m", "1h", "4h", "1d"]`
- `momentum_breakdown_short_v1`: `["1m", "1h", "4h", "1d"]`
- `gap_fade_short_v1`: `["1m"]`
- `smallcap_donchian_breakout_long_v1`: `["1m", "4h", "1d"]`
- `smallcap_donchian_breakdown_short_v1`: `["1m", "4h", "1d"]`

**Total fetch set (union of both):** all 7 timeframes, because
`INDICATOR_REQUIRED_TIMEFRAMES` already includes `"1m"`, `"5m"`, `"12h"`, and
`"1w"`. Adding or removing active strategies cannot reduce the fetch set below
7 timeframes.

The plan does NOT claim that only strategy-required timeframes are fetched.
Both sets are always loaded.

### 6.2 Fetch limits per timeframe

Taken verbatim from `signal-engine.ts`:

| Timeframe | Fetch limit | Source |
|---|---|---|
| 1m | `max(SIGNAL_MIN_CANDLES + 80, 1000)` = 1000 | Needs ema200 + overnight session |
| 5m | 160 | Legacy value |
| 1h | 160 | Legacy value |
| 4h | 120 | Legacy value |
| 12h | 90 | Legacy value |
| 1d | 260 | Legacy value |
| 1w | 104 | Legacy value |

### 6.3 Minimum candle counts per timeframe

`buildTimeframeSnapshot()` requires >= 20 candles to produce any snapshot at
all; fewer returns `undefined`. A minimum of 20 does NOT guarantee
`EMA50`/`EMA200` — those require 50 and 200 candles respectively from that
timeframe's data. If regime computation or an active strategy uses EMA200 on
a particular timeframe, the effective minimum for that timeframe is 200, not 20.

| Timeframe | Hard min (snapshot) | Notes |
|---|---|---|
| 1m | 220 (SIGNAL_MIN_CANDLES) | Needed by 1m EMA200 and `hasRequiredIndicators()` |
| 5m | 20 | TimeframeSnapshot only; EMA200 needs 200 if used by strategy |
| 1h | 20 | trendFilterValue uses EMA50(1h); effective min for that indicator is 50 |
| 4h | 20 | Same caveat |
| 12h | 20 | Indicators require >= 20 bars for snapshot |
| 1d | 20 | Same caveat |
| 1w | 20 | Same caveat |

Effective minimum for a given timeframe = max(snapshot minimum, indicator periods
required by `hasRequiredIndicators()` for that timeframe, minimum required by
any active strategy using that timeframe).

### 6.4 Freshness rules per timeframe

```typescript
const MAX_CANDLE_AGE_MS: Record<CandleTimeframe, number> = {
  "1m":  180_000,      // 3 min: 2 closed bars + propagation delay
  "5m":  600_000,      // 10 min: 1 closed bar + propagation
  "1h":  5_400_000,    // 90 min: 1 closed bar + 30 min grace
  "4h":  21_600_000,   // 6 h: 1 closed bar (4h) + 2 h grace
  "12h": 54_000_000,   // 15 h: 1 closed bar (12h) + 3 h grace
  "1d":  259_200_000,  // 72 h / 3 days: covers weekends
  "1w":  864_000_000,  // 10 days: covers weekends + holidays
};
```

A valid closed bar for any timeframe does not become stale within minutes.
Values are hardcoded constants, not derived from `intervalMs`.

---

## 7. StrategyContextLoader

### 7.1 Location

```
apps/signal-engine/src/runtime/strategy/strategy-context-loader.ts
```

### 7.2 TradingExposure -> positionQuantity mapping

`EXPOSURE_DATA_CONTRADICTION` is checked in `TradingLoopService` directly after
the exposure read, before policy resolution and strategy activation. The loader
never sees the contradiction case — it receives only verified data.

After `TradingLoopService` verifies `hasOpenPosition === false` AND the
contradiction check passes, it derives:

```typescript
const positionQuantity = tradingExposure.quantity ?? 0;
// positionQuantity === 0 is guaranteed here
```

`StrategyContextLoader.load()` receives `positionQuantity: 0` and builds:

```typescript
const currentPosition = { quantity: 0 };
```

`exposureSnapshot` is deferred — no field exists on `TradingExposure`. The
`StrategyContext.exposureSnapshot` field remains optional and is omitted here.

### 7.3 secType derivation and validation

`SecType` is defined as a string alias, not a literal union:

```typescript
type SecType = string;
```

Validation and narrowing:

```typescript
const expectedSecType = mapAssetClassToIbkrSecType(instrument.assetClass);
const contractSecType = contract.secType.trim().toUpperCase();

if (contractSecType !== expectedSecType) {
  return { error: "STRATEGY_CONTRACT_MISMATCH" };
}

// Comparison succeeded; now use the validated secType
const secType: SecType = expectedSecType;
```

After validation, `secType` is assigned the known-valid expected value. No cast
or assertion needed.

### 7.4 Exact conId repository lookup

Two new methods added to `apps/signal-engine/src/repository.ts`:

**`getInstrumentContractByConId(conId: string): Promise<InstrumentContract | null>`**

```sql
SELECT symbol, conid, sec_type, exchange, primary_exchange, currency,
       local_symbol, trading_class, min_tick, display_name,
       contract_json, details_json, source, resolved_at
FROM instrument_contracts
WHERE conid = $1
LIMIT 1
```

Parameters: `[conId]`. No symbol fallback. No `OR` clause.

**`getRecentCandlesForContract(symbol: string, conId: string, timeframe: CandleTimeframe, limit: number): Promise<Candle[]>`**

```typescript
const table = this.tableForTimeframe(timeframe);  // existing private helper
```

Tables have no `timeframe` column — the table name encodes the timeframe.

```sql
SELECT conid, symbol, ts, open, high, low, close, volume
FROM ${table}
WHERE UPPER(symbol) = UPPER($1)
  AND conid = $2
ORDER BY ts DESC
LIMIT $3
```

Parameters: `[symbol, conId, limit]`. Result rows are reversed to ascending
`ts` order (matching `getRecentCandles` behavior).

### 7.5 Contract binding verification

All string comparisons: `String(field).trim().toUpperCase()`.

Steps (in order):
1. Load 1m candles: `repo.getRecentCandlesForContract(instrument.brokerSymbol, String(bound.conId), "1m", 1000)`
   — If empty -> `STRATEGY_CONTEXT_UNAVAILABLE`
2. Load contract by exact conId: `repo.getInstrumentContractByConId(String(bound.conId))`
   — If null -> `STRATEGY_CONTRACT_MISMATCH`
3. Verify all required contract fields (all comparisons after trim+uppercase):
   - `contract.conid === String(bound.conId)` — required; mismatch -> `STRATEGY_CONTRACT_MISMATCH`
   - `contract.symbol === bound.brokerSymbol` — required; missing or mismatch -> `STRATEGY_CONTRACT_MISMATCH`
   - `contract.localSymbol === bound.localSymbol` — required; missing or mismatch -> `STRATEGY_CONTRACT_MISMATCH`
   - `contract.tradingClass === bound.tradingClass` — required; missing or mismatch -> `STRATEGY_CONTRACT_MISMATCH`
   - Exchange: must match `bound.exchange`; if no match, compare with `contract.primaryExchange`; if neither matches -> `STRATEGY_CONTRACT_MISMATCH`
   - `contract.currency === bound.currency` — required; missing or mismatch -> `STRATEGY_CONTRACT_MISMATCH`
   - `contract.secType` — validated via `mapAssetClassToIbkrSecType` (§7.3); mismatch -> `STRATEGY_CONTRACT_MISMATCH`
   - A null or missing required field in the DB row is a `STRATEGY_CONTRACT_MISMATCH`, not a skip
4. Load remaining timeframes using exact conId via `getRecentCandlesForContract`
5. Apply freshness and minimum candle checks per §6.3 and §6.4
6. Load market state by conId; validate presence, timestamp <= now, age <= `maxMarketStateAgeMs`

---

## 8. StrategyPortfolioManager Changes

**Current state (confirmed in code):** `StrategyPortfolioManager.run()` returns
a plain `{ selected, rejectionReasons }` (no `kind`, no error branch). A
strategy that throws propagates unhandled to the caller.

### 8.1 Discriminated return type

```typescript
export type StrategyPortfolioRunResult =
  | {
      readonly kind: "ok";
      readonly selected: StrategyPortfolioSelection | null;
      readonly candidates: readonly StrategyPortfolioSelection[];
      readonly rejectionReasons: readonly string[];
    }
  | {
      readonly kind: "error";
      readonly strategyId: string;
      readonly errorCode: "STRATEGY_EVALUATION_EXCEPTION";
      readonly message: string;  // operator-safe; never raw exception text
    };
```

### 8.2 Constructor with optional options

```typescript
export interface StrategyPortfolioManagerOptions {
  onStrategyError?: (strategyId: string, error: unknown) => void;
}

export class StrategyPortfolioManager {
  constructor(
    private readonly strategies: readonly Strategy[],
    private readonly options: StrategyPortfolioManagerOptions = {},
  ) {
    if (strategies.length === 0) {
      throw new Error("StrategyPortfolioManager requires at least one strategy");
    }
  }
  // ...
}
```

Second argument is optional — backward-compatible with existing
`new StrategyPortfolioManager(strategies)` calls.

### 8.3 Exception handling via callback

In the `generateSignal` catch block, the `onStrategyError` callback is
best-effort — if it also throws, the manager still returns `kind:"error"`:

```typescript
} catch (err) {
  try {
    this.options.onStrategyError?.(strategy.id, err);
  } catch {
    // callback errors are silenced; domain result is unchanged
  }
  return {
    kind: "error",
    strategyId: strategy.id,
    errorCode: "STRATEGY_EVALUATION_EXCEPTION",
    message: "strategy evaluation failed; check logs",
  };
}
```

The raw error is NOT stored in the result.

### 8.4 TradingLoopService — narrowing `run()` result

```typescript
const result = this.#portfolioManager.run(context, new Set(activeIds));
if (result.kind === "error") {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED",
    instrumentId: instrument.id,
    reason: "STRATEGY_EVALUATION_ERROR",
    message: result.message,
  });
}

// Detect LONG/SHORT conflict before checking selected
const candidateDirections = new Set(
  result.candidates.map(candidate => candidate.signal.direction),
);
if (candidateDirections.has("LONG") && candidateDirections.has("SHORT")) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED",
    instrumentId: instrument.id,
    reason: "STRATEGY_CONFLICT",
    message: "conflicting LONG and SHORT strategy candidates",
  });
}

const winner = result.selected;
if (!winner) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED",
    instrumentId: instrument.id,
    reason: "NO_STRATEGY_SIGNAL",
    message: result.rejectionReasons.join("; "),
  });
}
```

### 8.5 `run()` call signature (unchanged)

`run()` already accepts `activeStrategyIds = new Set(this.strategyIds)` as
second argument (existing signature).

### 8.6 Legacy `SignalEngine.runForSymbol()` narrowing

`runForSymbol()` calls `this.portfolioManager.run(...)`. After the discriminated
union change, it must narrow before accessing `selected` or `rejectionReasons`:

```typescript
const portfolioResult = this.portfolioManager.run(context, activeStrategyIdSet);

if (portfolioResult.kind === "error") {
  return this.rejectedOrder(
    symbol,
    latest.conid,
    `${portfolioResult.errorCode}: ${portfolioResult.message}`,
    indicators,
    "HOLD",
    generatedFromCandleTs,
  );
}

const signal = portfolioResult.selected?.signal ?? null;
if (!signal) {
  return this.rejectedOrder(
    symbol,
    latest.conid,
    portfolioResult.rejectionReasons.length > 0
      ? portfolioResult.rejectionReasons.join("; ")
      : `No strategy signal for ...`,
    indicators,
    "HOLD",
    generatedFromCandleTs,
  );
}
```

The `rejectedOrder` path does NOT create a `proposed_orders` row intended
for execution. Raw exception text is never in the return value.

### 8.7 New optional fields in `SignalEngineOptions`

Two separate callbacks are added, serving distinct failure paths:

```typescript
interface SignalEngineOptions {
  // ... existing fields unchanged ...

  /** Called when a strategy's generateSignal() throws. Raw error forwarded. */
  onStrategyError?: (strategyId: string, error: unknown) => void;

  /** Called when getStrategyRuntimeState() throws inside resolveActiveStrategyIds(). */
  onStrategyStateError?: (strategyId: string, error: unknown) => void;
}
```

`SignalEngine` constructor passes them to the appropriate places:

```typescript
// Internal manager receives onStrategyError
this.portfolioManager = new StrategyPortfolioManager(options.strategies, {
  onStrategyError: options.onStrategyError,
});
// onStrategyStateError is forwarded to resolveActiveStrategyIds() in runForSymbol()
```

All existing `new SignalEngine(repo, { strategies, ... })` call sites are
backward-compatible (both fields are optional). The composition root in `index.ts`
supplies `app.log.error` for both callbacks (§4.5.7).

---

## 9. `expectedDirection` Validation in Policy Resolution

### 9.1 Problem

`InstrumentExecutionPolicy.expectedDirection` is currently optional in the
shared type (for compatibility with manual/legacy policies). PR15.4 requires it
for the strategy-attributed trading-loop path. Without it, the attribution chain
cannot verify that the winning signal's direction matches the instrument's
configured intent.

### 9.2 Fail-closed check in `resolveInstrumentPolicy()`

After the existing policy resolution succeeds (policy found, strategyId
present), add:

```typescript
if (
  ep.expectedDirection !== "LONG" &&
  ep.expectedDirection !== "SHORT"
) {
  return {
    ok: false,
    message: `expectedDirection missing or invalid for ${instrument.id}`,
  };
}
```

This returns `{ ok: false }` which the trading loop already maps to
`INSTRUMENT_POLICY_UNAVAILABLE`. No change to the `NotSubmittedReason` enum
needed.

The check fires before strategy resolution and before any candle fetch.
Zero state reads, zero candle fetch, zero portfolio evaluation, zero pipeline,
zero submitter.

The shared `InstrumentExecutionPolicy` type is NOT changed to `required` —
older manual policies that omit `expectedDirection` continue to work on their
own paths. The fail-closed applies only to the trading-loop's
`resolveInstrumentPolicy()` resolver.

---

## 10. Full Attribution Chain in TradingLoopService

### 10.1 Complete pre-dryRun validation (step 9)

All six checks fire in order. Each failure returns `SKIPPED / STRATEGY_POLICY_MISMATCH`
with zero dryRun invocation:

```typescript
const normalize = (s: string) => s.trim().toUpperCase();
const winner = result.selected;

if (normalize(winner.signal.symbol) !== normalize(instrument.brokerSymbol)) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED", instrumentId: instrument.id,
    reason: "STRATEGY_POLICY_MISMATCH", message: "symbol_mismatch",
  });
}
if (winner.strategy.id !== winner.signal.strategyId) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED", instrumentId: instrument.id,
    reason: "STRATEGY_POLICY_MISMATCH", message: "strategy_signal_id_mismatch",
  });
}
if (winner.strategy.id !== executionPolicy.strategyId) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED", instrumentId: instrument.id,
    reason: "STRATEGY_POLICY_MISMATCH", message: "strategy_policy_id_mismatch",
  });
}
if (!winner.strategy.supportedDirections.includes(winner.signal.direction)) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED", instrumentId: instrument.id,
    reason: "STRATEGY_POLICY_MISMATCH", message: "direction_unsupported",
  });
}
if (winner.signal.direction !== executionPolicy.expectedDirection) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED", instrumentId: instrument.id,
    reason: "STRATEGY_POLICY_MISMATCH", message: "direction_mismatch",
  });
}
const expectedSide = winner.signal.direction === "LONG" ? "BUY" : "SELL";
if (winner.signal.side !== expectedSide) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED", instrumentId: instrument.id,
    reason: "STRATEGY_POLICY_MISMATCH", message: "side_direction_inconsistent",
  });
}

const attribution: SignalAttributionContext = {
  strategyId: winner.strategy.id,
  intendedAction: winner.signal.direction,
};
```

Proceed to dryRun only after all six checks pass.

### 10.2 Post-pipeline defence-in-depth (after dryRun)

After `dryRun()` returns a `DryRunResult`, but before `executePrepared()` is
called, verify attribution consistency:

```typescript
const pipelineSignal = dryRunResult.pipeline.signal;
if (
  pipelineSignal?.metadata.strategyId !== attribution.strategyId ||
  pipelineSignal?.decision?.action !== attribution.intendedAction
) {
  return this.#finalize(cycleId, instrument.id, startedAt, {
    kind: "SKIPPED",
    instrumentId: instrument.id,
    reason: "STRATEGY_POLICY_MISMATCH",
    message: "pipeline_attribution_mismatch",
  });
}
```

`SKIPPED` is correct here because `executePrepared()` has not yet been called —
there is no `ExecutionRuntimeOutcome` and no `idempotencyKey`.

`ExecutionRuntime.executePrepared()` still independently validates
`metadata.strategyId` and returns `STRATEGY_ATTRIBUTION_MISMATCH` to any caller
(trading-loop or direct). The two checks are independent: the loop-level check
is a pre-submission guard; the runtime-level check is a final defence-in-depth
for the `executePrepared()` entry point itself.

---

## 11. ExecutionRuntime Changes

### 11.1 Two new reason codes

Added to `NotSubmittedReason` in `execution-runtime.ts`:

```typescript
| "STRATEGY_ATTRIBUTION_UNAVAILABLE"
  // executePrepared() called with absent, empty, or whitespace-padded strategyId

| "STRATEGY_ATTRIBUTION_MISMATCH"
  // strategyId does not match dryRunResult.pipeline.signal.metadata.strategyId
```

### 11.2 New ExecutePreparedInput type

```typescript
export interface ExecutePreparedInput {
  readonly dryRunResult: DryRunResult;
  readonly idempotencyKey: string;
  readonly bound?: BoundInstrument;
  readonly strategyId: string;  // Required; validated at runtime
}
```

### 11.3 `executePrepared()` with four-stage validation

```typescript
async executePrepared(
  input: ExecutePreparedInput,
): Promise<ExecutionRuntimeOutcome> {
  // 1. Non-empty check
  if (
    typeof input.strategyId !== "string" ||
    input.strategyId.length === 0 ||
    input.strategyId !== input.strategyId.trim()
  ) {
    return {
      outcome: "NOT_SUBMITTED",
      pipeline: input.dryRunResult.pipeline,
      reason: "STRATEGY_ATTRIBUTION_UNAVAILABLE",
      message: "executePrepared: canonical strategyId is required",
    };
  }

  const pipeline = input.dryRunResult.pipeline;

  // 2. Pipeline must be SUCCESS before attribution is meaningful
  if (pipeline.outcome !== "SUCCESS") {
    return this.#submitFromDryRun(
      input.dryRunResult,
      input.idempotencyKey,
      input.bound,
      input.strategyId,
    );
  }

  // 3. strategyId must match what the pipeline attributed
  if (pipeline.signal.metadata.strategyId !== input.strategyId) {
    return {
      outcome: "NOT_SUBMITTED",
      pipeline,
      reason: "STRATEGY_ATTRIBUTION_MISMATCH",
      message: "executePrepared: strategy attribution mismatch",
    };
  }

  // 4. All checks passed; submit
  return this.#submitFromDryRun(
    input.dryRunResult,
    input.idempotencyKey,
    input.bound,
    input.strategyId,
  );
}
```

### 11.4 Minimal change to `#submitFromDryRun()`

The **only change** to the existing `#submitFromDryRun` method is adding a
`strategyLabel: string` parameter and using it in place of `this.#strategy`
inside the submitter call:

```typescript
async #submitFromDryRun(
  dryRunResult: DryRunResult,
  idempotencyKey: string,
  bound: BoundInstrument | undefined,
  strategyLabel: string,
): Promise<ExecutionRuntimeOutcome> {
  // All existing code retained verbatim:
  //   NO_TRADE -> NOT_SUBMITTED / NO_TRADE
  //   non-SUCCESS -> NOT_SUBMITTED / PIPELINE_FAILURE
  //   this.#paperGuard.check()
  //   toLegacySignalTicket(ticket, { bound })
  //   computeClientOrderHash(legacyTicket)
  //   UNSUPPORTED_TICKET_SHAPE catch block

  const submission = await this.#submitter.submit({
    ticket: legacyTicket,
    strategy: strategyLabel,  // was: this.#strategy
    clientOrderId: idempotencyKey,
    clientOrderHash,
  });

  // Full switch retained verbatim:
  //   submitted / resumed -> SUBMITTED
  //   duplicate_submitted / duplicate_terminal -> DUPLICATE
  //   duplicate_pending_ambiguous / pending_claimed -> PENDING
  //   conflict -> CONFLICT
  //   active_intent_exists / open_position_exists / position_state_unavailable -> NOT_SUBMITTED
  //   not_submitted -> NOT_SUBMITTED / PIPELINE_FAILURE
  //   unknown -> UNKNOWN
}
```

No change to `PaperGuard` API (`check()` remains). No change to
`ExecutionTicketSubmitter` API. Ticket mapping, hash computation, and all
submission outcomes are preserved exactly.

Callers:

```typescript
// execute() — unchanged operator path
this.#submitFromDryRun(dryRunResult, idempotencyKey, bound, this.#strategy)

// executePrepared() — trading-loop path
this.#submitFromDryRun(dryRunResult, idempotencyKey, input.bound, validatedStrategyId)
```

---

## 12. Early-Return Order in TradingLoopService

**`kind` key — which discriminant each gate returns:**

```
#runCycle (before per-instrument work)
0.  syncStrategyRuntimeStates()          [NEW]
    Throws -> all instruments get SKIPPED / STRATEGY_STATE_SYNC_UNAVAILABLE
    No #runInstrument() called; cycle returns normal TradingLoopCycleReport

#runInstrument
1.  INSTRUMENT_BINDING_UNAVAILABLE       SKIPPED   (existing)
2.  RECONCILIATION_*                     SKIPPED   (existing)
3.  EXPOSURE_BLOCKED / READ_FAILED       SKIPPED   (existing)
4.  EXPOSURE_DATA_CONTRADICTION          SKIPPED   [NEW PR15.4]
5.  INSTRUMENT_POLICY_UNAVAILABLE        NOT_SUBMITTED  (existing — preserved unchanged)
    [NEW PR15.4] includes fail-closed on missing expectedDirection
6.  STRATEGY_STATE_UNAVAILABLE           SKIPPED   [NEW PR15.4 — single-strategy DB error]
    NO_STRATEGY_SIGNAL (no active IDs)   SKIPPED   [NEW PR15.4]
7.  STRATEGY_CONTRACT_MISMATCH           SKIPPED   [NEW PR15.4]
    STRATEGY_CONTEXT_UNAVAILABLE         SKIPPED   [NEW PR15.4]
8.  STRATEGY_EVALUATION_ERROR            SKIPPED   [NEW PR15.4]
    NO_STRATEGY_SIGNAL (selected=null)   SKIPPED   [NEW PR15.4]
    STRATEGY_CONFLICT                    SKIPPED   [NEW PR15.4]
9.  STRATEGY_POLICY_MISMATCH             SKIPPED   [NEW PR15.4 — pre-dryRun]
    (symbol, IDs, supported dirs, direction, side)
    -> attribution = { strategyId, intendedAction }
10. dryRun with attribution                        [NEW threading]
11. PIPELINE_FAILURE("ATTRIBUTION")      NOT_SUBMITTED  [NEW PR15.4]
12. NO_TRADE                             NOT_SUBMITTED  (existing)
13. PIPELINE_FAILURE (other)             NOT_SUBMITTED  (existing)
14. STRATEGY_POLICY_MISMATCH             SKIPPED   [NEW PR15.4 — post-pipeline defence-in-depth]
    (dryRunResult exists; executePrepared not yet called; no ExecutionRuntimeOutcome)
15. Trigger identity / idempotency key             (unchanged)
16. ExecutionRuntime.executePrepared()             [CHANGED: strategyId required]
```

**Why all newly introduced PR15.4 loop-owned guards outside `ExecutionRuntime` use `SKIPPED`:** `NOT_SUBMITTED`
requires both `idempotencyKey` and `runtime: ExecutionRuntimeOutcome`, which
do not exist before `executePrepared()` is called. `SKIPPED` is the correct
discriminant for all loop-layer early returns that occur before execution.

**Note — direction gate inside shared pipeline:** The direction gate in
`runSignalPipeline()` returns a `BLOCKED` signal status, which maps to
`failedStage: "ATTRIBUTION"` and ultimately to a `NOT_SUBMITTED / PIPELINE_FAILURE`
outcome in the loop. This is correct: by the time the direction gate fires,
`dryRun()` has been called and a real pipeline outcome exists.

**Why `INSTRUMENT_POLICY_UNAVAILABLE` keeps `NOT_SUBMITTED`:** This gate
predates PR15.4 and is not being refactored in this PR. Changing its
discriminant would break existing observability consumers.

**New `TradingLoopSkipReason` values added to `types.ts`:**

```typescript
| "EXPOSURE_DATA_CONTRADICTION"
| "STRATEGY_STATE_SYNC_UNAVAILABLE"   // sync threw before any #runInstrument
| "STRATEGY_STATE_UNAVAILABLE"        // single-strategy getStrategyRuntimeState threw
| "NO_STRATEGY_SIGNAL"
| "STRATEGY_CONTRACT_MISMATCH"
| "STRATEGY_CONTEXT_UNAVAILABLE"
| "STRATEGY_EVALUATION_ERROR"
| "STRATEGY_CONFLICT"
| "STRATEGY_POLICY_MISMATCH"
```

**`NOT_SUBMITTED.reason` in `TradingLoopInstrumentOutcome`:**

The `NOT_SUBMITTED` branch currently has a manually maintained union that
mirrors most of `NotSubmittedReason`. PR15.4 adds two new reasons to
`NotSubmittedReason` in `execution-runtime.ts`:

```typescript
| "STRATEGY_ATTRIBUTION_UNAVAILABLE"
| "STRATEGY_ATTRIBUTION_MISMATCH"
```

To avoid maintaining duplicate unions, import `NotSubmittedReason` from
`execution-runtime.ts` and replace the inline list:

```typescript
import type {
  ExecutionRuntimeOutcome,
  NotSubmittedReason,
} from "../execution/execution-runtime.js";

// In TradingLoopInstrumentOutcome NOT_SUBMITTED branch:
readonly reason:
  | NotSubmittedReason
  | "INSTRUMENT_POLICY_UNAVAILABLE"   // loop-owned: predates PR15.4
  | "TRIGGER_UNAVAILABLE"             // loop-owned: key derivation failure
  | "STRATEGY_POLICY_MISMATCH";       // loop-owned: post-pipeline mismatch
```

`NotSubmittedReason` covers all reasons returned by `ExecutionRuntime`
(including the new attribution reasons). The three remaining values are
loop-level orchestration reasons that `ExecutionRuntime` never produces.
`#classifyRuntimeOutcome()` can continue to pass `runtime.reason` directly
without casting; future `NotSubmittedReason` additions need no second union.

---

## 13. Complete File Changes

### 13.1 New files

| File | Responsibility |
|------|----------------|
| `apps/signal-engine/src/runtime/strategy/active-strategy-resolver.ts` | Shared activation logic; discriminated union return type; `ActiveStrategyResolverOptions` with `onStateError` |
| `apps/signal-engine/src/runtime/strategy/active-strategy-resolver.test.ts` | Unit tests for resolver including `onStateError` callback test |
| `apps/signal-engine/src/runtime/strategy/strategy-context-loader.ts` | Binding verification, freshness, candle/contract fetch |
| `apps/signal-engine/src/runtime/strategy/strategy-context-loader.test.ts` | Unit tests |
| `apps/signal-engine/src/runtime/strategy/indicators.ts` | Extracted `computeIndicatorsForContext()` |
| `apps/signal-engine/src/runtime/strategy/indicators.test.ts` | Equivalence tests |
| `apps/signal-engine/src/runtime/strategy/regime.ts` | Extracted `detectRegimeForContext()` |
| `apps/signal-engine/src/runtime/strategy/regime.test.ts` | Equivalence tests |
| `apps/signal-engine/src/repository.test.ts` | Unit tests with fake Pool for exact-conId methods |
| `apps/signal-engine/src/signal-engine.test.ts` | Unit tests for `runForSymbol()` `kind:"error"` narrowing |
| `apps/signal-engine/src/portfolio/strategy-portfolio-manager.test.ts` | NEW — unit tests for discriminated result, `candidates`, deterministic `selected`, and `onStrategyError` callback safety |
| `packages/shared/src/signal-engine/pipeline.test.ts` | Tests for `runSignalPipeline()` direction gate only |

### 13.2 Modified — shared

| File | Change |
|------|--------|
| `packages/shared/src/signal-engine/types.ts` | Add `SignalBlockerCode`, `SignalBlocker`, `SignalAttributionContext`; add required `blockers: readonly SignalBlocker[]` to `SignalEvaluation`; extend `BLOCKED` jsdoc |
| `packages/shared/src/signal-engine/pipeline.ts` | Add `signalBlockers` to `PipelineOutcome`; add `attribution?` to `PipelineInputs`; direction gate inside `runSignalPipeline()` |
| `packages/shared/src/signal-engine/result.ts` | `deriveSignalStatus`: check `signalBlockers.length > 0` before `decision.blockedBy`; update `summarizeReason` BLOCKED branch |
| `packages/shared/src/signal-engine/evaluator.ts` | `evaluate(snapshot, attribution?)`: pass to pipeline; set `metadata.strategyId`; propagate `signalBlockers` -> `evaluation.blockers` |
| `packages/shared/src/signal-engine/evaluator.test.ts` | Update `build()` fixture with `blockers: []`; add attribution tests |
| `packages/shared/src/signal-engine/index.ts` | Export `SignalBlocker`, `SignalBlockerCode`, `SignalAttributionContext` |
| `packages/shared/src/trading-pipeline/orchestrator.ts` | `run()` accepts and threads optional `attribution?` to signal pipeline step |
| `packages/shared/src/trading-pipeline/pipeline.ts` | `SignalEngineLike.evaluate` gains optional `attribution?`; `runSignalStep` threads it through |
| `packages/shared/src/trading-pipeline/pipeline.test.ts` | Update `buildSignal()` fixture with `blockers: []`; add TradingPipeline attribution integration test |
| `packages/shared/src/trading-pipeline/types.ts` | Add `"ATTRIBUTION"` to `TradingPipelineFailedStage`; extend `TradingPipelineFailure` jsdoc |
| `packages/shared/src/trading-pipeline/result.ts` | `deriveFailedStageFromSignal`: typed blocker check -> `"ATTRIBUTION"` (no string searching) |
| `packages/shared/src/execution-ticket/builder.test.ts` | Update `buildSignal()` fixture with `blockers: []` |

### 13.3 Modified — signal-engine app

| File | Change |
|------|--------|
| `apps/signal-engine/src/repository.ts` | Add `#syncMutex` serialization to `syncStrategyRuntimeStates()` (§4.5.2); add `getInstrumentContractByConId()` and `getRecentCandlesForContract()` |
| `apps/signal-engine/src/signal-engine.ts` | Add `onStrategyError?` and `onStrategyStateError?` to `SignalEngineOptions` (§8.7); pass `onStrategyError` to internal `StrategyPortfolioManager`; pass `onStrategyStateError` to `resolveActiveStrategyIds()`; add `kind:"error"` narrowing on resolver result and after `portfolioManager.run()` (§8.6); delegate activation to `resolveActiveStrategyIds()` |
| `apps/signal-engine/src/portfolio/strategy-portfolio-manager.ts` | Discriminated `StrategyPortfolioRunResult`; `StrategyPortfolioManagerOptions` with `onStrategyError`; backward-compatible constructor |
| `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts` | Add `portfolioManager`, `repo: StrategyRuntimeStateRepository`, `strategyCooldownMs` options (§4.5.6); `syncStrategyRuntimeStates` in `#runCycle()` with `#recordSkip`-based error path (§4.5.3); add `#trimLastOutcomes()` helper called in both paths (§4.5.4); extend `#recordSkip()` to accept any `TradingLoopSkipReason` and optional `message` (§4.5.5); `resolveInstrumentPolicy()` fail-closed on `expectedDirection` (§9.2); all new PR15.4 guards use `SKIPPED` (§12); post-pipeline defence-in-depth as `SKIPPED` (§10.2) |
| `apps/signal-engine/src/runtime/trading-loop/types.ts` | Add 9 new `TradingLoopSkipReason` values (§12); import `NotSubmittedReason` from `execution-runtime.ts`; replace inline `NOT_SUBMITTED.reason` union (§12) |
| `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts` | Integration tests for all scenarios in §14.7; `STRATEGY_ATTRIBUTION_UNAVAILABLE` and `STRATEGY_ATTRIBUTION_MISMATCH` pass-through (§14.7 tests 22-23) |
| `apps/signal-engine/src/runtime/trading-loop/idempotency-key.test.ts` | `strategyId` in key hash; different ID -> different `clientOrderId` |
| `apps/signal-engine/src/runtime/execution/execution-runtime.ts` | `ExecutePreparedInput` type; four-stage validation (§11.3); `strategyLabel` parameter to `#submitFromDryRun` (§11.4); add `STRATEGY_ATTRIBUTION_UNAVAILABLE` and `STRATEGY_ATTRIBUTION_MISMATCH` to `NotSubmittedReason` |
| `apps/signal-engine/src/runtime/execution/execution-runtime.test.ts` | Tests for all four validation stages; NO_TRADE and FAILURE pass-through; `check()`; ticket mapper; hash; submission outcomes |
| `apps/signal-engine/src/runtime/runtime.ts` | `dryRun(id, policy, attribution?)`: thread attribution to pipeline via orchestrator |
| `apps/signal-engine/src/runtime/runtime.test.ts` | EXTEND — attribution threading integration tests (§14.15) |
| `apps/signal-engine/src/index.ts` | Build separate `portfolioManager` for `TradingLoopService` with `onStrategyError`; supply `portfolioManager`, `repo`, `strategyCooldownMs` to `TradingLoopService`; add `onStrategyError` and `onStrategyStateError` to `SignalEngine` options |
| `docs/implementation/phase2/PHASE_2_ROADMAP.md` | Add PR15.4 entry |
| `docs/architecture/TRADING_LOOP.md` | Update attribution flow diagram |

### 13.4 Test fixtures requiring updates

- `packages/shared/src/signal-engine/evaluator.test.ts` — `build()` fixture must add `blockers: []`
- `packages/shared/src/trading-pipeline/pipeline.test.ts` — `buildSignal()` fixture must add `blockers: []`
- `packages/shared/src/execution-ticket/builder.test.ts` — `buildSignal()` fixture must add `blockers: []`

After all type changes: run `pnpm typecheck` to find any remaining manually-constructed
`SignalEvaluation` instances. All must add `blockers: []` before typecheck passes.

### 13.5 Unchanged

- `apps/execution-engine/` — NO changes
- `packages/shared/src/decision-engine/` — NO changes
- `packages/shared/src/risk-engine/` — NO changes
- `packages/shared/src/execution-ticket/types.ts` — NO changes
- `packages/shared/src/instruments/types.ts` — `expectedDirection` stays optional (§9.2)
- `packages/shared/src/instruments/definitions.ts` — all seeds remain disabled

---

## 14. Test Plan

### 14.1 Unit: `runSignalPipeline()` direction gate

**File:** `packages/shared/src/signal-engine/pipeline.test.ts` (NEW)

1. Decision LONG, intendedAction LONG -> `signalBlockers = []`; Risk called once
2. Decision LONG, intendedAction SHORT -> `signalBlockers[0].code = "STRATEGY_DIRECTION_UNCONFIRMED"`; `source = "attribution"`; `riskSkipped = true`; Risk NOT called
3. Decision HOLD, attribution provided -> `signalBlockers = []`; Risk skipped via HOLD path
4. Decision BLOCKED, attribution provided -> `signalBlockers = []`; Risk skipped via blocked path
5. No attribution -> `signalBlockers = []`; direction gate inactive

### 14.2 Integration: full TradingPipeline attribution flow

**File:** `packages/shared/src/trading-pipeline/pipeline.test.ts` (EXISTING — extend)

```
Test: "direction mismatch => ATTRIBUTION failure, RiskEngine not called"

Setup:
  - fakeDecisionEngine: returns action = "LONG"
  - spyRiskEngine: records call count; not invoked in this test
  - fakeInstrumentResolver: returns a valid instrument
  - SignalEngine constructed with fake engines
  - TradingPipeline constructed with real SignalEngine
  - attribution: { strategyId: "test_v1", intendedAction: "SHORT" }

Execute:
  - result = TradingPipeline.run(snapshot, instrument, policy, attribution)

Verify:
  - result.outcome === "FAILURE"
  - result.failedStage === "ATTRIBUTION"
  - spyRiskEngine was not called
  - result.signal.blockers.length === 1
  - result.signal.blockers[0].code === "STRATEGY_DIRECTION_UNCONFIRMED"
  - result.signal.blockers[0].source === "attribution"
  - result.signal.metadata.strategyId === "test_v1"
```

### 14.3 Unit: `SignalEngine.evaluate()` with attribution

**File:** `packages/shared/src/signal-engine/evaluator.test.ts` (EXISTING — extend)

For each status (GENERATED, HOLD, BLOCKED, REJECTED, ERROR) with attribution:
`metadata.strategyId === attribution.strategyId`. Without attribution:
`metadata.strategyId === undefined`. Uses real `SignalEngine` and
`runSignalPipeline()`.

### 14.4 Unit: active-strategy resolver

**File:** `active-strategy-resolver.test.ts` (NEW)

1. All enabled -> `kind:"ok"` with all IDs returned
2. Symbol in `excludedSymbols` -> excluded
3. Symbol not in `includedSymbols` -> excluded
4. `runtimeState.enabled = false` -> excluded
5. `runtimeState.permanentlyDisabled = true` -> excluded
6. `cooldownUntil` in future (injected clock, compared against `evaluatedAt`) -> excluded
7. `cooldownUntil` in past (injected clock) -> included
8. No active strategies -> `kind:"ok"` with empty `activeIds`, populated `disabledReasons`
9. Second `getStrategyRuntimeState()` call throws:
   - return `kind:"error"` with that strategyId
   - `onStateError` callback invoked with the full error object (spy assertion)
   - first partial result ignored
10. Resolution result is deterministic for given inputs (injected clock)

### 14.5 Unit: StrategyContextLoader

**File:** `strategy-context-loader.test.ts` (NEW)

1. Valid data, all fields match -> `StrategyContext` returned
2. No 1m candles -> `STRATEGY_CONTEXT_UNAVAILABLE`
3. 1m candle count < 220 -> `STRATEGY_CONTEXT_UNAVAILABLE`
4. Latest 1m candle older than `MAX_CANDLE_AGE_MS["1m"]` -> `STRATEGY_CONTEXT_UNAVAILABLE`
5. Latest 1m candle has future timestamp -> `STRATEGY_CONTEXT_UNAVAILABLE`
6. `getInstrumentContractByConId` returns null -> `STRATEGY_CONTRACT_MISMATCH`
7. Contract `conid` matches but `contract.symbol` does not match `bound.brokerSymbol` -> `STRATEGY_CONTRACT_MISMATCH`; zero portfolio, zero pipeline
8. Contract `conid` field mismatches `bound.conId` -> `STRATEGY_CONTRACT_MISMATCH`
9. Contract `exchange` and `primaryExchange` both mismatch -> `STRATEGY_CONTRACT_MISMATCH`
10. Contract exchange mismatch but `primaryExchange` matches -> accepted
11. DB row has null `currency` -> `STRATEGY_CONTRACT_MISMATCH`
12. DB row has null `localSymbol` -> `STRATEGY_CONTRACT_MISMATCH`
13. `contract.secType` differs from `mapAssetClassToIbkrSecType(instrument.assetClass)` -> `STRATEGY_CONTRACT_MISMATCH`
14. Market state absent -> `STRATEGY_CONTEXT_UNAVAILABLE`
15. Market state timestamp in future -> `STRATEGY_CONTEXT_UNAVAILABLE`
16. Market state age > `maxMarketStateAgeMs` -> `STRATEGY_CONTEXT_UNAVAILABLE`
17. Indicator computation returns null -> `STRATEGY_CONTEXT_UNAVAILABLE`
18. Non-1m timeframe below minimum candles -> `STRATEGY_CONTEXT_UNAVAILABLE`
19. Candles fetched via `getRecentCandlesForContract`; cross-conId rows excluded at DB level

### 14.6 Unit: ExecutionRuntime validation

**File:** `execution-runtime.test.ts` (EXISTING — extend)

All tests must verify that existing behaviors are preserved; only the `strategy`
field value changes for the `executePrepared` path:

1. Valid `strategyId` matching pipeline metadata, SUCCESS pipeline ->
   submitter called with `strategy = strategyId`;
   ticket mapped via `toLegacySignalTicket`; `clientOrderHash` computed;
   `clientOrderId = idempotencyKey`; PaperGuard called via `check()`
2. Missing `strategyId` -> `STRATEGY_ATTRIBUTION_UNAVAILABLE`; PaperGuard NOT called; submitter NOT called
3. Empty string `strategyId` -> `STRATEGY_ATTRIBUTION_UNAVAILABLE`; PaperGuard NOT called; submitter NOT called
4. Whitespace-padded `strategyId` (e.g. `" id "`) -> `STRATEGY_ATTRIBUTION_UNAVAILABLE`; PaperGuard NOT called; submitter NOT called
5. Non-empty `strategyId` but different from pipeline `metadata.strategyId` -> `STRATEGY_ATTRIBUTION_MISMATCH`; PaperGuard NOT called; submitter NOT called
6. NO_TRADE pipeline -> reason `NO_TRADE`; PaperGuard NOT called; submitter NOT called
7. FAILURE/ATTRIBUTION pipeline -> reason `PIPELINE_FAILURE`; PaperGuard NOT called; submitter NOT called
8. FAILURE/RISK pipeline -> reason `PIPELINE_FAILURE`; PaperGuard NOT called; submitter NOT called
9. `execute()` path (operator endpoint) -> submitter called with `strategy = "execution-runtime"` (unchanged)
10. `resumed` submission kind -> outcome `SUBMITTED` with `resumed: true` (unchanged)
11. `duplicate_submitted` submission kind -> outcome `DUPLICATE` (unchanged)
12. `conflict` submission kind -> outcome `CONFLICT` (unchanged)

### 14.7 Integration: TradingLoopService full attribution chain

**File:** `trading-loop-service.test.ts` (EXISTING — extend)

Attribution flows end-to-end via a fake `MarketDataRuntime` that returns a
pre-constructed `DryRunResult`. Tests verify attribution is passed as the third
argument to the fake runtime's `dryRun()`. Tests do NOT verify
`metadata.strategyId` by inspecting a manually-built pipeline result; that
end-to-end threading is covered by `runtime.test.ts` (§14.15).
All assertions reference the real `kind` field on `TradingLoopInstrumentOutcome`.
`proposed_orders.strategy` is verified at the submitter-contract level only
(fake submitter spy receives `strategy: strategyId`); DB record verification
is deferred to an optional pg-integration test.

1. Strategy LONG, Decision LONG, submitter returns `submitted` ->
   `kind: "SUBMITTED"`; fake submitter receives `strategy: strategyId`;
   fake runtime receives `attribution` with correct `strategyId` as third arg
2. `syncStrategyRuntimeStates` spy called once even with two instruments (not twice)
3. `syncStrategyRuntimeStates` throws:
   - both instruments get `{ kind: "SKIPPED", reason: "STRATEGY_STATE_SYNC_UNAVAILABLE" }`
   - outcome `message` does NOT contain raw error text
   - logger spy receives the full error object
   - zero exposure reads; zero reconciliation; zero state reads; zero loader;
     zero portfolio; zero dryRun; zero execution runtime; zero submitter
4. Strategy LONG, Decision SHORT ->
   `kind: "NOT_SUBMITTED"`, `reason: "PIPELINE_FAILURE"`; `metadata.strategyId` set
5. Winner `signal.symbol` differs from `instrument.brokerSymbol` ->
   `kind: "SKIPPED"`, `reason: "STRATEGY_POLICY_MISMATCH"`; zero dryRun
6. Winner `signal.strategyId` != `winner.strategy.id` ->
   `kind: "SKIPPED"`, `reason: "STRATEGY_POLICY_MISMATCH"`; zero dryRun
7. Winner `strategy.id` != `executionPolicy.strategyId` ->
   `kind: "SKIPPED"`, `reason: "STRATEGY_POLICY_MISMATCH"`; zero dryRun
8. `strategy.supportedDirections` does NOT include `signal.direction` ->
   `kind: "SKIPPED"`, `reason: "STRATEGY_POLICY_MISMATCH"`; zero dryRun
9. `signal.direction` != `executionPolicy.expectedDirection` ->
   `kind: "SKIPPED"`, `reason: "STRATEGY_POLICY_MISMATCH"`; zero dryRun
10. `direction = LONG` but `side = SELL` ->
    `kind: "SKIPPED"`, `reason: "STRATEGY_POLICY_MISMATCH"`; zero dryRun
11. Post-pipeline attribution mismatch ->
    `kind: "SKIPPED"`, `reason: "STRATEGY_POLICY_MISMATCH"`
12. Strategy throws -> `kind: "SKIPPED"`, `reason: "STRATEGY_EVALUATION_ERROR"`
13. LONG + SHORT candidates -> `kind: "SKIPPED"`, `reason: "STRATEGY_CONFLICT"`
14. Risk rejects -> `kind: "NOT_SUBMITTED"`, `reason: "PIPELINE_FAILURE"`;
    `metadata.strategyId` set
15. Context unavailable -> `kind: "SKIPPED"`, `reason: "STRATEGY_CONTEXT_UNAVAILABLE"`
16. Contract mismatch -> `kind: "SKIPPED"`, `reason: "STRATEGY_CONTRACT_MISMATCH"`
17. No active strategy -> `kind: "SKIPPED"`, `reason: "NO_STRATEGY_SIGNAL"`
18. `getStrategyRuntimeState()` throws ->
    `kind: "SKIPPED"`, `reason: "STRATEGY_STATE_UNAVAILABLE"`
19. `hasOpenPosition = false` but `quantity` non-zero ->
    `kind: "SKIPPED"`, `reason: "EXPOSURE_DATA_CONTRADICTION"`
20. Policy `expectedDirection` missing ->
    `kind: "NOT_SUBMITTED"`, `reason: "INSTRUMENT_POLICY_UNAVAILABLE"`
21. Manual run-once and scheduler invoke identical gate
22. Fake runtime returns `NOT_SUBMITTED / STRATEGY_ATTRIBUTION_UNAVAILABLE`:
    loop outcome has `kind: "NOT_SUBMITTED"`, `reason: "STRATEGY_ATTRIBUTION_UNAVAILABLE"`,
    preserved `runtime` and `idempotencyKey`
23. Fake runtime returns `NOT_SUBMITTED / STRATEGY_ATTRIBUTION_MISMATCH`:
    loop outcome has `kind: "NOT_SUBMITTED"`, `reason: "STRATEGY_ATTRIBUTION_MISMATCH"`,
    preserved `runtime` and `idempotencyKey`

### 14.8 Unit: legacy `SignalEngine.runForSymbol()` narrowing

**File:** `apps/signal-engine/src/signal-engine.test.ts` (NEW)

1. Strategy throws inside `generateSignal()`:
   - `runForSymbol()` does NOT throw
   - Returns a rejected/HOLD result with safe message
   - `onStrategyError` callback in `SignalEngineOptions` receives the full error object
   - Result message does NOT contain `err.message` or stack trace

2. `getStrategyRuntimeState()` throws for a strategy:
   - `resolveActiveStrategyIds()` returns `kind: "error"`
   - `runForSymbol()` does NOT throw
   - Returns a rejected/HOLD result with safe message
   - `onStrategyStateError` callback in `SignalEngineOptions` receives the full error object
   - Result message does NOT contain raw error text
   - No `proposed_orders` row with executable intent in either case

### 14.9 Unit: idempotency key

**File:** `idempotency-key.test.ts` (EXISTING — extend)

1. `strategyId` included in key hash
2. Different `strategyId` -> different `clientOrderId`

### 14.10 Unit: indicator/regime equivalence

**Files:** `indicators.test.ts`, `regime.test.ts` (NEW)

Given identical candle fixtures: extracted helper output equals legacy
`SignalEngine.runForSymbol()` inline output for every `IndicatorSnapshot` field.

### 14.11 Unit: repository exact-conId methods and sync serialization

**File:** `apps/signal-engine/src/repository.test.ts` (NEW)

**Exact-conId methods:**

1. `getInstrumentContractByConId("123")` executes `WHERE conid = $1` with `["123"]`
2. Row with different conId is not returned
3. `getRecentCandlesForContract("AAPL", "123", "1h", 10)` selects from `candles_1h`; passes `["AAPL", "123", 10]`; result in ascending `ts` order
4. Cross-conId row for same symbol is excluded by query

**Sync serialization:**

5. Two concurrent `syncStrategyRuntimeStates` calls with different arguments:
   - first: `(["strategy_a"], 1000)` — held at a deferred DB query
   - second: `(["strategy_b"], 2000)` — started concurrently
   Verify:
   - second call does NOT begin DB queries until first fully resolves
   - first call completes with its own arguments `["strategy_a"]`, `1000`
   - second call completes with its own arguments `["strategy_b"]`, `2000`
   - arguments are never merged or overwritten
   - both calls resolve to their own independent outcomes

6. First sync rejects (error thrown): second sync still executes and completes
   normally; the mutex is not permanently poisoned by a rejection

> **Integration tests against real PostgreSQL** are optional and gated by env
> var. If implemented, they require a separate `"test:pg-integration"` script
> in `apps/signal-engine/package.json` and that `package.json` entry must be
> added to the file change list. The existing root `pnpm test:integration` runs
> only `execution-engine` and is NOT modified by this PR.

### 14.12 Unit: callback safety

**File:** `active-strategy-resolver.test.ts` (extend)

1. `onStateError` receives the original error object (not a wrapper)
2. `onStateError` throws: resolver still returns `kind:"error"` with
   `STRATEGY_STATE_UNAVAILABLE`; callback exception does NOT propagate

**File:** `strategy-portfolio-manager.test.ts` (NEW)

3. `onStrategyError` receives the original error object
4. `onStrategyError` throws: manager still returns `kind:"error"` with
   `STRATEGY_EVALUATION_EXCEPTION`; callback exception does NOT propagate
5. `run()` returns a `candidates` array listing all strategies that produced a signal
6. Deterministic sort — verified separately:
   - higher `lanePriority` wins regardless of `confidenceScore`
   - equal `lanePriority`: higher `confidenceScore` wins
   - equal `lanePriority` and `confidenceScore`: lexicographically smaller `strategy.id` wins
7. `selected === candidates[0]`

**File:** `signal-engine.test.ts` (NEW — extend §14.8)

7. `onStrategyStateError` throws, `runForSymbol()` still returns safe rejected/HOLD
8. `onStrategyError` throws, `runForSymbol()` still returns safe rejected/HOLD

**File:** `trading-loop-service.test.ts` (extend)

9. Resolver `onStateError` callback throws: loop outcome is still
   `kind: "SKIPPED"`, `reason: "STRATEGY_STATE_UNAVAILABLE"`
10. Manager `onStrategyError` callback throws: loop outcome is still
    `kind: "SKIPPED"`, `reason: "STRATEGY_EVALUATION_ERROR"`

### 14.13 Unit: `STRATEGY_CONFLICT` detection and `#trimLastOutcomes`

**File:** `trading-loop-service.test.ts` (extend)

1. One LONG candidate and one SHORT candidate ->
   `kind: "SKIPPED"`, `reason: "STRATEGY_CONFLICT"`; zero dryRun; zero execution runtime; zero submitter
2. Two LONG candidates only -> no conflict; `selected` is highest `lanePriority`, then `confidenceScore`, then lexicographically smallest `strategy.id`
3. Two SHORT candidates only -> no conflict; same deterministic selection
4. Zero candidates -> `kind: "SKIPPED"`, `reason: "NO_STRATEGY_SIGNAL"`
5. Sync failure with more than `HISTORY_LIMIT` (100) unique instruments: after the
   cycle, `status().lastOutcomes` contains at most 100 entries; oldest entries
   are evicted first

### 14.15 Integration: `MarketDataRuntime.dryRun()` attribution threading

**File:** `apps/signal-engine/src/runtime/runtime.test.ts` (EXISTING — extend)

Uses the real `MarketDataRuntime`, `SignalEngine`, and `TradingPipeline`.
DecisionEngine is controlled (fake); RiskEngine is either a spy or a controlled
implementation. This test verifies that attribution is fully threaded through
`dryRun` → `TradingPipeline.run` → `SignalEngine.evaluate` → `runSignalPipeline`.

1. `dryRun(id, policy, { strategyId: "test_long_v1", intendedAction: "LONG" })`
   with Decision returning LONG:
   - pipeline result passes normally (not ATTRIBUTION failure)
   - `pipeline.signal.metadata.strategyId === "test_long_v1"`
   - RiskEngine is called (direction confirmed)

2. `dryRun(id, policy, { strategyId: "test_short_v1", intendedAction: "SHORT" })`
   with Decision returning LONG:
   - `pipeline.outcome === "FAILURE"`
   - `pipeline.failedStage === "ATTRIBUTION"`
   - `pipeline.signal.metadata.strategyId === "test_short_v1"`
   - RiskEngine is NOT called (spy call count === 0)

3. `dryRun(id, policy)` with no attribution:
   - pipeline behavior is unchanged from pre-PR15.4 baseline
   - `pipeline.signal.metadata.strategyId === undefined`

These tests detect attribution loss at any of three layers:
- `TradingLoopService` did not pass attribution to `dryRun()`
- `MarketDataRuntime` did not forward it to `TradingPipeline.run()`
- `TradingPipeline` did not forward it to `SignalEngine.evaluate()`

### 14.16 Gate commands

```bash
git diff --check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

> **Note on `proposed_orders.strategy` verification:** The unit tests
> verify only that the fake submitter receives `strategy: strategyId`.
> Verifying the persisted DB column requires a PostgreSQL integration test.
> This is deferred and would require a `"test:pg-integration"` script added
> to `apps/signal-engine/package.json`, which must then appear in §13.3.

---

## 15. Roadmap

Add to `docs/implementation/phase2/PHASE_2_ROADMAP.md`:

| Sub-track | Scope | Status |
|-----------|-------|--------|
| PR15.4 | Strategy Attribution and Direction Gate | planned |

---

## 16. Acceptance Criteria

- [ ] Direction gate fires inside `runSignalPipeline()`, before Risk Engine
- [ ] Risk Engine not called when direction disagrees (verified by §14.2 spy)
- [ ] Direction gate maps to `NOT_SUBMITTED / PIPELINE_FAILURE("ATTRIBUTION")` in the loop (§12)
- [ ] Typed `SignalBlocker` with `source:"attribution"` propagated to `SignalEvaluation.blockers`
- [ ] `deriveFailedStageFromSignal` maps blocker via `source` field -> `"ATTRIBUTION"` (no string searching)
- [ ] `"ATTRIBUTION"` added to `TradingPipelineFailedStage`
- [ ] `SignalEvaluation.metadata.strategyId` set for all `SignalStatus` values when attribution provided
- [ ] `blockers: []` added to all existing `SignalEvaluation` fixtures (§13.4)
- [ ] `syncStrategyRuntimeStates` is serialized inside `SignalRepository` via promise-chain mutex (§4.5.2); no external library
- [ ] Concurrent sync calls are NOT merged or skipped; each caller gets its own promise
- [ ] Mutex rejection does not block subsequent sync calls (§4.5.2, §14.11 test 6)
- [ ] `syncStrategyRuntimeStates(portfolioManager.strategyIds, cooldownMs)` called once per `#runCycle()` (§4.5.3)
- [ ] Sync error: `#recordSkip` called per selected instrument with `STRATEGY_STATE_SYNC_UNAVAILABLE`; `#logInstrumentReport` called; `#trimLastOutcomes()` called before return; full error in one logger call (§4.5.3, §4.5.5)
- [ ] `#trimLastOutcomes()` private helper: replaces inline loop in normal path; also called in sync-error path before returning `TradingLoopCycleReport` (§4.5.4)
- [ ] After sync failure with >100 instruments `status().lastOutcomes` contains at most 100 entries (§14.13 test 5)
- [ ] `#recordSkip()` extended to accept any `TradingLoopSkipReason` and optional operator-safe `message` (§4.5.5)
- [ ] `STRATEGY_STATE_SYNC_UNAVAILABLE` added to `TradingLoopSkipReason` (§12)
- [ ] `TradingLoopServiceOptions` gains `portfolioManager`, `repo: StrategyRuntimeStateRepository`, `strategyCooldownMs` (§4.5.6)
- [ ] `StrategyRuntimeStateReader` and `StrategyRuntimeStateRepository` interfaces defined separately; resolver depends only on `Reader` (§4.5.6, §5.3)
- [ ] `expectedDirection` validated as `"LONG"|"SHORT"` in `resolveInstrumentPolicy()` (§9.2); uses existing `NOT_SUBMITTED / INSTRUMENT_POLICY_UNAVAILABLE`
- [ ] `onStateError` callback is best-effort: wrapped in `try/catch`; resolver returns `kind:"error"` even if callback throws (§5.5)
- [ ] `onStrategyError` callback is best-effort: wrapped in `try/catch`; manager returns `kind:"error"` even if callback throws (§8.3)
- [ ] Each callback test is in its own unit (resolver test, manager test, signal-engine test, loop test) per §14.12
- [ ] Full attribution chain verified before dryRun (§10.1) — all six checks; each uses `SKIPPED`
- [ ] All newly introduced PR15.4 loop-owned guards outside `ExecutionRuntime` use `kind: "SKIPPED"` (§12)
- [ ] `STRATEGY_CONFLICT` detected from `result.candidates` directions before checking `selected` (§8.4)
- [ ] LONG+SHORT candidates -> `SKIPPED / STRATEGY_CONFLICT` in `trading-loop-service.test.ts` (§14.13)
- [ ] LONG-only or SHORT-only candidates -> no conflict (§14.13)
- [ ] `strategy-portfolio-manager.test.ts` covers `candidates`, deterministic `selected`, and callback safety (§14.12)
- [ ] Post-pipeline defence-in-depth uses `SKIPPED / STRATEGY_POLICY_MISMATCH` (§10.2)
- [ ] `NOT_SUBMITTED.reason` in `TradingLoopInstrumentOutcome` uses imported `NotSubmittedReason` union; only 3 loop-owned values added alongside it (§12)
- [ ] `STRATEGY_ATTRIBUTION_UNAVAILABLE` and `STRATEGY_ATTRIBUTION_MISMATCH` added to `NotSubmittedReason` in `execution-runtime.ts`
- [ ] `#classifyRuntimeOutcome()` passes `runtime.reason` without casting; typecheck passes (§12, §14.7 tests 22-23)
- [ ] Attribution pass-through verified in `runtime.test.ts` (§14.15): direction MATCH, direction MISMATCH, no attribution
- [ ] `#submitFromDryRun` unchanged except `strategyLabel` parameter (§11.4)
- [ ] Deterministic `StrategyPortfolioManager` sort: `lanePriority DESC, confidenceScore DESC, strategy.id ASC`; verified in `strategy-portfolio-manager.test.ts` (§14.12 tests 6-7)
- [ ] `STRATEGY_ATTRIBUTION_UNAVAILABLE` for absent/empty/whitespace strategyId
- [ ] `STRATEGY_ATTRIBUTION_MISMATCH` for pipeline metadata disagreement
- [ ] `EXPOSURE_DATA_CONTRADICTION` checked before policy resolution; uses `SKIPPED` (§12)
- [ ] Resolver `onStateError` called with full error; `onStrategyStateError` wired in `runForSymbol()` (§5.3, §5.5)
- [ ] `onStrategyError` and `onStrategyStateError` added to `SignalEngineOptions`; backward-compatible (§8.7)
- [ ] `SignalEngine` and `TradingLoopService` each have separate `StrategyPortfolioManager` instances (§4.5.7, §8.7)
- [ ] Clock evaluated once per resolver call via `evaluatedAt` before the per-strategy loop (§5.4)
- [ ] `instrument.brokerSymbol` used in all symbol lookups
- [ ] `secType` validated via `mapAssetClassToIbkrSecType()` + equality; no unsafe cast (§7.3)
- [ ] All contract required fields checked; missing field is `STRATEGY_CONTRACT_MISMATCH` (§7.5)
- [ ] `exposureSnapshot` on `StrategyContext` remains omitted (deferred)
- [ ] Candles and contract loaded by exact conId; new repository methods added
- [ ] Freshness validated against `MAX_CANDLE_AGE_MS` per-timeframe constants
- [ ] `StrategyPortfolioManager.run()` returns discriminated union `StrategyPortfolioRunResult` (§8.1)
- [ ] Fake submitter receives `strategy: strategyId` for `executePrepared` path (§14.7 test 1)
- [ ] `git diff --check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` pass

---

## 17. Rollback

1. Revert commits (touches `apps/signal-engine/`, `packages/shared/` pipeline and types)
2. Restart signal-engine
3. Trading loop reverts to always-failing `STRATEGY_POLICY_MISMATCH`
4. No migration to undo; execution-engine unchanged
5. Time: < 5 minutes

---

## 18. Out of Scope

- `es_front` activation; Paper E2E; PR16
- StrategySignal execution fields (entry, SL, TP) in ticket builder
- Full ExposureSnapshot in StrategyContext (deferred)
- `proposed_orders` schema change
- execution-engine changes
- `llm-agent` changes

---

**Status: planned, awaiting approval.**
