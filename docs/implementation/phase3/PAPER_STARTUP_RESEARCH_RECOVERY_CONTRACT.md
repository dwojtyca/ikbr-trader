# Startup research recovery: stage-0 contract

Date: 2026-10-19. Status: ACCEPTED by independent research_plan_final
(gpt-6-astra/high) after maintenance, clock, hold and supersession amendments. Supplements
[the startup plan](PAPER_STARTUP_DATA_RECOVERY_PLAN.md),
[two-source policy](TWO_SOURCE_RESEARCH_HOURLY_PLAN.md), and
[WSH recovery](WSH_FRESHNESS_RECOVERY_PLAN.md).

This document selects the recovery contract only. It does not authorize a Gateway
reset, a provider request, deployment, entry resume, or broker writes. The owner
has authorized implementation of the startup package. Runtime implementation proceeds under this accepted contract; final hostile
implementation review remains separate.

## Evidence and capability

Read-only operational evidence supplied by the lead, with private identifiers
omitted:

- PKO Marketaux: UNKNOWN from 2026-10-15T16:15:28Z, acquisition deadline
  16:17:28Z; pass 1/page 1 UNKNOWN, with its original request deadline retained.
- AAPL Marketaux: STARTED from 2026-10-15T18:19:11Z, acquisition deadline
  18:21:11Z; pass 1/pages 1–6 SUCCEEDED, pass 2/page 1 reserved without outcome.
  These are incomplete two-pass evidence, not a recoverable successful snapshot.
- PKO WSH: UNKNOWN from 2026-10-15T22:17:04Z, deadline 22:17:39Z,
  later classified RESEARCH_WSH_ABANDONED_ATTEMPT; cleanup UNKNOWN,
  verified_local_closure=false. The preceding AAPL acquisition succeeded with
  confirmed cleanup; that different session does not resolve the PKO fence.

Current Marketaux attempt rows have no persisted owner protocol. Neither the
age of these rows nor stopping today's container proves their original owner
was fenced. Legacy recovery therefore requires the operator quiescence receipt
below. No migration synthesizes ownership for historical rows.

Code checks: claimMarketauxAttempt, the SQL attempt INSERT guard, and the
historical-row fallback in readMarketauxRefreshState all independently prohibit
new acquisition after UNKNOWN. All must understand exact recovery receipts.
Admission must continue blocking cached evidence after recovery until a later
fully proved success. WSH SQL and store fences span endpoint OR issuer, across
accounts/manifests. A receipt must resolve those exact historical rows, not only
the instrument visible to the current operator.

The pinned @stoqey/ib 1.6.10 seam exposes only the current owned Node socket.
Actual close of that socket remains valid existing local cleanup evidence.
Disconnected, peer end, destroyed alone, worker death, a new handshake, or elapsed
time do not prove closure of a lost old session. There is no installed SDK
request that proves that an arbitrary historical WSH session was invalidated.
Automatic repair of that case is unsupported. The supported fallback is a
manually performed full restart of the exact locally observable Gateway process,
with before/after evidence and a normal bounded reconnect. The system never
restarts Gateway or automates its UI.

## Persistence and immutable history

Use one additive migration, provisionally 000037_startup_research_recovery.sql
(recheck numbering before writing). Preserve snapshots, source hashes, original
dates, calls, outcomes, budgets, refresh slots and terminal attempt rows.

1. Add nullable immutable `recovery_protocol`, `clock_domain_id`, `clock_db_at`
   and `clock_wall_at` fields to Marketaux attempts.
   New attempts require `DEADLINE_FENCED_HTTP_V1`; historical rows retain null.
   The existing UUID, immutable 120-second DB deadline, store-owned WeakMap ticket
   and original monotonic budget are the fencing authority. Do not add a second
   owner/heartbeat lease system. A migrated database rejects new attempts from
   an older image that cannot supply this protocol. An old image cannot simply
   relabel an historical attempt with the new protocol. New protocol claims capture
   the DB/host clock pair below. Legacy fields remain null. Missing clock-domain
   capability permits ordinary bounded acquisition but not automatic recovery.
2. `research_marketaux_recoveries`: UUID primary key, unique `attempt_id`, exact
   account/ledger and original attempt identity hash, original state, method
   `EXPIRED_FENCED_DEADLINE` or `OPERATOR_PRODUCERS_STOPPED`, database `recorded_at`,
   original protocol/deadline, optional operator challenge FK,
   canonical evidence hash. Immutable INSERT-only rows. Recovery is permission
   for ordinary acquisition after this predecessor, never evidence eligibility.
