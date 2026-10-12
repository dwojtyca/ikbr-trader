# Explicit continuous Paper start

Date: 2026-10-12. Status: accepted by [independent critical review](CLI_PAPER_START_PLAN_REVIEW.md); implementation in progress.
Baseline: `fe7f975` on main. Follow the owner's continuous PKO/AAPL direction in
[ROADMAP](../ROADMAP.md) and [runbook](../../runbooks/CONTINUOUS_PAPER.md).
The bot is stopped by owner request. This package implements and tests the command;
it does not run operational services, call providers, activate trading or renew
source/accounting qualifications. Existing unrelated backtest and signal-engine
working-tree changes are excluded.

## Problem and boundary

Resume requires current research for every entry-enabled instrument. The existing
signal-triggered preparation route requires entries already resumed. With news on
demand this can deadlock a deliberate start. Add a separate, explicit preparation
path under a durable entry pause, then use the existing resume gate. Do not relax
the signal preparation route, entry guards, research eligibility or budget rules.

The outcome is one owner command, `pnpm start`, which uses the approved private
configuration, connects to Paper, fills known missing/stale history and research,
checks existing gates and enables continuous operation until stopped. PKO/AAPL,
one whole share, one open position/instrument, no daily attempt count, USD5/day AI,
news on demand and existing no-extra-fee provider limits remain unchanged. No new
strategies, trading windows, UI, backtest service, subscription or secret output.
No automatic resume on execution process restart.

## Fixed control contract

Use the existing append-only entry-control revision and events; no new intent
framework/table or persistent startup daemon is needed. Each explicit start has
one UUID and unique reason `paper-start:<uuid>`. A later pause always increments
the revision, even if already paused, and invalidates every older pending start.

Extend existing `POST /execution/entry-control/pause` and `/resume` strict JSON
body with optional `expectedRevision`, a positive safe integer. Existing callers
using only `reason` retain behavior. When supplied, compare it to the current
revision under the existing account advisory lock and row lock, before the gate
or mutation. Mismatch throws HTTP423 `ENTRY_CONTROL_REVISION_CHANGED` with no
mutation. Pause remains authenticated/account-guarded with master off; resume
retains master/account/configuration/research/lifecycle/accounting guards. A
successful resume still increments revision and records the unique reason. CLI
must supply expectedRevision on resume. Readback uses existing authenticated GET
`/execution/entry-control`; advertise `startupProtocolVersion: 1` on this read-only
response so the CLI rejects an old image before producer startup rather than
waiting forever. Normalize PostgreSQL revision strings as safe integers.

Add authenticated, master-write guarded POST
`/execution/entry-control/start/prepare`, strict body `{expectedRevision}`. It
locks the same account control, requires current paused=true and exact revision,
and keeps that lock through preparation. The audit event at that revision must
have the exact reason format `paper-start:<UUID>` from this explicit start flow;
an ordinary pause is not preparation authority. Reject unadopted control, unpaused state,
revision drift, non-Paper, missing current allowed account/connection, non-bundle
or drifted configuration, wrong research identity, disabled research refresh,
unsupported/unbound entry-enabled contracts, and mismatched research budget
account. It does NOT call the new-entry permit: preparation is permitted while
paused, before research readiness and lifecycle/accounting readiness. Existing
configuration rollout authority and research authority/rights remain required.
No inputs may select a foreign account, manifest, instrument or arbitrary source.
Only server-derived current entry-enabled supported stock instruments are used.

Within this transaction call existing `ResearchStore.prepareRepair(identity, db)`
for each configured entry-enabled instrument. It only inspects/queues durable
repair work: it does not execute providers, AI, proposals, entry reservations or
broker orders. Its READY/WAITING/HOLD classification, source rights/expiry,
provider identities, request/cost budgets and unknown-outcome handling remain
unchanged. Return HTTP200 `{revision, instruments:[{instrumentId,...preparation}]}`;
return specific safe control/identity errors on rejected authorization. Repeated
successful preparation polls may coalesce the same durable queue; no new provider
call identity is introduced. A pause after queueing prevents resume but does not
claim to cancel an already reserved provider request. Document this distinction.

