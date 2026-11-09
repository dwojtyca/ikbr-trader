# Explicit startup source revalidation

Date: 2026-11-09. Status: ACCEPTED by independent
`immediate_start_plan_review` (`gpt-6-astra` / high), after one amendment round
covering dispatch checkpoints, one-shot consumption and concrete lock order.
No blocking plan findings remain. Reviewer token telemetry is unavailable.
Critical architecture/implementation route: `gpt-6-astra` / high. Independent
plan and implementation reviewers must be different agents and neither may
review its own authored implementation. Actual dispatch settings and available
usage belong in the implementation report; unavailable telemetry is unavailable.

## Owner outcome and bounded amendment

An explicit `pnpm start`, including a repeated start after purchasing a provider
subscription, starts the configured Paper services and initiates required data
acquisition and synchronization immediately. It must not wait for the ordinary
hourly refresh or a local recovery backoff merely to test whether access has
changed. Actual provider throttles, budgets, active requests and unknown-read
retirement remain real admission constraints. Startup never implies successful
data acquisition, permission to trade or permission to repeat an unknown order.

This amends [startup freshness](STARTUP_RESEARCH_FRESHNESS_PLAN.md) only for one
bounded, authenticated explicit-start observation opportunity per configured
source. Existing automatic demand and periodic refresh retain their contracts.
The exact provider refusals `RESEARCH_WSH_ERROR_10276` and
`RESEARCH_WSH_ERROR_10277` become eligible for this explicit revalidation when
their durable evidence is proved. They remain HARD historical failures; no broad
HARD retry rule, entitlement assumption or cached-evidence promotion is added.
These names identify observed provider responses, not an assertion that every
such response means the same subscription condition.

Continue the [continuous Paper scope](CONTINUOUS_PAPER_OPERATION_PLAN.md) and
[automatic recovery contract](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md): PKO and
AAPL, one whole share/position per instrument, existing USD5/day AI budget,
proposal/AI/risk/execution bindings, entry pause and protective orders. No Live
activation, strategy change, provider purchase, client-ID rotation, TWS restart,
manual ledger edits, broadened account scope or new user interface belongs here.
The existing required Paper services are postgres, redis, execution-engine,
ingestion, llm-agent and signal-engine; backtest and deferred UI remain optional.

## Current source evidence

`classifyWshFailure` in `apps/llm-agent/src/research-wsh-refresh.ts` returns HARD
for these provider responses. Migration45's `research_source_failure_retryable`
allows only six named WSH HARD parser/normalization failures. Its
`research_source_demand` returns `HOLD/RESEARCH_SOURCE_FAILURE_UNPROVED` for a
nonallowlisted terminal failure before calculating demand timing. The store
persists that acquisition HOLD; the scheduler skips sources without WAITING
acquisition. Only regular WSH admission remains, with its stored one-hour floor.
Restarting the process or repeating preparation does not change that evidence.

`PaperRuntime.start` already brings up all required Paper services after acquiring
its authenticated startup pause. It then awaits `prepareBootstrap` before
entering `waitPreparation`. A long history bootstrap would delay registration of
any new explicit-start research request added only inside that latter loop.
The llm scheduler already runs `tickRepairs` immediately after manifest setup and
every two seconds thereafter. Reuse that worker; do not add another fetch service.
Compose up can leave an existing container running, so constructor discovery
alone cannot implement a repeated explicit start.

Source inspection establishes these mechanisms, not current operational state.
The reported 10:05–11:05 UTC failure interval and purchased subscription need
fresh supported API/provider observations after release to establish recovery.

## Explicit-start authority and durable one-shot semantics

Reuse `POST /execution/entry-control/start/prepare`, its bearer authentication,
`expectedRevision` and `EntryControlStore.withStartupPause`. This already proves
the current account, exact paused revision and audited `paper-start:<UUID>`
reason. No unauthenticated force flag or caller-chosen source/account is added.
The execution service registers acquisition intent only; llm-agent remains the
research provider caller. Normal proposal preparation does not create this
authority.

