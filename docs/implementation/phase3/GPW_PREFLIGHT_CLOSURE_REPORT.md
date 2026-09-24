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
all PASS. Lint has three pre-existing warnings and zero errors. Clean Docker build
PASS: `sha256:42b144e9bbb2ecf99c0a99864f54cb1adade303047ff36b998bfbcc2eb5b11da`.
All 29 unrelated research files retain their baseline hashes. No strategy changes
were made; no separate backtest run is required.
Targeted unit, HTTP-auth and PostgreSQL production-runner tests pass, including
legacy-hold proof, approval revocation, aggregate oversell, unknown holds, permId
and nonzero broker-order-ID collisions, empty-day generation/fill races and the
actual UTC execution filter sent on the wire.

Delivery remains on main with explicit staging. Unrelated research files and
secret configuration are excluded. The deployment will keep trading and the
scheduler disabled; no AI call, order submission, cancellation, position close or
entry-window activation is part of this task. Operational evidence and exact CI
results will be recorded after verification and deployment.
