# Marketaux recovery and original acquisition diagnostics

Date: 2026-10-13. Status: ACCEPTED by independent `wsh_plan_review` (Astra/high), after one
revision round tightening legacy deadline/correlation proof.
Baseline: `3bbf8c7` on main. Parent contracts:
[continuous operation](CONTINUOUS_PAPER_OPERATION_PLAN.md),
[PP4 provider normalization](PP4_PROVIDER_CONTRACT.md), and
[WSH original diagnostics](WSH_CANCELLATION_DIAGNOSTICS_PLAN.md).

## Owner request and evidence

Preserve original error identity and wording when acquisition errors are wrapped,
show that information alongside the application's own reason, and automatically
recover from a transient Marketaux acquisition failure without permanent demand
HOLD. Keep missing research ineligible throughout recovery. This is a bounded
research acquisition/diagnostic change, not permission to retry broker orders,
AI requests, WSH acquisitions, or an already reserved HTTP request.

The lead observed one failed PKO acquisition among thirteen successful calls.
Its request ran from 12:15:18.164 to 12:15:28.165 with a deadline at 12:15:28.160
and durable UNKNOWN outcome. Native HTTPS can deliver AbortError / ABORT_ERR /
“The operation was aborted” when the internal deadline fires, before the current
custom timeout error. createMarketauxFetch replaces that error with a generic
RESEARCH_MARKETAUX_ACQUISITION_FAILED and drops its original fields. These source
observations explain a plausible mechanism; the historical row does not contain
proof of the lost original error and must never be backfilled with that inference.

inspectResearch treats every negative source result as HOLD. runRepairs selects
only missing/stale WAITING sources; periodic work skips Marketaux in on-demand
mode. Consequently one transient negative snapshot can prevent future acquisition
indefinitely. Existing repair rows/events, refresh slots, reservations, outcomes,
provider budgets and per-instrument advisory locks are reusable.

Preserve dirty backtest work and `apps/signal-engine/src/signal-engine.ts`. No
strategy, scheduler cycle/concurrency, order, AI gate, accounting, entitlement,
qualification, provider pricing, or source-completeness changes. Implementation
and tests perform no external provider or broker calls. Work directly on main;
no branch/PR and no blanket staging.

## A. Original error contract

Keep the current WSH `{code:number|null,message}` providerError contract and its
validation, rendering and legacy hashes unchanged. Add a separate optional
`sourceError` to negative HTTP-backed source coverage, including generic issuer/
SEC acquisition and Marketaux, for both currently readable snapshot versions.
The absence of this optional property preserves existing canonical bytes/hashes.
It is valid only on ERROR coverage for HTTP-backed source adapters, not successful
coverage, WSH evidence or arbitrary roles. Successful later refresh removes it
with the old source-role result. Existing immutable snapshots are never edited.

The exact diagnostic structure is bounded and strict:

- `name: string | null`, original Error.name when available;
- `code: string | number | null`, original native or provider code when available;
- `message: string`, original wording after sanitization;
- optional `httpStatus: number`, validated 100–599;
- optional `httpStatusMessage: string`, original response status message;
- optional `providerCode: string | number | null` and `providerMessage: string`,
  only when actually read from the supported JSON error envelope.

Names/codes are at most 100 characters, each message at most 1000. Null or omitted
fields mean unavailable, never an invented original. Do not copy the application's
own normalized reason into an 'original' field when no originating error exists.
Preserve the deepest already-captured originating diagnostic across subsequent
wrappers rather than replacing it with wrapper text. Retain an Error cause in
memory only in sanitized form; no raw credential-bearing Error/stack may reach
logging, persistence or returned API data. Never stringify arbitrary thrown
objects; inspect only the named primitive fields of Error or a known transport
error shape. Non-Error/string throws may preserve a bounded sanitized string;
unknown objects get a truthful unavailable description.

Reuse safeDiagnosticText for account/secret redaction, control/bidi escaping and
bounds; additionally remove URL userinfo and credential/query values before any
capture. Redact explicitly supplied API/execution tokens and known account IDs,
including encoded token forms. Do not retain request URLs, query strings, headers,
request/response objects, raw error bodies, stacks, arbitrary nested fields or
financial-source document content. Re-sanitize/validate at operator rendering.
Original/provider text remains untrusted display data and never selects recovery
or grants readiness. Privacy tests include tokens inside native messages, JSON
fields, URLs, percent encoding, newlines, ANSI/bidi and wrapper causes.

