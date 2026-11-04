# Startup research freshness implementation report

Date: 2026-11-04. Status: implementation accepted; local validation complete.
Publication CI and runtime evidence remain pending until verified after publication.
Baseline: `b8dd08c9383b7abceb9274c4da8ed68000078941`.

## Scope and acceptance

The owner requires missing or unusable research to be acquired at startup without
waiting for ordinary hourly refresh. The accepted
[plan](STARTUP_RESEARCH_FRESHNESS_PLAN.md) covers Marketaux and WSH, independent
source recovery, durable pacing and evidence-preserving migration. It grants no
entry permission and does not change proposal, AI, risk or financial reconciliation.

The existing WSH error10281 reports a duplicate event-data request. Passive
inspection did not establish its cause. The current transport's socket round trip
does not prove that the WSH backend has completed cancellation. Existing TWS API
log viewing exposed no available log; general-log viewing was disabled. A later
local-only export through the existing TWS interface showed a WSH event request
at 2026-11-03 19:21:45.928 in the log's displayed timezone and the first duplicate
request error at 19:23:44.623. Subsequent requests report the pending request.
This locates the onset but does not establish why the original request or
cancellation failed. No TWS settings or broker operations were changed, and no
logs were uploaded. The generated export is private to the local user; raw logs
and provider payloads are excluded from this report.
This package must not be described as a proved fix for that provider error.

## Review and work allocation

| Work | Agent | Requested route | Outcome |
| --- | --- | --- | --- |
| Plan, shared store and SQL implementation | startup_freshness_design | gpt-6-astra / high | Frozen; shared checks and eight upgrade/hostile cases passed |
| Independent critical plan review | cleanup_audit | gpt-6-astra / high | Accepted after one clarification round |
| App integration and provider timing | startup_retry_design | gpt-6-astra / high | Frozen; 128 focused tests passed |
| Integration, diagnostics, release verification | root | Session model | Local validation complete; publication/runtime verification follows |
| Independent implementation review | startup_retry_final_review | gpt-6-astra / high | Accepted; full release checks and operational evidence pending |

Plan review froze exact parser-failure allowlists and required SQL enforcement of
ordinal-zero-only WSH demand cycles. A subsequent clarification accepted a
10-minute project backoff for malformed Retry-After, preserving longer valid
provider deadlines and pooled throttling for regular and demand reads alike.
A further accepted clarification keeps a proved Marketaux HTTP402 as an
account/provider-wide fast-demand hold until a complete, matching successful
response is proved for a call reserved after that failure. Ordinary hourly
revalidation remains available under existing budgets and throttling; neither a
source rename nor a late response to an older call clears the hold.

Hostile review required full local-cooldown settlement support, database-time
validation of WSH demand claims, serialization of pooled provider deadlines with
claims, unconditional SQL validation of terminal HTTP429 timing, and stronger
WSH provenance/failure-proof checks. Regression tests cover those findings;
final independent acceptance was granted after the refusal-proof repairs.

No critical semantics were downgraded to a smaller model. Independent model
telemetry and token usage are unavailable. Whole-package elapsed time and a complete per-agent repair counter were not
collected and are unavailable. All critical review and repair work retained the
Astra/high route; no model-tier escalation or downgrade occurred. The findings
and failed validation rounds are recorded below rather than treated as passes.

## Lock order

Marketaux claims acquire the issuer advisory lock before the pooled research-budget lock,
then read database time and evaluate admission. Direct SQL Marketaux claim guards use the
same order. WSH retains its endpoint lease/row, issuer, then attempt/head
locking paths; provider budget reservation occurs later, not during WSH claim. Call reservation first locks its attempt, then the existing pooled
budget authority; a denied reservation commits no call or budget debit while retaining proved
refusal or budget-denial evidence.
Refusal markers are committed under the pooled lock before returning the fixed
local refusal; no request is charged and the same attempt cannot dispatch again.
Lost commit acknowledgements allow bounded readback only, never dispatch.
Terminal provider cooldown/usage failures acquire the pooled budget lock before
publication can commit, serializing them against claims and reservations. Demand
admission reads publication history without acquiring a head-row lock; it does
not add a budget-to-head lock dependency. Existing writer/recovery authorities
and unknown-call fencing remain in force.

## Validation history and deployment

An initial scoped clean export passed build, lint, typecheck and the full unit
suite (4,029 passed, 396 skipped, zero failures). These results precede the final
review repairs and do not qualify the final release. Initial app-focused tests
passed all 128 cases. Regression/historical migration tests, hostile review,
full integration and exact-commit CI were still pending at that stage.

The first full integration run found three historical-fixture failures: two
expected pre45 attempt rows lacked the newly added default columns, and one
pre40 setup invoked current claim code against the old schema. The fixtures now
assert those explicit defaults and seed the original pre40 protocol/clock row;
all 24 historical recovery tests pass with zero skips. Original row comparisons,
charges and audit checks remain intact.

