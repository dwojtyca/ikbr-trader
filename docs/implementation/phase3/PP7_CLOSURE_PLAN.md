# PP7 closure: real Paper sources and operational readiness

2026-10-06, updated 2026-10-07. E1a implementation and required local checks are
accepted and published as `b1a4a907d3d8617f922a31cfe45b691a040c7e72`.
The first exact-commit CI failed at `pnpm test`; the reproduced Linux cleanup
defect was repaired in `bc5d6d62b825ee69d8862142401f91badb5b07ff`, whose exact-commit
CI passed. See the
[E1a report](PP7_E1A_IMPLEMENTATION_REPORT.md).
The [F1 source contract](PP7_ACCOUNTING_SOURCE_CONTRACT.md)
was independently accepted after two plan findings were repaired; its implementation
passed hostile re-review after four findings were fixed in one round. The
[F1 report](PP7_F1_IMPLEMENTATION_REPORT.md) tracks release validation. The accepted
[news contract](PP7_NEWS_FEED_CONTRACT.md) and its implementation passed independent
review after two implementation findings were repaired. Their combined clean
candidate passed lint, typecheck, 3019 unit tests (143 database-dependent skips),
2459 isolated integration tests without skips, build and a clean Docker rebuild.
The [closure report](PP7_CLOSURE_REPORT.md) records readiness separately from
source delivery. Calendar/model
work and H retain their unresolved acceptance requirements. Baseline
`197b13738620a648ce6a2c373d6bd4bff75ecfae`. This continues
[PP7](PP7_IMPLEMENTATION_PLAN.md); it does not restart PP0–PP6 or declare the
operational gates complete. The owner requested implementation sufficient to run
actual Paper trading, deferred additional strategy configuration, and accepted
expansion to two simultaneous positions after the first supervised PKO proof.

## Scope and evidence

Preserve the 25 pre-existing dirty ES/backtest/diagnostic files, including
`apps/signal-engine/src/signal-engine.ts`. Their hashes are recorded privately in
`backups/pp7-closure-2026-10-06/initial-dirty-files.json`. Work on main, stage only
reviewed paths, and publish no secrets, account IDs, balances or raw broker logs.

The existing configured scheduler/proposal/AI/risk/bracket/close path is connected.
The remaining entry blockers are production accounting coverage and mandatory
research coverage, followed by deployment and actual operational acceptance.
Existing loop/master settings are disabled; bundle and research paths are unset.
Configured broker TCP availability returned connection refused during this audit.
Credentials for existing OpenAI, Marketaux and Telegram clients are present; this
is not source entitlement, model access or delivery evidence. Do not create another
always-denying adapter and describe it as completion.

This work authorizes implementation, isolated validation and preparation of a
reviewable disabled release. Keep live disabled. Actual broker entries, provider
cost budgets, dated windows and operational controls must be grounded in the
owner's applicable concrete scope before use. Do not invent them. Read-only
qualification and public source research may establish prerequisites. Preserve the
normal proposal/risk/AI flow and every unknown-outcome hold.

## Delivery order

1. Qualify the accounting source and finish the missing research adapters.
2. Integrate both sources, demonstrate positive and hostile production-wired tests,
   and prepare a complete disabled release/configuration manifest.
3. Gate A: disabled deployment/preflight, with UI stopped and real source evidence.
4. Gate B: first one-share PKO normal-flow round trip, then AAPL under the existing
   one-attempt/account/day policy. A no-signal/AI rejection is valid but not a pass.
5. Add the bounded two-position capability below, after its supplemental contract
   and independent review; enable only after supervised proof.
6. Gates C/D: unchanged-manifest five-session evidence per instrument plus recovery.

Code may be implemented before its operational activation gate. No incomplete
external prerequisite may be represented by synthetic positive evidence. Finish
independent implementation while reporting exact external inputs still needed.

## F1: qualified full-account accounting source

### Verified source route

