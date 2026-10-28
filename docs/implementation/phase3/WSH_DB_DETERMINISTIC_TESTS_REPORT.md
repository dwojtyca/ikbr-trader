# Deterministic WSH database tests: implementation evidence

Date: 2026-10-28. Status: implementation, focused checks and independent hostile
final review accepted; full local validation and clean Docker build passed.
Publication and exact-commit CI remain pending. Baseline: research diagnostics commit `4af8830`.

## Change and preserved behavior

The [accepted plan](WSH_DB_DETERMINISTIC_TESTS_PLAN.md) replaces real scheduler
timing assumptions in `packages/shared/src/instrument-research/wsh-db.test.ts`.
Only that test file and this package's plan/report are changed. Production
`wsh-db.ts` and `store.ts` remain unchanged, including every timeout, monotonic
budget, wall-clock conversion, rejection and resource-cleanup condition.

The test fixture controls `performance.now()`, wall-clock samples and Node's
deadline timers together. Deferred pool/query completions and explicit phase
signals establish when work is actually pending. The tests retain initial-query
success, original cumulative/attempt budgets, counted rollback at the original
handoff, one wall-clock sample, late destructive release exactly once and no
late COMMIT/business-query continuation. The old real elapsed `<200 ms` checks
become pending-at-19/timeout-at-20 logical millisecond checks. A documented native
event-loop checkpoint drains the finite late promise continuation after a
timed-out wrapper; it is not a latency measurement or a deadline extension.
The file-local fixture also owns each deferred and observed wrapper promise.
Test-context cleanup resolves held dependencies and observes their finite
continuations before automatic clock/timer restoration, including when an
assertion fails. Original test promises retain their assertions; cleanup cannot
convert a failure into success.

All ten scenarios remain; no skips, retries or lower test-runner concurrency are
introduced. No broker, provider, operational database or recovery action is
performed by this package.

## Original failure evidence and limits

The exact baseline Linux Node 24.20.0 image passed 40 focused recovery diagnostics
tests, then its full `CI=true pnpm test` failed in the shared package with
697 passing, 96 skipped and three failing tests (796 total). The first query
unexpectedly expired in the 50 ms cumulative-operation and 25 ms attempt tests.
The connection-handoff test expected release `[true]` and observed `[]`; that
assertion does not identify whether admission had already expired or a later
continuation was delayed. Its retained local log is
`/private/tmp/ikbr-exact-4af8830-unit-linux.log`.

The detailed GitHub CI failure log for `4af8830` was unavailable. These local
failures are not claimed to be the GitHub failure cause. Passing repaired local
tests will not by itself prove exact-commit CI success or bot readiness.

## Focused validation

At the stable handoff after the review cleanup correction:

- Host Node 24.4.1: `node --import tsx --test
  src/instrument-research/wsh-db.test.ts` from `packages/shared`: 10/10 pass,
  exit 0, approximately 0.20 seconds.
- Linux Node 24.20.0: the exact baseline image with only the changed test file
  mounted read-only, network disabled, `CI=true`, no PostgreSQL URL: three
  bounded focused runs, each 10/10 pass, exit 0 (approximately 0.24, 0.17 and
  0.14 seconds). This overlay check is not a clean-image build claim.
- Existing shared recovery diagnostics plus backend/host recovery CLI tests:
  40/40 pass on host Node 24.4.1, exit 0.
- Shared TypeScript `tsc -p packages/shared/tsconfig.json --noEmit`: exit 0.
- Changed-file ESLint: exit 0.
- Independent review fault probe deliberately failed an early assertion in a
  temporary copy: one expected failure, nine other tests passed, no hang or
  cleanup cancellation. This supports cleanup on the assertion-failure path;
  the versioned test file was not changed by that probe.

## Full validation

The clean archive of `4af8830` plus only the three scoped files was validated in
`/private/tmp/ikbr-wsh-db-deterministic-20261028`.

- Host `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: exit 0.
  Unit totals: 4,277 tests, 3,921 passed, 356 skipped, zero failures. Lint retained
  two existing unused-disable warnings.
- Clean application Docker build: exit 0; candidate ID
  `sha256:fc370999adda9f33e79c811cfcb4c0d39ca8b6319643a18b999807f00586ab44`.
- The first full Linux unit run reached two Compose-binding tests that failed
  with `spawnSync docker ENOENT`: the application image lacks Docker CLI.
  A temporary validation-only derivative copied Docker CLI and Compose from
  official `docker:cli`; no daemon socket was mounted and application source
  stayed unchanged. Full `CI=true pnpm test` then passed at normal concurrency:
  4,277 total, 3,921 passed, 356 skipped, zero failures.
- A single complete `pnpm test:integration` invocation in the original candidate
  against fresh isolated tmpfs PostgreSQL passed: 3,135/3,135, zero skips/failures.
  It used the test container network namespace, loopback port 5432 and
  `ikbr_trader_ci`; no operational database was used. The test PostgreSQL stopped
  after completion.

The validation-only derivative ID is
`sha256:be35091e3fcebdec19ad615418c3c85ff72bdff7de0c70c95ea2aa5dab55c4a3`.
It is not the deployment image. Logs are retained under
`/private/tmp/ikbr-wsh-db-deterministic-*.log`. Exact-commit GitHub CI remains
required before deployment; local checks do not prove operational readiness.

## Routing and review

| Work | Requested / actual route | Result |
| --- | --- | --- |
| Critical diagnosis, plan and test implementation | `gpt-6-astra` / `high`, same actual route | Focused checks pass; no production changes |
| Independent plan review, `wsh_diagnostics_plan_review` | `gpt-6-astra` / `high`, same actual route | ACCEPT after one checkpoint clarification; zero escalations |
| Mechanical full checks | Requested `gpt-5.6-luna`/`low` unavailable; actual `gpt-6-luna`/`low` | All full checks passed; Docker CLI validation environment corrected; no source edits |
| Independent final review, `wsh_diagnostics_final_review` | `gpt-6-astra` / `high`, same actual route | ACCEPT after one cleanup correction; no remaining findings |

Implementation review repair count: one (settle owned deferred work even on
assertion failure). Initial focused tests also passed before that correction;
the final changed file was rechecked above. An initial patch
application was rejected before changes because it combined delete/add for the
same path; the equivalent single-file write then succeeded. Token telemetry and
reliable aggregate work elapsed time are unavailable; measured command durations
are recorded above. The final reviewer is independent of implementation and plan
review. No completed publication or CI success is claimed here.
