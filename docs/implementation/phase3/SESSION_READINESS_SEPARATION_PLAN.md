# Historical readiness and current session availability

Date: 2026-11-04. Status: ACCEPTED by independent `session_readiness_plan_review`
(`gpt-6-astra`, high), after one review repair round; no remaining blockers.
Implementation route: `gpt-6-astra`, high; distinct Astra/high plan and final
reviewers. The lead owns publication, full validation and authorized Paper rollout.

## Evidence and bounded outcome

Follow [continuous operation](CONTINUOUS_PAPER_OPERATION_PLAN.md) and
[automatic recovery](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md). On November 4 at
14:20 UTC, the AAPL historical SCHEDULE response ended November 3 at 21:00 UTC.
Its history preparation was COMPLETE, while all warmup timeframes reported
WAITING / `session_schedule_coverage_missing`. The adapter also supplies validated
current contract hours: these can establish that the market is closed before its
opening without extending the historical SCHEDULE envelope.

At 14:38:59 UTC, fresh runtime observation established that the existing ordinary
14:30:06 UTC fetch had obtained the November 4 session ending at 21:00 UTC.
AAPL 1m was READY at 14:38:05 UTC with the 14:37 candle and 230 bars; PKO was also
READY. Thus opening refresh already works. This package corrects the pre-open
historical/current readiness distinction and adds regression coverage; it does
not replace that recovery mechanism or claim a demonstrated opening outage.

`requireSessionHistorySchedule` already validates historical preparation, whereas
`requireSessionSchedule` additionally requires coverage through now. Two callers
currently conflate these questions: `classifySessionAvailability.historyReady`
uses the strict helper because the runtime relies on it for close-crossing error
classification; that semantics must stay unchanged. `evaluateSessionCandles`
calls the strict helper before determining that the current session is closed.

## Contract and changes

1. Keep `requireSessionSchedule`, `requireSessionHistorySchedule`, historical
   envelope/weekly-slot rules, parsers, timestamp/identity/generation validation
   and the existing Monday PARTIAL contract unchanged. Historical completeness
   means the existing history preparation contract, not proof of trading readiness
   or that every requested candle has arrived.
2. Keep `classifySessionAvailability`, including `historyReady`, unchanged.
   Despite its name, this flag proves strict current coverage for the configured
   runtime's close-crossing error recheck. Broadening it could disguise a
   pre-existing missing-current-coverage error as a later normal close. Warmup's
   existing `historyCoverage` expresses historical completeness separately; add
   no new readiness flag. Current hours cannot repair historical gaps. Invalid,
   stale, future or wrong-identity evidence cannot use the new CLOSED path.
3. `evaluateSessionCandles` may use historical-only coverage when current
   availability is positively CLOSED and historical validation succeeds. It still
   validates and filters native candles against the real historical schedule and
   returns `session_closed`, with real latest/expected metadata. Insufficient
   history remains unavailable, Monday PARTIAL stays partial, invalid candle
   identity/values remain rejected, and an UNKNOWN session does not take this path.
   If CLOSED current hours contradict an explicitly active historical interval,
   return `session_schedule_hours_conflict` instead of masking it as normal closed
   waiting. No adapter/parser redesign or new hours fallback is included.
   OPEN retains the exact strict current-coverage and active-minute evaluation
   path. No hours are appended to historical sessions and no bounds are extended.
4. Preserve `SessionScheduleRefresh` and `SessionNativeRefresh` production control
   flow, including one-minute retry floors, existing opening/hourly refresh,
   account-wide pacing, single-flight work, reconnect invalidation and generation
   fencing. Add tests demonstrating automatic pre-open-to-open recovery with
   schedule evidence ending yesterday, no manual restart, missing-current-minute
   waiting, and readiness only after the real schedule and required native bars
   exist. Persistent missing current coverage remains a hold with ordinary retries.

## Cross-service implications and file ownership

Production edit scope: `packages/shared/src/instrument-sessions.ts` only.
Test scope:

- `packages/shared/src/instrument-session-hours.test.ts`
- `packages/shared/src/instrument-sessions.test.ts`
- `apps/ingestion/src/session-schedule-refresh.test.ts`
- `apps/ingestion/src/session-native-refresh.test.ts`
- `apps/signal-engine/src/runtime/strategy/configured-strategy-runtime.test.ts`
- `apps/signal-engine/src/runtime/strategy/strategy-context-loader.test.ts`
- `apps/execution-engine/src/session-entry-guard.test.ts`