3. `research_recovery_challenges`: UUID/unguessable nonce, kind
   `MARKETAUX_PRODUCER_QUIESCENCE` or `WSH_ENDPOINT_RESET`, exact current
   account/config/manifest, durable entry-pause revision, endpoint identity and
   generation when applicable, creation/expiry from DB time (15 minutes),
   canonical ordered predecessor set/hash, and state
   `PREPARED|COMMITTED|CANCELLED`. PREPARED is a durable maintenance hold for its
   account/issuer or endpoint. Expiry prevents commit; it never silently clears
   the hold after a possible reset. Terminal rows are immutable. Replacing an expired or obsolete challenge is operator-authenticated, audited,
   and atomic with creation of its successor PREPARED hold as specified below.
   There is no cancellation that removes the maintenance fence.
4. `research_wsh_recovery_receipts`: UUID, unique challenge FK, endpoint ID,
   prior and resulting endpoint generation, method
   `OPERATOR_OBSERVED_LOCAL_GATEWAY_RESTART`, DB recorded_at, actor/audit operation
   identifier, canonical evidence hash, reconnect session ID and actual reconnect
   cleanup evidence. `research_wsh_recovery_predecessors` explicitly links every
   covered attempt and/or legacy acquisition, with its exact session, generation,
   ledger, identity hash and original state. No wildcard/timestamp-only exemption.
   All are immutable. A separate unique receipt-to-successor row records the
   first admitted regular attempt. Receipt evidence resolves only its enumerated
   old fences; a subsequent new UNKNOWN needs its own proof and cannot reuse it.

Evidence JSON is strict, bounded (32 KiB maximum), versioned, free of secrets,
raw broker/provider payloads and account logs. Store process/container IDs and
hashes privately; public diagnostics show stable reasons and receipt IDs only.
Database guards reject fabricated references, mismatched identities, updates,
deletes, truncates, inconsistent deadline/generation and duplicate consumption.
Do not turn successful call outcomes into UNKNOWN. For an unresolved reserved
call with no outcome, recovery may append UNKNOWN once; the reservation and its
budget day/cost remain unchanged. Do not add invented successful response receipts.

## Marketaux automatic recovery and dispatch contract

This is an explicit amendment to the startup plan's suggested owner-lease
mechanism. A deadline alone in the old implementation was insufficient: after DNS,
fetchBoundedResearchUrl checked only the abort signal, whose timer could run late.
The new versioned protocol fixes the final synchronous dispatch gates and already
has strict DB publication deadlines. It proves no new application dispatch or
publication after the original acquisition budget; it does not prove worker death
or remote HTTP completion. Legacy attempts are not granted that proof retroactively.

The new protocol is explicit and enforced in both producers and SQL:

- Claim captures the original absolute monotonic 120-second budget before its
  first I/O, locks account/issuer, checks current authority and all existing
  pooled budgets/spacing rules, then creates the protocol-marked attempt atomically. The local ticket is a store-owned capability, not caller-created
  serialized authority. No original deadline can be renewed by cloning a ticket,
  reconnecting, retries or a late response.
- Each page reservation, finalization fence, outcome write and publication
  verifies the exact store-owned ticket and unretired attempt in the same
  transaction. Each physical HTTPS dispatch verifies the store-issued call
  capability, original monotonic AND fixed local wall-clock deadline and shutdown
  signal immediately before
  `https.request` AND `req.end`, with no intervening await. Recheck after DNS.
  A delayed timer callback is insufficient: compare performance.now and Date.now
  directly. The fixed local wall deadline is captured from the DB-admitted
  remaining duration at the original operation entry and bounded by the original
  claim wall-time +120s; never recreate it after DNS, suspension or restart.
  Raw DB wall dates must not be compared to an uncalibrated host clock; retain the
  fixed original local translation plus the independent monotonic limit. A host
  suspension advancing wall time while monotonic freezes must still stop sends.
  Publication independently rechecks the original absolute DB deadline.
  Transport close/abort invalidates that local capability. The provider helper
  must never dispatch a pre-reserved later page after the original deadline or durable retirement.
- This fences future application sends/publication; it does not claim that an
  already-sent remote GET was cancelled or completed. Its full original budget
  reservation remains charged. The next acquisition has a new ID, calls and
  ordinary hourly floor, never a continuation/replay of unknown pagination.
- Recovery is called before claim by ordinary scheduler work, independently of
  whether preparation is currently HOLD. Live unexpired STARTED/FINALIZING is
  WAITING until its original deadline. A new-protocol expired attempt may be
  retired atomically under the same issuer lock after exact terminal readback.
  Append recovery receipt and settle nonterminal old
  STARTED/FINALIZING as UNKNOWN in one transaction. Existing UNKNOWN remains
  byte-for-byte unchanged. If the transaction is ambiguous, read its exact UUID
  once boundedly; no new claim/network send until proved committed.
