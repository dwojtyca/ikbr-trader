# Automatic Paper startup and recovery — implementation evidence

Date: 2026-10-28. Status: implementation, hostile runtime review and full local validation passed.
Publication, exact-commit CI and operational rollout remain pending.
Contract: [automatic startup/recovery plan](AUTOMATIC_PAPER_STARTUP_RECOVERY_PLAN.md).

## Outcome and causes

The package implements automatic startup and recovery for continuous Paper
PKO/AAPL, one whole share/open position per instrument, existing USD5/day AI budget.
Routine TWS resets and recurring manual accounting qualification are replaced by
API evidence and automatic source recovery. Unknown order submissions, deterministic
risk, operator pause, audit history and charged research budgets remain protected.

| Blocker | Provenance and automatic handling |
| --- | --- |
| Durable ACTIVE owner after database loss | Source ownership introduced in `7df517d` (2026-10-18); acknowledged release improved in `28f87fe`; manual observed-reset recovery added in `4328079`. After the actual session advisory lock becomes available, record a new fenced generation and immutable handover. Do not claim the old physical socket is dead. |
| Execution API unavailable during source failure | Startup awaited accounting initialization. Initialize the source independently after schema startup and retain HTTP diagnostics. Before schema availability, retry database initialization with bounded backoff and logs. |
| Missing account after initial source failure | The first asynchronous integration draft could attempt session hydration before its source owner was ready, then leave the scheduler without an account. A bounded singleflight loop now confirms the account and connection generation, retries automatically and rejects stale callbacks. This defect was found and repaired during the actual runtime drill. |
| Process exit on checked-out PostgreSQL client error | A pool idle-error listener does not cover checked-out clients. Permanent per-client listeners preserve original errors; transaction failures remain failures and synchronous sends reject known failed clients. |
| Three-attempt/manual clock recovery policy | Preserve episode history, leases, hourly limits and backoff while allowing continued automatic recovery through a fresh source. The continuous deployment explicitly requires `EXECUTION_ACCOUNTING_AUTO_CLOCK_RECOVERY_ENABLED=true`. |
| Expired manual accounting qualification | The installed legacy SDK lacked modern configuration and parameterized replay. A pinned official SDK establishes these capabilities automatically, with generation-bound qualifications and explicit timestamp provenance. |
| Unknown WSH read cleanup | Preserve unknown outcomes and charges, retire stale publication authority, and admit only a new legal regular slot. Handle STARTED attempts that failed before acquiring an endpoint without inventing a successful connection or a charge. |
| Interrupted manual recovery maintenance | Immutable dispositions supersede exact legacy operations and fence late finalizers. Do not delete history or manufacture reset evidence. |

The initiating cause of the observed operational PostgreSQL interruption remains
unestablished. Git history identifies implementation provenance, not proof that
the owner requested historical manual policies. These policies are not IBKR
requirements to restart TWS.

## Implementation boundaries

- Existing execution/ingestion sockets remain; the official Python SDK is a
  bounded read-only accounting transport, not an alternative order submission path.
- Source generations, account/settings identities and PostgreSQL locks fence stale
  observations and mutation continuations. Broker sends and database COMMIT are
  not claimed to be atomic: uncertain sends retain durable markers and are never
  replayed merely because a connection failed.
- Automatic source qualification uses protocol/configuration evidence, an explicit
  execution-history window and configured UTC/Europe-Warsaw provenance for naive
  timestamps. Empty replay does not prove an observed historical timestamp format.
- Legacy qualification and recovery receipts remain historical evidence. New WSH
  recovery preserves reservations, original schedule boundaries and all outcomes;
  its WAITING state cannot authorize use of blocked cached research.
- Execution uses direct Node plus Compose init for signal delivery. No new UI,
  host supervisor, Docker socket mount or routine TWS restart is introduced.

See the [accounting contract](AUTOMATIC_ACCOUNTING_CAPABILITY_CONTRACT.md),
[WSH contract](AUTOMATIC_WSH_READ_RECOVERY_CONTRACT.md) and
[operator runbook](../../runbooks/CONTINUOUS_PAPER.md).

## Independent reviews

`automatic_startup_plan_review` (Astra/high) accepted the core plan after one
revision and the separate D/E contracts, including settings-hash rollover with
independent predecessor identity validation. It did not perform final review.

`automatic_recovery_final_review` (Astra/high), independent of all implementation
and plan authors, accepted A–E and the final runtime evidence. Findings repaired:
stale dispatch acknowledgement; inactive acquisition identity reuse; lost database
error cause; shortened clock backoff; checked-out client error events; WSH
pre-acquisition endpoint absence; locked manifest authority race; initial session
hydration deadlock and stale cached account generation. Accepted cancellation scope
retains the existing lifecycle rather than inventing a new ordinary-cancel ledger.

