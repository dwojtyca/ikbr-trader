# PP7 E1b: paginated Marketaux news contract

Accepted by independent Astra/high plan review after expiry repairs, 2026-10-07.
The section-5 database publication deadline supplement was independently accepted
before its store implementation. Independent implementation/document review passed;
full repository and publication checks remain pending; see the
[E1b report](PP7_E1B_IMPLEMENTATION_REPORT.md).
This bounded package
continues [E1](PP7_CLOSURE_PLAN.md#e1-authoritative-financial-extraction-and-actual-source-coverage)
and [PP7](PP7_IMPLEMENTATION_PLAN.md). It implements an actual positive news
adapter through the existing research scheduler, call reservations and immutable
snapshots. It does not complete calendar coverage or qualify an operational launch.
No credentials, paid calls, broker actions or runtime configuration changes were
used to prepare this contract. Requested author route: `gpt-6-astra` / `high`;
actual model/effort must be recorded by the dispatching lead. Token usage is
unavailable. Independent plan and final implementation reviewers must differ.

## 1. Verified source and remaining qualification

The official [API documentation](https://www.marketaux.com/documentation), inspected
2026-10-06 UTC, describes `/v1/news/all`, UTC dates, symbol/entity filters,
`published_after`/`published_before`, page/limit pagination, and
`meta.{found,returned,limit,page}`. Article records include UUID, title, URL,
publication time and identified entities. Result access is bounded to 20,000.
The separate `/v1/entity/search` endpoint provides provider entity metadata.
The documentation does not promise a snapshot token or immutable pagination.

The [pricing page](https://www.marketaux.com/pricing) advertises Free at 100
requests/day and three articles/request. This is not evidence of the owner's
actual subscription. At the current fifteen-minute news cadence, two issuers need
192 first-page calls per full day before pagination; the two-pass contract below
needs at least 384. Do not raise budgets, buy a plan, reduce mandatory coverage or
change freshness requirements to hide this mismatch.

The [terms](https://www.marketaux.com/tos) describe personal noncommercial use,
site automation restrictions and third-party content. Evaluate the deliberately
offered API and the applicable terms together for this private use; do not apply
a generic website anti-bot clause as a blanket prohibition on its published API.
Do not infer a global copyleft requirement or permission to redistribute publisher
articles. Record the API/terms review and applicable subscription evidence for private Paper research,
retaining only identifiers, titles, dates, references and acquisition receipts.
Keep raw bodies, descriptions, snippets, highlights and images out of snapshots,
logs, fixtures derived from real articles and committed evidence.

No additional written permission is automatically required by this contract;
only a material unresolved conflict about the actual intended use needs clarification.

Operational prerequisites remain: a verified Marketaux entity for each configured
issuer/listing, actual plan limits, owner-approved request/cost ceilings, credential
availability, and applicable private-use retention permission. PKO's provider
symbol is unverified; do not guess `PKO`, `PKO.WA` or another alias. AAPL is also
subject to the same verified mapping contract. Qualification may use existing
authorized read-only access within its concrete budget; no unbudgeted API probe
is implied by this implementation plan. Positive synthetic tests are legitimate
code evidence and must be labelled synthetic, never operational qualification.

## 2. Manifest and identity contract

Add explicit source adapter `marketaux-news`, parser kind `marketaux-news-v1`,
roles exactly `["news"]`, provider exactly `https://api.marketaux.com`. Retain
schema version 1 and backward compatibility for existing valid sources; strict
new-kind validation is shared by manifest loading and runtime. Do not route this
through the legacy `MarketAuxClient`, whose truncated compatibility output does
not establish coverage. Leave its consumers unchanged in this package.

Define a strict `MarketauxNewsConfig` in a dedicated shared research module:

| Field | Contract |
| --- | --- |
| `kind` | `marketaux-news-v1` |
| `entity` | Exact provider `symbol`, `name`, `type: equity`, `country`, and `exchange: string or null`; no fallback aliases or ticker inference |
| `qualification` | `outcome: VERIFIED or UNVERIFIED`, `verifiedAt`, `expiresAt`, credential-free entity-search evidence URL and SHA256 of the nonsecret entity receipt, policy issuer identifier and listing conId |
| `entitlement` | `outcome: VERIFIED or UNVERIFIED`, `verifiedAt`, `expiresAt`, evidence URL and SHA256 of nonsecret plan/permission receipt, `maxArticlesPerRequest`, `maxRequestsPerDay`, `maxCostMicrosPerDay` |
| `pageSize` | Positive integer <=100 and <= qualified plan maximum |
| `maxPagesPerPass` | Positive integer <=100; pageSize × maxPagesPerPass <=20,000 |
| `maxArticles` | Positive integer <=900 and <= pageSize × maxPagesPerPass |

These are explicit limits, not automatic defaults or proof assertions. Timestamps
must be canonical UTC; VERIFIED records require `verifiedAt <= now < expiresAt`
at refresh and every subsequent admission checkpoint. Both qualification records are manifest-hashed, tied to the current
policy identity, and must be reissued when mapping, entitlement or permissions
change. The source's existing request/cost caps must not exceed entitlement caps.
Retain the provider-wide minimum caps already enforced by `fetchReserved`; same
provider means the same durable account/provider budget across both issuers.
PERMITTED automation and FACTS_AND_REFERENCES remain mandatory.

Qualification and entitlement expire independently. Recheck both before every
page reservation, immediately before its network request, and immediately before
snapshot publication. The overall acquisition deadline is the minimum of
refresh start +120 seconds and both expiry instants; each request deadline is
the minimum of now +10 seconds and that overall deadline. Abort at expiry; a
reservation already made remains spent. Expiry during an attempted acquisition
publishes ERROR, never a successful partial or freshly eligible snapshot.

Shared `evaluateResearchEligibility` must also deny the stored snapshot whenever
either required Marketaux qualification is unverified, future-dated or expired,
including at the exact expiry instant. Include both expiries in the minimum
`ResearchEligibility.expiresAt` deadline together with existing freshness limits.
This check applies during AI review and final binding/dispatch validation, so
evidence acquired before expiry cannot authorize entry after expiry. Structural
manifest/snapshot decoding remains independent of wall-clock expiry: correctly
formed historical evidence must remain readable for audit. Do not invalidate
history by putting a current-time check into the historical schema decoder.

The operational evidence receipt records the actual issuer/listing crosswalk and
the actual provider entity result, including a legitimately null exchange.
Null is exact provider data, never a wildcard. Verify name/country/type and issuer
crosswalk; a matching symbol alone is insufficient. Evidence URLs and hashes
support operator review, not cryptographic third-party attestation. Do not treat
an arbitrary nonempty receipt as qualified. The disabled example can contain an
explicit UNVERIFIED candidate mapping but never invent a verified PKO identity.

Exactly one canonical URL is stored in `source.urls`. Generate it deterministically
from the fixed HTTPS endpoint and the exact configured symbol, country, equity
type, `filter_entities=true`, `must_have_entities=true`, `group_similar=false` and
pageSize. Use URLSearchParams encoding in a fixed documented order. Reject a URL
that does not equal this generated value, including extra keys, duplicate keys,
credentials, fragments and noncanonical encoding. No language, domain, sentiment,
search, match-score or relevance filters may silently shrink the news universe.
Omit sort parameters, using the documented publication ordering; do not guess a
sort option from the documentation's inconsistent `published_on`/`published_at`
terminology. Page traversal must not depend on tie ordering.

## 3. Request authority and secret isolation

Preserve `assertResearchSourceUrl` and the exact allowlist for all existing kinds.
For Marketaux only, use a dedicated request descriptor:
`{ sourceUrl, windowStart, asOf, pass: 1|2, page }`. Validate sourceUrl by the
existing exact allowlist; derive transport query fields internally. The caller
cannot supply a destination, extra query field, next-link or authentication value.
The same pure builder provides the credential-free canonical request URL for
reservation hashes and receipts. Pass number belongs in the durable call identity,
not in the provider HTTP query. Strict bounds apply before reservation/network IO.

Inject `LLM_AGENT_MARKETAUX_API_KEY` from startup environment through a private
transport dependency. Missing/blank credentials fail before any request. Append
`api_token` only to a fresh URL inside the HTTPS transport after validating the
credential-free descriptor. It must never enter source.urls, manifests, request
hashes, call keys, receipts, errors, snapshots or diagnostics. Token rotation does
not refund reservations. Use the existing public DNS validation and pinned lookup,
TLS verification, no redirects, ten-second per-request deadline, 10MB response
limit and bounded headers. Require JSON content type; reject status/envelope errors.
Do not include raw response bodies, request objects or native transport errors in
operator errors. Return stable, enumerated failure codes; sanitize even errors
thrown by injected clients before scheduler persistence.

Dynamic publisher article URLs are reference data, never fetch authority. Keep
`ResearchEvidence.url` equal to the exact canonical source URL and use
`documentId = marketaux:<uuid>` to identify the record. Do not change
`source.urls.includes(evidence.url)` or append publisher URLs to the allowlist.
Preserve the publisher URL only in the validated acquisition record hash in this
first package; direct clickable publisher links are intentionally outside scope.
No publisher, image, similar-story, next-link or entity-search request occurs
during scheduled news refresh. Publisher URL validity is checked as reference
data with `safeResearchUrl`; malformed links fail the refresh rather than disappear.

## 4. Fixed time window and bounded exhaustive acquisition

Set `asOf = newsSlot * 900000 - 1000` once per source
refresh. Coverage is the closed interval `[asOf - 24h, asOf]` and checkedAt is
exactly asOf, never acquisition completion. Query with second-resolution UTC
`published_after = windowStart - 1 second`, `published_before = asOf + 1 second`,
using the documented no-suffix UTC wire format. These one-second margins avoid
assuming undocumented boundary inclusivity; the slot-start anchor and one-second
lag keep the upper query bound no later than refresh start. Both passes use
identical bounds. The stable slot-derived time also survives process restart.

Exhaust and validate the expanded result before filtering the small margins.
Strictly parse real calendar dates and UTC timestamps, retaining provider
microsecond precision during boundary comparisons; canonicalize to milliseconds
only after deciding membership. Reject missing/malformed/future or out-of-query
publication times. Margin records count toward result, page and memory bounds but
are not emitted as news. Never stretch windowEnd to the final fetch time.

Per pass, request consecutive pages starting at 1. Before each HTTP request,
reserve its own durable call and cost. For every response require an object with
`meta` and `data` array; integers `found >=0`, `returned >=0`, exact requested
limit and page, returned equal array length, and consistent found across pages.
Reject over-ceiling found immediately, before requesting further pages. Expected
pages are `max(1, ceil(found/pageSize))`; this number must fit maxPagesPerPass and
its final page × pageSize must fit the provider's 20,000 bound. Require exactly
the expected returned count on every page, including the last. This also handles
an exactly full last page without an undocumented extra sentinel request.

Each item requires a valid unique UUID, nonempty bounded title, safe URL, valid
publication time and exactly one matching configured entity tuple. Other entities
may coexist; they do not establish this issuer's identity. Malformed/mismatched
records fail the whole refresh; no silent filtering or truncation. Unexpected
nonempty grouped `similar` output rejects because grouping was disabled. Duplicate
UUIDs anywhere in one pass reject even when contents match: deduplication cannot
prove an omitted page item was recovered. Do not collapse different UUIDs merely
because their publisher URL or title agrees.

Run a second complete pass, including the zero-result case. Its found count and
sorted UUID-to-normalized-record digest set must exactly match the first pass.
The digest includes title, original publication timestamp, publisher URL and the
matched entity tuple. Page order may differ if every unique item is present;
stable ordering of equal publication timestamps is not assumed. Count drift,
UUID insertion/removal/substitution or changed record data means ERROR. Do not
restart acquisition in the same refresh, and never convert partial results to
EMPTY. This is bounded observed completeness for the provider query; it is not
an atomic snapshot guarantee or a claim that every world publication is indexed.
Late indexing after the successful read remains a provider limitation addressed
by subsequent refreshes, not fabricated publication knowledge.

Cap the entire two-pass acquisition at 120 seconds and 20MB cumulative response
bytes, while retaining existing per-request bounds. maxArticles <=900 preserves
the current 1,000-row snapshot bounds with ordinary report evidence. Validate the
whole integrated snapshot against existing row and 2MB caps; a large other source
can still cause ERROR. Do not trim news or raise shared limits to make it fit.
Keep network sequential, no auto-retry for this new adapter, and no provider
probes or model calls from diagnostics. A HTTP 429/5xx, timeout, malformed response,
budget exhaustion or deadline stop ends this refresh with ERROR. Existing adapters'
bounded retry policy remains unchanged.

## 5. Durable acquisition evidence and refresh integration

Extend `ResearchSourceResult` with optional `acquisition`, accepted only for this
new source kind. Old snapshot shapes remain valid unchanged. For Marketaux
AVAILABLE/EMPTY complete coverage, require a strict object containing:

```
kind: marketaux-news-v1
queryStart, queryEnd, asOf
entityQualificationHash, entitlementHash
found, emitted, recordSetHash
pages: [{ pass, page, canonicalRequestUrl, requestHash, callKey,
          fetchedAt, contentHash, found, returned, limit }]
```

Each pass must contain exactly its contiguous expected pages with matching
counts/bounds and identical found. Validate request descriptor reconstruction,
canonical credential-free URL, hash formats, qualification identities and all
dates. The receipt stores SHA256 of actual returned page bytes; per-article
evidence uses the first-pass containing page's hash, actual fetch time, actual
publication time and UUID. `observedAt` is that fetch time. Namespace IDs using
the existing source/role logic. Required evidenceRefs contain emitted article
evidence only; EMPTY has no evidence/news but retains successful page receipts.
This avoids inventing a publication date for an empty feed or violating the
existing EMPTY invariant. Do not store raw publisher payloads.

The call identity extends the existing research call key only for Marketaux with
source/policy/manifest/slot, fixed bounds, pass, page and attempt=1. requestHash
binds method, canonical request URL and callKey. reserveCall remains authoritative
before every page, including both empty-result requests; use its existing
account/provider atomic daily caps and conservative cost reservation. No refunds
after errors, ambiguity or restart. A crash after a reservation prevents repeating
that call under another identity in the same slot: derive asOf deterministically
from the original slot start as specified in section 4. This creates at most a
fifteen-minute additional lag and leaves the
existing thirty-minute news freshness check unchanged. Late acquisition cannot
advance the claimed window; deadline and freshness remain independently checked.

Use the scheduler's existing per-instrument refresh lock, durable slot marker and
atomic publication. Partial acquisition is discarded; publish ERROR/complete=false
for the current source, preserve unrelated current sources and all immutable
historical snapshots. Do not merge old news into new coverage. Keep completed
call outcomes even when source parsing later fails. A denied permission or
unverified/expired qualification makes the source UNVERIFIED without HTTP IO.
An otherwise qualified attempted acquisition failure is ERROR. A missing key is
an explicit configuration failure and no call is spent. Restart must not replay
an already completed slot or repair an unknown page by making a second request.

Construct and validate the final success snapshot including its coverage row and
all acquisition receipts inside the failure-to-ERROR boundary, before storing it.
In particular, a final 2MB overflow or receipt-validation failure must roll back
the current source and publish a small valid ERROR snapshot rather than escape
before replacing its stale current head. Validate that fallback before storage;
actual storage failures still propagate and cannot be described as publication.
All Marketaux coverage rows, including ERROR and UNVERIFIED, use the same slot
asOf for checkedAt and its fixed 24-hour window, never completion time. A refresh
completing after the next slot begins must not make the later slot's checkedAt
appear to move backward. snapshot.createdAt and page fetchedAt remain actual times.

### Publication deadline after database lock waits (accepted supplement)

Extend `ResearchStore.storeSnapshot(input, refreshSlot?, admissionDeadlineAt?)`
with an optional deadline for this Marketaux success publication only. Existing
callers and historical schema decoding remain unchanged. Require a canonical UTC
deadline; after authority/head locks and prior-head ordering validation, use the
database clock to deny an expired deadline with the single enumerated code
`RESEARCH_SNAPSHOT_ADMISSION_EXPIRED`. The INSERT itself must be conditional on
`clock_timestamp() < deadline`, return the inserted row and fail with that same
code if no row was inserted. Roll back before changing the head or slot marker.
This is the transaction's publication admission point; commit/network completion
is not an additional fresh-source attestation. Stored-snapshot eligibility still
denies entry at expiry independently of commit timing.

The scheduler supplies the minimum acquisition/qualification/entitlement deadline
and catches only this explicit publication-admission expiry to publish the bounded
ERROR fallback without an admission deadline. All other storage failures propagate;
do not retry an ambiguous transaction, republish a success, refund reservations
or claim that a failed ERROR write replaced the head. Existing freshness/expiry
eligibility remains authoritative when the database cannot publish the failure.
The fallback removes only this source's current news/evidence/receipt, keeps the
same slot asOf, and preserves unrelated sources and immutable history.

Add an isolated PostgreSQL test that holds the head lock until after the deadline,
then verifies no successful snapshot or slot was committed by the denied write;
the scheduler publishes exactly one ERROR head and slot, without another provider
request. Test that an ordinary storage error propagates without a second store
attempt. Do not use the operational database or the F1 validation database.

Successful matching passes emit AVAILABLE when the actual closed coverage window
contains news and EMPTY only when it contains none. Both receive complete=true
only after integrated validation. The unchanged reports/calendar/identity/AI
eligibility checks still decide whether an entry can proceed.

## 6. Exact implementation scope and task packets

Integrate shared contracts first, then assign disjoint file ownership. No migration,
strategy, execution risk, broker write, model prompt or trading-control change.

| Task | Owned paths | Route and obligations |
| --- | --- | --- |
| E1b-A | `packages/shared/src/instrument-research/marketaux.ts`, `types.ts`, `validation.ts`, `eligibility.ts`, `eligibility.test.ts`, their new/appropriate tests, public barrel exports | Astra/high: manifest, request descriptor and receipt validation, qualification/entitlement expiry at eligibility; preserve old shapes and fail-closed invariants |
| E1b-B | `apps/llm-agent/src/research-marketaux.ts`, `research-marketaux.test.ts` | Luna/medium only after A's accepted interfaces: pure page mapping, window membership and two-pass consistency helper, no IO or policy defaults |
| E1b-C | `apps/llm-agent/src/research-marketaux-fetch.ts`, its tests, `research-fetch.ts`, `research-refresh.ts`, `research-marketaux-refresh.test.ts`, `index.ts` | Astra/high: bounded secret-isolated transport, budgeted acquisition, production scheduler wiring and atomic failure behavior |
| E1b-expiry tests | `apps/llm-agent/src/research-review.pg-integration.test.ts`, `apps/execution-engine/src/research-entry-guard.pg-integration.test.ts` | Lead Astra/high after A: expiry between acquisition, AI review and final binding; tests only, no execution runtime changes |
| E1b-publication deadline | `packages/shared/src/instrument-research/store.ts`, new `apps/llm-agent/src/research-marketaux.pg-integration.test.ts` | Astra/high after supplemental review: optional transactional publication deadline and isolated lock-wait/ERROR tests |
| E1b-D | `config/research/paper.example.json`, this contract and closure report/runbook references | Lead: disabled examples, qualification instructions and actual remaining blockers |

Workers read AGENTS.md, this accepted contract and named callers/tests before
editing. No .env reads, credentials in fixtures, provider/broker calls, deployment,
staging or publication in worker tasks. Escalate undefined critical semantics,
changed shared contracts, inability to preserve restart idempotency or missing
permission/entitlement evidence; never relax acceptance to pass a test. One failed
bounded Luna repair escalates to the lead. Return exact changed paths, commands,
exit codes, findings, requested/actual model/effort, repair count, elapsed time and
available token evidence. Lead publishes only after independent final review.

## 7. Acceptance and validation

1. Production scheduler + real adapter/transport boundary with injected HTTP
   fixtures publishes valid nonempty news across several pages and passes; a
   third issuer works by configuration. Zero-result and margin-only successful
   queries produce EMPTY with two complete receipts. No manually declared
   coverage envelope is used as provider input.
2. Wrong issuer tuple, null-exchange mismatch, unknown mapping, altered bounds,
   wrong content type, bad dates/microseconds, duplicate UUID, invalid count/page,
   short/full-page errors, >limits, count insertion, same-count substitution and
   changed record reject. Correct out-of-order same-time articles remain valid.
3. Test inclusive/exclusive margins, UTC/day/DST transitions, frozen slot asOf,
   changing wall clock, acquisition timeout, byte/row/snapshot ceilings and
   current coverage freshness. Never claim completion-time coverage. Prove expiry
   of either qualification between pages, between reservation and request, and
   immediately before publication stops acquisition and denies success. Verify
   all deadlines are capped by both expiries, spent reservations are retained,
   and receipt-induced final snapshot overflow publishes ERROR. A failed refresh
   completing across a slot boundary retains its own slot-derived checkedAt.
4. Test redirect/private DNS/mixed public-private DNS and rebind resistance,
   alternate hosts/paths/queries, unknown source kinds, malicious publisher links,
   missing key and token-containing injected/native errors. Assert secrets never
   occur in durable hashes, receipts, logs, outcomes or snapshot reasons.
5. Two refresh workers, two issuers, process restart, crash before/after reservation,
   exhausted request/cost budget on any pass/page, and unknown transport outcomes
   prove one durable reservation before each request and no same-slot retry.
   Use isolated PostgreSQL integration for locks/counters/restart behavior.
6. Existing SEC/PDF/declared-evidence/calendar, immutable snapshot/binding,
   eligibility and per-proposal AI-call tests stay green. The disabled example
   has refresh=false, zero source/model spending limits and no invented VERIFIED
   operational evidence. A configured news source never satisfies calendar.
7. A previously valid stored snapshot becomes ineligible at either qualification
   expiry during AI review and final binding validation, despite its news still
   being fresh. Assert the exact minimum ResearchEligibility.expiresAt, the
   equality boundary, future-dated qualification, and readable historical
   manifest/snapshot decoding after expiry. Extend the existing research review
   and execution research-binding test files only for these integration cases;
   runtime implementation remains in the shared eligibility path.

Run targeted native-runner tests during implementation, then `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` on isolated PostgreSQL and
`pnpm build`. Run a clean Docker build if runtime/deployment inputs change.
No strategy backtest is needed for unchanged strategy/simulator behavior. Record
independent plan acceptance, a different Astra/high hostile implementation review,
repairs and all checks in the package report; commit/push the reviewed scope on
main and verify GitHub CI for that exact SHA. Fixture success proves code behavior;
owner-plan/entity/permission qualification and actual source receipts are separate
Gate A evidence.

## 8. Calendar remains a distinct E1 prerequisite

This package does not invent an issuer calendar JSON feed. The public PKO news
listing and investor calendar are promising acquisition sources but need an
independent completeness/publication/occurrence contract. The prior source audit
found a 2026-10-14 extraordinary meeting in current report 32/2026 published
2026-09-10 that was absent from the investor calendar; that calendar alone cannot
establish the complete material-event horizon. Apple IR access returned 403 in
the prior audit and no exhaustive calendar was qualified. Marketaux news metadata
does not resolve either gap. Do not bypass access controls or mark calendar EMPTY
based on missing or inaccessible source data. Gate A remains blocked until actual
calendar sources and their integrated positive/hostile tests are accepted.
