# Startup session recovery: bounded partial history preparation

Date: 2026-10-19. Status: ACCEPTED for implementation by independent reviewer startup_plan_review on 2026-10-19 (requested gpt-6-astra/high). Actual model/effort telemetry unavailable.
Parent: [startup recovery plan](PAPER_STARTUP_DATA_RECOVERY_PLAN.md).
This amendment covers session-calendar preparation only. Existing owner authorization
covers implementation after independent acceptance; it grants no new trading authority.

## Observed failure

The lead observed one response from the existing normal, paced ingestion request
using a temporary non-pausing inspector logpoint; the breakpoint and inspector
were removed afterward. No competing history request was issued.

- Instrument: configured AAPL/NASDAQ stock, RTH, America/New_York.
- Request: endDateTime empty, duration `14 D`, bar size `1 day`, whatToShow `SCHEDULE`.
- requestedAt: `2026-10-19T07:23:42.887Z`; observed response: `2026-10-19T07:23:43.347Z`.
- Broker timezone: `US/Eastern`.
- Raw coverage: `20260929-09:30:00` through `20261016-16:00:00`.
- 14 sessions; first reference date 2026-09-29, last 2026-10-16.
- Parsed coverage: `2026-09-29T13:30:00.000Z` through `2026-10-16T20:00:00.000Z`.
- Monday history validation requires start no later than `2026-10-11T04:00:00.000Z`
  and end no earlier than `2026-10-19T04:00:00.000Z`. Only the end test fails.

This establishes a recent completed-session response whose envelope stops at
Friday while the request occurs on Monday before opening. It does not establish
missing market-data entitlement, malformed identity, or the absence of all
possible sessions in the uncovered weekend. Existing persisted FAILED evidence
can retain an older successful response and is not the rejected response above.

PKO independently became READY at 09:00:43 Warsaw, generation 3478, with coverage
2026-09-30T07:00Z through 2026-10-19T15:05Z. That observation supports retaining the
normal opening refresh; it is not a promise about future responses or AAPL.

## Fixed safety contract

Do not modify broker request parameters, add requests, invent sessions or extend
coverage. Preserve the existing identity/mode/timezone, freshness and generation
checks; the serialized adapter, 60-second retry floor, shared pacing, two-instrument
capacity and fair rotation remain unchanged.

`requireSessionHistorySchedule`, `requireSessionSchedule`, `checkSessionWindow`,
`sessionCandleSlots`, `filterClosedSessionCandles`, `evaluateSessionCandles` and
`classifySessionAvailability` retain their existing acceptance and finality semantics.
In particular, the last weekly period remains unavailable until its following
Monday is inside authoritative SCHEDULE coverage. `currentHours` cannot fill the
uncovered historical gap. Existing `historyReady` in session availability retains
its current-time-coverage meaning.

The correction permits useful **partial preparation** while retaining explicit
incomplete-history status. It does not make all six timeframes or an entry ready.
The normal timer completes strict history and weekly preparation when authoritative
coverage becomes available. A holiday can legitimately prolong that wait.

## Pure preparation classifier

Add one shared pure helper, `classifySessionHistoryPreparation(evidence, identity,
nowMs)`, returning a discriminated result:

- `COMPLETE`: existing `requireSessionHistorySchedule` succeeds; return its schedule.
- `PARTIAL`: all conditions below hold; return the unchanged schedule.
- `UNAVAILABLE`: return the original controlled rejection reason; no schedule.

PARTIAL is allowed only when the existing history validator rejected specifically
`session_schedule_coverage_missing`, and:

1. Existing evidence status/generation, schedule identity/envelope, canonical
   timestamps and six-hour freshness checks have already passed. No other error
   is converted to PARTIAL.
2. The schedule start satisfies the original previous-Sunday bound. Its end is
   before current Monday but at or after the previous Monday in the instrument's
   local timezone. This is a bounded recent partial envelope, not arbitrary old
   history. Use local-date arithmetic, not fixed 24-hour subtraction across DST.
3. `classifySessionAvailability` returns CLOSED using present, valid, fresh
   `currentHours` for the current local date. Missing hours, UNKNOWN, OPEN, wrong
   identity, malformed/overlapping hours or timestamp errors do not qualify.

