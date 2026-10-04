# Instrument research and AI decision context

Status: **PP4 contract implemented and independently reviewed**, 2026-10-04.
Full real-source acceptance remains blocked; see the
[PP4 implementation and coverage report](../implementation/phase3/PP4_IMPLEMENTATION_REPORT.md).
ETF data has a descriptor contract only; ETF research providers and execution remain unsupported.
This extends existing llm-agent/shared modules; it does not move AI into execution.

## Two timelines

Slow instrument research is fetched/cache-refreshed before signals and stored as
an immutable `InstrumentResearchSnapshotV1`. A time-sensitive entry
review joins the latest eligible snapshot with the exact proposed order, technical
observations, fresh account/quote evidence and deterministic risk results. It pins
the snapshot ID/version to both proposal and decision. The dispatcher repeats
execution risk checks after AI; cached research cannot certify price/account freshness.

Do not download annual reports during the current 30-second AI claim. PP4 introduces
an explicit total decision deadline, a bounded claim/renewal policy if needed,
provider timeout and per-day cost/request limits. Persisted delivery still occurs
at most once; repeated research/model attempts cannot retry an unknown broker write.

## Snapshot contract

| Field group | Required evidence |
| --- | --- |
| Identity | instrumentId, broker conId/listing, asset class, quote currency, verified issuer/fund IDs, provider mapping and verification provenance |
| Version | snapshot ID, schema version, canonical content hash, policy/config version |
| Source | provider and document IDs, source URL, retrieval outcome, licensed/entitled access status |
| Time | publishedAt, source observation/effective time, fetchedAt, reporting-period start/end, expiration/freshness decision |
| Coverage | Required/optional source results: AVAILABLE, EMPTY, MISSING, STALE, UNVERIFIED, ERROR or NOT_APPLICABLE |
| Facts | Normalized values with units, currency, period and pointers to source evidence; conflicting/restated values preserved with explicit precedence |
| Summary | Bounded evidence-grounded narrative, never a substitute for provenance or a source of fabricated values |

Publication time must not be after decision time. Historical replay selects only
facts published at the replay time, including restatement publication dates; later
revisions cannot leak into earlier decisions. A future/invalid timestamp, ambiguous
issuer or currency mismatch cannot become AVAILABLE. EMPTY means a successful query
with zero qualifying events; it is different from a failed/missing source.

## Asset-specific minimums

| Asset | Required design scope | Separate optional expansion |
| --- | --- | --- |
| Stock | Issuer/listing match, business/sector/country, most recent annual and periodic report available under that issuer's reporting regime, sourced financial facts, reporting dates/known upcoming earnings, matched material news/corporate events | Sector benchmarks, analyst estimates, deeper macro |
| ETF | Issuer/fund/share-class match, prospectus/factsheet, benchmark, replication, holdings/concentration, fees, leverage/inverse, distributions, domicile, currency/hedging | Flows, tracking error histories and broad positioning |
| Futures/options/other | Explicit asset-specific policy and adapter required before entry support | Futures expiry/roll/multiplier and option underlying/expiry/strike/Greeks cannot be replaced by stock fundamentals |

Stock facts should include revenue/profit/cash flow/debt when meaningful for the
issuer. Bank-specific reporting (PKO) requires appropriate metrics and availability
rules; do not infer missing industrial cash-flow metrics are zero. AAPL and PKO
report on different calendars and under potentially different taxonomies. Do not
require a fictional identical quarterly filing format for all markets.

PP4 begins with verified coverage for the two initial stocks. Define ETF schema
and NOT_SUPPORTED behavior now; implement and test actual ETF sources together
with a complete ETF execution/close capability in a bounded extension. No ETF
fundamental or trading support is claimed merely because the schema has a branch.

## Providers and coverage policy

Use official issuer/regulatory documents when available and a licensed provider
where automation/coverage requires it. SEC EDGAR exposes submissions and XBRL facts
for reporting issuers ([official API reference](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)).
It is not a universal PKO/ETF provider. Before declaring PP4 ready, record successful
source identity/coverage checks for both issuers and provider permission/availability.
No paid call or subscription is authorized by this document.

IBKR market-data subscriptions do not by themselves establish research/news access
or model availability ([IBKR subscriptions](https://www.interactivebrokers.com/campus/trading-lessons/subscribing-to-data/)).
Avoid treating Marketaux ticker search as issuer verification. Validate response
entities/listings, publication timestamps, requested time window and duplicates;
unmatched items remain excluded from instrument-specific evidence.

Proposed initial refresh defaults: news query every 15 minutes with a 24-hour
lookback, coverage refresh no older than 30 minutes at entry; issuer filing checks
once per day with last successful check no older than 24 hours; upcoming-event
calendar checked within 24 hours. Reports remain eligible by issuer reporting
period/expected filing schedule, not by a universal 24-hour document age. Source
specific exceptions must be explicit policy revisions, reviewed and tested. The
model cannot waive a missing mandatory source. No known earnings date must be
represented with provider coverage and uncertainty rather than an invented date.

Define risk treatment of nearby earnings/material events deterministically per
policy, with configured blackout windows and source quality. Publish the initial
stock policy and fixture outcomes before operational provider evaluation. Cached
optional data may be omitted with a visible warning; stale required data blocks
new entries but not an otherwise supported risk-reducing exit.

## Order context and model output

Send algorithm and strategy-instance identity/parameters/hash; exact contract and
issuer; trigger time and technical snapshot; entry/stop/TP/quantity; stop risk,
notional and estimated fees with units/currency/source; account exposure, open
orders, verified valuation currency/FX and current risk evidence. Missing FX must
not produce cross-currency arithmetic. Deterministic checks remain authoritative.

Output remains structured EXECUTE/REJECT with reason/confidence, persisted
`riskFlags`, evidence references, model ID, prompt/schema version, timings,
provider outcomes and context hash. Validate shape/ranges and source-reference
membership. A reason mentioning unavailable reports cannot be accepted as proven
research. External text is untrusted data; it cannot override tools, risk or
system instructions. Do not expose secrets in prompts/logs or retain full licensed
content beyond permitted retention. Keep sufficient permitted evidence for audit.

## Failure and acceptance matrix

Required tests cover wrong issuer/same ticker on another venue, share classes,
missing/stale/future facts, multiple report periods, currency/unit conflicts,
restatements, empty news versus provider failure, malformed/hostile source text,
model timeout/invalid output, claim expiry/restart and bounded paid-call duplication.

Acceptance requires replaying a stored decision's exact context without fetching
changed documents, showing source references in the operator view, and showing
that missing mandatory context blocks entry before broker dispatch. A provider
REJECT remains a valid result, not an integration failure or a reason to loosen
strategy thresholds. Live provider checks during acceptance require scoped owner
authorization and a recorded request/cost ceiling.
