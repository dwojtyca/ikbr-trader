# Paper accounting: reliable shutdown and stranded-owner recovery

Date: 2026-10-19. Status: ACCEPTED as a staged plan by independent Astra/high plan review;
final document review corrected release-acknowledgement wording. Package B still
requires a frozen implementation contract and its own review before code.
Owner request: prepare a correction plan, not implement or activate trading.
Baseline: `28f87fe` and the local Paper image `729919d7ac67…`.

## Outcome and boundary

An orderly stop must close the accounting transport and durably retire its exact
owner before PostgreSQL stops. A later start must succeed without a manual reset.
If the process died without retirement, a separate audited, disabled-Paper recovery
must establish that the old transport cannot survive or reconnect before releasing
that specific ownership fence. Ordinary startup never takes over ACTIVE/UNKNOWN.

This plan extends the existing [release contract](PAPER_STARTUP_ACCOUNTING_RELEASE_CONTRACT.md)
without weakening its normal lock-release acknowledgement. It fits the
[current roadmap](../ROADMAP.md) and [continuous Paper runbook](../../runbooks/CONTINUOUS_PAPER.md).
It does not redesign the execution, signal or research services.

Out of scope: new strategies, order submission, forced signals, automatic clearing
of WSH/Marketaux uncertainty, renewed TWS qualification without operator evidence,
resetting attempts/budgets, Live, UI, and unrelated local ES diagnostic changes.
Clock recovery and research recovery remain separate capabilities. Successful
owner recovery alone is not permission to trade or proof of accounting coverage.

## Observed evidence versus hypotheses

On 19 October the stack was stopped with `docker compose stop -t 45`. The next
start repeatedly failed with `ACCOUNTING_SOURCE_OWNER_UNRETIRED`. A read-only query
showed owner generation 1, state ACTIVE, acquired at 09:41:10 UTC, no retirement.
Execution logs contain termination by SIGTERM. The exact reason retirement was
not persisted is not yet proven. Do not label PostgreSQL stop ordering or pnpm
signal forwarding as the proven cause solely from these facts.

Confirmed source defects and constraints:

- `index.ts` awaits recovery coordinator, observer, alerts and reconciliation stop
  serially before accounting close. A rejection in an earlier step skips close.
- Its finally block calls `process.exit(0)` even when shutdown failed.
- Accounting close needs PostgreSQL after transport retirement to persist the
  exact owner's retirement. Database-session disappearance is not transport proof.
- Owner acquire replaces only RETIRED, correctly rejecting ACTIVE and UNKNOWN.
- Owner acquisition happens before HTTP readiness/routes. Existing HTTP
  recover-clock/qualification cannot repair a stranded owner preventing startup.
- Compose starts execution through pnpm. The actual container signal path and
  shutdown ordering need an isolated reproduction, including process descendants.

Before implementation, preserve sanitized timestamps, container lifecycle events
where available, shutdown logs and relevant source hashes. Missing historical
logs remain missing. Reproduce with isolated PostgreSQL and fake broker transport;
never kill operational PostgreSQL to reproduce the incident.

## Package A — orderly shutdown, independently releasable

1. Establish one idempotent shutdown promise, created synchronously on first
   SIGTERM/SIGINT. Repeated signals must not start parallel cleanup, release twice,
   revive work, or report success prematurely.
2. Fence new entry work immediately. Stop producers and acquisition scheduling;
   stop/drain accounting recovery and reconciliation work before closing their
   transport. Record each stage and its sanitized original cause independently.
   A failure in unrelated observer/alert shutdown must not skip accounting cleanup.
3. Bound the entire application shutdown by one monotonic deadline (30 seconds),
   within the container stop grace (45 seconds). Stage budgets consume the original
   deadline, never restart it. Reserve time for transport retirement, audit flush
   and owner retirement/release. If an accounting user cannot be quiesced, revoke
   its local capabilities and close transport; do not assert orderly retirement
   without the collector's existing positive acknowledgement and durable proof.
   Late work cannot write new owner state or reconnect after the shutdown fence.
4. Keep existing transport retirement -> persistence drain -> durable exact-owner
   retirement -> acknowledged advisory unlock semantics. Cleanup failures must
   not fabricate RETIRED. Failed/unknown transport closure retains the hold.
   Review collector.retire() throw paths as well as its false acknowledgement;
   release resources even when it throws, without claiming successful retirement.
5. Close database pools only after attempted accounting cleanup and its outcome
   are known. Exit 0 only after required cleanup succeeds. Any critical timeout,
   retirement/persistence failure or unknown acknowledgement exits nonzero and
   emits a distinct shutdown-incomplete diagnostic. Preserve original cause safely.
