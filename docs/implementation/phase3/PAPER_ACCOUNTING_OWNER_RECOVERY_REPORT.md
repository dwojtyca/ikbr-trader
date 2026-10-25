# Accounting owner recovery implementation report

Date: 2026-10-25. Status: implementation accepted; local release validation passed. Publication/CI and operational evidence are separate gates.

## Scope

Implements Package B selected by the owner, under the accepted
[recovery contract](PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md) and
[staged plan](PAPER_ACCOUNTING_SHUTDOWN_RECOVERY_PLAN.md). The change supplies an
offline recovery path for `ACCOUNTING_SOURCE_OWNER_UNRETIRED`; orderly whole-stack
shutdown (Package A) and other accounting/research recovery are outside scope.

The normal owner keeps its original canonical endpoint and advisory lock. A
transactional global maintenance fence covers alternate endpoint aliases during
recovery. The offline protocol binds the stranded owner, paused account, private
settings, image/deployment, operator evidence and observed TWS reset. A single
live observer performs one read-only client-0 handshake and requires native socket
closure before atomically retiring the exact old owner with an immutable receipt.
No detached commit, automatic takeover, unknown broker retry or direct order path
is added.

Recovery leaves qualifications, accounting holds/replay gaps, observations,
clock/research attempts, budgets and entry controls unchanged. Existing ordinary
startup alone creates the next generation and must pass all existing gates.

## Supported limits

This implementation is restricted to local macOS Docker Desktop and native TWS,
one explicit allowed Paper account, master writes disabled, durable pause and
stopped application producers. It requires account-wide flat/no-open-order
operator evidence, including private artifact integrity. It cannot interpret
screenshots as independent broker facts. Native process evidence consists of
bounded snapshots plus the trusted operator's no-other-client/no-launch
attestation; it is not continuous proof against arbitrary hostile software.

The offline subset rejects any bot submission history for the account or unbound
historical attempts, including apparently completed ones. This avoids claiming
offline lifecycle adjudication. It also rejects reservations and uncertain
operations. No history may be deleted to fit this supported subset.

Container self-checks verify runtime environment, source-settings bytes, account,
token and canonical DNS. The verified host collector supplies image/deployment
and physical host authority through the exact expected private child profile;
the container does not independently attest its image or inspect the macOS host.

## Operational state

No operational recovery, TWS reset, provider call, order submission or bot start
was performed for this implementation. Tests use synthetic accounts, injected
host/transport fixtures and isolated PostgreSQL at localhost port 55438. During the original implementation, the operational PostgreSQL and bot containers remained stopped. On October 23 the lead started Docker and operational PostgreSQL/Redis for read-only diagnostics; application containers remained stopped. These infrastructure actions did not apply recovery. No private account
evidence or secrets are included in this report or publication.

Delivering the source does not establish that the current account meets the
supported recovery subset. Applying it requires a separate authorized deployment
and observed procedure. Known independent qualification, clock and research
holds are not resolved by this package.

## Review and validation record

The independent plan reviewer accepted after one repair round: initial proof UUID
sequencing, physical alias fencing and native evidence boundaries were corrected.
No extra lifecycle/AI/loop configuration changes are required by recovery.

Baseline lint and typecheck passed. The initial baseline test run in the default
sandbox failed only where existing tests attempted local TCP listeners (`EPERM`);
network fixture tests run with the required local execution permission.

Focused transport tests: 15 passed, including the installed `@stoqey/ib` 1.6.10
against a fake TCP peer. Observed outbound frames were limited to protocol startup
and optional managed-account request. Tests reject wrong/multiple accounts,
missing protocol evidence, time drift, timeout, aborted handshake and missing
native-close acknowledgement; late callbacks cannot revive the attempt.

Shared contract validation: build/typecheck passed; focused strict-parser tests
7 passed; existing shared suite 774 total, 684 passed, 90 PostgreSQL tests skipped
without an integration URL. Full PostgreSQL validation remains separately required.

The original October 19 validation left full checks, Docker build, hostile review
and publication pending. The completion record below supersedes that historical
validation status; exact-commit CI is verified after publication.

## Agent routing

