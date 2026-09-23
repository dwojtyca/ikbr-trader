# PR16A — lifecycle ownership and cancellation uncertainty

Status: independently accepted; all local checks passed.

## Behavior

`GET /execution/lifecycle/:id` reports PENDING_ENTRY, OWNED_POSITION,
FLAT_OBSERVED or BLOCKED using the latest durable reconciliation snapshot,
exact proposal/AI identity, saved broker legs and attributed broker executions.
It uses a single read-only repeatable-read transaction, never calls IBKR and
always returns `readOnly:true` and `canSubmitClose:false`.

The report requires fresh evidence for the current process session and active
account, complete exposure sources, matching registry policy and no active holds
or competing intent. Broker account fields are preserved from the source; missing
accounts cannot be inferred. Position quantities must equal attributed entry
minus exit executions. Positive positions require active SELL protective children;
manual/foreign activity, unmatched or contradictory rows, orphan orders, missing
protection, stale data and insufficient restart history block the report.

The report is a diagnostic observation, not proof of atomic protection or a close
permit. An absent order does not prove cancellation. Restart requires a new
current-session snapshot with executions covering the original attempt; otherwise
ownership remains blocked. A flat observation alone is not a completed trade or
proof of its realized P&L/commissions.

The existing cancel endpoint now returns HTTP409 `CANCEL_UNCONFIRMED` on failed
confirmation and requests reconciliation without terminalizing the proposal.
Code 10147 no longer synthesizes CANCELLED in either automatic cancellation path.
PENDING_CANCEL stays pending; INACTIVE is not cancellation confirmation. Existing
auth/account guards and actual broker lifecycle status handling remain in place.

## Migration

`000008_lifecycle_snapshot.sql` adds nullable JSONB `broker_snapshot` to
`reconciliation_runs`. Existing publication stores raw evidence in the same
transaction as the result. Old runs without this column's evidence fail closed.
No new instrument, strategy, configuration switch or order submission is enabled.
No additional broker polling is introduced. Snapshot retention follows existing
reconciliation-run retention; this adds broker evidence to those records.

## Review and verification

The independent plan reviewer accepted provenance, freshness and active-order
status requirements before implementation. A separate implementation reviewer accepted the code after corrections and
independently ran 132 focused tests plus 26 PostgreSQL tests. Final local checks:

- `pnpm lint`: zero errors, three pre-existing unused-disable warnings.
- `pnpm typecheck` and `pnpm build`: all workspace packages pass.
- `pnpm test`: 1,554 pass in the current workspace (includes pre-existing local
  ES test additions, which are preserved and excluded from this commit).
- `TEST_POSTGRES_URL=... pnpm test:integration`: 609 pass on a dedicated
  disposable PostgreSQL; this repeats execution unit coverage.
- Compiled focused Node tests: 159 pass.
- `git diff --check`: clean.

Earlier unrelated working files were verified unchanged byte-for-byte.
Commit/push uses main directly. GitHub CI result is inspected after the push;
no remote result is claimed by this pre-commit report.
All broker tests use fake transports and disposable PostgreSQL, never real IBKR.
No strategy/simulator changes are included, so no new strategy backtest is needed.

## Next boundary

PR16B must implement full close with independent fresh exposure/ownership checks,
entry and child cancellation reconciliation, quantity caps, durable idempotency,
unknown-result recovery and protection against reversing a position. This report
must not be reused as its authorization token. Paper remains unlaunched.

## Review corrections

The previous main CI log exposed a race in PR15.6 risk evidence. The correction
serializes pre-submission refusal recording with the proposal row lock and leaves
successful evidence publication to the atomic claim. A deterministic PostgreSQL
test forces overlapping transactions and verifies committed evidence survives.
The existing concurrent-execution test still proves a single dispatch.

`INACTIVE` also no longer maps to CANCELLED through the global broker-status
repository callback. Raw invalid or unsupported execution times remain unavailable
through adapter/JSON persistence instead of being replaced with current time.

`EXECUTION_BROKER_TIME_ZONE` defaults to unset. Explicit UTC/GMT timestamps are
supported; zone-less timestamps require an explicit `UTC` value and verified
broker output in UTC. Unknown explicit zones, missing times and invalid calendar
values always block ownership. This prerequisite must be checked before Paper;
the application never assumes the host timezone or invents a current timestamp.
