# Automatic continuous Paper startup and recovery

Date: 2026-10-28. Status: CORE A/B/C + lead integration ACCEPTED by independent
`automatic_startup_plan_review` (Astra/high), 2026-10-28. D and E are also accepted
under their separate capability and WSH recovery contracts. This is plan acceptance,
not implementation or operational acceptance.
Plan author: `automatic_recovery_architecture`, requested/actual
`gpt-6-astra` / high. This document authorizes no deployment by itself.

## Owner outcome and superseded behavior

Implement one start procedure for continuous Paper PKO and AAPL, one whole long
share and at most one open position per instrument, with the existing USD5/day AI
budget. Services automatically synchronize after PostgreSQL, TWS or process
failure. Accounting `ACTIVE` rows, interrupted read-only recovery operations and
old cleanup markers must not create permanent manual-recovery requirements.
Routine TWS restarts and a recurring seven-day operator qualification ceremony
are removed from the supported path. Diagnostics and synchronization continue
while a capability, market, account, research or trading guard prevents entries.

The owner explicitly supersedes earlier manual-reset/flat-only recovery policies.
This does not authorize fabricated source coverage, erased history, replays of
unknown order/model submissions, changed strategies, Live activation, new
subscriptions or restarting TWS as a recovery shortcut. Existing operator pause
survives restart. Existing adopted recurring authority is retained; the start
procedure does not create a new authority or silently undo a pause.

The [continuous-operation plan](CONTINUOUS_PAPER_OPERATION_PLAN.md) remains the
business contract. This plan changes its recovery and qualification mechanisms,
not strategy evaluation, risk limits, business responsibilities or the distinction
between released code and real Paper round-trip/soak evidence. The old deadline
UX package is not resumed. Preserve its dirty files and all unrelated ES and
signal-engine work. Work on main, with scoped staging only.

## Observed implementation and architectural decision

`AccountingSourceOwner` currently takes an endpoint-specific PostgreSQL session
advisory lock, but refuses a prior `ACTIVE`/`UNKNOWN` row even when that lock is
free. `AccountingSourceStore.transaction` already locks/checks the owner row and
checks the current source process session. The collector exposes only managed
accounts, clock and execution reads. It does not submit, modify or cancel orders.
Its transport closure assertion is therefore an observation-lifecycle guarantee,
not a broker-write authorization mechanism.

`index.ts` awaits accounting initialization before listening; a source-owner
failure currently removes the entire execution HTTP service. A lost dedicated
owner connection permanently invalidates that service instance. Clock recovery
has process-change and attempt-count paths to `OPERATOR_REQUIRED`. The legacy
owner-recovery protocol requires a local TWS reset and rejects any bot trading
history. WSH cleanup similarly prevents later acquisition after unknown local
closure, although the old read reservation remains recorded.

**Decision: distinguish durable read-source ownership from physical socket
closure.** Automatically transfer the former using the existing PostgreSQL
session lock plus a new durable generation and immutable handover receipt. Never
assert that the old process/socket is dead. Reject its later observations and
publication. A simultaneous old read socket cannot place an order; IBKR client-ID
collision is an observable retryable availability problem. The old process must
locally revoke its owner forever on lock loss and stop reconnecting under that
owner. A fresh owner is a fresh object and generation.

A Docker-privileged supervisor, signed host death certificates, Docker socket
mount and routine TWS replacement are not required for this safety boundary and
are outside this implementation. Normal killed/crashed containers lose their
sockets; Compose can restart them. A pathological indefinitely suspended foreign
process occupying an API client ID may still prevent connection. Diagnose the
actual client-ID conflict and keep retrying; do not claim arbitrary foreign
process termination or guaranteed recovery while the broker itself is unavailable.

The execution socket is a separate broker writer. Read-source handover does not
resolve any execution attempt. Before accepting this design, hostile tests must
prove that old entry, close, cancel and reconciliation continuations cannot use
new-source evidence or replay a durable unknown dispatch. Add source-generation
admission fencing to missing mutation boundaries as described below; do not infer
broker-write exclusivity merely from a read-source advisory lock.

## Immutable invariants

