# Native refresh cadence and context diagnostics

Date: 2026-10-13. Baseline: c1fdc6b325022da408240e05cec0a60fceda3b5b.
Scope: owner-requested debugging/repair of intermittent AAPL context failures.

## Evidence and cause

A read-only probe of the deployed loader at 13:47:00–08 UTC returned
STRATEGY_CONTEXT_UNAVAILABLE / session_expected_candle_missing: expected 1m
13:46, latest 13:44. At 13:47:11 it succeeded with latest 13:46. Session was
OPEN throughout. No strategy evaluation, broker request or order was triggered
by the probe. Independently reproduced with two instruments, 60s timer ticks
and 300ms first-request latency: rotating second to first means the next check
is only 59.7s after the previous request; the strict 60s throttle skips a whole
poll. No long-running refresh is necessary. Runtime also drops loader.message.

## Bounded implementation contract

1. In SessionNativeRefresh retain current sequential/singleflight refresh,
   rotating fairness, capacity2, historical pacing and all schedule-generation,
   contract/source and closed-bar validation. Do not change freshness gates,
   strategy formulas, scheduler concurrency, research/risk or order flow.
2. Replace request-time-only throttle with recorded attempt metadata per existing
   identity/timeframe key: attempt timestamp, successful completion/readback timestamp, expected closed-slot
   end and success flag.
   Ordinary retry remains at least60000ms after previous attempt. Only a successful
   previous acquisition may fetch sooner when a strictly newer expected closed
   slot exists, time is monotonic and at least15000ms has elapsed since successful completion
   and readback (not request start). The15s completion floor applies to every subsequent request after success,
   including the ordinary60s branch after a slow acquisition. No duplicate
   rapid requests for the same slot, no early retries after errors/empty or invalid
   acquisitions. Success requires fetched closed validated bars containing the
   requested expected slot and generation unchanged after persistence/readback;
   post-readback required warmup count must also be satisfied. Mere resolved fetch
   is insufficient. Missing expected slot or warmup-only work
   retains60s retries. Clock regression never makes an attempt eligible early.
   Record before await fetch and update success only after final validation. Catch
   remains conservative (timestamp=max(previous finite attempt time, current finite
   time), no success). Reject nonfinite clock before fetch. A backwards catch
   clock must never reduce the prior throttle timestamp. Shared50/10min acquisition
   remains authoritative; no bypass or extra direct broker call.
3. Keep primary configured runtime reason codes stable; add bounded sanitized
   diagnostic detail as a second reasons item for loader errors and session
   precheck/recheck failures. Preserve loader.message and specific availability
   reason; use deterministic details for invalid timestamps/changed evidence.
   Use existing safeDiagnosticText with known account and environment secrets at
   runtime boundary, before any raw logger; recorder sanitization remains in place.
   Add optional diagnosticSecrets runtime option; index.ts supplies the same
   nonempty TOKEN|SECRET|PASSWORD|API_KEY|CHAT_ID environment values already used
   by DiagnosticLoopRecorder. Include plain and percent-encoded values for redaction.
   Do not change control decisions or convert unavailable data to NO_SIGNAL.
4. No unrelated broker366/2100 cleanup, schema/migration, strategy thresholds,
   history-source substitution, or market-data freshness relaxations.

## Acceptance and hostile checks

- Two rotating instruments with300ms acquisition latency and60s timer ticks
  acquire each newly due1m slot on consecutive cycles; replay old predicate to
  establish regression. Verify context freshness stays acceptable before nextpoll.
- Same slot, <15s new slot, failed/empty/missing target acquisition, changed
  generation, backwards clock (including catch during regression and recovery)
  and insufficient warmup remain rate-limited;
  retry permitted after60s. Multiple callers still singleflight; capacity retained.
- Loader specific message survives configured evaluation, durable diagnostics and
  console; primary code unchanged. Session UNKNOWN/recheck failures include detail.
  Secret/account/control-character samples sanitized before raw logger and sink.
- Existing closed-session skip, candle identity and generation tests pass.
- Required lint, typecheck, unit, isolated PostgreSQL integration and build.
  Clean scoped Docker build. No backtest needed: no strategy/simulator change.
- Independent Astra high plan review before implementation, different independent
  Astra high final review. Read-only diagnosis used Sol medium. Lead owns semantics;
  bounded cadence implementation delegated only after plan acceptance.
- Report, scoped commit/push main and exact-commit GitHub CI. Preserve unrelated
  dirty backtest and signal-engine.ts files. Do not claim operational repair until
  deployed evidence exists; deployment uses existing authorized continuousPaper
  runbook, pinned reviewed source and normal startup gates, never forced signals.

## File scope and delivery

apps/ingestion/src/session-native-refresh.ts and .test.ts;
apps/signal-engine/src/runtime/strategy/configured-strategy-runtime.ts and .test.ts;
apps/signal-engine/src/runtime/trading-loop/diagnostics.test.ts;
apps/signal-engine/src/index.ts (diagnosticSecrets wiring only); this plan and report.
Expand/review plan first if scope/semantics change. No operational DB test fixtures.
Record requested/actual models, review findings/repair count, elapsed time and
available token usage (unavailable if not provided).
