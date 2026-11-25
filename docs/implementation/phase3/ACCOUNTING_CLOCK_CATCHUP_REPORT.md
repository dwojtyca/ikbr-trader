# Accounting clock catch-up report

Date: 2026-11-25. Status: implementation and local runtime acceptance passed before publication;
commit/push and exact-commit CI are the remaining release steps.

## Scope and observed failure

The owner requested a fix, local verification that it resolves the problem, and
only then commit/push. The accepted [plan](ACCOUNTING_CLOCK_CATCHUP_PLAN.md)
preserves strict timestamps and freshness, with a bounded wait before evidence
publication. No strategy, broker-write flow, risk limits or schema changes belong
to this package.

Before the change, 30 consecutive persisted inspections showed broker time
48–56ms ahead of local receipt time. Source session and connection generation
matched; the observed protocol was 226. Automatic qualification/capture attempts
reported `ACCOUNTING_INSPECTION_INVALID`, followed by
`ACCOUNTING_EVIDENCE_STALE`. The source had no current capture, despite connected
TWS and successful market-data bootstrap. Durable entry pause was confirmed.
This evidence is specific to this incident, not a claim that all occurrences of
these general error codes have the same cause.

## Review and validation

The plan was independently accepted by `clock_plan_review` after one revision
round clarifying the original monotonic deadline and runtime verification order.
Implementation was accepted by the different `clock_final_review` agent after
one repair round: a cost-wait deadline must retain `FEE_PENDING` rather than be
misreported as a persistence failure. The reviewer independently passed 31 focused
tests. An initial lint error was also corrected; the isolated PostgreSQL negative
tests were adjusted to assert both the adapter hold and the underlying rejection.
No rejection or expected safety outcome was relaxed.

Completed local checks: 31/31 focused tests and 48/48 isolated PostgreSQL source
tests; lint (zero errors, two existing warnings), typecheck, build, full unit suite
(4,574 tests: 4,135 pass, 439 database tests skipped, zero failures), and clean
candidate Docker build. Sandbox TCP-listen restrictions caused the initial unit
run to fail; the authorized rerun passed. Full integration passed: 3,383 tests, zero failures or skips. The final candidate
source hashes match the reviewed working-tree files.

## Local runtime acceptance before publication

The candidate image
`sha256:d9f0a96b0e84b5b456d8ae7da5cb0e9b6a310332e5467195a5b4254c74fd2252`
was built from clean base `5577174dae793e1acb3bc044b5b5a2d75ca83b7a` plus
exact reviewed source/test files, excluding unrelated dirty work. Backup and
private profile copies preceded replacement; the profile check passed. All four
application services use the candidate, initially with durable entry pause retained
and existing protective supervision unchanged. No direct broker submission or
fabricated signal was used.

Between 13:43:08 and 13:44:13 UTC, 13 read-only samples showed source `READY`,
no hold/error/pending persistence, 13 distinct accounting captures and one current
automatic qualification. Ordinary reconciliation logs showed successful accounting
publication and `CLEAN` reconciliation. During this actual run the broker clock
was approximately 887ms behind the local/database clocks, so this runtime evidence
establishes healthy operation, not a live reproduction of positive clock skew.
The specific +55ms regression was reproduced and resolved in focused unit and
real isolated PostgreSQL tests, including first and repeated captures.

Only after this observation, guarded `pnpm start` completed successfully. At
13:44:37 UTC, `/ready` returned HTTP200 with `ready:true` and no reasons; accounting
remained `READY` with no hold; entry pause was false at revision101. PKO history
and all required timeframe warmups were ready. AAPL retained complete history and
waited for its market session. This is a bounded runtime observation, not a claim
of a completed trade or long-term soak.

Private evidence: `.local/paper-runtime/clock-catchup-deploy-20261125/` contains
`before.jsonl`, `candidate-source.json`, `after-paused.json`, `after-start.jsonl`,
`execution-after.log`, `start.log` and the pre-deployment database backup. Full
validation logs are in `/private/tmp/ikbr-clock-validation-logs/`.

## Delegation record

Requested routes: `clock_fix_author`, `clock_plan_review`, `clock_final_review`:
`gpt-6-astra/high`; mechanical validation: `clock_validation`,
`gpt-5.6-luna/low`. The tool accepted these selected routes; independent provider
model/effort telemetry and token usage are unavailable. One plan review round and one hostile implementation repair round were required;
there was no model downgrade. Mechanical preparation/checks used Luna; the lead
took over final checks after its initial sandbox failures and stale preliminary
image build. The stale image was never deployed. Elapsed lead work was about
35 minutes through local runtime acceptance; exact provider timing is unavailable.
Publication must follow this recorded acceptance; the final delivery records the
commit and exact-commit CI result without claiming them in advance.
