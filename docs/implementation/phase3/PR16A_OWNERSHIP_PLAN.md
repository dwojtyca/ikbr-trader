# PR16A — read-only lifecycle ownership and cancellation uncertainty

Status: accepted by independent reviewer after provenance/time/status revisions. Work directly on main; preserve unrelated ES changes.

## Boundary

Implement the first unfinished lifecycle slice already defined in Phase 2 roadmap:
ownership/recovery before an exit intent. Do not enable instruments, close positions,
submit new orders, tune strategies, or launch Paper. PR16B will implement full close.
No new AI or broker UI operations. Existing proposal/AI/risk/submission fences remain.

## Implementation

1. Persist the exact reconciliation broker snapshot in an additive nullable JSONB
   column `reconciliation_runs.broker_snapshot` (migration 000008). Publish in the
   existing final-result transaction, preserving run/session/account identity and
   source coverage. Old runs without evidence cannot establish ownership. Extend
   broker open-order rows to include the actual broker account (never inferred
   from requested account). Remove requested-account fallbacks from position and
   execution snapshot provenance too; absent broker account stays absent and
   blocks ownership. Add adapter-to-persistence/evaluator regression coverage.
2. Add a read-only lifecycle repository and pure evaluator. Repository uses one
   REPEATABLE READ READ ONLY transaction to load the selected bound proposal,
   its AI review, all saved broker leg links, latest account run (including running
   or failed runs, no fallback to older clean evidence), active account holds and
   competing proposals for the same account/conId. No write or new broker request.
3. GET `/execution/lifecycle/:id` exposes a bounded evidence report through a
   separately registered/testable route wired into execution-engine. Return
   `readOnly:true`, `canSubmitClose:false` unconditionally, reasons, proposal and
   instrument identity, run/time/session, broker position quantity, owned fill net,
   and correlated parent/TP/SL observations. Missing proposal returns 404. Missing
   current account, missing/bad evidence or stale session returns BLOCKED.
   Classifications are descriptive: PENDING_ENTRY, OWNED_POSITION, FLAT_OBSERVED,
   BLOCKED. They never constitute an execution permit or prove cancellation.
4. Strict evaluator scope: bound BUY LMT USD stock proposal with approved immutable
   AI decision and an execution attempt, exact account/conId/strategy, one PARENT,
   one TP and one SL durable leg. Validate canonical persisted ticket hash against
   review and proposal. No partial allocation across strategies or manual positions.
   Require current registry binding/policy agrees; disabled/missing binding blocks.
5. Evidence must come from the latest finished run for the active account/current
   process session; run start and snapshot capture within 10 seconds, nonfuture,
   complete positions/openOrders/executions/session source coverage and no active
   account holds. Completed-orders support is not required for a descriptive
   positive ownership report, but absence of an order never proves cancellation.
   Require execution coverage from <= proposal execution attempt, with execution
   window.to between run start and snapshot capture, and no timed-out sources.
   Run start <= source end <= capture <= completion <= now; all within freshness.
   Collection is non-atomic; PR16B must refresh and revalidate under its own fences,
   never treat this descriptive report as a close permit. If restart loses historical executions,
   report BLOCKED instead of guessing from local status or fills.
6. Correlate broker rows with exact account/conId and stable orderRef plus broker
   order ID, checking permId when stored; never match by symbol alone or union
   unrelated identifiers. Every target-contract open order and execution must map
   uniquely to a saved leg; duplicate identities, foreign/manual activity, another
   active intent or malformed/unattributed target evidence blocks. Broker open
   order lacking account blocks conservatively; another known account is excluded.
   Unique execIds contribute BUY/BOT parent fills and SELL/SLD TP/SL fills;
   conflicting duplicates, invalid shares/sides, excess fills and negative net block.
   Require broker position equals attributed parent-minus-exit fill quantity.
   Missing target position in complete positions snapshot is zero; duplicate or
   unknown-conId potentially relevant position is ambiguous. Partial fills are
   visible, not an authorization to issue fractional/partial exits. Flat reports
   require no target open orders; remaining children => BLOCKED orphan exposure.
   Missing protective children with positive exposure => BLOCKED. Pending parent
   must be observed active with BUY action for PENDING_ENTRY. Positive exposure
   requires TP/SL SELL rows with active statuses SUBMITTED/PRESUBMITTED (not
   PENDINGCANCEL, INACTIVE or terminal); any observed parent must be BUY.
   Validate remaining quantities are finite, nonnegative and cannot exceed the
   original proposal quantity; this is evidence inspection, not proof of atomic protection. Terminal local proposal status alone is not
   proof of zero broker exposure. Report deterministic reasons for each refusal.
7. Remove three false-cancellation assumptions: public cancel route and locate/
   submitted-timeout auto-cancel callbacks must never synthesize CANCELLED on
   code 10147. Public failure returns HTTP409 CANCEL_UNCONFIRMED and requests
   reconciliation, retaining persisted order status. Other failed cancels do the
   same. PENDING_CANCEL stays pending; INACTIVE is not a cancellation confirmation.
   Only actual CANCELLED/APICANCELLED status confirms cancel. Do not broaden cancel
   authorization, change broker lifecycle fill handling, or implement cancel retry.

## Verification

Pure tests cover positive entry/partial position/flat, restart with sufficient
coverage, stale/missing/failed/latest-run evidence, wrong account/session/conId,
manual/foreign activity, duplicate/conflicting identities/fills, incomplete source,
missing children/orphan children, and no execution permission in every response.
Real disposable PostgreSQL tests use actual migrations/publication/repository/
evaluator and route injection, verifying persisted snapshot, old-row fail-closed,
restart, latest failed run and account isolation. Fake IB EventEmitter tests cover
open-order account provenance and cancel CANCELLED/APICANCELLED/PENDINGCANCEL/
INACTIVE/10147/timeout; public route test proves no local terminalization and
reconciliation request on uncertain cancel. No real broker or provider calls.

Independent plan acceptance precedes implementation. A new reviewer checks code
against this plan; fix until accepted. Run lint/typecheck/test/build, all integration
checks on an isolated disposable PostgreSQL, compiled focused tests, diff check.
Existing unrelated dirty ES files remain uncommitted; stage only this scope and
stage roadmap changes relative to committed content if needed. Write report,
commit + push main, inspect GitHub CI. No PR creation (owner preference).

## Review amendments

Broker execution timestamps must retain provenance: never substitute current time
for a missing or malformed timestamp, normalize invalid calendar dates or ignore a
timezone suffix. Strict explicit UTC/GMT is supported. Optional
`EXECUTION_BROKER_TIME_ZONE=UTC` declares that the operator configured broker output
as UTC and permits otherwise valid timezone-less timestamps; unset rejects them.
No local machine timezone inference or implicit default. Snapshot serialization
keeps unavailable time null, and ownership blocks. An unknown explicit timezone
still rejects when the UTC declaration is set. Calendar values are validated
without date rollover. Tests cover these cases. The independent plan reviewer
accepted the saved amendment and these test requirements.

CI for the preceding main commit exposed a concurrent risk-evidence overwrite:
a late assessment UPDATE could wait on the review row then overwrite committed
submission evidence using a stale statement snapshot. Correct in this scope by
locking the proposal first, checking its current execution fences, then updating
the review. Successful assessment is persisted only by the atomic submission
claim; late failure must not overwrite it. Add deterministic real-PG overlap test
and retain exactly-once submission checks. No risk policy change.
