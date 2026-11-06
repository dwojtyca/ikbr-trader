# Ingestion recovery after host interruption

Date: 2026-11-06. Status: implementation accepted by independent code review;
local release validation passed, not yet published or deployed.
Baseline: `3677bbf2ccb85ccf96fcdee777fedb3ccb3962d7`.

## Scope

The [accepted plan](SLEEP_WAKE_RECOVERY_PLAN.md) extends ingestion recovery after
host suspension or an unresponsive read connection. It separates transport
liveness from session/data readiness, preserves historical pacing and manual
stop, and fences retired transport results. Execution, strategy, research
provider acquisition and order-submission semantics are outside this package.

## Implemented behavior

The existing controller detects scheduling gaps of at least 30 seconds and
clock anomalies, including from asynchronous continuations before an overdue
watchdog executes. Idle connected sessions receive a current-time probe at most
once per 30 seconds with a 15-second deadline. A positive integer reply is only
socket-liveness evidence. Warmup and session readiness remain separate.

The stable TWS client replaces retired IB emitters, aborts outstanding reads and
pacing waits, and retains allocated request IDs and charged historical requests.
The installed ib 0.2.9 transport is physically retired rather than relying only
on its queued public disconnect. Late callbacks and expired responses cannot
establish successor readiness. The new shared `ReadRecoverySession` is consumed
by production startup and the integration fixture; it orders pause, invalidation,
storage drain, connection, probe, preparation and subscription publication.

Native refresh and schedules preserve their existing readiness/pacing policy.
Generation checks fence suspended work around awaited boundaries. Serialized
market-state publication prevents an old admitted Redis write overwriting a
successor. Storage work already admitted is awaited, not falsely declared
cancelled; unresolved drain is observable with unavailable timestamps represented
as null. Durable stop and execution entry pause are not automatically cleared.

Intentional existing-test updates assert that ticks from a retired transport are
suppressed and schedule invalidation preserves its existing acquisition cooldown.
No strategy condition or stale-data acceptance rule was relaxed.

## Evidence before implementation

After the owner's TWS restart on November 6, execution reconciled successfully
while ingestion reported disconnected and strategy evaluations lacked context.
Restarting ingestion restored native history and a natural PKO `NO_SIGNAL`
evaluation at 10:00:46 UTC. After another reported host sleep, invoking the
existing start procedure restored data readiness and a PKO evaluation at
10:47:15 UTC. At 11:04 UTC PKO again lacked the expected current-session minute.
These observations demonstrate the operational symptom and temporary recovery,
not a proven single cause for every occurrence or acceptance of this new code.

## Review and routing

- Plan author and critical implementation: `wake_recovery_plan`, requested
  `gpt-6-astra` / high; actual model telemetry unavailable to the lead.
- Independent critical plan reviewer: `wake_recovery_plan_review`, reported
  requested/actual `gpt-6-astra` / high. Accepted after one substantive repair
  round and a permitted-file clarification.
- Plan review resolved physical adapter retirement, no-request-ID response
  isolation, buffered event ordering, preserved pacing, honest storage-drain
  limitations, response validation and removal of stale-data reconnect loops.
- Independent implementation review: `wake_recovery_final_review`, requested
  `gpt-6-astra` / high; code, targeted verification and final report accepted after verification
  of the results below. Repairs addressed expired read callbacks arriving before
  timeout callbacks; schedule dispatch after invalidation at both initial and
  generation-write awaits; bootstrap/probe continuations before the watchdog;
  real production ordering shared with the fixture; native publication races;
  and honest invalid-clock/drain diagnostics. No unresolved code findings.
- Lead authored controller/publication regression tests and the runbook update.
- Agent token usage and exact per-agent elapsed times: unavailable.

## Validation and release

Final-source ingestion suite: 203 tests, 198 passed, zero failed, five database tests
skipped without `TEST_POSTGRES_URL`. Ingestion typecheck and scoped ESLint passed.
Lead controller wake tests: eight passed, including both before-watchdog
continuation regressions. Independent reviewer focused run: 48 tests passed,
zero failures. Full local release checks are recorded below.

The combined PKO/AAPL fixture uses real controller, TWS wrapper, session refresh,
shared production recovery sequencing and unchanged readiness evaluator with
fake IB and in-memory persistence. It proves recovery of current-session native
1m evaluation evidence for both instruments without a disconnect event. Higher
timeframes deliberately remain unavailable in that fixture: it does not claim a
full strategy evaluation, actual laptop suspension, paid research or a trade.

Validation used a clean baseline export with only the 20 reviewed package files;
25 unrelated local files were excluded and their baseline hashes still match.

- `pnpm lint`: exit 0; two pre-existing unused ESLint-disable warnings.
- `pnpm typecheck`: exit 0.
- `pnpm test`: exit 0; 4,081 passed, 420 database-dependent skips, zero failures.
  The final run serialized workspaces with `npm_config_workspace_concurrency=1`.
- `pnpm build`: exit 0.
- Clean Docker build (`--no-cache`): exit 0 on final runtime source.
- `pnpm test:integration`: exit 0; 3,310 passed, zero skipped, zero failures,
  using isolated PostgreSQL 16 and the final clean Docker image.

An earlier concurrent unit run failed the unchanged 150 ms HTTP timeout test
before its localhost server observed the request. Its isolated rerun passed all
15 tests and the complete serialized rerun passed; no test or deadline was changed.
A sandbox-only targeted attempt could not bind localhost (`EPERM`); the permitted
rerun above supplied the required local-server capability. The first integration
attempt used a host address rejected by the existing isolation guard. It was
replaced with the accepted CI profile (`CI=true`, loopback port 5432,
`ikbr_trader_ci`) in the dedicated test database container's network namespace.
No operational database was used and no isolation check was weakened.

Publication, exact-commit CI and deployment remain pending at this pre-publication snapshot. Operational receipts will be retained
privately alongside the deployment image and exact-commit CI result.

The 25 pre-existing unrelated modified/untracked files have baseline hashes in
the private validation directory. Their content is excluded from this package.
No strategy or simulator change is authorized, so no new strategy backtest is
required. The fake-clock interruption simulation passed as described above. Deployed
transport-interruption, actual host-sleep recovery and real trade/soak evidence
remain separate and are not claimed by this report.
