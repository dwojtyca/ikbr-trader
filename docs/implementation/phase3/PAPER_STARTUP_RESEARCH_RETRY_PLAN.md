# Automatic Paper startup: bounded research retries and continued observation

Date: 2026-11-02. Status: ACCEPTED by independent reviewer
`/root/startup_retry_plan_review` (Astra/high), after one clarification round.
Implementation requires a different independent hostile reviewer.
This plan does not claim implementation or operational acceptance. Follow
[automatic recovery](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md),
[continuous Paper](CONTINUOUS_PAPER_OPERATION_PLAN.md), and the
[two-source contract](TWO_SOURCE_RESEARCH_HOURLY_PLAN.md). The owner's current
request authorizes repairing automatic startup after stale weekend data and
unnecessary waits after failed reads. It does not authorize weaker research
acceptance, provider quota resets, broker-write shortcuts or Live activation.

## Evidence and actual cause

The current llm-agent already calls both regular refresh and repair immediately
on startup; later scans run every60s and2s respectively. With no active attempt or
inherited pacing fence, stale Friday data can be fetched immediately on Monday.
There is no intended new one-hour startup sleep.

The observed Nov2 WSH attempts for PKO and AAPL instead failed with provider10281,
classified BUSY, with CONFIRMED local cleanup. `finishWshAttempt` schedules30s and
120s retries only for TRANSIENT failures. Its SQL CHECK has the same restriction.
BUSY therefore waits for its immutable hourly cycle deadline. The original
[hourly plan](WSH_HOURLY_REFRESH_PLAN.md) intentionally retained that behavior;
the hour is regular refresh pacing, not an IBKR error-specific recovery mandate.

WSH10281 does not establish that a foreign/global request is present. The lead's
current official IBKR documentation check describes another pending request for
the same API client. Current transport cancels its owned request IDs, observes
local send/close and waits25ms after send. CONFIRMED proves this local cleanup;
it does not prove the provider cleared an earlier pending request with a different
ID. A bounded new read may recover temporary BUSY, but cannot guarantee resolution
of persistent provider state. No client-ID rotation, guessed cancel ID, cancelling
another client's work or routine TWS restart belongs to this change.

The observed AAPL Marketaux attempt received a successful response and then
failed HARD with `RESEARCH_MARKETAUX_PAYLOAD_INVALID`; PKO succeeded. Its exact
failed predicate is currently unavailable. The pending
[payload diagnostics amendment](MARKETAUX_PAYLOAD_DIAGNOSTICS_AMENDMENT.md)
adds fixed labels without relaxing parsing and is an explicit prerequisite for
explaining that failure. Successful transport is not complete valid news.

Marketaux's hour is separately enforced by `claimMarketauxAttempt`, the SQL
attempt guard, account/issuer/hourly-slot uniqueness and refresh-slot publication.
Changing a scheduler timer cannot safely add same-hour attempts. This minimal
package retains that contract, including no immediate429 retry. A fast retry for
HARD invalid payloads is not justified by the available evidence. Faster known
Marketaux transient attempts would require a separately reviewed attempt/slot/
publication identity migration; it is not hidden inside this WSH repair.

Two related startup defects are in scope: `inspectResearch` treats only WSH
TRANSIENT as retryable WAITING, and the CLI terminates on any valid research HOLD,
leaving the startup pause behind even when normal periodic work later repairs the
source. Also `marketauxAdmissionReasons` still selects recovered UNKNOWN rows,
unlike claim admission and the supplementary status scan.

## A. WSH BUSY uses the existing bounded retry authority

Keep regular cadence, source policy/hash, original cycle timestamps, ordinal0/1/2,
35s attempt bounds and30s/120s settlement-based backoff unchanged. Extend fast
retry eligibility only to a terminal FAILED/BUSY attempt whose exact failure
reason is `RESEARCH_WSH_ERROR_10281`, sanitized provider code is10281, and cleanup
is CONFIRMED. TRANSIENT retains its existing CONFIRMED/NOT_NEEDED rule. Do not
reinterpret unknown acquisition/publication or cleanup as a known BUSY result.
Specifically, `acquisitionOutcome === 'UNKNOWN'` prohibits a BUSY fast retry even
when the outer result is FAILED/BUSY. Validate this before storing retry authority;
retain the original uncertainty and its existing admission/recovery fences.

