# Marketaux local daily budget rollover recovery

Date: 2026-10-14. Status: ACCEPTED by independent `budget_rollover_plan_review`
(Astra/high), after one amendment round; no blocking findings. Baseline: `21bfd85cf5cde0ff1fee9ad46ed8fe651f998295`.

## Owner outcome and bounded scope

The owner requested correction of the diagnosed persistent Marketaux budget hold
and delegation to appropriate agents. Continue the already authorized continuous
Paper PKO/AAPL scope from [the continuous operation plan](CONTINUOUS_PAPER_OPERATION_PLAN.md).
A prior UTC day's locally exhausted research budget must not permanently prevent
fresh research acquisition after the pooled budget renews. A budget renewal is
permission to acquire fresh evidence, never permission to trade using failed or
stale evidence. Existing qualification, authority, risk, entry pause and AI binding
checks remain authoritative.

This plan follows [AGENTS.md](../../../AGENTS.md), [the roadmap](../ROADMAP.md),
[the routing guide](MODEL_ROUTING_GUIDE.md) and the current delivery documents.
It changes no strategy, broker integration, provider entitlement, configured
budget, source mapping, proposal schema or admission eligibility rule. It does
not refund, delete or modify any reservation, outcome or historical snapshot.
No provider/broker calls during implementation or fixtures; operational checks
and the normal deployed runtime are separately evidenced.

## Observed failure and source path

The last diagnosed AAPL coverage is ERROR/incomplete with exact reason
`RESEARCH_BUDGET_EXHAUSTED`, checked at 2026-10-13T17:44:59Z. The account/provider
pool reached its configured 90 reservations on October 13. On October 14 the
pool renewed, but the old error remained a permanent HOLD. The runtime stayed
paused with fresh CLEAN reconciliation and zero exposure.

`inspectResearch` currently recognizes only selected transient and legacy
Marketaux failures as repairable. `prepareRepair` examines pooled current usage
only for already-WAITING sources. `dueRepairs` cannot rediscover budget HOLDs,
and the on-demand scheduler has its own explicit reason allowlist. All four
places need the narrow recovery path; changing only the classifier is incomplete.
`reserveCall` already serializes account/provider reservations and uses database
UTC days. A locally rejected reservation creates no call row. Keep that invariant.

Marketaux coverage `checkedAt` is the window cutoff, one second before the slot
boundary. It is not the acquisition timestamp or budget day. Later snapshots can
copy an unchanged failed coverage. The original published slot and its matching
coverage must supply provenance, not the newest snapshot's `createdAt`.

## Accepted implementation contract to be reviewed

### A. Candidate, original publication and ledger proof

Only `marketaux-news`/`news` coverage with exact reason
`RESEARCH_BUDGET_EXHAUSTED`, status ERROR, `complete:false` and no evidence refs
is a candidate. HTTP 429, provider quotas, malformed payloads, other errors and
unverified coverage do not qualify by resemblance. Preserve current external
cause diagnostics; do not fabricate a Marketaux HTTP error for local exhaustion.

The critical store assessment must:

1. Reconstruct the original slot from `checkedAt + 1000`, require the exact
   `marketauxWindow(slot)` cutoff/window, and locate its durable
   `research_refresh_slots` publication. Decode its immutable snapshot normally.
2. Require original config/manifest/instrument/mapping identities to match the
   current authority/head, and canonical equality of original and current
   source coverage. Missing publication or differing coverage is insufficient.
3. Require original snapshot creation and slot publication to be within the
   original 15-minute slot, in chronological order, and no later than database
   now. The slot start, original creation and publication must share a UTC date.
   This deliberately denies ambiguous old acquisitions crossing a slot/day
   without precise rejection-time evidence. A 00:00 acquisition wholly within
   the new slot is supported even though its cutoff belongs to yesterday.
4. Reconstruct every possible pass/page call identity using the existing config
   and original window. Query matching reservation keys with LEFT JOIN outcomes.
   Every present row must have exact account/provider/kind/config/manifest and
   request hash, UTC budget day matching reserved time and the proven acquisition
   day, valid reservation/deadline ordering, and terminal SUCCEEDED recorded
   after reservation and before original snapshot creation. All such calls must
   fit the existing 120-second acquisition bound, starting with pass 1/page 1.
   Present page sequences must be contiguous from page 1, pass 2 cannot precede
   pass 1, and there can be no missing outcome, UNKNOWN, FAILED or pending row.
   Zero original calls is valid only for a proved rejection before the first
   reservation; a missing first page with later rows is never treated as zero.