The current official [execution-details introduction](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/execution-details/introduction)
documents a TWS Trade Log setting allowing seven-day retrieval; IB Gateway is
limited to the current trading day. The generic request page alone does not name
the timezone of that current-day floor. Therefore use a qualified TWS seven-day
read-only replay source as the first supported positive route. Do not label a
Gateway current-day request as full Warsaw-day evidence. Retain the old adapter
for its existing reconciliation scope when the new source is not configured.

The [all-origin visibility contract](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/client-id-0-and-the-master-client-id)
requires the accounting connection's client ID and Master Client ID both to be 0.
A filter containing clientId 0 is insufficient. A dedicated accounting client must
never call order binding, submit, cancel, exercise, account-changing or UI methods.
Broker writes remain on the existing execution connection.

### Qualification contract and trust boundary

Before implementing positive production certification, establish a versioned
capability record binding the exact allowlisted Paper account and endpoint to:
TWS product/build, negotiated protocol version, seven-day Trade Log setting,
Master 0, client 0, explicit execution timestamp timezone, source documentation
and dated source-setting evidence. Historical replay is recorded as corroboration
when present; a fresh empty account needs no manufactured historical transaction.
The handshake identifies a negotiated protocol, not the product build. Source
settings absent from the installed API require explicit timestamped operator or
narrow host-setting evidence. A configuration boolean or arbitrary nonempty URL
does not qualify a source. The accepted [supplemental F1 contract](PP7_ACCOUNTING_SOURCE_CONTRACT.md)
defines the evidence representation, expiry, safe recording procedure, both-socket
semantic revision barrier and verification before code admits it. It is the
implementation authority for these details.

Requalify on host/build/settings/account changes and expire stale qualification.
Use broker configuration reads for Master drift when the negotiated protocol and
supported implementation expose them. Settings that cannot be checked dynamically
remain explicit operator-controlled trust assumptions, never broker-attested facts.
Do not add an unverified new SDK or silently switch the operator's broker host.

### Acquisition, persistence and admission invariants

- Install all execution, commission, connection and error listeners before the
  observer becomes usable. Capture full-account history without symbol, security
  type or side filters. Retain source connection generation separately from the
  execution service's connection generation.
- Add an append-only acquisition/observation ledger with source/capability identity,
  request and receive sequence, original broker timestamps and payload digests.
  Existing mutable fill tables remain compatibility projections, not the new
  source-completeness authority. Add migrations; never rewrite released SQL.
- A capture certificate references the durable observation revision and the
  qualified replay interval covering Warsaw midnight. It is constructed internally
  from source evidence, never imported from caller-supplied `certifiedFrom` JSON.
- Require successful matching end marker, unchanged account/session/connection,
  persisted full capture and matching finite fee/accounting evidence for every
  relevant execution. End markers alone do not certify fee completeness.
- Preserve the existing ten-second freshness and final transactional revision
  fences. New fills/fees/corrections, connection loss, pending persistence, parse
  failure or source drift invalidate entry evidence before later entry admission.
- Missing costs, unset realized P&L, pending price revision, contradictory execution
  identities and unsupported accounting stay denied. Do not turn an opening fill's
  absent realized P&L into zero. Qualify this behavior before multi-position
  activation; any deterministic accounting extension needs a reviewed contract.
- Store corrections unchanged. The first implementation may retain a durable HOLD
  for ambiguous correction/bust families rather than guess suffix ordering.
- A reconnect/restart needs full qualified replay to repair its durable gap.
  Callback silence, process uptime and market-data-restored codes are not repair.
  Evidence that no executions occurred can establish zero only after full qualified
  coverage of the account-day interval and fresh broker state is demonstrated.

F1 code acceptance requires a real implementable positive capture contract,
independent review, and tests for empty/full days, fees after end, missing costs,
corrections, UTC/Warsaw/DST, old-day records, foreign accounts, Master/client drift,
disconnect/persistence races, replay after restart, tampered certificates and stale
final dispatch. Real-source acceptance separately needs actual host qualification.

