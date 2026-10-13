# Continuous Paper startup repair

Date: 2026-10-13. Baseline: `cc5ada1`. Source repair accepted and required local
validation passed. Scope and reviews: [plan](CLI_PAPER_START_REPAIR_PLAN.md),
[plan review](CLI_PAPER_START_REPAIR_PLAN_REVIEW.md),
[final review](CLI_PAPER_START_REPAIR_IMPLEMENTATION_REVIEW.md). At publication,
exact-commit CI and subsequent operational startup remain pending; their results
will be recorded separately in private delivery receipts and the delivery
response. This report does not claim a broker trade.

## Cause and repair

The preceding release required a nonblank legacy `TRADING_LOOP_INSTRUMENT_IDS`
in its private-profile validator. The shared bundle loader explicitly forbids
this competing configuration authority. The deployed signal-engine repeatedly
exited with `CONFIG_AUTHORITY_CONFLICT`; its configuration heartbeat expired,
leaving `CONFIG_SERVICE_UNAVAILABLE`, reported by startup as
`ENTRY_START_CONFIGURATION_UNAVAILABLE`. Ingestion, execution and llm-agent had
current matching bundle identities. The previous CLI fixture used an invalid
empty bundle and an invented canonical hash, missing the contradiction.

CLI preflight now uses the actual shared loader for every service against the
proof-covered strategy file and derives entry scope from validated `entryEnabled`
rows. Existing file/image/config proof and entry/close/risk/research controls are
unchanged. Diagnostics display only known configuration reasons and do not grant
authority; repeated unchanged waits are suppressed. Startup messages describe
automatic preparation. An explicit start still protects preparation with an
audited pause and automatically resumes through the existing gate; an explicit
stop or interruption still cancels that start.

## Operational evidence so far

Initial read-only diagnostics found completed healthy ingestion bootstrap for
two instruments, clean current reconciliation, no broker positions or open orders,
and no active reconciliation holds. Stored research was stale with a calendar
error; it must be refreshed through the existing queue before readiness. Current
state reconciliation alone does not certify historical completed orders.

The source also retained `ACCOUNTING_CLOCK_INVALID`. Its latest recorded rejected
clock was 2026-10-12T15:24:59.895Z with +128895 ms skew (the collector limit is
2000 ms); no recent rejected-clock observation proved an ongoing clock failure.
The lead used `pnpm stop` (confirmed revision 7), retained exit services, then
temporarily deployed execution with writes disabled and startup entries paused.
One supported authenticated `recover-clock` operation succeeded and saved a
private receipt. No observations/holds were deleted, no source qualification was
renewed, and no broker order was submitted. At 08:27:23Z the source had no hold,
no pending persistence and a fresh joined capture; reconciliation was clean with
zero positions/open orders/active holds. Research readiness remains required.

## Validation and delivery

Focused runtime tests: 34 passed; package typecheck and diff check passed. An
initial package test invocation was sandbox-blocked on loopback listening. Two
host aggregate attempts subsequently exposed a pre-existing fixture cleanup bug:
`listenOnDefaultPorts()` binds port 3102, then `Promise.all` rejects for occupied
operational ports 3101/3103 and loses the bound server handle. A focused reproduction
confirmed the assertions passed while that listener kept the test process alive.
An isolated app-image test attempt then exposed its lack of the Docker CLI,
needed by the Compose configuration tests. The accepted plan amendment adds only
cleanup of successful test listeners before propagating partial bind failure;
no test assertion is removed and operational exit services stay available.
The earlier parallel UI failure passed its targeted rerun and the sequential run.
Final `pnpm lint`, `pnpm typecheck`, full `pnpm test` with workspace concurrency 1,
`pnpm build` and clean `docker build --no-cache` passed. `pnpm test:integration`
passed against isolated PostgreSQL on port 55432 before the final test-only
listener cleanup; production source did not change afterward. The fixture package
completed 207 tests with no failure/cancellation. No operational database fixtures
were used. Logs are in `/private/tmp/cli-paper-repair-validation-20261013-logs`.

Final image:
`sha256:7a45317830bae0656c88a075c4c1db8d804f5f313fb46b1f3611947d8a1a349c`.
It passed actual config-module imports for all four corrected environments and
rejected the old signal environment with `CONFIG_AUTHORITY_CONFLICT`. Containers
had no network and read-only mounts; no service entry point was imported.

The corrected private profile is installed, backed up under the ignored
`.local/paper-runtime/repair-20261013` directory. Only the conflicting legacy
allowlist was cleared and four app image references replaced. Strategy, research,
accounting evidence, rights, expiry and budget bytes were preserved. The existing
file/effective-config release proof was reissued for this reviewed deployment;
`pnpm paper:runtime check` passed. This action did not start services or resume
entries. Subsequent startup must use the supported guarded flow after successful
exact-commit CI. Unrelated backtest/signal-engine changes are excluded from the
clean snapshot and publication.

## Agent routing

| Work | Requested / actual model | Effort | Evidence |
| --- | --- | --- | --- |
| Read-only live diagnostics | gpt-6-luna / gpt-6-luna | medium | Identified crashing peer, conflicting key, next readiness blockers |
| Independent plan review | gpt-6-astra / gpt-6-astra | high | Accepted, no blocking findings |
| Bounded CLI implementation | gpt-6-sol / gpt-6-sol | medium | Existing loader integration, regressions, diagnostic output |
| Checks/build/publication | gpt-5.6-luna / gpt-6-luna | low | Stronger available fallback; required local checks passed |
| Fixture cleanup | gpt-6-sol / gpt-6-sol | medium | Confirmed leaked listener; bounded accepted test-only cleanup |
| Independent final review | gpt-6-astra / gpt-6-astra | high | Accepted, including test cleanup; different from author and plan reviewer |

Lead owns critical diagnosis/contract, integration and authorized operational
steps. No failed targeted code repair; one message wording completion and one
independently accepted test-cleanup amendment. The hanging fixture was escalated
from mechanical checks to Sol for diagnosis. Exact per-agent token telemetry is
unavailable. Elapsed from plan creation (08:15Z) to validated installed profile
(approximately 08:47Z): about 32 minutes, excluding initial diagnosis. Per-agent
elapsed telemetry is unavailable except the plan review's approximately 3 minutes.
