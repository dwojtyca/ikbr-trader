# GPW preflight closure — implementation report

## Behavior

Explicit, short-lived external manual SELL approvals are matched against the full
broker identity, durable permId and current long position. Aggregate remaining
quantity cannot exceed that position; unknown competing orders, protected bot
contracts, expired approvals and persisted ownership collisions remain blocked.
Legacy orphan holds require the exact persisted historical snapshot and permId
before audited resolution. Removing approval restores the orphan hold. Recognition
never grants permission to submit, cancel or manage the external order.

Empty local daily fills remain incomplete unless a fresh current-session broker
snapshot proves an empty UTC day and completed account data explicitly reports
zero USD realized P&L. Connection, position-generation and synchronous fill fences
invalidate this evidence. The consumer may refresh readonly reconciliation once,
then rereads and revalidates everything; it does not refresh accounts in a loop.
Nonempty-day P&L and commission/FX handling are unchanged.

Signal runtime now authenticates its protected execution readiness probe with the
existing token. Missing/wrong credentials, redirects, malformed responses and
inconsistent readiness fail closed without leaking the token. Disabled-write
status is preserved.

## Verification and delivery

Independent plan review accepted the plan and the bounded readonly refresh
amendment. Separate implementation review accepted after two fixes: persisted nonzero
broker-order-ID collisions and the ordering of recovery completeness checks before
external hold resolution. The reviewer independently ran 51 unit/HTTP tests.
Twelve targeted PostgreSQL tests pass, including a new ambiguous proposal arriving
during capture: recovery becomes incomplete and the external orphan hold remains.
Full clean-copy lint, typecheck, unit tests, PostgreSQL integration and build
all PASS (2095 unit passes; 1210 integration-command passes). Lint has three pre-existing warnings and zero errors. Clean Docker build
PASS: `sha256:42b144e9bbb2ecf99c0a99864f54cb1adade303047ff36b998bfbcc2eb5b11da`.
All 29 unrelated research files retain their baseline hashes. No strategy changes
were made; no separate backtest run is required.
Targeted unit, HTTP-auth and PostgreSQL production-runner tests pass, including
legacy-hold proof, approval revocation, aggregate oversell, unknown holds, permId
and nonzero broker-order-ID collisions, empty-day generation/fill races and the
actual UTC execution filter sent on the wire.

Delivery remains on main with explicit staging. Unrelated research files and
secret configuration are excluded. The deployment keeps trading and the
scheduler disabled; no AI call, order submission, cancellation, position close or
entry-window activation is part of this task. Operational evidence and exact CI
results are recorded below.

## Deployed verification — 2026-09-24 10:57 UTC

Code commit `a9a04fc492e22551249913f4c2ee69f987711306` is on main;
[exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/35989831733)
passed. Execution and signal use `ikbr-trader-gpw:a9a04fc`; ingestion remains on
its compatible c5e8576 image. Both deployed write and scheduler switches are false.

Local .env contains an exact, short-lived approval for the owner-confirmed external
manual order. Account identifiers, broker order identifiers, balances, quantities,
P&L values and approval contents remain only in private local evidence.
Reconciliation resolved the corresponding orphan hold through its audited
historical-identity validation path. Subsequent runs are CLEAN with complete
exposure/recovery and no active holds. Existing external broker state was not
modified by this deployment.

The daily-loss evidence check is complete and the protected execution readiness
endpoint returns200 for paper with writes disabled. Exact financial observations
are deliberately omitted from this versioned operational report.

The disabled-write stack verifier returns HEALTHY, exit0: 12 healthy checks,
2 intentionally disabled scheduler checks, no degraded/unhealthy/unreachable or
configuration failures. Authenticated internal signal readiness correctly reports
the write switch rather than an authentication error.

PKO is the only subscribed/bound instrument, with real-time market-data type1.
All six native closed history counts exceed their minimums. At10:57 UTC the latest
4h bar still starts on the previous session (2026-09-23 12:00 UTC); counts and the
disabled scheduler response do not prove current strategy freshness. A supervised
entry window must still validate fresh closed4h context, all indicators, current
BBO age, broker liquidHours and every risk/AI gate at actual evaluation time.
No entry window is configured, no AI worker was started, no paid AI call or broker
write was made. The three preflight defects are closed; a completed PKO trade or
strategy profitability has not been demonstrated by this infrastructure check.

The isolated verification PostgreSQL container was removed. The 29 unrelated
research-file hashes remain unchanged after deployment.