5. Independently prove historical pooled account/provider request or cost
   exhaustion using reservations on that proven UTC day already reserved by
   original snapshot creation. Use all reservations irrespective of outcome,
   config or instrument, as current budgeting does. Pool limits are the minimum
   request/cost ceilings and maximum per-call cost across current manifest
   sources for that provider. A coherent original manifest is mandatory.
   Zero/invalid configured allowance is a policy HOLD, not a renewable budget.
6. Read the current pooled usage using the same database-now UTC day as the
   preparation assessment. Recovery requires a strictly later UTC day and room
   for the next call under both current request and cost ceilings. Keep the
   existing unresolved-FAILED and current/previous-slot protections as additional
   checks; this new path cannot weaken the separately reviewed transient/legacy
   paths. No blanket clearing of unrelated unknown history is introduced.

The lead read-only verified actual AAPL original provenance: cutoff
2026-10-13T17:44:59.000Z, original snapshot creation 17:45:33.967Z and slot
publication 17:45:34.002043Z, both within the 17:45 slot. Later WSH snapshots
copy this error. Remaining ledger proof still requires implementation assessment;
if it fails, report the precise gap and obtain amended independent review rather
than adding a heuristic or altering operational rows to force recovery.

### B. Shared interface and classifier

Extend `repair.ts` with `MarketauxBudgetRecoveryAssessment`, passed as a new
optional sixth argument to `inspectResearch` (preserve the legacy fifth argument).
Its proof binding contains `snapshotId`, `sourceId`, `coverageHash`, original
`slot`, `failedBudgetDay`, `failureRecordedAt`, and `nextCheckAt`. Only the store constructs
an assessment after A's complete proof and renewed current allowance.

Add optional `localBudget` to `ResearchRepairSource` with this diagnostic shape:

- `kind: "LOCAL_RESEARCH_BUDGET"`;
- `failedBudgetDay: string | null`, `failureRecordedAt: string | null`;
- `currentBudgetDay: string`, `requestsUsed: number`, `maxRequestsPerDay: number`;
- `costUsedMicros: number`, `maxCostMicrosPerDay: number`, `nextCallCostMicros: number`;
- `nextBudgetResetAt: string`, `recoveryProof: "VERIFIED" | "UNAVAILABLE"`.

Only finite nonnegative safe integers, canonical UTC timestamps/date strings and
these enums may leave the store. No account IDs, secrets, raw errors/payloads or
provider URLs are included. Diagnosis is independent of recovery permission:
return local-budget details for the exact candidate even while still exhausted
or if original provenance cannot be proved; unavailable historical details stay
null. `failureRecordedAt` means original snapshot.createdAt (the time the failure
was recorded), not the exact reserve-rejection time, which is not persisted.
The Polish label is “zapis błędu”; this field is null until historical proof is
established. `VERIFIED` means original local-failure provenance was proved, not that
current budget or research eligibility is ready.

A matching assessment changes only this source's repair classification to
WAITING with reason `RESEARCH_MARKETAUX_BUDGET_RENEWED`, preserving
`failureReason: RESEARCH_BUDGET_EXHAUSTED` and sanitized `sourceError`. Earliest
check is max(database now, next slot after the original failure). Bind assessment
to current snapshot/source/coverage hash and exact original slot; reject stale
or mismatching assessments. Apply the existing permission, mapping,
qualification, manifest refresh and future-data checks. Extend only the narrow
repair-level suppression of `RESEARCH_NEWS_ERROR`; do not change
`evaluateResearchEligibility` or proposal/binding validation.

`prepareRepair` computes provenance and diagnostics, then classifies, then applies
existing cross-source/global holds and call-slot guards. Same-day exhaustion and
new-day exhaustion remain HOLD with zero network activity. Atomic `reserveCall`
remains the final authority when another instrument consumes budget after prepare;
its rejection is published as a new local failure without overspend or retry.

### C. Queue, restart and timing

