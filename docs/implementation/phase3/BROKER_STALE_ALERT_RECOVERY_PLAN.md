# Broker stale observation: latency diagnosis and bounded notification recovery

Date: 2026-10-14. Status: ACCEPTED for implementation by independent reviewer
`stale_alert_plan_review` (requested/actual `gpt-6-astra`, high), after one review
round with targeted clarifications to proof expiry, lock ordering and fairness.
Token telemetry unavailable. A different independent agent must review the final
implementation. No remaining blocking plan findings.
Baseline: `5c32cdc4f88be3de1c3cff7b16871302a0cb4b10` on main.
Owner scope: diagnose and fix recurring `BROKER_STATE_STALE` Telegram noise during
[authorized continuous Paper operation](CONTINUOUS_PAPER_OPERATION_PLAN.md),
separating immediate safety denial from bounded notification delivery. Urgent
exposure/protection alarms stay immediate. This plan does not authorize broker
writes, provider requests, Telegram probes or operational mutations during development.

## Evidence and limits

Source inspection establishes:

- `lifecycle/observer.ts` runs nonoverlapping cycles every 5 seconds. Its independent
  watchdog marks health false and records an account fault after 10 seconds since
  the last completed observation. That 10-second safety contract remains unchanged.
- `index.ts` uses the full-close refresh dependency for the observer: first refresh
  the position snapshot, then `reconScheduler.triggerFresh()`. `triggerFresh()` waits
  for an older capture and starts another. This is intentional post-request evidence
  for close and must not become reuse of a pre-request capture.
- `reconciliation/scheduler.ts` schedules additional periodic captures. It currently
  applies minimum interval only to timer spacing, so a periodic capture may follow
  a forced observer capture almost immediately.
- `IbBrokerReconciliationAdapter.capture()` waits for initial session, parallel
  positions/open orders/executions/completed orders, final session, then accounting
  join. Accounting failures are caught and the ordinary snapshot is retained for
  exits. The cause is currently discarded; CLEAN alone does not certify accounting.
- `AccountingSourceCollector.replay()` waits for ready identity, accepted broker
  clock and replay end using one deadline capped by the source timeout. Timeout or
  abort becomes `ACCOUNTING_REPLAY_INCOMPLETE`; the socket is retired. Do not infer
  which wait failed from that generic code.
- `LifecycleAlertStore` immediately inserts an outbox row per fault episode.
  `resolveScope()` resolves the fault but does not cancel its outbox. `claimNext()`
  can claim a resolved episode. The worker normally ticks every 5 seconds. This
  explains delivery after recovery and a new message for every recurring episode.

Read-only production observations supplied by the lead: reconciliation 49307 ran
10:34:57.318706–10:35:05.411329 UTC, CLEAN with complete ordinary coverage. Accounting
replay 909 clock/end occurred at 10:34:56.533/.534; replay 910 has no accepted clock
or replay start; generation 42 gap is at 10:35:05.393. Generation 43 handshake and
successful replay 911 occur at 10:35:07.398/.399. Earlier repeated episodes occurred
at minute boundaries with about 8.08-second capture duration, watchdog faults around
second 02–04, resolution around 05, and delivery around 07. A periodic run followed
an observer run by about 0.8 seconds. These establish a pre-accepted-clock accounting
stall and redundant capture pressure, **not** the cause of the missing clock.
Installed `@stoqey/ib` 1.6.10 has generic request scheduling, without a discovered
clock-specific throttle. No speculative pacing, clock cache, retry or timeout
increase is justified.

## A. Per-phase evidence and periodic capture coordination

1. Add bounded structured measurements for scheduler caller (`periodic`, explicit,
   fresh), scheduler wait, capture session-before, each parallel source,
   session-after, accounting join and total capture. Record duration, outcome,
   run identity and safe source generation, without accounts or broker payloads.
2. Record collector ready, clock request/wait, replay request/end wait, drain/cost
   wait and publication phases. Preserve original sanitized error name/code/message
   alongside mapped phase/error; generated timeout has its actual internal cause,
   while absent external details remain unavailable. Use existing diagnostic privacy
   helpers with configured secret/account redaction. Do not serialize Error objects,
   provider payloads or raw socket frames. If SDK sent/received milestones are added,
   permit only validated clock-message metadata; no generic raw logging.
