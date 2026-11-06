# Ingestion recovery after laptop sleep

Date: 2026-11-06. Status: ACCEPTED by independent reviewer
`wake_recovery_plan_review` (`gpt-6-astra` / high), after one substantive review
repair round and a file-scope clarification. This is plan-only acceptance;
a different independent hostile implementation review remains mandatory.
This document is a bounded extension of the
[continuous-operation plan](CONTINUOUS_PAPER_OPERATION_PLAN.md) and
[automatic recovery plan](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md). It does not
claim implementation, deployment, market-data readiness or Paper trade acceptance.

## Outcome and boundary

After the laptop/Docker VM resumes, continuous Paper PKO/AAPL observation must
recover without a routine owner pause/resume, service restart or TWS restart.
Recover an ingestion socket that remains locally marked connected but cannot
answer, rebuild its subscriptions, and repair missing native closed candles and
session evidence. Continue bounded retries while TWS is unavailable. Preserve
the existing durable manual ingestion stop and every trading pause/authorization.

Only ingestion read connectivity and orchestration change. No order send,
modification, cancellation, close, execution reconciliation, accounting ownership,
research provider/model call, strategy or risk semantics change. Unknown financial
submissions remain unknown and are never replayed. No schema migration, new
operator UI, host sleep inhibitor, launch daemon or generic stack supervisor is
required. The bot cannot execute while its host is asleep and cannot promise
recovery while TWS/network/Docker remains unavailable.

Work on main, preserving unrelated dirty backtest/signal-engine source and the
already modified automatic recovery report. Publication is scoped to this package.

## Source findings

- `apps/ingestion/src/auto-bootstrap.ts` already serializes startup/control,
  reads/writes the durable stop, fences bootstrap completion by generation and
  uses 30/60/120/240/300-second retry delays. Its `ready()` dependency checks only
  the local connection flag and configured subscription membership in `index.ts`.
  A half-open socket with no disconnected event satisfies both indefinitely.
- `TwsClient.connect()` returns immediately when `connected` is true;
  `disconnect()` returns when it is false, including a failed/unfinished connect.
  The single IB object and listeners currently survive reconnect. There is no
  current-time liveness probe. Connectivity-error invalidation alone does not
  consistently dispose that transport.
- Installed `ib` is 0.2.9 (manifest `^0.2.8`); its `reqCurrentTime()` method emits
  `currentTime`. That response has no request ID. A timed-out probe must therefore
  not be followed by another probe on the same transport that accepts a late reply.
  This endpoint proves a TWS API response, not market-data farm health, account
  identity, execution readiness or quote freshness.
- `SessionNativeRefresh` already runs once per minute, serializes runs, rotates
  instruments, prioritizes due minutes and fetches only missing/obsolete native
  history. `expectedSessionSlot` and existing finality helpers decide what should
  exist. `SessionScheduleRefresh` already fences persisted schedule generations.
  Reuse these mechanisms; do not implement a second history scheduler.
- Native refresh currently has no caller-generation cancellation. A socket reset
  alone does not fence a refresh already awaiting a DB read, pacing token or
  publication. Tick callbacks in `index.ts` are asynchronous and need equivalent
  care. Resetting an object must not reset `finalBarRequestTimes`, the ingestion
  rolling historical-request ledger also used by schedule acquisition.

## Implementation contract

### 1. One recovery owner and observable states

Extend the existing `AutoBootstrapController` and its production composition.
It remains the sole owner of automatic bootstrap/recovery and manual start/stop.
Expose transport health separately from native-data readiness in existing health
diagnostics. Retain existing fields for consumers; add last successful probe,
last scheduling-gap observation, reason, recovery generation and next retry.
Do not relabel an existing HTTP health response as proof of launch readiness.

Keep the five-second controller cadence. Measure actual intervals with an
injected clock: a forward elapsed gap of at least 30 seconds, a backward wall
clock jump, or a non-finite clock invalidates the prior usable generation. Use
wall time for sleep detection because monotonic timers do not uniformly include
host suspension; use a monotonic elapsed clock for probe deadlines. First startup
does not count as a wake. A clock anomaly is a synchronization trigger, not proof
that the operating system slept, and diagnostics must use that distinction.