1. Every accepted accounting observation/capture belongs to exactly one current
   owner tuple `(endpointKey, ownerId, generation, processSessionId)` and exact
   account/settings identity. A successor invalidates all previous capabilities.
2. PostgreSQL advisory-lock ownership is required for acquiring a generation.
   Expiry, heartbeat age, an empty query result or a fresh TWS handshake alone
   never establishes ownership or physical death. The database session lock is
   checked on the dedicated connection; lost owners never revive.
3. SQL owner/source row locks fence old writes through transaction completion.
   A transaction holding the predecessor row lock commits before handover or
   fails; it cannot append/publish after handover with the successor capability.
4. No owner-handover or source-repair operation changes proposed-order attempts,
   order IDs, permIds, executions, lifecycle ownership, budget debits, operator
   pause, AI bindings or unknown submission markers.
5. Observation and recovery are available with master writes disabled and with
   existing supported positions, working protective orders and trade history.
   Recovery performs no broker order mutation. Genuine unresolved exposure still
   holds new entries and follows existing lifecycle reconciliation.
6. Read acquisition uncertainty may be retired as unreadable/unknown, never
   relabelled successful or physically closed. New acquisition uses a new identity
   and existing pacing/budget. Unknown order or model calls keep their stronger
   no-replay rules.
7. Qualification must state what machine evidence proves. Empty replay completion
   does not prove retention, master-client settings or execution timezone.

## A. Retrying runtime and service availability

Add `apps/execution-engine/src/accounting/source-runtime.ts` as a stable facade
for the methods currently consumed from `AccountingSourceService`. It owns a
single current service generation; each inner service has its own store, owner,
collector, queue and maps. Its source `processSessionId` is a new UUID per inner
generation, distinct from `EXECUTION_PROCESS_OWNER_ID`; execution identity remains
separately bound in the barrier. Never assign a new owner to a store still referenced
by a predecessor persistence queue. Capture the inner generation before any
async delegate call; reject its result when the facade generation has changed.
Callbacks also capture the inner generation and cannot forward stale ingress.

Freeze exported structural `AccountingSource` consumer interface in
`source-service.ts`: readonly `settings`, `settingsHash`; `status`, `assertCurrent`,
`observeIngressFailure`, `observeOrderStatus`, `observeExecution`,
`observeCommission`, `inspect`, `qualify`, `invalidate`, `join`, `readCapture`,
`refreshRecoveryState`, `recoveryDatabaseTime`, `verificationExpired`,
`recoveryIdentity`, `requireRecoveryOperator`, `automaticRecovery`, `recoverClock`.
Signatures match the current public service methods. Add
`assertRuntimeOwnerCurrent(): void` and
`assertRuntimeOwnerInTransaction(db: Pick<PoolClient, "query">): Promise<void>`.
`status` retains the existing `automaticClockRecovery` field even while no inner
service is initialized, plus a separate runtime status. The facade owns
`initialize/start/close`; do not expose its replaceable store/collector publicly.
Its `onOwnerLost` callback lets composition immediately revoke/disconnect execution.
Routes/coordinator/adapters depend on this structural interface, not private
class members. Existing `ib-broker-adapter` already retains independent exposure
when accounting join fails; preserve and test that behavior rather than rewrite.

The controller states are `WAITING_DATABASE`, `ACQUIRING_OWNER`,
`CONNECTING_SOURCE`, `QUALIFYING_SOURCE`, `SYNCHRONIZING`, `READY`, `BACKOFF`,
`CAPABILITY_UNAVAILABLE`, `STOPPING`. A status snapshot includes state, generation,
last successful capture time, sanitized original cause, next retry and precise
entry-blocking reasons. `CAPABILITY_UNAVAILABLE` keeps periodic discovery and
read-only diagnostics alive; it is not an irreversible local terminal state.

One initialization/recovery job at a time. Use a monotonic deadline for each
attempt, bounded SQL/connect deadlines, and retry delays 1, 2, 5, 10, 30 seconds,
then 30 seconds with bounded jitter for database/connectivity failures. No timer
creates work after stop. Abort an old attempt and fence its callbacks before
starting the next; an unresolved old promise cannot publish later. Owner loss
immediately removes locally usable captures and blocks write admission, stops
collector reconnect and cancels the generation's work. Recover by creating a new
inner service, not clearing its failed flags.

