# Research recovery diagnostics: implementation evidence

Date: 2026-10-28. Status: bounded implementation, focused verification and independent
hostile final review accepted; local package checks and builds passed with the
integration caveat below. Publication, exact-commit CI and deployment are pending. This is not a bot-readiness or recovery-success
claim. Baseline: `863abcad76c35fe86dedf78e3a6c9450b5a4e28b`.

## Change and limits

The [accepted plan](RESEARCH_RECOVERY_DIAGNOSTICS_PLAN.md) addresses the loss of
failure details between the WSH recovery backend, host subprocess and terminal.
Both recovery CLIs now retain a bounded diagnostic containing the failing stage,
internal reason and available sanitized original name/code/message. Backend success
output and recovery evidence schemas remain unchanged. The host validates child
diagnostics before presenting them with the existing Polish hold/no-retry guidance.

First mutation failures remain visible when exact readback throws or returns no
valid result. Successful exact readback remains success. A connection failure
remains primary if cleanup also fails; an independently failed cleanup or its
returned source error is reported at its actual phase. Native host cause records,
spawn failures and the existing subprocess timeout remain distinguishable.

Configured secrets and account identifiers, including nonnumeric accounts and
encoded secrets, are redacted at the caller boundaries and again at presentation.
The recovery-specific helper also removes credential URLs regardless of normalized
scheme/spelling and payload-shaped message fragments. It reuses existing privacy
helpers without changing their behavior for other subsystems. Invalid child JSON,
unknown diagnostic fields and raw stderr are not forwarded. Details unavailable
before a safe privacy context exists remain unavailable.
Configured URL credentials and token query values are also included in redaction
when a driver echoes the decoded value without the surrounding URL.
JSON parser `SyntaxError` messages are omitted because they may contain raw input
excerpts; the safe original error name/code remain available. Initial profile
inspection and later profile rechecking are distinguished even when the profile
reader has already wrapped the error.

There are no new provider/broker calls, handshakes, restart retries, timeouts,
migrations, challenge/evidence fields, state repairs or guard relaxations. The
subprocess test seam retains the exact production spawn and bounds by default.
Existing identity, pause, producer, process replacement and socket-close checks
remain authoritative.

The 2026-10-27 observer's original failure cause remains unknown. A later read-only
host capture succeeded; this does not prove that the earlier failure was a timeout
or that TWS was not yet ready. No historical receipt or observation was synthesized.
This implementation work performed no operational restart, recovery mutation,
broker connection, provider acquisition or trading activation.

## Focused verification

Commands use the installed Node v24.4.1 executable. Results at handoff:

- Shared TypeScript build: `node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json`
  — exit 0.
- Backend typecheck: `node node_modules/typescript/bin/tsc -p apps/llm-agent/tsconfig.json --noEmit`
  — exit 0.
- Host typecheck: `node node_modules/typescript/bin/tsc -p tools/paper-verify-stack/tsconfig.json --noEmit`
  — exit 0 after narrowing the spawn test seam's overload type.
- Diagnostic/shared, backend CLI and host CLI focused run: `node --import tsx --test`
  with their three test files — final 40 passed, zero failures/skips, exit 0.
- Extended run including unchanged native host collector and WSH transport tests
  — 75 passed, zero failures/skips, exit 0 (approximately 7.3 seconds), before the
  final parser-excerpt/profile-stage diagnostic regressions were added.
- Changed-file ESLint — exit 0 after moving primary/cleanup rethrows outside
  `finally`, retaining the same cleanup call and primary-failure precedence.
- `git diff --check` — exit 0; plan links resolved locally.

The focused tests include an actual isolated Node child executing the backend with
fixture configuration and an injected read failure; the production host subprocess
reader decodes its output and the terminal formatter retains its sanitized cause.
No Docker or broker is invoked by that test. Tests also cover native/plain cause
records, unavailable originals, nested/cyclic causes, getters, size/control limits,
credential URLs, payload fragments, malformed wire data, spawn/timeout failure,
returned cleanup causes, exact-readback preference, unchanged one-shot action
counts and no evidence saved after failure.