Permitted F1 source scope: execution-engine accounting/reconciliation adapters,
broker coverage DTOs, acquisition migrations, daily-loss reader and final entry
fences, associated tests and existing configuration/diagnostic wiring. No strategy,
order-dispatch or close algorithm changes. Shared DTO edits integrate first.

## E1: authoritative financial extraction and actual source coverage

Source research found new evidence beyond the former PKO capital blocker: the
Polish H1 page, consolidated financial report, directors' report and Pillar 3
disclosure agree on Tier 1 15.55%; the English summary and supplemental workbook
say 15.53%, inconsistent with the workbook's own capital/RWA components. A reviewed
source hierarchy may use the primary signed consolidated/prudential disclosure
and explicitly record the conflicting derivative source. Do not silently select
one number or replace the configured metric with CET1.

Before parser implementation, append and independently review exact source URLs,
publication/period/scope/unit/row/column mapping, conflict disposition, bounded
decoder/dependency choice and tests. Financial data must originate from the fetched
authoritative document; manually entered JSON facts or a fabricated complete feed
do not close E1. Retain document hashes, exact pointers and issuer identity.

Add only the actual missing adapters through the existing refresh/reservation and
immutable snapshot flow. Keep the working SEC adapter. Real news and calendar
coverage means successful exhaustive retrieval over the configured source's
documented scope and required time range, with verified issuer/listing matching,
pagination and separate publication/occurrence times. It does not mean knowing
unannounced future events. Never convert parse/transport failures, truncated feeds
or unknown provider coverage into EMPTY. Do not bypass a source's access control.

Prefer existing available providers and deliberately published issuer feeds. Source
automation/retention evidence must match actual private Paper research use and the
configured retention mode; no arbitrary PERMITTED declarations. Prove exact model
request compatibility and source/model budgets before operational calls. Retain
one charged model call per proposal, immutable citations/bindings and all research
freshness/blackout guards.

E1 acceptance: real PKO report extraction plus real SEC recheck, no source conflict
hidden, exact issuer/period/unit validation, hostile binary/text and duplicate
mapping rejection; real news/calendar feed contracts plus positive/negative
refresh tests; current model/source entitlement evidence separately from fixtures.
Any still-unselected feed remains an explicit prerequisite to Gate A, not a waived
mandatory group.

Permitted E1 source scope: llm-agent provider/refresh/fetch modules, isolated parser
modules and tests, disabled research example, shared research validation only when
an accepted representation requires it, package/lockfile for reviewed dependencies.
No strategy thresholds or AI eligibility relaxation.

### E1a concrete first implementation contract: mapped PDF financial reports

This subsection is the first code package submitted for acceptance. It closes
the actual PKO financial extraction gap; it does not claim that missing calendars,
accounting or model qualification are solved. F1's concrete
[source contract and implementation packet](PP7_ACCOUNTING_SOURCE_CONTRACT.md)
are accepted; H still needs its supplemental contract before implementation.

