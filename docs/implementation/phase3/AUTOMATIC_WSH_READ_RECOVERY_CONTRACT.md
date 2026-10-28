# Automatic WSH read recovery contract

Date: 2026-10-28. Status: independently accepted by `automatic_startup_plan_review` (Astra/high).
Parent: [automatic startup plan](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md), package E.
This package changes read admission and publication authority, never broker orders,
model calls, Marketaux recovery, entitlements or charged provider budgets.

## Durable representation

Allocate migration `000042_automatic_wsh_read_recovery.sql`; do not edit released
migrations. Add three immutable tables:

- `research_wsh_read_recoveries`: UUID operation key, initiating account/config/
  manifest/instrument/source identity, database timestamp, canonical record and
  SHA256. Record contains sorted endpoint predecessor/successor generations,
  predecessor identities and original outcomes, matching legacy challenge IDs,
  and the maximum original legal regular-read boundary for each issuer.
- `research_wsh_read_recovery_predecessors`: recovery FK, predecessor kind
  (`WSH_ATTEMPT` or `WSH_ACQUISITION`), predecessor UUID, identity SHA256 computed
  using existing `research_recovery_identity_hash`; unique kind/UUID. This is a
  publication retirement receipt, not evidence of socket closure.
- `research_wsh_read_recovery_challenges`: recovery FK, unique legacy challenge
  UUID, original challenge hash. Only exact WSH endpoint-reset challenges whose
  complete predecessor set is covered by the recovery can receive disposition.

Database guards verify references, hashes, original generations, expired read
deadlines and complete predecessor/challenge coverage. Update/delete/truncate of
receipts is prohibited. Historical receipt tables retain their original meaning.
Do not fill `verified_local_closure`, reset budgets, claim an endpoint restart,
overwrite an existing terminal result, or create a fake old recovery receipt.

## Recovery transaction and concurrency

Add `ResearchStore.recoverExpiredWshReads(identity)` for the current authorized
research identity, independent of trading-enabled and operator entry pause. It
performs database work only. Run it before WSH due-attempt selection, including
when existing cleanup/maintenance holds would otherwise suppress all due work.
Current manifest authority is mandatory, but expired WSH qualification must not
prevent bookkeeping recovery. Acquisition still requires normal qualification.

Discover unresolved read attempts/acquisitions affecting configured WSH endpoints
or issuer ledgers, including old manifests and acquisition-only predecessors.
Determine all affected endpoints. Acquire their existing session advisory locks
in sorted endpoint order with `pg_try_advisory_lock` on one bounded dedicated
connection. Failure releases all acquired locks and returns BUSY with a later
retry; never wait while holding a partial set. Existing single-endpoint readers
use the same keys, so recovery cannot overlap their active database session.

Begin one bounded transaction, lock `research_recovery_challenges` in the same
SHARE mode as read admission, validate authority, lock affected endpoint rows in
sorted order, then issuer advisory transaction locks in sorted order, then exact
attempt/acquisition rows in deterministic UUID order. Re-read the predecessor and
endpoint set under those locks. If discovery changed or includes an unlocked
endpoint, roll back and rediscover on the next bounded tick. Never enlarge the
lock set while holding transaction locks.

Eligibility requires database time past every STARTED attempt deadline and every
linked call reservation deadline. Acquisition-only predecessors require time
past both their start plus `WSH_ATTEMPT_MS` and all linked reservation deadlines.
A still-active predecessor returns its concrete next-check time without changes.
For acquisition-only predecessors, derive the next legal regular boundary from
the persisted original start plus the original manifest's refresh interval,
combined with existing issuer rolling pacing. Missing or invalid original
configuration is an integrity error; never substitute the current time.
Future/inconsistent timestamps are explicit diagnostic errors, not permission to
retire. Account identities in linked cycles/reservations must be consistent with
the authorized account; a foreign-account predecessor is not silently rewritten.

Use a stable UUID operation identity until an uncertain COMMIT is resolved by
reading that exact receipt. Insert the receipt and predecessor dispositions,
advance each affected endpoint generation exactly once, and retire old pending
acquisition publication authority atomically. A previously STARTED attempt may
become UNKNOWN with an explicit automatic-recovery cause; existing terminal
outcome/result hash and cleanup details stay unchanged. PENDING acquisitions
become UNKNOWN/retired; already terminal acquisitions keep their outcome and gain
only the supported retirement marker. Retain call outcomes and reservations.
Receipt insertion guards and deferred consistency checks must reject incomplete
direct SQL mutations, not merely rely on application ordering.

Mark matching legacy PREPARED WSH challenges through the separate immutable
disposition relation. Keep their original rows and canonical hashes unchanged.
`research_recovery_held` ignores only exactly disposed WSH challenges; Marketaux
branches are byte-for-byte equivalent in behavior. Legacy commit/supersede paths
must reject a challenge with such disposition, including a finalizer delayed
across the recovery transaction. Expiry alone is never a disposition.

## New read admission

Update application and SQL cleanup fences consistently to recognize these exact
receipts. An old unknown attempt no longer demands confirmed physical closure,
but its original `next_regular_at` and issuer rolling pacing remain binding.
Only a new ordinal-zero regular cycle is admitted after that boundary; no retry
of the retired cycle and no reuse of its call keys. Recovery itself reserves no
provider call. Existing endpoint locks, call reservation/deadline enforcement,
USD budgets, canonical source identity and acquisition-generation checks remain.

Every preflight/finalization/reservation/publication path must reject a retired
attempt/acquisition even if its old callback arrives after recovery. Preserve the
existing possibility that an already charged read crosses a final check/send
race; its result cannot publish and no new reservation can use the retired
capability. No claim of physical socket death or zero residual network reads.
Broker duplicate-request/client-ID conflicts remain bounded BUSY/unavailable
failures under existing pacing, not a TWS-reset requirement.

Old uncertain evidence continues to block cached research eligibility until a
new complete successful acquisition covers the current identity. Read scheduling
must nevertheless continue. Diagnostics distinguish historical unknown outcome,
publication retirement, next regular-read time and current capability error.
Do not label retired unknown history as recovered research coverage.

## Owned files and acceptance

Implementation scope: migration000042; `packages/shared/src/instrument-research/`
store, WSH/recovery types and diagnostics plus associated tests; llm-agent WSH
refresh/scheduler wiring only if store-level due selection cannot contain the
change; `tools/paper-verify-stack/src/paper-runtime.ts` and associated tests for
automatic WAITING continuity. No accounting000041 or SDK000043 edits. No deployment during implementation.

Required focused PostgreSQL fixtures: current and old-manifest unknown attempts;
acquisition-only predecessor; both configured instruments sharing one endpoint;
same issuer across two endpoints; one endpoint lock busy; discovery changes;
unexpired read; foreign account; unknown COMMIT before/after persistence; stale
callbacks and budget reservation; legacy PREPARED challenge with delayed commit;
Marketaux hold remains; direct SQL forged/incomplete disposition rejected;
charged budgets unchanged; original regular boundary retained; subsequent fresh
success restores eligibility, while recovery alone does not. Use isolated test DB.
Scheduler test proves an initially indefinitely blocked endpoint reaches a new
regular read without any operator action. Full parent validation/review/CI applies.

The existing `pnpm start` procedure must remain polling through known recoverable
WSH read cleanup/maintenance states and their next-check times. Classify only
those exact states as WAITING; foreign identity, corrupt evidence or unsupported
capability remains HOLD. Add a scheduler plus runtime-CLI fixture covering old
hold, automatic disposition, regular-slot wait and fresh successful data without
another operator start. Reuse the existing command; do not add a second launcher.
