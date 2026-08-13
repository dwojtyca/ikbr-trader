# PR15.4 — Strategy Attribution & Direction Gate — REPORT

**Status:** implementation complete, all §14 tests shipped, all §16
acceptance criteria met; awaiting independent code review.

**Plan:** `docs/implementation/phase2/PR15_4_PLAN.md` (r15, approved).

**No commit, no push.**

---

## 1. Scope

PR15.4 wires `StrategyPortfolioManager` into the trading loop as the
authoritative source of directional intent, propagates a typed
`SignalAttributionContext` end-to-end
(`TradingLoopService → MarketDataRuntime → TradingPipeline → SignalEngine
→ runSignalPipeline`), enforces a fail-closed direction gate inside
`runSignalPipeline` before the Risk Engine is called, adds a typed
`SignalBlocker` classification and a new `TradingPipelineFailedStage`
value (`ATTRIBUTION`), and enforces `proposed_orders.strategy = strategyId`
via a new `ExecutionRuntime.executePrepared` four-stage validation.

Business logic is shared between Paper and Live; operational verification
is Paper-only and Live remains disabled. No schema migration. No
execution-engine changes. No `es_front` (or any other instrument)
activation. No Paper E2E.

---

## 2. Files Changed

### 2.1 Modified — shared package (`packages/shared`)

- `src/signal-engine/types.ts` — added `SignalBlockerCode`,
  `SignalBlocker`, `SignalAttributionContext`; added required
  `blockers: readonly SignalBlocker[]` to `SignalEvaluation`; extended
  `SignalStatus.BLOCKED` jsdoc.
- `src/signal-engine/pipeline.ts` — added `signalBlockers` to
  `PipelineOutcome`; added optional `attribution` to `PipelineInputs`;
  direction gate inside `runSignalPipeline` before instrument
  resolution and Risk; every return site sets `signalBlockers`.
- `src/signal-engine/result.ts` — `deriveSignalStatus` new rule order
  (ERROR → `signalBlockers.length > 0` → `decision.blockedBy.length >
0` → HOLD → REJECTED → GENERATED); `summarizeReason` handles the
  blocker-driven BLOCKED branch.
- `src/signal-engine/evaluator.ts` — `evaluate(snapshot,
attribution?)` and `evaluateMany(snapshots, attribution?)` thread
  attribution to `runSignalPipeline`, propagate `outcome.signalBlockers`
  to `evaluation.blockers`, always stamp
  `metadata.strategyId = attribution?.strategyId`.
- `src/trading-pipeline/types.ts` — added `"ATTRIBUTION"` to
  `TradingPipelineFailedStage`; extended `TradingPipelineFailure`
  jsdoc.
- `src/trading-pipeline/pipeline.ts` — `SignalEngineLike.evaluate`
  accepts optional `attribution`; `runSignalStep` threads it.
- `src/trading-pipeline/orchestrator.ts` — `TradingPipeline.run`
  accepts optional `attribution` and threads it into `runSignalStep`
  via `#runInner`.
- `src/trading-pipeline/result.ts` — `deriveFailedStageFromSignal`
  typed check on `signal.blockers.some(b => b.source ===
"attribution")` → `"ATTRIBUTION"`; no string searching.
- Test fixture updates:
  `src/execution-ticket/builder.test.ts`,
  `src/trading-pipeline/pipeline.test.ts` — `buildSignal` helpers
  add required `blockers: []`.

### 2.2 Modified — signal-engine app (`apps/signal-engine`)

- `src/repository.ts` — promise-chain mutex on
  `syncStrategyRuntimeStates` (delegates to private
  `#doSyncStrategyRuntimeStates`); new `getInstrumentContractByConId`
  and `getRecentCandlesForContract` (exact-`conId`, no symbol
  fallback).
- `src/portfolio/strategy-portfolio-manager.ts` — discriminated
  `StrategyPortfolioRunResult` (`kind: "ok" | "error"`);
  `StrategyPortfolioManagerOptions` with best-effort `onStrategyError`
  callback; `candidates` in result; `try/catch` around
  `generateSignal`.