Preserve the repair schema. Migration 000031 enforces
`(state='WAITING')=(next_check_at IS NOT NULL)`; a HOLD must not be written with a
non-null next time. `localBudget.nextBudgetResetAt` is informational while held.

Extend `dueRepairs` to discover persisted news HOLDs containing the exact local
budget reason, then recheck current head coverage is the exact candidate. Do not
turn that query into an authorization decision: `prepareRepair` must always run
again under the existing instrument refresh lock.

Bound automatic budget-HOLD discovery to once per 60 seconds per
account/config/manifest identity in the store instance, with an early reset at
the next database UTC midnight. A newly constructed store scans immediately, so
restart does not require an operator/database reset. Use a bounded cache (one
active identity per configured store, or explicitly capped eviction), not a
persistent collection of every historical snapshot. Preserve existing transient
and WAITING discovery cadence. Sample only the budget branch; a failed/unchanged
assessment must not insert repeated repair events. Explicit `prepareRepair` on
start remains immediate and does not depend on discovery throttling.

The SQL and cache must not starve ordinary WAITING requests or permanently hide
budget candidates behind unrelated HOLD rows. Read at most the existing bounded
candidate batch with rotating/cursor discovery if needed to prevent starvation;
no per-two-second full historical reservation scan. Apply the scan throttle only
after a successful discovery query; a transient query failure must not lose the
candidate or persist a false scanned state. The
scheduler adds only `RESEARCH_MARKETAUX_BUDGET_RENEWED` to its repair allowlist.
Repaired acquisition uses a fresh slot and the existing full two-pass procedure;
never resume old pages, reuse old call keys or assume EMPTY. READY requires the
new complete validated snapshot. Other-source HOLD prevents scheduler I/O.

### D. Operator diagnostics

In the existing runtime preparation output, an exact validated `localBudget`
diagnostic renders a Polish explanation that this is the bot's local daily
research limit. Show known original failure date/time, current UTC day usage and
request/cost limit, next UTC reset, and whether original recovery provenance is
available. Distinguish historical exhaustion with renewed allowance from current
exhaustion. Do not call either a Marketaux response or invent its name/code.
Keep the internal reason and any actually available sanitized original cause.
Absent/malformed diagnostics retain existing safe fallback output. Preserve
external error formatting and redaction for all other sources.

## Agent packets and owned files

All workers read current AGENTS.md and this accepted plan. No worker commits,
pushes, deploys, invokes paid providers or mutates the operational DB. Stop and
return evidence on critical assumptions, changed interfaces, scope expansion or
inability to satisfy provenance. One ordinary targeted repair attempt precedes
escalation; never weaken a hold/test to obtain success.

1. Independent plan reviewer: Astra/high; read-only review of this plan and
   source. Must be different from its author and final implementation reviewer.
2. Critical implementation: Astra/high owns shared
   `packages/shared/src/instrument-research/repair.ts`, `store.ts`,
   `repair.test.ts`, and export surface only if needed; owns new isolated
   `apps/llm-agent/src/research-marketaux-budget-recovery.pg-integration.test.ts`.
   Establish/export the exact diagnostic/assessment contract before wiring work.
   Return changed files, targeted test evidence and any unresolved provenance.
3. Known-contract integration: Sol/medium, only after shared contract acceptance,
   owns `apps/llm-agent/src/research-refresh.ts`,
   `research-marketaux-refresh.test.ts`,
   `tools/paper-verify-stack/src/paper-runtime.ts` and
   `paper-runtime.test.ts`. No store/classifier semantics changes. Add reason
   wiring, faithful day-aware fake budgets and validated diagnostic formatting.
4. Lead coordinates integration, this plan and
   `MARKETAUX_BUDGET_ROLLOVER_RECOVERY_REPORT.md`, local checks and reviewed
   publication/deployment. Mechanical route is Luna/low where available; otherwise
   use the capable lead and record unavailable model plus actual fallback.
5. A different independent Astra/high reviews the complete implementation and
   hostile cases, including source/test completeness and publication scope.

Preserve every existing backtest/ES change and
`apps/signal-engine/src/signal-engine.ts`; no edits or staging outside the explicit
package. No migration is planned. A necessary added schema/provenance path
requires an amended plan and independent acceptance first.

## Acceptance and hostile tests