## Fixed CLI orchestration contract

The CLI exposes `pnpm start`, `pnpm stop`, `pnpm logs`, `pnpm status`. It uses
`--project-directory <repo> --env-file <repo>/.env -f docker-compose.yml -f
.local/paper-runtime/redis-internal.override.yml -f
.local/paper-runtime/compose.override.json`, with reviewed pinned images and
`--no-build`. The lead installs this ignored private profile from approved
configuration, rebasing existing relative paths without changing evidence.
The CLI worker owns tools/paper-verify-stack startup files, package scripts and
runbook only. Core worker owns execution-engine control/preparation/index and its
tests. Shared critical edits require escalation. Lead coordinates private config
packaging and any stable ignored runtime paths; do not copy secrets into Git or
modify evidence expiry/hash contents. Follow existing loopback transport and
secret-redaction conventions; token only from environment/private env file.

### Private profile proof (fixed contract for the CLI worker)

The lead installs `.local/paper-runtime/release.json` (mode 0600) alongside the
private override, only after review/build. Version 1 contains `imageId` (exact
local sha256 image ID), `effectiveComposeSha256` (SHA256 of recursively key-sorted
JSON of the full rendered Compose config), and `files` (relative repository paths
and raw-byte SHA256 hashes for base Compose, private overrides, strategy/research
files and every file in the private accounting mount). No secret values appear in
this proof. All referenced paths must resolve inside the repository without
symlinks; files must exist. The lead derives this proof from the approved existing
profile and built image, never from an arbitrary caller configuration at start.
The CLI only validates the proof; it must never regenerate/accept changed hashes.
The extra stable Redis YAML override preserves the existing approved `ports: !reset []`
behavior, which cannot be represented by an ordinary JSON Compose merge.
A changed environment/configuration requires reviewed reinstallation, with an
explicit configuration-changed message. This includes credential rotation.

Before start's Compose/startup mutations, render `docker compose ... config --format json`
in memory (bounded subprocess output, never echo stdout/stderr or secrets). Its
canonical digest must match the installed proof. Inspect the local image by ID;
all four app services must use exactly `imageId`. Never build or pull during start
(`--no-build --pull never`), and never select services outside the six-name list.
Independently require each app command to be exactly the token list `pnpm`,
`--filter`, `@ikbr/<service>`, `start`, with no custom entrypoint; effective
`IBKR_ENVIRONMENT=paper`, identical nonempty paper account/allowlist, no allowed
live accounts, common bundle path/hash and `TRADING_CONFIG_MODE=bundle`.
Execution/signal/LLM master switches are true, ingestion master false; execution
startup pause false and lifecycle automation true; signal loop true; LLM enabled
true; ingestion auto bootstrap true; research on demand true; execution/LLM
research path/hash and budget-account identity match. These are the already
approved r3 operational settings, not relaxed/new safety defaults. A durable
pause is acquired before producers as specified below.

Relevant strategy/research/accounting bind mounts must be read-only and source
files covered by the proof (a directory is covered by its exact recursively
listed files; unexpected files/symlinks reject). Destination paths are the ones
referenced by the validated service environment. The full effective-config hash
also binds other service commands, port/volume/capability settings and dependencies;
no benign `.env` may mask a changed override. Rejection fixtures must cover profile,
environment, command, image, mount or file changes before any service mutation.
Never include rendered config, tokens, source contents or account IDs in errors.
Startup proof failure must not disable risk-reducing `pnpm stop`: stop uses current
authenticated exact-account pause controls even if profile/image/file hashes have
changed. Its only service-stop targets are the fixed signal-engine and llm-agent
allowlist, preserving execution and ingestion. No build/start/pull is permitted on
this degraded stop path. Logs/status likewise remain read-only diagnostics.

1. Validate approved private configuration and exact Paper scope before bringing
   up anything. No silent environment switch, account adoption, source rights
   renewal, budget change or newly invented policy. Use explicit allowlist only:
   postgres, redis, execution-engine, ingestion, llm-agent, signal-engine.