- `src/signal-engine.ts` — added optional `onStrategyError` and
  `onStrategyStateError` to `SignalEngineOptions`; constructor
  passes `onStrategyError` to the internal
  `StrategyPortfolioManager`; `runForSymbol` delegates activation to
  `resolveActiveStrategyIds` with `kind:"error"` narrowing; portfolio
  manager `run()` narrowed on discriminated result.
- `src/runtime/execution/execution-runtime.ts` — added
  `STRATEGY_ATTRIBUTION_UNAVAILABLE` and
  `STRATEGY_ATTRIBUTION_MISMATCH` to `NotSubmittedReason`; new
  `ExecutePreparedInput` type with required `strategyId`; four-stage
  validation in `executePrepared`; `#submitFromDryRun` now accepts
  `strategyLabel` and forwards it to the submitter; `execute()`
  operator path continues to pass `this.#strategy`.
- `src/runtime/runtime.ts` — `MarketDataRuntime.dryRun` accepts
  optional `attribution` and threads it into `TradingPipeline.run`.
- `src/runtime/trading-loop/types.ts` — imported `NotSubmittedReason`
  from `ExecutionRuntime`; `TradingLoopInstrumentOutcome.NOT_SUBMITTED
.reason` union now `NotSubmittedReason | "INSTRUMENT_POLICY_UNAVAILABLE" |
"TRIGGER_UNAVAILABLE" | "STRATEGY_POLICY_MISMATCH"`; added the nine
  new `TradingLoopSkipReason` values (`EXPOSURE_DATA_CONTRADICTION`,
  `STRATEGY_STATE_SYNC_UNAVAILABLE`, `STRATEGY_STATE_UNAVAILABLE`,
  `NO_STRATEGY_SIGNAL`, `STRATEGY_CONTRACT_MISMATCH`,
  `STRATEGY_CONTEXT_UNAVAILABLE`, `STRATEGY_EVALUATION_ERROR`,
  `STRATEGY_CONFLICT`, `STRATEGY_POLICY_MISMATCH`).
- `src/runtime/trading-loop/trading-loop-service.ts` — new
  `StrategyRuntimeStateRepository` port; required
  `portfolioManager`/`repo`/`strategyCooldownMs`/`maxMarketStateAgeMs`
  options; once-per-cycle `syncStrategyRuntimeStates` in
  `#runCycle` with fan-out via `#recordSkip` on failure;
  `#trimLastOutcomes` helper called from both cycle-end paths;
  `#recordSkip` extended to any `TradingLoopSkipReason` and optional
  `message`; `resolveInstrumentPolicy` fail-closed on
  `expectedDirection`; loop-driven attribution chain (six pre-dryRun
  checks) → `dryRun(id, policy, attribution)` → post-pipeline
  defence-in-depth → `executePrepared({..., strategyId})` with the
  bound instrument forwarded.
- `src/index.ts` — separate `StrategyPortfolioManager` instance for
  the loop; `SignalEngine` receives both callbacks;
  `TradingLoopService` wired with `portfolioManager`, `repo`,
  `strategyCooldownMs`, and `maxMarketStateAgeMs`.

### 2.3 New — signal-engine strategy runtime (`apps/signal-engine/src/runtime/strategy/`)

- `active-strategy-resolver.ts` (+ `.test.ts`) — shared resolver used
  by legacy `SignalEngine.runForSymbol` and the trading loop;
  discriminated return; best-effort `onStateError` callback.