Initialize migrations/configuration with bounded retry on transient database
availability failures. Before the schema is valid, process logs expose startup
state and retry time; existing HTTP routes need not be available yet. A migration
checksum/schema-integrity failure remains an explicit configuration hold until
the cause changes; do not repeatedly apply a known-bad migration. No broker work
or handlers can run against an unvalidated schema.

After schema/config initialization, register the existing authenticated HTTP
routes and listen independently of accounting owner/source initialization. The
minimal runtime status is added to existing diagnostics; no second web server or
operator interface is introduced. `/health` means alive; readiness remains false
while existing gates fail. Once running, a later DB outage must leave HTTP alive,
with structured unavailable responses on DB-backed routes and safe write denial.
Auth/correlation stay unchanged; audit persistence failure never grants write
permission. Attach pool `error` handlers to operational and diagnostic pools and
catch background persistence failures; direct clients retain error/end ownership
handlers. Service initialization or logging must not create unhandled rejections.

Once schema/config initialization succeeds, start observer/synchronization work
independently of accounting qualification. Reconciliation may publish a complete
exposure snapshot with accounting unavailable, but never a falsely complete
entry/account-day proof. Audit code that currently aborts all observation when
accounting join fails and retain its independently valid position/order evidence.
Lifecycle actions still require their exact existing evidence and risk contract.

## B. Durable owner handover and legacy maintenance

Allocate additive migration `000041_automatic_read_source_recovery.sql` (recheck
that number before writing). Extend `accounting_source_owners` with nullable
`process_session_id` and `settings_hash` for legacy compatibility; new acquisitions
require both. Add:

- `accounting_source_handovers`: UUID primary key, unique `(endpoint_key,
  successor_generation)`, predecessor owner UUID/generation/state/session/hash
  snapshot (whole predecessor null only for initial creation; legacy session/hash
  nulls retained with derivation evidence), successor UUID/generation/session/
  hash, account, database timestamp, reason enum `INITIAL`, `CLEAN_RELEASE`,
  `READ_SOURCE_FENCED`, optional legacy operation UUID, and canonical record hash.
- `accounting_read_recovery_dispositions`: UUID primary key, unique predecessor
  kind/id plus predecessor fingerprint, exact endpoint/account/source identity,
  successor handover UUID, reason `READ_GENERATION_SUPERSEDED`, database timestamp
  and canonical hash. Used for old owner maintenance/clock read operations only.

Acquisition algorithm on the dedicated session: acquire the existing advisory
lock; begin transaction; lock the maintenance row and exact endpoint owner row;
validate current account/settings identity; snapshot predecessor; insert handover
and generation+1 owner update atomically; commit; only then expose the capability.
A free lock permits replacement of `ACTIVE`, `UNKNOWN` or `RETIRED` in this new
explicit read-source recovery policy. Do not change the predecessor into a false
`RETIRED` assertion: the immutable receipt records its real old state and that
only publication authority was transferred. Initial insert is generation1.

Serialize source begin/invalidation with the owner update. Increment semantic
revision, set gap true and clear current capture; keep execution/commission
history. A matching static qualification is not itself permission to publish a
fresh capture; section D applies. Failed/unknown commits resolve by exact UUID and
owner tuple on the next connection. Never increment again just because the reply
was lost; acquire/resolve APIs use stable attempt UUID until resolved.

`assertInTransaction` must validate process session/settings as well as existing
owner/generation. Use exact owner-row lock order consistently to avoid deadlocks.
Old `retire`, `activate`, `release`, gaps and queued appends cannot update a
successor tuple. On acquisition failure destroy the dedicated connection rather
than returning its advisory lock to the pool.

