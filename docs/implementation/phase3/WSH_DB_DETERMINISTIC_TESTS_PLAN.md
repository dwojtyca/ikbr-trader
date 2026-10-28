# Deterministic WSH database deadline tests

Date: 2026-10-28. Status: accepted by independent
`wsh_diagnostics_plan_review` (`gpt-6-astra`/`high`) after one clarification of
the native event-loop checkpoint for late promise continuations.
Implementation and independent hostile final review are accepted; full
validation and publication evidence are tracked in the package report.
Follow-up to published research-recovery diagnostics commit `4af8830` and its
[plan](RESEARCH_RECOVERY_DIAGNOSTICS_PLAN.md). Follow the existing
[roadmap](../ROADMAP.md); this is validation repair, not a new delivery phase.

## Evidence and outcome

The exact Linux image `ikbr-research-diagnostics:4af8830`, Node 24.20.0, passed all
40 focused diagnostics tests. One subsequent `CI=true pnpm test` run without
network access or `TEST_POSTGRES_URL` failed in the shared package: 796 tests,
697 passed, 96 skipped, three failed. The retained local log is
`/private/tmp/ikbr-exact-4af8830-unit-linux.log`.

Two tests in `wsh-db.test.ts` unexpectedly expired during their initial query:
the cumulative 50 ms operation test and the 25 ms attempt test. The 20 ms
connection-handoff rollback test later expected releases `[true]` but observed
`[]`. That last assertion alone does not establish whether admission expired
before acquisition or a continuation was delayed. The suite used real timers,
real monotonic time and very small successful-work margins; those margins cannot
be guaranteed under scheduler load. This proposal replaces the test scheduler
assumptions with explicit clock and promise ordering. It does not change the
production deadline contract or infer a production defect from those assertions.

GitHub CI for `4af8830` also failed its unit-test step, but its detailed log was
unavailable. The local failures are **not established as the GitHub cause**.

## Scope and invariants

Allowed changes are only:

- `packages/shared/src/instrument-research/wsh-db.test.ts`.
- This plan and `WSH_DB_DETERMINISTIC_TESTS_REPORT.md` in this directory.

No production file, dependency, Node constraint, CI setting, test-runner
concurrency, timeout, default, error code or database schema changes. No retries,
skips, removed tests, widened successful-work deadlines or relaxed assertions.
In particular `wsh-db.ts` and `store.ts` remain byte-identical. No operational DB,
broker, provider or recovery action is part of implementation or tests.

Keep all existing tests and their deadline, monotonic-budget, wall-clock rollback,
late-cleanup and no-continuation invariants. Convert all timing-sensitive cases
in this one file, including currently passing neighbours, because they share the
same real-time fixture assumption. Preserve the existing positive/expired
current-attempt API coverage. Do not build a shared clock framework.

## Test clock and asynchronous contract

Use Node's existing test mocks in a small file-local fixture:

1. Import the same `performance` object from `node:perf_hooks` used by production.
   Mock `performance.now()` with a controlled monotonic millisecond value.
2. Enable `t.mock.timers` for `setTimeout` only. All production deadline timers
   remain the actual unchanged timer calls, routed through Node's test scheduler.
   Never mock the production functions, deadline predicates or timeout errors.
3. Mock `Date.now()` to a fixed wall time where sampled. For rollback tests retain
   the existing counted rollback schedule: minus 60000 ms at the third read for
   connection/legacy handoff or fifth read for query handoff. Assert exactly one
   wall read. Monotonic advancement must never move wall time backward or renew a
   ticket budget. Construct wall-based fixture dates from the fixed wall value;
   do not depend on unmocked `new Date()` for relevant deadlines.
4. `advance(ms)` first increments the controlled monotonic value, then ticks
   mock timers by the identical nonnegative amount. Use explicit deadline steps
   (for example 19 ms then 1 ms), not one large tick hiding intermediate states.
5. Replace real `node:timers/promises` sleeps with file-local deferred promises
   for pool acquisition and raw-query completion. Expose explicit phase signals
   for acquisition started, statement-timeout setup entered and business-query
   issued. Await a phase signal before moving time or resolving its completion.
   Attach rejection observations before advancing timers to prevent unhandled
   rejection races.
6. Await explicit operation/phase completion after resolving a deferred. Do not
   use real sleeps, polling, arbitrary counts of microtask flushes or a test
   timeout as evidence that a continuation happened. A narrowly scoped promise
   completion signal may observe a controlled fake dependency; it must not
   replace the production result/assertion. Observe late acquisition cleanup
   through its raw release signal. For a late raw setup result whose wrapper
   already rejected, use one documented `setImmediate` event-loop checkpoint
   after resolving the deferred: its finite promise continuation chain drains
   before the next event-loop phase. No further timer or external work exists
   in that chain. Assert forbidden-query/release counts after this checkpoint;
   logical clocks stay frozen and no CPU-duration threshold is asserted.
