# Paper accounting stranded-owner recovery contract

Date: 2026-10-19. Status: ACCEPTED for bounded implementation by independent owner_plan_review2
(requested gpt-6-astra/high), after one repair round.
Selected scope: Package B of the [shutdown/recovery plan](PAPER_ACCOUNTING_SHUTDOWN_RECOVERY_PLAN.md).
The owner authorizes implementation of `ACCOUNTING_SOURCE_OWNER_UNRETIRED`
recovery only. This contract does not authorize applying recovery, starting the
bot, restarting TWS, invoking a provider or contacting a broker. All development
uses synthetic accounts, fake transports and isolated PostgreSQL. Package A
shutdown changes are outside this package.

## Outcome and invariants

Add an offline, authenticated recovery command for an exact stranded accounting
owner when execution HTTP cannot start. Recovery retires that owner after proof
that its old local TWS transport cannot survive or reconnect. Ordinary startup
continues rejecting ACTIVE/UNKNOWN ownership. Recovery never acquires a running
accounting owner, qualifies a source, proves accounting coverage, enables writes,
resumes entries, consumes another research attempt or clears another hold.

Preserve the [normal release contract](PAPER_STARTUP_ACCOUNTING_RELEASE_CONTRACT.md).
The owner advisory-lock key and canonical endpoint algorithm in
`apps/execution-engine/src/accounting/source-owner.ts` remain authoritative.
Neither lock availability, DB connection death, PID absence alone, lease expiry,
API disconnection nor a successful new handshake proves the old transport closed.
The new method is `OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1` and requires whole-process
and listener reset observed by the host collector, then closure of one new
read-only client-0 handshake. Unknown evidence remains a hold.

## Supported authority and topology

Support only the pinned local macOS host, local Docker Desktop Unix daemon,
reviewed Compose deployment and locally observable native TWS process. Reject
remote Docker, proxies, tunnels, remote brokers, IB Gateway, unknown native broker
clients and unrecognized container/process topology. Product recognition must
select TWS specifically; the existing research collector accepts Gateway too and
cannot be reused unchanged. Environment is explicitly `paper`; never infer it
from the socket port. A privileged local operator/DB administrator can bypass any
local tool; this protocol assumes the trusted host and its private deployment
files, not a hostile administrator.

Before every mutation and before opening the handshake, validate:

- Exact pinned source/image ID, deployment proof and effective configuration hash;
  same local Docker socket, host identity, settings-file bytes/hash and endpoint.
- Exactly one allowed Paper account equal to configured account and accounting
  settings; client ID exactly 0. No arbitrary account/client/endpoint overrides.
- `TRADING_ENABLED=false` for every applicable service and all application
  processes stopped. Durable `execution_entry_controls.paused=true` must already
  exist. Capture and require its exact revision; recovery does not create or alter
  a pause record. Capture the exact startup entry pause, lifecycle, signal-loop
  and AI-worker settings in the deployment hash without changing them. The pinned
  continuous profile may retain startup pause=false and automation settings=true:
  stopped processes, master=false, durable pause and owner maintenance are the
  required recovery controls. No ordinary app is started by this command.
- An explicit operator identity (1–200 sanitized characters), private proof files,
  and an independently supplied execution token of at least 32 characters matched
  with constant-time comparison to the pinned container token. No token in argv,
  logs, receipts or evidence. The host reads the trusted private configuration and
  sends authorization over the child's stdin. The one-shot validates it itself;
  merely inheriting a token in its environment is not authentication of a request.
- Offline private operator account evidence described below and a conservative
  no-bot-history subset: deny any `proposed_orders.execution_attempted_at` for the
  target account or any unbound account row, including apparently terminal history;
  deny `findAccountReservation` for that account and any unresolved Paper entry
  attempt or close operation. Freeze the existing repository predicates/terminal
  enums from current source in implementation tests; never infer terminality from
  age or missing broker rows. Any ambiguous/missing schema/account binding denies.
  This deliberately does not replicate the live lifecycle evaluator offline and
  does not support recovery for accounts with bot submission history. Supporting
  them later requires a separately reviewed exact offline proof contract.