The coherent boundary is the shared bounded HTTP fetch, its Marketaux wrapper,
issuer fetch wrapper and generic/Marketaux refresh catch-to-snapshot paths, plus
preparation/status rendering. Existing WSH originals must survive untouched.
This package does not promise a repository-wide conversion of unrelated errors.
Add one enduring core rule to AGENTS.md: when replacing an external error with an
internal code, preserve the sanitized original name/code/message as a diagnostic
cause; never log credentials or raw payloads. This records the owner's 'always'
direction for future work without claiming historical unrelated catches were fixed.

### Shared implementation interface

Export from `@ikbr/shared/instrument-research`:

- `ResearchSourceError`, the strict diagnostic shape above;
- `ResearchSourceHttpDetails`, its optional HTTP/provider fields;
- `isResearchSourceError(value: unknown): value is ResearchSourceError`;
- `captureResearchSourceError(error: unknown, privacy?: DiagnosticPrivacy): ResearchSourceError`;
- `sanitizeResearchSourceError(value: ResearchSourceError, privacy?: DiagnosticPrivacy): ResearchSourceError`;
- `formatResearchSourceError(value: unknown, privacy?: DiagnosticPrivacy): string`;
- `ResearchSourceFailure extends Error`, constructor
  `(reason: string, original: unknown, privacy?: DiagnosticPrivacy, httpDetails?: ResearchSourceHttpDetails)`,
  exposing `sourceError: ResearchSourceError` and only a sanitized Error cause.

Capture first preserves a valid already-attached sourceError; otherwise it reads
actual native error primitives. Internal RESEARCH_* wrappers without an original
cause and unavailable values produce null name/code and an explicit original-
unavailable message, never the normalized own reason presented as an original.
HTTP construction can pass null original plus observed status/statusMessage and
supported provider envelope fields; no fictitious native Error name is invented.
The stable own Error.message remains the first constructor argument. HTTP details
are sanitized at construction. Renderers accept unknown and validate again.
Transport selects the stable reason from trusted events/status/native-code facts;
shared capture/format helpers never decide whether to recover.

## B. Transport and HTTP behavior

Keep the ten-second per-request and 120-second whole-acquisition deadlines, byte
caps, HTTPS-only URL
allowlist, public-address/DNS checks, pinned resolved address, no redirects and
provider request budget reservations. Normalize internal deadline cancellation to
RESEARCH_SOURCE_TIMEOUT while preserving the actual native AbortError fields if
observed. Set/check the trusted local deadline state before aborting so callback
ordering cannot turn a known timer timeout into generic ACQUISITION_FAILED.
Do not classify arbitrary caller/shutdown cancellation as timeout. Settlement is
once-only; late end/error/abort callbacks cannot replace the original failure,
produce success, revive a stopped scheduler, or issue another request.

For non-200 responses preserve actual status/statusMessage. For Marketaux JSON
errors read only a bounded error envelope (maximum 16 KiB, also within remaining
request/acquisition byte and time budgets). Extract only primitive `error.code`
and `error.message` from an object envelope. Unsupported shapes/content types,
oversize/truncated/invalid JSON or missing fields preserve status and explicitly
lack body detail. Do not persist a body excerpt, arbitrary HTML or payload. A
body timeout/overflow after headers must not erase an already known HTTP status
or change its recovery classification: HTTP401/403 remains a hard authorization
failure even if body collection later times out. Preserve the known HTTP reason
when secondary body errors occur. Do not
follow redirects or allow error-body collection to extend a deadline.