| Responsibility | Requested model / effort | Outcome |
| --- | --- | --- |
| Contract, shared wire, SQL/store/owner fencing (`owner_contract`) | gpt-6-astra / high | In progress |
| Independent plan review (`owner_plan_review2`) | gpt-6-astra / high | Accepted, one repair round |
| Host collector and operator CLI (`owner_host_impl`) | gpt-6-astra / high | In progress |
| Offline backend CLI (`owner_backend_cli`) | gpt-6-astra / high | In progress |
| Transport, integration, documentation, publication (lead) | inherited lead | In progress |
| Independent implementation review | gpt-6-astra / high | Pending, different from plan reviewer and implementers |

Actual per-agent model/effort telemetry, token usage and precise per-agent elapsed
time are unavailable. No zero-usage or savings claim is made. Implementation
repairs and escalations will be recorded with the final review result.


## Completion work — 2026-10-25

The owner explicitly requested completion and startup. This carries operational
Paper authorization forward, but does not supply missing broker-state/settings
attestations or authorize automation of the IBKR UI.

Independent hostile review (`owner_hostile_review`, gpt-6-astra/high) found three
issues: incoherent observer-ready timing evidence (P1), rejection of the actual
Docker Compose v2 plugin as an unknown native producer (P1), and failure to display
status when a saved request has no durable event (P2). Repairs preserve the original
operation deadline, bind the exact spawned Docker/plugin process identity, and
report missing request outcomes as UNKNOWN without relaxing receipt readback.
The migration conversion fixture now strictly expects migration 38 too.

Validation first found the same CLI fixture incompatibilities and one migration
expectation. Host loopback tests require local execution permission. Historical
PG guards intentionally accept different test ports, so full integration runs
with CI=true and localhost:5432/ikbr_trader_ci inside the isolated PostgreSQL
container network; this does not refer to the host operational localhost:5432.
The dedicated test container/volume were inspected before use. No isolation guard
was weakened. Clean release context excludes unrelated local ES/backtest/signal
changes and includes only the reviewed owner-recovery package.

Final checks, reviewer reacceptance, release commit/CI, deployment and operational
recovery evidence will be recorded separately below. Initial passes/failures are
not final acceptance. Test logs remain under /private/tmp for this local session;
no private profile, account artifacts or credentials enter Git.


### Final review and validation evidence

- Independent hostile review: `owner_hostile_review`, requested gpt-6-astra/high,
  ACCEPT after all three findings were repaired. The reviewer authored no changes.
- Repair worker: `owner_repairs`, requested gpt-6-astra/high; three findings repaired
  in one round each, no relaxed predicates or broadened broker capability. The
  lead updated the strict migration-list fixture for version 38.
- Mechanical validation: `owner_validation`, requested gpt-5.6-luna/low; no source
  edits. Environmental failures were diagnosed by the lead, not repaired by
  weakening test isolation. Actual model/effort telemetry, token usage and total
  per-agent elapsed time are unavailable; no efficiency claim is made.
- Final clean-context lint, typecheck and build: PASS. Two pre-existing unused
  eslint-disable warnings remain, without errors.
- Final complete `pnpm test` in the clean host release directory: PASS (exit 0).
  The production image intentionally has no Docker CLI; its two existing Compose
  rendering tests therefore need the host. The host run used the repository's
  pinned pnpm through Corepack, Node 24 and an explicit Docker CLI path.
- Real isolated Docker fake TCP fixture and real Compose v2/native-process
  regression: PASS. Both use network-disabled synthetic processes, no broker.
- Clean `docker build --no-cache`: PASS. The accepted code candidate image is
  `sha256:b7a2e38edd213552c6274dc751247514df059d1e79db114faf9e103e672f25eb`.
  Final publication metadata/document changes may produce a distinct deployment
  image; record its exact ID in the private deployment receipt.
- Full `pnpm test:integration`: PASS, exit 0, 297.62 seconds, against isolated
  PostgreSQL in the dedicated container network. No operational fixtures were used.

The operational predeployment backup was created privately on October 25; readonly
checks still found owner ACTIVE/generation 1, durable pause revision 53 and zero
local broker-submission attempts. Migration 38 was not yet applied at this check.
The configured host API port 7497 had no listening process at inspection. No
claim is made about account flatness; current TWS evidence is still required.
