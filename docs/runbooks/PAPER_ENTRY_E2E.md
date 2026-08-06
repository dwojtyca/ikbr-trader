# Paper Entry E2E — single-instrument bounded window runbook

> **Status (2026-08 hostile review):** PR15.3 is currently
> **blocked, not ready**. `es_front.trading.executionEnabled`
> was rolled back to `false` because the shared Phase 2
> `SignalEngine` (DecisionEngine + RiskEngine) does not identify
> the winning strategy, so the loop's fail-closed strategy-policy
> check refuses every submission for any policy-carrying seed.
> This runbook stays authoritative for the Paper E2E procedure
> but MUST NOT be executed against a real broker until the plan
> revision (r2 or later) plumbs a real `strategyId` through the
> pipeline AND `es_front` is re-activated behind a fresh operator
> approval. See
> [PR15_3_PLAN.md](../implementation/phase2/PR15_3_PLAN.md) §11
> and [PR15_3_REPORT.md](../implementation/phase2/PR15_3_REPORT.md).
>
> Introduced with PR15.3. Governs the operator-driven, one-shot
> Paper submission window that exercises the full
> `ingestion → signal-engine → execution-engine → IBKR Paper`
> path for exactly one contract on `es_front`.
>
> **Paper only. Entry only. One contract maximum. Scheduler
> stays OFF throughout. No Live enablement. No automatic roll.**
> This runbook does not authorise mutating any real broker
> account by itself — the operator MUST have separate written
> approval before running Phase B.

## 0. Non-negotiable invariants

Before, during, and after the window the following MUST all hold.
If any becomes false during Phase B or Phase C, abort per §5.

- `IBKR_ENVIRONMENT=paper` on every service.
- Active broker account ID matches an entry in
  `ALLOWED_PAPER_ACCOUNTS`. The whitelist compares FULL account
  IDs (e.g. `DU1234567`), so `.env` / the secret store must
  contain the FULL identifier — masking is applied only to
  runbook output, the report, chat logs, and screen recordings,
  never to the environment variable itself. `ALLOWED_LIVE_ACCOUNTS`
  remains empty for this account.
- `EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT=paper`.
- `EXECUTION_RUNTIME_ENABLED=true` (needed to register
  `/runtime/*` including `run-once`).
- `TRADING_LOOP_ENABLED=false` throughout the entire window.
- `TRADING_LOOP_INSTRUMENT_IDS=es_front`.
- `EXECUTION_API_TOKEN` is present, ≥ 32 chars, identical
  across `signal-engine` and `execution-engine`, and NEVER
  printed to the runbook, chat, screen recording, or logs.
- `INSTRUMENT_BINDINGS_JSON` contains exactly the intended ES
  Paper binding (`conId`, `localSymbol`, `tradingClass`,
  `exchange`, `currency`, `minTick=0.25`) and is byte-identical
  across `ingestion`, `signal-engine`, and `execution-engine`.
- Kill switch is not engaged.
- Zero non-terminal `PROPOSED` / `SUBMITTED` for `es_front`
  and zero open ES position under the server's cross-contract
  exposure policy (`allowCrossContractExposure=false`).
- Broker-driven reconciliation is `complete=true` and NOT held.

## 1. Prerequisites

- Repository checked out at the exact commit approved for the
  window; commit SHA recorded in the report.
- IB Gateway running in **paper** mode on `127.0.0.1:4002`, an
  operator has manually confirmed the paper account ID inside
  the Gateway before starting.
- Docker + Docker Compose installed.
- `.env` populated from `.env.example`; secrets provided
  through the shell / vault, NEVER committed.
- Operator terminal session recorded (video / typescript) for
  audit. Sanitize before archiving.
- Full-stack test gate green on the current commit:
  `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration && pnpm build && pnpm paper:verify-stack:fixture`.

## 2. Phase A — prepare with writes disabled

Goal: bring the stack up in a state where no mutation is
possible, verify every guard, and record the baseline.