2. If existing execution is reachable, read controls then issue one authenticated
   CAS pause with unique reason before starting/recreating producer services. If
   unavailable, first stop AND verify stopped signal-engine and llm-agent containers
   before bringing up/recreating execution. Then bring up only dependencies/execution; do not start ingestion,
   AI or signal producers until control account is known and durable pause is
   positively verified. An existing running stack is deliberately paused/rechecked
   by explicit start; a CLI invocation is not permission to bypass readiness.
3. Record the successful pause's revision and exact event reason. Do not reacquire
   a new revision automatically after any other control mutation. Start necessary
   ingestion/research workers while paused. Use existing authenticated ingestion
   bootstrap to explicitly clear its separate durable data stop and fill gaps;
   retain pacing/coalescing/reconnect behavior. Never delete stored candles.
4. Poll read-only status and preparation, showing changed Polish WAITING/HOLD
   reasons. Check control revision before each preparation/resume. Retry only
   requests with definitive responses; unknown mutation response (timeout,
   malformed response, disconnect or server error) is resolved read-only or ends
   as unknown, never silently retried. Pause/resume success after lost response
   requires exact expected next revision, paused value and UUID reason event.
   An unchanged readback cannot prove an in-flight mutation failed. Unknown
   preparation outcome ends this attempt without resume; queued work may finish.
5. Wait for bootstrap completion and all research READY. Per-instrument history,
   quote and session freshness stay enforced by existing entry checks: PKO closed
   must not block AAPL open merely because not all markets are open.
   Definitive current resume-gate denials may be retried with the SAME revision,
   bounded polling/backoff and visible reason. HOLD does not weaken guards or
   manufacture evidence. Closed market is an observable wait for natural signals,
   not a request for a fabricated session/window; existing entry/session/history
   guards decide eligibility and no order is generated by startup itself.
6. Resume with recorded expectedRevision and same unique reason only after
   preparation. Any newer pause/control revision cancels this command permanently.
   On success exit zero and explicitly report that the bot works in Docker; use
   `pnpm stop` to stop entries and `pnpm logs` to observe it. Starting a second CLI can supersede the first only
   through its own explicit audited pause; the earlier command cannot resume.
7. SIGINT/SIGTERM before resume ends startup and leaves durable pause. If resume
   could be in flight or completed, send a new explicit pause and verify it before
   declaring stopped; unknown pause remains unknown and requires readback. Do not
   stop execution/exit supervision while exposure could exist. A stop command
   first persists pause (cancels pending starts), then may stop entry producers;
   execution AND ingestion remain available while exposure is unknown/present
   (exit pricing uses ingestion). Never infer flatness from local rows.

No arbitrary half-hour startup/session deadline. Each network operation and poll
has finite resource/time bounds, while operator-visible waiting can span closed
sessions. A hard blocker may exit nonzero with reason, leaving paused. Starting
requires currently valid approvals; expired source/accounting evidence is a real
operator hold, not an automatically renewable setting.

## Acceptance and hostile cases

- CAS pause/resume validates positive safe revision; legacy bodies remain valid;
  unexpected fields/malformed revisions reject. Unauthorized start prepare rejects.
- Independent PostgreSQL connections: pause while prepare waits serializes; a
  newer pause wins over pending resume, duplicate resume cannot create two events,
  and stale CAS never invokes the resume gate. Existing pause/send serialization
  and durable restart/adoption tests remain passing.
- Startup preparation works under durable pause with missing/stale known data,
  enqueues through existing store, and never invokes entry permit/provider/AI/order.
  Unpaused, foreign/drifted configuration, wrong budget account, unsupported stock,
  disabled refresh and expired rights fail closed. Unknown reservations and budget
  exhaustion remain HOLD. Fresh sources create no new provider acquisition.
- Transaction rollback preserves control/queue on preparation failure; all selected
  instruments derive from server config. Response identifies each instrument and
  preserves source reasons. Existing signal preparation remains pause-blocked.