- `strategy-context-loader.ts` (+ `.test.ts`) — loads candles +
  contract + market state by exact `conId`; fail-closed
  contract-field verification; freshness / minimum-count checks per
  timeframe; **PR15.4 r16 fail-closed market-state validation**
  (identity conid+symbol, finite `lastPrice`, finite optional `bid`
  / `ask` / `spread`, timestamp bounds); operator-safe messages, no
  raw payload leakage. **Effective minimum candle counts (§6.3)**:
  `1m` = 220 (SIGNAL_MIN_CANDLES); every higher timeframe = 50
  because `MarketRegimeDetector.scoreTimeframe` reads EMA50 on
  every higher timeframe (and the smallcap donchian strategies
  read EMA50 on `4h` for their trend filter). A context with 20–49
  bars on any higher timeframe is refused.
- `indicators.ts` (+ `.test.ts`) — extracted
  `computeIndicatorsForContext`; equivalence tested against the
  inline block in `SignalEngine.runForSymbol` (§14.10).
- `regime.ts` (+ `.test.ts`) — thin adapter over
  `MarketRegimeDetector`; equivalence tested against
  `MarketRegimeDetector.detectDetailed` (§14.10).

### 2.4 New / extended — tests

- `packages/shared/src/signal-engine/pipeline.test.ts` (new) — 5
  unit tests for the direction gate in `runSignalPipeline`.
- `packages/shared/src/trading-pipeline/attribution.test.ts` (new) —
  full `TradingPipeline` attribution integration (direction mismatch
  → ATTRIBUTION failure with Risk NOT called; direction match →
  metadata stamped, Risk called).
- `apps/signal-engine/src/runtime/strategy/active-strategy-resolver.test.ts`
  (new) — 9 unit tests: activation order, cooldown, error branch,
  callback receives raw, callback throwing does not change result.
- `apps/signal-engine/src/runtime/strategy/strategy-context-loader.test.ts`
  (new) — 41 unit tests covering the r16 fail-closed market-state
  additions (marketState conid mismatch, symbol mismatch, NaN /
  Infinity / non-numeric `lastPrice`, malformed optional `bid` /
  `ask` / `spread`, future / stale timestamps, cross-conId query
  safety) plus the §6.3 effective-minimum boundary tests: `1m` at
  219 (→ UNAVAILABLE) / 220 (→ accepted), and every higher
  timeframe (`5m`, `1h`, `4h`, `12h`, `1d`, `1w`) at 49 (→
  UNAVAILABLE) / 50 (→ accepted) to guarantee EMA50 is available
  to `MarketRegimeDetector` before a context can be accepted.
- `apps/signal-engine/src/runtime/strategy/indicators.test.ts` (new)
  — §14.10 field-by-field equivalence with inline
  `SignalEngine.runForSymbol` computation.
- `apps/signal-engine/src/runtime/strategy/regime.test.ts` (new) —
  §14.10 field-by-field equivalence with
  `MarketRegimeDetector.detectDetailed` (default and injected
  detector).
- `apps/signal-engine/src/portfolio/strategy-portfolio-manager.test.ts`
  (new) — 6 unit tests: discriminated result, `candidates`,
  deterministic sort (lanePriority ↓, confidenceScore ↓, id ↑),
  `selected === candidates[0]`, callback safety.
- `apps/signal-engine/src/signal-engine.test.ts` (new) — 5 tests:
  insufficient-candles rejection, resolver `kind:"error"` +
  `onStrategyStateError` receives raw, `onStrategyStateError`
  callback throwing does not change result, strategy
  `generateSignal` throwing produces a safe REJECTED with the
  `onStrategyError` callback receiving raw and no leak,
  `onStrategyError` callback throwing does not change result.
- `apps/signal-engine/src/repository.test.ts` (new) — 6 tests:
  `getInstrumentContractByConId` exact-`conId` SQL with **no
  symbol fallback**; null on no match;
  `getRecentCandlesForContract` uses timeframe table + WHERE
  `UPPER(symbol) = UPPER($1) AND conid = $2` and returns rows in
  ascending `ts` order; cross-conId rows excluded at DB layer;
  `syncStrategyRuntimeStates` mutex serializes two concurrent calls
  with different arguments and preserves each argument list; a
  first-sync rejection does not block subsequent syncs.
