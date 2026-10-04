# PP5 — Automatic lifecycle supervision and durable escalation

Date: 2026-10-04. Status: accepted by independent Astra/high reviewer after one
amendment/re-review round; reviewer authored no implementation.
Baseline: `4c94f737ecc041a9bb7f5929cbca707ac35f3393`, main.

Dependencies: [ROADMAP](../ROADMAP.md), [delivery PP5](PAPER_PRODUCTION_DELIVERY_PLAN.md#9-pp5--automated-protection-exits-and-recovery),
[routing](MODEL_ROUTING_GUIDE.md), [PP1 configuration](PP1_CONFIGURATION_CONTRACT.md),
[PP2 identity](PP2_RUNTIME_CONTRACT.md), [PP3 plan](PP3_IMPLEMENTATION_PLAN.md),
[PP3 report](PP3_IMPLEMENTATION_REPORT.md), [PP4 report](PP4_IMPLEMENTATION_REPORT.md).

## 1. Verified baseline and bounded scope

PP1–PP3 reports record accepted source/review/checks/CI. PP4 source is delivered,
but real-source research acceptance remains blocked. Original configuration and
AI attribution, one-share stock capability, immutable attempts, account reservation,
audited full-close and strict broker evidence are reused. No new entry authority,
strategy, research provider, quantity, repeated-entry policy or broker-write adapter
is introduced. PP7 scheduled budgets remain denied. No deployment, activation,
operational DB, real broker action, provider request or real alert recipient is used.

The 25 unrelated dirty paths are inventoried with SHA-256 in the local
`/private/tmp/pp5-delivery/baseline.json`. They include ES diagnostics, simulator,
backtest manifest and legacy `signal-engine.ts`; preserve byte-for-byte and exclude
from candidate/publication. Work on main, no PR or branch.

FullCloseService already persists reservation, cancel intent, terminal acknowledgement,
close proposal and dispatch marker. Its reconcile operation is observation-only.
The missing pieces are automatic scheduling, pinned session deadline, durable entry
pause/health fence, exact protection shape and durable alert delivery status.

## 2. Permissions and migration (PP5-A)

`TRADING_ENABLED` retains its existing meaning: new entry and full-close writes
require true. Existing authenticated cancel/reconciliation exemptions remain.
Introduce `EXECUTION_ENTRIES_PAUSED` (strict boolean, default true) as a startup
ceiling, plus an account-scoped durable pause initially true with append-only
actor/reason/time audit. Starting with false never clears a persisted pause.
Authenticated exact POST `/execution/entry-control/pause` sets the pause even when
master writes are off. `/execution/entry-control/resume` requires master writes on,
startup ceiling off, known allowed Paper account, healthy lifecycle observations,
available critical-alert transport, fresh complete current reconciliation and all
existing configuration/research gates. This does not authorize an entry or reset
budgets. Read-only status reports configured ceiling, durable pause, faults and
readiness separately. PP6 UI is out of scope.

Enforce entry control at service admission, proposal/reservation boundaries and the
final dispatch permit. Pause mutation and entry reservation/send share the existing
account lock, with DB-time health recheck after waits. An entry already synchronously
sent before pause wins cannot be retroactively cancelled; all subsequent sends fail.
No unknown/attempted proposal becomes retryable. DB failure denies entries. A process
local failed-observer flag also denies sends immediately until durable fresh health.
The close path never reads entry pause or new AI research. It retains Paper scope,
token/account guards, original ownership, deterministic risk and write master at
actual background/manual cancel and close dispatch, not just HTTP middleware.

Introduce additive migration22 for lifecycle state, migration23 for faults/delivery
and migration24 for pause/audit and entry fencing. Do not edit
released migrations or configuration hash versions. Rollout: disabled writes,
entries paused, migration, inspect original ownership, start observer, verify fresh
broker state/alerts, then separately authorize management/entry settings. To pause
entries while keeping close working use master=true + entries paused; master=false
still blocks close and emits a visible management-disabled fault if action is due.
Rollback cannot use an old image which ignores an adopted durable pause; keep master
off until a compatible supervisor manages outstanding ownership. Never delete holds.

## 3. Durable lifecycle and concurrency (PP5-A)

Observer runs at a fixed interval no slower than 5s, starts immediately, and never
overlaps its own cycle. Account-scoped PostgreSQL advisory serialization prevents
two observers; existing account locks and close reservation arbitrate manual/automatic
close and entry. Discover attempted entry ownership and unresolved closes from DB,
not a process cache or only SUBMITTED status. Include missing/orphan links/identity
as faults, never silently filter them away. Reconstruct after every restart using
original proposal/immutable management snapshot and fresh IBKR evidence. Removed or
disabled current assignments must retain management.

Persist latest evidence/run/generation, status, original identity, deadline and fault
references per original proposal. States distinguish PENDING_ENTRY, PROTECTED,
CLOSING, FLAT/terminal-unfilled, HOLD and unavailable. Only exact round-trip
or zero-fill terminal proof may establish final state. Missing commissions remain
accounting-pending; no new budget is released by this observer. Prior terminal rows
cannot conceal a newer contradictory broker position/order. Observe all unfinished
close states automatically without HTTP calls. Retain immutable terminal proof,
original IDs and economic/link fingerprint. Later legitimate owned proposals may
explain current exposure; do not reevaluate historical completion against their
position. Recheck terminal fingerprints and current broker rows referencing old
links; late fills/corrections/working orders reopen an incident. Account-wide
reconciliation and active ownership must explain current positions/orders.

Refresh positions and reconciliation before decisions. Reuse existing account-wide
reconciliation checks, instrument-scoped ownership and exact typed fills. Foreign
orders on the owned contract, unresolved account identities, quantities other than
0/1, stale/disconnected evidence and order-ID changes without supported exact proof
cause HOLD. Extend read-only open-order capture with order type, limit/stop prices,
total quantity, parent/OCA linkage and TIF where exposed by installed adapters.
PROTECTED requires owned exact SELL quantity1 TP LMT and SL STP with original prices,
valid linkage and live broker status, not merely a local bracket declaration.
Absent/mismatched shape is protection-unknown/gap, never assumed healthy.

Separate fast observation/fault watchdog from potentially slow broker refresh/close
work. Polling must not hide a stuck cycle: overdue evidence/work generates local
critical status within 15s and blocks entries. Persist DB errors when storage recovers;
while DB itself is unavailable use process-local critical logging/status and deny
writes that require audit. Do not claim durable persistence during a DB outage.
Shutdown stops timers, awaits in-flight work before disconnect/pool shutdown, and
does not cancel broker protective orders.

## 4. Session exit and safe fallback (PP5-A)

`EXECUTION_LIFECYCLE_AUTOMATION_ENABLED` defaults false; observer remains read-only
unless explicitly enabled with master writes true and known allowed Paper account.
`EXECUTION_EXIT_BEFORE_CLOSE_MINUTES` is an integer 15..60, default15. Persist the
effective policy, original config identity, exact broker session date/start/end and
derived UTC deadline per owned proposal atomically with entry attempt reservation,
before broker send. Final dispatch rechecks it and denies entries at/after the
deadline; PP3's fixed 15-minute margin is insufficient for a larger exit margin.
The session
is the one containing its original entry attempt, never an arbitrary next session.
Use the instrument's verified calendar identity and shared session validation:
early close and DST follow broker UTC intervals, no fixed wall-clock hour. Restart
retains the pinned deadline. A verified earlier close may tighten it; changes never
postpone an existing deadline. Missing/stale/contradictory calendar pauses writes
and raises critical escalation. An overdue position outside valid RTH is a fault;
do not use outsideRTH or infer permission from no-overnight policy.

Older ownership without a pinned policy is explicitly unavailable. Adoption uses
`EXECUTION_LIFECYCLE_ADOPT_EXISTING=true` only with master writes disabled and
startup entries paused, original management identity, a current verified schedule
covering the original attempt and a recorded actor/policy-source of disabled
adoption. This adopts a new explicit recovery policy, never claims a historical
policy existed. Missing historical session remains HOLD. Automatic action requires
a later compatible startup after this durable adoption. A crash after pinning an
automatic request but before creating its close operation remains HOLD, not replay.

At deadline, create exactly one stable automatic close request for original
ownership, using current bid on the verified market-rule grid and existing close
risk/slippage limits. Persist request identity before invoking FullCloseService.
An unfilled entry must cancel its parent safely, then children, and prove terminal
zero-fill/flat; it must never submit SELL without exactly one owned share. Entry
window expiry is irrelevant to this deadline. A protective fill at any step can
make the fresh position flat and suppress SELL; stale working exit legs prevent
completion. Original AI approval is ownership evidence, not a new close approval.

Extend `evaluateCloseEvidence` and `isProvenUnfilledPaperEntry` narrowly for a
completed cancel-only operation with no close proposal/link/submission attempt.
Zero-fill completion requires exact positive terminal proof for all three original
legs, no executions/local fills, independent flat position and no working orders.
An absent child without terminal proof is HOLD. A close row alone must neither
fabricate completion nor permanently strand a proven terminal unfilled entry.

Do not add automatic replacement or reprotection. Existing operation after crash,
cancel-ack loss, close rejection, missing outcome or DB failure is observation-only.
Unfilled close is tracked; after 15s working without terminal flat evidence emit
critical CLOSE_UNFILLED and retain the account reservation. Intentional cancellation
has a bounded CLOSING interval: at most15s from the first protective cancel intent
through dispatch/terminal proof. A watchdog escalates stalled work even if the
close promise has not returned. Any failure/unknown after cancellation is immediately
a protection-gap incident; a normal short successful close does not emit a fault.
No timeout is terminal cancellation, no unknown
send is retried, and no operator resume clears close uncertainty. Eventual exact
broker flat/no-working-order proof can complete the existing operation. Otherwise
durable HOLD + operator escalation is the explicitly supported PP5 fallback;
advanced cancel/replace/reprotection is not claimed or silently attempted.

## 5. Fault and delivery contract (PP5-A before PP5-B)

Stable fault identity comprises account + original proposal (or account supervisor)
+ enumerated fault code; observation/run IDs and timestamps are payload, not dedup
keys. Codes cover protection gap/unknown, foreign-order conflict, orphan ownership,
stale/disconnected broker/account/calendar, unknown cancel/submission, unfilled
close, missed/disabled exit and supervisor/DB failure. Persist first/last observation,
occurrences, active/resolved status and evidence. Resolution requires fresh exact
broker evidence; acknowledgement alone never resolves a safety fault or enables entry.
Reappearance after resolution creates a new delivery episode. Observer health/fault
records are separate from reconciliation holds so they cannot invalidate their own
proof; they independently deny entry.

PP5-B adds migration23 and an outbox using the existing Telegram provider, not a
new vendor. Fault persistence and pending delivery must commit atomically. Record
delivery attempts, bounded lease, start/end, status, provider message ID and redacted
error. States PENDING, SENDING, DELIVERED, FAILED, UNKNOWN, DISABLED distinguish
provider-confirmed acknowledgement from human acknowledgement (not implemented).
Telegram success requires parseable `ok:true` and message ID. Timeout/crash after
send is UNKNOWN, never fabricated delivery. Notification retransmission may produce
duplicates and is independent of forbidden broker retries; bound attempts to3 per
episode, delays5s/15s, transport deadline5s, no unbounded send loop. Stable fault ID
appears in text. Never leak token/chat ID or response bodies into audit/logs.
Critical alerts bypass severity filters. Disabled/failed/unknown/exhausted delivery
is visible and blocks unattended admission, while close/reconcile continue.

Worker readiness requires a heartbeat no older than15s and provider-confirmed
delivery in the current worker session. On activation the outbox enqueues one
durable transport-check message per account/process (separate from safety faults),
using the same bounded delivery state machine. Configured credentials alone report
UNVERIFIED until its acknowledgement; tests stub this message too. No periodic
probe spam. Restart creates a new probe and cannot inherit stale process health.
Any pending critical delivery/unknown/error blocks unattended admission until a
confirmed delivery; an exhausted episode needs operator intervention and never
silently rearms. A transactionally idempotent enqueue/backfill joins every active
fault episode to exactly one outbox row, including faults predating worker restart.
Lease tokens fence late workers; expired SENDING becomes UNKNOWN and is charged,
not success. A owns these admission/lease/retry/secret semantics; B implements them.

The local critical fault is generated within15s of observed failure; a5s outbox
tick with5s transport deadline exposes delivery/ack state within60s when DB/transport
available. No exchange-fill guarantee. APIs expose persisted fault and delivery
status without triggering broker calls or sending test messages. Replace the close
claim-before-fire-and-forget path for PP5 faults; an earlier claimed legacy alert
must not suppress PP5 fault/outbox creation. Tests inject stub transport only.

## 6. Work packets and acceptance

| Task | Model/effort | Owned scope | Dependency |
| --- | --- | --- | --- |
| Lead PP5-A | capable lead, critical route | plan/report, migration24 entry control, config/index/repository guard wiring, runbooks | accepted plan |
| PP5-A lifecycle | gpt-6-astra/high | migration22, lifecycle observer/store/session/close modules, read-only broker shape capture and associated tests | accepted §§2–5; lead coordinates index |
| PP5-B | gpt-6-sol/medium | durable alert store/worker/transport/routes, migration23, focused tests | accepted fault/outbox contract and shared interfaces |
| Plan reviewer | gpt-6-astra/high | read-only plan/contracts/source | before implementation |
| Implementation reviewer | different gpt-6-astra/high | read-only full scoped diff and tests | integrated A+B |
| Mechanical | gpt-5.6-luna/low; disclosed fallback if unavailable | supplied isolated checks/publication commands | frozen reviewed candidate |

Workers read AGENTS/source/contracts, preserve unrelated work, report changed paths,
commands/exits, repairs, elapsed and available usage. Stop/escalate critical contract
changes; B has one focused noncritical repair before Sol-to-A escalation. No broker,
provider, real notifications, deployment or activation. Reviewers author no accepted
implementation. Shared edits stay sequential; report requested/actual dispatch.

Acceptance tests exercise actual service/store wiring with injected IBKR/transport:
normal entry→protected→TP/SL or deadline close→broker-confirmed flat without manual
HTTP; pending entry deadline; early close/DST/exact boundary; original disabled config;
missing/wrong protective shape; TP/SL fill at each cancellation/dispatch boundary;
lost cancel/submit acknowledgements; rejected/unfilled/disappeared close; foreign
orders; reconnect/order-ID change; two workers/manual-close/entry-pause races;
restart and DB failure before/after reservation, cancel intent/ack, claim, dispatch,
observation/fault/outbox/delivery transitions. Assert no oversell/reversal, duplicate
close, retry of unknown, silent hold clearing or entry during close/pause/stale health.
Notification tests assert dedup, renewed episodes, leasing/crash, bounded attempts,
strict acknowledgement, redaction and visible status/time targets with fake clocks.

Full validation on a clean exported baseline plus only PP5 files: `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` with only TEST_POSTGRES_URL
on isolated PostgreSQL16, `pnpm build`, and clean Docker build for new configuration
plumbing. No operational DB/frozen ES data. No strategy/simulator changes, so no
additional strategy backtest unless scope changes and plan is reviewed. Check links,
scoped diff and original dirty hashes. Write report, independent hostile/document
acceptance, explicit scoped commit/push main and exact-SHA GitHub CI verification.
Passing source checks does not establish PP4/PP7 operational readiness.