Reuse `verifyProof`, canonical JSON and existing maintenance Compose validation
in paper-runtime, which permits master=false in the pinned continuous profile.
Require its complete original settings/profile, immutable image and exact effective
maintenance configuration digest. Do not add a second disabled-state profile or
rewrite release proof/policy authority. A deployment/config change during an
operation denies it.

The settings endpoint must resolve inside the pinned execution one-shot exactly
as normal acquire does. Persist that canonical key and the resolved address.
Host loopback observation and Docker `host.docker.internal` are different network
names: accept their association only for the pinned local Docker Desktop bridge,
with the host-observed local listener and one-shot connection to the pinned
resolved address. Never invent a second endpoint key, rename the owner or change
settings to make recovery match. DNS change or ambiguous resolution denies.
Aliases resolving to the same canonical key share the original advisory lock.
Different host/container addresses for the same physical endpoint cannot bypass
recovery: pending recovery applies a conservative database-global maintenance
fence to every accounting owner acquire/activation, regardless of endpoint key.
Prepare requires its captured owner to be the sole ACTIVE/UNKNOWN owner in this
DB, otherwise it denies. Existing historical endpoint keys are never renamed.

## Offline operator account proof

HTTP unavailability is handled by explicit current operator evidence from TWS,
not a new account-data collector. Before prepare, the owner manually verifies the
exact Paper account, all account positions flat, all account open orders absent,
no pending manual actions and all other API clients stopped/coordinated. This
package intentionally supports an account-wide flat/no-orders maintenance case;
known unrelated exposure allowed for trading acceptance does not qualify here.
The owner performs all UI actions; agents never automate IBKR UI.

Use a strict private JSON record with schema version 1, inspection UUID, account/
endpoint/settings/deployment bindings, operator, observedAt, product `TWS`, and literal true
confirmations for Paper account, account-wide zero positions, account-wide zero
open orders, no pending manual actions, other clients stopped, and no changes
until recovery ends. Require three distinct artifacts: account/environment,
positions and open-orders views, with canonical private relative path, SHA-256,
observedAt and kind. Reuse accounting private-file/artifact validation (0700
parent, 0600 regular files, no symlinks/path traversal, PNG/JPEG/TXT validation,
5 MiB per artifact and 20 MiB total). Store only sanitized record and hashes in DB,
not image contents, account logs or credentials. This is explicitly operator
attestation with verified provenance/integrity, not machine interpretation of a
screenshot. A boolean without artifacts is insufficient.

Prepare evidence is at most five minutes old by database time; prepare binds its
digest to the newly allocated operation (the operator need not predict that UUID).
After the observed
TWS replacement, the owner supplies a second record additionally binding the
returned operation UUID, nonce and
new TWS process identity, with artifacts observed after replacement, again at most
five minutes old at commit. The running observe command waits boundedly for this
private file to appear; it does not automate or prompt another process to trade.
Document these manual steps before invocation. The owner must stop if broker
state is unavailable, nonflat, stale or ambiguous; the tool must deny malformed,
stale, incorrectly bound or missing proof. Manual exposure changes invalidate it.

## Persistence and acquire fencing

Add `infra/sql/migrations/000038_accounting_owner_recovery.sql`, confirming 38 is
still free immediately before implementation. No migration retires historical
owners or changes existing holds. Verify automatic discovery by the existing migration runner, which also supplies
the fresh-database accounting schema. Do not append dependent recovery tables to
`infra/sql/001_init.sql`, which does not contain their accounting prerequisites;
do not duplicate schema registration or edit historical versioned migrations.

Use these additive records (bounded strict shared wire schemas; UUIDs and SHA-256
fields validated in application and SQL):

