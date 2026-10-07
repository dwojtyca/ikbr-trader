# PP7 F1: qualified account-day accounting source

2026-10-07. Implementation is accepted after one hostile repair round and all
required local checks passed for the initial candidate. Source was published, but
its CI integration failed. The independently reviewed fixture-only repair has
passed all local checks against CI-shaped PostgreSQL; repair publication/CI remain pending. This is a code package under the
[accepted F1 contract](PP7_ACCOUNTING_SOURCE_CONTRACT.md); it is not real broker
qualification or permission to activate Paper trading.

## Implemented scope

A separate read-only `@stoqey/ib` connection replays account executions and fees
using client ID 0 on the execution service's configured endpoint. Its supported
positive source is explicitly qualified TWS seven-day retrieval with Master 0.
The existing `ib` execution socket retains broker writes. There is no UI automation,
order binding, submission, cancellation or strategy change in this source.

Private strict settings bind the Paper account, endpoint and timestamp timezone.
Authenticated inspect/qualify/status/invalidate controls use the existing API
token and account guards; qualification requires paused entries. Source reads and
revocation remain available with master writes disabled. The CLI verifies private
local host-setting artifacts before sending metadata and digests. Unexposed TWS
settings remain honest operator attestations, not purported API attestations.

Additive migration `000027_broker_accounting_source.sql` retains source controls,
immutable qualifications, append-only observations and immutable captures. The
service tracks callbacks from both accounting and execution sockets before async
persistence. Exact durable duplicates do not change the economic revision; new or
changed values, missing costs, pending persistence, disconnects and ambiguous
corrections prevent admission. Capture identities bind qualification, source and
execution sessions, reconciliation run, position generation and source evidence.

The production reconciliation adapter joins qualified accounting with its existing
broker snapshot. Qualified daily-loss reads and early, AI-context and final
transactional entry checks use the source evidence barrier. Unconfigured operation
keeps the existing reconciliation behavior without inventing positive accounting
coverage. Exit persistence and lifecycle responsibilities remain intact.

The [operator runbook](../../runbooks/PAPER_ACCOUNTING_SOURCE.md) describes private
configuration, read-only qualification, freshness and revocation. Source opt-in
is absent from the operational environment and examples do not establish evidence.

## Review and validation

Independent critical plan review accepted the F1 contract after two blocking
findings were repaired. A different Astra/high implementation reviewer identified
four issues during the first hostile pass:

1. `FILLED` order-status observation needed synchronous invalidation before a
   database lock could delay the existing position-snapshot invalidation.
2. Capture reads needed to revalidate immutable referenced evidence and receipt
   bindings, including an inserted self-consistent but unsupported capture.
3. Qualification needed to recheck identity and evidence freshness after waiting
   for its database lock.
4. Malformed execution/commission events discarded by the old SDK adapter needed
   to invalidate the qualified source before returning.

All four findings were repaired in five existing implementation/test files. The
independent reviewer accepted the fixes and reproduced 13 PostgreSQL cases with
zero skips/failures, plus 10 pure accounting tests. A composed positive path uses
the actual reconciliation adapter, collector/service/store, daily-loss reader and
repository final dispatch. Unrelated research/session ports are stubbed. When a
FILLED callback arrives while SQL invalidation waits on locks, dispatch sends zero
orders; after complete fresh replay the same supported path admits one stubbed
send. Tests also reject rehashed unsupported persisted captures, stale or
disconnected qualification and malformed legacy callbacks. No real order is sent.

The first clean candidate excluded all 25 pre-existing dirty paths and concurrent
news work. Its source overlay was recorded by SHA-256. Before hostile repairs,
install, lint, typecheck, full unit tests, build and a no-cache Docker build passed;
targeted source PostgreSQL tests passed 9/9. Those checks are provisional because
the reviewed repair changes the candidate.

| Required final check | Result |
| --- | --- |
| Hostile implementation re-review | Accepted after one repair round; all four findings resolved |
| `pnpm lint` | Passed; two pre-existing unused-disable warnings |
| `pnpm typecheck` | Passed |
| `pnpm test` | 3019 passed, 143 PostgreSQL-dependent skips, zero failures |
| Isolated PostgreSQL `pnpm test:integration` | 2459 passed, zero skips/failures; complete rerun after migration-test repair |
| `pnpm build` | Passed |
| Clean Docker build | Passed after repair, `ikbr-trader:pp7-closure-verify` |
| Scoped diff, links, private baseline preservation | Eight-document independent review accepted; all local links resolve; 25 baseline hashes unchanged |
| Main commit and exact-commit CI | `ddffe1009dae4b5a7d67bb4a0ad86c6d7705c56d` published; integration failed in CI, fixture repair passed local checks, repair publication/CI pending |

