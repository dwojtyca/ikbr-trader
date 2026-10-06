# PP7-E/F research and broker coverage evidence

2026-10-05. Implements calendar coverage and the bounded broker request-window fix of the accepted
[delivery contract](PP7_DELIVERY_CONTRACT.md). Public source inspection and isolated
tests do not establish Gate A readiness. No broker connection, deployment, trading,
real alert, paid provider/model call, or secret inspection occurred in this package.

## Calendar coverage implementation

The previous eligibility function accepted fresh `EMPTY` calendar coverage whose
query interval was entirely in 2020. A local fixture reproduced `eligible:true`.
Acquisition timestamps alone could therefore assert upcoming-event readiness.

Calendar source results now carry paired optional `occurrenceWindowStart` and
`occurrenceWindowEnd` fields, distinct from source query/as-of timestamps. Entry
requires an explicit occurrence range covering the current time minus 24 hours
through more than 24 hours ahead, matching the existing event blackout. Eligibility
also expires at occurrence-window end minus 24 hours. A source can supply a larger
range to remain usable throughout its refresh period. Calendar events, including
date-only events with an explicit timezone, must fit inside that occurrence range.
Future occurrence is allowed; future publication or source observation is not.

The existing schema-version-1 JSON representation accepts either the old exact
coverage shape or the new exact calendar shape; incomplete pairs, other-role ranges,
extra fields and inverted/invalid times reject. Old immutable snapshots remain
readable, retain their exact bytes and hashes, and are ineligible for new entries
without occurrence coverage. No SQL migration or historical record rewrite is
needed. Existing decisions remain historical audit records, not new entry permits.

The declared-evidence adapter preserves the explicit range and labels missing range
UNVERIFIED. This adapter remains a fixture/input format, not a verified operational
provider. Refresh propagates the range without substituting acquisition time and
publishes incomplete ranges as UNVERIFIED. Call budgets, unknown outcomes, proposal
binding, request hashes and final execution checks retain their existing contracts.

Reporting deadlines are not extended by this change. The disabled example's
expired/unverified deadlines still block. The following source observations can
support a later verified manifest; they do not authorize inventing future dates,
claiming complete feeds, enabling budgets or replacing permission evidence.

## Public source receipts

Raw public files and inspection outputs are temporary, outside the repository.
Downloads were unauthenticated HTTP GETs. No provider keys or model calls were used.