The helper must not call itself indirectly: existing strict validators remain
unchanged. A pure boundary helper may share date calculations with strict history
validation only if their exact values and rejection behavior remain unchanged.
COMPLETE preserves existing after-hours prewarming support independently of hours.

No inference of weekend/holiday closure is made. CLOSED proves only the current
market state; partial history is explicitly incomplete. The age bound is solely
a preparation bound and never authorizes entry or the newest weekly candle.

## Refresh and persistence transitions

`SessionScheduleRefresh` accepts COMPLETE or PARTIAL for generation-fenced storage.
It rejects UNAVAILABLE through the existing FAILED finish. Persisted READY retains
its existing meaning of a successfully validated calendar object; a new database
status or migration is unnecessary. All strict downstream validators still reject
PARTIAL history for evaluation or execution.

The coordinator's additive presentation status distinguishes COMPLETE and PARTIAL
from FETCHING, FAILED and SUPERSEDED. A rejected or superseded generation must never
be reported as current COMPLETE/PARTIAL. `invalidate()` clears or supersedes local
presentation evidence. DB read/write failure remains unavailable, not retained
success. Partial success clears only the old fetch error; incompleteness remains
visible as `session_history_partial` and does not disappear from diagnostics.

The due calculation remains conservative: PARTIAL has coverageEnd before now and
therefore is due through the ordinary minimum 60-second schedule interval. No new
retry loop, bypassed pacing, new client ID or endpoint is introduced.

## Native warmup transitions

For COMPLETE, preserve existing behavior for all six timeframes.

For PARTIAL, permit the existing native fetch/read/filter/persist flow only for
1m, 5m, 1h, 4h and 1d, using the unmodified returned sessions and filters. This
preloads genuine closed bars; it does not mark candle freshness or warmup readiness
as complete. Existing minimum counts are unchanged. Final evidence must still have
the same generation and qualify for preparation after each fetch and before status
publication. A mode change, invalidation, clock regression or concurrent refresh
still fails closed.

For 1w, retain the existing strict history check **before fetching or accepting
weekly data**. A PARTIAL result yields a distinct WAITING state with
`session_weekly_coverage_pending`; it makes no weekly broker request and does not
claim zero stored history. Existing rows remain untouched. No rejected row is
silently discarded to make a count pass.

A historical fetch during PARTIAL remains an unsuccessful readiness attempt under
the existing retry accounting. Do not change its success condition, retry floors
or expected-slot provenance. Once COMPLETE appears, the ordinary next run performs
strict checks and fills any remaining data; it does not reuse a partial readiness
claim. Reopening still requires the first actual closed current-interval minute.

## Additive diagnostic fields

Preserve existing health/progress fields and their types, including bootstrapped,
legacy warmup counters, scheduleStatus and error. Add to each warmup result:

- `preparationState`: READY, WAITING or HOLD.
- `historyCoverage`: COMPLETE, PARTIAL or UNAVAILABLE.
- `countsMeasured`: boolean; false when calendar checks prevented the DB/filter read.
- `nextCheckAt`: earliest ordinary check time, not a guaranteed broker completion.
- `preparationReason`: a controlled reason when not READY.

Legacy zero counters with countsMeasured=false mean unmeasured, not an empty DB.
READY requires existing full native-count and strict session evaluation success.
PARTIAL always produces WAITING, even if all five measured counts exceed minima.
Weekly pending is WAITING. Noncoverage validation errors remain HOLD/FAILED with
the original reason; missing/unknown current market evidence is never CLOSED.

Expose additive `sessionScheduleDiagnostics` beside existing
`sessionScheduleErrors`, containing identity, generation, last attempt/completion,
nextCheckAt, preparation status, reason, parsed coverageStart/End, requestedAt,
receivedAt, session count and first/last reference dates, plus required previous-
Sunday/current-Monday bounds. Absent response fields remain absent; never substitute
retained prior DB evidence. No raw sessions, contracts, account IDs or provider
payloads are logged. Use existing sanitized source-error helpers where available;
never fabricate unavailable provider details. No diagnostic field grants authority.