1. `accounting_owner_recovery_operations`: operation UUID PK, unique unpredictable
   nonce, version, endpoint key, old owner UUID/generation/state/acquiredAt/
   updatedAt, settings/deployment/image/host hashes, account, pause revision,
   actor, DB preparedAt/expiresAt (exactly 15 minutes), immutable binding digest,
   state `PREPARED|OBSERVED|COMMITTED|SUPERSEDED`, successor UUID if superseded.
   PREPARED and OBSERVED both impose maintenance, including after expiry.
   At most one pending operation in this database (partial unique constant index).
2. `accounting_owner_recovery_events`: append-only event UUID, unique request UUID,
   operation FK, event kind, DB timestamp, actor, binding/evidence digests and
   bounded sanitized evidence JSON. PREPARED, HANDSHAKE_DISPATCH, HANDSHAKE_CLOSED, OBSERVED, SUPERSEDED and COMMITTED
   protocol transitions each append their exact event in the same transaction. Historical
   binding fields and events cannot be updated/deleted/truncated.
3. `accounting_owner_recovery_receipts`: immutable UUID PK, unique operation FK,
   unique commit request UUID, exact old owner tuple/state/timestamps, method,
   evidence digest, DB committedAt, actor, new state RETIRED and retirement time.
   Unique `(endpoint_key, old_owner_id, old_generation)` prevents duplicate
   retirement. Receipt/evidence identity is enforced with constraints/transactional
   checks; no receipt can refer to a different operation or owner.

Add one initialized singleton `accounting_owner_recovery_maintenance` row holding
nullable pending operation UUID. It is the global fence, not a new broker owner or
lease. It cannot be deleted/truncated; FK/transition guards prevent orphaned or
inconsistent pending state. Commit/supersede update it transactionally with the
operation history. Migration initializes it empty, never infers recovery.

Use the existing SHA-256-derived signed bigint endpoint advisory lock, not another
advisory namespace. Factor its computation into an exported helper if needed.
Lock order is endpoint session advisory lock, global maintenance singleton row,
operation row, owner row, entry-control row. Ordinary acquire obtains the original
endpoint lock and singleton `FOR SHARE`, checks no pending maintenance and performs
its INSERT/RETIRED takeover in that same transaction. Recovery prepare/commit/
supersede take singleton `FOR UPDATE`; prepare reads all nonretired owners only
after obtaining it and requires exactly the captured target. Thus alias-key acquire
before prepare makes another owner visible and blocks prepare; acquire after
prepare sees maintenance and is denied. Recovery observe may keep its endpoint
session lock while using bounded transactions for subsequent singleton checks.
Missing migration/table is a failure, never a compatibility fallback.

Add a DB owner-row guard for INSERT and changes to owner identity/generation or
retirement state, including ACTIVE, UNKNOWN and RETIRED: it locks the singleton
`FOR SHARE` before checking database-global pending maintenance. This serializes
older-style writers with prepare too. Pending maintenance rejects those changes. This protects against an older
writer that ignores application fencing. During recovery the only permitted
retirement is the exact CAS covered by a COMMITTED event/receipt created in the
same transaction, with the operation state changed atomically. No user-settable
session flag alone bypasses the guard. Existing normal retirement stays available
without pending recovery. Ordinary acquisition never sees a committed retirement
without its committed receipt. Reject rollback to an incompatible image while
maintenance is pending. Runtime owner checks must also refuse pending maintenance;
prepare cannot succeed while an ordinary owner holds the endpoint advisory lock.

## Protocol and command behavior

Expose `pnpm paper:accounting-owner-recovery` with strict subcommands below. Root
and workspace package scripts are integration-owned. No SQL reset command, force
flag, endpoint override, bare abort or independent `commit` subcommand exists.
The implementation report and runbook distinguish source delivery from application.

`prepare --operator-evidence <absolute-private-file>` validates the profile,
operator proof and stopped-process inventory, allocates an operation/request UUID
and persists private request identity before dispatch. Under endpoint lock, read
and capture exactly one ACTIVE/UNKNOWN stranded owner and current paused revision;
RETIRED/no owner/competing advisory owner deny. Create PREPARED and event atomically.
Return the operation ID, binding digest and DB deadline. No socket is opened.

