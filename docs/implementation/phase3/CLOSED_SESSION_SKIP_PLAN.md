# Closed-session strategy skip

Date: 2026-10-13. Status: ACCEPTED by independent `wsh_plan_review`
(`gpt-6-astra/high`), no blocking findings, zero repairs/escalations.
Baseline: `113d6b614448bebe51b5650307d952e9788341f2` on main.
Parent contract: [continuous Paper operation](CONTINUOUS_PAPER_OPERATION_PLAN.md).

## Requested result and boundaries

For an instrument whose broker-confirmed exchange session is closed, omit strategy
evaluation and signal production and report an ordinary INFO result in Polish.
Keep the existing 30-second scheduler and maxConcurrent=1. Preserve the open
instrument's independent evaluation. No strategy thresholds, order/risk/AI gates,
research policy, lifecycle exits, execution calendars or authorization change.
Preserve dirty `apps/signal-engine/src/signal-engine.ts` and all unrelated backtest
work. Work on main; publish only reviewed scope. No broker mutations/provider
calls during implementation or tests. Operational rollout uses a clean pinned
build and existing authorized Paper scope; no added trading authorization.

## Evidence and smallest safe design

The generic ingestion SessionScheduleAdapter already obtains exact correlated
contractDetails and validates its complete unique contract before requesting
historical SCHEDULE. It currently discards timeZoneId/liquidHours/tradingHours.
Installed @stoqey/ib 1.6.10 exposes these fields. Its contractDetails declaration
identifies liquidHours as regular sessions and documents CLOSED, split intervals,
legacy same-date times and modern date-qualified closing times. The lead checked
[IBKR contract details documentation](https://www.interactivebrokers.com/docs/tws-api/doc/contracts-financial-instruments/contract-details/introduction).
Historical SCHEDULE can end before the present pre-open time, so absence of an
active historical interval is not proof of closure. requireSessionSchedule must
retain strict current and historical coverage. Existing persistence stores the
schedule JSON intact with generation/status fences; no SQL migration is needed.
ConfiguredStrategyRuntime currently synchronizes state and builds strategy objects
before context loading, and reports all loader failures as a generic error.

Add optional **separate current-hours evidence** inside SessionSchedule JSON.
Keep the historical source, coverage boundaries and sessions unchanged. It has
its own source tag `ibkr_contract_hours_v1`, exact InstrumentSessionIdentity,
requestedAt/receivedAt, canonical time zone and explicit date entries with
intervals or CLOSED. Obtain it from the same exact contractDetails response,
without another socket/request/client/pacing path. Select liquidHours for useRTH;
select tradingHours for non-RTH. Never substitute full hours when RTH is missing.
Missing/unsupported/malformed hours must never become an empty CLOSED day; omit
unusable optional hours and retain the existing historical result, with the
consumer falling back only to a fully valid strict historical schedule.
Do not fail an otherwise valid historical fetch just because optional current
hours are unsupported. Persisted present-but-invalid hours are unknown, not a
closure proof. This optional evidence only suppresses work; OPEN never authorizes
entry or repairs historical schedule coverage.

## Exact classification contract

A shared helper returns OPEN, CLOSED or UNKNOWN with a fixed reason. Validate
READY, positive generation, identity including RTH/exchange/zone, finite ordered
request/receipt/update timestamps, no future receipt/update, and freshness no
longer than the existing six-hour calendar ceiling. No classification uses stale
or REFRESHING/FAILED retained data. Parse the complete returned hours value with
bounded length/date count, unique valid dates, valid local times, ordered disjoint
intervals and unambiguous DST conversion using existing session time helpers.
Unknown timezone, impossible dates, duplicates, overlapping/conflicting rows,
ambiguous DST times and malformed tokens cannot prove closure.

The current exchange-local calendar date must be explicitly represented. CLOSED
is explicit CLOSED for that date or the time outside all of that date's verified
intervals; opening is inclusive and closing exclusive. Do not infer missing
weekends, holidays, calendar gaps, or future dates from neighboring dates. Support
modern fully dated end times and legacy same-day times. Overnight or cross-date
forms beyond the supported stock day-session contract return UNKNOWN rather than
assuming the preceding/following day's interval absent. Full-session generic
fixtures remain compatible through the existing historical fallback, without
claiming new asset capability. Current hours must agree with configured canonical
timezone (aliases may canonicalize; never guess a timezone from symbol).

If optional hours are absent, strict requireSessionSchedule may establish OPEN
or CLOSED from its validated covered envelope. If optional hours are present but
invalid or stale, return UNKNOWN; do not reinterpret corruption as closure.
UNKNOWN remains a context-unavailable failure with a safe fixed diagnostic reason.
An OPEN precheck continues through the unchanged historical/native-candle/context
and execution checks; its truth is never an alternative permission source.
No merge, extension, synthesized session, weekday calendar or clock-only schedule.

## Runtime and race behavior

Expose a small session precheck on StrategyContextLoader using its existing repo
and clock. Make it part of the configured runtime dependency contract and update
all in-scope mocks. After configuration/account/binding checks, perform it before
state.sync, factory creation, candle/market-state reads or strategy execution.
CLOSED returns a new configured evaluation kind `skipped`, reason
`MARKET_SESSION_CLOSED`, no signal/trigger/attribution and entryAllowed=false.
UNKNOWN returns the existing error class with its fixed diagnostic reason.

Recheck current session status after context load and immediately before calling
portfolio evaluation after asynchronous guards. A close during context loading
returns skipped rather than a stale-data error when fresh closure is proven.
Unknown/changed evidence remains an error; existing loader generation and final
freshness checks stay intact. Recheck after strategy evaluation before returning
any selected signal if asynchronous work has occurred. Never cache CLOSED across
ticks: the first tick at/after a verified opening follows normal readiness checks.
Carry the generation and evidence fingerprint between checks. Convert a
context-load failure to CLOSED only for a proven close-boundary crossing with
unchanged evidence; unrelated failures and changed evidence remain errors.
All proposal, research and execution paths remain unreachable for skipped results.
Accepted review amendment: a close detected only after the evaluator ran uses
`MARKET_SESSION_CLOSED_AFTER_EVALUATION` with INFO text explaining that the result
was discarded; it must not claim evaluation was skipped. The independent plan
reviewer accepted this distinction. Rechecks prove a forward clock crossing of
the initial active interval end; a backwards clock or changed evidence is an
error, never an ordinary closure.

Retain CONFIGURED_EVALUATION as the loop outcome for `skipped`: existing diagnostic
severity already treats it as INFO. Add a specific Polish presentation for
MARKET_SESSION_CLOSED, for example “Giełda jest zamknięta. Pominięto ocenę strategii
i generowanie sygnału.” Include the fixed reason in the ordinary loop log so the
reason survives headless output. Do not downgrade real context errors or expose
raw provider/database error messages. Do not label this NO_SIGNAL because no
strategy was evaluated. No scheduler interval/concurrency edits.

## Owned file scope and routing

Core implementation: Astra/high, after independent Astra/high plan acceptance:

- `packages/shared/src/instrument-sessions.ts` and its test;
- optional narrowly named shared current-hours helper/test plus export if splitting
  parsing keeps the existing module focused;
- `apps/ingestion/src/session-schedule-adapter.ts` and its test;
- `apps/ingestion/src/session-schedules.pg-integration.test.ts` and
  `apps/signal-engine/src/repository.session.pg-integration.test.ts` for JSON proof;
- `apps/signal-engine/src/runtime/strategy/strategy-context-loader.ts` and tests;
- `apps/signal-engine/src/runtime/strategy/configured-strategy-runtime.ts` and tests;
- configured-runtime test mocks directly affected by the required precheck method.

Lead owns diagnostic integration: trading-loop-service.ts/test,
`packages/shared/src/diagnostics/presentation.ts`/test and
`apps/signal-engine/src/runtime/trading-loop/diagnostics.test.ts`, plus this plan
and `CLOSED_SESSION_SKIP_REPORT.md`. Existing diagnostic recorder/read-model logic
must be verified but need no semantics change. No production SQL, execution,
strategy formula, signal-engine.ts, scheduler configuration or backtest edits.
Material deviations require plan amendment and independent review.

## Acceptance and hostile cases

- Before open, exact open, intraday split gap, exact close, after close, explicit
  holiday/weekend CLOSED, early close and New York/Warsaw DST boundary fixtures.
- Missing current date, missing metadata, stale/future evidence, FAILED/REFRESHING,
  wrong identity/RTH/exchange/timezone, corrupt rows and ambiguous times never
  produce CLOSED. Unsupported overnight is UNKNOWN unless an independent strict
  historical schedule can legitimately classify absent optional metadata.
- Broker identity must complete before metadata is accepted; stray request IDs,
  duplicate details, timeouts and disconnects retain existing failed-generation
  behavior and listener cleanup; no additional broker requests.
- Yesterday-only historical coverage plus fresh AAPL current liquidHours proves
  a pre-open skip. The same historical coverage at OPEN still fails the unchanged
  loader/entry checks. No historical coverage bytes are extended or changed.
- CLOSED runtime calls zero state.sync, factory, context load, strategy evaluator,
  research preparation, proposal/AI or broker-write methods. Concurrent instrument
  fixture proves open PKO continues while AAPL is skipped (and vice versa).
- Crossing close during context load produces INFO skipped without signal;
  opening next tick resumes the ordinary readiness path. Changed/stale generation
  remains an error, not closed. Test typed result and persisted reason/severity.
- JSON roundtrip preserves optional evidence and legacy rows without it; existing
  execution/calendar checks and golden historical schedule behavior remain intact.
- The configured scheduler retains 30 seconds/max1 and non-overlap; repeat closed
  cycles produce truthful INFO diagnostics without context-error noise.

Run targeted meaningful suites, then `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` with isolated PostgreSQL, and `pnpm build`. No operational
DB fixtures or provider calls. Existing strategy regression tests remain relevant;
no strategy/simulator change or new backtest is required. A different independent
Astra/high reviewer must accept implementation and hostile cases. Build a clean
Docker release for deployment; inspect safe current-hours/readiness diagnostics
without interpreting source tests as real trading acceptance. Record model/effort,
review findings/repairs, elapsed time and available token data (otherwise
unavailable). Report, scoped commit/push and exact-commit GitHub CI verification
complete publication. Any failed/unverified check remains explicitly incomplete.
