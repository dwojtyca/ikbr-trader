# PP4 provider normalization contract

Date: 2026-10-04. A-authored adapter contract under the accepted
[PP4 plan](PP4_IMPLEMENTATION_PLAN.md). These are capabilities, not a claim that
all mandatory sources are ready. No paid provider has been selected or called.

## Verified public observations

Direct unauthenticated requests at 09:29–09:30 UTC returned HTTP200 for:

- SEC Apple [submissions](https://data.sec.gov/submissions/CIK0000320193.json)
  and [companyfacts](https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json).
  Both identify CIK0000320193/Apple Inc.; submissions lists AAPL/Nasdaq.
  Latest observed annual accession 0000320193-25-000079, period 2025-09-27,
  and periodic accession 0000320193-26-000020, period 2026-06-27.
- PKO [annual page](https://www.pkobp.pl/en/investor-relations/financial-reports/2025-annual-report)
  and its consolidated [XHTML](https://www.pkobp.pl/api/public/7ac80885-6c08-42c2-8c15-42540e4e3987.xhtml).
  XHTML is a financial document with ordinary tables, not usable inline-XBRL facts.
- PKO [IR](https://www.pkobp.pl/en/investor-relations) and
  [Apple IR](https://investor.apple.com/investor-relations/default.aspx).
  Reachability alone does not certify news/calendar completeness.

PKO's official identity page identifies LEI P4GTT6GF1W40CVIMFR43 and ISIN
PLPKO0000016. Source mapping must still match the configured full broker listing.
SEC public-filing reuse is documented by its webmaster FAQ; automated deployment
must comply with identification/pacing. PKO automation/retention permissions remain
UNVERIFIED. Calendar/news completeness and PKO latest periodic extraction remain
unverified. Keep mandatory coverage denied until these have independent evidence.
No provider key or public browse result establishes entitlements for other sources.

## Pure PP4-B adapter interface

Own `apps/llm-agent/src/research-providers.ts` and tests. Inputs include an
A-validated ResearchInstrumentPolicy/source, fetchedAt, source URL, content digest
and response. Outputs are only normalized evidence/reports/facts/news/events and
source results, never an eligibility decision. Shared A code validates outputs.
Use source IDs, issuer IDs, mappings and endpoints from configuration, no ticker
branches, network calls, current time, implicit currency, or default zero facts.

### SEC JSON

`normalizeSecReports(submissions, companyfacts, mapping, fetchedAt)` verifies exact
CIK in both and legal name plus expected listing symbol/exchange in submissions.
Exchange comparison uses an explicit configured source exchange (`Nasdaq`), never
currency inference. Reject malformed/mismatched input. Filing metadata is keyed by
accession; each used fact accession must have a matching 10-K/10-Q/amendment,
reportDate and acceptanceDateTime. Unknown old accession is excluded and reported,
not given fabricated publication time. Preserve every mapped period and revision;
no latest-value collapse. Exact acceptance time is publication only after verified
ISO parsing. Source API date-only `filed` is not substituted for acceptance time.

Mapped industrial concepts verified in the actual Apple response:
`us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax` => revenue;
`NetIncomeLoss` => net_income; `NetCashProvidedByUsedInOperatingActivities` =>
operating_cash_flow. All use USD units, scale1. Total debt is the explicit sum of
`LongTermDebtCurrent`, `LongTermDebtNoncurrent`, `CommercialPaper` ONLY for the
same accession/end/scope/unit; retain component source pointers. Missing/duplicate/
conflicting component blocks that derived fact. Do not sum all liabilities. Mapping
is configured and reusable; future issuers can select different verified concepts.
Duration values preserve start/end (quarter vs YTD); instant debt preserves end.
Reports keep original annual/periodic periods from configured required report
requirements plus exact accession reportDate. Reject unexplained period changes.
Do not claim SEC submissions supply complete broader news or upcoming calendar.

The SEC parser maps only the configured annual and periodic periodEnd values.
It preserves every matching accession and amendment for those periods. Older
accessions are excluded with an OUTSIDE_CONFIGURED_REPORT_PERIOD diagnostic; a
newer annual/periodic filing than the configured period fails with
RESEARCH_REPORT_MAPPING_OUTDATED. For selected accessions, instant facts must
match the configured periodEnd. Duration facts are retained only when both
start and end exactly match the configured period; other durations (including
quarter versus YTD alternatives) are counted as UNMAPPED_DURATION. The parser
does not infer a report start date from facts. Unknown accessions are excluded
and counted separately. These exclusions are diagnostics, not eligibility
decisions.

### Generic declared XHTML financial tables

Use an XML parser (`saxes`6.0.0, ISC) with no DTD/external entities, no network,
max10MB input, maxdepth128, max10000 rows/max100 cells per row and bounded cell text.
Malformed XML/doctype rejects. Nested layout tables retain separate rows; ambiguous exact matches reject. Ignore scripts/styles; never
execute markup. Extract plain table rows, then use configured exact table-header
and row-label/column-header mapping. Exactly one table/row/column must match; no
first-match heuristic or fuzzy semantic matching. Verify configured issuer marker,
document-period marker and source unit marker appear in visible document text.
Identity markers alone do not establish listing; mapping provenance is separate.

Verified PKO 2025 consolidated document observations (PLN million): income statement
header `[INCOME STATEMENT, Note, 2025, 2024]`; `Net interest income` and
`Net profit attributable to equity holders of the parent company` map to duration
net_interest_income/net_profit, period2025-01-01..2025-12-31, column2025.
Balance-sheet customer loans and customer deposits map to instant loans/deposits
only under a verified table/date header. Capital table header `Capital adequacy`,
`31.12.2025`, `31.12.2024 (restated)`, `31.12.2024 (published)` and exact row
`Tier 1 capital ratio` map to tier1_ratio percent, scale1, period-end2025-12-31,
prudential basis recorded in source pointer. Never relabel Tier1 as CET1 or collapse
restated/published columns. Column-specific configured publication metadata must
preserve later revision availability. Missing latest periodic/permissions remains
an operational blocker even when this pure annual parser succeeds.

### Declared source data / news and events

A strict normalized evidence input adapter is useful for fixtures and future
verified feeds, but must be labelled `declared-evidence`; it is not a real provider
or permission proof. Every item requires issuer ID/identifier, safe source URL,
published timestamp/precision and source reference. Calendar occurrence is separately required; an announcement time is not its event time. Facts retain raw magnitude with an explicit multiplier, applied exactly once. Reject foreign issuer/listing,
invalid timestamp, duplicate conflicting document IDs; deduplicate exact duplicates.
EMPTY requires complete successful window evidence. Do not convert transport or
parse failure into EMPTY. Model/source instructions stay plain bounded data.

## Tests and limits

Fixture tests must cover real response shapes (small synthetic values), exact and
wrong issuer/listing/share class; malformed numeric/time/unit, multiple durations,
amendment preservation, incomplete debt, XML entities/doctype/nesting, duplicate
labels/tables and prompt-injection text. Also run the normalizer locally against
already fetched public SEC payloads, reporting extraction separately from eligibility.
Do not commit full public documents or treat successful parser tests as permission.
B must escalate ambiguous financial semantics before implementation; one ordinary
repair attempt then return evidence for Sol/A. Final package gets independent RA.