6. Validate signal delivery to the actual Node process using the production image.
   Prefer a direct Node command and init/reaping only if reproduction proves the
   current wrapper cannot honour the contract. No blanket command rewrites.
7. Add an explicit full-stop operator command separate from existing entry-only
   `pnpm stop`. It pauses/stops producers, verifies fresh broker flat/no orders
   and no unresolved local broker operations, stops execution/ingestion, confirms
   shutdown and retirement, then stops PostgreSQL/Redis. If proof fails, leave
   database and required supervision available, report the blocker and do not
   claim full-stop success. Existing `pnpm stop` semantics remain unchanged.
   For nonflat exposure require coordinated existing close/management procedure;
   the full-stop command never closes or cancels orders itself.
8. Compose dependencies/grace and documentation must make the database lifetime
   requirement explicit. Direct Docker stop/crash remains possible and must fail
   closed; do not promise recovery from SIGKILL as an orderly shutdown.

## Package B — explicit recovery of an already stranded owner

Requires a separately frozen implementation contract and independent Astra review
before code. This section sets mandatory acceptance constraints; unresolved proof
or schema choices block B, not A. Reuse host collection and challenge conventions
from [research recovery](PAPER_STARTUP_RESEARCH_RECOVERY_CONTRACT.md), not its WSH
receipt or client identity. Do not pretend the existing WSH protocol proves client 0.

### Authority and evidence

Provide a local one-shot recovery tool because execution HTTP is unavailable.
It must validate the pinned deployment, explicit Paper environment, single allowed
account, master writes disabled, durable/startup entry pause policy, exact settings
hash and canonical endpoint/client 0. It must not open execution/order writers.
Reject Live, remote/proxy endpoints and unrecognized deployment topologies.

Inventory all processes/containers capable of acquiring this accounting endpoint,
record their immutable identities, and verify they are stopped before, throughout
and after recovery. An effective maintenance fence shared with normal acquire must
prevent replacement writers. Do not equate a missing DB session, lease expiry,
PID absence, API disconnection or a free advisory lock with retired broker transport.

For the initial supported local macOS + Docker + TWS topology, require a positively
observed whole TWS process/listener termination and replacement while all relevant
clients are quiescent. An operator performs UI actions; the agent never automates
IBKR UI. Capture old/new process identity and observed listener absence, bind to the
same canonical endpoint and deployment. A restart performed before observation
cannot retroactively become evidence. Coordinate all other broker clients and
exposure before interrupting TWS; unavailable account state blocks the procedure.
The contract must specify how fresh independent account/position/order evidence is
obtained without the unavailable execution API, or explicitly require verified
operator evidence with exact provenance; never infer flat from old local rows.

A bounded read-only client-0 handshake may verify endpoint/account/protocol and
positive closure of its own socket only after the old endpoint reset is proven.
It is not evidence of old-session closure by itself. No order/provider/history
requests, no new source qualification, no broker retries after uncertain outcomes.

### Durable protocol

Use PREPARED -> OBSERVED -> COMMITTED, with immutable operation UUIDs, exact
endpoint/ownerId/generation/settings/deployment/account binding, evidence digest,
actor, observation times and receipt. Proposed validity: 15 minutes, checked using
monotonic and database time with conservative rejection on drift. Expiry must not
silently remove maintenance or grant takeover. Define audited supersession/abort
and recovery after tool crash without lifting a hold on insufficient evidence.

Acquire the existing canonical endpoint advisory lock for prepare/commit and bind
normal acquire to the maintenance fence. Revalidate stopped producers and endpoint
identity immediately before commit. Compare-and-swap only the captured stranded
owner tuple. Concurrent acquisition, changed generation/settings, invalid evidence,
unknown producer or missing lock denies commit. Do not force-unlock another session.

Commit receipt and exact owner retirement atomically; retain original owner identity,
state and reason in immutable recovery history. No deletes or direct admin resets.
An uncertain commit is resolved only by exact operation/receipt readback; never
resubmit a possibly executed mutation. An uncertain transport or missing readback
remains a visible hold. Fresh application initialization subsequently performs
ordinary acquire and gets its own new generation; recovery grants no live owner.

Keep all accounting holds, qualification expiry, observations, commissions,
clock episodes/attempt budgets and research uncertainty unchanged. No alias or
endpoint spelling change may bypass the maintenance/owner fence. Rollback to an
older writer unaware of maintenance is unsupported while recovery is pending.

## File scope and task routing

A: execution `index.ts`, focused shutdown module/tests if extraction is justified,
accounting `source-service.ts`, `source-owner.ts`/collector only for reviewed cleanup
requirements, relevant integration tests; Docker Compose; paper-runtime operator
full-stop code/tests; accounting and headless runbooks. Preserve shared API contracts.