Use `issuer-pdf-table` under the existing `issuer-document` source adapter. Pin
`pdfjs-dist` 6.4.299 (npm metadata inspected 2026-10-06; requires Node >=22.13 or
>=24; actual local and Docker runtime is Node24). Declare its runtime requirement
in llm-agent rather than silently claiming Node20 compatibility. The official
[PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
supports local bytes and page text/coordinates. No rendering, OCR, remote service,
PDF JavaScript execution, XFA, remote font/image acquisition or URL fetch belongs
in this parser. Existing fetch authority remains the only network boundary.

The async binary extraction helper validates a 10MB input limit and configured
SHA256 pin before decoding. Use a bounded worker with a 12-second deadline,
256MB V8 heap limit, maximum 100 document pages, maximum 12 selected pages and
100,000 text items/1MB extracted text total. Stop at parser errors, reject encrypted
documents, unsupported rotation/geometry, missing text and nonfinite coordinates;
terminate/destroy resources on success/error/timeout. Do not return raw decoder
messages as operator-facing errors. These limits supplement digest pinning; do
not describe a V8 heap limit as an OS-wide external-memory guarantee.

Normalize extracted coordinates into PDF points with origin at the upper left.
The pure mapper accepts only a validated mapping, bounded extracted page items,
policy/source identity, actual content hash and fetch time. Each page declares
expected width/height and issuer/title/period/unit marker rectangles. Each table
declares title and exact column-heading rectangles, each fact an exact row-label
rectangle and selected column ID. Value selection is the intersection of that
row's vertical band and the column's horizontal band. Reject overlaps, text crossing
cell boundaries, multiple matches, missing labels/headings/values and malformed
numbers; never select by flattened token index or fuzzy text. Normalize whitespace
only. Numeric grammar explicitly supports grouped thousands, decimal point and
parenthesized negatives; a dash, blank, NaN or locale ambiguity is not zero.

Row/column bands, period and unit metadata are configuration; extracted financial
values are never configuration constants. Require matching source/policy issuer,
period/scope and metric contract, unique IDs and metrics, date ordering, publication
no later than fetch time and selected document identity. Existing research
validation/eligibility remains authoritative. Stable source pointers include page,
table, exact row/column and coordinates; evidence retains actual digest and URL.

The first reviewed mapping uses this official source:
`https://www.pkobp.pl/api/public/57cf6f76-c47b-4c5c-a17d-ed72de0980bd.pdf`.
SHA256: `814f2e8d1c5b2239db62b08a3636a7add61e09b511981f2fae797d4544b82908`.
It has 36 pages, 595.32 x 842.04 PDF points. Publication provenance is the issuer
landing page's 2026-08-13 00:03 Europe/Warsaw publication. The lead rendered and
visually inspected complete pages 5, 7 and 33, including headings and footnotes.

| Metric | Page/table/row and selected column | Value observed, not a parser constant | Unit and period |
| --- | --- | --- | --- |
| net_interest_income | 5 / Consolidated income statement / Net interest income / H1 2026 | 12027 | PLN million, 2026-01-01..2026-06-30 duration |
| net_profit | 5 / same table / Net profit attributable to equity holders of the parent company / H1 2026 | 5290 | PLN million, same duration |
| loans | 7 / Consolidated statement of financial position / Loans and advances / 30.06.2026 | 315047 | PLN million, instant 2026-06-30 |
| deposits | 7 / same table / Amounts due to customers / 30.06.2026 | 475762 | PLN million, same instant |
| tier1_ratio | 33 / Own funds and capital ratios / Tier 1 capital ratio / 30.06.2026 | 15.55 | percent, scale1, same instant, disclosed prudential group basis |

Monetary scale is 1,000,000 applied once by existing consumers; scope is consolidated.
Net profit uses the parent-attributable row even when total net profit happens to
equal it. Loans map to the financial-position report row; do not rename arbitrary
assets as customer loans. The ratio is the reported value, not a calculated value
from capital components. A replacement digest or layout requires new review.

Record a structured authority decision in this source's manifest-hashed parser
configuration: ID/version, selected document/hash/metric/pointer, conflicting
XLSX document/hash/pointer/value 0.1553 decimal, corroborating Pillar3 document/hash/
pointer/value 15.55 percent, source classes, observed dates and rationale. Selection
is by source precedence (canonical consolidated report, corroborated by prudential
disclosure, over derivative workbook/translated summary), not by choosing a larger
value or silently dropping a conflict. Historical corroboration is labelled as
review provenance and never represented as a new fetch. Missing or inconsistent
authority metadata rejects this mapped disputed fact. Test equivalent units.

Pipeline integration must branch explicitly for PDF bytes, await bounded extraction,
then use the pure mapper and existing namespace/snapshot atomic rollback. Request
PDF Accept only for this configured kind; require application/pdf content and PDF
magic. Unknown kinds retain their current failure. No source/provider call is
introduced into diagnostics. Keep the shipped example refresh, budget and entries
disabled; replace only the unsupported PKO mapping and its documented source data.

Acceptance tests: real binary decoding through the production helper; synthetic
PDF with observed shape and different financial values; correct H1/June columns
versus quarterly/prior-year/restated columns; wrong issuer/title/period/unit; row
wraps; duplicated/overlapping/ambiguous cells; changed digest; malformed/encrypted
PDF; bounds/deadline/worker cleanup; source identity/hash mismatch; authority
decision tampering/unit mismatch; successful scheduler publication of five facts;
failure preserving prior evidence plus ERROR/ineligible coverage. Re-run the actual
fetched canonical document locally, assert its five observed values and preserve
the receipt privately. Do not commit full issuer PDFs. Existing SEC, XHTML,
calendar, research binding and AI guard tests must remain green.

E1a task packet: critical lead owns dependency, binary isolation and refresh/fetch
wiring; Astra/high source worker may implement the pure mapping/normalizer and
associated tests under this contract (critical disputed financial semantics).
Permitted files are `apps/llm-agent/src/research-pdf*.ts`, provider/refresh/fetch
modules and tests, llm-agent package, lockfile, disabled research example and related
phase3/runbook documentation. Assign disjoint files before writes. Independent
Astra/high plan reviewer and a different final reviewer author none of these edits.
No schema migration, broker calls, provider spending or deployment in E1a.

Documentation acceptance also corrects the obsolete PP2-only claims in
`TRADING_CONFIGURATION.md` and `STRATEGY_INSTANCES.md`: diagnostic evaluation
remains read-only, but PP7's configured scheduler can enter the guarded proposal
flow when execution runtime and all admission controls allow it. Link the current
PP7 readiness evidence; do not describe implemented source as real Gate A/B proof.

Independent plan review accepted E1a with no blocking finding. Its clarifications
are binding: failed refresh preserves immutable historical snapshots and unrelated
sources, but publishes ERROR/ineligible current-source coverage; authority metadata
is historical review provenance and must match the actual selected fact/digest,
never imply a fresh corroborating acquisition. A different independent reviewer
must review the implementation.

E1a publication follow-up: the generated encrypted PDF's fixed-width xref table
was detected as text by Git and produced trailing-space warnings during staged
diff checking. Add a narrow root `.gitattributes` entry marking exactly
`apps/llm-agent/src/research-provider-fixtures/encrypted-test.pdf` as `binary`.
Do not change its bytes or parser behavior. Acceptance: unchanged PDF SHA-256,
Git reports the fixture as binary, scoped diff checking passes, document links
and source/CI evidence stay accurate. Independent plan and document/metadata
reviews apply; unchanged runtime suites need no local repeat for this Git metadata.

E1a decoder repair contract (2026-10-07): isolated Linux reproduction identified
an uncaught cleanup error: PDF.js 6.4.299's document proxy has no `destroy()`
method. Its loading task owns destruction. The worker currently publishes before
cleanup, allowing the error and result to race. In the fixed worker, accumulate
the result or stable failure, await the loading task's supported `destroy()` in
all acquired-task paths, then publish exactly one result. Cleanup failure becomes
`RESEARCH_PDF_DECODE_FAILED`; it cannot overwrite an already published success.
Keep the parent deadline, unconditional worker termination, bounded local bytes,
trusted module URL and all extraction checks. Do not suppress a failed cleanup or
expose decoder text. Add actual-worker tests with a controlled test-only module for
loading-task-only cleanup and a rejecting cleanup, alongside existing real-PDF
success/error tests. Scope: extractor, its test, this plan and E1a report. No
provider/refresh changes overlap E1b. Independent plan/final review and the full
required runtime validation, clean Docker build and exact-commit CI apply.

## H: two protected positions, bounded extension after first Paper proof

This is additional scope to the previous one-active-intent contract. A supplemental
contract and independent review are required before implementation. Prefer the
smallest useful concurrency: at most two distinct owned protected positions, while
retaining a single unresolved entry admission/dispatch at a time. A second entry
can proceed only after the first is authoritatively filled, protected, accounted
for and included in fresh account risk. This avoids simultaneous pending entries
spending the same cash. Both holdings can coexist; ambiguous state anywhere still
retains account holds. Existing closes and new admissions remain coordinated.

The contract must cover configurable caps 1/2 with default 1; immutable/versioned
policy migration; explicit per-instrument ownership and protection; terminal
accounting; aggregate exposure, available funds and pending notional treatment;
close serialization/deadlines; unknown outcomes; restart/rollback; and atomic SQL
enforcement under the existing account lock. One attempt per instrument/day and
two per account/day remain separate limits. Changing configuration cannot refund
budgets or abandon existing management. No extra strategy or quantity expansion.

Acceptance includes two actual production-wired concurrent holdings in fixtures,
no third slot, overlapping signals and closes, fresh account inclusion before the
second entry, unknown first entry denial, insufficient shared funds, restart with
both owned positions, independent TP/SL/deadline exits and preserved old policies.

## Validation, independent reviews and publication

Each concrete code contract must be accepted by an independent Astra/high plan
reviewer before implementation. F1/E1/H unresolved contract sections above are
explicit implementation barriers, not permission to improvise. A different
Astra/high reviewer must accept the integrated implementation and hostile cases.

Critical contracts/integration and accounting/research admission use Astra/high;
bounded pure extraction under the accepted contract may use Luna/medium; known
transport wiring may use Sol/medium. Mechanical checks/publication use the requested
GPT-5.6 Luna/low or an explicitly disclosed available fallback. Task packets must
name exact owned paths, dependencies, invariants, check commands, stop conditions
and requested/actual model evidence. No overlapping concurrent writers.

Run lint, typecheck, unit tests, isolated PostgreSQL integration and build. Use
only disposable test databases, never operational fixtures. Run a clean Docker
build for changed runtime dependencies/deployment. No strategy/simulator changes
are planned; if introduced, stop and review scope plus required backtests.

Update stale operator instructions that claim configured scheduling cannot submit.
Record positive source evidence, remaining operational inputs, source SHA/image,
checks and review/repair effort in the closure report. Commit/push only reviewed
scope on main and verify GitHub CI for that exact SHA. Recheck preserved dirty-file
hashes. Full PP7 completion still requires Gates A–D; code, deployed readiness and
observed Paper execution are separate statuses.

## Latest operational evidence, 2026-10-07

At 07:37:57 UTC a single read-only TCP check of the configured Paper endpoint
returned `ECONNREFUSED`. No broker API call or order was attempted and master
writes remained disabled. Actual TWS product/build/settings qualification,
current broker reconciliation and quotes remain unavailable.

At 07:29:28 UTC the existing OpenAI credential successfully read metadata for the
configured `gpt-5.4` model (`GET /v1/models/gpt-5.4`, HTTP 200). The
[official model documentation](https://developers.openai.com/api/docs/models/gpt-5.4)
lists Chat Completions and Structured Outputs support; the
[request reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
documents the existing JSON-schema format and completion-token cap. This supports
the client's protocol choice, but does not prove a successful production-shaped
generation, available credit or latency within the bot's deadline. No generation
or paid model call was performed, and the research example remains unqualified.

Actual Marketaux plan and PKO/AAPL entity qualification still need evidence. No
Marketaux provider call or subscription change was made. Calendar adapters and
their positive completeness/publication/occurrence contract remain unresolved;
news acquisition does not satisfy that mandatory group. These are explicit
remaining implementation/operational requirements, not optional warnings or a
claim that supplying credentials alone makes the bot ready.

Gate A remains unproven, no actual PKO/AAPL Gate B round trip has been recorded,
and Gate C session counts remain zero. Entry activation, trading budget/window
adoption and the later two-position H extension have not been performed.
