# Accounting recovery Docker event retention repair

Date: 2026-10-26. Status: ACCEPT by independent `event_watcher_plan_review`
(`gpt-6-astra`/high), no blocking findings; implementation authorized. Baseline: `5c25ca5`; preserve unrelated research work on main.

Amendment: realistic stream-volume acceptance below ACCEPT by independent
`event_watcher_plan_review` (Astra/high), zero repair rounds; implementation authorized.

## Failure evidence and scope

The replacement recovery operation remained PREPARED after observing the full
manual TWS stop and replacement. It exited with INVENTORY_UNAVAILABLE while
waiting for fresh post-reset evidence, with no handshake dispatch. The original
stack was not retained, so attribution of that incident remains high-confidence
inference, not an observed original stack.

The current watcher replays from its original start on every `flush()` and rejects
256 or more returned lines before classifying events. Redis/Postgres healthchecks
produce `exec_create`, `exec_start` and `exec_die` events; these are harmless under
the existing event guard but still consume Docker's global retained event buffer.
A read-only replay returned exactly 256 such events spanning only 216 seconds.
The failed observation had lasted approximately eight minutes. Thus a current
production replay definitely triggers the guard, and a long healthy observation
cannot reliably fit this history window. The lead then reproduced the defect
with the production watcher alone: initial
flush passed; after 240 seconds the continuous stream guard still passed, while
flush failed with INVENTORY_UNAVAILABLE at the replay guard. No native collector,
TWS action, broker connection or container mutation was involved in that probe.

A controlled Unicode/multiline argv probe did not reproduce native framing
failure: installed C-locale `ps` escaped the supplied arguments into ASCII. Do
not weaken the accepted native parser or claim the private evidence writer was
the cause. Keep the [native repair contract](PAPER_ACCOUNTING_NATIVE_INVENTORY_REPAIR_PLAN.md)
and all [owner recovery invariants](PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md).

## Bounded event continuity contract

Retain the mandatory live Docker event stream, fail-closed stream loss, existing
container lifecycle classification and exact one-shot exception. Replace replay
of the entire operation with retained-anchor checkpoints established before any
initial producer inventory. Do not remove the overflow rejection, assume history
is complete because fewer than 256 filtered records arrived, or filter health
events at the daemon to hide global retention pressure.

1. Establish an initial anchor from a bounded **unfiltered global** Docker event
   snapshot before initial producer inventory or recovery backend launch. This
   bootstrap is a new observation boundary, not proof of earlier history. It may
   select the last event in a full retained buffer: earlier history precedes the
   boundary and is not claimed as witnessed. No event, malformed output, missing
   timestamp, ambiguous anchor, timeout or unavailable Docker evidence denies.
   Record the actual initialized boundary in returned `startedAt`; do not claim
   continuity from the earlier process-spawn time. Start the mandatory stream
   around bootstrap, with replay covering the interval before stream receipt.
2. Keep one private in-memory anchor: the exact event-line SHA-256 and its safe
   integer Unix `time` seconds. Hash raw event bytes so `timeNano` is not silently
   rounded through JavaScript numbers. Never log/store raw event attributes,
   action suffixes or commands. Query from at least one second before the anchor
   time, so equal timestamps and inclusive/exclusive boundary behavior cannot
   omit the anchor. Only an exact single occurrence of the previous anchor
   establishes continuity. Events before that matching anchor are overlap;
   classify every subsequent event before advancing to the final returned event.
3. During the observation, perform serialized finite replays at a fixed one-second
   cadence, with the existing bounded command timeout/output limits. No overlap,
   unbounded queue, retry-until-success or detached unhandled rejection is allowed.
   Each replay is unfiltered globally, requires the previous exact anchor and
   rejects 256 or more records, malformed/ambiguous data and any command failure.
   If benign traffic exceeds the available buffer within a checkpoint interval,
   abort; no weaker continuity claim is substituted. Missing anchors also abort
   when a filtered/subset response would otherwise contain fewer than 256 rows.
4. Apply the existing guard to container events after the anchor; retain global
   non-container events for capacity/anchor continuity without treating them as
   broker producers. Validate the global envelope and only the fields needed for
   that role. Existing container validation remains unchanged. Container starts,
   stops, replacement, update, rename and other existing forbidden transitions
   remain fatal, including an event burst between inventory snapshots.
5. `flush()` waits for any checkpoint in progress and completes a fresh serialized
   replay before succeeding. `check()` reports already-latched failures. Stream
   error/stderr/closure, replay failure, deadline or cancellation latches failure
   once, cancels the backend, clears timers and prevents later success. A replay
   is not permission to continue after a lost stream. `close()` stops the timer
   and stream; a late result cannot re-enable a closed watcher or dispatch work.