3. Keep the adapter's existing accounting-failure exit behavior, but emit its safe
   phase/cause. No change to accounting qualification, invalidation, gap fencing,
   replay coverage, clock tolerance or entry accounting requirements.
4. Only the periodic timer may skip a redundant capture when the immediately latest
   completed run is same account, process session and current broker generation,
   CLEAN, exposure/recovery complete, without holds, with available required
   accounting, and its scheduler attempt started no more than 5 seconds ago. Use
   monotonic elapsed time and reject any future/rollback timestamp; an 8-second run
   cannot qualify merely because it just completed. Original capture timestamps
   remain current; accounting publication must not rejuvenate old source evidence. A subsequent failed/partial run, disconnect, context change,
   accounting gap or changed generation invalidates skip eligibility. Missing
   capability to verify a condition means do the periodic capture. Emit a bounded
   skip event identifying the qualifying run. Use local coordination only; this is
   request reduction, never an entry readiness decision.
5. `triggerNow()`, reconnect/manual triggers and `triggerFresh()` preserve their
   existing behavior. In particular fresh callers never consume a capture begun
   before their request. Failed or null runs do not provide a skip receipt. Graceful
   stop still prevents a new capture.

This removes measured redundant pressure. It is not a claim that broker clock
pacing caused the stall. Operational verification must identify remaining timeout
phases; a further semantic fix requires evidence and a reviewed plan amendment.

## B. Current flat checkpoint used only for notification timing

The watchdog may defer notification only for `proposalId=null`, code
`BROKER_STATE_STALE`, and the exact locally generated
`lifecycle_observation_overdue` reason. Do not trust the existing redacted JSON
`evidence.reason` to select policy: use a typed internal notification eligibility
request and independently validate it in storage.

An additive migration supplies a durable, notification-only current-capture
checkpoint. The adapter publishes it after every ordinary source has ended and
final session/generation validation passed, **before** accounting join can stall.
It is not a CLEAN reconciliation run, accounting certificate, terminal proof or
entry permission. Other consumers must never use it as such.

The producer and consumer contract is fail-closed:

- Bind checkpoint to account, execution process session, connection generation,
  exact reconciliation run, and the position snapshot generation captured by that
  run. Store acquisition start and each required completion timestamp; freshness
  is bounded by the oldest relevant acquisition time, not later persistence time.
- Require successful bounded positions, all-open-orders, executions, completed
  orders and both session checks, exact managed account identity, unchanged live
  connection, and no missing/endless/partial source. All account positions must be
  zero; all account working orders absent. Unknown account/type/quantity identity,
  nonterminal completed-order evidence or contradictory records disqualify it.
- Under the existing `snap:<account>` transaction lock, require no active
  reconciliation hold; no nonterminal entry reservation/dispatch/submission or
  close intent; no unknown outcome; no other active lifecycle fault. Historical
  attempted candidates qualify only through existing accepted terminal evidence
  with unchanged current fingerprint and no contradictory current evidence.
  Reuse the existing terminal validation semantics; never count a status label or
  old empty position array as terminal proof. If existing terminal validation needs
  fresh CLEAN evidence that is unavailable during this stall, do not relax it: the
  candidate is ineligible and alerts immediately. Missing evidence disqualifies.
- Both recording a delayed fault and claiming/coalescing its outbox revalidate the
  above durable conditions and same session/generation. A current in-process
  connection check must also agree; restart provides no inferred continuity.
  Require checkpoint age strictly less than 10 seconds using DB time, no future
  timestamps, latest capture identity, and unchanged position generation.
- Publish/revalidate under existing account serialization so a concurrent durable
  reservation or dispatch cannot be overlooked. The immediate watchdog health/fault
  hold still blocks entry irrespective of notification timing. No new broker reads
  are made merely to decide whether a notification is delayed.
- A failed check, source exception, disconnected session, expired checkpoint,
  persistence problem or uncertain ownership uses immediate notification. A
  checkpoint never hides a separate proposal fault or protection escalation.

Implementing terminal validation or atomicity requires critical ownership by the
lead/Astra worker. If an individual candidate cannot qualify (including a latest RUNNING reconciliation
that prevents existing terminal validation), immediate notification is the supported
fallback, not a scope failure. If implementing the contract would require changing
terminal ownership semantics, stop and amend the plan; never replace proof with inference.

