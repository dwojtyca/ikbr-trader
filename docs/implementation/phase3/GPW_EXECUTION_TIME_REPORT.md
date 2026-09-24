# Execution timestamps and reconciliation failure — 2026-09-24

## Defect and correction

The stopped Paper observation exposed two defects. The Gateway was explicitly
configured for Europe/Warsaw and emitted bare execution timestamps with a double
space between date and time. The snapshot parser accepted only UTC/GMT or bare
UTC with explicit configuration, so it produced Invalid Date. Phase C attempted
to persist that value as an observation timestamp; PostgreSQL rolled back the
result transaction, leaving the earlier RUNNING record.

The [accepted plan](GPW_EXECUTION_TIME_PLAN.md) and consistency amendment deliver:

- Explicit UTC or Europe/Warsaw configuration for bare execution timestamps.
  Calendar validation and Warsaw round trips reject nonexistent/ambiguous DST
  times; no host/exchange-based timezone guessing. Explicit UTC/GMT stays
  authoritative. Supported calendar years are 2000–2100.
- The same parser normalizes the execution-fill callback to canonical UTC ISO.
  Untrusted time becomes absent, while the fill event itself remains present;
  the real repository test verifies NULL rather than a fabricated timestamp.
- Snapshot timestamps are validated before reconciliation matching. Invalid or
  missing execution times cannot borrow the capture timestamp.
- Phase C failure finalization writes only the matching account/session RUNNING
  record as FAILED, under the snapshot lock, without replaying snapshot,
  observation, hold or lifecycle writes. A committed terminal result cannot be
  overwritten after an ambiguous COMMIT; finalizer failure/no-op propagates.

Independent reviewers accepted the plan, amendment and implementation. No strategy,
Risk Engine, AI gate, submission, budget or trading activation behavior changed.
No historical database rows were directly edited to manufacture readiness.

## Validation

Targeted tests passed: 10 PostgreSQL tests cover runner failure/rollback/finalizer
and the real TWS callback-to-repository path, including eight timestamp cases.
Parser/TWS tests cover summer/winter, leap dates, bounds, DST gaps/folds,
unsupported suffixes, malformed data and explicit timezone requirements.

The 29 unrelated research files are preserved;
private broker records, accounts, quantities and identifiers are excluded here.

Clean-copy checks: lint PASS (three existing warnings), typecheck PASS,
unit suite 2,156 passed/19 skipped without DB, isolated PostgreSQL integration
1,269 passed/zero skipped, build PASS. Docker build PASS, image digest
`sha256:810571ed81c7d5f942402d82891bf75bbba574c405e1450fec3f3d07cf3c8705`.

## CI and disabled deployment

Code commit `fad351e90f90c9bfed5c265104c55739cf8995da` passed
[GitHub CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/36011009435).
The reviewed image was deployed to execution-engine only, with explicit
`EXECUTION_BROKER_TIME_ZONE=Europe/Warsaw`. Execution writes and the signal loop
remain disabled; the AI worker remains stopped and monitoring remains paused.

Actual broker executions now persist with finite UTC times matching the inspected
Gateway local-time evidence. Two explicit post-deployment reconciliation captures
finished durably rather than remaining RUNNING. No invalid-timestamp persistence
error or reconciliation tick failure appeared in the inspected deployment log.
No old database status or snapshot was manually rewritten.

The current result is **INCOMPLETE**, not launch-ready: completed-order coverage
reports `completed_record_invalid`. This is a separate adapter validation blocker
that must be diagnosed before another supervised entry window. Exposure coverage
is complete, but recovery coverage is not. `/ready` returns HTTP 200 with writes
disabled; that alone is not acceptance for trading. The disabled stack verifier
reports UNHEALTHY, so no new Paper test was activated.