- A legacy attempt requires an accepted operator quiescence challenge. It cannot
  borrow the new protocol or derive ownership from a currently running container.
- A committed SUCCEEDED result is recognized only through exact attempt,
  snapshot hash, source projection, complete canonical two-pass page receipts,
  immutable call outcomes and original publication linkage. Reuse the existing
  provenance validator; do not rebuild or republish a missing result from only
  response hashes. All-success page rows alone are not a snapshot proof.

The clock proof has exact fixed bounds, not an assumed globally reliable wall
clock. At claim, reservation, automatic recovery and terminal publication sample
DB clock_timestamp and local Date.now with the same bounded operation. Require
absolute sampled difference <=1000ms; query/response latency exceeding1000ms is
not an acceptable clock sample. Store the original admitted pair immutably.
The store-owned ticket also retains original wall and monotonic anchors. At each
reserve and synchronous request/end checkpoint require
`abs((wallNow-wallAnchor)-(monotonicNow-monotonicAnchor)) <=1000ms`; any failure
permanently invalidates the local ticket, with no reanchoring or fresh budget.
Recheck numeric fixed wall/monotonic deadlines independently of timers.

Automatic recovery additionally requires the original and current trusted runtime
clock domain to be identical: production Linux reads
`/proc/sys/kernel/random/boot_id` and stores its SHA-256 as clock_domain_id. This
identifies the shared kernel wall clock of containers on the same Docker VM.
It is collected by runtime, never accepted as caller JSON. Missing capability,
changed boot ID or another host requires operator quiescence. This restriction
prevents a new worker's clock jump from being mistaken for expiry of a worker on
another host. A normal container restart on the same kernel remains eligible.

Do not recover before `DB now >= original deadline_at +5000ms`. Under the issuer
lock repeat the fresh <=1000ms DB/host check and fixed continuity check immediately
before committing recovery. The 5-second guard absorbs bounded sample skew; it
does not extend acquisition or permit publication. A DB-only clock jump that
would prematurely expire the attempt/hourly floor fails the clock check and
returns OPERATOR_REQUIRED without a receipt or provider request. A shared host
wall jump is visible to the predecessor's fixed wall deadline; a suspension with
frozen monotonic fails the continuity check. DB backward jumps, local rollback,
malformed/missing stored proof or uncertainty likewise grant no automatic proof.
Clock failure cannot rewrite the original evidence or classify UNKNOWN as known.
All terminal success paths additionally validate current clock continuity and
original DB deadline in their existing bounded transaction. Failure bookkeeping
may preserve UNKNOWN even when successful publication is no longer admissible.

The claim and SQL INSERT unresolved predicates ignore only exact predecessors
with valid recovery receipts. They still enforce one hour from EVERY original
attempt started_at, immutable original slots, current authority, source identity
and pooled UTC budget. Receipt creation does not consume a provider request;
actual new reservation consumes it normally. A recovery followed by budget denial
remains HOLD/WAITING as appropriate, never READY from stale cached news.

Keep admission reasons separate from scheduling fences. Recovered UNKNOWN still
blocks cached data until a strictly later, same-current-identity fully proved
SUCCEEDED acquisition exists. Across manifests, a receipt allows a new ordinary
claim but never imports the former manifest's snapshot. The historical global
fallback in readMarketauxRefreshState must distinguish unrecovered scheduling
fences from recovered history, then require current-manifest valid success.
Known HARD failures are not converted to transient or erased by recovery.

Suggested shared API additions:

```ts
recoverMarketauxAttempts(identity: MarketauxAttemptIdentity): Promise<{
  state: 'NOT_REQUIRED' | 'RECOVERED' | 'WAITING' | 'OPERATOR_REQUIRED';
  reason: string | null; nextCheckAt: string | null; recoveryIds: string[];
}>;
readMarketauxAttemptResult(attemptId: string): Promise<ExactAttemptResult>;
```

The store issues a nonserializable dispatch capability with reserveMarketauxCall;
the app passes its synchronous assertActive callback into the existing HTTP helper.
No generic executor or arbitrary function-call mechanism is introduced. Use the
existing bounded DB connection pattern: each operation <=3 seconds and the
original attempt deadline; failure bookkeeping has its one existing separate
absolute 3-second bound. Recovery itself has one 3-second monotonic bound.

## Privileged local operator procedure and evidence

Add a bounded privileged local CLI alongside existing paper-verify-stack
operator tooling, following the repository's existing local database maintenance
pattern. Do not add a new HTTP service or recovery route family. The CLI first
uses existing authenticated execution account/entry-control/configuration reads,
then invokes strict shared store recovery methods through the existing operator
DB capability. This is a trusted local administrator boundary, not an unauthenticated
worker API. It requires explicit configured Paper identity, known allowlisted
account and durable entry pause. It never changes pause/resume state or needs the
master broker-write switch enabled.

