# PP7 accounting clock recovery implementation report

Date: 2026-10-07. Status: independent hostile source/document review, full repository
checks and clean Docker build passed. Publication, exact-commit CI and operational
use remain pending at this revision.
Accepted plan: [clock recovery](PP7_ACCOUNTING_CLOCK_RECOVERY_PLAN.md), original
accepted SHA256 `3cf4fece87b968b54c4e67dad860b1f337bb2ea500d0d4c10d1b397e60a37250`.
The subsequent exact write-guard exemption/file-scope clarification was authorized
by the lead; it adds no broader path exemption.

## Problem and resulting behavior

A durable `ACCOUNTING_CLOCK_INVALID` previously survived later valid clocks,
restart and normal qualification. The new authenticated `recover-clock` command
requires server-owned Paper, disabled broker writes and effective entry pause.
It retires the old accounting socket and uses a new object with generation-bound
callbacks, a newly requested valid clock and complete execution/commission replay.
The transaction verifies persisted evidence, both clocks, current source identity,
revision and lane state before appending an immutable receipt and clearing only
that clock hold. Gap remains true; existing qualification ID/expiry are unchanged;
a new joined reconciliation capture is still required before admission.

Non-clock holds are never downgraded by a clock/gap update. Recovery scans retained
observations for overwritten failures, changed execution/fee payloads and the exact
existing correction-family condition. Missing fees, unknown prices, malformed
values, orphan fees, wrong identity, stale clocks, failed persistence and concurrent
source changes refuse recovery. Old sockets cannot certify a new request, and a
new invalid clock poisons the attempt even after replay while its transaction waits.
No order, provider call, operational database mutation, safety reset or fabricated
cost was performed during implementation/testing.

## Review and repair evidence

The independent plan reviewer required fresh socket objects, immutable callback
generations and explicit pre-request/retired-callback tests; the accepted plan
contains these requirements. This worker reviewed that plan but did not author it.
A different agent, `retained_state_final_review`, accepted the frozen source after
an independent run of all 50 focused tests (including 21 real PG checks).
The 13 runtime files are pinned by aggregate scope SHA256
`7d9d1f73b5fbeeb0044d1976daa9768421a3cb6895e432fe8ecad36b440154e9`;
the private receipt is `/private/tmp/pp7-accounting-clock/runtime-freeze.json`.

Early implementation review identified and checked repairs for:

- Invalid clock callbacks after the first clock/replay: a per-socket request marker
  permits diagnostics/poisoning after replay without certifying unsolicited clocks.
- Final database-clock freshness: the store rechecks DB time after all awaited
  work, then applies the synchronous process/lane guard immediately before commit.
- Historical correction-family comparison: the historical query now mirrors the
  existing prefix check and first-observation order, including `a.b.01` then `a.02`.
- Coverage accuracy: hidden-history tests restart after simulating the old overwrite
  and explicitly require `HISTORY_CONFLICT`; the lock-race test changes a known
  execution and verifies the stronger correction hold persists.

Two targeted fixture/expectation repairs were necessary: the new positive fixture
now drains startup persistence before recovery (the original `SOURCE_BUSY` refusal
was correct), and the closed write-exemption list includes the one new exact route.
No failure was resolved by relaxing runtime guards. One initial isolated PG command
was denied by the filesystem/network sandbox (`EPERM`); the same bounded command
ran successfully with approved access to localhost:55479.

## Validation at source freeze

- Execution-engine typecheck: passed.
- ESLint for the affected accounting modules, index wiring and exemption/tests: passed.
- Accounting/exemption unit tests: 29 passed, one PG parent skipped without DB URL.
- Real isolated PostgreSQL source/service suite: 21 passed, zero skipped or failed.
  The suite creates/drops its own disposable database on localhost:55479.
- Tests include real store/service wiring, fresh connections, old callbacks,
  malformed/late clocks, real costs, absent costs, restart, stronger/overwritten
  failures, DB lock races, final DB-clock aging, pre-commit callbacks and injected
  rollback between receipt insertion and hold clear. Existing qualification,
  capture, correction and actual final-dispatch refusal tests remain passing.

Full release checks passed on the clean archive of `a7893084e2b7c7344f70e6c205cd8deb4d171a82`
plus only the 13 frozen runtime/test files: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
isolated `pnpm test:integration`, `pnpm build`, and a full no-cache Docker build.
Unit command: 3,083 passed, 157 database-gated skipped, zero failed. The explicit
integration command passed 2,491 tests with zero skipped. Total successful sequence:
269.974 seconds (lint 6.129, typecheck 13.014, unit 82.416, integration 129.637,
build 7.320, Docker 31.458).

Reviewed image: `sha256:393de8c9d92014b67beb6429482d3f43224436f40217be84e97e162d106fc7c5`.
All 13 frozen runtime hashes matched source and archive; all 25 unrelated dirty-file
hashes remained unchanged. Logs/receipts are under `/private/tmp/pp7-clock-recovery/`.
Mechanical route: requested GPT-5.6 Luna/low, available fallback GPT-6 Luna/low;
actual runtime telemetry/token usage unavailable. No strategy/backtest behavior changed.

Publication and exact-commit CI remain gates before deployment. Operational backup,
disabled deployment and explicit recovery are separate steps; this revision is not
evidence of recovered operational accounting or a Paper trade.

## Routing and scope

Requested implementation route: Astra/high. Actual model/effort telemetry and token
usage are unavailable. Original worker reactivation failed because of the agent
thread limit; the lead delegated implementation to this capable worker while
retaining a different final reviewer. Exact implementation elapsed time was not
instrumented; the recorded isolated source suite took 9.87 seconds on the final
expanded run. Review corrections and the two test repairs are listed above.

Only accounting collector/service/store/types/routes/CLI and their tests, minimal
index wiring, the exact write-guard exemption/test, this report/plan and accounting
runbook/source-contract documentation belong to this package. No staging, commit,
push, broker interaction or operational DB operation was performed by this worker.
The unrelated 25 dirty paths and the separately published retained-state package
are outside this scope.
