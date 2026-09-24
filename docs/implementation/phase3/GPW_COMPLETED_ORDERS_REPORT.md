# GPW completed-order reconciliation — implementation report

## Delivered behavior

The production reconciliation adapter now requests the retained completed-order
list through a dedicated read-only `@stoqey/ib` socket (default client120).
Managed-account handshake, record validation, capture timeout/abort, serial
requests and execution-session generation fencing protect the composite snapshot.
The auxiliary socket waits for confirmed asynchronous disconnect; an unconfirmed
shutdown blocks reuse until restart. A stateless terminal error listener prevents
late SDK errors from becoming unhandled process errors.

The list completes current-state recovery coverage only when no ambiguous
submission exists. The runner rechecks ambiguity after capture and downgrades
snapshot, report and status before publication if an attempt appeared meanwhile.
An old ambiguous attempt retains `completed_historical_window_unproven`; empty
responses never prove non-submission. Readiness checks both available and bounded.
The installed decoder omits API order IDs: rows keep explicit null IDs for
diagnostics and cannot create recovery matches or correlated order observations.
Existing positive-ID recovery, account/risk/hold gates and write switches remain.

Coverage consumers audited: completeness derivation and readiness require bounded
completed-order coverage; the existing submission gate and signal reconciliation
reader deliberately enforce exposure coverage plus identity holds. The round-trip
collector requires CLEAN. No unrelated consumer was relaxed.

## Review and verification

- Independent plan review: ACCEPT after adding the during-capture ambiguity race
  and available-but-unbounded readiness regression.
- Separate implementation review: ACCEPT after fixing asynchronous SDK shutdown;
  reviewer independently ran 25 client/adapter/config unit tests.
- New PostgreSQL tests: actual production adapter with fake socket, clean empty
  completion, unavailable source, null-ID records and a new attempt during capture.
  Persisted snapshot, readiness, proposal state and unresolved recovery hold checked.
- Full clean-copy `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:integration` on isolated PostgreSQL16, and `pnpm build`: PASS.
  Unit tests: 2042 passed; integration command: 1153 passed.
  Lint reports three pre-existing warnings, zero errors.
- Clean Docker build: PASS, image digest
  `sha256:1c7195a989c9bfc2079fb5763c5465cb983443fb9281e2814794bedfe81793c4`.
- Direct read-only probe of the real Paper Gateway: two serial captures completed,
  both with zero retained completed orders and confirmed socket cleanup.
- No strategy/simulator changes; no separate backtest required. All 29 unrelated
  research files retain their baseline hashes. Local secret environment unchanged.

## Operational status before deployment of this change

At 2026-09-24 10:05 UTC, the prior c5e8576 deployment had real-time PKO data,
exact PKO-only watchlist, 5811.07 PLN cash and no configured entry window.
All six native history counts met minimums; the newest closed 4h bar was still
from the prior session, so counts alone did not establish usable strategy context.

SMR remained an external position with a pending manual SELL. Its open order
created an `orphan_broker_order` warn hold because current reconciliation treats
all non-owned open orders as orphaned. This change intentionally does not clear
that hold or change ownership policy. It removes the unsupported completed-source
limitation, not every launch blocker. A successful source may therefore yield
MISMATCH rather than CLEAN while that order remains. Before any PKO activation,
this needs a separately reviewed explicit external-order handling solution;
forcing hold resolution or linking SMR to a bot proposal is not valid evidence.

Delivery proceeds with explicit staging, main commit/push, exact GitHub CI, then
disabled-write deployment and repeated read-only preflight/reconciliation.
No broker submission, cancellation, close, AI provider call or trading window is
authorized or performed by this implementation. Post-deployment observations are
reported separately; this report does not claim a completed Paper round trip.

## Post-deployment verification — 2026-09-24 10:15 UTC

Code commit `e0d3f4f176b7953988e1360704f0157c19992b81` was pushed to main.
[Exact-commit CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/35985813114)
passed lint, typecheck, unit tests, PostgreSQL integration and build. The reviewed
image was tagged `ikbr-trader-gpw:e0d3f4f` and deployed to execution-engine only;
ingestion/signal retained the compatible c5e8576 image to avoid interrupting data.

Explicit read-only reconciliation run74 returned `MISMATCH`, with
`exposureComplete=true`, `recoveryComplete=true`, zero position mismatches,
zero ambiguous proposals and one active SMR orphan-order hold. Completed-order
source was available/bounded, zero retained rows; the unsupported-source blocker
is resolved. No hold was cleared and SMR was not modified.

Disabled-write verifier returned `UNHEALTHY` (exit30): 9 healthy, 2 intentionally
disabled and 3 unhealthy checks. Concrete remaining issues:

1. SMR manual SELL remains `orphan_broker_order`. Explicit trusted external-order
   recognition needs design/review without weakening unknown-order/PKO identity
   safeguards. The position itself need not be closed to support scoped PKO tests.
2. Daily-loss diagnostics report `complete=false` with zero missing FX and zero
   missing commissions. Read-only SQL confirmed zero fills today; current
   `aggregateRealizedPnL` marks an empty local set incomplete. A follow-up needs
   broker-backed evidence of an empty day, not unconditional zero-PnL acceptance
   and not disabling the kill switch.
3. Signal `runtime/execute/ready` fails its Paper guard because `HttpReadyProbe`
   sends no token to execution `/ready`, while actual production auth exempts only
   `/health`. The returned error lacks `environment`; this is an authentication
   integration defect, not evidence of a live account. Follow-up must authenticate
   the internal probe and retain the fail-closed response checks.

PKO-only subscription and real-time feed worked; latest completed 4h history was
still from the preceding session. Current explicit PLN cash: 5811.0746. Risk
account evidence was complete, including explicit USD metrics and PLN FX. No entry
window configured; TRADING_ENABLED=false and scheduler false throughout. The AI
worker was not started and no paid provider call was made. No new user credentials,
PLN funding or forced SMR close is needed for the next code fixes. Launch remains
blocked until those checks pass, history is usable and a supervised window is
explicitly authorized.
