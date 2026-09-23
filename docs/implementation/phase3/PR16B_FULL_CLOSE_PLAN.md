# PR16B — durable full close of the single-stock mechanical position

Status: revision 2 ACCEPTED by independent `pr16b_plan_review` (2026-09-23). Work directly on main; commit
and push after independent implementation acceptance and local checks. No broker
launch or activation is authorized by this implementation.

## Goal and scope

Extend PR16A with an operator-requested, durable full close. Supported original
entry: the existing bound USD stock, long, one whole share, BUY LMT, one TP and
one SL, mandatory approved AI entry. No strategies, tuning, partial-close,
replace, trailing, market-order fallback, fractional rounding, or live launch.
Business logic remains shared across environments and normal write/auth/account
policy applies. Cancellation alone does not close a position.

A successful request either proves already flat with no orphan orders, or:
reserve account -> prove ownership -> cancel and positively confirm all original
legs terminal -> capture new broker state -> persist risk-approved close proposal
and exact prepared single SELL LMT -> commit submission marker -> dispatch once
-> reconcile until flat with no original or close orders. Uncertainty stops new
writes; it never implies cancellation or permission to retry a submission.

## API and durable state

Authenticated POST /execution/lifecycle/:id/close takes strict JSON
{ requestId: UUID, limitPrice: positive finite number }. `id` identifies the
original entry, never an arbitrary position. Persist immutable request identity,
original proposal/hash, account, session, instrument/conid, price and actor.
Replays return the durable operation; changed parameters conflict. Only one
operation per original entry; active operations reserve the entire account.
GET /execution/lifecycle/:id/close returns operation plus durable evidence.
POST /execution/lifecycle/:id/close/reconcile is read-from-broker / persist-only:
it may resolve observed completion, never cancel, allocate IDs or dispatch.
These routes use existing bearer and normal administrative/environment guards;
no new exemption from TRADING_ENABLED or account allowlists in this slice.

Versioned migration adds close operations and durable per-leg cancellation
records (or constrained JSON evidence), close proposal linkage, risk/plan,
submission marker, latest observation and failure reason. States distinguish
PREPARING, CANCEL_UNKNOWN/BLOCKED, SUBMISSION_UNKNOWN, SUBMITTED, COMPLETED.
A worker never adopts an interrupted operation to repeat writes. Replays are
read-only, including after restart. Unknown/blocked operations retain account
reservation; only authoritative completion releases it. Completion never follows
HTTP success alone. All transitions use conditional updates/row locks.

## Authority and race handling

Use the same account `snap:<account>` advisory transaction lock as entry creation
and claim. Extend their reservation checks so a close operation blocks competing
entries, including when its original entry is FILLED. Reject pre-existing active
entry intents/close operations account-wide before reserving. Reservation and
initial authoritative evidence validation commit atomically, before cancellation.

PR16A evaluator remains read-only and unchanged in meaning. Share its identity,
AI approval, provenance and source-validation code with a purpose-specific close
evaluator as needed. Never synthesize original protective orders to pass it.
Initial state must have fresh complete account/session/contract/owned-fill proof,
no holds/competing exposure, known original legs and whole quantity 0 or 1.
Require the configured execution clientId on every working leg to be cancelled;
unknown/foreign client cannot be cancelled by numeric ID. Persist exact original
broker IDs/refs/perms and client identity from the validated observation.
A flat original entry can complete without broker writes only if its parent is
positively terminal: complete owned entry fill with matching owned exits, or a
durable exact parent cancellation acknowledgement. Empty snapshot arrays cannot
establish terminality of an unfilled/unknown parent. For completion (no new SELL),
complete fresh absence of children plus net-zero execution proof is sufficient
once the parent is positively terminal. For permission to submit a new SELL,
EVERY original leg needs a full-fill or durable matching cancel acknowledgement,
plus fresh absence; absent children alone never grant close authority.
Pending unfilled parent can be cancelled; partial original fill blocks this slice
before protections are removed.

Cancel original parent first if working, then TP, then SL, retaining SL longest.
For each actual cancel persist a one-shot attempt marker BEFORE broker call.
Fresh identity evidence plus matching terminal acknowledgement is required.
Use an identity-aware TWS cancellation method which waits through PENDING_CANCEL
and rejects INACTIVE/errors/timeout/disconnect; only CANCELLED/APICANCELLED or
an exactly correlated full fill is terminal. Existing generic cancellation API
semantics remain compatible. Never record success from an uncorrelated callback.
An already fully filled leg is terminal only with exact owned execution evidence;
absence by itself is not terminal. If cancel acknowledgement is lost, preserve
uncertainty; new snapshots may prove complete fill but cannot invent cancelled
history unsupported by this IB library. No cancel retry or assumption that OCA
cancelled its sibling. A race where TP fills may finish flat only after all orphan
orders are positively dealt with or a complete flat/no-working snapshot proves
completion; it must never generate an extra SELL.

The process session ID is insufficient to detect a socket reconnect. Capture the
connected socket generation after session bootstrap and before initial capture.
Check generation/connected/account/client unchanged before every cancel and at
close claim/dispatch. A strict close dispatch must fail on changed generation
and MUST NOT auto-connect; use a guarded entry into the existing dispatchPlan.
Preparation may connect internally but a changed generation afterward blocks.
Disconnect/reconnect while waiting for cancellation invalidates the acknowledgement.

