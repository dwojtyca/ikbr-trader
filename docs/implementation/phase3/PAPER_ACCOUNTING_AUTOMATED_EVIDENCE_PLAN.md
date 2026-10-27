# Paper accounting recovery: automatic account evidence

Date: 2026-10-27. Status: ACCEPTED by independent `automatic_evidence_plan_review`
(`gpt-6-astra` / `high`), after one repair covering unresolved-dispatch ancestry.
Acceptance authorizes this bounded implementation; no operational acceptance is implied.
The same independent reviewer accepted the explicit coordination-file readback
and bounded probe inventory clarification on 2026-10-27. Author route: critical architecture, requested
`gpt-6-astra` / `high`; actual model/effort must be recorded by the coordinator.

## Outcome and boundaries

Extend the existing offline stranded-owner recovery so that complete, current
IBKR account/position/open-order API evidence replaces the owner's transcription
of those facts. Preserve the full observed TWS reset, positive native socket
closure, exact owner CAS, maintenance fence and no-bot-submission-history subset.
Do not weaken the prerequisite that the account is known flat before restarting
TWS. The current expired PREPARED operation must be superseded, never resumed.

The owner requests starting the existing Paper bot and prefers automatic API
inspection. This package supplies a prerequisite, not permission to ignore other
startup, research, qualification, accounting or trading gates. No strategy,
proposal/risk/close logic, new UI, general broker console, operational SQL reset,
provider call, or Live support is included. Historical V1 evidence keeps its
meaning. Read [AGENTS](../../../AGENTS.md), [ROADMAP](../ROADMAP.md),
[delivery plan](PAPER_PRODUCTION_DELIVERY_PLAN.md),
[routing guide](MODEL_ROUTING_GUIDE.md),
[current recovery contract](PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md) and
[runbook](../../runbooks/PAPER_ACCOUNTING_SOURCE.md).

## Evidence and adapter findings

Execution already installs `@stoqey/ib` 1.6.10 alongside legacy `ib`. The existing
`owner-recovery-transport.ts` uses the former's low-level `IBApi`, records the
actual `net.Socket` close and exposes only `reqManagedAccts`. Its handshake
therefore proves no position or order coverage. Installed
`dist/api/api.js` implements `reqPositions`, `cancelPositions`, and
`reqAllOpenOrders`; these methods schedule the corresponding encoder calls.
Use that same pinned SDK, not the higher-level `IBApiNext` or the trading client.
Verify the production connection path has no implicit order-binding calls.

