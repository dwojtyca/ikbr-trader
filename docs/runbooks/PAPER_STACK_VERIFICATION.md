# Paper stack verification runbook

> Introduced with PR15.1. Operates the read-only,
> allowlist-bound `paper:verify-stack` tool. **The tool does
> not activate any instrument and does not submit orders.**

## Prerequisites

- Docker + Docker Compose installed.
- Repository checked out, `.env` populated from `.env.example`.
- `.env` must set:
  - `IBKR_ENVIRONMENT=paper`
  - `TRADING_ENABLED=false`
  - `EXECUTION_API_TOKEN=<≥32 chars>` (or export
    `PAPER_VERIFY_EXECUTION_TOKEN` in your shell).
  - `TRADING_LOOP_ENABLED=false` (default).
- Node ≥ 20 (see `package.json engines`).
- IB Gateway running in **paper** mode on `127.0.0.1:4002`
  (or the ingestion / execution services will be UNREACHABLE
  against the broker).

## Boot the stack

```bash
docker compose up -d postgres redis ingestion signal-engine execution-engine
```

Wait ~10 s for `execution-engine` to run migrations. `pnpm install
--frozen-lockfile` may be required after pulling the branch
because PR15.1 added `tools/*` to the workspace globs.

## Run the verifier

```bash
pnpm paper:verify-stack           # human-readable table
```

For **machine-readable JSON** on stdout, bypass `pnpm run`
(which prepends its own script banner and can add trailing
lines) and invoke Node directly:

```bash
node --import tsx tools/paper-verify-stack/src/index.ts --json
```

`stdout` contains exactly one JSON document terminated by a
newline. `stderr` is used only for runtime errors and is
guaranteed never to contain the Bearer token. Exit codes are
identical to the table form.

The tool issues **GET** requests only, exclusively to a closed
allowlist of endpoints on `ingestion` (`3101`), `signal-engine`
(`3102`), and `execution-engine` (`3103`). Every rendered string
is passed through an account-ID + Bearer-token redactor.

## Exit codes

| Verdict | Exit | Meaning |
| --- | --- | --- |
| HEALTHY | 0 | Every executed check passed. |
| DISABLED (aggregate) | 0 | Every executed check reported `DISABLED` (only reachable when every expected component is configured `absent`; the base ingestion / signal / execution `/health` checks always run in a normal E2E, so a real stack never reaches this verdict). |
| DEGRADED | 40 | At least one informational warning (e.g. kill-switch `enabled=false`, stale 1m candle). |
| UNHEALTHY | 30 | At least one blocking failure. |
| UNREACHABLE | 20 | Transport-level failure (timeout / connection refused / DNS). |
| CONFIG_ERROR | 10 | Env misconfiguration (including **missing Bearer token** — the tool refuses to boot with neither `PAPER_VERIFY_EXECUTION_TOKEN` nor `EXECUTION_API_TOKEN` set) OR Bearer rejected upstream (HTTP 401/403). |

Severity ordering (over active, non-DISABLED checks):
`CONFIG_ERROR > UNREACHABLE > UNHEALTHY > DEGRADED > HEALTHY`.

The Bearer token is **mandatory** (fail-fast). Running the tool
with both `PAPER_VERIFY_EXECUTION_TOKEN` and
`EXECUTION_API_TOKEN` empty exits `10` with
`CONFIG_ERROR: execution_token_missing` **before any HTTP
request is issued**. Zero requests reach any service in that
state; there is no path in which "no token configured" yields
an all-DISABLED / exit-0 result.

## Expectation matrix

Set the three expected-state envs to match the branch you are
operating. The tool refuses to run with any other combination —
`CONFIG_ERROR` is emitted before any HTTP request is issued.

| RUNTIME | EXECUTION_RUNTIME | TRADING_LOOP | Meaning |
| --- | --- | --- | --- |
| `absent` | `absent` | `absent` | Runtime turned off entirely. |
| `registered` | `absent` | `absent` | Runtime registered; execution runtime off. |
| `registered` | `registered` | `enabled` | Full runtime, scheduler running. |
| `registered` | `registered` | `disabled` | Full runtime, scheduler paused (expected on paper before PR15.3). |

Fail-fast reasons (each is emitted verbatim on `CONFIG_ERROR`):

- `execution_runtime_requires_runtime`
- `trading_loop_requires_execution_runtime`
- `trading_loop_endpoints_always_registered_with_execution_runtime`

## Kill-switch cache coupling

`GET /execution/kill-switch` reads from a per-process cache that
is populated only by `GET /execution/account/summary`. On a
freshly booted `execution-engine`, the very first kill-switch
call therefore has `snapshotCacheAgeMs` unpopulated and
`netLiquidation` unset. Two modes:

- **Default (opt-out).** The tool does not call
  `/execution/account/summary`. Missing / stale
  `snapshotCacheAgeMs` under `enabled=true` reports UNHEALTHY
  with reason `kill_switch_cache_unpopulated` and a remediation
  hint.