Own stable reasons remain separate from originals. Recovery classifications use
trusted transport facts only: internal timeout; native transient transport codes
ETIMEDOUT, ECONNRESET, EAI_AGAIN, ECONNREFUSED, ENETUNREACH, EHOSTUNREACH; or HTTP
429/500/502/503/504. Map these known native codes to a fixed
RESEARCH_SOURCE_TRANSPORT_TRANSIENT reason. Other native codes, unknown errors,
malformed payload/schema, result-set changes, identity errors, content-type
failures, URL/private-address failures, auth/permission errors (including HTTP
401/403), missing key and configuration/qualification errors remain HARD/HOLD.
A provider message saying 'retry' never changes this classification. HTTP bodies
cannot reinterpret status or supply authoritative recovery state. DNS resolution
must preserve a sanitized originating error when one exists without weakening
public-address validation; no address response remains an unavailable result.

## C. New-slot Marketaux recovery

This explicitly narrows the parent contract's permanent unknown-provider HOLD:
a finished/expired **read-only Marketaux** acquisition may be superseded by a
fresh, independently identified acquisition in a later natural news slot. Its old
UNKNOWN record/reservation/cost remains immutable and unknown. No prior call is
replayed, outcome repaired, reservation deleted/refunded, attempt number increased
within its slot, or old snapshot made complete. This exception does not apply to
broker/WSH/model/delivery/financial-write uncertainty.

Only an existing demand or an owner-authorized startup preparation drives this
work. Zero signal/demand and no pending repair still means zero Marketaux calls.
Do not turn on periodic Marketaux to mask demand recovery. The scheduler may finish
a queued repair after its originating signal disappears; READY clears the repair
and does not automatically rearm when data later age. Future natural signals use
new current strategy/session/risk data, never a saved proposal replay.

For qualified/allowed Marketaux news with a trusted transient negative result,
inspection returns WAITING with fixed RESEARCH_SOURCE_TRANSIENT_FAILURE and the
original negative status/own reason/original diagnostic retained for display.
No snapshot or diagnostic becomes READY until ordinary successful two-pass,
full-pagination, identity, time and coverage validation succeeds. Other source or
account/config blockers remain HOLD; skip eligibility reasons only where they
are exactly the news-coverage consequence of this specifically identified pending
repair. Do not suppress conflicting reports, future timestamps, wrong identities
or generic eligibility failures merely because one source can recover.

prepareRepair is the authoritative scheduling boundary and must recheck manifest,
account/config authority, source rights/qualification, negative snapshot identity,
provider-wide budget and current database time under existing transactional rules.
Use the existing natural 15-minute news slot. The earliest fresh slot is strictly
after the failed acquisition slot and after its request/acquisition deadline.
Persist WAITING/next_check_at/reasons in existing research_repair_requests and
append changes to repair events. Within the failed/current reserved slot, wait
until the next slot; never replay even when its outcome is UNKNOWN or absent.
Any current PENDING reservation remains an existing-acquisition wait until its
bounded deadline, then a next-slot wait. If a failure occurs late in a slot, use
the later of the next slot and deadline. Recompute the actual legal slot before
reserving, so restarts/late wakes cannot reuse the failed identity.

runRepairs recognizes the new fixed transient/legacy recovery reason in addition
to missing/stale sources. It continues through existing instrument advisory lock,
refreshSlot, hasRefreshSlot and immutable marketauxCallIdentity. Duplicated workers,
manual/periodic/demand collisions and restarts cannot reserve the same page call
twice. Every new page/pass consumes the existing provider/account shared daily
quota and conservative cost reservation. Exhaustion stays HOLD with original
failure visible; do not buy quota, reset counters or borrow another account.
No immediate in-slot retry or extra exponential timer is introduced; the existing
15-minute cadence bounds failed fresh acquisitions and durable demand scheduling.
Per-instrument failures remain isolated; global authority/DB failures deny work.
Exact source FAILED reservations whose negative publication was lost remain holds
across later slots and delayed restarts. A trusted transient publication for that
slot or validated complete source acquisition with asOf after the failure may
supersede this hold; a later composite publication of old coverage cannot. Check
previous-slot outstanding deadlines before permitting a new-slot acquisition.

## D. Legacy generic failure and restart recovery

Old generic ACQUISITION_FAILED coverage lacks original cause; keep the historical
snapshot unchanged and print 'original unavailable'. Do not infer AbortError or
TIMEOUT from its duration. To resolve this incident without globally reclassifying
all generic errors, prepareRepair may establish a **legacy fresh-verification**
request from current durable evidence:

1. Exact current account/config/manifest/instrument/source/news identity; ERROR,
   incomplete generic RESEARCH_MARKETAUX_ACQUISITION_FAILED coverage with no
   sourceError property (legacy only), valid time
   bounds and a matching completed refresh slot for that source/negative snapshot.
   If later composite snapshots copied this negative coverage during another source
   refresh, resolve the original snapshot from that exact deterministic slot and
   require identical canonical source-role coverage and matching config/manifest/
   instrument/mapping identity. Use the originating publication timestamp in step2,
   never approximate time/provider matching or the later composite timestamp.
2. Enumerate the exact deterministic Marketaux page/pass reservation keys for
   that failed slot and match provider/account/config/manifest/request identity.
   At least one reservation has terminal UNKNOWN recorded_at at or after its
   request deadline and no later than the exact negative snapshot publication.
   Require the reconstructed request hash as well as call key to match. An earlier
   UNKNOWN (for example immediate TLS/certificate failure), missing outcome, or
   new generic failure carrying sourceError does not qualify. No unexpired/PENDING
   operation is treated as finished. All matched calls are
   accounted for and remain immutable. A generic parsing failure after entirely
   SUCCEEDED calls does not qualify through this legacy path.
3. Rights, qualification, mapping, configured budget and all independent hard
   eligibility checks currently pass. No known hard negative is overridden.
4. Schedule only a later independent natural slot, reason
   RESEARCH_MARKETAUX_LEGACY_FRESH_VERIFICATION. This reason describes a new
   verification opportunity, never a reconstructed original or timeout diagnosis.

Pure inspectResearch can accept a narrowly typed, snapshot/source/slot-bound
legacy recovery assessment supplied by ResearchStore; arbitrary callers cannot
turn a generic negative into a recoverable one by providing an error string.
The store reconstructs this assessment from retained ledger and slot evidence
on every prepare; it never mutates the old snapshot or inserts fabricated causes.
Read-only diagnostics without that assessment may conservatively show HOLD until
preparation has persisted the exact pending recovery.

Existing demanded HOLD rows must not strand recovery after rollout/restart.
Extend due-repair candidate discovery only for retained Marketaux-news demand
whose latest matching negative snapshot meets the structured transient or legacy
candidate shape. Reinspect it under prepareRepair before changing state or doing
IO. Do not select arbitrary HOLDs, reset READY rows, create demand for all sources,
or use a one-off SQL update as the runtime fix. SQL/store fixtures must prove the
old current incident's HOLD can become durable WAITING and reach a fresh successful
slot after process restart, with the original unknown call still untouched.
If matching legacy ledger/slot evidence is missing or contradictory, keep HOLD
and state the unavailable evidence; no fallback guess or broad replay.

## E. Operator visibility

Propagate sourceError and the stable own failure code through ResearchPreparation
source rows, authenticated startup preparation and read-only research status.
Show source/instrument, own reason, original name/code/message, actual HTTP
status/status message and safe provider envelope fields when present. Retain
WSH's existing providerError display and unavailable-original wording for legacy.
Both WAITING transient and HOLD paths display originals; transient failures must
not disappear merely because automatic recovery was scheduled. Show next legal
check time and explain in Polish that research remains unavailable and a fresh
acquisition is scheduled, without claiming the old UNKNOWN was resolved.
Log on meaningful diagnostic/state/next-slot change, avoiding unchanged five-second
startup repetitions. Never emit secrets to ordinary application or CLI logs.

## File ownership and routing

After independent Astra/high plan acceptance, split only disjoint coherent scopes:

- Astra/high shared worker owns shared `instrument-research/types.ts`, `validation.ts`,
  `provider-error.ts` or a narrowly named source-error helper/export, `repair.ts`,
  `store.ts`, associated shared tests and isolated PostgreSQL repair/store tests.
  Shared diagnostic/recovery contract must land before dependent wiring.
- Astra/high lead owns `apps/llm-agent/src/research-fetch.ts`,
  `research-marketaux-fetch.ts` and their direct fetch/transport tests. The shared
  worker also owns `research-refresh.ts`, its generic/Marketaux refresh tests and
  isolated research-repair tests, wiring the accepted shared recovery contract. Inspect WSH paths but do not change their
  lifecycle/ledger contract. A bounded pure sanitization helper could be routed
  to Luna/medium only after exact shared semantics and failure fixtures are fixed.