Independent runs passed70 execution/source tests,17 error/fencing tests,91 WSH
PostgreSQL tests and35 hydration/startup/fencing tests. Final WSH authority-race
suite13/13 and LLM preparation suite5/5 were also reviewed. Test-only timing
repairs preserve assertions and production deadlines: controlled clocks replace
20ms wall-clock assumptions; owner fixtures await actual database-scoped advisory
lock disappearance instead of assuming TCP teardown is instantaneous.

## Validation

| Check | Result |
| --- | --- |
| Scoped lint | Pass; two pre-existing unused eslint-disable warnings |
| Scoped TypeScript check | Pass |
| Scoped full unit suite | 4,351 tests:3,980 pass,371 skipped,0 failures; skipped database cases are exercised separately |
| Full integration | Pass: 3,216/3,216, zero skips, isolated PostgreSQL; includes real backend termination and durable unknown-send fixtures |
| Build | Pass |
| Clean scoped Docker build | Pass, including pinned official SDK installation and Python6/6 tests |
| Real read-only accounting probe | Pass on existing TWS protocol226, master0, explicit replay and matching end; no broker writes |
| UI-off runtime failure drills | Pass; see below |
| Final source publication / exact-commit CI | Pending |

Validation archives contain HEAD plus an explicit reviewed file allowlist. Unrelated
ES/backtest and signal-engine edits, and the superseded owner-deadline UX patch,
are excluded. No destructive integration fixtures used the operational database.
No strategy/simulator behavior was changed, so no new strategy backtest was needed.

## Actual runtime evidence

The production SDK bridge/collector read-only probe confirmed protocol226 and
master0 before and after an explicit history replay. Requested lower bound:
2026-10-26T12:56:49.000Z; covered-through:2026-10-28T12:56:49.807Z. Matching end,
zero executions/fees, confirmed transport closure, process exit0. This is scoped
capability evidence, not proof of a historical fill timestamp or cross-client fill.

The final runtime drill used image
`sha256:675ef203687ba82a6cf91752747498c9a094480d37f8b3187e889388847c4029`,
with writes, lifecycle automation, AI and WSH disabled, durable entry pause enabled,
and automatic clock recovery enabled. Only execution, an isolated tmpfs PostgreSQL
and a TCP proxy ran; UI and other producers were stopped. Later code changes were
reviewed test-only determinism repairs, not runtime behavior changes.

1. Start without a database: bounded retry logs, no broker traffic before schema
   initialization. When the database appeared, the same process automatically
   confirmed the account, qualified the source and produced a complete CLEAN snapshot.
2. Stop/start only the isolated database process, retaining data: health/source/
   diagnostics remained HTTP200; reconciliation correctly returned503 during the
   outage. Recovery produced a fresh qualification/capture and owner generation1→2.
3. SIGKILL execution: durable owner2 remained ACTIVE. Normal startup automatically
   acquired owner3 and restored fresh complete CLEAN reconciliation.
4. Interrupt/restore the broker proxy: source evidence became unavailable while
   HTTP diagnostics remained available; restoration automatically produced fresh
   qualification/capture and complete CLEAN reconciliation. TWS was never restarted.

Independent checkpoint comparison verified retention of every prior immutable
hash and unchanged pause revision1. Qualification count advanced1→2→3→4. The real
account was flat; preservation of nonzero unknown-write and budget evidence is
covered by separate production-wired PostgreSQL fixtures, not claimed from this
flat runtime exercise. HTTP was measured inside the execution container.

Private receipts are preserved under
`.local/paper-runtime/research-diagnostics-20261028/automatic-recovery-drill/`.
An earlier disposable database with an obsolete development migration42 checksum
was recreated; no applied checksum was edited. Isolated execution/proxy were
stopped after testing to release client0. No operational DB, broker-order or
provider writes occurred in these drills.

## Remaining limits and release tracking

An unavailable broker/login, missing permissions or unresolved financial state
can prevent trading; observation/retry continues without inventing success. An
old endpoint below protocol219 is rejected safely, but currently reports a generic
SDK_PROTOCOL_INVALID/source gap rather than a dedicated capability state. Runtime
status does not yet expose every proposed diagnostic field, including last-success
capture time. Tested endpoint226 does not establish older-version support.

Deployment requires a fresh backup, verified immutable image/private profile,
clock-recovery flag enabled, actual Paper reconciliation and the existing guarded
`pnpm start` flow. Source tests and drills alone do not claim activated trading,
a completed Paper trade, or long-duration soak acceptance. Operational rollout
receipts remain private; exact-commit CI must be verified before rollout.

Requested routes: Astra/high for critical architecture, integration, capability
work and independent reviews; the lead integrated parsers, presentation, fixtures
and documentation. Model capacity interruptions resumed on the same requested
routes; no weaker reviewer was substituted. Reported model configuration matches
the requested route; independent provider telemetry, token usage and per-task
elapsed time are unavailable. Repair findings and evidence are listed above;
no cost-saving or model-quality claim is made.