## Full validation

A clean baseline archive plus only the ten reviewed files was validated in
`/private/tmp/ikbr-research-diagnostics-20261027`; unrelated dirty work was excluded.
Node v24.4.1 and pnpm 9.5.0 were used.

- `pnpm lint`: exit 0, two pre-existing unused-disable warnings.
- `pnpm typecheck`: exit 0.
- `pnpm test`: exit 0; 4,277 total, 3,921 passed, 356 skipped, zero failed.
- `pnpm build` and clean Docker build: exit 0. Candidate image:
  `sha256:dd4da4954d1454df33ba3335c0d16c269fa523bec9f2465b1e27a68bebbf55f9`.
- Isolated PostgreSQL integration package results: shared 96/96, execution
  2,203/2,203 on its full rerun, backtest 18/18, llm-agent 84/84, ingestion
  160/160, signal-engine 574/574. Total 3,135 passing results, zero skipped.

The first host integration attempt was rejected by the fixture URL allowlist
(port 55432). The corrected candidate container shared the isolated tmpfs test
PostgreSQL network namespace, using `CI=true`, loopback port 5432 and database
`ikbr_trader_ci`. No operational database fixtures or weakened safeguards were used.

That corrected top-level attempt passed shared tests but failed one execution
test: `deadline pending-entry cancellation completes all3 terminals with no SELL
and restart reconstructs terminal proof`, expecting `COMPLETED`, receiving
`BLOCKED`. The original reason is unavailable: the log retained only the assertion
and fixture cleanup removed its database. Source, assertions and timeouts remained
unchanged. Bounded investigation passed the target once, ten further repetitions,
and the full close file (62/62). The full execution rerun passed 2,203/2,203;
remaining integration packages ran separately. **No single local top-level
integration invocation completed successfully.** The cause remains unknown;
a timing race or pre-existing flakiness is not proven. Relevant close source is
unchanged from baseline, which alone does not establish causality. Independent
review permits diagnostics-only publication after the full rerun, conditional on
successful exact-commit CI and disclosure here.

The initial changed-code lint failure (`no-unsafe-finally`) was repaired before
final checks, preserving connect/close action counts. No strategy/simulator behavior
changed, so no backtest was required. Exact-commit CI remains required before
deployment; these checks do not establish operational readiness.

## Review and routing

| Work | Requested / actual model and effort | Evidence | Repairs / escalation | Usage |
| --- | --- | --- | --- | --- |
| Diagnosis, plan and implementation | `gpt-6-astra` / `gpt-6-astra`, `high` | Bounded source/tests; no runtime actions | One typecheck repair and one lint repair; lead privacy and returned-cleanup-cause findings addressed; no scope escalation | Token and active elapsed telemetry unavailable; work interrupted overnight by usage limit |
| Independent plan review | `gpt-6-astra` / `gpt-6-astra`, `high` | `wsh_diagnostics_plan_review`: ACCEPT | One clarification on first mutation failure versus unsuccessful readback; zero escalation | Unavailable |
| Independent hostile implementation review | `gpt-6-astra` / `gpt-6-astra`, `high` | `wsh_diagnostics_final_review`: ACCEPT after final 40/40 focused verification | Parser payload-excerpt and profile-recheck stage findings fixed with caller regressions | Unavailable |
| Full checks | Requested `gpt-5.6-luna`/`low` unavailable; actual `gpt-6-luna`/`low` | Passing package results/builds above; exact CI pending | Fixture-port correction; one unexplained execution failure then full package pass; Astra diagnosis | Tokens unavailable; execution rerun 161.1 s |

Deployment must follow the existing disabled-write retirement/recreation protocol
and private proof validation. A stale challenge uses supported supersession;
fresh WSH recovery still requires independently witnessed full endpoint replacement
and the single verified handshake. Accounting and normal guarded startup remain
separate operational gates.