Commands and shared APIs:

```text
paper research-recovery prepare --kind marketaux|wsh --instrument <id>
paper research-recovery observe --challenge <uuid>
paper research-recovery commit --challenge <uuid>
paper research-recovery supersede --challenge <uuid> --instrument <current-id>
```

```ts
prepareResearchRecovery(input: RecoveryIdentity): Promise<RecoveryChallenge>;
commitResearchRecovery(input: RecoveryCommit): Promise<RecoveryReceipt>;
readResearchRecovery(id: string): Promise<RecoveryChallenge | null>;
readResearchRecoveryReceipt(challengeId: string, operationId: string): Promise<RecoveryReceipt | null>;
supersedeResearchRecovery(input: RecoverySupersede): Promise<RecoveryChallenge>;
readResearchRecoveryReplacement(operationId: string, identity: RecoveryIdentity): Promise<RecoveryChallenge | null>;
```

The command's prepare phase accepts strict kind/instrument/source identities and
idempotency UUID. The store transaction binds current authority, pause revision
and exact full blocker set directly from durable tables; an API observation alone
is not sufficient authority. For WSH, collect endpoint predecessors AND each
relevant issuer's blockers on other endpoints. A reset of endpoint A cannot resolve
session B on endpoint B; return the additional required endpoint instead of
expanding the reset claim. Refuse live active attempts and acquire the existing
endpoint session lock during preparation/commit. PREPARED maintenance hold prevents a producer starting under an old challenge.
Prepare preserves the endpoint generation so legacy retirement can use its
original exact fence; commit retires covered PENDING rows before advancing the
endpoint generation in that same transaction.
Claims and SQL admission guards both honor the durable hold. The endpoint lock
is not held over a manual 15-minute operator interaction. Direct DB methods
revalidate the durable account, authority and pause revision, and append a dedicated
actor/action audit row in the same transaction. Credentials never enter evidence.

The shared exported interface is frozen as follows. UUIDs, hashes, UTC dates,
identifier lengths, numeric bounds and strict no-unknown-key validation apply at
the boundary; interfaces alone are not validation. Reuse existing shared
ResearchIdentity and WshCleanupResult. `parseRecoveryEvidence(unknown)` is exported
for the host collector and one-shot CLI. Canonical hashes use existing researchHash.
Definitions and the parser live in
`packages/shared/src/instrument-research/startup-recovery.ts` and are exported
through the existing `@ikbr/shared/instrument-research` barrel; methods remain on
ResearchStore. The one-shot CLI imports neither llm-agent index nor its scheduler.

```ts
type RecoveryKind = 'MARKETAUX_PRODUCER_QUIESCENCE' | 'WSH_ENDPOINT_RESET';
interface RecoveryIdentity extends ResearchIdentity {
  kind: RecoveryKind; accountId: string; instrumentId: string; sourceId: string;
  pauseRevision: number; actor: string; operationId: string;
}
interface RecoveryPredecessor {
  kind: 'MARKETAUX_ATTEMPT' | 'WSH_ATTEMPT' | 'WSH_ACQUISITION';
  id: string; identityHash: string; state: string;
  endpointId: string | null; ledgerKey: string;
  sessionId: string | null; generation: number | null;
}
interface RecoveryChallenge extends RecoveryIdentity {
  id: string; nonce: string; challengeHash: string;
  executionProcessId: string;
  createdAt: string; expiresAt: string;
  state: 'PREPARED' | 'COMMITTED' | 'CANCELLED';
  endpointId: string | null; endpointGeneration: number | null;
  predecessors: RecoveryPredecessor[]; predecessorHash: string;
  receiptId: string | null;
}
interface RecoveryProducer {
  containerId: string; imageId: string; project: string; service: 'llm-agent';
  startedAt: string; finishedAt: string; state: 'exited' | 'dead';
}
interface RecoveryProcess {
  pid: number; startIdentity: string; executableHash: string;
}
interface RecoveryEvidenceBase {
  version: 'local-research-recovery-v1'; kind: RecoveryKind;
  challengeId: string; challengeHash: string; nonce: string;
  hostIdHash: string; platform: 'darwin'; collectorStartedAt: string;
  producerCheckedAt: string; producerRecheckedAt: string;
  deploymentHash: string; producers: RecoveryProducer[];
  // Empty result of a complete second deployment inventory, not a caller override.
  runningProducerIds: [];
}
interface MarketauxRecoveryEvidence extends RecoveryEvidenceBase {
  kind: 'MARKETAUX_PRODUCER_QUIESCENCE';
}
interface WshRecoveryEvidence extends RecoveryEvidenceBase {
  kind: 'WSH_ENDPOINT_RESET'; endpointId: string; endpointSettingsHash: string;
  host: string; port: number; clientId: number;
  before: { observedAt: string; process: RecoveryProcess };
  stopped: { observedAt: string; processAbsent: true; listenerAbsent: true };
  after: { observedAt: string; process: RecoveryProcess };
  reconnect: {
    startedAt: string; completedAt: string; sessionId: string;
    accountId: string; serverVersion: number; sdkVersion: '1.6.10';
    cleanup: WshCleanupResult;
  };
}
type RecoveryEvidence = MarketauxRecoveryEvidence | WshRecoveryEvidence;
interface RecoveryCommit {
  challengeId: string; challengeHash: string; operationId: string;
  actor: string; pauseRevision: number; evidence: RecoveryEvidence;
}
interface RecoveryReceipt {
  id: string; challengeId: string; kind: RecoveryKind;
  recordedAt: string; evidenceHash: string; predecessorHash: string;
  nextCheckAt: string | null;
}
interface RecoverySupersede {
  challengeId: string; challengeHash: string;
  replacement: RecoveryIdentity;
  evidence: RecoveryQuiescenceEvidence;
}
interface RecoveryQuiescenceEvidence extends Omit<RecoveryEvidenceBase, 'kind'> {
  kind: 'PRODUCER_QUIESCENCE';
}
```

