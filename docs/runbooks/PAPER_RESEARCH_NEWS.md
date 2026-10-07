# Paper research: Marketaux news qualification and operation

Updated 2026-10-07: the [WSH context contract](RESEARCH_CONTEXT_WSH.md) adds V2
news descriptions, snippets and matched-issuer sentiment for AI adjudication.
Calendar proximity is context, not an automatic entry veto; WSH is the sole
calendar source and does not require an additional issuer-confirmation feed.

This runbook describes the E1b news implementation under the
[accepted contract](../implementation/phase3/PP7_NEWS_FEED_CONTRACT.md).
The [implementation report](../implementation/phase3/PP7_E1B_IMPLEMENTATION_REPORT.md)
separates code verification from real-source qualification. This source alone does
not enable trading or complete the mandatory calendar/report/model prerequisites.

## Configuration and credentials

The existing secret key is `LLM_AGENT_MARKETAUX_API_KEY`, supplied through `.env`
to llm-agent. Do not put its value in a source URL, manifest, receipt, terminal
transcript or committed file. Authentication is added only inside the bounded
HTTPS transport; acquisition identity and persisted URLs contain no API token.
No new dependency, provider client or credential is required for this adapter.

Start from [paper.example.json](../../config/research/paper.example.json). Both
initial issuers have an explicit `marketaux-news` source and
`marketaux-news-v1` parser. The example deliberately has refresh disabled,
UNVERIFIED identity/entitlement/permission, and zero request/cost budgets. Its
three-article page size is an unqualified example, not evidence of the owner's
subscription. The PKO provider symbol is an explicit placeholder. AAPL is also
unqualified. Do not turn these fields into VERIFIED merely because a key exists.

Research remains under its existing manifest loading/adoption and account guard:
`RESEARCH_BUDGET_ACCOUNT_ID` must identify an account in the explicit environment
allowlist. Adopt a reviewed immutable manifest with writes disabled according to
the existing research/deployment procedure. Manifest changes invalidate prior
mapping/binding identity; key rotation alone does not refund durable calls.

## Qualify the source without guessing

1. Verify the actual subscribed API plan and owner-approved daily request/cost
   allocation. Include other consumers of that subscription. Consult the
   [published API](https://www.marketaux.com/documentation),
   [pricing](https://www.marketaux.com/pricing) and
   [terms](https://www.marketaux.com/tos) for the intended private Paper use.
   The deliberately offered API and applicable terms are assessed together;
   this runbook imposes no automatic extra written-permission requirement.
2. Within the existing explicitly authorized read-only budget, qualify the entity
   using provider entity-search evidence. Bind the exact symbol, name, equity
   type, exchange country and actual exchange value, including a legitimate null,
   to the issuer identifier and IBKR conId. A symbol match alone is insufficient.
   Do not guess a PKO exchange suffix, substitute a similarly named issuer or
   generalize Apple evidence to another listing.
3. Keep a private nonsecret qualification receipt recording the observed entity,
   issuer/listing crosswalk, actual plan limits, reviewed API/retention permission
   and dated evidence. Hash that receipt and reference its credential-free
   evidence URL in the manifest. Record explicit verification and expiry times.
   These are reviewed operator assertions, not provider-signed attestations.
4. Set actual page and request/cost bounds no higher than the qualified allowance.
   The source permits only news, one exact canonical query URL and verified
   FACTS_AND_REFERENCES retention. Requalify when entity, plan, permissions or
   listing change, and before expiry. Keep entries disabled until every separate
   operational gate has passed.

The scheduled adapter never performs entity-search probes, subscription discovery,
publisher-page requests, or retries in response to unknown outcomes. Diagnostics
are read-only and cannot spend provider or model calls. Source qualification does
not authorize a new paid subscription or any broker action.

## Budget the actual cadence

The news slot remains fifteen minutes. Each complete acquisition reads every page
twice, including an empty result: at least 2 ×96 = **192 calls per issuer per full
day**, or **384 for PKO plus AAPL**, before additional pages. With a stable P-page
result in each slot, the daily count is 192 ×P per issuer. Counts can vary by slot;
the configured page cap is a ceiling, not a forecast of demand.

Marketaux's pricing page advertised Free at 100 requests/day and three articles
per request when reviewed on 2026-10-06 UTC. That allowance cannot sustain the
unchanged full-day cadence even for one issuer. This is a capacity fact, not an
upgrade instruction. No session-only refresh schedule is added by E1b.

The durable ledger pools both issuers under the configured account/provider key,
using the most conservative caps of sources sharing that provider and reserving
cost before every page. It is not an account-wide Marketaux billing meter: other
applications, legacy clients or another configured account using the same API key
can consume the subscription quota outside this ledger. Allocate headroom rather
than treating locally unused reservations as proof of provider quota remaining.
Failure, timeout, HTTP 429 and restart do not refund reservations or trigger retries.

## Interpret source state and receipts

AVAILABLE means two complete bounded provider-query traversals yielded the same
UUID/record set and retained in-window news. EMPTY means both traversals succeeded
and no records belonged to the closed 24-hour window; it still has page receipts.
Neither status claims an atomic provider snapshot, complete world news, or absence
of later indexing/backfill. The window ends one second before the fifteen-minute
slot boundary, preserving a stable request identity across restart. Completion
time never extends the claimed coverage window.

UNVERIFIED indicates permission, qualification or configured capacity is not
available. ERROR covers failed attempted acquisition, incomplete or changed pages,
quota/budget exhaustion, malformed identity/data, deadline expiry or bounded-size
overflow. The latest snapshot removes that source's partial news and carries the
failure; unrelated sources and immutable historical snapshots remain. An ordinary
database failure propagates and is not described as a successfully published ERROR.

Receipts retain credential-free request identity, page counts, actual response
hashes and times. Article evidence points to the allowlisted provider query and a
`marketaux:<uuid>` document ID. Publisher URLs affect the consistency digest but
are not clickable snapshot links or network authorization. V1 retains title-only
news. V2 additionally retains bounded provider descriptions/snippets and optional
matched-issuer sentiment in the immutable AI context. Full article bodies,
highlights and images are not retained.

Qualification and entitlement expiry cap requests and transactional publication.
They also cap stored research eligibility, AI preparation and final binding even
while the news freshness interval has not elapsed. Historical evidence remains
readable after expiry. Do not repair a hold by editing historical snapshots,
deleting reservations or fabricating an EMPTY result.

## Remaining launch gates

PKO/AAPL entity and plan qualification must be evidenced privately before real
provider operation. A valid configured WSH query supplies the required calendar
context; neither WSH nor Marketaux claims exhaustive real-world coverage. The
earlier issuer-page calendar audit is not an additional launch prerequisite.
Report extraction, model access/budgets, broker accounting, risk, alerts and the
supervised Paper acceptance gates remain separate requirements. See the
[closure plan](../implementation/phase3/PP7_CLOSURE_PLAN.md) and
[Paper production acceptance runbook](PRODUCTION_PAPER_ACCEPTANCE.md).