Documentation scope: this plan and `SESSION_READINESS_SEPARATION_REPORT.md`.
The lead exclusively owns the report, `docs/runbooks/INSTRUMENT_SESSION_READINESS.md`,
and `tools/paper-verify-stack/src/paper-runtime.ts` plus its `.test.ts`. The lead
adds one Polish reason mapping for `session_closed`: “rynek zamknięty — oczekiwanie
na kolejną sesję”, which covers pre-open and other closed periods. The runbook
explains the separated evidence, without calling incomplete candle counts ready.
Only necessary test files need edits. Read other callers to verify compatibility.

The configured strategy runtime already skips CLOSED before state/evaluation;
its coverage-error recheck uses unchanged strict historyReady. An initial OPEN
with historical-only coverage must remain a context error even if loading crosses
the real close with identical evidence. Context loader initial
and final strict schedule checks are unchanged. Execution entry guard,
`checkSessionWindow`, stock execution preflight, lifecycle exit derivation/observer
and diagnostics retain their existing strict helper. None gains write permission,
extended exit deadlines or a new source of active-session evidence.

Preserve dirty `apps/signal-engine/src/signal-engine.ts`, all backtest/ES files,
`.local`, and `AUTOMATIC_PAPER_STARTUP_RECOVERY_REPORT.md`. No schema/configuration
change, migration, broker/provider call, publication, deployment, new strategy,
instrument branch, bar fabrication or risk/AI/proposal change is authorized to
the implementation worker. Escalate any need to change production ingestion or
signal/execution callers for a reviewed plan amendment before editing them.

## Acceptance and hostile cases

1. AAPL November 4 pre-open fixture, PKO with Warsaw hours, and a third synthetic
   stock: valid complete historical evidence ending before now plus explicit
   current CLOSED hours yields `historyReady: false`, `session_closed` assessment,
   and measured warmup WAITING with history COMPLETE. No strategy evaluates or
   entry guard passes. Historical coverageEnd/sessions remain byte-identical.
2. Opening: current hours OPEN but unchanged prior-session historical envelope
   still rejects evaluation and entry. Ordinary scheduled refresh obtains the
   current broker SCHEDULE; previous-session minutes cannot satisfy active-minute
   readiness. First current closed minute plus required history permits normal
   assessment; counts, expected-slot/grace rules and strategy conditions remain.
3. Preserve explicit holiday/weekend/split-session close and DST local-date
   semantics. Stale/future/FAILED/REFRESHING/generation/identity/mode/timezone,
   missing current date, malformed/null currentHours and missing historical
   coverage cannot become ready. Malformed candles cannot hide behind CLOSED.
   CLOSED hours with an active historical interval produce an explicit conflict.
4. Monday PARTIAL never becomes historyReady COMPLETE; weekly coverage and counts
   are not invented. Existing partial and old-callback tests continue passing.
5. Schedule retries remain single-flight and paced, failures continue retrying,
   reconnect fences old callbacks. The pre-open fixture automatically progresses
   through open/missing-minute/current-minute states without test row repair.
6. Strategy runtime remains skipped before open; OPEN plus missing coverage is
   a context error even though historical preparation is COMPLETE, including an
   exact unchanged-evidence OPEN-to-CLOSED crossing during load. Strict execution
   entry/window/exit and stock preflight regressions continue passing.

## Validation and delivery

After independent plan acceptance, implement and run focused native Node tests
for the shared session helpers, ingestion schedule/native refresh, strategy
runtime/context loader and execution session guard. Build shared first so consumer
tests execute the changed package. Report actual commands and exits; no external
broker calls or operational database fixtures.

The lead runs `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` against isolated PostgreSQL, and `pnpm build`; obtains a
different independent hostile implementation review; writes the report; performs
the required clean Docker build for rollout; then commits/pushes reviewed scope
on main and verifies CI for that exact SHA. Strategy/simulator behavior is unchanged,
so no new strategy tuning/backtest is required. Authorized Paper rollout and fresh
runtime readiness are separate acceptance evidence, never inferred from unit tests.

Record requested/actual model and effort, review findings, repairs/escalations,
elapsed time and available usage in the report. Unavailable tokens remain
`unavailable`. Do not call release complete with failed checks or unverified CI.
