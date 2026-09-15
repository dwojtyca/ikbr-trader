# PR15.4.1 — Clean-checkout CI and status hardening — PLAN

Status: implementation complete; awaiting commit/push/green CI

## Goal

Close the independent-review findings that prevent PR15.4 from satisfying the
repository Definition of Done. This is a stabilization PR only; it does not
enable trading, activate an instrument, run Paper E2E, or contact the broker.

## Scope

1. Make root `pnpm typecheck` deterministic on a clean checkout by building the
   workspace packages whose public type exports point at `dist` before checking
   their consumers.
2. Declare the direct `pino` dependency used by execution-engine source.
3. Replace raw exception text in trading-loop outcomes with fixed,
   operator-safe messages while retaining raw errors in structured internal
   logs.
4. Add regression tests proving secrets from reconciliation, exposure,
   dry-run, execution, and unexpected per-instrument failures do not reach
   status outcomes.
5. Override vulnerable transitive versions of `fast-uri` and `find-my-way` to
   patched releases and refresh the lockfile.
6. Re-run lint, clean-checkout typecheck, tests, PostgreSQL integration when a
   database is available, build, audit, and `git diff --check`.
7. Reconcile PR15.4 status documentation and record a PR15.4.1 report.

## Acceptance criteria

- A fresh archive plus `pnpm install --frozen-lockfile && pnpm typecheck`
  succeeds without pre-existing `dist` or root `node_modules` artifacts.
- `pino` is a declared execution-engine dependency.
- No raw thrown message is copied into a `TradingLoopInstrumentOutcome`.
- All new redaction tests pass.
- `pnpm audit --prod --audit-level=high` reports no high-severity finding from
  the previously pinned `fast-uri@3.1.0` or `find-my-way@9.5.0`.
- Trading remains fail-closed: every seed has `executionEnabled=false`, and no
  runtime/loop/environment toggle is enabled by this PR.
- Roadmap and reports reflect the actual Git/CI state.

## Out of scope

- PR15.5A implementation.
- Futures backtest changes.
- Strategy-profile narrowing.
- Paper or Live broker operations.