Use actual store/isolated PostgreSQL for ledger proofs. Seed historical rows in
isolated databases against current database UTC day; no host clock changes. The
store clock override alone does not change SQL clock_timestamp in due/reserve
queries: precise boundary tests need a consistent query/pool seam covering all
clock reads, or pure classification tests plus real non-UTC-session SQL checks.
Current usage should use prepareRepair's captured database-now UTC day explicitly
so a midnight crossing cannot mix two days in one assessment. Unit fake budgets must count
by UTC day/account/provider, retaining all prior reservations and outcomes.

- Real local reserveCall exhaustion, persisted failure and original publication
  on day D; day D+1 after restart discovers it and becomes WAITING; on-demand
  scheduler completes two fresh passes; new snapshot becomes READY. Include
  before-first-call rejection and rejection after successful partial pages.
- Original immutable snapshots, coverage hashes, reservations/outcomes remain
  byte-identical. New calls have new slot identities. No fabricated empty result.
- Same day still exhausted: HOLD, zero new fetches; later day already consumed by
  another instrument: HOLD, zero fetches. Include request and monetary ceilings,
  pooled limits, concurrent prepare/reserve and max-request no-overspend checks.
- No publication, mismatching copied coverage/hash/identity, missing first page,
  gaps, missing outcome, PENDING, UNKNOWN, FAILED, invalid ordering/deadlines or
  unproved historical exhaustion cannot create a recovery assessment. Keep
  unpublished FAILED and current/previous-slot unknown protections tested.
- UTC midnight with a non-UTC PostgreSQL session: new 00:00 acquisition has the
  new budget day despite prior-day cutoff. Copy the failed coverage into a newer
  snapshot and prove original provenance still controls. Ambiguous publication
  crossing slot/day is explicitly HOLD; recovery never uses copied creation time.
- 401/403/429, invalid payload, disabled/zero budget, expired qualification,
  permission failure, refresh disabled and unrelated report/calendar HOLD remain
  protected. Existing transient/legacy semantics remain unchanged.
- Discovery scans immediately on restart, at most once per 60 seconds during
  unchanged budget HOLD, and at UTC reset; WAITING work is not throttled. Repeated
  unchanged preparation adds no repair events. No provider calls from prepare.
- Runtime start waits for fresh evidence and never resumes from budget renewal
  alone; unrelated HOLD still blocks; stale proposals remain bound to their old
  snapshot and cannot be revived. Diagnostics explain local budget with usage,
  failure-recorded date and reset; malformed data and secrets receive safe fallback.
- Queue hostile fixture: more than 100 nonrecoverable/stale budget HOLD candidates
  before a valid budget candidate plus ordinary WAITING work; bounded rotation
  reaches the valid candidate and does not delay WAITING work. A failure before
  completed discovery must not arm the throttle. Test the midnight throttle reset.

Targeted checks: build shared, then native node test runner for shared repair,
Marketaux refresh/recovery PostgreSQL suites and runtime tests in their workspaces.
The lead then runs `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` with isolated `TEST_POSTGRES_URL`, and `pnpm build`.
Run full heavy suites serially. No strategy/simulator change means no new backtest
is required. Obtain a clean Docker build from reviewed source only, excluding
unrelated dirty files.

## Review, publication and operational evidence

Resolve independent plan and implementation findings before publication. Report
requested/actual models and efforts, elapsed times, repairs/escalations, findings,
commands/exit codes and token telemetry (unavailable if not supplied). Commit and
push only reviewed files on main; verify GitHub CI for that exact commit. CI or
access limitations prevent claiming completion.

After checks and CI, use the authorized pinned-release workflow with private
configuration and DB backup, explicit image proofs and existing settings. Recheck
paused state, CLEAN fresh reconciliation, flat positions/orders and healthy
observer before replacement. Retain protective/exit services. Start through the
normal `pnpm start` flow; no manual unpause, DB repair, budget reset or ad hoc
provider call. Verify actual renewed AAPL coverage, immutable old failure and
fresh ledger outcomes, then account pause/readiness and ongoing services. Report
any independent external blocker honestly rather than clearing it. Preserve the
previous release for documented rollback. Operational evidence/CI links are
recorded separately from source-freeze checks and actual trade evidence.