`observe --operation <uuid> --operator-evidence <absolute-private-after-file>`
performs observation AND the validated commit in one bounded process. State this
clearly in help and runbook: there is no later detached commit. Keep the same host
collector and monotonic clock alive through old process capture, observed full
stop, observed replacement, current operator evidence, one client-0 handshake,
closure, durable OBSERVED and atomic COMMITTED. The collector polls for the owner
performed UI actions; never starts/stops TWS itself. A restarted CLI cannot reuse
old in-memory observation, a recorded OBSERVED state or a handshake result to
continue a mutation. It can only read status or explicitly supersede.

The host clock/wall/DB samples bracket all critical phases. One 15-minute budget
starts at PREPARED in DB and never restarts. Observe uses the remaining DB budget,
not another 15 minutes. Wall/monotonic elapsed disagreement over 1,000 ms, backwards
wall/DB time, expiry or DB round trip over 2,000 ms deny. Revalidate final database
time/deadline in the commit transaction. A delayed observer cannot extend expiry.

`status --operation <uuid>` is read-only: returns exact bindings, phase, expiry,
pending maintenance, events, receipt and any successor. Unknown request outcomes
are resolved by exact request UUID lookup, never by latest endpoint receipt.
Status requires authentication and account binding; it may report a historical
operation after deployment hash changes without granting mutation authority.

`supersede --operation <uuid> --operator-evidence <absolute-private-file>` is the
only way to abandon/restart an expired, interrupted or obsolete pending operation.
Require current disabled profile, fresh flat proof, stopped inventory, same exact
stranded owner tuple and endpoint, authentication and advisory lock. Allocate and
persist replacement request UUID first. In one transaction append supersession,
mark old SUPERSEDED, create successor PREPARED with current bindings and a fresh
15-minute deadline. No gap in maintenance; no retirement/qualification/budget
changes. Changed owner/generation or unknown competing process blocks supersession.
An expired operation never unlocks itself. A superseded nonce/evidence cannot be
reused. Unknown supersession reads back that exact request, never issues another.

## Concrete offline wire and live-witness lifecycle

Use bounded JSON Lines over child stdin/stdout, schema version 1, maximum 64 KiB
per message and 256 KiB per session; diagnostics only on stderr after sanitizing.
Root CLI runs the pinned execution image using Compose `run --rm --no-deps -T`,
entrypoint `node apps/execution-engine/dist/accounting/owner-recovery-cli.js`.
It neither imports application startup nor invokes another provider worker.
The host records the actual created container ID/image/command and operation-bound
name before allowing it as the sole inventory exception. A name alone never
identifies an allowed process. Container exit/stdio EOF aborts the witness.

`prepare`, `status`, and `supersede` use one request/response and exit. Each request
has `{version:1, action, requestId, operationId?, actor, token, profile, evidence?}`;
response has `{version:1, requestId, ok, result? , error?}`. Mutating request UUIDs
are durable locally before send. Reject extra fields and duplicate request IDs
with changed body. Shared schemas define exact profile/evidence types from the
fields above; wire token is omitted from all persisted hashes/evidence.

`observe` uses exactly one long-lived backend child, not sequential handshake and
commit one-shots. Its state machine is:

1. Host sends `begin-observe` with token, operation UUID, original binding digest
   and request UUID. Backend authenticates, verifies current profile/pause/owner,
   acquires the canonical session advisory lock and retains it through session
   completion. Backend independently starts its remaining-DB-deadline monotonic
   budget. Response `observer-ready` contains fresh observer-session UUID, operation
   nonce/bindings and remaining deadline. An OBSERVED/terminal operation is denied;
   a previous interrupted handshake dispatch event also denies reuse.
2. Host collects old TWS/stop/replacement and sends `reset-proof` with session ID,
   a new durable request UUID, complete bounded reset/inventory evidence and current
   post-replacement operator proof. Backend validates exact operation/nonce/profile,
   strict timestamp/proof shape, its retained lock and unchanged DB owner/pause.
   It appends the unique handshake-dispatch event before any socket open, performs
   the single bounded handshake, positively closes that socket, and returns
   `handshake-closed` with dispatch-event UUID and its backend-owned result digest.
   The result remains in this child's memory as well as its append-only event;
   another child cannot import it as permission to finalize.