Evidence limits: actor 1–80 `[A-Za-z0-9_.:-]`, process startIdentity 1–128 printable
ASCII, SHA-256 lowercase hex hashes, UUID operation/challenge/container session IDs
(where existing transport sessions use another shape, validate existing session
format instead), Docker containerId 64 hex and imageId `sha256:` plus64 hex,
project 1–100 `[A-Za-z0-9_.-]`, positive safe PID/clientId/serverVersion, port1–65535,
1–16 producers, 1–256 predecessors. Refuse an empty producer inventory: no stopped
original deployment evidence is an unsupported proof, not success. `runningProducerIds`
is exactly empty because the collector must have observed no active producers;
this single field never substitutes for the complete stopped inventory.

Evidence ordering is local-host time: collector start <= producer check <=
producer recheck; WSH before < stopped < after <= reconnect start <= reconnect
completion <= producer recheck. All observed times must be finite, canonical UTC,
not future relative to the collector's commit submission and span <=15 minutes.
The store independently checks its DB challenge expiry; it does not compare raw
host times to DB times as if clocks were equal. Host clock rollback/order failure
requires a fresh observation. WSH old/new process creation identities must differ;
reconnect cleanup session must exactly match reconnect session and be CONFIRMED
with verifiedLocalClosure=true. Captured expected account/clientId/endpoint/config
must match pinned local runtime and current parsed manifest. `endpointSettingsHash`
is researchHash({endpointId,host,port,clientId}); the one-shot CLI reconstructs it
from current pinned runtime, not caller-supplied arbitrary settings. Platform and
host capability validation are the host collector's trusted boundary.

All prepare/commit/supersede operator transactions first take existing `snap:<account>`
advisory lock and execution_entry_controls row lock, require paused=true and
identical revision, then follow provider lock order below. This matches the
existing entry-resume serialization and prevents concurrent resume racing a
receipt. Recovery changes no entry-control row or revision. CLI authenticated
preflight reads do not substitute for these database checks.

PREPARED maintenance holds are research admission fences, not merely acquisition
fences. Add one shared store check before snapshot/head locks in prepareRepair,
bind, validateBinding and the final startup/resume transaction. Marketaux applies
to affected account/issuer; WSH applies to every current instrument/account using
the held endpoint or enumerated affected issuer. Even a cached PUBLISHED/SUCCEEDED
WSH projection with cleanup UNKNOWN cannot authorize resume during PREPARED.
Expired PREPARED challenges remain holds until explicit supported resolution.
Receipt alone never makes previously uncertain cached evidence eligible.

Serialize this against challenge creation: admission readers take SHARE on
research_recovery_challenges before research attempt-table/head locks; maintenance
mutators take ROW EXCLUSIVE before those same locks. Provider claim/publication
transactions take the shared challenge lock before their attempt/head/endpoint-row
locks, so they cannot start from a stale absent-hold observation. Existing external
WSH endpoint session locks remain outside transactions and are acquired before
the challenge-table lock. Operator mutations retain snap/account pause locks first.
Concurrent resume either finishes before maintenance prepare (which then rejects
the changed pause revision), or observes the hold and leaves the account paused.

### Maintenance authority while producers are stopped

Normal `assertAuthority` requires a fresh llm-agent observation and cannot be
used by this maintenance path: the deliberate producer stop outlasts its 30-second
observation. Add one private `assertRecoveryMaintenanceAuthority(identity, db)`
used exclusively by prepare/commit/supersede and their exact readback/retirement.
It runs inside the same single bounded transaction and checks:

1. Canonical durable trading configuration and research manifest decode/hash
   correctly, the bundle rollout is latched, and locked research_authority still
   adopts the exact config/manifest pair. Do not mistake first_effective_hash for
   the current configuration: that rollout field is the historical first latch.
2. The locked execution_entry_controls account is paused at the exact expected
   revision. The CLI has verified current Paper environment and known allowlisted
   account through existing authenticated controls; maintenance never sets these.
3. A fresh unambiguous execution-engine research observation remains current,
   matches config/manifest and has a finite unexpired DB-time validity. Fresh
   execution-engine trading-configuration observations must match bundle mode and
   effective hash. Prepare captures the actual research executionProcessId;
   commit requires that same current process. Supersession uses current authority
   and current execution process under the separate contract below. All fresh conflicting research
   or trading-configuration observations reject, including a drifting llm worker.
4. Only absence/expiry of the intentionally stopped llm-agent heartbeat is exempt.
   No observation row is inserted, renewed or relabelled. Missing/stale execution
   evidence, different process, changed authority or changed pause revision denies.

Prepare/commit/supersede use this check both before mutation and before COMMIT,
including the captured execution observation expiry. Exact readback uses the same
bounded maintenance read with challenge-pinned identity; it cannot grant recovery
authority from an arbitrary ID. `readResearchRecovery(id)` reads the stored
challenge identity first and checks the maintenance authority before returning it;
it returns null only for an absent ID, and throws on inaccessible/stale authority.
Retirement of covered PENDING acquisitions happens inside the caller's transaction
using the exact lease/generation and existing outcome-only retirement mechanics.
It does not invoke finishWshFailure/persistSnapshot or nested transactions that
would require the stopped peer or publish research. The same applies to appending
missing UNKNOWN call outcomes and Marketaux retirement. No negative snapshot is
needed because the existing uncertainty and maintenance holds remain authoritative.

Normal automatic Marketaux recovery, refresh claims, provider reservations,
publication, preparation, binding, AI and resume keep the original full
assertAuthority checks unchanged. Add a regression: stop llm observations past30s,
keep exact execution observations fresh, and complete maintenance; stale execution,
fresh drifting llm, restart of execution, changed manifest or changed pause must
reject. No fake heartbeat is an allowed test fixture for the stopped producer.

The local command uses fixed argv arrays with no shell interpolation. The initial
supported verifier is the current local macOS Gateway deployment. Use read-only
Docker inspect and OS listener/process inspection (`lsof`, `ps` or an equivalent
fixed native query), selected by validated local host/platform capability. Map
the configured endpoint/port to the actual listener process. Require exact local
or configured host.docker.internal mapping; remote, proxied, ambiguous and
unobservable listeners remain OPERATOR_REQUIRED. Do not infer Paper from the port.

The command records a strict versioned observation bundle:

- challenge UUID/nonce/hash; pinned current config/manifest and endpoint settings
  hash; operator label and request audit identifier;
- complete configured producer deployment identity: Compose project/service,
  prior llm-agent container IDs/image digests, process identity/start identity,
  stopped/exited status, and a second inspection proving no replacement producer
  appeared while gathering evidence; known external producers require an explicit
  documented inventory and quiescence, otherwise capability is unsupported;
- for Marketaux, verified old deployed producers have exited and no active
  replacement remains. This is proof about producer lifetime only, not HTTP
  provider completion. Legacy historical owner fields stay unavailable;
- for WSH, exact old Gateway listener PID plus process creation identity, observed
  old process termination AND old listener disappearance, then distinct new
  process creation identity owning the same configured endpoint. The operator
  manually restarts Gateway after coordinating clients, open positions and
  protection. A changed PID alone, reused PID, mere new worker, reconnect alone,
  time gap, log message or unchecked evidence file is insufficient;
- after restart, a bounded handshake using the configured unchanged WSH clientId
  and expected account, no metadata/events/history/order calls, verifies server
  protocol and expected account. Reuse WshSocketTransport connect/close and its
  actual owned-local-close proof. This proves new endpoint reachability, not
  cleanup of the old socket; old process termination supplies the latter.

The host helper is the trusted local operator evidence collector, using existing
execution bearer reads plus its local operator DB credential. This is not cryptographic proof against an
operator who possesses those administrative credentials. Do not invent a signature that adds no trust:
the store validates schema, scope, immutable challenge, expected endpoint,
account/revision, freshness/order and evidence hash, while the documented trusted
host collector is responsible for truthful OS observations. An arbitrary boolean
`confirmed=true`, unparsed prose, arbitrary uploaded hash, or observation from
an unsupported remote host is rejected. Store the canonical structured evidence,
not only its caller-supplied digest. Exact commit readback returns the stored hash.

