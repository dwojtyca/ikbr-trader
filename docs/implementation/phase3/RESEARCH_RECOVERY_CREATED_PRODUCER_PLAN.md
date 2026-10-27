# Research recovery for a never-started producer

## Observed problem and scope

2026-10-27: the published disabled-write deployment recreated the application
containers with `--no-start`. Accounting owner recovery completed, execution is
running with writes disabled and durable entry pause, and llm-agent is `created`.
Research recovery rejects that container before persisting an operation ID:
`RESEARCH_RECOVERY_PRODUCERS_NOT_QUIESCENT`. Read-only database inspection found
no research recovery challenges, two legacy interrupted Marketaux acquisitions,
and unresolved WSH acquisitions. Starting the producer merely to obtain a stopped
container would risk provider requests before recovery.

Extend the existing research producer evidence with an explicit never-started
variant. Do not fabricate start/finish timestamps, change old evidence semantics,
clear UNKNOWN directly, reuse accounting reset evidence, or broaden trading scope.
Owner authorization remains continuous Paper PKO/AAPL with existing gates.

## Contract

- Preserve existing exited/dead evidence byte shape and validation.
- Add a discriminated `created` producer variant with actual Docker creation time,
  `startedAt: null`, `finishedAt: null`. Exact keys, strict types, valid finite
  canonical creation time no later than first producer observation are required.
- The host accepts created only with Running/Paused/Restarting false, Pid zero,
  and BOTH Docker start/finish timestamps equal the Docker never-started sentinel.
  All image, project, service, oneoff, entrypoint, command and inventory checks
  remain. Never reinterpret running, paused, restarting, removing, dead or exited
  containers as created. Preserve before/after identity equality checks.
- Include Docker Created in the bounded inspect output. Parse it strictly; reject
  malformed/future creation timestamps. Keep active and unknown producers blocked.
- The server shared parser must validate this variant independently. Durable JSON
  evidence retains audit; the additive database guard amendment below is required.
- No changes to challenge identity, source scope, budgets, deadlines, execution
  pause, WSH observed reset/handshake, broker writes or provider calls.

## Bounded files and delivery

Implementation: shared `instrument-research/startup-recovery.ts`, its focused
unit/integration tests; `research-recovery-host.ts` and focused host/CLI tests.
Update the startup research runbook and a package report. Any need to change
critical semantics beyond this contract returns for plan amendment and review.

Independent Astra/high plan review precedes implementation. A different
Astra/high agent performs hostile final review. Keep unrelated research changes
untouched. Work on main; scoped commit/push and exact-commit CI required.

## Acceptance and validation

Tests accept genuine never-started evidence end-to-end and retain old evidence.
Reject nonzero PID, true running/paused/restarting flags, nonzero lifecycle times,
missing/null/malformed/future creation time, unexpected fields, image/config
mismatch and producer replacement between observations. Database integration
must exercise commit with created evidence while preserving original attempt
history/budgets and WSH reset requirements. Run lint, typecheck, unit tests,
integration against isolated PostgreSQL, build and clean Docker build. No strategy
or simulator changes; no new backtest required. Report commands/results, review
identities and findings, model/effort, elapsed time and available token usage.

Deploy only reviewed published image with private release proof refreshed and
all producer services stopped. Preserve backup and disabled writes. Read-only
inventory should then pass; follow existing prepare/observe/commit recovery
protocols. A successful inventory or recovery is not proof of trading readiness.

## Reviewed scope amendment: durable audit guard

Isolated integration rejected all three positive created commit cases because
migration 37's `research_recovery_audit_guard` independently accepts only
exited/dead. The initial plan missed this database dependency; do not modify an
applied historical migration or bypass the trigger.

Add migration `000040_research_recovery_created_producer.sql` replacing only that
function. Preserve all existing prepare, supersede, challenge, commit, hash and
legacy producer checks. The created branch must require an exact eight-key
producer object, valid identity/image/project/service, explicit JSON null start
and finish, canonical finite UTC millisecond creation time not later than the
first producer check. Missing/unknown discriminator rejects. Reject malformed
and impossible dates without permitting NULL SQL logic to accept them. Existing
exited/dead behavior remains compatible. No tables/columns/data updates, no direct
state repair and no removal of audit history.

Add isolated raw-SQL forgery tests proving malformed created evidence cannot enter
audit (missing/null/noncanonical/future creation time, wrong lifecycle, extra key,
invalid state), with valid challenge and hash bindings so failures exercise the new
producer guard. Keep positive Marketaux/WSH tests and old-format coverage. Update
only existing migration-list expectations that need migration 40; explicitly test
new migration applied once/idempotently and history preservation. Deployment
requires backup and the existing migration runner before new recovery commands.

Independent Astra plan amendment review and hostile final SQL/implementation
review are required. Rerun all required checks against final code and Docker image.