3. Host rechecks live TWS/listener, inventory/event continuity, profile, clock and
   artifact freshness, then sends `finalize-observation` with the same observer
   session ID, exact handshake result digest, a new OBSERVED request UUID, a new
   commit request UUID and final bounded witness evidence. Backend accepts this
   message only after its own handshake closure in this still-live session and
   only once. It validates all bindings/current DB state and deadline, writes
   OBSERVED and its evidence digest, then performs the exact commit below under
   the retained lock. `finalize-observation` is private protocol for this live
   child; there is no CLI accepting saved evidence to call commit independently.
4. Backend returns `committed` with exact receipt and unlock acknowledgement,
   closes its DB session/pool and exits. Host performs final process/inventory
   checks and exact receipt readback before reporting success. A surviving child
   or uncertain unlock remains visible even with a confirmed durable receipt.

All messages require the original unpredictable observer-session UUID, request
identity and strict expected order. EOF, signal, duplicate/out-of-order message,
watcher loss, absolute deadline or host cancellation revokes local finalize
capability synchronously and closes the owned socket/DB session without claiming
retirement. Backend has its own deadline and EOF cleanup even if the host dies.
No child restart/reconnect/resend is automatic. OBSERVED persisted before a crash
still blocks acquire and requires status or supersession with a new observed
reset. A lost final response is resolved by exact commit request readback only.

## Host collection and transport boundary

The [October 25 zero-start amendment](PAPER_ACCOUNTING_ZERO_START_DEPLOYMENT_PLAN.md)
also accepts genuinely never-started containers on the exact pinned image. In
addition to all identity/command/non-oneoff checks, require Docker state created,
Running/Paused/Restarting false, Pid 0, both StartedAt/FinishedAt exactly
`0001-01-01T00:00:00Z`, and valid nonfuture Created. Shared evidence records
`state: created`, real `createdAt`, and null `startedAt`/`finishedAt`; exited/dead
records keep their existing strict shape. Never synthesize start/stop timestamps.
This variant changes no TWS reset, operator proof, event-watcher, maintenance or
retirement requirement. It proves nothing about a previous owner's transport.
Recreate containers only before observation, with matching host/backend versions;
deployment changes invalidate pending proofs under existing rules.

Prefer a minimal extension/factoring of `research-recovery-host.ts`; retain its
existing research behavior/tests. Accounting profile requires every actual instance of all six app
services (execution, ingestion, llm-agent, signal-engine, backtest-engine, UI)
nonrunning. Missing never-created optional UI/backtest containers are acceptable
only when complete global Docker inventory plus rendered Compose prove absence;
never create an optional service merely to satisfy inspection. Inspect Compose service labels across projects and all pinned-image
containers; reject unknown projects/images/commands, one-offs and duplicate
unrecognized writers. Record immutable container ID/image/project/service,
startedAt/finishedAt and state. Check global native process/socket inventory using complete bounded `ps -ww`
PID/PPID/start/executable/argv output and `lsof` API endpoint connections. Classify
native producer candidates by argv containing this repository's canonical root,
`@ikbr/` service package, execution/ingestion/llm-agent/backtest entrypoint or known
IB API client module (`@stoqey/ib`, `ibapi`); any such candidate denies except the
exact host recovery process and its observed one-shot child/inspection helpers.
An endpoint-connected process outside the exact TWS/recovery identities denies
regardless of name. Do not classify all Node/Python/Java processes as producers:
unrelated Codex/editor/development processes without those matches or endpoint
connections are outside the supported producer inventory. Store PID/start/argv
hash for candidates, not broad raw command lines that could contain credentials.
Truncation, unavailable complete argv or missing socket permissions denies.
The [2026-10-26 native inventory amendment](PAPER_ACCOUNTING_NATIVE_INVENTORY_REPAIR_PLAN.md)
collects each global native view with one ps invocation, avoiding a join between
process lists taken at different times. Its strict byte framing uses an explicit
1024-byte command field and complete final argv. Malformed/truncated/ambiguous
output still denies; no inconsistent-view retry or arbitrary PID exemption is
introduced. Command text remains ps-displayed argv[0], not kernel executable
attestation. Existing exact command/argv/ancestry/start/hash checks remain required.
The operator explicitly attests no other broker-capable native process, external
client, scheduler or manual launch will run during the procedure. This is a
bounded supported-topology assertion, not proof that arbitrary software cannot
connect. Unknown native clients or an inability to make that assertion blocks.

