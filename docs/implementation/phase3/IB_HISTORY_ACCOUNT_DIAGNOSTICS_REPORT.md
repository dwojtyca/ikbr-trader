# Completed history cleanup and account subscription diagnostics

Date: 2026-10-13. [Accepted plan](IB_HISTORY_ACCOUNT_DIAGNOSTICS_PLAN.md).
Status: implementation, independent hostile review and required local checks
passed; publication, exact-commit CI and operational observation pending.

## Change

Three ingestion historical request paths no longer cancel requests after matching
broker completion, including payloads that subsequently fail local validation.
Unfinished requests retain cancellation and listener/timer retirement on timeout,
error or synchronous send failure. Existing pacing and data validation remain.

Execution retains the original IBKR error text and emits bounded account-update
trace records containing only local sequence, connection generation, phase and
monotonic timing. The installed ib@0.2.9 sent event follows local socket.write;
it does not prove broker receipt. observedDuringSequence is observation context,
not a broker request ID (reqAccountUpdates has none). Trace logger exceptions do
not change snapshot behavior. Connection-generation changes discard old context.
No polling, account subscription, risk, strategy or eligibility behavior changed.

## Five-second source evidence

LifecycleObserver.start schedules a cycle every 5000 ms. Each eligible cycle
refreshes before enumerating lifecycle candidates, so a flat account still causes
refreshes when account context/lease and in-flight conditions permit them. The
index.ts observer dependency delegates to fullCloseService.deps.refresh, then
refreshBrokerPositionSnapshot and the refresh coordinator, whose fetchBrokerSnapshot
calls getAccountSnapshot. That method subscribes with reqAccountUpdates(true),
waits for matching accountDownloadEnd and unsubscribes with false.

This call chain explains the observed five-second cadence, but pre-change logs
cannot prove whether 2100 arrives after subscribe or unsubscribe. Runtime trace
observation is still required; even temporal proximity cannot exclude a
simultaneous external-client action. Do not classify 2100 as harmless merely from
this code inspection.

## Validation and delivery evidence

- Ingestion focused tests: 31 passed; ingestion typecheck passed.
- Execution focused diagnostics and existing risk-evidence tests: 16 passed.
- pnpm lint: exit 0 (two pre-existing unused-disable warnings).
- pnpm typecheck: exit 0; pnpm build: exit 0.
- pnpm test: 3503 total, 3308 passed, 195 database-dependent skips, zero
  failures on the completed run. Initial sandbox run could not bind localhost;
  rerun with local-network permission. One earlier full run had a transient UI
  dev-server test failure/hang; its isolated seven-test rerun and subsequent
  complete suite passed without source changes.
- pnpm test:integration: exit 0, 2611 passed, zero skipped/failed,
  isolated PostgreSQL on port 55432.
  First run failed one pre-existing synthetic XYZ scheduler case (missing proposal
  at its assertion) after a pathological 509-second CPU interval. The failing
  fixture does not execute either changed production path; its isolated rerun
  passed in 2.1 seconds without edits. Native sampling suggested exception/stack
  formatting overhead but did not establish the cause. The repeated execution suite passed all 1827 cases, including XYZ in
  4.2 seconds; all remaining integration packages also passed. No fixture
  deadlines or production guards have been relaxed.
- Clean Docker build (--no-cache): exit 0. Image-local focused tests with
  network disabled: ingestion 31 and execution 16 passed. Build excludes
  unrelated local work; final report is included in the publication image through a cached rebuild.
- Exact-commit CI and deployment: pending at source freeze; record the actual
  results separately after publication rather than claiming future success.

## Review and routing

- Lead: gpt-6-astra/high, critical trace semantics/integration/operations.
- Read-only 2100 diagnosis: gpt-6-astra/high; no edits or broker probes.
- Plan reviewer: gpt-6-astra/high, ACCEPT, no required repairs.
- Ingestion implementer: gpt-6-sol/medium, six permitted files, zero repairs;
  reported approximately eight minutes. No live calls.
- Distinct final reviewer: gpt-6-astra/high, ACCEPT, zero findings/repairs;
  independently reran the 31 ingestion and 16 execution focused cases.
- Mechanical gpt-5.6-luna/low route unavailable in selector; capable lead runs
  checks and publication. Requested and actual dispatched worker/reviewer routes
  match. Token usage unavailable. No model quality/savings claim.
- Lead focused repair: parsed IB error codes are normalized strings; diagnostic
  selection now uses the existing numeric conversion. Tests caught the mismatch.
- Unrelated dirty backtest and signal-engine files are excluded from publication
  and the clean Docker build context.

Plan creation to completed local validation: approximately 23 minutes, including the failed runs and diagnosis described above.