Add a narrow `research_startup_source_requests` table in migration46 (verify the
next unused number before implementation), keyed uniquely by account, startup
pause revision, config hash, manifest hash, instrument, source and role. Record
the creation DB timestamp, exact startup control-event identity and the observed
predecessor identity where present. Identity/creation evidence is immutable.
Pending requests transition at most once to a terminal disposition containing
the exact joined or newly admitted attempt identity, or `FRESH`/`SUPERSEDED`.
SQL guards reject deletion, resetting consumption, replacement identities and
forged dispositions. A consumed request cannot authorize another attempt.

Registration and preparation are one transaction under the existing startup
pause/account fence. Repeated prepare polls, HTTP retry after a lost reply and
service restart reuse the unique row. A new explicit start has a newly audited
pause revision and may create a new row. This intentionally permits the owner to
test changed external access without waiting for the prior project cadence;
actual pooled budgets/throttles and serialization still prevent excess dispatch.

Evaluate required sources independently:

- Fresh, complete, current-manifest, provenance-proved usable data consumes the
  opportunity as FRESH and dispatches nothing.
- A live acquisition or an already authorized in-cycle retry is joined under its
  existing identity and consumes this opportunity. No second retry mechanism
  races it; failure of joined work does not mint another explicit-start allowance.
- Missing/stale data or a proved normally retryable failure requests one new
  DEMAND acquisition without the local 30s/120s/10min or ordinary hourly floor.
- The exact two WSH refusals above also request one DEMAND acquisition only after
  the additional durable refusal proof below.
- Uncertain reads first use existing retirement/generation fencing. They never
  reuse an old ticket or relabel an unknown outcome; after committed retirement
  a still-pending request can admit one fresh identity.
- Invalid current configuration, authority, qualification/entitlement declaration,
  permission/retention, provenance or unsupported failure remains a precise HOLD.
  Recording a startup request does not repair any such prerequisite.
- Exhausted local budget, actual provider cooldown and Marketaux HTTP402 usage
  hold remain effective. In particular explicit startup does not bypass the
  pooled402 proof requirement or reinterpret401/403 as retryable. Deferred
  requests remain visible and wake when an existing supported prerequisite clears.

Registration pins the latest applicable predecessor and head identity and makes
the FRESH/no-work disposition atomically in that transaction. It cannot leave an
unused pending token for a later unrelated failure. If a concurrent publisher
makes data usable before admission, consume FRESH under admission locks. Any
newer applicable attempt after registration consumes JOINED, even if that attempt
already completed before the claim; compare against the pinned predecessor and
DB creation timestamp, not only active rows. A single admitted attempt consumes
the request even if it fails, is cancelled or later becomes unknown. A lost claim
commit acknowledgement permits only exact supported readback; no guessed
dispatch, unconsumption or repeated claim with another identity.

The request is usable only while its exact startup revision/account/authority
remains current and paused. Superseded start, explicit stop, resume, manifest
change or account change prevents new admission from that request. Revalidate
the exact startup revision and current authority at every not-yet-sent call
reservation and final dispatch checkpoint, including each Marketaux page/pass
and WSH events after successful metadata. Preserve the existing short
reservation/dispatch deadline checks and local abort fences. No transaction spans
network I/O and no atomic database/provider transaction is claimed: supersession
after the final checkpoint can race an already dispatched read, which must settle
under its original identity and existing audit/publication fences.

A refusal before reservation sends nothing and creates no call debit. If a call
was reserved but its dispatch/outcome cannot be proved, preserve the charge and
use the existing UNKNOWN/retirement protocol; never fabricate a remote FAILED or
successful receipt, refund, replay or unconsume the startup request. Original
proved completed calls remain unchanged. Already dispatched reads may settle
under their existing fences without granting entries; no additional unsent call
may be authorized by the superseded startup request. A newly recorded startup
request cannot cancel another process's read.

## Refusal proof and SQL admission

Do not change `classifyWshFailure`, rewrite old failure rows or widen the ordinary
`research_source_failure_retryable` HARD allowlist. Add an exact explicit-start
predicate for10276/10277. Require all of:

1. A terminal FAILED WSH attempt, HARD failure class, exact matching reason and
   preserved provider-error JSON numeric code10276 or10277; missing keys, null,
   string codes, mismatched reason/code or message-only matches reject.