- `apps/signal-engine/src/runtime/execution/execution-runtime.test.ts`
  (extended) — 9 new PR15.4 tests: matching strategy submits with
  the strategy label as the persisted `strategy` field; empty /
  whitespace `strategyId` → `STRATEGY_ATTRIBUTION_UNAVAILABLE`;
  mismatch → `STRATEGY_ATTRIBUTION_MISMATCH`; NO_TRADE pipeline
  bypasses the attribution match; `execute()` operator path still
  labels submissions `"execution-runtime"`; **absent strategyId
  (undefined via controlled cast) → STRATEGY_ATTRIBUTION_UNAVAILABLE
  with PaperGuard/submitter zero calls**; **mismatch with paperGuard
  spy asserting zero calls**; FAILURE (stale price) pipeline →
  PIPELINE_FAILURE; `resumed` submitter kind → SUBMITTED with
  `resumed:true` and strategy label forwarded.
- `apps/signal-engine/src/runtime/runtime.test.ts` (extended) — 3
  new §14.15 tests threading attribution end-to-end via
  `MarketDataRuntime.dryRun`: match → metadata.strategyId set +
  Risk called; mismatch → FAILURE / ATTRIBUTION + Risk NOT called;
  no attribution → metadata.strategyId undefined, Risk called.
- `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts`
  (rewritten) — full PR15.4 integration fixtures (binding
  authority, loader repo, real strategies, attribution-aware fake
  `MarketDataRuntime`); the 23 §14.7 integration tests exercise
  the real path `context loader → portfolio → dryRun →
executePrepared`; the 5 §14.13 tests cover STRATEGY_CONFLICT
  and history-bound after sync failure; additional PR15.4 tests
  preserve the invariants of the removed PR15.3 skipped
  suites: idempotency-key includes `strategyId` and produces
  different keys for different strategies (3 tests), NO_TRADE and
  missing `price.observedAt` routing (2 tests), bound instrument is
  forwarded through `executePrepared` (1 test), scheduler-off
  manual `runOnce` still submits (1 test), and callback safety at
  the loop layer (2 tests).
- `apps/signal-engine/src/runtime/trading-loop/routes.test.ts`
  (rewritten fixture) — un-skipped: the three previously-skipped
  tests now use the full binding + loader + real strategy
  scaffolding and pass on the real PR15.4 path.

**Zero `describe.skip` / `it.skip` remain in any file changed by
PR15.4.**

### 2.5 Documentation

- `docs/implementation/phase2/PR15_4_PLAN.md` (r15, approved).
- `docs/implementation/phase2/PR15_4_REPORT.md` (this file).
- `docs/implementation/phase2/PHASE_2_ROADMAP.md` — added the
  PR15.4 row.

**Total: 39 files touched (24 modified + 15 new source/test/docs files).**
`git diff --stat` — +3029 / −733.

### 2.6 Confirmed unchanged

- `apps/execution-engine/**` — no code, config, migration change.
- `infra/sql/**` — no schema change, no `ALTER TABLE`.
- `packages/shared/src/instruments/**` — no seed activation.
- `apps/llm-agent/**` — untouched.

---

## 3. Coverage of Plan §14 test items (all shipped, zero skipped)