1. Set the following in `.env` (or the deployment secret store)
   for this window. Values below use SHELL EXPANSION so the
   FULL DU account id is provided by the operator's local
   shell / vault and NEVER pasted into this runbook, a PR, a
   chat log, or a screen share. Replace the shell placeholders
   with real values inside the operator terminal only:

   ```
   IBKR_ENVIRONMENT=paper
   TRADING_ENABLED=false
   EXECUTION_RUNTIME_ENABLED=true
   EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT=paper
   TRADING_LOOP_ENABLED=false
   TRADING_LOOP_INSTRUMENT_IDS=es_front
   ALLOWED_PAPER_ACCOUNTS=${PAPER_ACCOUNT_ID}   # full DU..., masked in every report
   ALLOWED_LIVE_ACCOUNTS=
   ```

   The whitelist match is a literal `.includes()` string
   comparison inside `assertEnvironmentAllowsWrite`, so a
   partial / masked value in the env WILL cause every mutating
   request to fail with `423 account_not_allowed_for_paper`.

   Do NOT paste the raw `INSTRUMENT_BINDINGS_JSON` value into
   this runbook, the deployment PR, or any shared channel — set
   it directly in the operator shell or the secret store.

2. Rebuild + start the trading services with writes disabled:

   ```
   docker compose up -d postgres redis ingestion signal-engine execution-engine
   ```

3. Wait for migrations, then verify readiness. Phase A expects
   writes to be administratively disabled — the verifier MUST
   assert that state explicitly, otherwise `execution.ready`
   would silently accept an operator who forgot to switch
   Phase B off.

   ### Reusable verifier helper

   Define this once in the operator shell (or add it to a
   short-lived local file sourced only for the window). Phase A,
   Phase B and Phase D all invoke it — the ONLY difference
   between phases is the write-state argument (`disabled` /
   `enabled` / `disabled`).

   ```
   paper_verify_stack_phase() {
     local write_state="${1:?paper_verify_stack_phase: pass 'disabled' or 'enabled'}"
     case "$write_state" in
       disabled|enabled) ;;
       *) printf 'invalid write_state: %s\n' "$write_state"; return 2 ;;
     esac
     # Consume the write-state argument so it is NOT forwarded to
     # `pnpm paper:verify-stack`. Remaining positional arguments
     # (typically `--json`) are passed through verbatim via "$@".
     shift
     env \
       PAPER_VERIFY_INGESTION_URL=http://127.0.0.1:3101 \
       PAPER_VERIFY_SIGNAL_URL=http://127.0.0.1:3102 \
       PAPER_VERIFY_EXECUTION_URL=http://127.0.0.1:3103 \
       PAPER_VERIFY_EXECUTION_TOKEN="$EXECUTION_API_TOKEN" \
       PAPER_VERIFY_RUNTIME_EXPECTED_STATE=registered \
       PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=registered \
       PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE=disabled \
       PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE="$write_state" \
       pnpm paper:verify-stack "$@"
   }
   ```

   For the JSON form, pass `--json` as an argument:

   ```
   paper_verify_stack_phase disabled --json > phase-a-evidence.json
   ```

   Or invoke the tool directly (identical env, but skips `pnpm`
   wrapping):

   ```
   env \
     PAPER_VERIFY_INGESTION_URL=http://127.0.0.1:3101 \
     PAPER_VERIFY_SIGNAL_URL=http://127.0.0.1:3102 \
     PAPER_VERIFY_EXECUTION_URL=http://127.0.0.1:3103 \
     PAPER_VERIFY_EXECUTION_TOKEN="$EXECUTION_API_TOKEN" \
     PAPER_VERIFY_RUNTIME_EXPECTED_STATE=registered \
     PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=registered \
     PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE=disabled \
     PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled \
     node --import tsx tools/paper-verify-stack/src/index.ts --json
   ```

   ### Phase A verifier run

   ```
   paper_verify_stack_phase disabled           # human-readable table
   paper_verify_stack_phase disabled --json    # machine-readable
   ```

   The `signal.execute.ready` endpoint returns 503 in Phase A
   because `PaperGuard.check()` correctly refuses to authorise
   a submission while `TRADING_ENABLED=false`. The verifier
   treats that specific paperGuard failure as an
   infrastructure-side pass ONLY because
   `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled` is
   set. Redis / Postgres / environment / account checks still
   have to pass on their own.

   Every check must pass. Save the JSON output to the report
   evidence directory.