## C. Durable bounded delivery and coalescing

Use existing fault episodes and outbox; retain every episode, count and timestamp.
Add explicit policy/proof/deadline metadata and a distinct `COALESCED` terminal
notification disposition. It means no transport attempt was made for a recovered
qualified transient; it never means delivered or acknowledged.

- A qualified new watchdog episode is immediately active/entry-blocking, but its
  first delivery becomes eligible 5 seconds after `first_observed_at`. This is one
  existing worker cadence of notification observation, **not** a safety grace
  period. Persist the deadline once. Repeated watchdog calls and restart never
  postpone it. Unqualified episodes and all other fault codes remain immediately
  due. Every worker tick proactively scans all policy PENDING rows for its accounts
  **before** the `next_attempt_at` due filter, and losing eligibility promotes the
  delayed row to immediately due in that tick. Watchdog re-observation also promotes
  it immediately if the proof no longer qualifies; neither route extends deadlines.
- Before any delayed claim, recheck policy, active state and current proof under
  account/outbox locking. At the original deadline an unresolved episode is due;
  do not renew the delay using newer snapshots. Thus sustained staleness generates
  an alert through the existing worker even while the account remains flat.
- Only a successful existing observer resolution with current complete, fresh,
  same-session broker reconciliation and flat proof may coalesce this episode,
  and only if resolution happened within its original 5-second delivery delay.
  Atomically change only `PENDING`, attempts=0, no lease/attempt history to
  `COALESCED`. Recovery after the deadline does not erase a due alarm, even if
  the worker was busy. Resolved nonqualifying faults retain existing delivery.
- The record/resolve/claim operations use consistent account-first locking and
  recheck outbox state so racing workers cannot send an already coalesced row or
  coalesce a claimed one. Multi-account handling sorts account IDs and handles one
  account transaction at a time: acquire `snap` first, then select/lock its fault and
  outbox rows in ID order. Never claim an outbox row and then acquire its account
  lock. Lease expiry/claim and resolution follow this order; concurrent workers
  retain existing lease/token protection. Sorted validation is not claiming priority:
  preserve globally due/oldest eligible selection (unlocked candidate read, then its
  account lock and locked row recheck), or equivalent bounded fairness. A first
  account with recurring faults must not starve an urgent later account.
- Never coalesce `SENDING`, `UNKNOWN`, `FAILED`, `DELIVERED`, `DISABLED`, any row
  with an attempt, or any probe. Preserve their histories/retries and existing
  uncertain-delivery entry hold. Do not backfill old episodes into this policy.
- Entry gating excludes only positively `COALESCED` resolved rows from the pending
  delivery count; active faults still deny, as do unconfirmed transport/probes,
  stale observer, reconciliation/accounting/risk failures and attempted unknown
  deliveries. Enforce the coalesced invariant in SQL as well as application code.
- Later recurrence creates its own durable episode. Repeated qualifying brief
  transients coalesce separately and remain locally countable; sustained or unsafe
  recurrences alert. Do not rate-limit urgent codes, erase history or mark delivery
  success merely to remove a hold.

Existing supervision/API/status projections show policy, due time, proof reference
and coalesced result accurately. No dashboard development or Telegram test is in
scope. The runbook explains immediate safety denial versus this narrow delay.

## Ownership, files and sequence

Lead supplies bounded packets and integrates shared contracts first. Requested
critical implementation model/effort: `gpt-6-astra` / high. Plan reviewer is a
separate Astra/high agent; final hostile reviewer is another independent Astra/high
agent who did not implement this change. Mechanical checking/publication may use
an available routing-guide equivalent; record actual model and any fallback.

Permitted production scope:

- `apps/execution-engine/src/reconciliation/{scheduler,runner,ib-broker-adapter,broker-adapter}.ts`
  and adjacent focused tests for coordination, timings and checkpoint producer;
- `apps/execution-engine/src/accounting/{source-collector,source-service,types}.ts`
  and focused tests for phase/cause measurements only;
- `apps/execution-engine/src/lifecycle/{fault-contract,lifecycle-alerts,observer,observer-repository}.ts`
  and focused unit/isolated PostgreSQL tests;