After terminal evidence, require a fresh reconciliation run whose capture START
is after the last acknowledgement, not merely completion after it. Serialize
with existing capture (scheduler helper can await then start a new run). Validate
source windows include the original entry attempt. Restart/history gaps block.
Require no working target orders, matching owned net and broker position, no
unknown target executions, and unchanged account/session/binding. Net zero ->
COMPLETED; net exactly one -> close risk; anything else -> BLOCKED. Preserve
provenance after cancellations using actual terminal evidence rather than the
PR16A requirement for still-active protective children.

## Close proposal, deterministic risk and dispatch

Create a persisted proposed_orders row for the close, with immutable link to the
original operation, canonical hash, strategy/instrument/account identity,
positionEffect CLOSE_OR_REDUCE, SELL LMT, quantity one, no bracket/trailing.
The original AI entry decision remains audit evidence. A deterministic lifecycle
risk authorization permits this risk-reducing operation without waiting for a
new AI opinion; this is not a caller-selectable bypass. Generic bound
execute-ticket/execute-proposed CLOSE stays rejected. No signal-engine changes.

Risk checks require fresh live BBO for the exact instrument/conid, valid bid/ask,
spread/slippage bounds from registry (SELL compared with bid), positive tick-aligned
limit, enabled bound policy and exactly one owned share with no remaining sell
order. Revalidate after broker preparation and atomically at submission claim:
latest fresh run/session/holds/position evidence, cancellation terminal barrier,
current complete position snapshot generation frozen at reconciliation start
(no later known position invalidation or refresh),
account reservation, original/close immutable identity, risk expiry and exact
prepared contract/side/quantity/price/ref/IDs. Prepared normalization must not
change the authorized ticket. Prepared single parent must have no children,
parent binding, OCA or other unintended exposure-increasing attributes.

Reuse existing TWS prepare/dispatch split and deterministic orderRefs. Extend or
extract existing exact plan persistence carefully; do not use the old ref-only
helper as proof of broker IDs. Persist close proposal, full plan legs/refs and
submission marker atomically before dispatch. Only the successful claim owner
can dispatch, once. Exceptions, timeouts, process crash, post-commit DB failure
retain marker and plan, trigger reconciliation, and surface SUBMISSION_UNKNOWN.
No new IDs on replay. SUBMITTED is not completed. Never infer flat from local
status. Partial close fills can remain working; if remainder becomes uncertain,
block rather than round/reissue. A failed close can leave a long position without
protection: persist and emit a critical operator alert including operation ID;
never describe it as completed or silently attempt replacement.

## Completion and recovery

Explicit reconcile observes the exact persisted close ref/ID/account/conid/perm
(if known), original legs, executions, position and current session. It handles
late acknowledgement, exact full fill after unknown dispatch, and already-flat
original exits without a duplicate order. COMPLETED requires fresh complete
coverage from original attempt, owned entries minus protective/close fills = 0,
broker net = 0 and no working target orders. Unknown identities, wrong account,
wrong session, insufficient history, holds or conflicting evidence keep the
reservation and provide an actionable reason. Readiness/lifecycle output exposes
operation state; no automatic broker-write recovery is introduced.

## Validation and acceptance

Use production service and real isolated PostgreSQL with injected fake broker,
plus TWS fake-event adapter and pure evaluator/HTTP tests. Cover:
- happy path and flat no-op, parent/TP/SL ordering and actual terminal barrier;
- same-key replay, changed parameters, parallel requests/claims, active close
  fences entry creation and entry claim (including FILLED original);
- no-fill empty snapshots cannot release a potentially working parent;
- disconnect between capture/cancel or claim/dispatch and reconnect during ack:
  generation change causes zero subsequent broker writes;
- pending cancel, INACTIVE, 10147, disconnect, timeout, lost acknowledgement,
  absent children, foreign client and identity collision: zero close dispatch;
- TP fills during cancellation -> flat/no SELL, partial/fractional residual ->
  blocked; wrong account/session, stale/pre-barrier capture, missing coverage,
  unknown executions/holds/competing intent;
- stale quote/risk or state change during preparation/claim, altered price,
  quantity/side/contract/orderRef/extra leg -> no submission marker/dispatch;
- plan persistence/marker visible before broker call, crash before/after commit,
  unknown/partial dispatch, restart and repeat request -> at most one dispatch;
- close working/partial fill remains reserved; full fill plus no orphans completes;
  flat snapshot alone with missing owned fill evidence does not complete;
- auth/write guard applies, generic bound CLOSE cannot bypass dedicated flow,
  existing PR16A and AI gate regressions pass.

Independent reviewer must approve this plan before implementation. A new
independent reviewer checks final code against acceptance criteria; fix findings
until accepted. Then run pnpm lint, pnpm typecheck, pnpm test, pnpm build, full
PostgreSQL integration command from CI on an isolated disposable database, and
relevant compiled lifecycle tests. No strategy/simulator behavior changes means
no strategy backtest is required. Write PR16B_FULL_CLOSE_REPORT.md and update only
the delivery header of ROADMAP.md, preserving unrelated ES work. Selectively
stage this slice, commit + push main, verify GitHub CI for that exact commit.