- **Opt-in.** Set `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true`.
  The tool issues account-summary **first**; only when that
  call reaches HEALTHY does it issue the kill-switch call. Any
  non-HEALTHY account-summary suppresses the kill-switch call
  entirely and records `dependency_failed_account_summary`; the
  aggregate follows the account-summary category (UNREACHABLE /
  CONFIG_ERROR / UNHEALTHY).

Account-summary is opt-in because it triggers broker-side
`ensureBrokerSession` + `syncRecentExecutions`.

Related tuning knobs:

- `PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS` (default `60000`) —
  freshness bound applied to `snapshotCacheAgeMs`.
- `PAPER_VERIFY_LOOP_STARTUP_GRACE_MS` (default `0`) — grace
  window for `running=false` right after the loop starts. No
  implicit grace; set explicitly if needed.

## Interpretation matrix (per check)

| Endpoint | HEALTHY | DEGRADED | UNHEALTHY |
| --- | --- | --- | --- |
| `ingestion.health` | `ok=true`, `connected=true`, `bootstrapped=true`, fresh ticks + candles | — | any of the above missing/false, stale tick > `PAPER_VERIFY_MAX_TICK_AGE_MS` |
| `ingestion.watchlist` | ≥1 subscribed symbol, `marketState.ts` fresh | 1m candle older than `PAPER_VERIFY_MAX_CANDLE_AGE_MS` | empty watchlist, no subscribed symbol, missing `conid` / `marketState`, stale market state |
| `signal.*.health/ready` | `ready=true` and every `checks.*.ok=true` | — | `ready=false`, any dependency `ok=false`, HTTP 503 with parseable body |
| `signal.execute.ready` | `ready=true`, redis / postgres / paperGuard all `ok=true` | — | any of the above `false` |
| `signal.trading_loop.status` | `enabled` matches expectation (see matrix) | — | mismatch, or `enabled=true` + `running=false` beyond startup grace |
| `execution.health` | `ok=true`, `twsConnected=true` | — | any `false` |
| `execution.ready` | `ready=true`, `environment=paper`, `account` non-null, all `checks.*=true`, `reasons` empty | — | any of the above missing |
| `execution.reconciliation.latest` | `stale=false`, `run.snapshotComplete=true` | — | `stale=true`, no run recorded, snapshot incomplete |
| `execution.reconciliation.holds` | no active holds | — | ≥1 active hold |
| `execution.kill_switch` | `enabled=true`, `triggered=false`, `complete=true`, cache fresh | `enabled=false` (protection off) | `triggered=true`, cache missing / stale, incomplete diagnostics |

## Troubleshooting

- **UNREACHABLE across the board.** Verify docker containers are
  running (`docker compose ps`). Check that IB Gateway is up in
  paper mode on `127.0.0.1:4002`.
- **CONFIG_ERROR: url_not_loopback.** URLs default to loopback.
  If you need non-loopback (e.g. running from a container on the
  host network), set `PAPER_VERIFY_ALLOW_NON_LOOPBACK=true`.
- **CONFIG_ERROR on any expected-state combo.** Re-read the
  matrix above. The trading-loop endpoints share a router with
  execution-runtime endpoints — you cannot have execution-runtime
  registered and trading-loop absent (or vice versa).
- **auth_rejected on `execution.ready`.** Bearer token missing or
  wrong. Ensure `EXECUTION_API_TOKEN` (or
  `PAPER_VERIFY_EXECUTION_TOKEN`) matches the value in
  `execution-engine`'s `.env`.
- **Ingestion stale.** Ensure `ingestion` has finished bootstrap
  (`/backfill-progress`) and that market hours cover the
  subscribed symbols. Off-hours candle staleness surfaces as
  DEGRADED (not UNHEALTHY) — this is by design.
- **Reconciliation stale or held.** Run a manual reconciliation
  from a separate operator tool (not this verifier). The verifier
  is read-only by construction.
- **kill_switch_cache_unpopulated.** First-boot expected on the
  opt-out path. Either re-run with
  `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true`, or invoke
  `/execution/account/summary` from a separate operator flow.

## Safety guarantees

- **GET-only.** Transport hard-codes `method: "GET"` and rejects
  any endpoint key outside the closed allowlist. Tests assert
  the request log ⊆ `{ GET × 14 allowlisted paths }`.
- **No mutating endpoints in scope.** `POST /execution/*`,
  `POST /execution/reconciliation/run`,
  `POST /execution/reconciliation/holds/*`, and
  `POST /bootstrap` / `POST /stop` are not reachable from the
  tool.
- **PR15.1 does not activate any instrument.** Every
  `Instrument` in `packages/shared/src/instruments/definitions.ts`
  keeps `executionEnabled: false`. `TRADING_LOOP_ENABLED` stays
  `false`. Enabling either is a deliberate operator action
  outside PR15.1 (tracked under PR15.2 / PR15.3).
- **No secrets in output.** Account IDs are masked as
  `DU-***234`. Any occurrence of the configured Bearer token is
  replaced with `[REDACTED]` in every rendered string.