Inventory must cover every pinned deployment app and any competing deployment
using the endpoint. Keep Docker lifecycle event observation from before initial
inventory through final commit checks so an intervening start/stop is detected;
reinspect immutable process/container identities before stop, after listener
absence, after replacement, before handshake, before commit and after commit.
The [event retention repair](PAPER_ACCOUNTING_EVENT_WATCHER_REPAIR_PLAN.md)
establishes its initialized observation boundary before initial inventory. It
requires both a live stream and serialized bounded unfiltered-global replays,
linked by a unique exact retained event hash. One-second checkpoints advance
that chain; explicit flush waits for a fresh checkpoint. Old healthcheck history
may leave retention only after a verified checkpoint advances beyond it. Missing
or ambiguous anchors, replay overflow, unavailable bootstrap evidence and stream
loss still abort. A long operation is never certified by silently discarding a
saturated replay or by filtering away events that consumed global retention.
The only one-shot exception is this command's pinned image, exact entrypoint and
request-bound identity. It never imports application `index.ts` or starts workers.
No other native producer is supported. Native inspection is repeated snapshots,
not an OS audit of every transient start/stop: do not claim it detects a hidden
native client between samples. The explicit trusted-operator topology/no-launch
attestation is required for that gap; ordinary repository owners are additionally
fenced in the database even under alternate endpoint keys. Any detected producer
restart or Docker watcher loss aborts
the witness and leaves maintenance; post-commit unexpected activity is reported
as a failed operational recovery, never readiness.

Capture old TWS PID, start identity, executable digest, host digest and listener.
Observe both old whole process absence and listener absence before allowing a
new process. New PID/start identity must be distinct, new start later than stop,
and old process must remain absent. Revalidate new process/listener identity
through commit. PID reuse, a pre-observation restart, listener rebind, Gateway,
multiple listeners, process mismatch and missing absence observation deny.

After reset proof, the one-shot opens one client-0 socket using the installed
`@stoqey/ib` transport boundary or a minimal read-only adapter verified against its
installed implementation. Allowed behavior is connection handshake, server version,
`managedAccounts`/account identity and next-valid-ID protocol readiness only.
No place/modify/cancel, automatic-open-order binding request, executions, positions,
account summary, history, WSH, news or paid calls. Do not import the execution
writer or accounting replay collector. Require exact singleton expected managed
account, protocol-ready event and positive close event for this owned socket.
Close/destroyed/requested disconnect without observed closure is insufficient.
One 10-second monotonic budget covers handshake and closure (reserve at least two
seconds for closure), within original operation deadline. No reconnect or retry.
Persist a handshake dispatch event before opening the socket. An uncertain dispatch
or closure makes the operation unusable; only a new superseding reset can proceed.
The fresh handshake proves only its own identity/closure, never old-session death.

## Exact commit and unknown outcomes

Before OBSERVED and again immediately before COMMITTED, revalidate live witness,
new TWS identity/listener, complete stopped inventory, deployment/settings hash,
authentication, flat proof freshness, unchanged pause revision, owner tuple and
handshake closure. OBSERVED freezes the canonical evidence digest once; evidence
is immutable and bound to nonce, operation, all timestamps and dispatch receipt.

