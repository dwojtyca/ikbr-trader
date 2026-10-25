# Accounting recovery zero-start deployment report

Date: 2026-10-25. Status: implementation and local validation complete; publication/CI and
operational recovery are separate gates.

## Scope and reason

The accepted owner-recovery implementation `4328079` cannot validate a freshly
recreated image without first starting ordinary producers, because its inventory
accepts only exited/dead core containers. Master=false does not disable data or
provider work. This package follows the independently accepted
[bounded amendment](PAPER_ACCOUNTING_ZERO_START_DEPLOYMENT_PLAN.md) so deployment
can prepare containers without running them.

The additional explicit Created variant records null start/finish timestamps and
the real creation time. It requires all previous image/project/service/command
identity checks plus exact never-started Docker state. It neither retires an old
accounting owner nor proves old broker-session closure. Mandatory TWS/operator
evidence, global inventory, event continuity, deadlines, CAS and receipts remain.

No strategy, trading/risk decision, paid-provider policy or SQL migration changes.
Unrelated dirty ES/backtest/signal work remains excluded. Operational recovery
and entry activation require their independent evidence, even after successful
source validation and deployment.

## Review and validation

Plan review: `diagnose_profile`, requested gpt-6-astra/high, ACCEPT with no repairs.
Implementation: `owner_repairs`, requested gpt-6-astra/high.
Final review: different independent `zero_start_final_review`, requested
gpt-6-astra/high, ACCEPT without blocking findings or repairs. The reviewer
authored no edits, independently reran shared (10 passed) and host (13 passed,
1 optional native test skipped) tests and checked the scoped diff. The final
no-start/no-deps deployment command was also reviewed and accepted.
Actual model/effort telemetry, token usage and elapsed attribution are unavailable.
Focused author checks passed: shared build and 10 parser tests, host 13 passed
with one optional native test skipped, tools/execution typechecks, real isolated
Docker zero-start fixture (six app-shaped containers and replacement never
started; separate harmless event container invalidates the watcher), and isolated
PostgreSQL durable recovery path. The PG regression also rejects missing reset,
operator evidence and handshake closure without changing owner/hold/pause.
No repair failures or escalations in this amendment.

Clean candidate Docker build with --no-cache passed:
`sha256:149a3f71d1b985110bf6548e251bc2f3e8a0a235517673b212ff0570f67504dd`.
Context is HEAD plus only this package, excluding unrelated local work.
Clean-context host validation passed: `pnpm lint`, `pnpm typecheck`, `pnpm test`
and `pnpm build`, all exit 0. Full execution unit suite reports 1,614 passed;
remaining workspace suites passed with their existing optional skips. Initial
sandbox dependency installation failed with registry ENOTFOUND; the authorized
network-enabled frozen install succeeded. No source changes were made to obtain
these passes. At this initial checkpoint full isolated integration, publication/CI and deployment
were pending; final local outcomes are recorded below.

The prerequisite owner-recovery commit `4328079dcdab3631c176767aaf7e148c096ddb9a`
has [successful exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/40205894369).
This does not retire the operational owner or activate entries.


## Integration fixture timing finding

The first full isolated run failed one unchanged owner fixture: after UNKNOWN
retirement and local client destruction, immediate acquisition saw
`ACCOUNTING_SOURCE_OWNER_CONFLICT` rather than the expected durable
`ACCOUNTING_SOURCE_OWNER_UNRETIRED`. Focused rerun passed 2/2. Diagnosis traced
this to asynchronous pg-pool client teardown: non-retired release does not promise
server-side lock disappearance. This is a fixture sequencing assumption, not a
Created-variant regression. The plan amendment requires an exact bounded
read-only lock-absence observation before the unchanged single acquisition.
No production release or denial semantics are relaxed. The bounded test-only amendment was accepted by independent
`teardown_plan_review` (Astra/high) before implementation and by the separate
`zero_start_final_review` (Astra/high) after implementation. Focused isolated PG
rerun passed 2/2. This was one diagnosed fixture repair, no runtime repair or
escalation/downgrade. Final repaired-scope validation follows.


## Final validation and publication boundary

Final clean-context `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`
passed (exit 0). The amended test required one compile-only correction to model
node-postgres query_timeout with explicit QueryConfig intersections; SQL,
timeouts and assertions were unchanged. The independent final reviewer accepted
that correction. Lint/typecheck/build were rerun and passed; the unchanged
runtime tests were not repeated solely for those erased type annotations.

Full `pnpm test:integration` then passed (exit 0) using only dedicated PostgreSQL
`ikbr-owner-recovery-test`, database `ikbr_trader_ci`, reached through that test
container's network namespace. No operational database was used for fixtures.
The clean candidate image ran with only the amended test file mounted read-only;
all other source came from the isolated approved context. The previously failing
owner scenario passed in this full run. Logs remain in the local temporary
validation directory; no credentials or raw account evidence are committed.

Scoped diff and relative document links passed. No strategy/simulator behavior
changed, so no strategy backtest applies. Publication and exact-commit CI are
verified after this report's commit; exact final image, CI conclusion and any
operational deployment are recorded in the private deployment receipt. A source
pass alone is not a claim that the accounting owner has been recovered.

At the predeployment check, operational schema remained 000037, old owner ACTIVE
generation 1, durable pause true/revision 53, and no local attempted submission.
Backup archive was readable (866 TOC entries). TWS API was not listening; current
operator flat-account/reset evidence and unrelated-container consent remain
required. No positive attestations were generated and no recovery was initiated.
