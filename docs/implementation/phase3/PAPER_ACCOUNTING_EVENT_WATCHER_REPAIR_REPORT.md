# Accounting recovery event watcher repair report

Date: 2026-10-26. Status: implementation accepted; full local validation passed;
publication/CI pending; not deployed.

## Problem and resulting behavior

The replacement owner recovery observed a manual TWS stop and a new process,
then failed with `ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE`. Exact durable
status remained PREPARED with only its PREPARED event: no handshake dispatch,
retirement or trading activation. The original stack was not retained; attribution
of that incident is an inference from the independently reproduced defect.
Private operation/account evidence remains local.

The old watcher replayed from the operation's original start and rejected 256
records. A read-only replay returned 256 harmless healthcheck events spanning
216 seconds. In an isolated unmodified-production-watcher probe, initial flush
passed and the continuous guard still passed after 240 seconds, but final replay
failed. It opened no broker connection and mutated no containers or operational
data. This reproduces the retention defect independently of TWS and the native
collector. C-locale ps escaped controlled Unicode/multiline arguments; that
alternative hypothesis was not reproduced and no native parsing guard was relaxed.

The [accepted plan](PAPER_ACCOUNTING_EVENT_WATCHER_REPAIR_PLAN.md) replaces
whole-operation replay with serialized one-second checkpoints linked by a unique
exact retained event hash. Bootstrap precedes initial inventory. The mandatory
stream, unfiltered global replay, overflow rejection, anchor-loss rejection,
exact one-shot identity and cancellation rules remain. Fixed local phase/reason
diagnostics distinguish failures without exposing raw process/event payloads.

A later measurement of 408,336 bytes over 214 seconds projects to approximately
1.72 MB in fifteen minutes, above the inherited 1 MiB cumulative stream limit.
A separately accepted amendment raises only that fixed lifetime cap to 4 MiB.
The 64 KiB partial buffer, 2 MiB finite-command output, 256-record replay rejection
and fifteen-minute deadline remain. The counter never resets. No ownership,
settings, migrations, native parser, strategy, broker transport or wire-schema
changes are included.

## Validation

- Final author focused host/watcher/CLI/research suite: 57 passed, one optional
  native skip; package typecheck and scoped diff check exited 0.
- Three real network-isolated Docker/Compose fixtures passed, including actual
  native Compose identity and forbidden-container activity; cleanup completed.
  An initial sandbox socket denial was resolved by the authorized escalated run,
  without weakening code or tests.
- Final independent watcher run: 13/13 passed. Coverage includes fifteen-minute
  turnover, exact anchors, startup gaps, malformed times/order, stream loss,
  serialization, close races and first-cause diagnostics.
- A realistic 899-second stream/replay test processes 1,079 records of 1,600 bytes
  (1,726,400 bytes), passes final flush and denies at the 900-second deadline.
  Exactly 4,194,304 cumulative bytes pass; the next byte fails closed. Exactly
  65,536 unterminated buffered bytes pass; the next byte fails, cancels once,
  clears timers and keeps later flushes failed.
- The lead's first new-source 240-second live watcher probe passed. A second probe
  captured the initial exact anchor hash, demonstrated its absence from the final
  retained 256 global events, and completed 237 checkpoint calls plus final flush
  successfully. Neither probe connected to the broker. Receipts remain private.
- Clean archive of baseline `5c25ca555965624f2a76d5a4fdc987d55738a154` plus only the
  eight package files, Node 24.4.1 and frozen pnpm 9.5.0: final lint, typecheck,
  full test and build exited 0. Full tests used
  `npm_config_workspace_concurrency=1`; all assertions and timeouts were retained.
  Earlier parallel runs failed existing short-timeout completed-order phase and
  HTTP-abort tests under load. The completed-order file passed separately unchanged.
  The final full test log includes the last added partial-buffer regression;
  lint/typecheck were repeated afterward for that test-only addition.
- Clean no-cache candidate Docker build passed:
  `sha256:12a51ca87ce8560fda2bfd3dc17e6d3930dc47740a7a6a7a54dabf91020e069d`.
  Full `pnpm test:integration` exited 0 against the dedicated isolated PostgreSQL
  container and `ikbr_trader_ci` database; operational data was not used for fixtures. No strategy/simulator changes:
  additional backtests are not applicable.

## Routing and review

Diagnosis/plan/implementation: `observer_inventory_diagnosis`, requested
`gpt-6-astra`/high. Independent plan and bounded amendment reviewer:
`event_watcher_plan_review`, requested Astra/high, both ACCEPT with zero repair
rounds. Different final implementation reviewer: `native_inventory_final_review`,
requested Astra/high, final ACCEPT. One test-only acceptance gap (partial-buffer
boundary) was requested and repaired; no runtime relaxation was needed. Author
validation also tightened malformed timestamp/ordering and late-failure handling.
No model downgrade or unresolved review finding remains.

Mechanical clean-context preparation: `owner_validation`, requested
`gpt-5.6-luna`/low, archive and frozen install exited 0. Lead owned the live probes,
full validation and publication coordination. Actual model telemetry, per-worker
elapsed attribution and token usage are unavailable. Each live probe's measured
wait was 240 seconds. No efficiency percentage is claimed.

## Publication and operational boundary

Publish only the reviewed eight-file scope on main and verify exact-commit CI.
Source publication is not evidence of deployment or trading. The interrupted
operation, original owner, maintenance and entry pause remain; TWS is running.
A fresh operational backup was validated with pg_restore list. Deployment must
preserve those records and leave app containers stopped with writes disabled.
Supported supersession then requires fresh operator evidence and a new observed
reset; the interrupted witness cannot be reused. Qualification, clock and research
holds retain their own recovery requirements.