Persist the retry deadline atomically with a newly completed eligible attempt.
Claim only under the existing endpoint lease, issuer lock, current authority,
session identity, active-attempt/pending-acquisition exclusions, recovery fences,
rolling WSH pacing and account/provider reservations. No retry at or after the
original next-regular deadline; no fourth attempt. Repeated BUSY after two retries
continues normal hourly observation with the true reason visible. This is an
explicit retained request bound, not a claim that every failure now recovers
within minutes. No old terminal row or result hash is edited to invent a retry
deadline: already-settled pre-deployment BUSY waits for the next legal regular
cycle. Deployment must report that inherited wait honestly.

Use one additive migration, next number allocated by the lead (currently44;
recheck before implementation). Replace only the verified existing retry CHECK
with the exact additional BUSY predicate above; unexpected schema fails closed.
The new SQL BUSY branch must be NULL-safe: require the entire branch to be
`IS TRUE` (or equivalently coalesce it to false), with provider_error an object
whose `code` is a JSON number exactly10281. A missing key, SQL NULL, JSON null,
string `"10281"`, wrong value or malformed shape must reject retry authority;
SQL CHECK's ordinary acceptance of NULL must not admit an unknown predicate.
Keep the pre-existing TRANSIENT branch semantics unchanged. For a BUSY attempt
with a linked acquisition, SQL admission must also reject an UNKNOWN acquisition
outcome rather than trusting the outer attempt classification alone.
Keep all current migration42 attempt-admission recovery checks. Do not modify
historical migration checksums, attempts, cycles, outcomes, charges or recovery
receipts. If SQL needs any additional predicate change, keep it semantically
equivalent to the application contract and test direct SQL attempts.

Preparation must recognize this exact finite BUSY retry as WAITING, with the
same durable nextRetryAt reported by due discovery. Update the aggregate calendar
error suppression only for an actually WAITING retryable source; never suppress
HARD, UNCERTAIN, absent proof or cleanup UNKNOWN. Preserve fresh-cache TTL and
existing source provenance. On exhaustion, stale/missing coverage remains HOLD;
the CLI observation change below keeps watching without granting entry permission.

## B. Receipt-aware Marketaux admission

Make the admission unresolved-attempt selection agree with the existing recovery
contract: an exact immutable `research_marketaux_recoveries` receipt excludes
only its matching recovered predecessor from the unresolved STARTED/FINALIZING/
UNKNOWN branch. Match attempt ID, account and issuer ledger; rely on existing
receipt identity/deadline/method validation and immutability, and exercise that
validation with real PostgreSQL fixtures. Do not ignore rows merely because a
diagnostic says RECOVERED or because some later row exists.

Recovery never turns an old source error into successful coverage. Missing/stale
coverage remains WAITING for a legally admitted new attempt; any otherwise valid
cache still passes current provenance, TTL, authority, rights and all other
admission checks. Non-recovered unknowns, orphan reservations, HARD failures,
failed outcome/projection proof and active maintenance challenges still hold.
Retain original attempt history and charged requests; the next regular hour floor
is unchanged. If the negative snapshot independently requires HOLD, keep that
HOLD until fresh valid acquisition rather than weakening it to make a test pass.

## C. Startup continues observing valid research holds

In `PaperRuntime.waitPreparation`, a successfully authenticated, shape-valid
preparation response containing HOLD is a reason to remain paused and report the
source problem, not terminate the owner's continuous startup command. Poll with
the existing cancellable5s cadence. De-duplicate unchanged diagnostics, expose
known nextRetryAt/nextRegularAt even for HOLD, and state clearly when a hard source
failure has no promised repair time. Do not trigger a provider call from the CLI;
the regular/repair scheduler remains the sole acquisition owner.

This changes observation only: no HOLD or WAITING response reaches resume.
After every source reports READY, reuse the existing resume transaction with
fresh research/risk/account/reconciliation/session checks. Keep exact account,
startup generation, original durable pause revision and stop/AbortSignal checks
before and after every request. Operator pause/revision/config changes supersede
the start. Authentication, malformed protocol, unsupported configuration and
definitive control errors retain their existing terminal behavior. Unknown resume
or other mutation outcomes must never be retried under a read-recovery rule.
No process-independent auto-resume daemon or permission to clear owner pause is
introduced. If the CLI is stopped, existing start/stop semantics still apply.

## File ownership and sequence

