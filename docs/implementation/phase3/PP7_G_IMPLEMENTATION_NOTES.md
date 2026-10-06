# PP7-G implementation evidence

2026-10-06. Source implementation under the accepted
[PP7 delivery contract](PP7_DELIVERY_CONTRACT.md), including its authority-bootstrap
review repair. No operational deployment, provider call, broker action or policy
activation was performed. Gate B remains supervised/max1; Gate C requires its
separate authorization and preceding Gate B evidence.

## Implemented contract

The parser preserves v1 canonical serialization and supervised behavior. The v2
`bounded_scheduled` manifest adds explicit effective/expiry Warsaw dates, max2
account attempts and max1 instrument attempts, with at most100 dated windows of
at most60 minutes each. Repeated contracts require distinct account and local
session dates. Shared configuration accepts the exact scheduled/max2 capability;
a v2 manifest cannot broaden a supervised bundle. Existing quantity, currency,
notional, stop, daily-loss and no-overnight restrictions remain in the normal flow.

Migration000026 preserves all attempt/debt/hold tables and adds immutable policy
events plus a revisioned account authority. No initial active manifest is guessed.
Without authority, the existing v1 compatibility path retains its SQL max1 fence.
After explicit authority bootstrap, both old and new writers must use its exact
active run; a due pending transition blocks fallback to the older run.

Authenticated controls are GET `/execution/paper-policy` and exact POST
`/execution/paper-policy/schedule`, `/cancel`, `/adopt`. Scheduling requires a UUID
requestId, expectedRevision, exact manifestHash, priorManifestHash and reason.
Cancel/adopt require the same fields except priorManifestHash, which their strict
schemas reject. The runtime configured policy must match the scheduled/adopted
target. One pending transition is allowed. Exact replays are idempotent; changed
requests, stale revisions and replacement of pending authority conflict.

All mutations require master writes disabled and both startup and durable entry
pause. Scheduling establishes a strictly later database Warsaw day; cancellation
is allowed only before that day. Due-day adoption is explicit, within its finite
date interval, and never resumes entries. Scheduling and adoption check real PP5
observer/alert readiness, complete CLEAN reconciliation, exact broker connection
and position generations, fresh independent position evidence, flat configured/
owned exposure, no active proposals/closes/unknown attempts and no migration hold.
These checks repeat immediately before authority persistence and commit; evidence
changes or expiry roll back both event and authority. Failed or expired pending
adoption remains blocked, without fallback or automatic roll-forward.

Budget admission, reservation, dispatch and SQL count immutable account/Warsaw-day
attempts and stable conId against both account and exchange day. Unknown attempts
and legacy debts remain consumed. A second slot requires existing authoritative
terminal lifecycle proof of the first. Proposal bindings pin the particular dated
window; reservation uses database time after acquiring the account lock. The
configured15–60 minute exit margin applies to the full window. Pinned original
exit policies remain unchanged. Scheduled round-trip reports require persisted
policy version/kind and an adoption event predating the attempt.

The execution entry-route extraction and stock-market metadata route were authored
by the lead and wired into index.ts here, preserving its alert callback and auth
hooks. This worker did not author or modify those new route modules.

## Focused evidence

- Shared build: PASS. Shared parser/canonical identity tests:19 PASS.
- Final combined execution run:91 PASS, zero failures or skips. It includes v1
  import/hold/old-writer preservation; v2 schedule/CAS/replay/cancel/adoption/expiry;
  disabled and paused requirements; real PP5 alert/reconciliation checks;
  generation drift; final-readiness rollback; raw-SQL fence; concurrent account
  attempts; terminal first slot then second slot; max2 and per-instrument limits;
  unknown/rollback preservation; exit margin and stale calendar; expiry while
  waiting for the account lock; strict authenticated route schema; DST/date parsing;
  and generic stock report attribution.
- Command: `pnpm --filter @ikbr/execution-engine exec node --import tsx --test`
  with the `paper-policy-authority.pg-integration`, `paper-entry-budget.pg-integration`,
  `paper-policy-control`, `stock-generic`, `paper-run-policy`,
  `entry-control.pg-integration`, `entry-control`, and `write-guard-exemptions`
  test files. TEST_POSTGRES_URL targeted the disposable PostgreSQL16 instance on
  local port55447; each harness created and dropped its own database.
- Hostile review repair1: PostgreSQL DATE values are selected as civil date text,
  preventing host timezone conversion from blocking the prior day early. A focused
  unit test covers both DST transitions and prior/effective dates; the12-test
  authority suite passes under TZ=Europe/Warsaw, including SQL/application
  agreement. All13 tests pass with zero skips.
- Scoped ESLint and `git diff --check`: PASS.
- Execution typecheck: PASS after the lead repaired a concurrent test wiring issue.
  Final whole-workspace verification belongs to the integrating lead.

Historical pending authority is restored only inside an isolated fixture using a
briefly disabled INSERT trigger, then immediately reenabling it. Production cannot
schedule today's date; this fixture represents a transition requested yesterday.
Terminal proof in budget-only fixtures is supplied evidence; the integrated
scheduler/broker/lifecycle harness separately proves its actual production origin.
These tests do not claim real broker or research readiness.

Requested/actual worker route: gpt-6-astra, high. One test-fixture repair batch fixed
an undefined optional request field and an irrelevant currency cap in a single-
currency parser fixture; no safety assertion was weakened. One hostile-review repair addressed the DATE
conversion finding with focused regressions. No model escalation.
The first sandboxed PostgreSQL attempt was blocked by local TCP permissions;
authorized isolated tests then passed with escalation. Token usage and separately
measured active elapsed time are unavailable. Independent hostile review, complete
workspace checks/build/Docker, scoped publication and exact-commit CI remain the
lead's delivery requirements; this note does not claim them complete.