Legacy owner identity with NULL new fields is derived only from a unique
`broker_accounting_sources` record matching the configured account/settings and
endpoint settings, corroborated by any pending operation's exact profile and
owner tuple. Preserve the derivation evidence in the handover. Conflicting or
ambiguous records reject takeover; the configured account is never simply stamped
onto an unrelated legacy row. Historical source sessions are evidence, not proof
of a physical container identity.
Accepted amendment (independent reviewer `automatic_startup_plan_review`): a
validated installed source configuration may change settings hash for the same
Paper account and canonical endpoint. Validate the predecessor hash independently
against retained owner/source/pending-profile evidence, record both hashes, and
compare pending profile to the predecessor hash. Atomic handover invalidates
predecessor capture/current qualification on hash change, increments semantic
revision and updates source-session identity; history is immutable. A legacy
hash-change with no pending profile needs its retained qualification's exact
endpoint/account/settings evidence. Conflicting/foreign identities are rejected.


Legacy pending owner recovery is handled as read-operation supersession, not a
fabricated old reset receipt. Under the same lock, validate the pending operation
exists, matches exact endpoint/account/owner generation and its canonical record;
append disposition referencing that full snapshot and new handover. Add a distinct
terminal `AUTO_SUPERSEDED` operation/event state and immutable disposition UUID,
not the existing `SUPERSEDED` state that requires a successor old-protocol
operation. Amend the versioned SQL state/record checks, transition/event binding
functions and deferred consistency trigger from migrations000038/000039: permit
only PREPARED/OBSERVED -> AUTO_SUPERSEDED with exact disposition+handover linkage,
matching owner/profile and one event; terminal state is immutable; prior evidence
digest and all original binding fields remain unchanged. Clear only that matched
pending pointer in the same transaction. Preserve every existing COMMITTED
receipt/reset-proof consistency condition unchanged. Update shared parsing/status
to expose this terminal disposition, without accepting it as a reset/retirement
receipt. Keep old events/probe evidence unchanged. Pending unknown/foreign/
corrupt operations remain an explicit integrity/capability error, not a blanket
DELETE or pointer reset. An expired matching PREPARED/OBSERVED operation and
unknown *read* probe dispatch are eligible; no flat-account or no-history test.
Legacy one-shot observers cannot finalize after their maintenance pointer/owner
changes because their exact assertions fail. Tests must cover that race.

## C. Execution continuity and clock recovery

Before source handover can permit entries, reconcile account-scoped positions,
open/completed orders, executions and known lifecycle records with fresh source
identity. Preserve completed cycle fingerprints and ownership across history.
Automatic recovery supports an existing protected PKO/AAPL share and previously
completed cycles. Rejoin existing lifecycles; do not adopt arbitrary foreign
positions or reconstruct new ownership from conId alone.

Introduce a qualification-independent `assertRuntimeOwnerCurrent` capability
at the execution composition boundary. It proves current owner/session and local
runtime generation, not research eligibility. It guards entry final-send and
close/cancel final-send as applicable, in addition to their existing deterministic
risk, environment, account and durable reservation checks. Audit all direct
`ib.placeOrder`/`ib.cancelOrder` sites in `tws-execution-client.ts`, including the
ordinary cancel path. Existing entry permit and close repository transactions
must validate the exact owner tuple before creating dispatch/cancel markers.
All three mutation sites are in scope: each `placeOrder` in the bracket loop,
`cancelOwnedOrder` and ordinary `cancelBrokerOrder`. Keep the ordinary cancel's
existing authenticated master-switch exemption; its ownership/account/runtime
checks still apply. Check capability synchronously immediately at each send; no
await between the final local invalidation check and that send. The guard checks
exact source generation plus a current monotonic owner proof; it never demands
research qualification for a close/cancel. Hold an exact owner-row SHARE lock
in the existing dispatch-permit transaction through the synchronous broker call;
add equivalent bounded permit plumbing for close/cancel. Source handover takes
the conflicting owner-row lock, with a documented consistent lock order relative
to existing account/snapshot/close locks.

Independent review clarification: ordinary cancel-proposed does not currently
have a separate durable cancellation ledger or a permId input. Preserve its
existing behavior, account/auth guards and master-switch exemption; do not add a
new cancellation lifecycle in this recovery package. Capture the runtime/broker
origin before the route's asynchronous order lookup and when scheduling automatic
cancellation, carry its DB/runtime permit through final send, and reject old-origin
acknowledgements. An unconfirmed ordinary cancel remains explicitly unconfirmed
and requests reconciliation; recovery never replays it. Existing full-close
cancel markers and their durable unknown state remain unchanged. Exact owner
transaction checks apply to existing entry/full-close markers, while the ordinary
cancel uses the bounded final-send permit without claiming a new durable marker.