1. Independent Astra/high reviewer accepts this bounded contract before code.
2. One critical implementation owner changes
   `packages/shared/src/instrument-research/store.ts`, `repair.ts`, their existing
   `repair.test.ts`, `wsh-recovery.pg.test.ts`, `startup-recovery.pg.test.ts` and
   relevant existing Marketaux PostgreSQL suite, plus the additive SQL migration.
   Reuse `wsh-refresh.ts` constants/types; change it only if the accepted predicate
   needs a shared representation. Same owner controls migration/check fixtures.
   The migration inventory assertions in execution-engine's
   `src/lifecycle/notification-checkpoint.pg-integration.test.ts` and
   `src/strategy-conversion.pg-integration.test.ts` must include migration44;
   their historical data preservation and idempotency assertions stay unchanged.
3. After that contract is fixed, a separate bounded integration worker may own
   `apps/llm-agent/src/research-wsh-refresh.test.ts`,
   `research-wsh-refresh.pg-integration.test.ts`, `research-two-source-refresh.test.ts`
   and `tools/paper-verify-stack/src/paper-runtime.ts`, `paper-runtime-cli.ts`,
   `paper-runtime.test.ts`.
   Scheduler production code changes are permitted only if tests expose a failure
   to discover the existing due retry; no new timers/provider pathways.
4. Include the already accepted diagnostics changes in
   `apps/llm-agent/src/research-marketaux.ts` and its test file, preserving their
   exact existing work. Do not broaden parser acceptance without real evidence
   and a reviewed amendment. Coordinate with the lead before touching dirty
   runtime files. This release explicitly incorporates the existing reviewed
   HTTP-recreation repair in `paper-runtime.ts`, GET response classification in
   `paper-runtime-cli.ts`, and associated runtime tests, as specified in the
   rollout amendment of the automatic recovery plan. Preserve its wait after
   Compose recreation, exact original paused revision/account and cancellation
   checks, terminal malformed successful GET/definitive client errors, retryable
   availability reads, and unchanged unknown-outcome treatment for POST. Report
   this included baseline separately from the new research retry changes; do not
   stage unrelated accounting CLI, signal-engine or other dirty changes.
5. A different independent Astra/high agent performs final hostile review of the
   integrated migration, preparation/admission and CLI semantics. Lead owns report,
   isolated release, scoped commit/push and exact-commit CI. All unrelated dirty
   ES/backtest/signal/accounting-owner/documentation work remains untouched.

Implementation/review routes are Astra/high because research eligibility and
persistent retry authority are critical. No author reviews its own code. Record
requested/actual model and effort, findings/repair count, elapsed time and token
usage if exposed (otherwise unavailable). A semantic/schema expansion, persistent
10281 requiring unknown-request handling, or parser-relaxation proposal stops for
lead review and an independent plan amendment.

## Acceptance and hostile cases

- Weekend fixture: both sources older than24h and no current pacing/active fence
  cause immediately admitted normal reads on scheduler startup; no wall-clock
  hour wait. Fresh valid cache permits ordinary readiness without refetch demand.
- WSH known BUSY10281 plus confirmed owned cleanup admits exactly two successors
  at settlement+30s/+120s, including across process restart. Wrong provider code,
  missing diagnostic, HARD, UNKNOWN cleanup/outcome, forged direct SQL retry,
  early claim, fourth attempt and original cycle-boundary retry reject.
  Direct SQL fixtures cover absent provider_error, missing code, JSON null,
  string code, wrong numeric code and malformed provider shape. Include outer
  FAILED/BUSY with acquisitionOutcome UNKNOWN and a linked UNKNOWN acquisition;
  neither application nor SQL may grant fast retry authority. Existing TRANSIENT
  CONFIRMED/NOT_NEEDED admission remains unchanged.
- Simultaneous periodic/repair/second-process claims produce one admitted attempt.
  Both instruments receive fair due work; another active endpoint request remains
  excluded. Budget exhaustion/pacing denial causes no unreserved transport call.
  STOP and stale callbacks cannot publish or dispatch. No guessed cancellation.
- Successful retry publishes normal complete coverage with its own original
  receipt; retained cache timestamps and legacy cycles/hashes remain unchanged.
  No-success BUSY stays WAITING only while an eligible retry remains, then HOLD
  until an ordinary valid acquisition. Persistent10281 is reported, not healed.
