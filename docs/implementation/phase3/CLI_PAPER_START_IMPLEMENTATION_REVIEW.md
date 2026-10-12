# Explicit Paper CLI startup — independent implementation review

Date: 2026-10-12. Verdict: **ACCEPT** for the reviewed implementation and public
documentation, including the accepted critical repair addendum. Full repository
validation, clean Docker build and exact-commit CI remain separate delivery gates;
this review does not claim deployment, provider access or broker readiness.

Reviewer: independent `cli_start_final_review`, requested route `gpt-6-astra` /
`high`, different from the plan reviewer and implementation authors. Runtime
model telemetry, token usage and exact elapsed time are unavailable. The reviewer
made no source changes and invoked no operational services, providers or broker
endpoints.

## Scope and evidence

Reviewed the [plan](CLI_PAPER_START_PLAN.md), its accepted critical repair
addendum and [independent plan review](CLI_PAPER_START_PLAN_REVIEW.md), repository
workflow, execution entry controls, startup preparation, production authorization
wiring, CLI orchestration and transport, focused tests, package scripts, private
file exclusions, narrow lint transport exception, [runbook](../../runbooks/CONTINUOUS_PAPER.md)
and [delivery report](CLI_PAPER_START_REPORT.md). The report correctly leaves
remaining validation and publication evidence pending.

Inspected the existing research repair store, configuration admission, ingestion
bootstrap controller and real health/progress response shapes, authentication/write
guards and unchanged resume gate. No unrelated backtest or signal-engine edits
are included in this acceptance.

Independently ran:

- Entry-control and research-prepare-route unit tests: 5 passed, zero failed.
- Final CLI fixture suite: 31 passed, zero failed, exit 0.

The lead reports eight isolated PostgreSQL core tests passed. Their assertions
cover concurrent pause/resume, stale revision, queue rollback/coalescing and no
provider reservations. The critical implementer reports tools typecheck, focused
lint and diff checks passed. Production `index.ts` authorization rejection branches
were inspected; route unit tests use an authorization stub rather than starting
the broker-connected process.

## Core review

No blocking findings in the core change. Revision comparison occurs under the
account advisory and row locks before the resume gate. Startup preparation
requires a paused revision with its explicit start audit reason, derives current
instruments on the server, retains Paper/account/configuration/connection checks,
and runs repair preparation within the control transaction with final fences.
Existing signal preparation and resume admission remain unchanged. Preparation
cannot manufacture an entry permit, provider reservation, AI decision or order.

## Findings and verified repairs

Initial CLI acceptance was withheld despite 13 passing mocked tests. One critical
orchestration escalation and a focused follow-up review resolved the findings:

- Stop now atomically changes the local cancellation generation before account/API
  work. Separate-runtime fixtures demonstrate cancellation before the cold broker
  account becomes available. The marker is not described as broker pause evidence.
- Risk-reducing stop uses one authenticated unconditional pause with a unique
  audited reason. This serializes against concurrent resume without losing a CAS
  race. Unknown responses receive exact readback, not another ambiguous mutation.
- Interrupted resume forces a new pause even after a paused read before a delayed
  server commit, and after a successful POST whose readback fails. Unverified pause
  returns uncertainty and stops only entry producers; execution and ingestion stay
  available for exit management.
- Real transport sends bootstrap to ingestion port 3101. Its single long request
  is observed concurrently through control/cancellation and actual health/progress.
  Only complete positive readiness permits progress after an unknown response.
  A follow-up repair tolerates the previous durable stop and old failure while
  that request remains pending, with a dedicated regression fixture.
- Cold startup waits for authenticated account control. Old protocol, malformed
  control events and auth denial reject; peer-readiness waits retain the same
  paused revision. Stale research at resume returns to preparation under that
  revision rather than acquiring new authority.
- Docker subprocesses and both HTTP success/error bodies have finite bounds;
  cancellation terminates the child. The arbitrary whole-run deadline is removed.
  Parsed producer records must positively establish stopped or absent containers.
- The proof pins effective Compose JSON, image identity and private file contents;
  independent checks compare research hashes and constrain accounting settings to
  the covered read-only mount. File/symlink/mount-related rejection fixtures cover
  the reviewed boundary. The CLI cannot regenerate proof or build/pull on start.
- Status uses existing operator diagnostics with an explicitly unconfirmed
  container-only fallback. The runbook distinguishes unknown mutation outcomes
  and does not claim every error proves entries paused. The lint exception is
  confined to the reviewed fixed-origin authenticated CLI transport.

No blocking findings remain in the final frozen source. Unknown broker/control
outcomes, expired source/accounting rights and missing genuine market readiness
remain operational holds, not deficiencies this package claims to resolve.

## Additional isolated integration fixture review

Verdict: **ACCEPT** for the independently planned correction to
`apps/execution-engine/src/paper-recurring.pg-integration.test.ts`. Reviewed the
exact bounded diff and accepted plan addendum; no production source changed.

The case now saves the fixture's existing session end, binds the proposal with
an end 15 minutes earlier, shortens it a further 15 minutes, and finally extends
back to the saved end. The final schedule genuinely extends beyond the initially
bound schedule, preserving the unchanged-original-cutoff assertion. The strict
shortening, valid original binding, session hash and failed-evidence assertions
remain intact. Failure diagnostics now expose the returned reason without
weakening success assertions.

The change removes the unnecessary `Date.now()+2h` extension implicated by the
reported Warsaw account-day failure. It does not claim to eliminate the existing
shared fixture's dependence on current time near midnight. The implementer
reports 5/5 targeted PostgreSQL tests, lint and diff checks passing; the full
isolated integration rerun remains a delivery gate. This reviewer performed
source/contract review and did not contact a database for this addendum.
