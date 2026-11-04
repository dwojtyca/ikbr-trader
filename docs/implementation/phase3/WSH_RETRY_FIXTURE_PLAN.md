# WSH BUSY retry SQL fixture clock repair

2026-11-04. Status: ACCEPTED by independent `/root/cleanup_audit` (requested/actual
`gpt-6-astra` / high), zero findings. Baseline `29d4e1f`.

## Observed failure and bounded cause

The lead inspected authenticated GitHub CI run `41644447207`: the direct SQL
BUSY retry authority test in `wsh-recovery.pg.test.ts` expected
`research_wsh_retry_known_failure` but received
`research_wsh_refresh_attempts_check13`. Migration 33 defines that constraint as
cleanup timestamps ordered at or before `cleanup_completed_at`. The fixture
computes `local_closed_at` and `cleanup_completed_at` with separate volatile
`clock_timestamp()` calls. Their textual SET order does not establish their
evaluation order; the table stores `cleanup_completed_at` before
`local_closed_at`. These independently evaluated timestamps can therefore violate
cleanup ordering before the intended provider-code CHECK is reached. Local suite
success does not disprove this timing dependence.

This is a follow-up to the accepted [startup retry plan](PAPER_STARTUP_RESEARCH_RETRY_PLAN.md)
and the pending [article-reference release](MARKETAUX_REFERENCE_FRAGMENT_PLAN.md).
It does not change their production contracts or claim operational readiness.

## Implementation boundary

Change only `packages/shared/src/instrument-research/wsh-recovery.pg.test.ts`
and this plan plus `WSH_RETRY_FIXTURE_REPORT.md`. The two direct SQL BUSY
settlement fixtures must use the same statement-stable database timestamp for
`finished_at`, `local_closed_at`, `cleanup_completed_at`, and the base of
`retry_due_at` (still exactly 30 seconds). Use `statement_timestamp()` consistently.
Keep every invalid provider-code case, the exact expected known-failure CHECK,
the valid numeric 10281 positive control, the linked UNKNOWN acquisition denial,
and all history/charged-reservation assertions. Add a positive-control database
assertion that closure and cleanup timestamps are equal and the retry deadline
equals settlement plus 30 seconds using PostgreSQL equality, not lossy JavaScript
timestamp precision. Do not alter migrations, guards, production clocks or policy.

## Validation and acceptance

1. In a disposable database only, demonstrate deterministic evaluation-order
   failure with an otherwise valid numeric 10281 fixture: an isolated test-only
   wrapper around each volatile clock call introduces a small delay, ensuring
   cleanup completion and local closure differ. Capture the exact constraint.
   The same delayed wrapper around statement-stable timestamps must allow the
   valid positive control and preserve all invalid-code rejection assertions.
   The wrapper/delays are temporary evidence, never committed fixtures or runtime.
2. Run the complete `wsh-recovery.pg.test.ts` against isolated PostgreSQL, with
   no skipped tests. Verify both direct SQL BUSY cases and positive timestamp
   invariants pass. Inspect the scoped diff for unchanged guard assertions.
3. Obtain independent plan acceptance before changing tests, followed by a
   different independent implementation/hostile reviewer after implementation.
   Both reviews use requested `gpt-6-astra` / high because these tests establish
   durable research retry authority. Record actual route, repairs, elapsed time
   and available token usage (unavailable if not exposed).
4. The lead runs required lint, typecheck, unit, isolated integration and build
   against a clean export with only reviewed changes, then the clean Docker build,
   scoped main publication and exact-commit CI. No strategy changes or new
   backtests. Preserve unrelated ES/backtest/signal/report changes. Deployment and
   broker/provider operations remain exclusively with the lead under the existing
   authorized Paper rollout; this worker performs none.

Stop and return to the lead if reproduction implicates a production guard,
requires a different expected rejection, weakens an assertion, or requires files
outside this boundary. A failing CI check remains a release blocker until the
exact successor commit passes; focused local proof alone is insufficient.