Commit takes the canonical session lock and a transaction. Require pending
OBSERVED for this operation, unexpired DB deadline and exact evidence digest.
Compare-and-swap only the captured owner endpoint/UUID/generation/original state/
acquiredAt/updatedAt to RETIRED, keeping UUID and generation, with database
retiredAt/updatedAt. Insert immutable receipt/event and mark COMMITTED atomically.
Zero/multiple affected owner rows roll back and deny. Release only this session's
advisory lock; require acknowledged unlock, destroy session on error, never unlock
another session. The next ordinary acquire alone creates a new owner/generation.

Write mutation request UUIDs to private local state before sending prepare,
handshake dispatch, OBSERVED, commit or supersession. Never resubmit a mutation
after timeout/EOF/process interruption. Resolve using the exact durable request,
operation, digest and receipt readback. A missing receipt is not proof of rollback
while a transaction might still finish. DB outage/readback mismatch/unknown socket
closure exits nonzero and retains a visible hold. Confirmed committed receipt
resolves retirement even if transport/CLI acknowledgement was lost; it does not
license a second handshake/reset or claim successful lock release. Normal acquire
still requires the actual advisory lock. Uncertain unlock preserves the already
proven durable receipt, consistent with the normal release contract.

## File ownership and task packets

All workers read AGENTS.md, this accepted contract, source and routing guide.
Requested routes below are exact; actual telemetry/usage is recorded if exposed.
Do not edit unrelated dirty signal/backtest files. Shared wire contract lands first;
backend and host then have disjoint write scopes. Lead integrates scripts/docs.

| Task | Model / effort | Owned files and required evidence |
| --- | --- | --- |
| B0 shared contract | gpt-6-astra / high | `packages/shared/src/accounting-owner-recovery.ts`, its focused test and package export; strict versioned schemas using typed handwritten parsers (shared has no zod dependency), canonical hashes, fixed limits/states/errors; parser hostile tests |
| B1 backend fencing and one-shot | gpt-6-astra / high | migration 38; `apps/execution-engine/src/migrations.ts` only if integration requires it; `accounting/source-owner.ts` and affected adjacent owner-test fixtures; new `accounting/owner-recovery-{store,cli,transport}.ts` and adjacent unit/PG tests; no HTTP/startup/strategy rewrites; concurrency, CAS, immutable receipt, token and socket closure evidence |
| B2 host witness | gpt-6-astra / high | `tools/paper-verify-stack/src/accounting-owner-recovery-cli.ts`, optional narrowly factored host module, `research-recovery-host.ts`, adjacent unit tests; bounded inventory/reset/clock/witness/proof flow, existing research regression suite |
| B3 integration and publication | lead Astra/high; mechanical checks gpt-5.6-luna/low if available | root/workspace scripts, focused integration registration, `docs/runbooks/CONTINUOUS_PAPER.md`, `docs/runbooks/PAPER_ACCOUNTING_SOURCE.md`, this contract and implementation report; accepted full diff, checks, exact commit CI |
| Independent plan / final implementation | two different gpt-6-astra / high agents | Read-only review of complete scope, requirements and hostile cases; neither reviewer authors reviewed code |

Fixed diagnostic prefix: `ACCOUNTING_OWNER_RECOVERY_`; reasons include AUTH_REQUIRED,
DISABLED_PAPER_REQUIRED, UNSUPPORTED_HOST, DEPLOYMENT_CHANGED, SETTINGS_MISMATCH,
ACCOUNT_MISMATCH, PAUSE_CHANGED, OWNER_CHANGED, OWNER_CONFLICT, MAINTENANCE_PENDING,
PRODUCERS_NOT_QUIESCENT, INVENTORY_UNAVAILABLE, RESET_UNPROVEN, PROCESS_CHANGED,
OPERATOR_EVIDENCE_INVALID, OBSERVATION_EXPIRED, CLOCK_UNCERTAIN,
HANDSHAKE_UNKNOWN, CLOSURE_UNKNOWN, MUTATION_UNKNOWN and RECEIPT_MISMATCH.
Preserve sanitized original error name/code/message as cause; missing cause stays
unavailable. Public output uses Polish descriptions and operation/receipt IDs,
never credentials or raw broker/account payloads. Exit 0 only for confirmed
requested phase/status; nonzero failure/unknown never says recovery succeeded.

