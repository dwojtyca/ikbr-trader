# Validation and rollout

Updated 2026-09-26. [Current evidence](../CURRENT_STATE.md) is distinct from
[future production-Paper acceptance](../../runbooks/PRODUCTION_PAPER_ACCEPTANCE.md).

## Repository checks

Use declared Node/pnpm versions and frozen lockfile installation. Code/versioned
configuration changes require pnpm lint, pnpm typecheck, pnpm test,
pnpm test:integration with an isolated PostgreSQL16 database, and pnpm build.
Strategy/simulator changes also require relevant backtests. Deployment changes
require a clean Docker build. Independent plan and implementation reviews precede
scoped commit/push and exact-commit CI verification on main.

Documentation-only work receives plan/document review, fact/link/example checks
and staged-diff validation; do not rerun unchanged runtime suites solely for prose.
CI still runs for the exact pushed commit. Preserve unrelated dirty work.

## Database isolation

Standard CI sets TEST_POSTGRES_URL to a disposable database. Never point destructive
fixtures at the operational database. Frozen ES diagnostics use separate research
source/target settings and require real frozen evidence; a blank generic fixture
is not a valid TEST_RESEARCH_POSTGRES_URL. Keep those diagnostics out of standard
Paper delivery checks unless their research scope is explicitly selected.

Unit success with DB-gated tests skipped is not integration success. Record pass,
fail and skip counts by command and whether the tested tree is clean/dirty.
Do not report historical CI as validating current uncommitted files.

## Acceptance layers

1. Pure/unit: parameters, identity, risk, schedules, selection and failure decisions.
2. Isolated integration: migrations, claims/idempotency, budgets, ownership, close
   races, config revisions, source snapshots and restart recovery.
3. Adapter/HTTP: auth/proxy boundaries, broker coverage and unknown write handling.
4. Frozen strategy/backtest replay: default behavior and instance parameter parity;
   explicitly separate synthetic mechanics from strategy profitability evidence.
5. Disabled deployment: exact digest/config, compatible schema, current read-only
   broker/account/data/research readiness with entries off.
6. Separately authorized Paper: real signal/AI-approved entry, protection, exit and
   broker-flat proof; then PP7 five-session-per-instrument automated soak.

## Release and rollback

Each stage records code/image/config hashes, migrations and operator authorization.
Deploy with entries disabled. Confirm actual account/environment and source coverage
before writes. Rollback cannot erase attempts or reinterpret existing positions;
keep a compatible execution version for owned positions and reconcile before
resuming. Backups/restores are rehearsed on isolated copies, with broker divergence
since backup treated explicitly. Live is outside this track.
