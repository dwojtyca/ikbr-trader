# PR16B — full close of the mechanical stock position

Status: implemented; independent review ACCEPTED and local validation passed (2026-09-23).
Plan: [PR16B_FULL_CLOSE_PLAN.md](PR16B_FULL_CLOSE_PLAN.md), revision 2 accepted by
independent `pr16b_plan_review`. Implementation review was accepted by the new independent
`pr16b_implementation_review` after fixing both P1 findings (known position
invalidation and missing-close failure reporting). The reviewer independently
ran 133 focused tests and reviewed the 24 PostgreSQL regressions.

## Behavior

The operator can request a full close of an existing, attributable one-share
USD stock long entry. The service reserves the account, validates original AI
approval and broker ownership, cancels the original parent (if still working),
TP and SL in that order, and requires exact terminal acknowledgement. It captures
new broker evidence, checks fresh live quotes and deterministic close risk, then
commits a separate close proposal, exact single SELL LMT plan and one-shot marker
before dispatch. Socket generation checks prevent using authority from before a
reconnect. Each reconciliation run also freezes the local position generation at
capture start; close authority requires the same complete, current-session
position generation and matching position quantities under the account lock.
Known later position invalidation prevents cancellation, submission and completion. Original generic bound CLOSE calls remain blocked.

The close remains SUBMITTED until a fresh broker snapshot proves matching owned
fills, a flat position and no remaining original or close orders. A timeout,
missing cancel acknowledgement, unsupported residual, stale data or unknown broker
submission retains the account reservation and exposes the reason. Replaying the
same request never repeats cancellation/preparation/dispatch. A changed request
conflicts. A partially filled close can remain observed and working; a missing
close with residual exposure becomes an actionable unknown state and critical
alert, with no retry. Read-only reconciliation can establish later completion from exact
execution evidence; it never submits replacement orders.

A completed original protective exit can be recorded without new broker writes.
An empty snapshot without parent terminal evidence cannot establish completion.
Risk-reducing exits retain deterministic authorization independent of a new AI
opinion, as established in the Paper mechanics delivery plan; the original AI
entry decision stays in the audit chain.

## Operator API (after a separately authorized Paper launch)

All paths require the existing execution bearer. POST routes also require normal
TRADING_ENABLED and environment/account policy; no new write exemptions exist.
The original entry proposal ID is the route ID:

- `POST /execution/lifecycle/:id/close` with strict JSON
  `{ "requestId": "<UUID>", "limitPrice": 100.00 }`.
- `GET /execution/lifecycle/:id/close` reads the durable operation.
- `POST /execution/lifecycle/:id/close/reconcile` refreshes broker observations
  and records any proven completion, without broker writes.

There is no background close-observation worker in this slice. After SUBMITTED,
the operator invokes the reconcile endpoint to refresh completion or a later
failure. A late missing/cancelled close raises its critical alert on that explicit
observation; repeated unchanged observations do not duplicate the alert.

GET `/execution/lifecycle/:id` remains the descriptive PR16A ownership report;
it is not permission to close. `SUBMITTED` is not equivalent to flat. Inspect
operation state and broker executions before considering the round trip complete.

## Limits and next step

Only the existing one-whole-share long stock scope is supported. Fractional
residuals, uncertain cancellations and incomplete execution history block
progress. This broker library cannot recover a lost cancel acknowledgement from
completed-order history. Such operations stay reserved for operator investigation;
there is no automatic retry or unsafe release endpoint.

After protective orders are cancelled, a limit close can remain unfilled. A
failure after cancellation can leave the position without protection and emits
a critical alert; the bot does not silently replace orders. The next operational
milestone is a separately authorized, controlled Paper round trip on one bound
instrument, with broker evidence of fill/exit/flat state and recorded costs/P&L.
No strategy tuning or profit claim follows from local tests.

No registry activation, Paper/Live launch, real broker order, paid AI call or
strategy/simulator change is part of PR16B. Existing local ES diagnostics remain
outside this commit. No strategy backtest is required for this lifecycle slice.

## Validation

- `pnpm lint`: passed, with three pre-existing unused-disable warnings.
- `pnpm typecheck`: passed across the monorepo.
- `pnpm test`: 1688 passed, zero failures.
- `pnpm test:integration`: 767 passed, zero failures, on a disposable PostgreSQL 16
  container isolated from trading/research databases. Includes 24 full-close
  service/database tests and a real reconciliation-runner round trip.
- `pnpm build`: passed across the monorepo.
- Compiled execution-engine lifecycle/broker/HTTP/risk regression selection:
  238 passed, zero failures.
- `git diff --check`: passed. Original unrelated ES work preserved byte-for-byte;
  only this delivery's roadmap header is included.

Tests use fake broker events and source data, not a real IBKR session. Exact
historical execution duplicates preserve the position generation; new/changed or
uncertain fills still invalidate it before persistence. GitHub CI is checked for
the exact commit after push to main and reported in the task.
