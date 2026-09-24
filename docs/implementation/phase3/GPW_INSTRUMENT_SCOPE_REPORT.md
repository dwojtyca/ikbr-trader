# GPW — instrument-scoped round-trip acceptance

Independent plan and implementation reviews ACCEPT by different reviewers.
Plan: [GPW_INSTRUMENT_SCOPE_PLAN.md](GPW_INSTRUMENT_SCOPE_PLAN.md).

The read-only round-trip report now proves completion for its verified account,
instrument binding and conId. Target position must be flat in both broker and
position-snapshot evidence, and no target working orders may remain. Known other
contracts can remain open: `completionScope=INSTRUMENT` and `outsideScope` describe
their nonzero positions and working-order count with observation timestamps.
COMPLETED no longer asserts that the entire account is flat.

Canonical contract identities are checked before exclusion. Missing/malformed
identity, owned-order identity collisions, residual target exposure/orders,
duplicate snapshot positions, stale/wrong-session/incomplete data, holds and
non-CLEAN reconciliation remain blockers. The existing exact collector excludes
unrelated fills and fees from the target PLN result without deleting their data.

No changes to submission, full-close, account-wide risk, cash/exposure caps,
AI approval, window/day budget or reconciliation requirements. Other positions
can still block through those account-level controls. No strategy behavior changed
and no backtest tuning was performed. Runtime code changes are confined to the
round-trip evaluator; documentation describes the updated operational acceptance.

Validation in a clean committed-source copy plus the reviewed patch:

- Independent reviewer reran all157 targeted unit/route/risk tests successfully.
- PostgreSQL collector fixture passes before and after an unrelated SMR sell:
 4172 shares, a manual sell order, separate USD fills/fees, unchanged target PLN
 accounting, and no state mutation during report collection.
- Full lint, typecheck, unit tests, PostgreSQL integration tests and build PASS.
 Lint retains three pre-existing warnings and no errors.
- Relative documentation links and diff whitespace checks pass. All29 unrelated
 research files and the operational .env retain their baseline hashes.

No service deployment, broker trade/cancel or paid provider call was performed.
SMR does not need to be closed solely for this test's acceptance scope. Current
quotes, completed-order reconciliation coverage and all other preflight gates
still require resolution/verification before an authorized Paper entry. Commit,
push on main and exact-commit CI verification follow this report.
