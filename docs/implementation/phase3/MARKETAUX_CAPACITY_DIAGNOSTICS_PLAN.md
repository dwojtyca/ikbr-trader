# Marketaux local capacity failure diagnostics

Status: ACCEPTED by independent Astra/high reviewer stale_alert_plan_review after one clarification round. Implementation is a separate
follow-up after the active completed-order diagnostics release. Requested route:
Astra/high for critical source-evidence semantics and independent review. No provider,
broker or Telegram calls, operating configuration changes or paid upgrade are
part of this plan.

## Evidence and bounded objective

The owner confirms the free entitlement: 100 requests/day and three articles per
response. The current observed source bound is 30 articles / ten pages. In
`research-marketaux.ts`, parseMarketauxPage rejects a valid integer meta.found
above maxArticles or the page ceiling before returning the parsed page. The
negative snapshot retains RESEARCH_MARKETAUX_RESULT_LIMIT but loses that observed
count, because captureResearchSourceError deliberately treats bare internal reason
strings as unavailable external detail. The count is already present in the normal
response; another provider call is unnecessary to preserve it on a future ordinary
acquisition. A synthetic local reproduction accepts found=30, rejects found=31 at
3×10, and accepts the first page at 3×11/maxArticles33. It does not prove that an
actual complete acquisition or daily workload fits the free entitlement.

Preserve this missing local diagnostic without changing whether any research is
eligible. No pagination, duplicate request or polling bug was established by the
read-only audit. The separate capacity and product decisions remain unresolved.

## Implementation contract

Preserve the existing validation order exactly: safe-integer numeric metadata
checks, then RESULT_LIMIT, then later limit/page/data-length consistency checks.
Do not move or reclassify any branch to obtain diagnostic details. The observed
found value is a validated provider-reported numeric claim, not certified
completeness or independently verified inventory.

At the existing result-limit branch, after validating numeric metadata, retain only
safe observed/configured scalars: found, pageSize, requiredPages, maxPagesPerPass,
maxArticles, current pass and page, and the stable local bound(s) exceeded. Emit configured/request details, including pass and page, only after checking
finite safe integer values or the explicitly allowlisted pass enum. Never
interpolate arbitrary runtime configuration strings. Omit unavailable or invalid
diagnostic fields without changing the original failure reason or control flow.
Do not persist records, entities, URLs, credentials or response bodies. Do not infer an
actual count from an older error that omitted it.

Use the existing ResearchSourceFailure/captureResearchSourceError path with the
unchanged outer reason RESEARCH_MARKETAUX_RESULT_LIMIT and an explicitly named
local capacity-validation error. Its bounded diagnostic message contains the
validated scalars and clearly distinguishes provider-reported count from local
limits. The error is an actual local validation failure, not a fabricated provider
error: HTTP status, providerCode/providerMessage and unavailable provider error
details remain absent. Do not append text to the outer reason, which the existing
sanitizer allowlists exactly. Retain existing sanitization and snapshot validation;
no schema or database migration is necessary. Unexpected/unvalidated metadata
continues through its existing failure path without invented count details.

The existing scheduler must persist this cause in the ordinary incomplete ERROR
snapshot, with no partial news or acquisition receipts and no extra HTTP request.
A successful HTTP response still records the existing SUCCEEDED call outcome even
when subsequent local parsing produces ERROR coverage; do not rewrite that ledger
outcome as a provider failure.
Complete coverage, two passes, 24-hour window, thirty-minute freshness, fifteen-minute
slots, demand mode, repair/HOLD classification, reservation/call identities, provider
budget and AI/entry eligibility remain unchanged. A result-limit hold remains a
hold; this plan does not rearm it or authorize a diagnostic fetch. Deployment alone
may therefore produce no new count until an independently authorized ordinary
acquisition occurs. Report that evidence gap honestly.

## Files, acceptance and release

Permitted implementation: `apps/llm-agent/src/research-marketaux.ts` and its direct
parser/refresh tests. Change research-refresh.ts only if existing error propagation
cannot preserve the typed local cause; do not modify shared eligibility, budgets,
configuration or schemas. The existing shared ResearchSourceFailure helper should
suffice; any broader contract change requires amendment and review.

Tests must prove found30 boundary behavior and found31 diagnostics at size3/cap10,
each applicable result-bound branch, unchanged outer reason, named local cause,
no fake HTTP/provider error, no raw data/secret leakage, and unchanged successful
parsing. A fake-transport scheduler test must show exactly one ordinary request and
reservation for a first-page overflow, ERROR/complete=false with no partial news,
recorded local details, and the same resulting HOLD. Malformed/noninteger metadata caught by the existing pre-limit numeric checks
must retain its existing failure classification and must not generate trusted
capacity details. Test invalid diagnostic-only fields without moving later
limit/page/data checks ahead of RESULT_LIMIT. Assert that successful HTTP followed
by local overflow retains SUCCEEDED in the call ledger while coverage is ERROR. No test may call a real provider.

Independent critical plan acceptance precedes implementation; a different
independent Astra/high reviewer accepts implementation. Run focused parser/refresh
and shared error/eligibility tests plus required lint, typecheck, unit tests,
isolated PostgreSQL integration tests and build. Deployment requires a clean Docker
build. Report scoped commit, exact-commit CI, deployment and any later ordinary-fetch
evidence separately. Keep entries paused according to the existing owner/lead
operating decision; diagnostic publication grants no entry permission.