The broader startup package consumes these fields for transport/bootstrap/calendar/
warmup/research messages. It must not claim READY from bootstrapped alone, nor wait
for AAPL's market opening before independently preparing PKO. Account pause/resume,
revision fencing, research eligibility and per-entry checks remain under the parent
contract. A successful account resume is not a claim that both instruments can trade
at that moment. Integration must not add a global both-markets-open gate.

## Permitted files and actions

Shared helper and tests: `packages/shared/src/instrument-sessions.ts`,
`packages/shared/src/instrument-sessions.test.ts` (exports already use the existing
module export path; verify before changing exports).

Ingestion: `apps/ingestion/src/session-schedule-refresh.ts`,
`session-schedule-refresh.test.ts`, `session-native-refresh.ts`,
`session-native-refresh.test.ts`, `index.ts`; a small pure diagnostics module/test
is allowed if needed for endpoint composition. Adapter observation/test changes are
allowed only for bounded sanitized diagnostics, without changing requests or events.

Documentation: this contract, parent plan/report and the session-readiness runbook.
Terminal presentation is integrated separately in the parent's permitted runtime
files under the same accepted field contract. No changes to signal-engine,
execution risk, strategy decisions, proposed_orders, broker writes or DB schema.

## Acceptance and hostile cases

Use the exact observed AAPL envelope as a deterministic fixture. Add explicit valid
currentHours fixtures rather than claiming the real capture contained those fields.
At Monday preopen: strict history remains rejected; preparation is PARTIAL only
with validated CLOSED hours; five timeframes can warm; weekly makes no request and
reports WAITING. Do not equate simulated hours with real operational evidence.

Test missing/wrong-date/stale/future/identity-mismatched/overlapping hours, OPEN
market with Friday-only envelope, coverageStart too late, end before previous
Monday, exact start/end boundaries, generation 0/FAILED/REFRESHING, corrupt sessions,
invalid values, DST PL/US, a holiday Monday and shortened Friday. All relevant
strict-validator and weekly finality tests must remain unchanged and pass.

At opening, use a new generation with actual Monday coverage. Demonstrate normal
transition to COMPLETE, weekly preparation, and first-closed-minute gating. Test
concurrent invalidation/late callback, stale final read, clock regression, unchanged
pacing/single-flight and instrument fairness. Demonstrate that PARTIAL never passes
requireSessionSchedule/checkSessionWindow/evaluateSessionCandles. Independent PKO
preparation continues while AAPL is partial. Rejected response diagnostics cannot
accidentally describe an older retained schedule.

Run targeted shared/ingestion tests, then the parent required lint/typecheck/test,
isolated integration, build, clean Docker build and exact-commit CI workflow.
No strategy/simulator or candle-finality behavior changes are authorized. Any need
to alter existing candle filters, entry validators or weekly finality returns to
lead and independent plan review before editing. Deployment and operational checks
remain separate, preserving account pause/revision and existing exit supervision.

## Scoped implementation evidence

Session worker implemented the accepted contract on 2026-10-19. Independent final
review and whole-package checks/publication remain the lead's responsibility.

- `pnpm --filter @ikbr/shared exec node --import tsx --test src/instrument-sessions.test.ts src/instrument-session-hours.test.ts`: PASS, 92 tests.
- `pnpm --filter @ikbr/ingestion exec node --import tsx --test src/session-schedule-refresh.test.ts src/session-native-refresh.test.ts src/session-schedule-adapter.test.ts`: PASS, 49 tests.
- Shared build, ingestion build/typecheck, scoped ESLint and diff whitespace: PASS.
- No operational/provider calls, migrations, Docker deployment, broker writes or Git publication were performed by this worker.
- Requested model/effort: gpt-6-astra/high. Actual model/effort telemetry, elapsed time and token usage: unavailable.
- Failed targeted repair attempts: 0; escalations: 0. Existing strict validators, candle filters, weekly finality and adapter requests remain unchanged.

Operational limitation: actual currentHours was not part of the captured envelope.
The new PARTIAL path intentionally requires valid current-date CLOSED evidence;
without it the calendar remains unavailable. Weekly preparation remains deferred
until authoritative SCHEDULE coverage permits the existing strict check.