- CLI fixture tests cover ordered service startup, all research READY before
  resume, bootstrap wait, later pause during waiting/in-flight resume, second CLI,
  reconnect, SIGINT, exact readback after lost response, unchanged readback unknown,
  malformed/5xx mutation response without retry, no secrets in errors, no UI or
  backtest startup, and persistent HOLD without repeated provider identity.
- Closed-market/insufficient-history observations never fabricate signal/session
  or claim broker readiness. No stale source, report parser, issuer mapping or
  accounting certificate is automatically repaired beyond its supported contract.

## Review, checks, delivery

Plan and final hostile reviewers are different independent gpt-6-astra/high
agents. Core implementer: gpt-6-astra/high. CLI pure transport/orchestration under
this contract: gpt-6-luna/medium, escalating critical semantics to lead. Mechanical
checks/publication: gpt-5.6-luna/low. Record actual model/effort, repairs, findings,
elapsed time and tokens (unavailable if not exposed).

After accepted plan, run targeted execution/control and CLI fixture tests, then
required pnpm lint, typecheck, test, test:integration with isolated PostgreSQL,
build and clean Docker build for deployment packaging. No operational database
fixtures, provider calls or broker writes. No strategy/simulator behavior changes,
so no additional backtests for this package. Review final full scoped diff, write
report, commit/push only reviewed files on main, verify CI for exact commit. Do
not claim runtime activation, broker round-trip or expired evidence resolved from
passing tests/builds. Current unrelated dirty files stay untouched/unstaged.

## CLI critical repair addendum (2026-10-12, independently accepted by cli_start_plan_review)

The initial CLI fixtures missed cold-start cancellation, an in-flight interrupted
resume and a stop/resume CAS race. Escalate only orchestration/transport/tests to
`gpt-6-astra/high` (one escalation); keep the accepted API and guard contracts.

- A single ignored local cancellation marker
  `.local/paper-runtime/stop-generation` contains a random UUID. Stop atomically
  replaces it (0600 temporary file + rename) BEFORE HTTP/config inspection; start
  reads its generation before any startup work. Missing marker is an initial
  generation. Symlink/non-file/invalid marker or IO failure fails closed. Every
  start wait cycle and immediately before/after service mutations, preparation
  and resume checks the captured generation and signal. Changed marker permanently
  cancels that invocation; a later explicit start captures the new generation.
  This marker cancels local startup only; it is never evidence of broker pause.
- Stop always uses the existing authenticated pause with a unique
  `paper-stop:<UUID>` reason and WITHOUT expectedRevision, after checking exact
  configured Paper account. This risk-reducing write serializes with resume on
  the existing database account lock: pause before resume invalidates its CAS;
  pause after resume returns account to paused. Resolve a lost stop response only
  with a paused current revision and its exact unique event, never resend an
  ambiguous pause. Startup CAS conflict never reacquires a newer revision.
- On interruption/supersession after a resume could have been dispatched, start
  performs a NEW explicit unconditional pause, independent of its aborted
  signal, even if an earlier read currently says paused. A delayed resume may
  still be in flight. Never infer safety from that earlier read. Stop marker plus
  this durable pause fence coordinates the final resume window; no new supervisor
  or intent table/file lock is required. If the API cannot verify pause, stop and
  verify entry producers only, retain ingestion/execution and return nonzero
  `PAPER_PAUSE_UNKNOWN` (or interruption with that uncertainty). Never report a
  durable stop or broker-flatness from local cancellation/containers alone.
- Stop while execution is unavailable still writes cancellation first and stops
  and verifies producers without starting anything. Report durable pause unknown;
  the older cold start sees cancellation while waiting for account readiness and
  cannot later resume. A future explicit start is separately authorized.
- Cold start waits on the actual account-control API, not merely `/health`.
  Transport and definitive account-unavailable reads may reconnect with visible
  bounded-backoff waiting; missing protocol version, auth denial or wrong account
  fails. Check cancellation throughout, including before initial pause. HTTP
  operations have finite timeouts; no 24-hour hidden startup/approval deadline.