When enabled and durably running, inspect scheduling gaps even during an ongoing
bootstrap. Invalidate that flight once, revoke its ability to publish/subscribe,
and dispose its old read transport before waiting for it to settle. Never start
another bootstrap concurrently. Coalesce repeated ticks/gap/disconnected signals
for the same recovery episode. A new wake can supersede the current attempt, but
cannot reset failure backoff or create unlimited immediately retried attempts.

Do not launch automatic probes or repair when opt-in is disabled, manually
stopped, shutting down, uninitialized or control persistence is uncertain. Manual
start still works when automatic mode is disabled. Preserve serialized controls,
durable stop across process restart, immediate local inhibition on persistence
failure, and shutdown that does not persist an operator stop. No recovery clears
the execution account pause or startup entry ceiling.

### 2. Real read liveness and transport retirement

While idle and locally connected, probe `reqCurrentTime` at most once per
30 seconds, with a 15-second response deadline and one pending probe per transport.
This is a cheap socket response check; it does not change historical-fetch
deadlines, including any separately requested historical timeout policy. A valid
reply is a positive safe integer of broker epoch seconds and belongs to the
captured transport/generation while its probe
is pending. Do not require exact host/broker clock agreement or use the value as
financial accounting time.

Validate elapsed/deadline and scheduling continuity at event acceptance as well
as in the watchdog. Buffered `currentTime` or tick events can arrive after wake
before the overdue timer callback; that ordering cannot make old data appear
current or refresh a liveness success. Expired pending operations reject even
when their timeout callback has not run yet.

A probe send throw, timeout, disconnect or invalid reply makes transport health
unavailable and requests recovery. Remove its listeners/timer on every outcome.
Retire the old IB object after an unsuccessful probe; its late response must not
resolve a later attempt. Successful transport probing alone must not clear
session/quote/history holds. Do not add a second probe while bootstrap owns reads;
the scheduling-gap check must still invalidate a suspended bootstrap.

Add explicit transport generation and force-disposal in `TwsClient`. Disposal
invalidates first, clears subscription/ticker provenance, aborts or rejects
pending reads/connect/probe promises, then disconnects even when the local flag
is false. A new transport gets new core listeners. Old connected/disconnected,
error, contract, history and tick events cannot mutate the new client. Inject an
IB factory for tests while preserving existing single-fake test seams as needed.
Request IDs stay monotonically allocated across replacements.

Verify the installed adapter's physical retirement behavior: its public
disconnect is queued and socket `end()` alone does not guarantee immediate
closure of a stalled connection. Provide narrowly scoped, tested bounded socket
cleanup for this installed adapter, including force destruction when required,
with late errors safely consumed. Do not leak old sockets or create competing
clients with the same ID while claiming retirement succeeded. Adapter-private
access, if unavoidable, must validate the actual installed shape and fail
explicitly when unsupported; do not introduce a general transport framework.

Preserve the existing pacing ledger on the stable `TwsClient` object across
transport replacements. No generation change, wake, failure or manual start
clears charged request times. Historical/schedule requests keep the same pacing
path; an aborted charged read retains its debit. A waiting request captures its
origin before waiting and rechecks after acquiring a token, before the send;
it must not borrow the replacement socket. Stop/cancellation must also wake or
bound pacing waits so shutdown cannot wait an entire rolling window. This package
does not claim the local ledger implements cross-process/account-wide pacing.

Apply the same capture-before-wait/check-before-dispatch rule to schedule
acquisition. Existing schedule invalidation resets its local retry time; retain
an episode/endpoint retry bound so repeated invalidations cannot bypass ordinary
schedule cooldowns or manufacture an acquisition storm.

### 3. Ordered bootstrap and publication fencing

For a recovery episode, immediately pause refresh/publication admission and revoke
the old transport/generation. Clear active local subscription claims. Invalidate
session schedule coordinators using their existing DB generation mechanism, drain
or abort old native-refresh work, and drain already-admitted publication work.
Then run the existing bootstrap: connect and verify read liveness, retain managed
account/binding checks, obtain current schedules, repair differential history,
and add subscriptions only while the originating recovery generation is current.
Restart the ordinary minute refresher after this sequence. A pending DB failure
must remain visible and retryable, never a fabricated ready state.

