# Research recovery process identity repair

Date: 2026-10-27. Status: implementation, independent hostile source review and
all required local checks passed. Publication and exact-commit CI remain pending. This report does not certify deployment or trading readiness.

## Change and invariant

The execution research startup observation and recurring heartbeat now use
`configurationRuntime.processId`, matching configuration registration and the
authenticated configuration diagnostics. Previously they used
`EXECUTION_PROCESS_OWNER_ID`, so a prepared challenge could not pass the recovery
CLI's exact process comparison. Broker, accounting, submission and lifecycle
ownership continue to use their existing owner ID; the production change is one
assignment in `apps/execution-engine/src/index.ts`.

The [accepted plan](RESEARCH_RECOVERY_PROCESS_IDENTITY_PLAN.md) preserves strict
process, account, configuration, manifest, pause, evidence and expiry checks.
There is no schema migration, namespace alias, historical-row rewrite or provider
retry change. The [runbook](../../runbooks/PAPER_STARTUP_RESEARCH_RECOVERY.md)
explains old-observation expiry and supported supersession of old owner/process
challenges using fresh evidence.

## Regression evidence

- The execution test parses the actual production `observeResearch` initializer,
  transpiles and invokes only that callback twice with distinct process and broker
  owner IDs. It does not import the application entrypoint or open broker sockets.
  On the original production assignment, the test failed with the broker owner
  string instead of the expected UUID; after the correction it passes. This is
  source-wiring evidence, not a full application startup test.
- The shared PostgreSQL test uses real `TradingConfigurationRuntime`
  initialization/heartbeat/diagnostics, `TradingConfigurationStore` registration
  and `ResearchStore` prepare/read/commit/supersede methods. It creates a challenge
  in the old owner namespace, rotates to the configuration UUID, rejects stale
  reads and commits, and supersedes through the supported protocol. A second
  runtime generates a new UUID and repeats stale rejection and supersession.
  Assertions retain original canonical history, a single active challenge, two
  supersession audit records, durable pause and no recovery receipt. Timestamp
  expiry is synthetic and limited to the disposable fixture database. This case executed successfully against isolated PostgreSQL (1,159 ms);
  it was not skipped.
- The CLI test retains the strict read guard for a legacy owner string, another
  process UUID, wrong account/configuration/manifest, changed pause revision and
  restart. Existing auth, stopped-peer and reconnect checks remain unchanged.

## Commands run by the implementation worker

| Command | Result |
| --- | --- |
| `pnpm --filter @ikbr/execution-engine exec node --import tsx --test src/research-process-identity.test.ts` before correction | Expected failure: 0 passed, 1 failed; exit 1 |
| Same command after correction | 1 passed, 0 failed; exit 0 |
| `pnpm --filter @ikbr/llm-agent exec node --import tsx --test src/research-recovery-cli.test.ts` | 7 passed, 0 failed; exit 0 |
| `pnpm --filter @ikbr/shared exec tsc -p tsconfig.json --noEmit` | Exit 0 |
| `git diff --check` | Exit 0 |

Full lint, typecheck, unit, isolated PostgreSQL integration, build and clean Docker
build passed in the lead validation record below. No strategy/simulator behavior changed, so no new backtest
scope is introduced. No operational database, broker/provider call, service
restart, commit or push was performed by this implementation worker. Unrelated
backtest and signal-engine changes remain outside this package.

## Review and routing record

| Task | Requested / actual model and effort | Result | Repairs / escalation | Time / tokens |
| --- | --- | --- | --- | --- |
| Independent plan review | Astra/high as reported by lead; exact dispatch telemetry unavailable to implementation worker | ACCEPT reported by lead, agent `research_process_identity_diagnosis` | Findings supplied in bounded contract | Unavailable |
| Bounded implementation | Critical Astra/high route; exact dispatch telemetry unavailable to implementation worker | Focused checks above pass; full acceptance pending | No failed repair cycle or scope escalation; corrected expected error name during test authoring | Unavailable |
| Independent hostile implementation review | `gpt-6-astra` / high dispatched | ACCEPT source/tests/docs, full checks subsequently passed | No blocking findings; plan status clarified | Unavailable |
| Full checks and publication | `gpt-6-luna` / low dispatched, fallback described below | All local checks pass; publication/CI pending | One dependency environment repair, no source repair | Unavailable |

The lead must append actual dispatch, full-check, hostile-review, commit and CI
evidence before marking this package complete. Deployment must follow the plan's
disabled-write, paused-entry and confirmed accounting-owner retirement procedure.

## Lead validation record

Independent plan reviewer `research_process_identity_diagnosis` accepted without
blocking findings. Independent final reviewer `shutdown_owner_diagnosis`, who
did not author the change or plan, conditionally accepted the frozen source, tests
and documentation with no blocking findings, subject to all remaining checks.
The plan status was clarified as requested. Both reviewers and implementation
worker `research_identity_implementation` were dispatched as `gpt-6-astra`, high.
Independent backend model telemetry and token usage are unavailable. No critical
semantics were downgraded and no implementation repair or scope escalation was
required.

Mechanical worker `research_created_checks` uses `gpt-6-luna`, low, the previously
disclosed available fallback for unavailable `gpt-5.6-luna`. Validation uses a clean
archive of base commit `8cf5ee0bc9e1154721a658e349e8c6fe4592e096` plus only the
seven scoped files, with separate ephemeral PostgreSQL. Initial lint failed because
ESLint was missing in the copied dependency tree; frozen-lockfile installation
repaired this validation environment without source or lockfile changes. Subsequent
lint and typecheck passed. Unit tests passed: 4,256 total, 3,900 passed, 356 skipped,
zero failed. Integration passed: 3,135 tests, 3,135 passed, zero skipped or failed.
The new configuration runtime UUID supersession/restart test and actual production
callback regression both executed. Workspace build and clean Docker build passed.
The isolated PostgreSQL container was stopped afterward. Candidate image:
`sha256:66c7c33aaf356784802f01c99ed4752c31b543bddddd910279bf0fc8d0ccf0dd`.
Publication and exact-commit CI are the remaining release gates; the deployment
image must be built from the final published commit, not this pre-publication tag.