Workers stop/escalate for new topology, endpoint canonicalization change, uncertain
transport capability, migration conflict, unsupported offline uncertainty query,
critical semantic change or any proposed relaxed denial. Material changes need
contract amendment and independent review before implementation resumes.

## Acceptance and validation

Deterministic fake host/transport and isolated-PG tests must prove:

- Live, multiple/wrong account, missing token, disabled-state mismatch, unpaused or
  changed revision, stale/forged binding/artifact, settings/deployment/DNS/alias
  mismatch and unknown topology all deny before broker connection.
- Prepare/acquire/commit/supersede races serialize on the original endpoint lock;
  pending expired maintenance fences ordinary and older-style acquire; no missing
  table fallback; an ACTIVE competing advisory owner blocks prepare.
- Full reset sequence is mandatory; stopped-before-observe TWS, PID reuse, process
  survival, listener replacement, Docker app restart even followed by stop, uninspectable
  client, Docker event failure and clock drift block commit.
- Exactly one read-only handshake; account/protocol mismatch, timeout, partial
  handshake, close false acknowledgement, interrupted process and late callbacks
  cannot yield valid OBSERVED/receipt or authorize a retry.
- Tool crashes before/after each durable phase, duplicate operation/request IDs,
  lost commit acknowledgement, unavailable DB and stale successor evidence yield
  only exact readback or maintained hold. Supersession never opens a maintenance
  gap. At most one immutable retirement receipt per original owner tuple.
- Successful recovery changes only recovery tables and exact owner retirement.
  Qualification IDs/expiry, source holds/gap, observations/commissions, clock
  episodes/attempts, entry/research/AI budgets and all uncertainty remain identical.
  Next ordinary acquire uses a new generation; entry admission remains blocked
  until its existing replay/reconciliation/qualification/research gates pass.
- A real isolated Docker lifecycle fixture with fake TCP server verifies process
  inventory/one-shot exceptions and start-stop detection. No operational DB,
  provider or real TWS is contacted. Verify SQL constraints independently of CLI.

Run focused tests during implementation; final required checks are `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` against isolated PostgreSQL,
`pnpm build`, and clean Docker build. The supplied isolated database is
`postgres://postgres:postgres@127.0.0.1:55438/ikbr_owner_recovery_test`; verify it is
an isolated test instance before fixtures. No strategy/simulator change is allowed,
so no new backtest run is needed. Independent hostile acceptance, scoped commit/
push on main and successful exact-commit GitHub CI are completion requirements.

## Application gate and report

Real application is a later explicitly authorized operational procedure. Before
it, require reviewed/published image, migration/backups, private profile, stopped
producers, valid token/current owner flat evidence and a supported TWS witness.
A pre-existing owner or currently stopped bot alone supplies none of those proofs.
Do not apply recovery in this implementation task. Do not start the bot afterward.
Document separate remaining qualification, accounting replay, clock and research
holds. The command is the supported replacement for a direct SQL owner reset.

Contract author: owner_contract, requested `gpt-6-astra`/high. Actual model/effort,
tokens and elapsed telemetry unavailable. Initial draft: no implementation or
operational calls. Independent plan acceptance: owner_plan_review2, requested gpt-6-astra/high,
one repair round resolving pre-prepare proof identity, alias fencing, native
inventory coverage and minimal disabled-state policy. Actual reviewer model/effort
telemetry and tokens unavailable. Final implementation reviewer must be different. Report implementation repairs,
escalations, exact checks and final reviewer findings in the package report.

No unresolved semantic option is delegated to a worker. Remaining factual checks
are installed socket close capability, exact existing offline uncertainty query,
TWS executable/process shape and actual recovery deployment profile. Unsupported
facts must fail closed and return to contract review; fixtures do not establish
real-host capability or operational acceptance.