Use captured transport/run identity at asynchronous boundaries for the
production tick-to-market-state path and native refresh. A late tick callback,
schedule result, pacing continuation, history result or bootstrap cannot publish
fresh market state, advertise readiness, or add subscriptions after revocation.
For publication already admitted to storage before revocation, serialize/drain
it before any replacement generation publication. Its original observation
timestamps remain unchanged; never stamp old data with recovery time. This is
particularly necessary for Redis, where an old async write could otherwise
overwrite a newer quote. Handle callback rejections without unhandled promises.

Native-refresh generation checks apply before request dispatch, after awaits,
before each persistence admission and before status success. Retained validated
historical rows are not deleted. An already admitted historical write may finish
with its original immutable candle timestamps, but cannot certify the new run.
Keep the existing schedule DB generation check and native finality checks. Do
not claim that a local flag can undo a DB write already in progress.

Bound transport read and pacing cancellation; do not replace this with
fire-and-forget old flights. The current ingestion PostgreSQL pool does not
configure query, statement or connection deadlines, so this package must not
claim that DB work necessarily drains within a deadline. If admitted storage
work has not settled, remain in observable `DRAIN_WAITING_STORAGE` with elapsed
time and no successor publication. A diagnostic deadline may report this state;
it never proves the old write was cancelled. Keep the event loop, watchdog and
read-only health diagnostics responsive while the control operation awaits
settlement. Once the real operation settles, automatic recovery may continue.
No PostgreSQL cancellation protocol or storage-generation migration is added.

### 4. Distinguish data repair from transport recovery

After wake/bootstrap, run the existing session-native refresher promptly and
then retain its one-minute cadence. The 30-second liveness check continues
independently when idle. Missing candles call this normal repair path, not a full
universe download. Do not clear refresh attempt cooldowns merely to accelerate
retry, and preserve minute priority/two-instrument polling capacity.

With a healthy transport, missing/stale data continues through ordinary native
refresh and its existing attempt cooldowns and session rules. Do not reconnect
the socket solely because native candles or quotes remain unavailable. This
bounded fix reconnects on scheduling interruption, failed liveness or explicit
connection invalidation. A separate market-data resubscription policy is not
required to fix the demonstrated half-open-socket defect and is not introduced.

Do not classify closed sessions, holidays, missing/future/partial schedules,
weekly coverage pending, cold insufficient history, permissions, client-session
conflicts, exhausted pacing or unknown request completion as successful repairs
or automatically reconnect solely for those conditions. Keep the affected scope
in WAITING/HOLD with its actual reason. Quote silence alone is not a reconnect
criterion: legitimate quiet markets exist, and current entry quote guards remain
authoritative. A repaired socket does not imply market-data entitlement.

Report Polish operator diagnostics for detected scheduling interruption, probing,
retry delay/TWS unavailable, native data catching up, outside session and manual
stop. Errors retain sanitized original name/code/message when available; no raw
account/provider payload, token, credentials or private configuration is logged.

## Permitted source scope and delegation

- `apps/ingestion/src/auto-bootstrap.ts` and its tests: timing, health orchestration,
  backoff, control races and diagnostics.
- `apps/ingestion/src/tws-client.ts` and focused `tws-client.*.test.ts`: liveness,
  transport ownership/disposal, cancellation and preserved pacing.
- `apps/ingestion/src/session-native-refresh.ts` and its tests: cancellation and
  existing data-readiness diagnostics; schedule refresh only if needed to connect its
  existing invalidation/idle mechanism.
- `apps/ingestion/src/session-schedule-adapter.ts` and its tests: cancellation and
  captured-generation admission across its queue/pacing boundary only; retain
  schedule parsing and request semantics.
- `apps/ingestion/src/index.ts` and a narrowly extracted production composition
  helper/test if required for testability: actual wiring and publication draining.
- This plan, `SLEEP_WAKE_RECOVERY_REPORT.md`, and the existing applicable runbook
  may document the delivered mechanism. No unrelated report rewrite.

Avoid configuration churn: defaults above are internal tested constants behind
the existing automatic-bootstrap opt-in. An additional configuration knob or
broader service/schema change requires a reviewed amendment. No edits to dirty
signal-engine/backtest files are authorized by this package. Tests may consume
their existing interfaces without altering strategy logic.

