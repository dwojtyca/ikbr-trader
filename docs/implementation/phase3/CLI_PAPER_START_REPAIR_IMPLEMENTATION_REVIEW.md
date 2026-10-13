# Continuous Paper startup repair — independent implementation review

Date: 2026-10-13. Baseline: `cc5ada1`. Verdict: **ACCEPT** for the reviewed
implementation. Blocking source findings: none.

Reviewed the [accepted plan](CLI_PAPER_START_REPAIR_PLAN.md),
[independent plan review](CLI_PAPER_START_REPAIR_PLAN_REVIEW.md), repository
instructions and the complete scoped changes in `paper-runtime.ts`,
`paper-runtime-cli.ts`, `paper-runtime.test.ts` and
[the continuous Paper runbook](../../runbooks/CONTINUOUS_PAPER.md). Also inspected
the shared loader, admission contract, four service configuration bootstraps and
execution preparation/configuration routes. This reviewer neither authored the
plan review nor implemented the change.

## Contract and hostile-case findings

- The fixed strategy source uses existing proof/path checks and an additional
  byte-hash check before parsing. The loader receives only the validated fixed
  container-path mapping. Every rendered app environment passes the actual shared
  loader; canonical mismatch, legacy authority conflicts and loader errors become
  the fixed `PAPER_CONFIG_CHANGED` error before startup service or HTTP mutations.
  File contents and underlying parser errors are not printed.
- Expected preparation instruments come from the authenticated bundle's
  `entryEnabled` rows, matching execution's preparation scope. Empty scope remains
  rejected. Authentic fixtures cover PKO/AAPL, disabled rows, canonical mismatch,
  the original signal-engine conflict and each other consumer's conflict.
- The diagnostic addition allows the exact local configuration endpoint with GET
  only, retains transport time/output bounds and rejects redirects. Displayed
  reasons must all belong to a five-code allowlist and are deduplicated. Unknown,
  mixed or unavailable diagnostic data produces generic waiting. Neither reasons
  nor an `allowed` field can authorize preparation or resume.
- After the diagnostic request, startup rechecks cancellation, account, durable
  pause and revision ownership. Existing exact preparation scope/revision checks,
  research gates, resume admission, stop supersession and unknown mutation outcome
  handling are preserved. No broker-write, risk, qualification or recovery policy
  changed. The final three presentation-only changes describe automatic
  preparation without changing the audited startup pause.
- The runbook accurately identifies bundle authority, automatic preparation and
  diagnostic limits; it does not instruct manual unpause or claim launch readiness.

## Evidence and remaining delivery gates

Reviewer inspection of the final scoped diff and `git diff --check` passed.
The coordinator reported the 34 targeted runtime tests and targeted typecheck
passed. Runtime suites were not duplicated by this reviewer.

At review time, the full required checks, isolated PostgreSQL integration, clean
Docker build and four built service config-module imports were still being
completed separately. The import evidence must show the original conflicting
environment rejected and the corrected environment accepted without service
entry-point, broker or provider calls. Record those results in the implementation
report before deployment. Source acceptance does not replace these gates, scoped
publication or exact-commit CI.

Private profile correction, preservation of strategy/research/accounting and
risk/budget/expiry contents, fresh configuration observations and supported
operational startup remain the coordinator's separately verified rollout work.
This review does not claim successful deployment, entry, exit or broker readiness.

Requested/actual reviewer route: `gpt-6-astra`, high. Repairs/escalations: 0.
Elapsed approximately 5 minutes. Token telemetry unavailable. No implementation,
private configuration, broker/provider or operational state was changed by this
reviewer; only this review document was written.

## Validation amendment — fixture listener cleanup

Verdict: **ACCEPT**. Reviewed the accepted plan amendment and the complete change
to `tools/paper-verify-stack/src/fixture/fixture-stack.test.ts`.
`listenOnDefaultPorts` now waits for all bind outcomes, retains every successful
test-owned listener and closes those listeners before propagating a failed bind.
The success path still returns all listeners for existing caller cleanup. Failed
binds do not obtain ownership of pre-existing listeners. The fix preserves all
assertions and changes no production behavior or operational service state.
No blocking finding; scoped `git diff --check` passed.

The coordinator supplied focused reproduction evidence: the partial-occupancy
case naturally exited with status 0, one pass and zero cancellations, leaving no
test-owned listener on port 3102 while existing services occupied 3101/3103.
Updated full host tests, lint/typecheck and clean image build remain required;
already passed unchanged production integration/build evidence remains applicable.

The coordinator also supplied successful built configuration smoke evidence for
the initial repaired image: all four actual `dist/config.js` imports accepted the
corrected environments, and signal-engine with the original conflicting variable
rejected with `CONFIG_AUTHORITY_CONFLICT`. These ran in ephemeral, read-only,
network-disabled containers without importing service entry points. The final
test-cleanup image and its rollout identity remain separately tracked by the lead.

Same independent reviewer route. Amendment review approximately 2 minutes;
blocking findings and escalations: 0; token telemetry unavailable.

## Final report and publication scope

Reviewed the final [implementation report](CLI_PAPER_START_REPAIR_REPORT.md).
Its scope, linked documents and reported final checks are consistent with the
accepted implementation. The coordinator supplied passing final lint, typecheck,
full host unit tests, build and no-cache Docker build, plus the unchanged
production integration results against isolated PostgreSQL. The final image
`sha256:7a45317830bae0656c88a075c4c1db8d804f5f313fb46b1f3611947d8a1a349c`
also passed all four corrected config imports and the original conflicting
signal-environment rejection. These reports supersede earlier pending local-check
entries in this review; the reviewer did not repeat the mechanical checks.

The coordinator reports that the private profile/proof update preserved all
other proof-covered policy/evidence bytes and passed the supported runtime check,
without starting services or resuming entries. Exact-commit CI and guarded
operational startup remain outstanding and must be described as pending.

**ACCEPT** the nine-file publication scope: the three runtime source/test files,
the fixture listener test, continuous Paper runbook, repair plan, plan review,
this implementation review and implementation report. Unrelated dirty files are
excluded. No further code findings. Final report review approximately 1 minute;
requested/actual route unchanged, token telemetry unavailable.