| Source | HTTP / acquisition UTC | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| [PKO H1 2026 XLSX](https://www.pkobp.pl/api/public/a73faa8f-2958-457a-b149-80bc8b3d5c3e.xlsx) | 200 / 2026-10-05T14:10:12.677082Z | 1,538,195 | `511e0666eefbd7351fcc0552447b010bea7189519bf9d8400456e908514dd403` |
| [Apple SEC submissions](https://data.sec.gov/submissions/CIK0000320193.json) | 200 / 2026-10-05T14:10:12.983473Z | 163,997 | `3cf0928a15c79b842e4ecef56a0ce30c5edfeda0c98643a046233fafba40dae7` |
| [Apple SEC companyfacts](https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json) | 200 / 2026-10-05T14:10:13.503099Z | 3,789,099 | `73a86c6aedc31f77cac2ea4df5f80f0b3bd7e6eb58bb4e01444fbedf3afb9c43` |
| [PKO H1 consolidated PDF](https://www.pkobp.pl/api/public/57cf6f76-c47b-4c5c-a17d-ed72de0980bd.pdf) | 200 / 2026-10-05T14:17:55.389932Z | 1,283,647 | `814f2e8d1c5b2239db62b08a3636a7add61e09b511981f2fae797d4544b82908` |

The [official PKO H1 landing page](https://www.pkobp.pl/en/investor-relations/financial-reports/periodic-report-for-the-first-half-of-2026)
links both files and displays publication on 13 August 2026 at 00:03. Use this
source provenance, not XLSX ZIP modification times, for publication availability.
The issuer's [2026 reporting schedule](https://www.pkobp.pl/en/investor-relations/current-reports/report-no-412025-release-dates-of-periodic-reports-by-pko-bank-polski-sa-in-2026)
was published on 15 December 2025 at 15:21 and specifies Q3 results on 5 November
2026; the [issuer calendar](https://www.pkobp.pl/en/investor-relations/calendar)
corroborates the date. Preserve date-only precision and Europe/Warsaw timezone;
this is not evidence for an invented publication instant or next annual deadline.

### PKO extraction findings and supplemental parser boundary

The spreadsheet skill and bundled artifact-tool imported 30 sheets without editing
or exporting the workbook. Exact inspected locations:

| Required metric | Sheet / cells | Value and semantics |
| --- | --- | --- |
| Net interest income | `2_RZiS_P&L_new`: S7 + T7; headers S4=`Q1'26`, T4=`Q2'26`, B4=`Quarterly (PLN mn)` | 5,953 + 6,074 = 12,027 PLN million for 2026-01-01 through 2026-06-30 |
| Net profit attributable to parent | `2_RZiS_P&L_new`: S35 + T35, same period headers | 2,522 + 2,768 = 5,290 PLN million for H1; use parent profit, not the other net-profit row |
| Loans and advances to customers | `8_Bilans_Balance sheet_new`: T25; T4=`30.06.2026`, B4=`(PLN mn)` | 315,047 PLN million, instant 2026-06-30 |
| Amounts due to customers | `8_Bilans_Balance sheet_new`: T50, same date/unit | 475,762 PLN million, instant 2026-06-30 |
| Tier 1 capital ratio | `12_Adekwatność_Capital adeq_new`: T34; T4=`30.06.2026`, B34=`Tier 1 Capital ratio` | Raw decimal 0.1553, scale 1; conflict described below |

The income statement B1 explicitly says consolidated income statement; the
balance-sheet B1 explicitly says consolidated statement of financial position.
All selected values are numeric literals without formulas. Do not use the key-data
sheet's separate `Core Tier 1` value 0.15531 as a substitute. Do not sum instant
balances or relabel Q2 alone as H1. Preserve raw magnitudes with scale 1,000,000
for monetary data, and ratio decimal with scale 1. Quarter aggregation must retain
both source cells and their exact adjacent, non-overlapping duration periods.

The consolidated PDF corroborates income metrics on page 5 and balance metrics on
page 7. **Its page 33 capital table reports Tier 1 ratio 15.55 at 30 June 2026,
while the XLSX and landing page report 15.53.** The PDF's prior-year published ratio
15.57 matches the existing annual mapping. The difference must be resolved by
verified prudential basis or publication/revision evidence before treating these
as the same required fact. No parser may silently choose the first value, relabel
Tier 1 as CET1 or claim all five metrics are consistent.

A new XLSX normalizer is not implemented by this calendar package. Before that
extension, independently review the exact mapping, quarter-sum derivation and
capital conflict treatment. Require bounded ZIP/XML extraction, rejection of
encrypted/macro/external-link/DTD/ambiguous archives and malicious expansion,
exact sheet/title/row/column/unit checks, finite literal values, no formula
evaluation or guessed cached results, issuer/source binding and preserved document
hash/provenance. Tests need wrong periods, missing/duplicate cells/headers,
quarter-versus-YTD confusion, scale errors, formula values, source revisions and
the conflicting capital values. Four corroborated values alone do not satisfy the
mandatory bank profile.

The external decision required is a source-backed resolution of the issuer's
conflicting published group Tier 1 value: an issuer correction/revision or evidence
explaining differing prudential bases and identifying the applicable consolidated
fact. An operator preference for one number is insufficient. Until that evidence
exists and a supplemental parser contract is independently reviewed, no five-fact
PKO H1 normalization or research-eligibility claim is supported.

### Apple extraction recheck

Fresh SEC responses have the same hashes as PP4. Submissions identifies Apple Inc.,
CIK 0000320193, AAPL/Nasdaq. Running the existing production normalizer against
these actual downloaded responses succeeded: two consolidated reports, eight facts.

| Metric (USD, scale 1) | Annual 2024-09-29..2025-09-27 | Periodic YTD 2025-09-28..2026-06-27 |
| --- | ---: | ---: |
| Revenue | 416,161,000,000 | 364,357,000,000 |
| Net income | 112,010,000,000 | 101,464,000,000 |
| Operating cash flow | 111,482,000,000 | 116,996,000,000 |
| Total debt, period-end instant | 98,657,000,000 | 84,344,000,000 |

Accessions remain `0000320193-25-000079` and `0000320193-26-000020`. Debt is the
configured same-accession/date sum of LongTermDebtCurrent, LongTermDebtNoncurrent
and CommercialPaper. Seventy-four mapping diagnostics preserve excluded older
accessions/other durations; success is extraction, not complete issuer research.

Apple's [official IR page](https://investor.apple.com/investor-relations/default.aspx)
was reachable but the retrieved view did not establish a complete news/event feed
or verified upcoming reporting deadline. Both issuers still require source
automation/retention evidence, complete fresh mandatory news/calendar windows and
operational model availability. Configuration/key presence or public model names
do not prove account access to the exact strict-schema model request. No model
availability probe or expenditure was authorized/performed here.

## F: installed capability and remaining blocker

Installed versions are `ib` 0.2.9 (package range `^0.2.8`) and `@stoqey/ib` 1.6.10.
The former negotiates client protocol version 62. Both installed execution-request
encoders accept client/account/time/symbol/security-type/exchange/side filters;
neither returns an authenticated history lower bound. Production already has the
separate `CompletedOrdersClient` using `@stoqey/ib.reqCompletedOrders(false)`.
Older reports describing no completed-order adapter are not current capability
evidence. Its production recovery scope remains `current_state_only`.

IBKR documents [current-day execution retrieval](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/execution-details/request-execution-details),
with [TWS/Gateway retention differences](https://interactivebrokers.github.io/tws-api/executions_commissions.html).
The account-wide [client-ID visibility contract](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/client-id-0-and-the-master-client-id)
also depends on actual Master Client ID and manual/FIX client-0 settings. Sending
filter.clientId=0 does not prove the connection has that visibility. Completed
orders concern the [broker's given day](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/retrieving-completed-orders/introduction),
not an authenticated Warsaw-day certificate. [Execution corrections](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/execution-details/exec-id-behavior)
and [commission callbacks](https://www.interactivebrokers.com/docs/tws-api/doc/order-management/commission-and-fees-report)
also require explicit accounting handling.

The reconciliation adapter previously requested a minimum including UTC midnight
and session recovery bounds; after a later process start that could omit the
beginning of the Warsaw day. It now uses the existing `paperAccountDayStart`
Europe/Warsaw calculation for that floor, retaining earlier session-start-minus-margin
and ambiguous-attempt-minus-margin boundaries. The wire request remains UTC with
an explicit `yyyyMMdd-HH:mm:ss` representation. No certification flag or source
capability changes. Requesting `from`, receiving an end marker, process uptime or
empty local rows still do not certify coverage.

Production does not emit `certifiedFrom`; `buildPaperDailyLoss` correctly rejects
missing coverage before entry. It also checks fresh matching account/session/
connection/position generations, broker/local execution correspondence, finite
commissions and realized P&L. Preserve all those denials. A future positive
collector requires verified host retention/timezone/client visibility, complete
account-wide executions and costs, durable gap/correction provenance and final
freshness fences. Existing overwrite-style fill/commission storage is not an
immutable corrected-execution ledger. No evidence obtained here supports issuing
positive coverage certificates or changing the supported broker source.

The external capability decision remains whether an authorized, documented broker
source can establish the complete Warsaw account day across retained history,
all client/manual/FIX visibility and delayed/corrected fees. Actual host settings
and retention evidence must accompany that source, followed by an independently
reviewed collector/accounting contract. Merely migrating execution requests to
the already installed newer library does not supply missing completeness evidence.
Until then the production daily-loss gate remains blocked.

## Validation and remaining work

- Shared build, llm-agent typecheck and execution-engine typecheck passed.
- Thirty focused eligibility/provider/refresh tests passed, including old snapshots,
  past-only EMPTY, horizon expiry, wrong-role/partial/malformed range, future
  publication versus occurrence and range-preserving refresh/restart.
- Seven existing research audit integration tests passed against the designated
  disposable PostgreSQL 16 on port 55447, retaining one-call/lease/late-outcome and
  changed-source fences. Initial sandbox TCP EPERM prevented connection; the same
  command passed with approved local-network access. No operational DB was used.
- Forty-four focused broker/daily-loss/lifecycle tests passed. Eleven new tests
  exercise the real production reconciliation adapter and TWS client with a local
  controlled event emitter: winter/summer, both DST boundaries, Warsaw/UTC date
  mismatch, earlier session/ambiguous recovery with safety margin, successful
  empty responses, late commission callbacks and reconnect generation changes.
  End markers and complete local costs still leave `certifiedFrom` absent and
  daily-loss entry evidence unavailable. No actual broker connection was opened.
- Scoped whitespace/diff check passed. Full-package CI and independent hostile
  implementation review belong to the lead's integrated delivery; they are not
  claimed complete by this evidence document.

Requested model/effort: gpt-6-astra/high. Backend actual-model telemetry and token
usage are unavailable. No implementation repair round was needed for the initial
focused tests. Public data receipts prove acquisition and extraction only. PKO
capital reconciliation, complete research feeds/permissions/deadlines/model access
and certified broker account-day accounting remain explicit Gate A blockers.