- `apps/execution-engine/src/index.ts` wiring; minimal diagnostic status/type
  compatibility only; a focused helper in the above directories if needed;
- new migration `infra/sql/migrations/000032_broker_stale_alert_policy.sql`, migration
  tests, this plan/report and the relevant supervision/continuous runbook sections.

Do not alter released migrations, strategy behavior, research budgets, risk limits,
accounting approval semantics, broker submission/cancellation code or unrelated
ES/backtest/signal-engine working changes. No branch/PR. No publication until
independent implementation acceptance and required checks.

## Acceptance and validation

1. Deterministic clock tests: health/fault deny at the existing 10 seconds during
   blocked refresh; no source timeout increase; protection/unknown/close faults have
   no added delivery delay. A stale historical empty snapshot cannot qualify.
2. Phase fixtures distinguish ready, clock, replay-end, accounting costs/drain and
   publication waits, ordinary parallel source failures and total duration. Errors
   preserve actual sanitized name/code/message; privacy tests cover secrets,
   account IDs, URLs, control characters and absent external cause.
3. Scheduler fixtures: periodic tick shortly after valid same-context capture
   skips; >5 seconds since attempt start, long-run/recent-completion, clock rollback,
   stale acquisition, partial/failed/null run, missing accounting,
   holds, reconnect/generation/account/session change do not. Explicit/fresh calls
   still execute and pre-existing capture cannot satisfy close freshness. Stop and
   overlapping periodic/fresh callers do not create duplicate completion or hangs.
4. Isolated PostgreSQL checkpoint fixtures: complete zero exposure qualifies;
   exposure, working orders, missing identity, pending/unknown entry or close,
   active hold, changed fingerprint, future/expired timestamp, stale/wrong session,
   generation change and position-generation mismatch deny. Race a durable entry
   reservation against eligibility; no unsafe delayed classification is permitted.
5. Isolated PostgreSQL delivery fixtures: 3-second qualified recovery coalesces with
   zero transport calls; recurrent episodes retain history without sends; 5-second
   unresolved episode becomes due once and cannot postpone; loss of proof promotes
   immediate due; recovery after deadline does not coalesce. Restart retains policy,
   deadline and state. Competing claim/resolve workers cannot send a coalesced row.
   Two-account fixtures prove recurring first-account faults cannot starve an urgent
   second-account delivery.
6. Claimed/SENDING/UNKNOWN/FAILED/DISABLED/probe and old fault rows are not coalesced;
   lease expiry, late completion, retries and unresolved entry holds are unchanged.
   Only resolved positively coalesced rows stop blocking entry delivery; no unrelated
   hold is cleared. Urgent faults retain existing immediate eligibility and attempts.
7. New migration works from baseline and fresh DB, enforces disposition constraints
   and preserves old states. Status/report distinguishes coalesced from delivered.
8. Independent hostile implementation review, then `pnpm lint`, `pnpm typecheck`,
   `pnpm test`, `pnpm test:integration` against isolated PostgreSQL, and `pnpm build`.
   No strategy/simulator change: no additional backtest is warranted. Deployment
   requires a clean Docker build and existing authorized runbook gates. Commit only
   reviewed scope, push main and verify GitHub CI for the exact commit.
9. During separately authorized deployment, retain private before/after phase
   evidence across multiple former minute-boundary failure opportunities. Confirm
   watchdog safety behavior through fixtures, no unnecessary periodic captures,
   no repeated resolved transient Telegram alerts, current account/observer and
   accounting state. If pre-clock stalls recur, report their phase/cause and amend
   the root-cause fix; do not claim root cause resolved from fewer messages alone.

Implementation report records acceptance, independent reviewer identities/findings,
requested/actual models and effort, repairs/escalations, elapsed time, token usage
or `unavailable`, exact checks/results/commit/CI and outstanding operational evidence.

## Final review amendment — notification evidence and transaction boundary

Accepted design refinement 2026-10-14; independent plan reviewer
`stale_alert_plan_review` ACCEPTED this exact amendment. Repaired implementation
still requires independent final acceptance. These are notification-only vetoes, not new terminal ownership authority.