2. Failure stage metadata or events, confirmed/not-needed owned cleanup, a linked
   FAILED and retired acquisition, current applicable ledger/source identity,
   and the original negative publication matching the failure. No orphan or
   forged call-free failure is retry authority.
3. At least one matching reserved provider call with proved FAILED outcome, and
   every acquisition call has a known matching outcome recorded by terminal
   completion, with the existing account/provider/config/manifest links intact.
   Unknown/missing outcomes require existing retirement rather than this shortcut.
4. Current unchanged permission/retention and valid configured qualification,
   endpoint and source identity still pass. The new read establishes whether the
   external refusal is gone; the old refusal is never treated as evidence of
   access or valid research.

Keep the existing DEMAND attempt kind and attempt-specific publication namespace.
Associate a claimed startup request with its Marketaux attempt or WSH cycle in
the new request table; do not add columns to WSH attempt/acquisition rows because
historical recovery receipts compare their complete original row values.
Admission and request consumption commit atomically with the new acquisition
attempt/cycle. Direct SQL claim guards independently prove the request and exact
source condition; a TypeScript-only timing exception is insufficient.

The source-acquisition diagnostic reports explicit-start request state and its
actual constraint separately from `nextRegularAt`. A pending valid startup
request must be discoverable by the existing due-repair path even after an older
repair row was HOLD or had a future local deadline. Only the explicit allowance
omits local cadence/backoff; actual Retry-After/429 and pooled usage/budget guards
remain at both admission and dispatch where currently enforced. Existing WSH
endpoint lease, issuer serialization, metadata-before-events, ordinal-zero-only
DEMAND cycles and immutable original receipts remain unchanged.

Freeze lock order before code: account startup-control lock precedes research
authority/recovery/source locks for explicit-start registration, admission and
dispatch checkpoints. For explicit paths acquire that row lock before
`wshTransaction`'s recovery-table SHARE and before `marketauxTransaction`'s
recovery/attempt-table locks, not in their already-locked callbacks. Ordinary
paths retain their existing order. `withWshEndpointLock`'s outer session advisory
lease is a permitted exception: acquisition is nonblocking try-lock, outside
transactions, and startup-control holders must never wait for that session
lease. Startup registration/preparation reads state without acquiring it. No
account-control row lock is held across provider I/O. Direct-SQL guards verify
the same current row with nonblocking locking (NOWAIT) if the caller has not
prelocked it; rejection is preferable to a reverse-order wait or stale admission.
Within research, preserve existing endpoint/issuer/attempt/budget/head order.
Request disposition is acquired only after the source admission lock; registration
must not retain a request-row lock while entering source admission. Ordinary
claims never acquire startup-control locks after source locks. If implementing
the single atomic exception requires violating this order, stop for plan review
instead of introducing an inversion. No transaction spans provider I/O.

## Startup sequencing and diagnostics

Keep existing release-image verification, account validation, durable startup
pause and all-services Compose up ordering. After those services are started and
the account/revision is confirmed, run history/bootstrap preparation and research
preparation concurrently. The research loop registers/reuses explicit intent on
its first authenticated prepare call, without waiting for history completion.
Use existing two-second repair discovery to dispatch; no container restart is
required. Synchronization/diagnostics continue when one source is held.

Resume still requires successful completion of both preparation branches and all
existing final account/configuration/revision/financial/source checks. On a branch
failure or user interruption, stop/drain the sibling local wait through a scoped
abort mechanism and preserve the existing pause/stop behavior. Do not leave an
unobserved promise that can later resume trading. Cancelling a local wait never
claims provider cancellation or erases an admitted read. Do not rewrite ingestion
bootstrap or financial reconciliation; demonstrate their existing independent
startup behavior in tests.

Polish diagnostics distinguish requested immediate read, joined existing read,
actual provider refusal, budget/provider deadline, pending unknown-read recovery
and unusable configuration. Never print a future regular hour as the earliest
explicit-start acquisition when an allowance is pending. Preserve sanitized
original names/codes/messages; do not log raw provider payloads or private IDs.

## File ownership and implementation order