Treat this as critical data freshness/integration work: Astra/high establishes
and implements semantics; bounded noncritical fixtures/presentation may use the
existing routing guide only after their exact contract is fixed. An independent
Astra/high reviews this plan; a different independent Astra/high performs final
hostile review and does not implement this package. Workers receive exact file
scope, invariants, checks and stop conditions. Escalate unknown library behavior,
new cross-service contracts or inability to fence/drain to the lead, never relax
the invariants to make a fixture pass.

## Acceptance and hostile cases

1. Fake IB remains marked connected and emits no disconnect across a clock gap.
   Exactly one old generation is retired; a new real handshake/read, verified
   subscriptions and native refresh follow automatically.
2. Without a scheduling gap, a silent time probe expires and causes bounded
   recovery. Late time/nextValidId/error/disconnect/tick/history callbacks from
   the retired transport cannot satisfy or invalidate the successor.
3. TWS unavailable for several attempts produces the existing backoff ceiling;
   return of TWS restores observation without manual start. Repeated wakes,
   overlapping timers, slow bootstrap and disconnect bursts create no parallel
   connects, duplicate subscriptions, request floods or reset pacing charges.
4. Manual stop during probe, historical pacing wait, bootstrap and Redis/DB
   publication remains stopped after all promises settle and after process
   restart. Explicit start is the only action that clears durable manual stop.
   DB control failures and shutdown remain fail-closed.
5. Exercise a deferred old Redis write and historical refresh across invalidation:
   old work cannot overwrite a newer generation, publish readiness, dispatch an
   old queued read on a new socket or create an unhandled rejection/listener leak.
6. Real socket liveness with missing current-session minutes triggers normal
   repair without a full reconnect. Complete history is reused. Holidays/closed
   sessions, partial schedule coverage, market-data permission failures and
   pacing waits do not create reconnect loops. A blocked storage drain stays
   observable without successor publication; later real settlement resumes
   recovery without pretending a diagnostic timeout cancelled the old write.
7. Production-wired fake-clock/fake-IB integration, with isolated PostgreSQL when
   persistence is involved: sleep interruption -> recovery -> new native closed
   current-session candles -> unchanged readiness evaluator accepts fresh data
   for both PKO/AAPL fixtures. Include existing signal evaluation interface where
   feasible, proving that a fresh natural evaluation can run without loosening
   its stale-data rejection. No fabricated signal, AI approval or broker order
   is needed or permitted to obtain this pass.
8. Assert zero broker order mutations and paid-provider calls in recovery tests;
   existing execution pause/unknown-order protections and required suites remain
   unchanged. Passing a health endpoint alone is not acceptance.

## Validation, publication and operational evidence

Run targeted ingestion tests during implementation, then `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` against isolated PostgreSQL,
and `pnpm build`. Confirm the integration database URL targets the isolated test
database before destructive fixtures; never use operational `ikbr_trader`.
No strategy/simulator change is planned, so new backtests are unnecessary unless
the reviewed scope changes. Inspect full/staged diff for unrelated edits and
secrets. Deployment requires a clean Docker build of the exact reviewed commit.

After accepted hostile review, record tests, command exit codes, findings/repairs,
requested and actual models/effort, elapsed time and available token usage in the
package report (unknown telemetry is `unavailable`). Commit/push only reviewed
scope on main and verify GitHub CI for that exact commit. Report access failures
explicitly; do not claim completion with failed or unverified CI.

Operational verification uses the existing authorized Paper scope and current
[GPW runbook](../../runbooks/GPW_PAPER_ROUND_TRIP.md), with fresh broker/account
evidence and existing deployment/recovery controls. Do not force sleep while
bot-owned exposure needs supervision merely to generate evidence. Prefer a
controlled disconnected ingestion read transport or a safe observed host wake;
differentiate simulated interruption from a real laptop-sleep receipt. Observe
automatic reconnect, schedule generations, new quote provenance and current
native closed-candle times for each instrument during its actual open session,
then fresh scheduler evaluation. Check execution reconciliation and entry gates
through existing read APIs; ingestion recovery never bypasses them.

Record separately: implemented/tested, published CI, deployed build, isolated
interruption recovery, actual host-wake recovery, each instrument's fresh-session
evaluation, and real trading/soak evidence. Outside-session observations may prove
transport recovery only; leave market-data/session acceptance pending until the
applicable market opens. No ordinary operator resume/restart ceremony is added.
