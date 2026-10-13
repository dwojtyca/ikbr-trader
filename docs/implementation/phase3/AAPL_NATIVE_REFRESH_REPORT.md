# AAPL native refresh cadence — evidence

Date: 2026-10-13. Contract: [accepted plan](AAPL_NATIVE_REFRESH_PLAN.md).
Status: implementation accepted; required local checks and clean Docker build passed.

## Diagnosis

Read-only deployed-loader observation on c1fdc6b at 13:47:00–08 UTC returned
STRATEGY_CONTEXT_UNAVAILABLE with original message session_expected_candle_missing.
The expected closed minute was13:46 and persisted latest13:44, with session OPEN.
At13:47:11 the latest was13:46 and loading succeeded. The same failure recurred
at13:49:00. No broker/provider request or strategy/order invocation was added by
this probe: it used existing PostgreSQL/Redis data, PostgreSQL read-only transactions,
and the deployed StrategyContextLoader.

Independent fake-clock reproduction used two instruments and300ms first-fetch
latency. AAPL requested13:41:09.300 and13:43:09.300, skipping13:42:09 and13:44:09.
Each cycle finished in under1s. Rotation moves AAPL second-to-first, so the next
check is59.7s later and the previous strict60s condition skips an entire poll.
This explains an application scheduling error rather than a closed exchange,
broker calendar fault or need to loosen candle freshness.

## Implementation and invariants

The refresh records the expected closed slot and successful acquisition completion.
A new slot can be acquired before60s only after validated successful acquisition,
sufficient persisted warmup and15s since completion. Failure, empty/invalid/missing
bars retain conservative60s retry limits. Shared broker pacing, capacity, fairness,
singleflight, generation checks and candle source/identity/finality stay intact.
Configured evaluation now keeps the original loader/session detail below its stable
primary reason, sanitized before raw logging and persisted diagnostic recording.
Strategy formulas, scheduling concurrency, risk/research/AI and orders are unchanged.

## Routing, review and validation

- Read-only reproduction and bounded ingestion implementation: requested
  gpt-6-sol/medium (`aapl_diagnosis`), under lead-owned semantics.
- Independent plan reviewer: requested gpt-6-astra/high (`aapl_plan_review`).
  ACCEPT after one repair clarifying completion timing, clock-regression throttle,
  warmup success and secret sourcing. Two review rounds, no escalation.
- Signal diagnostics and integration: capable lead.
- Different independent final reviewer: requested gpt-6-astra/high
  (`aapl_final_review`). Review identified stale pre-read time used as the
  request timestamp: a slow read could shorten failure backoff, and a clock
  changing during the read could reach fetch. Repair resamples/revalidates time
  and schedule after the read, with slow-read and invalid/backward-clock tests.
  Same-slot suppression after15s, concurrent singleflight and post-persistence
  generation-race/backoff tests were added. The lead corrected the slow-read
  regression to use an empty resolved acquisition rather than a thrown fetch,
  ensuring it detects the original timestamp bug. Final source ACCEPT; reviewer
  independently passed38 diagnostic/runtime tests and17 ingestion tests. One
  production repair round plus strengthened test evidence; no open findings.
- Diagnostic/runtime focused tests:38 passed,0 failed/skipped.
- Ingestion regression/hostile tests:17 passed,0 failed/skipped; scoped
  ingestion typecheck and diff check passed.
- Full integration on isolated PostgreSQL loopback55432:2596 passed,0 failed
  or skipped; full build exit0. Initial lint/typecheck/unit also passed but
  overlapped the timing repair. Settled-source lint/typecheck and complete unit
  rerun passed:3488 tests,3293 passed,195 skipped,0 failed. Integration reached
  the changed ingestion/signal suites after their final freeze.
  Lint has two pre-existing unused-disable warnings.
- Clean Docker build with `--no-cache` passed from HEAD plus only the eight
  reviewed files. Ignored secrets/backups and unrelated dirty work were excluded.
  Image-local focused tests with network disabled passed:17 ingestion and38
  runtime/diagnostic tests,0 failures/skips.
- Reviewed publication and exact-commit CI remain pending at this source-report
  freeze. The final image includes the settled report; immutable publication,
  CI and deployment receipts belong in the private deployment record and operator
  delivery message. No strategy/simulator change requires a new backtest.

Actual provider model/effort telemetry and token usage are unavailable. Elapsed
review/worker time is unavailable unless separately reported. No operational
repair or broker round trip is proven by source tests. No destructive fixture uses
the operational database. Unrelated dirty backtest and signal-engine.ts work is
excluded from the publication and deployment scope.