1. Critical shared contract: new migration46; `packages/shared/src/instrument-research/`
   `store.ts`, `source-demand.ts`, `repair.ts`/barrel only as needed; focused new
   explicit-start PostgreSQL tests plus existing historical recovery fixtures.
2. Execution integration: `apps/execution-engine/src/research-prepare-route.ts`
   and its tests; `entry-control.ts` only if narrowly necessary to reuse the
   existing lock/authority proof, with associated tests. No resume/risk relaxation.
3. Producer integration: `apps/llm-agent/src/research-refresh.ts` and its tests,
   shared call signatures/types and `research-wsh-refresh.ts` only as necessary
   to carry admission association. Do not change WSH failure classification.
4. Startup orchestration: `tools/paper-verify-stack/src/paper-runtime.ts` and
   tests, with narrow adapter cancellation plumbing in its CLI if required.
5. Update relevant startup/continuous/WSH runbooks and add a scoped report. Update
   migration inventory tests only where the new migration requires them.

Integrate shared contracts before delegating disjoint application changes.
Critical SQL/authority work and hostile review use Astra/high; known-contract
application wiring may use Sol/medium after contracts are accepted. Preserve all
existing dirty ES/backtest/signal-engine files, `.local/` and the unrelated
automatic-recovery report. Work on main, no branch/PR and no blanket staging.

## Acceptance and hostile validation

- With metadata10276 or10277 terminal evidence ten minutes old and next regular
  hour fifty minutes away, a new authenticated start admits exactly one fresh
  attempt immediately; actual metadata/events success is needed for readiness.
  Persistent refusal preserves HARD history/HOLD and does not repeat every poll.
- Repeated prepare, lost registration/claim replies, two schedulers, process
  restart and concurrent starts cannot consume one request twice. New explicit
  revisions may each request one observation under unchanged real provider limits.
- An initially fresh source consumes FRESH during registration; a later failure
  cannot use that old request. A newer attempt that fails/completes between
  registration and claim consumes JOINED. Supersession between metadata and
  events, between Marketaux pages and after reservation/before dispatch forbids
  the unsent call, preserves charged UNKNOWN evidence where necessary and never
  recreates the one-shot allowance.
- Fresh sources make no calls. Missing/stale and normally retryable sources bypass
  local recovery cadence once. Active attempts/retries join without parallel
  reads; unknown read retirement, late replies and publication fences remain exact.
- Direct SQL forgery rejects wrong account/revision/source/authority, expired or
  foreign startup intents, mutable identities/consumption, malformed refusal proof,
  absent/unknown calls, spoofed failure stage/code and unproved negative publication.
- HTTP401/403,402 usage hold,429/Retry-After, exhausted daily budgets and invalid
  qualification remain blocked. Caps and debits survive restarts and new revisions.
  Refused/no-op admission creates no fake provider debit or successful evidence.
- Concurrent publish/prepare/admission, start/stop/resume and authority rotation
  exercise lock ordering and supersession. Historical recovery receipts remain
  byte-identical and valid after migration; original attempts and charges persist.
- A deliberately blocked ingestion bootstrap still allows the first research
  prepare/dispatch after all services start. A blocked research source does not
  prevent history/synchronization. Neither branch alone can resume entries.
  Test rejection, cancellation and sibling draining without dangling resumptions.
- Existing source/entry binding, unknown broker submission, protected positions,
  original AI decisions and deterministic risk remain fail-closed.

Run focused shared PG, scheduler, execution route and runtime tests first against
isolated PostgreSQL only. Then `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration`, `pnpm build`, and a clean Docker build. No strategy or
simulator behavior changes, so no new strategy backtest is required. Validate
document links and reviewed diff. Obtain a different independent critical final
review, repair findings, report exact commands/results and model/effort/repair
evidence, commit/push only accepted scope and verify CI for that exact commit.

Deployment and real readiness are separate from implementation acceptance. Use
the authorized pinned-release/backup/pause procedure; never change operational
rows to manufacture eligibility. Report fresh actual provider results and the
remaining precise hold if purchased access is still not available to this API
session. No claim of successful startup, usable research or Paper operation is
made solely from tests, subscription purchase or this plan.