Completed-order rows for the account must map uniquely across accepted terminal
links using nonempty exact account, permId and orderRef. A supplied brokerOrderId
must also agree; absence is allowed only because the installed completed-order
adapter deliberately provides permId/ref rather than that ID. Contract, STK type,
currency and BUY/SELL action must agree with the accepted leg. Finite nonnegative
filled quantity must equal accepted terminal fills for that exact leg; role totals
are usable only when the role maps to one leg. Filled rows require zero remaining;
cancelled terminal rows may retain their known unfilled remainder, but filled plus
remaining must agree with the accepted original quantity. No missing total or fill
is invented. Duplicate, unmapped, inconsistent or uncertain records deny notification
deferral. The existing terminalCycleFailure validator remains unchanged and runs first.

Carry a synchronous live identity and monotonic proof-expiry validator to every
policy-consuming mutation. Recheck before and after awaited writes. A failed
post-write check rolls back policy changes; keep/promote an immediate fault. The
chosen notification linearization point is the final synchronous identity/expiry
check immediately before issuing COMMIT, with no intervening await. If that check
fails, roll back and record an immediate non-deferrable fault. Following a known
successful COMMIT, detected identity/expiry drift also creates a new immediate fault
(or promotes the existing active delayed row). Preserve immutable COALESCED history;
a later disconnect is a new observation event, not a rewrite of accepted history.

This does not provide an atomic transaction between the broker socket and database.
Connection changes after that final synchronous check are new observations. A crash
or unknown COMMIT acknowledgement can prevent direct post-commit compensation;
propagate that uncertainty without blindly retrying the transaction or rewriting
history. Existing fail-closed observer, startup, account/probe and freshness checks
remain responsible for recovery. No durable verification subsystem or guaranteed
restart-safe compensation is claimed in this bounded package.

Disabling delivery, delayed-row scanning, lease expiry and claims use one account
lock at a time, nonblocking row locks, and mutate only rows actually locked. A later
broad UPDATE must not reacquire rows skipped by SKIP LOCKED. Preserve globally due
claim order and demonstrate progress for an urgent account while another account's
outbox row is locked. Regressions must exercise due claim/recovery interleavings,
active-query abort with no late publication, changed process session, completed-order
contradictions, prewrite/postwrite/precommit drift, known post-ack compensation and
unknown commit acknowledgement without speculative history changes.

### Independent checkpoint execution contradiction amendment

Accepted by independent plan reviewer `stale_alert_plan_review` (Astra/high).
The raw checkpoint and accounting-enriched
terminal reconciliation snapshot are independent evidence objects; neither may
stand in for the other in tests. After the unchanged terminalCycleFailure accepts
all candidate histories, each same-account checkpoint execution must map to exactly
one accepted cycle and leg using existing cycleForRow/matchesCycleLink identity
semantics. Its nonempty execution ID must occur exactly once in checkpoint rows and
exactly once in that cycle's accepted report fills, and belong to the immutable
proof execution IDs. The fill role must equal the matched leg role. Require exact
STK contract/conId, currency, finite positive quantity and price, finite execution
time, and the role-consistent BUY/BOT or SELL/SLD side against that accepted fill.
Quantity and price must exactly equal that fill; timestamps must represent exactly
the same instant, not merely both be finite.
Duplicate, unknown, ambiguous, malformed or contradictory rows deny notification
eligibility immediately. No whole-array equality is imposed: broker replay windows
may omit historical fills, while every row actually returned must be proven. No
accounting field absent from the ordinary execution source is invented or required.

Tests use distinct checkpoint, final snapshot and accepted report objects, with a
positive identical-value case and independent quantity, price, contract, security
type, currency, side, time, identity, duplicate and unknown-execution contradictions.
This is an additional notification-only veto; terminal validation, safety thresholds,
accounting authority and broker requests remain unchanged.

### Postdeployment amendment — canonical PostgreSQL run IDs

Status: ACCEPTED by independent critical plan reviewer `stale_alert_plan_review`
(Astra/high), with the actual PostgreSQL regression clarification below. The lead reports deployment
and successful CI for `c293b7f`, with fast reconciliation and no stale-alert recurrence,
but no observed periodic capture skips. Source inspection identifies a concrete
representation mismatch: `reconciliation/repository.ts` returns the raw BIGSERIAL
`id` from `pg` under a TypeScript number annotation. At runtime this can be a decimal
string. `readPeriodicProof` currently compares `Number(row.id)` with the unnormalized
caller ID, denying that otherwise eligible proof. The diagnostic emitter likewise
omits a string run ID because `Number.isSafeInteger` rejects it. These findings do
not establish the original broker timeout cause or complete operational acceptance.