4. Confirm the binding is broker-verified:
   - `GET http://localhost:3101/watchlist` — the top-level
     `bindings` object surfaces only safe DIAGNOSTICS
     (`{ boundCount, ids }`) and MUST NOT be relied on for
     `conId` verification. It MUST report `boundCount === 1`
     and `ids: ["es_front"]`.
   - The exact `conId`, `instrumentId`, and `subscribed` flag
     for the ES contract live in the corresponding element of
     the `watchlist[]` array. Confirm the entry with
     `instrumentId === "es_front"` reports the operator-
     configured `conid`, `subscribed === true`, and a fresh
     `marketState`.
   - `GET http://localhost:3103/ready` — verifies
     `environment=paper`, `tradingEnabled=false` in Phase A
     (this is expected — the kill switch is still ON here),
     the last position snapshot is complete, and reconciliation
     is clean.

5. Confirm no residual state. The FULL DU account id lives ONLY
   in a single shell variable `$PAPER_ACCOUNT_ID` in the operator
   terminal (sourced from the vault or `.env`, never printed).
   The examples below feed that value to `psql` via **stdin** so
   it never appears in `argv`, `ps`, `.psql_history`, the shell
   history file, or command-line audit logs. Each block starts
   with a fail-closed check that the variable is set and
   non-empty; the operator only ever sees a masked confirmation.

   Sanity guard (run once at the start of Phase A; do NOT print
   the full value). The regex accepts only real IBKR paper
   account identifiers — a leading `DU`, `DUPAPER`, or `DUH`
   followed by digits — and refuses whitespace, quotes,
   backslashes, or any character that could break out of the
   `\set` binding downstream:

   ```
   set -u
   : "${PAPER_ACCOUNT_ID:?PAPER_ACCOUNT_ID must be set in the operator shell before running Phase A}"
   if ! [[ "$PAPER_ACCOUNT_ID" =~ ^(DU|DUPAPER|DUH)[0-9]{4,10}$ ]]; then
     printf 'refusing PAPER_ACCOUNT_ID: format must match ^(DU|DUPAPER|DUH)[0-9]{4,10}$ (received: masked=%s***%s, len=%d)\n' \
       "${PAPER_ACCOUNT_ID:0:2}" "${PAPER_ACCOUNT_ID: -3}" "${#PAPER_ACCOUNT_ID}"
     return 1 2>/dev/null || exit 1
   fi
   printf 'PAPER_ACCOUNT_ID is set (masked: %s***%s, len=%d)\n' \
     "${PAPER_ACCOUNT_ID:0:2}" "${PAPER_ACCOUNT_ID: -3}" "${#PAPER_ACCOUNT_ID}"
   ```

   Query 1 — residual `PROPOSED` / `SUBMITTED` rows on
   `es_front`. Static SQL, no account id needed:

   ```
   docker compose exec -T postgres psql -U postgres -d ikbr_trader -c \
     "SELECT id,status FROM proposed_orders \
      WHERE instrument_id='es_front' AND status IN ('PROPOSED','SUBMITTED');"
   ```

   Query 2 — broker position snapshot for THIS account. The
   account id is fed to `psql` on stdin using `\set` from a heredoc,
   so it is bound to a psql variable BEFORE the SQL executes and
   never touches `argv`. `docker compose exec` (v2) does NOT accept
   `-i` — stdin is attached by default; verify locally with
   `docker compose exec --help`:

   ```
   docker compose exec -T postgres psql -U postgres -d ikbr_trader \
       -v ON_ERROR_STOP=1 <<PSQL
   \set account_id '$PAPER_ACCOUNT_ID'
   SELECT account_id, instrument, conid, quantity, session_id, observed_at
     FROM broker_position_snapshots
    WHERE account_id = :'account_id' AND ABS(quantity) > 1e-9;
   PSQL
   ```

   Query 3 — active reconciliation holds. Static SQL:

   ```
   docker compose exec -T postgres psql -U postgres -d ikbr_trader -c \
     "SELECT id, instrument, reason, severity, active, created_at \
      FROM reconciliation_holds \
      WHERE active = TRUE;"
   ```

   The `broker_position_snapshots` table has columns
   `account_id, instrument, conid, quantity, session_id,
   observed_at` (see `infra/sql/migrations/000002_execution_pr13_pr14.sql`).
   `complete` / `generation` live on the paired
   `broker_snapshot_syncs` table:

   ```
   docker compose exec -T postgres psql -U postgres -d ikbr_trader \
       -v ON_ERROR_STOP=1 <<PSQL
   \set account_id '$PAPER_ACCOUNT_ID'
   SELECT account_id, session_id, generation, complete, observed_at
     FROM broker_snapshot_syncs
    WHERE account_id = :'account_id';
   PSQL
   ```

   The `$PAPER_ACCOUNT_ID` interpolation happens in the operator's
   local shell BEFORE the `docker compose exec` process is
   spawned, but the resulting text is delivered to `psql` on its
   standard input — the process arguments only reference
   `-v ON_ERROR_STOP=1`. Verify with `ps auxww | grep psql` while
   a query is running: the account id MUST NOT appear.

   Every position-row result MUST be empty; the sync row (if
   present) MUST report `complete = true`; the holds result
   MUST be empty.