On owner loss, invalidate local write capability and immediately disconnect the
execution transport as well as the accounting collector. Its automatic reconnect
path is gated by a current runtime owner and new identity/synchronization. A
predecessor callback cannot restore connected/write-ready state. Source recovery
may reconnect observation while new writes remain gated by reconciliation. Do not make an expired research
qualification a new reason to remove otherwise supported protective supervision.

There is no claim of atomic distributed fencing between PostgreSQL and IBKR.
The DB session can fail after a valid dispatch reservation and before its failure
notification reaches the process. A previously reserved synchronous broker send
may therefore occur once after DB lock loss; source handover does not prove it
cannot. It remains an unknown durable attempt and cannot be resubmitted or
forgotten. The successor cannot clear it merely because no order is yet visible;
only the existing matching broker-terminal proof can resolve it. If that proof
is unavailable, retain the hold and keep diagnostics/reconciliation running. The
successor may observe it but may not release its reservation based solely on owner
handover or a momentarily absent order. Inject pauses at every durable-marker/
broker-send/commit boundary in tests. If existing semantics cannot satisfy this,
stop and revise that critical contract before implementation continues.

Clock repair becomes read-source recovery with durable backoff, not a three-try
operator ceremony. Keep existing episodes, attempt counts and original causes.
When an old `RECOVERING`, `VERIFYING`, `OUTCOME_UNKNOWN` or restart-generated
`OPERATOR_REQUIRED` episode is superseded by a new read-source generation, append
its disposition. Do not rewrite its old attempt as successful. A new clock
inspection and fresh capture may complete the new recovery episode only after
currentTime, identity, replay, persistence barriers and clock sanity pass.

Retry transient clock skew/connection failures with bounded exponential backoff
up to five minutes, without resetting hourly request accounting. After a wall or
DB time discontinuity, discard the local time baseline, wait for a stable
monotonic observation interval and take new evidence; never extend a deadline
using the discontinuity. Permanent correction/identity/corrupt-accounting holds
remain separate. Invalid or future broker clock values can keep entries blocked,
but must not stop HTTP or read-only exposure synchronization.

## D. Automatic source qualification: required capability gate

Current `ibkr-tws-seven-day-v1` stores manual product/build, Trade Log seven-day,
Master client0 and execution-timezone artifacts and gives them seven-day expiry.
Installed `@stoqey/ib`1.6.10 does not implement every current IBKR API capability.
Existing automatic `brokerTime-48h` certification relies on that qualification;
it cannot simply be retained after deleting the expiry check.

Implement a versioned, generation-scoped machine qualification, leaving v1
historical bytes/hashes readable. Required evidence is:

- exact endpoint/account, current API protocol and adapter capability identity;
- positively established account-wide execution scope (Master client setting or
  an equivalent documented request capability), with exact request parameters;
- positively established requested history interval covering the recovery floor
  and current Warsaw account day, explicit completion and commission joins;
- unambiguous normalization of each actual execution timestamp; a historical-data
  timezone switch is not evidence of execution timestamp timezone;
- broker/database clock sanity and unchanged connection/runtime generation.

New evidence has no arbitrary seven-day operator expiry. It is valid only within
its exact connection generation and capture freshness limits; restart, disconnect,
settings/capability change or contradictory data requires automatic reacquisition.
Qualification never extends coverage beyond what the request/protocol establishes.
An actual outage older than available broker replay/retained evidence remains a
specific coverage gap; DB data loss is not the same as a recoverable DB outage.

D is a separate package: D0 does not block independent A/B/C/E implementation
and acceptance. The full startup/automatic qualification outcome still depends
on D and actual supported broker capabilities.