Reconnect may be implemented by a small llm-agent recovery CLI using its existing
SDK dependency, invoked as a one-shot command by the host tool, with scheduler
startup disabled. It must take the prepared challenge and stop if authority or
pause revision changed. This CLI is observation only: no source query, no budget
reservation, no order method, and no clientId rotation. Close its socket before
receipt commit. If a challenge/evidence/commit is uncertain, preserve the hold;
do not repeat a Gateway reset automatically or resend a source request.

Commit rechecks the same account, authority, durable pause revision, exact blocker
hash, endpoint generation, producer observations and challenge deadline. It locks
the endpoint row and sorted issuer keys, then writes receipt/predecessor links and
terminal challenge atomically. Legacy PENDING WSH acquisitions may be retired
UNKNOWN using existing audited settlement only after this fence; missing call
outcomes become UNKNOWN once. Existing terminal attempts, cleanup UNKNOWN and
verified_local_closure=false remain unchanged. No old closure field is overwritten
with CONFIRMED. Preserve proved PUBLISHED acquisitions and their original TTL.

The receipt releases only its named old cleanup scheduling fences. It permits
the first subsequent ordinary cycle after max(all predecessor nextRegularAt,
existing issuer baseline), never a fast retry. Its unique first-successor link
prevents simultaneous redemptions. Later ordinary cycles rely on the current
generation and their own outcomes; any new UNKNOWN or other-endpoint predecessor
is an independent fence. Original uncertainty still blocks cached research until
new validated evidence succeeds. Recovery does not clear permission, identity,
budget, metadata, AI, risk, reconciliation or entry-control holds.

## Obsolete challenge supersession

There is no standalone cancel operation that removes a PREPARED hold. The operator
uses `supersedeResearchRecovery` when execution restarted, the pause revision
changed, authority changed or the challenge expired. It accepts the exact prior
challenge ID/hash, a current RecoveryIdentity, and strict fresh
RecoveryQuiescenceEvidence. The evidence shares the bounded producer inventory,
host, deployment, nonce and chronology checks above, but has kind
PRODUCER_QUIESCENCE and never asserts Gateway reset. Its challenge fields refer
to the old challenge. It is collected within a fresh 15-minute local observation
window, independently of the old expired challenge deadline.

Under snap/current-account pause lock, fresh current maintenance authority and
challenge-table ROW EXCLUSIVE, supersession locks the exact old PREPARED row and
verifies current paused revision. It does not require the obsolete execution
process or obsolete research authority to remain adopted. The replacement must
retain the same account, kind, endpoint and issuer scope; its current parsed
manifest must map the selected source to that scope. A missing mapping or changed
endpoint requires explicit separate reviewed capability, and preserves the hold.
The new predecessor set is the union of every old unresolved predecessor and any
new blocker in the same scope; it must never drop an old fence. Source uncertainty
and all original predecessor evidence remain unchanged.

Atomically write the old terminal CANCELLED row with its immutable successor ID,
the new PREPARED row referencing its predecessor challenge, fresh expiry/nonce/hash,
current execution process and current pause revision, and the audit event plus
canonical quiescence evidence. Unique predecessor/successor and operation UUID
constraints prevent forks. No receipt, provider call, outcome retirement, endpoint
generation increment or entry-control mutation is permitted. The shared table
lock means admission sees either the old hold or the new hold, never neither.

Exact operation readback (including a lost prepare response) uses the current replacement identity and operation
UUID; add `readResearchRecoveryReplacement(operationId, identity)` to resolve exact operation_id under current maintenance authority with the same historical account/kind/issuer-ledger/endpoint scope for either prepare or
supersession, so a lost response never requires reusing obsolete challenge read authority. It returns the
exact persisted replacement after current maintenance checks, or null if absent;
unknown readback remains HOLD with no automatic resubmission. Reusing an operation
UUID with different content rejects. `readResearchRecovery(id)` otherwise retains
its normal challenge-pinned maintenance checks.

Tests must cover execution restart, repeated pause, changed adopted manifest with
same scope, missing new mapping, expired challenge, wrong quiescence evidence,
concurrent supersession/resume/bind and unknown supersession commit. At every
point the old or successor hold denies cached research admission and acquisition.

## Lock order and compatibility

Retain existing store lock order; do not introduce recursive pooled transactions.
Marketaux recovery uses attempt-table ROW EXCLUSIVE, authority SHARE, issuer
advisory lock, attempt/receipt rows, calls, then head only if exact readback
requires it. It does not publish a snapshot. Admission continues taking its
existing authority/attempt-table SHARE lock before a head. WSH maintenance uses
the endpoint session advisory lock outside transactions, authority/observations,
endpoint row, sorted issuer locks, challenge/attempt/acquisition rows, then budget
or head if existing retirement requires them. Cross-provider challenges are not
supported; one challenge covers one recovery kind, avoiding mixed lock orders.

