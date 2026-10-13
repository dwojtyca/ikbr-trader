# WSH cancellation and original error diagnostics — evidence

Date: 2026-10-13. Status: implementation accepted; required local checks and clean Docker build
passed. Publication and exact-commit CI remain pending at this source freeze.
Contract: [accepted plan](WSH_CANCELLATION_DIAGNOSTICS_PLAN.md).

## Problem and scope

The WSH adapter disconnected without explicitly cancelling owned metadata/event
requests and discarded the original provider error text. Local read-only evidence
showed repeated 10281 errors followed by 502 for both configured instruments.
This establishes observed failures, not their exact broker-side cause. In startup,
negative calendar coverage remains a HOLD and leaves the durable entry pause.

This package adds cancellation and bounded shutdown, preserves original sanitized
provider diagnostics in new negative snapshots, and renders them in startup and
status. Historical snapshots have no invented description. It does not change
entry eligibility, clock tolerance, accounting recovery, provider limits, strategy
logic or broker-order handling. No real provider request/trade or operational
configuration mutation is part of implementation validation.

## Routing and review

| Task | Requested route | Result |
| --- | --- | --- |
| Independent critical plan review | gpt-6-astra/high, wsh_plan_review | ACCEPT, no blockers |
| Transport, acquisition and shutdown implementation | gpt-6-astra/high, wsh_runtime_worker | Implemented and focused checks passed |
| Shared diagnostic contract, CLI/status, integration/release | Capable lead | Implemented; local release checks passed |
| Independent critical final review | gpt-6-astra/high, wsh_final_review | ACCEPT after one repair; separate timer amendment accepted |

Actual provider telemetry, token usage and precise elapsed time are unavailable.
Plan review required real installed-SDK wire evidence, shutdown continuation fences,
legacy hash compatibility and pre-persistence secret redaction. No implementation
was authored by the plan reviewer. The different final reviewer authored no
implementation. One hostile finding was repaired: an uncorrelated provider error
arriving between awaited database operations was lost when the next request saw a
closed transport. The first terminal error now survives subsequent calls; gap and
duplicate-error tests verify it. No model escalation occurred.

## Validation and limitations

Final `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` and
`pnpm build` passed (exit0). Unit totals:3376 tests,3193 passed,183 skipped,0 failed.
Isolated PostgreSQL integration:2541 passed,0 skipped,0 failed. Lint retains two
pre-existing unused-disable warnings. No strategy/simulator changes were made;
no new backtest is required or claimed.

Worker evidence: transport10, refresh/shutdown28, actual installed-SDK loopback5,
isolated PostgreSQL persistence3 all passed, including original10281 readback and
secret/account redaction. Independent reviewer: transport/refresh/shutdown38,
loopback5, shared WSH7, status9 and runtime35 passed. Counts overlap and are not
added as a unique total. Loopback initially needed sandbox permission to bind;
the approved run used only a local fake server. The throttled SDK test verifies
cancel frames arrive before socket end, including requests queued for over100ms.

The first full unit run exposed an existing DNS fixture race: a real25ms deadline
expired before initial validation under load, yielding DEADLINE_INVALID rather
than the asserted TIMEOUT. A separately accepted test-only amendment uses mock
Date/setTimeout and retains exact TIMEOUT and zero-HTTPS assertions. Both lead and
independent reviewer passed16 focused cases, then the complete unit rerun passed.
Production timeout/clock rules were not changed. One preliminary typecheck also
caught test-only union narrowing errors, repaired before settled-source checks.

A clean `docker build --no-cache` from HEAD plus the explicitly scoped files passed,
without .env/private material or unrelated dirty changes. Final image receipts
and publication/CI outcome belong to operator delivery; no running container was
replaced as part of this package. Scoped commit/push and exact-commit CI are pending
at this report freeze.

PostgreSQL integration uses the existing disposable test server on loopback55432,
separate from operational5432. No destructive fixture targets the operational DB.
The unrelated ES/backtest and signal-engine local changes are preserved and are
outside publication/build-image scope.

Cancellation send is best effort, not broker acknowledgement. SIGKILL, power loss
and broken network cannot guarantee cleanup; durable uncertainty and pacing stay
in force. Source tests cannot prove real WSH recovery or make 10281 impossible.
Original errors lost by older code cannot be reconstructed. The two-second
accounting-clock check remains unchanged and is explained in the
[runbook](../../runbooks/RESEARCH_CONTEXT_WSH.md#błędy-dostawcy-i-zatrzymanie).
