# Paper startup data recovery — implementation evidence

Date: 2026-10-19. Status: implementation and independent reviews accepted; all required local
checks passed. Publication and exact-commit CI are verified separately after this
report is committed. No operational recovery acceptance is claimed.

Owner authorization: implement the accepted [startup plan](PAPER_STARTUP_DATA_RECOVERY_PLAN.md)
under the repository workflow. Unrelated ES/backtest work and the pre-existing
`apps/signal-engine/src/signal-engine.ts` diff are excluded.

## Evidence and decisions

Stage 0 used read-only operational queries and one bounded non-pausing logpoint on
an existing ingestion request. No extra historical fetch or broker order was sent.
The capture demonstrated AAPL's Monday preopen response ends at Friday's close;
PKO independently regained strict history coverage at its opening. Operational
currentHours for the captured AAPL response was not recorded. The accepted
[session contract](PAPER_STARTUP_SESSION_RECOVERY_CONTRACT.md) therefore permits
conditional partial preparation and makes no claim of actual AAPL recovery.

Legacy Marketaux attempts include an UNKNOWN first page for PKO and interrupted
second-pass pagination for AAPL. WSH has an abandoned PKO attempt without verified
local closure, fencing the shared endpoint. Exact evidence and the selected
recovery contract are recorded in the [research amendment](PAPER_STARTUP_RESEARCH_RECOVERY_CONTRACT.md).

## Routing and reviews

| Work | Requested model/effort | Agent | Evidence |
| --- | --- | --- | --- |
| Research contract design | gpt-6-astra/high | research_recovery_contract | Accepted after maintenance, resume hold, clock proof and supersession repairs; implementation includes immutable receipts and SQL guards |
| Session contract/implementation | gpt-6-astra/high | session_recovery_contract | Independent plan ACCEPT; targeted tests below |
| Independent stage-0 plan review | gpt-6-astra/high | startup_plan_review | Session ACCEPT; research_plan_final accepted research and read-only operation discovery amendment |
| Terminal presentation | gpt-6-luna/medium | startup_presentation | 48 focused tests and typecheck passed |
| Hostile implementation review | gpt-6-astra/high | startup_document_review | Session/terminal ACCEPT after three P2 repairs; full scoped integration ACCEPT after final repairs |
| Host process/deployment observation | gpt-6-astra/high | recovery_host_observer | Accepted after command/entrypoint identity repair; 16 focused tests |
| Research parser hostile tests | gpt-6-luna/medium then gpt-6-sol/medium | recovery_parser_tests_fallback | Luna unavailable at capacity; Sol completed 7 parameterized tests |
| Integration, operator tooling and release | Capable lead | root | CLI, WSH PostgreSQL cases, diagnostics and release checks |

Actual provider model/effort telemetry and token usage are unavailable. Requested
settings are tool routing, not measured provider telemetry. Elapsed time will be
reported only when available. One lead presentation finding corrected reading
sessionWarmup from the top-level progress response; duplicate/malformed records
also fail to unavailable. Initial hostile implementation review found three P2
issues: post-fetch clock regression, unreconciled final calendar generation, and
uncontrolled diagnostic reason text. The session author repaired the first two;
the lead added an explicit reason allowlist plus privacy sanitization for the
third. New hostile tests reproduce each issue. Session repair required one
TypeScript fixture annotation repair; there was no semantic escalation. No safety
guard or acceptance test was weakened. Independent session/terminal re-review
accepted the repair and independently reran 43 ingestion and 49 terminal tests
(approximately three minutes, actual token telemetry unavailable).

## Validation

Targeted session evidence: shared session suites 92/92; ingestion schedule/native/
adapter suites 49/49; shared and ingestion builds, ingestion typecheck and scoped
ESLint passed. Targeted terminal evidence: 49/49 runtime tests and tool package
typecheck passed after the diagnostic repair. Repaired native/schedule suites
43/43, ingestion typecheck, scoped lint and whitespace checks passed. These counts are not added as unique full-suite totals.

Dedicated test PostgreSQL: `ikbr-startup-recovery-test-20261019`, loopback port55434,
database `ikbr_startup_recovery_test`, separate from the operational database and
volume. Test fixtures never use operational5432.

Research transport evidence: 137 app focused regressions and 50 isolated-PG app
checks passed. Host collector: 16 tests, including oneoff/mislabeled command and
entrypoint rejection. One-shot CLI: 6 tests; host orchestration: 9 tests, including
unknown commit readback, changed evidence/receipt identity and status preserving
mutation markers. Parser: 7 parameterized tests. Lead WSH suite: 7 isolated-PG
tests covering legacy acquisitions, unchanged terminal rows, new evidence after
recovery, endpoint/issuer scope, competing commits, expiry and generation drift.
These are targeted counts and may overlap full-suite runs.

Review repairs also covered status overwriting unknown-mutation markers and exact
receipt evidence-hash readback. New WSH PG cases caught two PL/pgSQL identifier
collisions, both repaired before release. Fixture corrections supplied the required
coverage reason and used two canonical historical manifests for a moved endpoint;
normal authority-adoption guards were not relaxed. The parser fallback corrected
one malformed-UUID test fixture. No provider request or broker write was made.

Full lint and typecheck passed; lint has two pre-existing unused-disable warnings
in backtest simulator and llm config outside this package. Full unit tests and build passed. The first unit attempt encountered a timing-sensitive
existing WSH fixture under concurrent load; a sandboxed retry could not open its
local test sockets. The complete unsandboxed localhost-fixture run passed without
weakening runtime guards or those tests. Historical WSH regressions passed41/41;
final-resume regressions passed3/3, including PREPARED holding otherwise usable cache.
The migration34 fixture now seeds actual historical canonical snapshot bytes rather
than calling a current-schema store before migration37. Expected migration lists
include37, and dedicated test URL allowlists include the exact isolated database.
Full integration passed: shared90, execution2063, backtest18, llm84, ingestion160
and signal574 tests, zero failures. Final `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` and `pnpm build` passed; the integration URL was the isolated
port55434 database above. The final llm publication fixture received the same exact
isolated database allowlist after its first guarded run refused that URL. Independent
review accepted all52 publication paths and final documentation. Scoped publication
and exact-commit CI are the remaining release verification steps; consult the CI run
attached to this commit, not a previous green commit.
No deployed fix, resumed entry, successful provider refresh, broker transaction
or profitability is established by this document.


Final hostile review identified two additional implementation defects in one repair
round: recovered historical WSH cleanup incorrectly poisoned later legitimate
retries, and direct SQL admission did not serialize against an uncommitted
maintenance hold. The repair requires regular ordinal0 for first redemption,
then uses the unique successor link while preserving every new uncertainty fence;
SQL admission locks the challenge table before reading holds. Eight new isolated-PG
cases passed, including both SQL races, three maintenance authority denials, and
actual bind and binding-validation rejection. Independent Astra/high re-review ACCEPTED the full scoped implementation;
final repair verification took approximately four minutes.

The clean Docker build used a Git archive plus only scoped files, excluding local
ES/backtest work, untracked private configuration and credentials. `docker build
--no-cache` passed again after incorporating every final test fixture and its
explicit isolated database allowlist. Image:
`sha256:688df57e13ba8f6baaf362345d56fe8956d5df7e0d79e1df32053d85f958a539`.
No container was deployed from this image.