- Lead or Sol/medium under the accepted contract owns
  `apps/execution-engine/src/diagnostics/read-model-status.ts`/tests and
  `tools/paper-verify-stack/src/paper-runtime.ts`/tests. They consume shared safe
  display data only and do not decide eligibility.
- Lead owns AGENTS.md rule, this plan, Marketaux recovery report (filename
  `MARKETAUX_RECOVERY_DIAGNOSTICS_REPORT.md`), integration and publication.

No migration is anticipated: snapshots already contain strict JSON and repair
requests/events/slots exist. If durable identity correlation cannot be established
without schema changes, stop, amend the plan and obtain independent review before
implementation. The independent final reviewer must differ from the plan reviewer
and must not have authored implementation. Record requested/actual model/effort,
repairs/escalations, elapsed time and available usage; otherwise 'unavailable'.

## Acceptance and validation

- Native HTTPS deadline AbortError race, DNS timeout, response error, close/end,
  synchronous request throw, HTTP 429/500/401, invalid/oversize JSON error envelope,
  redirect and late callbacks preserve actual safe originals and stable own code;
  success cannot follow timeout and request count remains bounded. Use native
  loopback/fake transport where needed, never real Marketaux during tests. Include
  an actual Node local-server HTTPS/request-adapter deadline test reproducing native
  AbortError ordering, not only synthetic EventEmitter errors; HTTP401 delayed/
  oversized bodies must retain the hard HTTP401 result.
- Wrapper -> generic/Marketaux refresh -> immutable negative snapshot -> prepare
  WAITING/HOLD -> authenticated status/startup preserves original fields. Unknown
  legacy originals stay unavailable; WSH old hashes/shape and legacy snapshot
  hashes remain unchanged. Privacy, invalid-shape and terminal-control tests pass.
- Transient negative -> same-slot WAITING with zero second requests -> next natural
  slot acquisition -> ordinary complete two-pass READY. No partial/one-pass result
  is eligible. A fresh failure repeats only in subsequent slots within quota.
- Actual-format legacy generic UNKNOWN fixture + exact matching ledger/slot ->
  fresh-verification WAITING -> restart -> new-slot success. Missing correlation,
  mismatched identity, pre-deadline UNKNOWN, absent outcomes, new generic errors
  with sourceError hard native codes, entirely SUCCEEDED generic parse failure, hard auth/schema/
  entitlement failures and future timestamps remain HOLD. Old UNKNOWN and costs
  remain immutable; original call keys cannot be reserved again.
- Concurrent repair/periodic/worker execution, lost publication outcome, incomplete
  reservation, shutdown/restart, slot boundary, budget exhaustion and source/config
  changes never duplicate acquisition or grant readiness. No-demand/READY rows do
  not trigger Marketaux IO. An unrelated hard source block remains visible.
- Run targeted suites followed by pnpm lint, pnpm typecheck, pnpm test,
  pnpm test:integration against isolated PostgreSQL, and pnpm build. No destructive
  operational fixtures, external calls or strategy/simulator changes. Clean scoped
  Docker build required for runtime rollout. Independently review implementation,
  report evidence, scoped commit/push on main and verify exact-commit GitHub CI.
- Real operational recovery remains separate: after source acceptance and existing
  deployment authorization, inspect current authority/controls and perform only a
  supported fresh preparation/new-slot acquisition within provider budgets. Do not
  force/bypass entry activation, replay unknown broker submissions or invent
  successful news. Supported standard start may resume the owner-authorized
  continuous PKO/AAPL Paper scope only after every existing operational gate passes.

## Deliberate limitations

No lost original can be reconstructed. HTTP response bodies outside the supported
small JSON error envelope remain unavailable. Automatic future verification is
restricted to demanded Marketaux news; generic HTTP and WSH receive original-error
preservation but no new recovery policy. Hard failures require a corrected real
configuration/permission/source, not elapsed time. Exact legacy evidence missing
from the current database remains a reported blocker for that specific recovery.
