# PR15.5 — Controlled entry-only Paper E2E unlock for one instrument — PLAN (r5)

Document type: decision/gating only

Status: blocked

## 1. Current decision

PR15.5 does not authorize activation, Paper E2E, a backtest, data acquisition,
or broker operations.

PR15.5A completed the static compatibility audit with terminal result
`INCONCLUSIVE`. The current backtest and dataset foundations cannot produce
credible ES compatibility evidence, so `executionEnabled=false` remains
unchanged and no fixed ES execution policy is approved.

## 2. Closed prerequisite

PR15.5A established that:

- the momentum strategy implementations support only `STK` and `IND`;
- their shared profiles must not claim `ETF`, `CMDTY`, or `FUT` support;
- the backtest engine lacks a complete futures execution-cost, tick, session,
  expiry, and roll model;
- the current mutable, global candle dataset cannot serve as reproducible ES
  research evidence;
- backtest-engine has no test script, so its behavior is not covered by the
  root test gate.

See [PR15_5A_ES_COMPATIBILITY_PLAN.md](PR15_5A_ES_COMPATIBILITY_PLAN.md),
[PR15_5A_ES_DECISION_RECORD.md](PR15_5A_ES_DECISION_RECORD.md), and
[PR15_5A_REPORT.md](PR15_5A_REPORT.md).

## 3. Mandatory next sequence

The sequence cannot be skipped:

1. prepare, review, and approve `PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md`;
2. implement and verify the PR15.5B futures backtest model;
3. prepare and complete PR15.5C isolated reproducible ES dataset foundation;
4. prepare and complete PR15.5D ES compatibility experiment;
5. only a credible `ACCEPTED_FOR_ES` result may lead to a separate production
   activation PR.

## 4. Safety gate

Until the mandatory sequence is complete:

- do not add `FUT` to either momentum strategy implementation or profile;
- do not enable execution for an ES instrument;
- do not run a Paper E2E attempt;
- do not fetch or interpret ES research results;
- do not perform broker operations.

## 5. Git gate

The previous Git/CI prerequisite is satisfied:

- `2bbc24f`, `53213fe`, and stabilization commit `8a2f923` are present on
  `origin/main`;
- GitHub Actions run `34979744641` for `8a2f923` completed successfully on
  2026-09-15.

This closes only the repository-state gate. It does not authorize PR15.5
activation.

## 6. Final verdict

- PR15.5 activation: `blocked`.
- Next allowed action: prepare, review, and approve
  `docs/implementation/phase2/PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md`.
- `executionEnabled=false` remains in force.
- No Paper E2E or broker operations are authorized.