Normalize run IDs only at the new periodic-proof and diagnostic-emission boundaries.
Accept a number only when it is a positive safe integer. Accept a string only when
it is canonical positive decimal text (`^[1-9][0-9]*$`), converts to a positive safe
integer and round-trips to exactly the same decimal text. Reject zero, negatives,
fractions, NaN/infinity, whitespace, signs, leading zeros, exponent/decimal notation,
empty or nonnumeric text, other types, and values above Number.MAX_SAFE_INTEGER.
Normalize both the requested ID and returned latest-run ID before comparing them;
invalid or unequal IDs return no periodic proof. This does not change any existing
account/session/generation, CLEAN/complete capture, accounting, hold, acquisition-age,
monotonic scheduler-age or explicit/fresh capture condition. Diagnostic run IDs use
the same conversion, emit only a numeric safe integer, and omit invalid input.
Request IDs, generations, sanitized original causes and privacy filtering retain
their existing contracts. Do not alter repository ID behavior globally, install a
PostgreSQL type parser, broaden numeric coercion, or change persistent schemas.

Ownership: `stale_clock_readonly` implements the boundary normalization and focused
tests under this accepted contract (requested/actual Astra/high); the lead integrates,
records release evidence and performs authorized deployment verification. This
amendment author edits only this plan. A different independent Astra/high reviewer
must accept implementation before publication. Permitted source is periodic-proof,
phase-diagnostics and a small shared run-ID validator if needed, plus their tests;
no scheduler safety-policy rewrite or lifecycle/notification-policy change.

Acceptance requires the actual production periodic-proof predicate to accept a
canonical PostgreSQL string caller ID with the matching database ID, and preserve
positive numeric input. An isolated PostgreSQL regression must obtain an actual
`pg` BIGINT/BIGSERIAL string and feed that value through the actual
`readPeriodicProof` predicate with otherwise valid evidence; a mock string or
TypeScript cast alone does not satisfy this runtime-boundary acceptance. Mismatched IDs and every invalid/oversized/noncanonical
category must deny proof. A diagnostic fixture must show the same canonical string
emitted as a safe numeric run ID, invalid values omitted, and existing configured
secret/account redaction unchanged. Retain all existing periodic freshness/failure
and explicit/fresh tests. Run focused regressions, required repository lint,
typecheck, unit/integration suites, build and clean Docker build; publish the reviewed
follow-up commit and verify CI for that exact commit. The report must distinguish
`c293b7f` deployment from the follow-up commit/CI/deployment evidence. Authorized
postdeployment observation must demonstrate at least one actual periodic skip with
a safe run ID and preserved current account/observer/accounting health. Fast runs
or an absence of alerts alone do not satisfy that final acceptance requirement.

### Completed-order timeout localization amendment

Status: ACCEPTED by independent critical plan reviewer `stale_alert_plan_review`
(Astra/high), including socket-factory rejection and shutdown-fenced fixtures.
The lead reports `798ff70`
CI and deployment at 12:05 UTC, six verified periodic reuse skips, and two subsequent
approximately eight-second completed-order source timeouts with BROKER_STATE_STALE
and SUPERVISOR_FAILURE. Accounting clock phases were fast in those episodes. The
existing adapter phase identifies the source but cannot distinguish its internal
waits. Thus periodic reuse is demonstrated; stale-alert runtime acceptance is still
open. The separate Marketaux article-coverage blocker is outside this amendment,
and entry remains paused under the lead's existing operating decision.

Source: CompletedOrdersClient serializes load calls, includes queue wait in the
original deadline, creates a fresh socket, waits for nextValidId and managed-account
validation, calls reqCompletedOrders(false), waits for completedOrdersEnd, then waits
for confirmed disconnect before settling. Shutdown uncertainty fences subsequent
loads. Installed @stoqey/ib 1.6.10 encodes the request with message ID 99 and decodes
completedOrdersEnd from message ID 102. None of these facts identifies the observed
timeout's internal stage; broker pacing or reconnect delay must not be asserted
without evidence.