**D0 is a bounded implementation prerequisite for D, not a promise of support.** Inspect
the current broker's API version with a read-only capability probe and verify
exact official protocol encoding/installed adapter support. Current IBKR documents
`reqConfigProtoBuf`/`configResponseProtoBuf` since API10.44 and explicit execution
`lastNDays`/`specificDates`; do not assume this TWS version or adapter supports them.
A concrete candidate is the official IBKR Python SDK10.51.1, protobuf5.29.5,
wrapped as a bounded read-only stdin/stdout child of the TypeScript accounting
collector. The official1051.01 archive checksum observed by capability research is
`50a459ed09f0030df25125a177e57b69bdf576ec3a89fcb1f81fdff95bbf6316`. Its execution-date
filter requires server protocol200; config reads require219 (config writes221
are excluded). The installed TypeScript adapter caps negotiation at193, so merely
adding fields to its filter cannot work. Finalize packaging/license/pinned build
and exact request/response JSON limits in the D contract, with golden fixtures.
Only accounts/currentTime/config/executions/commission callbacks are exposed; no
order write method or arbitrary method dispatch. The current private evidence
reports TWS10.51.1b, which makes this route plausible, not proven by a live
capability handshake. A child has the same per-generation fencing and closure
semantics as the existing collector; process failure cannot publish stale output. Do not add configuration-write requests. Relevant official sources:
[setting management](https://www.interactivebrokers.com/docs/tws-api/doc/setting-management)
and [API settings fields](https://www.interactivebrokers.com/docs/tws-api/protobuf/api-settings-config).

If current TWS lacks the necessary request, a narrowly specified automatic local
settings/UI reader may be proposed using the owner's existing IBKR-UI permission;
it needs its own exact supported controls/host identity contract and independent
review. It may not invent unavailable metadata or transform a screenshot into a
claim of historical coverage. Until a concrete supported route is accepted, D is
blocked and the complete owner outcome cannot be called delivered. Configured `Europe/Warsaw` is the owner's accepted execution-timezone setting;
use it under an explicit supported protocol timestamp contract. Do not create a
new requirement to inspect unrelated TWS settings. Timestamp ambiguity or a
contradictory explicit zone still blocks the affected accounting evidence. Simply
renewing old artifact dates or inventing retention remains prohibited.
The rest of recovery must still operate and explain the exact missing capability.

## E. Research/WSH recovery coordination

Extend the existing durable WSH endpoint/session/acquisition generations rather
than resetting the TWS process. Add an immutable `WSH_READ_GENERATION_SUPERSEDED`
receipt in the existing recovery subsystem binding exact endpoint, predecessor
attempt/acquisition IDs+hashes, configuration/manifest/account, successor endpoint
generation, database timestamp and next legal acquisition time. Preserve the old
`UNKNOWN` outcome, `verifiedLocalClosure=false`, charged budget/pacing rows and
all historical observations. A supersession is not a closure receipt.

Under the endpoint/account locks, fence all predecessor result publications and
new reservations, mark their execution authority retired and advance endpoint
generation exactly once. A later eligible regular slot gets a distinct session,
request identity and existing budget reservation. No same-slot replay, borrowed
new identity for the old request, or model-call retry. Delayed old read sends
already reserved before invalidation may complete and remain charged; discard
results from the retired generation. Client-ID conflicts and broker WSH duplicate
request responses are bounded BUSY/unavailable outcomes, with existing pacing.

Accounting recovery never acquires WSH ownership implicitly; each controller has
one bounded operation and its existing endpoint locks. Both may observe a shared
broker disconnect and independently reconnect only their own clients. Preserve
supported source-validity policies and currently configured entitlement evidence.
Existing PREPARED WSH `research_recovery_challenges` must be superseded in the
same endpoint transaction. Add a separate immutable `research_read_supersessions` table and distinct
`AUTO_SUPERSEDED` challenge terminal state bound to the exact challenge hash and predecessor set; preserve its evidence and
prevent later manual commit by state/generation CAS. Amend the existing challenge
transition/deferred-consistency checks to require its supersession row; retain
COMMITTED reset-receipt constraints unchanged. Never reuse the old WSH reset
receipt schema, which requires physical closure and an operator-observed restart. Follow the existing research
recovery lock order; acquire the endpoint fence and exact challenge locks before
retiring predecessors. An unrelated or mixed Marketaux challenge must never be
cleared: scope-match every challenge/predecessor and retain the existing Marketaux
recovery contract. Unknown/corrupt challenge identity remains a diagnosed error.

Metadata/permission changes cause explicit source requalification/eligibility
failure, not automatic entitlement claims. Marketaux/provider/model unknown
semantics outside this WSH read contract remain unchanged.

## Implementation ownership and dependencies

The first independently reviewable implementation tranche is A/B/C plus lead
integration and its tests. D and E can be reviewed/implemented separately; neither
blocks beginning the accepted core tranche. Core completion is reported as a
partial delivery, not completion of the owner's full automatic startup outcome.

Every worker reads AGENTS and this accepted contract, reports exact changes,
commands/results, failure cases and unresolved risks, and stops on contract change.
Requested/actual model and effort, repair count, elapsed time and available token
usage go into the final report. All packages below are critical, Astra/high.
Independent plan and final reviewers are different agents and neither reviews
its authored code. No parallel writers share files or migration numbers.

| Package | Permitted source scope | Dependency and evidence |
| --- | --- | --- |
| A/B/C core owner | `accounting/source-owner.ts`, `source-store.ts`, `source-service.ts`, new runtime facade, clock recovery files, accounting types, migration000041, associated tests | Reviewed plan; transactional fencing and delayed predecessor fixtures before wiring |
| D capability | accounting config/collector/qualification adapter and tests; distinct qualification migration if needed | D0 protocol contract first; no invented positive capability fixture presented as real support |
| E WSH | `packages/shared/src/instrument-research/{store,wsh,wsh-refresh,startup-recovery,recovery-diagnostics}.ts`, `apps/llm-agent/src/research-wsh-*`, distinct migration and tests | Reviewed exact supersession contract; keep cost and pacing unchanged |
| Lead integration | execution `index.ts`, accounting/reconciliation route and adapter type wiring, Tws mutation guards, close/entry repository fence plumbing, compose/start command, diagnostics, docs | Core interfaces frozen first; shared files only lead edits |
| Final independent review | Full integrated scoped diff, failure fixtures, this plan and report | Different Astra/high reviewer; no deployment/publication while unresolved |

Do not split D config/collector files concurrently with A/B/C source edits without
explicit file handoff. Allocate subsequent migration numbers centrally. Start
procedure reuses Compose and existing configuration files; include one documented
`pnpm` command that starts dependencies/services, waits for authenticated runtime
status and prints READY or continuing recovery with reasons. It does not open a
second source client, launch an old recovery CLI, delete containers/TWS state,
resume durable pause, or require the web UI. Avoid a blocking start command that
turns a temporary data gap into service shutdown. Use direct Node entrypoints or
verified signal forwarding for Compose termination; graceful drain and hard-kill
recovery must both pass.

## Acceptance and hostile validation

- PostgreSQL unavailable at startup: process logs show bounded retry and no
  broker work starts before validated schema. PostgreSQL lost after HTTP startup:
  health and authenticated runtime status remain available; no unhandled pool/client error; recovery
  automatically rejoins after DB returns. DB schema failure is explained precisely.
- Crash without graceful retirement leaves ACTIVE; next process acquires only
  after the advisory lock is truly free, advances exactly once and synchronizes
  without owner action or TWS restart. Old append/publish/retire/activate/release
  cannot mutate the successor. Same-process concurrent recovery is single-flight.
- Simulate predecessor event-loop suspension, DB session loss and late source
  callbacks after successor commits. Old callbacks cannot publish or provide
  entry evidence. Client0 conflict is visible and retryable, never claimed dead.
- Inject commit-response loss before/after owner handover and maintenance
  supersession. Exact UUID resolution returns the committed result or retries the
  uncommitted operation; no duplicate generation or cleared unrelated pointer.
- Existing matched expired maintenance operation with read probe dispatch is
  superseded with retained history; foreign/missing/corrupt operation rejected.
  A late legacy finalizer cannot retire the new owner. Include a fixture matching
  the currently observed expired PREPARED operation: a persisted pre-probe CLOSED
  event and a local post-handshake UNKNOWN result with no persisted dispatch.
  The absence of that dispatch is never fabricated into a closure proof.
- TWS outage/reconnect, process hard kill, Compose restart and read collector
  persistence failure recover without clearing trading authority, pause, history,
  unknown orders or USD5 AI accounting. UI is stopped during the integrated drill.
- Exercise flat account; one protected PKO share; one protected AAPL share; both;
  completed historical cycles; pending entry; pending cancel/close; unknown write;
  late execution and changed commission. Supported known exposure is rejoined;
  unknown/ambiguous broker actions are observed and held without replay.
- Freeze old execution at durable-marker/final-send/commit boundaries while
  handing over source generation. No stale evidence admission, duplicate entry,
  duplicate close, silent protection cancellation or reversal. Preserve existing
  broker-confirmed terminal proof obligations.
- Clock failures across >3 attempts, process replacement, time jump and retained
  old episode automatically retry safely. Correction and identity faults stay
  distinct; invalid clock cannot certify a capture.
- D golden wire/parser tests cover unavailable capability, malformed fields,
  mismatched account, missing completion/commission, timestamp ambiguity and
  generation change. Actual broker capability evidence is required separately.
  No positive qualification comes solely from empty execution replay.
- WSH unknown cleanup/crash retains charged old attempts, fences late results,
  respects endpoint concurrency and rolling pacing, and allows only a new legal
  regular acquisition. Two instruments and accounting recovery cannot race into
  duplicate reservations or uncontrolled reconnect loops.

Run targeted tests while implementing, then `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration` against isolated PostgreSQL, and `pnpm build`.
No destructive operational-DB fixtures. No strategy/simulator behavior changes
are planned, so no new backtest parameter tuning. Compose/startup changes require
a clean pinned Docker build and isolated production-wired restart/failure drill.

Update AGENTS, ROADMAP/current-state/continuous-operation status and the accounting,
research and continuous-start runbooks to explain the new read-fencing policy and
remove superseded recurring manual procedures from the supported path. Preserve
historical reports as evidence. Carefully integrate the pre-existing dirty
`PAPER_ACCOUNTING_SOURCE.md`; do not stage its unrelated deadline UX edits.

Write the implementation report, commit/push only the accepted scope on main and
verify CI for that exact SHA. Back up private configuration/DB before separately
authorized rollout. Real data capability and Paper execution/soak acceptance are
reported separately from fixture/build success. Do not call this complete while
D has no supported actual capability route, mandatory checks fail, final review
has findings, or exact-commit CI is unverified.

## Integrated runtime drill amendment: initial execution session hydration

The isolated Docker drill on 2026-10-28 found a startup race after HTTP was made
independent of source initialization. The one-time execution connect ran before
source ownership was available. Its rejection left the active account unset;
the reconciliation scheduler then skipped every tick because its context was
null. Accounting client0 could connect, but no reconciliation join ever requested
replay or automatic qualification. This is a startup liveness defect within A/C,
not evidence of missing broker capabilities.

A bounded execution-session recovery controller now hydrates the broker session
independently of the scheduler's nullable context. It uses the existing guarded
connection and account allowlist path, one in-flight attempt, a22-second bound
(connect12seconds plus managed accounts8seconds), and1/2/5/10/30-second retries.
Its current predicate requires a connected execution transport, a known account
and current source owner even when an old account ID is cached. The confirmed
account is bound to the exact execution connection generation; a successful
reconnect followed by a managed-account timeout remains unconfirmed and retries. Each account read
captures its source owner and execution connection generation; both are checked
again immediately before publishing the active account or starting a snapshot.
Timeout and shutdown disconnect the attempted transport, invalidating late
responses. Shutdown cancels the pending attempt/timer. A successful hydration
requests a fresh reconciliation; the existing scheduler maintains subsequent
observation. The redundant one-time startup hydration is removed.

Acceptance includes real AccountingSourceRuntime/TwsExecutionClient fixtures for
initial source unavailability, owner replacement with a cached account, stale
managed-account responses, single-flight execution, bounded retries and shutdown.
The isolated Docker startup/source qualification and restart drills must be rerun
with the resulting image; earlier stalled-source evidence remains in the report.
