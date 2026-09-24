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
