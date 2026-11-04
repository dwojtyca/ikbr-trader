# Startup research freshness independent of periodic refresh

Date: 2026-11-04. Status: ACCEPTED by independent `cleanup_audit` (`gpt-6-astra` / high)
plan review on2026-11-04; reviewer accepted exact allowlists and SQL retry guards. Baseline: `b8dd08c` on main. Architecture route:
`gpt-6-astra` / high; independent plan and final reviewers must be different
agents, neither the author/implementer. Record dispatch settings and available
usage in the implementation report; unavailable usage is not zero.

## Outcome and authority

The owner requires startup to fetch required missing, expired or unusable research
as soon as a read can safely be admitted. Startup must not wait for an arbitrary
hourly refresh slot, including after deploying a parser repair. This explicitly
supersedes the hourly admission floors for **recovery demand** in the
[two-source plan](TWO_SOURCE_RESEARCH_HOURLY_PLAN.md) and older recovery contracts.
Ordinary background refresh remains hourly. Both Marketaux news and WSH calendar
use the same distinction; this is not an AAPL-only or Marketaux-only exception.

Continue the [continuous Paper scope](CONTINUOUS_PAPER_OPERATION_PLAN.md),
[automatic recovery contract](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md), and
[read-recovery evidence rules](PAPER_STARTUP_RESEARCH_RECOVERY_CONTRACT.md).
No changes to strategy, proposal/AI/risk binding, one-share scope, USD5/day AI,
entry pause, existing source budgets, order unknowns, protective orders or Live
activation. Research recovery is a read, not permission to trade. Implementation
tests use fixtures and isolated PostgreSQL, never operational data or paid calls.

Reported operational motivation is an AAPL HARD news attempt from before the
deployed parser repair, still preventing use and a replacement read until the
prior attempt's one-hour deadline. The separate WSH 10281 failure has retained
usable calendar coverage: a failed background refresh alone must not trigger
startup demand while that coverage remains valid. These observations are context,
not fresh broker evidence or a claim that this package fixes persistent 10281.

## Current mechanisms and exact blockers

- `ResearchStore.claimMarketauxAttempt` requires the latest issuer attempt start
  plus one hour even after terminal failure or fenced recovery. The current SQL
  `research_marketaux_attempt_guard` replacement in migration37 enforces the same
  rule. Migration35 also imposes `UNIQUE(account_id,ledger_key,slot)`; `slot` is
  checked against the original hour and is part of request/receipt identity.
- Marketaux success, hard-negative and retained-failure paths publish/link an
  hourly `research_refresh_slots` key. Merely removing the admission check creates
  same-hour publication collisions. Those rows are immutable audit history.
- WSH migration34 `research_wsh_cycle_admission` calls
  `research_wsh_regular_not_before`. Migration42 additionally imposes stored
  `issuers[].nextRegularAt` in `research_wsh_read_regular_boundary` and
  `research_wsh_read_predecessor_allows`. Application admission, diagnostics and
  preparation repeat these floors. Bypassing only the TypeScript floor is unsafe
  and ineffective. Current bounded WSH retries remain evidence-backed in
  migration44, with ordinal0–2 and delays30s/120s.
- `prepareRepair`, `inspectResearch`, `dueRepairs` and `runRepairs` conflate entry
  eligibility with permission to acquire replacement data: HARD news is excluded,
  and aggregate HOLD is copied to every source's repair request. A failure of one
  source can therefore prevent an independently recoverable source from repair.
- The existing startup and two-second repair tick already provide discovery and
  wakeups; the minute regular tick need not become a new service or job system.
  Existing `research_repair_requests/events` supply durable demand/audit state.

## Provider limits versus project scheduling