6. Record baseline evidence in the report evidence directory:
   masked account ID, `es_front`, exact `conId`, exact
   `localSymbol`, image / commit ID, UTC start time. DO NOT
   record the token or the raw binding payload.

**Phase A gate.** If any check above fails, STOP. Do not
proceed to Phase B. Fix the environment, restart Phase A.

## 3. Phase B — bounded write window

Goal: perform exactly one authenticated `run-once` while
writes are enabled, then close the write window as soon as
the outcome is captured.

1. Set `TRADING_ENABLED=true` for `execution-engine` ONLY.
   Restart that service:

   ```
   docker compose up -d --build execution-engine
   ```

   `TRADING_LOOP_ENABLED` MUST remain `false`. `signal-engine`
   MUST NOT be restarted with an enabled scheduler.

2. Re-run readiness and reconciliation checks with the
   **Phase B** expected write state — writes MUST be enabled
   before invoking `run-once`, and the verifier now asserts
   that explicitly.

   If any GET endpoint reports a change in binding, environment,
   active account, position snapshot, or reconciliation state
   compared to Phase A — OR the verifier still reports
   `tradingEnabled=false` under
   `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=enabled` (i.e.
   step B.1 didn't take effect) — ABORT per §5 immediately.

   Uses the same reusable helper defined in Phase A §3 — the
   ONLY change from Phase A is the write-state argument:

   ```
   paper_verify_stack_phase enabled
   paper_verify_stack_phase enabled --json > phase-b-evidence.json
   ```

   If a fresh shell is used (no helper in scope) the fully
   self-contained equivalent is:

   ```
   env \
     PAPER_VERIFY_INGESTION_URL=http://127.0.0.1:3101 \
     PAPER_VERIFY_SIGNAL_URL=http://127.0.0.1:3102 \
     PAPER_VERIFY_EXECUTION_URL=http://127.0.0.1:3103 \
     PAPER_VERIFY_EXECUTION_TOKEN="$EXECUTION_API_TOKEN" \
     PAPER_VERIFY_RUNTIME_EXPECTED_STATE=registered \
     PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=registered \
     PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE=disabled \
     PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=enabled \
     pnpm paper:verify-stack
   ```

3. Invoke exactly ONE authenticated `run-once` from an
   operator terminal. The token is read from the local shell,
   never echoed:

   ```
   curl -sS -X POST http://localhost:3102/runtime/trading-loop/run-once \
        -H "Authorization: Bearer $EXECUTION_API_TOKEN"
   ```

   Save the sanitized response. Record `cycleId`, per-instrument
   `outcome.kind`, `idempotencyKey`, and — when the outcome is
   `SUBMITTED` — the `proposedOrderId` and any `brokerOrderId`
   returned by the read endpoints below. Redact tokens.

4. Do NOT invoke a second cycle in the same evaluation bucket.
   A repeat is scheduled only after re-running every Phase A
   check on a distinct evaluation bucket (see §4.7).

## 4. Phase C — observe and reconcile

Goal: prove IBKR, `proposed_orders`, orders / fills, and
reconciliation agree. Read-only endpoints only unless
explicitly noted.

1. `GET http://localhost:3103/execution/orders?limit=20`
   (bearer) — inspect the parent + protective legs. The
   endpoint returns a `ProposedOrder[]` array in **camelCase**
   (`instrumentId`, `brokerOrderId`, `orderType`, `side`,
   `status`, `createdAt`, …) and does NOT project the
   `clientOrderId` / `clientOrderHash` columns. Use the SQL
   query in step 2 to resolve the `clientOrderId` returned by
   `run-once` back to the local `proposed_orders.id` for
   cross-checking.

2. Query Postgres read-only:

   ```
   docker compose exec -T postgres psql -U postgres -d ikbr_trader -c \
     "SELECT id, instrument, instrument_id, conid, client_order_id, \
             client_order_hash, status, broker_order_id \
      FROM proposed_orders \
      WHERE client_order_id = '<clientOrderId>';"
   ```

   Confirm `instrument_id = 'es_front'`, `conid = <bound conId>`,
   `client_order_id / client_order_hash` populated, `status` is
   `SUBMITTED` (or the terminal state broker reports).

3. Broker snapshot after any fill. Uses the same
   `$PAPER_ACCOUNT_ID`-on-stdin pattern as Phase A §5 (no argv
   exposure). `docker compose exec` does NOT accept `-i` — stdin
   is attached by default:

   ```
   docker compose exec -T postgres psql -U postgres -d ikbr_trader \
       -v ON_ERROR_STOP=1 <<PSQL
   \set account_id '$PAPER_ACCOUNT_ID'
   SELECT account_id, instrument, conid, quantity, session_id, observed_at
     FROM broker_position_snapshots
    WHERE account_id = :'account_id';
   PSQL

   docker compose exec -T postgres psql -U postgres -d ikbr_trader \
       -v ON_ERROR_STOP=1 <<PSQL
   \set account_id '$PAPER_ACCOUNT_ID'
   SELECT account_id, session_id, generation, complete, observed_at
     FROM broker_snapshot_syncs
    WHERE account_id = :'account_id';
   PSQL
   ```

   `broker_position_snapshots` carries the per-instrument row
   (`instrument`, `conid`, `quantity`, `session_id`,
   `observed_at`); `complete` and `generation` come from the
   `broker_snapshot_syncs` sync-record row. `quantity` must
   match what the IBKR UI shows for the same `session_id`, and
   `broker_snapshot_syncs.complete` MUST be `true`.

4. Reconciliation. Two GETs are required — the routes contract
   is:

   - `GET http://localhost:3103/execution/reconciliation/latest`
     (bearer) → returns
     `{ accountId, sessionId, run, latestInSession,
        latestOverall, stale, maxAgeSeconds }`. Verify
     `stale === false`, `run.status === "CLEAN"`,
     `run.snapshotComplete === true`,
     `run.sourceCoverage` reports every expected source, and
     `run.mismatchesCount === 0`. If any of those diverge,
     stop and follow the abort procedure — a mismatch during
     the window is a hard stop.
   - `GET http://localhost:3103/execution/reconciliation/holds?active=true`
     (bearer) → returns `{ accountId, holds }`. Verify
     `holds` is an EMPTY array. Any element here is a
     blocking active hold — abort per §5.

   The endpoint does NOT return top-level `mismatches`,
   `holds`, or `complete` fields.

5. IBKR ground-truth:
   - The operator manually verifies in the Gateway UI that the
     parent order + both protective legs match what
     `/execution/orders` reports (`conId`, side, quantity,
     limit / stop / take-profit prices).
   - Record the broker order IDs alongside the local IDs.

6. If parent filled: verify local fill capture in
   `broker_execution_fills` and that reconciliation stays clean
   after the FILLED transition.

7. Same-trigger replay (idempotency evidence):
   - Wait for a fresh evaluation bucket per the strategy's
     timeframe (1 min for `es_front`).
   - Actually easier: skip and rely on the existing PG
     integration tests that prove `duplicate_replay` and
     `CONFLICT` semantics. A hand-crafted replay against a
     live paper account is unnecessary and risks a second
     ambiguous submission — do NOT run one unless the plan
     revision explicitly authorises it.

## 5. Phase D — close the window

Goal: disable writes, confirm zero residual mutable state,
capture the final evidence, stop.

1. Set `TRADING_ENABLED=false` for `execution-engine` and
   restart it:

   ```
   docker compose up -d --build execution-engine
   ```

   The write guard now blocks every mutating `/execution/*`
   POST except the closed exemption list in
   `apps/execution-engine/src/write-guard-exemptions.ts`:
   `POST /execution/cancel-proposed/:id` (risk-reducing broker
   cancel) and the three operator reconciliation endpoints
   (`/execution/reconciliation/run`,
   `/execution/reconciliation/holds/:id/acknowledge`,
   `/execution/reconciliation/holds/:id/resolve`). Every other
   mutating endpoint — including `execute-ticket`,
   `execute-proposed/:id`, `reject-proposed/:id`, `bootstrap`,
   and `refresh-position-snapshot` — returns `423
   paper_trading_disabled`. Bearer auth and audit are still
   enforced on every endpoint.

2. Keep `TRADING_LOOP_ENABLED=false`.

3. Neutralise any remaining open Paper broker orders. The only
   audited endpoint available while writes are disabled is
   `POST /execution/cancel-proposed/:id` — and `:id` is the
   **LOCAL `proposed_orders.id`** row identifier, NOT the
   `brokerOrderId` IBKR assigned. Confusing the two silently
   404s (broker id 1234567 has no matching local row) or, worse,
   cancels a completely different order that happens to share
   the same numeric value. Distinguish them explicitly:

   - `proposedOrderId` — local Postgres row identifier
     (`proposed_orders.id`, integer primary key). Owned by the
     execution-engine, stable across broker sessions, and the
     value the endpoint expects on the URL.
   - `brokerOrderId` — the identifier IBKR issues once the
     parent order is transmitted (`proposed_orders.broker_order_id`,
     stored as text). Owned by the broker, unique within a
     session only, and NOT the cancellation identifier here.
   - `clientOrderId` — the deterministic idempotency key
     computed by the trading loop
     (`loop:v4:<instrumentId>:<strategyId>:<triggerId>`);
     stored on `proposed_orders.client_order_id`. Used to
     look up the local row without touching the broker.

   Step 3.a — LOOK UP the local row and CONFIRM every field
   before running the cancel. Never fill the URL by guessing
   or by copying an IBKR `brokerOrderId` from the Gateway
   window. Prefer the read endpoint. `GET /execution/orders`
   serialises `ProposedOrder` in **camelCase** (`instrumentId`,
   `brokerOrderId`), while the Postgres columns further below
   use snake_case (`instrument_id`, `broker_order_id`) —
   choose the right spelling for each context:

   ```
   curl -sS -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
     "http://localhost:3103/execution/orders?limit=20" | jq \
     '[.[] | select(.instrumentId == "es_front" and .status == "SUBMITTED")]'
   ```

   Note that `/execution/orders` does NOT include the
   `clientOrderId` / `clientOrderHash` columns in its response
   (they are stored on `proposed_orders` but not projected by
   the read handler). Use the SQL fallback below to confirm
   them.

   OR a read-only SQL check (uses the same
   `$PAPER_ACCOUNT_ID`-on-stdin pattern as Phase A §5, no argv
   exposure):

   ```
   docker compose exec -T postgres psql -U postgres -d ikbr_trader \
       -v ON_ERROR_STOP=1 <<PSQL
   SELECT id                AS proposed_order_id,
          client_order_id,
          broker_order_id,
          instrument_id,
          status,
          created_at
     FROM proposed_orders
    WHERE instrument_id = 'es_front'
      AND status = 'SUBMITTED';
   PSQL
   ```

   Confirm the specific row you intend to cancel has (SQL
   column names shown; the HTTP endpoint returns
   `.instrumentId` / `.brokerOrderId` in place of
   `instrument_id` / `broker_order_id`):

   - `id`                = the value you will pass to
     `cancel-proposed/:id` (NOT the broker id);
   - `client_order_id`   = the `loop:v4:…` string returned by
     the `run-once` response (SQL only — not on
     `/execution/orders`);
   - `broker_order_id` / `.brokerOrderId` = a non-empty,
     non-null broker id matching what IBKR reports;
   - `instrument_id` / `.instrumentId` = `es_front`;
   - `status`            = `SUBMITTED`.

   If any of those does not match, STOP. Do NOT cancel.

   Step 3.b — send the cancel with the LOCAL id. The example
   below uses shell variable `PROPOSED_ORDER_ID` so the
   substitution is explicit and the operator can re-run the
   command safely:

   ```
   : "${PROPOSED_ORDER_ID:?PROPOSED_ORDER_ID must be the LOCAL proposed_orders.id, NOT the brokerOrderId}"
   if ! [[ "$PROPOSED_ORDER_ID" =~ ^[1-9][0-9]*$ ]]; then
     printf 'refusing PROPOSED_ORDER_ID: must be a positive integer (received: %q)\n' "$PROPOSED_ORDER_ID"
     return 1 2>/dev/null || exit 1
   fi
   curl -sS -X POST \
        "http://localhost:3103/execution/cancel-proposed/$PROPOSED_ORDER_ID" \
        -H "Authorization: Bearer $EXECUTION_API_TOKEN"
   ```

   The endpoint sends `IBApi.cancelOrder` to the broker for the
   linked `brokerOrderId` and updates the local row on the
   canonical `code=10147` (order not found) response. It only
   applies to rows that are currently `status='SUBMITTED'`;
   already-terminal rows return 409 from the endpoint's own
   validator (per
   `apps/execution-engine/src/index.ts::/execution/cancel-proposed/:id`).

   Step 3.c — CONFIRM the cancel took effect. The cancel is
   asynchronous on the broker side; a HTTP 200 alone does NOT
   prove the broker acknowledged. Do all three:

   - IBKR ground truth — verify in the Gateway UI that the
     parent broker order is `Cancelled`; verify the OCA children
     (stop / take-profit) are `Cancelled` too;
   - local state — re-run the SQL from step 3.a and confirm the
     row's `status` is now `CANCELLED` (or, for the
     `code=10147` path, `CANCELLED` with the "Broker reports
     order not found" message on `last_error`);
   - fresh reconciliation — trigger
     `POST /execution/reconciliation/run` (still on the exempt
     list) and re-check
     `GET /execution/reconciliation/latest` — the run status
     MUST be `CLEAN` and `run.mismatchesCount === 0`.

   A HTTP timeout on step 3.b is NOT a confirmation. If the
   request times out, do NOT retry immediately — inspect
   broker state through the Gateway UI FIRST. Retrying can
   race a broker-side `Cancelled` acknowledgement that has
   simply not propagated yet.

   Allow protective children to fill naturally when appropriate
   — cancelling the parent will cancel unfilled OCA children on
   IBKR's side.

   **There is NO audited `close-position` / `flatten` / `exit-
   position` endpoint in the current codebase.** If a position
   IS already open and cannot be neutralised by the protective
   child cancellations (e.g. a naked filled position from a
   prior incident), STOP and treat it as an operational
   incident. Options, in order of preference:
     * wait for the protective stop / take-profit child to
       execute (they are broker-side OCA orders and remain
       active after `TRADING_ENABLED=false`);
     * re-enable writes ONLY under a fresh operator approval,
       submit a bracketed closing proposal through the normal
       proposal path (which stays under the write guard), and
       disable writes again;
     * escalate through the operator on-call procedure
       described in the incident playbook.

   Do NOT automate IBKR UI. Do NOT send a market order. Do NOT
   introduce a new close/flatten endpoint in this PR — that is
   PR16 (Position / exit management) territory.

4. Re-run the GET-only verifier and the final reconciliation
   check. Phase D expects the full Phase A verifier environment
   with the write-state set to `disabled` — the Phase A helper
   from §2 §3 already encodes it. A shortcut like
   `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled pnpm paper:verify-stack`
   is INCORRECT here: every other `PAPER_VERIFY_*` variable
   would fall back to its default, in particular
   `PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=absent`,
   which SKIPS the execution runtime + trading-loop probes
   entirely. Phase D MUST confirm those probes stayed green.

   Use the reusable helper:

   ```
   paper_verify_stack_phase disabled
   paper_verify_stack_phase disabled --json > phase-d-evidence.json
   ```

   Or the fully self-contained equivalent:

   ```
   env \
     PAPER_VERIFY_INGESTION_URL=http://127.0.0.1:3101 \
     PAPER_VERIFY_SIGNAL_URL=http://127.0.0.1:3102 \
     PAPER_VERIFY_EXECUTION_URL=http://127.0.0.1:3103 \
     PAPER_VERIFY_EXECUTION_TOKEN="$EXECUTION_API_TOKEN" \
     PAPER_VERIFY_RUNTIME_EXPECTED_STATE=registered \
     PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=registered \
     PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE=disabled \
     PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled \
     pnpm paper:verify-stack
   ```

   Every check must pass — Phase D confirms in one shot:

   - execution runtime is still registered;
   - trading-loop is still `disabled`;
   - execution-engine `/ready.tradingEnabled` is `false`;
   - Redis and Postgres are reachable;
   - `PaperGuard` is in the expected administrative OFF state
     (paperGuard.error mentions `tradingEnabled=false`; treated
     as an infrastructure pass only because of the explicit
     `disabled` expected-state).

   Save the JSON output.

5. Verify zero open ES position and zero non-terminal ES
   `PROPOSED` / `SUBMITTED` remain. If any residual is
   observed, STOP and treat it as an incident — do not close
   the window as "clean".

6. Record UTC end time and final residual state in the
   report. Mask account IDs; do not include the token, the raw
   binding, or the `.env`.

## 6. Immediate abort procedure

If ANY of the following is observed at any point after
Phase A completes, ABORT the window:

- Broker environment is not `paper`.
- Active account is not in `ALLOWED_PAPER_ACCOUNTS`, or
  matches an entry in `ALLOWED_LIVE_ACCOUNTS`.
- Binding mismatch (returned symbol / `conId` / `localSymbol`
  / `tradingClass` / `minTick` diverges).
- Position snapshot is missing, stale, incomplete, or was
  written by a different `session_id`.
- Reconciliation reports a hold, a mismatch, or is stale.
- More than one broker parent order exists for one
  `clientOrderId`.
- An unexpected ES position or an orphan order appears.
- An ambiguous submission (`SUBMIT_UNKNOWN`) surfaces on
  the runtime response or in Postgres.

Abort steps (execute in this order):

1. Disable writes FIRST:
   `TRADING_ENABLED=false`, restart `execution-engine`. Do NOT
   send any additional `run-once`.
2. Keep `TRADING_LOOP_ENABLED=false`.
3. Do NOT retry any unknown submission.
4. Inspect IBKR orders, IBKR positions, and the reconciliation
   endpoint. Broker state is the source of truth. The
   `POST /execution/reconciliation/run` endpoint remains
   available while writes are disabled (it is on the exemption
   list) and can be used to force a fresh reconciliation cycle.
5. Cancel outstanding SUBMITTED broker orders with
   `POST /execution/cancel-proposed/:id` — the ONLY audited
   endpoint for cancelling a broker order that stays reachable
   while `TRADING_ENABLED=false`. Three reconciliation
   operator endpoints (`/execution/reconciliation/run`,
   `/execution/reconciliation/holds/:id/acknowledge`,
   `/execution/reconciliation/holds/:id/resolve`) also stay
   reachable per the closed exemption list in
   `apps/execution-engine/src/write-guard-exemptions.ts`, but
   they are diagnostic / hold-management paths, not broker
   cancel paths. There is NO automatic `close-position` /
   `flatten` / `exit-position` endpoint in the current
   codebase, and one MUST NOT be introduced in scope of
   PR15.3 — that is PR16 (Position / exit management)
   territory. Never use IBKR UI automation. Never send a
   market order. If a position remains open after cancelling
   the parent and the protective children do not neutralise
   it, follow the escalation options listed in §5 Phase D
   step 3.
6. Record the abort context in the report; do not close the
   report as "shipped".

Abort does NOT itself cancel a broker order or flatten a
position — writes are disabled first, then broker state is
inspected, then the appropriate audited workflow is used.

## 7. What this runbook does NOT authorise

This runbook does not authorise any of:

- Live trading (`IBKR_ENVIRONMENT=live` at any point).
- Enabling the scheduler (`TRADING_LOOP_ENABLED=true`).
- More than one execution-enabled instrument for the window.
- Multi-symbol / multi-day / stable-Paper promotion (that is
  a separate acceptance gate — see
  [`../implementation/phase2/TESTING_AND_ROLLOUT.md`](../implementation/phase2/TESTING_AND_ROLLOUT.md)).
- Position / exit management beyond the risk-reducing
  `POST /execution/cancel-proposed/:id` endpoint (there is no
  close / flatten endpoint yet — PR16 territory).
- Automatic futures roll or contract selection.
- Portfolio optimisation or pyramiding.
- Direct broker test orders outside the proposal / risk /
  execution flow.
- IBKR UI automation.

## 8. Related documents

- [PR15.3 plan](../implementation/phase2/PR15_3_PLAN.md)
- [PR15.3 report](../implementation/phase2/PR15_3_REPORT.md)
- [Paper stack verification](PAPER_STACK_VERIFICATION.md)
- [Trading loop architecture](../architecture/TRADING_LOOP.md)
- [Instrument registry](../architecture/INSTRUMENT_REGISTRY.md)
- [Reconciliation runtime](../architecture/RECONCILIATION_RUNTIME.md)
