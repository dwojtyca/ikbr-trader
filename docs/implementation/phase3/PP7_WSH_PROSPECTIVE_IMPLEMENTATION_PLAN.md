# PP7 — WSH context for adjudicating existing technical proposals

Date: 2026-10-07. Baseline: `59e7f96d4194cff3f1dcefc3c3b291a7a5a54cad`.
Status: **owner-directed context-only amendment; independent Astra review accepted 2026-10-07 14:36:25 UTC**.
The accepted contract SHA-256 is recorded in the [implementation report](PP7_WSH_CONTEXT_IMPLEMENTATION_REPORT.md); this status update follows acceptance.
Parent: [WSH to first Paper](PP7_WSH_TO_FIRST_PAPER_PLAN.md), G1/G2.
The owner explicitly supersedes the parent's deterministic event-proximity veto
and earlier proposed 24-hour/seven-day policies. This document is the replacement
implementation contract after independent review; no runtime work precedes acceptance.
The instruction to finish and launch remains active within operational gates.

## 1. Intended behavior and exact scope

An existing technical strategy generates its normal persisted proposal. AI receives
the exact proposal, required issuer reports/facts, available forecasts/results,
Marketaux news and WSH calendar/upcoming events. It decides EXECUTE or REJECT based
on whether that context supports this proposal. Deterministic execution risk and
existing broker-write/ownership controls remain authoritative.
Do not change technical signals, strategy thresholds, risk sizing or backtests.
An approaching, occurring or recently completed event is information for AI:
neither deterministic eligibility nor the prompt imposes an event-proximity veto.
This applies to V1 and V2 research and identically in Paper and Live.

WSH is the sole calendar provider. No issuer-confirmation adapter, calendar crawler,
manual date attestation or extra calendar subscription is part of this package.
Preserve the 25 unrelated dirty ES/signal files; record/verify their hashes and stage
only reviewed work on main. Live remains disabled. Only the separately authorized
supervised one-share PKO attempt may follow the operational gates. AAPL can remain
entry-disabled without preventing a qualified PKO instrument from operating.

`coverageBasis=PROVIDER_REPORTED_QUERY` describes successfully acquired configured
WSH query data, not a guarantee of every real-world event or future disclosure.
AVAILABLE means provider rows were returned; EMPTY means a successful query returned
zero rows. Neither means universal event absence. Freshness, identity, parse integrity,
entitlement and budgets remain deterministic gates. Valid uncertainty, a new event
type, missing optional forecasts or ordinary revisions are context rather than holds.
The old G1 exhaustive guarantees and earlier receipts are not retroactively qualified.

## 2. Source evidence and current implementation

