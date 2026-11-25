# Accounting clock catch-up

Date: 2026-11-25. Status: ACCEPTED by independent `clock_plan_review`,
requested/actual `gpt-6-astra`, high, after deadline and runtime-scope clarifications.
Author route: requested/actual `gpt-6-astra`, high. No publication or broker
actions by the implementation worker. Existing unrelated dirty work is excluded.

## Problem and bounded outcome

Current runtime evidence supplied by the lead shows broker time approximately
49–54ms ahead of inspection completion on the same protocol226 generation.
The collector accepts absolute clock skew up to 2000ms, but consumers correctly
require evidence no later than their current clocks. `recordQualification`
rejects future broker time, `verifyObservations` rejects `capturedAt <
coveredThrough`, and `assertCurrent` rejects future coverage. This explains both
first qualification failure and subsequent capture failure after qualification.
Recovery also independently checks both local and database clocks.

Wait for a small accepted broker lead to become genuinely historical before
creating the inspection/capture. Preserve the exact broker timestamp and all
strict future/freshness checks. This extends the current
[automatic recovery contract](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md), preserving
the [continuous Paper scope](CONTINUOUS_PAPER_OPERATION_PLAN.md).

## Contract

1. Put one catch-up barrier inside `inspectInternal`, after replay and cost/
   persistence drain, before constructing/persisting the inspection. All callers
   (manual inspect/qualification, automatic qualification, join and clock recovery)
   receive the same barrier. Do not add another broker request or retry.
2. Sample actual local time and `clock_timestamp()` separately. Success requires
   finite broker/local/database times, broker time <= both clocks, age strictly
   less than 10000ms against both clocks, and the same Warsaw account date.
   Never synthesize timestamps, replace broker time with local time, widen future
   acceptance, or extend existing evidence freshness.
3. Catch-up has a fixed maximum 2000ms, matching the collector's existing maximum
   accepted skew, further capped by the remaining inspection timeout. Calculate
   elapsed/deadline using `performance.now()` so a wall-clock rollback cannot
   extend it. Establish the original operation deadline before replay; never
   re-arm its budget after replay, drain or catch-up. Refuse a lead over 2000ms
   against either sampled clock immediately.
   Poll only while future, at intervals no greater than 50ms. Reads and sleeps
   are abortable; clear timers/listeners. A hanging database read cannot extend
   the bound or later continue publication. No sleeps occur under SQL locks.
4. Database clock reads are read-only, bounded queries outside owner/source-row
   transactions. The wait does not confer ownership. Preserve owner, gap epoch,
   execution identity, collector generation, semantic revision and drained-lane
   fences before and after asynchronous steps. Evidence changing while waiting
   fails closed rather than silently adopting a new barrier.
5. Abort/deadline expiry produces `ACCOUNTING_REPLAY_INCOMPLETE`; invalid/excessive
   clock lead produces `ACCOUNTING_CLOCK_INVALID`; aged/date-mismatched evidence
   produces `ACCOUNTING_EVIDENCE_STALE`; existing owner/generation/revision and
   persistence errors retain their existing codes. Use sanitized phase diagnostics
   `accounting.clock_catchup` with finite local/database lead values and explicit
   reasons in the existing reason field; no raw account/provider data.
6. Revalidate freshness and cancellation after inspection persistence and at
   automatic/manual qualification and capture publication fences. Qualification
   and capture transactions retain owner/source locks and strict checks; validate
   both clocks at their final SQL boundary and local time before commit. There
   is no wait in these transactions: clock movement/staleness rejects the work.
   Existing `verifyObservations` and `assertCurrent` remain strict. Recovery's
   existing dual-clock final checks remain intact.
7. No changes to budgets, recovery episodes/leases/backoff, broker writes, AI,
   trading activation, strategies, owner handover or schema. Unknown outcomes stay
   holds. Failure never asserts a successful capture or updates the broker clock.

## Files and acceptance

Allowed source: `apps/execution-engine/src/accounting/source-service.ts`,
`source-store.ts`, and accounting tests (new focused clock-catchup tests allowed).
This plan is the only document owned by the implementation worker. Lead owns the
report, review coordination, full checks, deployment and publication.

Required tests: positive +55ms skew reaches initial automatic qualification and
valid capture; subsequent capture reuses qualification successfully; independent
database lag is waited for; zero/past time does not wait unnecessarily; >2000ms
lead and stale evidence reject; cancellation before/during wait and a hanging
clock read stop promptly with no late publication; fixed bound survives wall-clock
rollback and a nearly exhausted original replay/drain budget; owner loss,
connection generation, execution identity, semantic/lane
changes while waiting reject; delayed persistence/qualification/publication cannot
publish stale evidence; day rollover rejects; diagnostics contain useful clock
deltas/reasons without secrets. Use real isolated PostgreSQL for qualification/
capture acceptance and deterministic controlled clocks for boundary failures.

Worker runs focused Node tests and execution TypeScript checks. Lead runs required
`pnpm lint`, `pnpm typecheck`, `pnpm test`, isolated `pnpm test:integration`,
`pnpm build`, clean Docker build and a different independent hostile reviewer.
No strategy/simulator behavior changes, so no new backtest requirement.

The owner explicitly requires local runtime proof before commit/push: deploy the
reviewed candidate from a clean HEAD archive plus only the scoped reviewed patch,
preserving the existing durable entry pause and protective exit supervision during
deployment and real-source proof, within the already authorized operational scope.
Clock verification invokes read-only accounting/reconciliation only. Changing the
master-write switch requires fresh flat/no-orders evidence and the existing
configuration procedure; it is not a prerequisite invented by this fix. Establish
fresh successful accounting qualification/captures and disappearance of this
clock-related hold across repeated ordinary reconciliations. Guarded start follows
only after the existing operational gates and owner authorization. No manual
broker order or direct database-row mutation is part of this proof. Do not claim trading
readiness if another guard remains. Only then publish the reviewed scope on main
and verify exact-commit CI. Runtime actions belong to the lead; this document does
not expand their authorization. Record model/effort, repair/review findings, elapsed
time and unavailable token telemetry honestly in the final package report.

## CI diagnostics fixture amendment

Date: 2026-11-25. Accepted by independent `clock_plan_review`, requested/actual
`gpt-6-astra`, high. The CI success/publication diagnostic cases elapsed 46ms/35ms
against an unrelated 25ms fixture budget, causing `ACCOUNTING_REPLAY_INCOMPLETE`
before their diagnostic assertions could run. Their purpose is phase/cause/privacy
verification, not deadline enforcement.

Change only `source-phase-diagnostics.test.ts`: use the normal 9000ms budget for
success, drain and publication modes, retaining 25ms for the cost-timeout case.
Keep every assertion unchanged. Production deadlines and the dedicated catch-up
deadline, cancellation and two-second-cap tests remain unchanged. Run the focused
31-test accounting suite, obtain independent implementation review, and retain
the existing publication and exact-commit CI requirements. This amendment needs
no new broker action or runtime deployment because production bytes do not change.
