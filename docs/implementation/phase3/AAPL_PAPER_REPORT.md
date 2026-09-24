# Supervised AAPL profile — implementation report

The [independently accepted plan](AAPL_PAPER_PLAN.md), including the USD round-trip
assessment amendment, is implemented. The separate completed-order compatibility
fix is deployed and actual disabled reconciliation is CLEAN; see
[its report](COMPLETED_ZERO_TOTAL_REPORT.md).

## Delivered behavior

- Disabled-by-default exact AAPL profile, explicit Paper-only opt-in, mutually
  exclusive with GPW. Existing default momentum strategy, one whole share,
  LONG/LMT/DAY with required protection and regular-hours configuration.
- Additive durable AAPL window tables and bindings. Exact identity gates cover
  proposal creation, preparation, atomic budget consumption and broker dispatch.
  One consumed attempt per account/New York date survives restart and unknown
  dispatch. Expiration is checked again at the first wire. Supported close is exempt.
- Explicit USD cash and absolute notional/stop/fee-reserve controls retain the
  existing account-wide, percentage, quote, protection and mandatory AI gates.
- Exact AAPL omits legacy mislabeled 12h inputs while retaining the six required
  timeframes and existing minima/freshness. Strategy-context and production-loop
  regression tests prove the intended input path; no profitability claim is made.
- Read-only round-trip evidence uses persisted AAPL window association and USD
  fills. USD gross/net accounting preserves mixed-fee-currency refusal to fabricate
  net results, and keeps the existing GPW PLN output compatible.
- [Operator runbook](../../runbooks/AAPL_PAPER_ROUND_TRIP.md) records deployment,
  data/account/window gates, supervised close and evidence collection.

Five generic legacy PostgreSQL fixtures were renamed from real-AAPL aliases to
neutral synthetic identities so legacy idempotency tests do not bypass new AAPL
controls. No unrelated research implementation was changed; all 29 baseline files
remain byte-for-byte intact.

## Verification and delivery status

Independent implementation review accepted the scope. The reviewer independently
passed 135 execution/risk/window/accounting unit tests, 112 context/loop tests and
9 isolated PostgreSQL tests. Full clean-copy results: lint and typecheck PASS;
2,229 unit tests passed, 23 database-dependent tests skipped without DB; 1,351
isolated integration tests passed with zero skipped; build PASS. An initial unit
run found a stale expected seed catalogue list, which was corrected and reviewed.
Docker build PASS, image digest
`sha256:f7a05e6cf5f302287f86a8a3925bc2e5d31e6b5cd43dded78b78a959f4d7b26e`.
Exact-commit CI for `b9ca5d8043ecaf496787ca19ef518a5ac3be8243` passed
([run 36018385456](https://github.com/dwojtyca/ikbr-trader/actions/runs/36018385456)).
The reviewed image was deployed with writes and loop disabled; the AI worker
remained stopped.

The initial disabled preflight observed unavailable realtime API data and
insufficient USD cash. Subsequent fresh broker evidence confirmed marketDataType1
quotes and sufficient explicit USD cash. No delayed-data fallback or borrowing
bypass was enabled. Two separate code defects then blocked activation: FX CASH
fills were compared as securities positions, and recent incomplete aggregate
history suppressed native higher-timeframe downloads. Follow the
[CASH classification plan](CASH_RECONCILIATION_PLAN.md) and
[native history plan](AAPL_NATIVE_HISTORY_PLAN.md) for the bounded corrections.
The earlier CLEAN reconciliation preceded the currency conversion; it is not
proof of current readiness. No new AAPL order or supervised trading window has
been started.