| Plan item                                                                    | Covered by                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §14.1 `runSignalPipeline` direction gate (5 tests)                           | `packages/shared/src/signal-engine/pipeline.test.ts`                                                                                                                                                                                      |
| §14.2 Full `TradingPipeline` attribution flow                                | `packages/shared/src/trading-pipeline/attribution.test.ts`                                                                                                                                                                                |
| §14.3 `SignalEngine.evaluate` metadata per status                            | `packages/shared/src/signal-engine/evaluator.test.ts` — dedicated PR15.4 §14.3 block runs the real engine + `runSignalPipeline` and asserts `metadata.strategyId === attribution.strategyId` for each of GENERATED / HOLD / BLOCKED (decision blocker + attribution direction gate) / REJECTED / ERROR, plus a case without attribution asserting `metadata.strategyId === undefined` for every status.                                                                                              |
| §14.4 Active-strategy resolver (9 tests)                                     | `apps/signal-engine/src/runtime/strategy/active-strategy-resolver.test.ts`                                                                                                                                                                |
| §14.5 StrategyContextLoader (41 tests)                                       | `apps/signal-engine/src/runtime/strategy/strategy-context-loader.test.ts`                                                                                                                                                                 |
| §14.6 ExecutionRuntime.executePrepared four-stage + operator path (24 tests) | `apps/signal-engine/src/runtime/execution/execution-runtime.test.ts`                                                                                                                                                                      |
| §14.7 TradingLoopService integration (23 tests)                              | `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts`                                                                                                                                                                |
| §14.8 Legacy `runForSymbol` narrowing + callback safety (5 tests)            | `apps/signal-engine/src/signal-engine.test.ts`                                                                                                                                                                                            |
| §14.9 Idempotency-key includes `strategyId`                                  | `apps/signal-engine/src/runtime/trading-loop/idempotency-key.test.ts` (pre-existing) + 3 new loop-level tests in `trading-loop-service.test.ts`                                                                                           |
| §14.10 Indicators / regime equivalence                                       | `apps/signal-engine/src/runtime/strategy/indicators.test.ts`, `regime.test.ts`                                                                                                                                                            |
| §14.11 Repository exact-conId + mutex serialization (6 tests)                | `apps/signal-engine/src/repository.test.ts`                                                                                                                                                                                               |
| §14.12 Callback safety in each layer                                         | Resolver test, portfolio-manager test, signal-engine test, loop test                                                                                                                                                                      |
| §14.13 STRATEGY_CONFLICT + `#trimLastOutcomes` (5 tests)                     | `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts`                                                                                                                                                                |
| §14.15 `MarketDataRuntime.dryRun` attribution threading (3 tests)            | `apps/signal-engine/src/runtime/runtime.test.ts`                                                                                                                                                                                          |
| §14.16 Gate commands                                                         | `git diff --check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` all pass locally                                                                                                                                             |

## 4. Acceptance criteria (§16)

All checkboxes in §16 of the plan are satisfied:

- Direction gate fires inside `runSignalPipeline` before Risk (spy
  verified in `pipeline.test.ts`).
- Risk Engine NOT called on direction mismatch (spy verified in
  `attribution.test.ts` and `runtime.test.ts`).
- Direction gate maps to `NOT_SUBMITTED / PIPELINE_FAILURE("ATTRIBUTION")`
  through `deriveFailedStageFromSignal` (typed check on
  `blockers.source === "attribution"`).
- Typed `SignalBlocker` with `source: "attribution"` propagated onto
  `SignalEvaluation.blockers`.
- `"ATTRIBUTION"` added to `TradingPipelineFailedStage`.
- `SignalEvaluation.metadata.strategyId` set for every status when
  attribution is provided.
- `blockers: []` added to all previously-manually-constructed
  `SignalEvaluation` fixtures.
- `syncStrategyRuntimeStates` mutex serialized inside
  `SignalRepository` (test in `repository.test.ts`).
- Concurrent sync calls NOT merged or skipped; each receives its own
  promise; a rejection does not poison the tail (both tests in
  `repository.test.ts`).
- Once-per-cycle sync in `#runCycle` (spy verified in loop test 2).
- Sync error → `#recordSkip` per selected instrument with
  `STRATEGY_STATE_SYNC_UNAVAILABLE`; message operator-safe (loop
  test 3 asserts no `SECRET-DETAIL` leak).
- `#trimLastOutcomes` helper — replaces the inline `while` loop in
  the normal path and is called from the sync-error path too;
  history-bound is asserted (loop §14.13 test 5).
- `#recordSkip` accepts any `TradingLoopSkipReason` + optional
  operator-safe `message`.
