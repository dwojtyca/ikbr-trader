# Accounting native inventory repair report

Date: 2026-10-26. Status: implementation accepted; local validation passed; publication/CI pending.

## Failure and scope

The observed Paper recovery remained PREPARED after native inventory failed
before any TWS reset or handshake. Read-only reproduction passed three captures,
then failed at the two-ps PID join when a process disappeared between views.
The prior real-native fixtures filtered out unrelated process rows and missed
this ordinary host churn. No broker call or recovery retry was used to diagnose it.

The [accepted plan](PAPER_ACCOUNTING_NATIVE_INVENTORY_REPAIR_PLAN.md) replaces
that join with strict single-invocation framing. Complete argv classification,
exact owned-process checks, socket inventory, Docker events, operator evidence
and all backend guards remain. No strategy, shared protocol, database migration
or broker transport changes are included. Unrelated local research work is excluded.

## Routing and evidence

Plan author/implementation: `observer_inventory_diagnosis`, requested Astra/high.
Independent plan reviewer: `zero_start_final_review`, requested Astra/high,
ACCEPT without blocking findings. Final hostile review: different independent `native_inventory_final_review`,
requested Astra/high, ACCEPT without blocking findings or review repairs; no edits.
Independent focused tests: 28 passed, four opt-in native/Docker skips, exit 0.
An initial tsx CLI invocation was sandbox-denied for its IPC listener; the normal
node --import tsx test runner passed without changing source or assertions.
Mechanical clean-context preparation: `owner_validation`, requested Luna/low;
archive of baseline 4c46a70 and frozen pnpm9.5.0 install passed.
Actual model/effort telemetry, elapsed attribution and token usage unavailable.
Full validation, review and publication evidence will be recorded before completion.

## Operational boundary

Existing PREPARED maintenance remains active. MongoDB and mongo-express were
stopped with explicit owner authorization. TWS remains running; no reset was
requested. After approved deployment, fresh operator evidence and supported
supersession are required; no timestamps or prior proofs may be refreshed merely
to continue the old operation. Source delivery does not claim recovery or trading.


## Focused implementation validation

The author changed exactly the four allowed tools source/test files. Focused
host/CLI/research-host suite: 44 passed, one optional native test skipped.
Explicit real-native test then passed with eight unfiltered global snapshots
under controlled unrelated process churn and exact long/spaced path checks.
All three real Docker fixtures passed, including unfiltered owned Compose process
binding. Test containers used network:none and explicit harmless entrypoints;
no application worker or broker connection was launched. The default Node test
image was absent; the existing approved 4c46a70 image was used with those explicit
fixture commands. Fixture containers were removed in finally cleanup.

Package typecheck and scoped diff check passed. Two early targeted parser-format
runs identified header/separator offset mistakes; those were corrected against
actual macOS evidence without changing guards or acceptance. No semantic scope
escalation or model downgrade. Final independent review accepted; publication and exact-commit CI remain pending.

## Full validation

Clean archive of 4c46a70 plus only the eight reviewed package files, frozen
pnpm 9.5.0 dependencies, Node 24.4.1: lint, typecheck, full test rerun and build
all exited 0. The first full test run overlapped other validation and failed two
existing short-timeout llm-agent tests (late resolver not initialized and timeout
before local server receipt). The full rerun passed without source/assertion changes.
Mechanical worker logs also recorded successful test/build; lead validation was
retained as independent explicit exit-code evidence.

Full test:integration exited 0 against the dedicated isolated PostgreSQL container,
using the clean candidate image and ikbr_trader_ci database. Operational data was
not used for fixtures. No-cache candidate Docker build passed, image
`sha256:ea3ad316d9de027255d26d8df7e26c1668a4a1126884626bb9560462cbd10dff`.
No strategy/simulator changes: backtests are not applicable. Scoped diff and
relative documentation links were checked. Publication and exact-commit CI are
required before deployment; operational receipts remain private.
