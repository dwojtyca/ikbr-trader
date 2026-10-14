# Marketaux daily budget recovery evidence

Date: 2026-10-14. [Accepted plan](MARKETAUX_BUDGET_ROLLOVER_RECOVERY_PLAN.md).
Status: implementation, independent hostile review, required local suites and
clean image build passed. Publication, exact-commit CI and deployment pending
at source freeze; their actual results are recorded separately after publication.

## Observed incident

AAPL retained an incomplete Marketaux ERROR with local reason
RESEARCH_BUDGET_EXHAUSTED after the account/provider UTC budget renewed.
Its cutoff was 2026-10-13T17:44:59Z; the original snapshot recorded the failure
at 17:45:33.967Z and its slot was published at 17:45:34.002043Z. Later calendar
snapshots copied that coverage. The new snapshot creation time therefore cannot
establish the failed acquisition's budget day.

The last read-only check at 2026-10-14T08:46Z found entries paused at revision 29,
fresh CLEAN reconciliation, zero positions/orders and a healthy observer. This
is operational evidence at that time, not launch or trade acceptance.

## Implemented behavior

An exact local Marketaux budget failure is assessed against its original slot,
canonical coverage and reservation history. Recovery requires proven prior-day
pooled exhaustion, matching successful original calls (or proven refusal before
the first call), and available current UTC budget. Missing, mismatched, pending,
UNKNOWN or FAILED original call evidence does not qualify. Original publication
crossing a slot boundary remains conservatively held because rejection-time
provenance is unavailable. Current AAPL's observed original publication fits
the supported interval; complete ledger assessment is still an operational gate.

The assessment permits WAITING only. The on-demand worker must acquire a fresh
complete two-pass result before normal eligibility can become READY. Atomic
reservation limits, authority, qualifications, other-source holds, proposal
binding and entry controls remain unchanged. Old evidence is immutable.

Budget HOLD discovery uses bounded rotating batches, a 60-second throttle and
UTC-midnight reset; restart scans immediately. Ordinary WAITING work retains its
cadence. Polish output explains local pooled usage, reset and original failure
recording time while preserving any actual original source error.

## Routing and review

- Critical plan author and shared implementation: gpt-6-astra/high.
- Read-only test inventory: gpt-6-sol/medium; no changes or external calls.
- Independent plan reviewer: gpt-6-astra/high, ACCEPT after one amendment round.
  Clarified failure-recorded time and queue fairness/failure-throttle tests.
- Scheduler and operator output implementation: gpt-6-sol/medium under the
  accepted shared contract.
- Different independent final reviewer: gpt-6-astra/high, ACCEPT after fixes.
  Its P2 finding identified cross-source reasons bypassing the discovery
  throttle; query-origin tagging and a regression resolve that case. Additional
  requested evidence covers real reservation rejection/persisted failure,
  coherent same-day holds, hostile ledger ordering and malformed diagnostics.
- Mechanical gpt-5.6-luna/low is unavailable in the agent selector; the capable
  lead performs checks and publication. Requested/actual dispatched routes match.
  Token telemetry is unavailable. Critical implementer reported approximately
  20 minutes; other individual durations were not measured. Model identifiers
  describe requested/accepted routing; independent runtime model telemetry is
  not exposed for every worker.

## Validation and release

- Focused classifier tests: 19/19 before the final diagnostic regression.
- Focused scheduler tests: 21/21; runtime tests: 39/39; relevant typechecks pass.
- Initial isolated budget tests: 21/22; the timezone fixture omitted BEGIN when
  passing an existing connection. Corrected the fixture and expanded coverage.
- Final integration: 2638 passed, zero failures/skips; includes all 27 dedicated
  budget recovery cases and 79 llm-agent integration cases. The test composition
  proves actual current-day reserve refusal and immutable scheduler publication,
  later-day assessment, and historical failure to real fresh two-pass READY.
  It does not alter the host/database clock or operational data.
- Full lint/typecheck/build: exit 0. Final frozen-source lint/typecheck/unit rerun
  after the last diagnostic regression also passes: 3548 unit cases, 3326 passed,
  222 database-dependent skips, zero failures. The enabled integration run above
  executes the dedicated PostgreSQL cases without skips.
- Two existing lint warnings concern unused eslint-disable directives in
  backtest simulator and llm-agent configuration; no new lint errors.
- Clean Docker build (--no-cache): exit 0, using HEAD plus this reviewed scope,
  excluding unrelated working-tree changes. Image tests with networking disabled:
  79/79 pass (classifier, scheduler, runtime). The first image-test invocation
  used the workspace root where tsx is not installed; rerunning from the package
  directory corrected the invocation without source changes. The final report
  is included by a cached publication-image rebuild.
- Publication and exact-commit CI: pending at source freeze. Do not interpret
  local tests as CI, deployment, operational readiness or trade evidence.

Use only isolated PostgreSQL on port 55432 for destructive fixtures. Existing
backtest/ES changes and signal-engine edits are outside this package and must
be excluded from staging and the clean release image.

No strategy or simulator behavior is changed by this package; no new strategy
backtest is required. Normal runtime preparation remains the only start path.
No budget reset, manual unpause, altered historical evidence or direct broker
submission is part of the fix.

Plan drafting through completed local validation and clean build took
approximately 30 minutes, including review amendments and fixture repairs.