[IBKR's WSH API documentation](https://www.interactivebrokers.com/docs/tws-api/doc/wall-street-horizon/event-data)
requires metadata before event requests and rejects concurrent WSH requests until
the previous request succeeds, fails or is cancelled. It does not prescribe an
hourly refresh delay. Preserve the installed adapter's endpoint lease,
metadata/event ordering and response correlation. Do not borrow historical-bar
pacing limits as alleged WSH limits, rotate client IDs, restart TWS or assert
physical socket death from a database generation change.

[Marketaux's errors documentation](https://www.marketaux.com/documentation#errors)
describes HTTP402 usage-limit exhaustion and HTTP429 excess requests in the past
60 seconds, with usage/rate-limit headers. It does not establish a universal
one-request-per-issuer-per-hour requirement. Exact account entitlement is not
established by this public page. Existing configured pooled request/cost caps,
pagination limits, timeout limits and verified qualification remain authoritative.
Hourly refresh and the new failure backoff are explicitly **project choices**.
Respect actual provider throttling responses; do not invent provider capacity.

## Admission contract

Add `regular | demand` Marketaux admission, defaulting to `regular`; add `demand`
to `WshAttemptKind`, retaining `regular | retry`. Demand is supported only for the
validated `TWO_SOURCE_HOURLY_V1` policy. Legacy scheduling, canonical bytes, receipt
shapes, source hashes and existing report contracts are unchanged.

Use current authority, DB time and the existing verified source-projection and
durable-admission checks to distinguish these states:

| Source condition | Startup/repair action | Entry consequence |
| --- | --- | --- |
| Exact current-manifest complete AVAILABLE/EMPTY source remains usable | No demand read; regular refresh proceeds independently when due | Existing eligibility rules |
| Missing/expired data; or a proved source acquisition failed and makes older data unusable | Persist/reuse demand and admit once due | WAITING; no entry until a proved usable replacement |
| Live bounded attempt or pending authorized WSH retry | Join its durable state/deadline; no parallel demand | Existing cache rules, otherwise WAITING |
| Uncertain read | Run existing automatic retirement/fencing first; then new demand identity | Original uncertainty remains recorded; no cache promotion |
| Invalid authority/identity, invalid or expired qualification/entitlement, denied automation/retention, unproved legacy recovery | No bypass; preserve precise hold | HOLD; other eligible source reads continue |
| Exhausted local budget or provider cooldown | Durable next admissible time, no repeated denied fetches | Existing fresh-cache rules, otherwise WAITING/HOLD as applicable |

Data/normalization HARD failures are eligible for a **new read**, never reinterpretation
of the rejected data. This includes the current Marketaux payload/parser failure
and WSH malformed metadata/event payloads. Preserve original sanitized causes.
Do not make known authorization failures HTTP401/403, denied WSH entitlement,
local identity/configuration invariants or malformed durable provenance into
fast demand retries. Those require their real prerequisite to change; background
observation and independently eligible recovery continue. Freeze the following
additional terminal HARD allowlist; every member still requires a valid durable
terminal attempt, source identity, rejected publication and known/fenced calls:

- Marketaux: `RESEARCH_MARKETAUX_PAYLOAD_INVALID`,
  `RESEARCH_MARKETAUX_CONTENT_TYPE_INVALID`, `RESEARCH_MARKETAUX_BYTES_EXCEEDED`,
  `RESEARCH_MARKETAUX_RESULT_LIMIT`, `RESEARCH_MARKETAUX_RESULT_CHANGED`,
  `RESEARCH_MARKETAUX_DUPLICATE_UUID`,
  `RESEARCH_MARKETAUX_PUBLICATION_OUTSIDE_QUERY`.
- WSH: `RESEARCH_WSH_PAYLOAD_INVALID`, `RESEARCH_WSH_METADATA_INVALID`,
  `RESEARCH_WSH_ROW_INVALID`, `RESEARCH_WSH_ROW_COUNT_INVALID`,
  `RESEARCH_WSH_DATE_INVALID`, `RESEARCH_WSH_STATUS_INVALID`.

Existing proved TRANSIENT, local-budget renewal and WSH BUSY10281 eligibility
remain, with the backoff rules below; UNKNOWN first requires existing recovery.
Exclude, for example, Marketaux `ENTITY_MISMATCH`, `IDENTITY_MISMATCH`,
`QUALIFICATION_UNAVAILABLE`, `KEY_MISSING`, ticket/request/receipt/provenance
invariants and WSH `IDENTITY_INVALID`, `QUALIFICATION_*`, `ACCOUNT_*`,
`REQUEST_*`, `PROTOCOL_*` and provider entitlement/auth failures. These prefix
examples describe exclusions; admission uses exact allowlisted names, never a
permissive regex or `HARD => retry` fallback. Missing diagnostic proof remains
unavailable. Observed AAPL failure is `RESEARCH_MARKETAUX_PAYLOAD_INVALID` with sanitized
`MarketauxPayloadValidationError`/`article.url.safe_public_url` (fragment). Include
it in the acceptance fixture; if another failure
is outside this fixed allowlist, amend/review rather than silently broadening it.

Reuse the unique repair request for `(account,config,manifest,instrument,source,
role)` and immutable repair events. Source request state expresses acquisition
work, independently of aggregate preparation/entry HOLD. A hard financial hold
or another source's denied permission never erases this source's demand. Keep
aggregate preparation fail-closed. Expose a separate source acquisition diagnostic
with reason, demand status and `nextDemandAt`; retain `nextRegularAt` with its
existing periodic meaning. Do not simply delete hard-failure entry reasons.

Startup must assess every configured required source immediately after manifest
registration; the first repair pass discovers demand without needing an existing
proposal or pre-existing repair row. Later two-second repair passes recheck only
due work, with the existing bounded batch/fairness behavior. Revalidate fresh
coverage under the admission locks: a successful concurrent publisher cancels
unneeded demand without making another provider call. Do not hold a transaction
over network I/O. Never replay an old ticket after restart.

## Durable pacing and bounded recovery

Do not add a generic queue or mutable in-memory retry counter. Derive demand
backoff from immutable attempts on the stable existing provider ledger, across
source-ID/manifest changes and process restarts: Marketaux uses account+conId
ledger; WSH uses its existing globally serialized ISIN ledger and endpoint lease.
Count consecutive failed/retired actual attempts since the last proved success,
including regular attempts and existing WSH retries. Scope changes cannot erase
charged history or reset pacing. Read at most the latest three relevant failures
once the capped delay is established, using indexed history.

- No prior unsuccessful attempt: demand due now. A prior old failure whose delay
  has elapsed is also due now; do not start a fresh delay at discovery or restart.
- First failure: next admission no earlier than its terminal/recovery time+30s;
  second: +120s; third and subsequent: +10min. These are bounded recovery backoffs,
  not the periodic cadence. Only proved successful acquisition resets the streak.
- Uncertain attempts use the committed existing recovery receipt time, after its
  original deadline/margin and generation retirement; an absent receipt is not a
  terminal failure. No new read while an original active deadline remains live.
- Existing authorized WSH ordinal retries take precedence and retain their exact
  30s/120s timing and three-attempt cycle bound. A demand cycle has one ordinal0
  attempt; on failure it sets no in-cycle retry and uses the durable demand
  backoff instead. This prevents two retry mechanisms racing. Demand may follow
  exhausted regular retries when its common backoff permits, without an hour floor.
- Budget denial waits for the existing proven UTC budget reset/recheck, without
  inserting repeated empty denied attempts. Provider cooldown takes the maximum
  of the failure backoff and a valid provider-specified retry time; HTTP429 also
  imposes at least60s from the observed failure, across the provider/account.
  HTTP402 is provider usage exhaustion, never a reason to reset our local budget
  or retry on the30s fast path. The latest proved402 creates a provider/account
  hold on fast DEMAND admission and dispatch across issuer/source/manifest changes.
  Existing ordinary hourly refresh remains available under all its normal budget,
  qualification and429 cooldown guards; this is the existing bounded automatic
  revalidation path, not a newly assumed renewal deadline. Clear this usage hold
  only after a matching proved successful provider call reserved strictly after
  the402 terminal timestamp, with its successful outcome and non-null content-hash
  receipt agreeing. A delayed response to a call reserved before402 cannot clear
  it. Such success clears only the usage hold, never qualification/entitlement or
  entry eligibility. A demand already claimed before402 may settle a later locally
  refused dispatch as `RESEARCH_PROVIDER_USAGE_HOLD`, without a new call charge.
  This distinct local failure is eligible again only after the pooled usage hold
  clears, with the historical hold at its recorded refusal time and all prior calls proved
  known; unknown calls still require normal retirement. Local provider refusals
  use an immutable nullable `provider_refusal` marker on the existing Marketaux
  attempt, containing the fixed reason and DB timestamp. Under the existing pool
  lock, reservation independently proves the current hold, commits the marker,
  then reports refusal without reserving or charging a new call. SQL permits only
  this exact marker-only update on a live STARTED attempt, rejects forged or
  replaced markers, and forbids all later reservations for that attempt even if
  the provider recovers. Settlement uses this durable refusal observation rather
  than assuming the hold remains active at completion. A lost commit reply allows
  only bounded marker readback; absent/unavailable proof keeps the attempt unknown
  and dispatch forbidden. This closes both402-renewal and429-expiry races without
  a new table or public API. Independent plan reviewer `cleanup_audit` and final
  reviewer `startup_retry_final_review` accepted this bounded clarification on
  2026-11-04. It does not promote cached
  data or relabel the remote402. Preserve the old402 and every charge. This bounded clarification
  was accepted by independent plan reviewer `cleanup_audit` on2026-11-04 following
  final-review feedback. No dynamic quota discovery or manual renewal ceremony is
  added. No header
  means no invented provider deadline. Persist any supported Retry-After deadline
  as sanitized numeric timing evidence; pooled provider/account throttles affect
  all its source demands. A malformed/unrepresentable header is diagnosed and imposes at least10min
  from the durable failure time, combined with all longer constraints. A valid
  longer delta/date is never clamped to10min. Absent header, zero and malformed
  are distinct; invalid negative/nonfinite/fractional internal deltas reject.
  HTTP-date can be passed as a canonical absolute UTC deadline and compared with
  DB time; host skew cannot shorten it. This clarification was accepted by the
  independent plan reviewer. Pooled cooldown is enforced at claim and each call
  reservation under the existing provider budget lock. A local
  `RESEARCH_PROVIDER_COOLDOWN` refusal creates no provider dispatch or new debit;
  separately proved prior successful calls can retain fresh cache, while prior
  unknown calls still require normal recovery. The local refusal is distinct
  from the remote HARD parser allowlist, as accepted in review. This small
  transport/store addition is required if the existing adapter discards the header.
- Each tick starts at most one attempt for a given source; existing per-instrument
  serialization and WSH endpoint exclusivity remain. Sustained failures continue
  bounded periodic recovery, capped by provider budgets, not a synchronous loop
  or permanent manual retry requirement. DB outages schedule observation again
  without a provider call or erasing the prior attempt.

Regular admission still applies its normal interval from the latest admitted
acquisition/cycle, including demand. A successful demand therefore postpones the
next ordinary refresh and avoids immediate duplicate work. `next_regular_at`
continues to describe periodic scheduling, not permission for startup recovery.

## Evidence-preserving SQL migration

Add one new sequential migration (next unused number, currently45); do not edit
applied migrations. Check exact expected constraint/function definitions before
replacement and fail closed on an unexpected schema. Preserve all old timestamps,
canonical JSON, hashes, call outcomes, budgets, snapshots, attempts and recovery
receipts; no DELETE, synthetic success, history rewrite or timestamp reset.

1. Add immutable `admission_kind` (`REGULAR` default or `DEMAND`) and nullable
   `demand_request_id` foreign key to `research_marketaux_attempts` and
   `research_wsh_refresh_cycles`. Check REGULAR iff request is null. Demand must
   link the correct current source/account/manifest repair request; SQL insert
   guards require it due and independently confirm the source is absent, expired
   or invalidated by a supported acquisition failure. Recheck the current head and
   durable failure history; a caller-set kind or fabricated repair row is not
   authority. All admission metadata is immutable after insertion.
2. Discover/verify and drop only Marketaux's unique constraint on
   `(account_id,ledger_key,slot)`; replace it with the same unique **partial index
   for REGULAR rows**. Keep `slot=floor(epoch(started_at)/3600)`, the120s attempt
   deadline, call links, two-pass receipt proof and all immutable state rules.
   Demand attempts have distinct UUIDs, allowing truthful same-hour windows and
   call identities without falsifying slot/time. Existing issuer locks, active
   attempt rejection and new SQL demand backoff prevent duplicate demand.
   Retain the existing v2 hour-aligned `marketauxWindow(slot)` query cutoff and
   lookback: a new successful fetch has a new actual completion/24h validity,
   but does not claim its `asOf` is the current second. A replacement inside the
   same hour deliberately rechecks the same provider window with a new attempt
   and new two-pass proof. A later-hour demand advances the window normally.
   No v3 receipt or query-window redesign belongs to this package.
3. Replace the current migration37 Marketaux admission function only as necessary
   to dispatch regular hourly versus demand due checks. Retain recovered-unknown
   exceptions, clock protocol, source authority/hash, maintenance hold and all
   terminal validation. SQL must enforce the same pooled history/backoff as the
   store, including direct insert, concurrent start and manifest-rotation cases.
4. Update WSH cycle admission and the migration42 recovery boundary functions to
   recognize a valid linked demand cycle. A demand does not wait for historical
   `nextRegularAt`, including values inside immutable recovery receipts. It still
   requires committed predecessor retirement, current generation/endpoint lease,
   due backoff and no live predecessor. Keep ordinal0 identity, deadline35s,
   preflight and pending-acquisition guards. A demand acquisition must link the
   exact active preflight-complete demand attempt; the exception must not admit
   unowned direct acquisitions or change legacy/regular behavior.
   SQL attempt insert/update guards must enforce DEMAND cycles' ordinal0-only
   rule and `retry_due_at IS NULL`; migration44 BUSY retry eligibility must never
   authorize an in-cycle retry for demand. Reject direct ordinal1 inserts or
   forged retry_due_at updates as well as application-level retry requests.
5. Preserve migration42 recovery-record format and original `nextRegularAt`
   values as historical periodic deadlines. Do not remove its publication fences.
   In particular do **not** add fields to WSH attempt/acquisition rows: old
   receipts contain exact `to_jsonb(row)` snapshots checked by the fences. New
   cycle metadata does not require rewriting those originals. Verify all old
   recovery identity/hash and superseded-challenge checks after migration.
6. Demand publication uses a new attempt-specific refresh-slot namespace, including
   source/manifest/attempt identity, on all success, hard-negative and retention
   paths. Do not overwrite/delete historical hourly slots or make uniqueness
   failure an ignored success. Existing regular slot keys remain unchanged.
   Demand WSH bypasses only the scheduler's hourly attemptedSlots/hasRefreshSlot
   shortcut, never the durable admission checks.

The SQL demand source predicate is narrowly a read-admission predicate; it must
not become an alternative entry eligibility evaluator. Match the TS predicate
with shared fixtures covering missing, expired, fresh, hard-invalidated and
recovered-unknown projections. A malformed provenance record remains a hold.
Keep locking in the existing authority/recovery/source-admission/head order;
document the concrete order in the implementation report and exercise concurrent
repair, claim, publication, final binding and authority adoption. Do not introduce
a repair-row-before-source-lock inversion. If the existing head-first preparation
path needs adjustment, limit it to this lock-order correction and cover it in
the hostile review.

## Files and delivery order

1. Critical shared/store implementation: `packages/shared/src/instrument-research/`
   `store.ts`, `repair.ts`, `marketaux-refresh.ts`, `wsh-refresh.ts`,
   `startup-recovery.ts`/diagnostic helpers only as needed; a small source-demand
   helper for the single fixed backoff/classification contract is permitted.
   New SQL migration and migration tests; associated unit/PG suites and barrel.
2. Producer/scheduler integration: `apps/llm-agent/src/research-refresh.ts`,
   `research-wsh-refresh.ts`, `index.ts`, and only the transport/error timing
   plumbing necessary to preserve provider cooldown, with associated tests.
   Establish shared signatures first, then delegate disjoint app files under
   this accepted contract. Never ask a worker to select critical retry defaults.
3. Existing execution preparation/status consumers and diagnostic formatting may
   receive narrowly required new acquisition fields; no entry/close/risk logic
   relaxation. Update research/startup runbooks and a new scoped implementation
   report, identifying superseded hourly recovery claims precisely.

All unrelated dirty backtest/ES files, `apps/signal-engine/src/signal-engine.ts`,
`.local/` and other agents' report work remain untouched/unstaged. No branches or
PRs. No operations in this design task. Runtime deployment requires accepted
implementation, the existing authorized deployment protocol and separately
recorded readiness/activation evidence; the plan does not itself lift entry pause.

## Acceptance and hostile checks

- Startup with fresh proved news+calendar performs no demand calls. One missing,
  expired or hard-invalidated source triggers only that source on the first pass,
  even when a recent failed attempt has a future regular deadline. A deployed
  parser fix with an older elapsed failure backoff works without hourly waiting,
  ledger edits, a new manifest, force-refresh switch or forged successful data.
- Both sources missing or independently unusable recover fairly; one unrelated
  source/financial HOLD does not suppress the other source's observation. Entry
  remains blocked until both actual source and all financial/risk guards pass.
- Persistent failures produce the exact30s/120s/10min durable backoff; process
  restart, multiple schedulers, repeated prepare calls, authority/source renaming
  and host-clock skew cannot reset it or create extra requests. Test equal-time
  admission races and bounded DB connection/lock failures.
- Existing WSH regular retries keep their three-attempt bound and timings.
  Demand cannot overlap a live/pending retry or start a second mechanism. WSH
  10281 with still-usable retained coverage creates no startup demand. At expiry,
  demand becomes eligible subject to actual endpoint/read/budget guards.
- Same-hour Marketaux failure then demand success produces distinct immutable
  attempts/calls/slots and truthful identical query-hour values where applicable.
  Same-hour repeated demand failure/retention and WSH demand publications do not
  collide or overwrite hourly evidence. Preserve source projection merge races.
- Unknown read requires the existing complete recovery proof; replacement has a
  new identity. Late predecessor receipts, calls, snapshot writes and outcome
  updates remain fenced before and after migration. Include old migration42
  original-row receipts and prepared legacy challenges, not only a fresh schema.
- All SQL admission forgeries fail: demand with fresh cache, wrong request,
  account, source, authority or kind; earlier backoff time; bypassed hourly floor
  on REGULAR; direct WSH acquisition; two concurrent demand claims. SQL/TS
  freshness and failure classifications agree.
- Provider/account caps are unchanged and atomic across instruments; no refund
  for unknown reads, empty denied-attempt loop or increased AI spend. Test
  Retry-After beyond the local cap, malformed/future values, cross-issuer cooldown,
  budget exhaustion/reset, shutdown and restart. Original source causes remain
  sanitized; no credentials, response body or account IDs enter committed logs.
- Recovered or rescheduled data never bypasses existing bind/validateBinding,
  source provenance, expiry, snapshot identity, old AI decision rejection, entry
  pause or unknown broker submission holds. Resume races with HARD/UNKNOWN still
  reject. Existing canonical legacy fixtures remain byte-identical.

Run focused new and existing shared startup/WSH/Marketaux PostgreSQL suites and
llm scheduler tests first, on isolated PostgreSQL. Then `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build` and clean Docker
build for the deployable release. No strategy/simulator changes, so no new
backtest experiment. Ensure integration discovery includes every new suite.
Obtain independent critical final review against the accepted plan, fix findings,
write evidence/report, publish only the reviewed scope on main and verify GitHub
CI for the exact commit. Stop for an accepted plan amendment if implementation
needs new broker lifecycle semantics, changed qualification or weakened
publication/entry guards. Passing implementation checks is not proof of real
provider availability, launch readiness or a completed Paper round trip.

### Migration inventory fixtures

The two execution migration inventory tests (notification checkpoint and strategy
conversion) add migration45 to their expected applied list. This test-only
maintenance changes no production execution or acceptance semantics.

Historical startup-recovery fixtures also explicitly expect the new default
columns on migrated attempts. Their pre40 setup seeds the original row shape,
including its original clock/protocol fields, instead of invoking current claim
code on a pre45 schema. Original fields, charges and audit evidence remain exact
comparisons; no production guard is relaxed.

The existing two-source scheduler PostgreSQL test expects one provider call after
a pooled HTTP429, rather than one per issuer: only the failed issuer receives a
negative snapshot, peers remain unpublished and uncharged, and all subsequent
claims report the pooled cooldown. Its UNKNOWN timeout assertions remain intact.

The ingestion auto-bootstrap PostgreSQL fixture cleanup follows the existing
session fixture: await removal of ended pool connections, then drop its unique
test database without FORCE. This addresses an observed administrator-termination
cleanup race without changing assertions or operational code.
