# Paper startup research recovery — implementation evidence

Date: 2026-11-02. Status: initial source published with failed CI; reviewed timing repair passed local validation. Successor publication and deployment pending.

The [accepted plan](PAPER_STARTUP_RESEARCH_RETRY_PLAN.md) addresses delayed WSH
retries and startup observation ending on a research HOLD. It includes the
previously prepared strict Marketaux payload diagnostics and runtime reconnect
fixes. Unrelated backtest, strategy and accounting-owner changes are excluded.

## Observed problem

The deployed startup immediately prepared price history and attempted research.
Both WSH event reads failed with 10281 and confirmed local cleanup; AAPL news
failed payload validation. The existing regular acquisition floor deferred another
cycle by one hour. Accounting recovery subsequently completed, with fresh CLEAN
reconciliation and no positions or orders. This did not establish research
readiness or permission to resume entries.

The next ordinary cycle at 15:48 UTC repeated both WSH 10281 failures and the
AAPL payload rejection. PKO news succeeded. AAPL news had succeeded on October 31;
the historical evidence does not identify today's failed parser predicate. These
observations demonstrate that waiting for the hour alone did not repair the
current provider failures.

## Review and routing

- Plan author and core implementation: `/root/startup_retry_design`, requested
  `gpt-6-astra` / high; dispatch accepted.
- Independent plan review: `/root/startup_retry_plan_review`, requested
  `gpt-6-astra` / high; ACCEPTED after one clarification round addressing SQL NULL
  handling, unknown acquisition outcomes and pre-existing CLI scope.
- Runtime implementation: `/root/startup_retry_cli`, requested `gpt-6-astra` /
  high; dispatch accepted.
- Independent implementation review: `/root/startup_retry_final_review`, requested
  `gpt-6-astra` / high; dispatch accepted; source and documents accepted with no remaining finding.
- One implementation-review fixture repair round replaced the superseded
  BUSY-never-retries mock expectation with the accepted bounded retry behavior
  and preserved the metadata-success assertion in the PostgreSQL scheduler test.
  No unresolved production-code finding remains; final required local checks passed.
- Requested routing model identifiers were accepted by the orchestration tool;
  independent runtime model attestation and token usage are unavailable.
- Mechanical checks are performed by the lead; the policy's requested
  `gpt-5.6-luna` route is unavailable in this session.
- Precise per-agent elapsed-time telemetry is unavailable. Test durations remain
  in the private validation logs; no model cost/savings claim is made.

## Validation and release

Validation uses a clean export of commit `1e0c72a` plus only the reviewed package,
with pinned pnpm 9.5.0. PostgreSQL fixtures use a separate disposable container;
the operational database is not a test target.

The previously prepared parser diagnostic patch passed 15 focused tests. Runtime
tests passed 62/62, including continued HOLD observation, subsequent readiness,
stop/abort/revision fencing and ambiguous-resume non-retry. Runtime package
typecheck and focused lint also passed, with no worker repair round.

Core validation passed 21 repair unit tests, 55 WSH unit tests plus a cycle-boundary
case, and six PostgreSQL scheduler tests. The production scheduler/store test
records BUSY, creates a replacement worker and obtains normal successful coverage
through the durable retry. Another PostgreSQL case proves three-day-old source
data admits both legal reads immediately. Four legacy post-recovery assertions
were corrected from HOLD to WAITING without allowing missing coverage to become
READY. Initial synthetic fixture failures were corrected for source/configuration
identity and validity; production acceptance was not weakened.

Full local lint and build passed. Full unit tests passed with 3,992 successes and
377 expected integration/environment skips, using sequential workspace packages.
The first attempts encountered sandbox localhost restrictions, an incomplete
test-runner PATH, and an unchanged child-process test's five-second timeout under
parallel build load. Correcting the environment and running packages sequentially
resolved these failures without editing that test or extending its deadline.
The clean Docker build passed, including official accounting SDK installation
checks, and final full typecheck passed. The first complete integration attempt
passed all 114 shared tests and 2,269 execution tests but found two migration
inventory expectations missing version 44. Only those two expected lists were
extended; historical-data and idempotency assertions remain unchanged, as verified
by the independent reviewer. The corrected core package passed all 3,222 isolated
integration tests, with no skips. The subsequent cleanup diagnostics amendment
passed full validation below. Publication, exact-commit CI and deployment
evidence are pending.

## Cleanup diagnostics amendment

The accepted bounded amendment retains actual owned cancellation errors 10280
and 10284 during the existing cleanup window, with sanitized original name,
numeric callback code and message. Local cleanup failure keeps precedence.
Temporary listeners are removed before finalization; no observed error is not
a provider acknowledgement. Cleanup states, call counts, timers, retry policy
and publication acceptance remain unchanged.

Independent plan and implementation reviewers found no remaining amendment
blocker. Focused transport tests passed 26/26, wire tests 7/7 and PostgreSQL
persistence tests 2/2; a delayed-close listener-removal case also passed. One new
wire fixture initially omitted the SDK-version-specific error-frame field; the
fixture was corrected without changing production semantics. The amended package passed full lint (two existing warnings), typecheck, build,
clean Docker build and all 4,000 unit tests, with 377 expected integration/environment
skips. The amended full isolated integration suite passed all 3,222 tests with no skips
and exit code 0. No strategy or simulator behavior changed in this package,
so no new strategy backtest was required. Local documentation links and the
scoped diff were checked. Publication, exact-commit CI and operational acceptance
are still separate, pending steps.

## Published CI and validation timing repair

Commit `64b61c3e2be6fbba28dd0b9fb8aca09f4ab7fff0` was published on main.
[Its CI run](https://github.com/dwojtyca/ikbr-trader/actions/runs/41480213476)
passed lint, typecheck and unit tests but failed the PostgreSQL integration step.
Detailed logs require GitHub authentication unavailable to the agent at diagnosis;
public annotations only report exit code 1. The same first shared suite was rerun
locally against localhost PostgreSQL and passed 114/114.

Independent inspection found arbitrary one-second assertions in two new fixtures.
A disposable container with a valid 1.5s scheduling delay reproduced the old
weekend fixture assertion failure, while runtime deadlines remained unchanged.
This establishes a test fragility, not the unobserved CI failure cause. The accepted
validation amendment replaces those comparisons with operation-specific DB-time
brackets, preserving exact 30s/120s retry policy and all admission/fencing assertions.
The independent plan reviewer accepted the amendment before implementation;
a different final reviewer accepted the resulting tests and documentation.
Both complete PostgreSQL fixture files passed 56/56; the corrected disposable
fixture passed with the same 1.5s delay before each operation. Final full lint,
typecheck, build and clean Docker build passed; unit tests passed 4,000 with
377 expected skips, and isolated integration passed 3,222 without skips.
Publication and exact-successor CI remain pending. No production timeout or
provider acceptance is changed by this test repair.

## Limits

Bounded retries do not prove a persistently busy provider request has cleared.
Historical failures and costs remain recorded. The package does not add same-hour
Marketaux attempts or relax payload validation. AAPL's historical failed predicate
cannot be reconstructed from the retained hash; a subsequent normal attempt with
the new diagnostic code is needed to establish a fresh failure cause. Paper
activation and a natural strategy entry require separate operational evidence.
