# PR15.4.1 — Clean-checkout CI and status hardening — REPORT

Status: implementation complete locally; awaiting commit/push/green CI

Date: 2026-09-15

## Outcome

The independent-review blockers discovered after PR15.4 are fixed locally.
The change remains a stabilization-only update: no instrument was activated,
no trading toggle was enabled, and no broker operation was performed.

## Changes

- Root `pnpm typecheck` now runs a `pretypecheck` step that builds
  `@ikbr/shared` and `@ikbr/signal-engine`, whose package exports reference
  generated declarations in `dist`.
- Execution-engine declares its direct `pino` dependency.
- Trading-loop exception paths retain raw errors in structured internal logs
  but expose only fixed operator-safe outcome messages.
- Five regression tests cover reconciliation, exposure-reader, market-data
  dry-run, `executePrepared`, and unexpected per-instrument exceptions.
- pnpm overrides move `fast-uri` from `3.1.0` to `3.1.6` and `find-my-way`
  from `9.5.0` to `9.7.0`.
- PR15.4 roadmap/report status now matches Git reality.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` in a fresh copy without `node_modules` or `dist` | pass |
| clean-copy `pnpm typecheck` | pass |
| `pnpm lint` | pass with 3 pre-existing unused-disable warnings |
| `pnpm typecheck` | pass |
| `pnpm --filter @ikbr/signal-engine test` | pass — 416/416 |
| `pnpm test` | pass — 1209 total, 0 failed |
| PostgreSQL integration via isolated test databases | pass — execution-engine 371/371, 0 failed, 0 skipped |
| `pnpm build` | pass |
| `pnpm audit --prod --audit-level=high` | pass — 0 high, 2 moderate remain |
| `git diff --check` | pass |

PostgreSQL tests connected through the administrative `postgres` database and
created/dropped only their own disposable `ikbr_*test_*` databases. The
application database `ikbr_trader` was not used as a test target.

## Hostile review

1. Verified the original CI failure on an archive without generated artifacts.
2. Verified that building only `@ikbr/shared` exposed the undeclared `pino`
   import, and that building only shared plus declaring `pino` exposed the
   backtest dependency on signal-engine declarations.
3. Verified the final `pretypecheck` ordering on a second fresh copy.
4. Searched production seeds after the change: no `executionEnabled=true`.
5. Searched trading-loop outcomes: no remaining direct copy of a caught
   exception into `outcome.message`.
6. Confirmed `fast-uri@3.1.6`, `find-my-way@9.7.0`, and direct `pino@10.3.1`
   resolution with `pnpm why`.

No additional blocker was found in the PR15.4.1 diff.

## Remaining items

- GitHub CI remains red for current remote SHA `b6d84c2` because these fixes are
  not committed or pushed yet. A new CI run is required after push.
- Two moderate dependency advisories remain; they are below this repair's
  high-severity gate and should be handled in a separate dependency update.
- Backtest-engine still has no test script. That known gap remains a hard
  prerequisite for the future futures-model work in PR15.5B.
- PR15.5 and PR15.5A remain blocked; no Paper E2E or broker operation is
  authorized by this report.