Migration updates both SQL admission triggers and TypeScript store predicates;
application-only exclusions are insufficient. Stop producers during adoption.
An old image cannot generate new protocol attempts or understand receipts and
therefore remains blocked. No rollback clears history or grants older code new
recovery semantics. Unknown commit/readback always preserves a scheduling/admission
hold. Exact receipt ID is idempotent; changed content with the same ID rejects.

## Diagnostics and acceptance

Add optional typed recovery fields to Marketaux/WSH refresh diagnostics, retaining
existing fields: `state`, `reason`, `nextCheckAt`, `operatorAction`, `challengeId`
and `lastRecoveryId`. Allowlisted operator actions distinguish STOP_PRODUCERS,
OBSERVE_LOCAL_GATEWAY_RESTART, COMPLETE_RECONNECT_PROOF and UNSUPPORTED_ENDPOINT.
No credential, process inventory, account ID or raw payload is printed publicly.
Recovery is visible independently of data readiness, and never sets READY itself.

Required isolated tests:

- Reproduce the exact supplied PKO UNKNOWN and AAPL incomplete pass-2 legacy rows.
  Without receipt: OPERATOR_REQUIRED, zero network. After verified quiescence:
  original outcomes/budgets unchanged, one ordinary fresh acquisition, no page
  continuation, no eligibility until complete new two-pass publication.
- New-protocol attempt before deadline; expired STARTED; FINALIZING before/after COMMIT;
  lost ACK with exact success readback; all-success pages without published
  snapshot; retired-ticket writes/response/late DNS; timer-delayed req.end;
  wall advance with frozen monotonic; death during recovery; two recovery/claim workers; manifest/account changes;
  full UTC budget and rollover; hard failure never downgraded.
- Fixed clock proof: DB forward/backward jumps, query latency >1000ms, local wall
  shift, suspension/frozen monotonic, changed boot/clock domain, missing legacy
  proof, 5000ms recovery boundary, late DNS and delayed req.end. No receipt or send
  after failed clock proof; no successful publication after original DB deadline.
- WSH crash/no old socket; disconnect without close; replacement socket;
  terminal success with cleanup UNKNOWN; legacy acquisition without attempt;
  endpoint OR issuer fences across accounts and endpoints; missing/superset or
  changed predecessor set; stale generation/challenge/pause revision; 10281;
  one receipt/first successor; new UNKNOWN requiring new evidence; unknown commit.
- Host verifier: exact old process termination/listener loss/new start/handshake
  and local close succeeds; PID reuse, surviving old process, listener proxy,
  remote host, changed port/clientId, replacement producer, fake evidence hash,
  skipped observation, wrong expected account and reconnect cleanup UNKNOWN deny.
- CLI/store: failed authenticated preflight, wrong account/live/not paused denies;
  master disabled plus valid maintenance guard works; direct DB methods recheck
  durable authority/pause revision; audit always persists; no broker-write method
  invoked; prepare/supersede never clear source uncertainty; no resume.
- Scheduler normal startup/repair invokes recoverable Marketaux inspection even
  when source preparation is HOLD, but never repeats already fresh sources.
  Research binding/start/resume continue denying after receipt alone and after
  a later hard/unknown failure; no TTL or old snapshot resurrection.

- PREPARED WSH hold with otherwise usable cached success denies bind, validation,
  startup preparation and final resume across another instrument on the endpoint.
  Race prepare versus resume; rejection preserves the exact durable pause revision.

Files: shared `instrument-research/{store,marketaux-refresh,wsh-refresh,repair}.ts`,
small adjacent recovery types/parser file and barrel, migration 37 and focused
PG/unit suites; llm-agent `research-refresh.ts`, `research-marketaux-fetch.ts`,
`research-fetch.ts`, `research-wsh-refresh.ts`, existing transport only for
reusable observation boundary, a new recovery CLI and relevant tests; paper-verify-stack local recovery command/host verifier/tests;
package scripts only for these commands and suites; existing runbooks/report.
No changes to strategies, model decisions, order lifecycle or unknown broker writes.

Required package validation remains lint, typecheck, unit tests, isolated-PG
integration, build, clean Docker build, independent hostile implementation review,
scoped main publication and exact-commit CI. This contract is authored by
research_recovery_contract (requested gpt-6-astra/high; actual runtime telemetry
and token usage unavailable). The author must not be its plan reviewer or final
implementation reviewer. Any unsupported host proof, broadened deployment scope,
changed deadline fencing or changed admission semantics returns to the lead and
independent review before implementation.
