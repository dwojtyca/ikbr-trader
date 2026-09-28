# PP1 implementation report

Date: 2026-09-28. Status: PP1 implemented, independently reviewed and published on `main`; all
required local checks and implementation exact-commit CI passed. No operational
deployment was performed.

## Baseline and scope

The owner selected PP1-A, then the PP1-B Luna pilot and dependent PP1-C. Work began
on `main` at `a56bc5cfcd85b0de77362d6949794f0d713456f9` after rechecking PP0:

- PP0 implementation `574200ae4fa4e4e4b77c7122b8bba81516778c8e`: [CI success](https://github.com/dwojtyca/ikbr-trader/actions/runs/36424513729).
- PP0 report baseline `a56bc5cfcd85b0de77362d6949794f0d713456f9`: [CI success](https://github.com/dwojtyca/ikbr-trader/actions/runs/36425505879).

A SHA-256 inventory recorded the 25 pre-existing dirty files, including the ES
research work and `apps/signal-engine/src/signal-engine.ts`. They are outside this
package and must remain byte-identical and unstaged. Validation uses an isolated
candidate exported from the baseline with only reviewed PP1 files overlaid.

The [accepted plan](PP1_IMPLEMENTATION_PLAN.md), [normative v1 contract](PP1_CONFIGURATION_CONTRACT.md)
and [operator runbook](../../runbooks/TRADING_CONFIGURATION.md) define scope. No
PP2 parameter execution, new strategy, PP3 execution generalization, PP4 provider
research, operational deployment, real broker/provider request or trading activation
belongs to this delivery. Tests use synthetic dependencies and an isolated database.

## Delivered mechanisms

The shared parser separates reusable strategy instances and immutable revisions
from instruments, assignments and account/entry/execution/risk/research catalogues.
V1 supports bounded stock declarations for WSE/PLN and supported SMART/USD listings.
Unknown fields/versions, malformed primitives, unsupported capabilities, conflicting
listing identities and invalid references fail closed. Defaults match the existing
momentum implementation; PP1 records parameters but does not apply them to strategies.

Canonical v1 JSON sorts catalogues and keys, includes fixed defaults and produces a
shared SHA-256 identity. Instance identity includes algorithm revision and normalized
parameters. Reusing an instance ID/revision for different content is refused.
Immutable snapshots and instance revisions persist through additive migration
`000016_trading_configuration.sql`; proposal hashes and attempt budgets are untouched.

Each of ingestion, signal-engine, execution-engine and llm-agent unconditionally
loads the same authority before its production work starts, including when runtime
or worker flags are off. Bundle mode requires an absolute path and expected hash,
rejects competing legacy authority settings and has no fallback after failure.
Compose forwards the same settings and mounts the configuration directory read-only.
The [disabled example](../../../config/trading/paper.v1.json) declares PKO and AAPL
sharing one momentum instance. Generic fixture stocks traverse the actual loader,
projection and broker-evidence route without source symbol branches.

Service observations have independent process IDs, ten-second heartbeats and
30-second leases measured against database time. Concurrent processes cannot hide
one another's conflicting configuration. Explicit disabled migration preparation
suppresses new proposal, AI claim/provider/delivery and entry work. Conversion
requires compatible prepared source evidence; the durable bundle latch prevents a
legacy restart or expired peer lease from reopening entries. Store failure denies
entry. Every bundle entry remains denied pending PP2/PP3 even with matching peers.

Guards run at the actual signal runtime/loop, both bound and legacy AI workers,
and execution submission/dispatch boundaries. They recheck after awaited work and
before side effects. The legacy AI worker was extracted from its startup module to
exercise its real claim, provider, persistence and delivery sequence with injected
dependencies; its existing decision behavior is retained when admission allows.
A configuration pause is not an AI rejection and cannot turn an unknown submission
into a retryable proposal.

Disabled migration captures a validated immutable legacy management authority.
Original ownership, broker identity, execution policy and enabled flags remain
available for the existing supported close workflow after bundle disable/removal.
Owned instruments retain ingestion monitoring. Entry routing does not use this
management authority. Missing/conflicting snapshots fail closed, with no fabricated
ownership or quantity support. Legacy PKO/AAPL primary listing was absent; this is
unknown rather than a known conflict. New metadata still requires exact primary
listing, and the retained source is never backfilled. Capture cannot reconstruct
historical policy values which the old schema never persisted.

Authenticated on-demand metadata uses a dedicated read-only socket, serialized
requests, bounded timeout and exact returned contract identity. Price-grid evidence
requires complete route-selected market-rule bands, not merely equal minTick.
Session evidence uses the existing validated schedule and distinguishes a closed
session from missing/stale evidence. BBO evidence requires trusted ingestion
identity, connected/subscribed state, real-time market data and original timestamps
strictly younger than ten seconds. Diagnostics retain unknown/mismatch/unavailable
states and PP4 research unavailability. Ordinary status reads make no broker calls.

## Reviews and model-routing evidence

| Work | Requested route | Selected route | Evidence / repairs |
| --- | --- | --- | --- |
| PP1-A contract and critical shared/migration/execution integration | `gpt-6-astra`, high | Same | Accepted contract; targeted shared, PostgreSQL and actual close tests |
| Independent plan review | Different `gpt-6-astra`, high | Same | Two clarification rounds, then acceptance before PP1-B; narrow primary-listing/fresh-install amendment also accepted |
| PP1-B pure parser/defaults/types pilot | `gpt-6-luna`, medium | Same | 14 focused tests; one primitive typing repair and one successful batch repairing missing policy-reference validation and malformed-value/diagnostic handling |
| PP1-C startup/Compose/diagnostic wiring | `gpt-6-sol`, medium | Same | Focused consumer/monitoring/config checks; one TypeScript inference repair, no semantic relaxation |
| Independent final implementation review | New `gpt-6-astra`, high | Same | Accepted after one repair/re-review round; reviewer authored neither plan nor implementation |
| Mechanical checks/publication | `gpt-5.6-luna`, low | `gpt-6-luna`, low | Requested older model unavailable; disclosed equal-or-stronger fallback |

Selected routes are the models/efforts passed to delegation. Separate provider
runtime telemetry and token usage are unavailable, not zero. The capable lead
integrated critical signal/AI barriers, generic broker evidence and publication
scope. No savings percentage or model quality guarantee is claimed. Work started
at 14:19:58 UTC; all required local checks completed by 15:14 UTC, approximately
54 minutes including planning, implementation, reviews and environment repairs. The parser's
initial implementation took approximately seven minutes; that is not a measure of
the full accepted package, which includes reviews and repairs.

Independent plan findings and repairs fixed: atomic disabled conversion and durable
hold; actual close and monitoring retention after removal/disable; normalized
snapshot/default decoding and concrete metadata freshness; suppression of provider
and proposal work during preparation; exact real-time quote provenance and the
strict freshness boundary. Implementation integration additionally hardened policy
references, malformed parser inputs and actual service admission boundaries.

## Validation

Targeted evidence before final review: parser 14 passing; shared identity/loader/
admission/projection and actual legacy seeds 8 passing; isolated configuration-store
PostgreSQL fixtures 5 passing; actual close compatibility 3 passing; broker evidence
38 passing; execution metadata client/route 13 passing; signal execution/loop 91
passing; bound and legacy AI barrier suite plus existing bound clients 33 passing.
Consumer wiring tests, affected typechecks and synthetic Compose validation passed.
These groups overlap and are not summed into a repository-wide test count.

The independent final Astra reviewer accepted the frozen 75-file scope after one
repair/re-review round. Two P2 findings required a final pre-insert configuration
check after awaited preflight and preserving the actual legacy `aapl_nasdaq` ID in
the shipped example. Both were fixed with downstream-spy or actual-seed tests.
The reviewer also rechecked lead-raised retained-symbol/legacy identity conflicts,
account-bound metadata cache invalidation, and final dispatch deadlines after the
asynchronous configuration check. Independent checks passed: shared 60/60;
execution admission/metadata/close 25/25; AI barriers 21/21; shipped-example seeds
2/2; retained WSE close 2/2. No findings remain open.

Critical integration had one combined repair/re-review round and one test import
compile repair; the lead also repaired two test-fixture typing/setup errors.
No critical semantics were delegated to Luna or relaxed for tests. No model
escalation was needed after the successful repairs; the unavailable mechanical
model used the disclosed fallback above.

Final frozen-candidate results:

| Command / check | Result |
| --- | --- |
| `pnpm lint` | Exit 0; two existing unused-disable warnings, zero errors |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Exit 0; 2661 total, 2609 pass, 52 database-dependent skips, zero failures |
| `pnpm test:integration` | Exit 0; 2092/2092 pass, zero skips or failures, isolated PostgreSQL |
| `pnpm build` | Exit 0 |
| Clean Docker build | `buildx --load --no-cache`, exit 0; `ikbr-trader-pp1:verify` |
| Synthetic Compose and local documentation links | Passed; 228 relative file-link targets exist |
| Independent hostile implementation review | Accepted; no remaining must-fix findings |
| Exact-commit GitHub CI | Implementation `7a4f249716f507d890e2e3ca325ffb8121fcacf6`: [success](https://github.com/dwojtyca/ikbr-trader/actions/runs/36442731251) |

The frozen candidate was exported from the baseline to an isolated temporary
directory and all 75 PP1 files were hash-checked before overlay. Frozen dependency
installation exited 0. The initial sandboxed unit attempt encountered `listen EPERM`
in existing loopback server fixtures; it was stopped and the same unchanged suite
passed with local socket permission. Sandboxed dependency fetch also required
network permission; no lockfile or source was changed. A mechanical shell wrapper
was corrected to avoid zsh's read-only `status` variable. These are environment/
command execution repairs, not relaxed test acceptance.

The disposable PostgreSQL 16 database `ikbr_trader_pp1_test` runs in the separate
Colima profile `pp1-verification`. Integration runs in that same VM/network to
share its clock. The normal Docker context and operational databases are untouched.
Integration used `TEST_POSTGRES_URL` only: execution 1456, backtest 18, llm-agent
13, ingestion 111 and signal 494 passing tests. `TEST_RESEARCH_POSTGRES_URL` was
unset. Unit checks unset both database variables. The Docker image digest was
`sha256:72f87928a264d38e9bf6653a97d4ec679e0dc8223f14e47ff2670dd5a8a0b197`.
All 75 frozen candidate hashes were rechecked after validation. Source did not
change; subsequent report/status edits record this evidence and receive document
review. The candidate excludes private `.env` and unrelated dirty research files. No new
strategy/simulator behavior is implemented, so strategy backtests are not required.

## Publication

Implementation commit: `7a4f249716f507d890e2e3ca325ffb8121fcacf6` on `main`.
GitHub CI for that exact SHA [completed successfully](https://github.com/dwojtyca/ikbr-trader/actions/runs/36442731251). Publication staged
only the 75 reviewed PP1 files. All 25 pre-existing dirty files were checked against
the initial SHA-256 inventory and remained unchanged and outside the commit.

This document/status follow-up records the successful implementation CI. It changes
only documentation. Its independent review required one prose repair round to
remove stale pending-status wording; no runtime code changed. It receives local link/diff validation,
and its own exact-commit CI verification after push. The final delivery message links
that latest run; no unchanged runtime suite was rerun locally for prose alone.
The disposable Colima verification profile was stopped, preserving logs and leaving
the original Docker context and operational services untouched.

## Remaining boundaries

This report establishes source/configuration delivery only. It does not establish
IBKR market-data coverage, completed-order reconciliation coverage, real-time quote
availability, provider coverage or operational readiness. Known PP0/GPW operational
blockers require current evidence during a separately authorized deployment.
PP2–PP7 remain separate stages. Supported closes still require current broker state,
original ownership, authentication, enabled writes and deterministic close risk;
configuration migration supplies no bypass. There is no automatic rollback/reset of
the durable bundle hold and no silent legacy fallback.
