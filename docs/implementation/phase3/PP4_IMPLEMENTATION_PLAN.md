# PP4 implementation plan and bounded contract

Date: 2026-10-04. Status: accepted by independent Astra/high review after one repair round.
Baseline: `5e965b36fa6f5fb0342781a6445c2cc11c840718`, main. This implements
[delivery §8](PAPER_PRODUCTION_DELIVERY_PLAN.md#8-pp4--instrument-research-and-complete-ai-audit)
and [research context](../../architecture/INSTRUMENT_RESEARCH_CONTEXT.md), retaining
[PP1](PP1_CONFIGURATION_CONTRACT.md), [PP2](PP2_RUNTIME_CONTRACT.md) and
[PP3](PP3_IMPLEMENTATION_PLAN.md). Their publication reports were inspected.
Twenty-five unrelated dirty paths are frozen in the lead's SHA-256 inventory;
ES, simulator, legacy SignalEngine and unrelated documents are excluded.

## 1. Scope and dependencies

PP4-A establishes all identity, time, units, eligibility, storage, provider and AI
reservation semantics below. A separate Astra/high agent reviews this plan before
implementation. PP4-B uses Luna/medium only for pure provider normalizers under
these semantics. PP4-C uses Sol/medium for fetch scheduling, startup and read-only
source display after A's interfaces exist. A owns shared identities, SQL constraints,
claim/call reservations and execution integration. Material changes return for plan
review. Another independent Astra/high agent reviews the integrated implementation.

No PP5 lifecycle, strategy changes, ETF execution, deployment or trading activation.
No paid provider/model calls, API keys or subscriptions during development. Public
coverage discovery is limited to 30 unauthenticated public reads across lead and
research worker; no bypass of access restrictions. This is not runtime diagnostic
authorization. Runtime provider budgets default to zero and refresh defaults off.
The existing configuration barrier remains until per-proposal research validation
can replace it safely; missing research never enables an entry. Existing position
management, reconciliation and audited close do not require research.

## 2. Research configuration and identity (A)

Use a separate strict, versioned research manifest, without changing PP1 canonical
bytes. Its canonical SHA-256 covers policy and provider mapping, and is persisted
alongside the exact PP1 effective configuration hash. An issuer mapping contains
instrumentId, asset class, broker conId, symbol, local symbol/share class, route,
primary exchange, quote currency, legal issuer name, country/sector/business,
verified issuer identifiers (e.g. CIK, LEI, ISIN), source-specific IDs and verification
URL/time/outcome. Match the entire configured listing against the immutable original
PP1 instrument snapshot. Ticker search never establishes identity. Duplicate or
ambiguous issuer/provider/listing mappings fail closed. Another stock uses only
configuration and the same adapters; no PKO/AAPL branches in the research/AI worker.

Providers must prove identity from their response and pinned mapping provenance.
SEC CIK matches submissions/companyfacts; issuer documents must match the configured
legal issuer/identifier and explicitly mapped report, taxonomy, currency and units.
Public issuer coverage is recorded separately from automated-access permission and
permitted retention. Unverified entitlements remain UNVERIFIED, not AVAILABLE.
Source-specific parsing schemas/configuration are reviewed artifacts, not arbitrary
code, network URLs from model output, or instructions contained in source text.

### Research authority and rollout fence

The manifest is bound to one PP1 effective hash. Execution and llm-agent load it
from the same explicit path/expected digest; neither falls back to a latest or
implicit manifest. Immutable storage has an authoritative pointer per PP1 hash.
Initial adoption and changing that pointer require explicit disabled writes and no
active review lease/model call/unknown delivery; old approvals become ineligible
for entry but remain historical management evidence. Every claim, call reservation,
finalize, attempt reservation and final dispatch compares local loaded, authoritative
and pinned manifest hashes. Execution's comparison is independent of the worker.
Both services publish process/hash observations with <=30s validity, and both must
agree before model work/entry; an old binary cannot satisfy these new observations.
Missing manifest/store/peer/drift blocks model and broker work.

The blanket PP4 admission marker is replaced only by this explicit research
admission plus per-proposal binding checks in AI and execution. General config
admission continues all PP1 checks. Signal generation remains diagnostic at this
stage; enabling a scheduled proposal-to-entry loop is not part of PP4. No old
unattributed pending proposal may newly execute without PP4 binding. Historical
attempted orders and closes retain their existing management interpretation.

## 3. Immutable research schema and policy (A)

`InstrumentResearchSnapshot` v1 stores instrument/listing/issuer identity, schema,
configuration/policy/mapping hashes, created/fetched/observed/publication times,
source ID/document ID/URL/content digest/access and retention status, annual and
periodic report evidence, normalized facts, news and calendar query results.
Evidence references are stable within a snapshot. Coverage is AVAILABLE, EMPTY,
MISSING, STALE, UNVERIFIED, ERROR or NOT_APPLICABLE. Provider errors persist a new
negative snapshot; they do not re-date or overwrite the last successful snapshot.
Query window, success time and zero-result evidence distinguish EMPTY from failure.
A monotonic instrument/config/manifest snapshot sequence records every refresh.
Selection uses only the newest snapshot, never searches backwards for a success.
Any newer snapshot (including ERROR, permission loss, restatement or new blackout)
supersedes an older pin for current entry eligibility immediately. A decision using
an older sequence is retained but cannot dispatch or trigger a replacement AI call.
Final dispatch locks the same per-instrument head used by refresh publication, then
checks pinned head equality through synchronous send. Replay deliberately uses the
saved snapshot/context and original decision time, not today's head or documents.

Facts preserve metric, numeric value, unit, currency when monetary, scale, period
start/end, instant/duration, consolidation scope, source reference, publication
precision and revision/restatement link. No zero/default for missing data. Multiple
periods and revisions remain available for audit; select latest published revision
at the decision time, never latest retrieval alone. Conflicting same-priority facts,
unit/currency/scope ambiguity, invalid/future timestamps and inverted periods deny
eligibility. Date-only publication is conservatively eligible after that source
calendar day's end, with declared timezone; no fabricated exact publication time.
No future document/fact is AVAILABLE. Future scheduled events are allowed only if
the announcing evidence was already published. Snapshots cannot see future fetches
in replay. Selection re-evaluates policy at the actual decision/dispatch time.

Required stock groups: verified issuer/listing and company profile; annual and most
recent applicable periodic report with sourced facts; issuer-matched material news
and corporate events; upcoming earnings/event calendar. Initial policy: news query
15m, lookback 24h and max check age 30m; report/calendar checks 24h. Report eligibility
uses explicit configured reporting regime, required annual/periodic period end and
next expected publication deadline; it never infers all issuers file US quarters.
Initial PKO bank metrics: net interest income, net profit, loans, deposits, CET1 or
Tier1 capital ratio with explicit metric identity; cash-flow/debt are optional if
not meaningful under the configured bank regime. Initial industrial metrics:
revenue, net income, operating cash flow and total debt (or explicitly sourced debt
components with deterministic mapping). Monetary facts retain reporting currency,
which may differ from listing currency; no implicit FX conversion. Ratios declare
percent versus decimal; no silent conversion. Annual and periodic obligations are
checked separately, with period/scope consistency and no mixing YTD and quarter.

Calendar EMPTY is eligible only after a successful covered query and represents no
known date, visibly uncertain. Deterministic earnings/material-event blackout is
24h before through 24h after a known event; date-only events occupy the complete
source-local day, expanded by this window. Invalid/ambiguous event dates deny entry.
Optional macro/analyst/sector data are visibly unavailable and never mandatory.
ETF schema describes fund/share class, prospectus, benchmark, replication, holdings,
concentration, fees, leverage/inverse, distributions, domicile/currency/hedging, but
always returns NOT_SUPPORTED for entry until a separately reviewed extension.

## 4. Storage, refresh, budgets and provider adapters (A/B/C)

Add migration 20; do not modify released migrations. Store immutable manifest and
snapshot JSON with canonical digests; DB triggers deny update/delete, including
repointing referenced evidence. Review binding is an immutable one-per-proposal row
with original client hash, configuration hash, snapshot ID/hash and research manifest
hash. Historical approved/attempted legacy rows remain readable for management;
unattempted old reviews cannot bypass new entry validation.

A defines shared validation, canonical hashing, snapshot insert/read and eligibility
interfaces. C's scheduler runs independently of AI claims and can refresh while no
proposal exists, with bounded concurrency one, source timeout <=10s, response size
cap and no arbitrary redirect/host. Only manifest allowlisted HTTPS origins/paths
are fetched; reject credentials, localhost/private IPs, redirects and model/source
supplied URLs. Request budgets are durable and account/provider/day scoped,
atomically reserved before send. Changing configuration/process does not reset
usage; unknown calls consume budget. Zero budget means no request. Refresh has at
most two attempts per scheduled source slot (one initial + one transient-error
retry); permission/identity/parse failures do not retry. No rapid polling after
failure, and restart cannot create more attempts for the same slot. Retain source
metadata/digests and permitted facts/excerpts, never secrets or unrestricted raw
licensed documents. Source failures are explicit coverage observations.

B normalizes real selected source formats using bounded fixtures and recorded
mappings, preserving periods, identities and publication precision. Source coverage
report must name actual successful reads, machine-format availability and permission
limitations for PKO and AAPL before providers are claimed ready. If required actual
coverage or permissions remain unavailable, code may be validated but PP4 readiness
remains blocked and the report states exactly what is missing. Fixtures never count
as live coverage. Adapter selection/details require A review before B starts.

## 5. Decision binding, lease and model budget (A)

Before model work, lock proposal then review (existing lock order), validate original
PP2 attribution/hash and current loaded configuration, select eligible immutable
research snapshot, pin it exactly once, and persist exact context. Context includes
original strategy instance/parameters/hash, trigger/technicals, order levels and
quantity, per-currency notional/stop risk, estimated fees with source or explicit
unavailability, fresh account/positions/open orders and risk evidence with timestamps.
Unknown account valuation/FX stays unknown; never cross-currency arithmetic.
The trusted context seam is a new authenticated read-only
`GET /execution/proposals/:id/ai-context`, produced by execution from the persisted
original proposal, current broker account snapshot, completed open-order/position
reconciliation generation and the existing deterministic `assessAiEntryRisk` path.
The DTO contains exact proposal/hash/account/session/conId/config identity,
request/completion timestamps, complete generation, positions/open orders, quote,
per-currency valuation/FX evidence, fee reserve provenance and the risk assessment.
It is not the display AccountSummary DTO. Account/order coverage must be complete
and <=10s old, BBO <=10s, no future times, and same live session/account; metadata
retains PP3 deadlines. Context age is rechecked before model reservation. Missing
coverage or failed risk rejects before model calls. A pre-reservation reclaim
rebuilds this transient evidence; its one persisted request becomes immutable only
when model reservation commits. The route performs no broker write and no new
provider call. The execution layer continues to repeat current account/BBO/metadata risk after AI
and enforce its synchronous final expiry/identity fences.

Existing review expiry (120s from creation) remains the absolute upper bound. Each
claim has a fixed 30s nonrenewable lease; account/context preparation <=8s and model
request <=10s, leaving time for persistence. No report/news fetch occurs during claim.
Persist a model-call reservation before network send with unique proposal identity,
request digest, model/prompt/output-schema versions, start/deadline and reserved
maximum tokens/cost. Per-account/provider UTC-day count and monetary ceilings are
atomically charged in the same transaction. Default ceiling zero. Cost is a
configured conservative maximum per call and explicit input/output token bound;
actual usage/cost, if supplied, is audit only and does not refund unknown requests.
One model request per proposal, including malformed/timeout/unknown/REJECT outcomes.
No retry to obtain approval. Restart/claim expiry after reservation expires/rejects
the review and records an unknown outcome without another provider call or delivery.
Claims that expire before call reservation can be reclaimed until total deadline.
Late responses are audited but cannot approve or deliver; stale tokens cannot update
a replacement lease. Delivery marker remains atomic before at-most-once HTTP call;
unknown delivery never automatically repeats. Retain outcome audit for every path.

Persist exact model request payload/context and digest before call. Structured output
requires EXECUTE/REJECT, bounded confidence/reason/riskFlags and evidence references
from the pinned snapshot; EXECUTE requires required evidence membership, not invented
citations. Reject unknown keys, malformed JSON, out-of-range numbers, oversized text,
unknown references and missing required fields. Record riskFlags even for REJECT,
provider outcomes, timings/latency, actual model ID and prompt/schema version.
Model-returned tools/URLs/instructions have no execution authority. Untrusted source
text is bounded and clearly nested as data; system instructions prohibit following
it, there are no model tools, and eligibility/risk cannot be overridden by prose.
Replay uses the persisted exact request/context, without fetching changed sources.

Execution reads and independently validates immutable binding, snapshot/config hashes,
required coverage/freshness and decision/context membership before reservation and
again at final dispatch. Research expiry joins existing AI/risk deadlines. Cached
research cannot replace fresh quote/account risk. Legacy management paths retain
original approvals and never require retroactive research to close.

## 6. Read models, tests and completion

C exposes original research sources, coverage, snapshot/context/config identity,
riskFlags, evidence references and timing through existing authenticated order
read APIs/UI detail. Do not add trading controls or broad PP6 redesign. URLs render
as safe HTTPS links with text escaping; hostile source HTML is never executed.

Acceptance cases: PKO bank and AAPL industrial fixtures plus a third configured
stock; wrong issuer/same ticker/other venue/share class; missing/stale/future reports,
multiple reporting periods, late/restated facts and point-in-time replay; units,
reporting currencies, calendar unknown/blackout; EMPTY news versus errors;
malformed/hostile source text; model invalid output/timeout/REJECT; simultaneous
budget reservations and refresh restart; claim expiry before/after model reservation;
late finalize and process restart; fresh BBO change after approval; no model/broker
call with absent required research; existing close remains independent.

Run focused checks during implementation; final frozen clean candidate excludes
all pre-existing dirty files. Required: pnpm lint, pnpm typecheck, pnpm test,
pnpm test:integration on isolated PostgreSQL16, pnpm build. Clean Docker build if
startup/Compose changes require it. No strategy behavior changes: new backtests are
not applicable, existing replay suites still run. Independent final hostile review
must accept source and report. Record routes, actual dispatch, repairs, timings and
unavailable token data. Scoped commit/push on main and exact-commit GitHub CI required.
Report distinguishes implementation/test acceptance, public source observations,
permission/coverage blockers and operational readiness. No PP5 or trading activation.

## Plan review repairs

First independent Astra review required explicit manifest authority/drift/barrier
semantics, a broker-derived AI context DTO/freshness seam, and newer-evidence
supersession rules. The added sections resolve these before implementation.
Targeted cases include equal PP1/different research hashes, manifest replacement
during model work, stale parseable summaries, incomplete orders/wrong session,
pre-call reclaim, and correction/blackout/error publication while AI is running.

## Implementation clarifications within the accepted scope

Refresh reserves one charge per HTTP URL, including both SEC API responses, and
retains separate digests/references. An explicit allowlisted RESEARCH_BUDGET_ACCOUNT_ID
charges read-only source work without guessing the first broker account. Per-instrument
session advisory locks serialize schedulers; a published slot and snapshot commit
atomically, so process restart cannot turn a successful slot into an error. Unknown
charged but unpublished calls remain consumed. Declared query windowEnd is its
coverage as-of time; acquisition time records response completion. Both are retained.
Financial value is raw magnitude and scale is applied once. Exact model wire JSON
is saved before send. These clarify the planned budget, freshness, replay and retry
invariants; they do not authorize operational calls or new execution scope.
