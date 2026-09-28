# PR15.5 — Controlled entry-only Paper E2E unlock for one instrument — PLAN (r6)

## Documentation status — 2026-09-28

Historical plan/report: dates, test counts, commit evidence, limitations and
next-step instructions below describe the original work package. They are retained
as evidence, not the current delivery queue or authorization to activate trading. Frozen ES verdicts and experiment artifacts are unchanged; research is
deferred off the production-Paper critical path. Local PR15.5F drafts are not shipped
capability or prerequisites.

Current authority: [capability/evidence matrix](../CURRENT_STATE.md) and [detailed delivery plan](../phase3/PAPER_PRODUCTION_DELIVERY_PLAN.md).

## Historical work-package record

Document type: decision/gating only

Status: blocked; reconciled against terminal evidence on 2026-09-23

Priority update: this is the ES eligibility branch, now deferred. The owner's
current priority is [one-instrument Paper mechanics](PAPER_MECHANICS_DELIVERY.md)
on a supported instrument before strategy tuning. Its next PR is not gated on
finishing F or achieving ES compatibility; no ES activation is authorized.

## 1. Current decision

PR15.5 does not authorize activation, Paper E2E, a backtest, data acquisition,
or broker operations.

PR15.5A completed the static compatibility audit with terminal result
`INCONCLUSIVE`. PR15.5B/C/C.1 subsequently supplied the futures model and
immutable dataset. PR15.5D.3 completed three reproducible real-data scenarios
with zero trades and terminal `REJECTED_FOR_ES`. The current blocker is negative
compatibility evidence, not a missing backtest model. `executionEnabled=false`
remains unchanged and no fixed ES execution policy is approved.

## 2. Closed prerequisite

PR15.5A established the following historical baseline:

- the momentum strategy implementations support only `STK` and `IND`;
- their shared profiles must not claim `ETF`, `CMDTY`, or `FUT` support;
- the backtest engine lacks a complete futures execution-cost, tick, session,
  expiry, and roll model;
- the current mutable, global candle dataset cannot serve as reproducible ES
  research evidence;
- backtest-engine has no test script, so its behavior is not covered by the
  root test gate.

The model, dataset and test-script gaps above were addressed by B/C and later
verification. Production momentum support remains `STK`/`IND`; research-only
ES adapters and mechanical fixtures do not authorize adding `FUT` support.
PR15.5E proves the simulated mechanical path, not broker execution or alpha.

See [PR15_5A_ES_COMPATIBILITY_PLAN.md](PR15_5A_ES_COMPATIBILITY_PLAN.md),
[PR15_5A_ES_DECISION_RECORD.md](PR15_5A_ES_DECISION_RECORD.md), and
[PR15_5A_REPORT.md](PR15_5A_REPORT.md).

## 3. Mandatory next sequence

Completed prerequisite work must not be repeated as a new approval sequence:

1. B/C/C.1 foundations are implemented; D.3 is closed `REJECTED_FOR_ES` and
   its identity must never be reused.
2. Finish PR15.5F diagnostic preparation, including the 2026-09-23 review
   findings, then seek its separate full-replay/AC gate.
3. Use completed F evidence to propose at most one preregistered research
   hypothesis with independent validation and frozen acceptance criteria.
   A new strategy or parameter change needs its own approved scope.
4. Only a credible `ACCEPTED_FOR_ES` result from a separately authorized new
   experiment may lead to a production eligibility/activation PR. No result
   is presumed, and F itself cannot generate this verdict.
5. Complete minimum monitoring, review a current one-instrument Paper runbook,
   and approve activation/window separately. See the updated
   [deferred ES sequence](PHASE_2_ROADMAP.md#deferred-es-pr-sequence--historical-proposal-from-the-2026-09-23-audit).

## 4. Safety gate

This gating document grants no execution permission. Until separately approved:

- do not add `FUT` to either momentum strategy implementation or profile;
- do not enable execution for an ES instrument;
- do not run a Paper E2E attempt;
- do not perform broker operations.

Read-only evidence review and research work follow their separately approved
sub-track scope. The old prohibition on all result interpretation is superseded
by the completed D.3 evidence and approved F diagnostics; it is not a blanket
authorization to acquire data or run another experiment.

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
- Next work if the deferred ES branch resumes: finish PR15.5F preparation under its plan and
  review checklist; full replay requires the separate gate in that plan.
- `executionEnabled=false` remains in force.
- No Paper E2E or broker operations are authorized.