- Recovery fixture: expired fenced Marketaux attempt receives a genuine recovery
  receipt; admission no longer flags that predecessor solely as unresolved. It
  cannot make incomplete news READY. Missing/wrong-account/wrong-ledger/malformed
  receipt and unrelated orphan/HARD failure remain blocked. A new attempt obeys
  its original hourly lower bound and charged budgets. Late predecessor completion
  remains fenced; no unknown provider work is replayed.
- CLI receives WAITING, then BUSY-related HOLD or HARD payload HOLD, then actual
  READY and resumes exactly once through the supported endpoint. While holding,
  stop, AbortSignal, changed revision/account and malformed/auth responses prevent
  resume. Repeated identical HOLD does not spam output. Failed/unknown resume is
  never transformed into permission to repeat a mutation.
- Included HTTP-recreation baseline: post-Compose HTTP refusal,5xx and known
  account-hydration delay resume observation with the same account/pause revision
  and no repeated pause or Compose operation. Changed account/revision, unpaused
  state, stop and authentication/protocol errors deny progress. Malformed GET2xx
  is terminal; non-JSON GET401/403 stays terminal and malformed GET5xx remains
  availability. Malformed POST423 remains unknown with no repeated resume.
- Payload diagnostic fixtures keep identical valid/invalid parser acceptance and
  persist only fixed code-authored labels, never strings from provider payloads.

Run focused shared unit/PostgreSQL, llm refresh and runtime tests, then `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` using isolated PostgreSQL,
and `pnpm build`. Use package scripts/environment guards already in the repository;
no destructive operational DB or real provider fixtures. No strategy/simulator
change means no new strategy backtest. A clean pinned Docker build and isolated
production-wired startup/restart test are required before rollout. Write
`PAPER_STARTUP_RESEARCH_RETRY_REPORT.md`, publish only reviewed scope on main and
verify exact-commit GitHub CI. Do not call failed/unverified checks complete.

## Operational acceptance and explicit limits

### Bounded cleanup diagnostics amendment

The 15:48 UTC normal cycle repeated WSH10281. No plaintext local API logs were
found. Source inspection showed that cleanup marks the transport closed and drops
request listeners before owned cancellation; the remaining error listener ignores
closed transports. An observed cancellation failure can therefore disappear.

Extend only `apps/llm-agent/src/research-wsh-transport.ts` and its existing unit/
wire tests to retain an actually observed provider10280 (metadata cancellation) or
10284 (event cancellation) during the existing cleanup window. Install the bounded
listener before dispatch, mark the exact owned request/kind immediately before
its matching cancel call, and ignore global, foreign, wrong-kind, pre-cancel and
post-finalization errors. Preserve the first valid sanitized cause in the existing
`cleanup.sourceError` field and durable `cleanup_error`; preserve the original
attempt failure separately. Existing local cleanup failures take precedence over
the first cancellation diagnostic; do not call the state-changing `failed()` helper
for a diagnostic-only observation. Keep current cleanup state, verified-local-closure,
timers, calls, publication and retry decisions unchanged. This is diagnostics only,
not a cancellation acknowledgement or proof the server cleared its pending read.
No observed failure means unavailable cancellation outcome, never confirmed success.

Test synchronous and asynchronous matching failures for both kinds, unmatched/
global/late errors, first-cause retention, secret-safe diagnostics, removal of the
temporary listener, unchanged confirmed/unknown closure classification and no
extra calls or delays. Prove existing durable cleanup-error propagation in a
targeted store/refresh fixture. Independent plan amendment acceptance precedes
implementation; the independent final reviewer covers this added diff. Full checks
and clean image must cover the amended release.

After reviewed release, back up private configuration/DB, preserve source manifest,
account authority, pause, AI USD5/day and source budget history. Use the existing
authorized start flow. Observe real normal attempts, next deadlines and sanitized
provider causes; do not run ad hoc requests or manufacture errors to get evidence.
Readiness, Paper activation and natural entry/exit evidence remain separate.

This minimal implementation removes the gratuitous first-hour fallback for newly
settled, proved WSH BUSY and keeps startup alive while sources recover. It does
not prove persistent10281 can be cleared automatically, identify AAPL's malformed
field before diagnostic deployment, or add Marketaux same-hour attempts. Those
limitations must remain visible in the report; resolving the observed HARD
payload failure may require a separate evidence-driven follow-up before the
owner's complete operational outcome can be claimed.
