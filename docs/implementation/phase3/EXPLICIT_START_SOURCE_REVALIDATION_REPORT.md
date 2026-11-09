# Explicit startup source revalidation — evidence

Date: 2026-11-09. Status: implementation reviewed and local validation passed; publication/rollout pending.
Contract: [accepted plan](EXPLICIT_START_SOURCE_REVALIDATION_PLAN.md).

## Problem and intended behavior

After the owner replaced an expired WSH trial with a paid subscription, explicit
Paper startup still reported the earlier metadata refusal10276 and the next
hourly refresh. The current automatic demand contract intentionally excludes
these provider refusals. This package gives each authenticated startup pause
revision one source-scoped opportunity to revalidate required data without a
local hourly/backoff delay. It preserves historical failures, charged budgets,
provider throttling, configuration rights, read uncertainty and entry controls.
History preparation and research preparation run concurrently after the existing
audited pause and service startup. Both must finish before normal resume checks.

## Review and validation

Independent plan reviewer `immediate_start_plan_review`, requested/actual
`gpt-6-astra` high, accepted after one amendment round. Findings addressed request
consumption against newer work, revision/authority checks before unsent calls,
and lock order with the outer WSH session lease.

Core implementer `startup_diagnosis`, requested/actual `gpt-6-astra` high, owns
SQL, shared source admission, execution registration and provider integration.
The lead owns CLI orchestration, Polish diagnostics, documentation and release.
Independent final reviewer `immediate_start_final_review`, requested/actual
`gpt-6-astra` high, has not implemented the changes. Initial CLI review found
that aborting the bootstrap wait did not await local HTTP settlement; the lead
retained and drained that promise and added delayed-settlement tests.

Final independent critical implementation review: ACCEPTED. Core repairs tightened
account/source-scoped history and JOINED evidence, original WSH refusal evidence,
staged-cycle replay fencing, durable pending-request discovery after recovery,
and concurrent FRESH consumption. No remaining blocking findings. The core had
four review repair rounds, plus one fixture setup repair; the CLI had one repair
round. No model escalation or operational provider calls during implementation.

Targeted validation passed: PostgreSQL 62/62 (19 explicit-start cases), producer
95/95, execution route 2/2 and CLI 68/68. Final targeted PostgreSQL duration was
29.16 seconds. Independent scoped whitespace validation passed. A clean Docker
build passed. Final lint and typecheck passed in that image; full unit tests
passed on the isolated source export with workspace concurrency 1. Counts:
shared 714 passed/176 skipped, execution 1740/164, ingestion 198/5, llm 407/75,
signal 561/14, UI 14/0, tools 347/5 and backtest 109/0. Final `pnpm build` passed.
The initial full integration command passed shared 176/176, then found two stale
migration inventory assertions in execution tests. The repair only appends the
reviewed migration46 to those exact expected arrays. Both affected complete test
files passed again: 29/29, zero skips, 18.20 seconds; changed-file lint passed.
This adds one mechanical repair round, independently accepted. The original
execution integration run had 2270 passing cases and those two inventory failures;
the repaired complete files passed as above. The remaining integration command
passed backtest 18/18, llm 85/85, ingestion 203/203 and signal 575/575, all with zero
skips. This is combined local integration evidence, not a claim that the initial
full command passed. Exact-commit CI must rerun the complete command.

Publication, exact-commit CI and deployment remain pending at report creation.
Release/deployment receipts are kept privately under `.local/explicit-start-20261109`;
they must identify the exact commit/image and observed outcomes before rollout is
reported successful. A predeployment operational database archive was created and
its archive index verified. No provider success or trading readiness is claimed.

Validation environment notes: the first parallel host rerun had an unchanged UI
test failure; that test passed independently and in the final full host run.
An attempted full unit run inside the deployment image failed because that image
lacks the Docker CLI used by Compose tests; it also reported a strategy test
process failure. The final host run passed every package without modifying any
test criteria. Integration tests run in a container sharing only the isolated
PostgreSQL container's network, with CI's loopback test database identity.
Tests use a dedicated local PostgreSQL container; no destructive operational
fixtures are permitted. An isolated source export excludes unrelated working-tree
ES/backtest changes, signal-engine edits and the automatic recovery report.
No strategy or simulator behavior changes, so new strategy backtests are not
required. Token usage and independent provider telemetry are unavailable;
elapsed times and further repair evidence will be recorded when available.