6. Complete bootstrap before `startAccountingRecoveryBackend` performs initial
   inventory. Return the initialized watcher boundary to host evidence. Preserve
   the reserved-name/create-start allowance until actual inspected container
   identity binds it, including exact retrospective validation. No broker,
   backend/store, shared wire schema or operation-state change is required.

The implementation may adjust the local watcher API to make bootstrap awaitable;
all callers and fixtures must follow the explicit initialized-before-inventory
ordering. A bare timer or a last-seen timestamp without a retained exact anchor
does not meet this contract.

### Realistic stream-volume amendment

A later read-only measurement returned 256 container events totaling 408,336
bytes over 214 seconds. At that observed rate, fifteen minutes would produce
approximately 1.72 MB; the existing cumulative 1 MiB stream budget would still
abort an otherwise healthy operation after roughly nine minutes. The original
small synthetic event fixtures and four-minute live test did not cover this.

Set a fixed cumulative stream budget of 4 MiB for the existing maximum
fifteen-minute watcher lifetime. Keep the 64 KiB partial-buffer limit, 2 MiB
finite-command output limit, command timeout, replay capacity/anchor checks,
mandatory stream and deadline unchanged. This is a bounded counter, not retained
event storage. Overflow still latches failure and cancels the backend; no dynamic
growth or traffic-based relaxation is permitted. Test the fifteen-minute stream
and replay together with healthcheck-sized events (approximately 1.6 KiB at
1.2 events/second, exceeding 1 MiB cumulatively), plus explicit stream overflow
above 4 MiB and unchanged partial-buffer rejection. New source changes are limited
to the watcher budget and these existing acceptance tests.

## Diagnostics

Preserve existing public error codes. Add only sanitized local diagnostic causes
with fixed phase/reason values, for example watcher bootstrap unavailable,
replay overflow, replay anchor missing/ambiguous, malformed event, stream stderr,
stream closure, or native inventory framing. Include safe numeric counts and
elapsed duration only where useful. Do not emit process argv, event JSON, labels,
tokens, account evidence or command suffixes. Preserve the first failure cause;
cleanup cannot replace it with a generic closed-state error. Any external cause
that is propagated must use existing sanitization. No wire-schema change.

## Task boundaries and acceptance

Critical implementation and integration: `gpt-6-astra`, high. Allowed files:
`accounting-owner-recovery-host.ts`, `accounting-owner-recovery-cli.ts` and adjacent
host/CLI/Docker tests under `tools/paper-verify-stack/src`, plus this phase3 plan,
package report and directly relevant owner-recovery runbook/contract wording.
No native parser relaxation, settings, migrations, ownership, broker transport,
application startup, strategy or research edits. Escalate changes to these
semantics rather than inventing a fallback.

- Deterministic tests cover a full 15-minute observation with health-event churn
  exceeding the retention window repeatedly, and prove serialized checkpoints
  retain a chain of exact anchors. Replay overflow and missing/duplicate anchors
  still fail, including fewer-than-256 results after historical loss.
- Cover bootstrap with a full historical buffer, no available anchor, bootstrap
  failure before inventory/backend, same-second events, malformed envelopes,
  non-container global churn, startup stream delay, producer start-stop bursts,
  exact one-shot create/start binding and impersonation, failed commands,
  concurrent explicit flush/timer execution and delayed results after close.
- All existing stream-loss/start-stop rejection tests continue to pass. Assert
  safe diagnostic causes without secret-bearing event/process content leakage.
- A real isolated watcher test lasts beyond one observed global retention window
  using existing harmless health traffic or dedicated network-isolated fixtures;
  demonstrate checkpoints advance while the original anchor is eventually evicted.
  Never operate the broker or operational DB, and coordinate Docker fixtures so
  unrelated test starts cannot invalidate an active operational observer.
- Run focused host/CLI/Docker and research regressions, then `pnpm lint`,
  `pnpm typecheck`, `pnpm test`, isolated-PostgreSQL `pnpm test:integration`,
  `pnpm build`, and a clean Docker build. No strategy backtest behavior changes.
- Obtain independent Astra/high plan acceptance before implementation and a
  different independent Astra/high hostile implementation review afterward.
  Publish only reviewed files on main and verify exact-commit CI. Report model/
  effort, repairs, timing, available tokens (otherwise unavailable), commands,
  exit codes and exact commit/image/CI evidence.

## Deployment and recovery continuation

Leave the interrupted operation and maintenance intact. No active collector or
backend may survive deployment replacement. After reviewed clean-image deployment
with stopped apps and writes disabled, use fresh operator evidence and supported
supersession for the same exact owner. Never continue the interrupted observer,
reuse its reset witness, refresh a human confirmation timestamp or clear records.
Any later observation requires a new full operator-performed reset under the
existing authorized scope and runbook. This repair does not authorize trading or
remove independent accounting/research holds.