The final combined candidate was created from `bc5d6d62b825ee69d8862142401f91badb5b07ff`
plus the reviewed F1/E1b paths, excluding the 25 pre-existing dirty files. Its
first full integration run applied migration 27 correctly but failed the old PP1
upgrade test's literal expectation ending at 26. The lead added 27 to that exact
list; all legacy ownership, AI and consumed-budget preservation assertions remain.
An independent Astra/high reviewer accepted this one-line repair. The complete
integration command passed against the rebuilt clean candidate: execution 1757,
backtest 18, llm-agent 26, ingestion 111 and signal-engine 547 cases, zero skips or
failures. It finished in 276.100 seconds. The clean Docker rebuild took 25.704
seconds and passed. Full command outputs are saved in private
`/private/tmp/pp7-closure-final-*.log` files. The initial sandboxed frozen install
was interrupted after DNS failure; the authorized network retry passed.

No strategy or simulator behavior changes require backtests. Test fixtures use
isolated PostgreSQL, never the operational database.

## Remaining operational evidence

No actual accounting connection, TWS settings qualification, operational migration,
entry activation or broker order was performed for F1. The actual TWS/Gateway host
choice, build and settings still require operator evidence. Settings expire after
seven days; every entry still requires fresh complete broker evidence.

The conservative 48-hour certified replay floor cannot cover a requested recovery
start older than that floor. Existing ambiguous-order recovery guards remain.
Missing opening-fill realized P&L or other unset broker costs remain holds; there
is no synthetic zero or alternate accounting algorithm. A durable correction hold
requires a separately reviewed resolution, not deleting rows or restarting.

Research news/calendar and model qualification, deployment and real PKO/AAPL
entry/exit gates are separate requirements. F1 does not complete PP7 on its own.

## Delivery record

The author, critical lead, plan reviewer and distinct implementation reviewer use
the requested Astra/high route. Mechanical clean-candidate checks use
`gpt-6-luna`/low because `gpt-5.6-luna` is unavailable in the exposed subagent list.
Independent runtime model/effort and token telemetry are unavailable. Four hostile
implementation findings were resolved in one repair round, followed by the separately
reviewed one-line migration-test repair. The initial combined validation ran from
08:07:49 to 08:14:24 UTC (6 minutes 35 seconds); the final full integration rerun
finished at 08:57:14 UTC. F1 source work began on 2026-10-06 at 21:59:13 UTC;
the approximately eleven-hour wall span includes pauses and parallel work, not
exclusive coding time. Initial combined publication is `ddffe1009dae4b5a7d67bb4a0ad86c6d7705c56d`;
its failed CI and the fixture repair are recorded below. No savings percentage
or model-quality guarantee is inferred.

## CI fixture follow-up

The [source CI run](https://github.com/dwojtyca/ikbr-trader/actions/runs/37598003618)
passed install, lint, typecheck and unit tests, then failed PostgreSQL integration;
build was skipped. Full logs require GitHub authentication, so additional remote
failures cannot be excluded from public metadata. The independent Astra/high
diagnosis reproduced a deterministic defect before any database connection:
F1's pathname heuristic accepts `test`/`validation`, while the workflow uses
`ikbr_trader_ci`. The unchanged full local rerun on `pp7_f1_validation` passed
2459 cases; its different base name does not resolve the CI failure.

The accepted supplemental contract replaces the heuristic with an owned generated
child database. Migrations and scenarios run only there; nested cleanup closes
clients and pools and drops only the successfully created child. Production code
and all thirteen existing test cases remain unchanged. Independent implementation
review found one P2 cleanup issue spanning two checked-out client lifetimes; the
lead repaired unconditional rollback/release and the qualification lock wait.
The different final reviewer accepted the source pending measured validation.
The repaired fixture passed all 13 cases with the exact CI base name
`ikbr_trader_ci`. Before/after base table lists and sentinel contents match, and
no owned child remains. In private diagnostic copies, an invalid migration and a
controlled throw immediately after BEGIN each produced the intended test failure,
preserved the base and removed the child. The body failure did not hang. An
independent reviewer verified both cleanup receipts. A first Docker bind-mount
attempt failed before executing the test (exit 125); the private-image method
provided the actual failure evidence, and that harness attempt remains in the log.

The repaired clean candidate passed frozen install, lint, typecheck, host unit
tests, build and a no-cache Docker build. Its image is
`sha256:50983bcd506ab3511ad6150fd64a3a787b2e7f9c5f69eea098689938386af65d` on Node
24.20.0; the accepted fixture SHA-256 is
`0dc30b240138ae8b6bf237aece6337e5caecb172a2bba7ed2dc582d981cfe0a7`.
Full integration against the CI-shaped base passed 2459/2459 with zero failures
or skips in 116.402 seconds. The full host unit suite passed 3019 with 143
PostgreSQL-dependent skips; lint had zero errors and two existing warnings.
Typecheck, build and the no-cache image build passed. All 25 baseline file hashes
and the accepted fixture hash match. Exact repair-commit CI follows publication.
Complete logs are `/private/tmp/pp7-ci-fixture-repair-*.log`.

The repair's independent plan reviewer was Astra/high `plan_research_feeds`;
root implemented the accepted contract and Astra/high `review_e1a_implementation`
provided the distinct final review. One P2 implementation finding was repaired
in one round. Mechanical validation retained the disclosed Luna fallback. From
the failed CI completion at 09:09:21 UTC to the final local integration completion
at 09:33:00 UTC, elapsed wall time was 23 minutes 39 seconds, including diagnosis,
reviews and harness setup. Token usage is unavailable.