The subsequent full unit run passed 4,029 tests with 409 skipped and zero failures.
After the final bounded local-usage-hold repair, lint, typecheck, build and the
changed app parser suite passed again. The then-current targeted database suites passed
all 38 cases with zero skips (30 demand cases including its unit case, eight
migration/hostile cases). A clean `docker build --no-cache` succeeded, producing
`sha256:9d7694022abd663dc3a37a15f2b67b2dc6ceb6e059bde2ab2bbf3fc319e93cc2`.
Further review exposed refusal-before-settlement races for expired HTTP429
cooldowns and renewed HTTP402 access. The accepted amendment records an exact
durable refusal under the pooled lock, without a budget charge, and prevents
later dispatch through that attempt. That repair passed 43 targeted tests with zero skips (35 source-demand
cases, eight upgrade/hostile cases), including refusal expiry/renewal before
settlement, marker forgery/immutability and lost commit acknowledgement.
Lint, typecheck and build passed again. That clean no-cache build produced
`sha256:39bbe9c6db6acbf7a678fc52154a420290011f3280533e9993eceed78b12b913`.
Full unit and integration checks were started from that image against
PostgreSQL16 isolated from the operational database.
Integration fixtures must use isolated PostgreSQL. The operational database is
not a test fixture. Unrelated backtest/ES work and the earlier automatic recovery
report remain outside this publication scope.

Publication, deployment and actual source/entry readiness require separate fresh
evidence. No success is inferred from this report or the accepted plan.

## Final review acceptance

The independent reviewer accepted implementation and documentation with no
remaining blocking findings, conditional on full release checks, exact-commit CI
and fresh deployment evidence. The final SQL hash is
`064071b2fadf8f23235de51101e7e3112526388cf2767a4dcd64d257fc4f327f`;
the shared store hash is
`d417ddfaa8687b5426f704c3d030f40359e54cb6309237eb51973d95a67ac6a7`.
Final focused coverage passed 44 cases (35 demand, nine upgrade/hostile), zero
skips. A final SQL regression rejects missing refusal evidence even after proved
provider recovery; SQL NULL cannot turn missing evidence into admission.

An attempted parallel full unit/integration run overloaded the local Docker test
environment and produced timeout failures, including unrelated PDF decoder tests.
Both disposable test containers were stopped; release validation was repeated
sequentially without relaxing limits. These interrupted runs are not passes.

The accepted runtime was rebuilt without cache as
`sha256:971338ac417f2f96e1c629976eea0d7d005de82351dfbdee36a21540254809b7`.
The operational database passed the migration's exact baseline-function check
in a read-only transaction. No migration or state edit was performed by that
preflight. The sequential shared integration suite passed 157/157, zero skips.

The sequential full integration run passed shared157, execution2271 and
backtest18 tests, then exposed one stale llm-agent fixture assertion (84/85
passed): it expected three HTTP429 calls instead of one pooled provider call.
The fixture now checks exactly one charge, no peer snapshots, and cooldown
rejection for every issuer; UNKNOWN timeout assertions remain intact. Its real
PostgreSQL suite passed 2/2 and the independent reviewer accepted the test-only
adaptation. Runtime hashes are unchanged. Full integration was repeated with
that reviewed fixture.

The next full run passed shared157, execution2271, backtest18 and llm-agent85
tests. Ingestion exposed an existing fixture teardown race: forced database drop
could terminate a socket after pool.end. The auto-bootstrap fixture now follows
neighboring fixtures by awaiting connection removal and using ordinary DROP.
Its assertions and deadlines are unchanged; the targeted PostgreSQL test passed
and the independent reviewer accepted this test-only repair.

## Accepted local validation result

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`: exit0 on the
  final isolated scoped export. Unit suite: 4,029 passed, 420 skipped database
  cases, zero failures. Database cases were exercised with isolated PostgreSQL.
- Integration stage coverage: shared157, execution2271, backtest18, llm-agent85,
  ingestion160 and signal-engine574: **3,265 passed, zero skips or failures**
  in the accepted stage runs. The full command exposed the fixture issues above;
  after fixing the final ingestion teardown, ingestion and signal-engine were
  rerun successfully instead of repeating already-passed unchanged stages.
  Exact-commit CI must additionally verify one uninterrupted full command.
- Independent critical implementation/document review: accepted, no remaining
  blocking findings; follow-up fixture changes separately accepted.
- Local document links and staged whitespace checks pass. No strategy or
  simulator behavior changed, so no new backtest is required.

The scoped publication excludes unrelated backtest/ES work. Deployment preserves
the account, Paper policy, providers, budget, client IDs and existing protection.
It requires a private database backup, the supported durable entry pause, the
reviewed pinned image, automatic migrations and startup, followed by fresh
reconciliation/entry/source checks. No routine TWS restart is introduced.
Exact commit, image, CI URL and observed deployment outcome are recorded in the
private release audit and final delivery message after publication.