The primary [EClient reference](https://interactivebrokers.github.io/tws-api/classIBApi_1_1EClient.html)
documents position subscription and initial completion, and all-open-order
snapshot completion through `openOrderEnd`.
[IBKR's modifying-orders documentation](https://www.interactivebrokers.com/docs/tws-api/doc/orders/modifying-orders)
states that `reqAllOpenOrders` does not bind orders, while `reqOpenOrders` and
`reqAutoOpenOrders` can bind manual orders. Binding can cancel/resubmit orders;
both binding methods are forbidden here, including a call with a false argument.

API snapshots do not establish absence of untransmitted local UI drafts,
uncoordinated external clients, or future manual intervention. See the
[IBKR order introduction](https://www.interactivebrokers.com/docs/tws-api/doc/orders/place-order/introduction).
Do not label the API proof as evidence of those facts. Coverage is the complete
associated-account API snapshot on the pinned TWS session, under the explicit
single-account/other-client coordination prerequisite. Unsupported account or
session topology denies recovery; it is not silently filtered away.

## Selected lifecycle: reservation before proof, no reset before proof

A pre-prepare socket would bypass the existing owner fence. Instead V2 adds a
strictly bounded reservation and probe phase inside the existing recovery
operation. PREPARED means only maintenance is reserved; it never means account
flatness is established. Authentication, immutable deployment/settings/endpoint,
sole exact ACTIVE/UNKNOWN owner, durable pause, stopped producers and offline
eligibility are still required before that reservation. No ordinary accounting
owner is acquired and no source qualification is changed.

1. `prepare --api-evidence --coordination <private-json>` or
   `supersede --operation <uuid> --api-evidence --coordination <private-json>`
   validates the private coordination record and current inventory. Atomically
   create a V2 PREPARED operation, or supersede the pending operation with one,
   maintaining the existing global fence without a gap. Record actor,
   coordination digest, exact owner, endpoint, deployment and recovery client
   binding. No socket is opened by prepare/supersede.
2. `observe --operation <successor-uuid> --api-evidence
   --environment-evidence <private-after-json> --coordination <original-private-json>`
   revalidates the original coordination/artifact bytes and opens the existing
   long-lived pinned backend and obtains the existing endpoint advisory lock.
   Validate current bindings, pause, host watcher and one-shot identity. Before
   any socket open, append `PRE_RESET_PROBE_DISPATCH` durably. The backend owns
   this result; a host-supplied JSON account snapshot can never authorize it.
3. Perform exactly one bounded pre-reset account probe using the existing pinned
   accounting client ID 0. An older official
   [IBKR Java guide](https://www.interactivebrokers.ca/download/JavaAPIGettingStarted.pdf)
   qualifies manual TWS-order visibility by client 0, so a positive client ID
   cannot be assumed to provide equivalent coverage. This is an explicit V2
   recovery-only exception permitting a read-only client-0 probe under durable
   maintenance, exact-owner advisory lock, stopped inventory and pre-dispatch
   audit. It does not acquire/activate the accounting source or retire its owner.
   This exception requires independent critical acceptance; it is not inherited
   permission from the old V1 handshake. No client-ID override, numeric fallback,
   free-ID search, binding request or retry on conflict exists. A still-connected
   old client 0 causes a denial, not a forced takeover, alternate ID or reset.
   All ordinary services remain stopped. The non-binding API coverage test must
   include manual orders and connected client ID 0 before operational acceptance.
   During each bounded owned probe retain continuous Docker event monitoring and
   repeated exact TWS process/LISTEN identity checks. Perform full native socket
   inventory immediately before dispatch and after positive closure; an active
   sanctioned Docker proxy connection must not be mislabeled an external client.
   No socket-owner exemption is introduced.
4. Positive native transport close produces `PRE_RESET_PROBE_CLOSED`, recording
   the backend result (complete/incomplete/nonflat/error), closure and digest.
   A closed failure result remains a failure, not a flat-account proof. Only a
   complete flat/no-orders result plus this positive close permits continuation.
   Revalidate live inventory/profile/clock. Return the successful proof digest to
   the host and only then log permission to close TWS. No UI reset occurs if this
   phase fails, finds exposure or lacks coverage. If backend cancellation prevents
   durable recording of a real close, the outcome remains unknown; do not infer it.
5. Retain the same collector/backend/advisory lock and verify the pre-probe TWS
   process identity remained unchanged throughout the probe. Observe that identity,
   disappearance of its process and listener, and a new process/listener. Current
   authorized UI automation may perform the full stop/start externally. The
   collector does not fake the observation or restart TWS itself. Never start TWS
   before the collector acknowledges complete stop.
6. Obtain fresh post-reset Paper-session environment evidence described below,
   bound to the emitted operation/nonce/new-process identity. Then reuse the
   existing single client-0 post-reset handshake, extending it to collect
   the same complete account/positions/all-open-orders proof. Append the existing
   `HANDSHAKE_DISPATCH` before socket open. Account facts come from this backend
   connection after the witnessed replacement, never from old screenshots or a
   previous snapshot. The post-reset proof must be flat and its native socket
   positively closed. Persist `HANDSHAKE_CLOSED` with its V2 proof digest.
7. Recheck the live host witness, unchanged coordination/profile/owner/pause,
   clocks and both proof bindings. Finalize OBSERVED and COMMITTED atomically via
   the existing exact-owner retirement transaction and immutable receipt. Read
   back exact operation/request identity. Nothing resumes entries or producers.

The original 15-minute DB deadline starts at reservation and is never extended.
Each probe has a maximum 20 seconds total: at most 18 seconds for handshake and
snapshots and 2 seconds reserved for native close. Require this entire remaining
budget before dispatch. Retain the existing 1-second clock-skew and 2-second DB
round-trip bounds. Pre-reset proof must be no older than five minutes when reset
is authorized; post-reset proof no older than five minutes at finalization.
Any configuration, owner, producer, process or coordination change aborts.
A timing-invalid result with a positively observed native close may be recorded
as INCOMPLETE only in the same authenticated observer/dispatch while operation,
lock and authorization remain valid. It never authorizes reset or commit and
never extends a timer/deadline or accepts a callback after completion. Before/after
native snapshots plus continuous Docker/TWS checks do not prove absence of
transient external native clients between samples; coordination remains required.

## Concrete read-only probe contract

Expose only connection/lifecycle events, `reqManagedAccts`, `reqPositions`,
`reqAllOpenOrders`, and disconnect on the narrow recovery transport. The socket
is destroyed after the snapshot, ending its position subscription; a separate
cancel is unnecessary. No order submit/modify/cancel/bind, completed-order,
execution-history, data subscription or provider call is needed.

Require a single ready connection generation and exactly the configured account
in `managedAccounts`; explicit Paper environment and whitelist come from trusted
configuration, not account-ID prefix or socket port. Managed account identity
alone does not independently certify that TWS is Paper. Do not require a fresh
accounting-source qualification here: current recovery can be needed while that
qualification is expired and normal source startup is blocked by this owner.
Instead require separate fresh, honest environment-only evidence before each
probe: the current TWS UI explicitly displays Simulated Trading/Paper and the
exact configured account, linked to the host-observed current TWS PID/start/
executable identity. A current screenshot or accessibility observation can be
recorded by the actual observing agent, without claiming the owner saw it. Its
private hashed artifact, observation time, actual actor/provenance and exact
account/endpoint/settings/deployment bindings must be captured no more than five
minutes before the corresponding probe. The pre-reset record accompanies
coordination; the after-reset file is produced only after the collector emits
its new process/nonce binding, then validated before post-reset socket dispatch.
Use existing private-file safeguards. Missing, ambiguous, stale or unbound
UI/session evidence denies; neither a DU prefix, the configured port, nor an
expired qualification is a fresh Paper-session observation. An owner supplies
only this environment observation if supported read-only UI access cannot obtain
it reliably. This evidence does not attest positions/orders and does not renew
accounting qualification. No automatic change to settings is permitted.

After readiness/account confirmation, issue `reqPositions` exactly once and
`reqAllOpenOrders` exactly once. Register listeners before sending requests.
Accept `positionEnd` and `openOrderEnd` only after their own request dispatch in
this generation. No completion, timeout, error, truncation, disconnect or empty
array fallback may imply an empty snapshot. Unexpected/duplicate completion
markers, duplicate conflicting identity rows, unknown account, missing account,
malformed quantity/contract/order, non-finite numeric values or output overflow
deny. Require finite exactly-zero position quantities for all received rows and
zero open-order callbacks. Any order callback denies regardless of reported
status, quantity, order ID (including zero), instrument, origin or client ID.
Any nonzero position observed during the probe denies even if later updated to
zero. Keep listeners active through native close; late exposure/error invalidates
an otherwise completed candidate. A status-only order indication also denies
rather than being discarded for lack of an `openOrder` row.

Cap events at 4096 and bounded sanitized evidence at the existing 64 KiB message
limit; reaching a cap is incomplete coverage, never success. Store bounded
normalized coverage/counts/digests and timestamps, not raw provider payloads.
Record account, endpoint, server version, SDK version, actual client ID, probe
UUID, operation/nonce/session/phase, request dispatch times, both end markers,
ready/completed/closed times and `transportClosed:true`. The backend derives
`flat` only from complete callbacks. Preserve sanitized original error name,
code and message, with unavailable fields remaining unavailable. Only the
existing explicit harmless farm-status codes may be ignored; connectivity/data
loss and unknown errors invalidate the probe. Never reconnect or resend.

## Versioning, audit and coordination provenance

Add explicit V2 discriminants to operation/evidence/request/receipt schemas and
method `API_OBSERVED_LOCAL_TWS_RESET_V2`. Continue parsing historical V1 records
and supporting their unchanged manual-evidence path. Do not reinterpret existing
V1 `operatorEvidence`, method strings, events or receipts as automatic proof.
V2 host witness contains coordination binding and pre-reset proof digest, not
human flat-account attestations or fictional screenshots. Backend-owned probe
evidence must be tied to the same live observer session through finalization;
persisted proof cannot be replayed by a restarted collector.

Private coordination record: version/method, UUID, actual responsible actor,
trusted session authorization reference, source/recorded time, account/endpoint/
settings/deployment binding, and declarations covering no pending manual actions
or untransmitted drafts, no other native/external clients, and no manual actions
or client launches until the operation ends. Separately identify whether each
claim is carried owner authorization, current agent observation, or owner
attestation; a process inventory cannot be relabeled external-client evidence.
Record only genuinely established declarations. Retain 0700/0600/no-symlink
validation; no token, chat transcript, credentials or account logs in artifacts.

Existing explicit coordination authorization persists within its scope. Record
the current session reference and carry it without asking the same permission
again; do not invent a new human observation date. The coordinator must check
that no intervening action invalidated it. If external-client coordination,
untransmitted drafts or Paper-session identity cannot be established from that
authorization plus current reliable evidence, request only the specific missing
fact. A request to start the bot by itself does not assert those facts.

Add one new migration (next unused number, currently 000039; recheck before
authoring), never edit 000038. Extend strict V1/V2 row/method consistency checks,
allowed events and event-state guards for the two pre-probe events. Adjust
status's bounded event count from six to eight; retain unique operation/event
kind, immutable events/receipts, owner fencing and exact CAS checks. Store V2
coordination/probe metadata within the existing operation/events; no general
recovery framework or second owner/lease namespace is needed. Old published
images cannot interpret V2 and must not start during pending V2 maintenance.

## Interrupted probes and recovery from uncertainty

Durable pre-probe dispatch is one-shot across collector restarts. A successor
V2 may perform another probe only when the predecessor has a valid durable
`PRE_RESET_PROBE_CLOSED` with positive native closure (even if its data result
was a failure), or no pre-probe dispatch
ever existed; never infer closure from process absence or missing events.
Traversal of the complete predecessor history must find both unresolved
`PRE_RESET_PROBE_DISPATCH` and `HANDSHAKE_DISPATCH`, across V1 and V2, not merely
inspect the latest operation. Any dispatch without its valid positive-closure
event denies a V2 pre-reset probe. In particular V1 unknown post-reset handshake
followed by V2 supersession cannot reconnect before a new witnessed reset. Unknown
result remains maintenance held; V1 manual-proof/reset is the supported fallback.

There is a supported escape from pre-probe close uncertainty without weakening
the reset prerequisite: the existing V1 manual-proof route. After exact status
and verification that observer/backend have stopped, fresh genuine owner proof
can supersede the V2 operation into V1. Its no-socket-before-reset path proves
flatness manually, then witnesses full TWS reset before opening its single
post-reset handshake; that reset terminates the uncertain probe's old transport.
V1-to-V2 and V2-to-V1 supersession preserve the complete owner tuple and global
maintenance fence. A successful successor reset/commit can retire that owner;
prior dispatch records remain immutable. This exceptional fallback is explicit,
not an automatic second probe or fabricated manual attestation. If genuine
manual proof is unavailable, remain held and report that exact limitation.

A probe with a known closed transport but nonflat/incomplete data remains a
failed recovery attempt. Do not cancel/close exposure automatically. Current
owner-authorized supported reconciliation/close work must resolve it separately.
No silent loop, background retry, budget refund or deletion of safety history.

## Bounded implementation ownership

Critical implementation/integration: `gpt-6-astra` / `high`. Independent plan
review: a different Astra/high agent. Independent final hostile review: an Astra
agent that authored neither this plan nor code; plan and final reviewers differ.
No Luna worker selects protocol semantics. Mechanical checks/publication may
use the routing guide's available equal-or-stronger fallback with disclosure.

Permitted code scope:

- `packages/shared/src/accounting-owner-recovery.ts` and its tests: strict V2
  schemas, versioned limits and hash/identity compatibility.
- `apps/execution-engine/src/accounting/owner-recovery-{transport,store,cli}.ts`
  and their unit/integration tests; a focused adjacent probe test file if needed.
- `tools/paper-verify-stack/src/accounting-owner-recovery-cli.ts` and tests:
  V2 command options, coordination files, explicit pre-reset readiness, status.
  Host module/tests only for protocol-bound socket observation, if required;
  do not broaden native/container exemptions. UI-controller allowlisting is
  outside this package.
- One new migration and relevant isolated migration/consistency tests.
- Recovery runbook, V1 contract addendum linking this V2 contract, and package
  implementation report. Root/workspace scripts only if strictly required for
  existing CLI integration; do not add a parallel executable.

No changes to source acquisition semantics, runtime trading config, unrelated
dirty backtest/signal work, existing SQL migrations or application startup logic.
Escalate API coverage doubt, unsupported client topology, version/guard weakness,
or need for a larger recovery framework before widening scope. Stop if actual
SDK behavior cannot guarantee non-binding read-only requests.

## Acceptance and hostile verification

1. V1 historical parsing/status/receipt behavior unchanged. V2 cannot pass using
   V1 booleans, host-forged snapshots, foreign session results or stale proof.
2. No socket before durable maintenance plus authenticated exact-owner lock.
   No TWS reset readiness before flat pre-proof and positive native close.
   No post-reset handshake before witnessed full reset. The only pre-reset
   socket is the exact audited V2 probe. API call spies and installed
   adapter tests prove no binding/order methods, reconnection or retry.
3. Synthetic complete empty streams succeed; zero positions are accepted only
   with valid identity/quantity and completion. Test missing/early/duplicate end,
   malformed/foreign/absent account, nonfinite quantity, conflicting duplicate,
   nonzero then zero, unbound/manual order ID zero, orderStatus-only indication,
   late event/error, output limit, untransmitted-draft coordination missing,
   unknown server capability, wrong environment and client-ID collision.
4. Test timeout at every phase, transport close without logical disconnect and
   logical disconnect without native close, socket factory/connect exceptions,
   SDK internal socket unavailable, cancellation/EOF, clock drift, DB delay,
   producer restart, config mutation and TWS replacement during a probe.
5. Isolated PG tests cover atomic V2 supersession/maintenance, both versions'
   consistency guards, concurrent owner acquisition, sole-owner constraint,
   duplicate dispatch/replay, expiry, actor/nonce/profile/pause changes and commit
   response loss resolved only by exact operation/request readback.
6. Crash after either pre-probe or post-reset handshake dispatch with no valid
   closed event denies every V2 successor probe; traversal cannot be bypassed
   through intermediate V1/V2 supersessions. Include V1 unknown handshake -> V2
   successor and V2 unknown pre-probe -> V1 superseded without reset -> V2.
   Valid V1 manual fallback can supersede but opens no socket until observed reset.
   Restarting the CLI cannot import a proof or rerun observation in either version.
7. Host fake-command tests and Docker fixture tests preserve Created-container
   support, continuous event watching, exact backend inventory and no ordinary
   application startup. No operational DB fixtures or real broker test sockets.

Run required `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`
against isolated PostgreSQL, `pnpm build`, and a clean Docker build. No strategy
or simulator changes are included, so backtests are not relevant. Independently
review the implementation against this accepted plan and fix all findings.
Report requested/actual models and effort, reviews, repair counts, elapsed time,
available token usage (otherwise unavailable), commands and exit codes.

## Operational prerequisites outside this package

The lead observed native inventory false positives from CUA tool workers whose
arguments contained the repository root. Closing the CUA session using its
supported reset lifecycle made standalone native preflight pass while TWS
remained alive. Therefore close CUA before observe and do not reopen it during
the witness. Recheck actual complete inventory at execution time. No native
classifier change or controller allowlist is included. Do not suppress failure
or permit arbitrary Codex/node executables. If another topology blocker remains,
stop and investigate it separately.

API evidence collection does not require CUA. The full reset may be performed by
the owner while the collector observes it if current UI tools cannot control TWS.
Do not make this package depend on unverified screenshot/click capabilities or
promise an automatic restart. If current task authorization includes the reset,
that authorization remains valid; inaccessible controls are a capability gap.
An owner action is needed only if no supported authorized control path works.
With the currently observed CUA limitation, an owner may also need to supply the
post-reset environment-only artifact while the witness runs; do not reopen CUA
inside the witness or substitute a position/open-order attestation for API data.
The pre-reset environment artifact can be collected before closing CUA, provided
it remains fresh and is bound to the same TWS process at probe dispatch.

## Publication, deployment and operational acceptance

Preserve unrelated work; review and stage only this scope. Commit/push main and
verify GitHub CI for that exact commit. Deploy only the reviewed immutable image
with the supported zero-start maintenance procedure, private configuration proof,
backup and existing migration runner. Ensure no old observer/backend remains;
keep owner, pause and maintenance intact. Never restart an incompatible image
against pending V2. Record image ID, source commit, effective configuration hash,
migration and exact CI evidence without secrets.

Operational sequence: exact status of the old expired operation; confirm existing
authorization/coordination and disabled/stopped profile; V2 supersede; one observe;
complete pre-reset API proof and closed socket; authorized witnessed full UI
restart; complete post-reset API proof and closed socket; immutable receipt and
maintenance cleared. Record sanctioned API methods/client IDs and coverage/end
markers, without raw account payloads. If any step fails, follow exact status and
the explicit uncertainty branch above; never repeat automatically.

Receipt acceptance proves only old-owner retirement. Subsequently perform normal
disabled-write startup and full accounting/reconciliation/research gates under
the existing runbooks. Activate the bot only within the owner's actual Paper
authorization when those gates pass. A test pass or successful receipt is not
evidence of broker readiness or a completed Paper round trip.
