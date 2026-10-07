# PP7 E1b implementation: actual paginated Marketaux news

2026-10-07. Status: **targeted checks and independent hostile implementation/document
review and full local repository checks passed; published source CI failed in F1
integration setup; fixture repair passed all local checks, follow-up CI pending**. This is code
evidence, not real-source qualification or Paper launch acceptance.
The [contract](PP7_NEWS_FEED_CONTRACT.md) and
[operator runbook](../../runbooks/PAPER_RESEARCH_NEWS.md) define scope and operation.

## Implemented result

The explicit `marketaux-news` adapter now acquires actual Marketaux-shaped pages
through the existing research scheduler, durable call budget and immutable
snapshot path. It checks issuer identity, exact query authority, fixed UTC windows,
page counts, duplicate UUIDs and matching record sets across two complete passes.
Failures publish current-source ERROR with no partial news; historical and
unrelated-source evidence remains. EMPTY requires two successful complete reads.

The manifest includes bounded entity/entitlement qualification and expiry, while
the strict snapshot schema includes credential-free acquisition receipts. Expiry
is checked before each reservation/request, after acquisition and at publication;
shared eligibility carries both expiry deadlines into AI and final persisted
binding validation. Historical decoding stays independent of the current clock.
An optional store admission deadline is checked after database locks and by the
conditional INSERT, so an expired successful write rolls back before changing
the head/slot. Only this explicit expiry triggers the ERROR publication fallback;
ordinary database errors propagate without a publication retry.

The API token remains private to HTTPS transport. Existing DNS/public-address
validation, pinned lookup, no redirects, timeouts and response limits are reused.
Errors use fixed safe codes. Publisher URLs cannot expand fetch authority; the
snapshot keeps the exact source URL and UUID reference. No full article content
is retained. The legacy MarketAuxClient and its consumers remain unchanged.

PKO/AAPL examples now contain the actual adapter structure with UNVERIFIED
qualification, explicit unknown PKO symbol, zero spending caps and refresh=false.
The original calendar blocker remains. No strategy, model prompt, execution runtime,
broker action, deployment or activation changed. E1a's financial mappings were
preserved; its contemporaneous PDF cleanup repair belongs to the lead's package.

## Targeted evidence

All commands below completed with exit code 0 in the author or independent review
run after the documented repairs. PostgreSQL tests used the lead-provided isolated validation service and
created/dropped only randomly named disposable databases. No operational database,
real Marketaux credential, paid provider request or broker connection was used.

| Check | Command/scope | Result |
| --- | --- | --- |
| Shared build | `pnpm --filter @ikbr/shared build` | Passed |
| Shared source and expiry regression | `pnpm --filter @ikbr/shared exec node --import tsx --test src/instrument-research/marketaux.test.ts src/instrument-research/eligibility.test.ts` | 16 passed |
| LLM type check | `pnpm --filter @ikbr/llm-agent typecheck` | Passed |
| LLM source/transport/refresh regression | `pnpm --filter @ikbr/llm-agent exec node --import tsx --test src/research-marketaux.test.ts src/research-marketaux-fetch.test.ts src/research-marketaux-refresh.test.ts src/research-refresh.test.ts src/research-providers.test.ts` | 37 passed; author and independent reviewer |
| Isolated source and AI integration | With isolated `TEST_POSTGRES_URL`: `pnpm --filter @ikbr/llm-agent exec node --import tsx --test src/research-marketaux.pg-integration.test.ts src/research-review.pg-integration.test.ts` | 16 passed, no skips; independent reviewer after repair; author separately passed all 9 new cases |
| Existing final execution admission regression | With isolated `TEST_POSTGRES_URL`: `pnpm --filter @ikbr/execution-engine exec node --import tsx --test src/research-entry-guard.pg-integration.test.ts` | 3 passed, no skips |
| Scoped ESLint | New Marketaux modules/tests plus edited shared research and llm index/fetch/refresh files | Passed, repaired paths rechecked |
| Local artifact validation | 21 owned paths exist, relative document links resolve, scoped `git diff --check` | Passed |

The positive integrated test runs the scheduler, real credential transport and
mapper through injected HTTPS responses for a third configured synthetic issuer.
Other hostile tests cover count/UUID/content drift, duplicates across pages,
microsecond boundary membership, invalid timestamps/entity tuples, HTTP quota,
redirects, malformed content, secret-bearing errors, byte/time/snapshot overflow,
missing credentials, denied qualification and exact expiry boundaries.
The remaining cumulative byte allowance now reaches the HTTPS streaming limiter:
two 8MiB responses leave only 4MiB for the next response, which aborts on the first
chunk that would exceed its remaining buffer allowance. Two 10MiB responses deny
another request before reservation. The rejected chunk is not buffered or parsed;
transport chunk arrival is not a guarantee about bytes already received by the OS.

