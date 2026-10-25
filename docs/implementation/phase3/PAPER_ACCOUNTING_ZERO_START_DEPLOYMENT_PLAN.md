# Accounting recovery: zero-start image deployment

Date: 2026-10-25. Status: ACCEPTED by independent Astra/high plan review as a bounded amendment to the accepted
[owner recovery contract](PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md).
Owner request: finish the work necessary to start Paper. Baseline: `4328079`.

## Observed incompatibility

The accepted collector requires four core containers on the pinned image with
normal commands and exited/dead states. Updating an image without running it
produces Created containers. They are rejected, so a new installation would have
to start ordinary producers simply to fabricate an exited inventory. Master=false
does not prevent ingestion/provider activity. Do not start producers for that reason.

## Exact contract amendment

Accept an additional explicit never-started producer variant, only when the complete
trusted Docker inventory verifies the same project/service/image/normal command/
entrypoint/non-oneoff identity checks already required. Require State.Status=created,
Running=false, Paused=false, Restarting=false, Pid=0 and both Docker StartedAt and
FinishedAt exactly `0001-01-01T00:00:00Z`. Require a valid Docker Created timestamp,
not in the future at observation. Other representations, missing fields, nonzero
timestamps/PID, unknown states, wrong image/command and running containers still deny.

Represent this truth in shared wire data as a discriminated union:
`state: created`, `createdAt: ISO timestamp`, `startedAt: null`, `finishedAt: null`.
Do not invent start/stop times. Existing exited/dead records retain their current
fields and checks, with no createdAt field. For created records, shared validation
requires createdAt<=inventory.observedAt and both null timestamps. Strict parsers
reject cross-variant fields and invalid combinations.

Keep all four mandatory core services, global Docker/native/socket inventory,
exact immutable container comparison across observations and Docker event watcher.
Never-started records cannot be listed as absent. A create/start/stop/replacement
after initial observation still aborts the witness. Old stopped images/duplicate
unknown containers are not grandfathered. Existing optional absence behavior stays.

This proves only that these specific new containers have not started. It does not
prove the old accounting transport ended. Whole TWS reset, current account-wide
flat evidence, all other operator attestations, token, maintenance, handshake,
deadline, CAS/receipt, and independent qualification/research gates remain required.
No SQL migration or automatic owner takeover is added. Old binaries reject the
new variant; pin matching host/backend source/image. Existing pending operations
cannot import the changed deployment and require supported supersession/reset.

## Scope and routing

Astra/high implementer: shared accounting-owner-recovery types/parser and test;
paper-verify-stack accounting-owner-recovery-host and host/Docker tests; focused
backend PG fixture if needed to prove created evidence through the unchanged store;
contract, accounting runbook, this plan and package report. No other runtime changes.
Root updates deployment receipts only after tests/review/CI. No broker/provider
calls in development. Preserve unrelated dirty ES/signal files.

Independent Astra/high plan reviewer must accept before code. A different
Astra/high final reviewer must not author any edits. Escalate any proposed broader
state support, historical-owner assumption, missing inventory or wire semantic
change; do not change denial rules merely to satisfy tests.

## Acceptance and validation

- Accept genuine created containers for core and optional services only with exact
  zero process/timestamps and expected image/commands; preserve exited/dead behavior.
- Reject contradictory state/PID/timestamps, missing/future Created time, wrong
  image/service/project/command, duplicate unknown producer, and absent core.
- Strict shared parser accepts only the new explicit union, preserves old records,
  and rejects forged start/finish or createdAt mixtures.
- Create a real isolated network:none Docker container without starting it. Capture
  its real inspect shape and prove collector acceptance. Verify start/replacement
  events revoke observation; no test contacts the broker or operational DB.
- Through synthetic store evidence, created inventory still requires the entire
  reset/operator/handshake/receipt protocol. No shortcut retires an old owner.
- Full lint/typecheck/test/integration on isolated PostgreSQL/build, clean Docker
  build, independent final review, scoped main publication and exact-commit CI.
  No strategy change or new backtest is involved.

## Deployment

After accepted publication/CI, back up profile/database, preserve master=false and
durable pause, verify all ordinary apps nonrunning, pin the exact image, migrate
through the existing runner if necessary, and use Compose up --no-start --no-deps --force-recreate
(with --no-build --pull never) for the configured apps, leaving database/cache
dependencies untouched. Verify their exact never-started inventory
and unchanged owner/hold/pause. This prepares recovery, not trading readiness.
Do not initiate recovery before current TWS/operator and host-topology evidence.
Do not stop unrelated project containers without owner authorization.

Plan reviewer: `diagnose_profile`, requested gpt-6-astra/high, ACCEPT without
repairs. Reviewer made no edits; token and elapsed telemetry unavailable.

## Validation amendment: observe failed-owner PostgreSQL teardown

Full isolated integration found an existing fixture race at
`source-owner.pg-integration.test.ts:57`: immediate acquisition after
`retire(false)` and `release()` expects UNRETIRED but can see CONFLICT.
Neither production owner source nor that fixture had changed when the race was observed.
The focused candidate passes; pg-pool destroys its client asynchronously, and
non-retired release intentionally provides no early advisory-unlock proof.
Both denials are safe, but the test must establish backend teardown before
asserting the durable-row denial.

Bounded additional file: that PG test only. Capture the third owner's exact
advisory-lock backend PID before retire(false), asserting exactly one granted
matching lock in the current database. After release, use a monotonic deadline
of at most two seconds and bounded read-only pg_locks observations for the same
PID/key/classid/objid/objsubid and database. Require verified lock absence, failing
on deadline. Then perform exactly one acquisition and preserve the exact
UNRETIRED assertion. Do not poll acquisition, broaden the accepted error, delete
rows, unlock externally or change production release semantics. Existing UNKNOWN
and local loss assertions remain. Review this addition before implementation;
the independent final reviewer checks the actual diff. Rerun targeted PG and full
required checks on the final clean scope. No change to deployment or broker gates.

Validation amendment plan: `teardown_plan_review`, Astra/high, ACCEPT; final
test-only diff: `zero_start_final_review`, Astra/high, ACCEPT without blocking
findings. No production ownership changes.
