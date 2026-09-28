# PP3 implementation report

Date: 2026-09-28. Status: source and documentation accepted by independent review; all required local
checks passed. Main publication and exact-commit CI pending. This source package is not an operational deployment
or broker-readiness claim. No trading, real broker/provider calls or PP4 work was performed.

## Baseline and contract

PP3-A and dependent PP3-B extend `main` at
`fab78cab89dacdd286f7d9029056354e109c53f2`. The baseline's
[exact CI run](https://github.com/dwojtyca/ikbr-trader/actions/runs/36458266432)
was independently rechecked as successful through the public GitHub API.
The [accepted plan](PP3_IMPLEMENTATION_PLAN.md) refines
[delivery §7](PAPER_PRODUCTION_DELIVERY_PLAN.md#7-pp3--generic-bounded-stock-execution-and-evidence),
reusing [PP1 configuration](PP1_CONFIGURATION_CONTRACT.md) and
[PP2 identity/runtime](PP2_RUNTIME_CONTRACT.md). Their reports and actual callers,
immutable snapshots, migrations and v2 proposal guards were inspected before work.
PP1 canonical bytes/version and PP2 original attribution stay unchanged.

Twenty-five unrelated dirty paths were recorded with SHA-256, including ES
research/simulator and legacy SignalEngine work. A clean candidate was exported
from the baseline and overlaid only with PP3 files; it excludes those local edits.
The inventory is rechecked before publication; staging uses explicit reviewed paths.

## Delivered mechanisms

Common stock capability validates exact broker, asset class, conId, route, primary
listing, quote currency, session timezone, symbol/localSymbol and tradingClass.
Supported combinations are WSE/WSE/PLN/Europe-Warsaw and SMART with
NASDAQ/NYSE/AMEX, USD and America-New-York. Currency alone does not infer venue.
Metadata must independently match the binding and include route-selected market
rule bands, exact fresh session coverage and on-grid prices. Entry is one whole
long share, LMT/DAY with TP/SL bracket; close remains the existing audited one-share
SELL LMT workflow. Unsupported asset/quantity/order shapes fail closed.

The existing metadata socket is reused; no unsupported execution-adapter API was
invented. Current BBO, metadata/session and risk deadlines are enforced before send.
Prepared metadata is pinned against mutation. Original proposal snapshots supply
management after assignment removal/disablement; startup independently verifies
attributed history and preserves ingestion monitoring without requiring a fabricated
legacy snapshot. A proposal-scoped resolver avoids conflicting retained policies.
Historical PKO/AAPL adapters remain only for their original unattributed management
and report compatibility.

`PAPER_RUN_POLICY_JSON` supplies explicit immutable run identity, exact loaded hash,
windows of at most 60 minutes with a verified 15-minute exit margin and finite
PLN/USD caps. Generic policy is `supervised_one_attempt`: one attempt/account/Warsaw
day, one attempt/stable broker+conId/session day. One active bot intent/position
also blocks across dates. The future `bounded_scheduled` transition is specified
and rejected with `PP5_LIFECYCLE_REQUIRED`; it cannot loosen an already consumed
day. No timezone/run/config/revision change resets counts.

Migration 19 imports consumed legacy windows and attempted entries, deduplicates
by proposal, preserves differing old charged dates as conservative debts and stores
immutable account/global holds for ambiguous identity. Atomic account-first
reservation persists the attempt and broker links before submission. Unknown or
crashed dispatch consumes permanently. Triggers prevent deletion, relabelling,
mutation and stale legacy writers after adoption. First adoption requires disabled
writes; compatible existing adoption permits restart without reimporting or resetting.
A run's contents are pinned even before its first proposal.

Account-wide prior ownership is checked independently of a proposal's status/date.
Only proven final round-trip state with complete accounting, or independently proven
terminal zero-fill bracket state, can release the active ownership hold. The latter
is not a completed round trip and does not refund the consumed budget. Foreign
manual exposure remains subject to account risk/reconciliation and is reported.

Daily-loss evidence requires independently certified complete Warsaw-day coverage,
matching broker and persisted typed fills/fees, exact generations and an immutable
accounting fingerprint. Every configured currency cap must pass, with conservative
loss-plus-positive-fee debits and no gains/FX netting. Fingerprints are rechecked
under lock; a final synchronous fence catches fill/commission events during awaited
validation. Later unavailable/sentinel corrections replace earlier known economics
with unknown, rather than inheriting stale values. Close-risk deadlines are enforced
after context waits and immediately before the broker call.

The generic round-trip evaluator now requires matching STK/currency evidence and
reports original hashes/attribution, run/policy/attempt/date identity, AI/risk,
broker legs, close operation, typed fills, commission completeness and gross/net
P&L. Legacy aliases remain. PP3-B is a pure formatter exposed through the existing
route's `?format=markdown`; default JSON remains compatible with PP2's consumer.
See [Paper policy runbook](../../runbooks/PAPER_EXECUTION_POLICY.md).

## Independent reviews and repairs

Astra/high plan review first required a precise daily-loss completeness, currency,
correction and dispatch-race contract (one P1). The lead added §3.1 and the
independent plan reviewer accepted before implementation. That reviewer authored
no code. A different Astra/high reviewer examined the integrated implementation.

Its first pass required five P1 and three P2 repairs:

1. Final awaited identity validation could admit an interleaved fill/fee event.
   Added the final synchronous observation/deadline fence and an injected PG race.
2. Conflicting/FUT typed evidence could falsely complete a stock report.
   Required matching STK and currency on broker and persisted records.
3. Removed/disabled generic ownership could fail restart via legacy-only registration.
   Registration now verifies original v2 snapshot/hash and retains scoped monitoring.
4. Close's risk/BBO deadline was absent at final synchronous submission.
   Persisted expiry now propagates through service, claim and both dispatch checks.
5. A missing/sentinel commission correction could retain old numeric P&L.
   Latest unavailable economics replace previous values and invalidate the fingerprint.
6. Already adopted accounts could not restart with writes enabled.
   Initial disabled adoption is separated from immutable compatible restart checks.
7. The audit DTO lacked original risk, broker legs and close references.
   Both JSON and pure Markdown presentation now include them.
8. Proven terminal zero-fill attempts could block active ownership indefinitely.
   Added independent exact terminal-bracket proof without refunding a daily attempt.

A second review pass found one residual P1: deduplication could hide an earlier
conflicting broker type/currency for the same execution ID. Every raw target record
now passes the typed check before deduplication; both ordering permutations for
type and currency have regression tests. The 79-check evaluator/terminal suite passes.

Final source/document re-review accepted all repairs, including the terminal-zero-fill
clarification, conditional on the remaining full-check and publication gates. The
reviewer independently passed 99 focused checks and then 79 evaluator/terminal checks,
verified local links/diff and all 25 baseline hashes, and authored no implementation.

## Acceptance evidence

Focused checks before the final integrated suites:

- Generic capability/risk/TWS/close/report fixtures exercise PKO, AAPL and a third
  stock absent from source registry, all through common paths. ETF/FUT, unsupported
  quantity/FX/venue, wrong identity/grid and stale metadata/session/deadline reject.
- Policy/budget: 22 checks pass, including real PG simultaneous contracts, crash/
  replay, stale writer exclusion, migration debt/holds, manifest identity, disabled
  adoption and enabled restart, Warsaw/New York day boundaries/DST and transition.
- Original-attribution registration/restart: 11 PG checks pass, including removed/
  disabled third-stock assignments with and without legacy source and hash conflicts.
- Repository integration: 17 PG checks pass, including all three configured stocks,
  final reservation/dispatch, competing intents, prior-day FILLED ownership, unknown
  restart without resend, post-risk corrections and interleaved observation races.
- Daily-loss evidence: 8 unit checks pass; zero-fill terminal release: 2 pass;
  formatter: 4 pass. These use injected accounting/broker evidence, not real coverage.
- Capability-worker repair suites: 167 focused checks and 509 shared checks pass.

A host/Colima clock discrepancy tripped an existing lifecycle fixture's 100ms
future-timestamp guard during targeted PG tests. The guard was retained. Final
integration runs application and isolated PostgreSQL16 inside the same Colima VM.
The first full run also exposed outdated positive legacy fixtures lacking complete
listing identity, an invalid rather than closed session fixture, the migration list
missing 19 and one diagnostic test still treating PP4 as a nonignored blocker.
Those fixtures were corrected, their original failure/concurrency assertions retained,
and the three affected PG suites passed 115/115 inside Docker. Independent review
accepted these test-only deltas and the frozen candidate. A later full integration
run passed execution (1,566) and backtest (18), then exposed old LLM fixture
`TRUNCATE ... CASCADE` against the new immutable budget tables. Those two suites
now recreate their own disposable database per test instead of truncating protected
state. The independent reviewer accepted this isolation-only delta; production
triggers and assertions remain unchanged. The final candidate contains 78 paths. The fixture
clock wait now handles early timer wakeups while retaining its 100ms skew guard.
The definitive checks below supersede the unsuccessful/interrupted earlier runs.
No destructive fixture uses an operational database. No strategy/simulator behavior
changed; additional strategy backtests are not applicable. Existing configured
replay regression tests remain part of the full suite.

| Required check | Result |
| --- | --- |
| `pnpm lint` | PASS; 0 errors, 2 existing warnings |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 2,717 passed, 92 skipped with test DB variables unset |
| `pnpm test:integration` on isolated PostgreSQL16 | PASS; 2,232 passed, 0 skipped/failed, VM-local runner |
| `pnpm build` | PASS |
| Clean `docker build --no-cache` | PASS; complete image build on isolated Colima profile |
| Independent final hostile/document review | PASS; two repair rounds, final source/document verification clean |
| Scoped diff / unrelated hash preservation | PASS; 78 reviewed paths, 25 unrelated file hashes unchanged; explicit staging only |
| Main commit/push and exact-commit CI | Pending |

Validation used Node 24.4.1 / pnpm 9.5.0 on the host and Node 24.20.0 in the
clean Docker image. Integration used only isolated PostgreSQL16 on
`colima-pp1-verification`, with the runner and DB sharing the VM clock.
Final image: `sha256:3a2a1a9106a313e42f0eba3c9717f436122cbcb65c42b42fdc7f32863e41e2c0`.
The final command logs are local `/private/tmp/pp3-delivery/final-*.log`; status
files preserve each actual exit code. Full integration includes 1,566 execution,
18 backtest, 13 LLM, 111 ingestion and 524 signal checks. All passed.

## Routing and cost evidence

| Task | Requested / dispatched model and effort | Repairs/escalations | Evidence / elapsed / tokens |
| --- | --- | --- | --- |
| Lead critical contract/integration | Capable lead; exact runtime telemetry unavailable | Plan clarification + review repairs; no semantic downgrade | Final integrated checks below; elapsed/tokens unavailable per role |
| Independent plan review | `gpt-6-astra` / `high` | One P1 clarification, then accepted; no implementation | Separate plan reviewer; elapsed/tokens unavailable |
| PP3-A capability/close/identity | `gpt-6-astra` / `high` | One integrated review repair pass; no model escalation | Focused/PG evidence above; elapsed/tokens unavailable |
| PP3-A policy/budget/migration | `gpt-6-astra` / `high` | Targeted SQL/date fixture repairs; one review restart repair; no model escalation | 22 focused checks; elapsed/tokens unavailable |
| PP3-B pure formatter | `gpt-6-luna` / `medium` | No worker repair/escalation; A integrated later audit fields | 4 focused checks; elapsed/tokens unavailable |
| Mechanical preparation/checks | `gpt-5.6-luna` / `low` requested; fallback execution reported capable lead environment, exact runtime telemetry unavailable | No source editing | Dedicated PG and final logs; elapsed/tokens unavailable per role |
| Independent hostile/document review | `gpt-6-astra` / `high` | First pass 5 P1 + 3 P2; second pass 1 P1 repaired; final verification accepted | Different from plan reviewer/implementers; elapsed/tokens unavailable |

Dispatch settings are recorded, not independently measured runtime model claims.
No token totals or percentage savings can be established from available telemetry.
Wall-clock package time begins 2026-09-28 17:42:50 UTC; final completion time is
recorded with publication evidence. Startup, review and rework are included.

## Remaining operational gates

Bundle entry remains blocked by `PP4_RESEARCH_UNAVAILABLE`; PP4 is not implemented
here. The current production reconciliation adapter also lacks certification for
full Warsaw-midnight execution coverage, so generic daily-loss risk returns
`paper_daily_loss_coverage_unavailable` independently. Fixture coverage must not be presented
as broker capability. Actual quote entitlement, calendars, account/identity,
completed-order/economic coverage and supervised acceptance still require current
broker evidence. Repeated scheduling/automatic lifecycle require PP5; final broker
acceptance remains PP7. Source checks do not authorize deployment or trading.