- `STRATEGY_STATE_SYNC_UNAVAILABLE` in `TradingLoopSkipReason`.
- `TradingLoopServiceOptions` gains `portfolioManager`, `repo:
StrategyRuntimeStateRepository`, `strategyCooldownMs`,
  `maxMarketStateAgeMs`.
- `StrategyRuntimeStateReader` and
  `StrategyRuntimeStateRepository` are separate ports; resolver
  depends only on `Reader`.
- `expectedDirection` validated as `"LONG"|"SHORT"` in
  `resolveInstrumentPolicy`; missing → `NOT_SUBMITTED /
INSTRUMENT_POLICY_UNAVAILABLE` (loop test 20).
- `onStateError` and `onStrategyError` callbacks best-effort;
  callback exceptions do not change the domain result (dedicated
  tests in resolver, portfolio manager, signal-engine, and loop
  suites).
- Full attribution chain (six checks) verified before dryRun; each
  branch tested (loop tests 5–10).
- All newly-introduced PR15.4 loop-owned gates return
  `kind: "SKIPPED"`.
- `STRATEGY_CONFLICT` detected from `result.candidates` directions
  before checking `selected` (loop §14.13 test 1).
- `STRATEGY_ATTRIBUTION_UNAVAILABLE` for absent / empty / whitespace
  `strategyId` (`execution-runtime.test.ts` — three dedicated
  tests).
- `STRATEGY_ATTRIBUTION_MISMATCH` for pipeline metadata disagreement
  (`execution-runtime.test.ts` — two dedicated tests).
- `EXPOSURE_DATA_CONTRADICTION` checked before policy resolution
  (loop test 19).
- Runtime pass-through for both attribution reasons (loop tests
  22–23).
- Deterministic `StrategyPortfolioManager` sort verified
  (`strategy-portfolio-manager.test.ts` + loop §14.13 test 3).
- Attribution pass-through verified in `runtime.test.ts` for the
  three §14.15 scenarios.
- `#submitFromDryRun` unchanged except for the `strategyLabel`
  parameter.

## 5. Gate results

| Gate               | Result                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git diff --check` | pass (clean, exit 0)                                                                                                                                                                                                                                      |
| `pnpm typecheck`   | pass (all 8 projects, exit 0)                                                                                                                                                                                                                             |
| `pnpm lint`        | pass (0 errors; 3 pre-existing warnings unrelated to PR15.4, exit 0)                                                                                                                                                                                      |
| `pnpm test`        | pass — **1204 tests** total (packages/shared 343; tools/paper-verify-stack 158; apps/llm-agent 1; apps/ingestion 30; apps/execution-engine 261; apps/signal-engine 411); **0 fail; 0 skipped; 0 skipped suites** across all changed PR15.4 files. Exit 0. |
| `pnpm build`       | pass (all 8 projects, exit 0)                                                                                                                                                                                                                             |

---

## 6. Hostile review (post-implementation)

Reviewed every §14 and §16 item; findings and their resolutions:

1. **`StrategyContextLoader` fail-closed market state** — the r15
   plan required fail-closed validation of the market state
   identity (conid + symbol) and numeric field finiteness. Added:
   `marketState.conid === boundConId`, `marketState.symbol ===