Add bounded, optional internal diagnostics using the existing phase emitter and
configured privacy closure. Correlate with the safe reconciliation run ID when
available and a positive, local capture identifier for individual queued loads;
the latter is not a broker request ID. Record monotonic elapsed timings/milestones
for enqueue, dequeue/queue wait, connect call, validated nextValidId, managed-account
request/validated response, completed-order request call, allowlisted public SDK
`sent` with first token 99, optional first socket ingress (metadata only), first
validated decoded completed-order row (at most one milestone), decoded end,
disconnect request, confirmed disconnect and terminal settlement. Observe only the
first message-type token of `sent`; never scan received tokens for 102, since data
fields or fragments are not necessarily a decoded message boundary. Never emit
payloads, account lists,
order/execution records, host information or raw socket frames. A `sent` event is a
local socket-write attempt, not broker acknowledgement. A first-ingress milestone
is not a decoded message, completion or source coverage. Only the existing semantic
completedOrdersEnd callback establishes the observed end milestone. Missing SDK milestones stay unknown.
Do not log per completed-order row or introduce unbounded per-request trace storage.

Every failed load must identify the last reached stage and elapsed queue/read/shutdown
time, including rejection before a socket is created. Derive a stable waiting-stage reason from existing readiness/request/completion
flags and diagnostic-only milestone flags. Distinguish waiting for queue, nextValidId,
managed accounts, local request write, first completed-order response versus end, and disconnect
confirmation; if a write observation is unavailable, name that uncertainty rather
than infer delivery. Keep both the initial failure and any later shutdown failure
visible in separate bounded events so disconnect-result replacement cannot erase
the originating timeout. For thrown connect/request/callback/disconnect errors and
fatal SDK errors, preserve the actual sanitized original name, code and message;
retain numeric SDK codes when supplied separately. Never fabricate original details
for a timeout, abort, disconnect or internal validation result. Informational SDK
codes remain informational. Diagnostics exceptions must never escape or alter the
source result, and all new listeners must follow the existing capture cleanup and
late-event isolation rules.

This is instrumentation only: no changes to queue serialization, queue/deadline
semantics, eight-second source budget, shutdown timeout/fence, request ordering or
count, fresh-socket behavior, account/record validation, completed-end requirement,
returned source results, coverage classification, accounting, notification policy,
watchdog threshold, retries, caching or entry guards. A behavior fix requires observed
stage evidence and another bounded plan amendment/review. No broker stress test or
extra operational request is authorized by this document.

Ownership: `stale_clock_readonly` implements CompletedOrdersClient diagnostics and
focused tests (Astra/high), with minimal optional request correlation/adapter/index
wiring and existing diagnostic metadata changes if necessary. This author owns the
plan only; the lead assigns disjoint wiring ownership, integrates checks/report and
performs authorized observation. A different independent Astra/high implementation
reviewer must accept the final diff. Preserve unrelated work and all existing tests.

Acceptance fixtures cover queue expiry and queued abort without socket creation;
socket-factory rejection and connect throw; missing nextValidId; missing/mismatched managed accounts; request throw;
request call with no observed write; observed write with no end; socket ingress without
decoded end; successful end/confirmed disconnect; unexpected disconnect; shutdown
throw/timeout after an original failure; informational versus fatal SDK errors; and
late events after settlement and subsequent shutdown-fenced loads. Preserve an
existing promise rejection as rejection rather than converting it to a source
result. Assert exact stage/correlation and finite nonnegative
elapsed values, original sanitized causes, configured secret/account redaction, no
payload leakage, bounded event count, unchanged results/request counts and listener
cleanup. Re-run completed-order unit/integration, adapter and diagnostics suites,
then required repository lint/typecheck/unit/integration/build and clean Docker build.
Record independent acceptance, follow-up commit and exact CI/deployment evidence.
Authorized runtime observation must localize the next naturally occurring completed-
order timeout to its observed stage and preserve current health/alert evidence. If
no failure recurs during the stated observation window, report that limitation;
absence of alerts alone does not prove the underlying timeout fixed or close this
ongoing recovery task.