PostgreSQL evidence covers concurrent workers, completed-slot restart, two-issuer
provider/account budgets, persisted UNKNOWN reservation without replay, and a
head-lock wait until after the publication admission deadline. That last case
leaves exactly the original snapshot plus one ERROR head/slot and makes no further
provider request. For both entity qualification and entitlement expiry, integration
binds valid research and reserves the model once. It exercises actual
`finalize(EXECUTE)` denial after expiry and, separately, successful approval plus
`createResearchEntryValidator` before expiry, an expiry-capped permit, and actual
entry-validator rejection after expiry. News is still within its freshness window
and the historical snapshot remains readable. Existing execution admission
integration also passed; no concurrent execution-engine source file was edited.

## Review, repairs and ownership

Requested and actual implementation route: `gpt-6-astra` / `high`, sole E1b author.
The core plan was accepted by independent Astra/high `audit_lifecycle_ops` after
one blocking expiry/eligibility finding was repaired. A separately discovered
database lock-wait publication race received the bounded section-5 amendment;
independent Astra/high `review_e1a_implementation` accepted it before store edits.
The final E1b implementation reviewer is independent `review_e1b_final`, requested
and dispatched `gpt-6-astra` / `high`, distinct from both plan reviewers and the
author. Token usage is unavailable. Its two findings were repaired in one review
round: exercise the actual AI finalization/execution permit callers for both
expiry types, and enforce remaining cumulative bytes inside the streaming
transport rather than after buffering a full response. Both repairs were accepted
on source review; independent reruns passed 37 LLM tests, 16 shared tests and 16
PostgreSQL tests without skips. Its final typecheck, document links and scoped
whitespace checks passed. Final implementation and document review accepted all
21 paths with no remaining blocking finding.

Three failed implementation-check repair cycles were completed: TypeScript's
never-return narrowing needed a function declaration; the first AI integration
fixture needed normal strategy snapshot registration; and the two-issuer budget
assertion initially enumerated unrelated unrefreshed fixture instruments. Each
was repaired and its check rerun successfully. The first local PostgreSQL attempt
was denied by the filesystem/network sandbox; the authorized isolated rerun used
approved escalation. No functional acceptance condition or safety check was weakened.
There was one plan repair and one reviewed scope amendment; no model downgrade or
failed lower-tier repair escalation occurred. Available token usage: unavailable.
Measured implementation wall time from the first runtime file creation at
2026-10-07 06:40:29 UTC through final repair checks at 08:06:22 UTC is 85 minutes
53 seconds. This excludes the earlier planning work and later publication; no
token savings percentage or model quality claim is made.

The private path manifest is
`backups/pp7-closure-2026-10-06/e1b-paths.json`: 21 reviewed-scope candidate paths,
excluding F1, E1a lead-owned files and unrelated ES/backtest work. The manifest is
an ownership aid, not blanket permission to stage the dirty workspace. No files
were staged or committed by this implementation author.

## Combined release validation

The clean candidate overlays reviewed F1/E1b paths on
`bc5d6d62b825ee69d8862142401f91badb5b07ff`, excluding 25 unrelated dirty paths.
`pnpm lint` passed with two pre-existing warnings; `pnpm typecheck` and
`pnpm build` passed. Full host `pnpm test` passed 3019 tests with 143
PostgreSQL-dependent skips and zero failures. The first clean Docker build passed.
The first full isolated integration run found a stale F1 migration expectation
in the PP1 upgrade regression; the independently accepted one-line repair adds
migration 27 while retaining every legacy-state preservation assertion. Full
integration passed after that test-only repair: 2459 cases, zero skips/failures,
276.100 seconds. The no-cache Docker rebuild also passed in 25.704 seconds,
image `ikbr-trader:pp7-closure-verify`.
Complete outputs are saved in `/private/tmp/pp7-closure-final-*.log`.

Source was published as `ddffe1009dae4b5a7d67bb4a0ad86c6d7705c56d`. Its
[CI run](https://github.com/dwojtyca/ikbr-trader/actions/runs/37598003618) passed
lint/typecheck/unit tests but failed integration. A deterministic F1 database-name
fixture defect was reproduced; the accepted repair and successful CI-shaped
local validation are
recorded in the [F1 report](PP7_F1_IMPLEMENTATION_REPORT.md). E1b source is unchanged. The final eight-document
review accepted the narrative, all local links and scoped whitespace; all 25
pre-existing file hashes remain unchanged. Mechanical
verification uses `gpt-6-luna`/low because requested `gpt-5.6-luna`/low is unavailable
in the exposed subagent list. Runtime model/token telemetry is unavailable. No
runtime dependencies or deployment inputs were changed by E1b.
No strategy/simulator behavior changed, so no new strategy backtest is claimed.

Operational PKO/AAPL provider entities, actual plan and owner-approved daily/cost
allocation, API private-use/retention review and real acquisition receipts remain
unverified. Two passes at the unchanged cadence require at least 192 requests per
issuer/day; the publicly advertised Free 100/day allowance is insufficient for
full-day operation. No subscription or budget was silently increased. Mandatory
calendar coverage, production-shaped model generation and the remaining Paper Gates A–D remain
separate unresolved prerequisites. A read-only metadata lookup for the configured
`gpt-5.4` returned HTTP 200 on 2026-10-07; it did not make a generation request
or prove generation credit or latency. Do not report E1 or PP7 fully complete from
this package's fixture evidence.