B: accounting owner recovery service/store/CLI/types/schema, a versioned migration
(next available number checked at implementation time), shared acquire maintenance
checks, bounded host collector in paper-verify-stack, tests and runbooks. Freeze exact
schemas, error codes, lock ordering, offline evidence path and files before coding.
Reuse existing ownership helpers; do not add an independent competing lock system.

Astra/high owns critical contracts, implementation and integration. Bounded pure
formatting helpers may go to Luna/medium only under the accepted contract. Separate
Astra/high agents review plan and final implementation; neither reviews authored
work. Mechanical scoped publication/checks may use the routing guide's available
route. Workers receive exact files, invariants, commands and stop conditions.

## Acceptance and hostile validation

A must prove actual container SIGTERM reaches Node, stop under idle and in-flight
work, immediate normal restart after acknowledged retirement, repeated signals,
upstream stop rejection, collector rejection/false ack, unavailable PostgreSQL,
late async completions, stalled flush, deadline exhaustion and SIGKILL. Unknown transport retirement remains ACTIVE/UNKNOWN and denies acquisition.
A lost advisory-unlock acknowledgement fails shutdown and cannot prove orderly
handoff, but preserves an already proven durable RETIRED state; a later ordinary
acquire still requires the actual advisory lock. No error is relabelled as success.
Full-stop must keep PostgreSQL available through cleanup and refuse stale/nonflat/
incomplete broker proof without stopping necessary supervision. Confirm no orders.

B must prove refusal for live/wrong account/client/endpoint/config, ACTIVE competing
owner, concurrent prepare/commit/acquire, old receipts, PID reuse, unobserved restart,
endpoint rebinding, producer restart, changed owner generation, absent/expired proof,
clock drift, lost commit acknowledgement, DB outage, tool/process crash, duplicate
operation, and interrupted handshake. Test shared aliases and advisory lock ordering.
Prove at most one retirement receipt, unchanged budgets/holds/qualification, fresh
ordinary generation after commit and denial of unsafe admission until replay passes.
Use deterministic fake broker transports and isolated PostgreSQL, never operational
fixtures or paid providers. Include real Docker process-tree/signal tests with fake
broker endpoints and synthetic accounts, preserving the same command/grace settings.

For runtime implementation: independent hostile review plus `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration` against isolated PostgreSQL,
`pnpm build`, and clean Docker build. No strategy/simulator behavior changes are
planned, so backtests are required only if scope changes into those areas.
Publish only reviewed files on main and verify GitHub CI for the exact commit.
Record requested/actual models, review findings/repairs, elapsed time and available
token usage (unavailable is not zero). Failure/access limits are not acceptance.

## Deployment and remaining operational gates

Back up database and private profile, record image/source/config identities. Deploy
with master=false and producers stopped. Verify migration compatibility before
starting any writer. Apply B only with its proven evidence, then start accounting,
obtain fresh replay/reconciliation and verify expected owner generation/health.
Exercise A against the real disabled stack only after flat/no-order proof and
preserve PostgreSQL until shutdown completion. Keep an audit report; never undo
newer recovery history via backup restore or incompatible rollback.

Remaining blockers must be reported separately: expired TWS settings qualification
requires current operator evidence; automatic clock recovery needs its explicit
opt-in and existing eligibility; legacy WSH/Marketaux need their own supported
recovery. Owner repair does not promise automatic resolution of these gates.
Resume entries only after all existing risk/research/AI/account/session/alert gates
pass and current owner authorization applies. This planning request authorizes no
operational restart, provider call, broker action or trading activation.

## Plan-only delivery

Validate local links, factual source references and scoped diff; no runtime tests
for prose. Obtain independent plan review and a different independent final document
review. Commit/push this document only, verify exact-commit CI where accessible,
and explicitly report unavailable access. Implementation and deployment remain
future tasks after the owner selects this plan.

## Review record — 2026-10-19

- Independent plan reviewer: `shutdown_plan_review`, requested `gpt-6-astra`/high;
  ACCEPT as a staged plan, no blocking finding.
- Independent document reviewer: `shutdown_doc_review`, requested `gpt-6-astra`/high;
  corrected ambiguous RETIRED wording to preserve the existing release contract.
  One document repair; no runtime changes or escalation.
- Actual runtime model/effort telemetry and token usage: unavailable. Elapsed review
  timing is not instrumented. Source assertions and all four local links checked.
- Publication/CI evidence will be reported in the delivery message; local validation
  does not attest CI or authorize implementation/trading.
