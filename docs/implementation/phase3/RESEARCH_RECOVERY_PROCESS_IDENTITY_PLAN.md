# Research recovery: bind the actual configuration process

Status: bounded critical plan accepted by independent Astra/high reviewer
`research_process_identity_diagnosis` on 2026-10-27; implementation remains
subject to full validation and publication. No trading readiness claim.
Owner scope remains continuous Paper PKO/AAPL, existing risk/AI/budgets and audit.

## Evidence and contract

Production prepare succeeds but read/observe fails: execution research heartbeat
uses the broker/lifecycle owner string, while authenticated configuration diagnostics
uses the independent TradingConfigurationRuntime process UUID. The store binds the
former into a challenge and the backend compares it with the latter. Mocked CLI
fixtures used one identity and missed this production wiring discrepancy.

Change the execution research observation to use configurationRuntime.processId,
the same process identity published by configuration diagnostics and configuration
registration. Preserve EXECUTION_PROCESS_OWNER_ID for broker, submission, accounting
and lifecycle ownership. Preserve strict challenge equality, current account/config/
manifest, durable pause, producer evidence, expiry, WSH reset and audit guards.
Do not rewrite historical challenges or observations, relax equality, accept both
namespaces or change budgets/provider retry rules. Restart creates new authority;
old challenges require the supported supersede procedure and fresh evidence.

## Bounded implementation and acceptance

Files: apps/execution-engine/src/index.ts and focused execution/research recovery
regression tests; shared or llm-agent test files only as necessary to exercise
real runtime/store wiring, not change their production contracts. Update the
startup research runbook and package report. No schema changes or new abstraction
solely to test a single assignment. A fixture-only equality test is insufficient.

A regression must fail with old production wiring and pass with the corrected
configuration identity. Exercise real TradingConfigurationRuntime registration/
diagnostics and ResearchStore challenge creation/read where practical with isolated
PostgreSQL; include restart/stale challenge rejection and supported supersession.
Keep wrong account, configuration, pause and process rejection coverage. Document
any distinction between source-wiring verification and runtime integration evidence.

Independent Astra/high plan review before implementation; a different Astra/high
hostile final reviewer. All required lint, typecheck, unit, isolated PostgreSQL
integration, build and clean Docker build; no strategy/backtest behavior changes.
Scoped commit/push on main and successful exact-commit CI before deployment.
Preserve unrelated local research changes. Record reviews, models, repairs, commands,
elapsed time and unavailable token telemetry honestly.

## Operational deployment

Keep writes disabled and durable entries paused. Backup first. Before stopping
execution, disable its automatic container restart, identify exactly one application
Node process by executable/arguments/cwd, signal it directly and await exit. Plain
Docker stop through pnpm was reproduced to kill the wrapper before Node cleanup.
Confirm the durable accounting owner is RETIRED; exit zero alone is insufficient.
On failure retain hold and use supported recovery, never edit owner rows. Recreate
with the approved profile restores its configured restart policy. Pin reviewed
image, refresh private proof, start execution only, wait for old observations to
expire and verify current identity. Supersede stale research challenge through the
existing protocol, then normal Marketaux and WSH recovery. Qualification, joined
capture and normal guarded startup remain mandatory; this package does not itself
activate trading or certify research coverage.