instrument.brokerSymbol` (after normalize), finite `lastPrice`,
   finite optional `bid`/`ask`/`spread`. All error paths surface as
   `STRATEGY_CONTEXT_UNAVAILABLE` with an operator-safe message;
   no raw payload is leaked. Coverage: 12 targeted tests in
   `strategy-context-loader.test.ts`.
2. **`if (!bound)` defensive check inside `TradingLoopService`** —
   **retained**. The check fires immediately before the loader is
   invoked so a runtime call path without a bound instrument
   cannot reach `StrategyContextLoader.load({ bound: ... })`. In
   production the loop always runs with a `bindingAuthority`, so
   this branch is a defence-in-depth guard rather than the primary
   gate. The primary binding gate is at the top of `#runInstrument`
   and covered by the existing PR15.2 binding-gate test
   ("no binding for a registry instrument → SKIPPED /
   INSTRUMENT_BINDING_UNAVAILABLE"). The defensive check does not
   duplicate that test but keeps the loader’s TypeScript contract
   (`bound: BoundInstrument`) enforced at runtime.
3. **`describe.skip` / `it.skip`** — none remain in any PR15.4-
   touched file. The removed PR15.3 tests have been rewritten
   against the new PR15.4 flow so the invariants they protected
   (idempotency-key format, NO_TRADE routing, missing
   `price.observedAt`, bound forwarded through
   `executePrepared`, scheduler-off manual `runOnce`) are all
   still exercised.
4. **`SignalRepository` mutex tail on rejection** — verified with a
   dedicated test: a rejected first sync does not block subsequent
   syncs (`repository.test.ts`).
5. **Cross-conId row exclusion at DB layer** — `getRecentCandles
ForContract` uses `WHERE UPPER(symbol) = UPPER($1) AND conid =
$2`; test asserts the WHERE clause and confirms the DB-layer
   filter path.
6. **Callback safety inside every layer** — each throw path
   (resolver `onStateError`, portfolio manager `onStrategyError`,
   signal-engine callbacks, loop wrappers) is covered by a
   dedicated test that verifies the domain result is unchanged
   when the callback throws.
7. **Operator-safe messages** — no raw error message ever appears
   in a loop outcome, ExecutionRuntime outcome, resolver result,
   or portfolio manager result. Verified structurally by tests
   that embed `SECRET-DETAIL-*` tokens in raw errors and assert
   they do not surface in `outcome.message`.
8. **`SignalRepository.getInstrumentContractByConId` — no symbol
   fallback** — test asserts SQL has `WHERE conid = $1`, no
   `UPPER(symbol)` or `OR` clause.
9. **Legacy `SignalEngine.runForSymbol` still computes indicators
   inline** — the equivalence tests (`indicators.test.ts`,
   `regime.test.ts`) exist so if a future edit changes one code
   path but not the other, the drift will be caught.
10. **`ExecutionRuntime.executePrepared` runtime cast test** — the
    `absent strategyId (undefined via cast)` test forces the
    runtime path to reach the fail-closed check even though the
    type system enforces the field, validating that a hostile
    caller cannot bypass the guard at runtime.

## 7. Remaining risks

- **Legacy `SignalEngine.runForSymbol` still computes indicators
  inline.** The extracted helpers in `runtime/strategy/` are used
  only by the new `StrategyContextLoader` (i.e. the PR15.4
  trading-loop path). The legacy pipeline in `SignalEngine.runForSymbol`
  continues to inline the same computation, which is protected by
  the equivalence tests (`indicators.test.ts`, `regime.test.ts`)
  so drift is caught, but not by a single shared implementation.
  Merging the two computation paths is an incremental follow-up
  outside PR15.4 scope.
- **`§14.7` fake pipeline** models three failure stages
  (`SIGNAL`, `RISK`, `ATTRIBUTION`) — anything else that a future
  real `TradingPipeline` may emit is not exercised by the loop
  tests. The direction gate itself is separately end-to-end tested
  via `runtime.test.ts` (§14.15) and the shared
  `attribution.test.ts` (§14.2) which use the real
  `TradingPipeline`.
- Otherwise: all §14 items shipped with direct tests; all §16
  acceptance criteria have direct test coverage documented above;
  all five gates pass; zero skipped tests.

## 8. Rollback

Follows plan §17. Reverting the PR reverts the loop to the
pre-PR15.4 behavior where `STRATEGY_POLICY_MISMATCH` fires
whenever `metadata.strategyId` is `undefined` (which without the
PR15.4 attribution threading is always the case in production).
Time: < 5 minutes. No migration to undo. No execution-engine or
registry-seed change to revert.