- Bootstrap is exactly `POST http://127.0.0.1:3101/bootstrap`, never execution's
  port. Issue once, with a bounded 120-minute response allowance since this route
  awaits backfill. Poll control/cancellation and read-only ingestion health while
  awaiting it. A lost response is not retried and may only be treated as data
  readiness when health positively reports connected, bootstrapped, not
  bootstrapping, automaticBootstrap initialized=true, manuallyStopped=false,
  inFlight=false, recoveryNeeded=false, shuttingDown=false, error=null and actual
  `/backfill-progress` completed with no failedTimeframes. Otherwise keep a
  visible unknown/wait state or exit; never resume from partial/malformed status.
  Per-instrument entry checks still enforce actual quote/session/candle readiness.
- Exact-account/current startup revision is rechecked throughout bootstrap and
  research waits, including before retrying any definitive gate denial. Closed
  markets do not require a synthetic session/window or block a healthy other
  instrument. Unexpected research states and malformed success/error HTTP bodies
  are unknown, never retryable mutation denials.

Required added fixtures: separate runtime objects share cancellation marker and
control state; stop before broker/account availability prevents later resume;
stop racing a successful resume persists pause; interrupted unknown resume whose
server commit is deliberately delayed until after a paused read still ends paused;
unknown pause never resends or claims stop; transport mapping uses real ingestion
port/body; bootstrap unknown resolves only through complete real health protocol;
account unavailable waits and then connects, old image/auth/malformed reject;
stop retains ingestion/execution. Existing proof validation remains required.

Additional fixed repair obligations from the same hostile review: capture Docker
output with a finite 120-second deadline for config/inspect/ps/stop and 300 seconds
for up, kill on abort/deadline with bounded termination, and do not print stderr.
Logs is deliberately an indefinite foreground operation and must terminate its
child on signal. Bound error-response bytes with the same limit as success before
JSON parsing; malformed bodies are unknown, not definitive retryable denials.
Validate stopped producers positively from parsed Compose ps records: only
`exited`, `created` or `dead` are accepted for returned requested services; empty
records mean containers absent. Reject malformed/unknown/running/restarting/paused
records. Compare execution/LLM research hashes explicitly. Every configured
execution accounting file path must resolve inside the proof-covered read-only
accounting mount; no alternate path/env may redirect it. Add corresponding
fixtures plus symlink/mount/file-drift rejection. Correct the runbook so unknown
mutations may have committed and do not claim every error leaves entries paused.

Lead approved the narrow `eslint.config.js` transport exception for the explicit
fixed-origin runtime CLI, alongside the existing operator client exception. The
original infrastructure verifier transport remains GET-only and unchanged.

## Isolated integration fixture correction (independently accepted, 2026-10-12)

Full isolated integration validation exposed an existing wall-clock-dependent
failure in `apps/execution-engine/src/paper-recurring.pg-integration.test.ts`,
case `v3 binds actual session proof and a calendar revision only tightens the
original cutoff`. A diagnostic assertion in the disposable validation copy
confirmed `{ok:false,reason:'paper_budget_session_interval_invalid'}`. Its
`Date.now()+2h` revision crossed Warsaw midnight; the production same-account-day
guard correctly rejected it. This is a fixture error, not permission to change
session/risk behavior.

Authorize exactly this additional test file. Save the original fixture session
end, set its initial schedule end to savedEnd minus 15 minutes before proposal
binding, then shorten it to savedEnd minus 30 minutes and finally extend it back
to savedEnd. All revisions stay inside the original validated session interval;
the final revision still extends beyond the initially bound end. Retain every
assertion, including strict shortening, successful extension, unchanged original
cutoff and failed-evidence rejection. Add the returned failure reason to success
assertions for useful diagnostics. Do not change production code, guards, clocks,
SQL functions, setup authority, test skips or acceptance thresholds.

This removes the test's unnecessary two-hour calendar extension. It does not
change the shared real-time active-session fixture used by the existing suite.
Validate the targeted PostgreSQL case/file, then rerun the required isolated
integration suite. Have the independent plan reviewer accept this correction and
the existing independent implementation reviewer review the actual test diff.