7. Tests stay sequential within their file; mocks are restored/reset through
   the test context even on assertion failure. Deferred work must be settled and
   observed before reset so it cannot leak into the next test. Perform dynamic
   module imports before activating the fake scheduler.

A standalone Node 24.4.1 probe confirmed that native `mock.method(performance,
'now', ...)` and mocked `setTimeout` can advance together. That probe is tooling
evidence only; the complete fixture still requires focused Linux validation.

## Exact scenario equivalence

| Existing scenario | Deterministic script and required assertions |
| --- | --- |
| Late pool connection | Keep 20 ms acquisition budget. Confirm acquisition started. At 19 ms no rejection/release; at 20 ms timeout is observed with no query. Deliver raw connection at logical 70 ms and await its release signal: exactly `[true]`, zero queries, no second release. |
| Cumulative operation deadline | Keep 50 ms operation budget and two logical 35 ms raw business queries. Issue first at 0, resolve it at 35 and assert success. Issue second at 35; at 49 it remains pending, at 50 it times out and destroys once. A third query rejects without reaching raw query. Resolve second at 70 and observe its completion; exactly two business writes and one destructive release, with no revival of the failed wrapper. Statement-timeout values reflect the remaining original budget. |
| Attempt spans transactions | Keep original 25 ms attempt. Complete first operation while logical time is 0, end it, then advance to 35. Beginning another operation cannot refresh the attempt. Later query rejects before raw work; assert only first business query occurred and exactly one destructive release after explicit destroy. |
| Late COMMIT prevention | Keep 15 ms operation. Hold raw `set_config` completion; at 15 observe timeout/destruction. Complete setup at logical 60 and observe the continuation: COMMIT count remains zero and destruction is not duplicated. |
| Expired terminal resolution | Freeze clocks and preserve already-expired ticket. Assert no connection/query. No timer advancement is needed. |
| Separate-connection APIs, expired/positive budget | Seed original monotonic budget at minus 1 or plus 1000 ms, as today. Freeze logical time while each immediate fake operation completes. Preserve four successful connection checks and every expired rejection/no-query check. Do not renew the stored ticket deadline between APIs. |
| Rollback at connection handoff | Seed exactly 20 ms remaining, retain counted wall rollback and one-read assertion. Confirm pool acquisition was actually started. At 19 still pending and unconnected; at 20 timeout with `connected=false`. Deliver connection at logical 80; await destructive release, assert exactly one release and zero queries. |
| Rollback at query handoff | Seed exactly 20 ms remaining, retain counted rollback/one-read assertion. Complete pool connection without time advancement, hold the first raw statement-timeout query. At 19 still pending; at 20 timeout and one destructive release. Resolve raw setup at logical 80; no business query may follow, total raw queries stays one. |
| Legacy wall deadline conversion | Keep fixed wall deadline +20 ms and counted rollback schedule. Complete acquisition at logical 0. Hold raw setup, assert pending at 19 and timeout at 20, then resolve setup at 80. Exactly one wall read, one raw query, one destructive release. |

The old `<200 ms` real elapsed assertions in rollback/legacy cases are replaced
by stronger deterministic assertions: unresolved at logical 19 ms and rejected
at exactly the original 20 ms boundary, while the fake dependency is still held.
This preserves bounded completion and excludes a renewed 60-second allowance;
it deliberately does not assert host CPU scheduling latency. The initial-query
success, late-result cleanup and forbidden-continuation assertions are retained
or made explicit rather than discarded to make the suite pass.

## Acceptance and validation

Independent Astra/high plan acceptance precedes implementation. A different
independent Astra/high agent reviews the resulting test contract and hostile
cases. Escalate if faithful scheduling requires a production seam/change or
test weakening; amend and re-review rather than improvising.

After implementation:

- Run the entire `wsh-db.test.ts` file on host Node 24 and in a clean exact-source
  Linux Docker build. Include a bounded repeated focused run (three runs) to
  check mock cleanup; do not retry a failing run until evidence is understood.
- Run existing 40 recovery diagnostics tests to retain the package evidence.
- Run required `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:integration` against isolated PostgreSQL and `pnpm build`.
- Validate clean Docker build and full Linux unit run with normal configured
  concurrency; no reduced-load test configuration is the acceptance substitute.
- Inspect scoped diff and confirm production files unchanged. Record exact
  commands, exits, all initial failures, test counts and limitations in report.
- Scoped commit/push on main and verify GitHub CI for that exact commit. If CI
  still fails or logs remain inaccessible, report that explicitly; local passing
  checks do not establish CI success or operational readiness.

No strategy/simulator behavior changes, so no new strategy backtests are
required. Record requested/actual model and effort, independent review findings,
repair counts, elapsed time and token usage when available (otherwise
`unavailable`) in the report. No implementation or successful publication is
claimed by this proposed plan.