- [IBKR request contract](https://www.interactivebrokers.com/docs/tws-api/doc/wall-street-horizon/event-data/wsh-event-data-object)
  documents conId/dates or filter mode, fill flags and totalLimit at most 100.
- [Event introduction](https://www.interactivebrokers.com/docs/tws-api/doc/wall-street-horizon/event-data/introduction)
  requires metadata first and serial requests; the [callback](https://www.interactivebrokers.com/docs/tws-api/doc/wall-street-horizon/event-data/receive-event-data)
  returns requestId and JSON. Treat that correlated JSON as the response boundary,
  without inventing an additional end marker or global completeness warranty.
- [WSH dictionary](https://www.interactivebrokers.com/campus/wp-content/uploads/sites/2/2023/09/WSHEclassesandfieldsforIBAPI2022-12-23.pdf)
  describes selection by starred date fields, earnings certainty/fiscal fields and
  EPS report/estimate fields. Selection is not necessarily occurrence overlap;
  estimated_eps is available only when the announcement is yesterday or today.
  An upcoming earnings row is not a promise of an available consensus forecast.
- [WSH's API offering](https://www.wallstreethorizon.com/interactive-brokers) expressly
  advertises retail/institutional model use. Implement the advertised API without
  hypothetical vendor-warranty or separate-permission campaigns. Check actual account
  entitlement and applicable terms before operation; do not invent private rights.
- Installed `@stoqey/ib` 1.6.10 supports date/limit fields at protocol >=173. Its
  decoder returns requestId+JSON. disconnect ends/destroys the local socket and
  pauses the controller; a fresh transport instance avoids old queued work.

Current eligibility.ts has RESEARCH_EVENT_BLACKOUT and occurrence-window/expiry
logic derived from ±24h. Remove that admission policy for both schema versions.
Keep validating evidence ownership, schema and provenance. Report publication
deadlines, source freshness and actual acquisition coverage remain distinct checks.
Current research-marketaux.ts retains titles but drops returned description/snippet
and entity sentiment. Enrich V2 narrowly with those available provider fields;
no article scraping or additional news/forecast provider is added.
[Marketaux documentation](https://www.marketaux.com/documentation) describes
description/snippet and matched-entity sentiment_score (nullable, −1 through +1);
this is provider sentiment, not a forecast, AI verdict or admission cutoff.

## 3. Versioned snapshot and information contract

Add discriminated ResearchManifestV2 and InstrumentResearchSnapshotV2; shared public
aliases accept V1|V2. Keep historical V1 JSON/hash decoding byte-for-byte unchanged.
V1 eligibility intentionally loses event-proximity rejection; historical decisions
are not rewritten. No change to strict report/news publication or required metrics.
WSH is V2 calendar-only and cannot be written under a V1 manifest/authority.

V2 evidence is a strict union of existing published HTTP evidence and
`kind=wsh-calendar,published:null,knowledgeBasis=FIRST_OBSERVED` evidence. The latter
has durable firstObservedAt, receipt time and versionHash. Null publication never
becomes valid for reports/news. WSH result/forecast context cannot substitute for
required financial-report facts or inherit their publication/period qualification.
Socket provenance is tagged `{transport:IBKR_SOCKET,endpointId,sessionId,requestId,
requestHash,receiptHash,metadataHash,serverVersion,sdkVersion}`. Do not invent HTTPS
fetch provenance or weaken existing HTTP/redirect/SSRF validation.

Calendar acquisition records include exact requested dates/limit, row count,
metadata/receipt hashes, checkedAt, entitlement/qualification reference and expiry.
`complete=true` means no observed error, saturation, identity mismatch or invalid
required structure under this provider-query contract; the limitation is explicit.
No occurrence blackout, risk window, time-based event veto or history-window field
is added to V2. Existing V1 occurrence-window fields remain readable historical
data, but do not cause entry rejection or cap eligibility by a ±24h event horizon.

Each context row preserves provider event key/type, source status, conIds/issuer
ISIN, normalized recognized fields and bounded sourceFields. Dates/forecasts are
labelled with source precision and uncertainty, not upgraded to facts. Recognized
ed/fq fields include earnings_date, fiscal_year, quarter, earnings-date status,
time_of_day and supplied confidence/audit fields. sh includes supplied meeting
dates/status/type and location/time-zone data. Add wshe_eps normalization for actual
result and estimated EPS fields, currency, fiscal period and preliminary values
when present; retain their source units/strings rather than guessing conversions.
Do not require wshe_eps rows, consensus estimates or any other optional field to
exist. Represent missing as NOT_PROVIDED, never zero or global ineligibility.

All other event types use `interpretation=GENERIC_PROVIDER_EVENT`, preserving the
bounded event_type, supplied metadata label/field descriptions, source status,
index_date/type and data fields without assigning invented materiality or meaning.
An event type absent from metadata is marked METADATA_DESCRIPTION_UNAVAILABLE and
retained as generic context; its novelty alone does not invalidate a valid feed.
Unrecognized status is preserved with UNKNOWN_INTERPRETATION, not called confirmed
or cancelled. Unknown date semantics remain a labelled raw source value; absent
optional dates mean DATE_NOT_PROVIDED. Known typed date fields that are present but
invalid, impossible numeric values, wrong identity and malformed structure fail.

Use JSON.parse and a bounded recursive data-value validator: maximum depth 6,
128 keys per object, 100 elements per nested array and 4000 characters per string;
JSON scalar/null values only. A limit breach fails acquisition/context assembly
explicitly instead of silently dropping rows/fields. Received event JSON is at most
1 MiB; metadata at most 512 KiB. No custom duplicate-key parser or raw-text archive
is required. All external fields/metadata remain untrusted data in the AI request.
The full assembled request must fit the existing configured model context limit;
if not, fail visibly rather than truncate the issuer's available context silently.

Every row must contain the expected positive conId in valid conids and the exact
configured issuer ISIN in data.company. Additional listing conIds are allowed.
Missing/foreign identity or malformed row structure denies that acquisition.
No ticker branches: configuration plus qualified contract identity selects issuer.
Do not merge ed/fq by date similarity. Preserve distinct rows; same fiscal period
with different dates/statuses is labelled SOURCE_DISAGREEMENT for AI, not hidden
and not an automatic trade rejection. Duplicate event keys with different valid
payloads are retained as conflicting variants, while exact duplicates may dedupe
deterministically with counts recorded. No arbitrary last-row-wins semantics.

V2 news retains title, optional description and snippet (each at most 8000 chars)
and optional provider sentiment for the exact already-matched issuer entity only.
Preserve absence as NOT_PROVIDED and sentiment as explicitly labelled provider
assessment with its existing evidence reference; do not average other entities,
guess polarity/ranges or treat missing sentiment as neutral/zero. Validate supplied
sentiment as null or a finite value from −1 to +1 and strings by bounds. No numeric
sentiment cutoff controls admission. V2 normalization, record-set hash,
refresh snapshot and AI context include these fields. Preserve the V1 title-only
projection/hash algorithm, and label that limitation honestly in V1 AI context.
Do not claim snippets are full articles. Invalid/oversized supplied enrichment
fails visibly; no extra provider call is made to fill absent optional enrichment.

## 4. Prospective knowledge and limited history

First-observation rows use immutable provider/issuer identity plus event identity
and semantic versionHash, independently of sourceId/config/manifest/endpoint alias.
Version hashes include supplied context values affecting AI interpretation;
receipt hashes bind exact bytes. First observation uses DB clock_timestamp and an
acquisition reference. Material revisions get new versions; unchanged versions
reuse their original first observation. Never backfill historical publication.
Persist observations and snapshot atomically; data is eligible only after commit.

Retain prior immutable snapshots and version references for audit. The next fresh
snapshot can annotate REVISED or NOT_IN_CURRENT_RESPONSE against the previous
successful snapshot. Absence is not cancellation. Those annotations inform AI;
they create no persistent event hold, expiry window or forced human reconciliation.
A source rename reuses stable history and must not relabel old observations as
first seen, but lack of old event recurrence is not itself an admission failure.
No active-event ledger, perpetual disappearance hold, event-control row or cancellation
state machine is required. Stable issuer identity serves audit/version continuity.

## 5. Bounded acquisition and consistent publication

Strict WSH configuration includes endpointId, qualified conId/ISIN, issuer IANA zone,
metadata/request contract, entitlement/qualification validity, budgets and freshness.
Use conId mode, empty filter, all fills false, totalLimit=100; metadata precedes
events for each acquisition. No event-type filter or extra feed. Query asOf−7 days
through asOf+45 days with two additional local dates at each outer edge; persist
these application-selected bounds and disclose the source's date-selection limits.
DATE remains date precision; unqualified zone/offset stays unknown for AI rather
than becoming an invented exact timestamp. No event date influences entry expiry.
At >=100 rows the query is saturated: fail visibly; no claim that it is complete.
Splitting/pagination is outside this package. Initial PKO scope uses the actual feed.

Reuse research_call_reservations/outcomes, refresh locks/slots and ResearchStore.
Add `000028_wsh_prospective_research.sql` for first observations and narrowly scoped
acquisition/endpoint fencing state; no generalized lease/job framework. The physical endpoint
is serialized globally across cooperating processes/instruments, not just sourceId.
Reserve each metadata/event call before send, retain spent/unknown reservations,
use the existing <=10-second call deadline, and correlate session/request/generation.
All calls are read-only; the WSH transport port exposes no order API.

Use the existing snapshot-head lock for publication and final dispatch, held through
last binding/freshness validation and the existing synchronous send. A fresh published
snapshot remains usable during an in-progress refresh; starting a read does not
invalidate it. This explicitly replaces the earlier refresh-entry-barrier design.
Publication-first invalidates the old binding and produces zero sends; dispatch-first
prevents head publication before its synchronous send. P1 freezes the existing
proposal/authority/head lock order and endpoint fencing order; no event-control lock
or transaction held across WSH network I/O is added.

Success atomically writes first observations, snapshot/head/slot and acquisition
outcomes. A known failure publishes negative latest coverage. Until publication,
the previous head may remain usable only within its original freshness/authority
limits; failed refresh never extends its age. Unknown COMMIT is read back by exact
acquisition/snapshot identity, never blindly published again or represented as success.
If DB state/freshness cannot be validated, execution denies. A committed negative
head immediately makes its prior approval unusable; immutable audit is preserved.

WSH timeout/disconnect/fence loss records UNKNOWN, retains budget, retires that
generation under endpoint fencing and disconnects its dedicated transport instance.
No assertion of upstream cancellation is made. Old callbacks cannot publish.
The next scheduled slot, no sooner than 15 minutes, can reserve a new read with
fresh transport/session/generation, metadata and events under the endpoint lock.
Duplicate WSH or other errors produce negative coverage and later-slot backoff,
not fabricated success or immediate retry loops. A later valid acquisition can
restore eligibility while immutable old UNKNOWN read outcomes remain in audit.
Uncertain retirement commit must be resolved before new send. This recovery never
applies to unknown broker writes or AI/model-call replay.

Refresh cadence and maximum acquisition age are 15 minutes; equality is stale.
Eligibility expiry is the minimum of source freshness, actual qualification/
entitlement limits, existing report/news deadlines and peer authority, never an
event date. AAPL refresh failures affect its data, not unrelated PKO admission;
shared endpoint errors remain explicit until a valid new acquisition succeeds.

## 6. AI decision and execution integration

New decisions use prompt `pp7-research-context-v2` and request
`pp7-ai-context-request-v2` for both supported manifest versions. Old V1 audit
request decoding remains available, but an old-prompt pending decision cannot be
executed after adoption of the new active policy. Existing decision output shape
EXECUTE/REJECT/confidence/reason/riskFlags/evidenceRefs remains unchanged.
The request binds the exact technical proposal, order/risk context, manifest,
snapshot id/hash/sequence, available reports, forecasts/results, news and events.
The prompt asks whether available context supports the proposal; uncertainty and
proximity can inform reasoning but impose no categorical rejection. AI cannot
change order fields, invent missing forecasts, promote source certainty or override
deterministic integrity/risk guards. External data is untrusted, never instructions.

Add shared code-owned prompt/wire projections in instrument-research/ai-contract.ts
for versioned decision construction and independent execution validation. Execution
must verify the supported system prompt and exact provider wire request, not just
self-consistent hashes. Preserve historical V1 JSON/request projection for audit.
Preserve canonical request/provider-request hashes, model/version checks, required
citations and latest-head validation at bind, before model send/delivery and final
execution. New negative/positive publication, source expiry or policy/manifest change
invalidates an older approval. Starting a refresh alone does not. Timing policy
removal never allows stale decisions or unbound data.
Update runtime wiring, version-aware guards and Polish diagnostics together.
Default WSH activation remains off; examples remain disabled/unqualified.

## 7. Task packets, ownership and independence

| Packet | Route / bounded files | Acceptance dependency |
| --- | --- | --- |
| P0 plan | Astra/high, this document | Different independent Astra accepts owner-directed amendment before implementation |
| P1 contracts/store | Astra/high; shared instrument-research types/validation/eligibility/store/loader/exports and related tests; migration | Remove V1/V2 proximity admission, freeze V2 schemas, normalized context and transaction interfaces/lock order |
| P2 normalization | Luna/medium; new llm-agent research-wsh-normalization helper/tests | P1 exact contract; ed/fq/sh/eps plus bounded generic rows; no I/O or eligibility defaults |
| P3 acquisition/enrichment | Astra/high; research-wsh-transport/tests, research-refresh/tests, research-marketaux.ts/tests and shared marketaux record-set hashing/tests, index/config/package/lockfile | P1/P2; fences, budgets, publication, read-only recovery, V2-only news enrichment and startup |
| P4 AI/dispatch | Lead Astra/high; new shared ai-contract.ts/tests, research-decision/review-repository and execution research-entry-guard plus tests | P1/P3; exact context/version binding and final dispatch race |
| P5 diagnostics/docs | Luna/medium; designated existing formatter/tests and disabled example; lead owns runbook/report | Render accepted states only; exact file ownership assigned before writing |
| P6 review | Different independent Astra/high, neither plan reviewer nor runtime author | Full diff/source/tests, completeness and hostile failures |
| P7 checks/publication | GPT-5.6 Luna/low or disclosed GPT-6 Luna/low fallback | Commands only; lead-approved staging; exits/SHA/exact CI; no source fixes or broker retries |

P1 exports the lead-owned ai-contract.ts only after it is ready; shared contracts
integrate before disjoint parallel workers. Critical ambiguity
returns to Astra; one failed ordinary Luna repair escalates to Sol. Record actual
model/effort, review findings, repairs, elapsed and available tokens, otherwise
unavailable. Parent documents are updated only after amendment acceptance.

## 8. Acceptance, migration and delivery

Positive tests: V1 hashes unchanged; V1/V2 otherwise eligible before, during and
after earnings/material events; CONFIRMED/UNCONFIRMED/INFERRED retained; absent
forecasts are NOT_PROVIDED; eps actual/estimate values preserved when supplied;
new generic type passes with strict identity; third issuer works from configuration;
EMPTY is provider-scoped; revisions/disagreements remain visible without time veto.
V2 news description/snippet/exact-issuer sentiment reach AI and affect its bound
hash; missing values stay explicit; V1 hashes/title-only behavior stay unchanged.
Prompt tests require all context categories, original proposal and uncertainties,
and prohibit categorical event-proximity rejection. Mocked EXECUTE and REJECT
are both accepted under existing output/citation checks; no test demands real-AI
approval near an event or calls a paid model. Existing deterministic risk and
required report/news facts/publication still apply.

Negative tests: foreign/missing issuer/conId, malformed structures/known dates,
oversized/deep data, 99/100/101 rows, expired entitlement/source, exhausted budget,
payload/context overflow, wrong-entity sentiment and request/provenance mismatch.
Test generic unknown date/status differs from malformed known typed fields; no
synthetic publication. DB tests cover restart before/after send/callback, unknown
COMMIT, negative persistence failure, late callbacks, concurrent instruments/processes,
lock loss, spent budgets, read timeout→retirement→fresh scheduled read and Duplicate
WSH backoff. Force publication-first zero-send and dispatch-first serialization.
Test fresh last-good data during refresh and unchanged expiry after refresh failure.
Prove old AI cannot dispatch after publication/expiry/head/version changes; V1 reports/news
null publication still fails. Source rename retains history without event holds.

Migration is additive; test existing V1 audit readability and immutable hashes,
mixed-version rejection and first-observation durability in isolated PostgreSQL.
Adopt with writes disabled, entries paused, compatible peers and no active/unknown
AI work or unretired current WSH acquisition. Retired read outcomes remain audit.
Rollback pauses refresh/entries and preserves V2 history; old binaries cannot
overwrite new authority/head or silently execute older-policy approvals.

Run pnpm lint, pnpm typecheck, pnpm test, isolated-PG pnpm test:integration,
pnpm build and a clean Docker build from reviewed source. No strategy/simulator
change means no new backtest. Validate links, secrets, dirty-file hashes and diff.
Write report, scoped commit/push on main and verify exact-commit CI before release.
Deploy disabled from verified image/source with backup/migrations/private manifest;
UI remains stopped. Actual entitlement/terms, budgets and fresh WSH receipts must
be established, without inventing permissions or hypothetical warranty requirements.
Fresh broker/accounting/risk/model/alert evidence and bounded operator/session scope
remain Gate A/B conditions. Technical signal→proposal→AI→risk→execution remains
the only entry path. This package does not fabricate a signal, force an AI decision,
guarantee a fill or authorize Live trading.
