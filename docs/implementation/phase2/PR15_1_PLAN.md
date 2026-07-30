# PR15.1 — Runtime Truth & Paper Operator Tooling — PLAN (r6)

> Scope: documentation reconciliation + CI lint step +
> read-only, GET-only, allowlist-bound `paper:verify-stack`
> tool packaged as a first-class workspace, plus a runbook.
> **No** trading-logic changes. **No** endpoint changes. **No**
> instrument activation. **No** live enablement.
>
> Gates on: `87eff1c` (PR15 merged). Blocks PR15.2
> (instrument binding) and PR15.3 (entry-only Paper E2E).

## 1. Current-state findings (evidence)

### 1.1 Actual endpoints (source of truth)

Ingestion (`apps/ingestion/src/index.ts`):

- `GET /health` (L157) returns
  `{ok, connected, bootstrapped, bootstrapping,
  lastBootstrapAt, lastTickAt, lastCandleAt}`. There is
  **no** `twsConnected` field.
- `GET /backfill-progress` (L167).
- `GET /watchlist` (L171) returns
  `{connected, bootstrapped, bootstrapping, lastBootstrapAt,
  watchlist}` where each `watchlist[]` entry is
  `{symbol, displayName, conid, subscribed, marketState,
  latestCandle1m}`. `marketState` and `latestCandle1m` may
  be `null` for un-subscribed symbols; the freshness marker
  is `marketState.ts` (and optionally `latestCandle1m.ts`).
  There is **no** per-symbol `lastTickAt`.
- `POST /bootstrap` (L208), `POST /stop` (L475) — MUST NOT
  be invoked by the verify tool.

Signal-engine base (`apps/signal-engine/src/index.ts`):

- `GET /health` (L136) always registered.
- `/signals/*` — always registered; none are consumed by
  the verify tool.

Signal-engine runtime — conditional registration (verified
in `apps/signal-engine/src/index.ts:275–378`):

- `/runtime/health`, `/runtime/ready`, `POST /runtime/dry-run`
  register ONLY when `RUNTIME_ENABLED=true` (default
  `"true"`). When `false`, log
  `runtime: RUNTIME_ENABLED=false — /runtime/* endpoints not
  registered` and the paths return HTTP 404.
- `POST /runtime/execute` + `GET /runtime/execute/ready`
  register ONLY when `RUNTIME_ENABLED=true &&
  EXECUTION_RUNTIME_ENABLED=true` (default `"false"`).
- `GET /runtime/trading-loop/status`,
  `GET /runtime/trading-loop/ready`,
  `POST /runtime/trading-loop/run-once` register in the SAME
  branch as `/runtime/execute` (`index.ts:353`), i.e. they
  require `EXECUTION_RUNTIME_ENABLED=true`. The loop
  scheduler itself starts only when
  `TRADING_LOOP_ENABLED=true`; when `false`, the endpoints
  still exist and report `enabled: false`.

Execution-engine (`apps/execution-engine/src/index.ts`):

- `GET /health` (L901), `GET /ready` (L1068),
  `GET /execution/kill-switch` (L1130),
  `POST /execution/reconciliation` (legacy alias, L1134),
  `GET /execution/alerts` (L1143),
  `POST /execution/alerts/test` (L1151),
  `POST /execution/bootstrap` (L1167),
  `POST /execution/refresh-position-snapshot` (L1186),
  `GET /execution/account/summary` (L1200 — has side
  effects: `ensureBrokerSession` + `syncRecentExecutions`),
  `GET /execution/orders` (L1310),
  `GET /execution/trades` (L1360),
  `POST /execution/execute-proposed/:id` (L1370),
  `POST /execution/reject-proposed/:id` (L1392),
  `POST /execution/cancel-proposed/:id` (L1419),
  `POST /execution/execute-ticket` (L1474).
- Reconciliation
  (`apps/execution-engine/src/reconciliation/routes.ts`):
  `GET /execution/reconciliation/latest` returns
  `{accountId, sessionId, run, latestInSession,
  latestOverall, stale, maxAgeSeconds}` where `run` (mapped
  by `mapRun`) carries `snapshotComplete`,
  `snapshotCapturedAt`, `sourceCoverage`, `status`,
  `completedAt`, `error`. Verify tool consumes these
  directly; it must NOT synthesise freshness from other
  fields. `GET /execution/reconciliation/holds?active=…`,
  `POST /execution/reconciliation/run`,
  `POST /execution/reconciliation/holds/:id/acknowledge`,
  `POST /execution/reconciliation/holds/:id/resolve` — the
  four POST endpoints MUST NOT be reached from the tool.

### 1.2 Real env names

- `.env.example:229–235` — `TRADING_LOOP_*`.
- `.env.example:219–222` — `EXECUTION_RUNTIME_*`.
- `.env.example:115–128` — `RECONCILIATION_*`.
- `apps/signal-engine/src/config.ts:89` — `RUNTIME_ENABLED`
  default `"true"`.
- `apps/signal-engine/src/runtime/execution/config.ts:28` —
  `EXECUTION_RUNTIME_ENABLED` default `"false"`.
- `apps/signal-engine/src/runtime/trading-loop/config.ts:29` —
  `TRADING_LOOP_ENABLED` default `"false"`.
- No `ORCH_*` env exists anywhere in the codebase.

### 1.3 Documented-but-non-existent contract

- `POST /execution/tickets` (RUNTIME_FLOW.md:43;
  TESTING_AND_ROLLOUT.md:28/29/31/32;
  STATE_AND_RECONCILIATION.md:36; README.md:94;
  FAILURE_AND_RECOVERY.md retry table). Actual:
  `POST /execution/execute-ticket`. Body carries
  `clientOrderId + clientOrderHash` (JSON), not an
  `Idempotency-Key` header.
- `EXECUTION_TICKET_ENDPOINT_PATH`,
  `EXECUTION_IDEMPOTENCY_HEADER`, `LIVE_STARTUP_DRY_READ` —
  CONFIGURATION.md:21–23. None present in any `config.ts`.
- `ORCH_*` family (10 vars) — CONFIGURATION.md:12–20. None
  exist; the real runtime is `TRADING_LOOP_*` /
  `EXECUTION_RUNTIME_*` / `RECONCILIATION_*`.

### 1.4 OD-1..OD-6 resolutions

- OD-1 — runtime lives in `apps/signal-engine/src/runtime/`.
- OD-2 — no separate `execution_tickets` table; every
  order-critical field lives on `proposed_orders`
  (migration 000005: `partial_take_profits`,
  `trailing_stop_pct`, `trailing_stop_activation_r`).
- OD-3 — `client_order_id` + `client_order_hash` on
  `proposed_orders`, mandatory + server-recomputed via
  `@ikbr/shared/client-order-hash`.
- OD-4 — `POST /execution/execute-ticket`.
- OD-5 — internal loop in signal-engine
  (`TRADING_LOOP_INTERVAL_MS`).
- OD-6 — inline in
  `apps/signal-engine/src/runtime/execution/` submitter and
  in
  `apps/execution-engine/src/reconciliation/submission-service.ts`.

### 1.5 Retry / ambiguous semantics — actual (PR15)

- Idempotency replay returns HTTP 200 with `outcome:
  DUPLICATE_SUBMITTED | DUPLICATE_TERMINAL |
  DUPLICATE_PENDING_AMBIGUOUS | PENDING_CLAIMED` +
  `duplicate: true`.
- Ambiguous rows stay `PROPOSED` with marker + persisted
  plan; recovery is reconciliation-driven
  (`GET /execution/reconciliation/latest` + `/holds`), NOT
  a client-side re-query on the ticket endpoint.

### 1.6 Runtime state that must be stated plainly

- Every `Instrument` in
  `packages/shared/src/instruments/definitions.ts` has
  `executionEnabled: false` (L30, L68, L106, L144, L182,
  L220). `RiskEngine` rule
  `packages/shared/src/risk-engine/rules.ts:196` blocks
  with `INSTRUMENT_DISABLED`.
- `TRADING_LOOP_ENABLED=false` by default
  (`.env.example:229`).
- No exit path in `trading-loop-service.ts` — PR16 owns
  exit management.
- `apps/llm-agent` — already accurately described in
  `AGENTS.md:42` as the autonomous EXECUTE/REJECT gate that
  polls `PROPOSED` orders. AGENTS.md line 147 (`close
  positions`) is under "Safety Rules — Never", not a claim
  that the loop closes positions. **No AGENTS.md edit
  planned.** The "entry-only loop" + "legacy LLM agent
  outside the new pipeline" statements land in
  `PHASE_2_ROADMAP.md` and `RUNTIME_FLOW.md`.

### 1.7 CI

`.github/workflows/ci.yml:37–46`: install → typecheck →
test → `pnpm test:integration` (Postgres 16 service +
explicit `TEST_POSTGRES_URL=…/ikbr_trader_ci`, verified
L42–L45) → build. **No** `pnpm lint` step.
`pnpm lint` exists in `package.json` and is green locally.

### 1.8 Workspace state

- `pnpm-workspace.yaml` lists only `apps/*` and `packages/*`.
- Root `package.json.workspaces` matches. `tools/*` is not
  covered.
- Existing test / typecheck / build scripts iterate the
  workspaces (`pnpm -r --if-present …`) so a new tool
  package is picked up automatically once the workspace
  globs include it.

## 2. Documentation drift — files to update

Append/mark-status only; do not rewrite historical plans.

- `docs/implementation/phase2/PHASE_2_ROADMAP.md` — status
  block: PR11–PR15 shipped (commit `87eff1c`), PR15.1 =
  runtime truth + tooling, PR15.2 = authoritative
  instrument binding, PR15.3 = entry-only Paper E2E, PR16
  unchanged. Add explicit "still entry-only; LLM agent
  remains legacy EXECUTE/REJECT gate outside the new
  pipeline" callouts here.
- `docs/implementation/phase2/CONFIGURATION.md` — replace
  the `ORCH_*` table with an accurate one for
  `TRADING_LOOP_*`, `EXECUTION_RUNTIME_*`,
  `RECONCILIATION_*`, `RUNTIME_ENABLED`; strike the
  fictional `EXECUTION_TICKET_ENDPOINT_PATH`,
  `EXECUTION_IDEMPOTENCY_HEADER`, `LIVE_STARTUP_DRY_READ`
  rows; add "superseded" note on the historical narrative.
- `docs/implementation/phase2/RUNTIME_FLOW.md` — update the
  Mermaid + tables to reference
  `POST /execution/execute-ticket`,
  `signal-engine/runtime/trading-loop`,
  `submission-service`, `reconciliation/*`.
- `docs/implementation/phase2/STATE_AND_RECONCILIATION.md`
  — correct the lifecycle (mandatory `clientOrderId +
  clientOrderHash` on `proposed_orders`, no separate
  `execution_tickets` table).
- `docs/implementation/phase2/FAILURE_AND_RECOVERY.md` —
  rewrite the retry taxonomy on the current outcome union;
  replace client-side ambiguous re-query with
  reconciliation-hold recovery.
- `docs/implementation/phase2/TESTING_AND_ROLLOUT.md` —
  rename endpoints; list the current PostgreSQL suites
  (`three-phase*.pg-integration.test.ts`,
  `submission-gate.pg-integration.test.ts`,
  `matcher-per-row.pg-integration.test.ts`,
  `three-phase-r5..r8.pg-integration.test.ts`).
- `docs/implementation/phase2/README.md` — mark OD-1..OD-6
  resolved with code pointers.
- `docs/implementation/phase2/PR15_PLAN.md` and
  `PR15_REPORT.md` — historical; add a one-line "Status:
  shipped as commit 87eff1c" header if not already
  present.
- **AGENTS.md — no change** (see §1.6).

## 3. `paper:verify-stack` — workspace + package design

### 3.1 Workspace changes (mandatory)

- `pnpm-workspace.yaml` — add `- tools/*` under
  `packages:`.
- Root `package.json.workspaces` — add `"tools/*"`.
- Regenerate `pnpm-lock.yaml` via `pnpm install`.
- Root script:
  `"paper:verify-stack": "pnpm --filter @ikbr/paper-verify-stack start"`.
- The new package participates in root `pnpm test`,
  `pnpm typecheck`, `pnpm build` via `pnpm -r --if-present …`.

### 3.2 Package layout

`tools/paper-verify-stack/`:

- `package.json`:
  - `"name": "@ikbr/paper-verify-stack"`, `"private": true`,
    `"type": "module"`, `"main": "dist/index.js"`.
  - `"scripts"`:
    - `"start": "node --import tsx src/index.ts"`
    - `"typecheck": "tsc -p tsconfig.json --noEmit"`
    - `"test": "node --import tsx --test 'src/**/*.test.ts'"`
    - `"build": "tsc -p tsconfig.json"`
  - `"dependencies": { "zod": "^3.23" }` (matches root).
  - `"devDependencies": {
      "@types/node": "^22.7.4",
      "tsx": "^4.19.1",
      "typescript": "^5.6.3"
    }`.
  - `@types/node` is REQUIRED (not inherited): the tool
    uses `node:http` (fixture server), `node:test`,
    `process`, `NodeJS.*` types; pnpm does not hoist
    types across workspace packages.
- `tsconfig.json` extending `tsconfig.base.json`, outDir
  `dist`.
- `src/index.ts` — CLI entry.
- `src/config.ts` — Zod-validated env parsing.
- `src/http.ts` — the ONLY module allowed to import global
  `fetch`. Exposes `createTransport({ token?, timeoutMs,
  allowedEndpoints })` returning
  `{ get(pathKey): Promise<…> }` — no `method`, no
  arbitrary URL.
- `src/endpoints.ts` — closed allowlist mapping a stable
  `EndpointKey` (e.g. `INGESTION_HEALTH`,
  `RECON_HOLDS_ACTIVE`) to `{service, path, method: "GET"}`.
  Transport rejects unknown keys before any network call.
- `src/checks/` — per-service pure functions returning
  `CheckResult`.
- `src/schema.ts` — Zod schemas for every consumed response
  (fail-closed on malformed shape).
- `src/report.ts` — terminal + `--json` renderer with the
  masker.
- `src/mask.ts` — account-ID + credential redactor.
- `src/*.test.ts` — Node native test-runner scenarios.

Assumption: `zod`, `tsx`, `typescript`, `@types/node` are
declared as EXPLICIT dependencies of the new package
because pnpm workspaces do not hoist by default.

### 3.3 Config precedence

- `PAPER_VERIFY_INGESTION_URL` (default
  `http://127.0.0.1:3101`).
- `PAPER_VERIFY_SIGNAL_URL` (default
  `http://127.0.0.1:3102`).
- `PAPER_VERIFY_EXECUTION_URL` (default
  `http://127.0.0.1:3103`).
- Token precedence:
  `PAPER_VERIFY_EXECUTION_TOKEN` → `EXECUTION_API_TOKEN`.
  If both empty AND execution URL configured →
  `CONFIG_ERROR`. Token value is redacted from every log,
  stderr, JSON output, and error message.
- `PAPER_VERIFY_TIMEOUT_MS` (default `4000`, per request).
- `PAPER_VERIFY_ALLOW_NON_LOOPBACK` (default `false`).
- `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY` (default `false`)
  — opt-in for the side-effect-bearing
  `GET /execution/account/summary`.
- `PAPER_VERIFY_RUNTIME_EXPECTED_STATE`
  (`registered` | `absent`; default `registered`).
- `PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE`
  (`registered` | `absent`; default `absent`).
- `PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE`
  (`enabled` | `disabled` | `absent`; default `absent`).

Config dependency validation (`CONFIG_ERROR` on any
violation, checked before any request):

Allowed combinations (`RUNTIME` × `EXECUTION_RUNTIME` ×
`TRADING_LOOP`):

| RUNTIME | EXECUTION_RUNTIME | TRADING_LOOP |
|---|---|---|
| `absent` | `absent` | `absent` |
| `registered` | `absent` | `absent` |
| `registered` | `registered` | `enabled` |
| `registered` | `registered` | `disabled` |

Every other combination is a `CONFIG_ERROR`. Fail-fast
rejection reasons emitted verbatim:

- `RUNTIME=absent` + `EXECUTION_RUNTIME=registered`
  → `CONFIG_ERROR: execution_runtime_requires_runtime`.
- `EXECUTION_RUNTIME=absent` + `TRADING_LOOP=enabled`
  → `CONFIG_ERROR: trading_loop_requires_execution_runtime`.
- `EXECUTION_RUNTIME=absent` + `TRADING_LOOP=disabled`
  → `CONFIG_ERROR: trading_loop_requires_execution_runtime`.
- `EXECUTION_RUNTIME=registered` + `TRADING_LOOP=absent`
  → `CONFIG_ERROR:
    trading_loop_endpoints_always_registered_with_execution_runtime`.

Rationale: the actual signal-engine branch
(`apps/signal-engine/src/index.ts:280–378`) registers the
trading-loop routes in the SAME `if (executionRuntime.enabled)`
block as `/runtime/execute`. `TRADING_LOOP=absent` is
physically impossible whenever execution runtime is
`registered`.
- `PAPER_VERIFY_MAX_TICK_AGE_MS` (default `120000`).
- `PAPER_VERIFY_MAX_CANDLE_AGE_MS` (default `180000`).
- `PAPER_VERIFY_MAX_MARKET_STATE_AGE_MS` (default
  `120000`).

URL validation:

- Parse via `new URL(...)`; reject if
  `username || password` is non-empty (`CONFIG_ERROR`).
- Hostname MUST be `localhost` / `127.0.0.1` / `::1`
  unless `PAPER_VERIFY_ALLOW_NON_LOOPBACK=true`.
- Errors NEVER include the URL search string or any
  credentials.

### 3.4 GET-only enforcement

- `http.ts` internally hard-codes `method: "GET"` and never
  accepts a `method` argument.
- `endpoints.ts` is the CLOSED allowlist. Transport rejects
  any `EndpointKey` outside it BEFORE any network call.
- ESLint: add `no-restricted-globals` rule for `fetch`
  scoped to
  `tools/paper-verify-stack/src/**` EXCEPT `src/http.ts`.
- Transport test: wrap `fetch` under test with a spy that
  records every `(url, method)` pair; assertion — every
  recorded method is `"GET"` AND every path is in the
  allowlist.

Contract-drift note: `tsc`/`pnpm build` only verifies
local TypeScript types. The Zod schemas verify the
_expected_ shape used in tests via fixtures; the real
contract with running services is only exercised when
`pnpm paper:verify-stack` runs against an actual stack.
A silent shape change in a service therefore surfaces at
tool run-time (as `malformed_response` → `UNHEALTHY`),
not at build-time.

### 3.5 Endpoint allowlist (initial)

| Key | Path | Auth | Freshness source |
|---|---|---|---|
| INGESTION_HEALTH | `/health` | — | `lastTickAt`, `lastCandleAt` |
| INGESTION_WATCHLIST | `/watchlist` | — | `watchlist[].marketState.ts` (+ `latestCandle1m.ts`) |
| SIGNAL_HEALTH | `/health` | — | — |
| SIGNAL_RUNTIME_HEALTH | `/runtime/health` | — | — |
| SIGNAL_RUNTIME_READY | `/runtime/ready` | — | — |
| SIGNAL_EXECUTE_READY | `/runtime/execute/ready` | — | — |
| SIGNAL_LOOP_STATUS | `/runtime/trading-loop/status` | — | `nextCycleAt`, `lastCycleAt` |
| SIGNAL_LOOP_READY | `/runtime/trading-loop/ready` | — | — |
| EXECUTION_HEALTH | `/health` | — | — |
| EXECUTION_READY | `/ready` | Bearer | — |
| EXECUTION_KILL_SWITCH | `/execution/kill-switch` | Bearer | `diagnostics.complete`, `diagnostics.snapshotCacheAgeMs` |
| RECON_LATEST | `/execution/reconciliation/latest` | Bearer | `stale`, `maxAgeSeconds`, `run.snapshotComplete`, `run.status` |
| RECON_HOLDS_ACTIVE | `/execution/reconciliation/holds?active=true` | Bearer | — |
| EXECUTION_ACCOUNT_SUMMARY | `/execution/account/summary` | Bearer | opt-in only |

### 3.6 Conditional checks & 404 handling

- Ingestion checks always attempted.
- Signal-engine base `/health` always attempted.
- Runtime checks (driven by `RUNTIME_EXPECTED_STATE`):
  - `absent` → skip `SIGNAL_RUNTIME_*` entirely, report
    `DISABLED`; no request issued.
  - `registered` AND HTTP 404 → `UNHEALTHY` (contract
    mismatch — 404 is NEVER auto-interpreted as
    “wyłączony”).
- Execution-runtime checks
  (`EXECUTION_RUNTIME_EXPECTED_STATE`):
  - `absent` → skip `SIGNAL_EXECUTE_READY` and both
    `SIGNAL_LOOP_*` endpoints, report `DISABLED`; no
    request issued.
  - `registered` AND HTTP 404 → `UNHEALTHY`.
- Trading-loop scheduler
  (`TRADING_LOOP_EXPECTED_STATE`, requires
  `EXECUTION_RUNTIME_EXPECTED_STATE=registered`):
  - `absent` → skip `SIGNAL_LOOP_STATUS` +
    `SIGNAL_LOOP_READY`, report `DISABLED`.
  - `disabled` AND response `enabled=false` → `DISABLED`
    (intentional off-state).
  - `disabled` AND response `enabled=true` → `UNHEALTHY`
    (unexpected activation).
  - `enabled` AND response `enabled=false` → `UNHEALTHY`
    (expected scheduler is off).
  - `enabled` AND response `enabled=true` → evaluate
    readiness via `SIGNAL_LOOP_READY` (checks aggregate).
- Account summary: only invoked when
  `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true`.

Every consumed response is parsed through a Zod schema;
parse failure → `UNHEALTHY` for that check with `reason:
malformed_response`, no payload logged. Malformed one
check does NOT abort the remaining checks.

### 3.7 Freshness sources

- Ingestion: `Date.now() - Date.parse(lastTickAt) <=
  PAPER_VERIFY_MAX_TICK_AGE_MS`; same for `lastCandleAt`
  vs `PAPER_VERIFY_MAX_CANDLE_AGE_MS`; per-symbol
  `marketState.ts` vs
  `PAPER_VERIFY_MAX_MARKET_STATE_AGE_MS`.
- Reconciliation: use `body.stale`,
  `body.maxAgeSeconds`, `body.run?.snapshotComplete`,
  `body.run?.status` directly. Do NOT invent fields the
  endpoint does not return.
- The tool has NO trading-hours / session-calendar
  awareness. `latestCandle1m` older than
  `PAPER_VERIFY_MAX_CANDLE_AGE_MS` may be surfaced as
  `DEGRADED` (informational), but the tool MUST NOT
  claim the market is “outside RTH” or otherwise
  synthesise a session status.

## 4. Status precedence + exit codes

Severity ordering used only for `CONFIG_ERROR`,
`UNREACHABLE`, `UNHEALTHY`, `DEGRADED`, `HEALTHY`:
`CONFIG_ERROR > UNREACHABLE > UNHEALTHY > DEGRADED >
HEALTHY`.

`DISABLED` is **neutral in aggregation**:

- `DISABLED` never lowers a `HEALTHY` verdict.
- When another check has any of
  `{CONFIG_ERROR, UNREACHABLE, UNHEALTHY, DEGRADED}`,
  that one dominates; `DISABLED` is ignored.
- If EVERY executed check reports `DISABLED` (i.e. every
  expected component was configured `absent`), the
  aggregate verdict is `DISABLED`.
- `HEALTHY` and `DISABLED` both exit `0`.

| Verdict | Exit code |
|---|---|
| HEALTHY | 0 |
| DISABLED (aggregate) | 0 |
| DEGRADED | 40 |
| UNHEALTHY | 30 |
| UNREACHABLE | 20 |
| CONFIG_ERROR | 10 |

### 4.1 HTTP response taxonomy (applied per-check
before severity aggregation)

- Timeout / `ECONNREFUSED` / `EAI_AGAIN` / other DNS or
  transport failure → `UNREACHABLE`.
- Endpoint requires Bearer AND response is HTTP 401 or
  403 → `CONFIG_ERROR` (`reason: auth_rejected`); the
  token value MUST NOT appear in the error.
- Endpoint expected to exist (per expected-state matrix)
  AND HTTP 404 → `UNHEALTHY`
  (`reason: endpoint_not_registered`).
- Any other HTTP 4xx / 5xx that carries no readiness
  body → `UNHEALTHY` (`reason: http_<status>`).
- HTTP 2xx AND body fails Zod parse → `UNHEALTHY`
  (`reason: malformed_response`); no payload logged.
- Readiness endpoints (`/ready`, `/runtime/ready`,
  `/runtime/execute/ready`,
  `/runtime/trading-loop/ready`): body `ready === false`
  is `UNHEALTHY` even when HTTP 200; HTTP 503 accompanied
  by a parseable readiness body is `UNHEALTHY`
  (not `UNREACHABLE`).

### 4.2 Blocking-vs-informational mapping

- Broker disconnected
  (`EXECUTION_HEALTH.twsConnected=false`) → `UNHEALTHY`.
- `EXECUTION_READY` (exact response shape from
  `apps/execution-engine/src/readiness.ts`:
  `{ready, environment, tradingEnabled, account,
    reconciliation: { ageSeconds, maxAgeSeconds,
    lastRanAt },
    checks: { brokerSocket, activeAccountKnown,
      accountMatchesEnvironment, auditWriteAvailable,
      reconciliationFresh, positionSnapshotHealthy },
    reasons: string[]}`; `checks.*` values are raw
  booleans, NOT `{ok, error?}` objects):
  - `ready === false` → `UNHEALTHY`.
  - `environment !== "paper"` → `UNHEALTHY`.
  - `account === null` → `UNHEALTHY`.
  - Any `checks.<name> === false` → `UNHEALTHY`.
  - `reasons.length > 0` → `UNHEALTHY`.
  - Any required field missing / body fails Zod parse →
    `UNHEALTHY` (`reason: malformed_response`, no
    payload logged).
- `RECON_LATEST.stale=true` → `UNHEALTHY`.
- `RECON_HOLDS_ACTIVE` non-empty → `UNHEALTHY` (active
  holds block submission per `submission-gate.ts`).
- Stale required market data (ingestion `/health`
  `lastTickAt` older than threshold) → `UNHEALTHY`.
- Kill-switch classification — see §4.4 below.
- `latestCandle1m` older than
  `PAPER_VERIFY_MAX_CANDLE_AGE_MS` → `DEGRADED`
  (informational, non-blocking; no session-status
  inference).

### 4.3 Per-service health rules

Ingestion (`GET /health`, `GET /watchlist`):

- `ok !== true` → `UNHEALTHY`.
- `connected !== true` → `UNHEALTHY`.
- `bootstrapped !== true` → `UNHEALTHY`.
- `watchlist.length === 0` → `UNHEALTHY`.
- No `watchlist[i].subscribed === true` → `UNHEALTHY`.
- For every `subscribed=true` entry: missing `conid` or
  missing `marketState` → `UNHEALTHY`.
- `marketState.ts` older than
  `PAPER_VERIFY_MAX_MARKET_STATE_AGE_MS` for any required
  symbol → `UNHEALTHY`.

Signal-engine base (`GET /health`):

- `ok !== true` → `UNHEALTHY`.

Signal-engine runtime
(`GET /runtime/health`, `GET /runtime/ready`,
`GET /runtime/execute/ready`,
`GET /runtime/trading-loop/ready`):

- `/runtime/health`: `ok !== true` → `UNHEALTHY`.
- `/runtime/ready` +
  `/runtime/trading-loop/ready`: readiness body is
  `{ready, ...checks: Record<string, {ok, error?}>}`.
  `ready === false` → `UNHEALTHY`; any
  `checks.<name>.ok === false` → `UNHEALTHY` (name
  surfaced, no payload logged beyond it).
- `/runtime/execute/ready`: verified in
  `apps/signal-engine/src/runtime/execution/routes.ts:80`.
  Shape is
  `{ready: boolean,
    checks: { redis: {ok, error?},
              postgres: {ok, error?},
              paperGuard: {ok, error?} }}`
  with HTTP 200 when `ready=true` and HTTP 503 when
  `ready=false`. Classification:
  - `ready !== true` → `UNHEALTHY`.
  - `checks.redis.ok !== true` → `UNHEALTHY`.
  - `checks.postgres.ok !== true` → `UNHEALTHY`.
  - `checks.paperGuard.ok !== true` → `UNHEALTHY`.
  - Any required field missing → `UNHEALTHY`
    (`malformed_response`).
  - HTTP 503 with parseable body → `UNHEALTHY` (per
    §4.1 readiness rule).
  - HTTP 200 with `ready=false` → `UNHEALTHY`.

Signal-runtime readiness therefore uses the
`{ok, error?}` per-dependency shape; execution-engine
readiness uses raw booleans. The two contracts MUST
remain distinct in the schemas.

Execution-engine (`GET /health`, `GET /ready`):

- `/health`: `ok !== true` → `UNHEALTHY`;
  `twsConnected !== true` → `UNHEALTHY`.
- `/ready`: see §4.2 (booleans in `checks.*` + top-level
  `reasons: string[]` + `account`/`environment`/`ready`).

Trading-loop scheduler
(`SIGNAL_LOOP_STATUS` + `SIGNAL_LOOP_READY`, driven by
`TRADING_LOOP_EXPECTED_STATE`):

- `expected=disabled` AND response `enabled=false` →
  `DISABLED`.
- `expected=disabled` AND response `enabled=true` →
  `UNHEALTHY`.
- `expected=enabled` AND response `enabled=false` →
  `UNHEALTHY`.
- `expected=enabled` AND response `enabled=true` AND
  `SIGNAL_LOOP_READY.ready=false` → `UNHEALTHY`.
- `expected=enabled` AND response `enabled=true` AND
  `SIGNAL_LOOP_READY.ready=true` AND `running=false`
  after the operator-supplied startup grace has elapsed
  → `UNHEALTHY`. Grace is disabled by default; PR15.1
  does NOT introduce an implicit startup delay. Operators
  who need one set an explicit
  `PAPER_VERIFY_LOOP_STARTUP_GRACE_MS` (default `0`)
  and the tool documents the exact semantics used.

### 4.4 Kill-switch classification

Endpoint: `GET /execution/kill-switch` (Bearer;
verified: not in `publicPaths`, so
`registerExecutionAuth` protects it).

Additional env: `PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS`
(default `60000`).

**Cache dependency (verified):**
`apps/execution-engine/src/index.ts:1249` populates
`accountSnapshotCache` only inside the
`GET /execution/account/summary` handler.
`evaluateKillSwitch()` (`index.ts:640`) reads
`netLiquidation`, `fxToBaseByCurrency` and
`snapshotCacheAgeMs` from that same cache. A freshly-
booted process therefore returns
`enabled=true, triggered=false, netLiquidation=undefined,
snapshotCacheAgeMs=undefined` on the very first
`/kill-switch` call — the PCT limit cannot be
evaluated. The verify tool encodes this dependency
explicitly:

- **Opt-in path** (`PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true`):
  1. Issue `GET /execution/account/summary` FIRST.
  2. Classify the account-summary result per the global
     HTTP taxonomy (§4.1) — do NOT collapse every
     failure to `UNHEALTHY`. Preserve the original
     category (`UNREACHABLE` / `CONFIG_ERROR` /
     `UNHEALTHY`).
  3. If account-summary did NOT reach `HEALTHY`:
     - do NOT issue the kill-switch request;
     - record the kill-switch check as `UNHEALTHY` with
       `reason: dependency_failed_account_summary`;
     - keep the account-summary check's own verdict
       unchanged; the aggregate verdict follows the
       severity ordering in §4 (e.g. account summary
       `UNREACHABLE` + kill-switch `UNHEALTHY` →
       final `UNREACHABLE`; account summary
       `CONFIG_ERROR` → final `CONFIG_ERROR`; account
       summary `UNHEALTHY` → final `UNHEALTHY`).
  4. Only on account-summary `HEALTHY` → issue
     `GET /execution/kill-switch`.
- **Opt-out path** (default,
  `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=false`):
  - Kill-switch check runs on its own; missing
    `netLiquidation` / `snapshotCacheAgeMs` (i.e. cache
    unpopulated) at `enabled=true` → `UNHEALTHY`
    (`reason:
    kill_switch_cache_unpopulated`); the render adds a
    non-secret remediation hint:
    `enable PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true to
    refresh account cache`.
  - Runbook must note: reaching full HEALTHY on a fresh
    process may require the opt-in; account-summary is
    opt-in because it triggers `ensureBrokerSession` +
    `syncRecentExecutions` broker side-effects.

Classification (applied AFTER Zod parse of the response,
AFTER the above cache-population precondition):

- Malformed body → `UNHEALTHY` (per §4.1).
- `triggered=true` → `UNHEALTHY`.
- `enabled=true` AND
  (`netLiquidation` missing OR `<= 0`)
  → `UNHEALTHY`
  (`reason: kill_switch_netliquidation_unavailable`
  when opt-in path completed successfully; else
  `kill_switch_cache_unpopulated`).
- `enabled=true` AND `diagnostics.complete=false` →
  `UNHEALTHY` (`reason: kill_switch_incomplete`).
- `enabled=true` AND
  (`diagnostics.snapshotCacheAgeMs` missing OR
  `> PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS`)
  → `UNHEALTHY` (`reason: kill_switch_snapshot_stale`
  or `kill_switch_cache_unpopulated` as above).
- `enabled=true` AND `triggered=false` AND
  `diagnostics.complete=true` AND `netLiquidation > 0`
  AND `snapshotCacheAgeMs <= threshold` → `HEALTHY`.
- `enabled=false` → `DEGRADED` with note
  “daily-loss protection disabled” (informational,
  non-blocking).

## 5. Test plan
(`tools/paper-verify-stack/src/*.test.ts`, picked up by
root `pnpm test` via the workspace glob)

Uses `http.createServer` fixtures (no new deps) that replay
canned JSON per allowlisted path AND record every request.

- **A** — full healthy paper stack → `HEALTHY`, exit 0.
- **B** — execution-engine URL refuses connection →
  `UNREACHABLE`, exit 20.
- **C** — malformed JSON AND malformed shape (two
  sub-scenarios per endpoint) for EACH of the 14
  allowlisted checks. Each failing check flips to
  `UNHEALTHY` (reason `malformed_response`), exit 30
  overall; raw payload not logged; independent checks
  continue to execute. Coverage list (with expected
  states set to make each check active):
  `INGESTION_HEALTH`, `INGESTION_WATCHLIST`,
  `SIGNAL_HEALTH`, `SIGNAL_RUNTIME_HEALTH`,
  `SIGNAL_RUNTIME_READY`, `SIGNAL_EXECUTE_READY`,
  `SIGNAL_LOOP_STATUS`, `SIGNAL_LOOP_READY`,
  `EXECUTION_HEALTH`, `EXECUTION_READY`,
  `EXECUTION_KILL_SWITCH`, `RECON_LATEST`,
  `RECON_HOLDS_ACTIVE`,
  `EXECUTION_ACCOUNT_SUMMARY` (only when
  `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true`).
- **D** — fixture introduces > `timeoutMs` latency →
  request aborted, `UNREACHABLE`, exit 20; no orphan
  sockets.
- **E** — `EXECUTION_READY` reports `environment: "live"`
  → `UNHEALTHY`, exit 30.
- **F** — execution URL set but no token in either env
  name → `CONFIG_ERROR`, exit 10; neither env name nor
  any placeholder printed.
- **G** — ingestion `lastTickAt` older than
  `PAPER_VERIFY_MAX_TICK_AGE_MS` → `UNHEALTHY`, exit 30.
- **H** — `RECON_LATEST.stale=true` → `UNHEALTHY`, exit
  30.
- **I** — `RECON_HOLDS_ACTIVE` returns one active hold →
  `UNHEALTHY`, exit 30; hold reasons summarised, no
  payload dump.
- **J-set** — trading-loop expected-state matrix:
  - J1: `TRADING_LOOP_EXPECTED_STATE=disabled` +
    response `enabled=false` → `DISABLED`; verdict
    `HEALTHY` if everything else is fine.
  - J2: `disabled` + response `enabled=true` →
    `UNHEALTHY`, exit 30.
  - J3: `enabled` + response `enabled=false` →
    `UNHEALTHY`, exit 30.
  - J4: `enabled` + response `enabled=true` +
    `SIGNAL_LOOP_READY.ready=false` → `UNHEALTHY`,
    exit 30.
- **K** — `RUNTIME_EXPECTED_STATE=registered` AND
  `/runtime/health` returns 404 → `UNHEALTHY`, exit 30.
- **L** — `EXECUTION_RUNTIME_EXPECTED_STATE=absent` →
  tool skips `SIGNAL_EXECUTE_READY` and both
  `SIGNAL_LOOP_*` entirely; fixture assertion: no request
  recorded for those paths.
- **L2** — `RUNTIME_EXPECTED_STATE=absent` → tool skips
  `SIGNAL_RUNTIME_*` and all execution-runtime endpoints;
  no `/runtime/*` request recorded.
- **L3** — invalid expected-state combos →
  `CONFIG_ERROR`, exit 10:
  runtime `absent` + execution `registered`;
  execution `absent` + loop `enabled`;
  execution `absent` + loop `disabled`;
  execution `registered` + loop `absent`.
- **L4** — the four allowed combinations parse cleanly
  and drive the expected skip/attempt pattern; assertion:
  the request log matches the endpoint set implied by
  the state matrix.
- **M** — account IDs masked in every render
  (`DU-***234`); test scans the entire rendered output
  for the raw account.
- **N** — URL with credentials
  (`http://user:pw@127.0.0.1`) → `CONFIG_ERROR`, exit 10;
  no credential fragment in message.
- **O** — non-loopback URL without opt-in →
  `CONFIG_ERROR`, exit 10.
- **P** — transport request log assertion: EVERY recorded
  request has `method === "GET"` AND its path is in the
  allowlist; no request to `/execute-ticket`,
  `/execute-proposed`, `/reconciliation/run`,
  `/bootstrap`, `/stop`, `/acknowledge`, `/resolve`.
- **Q** — dynamic URL not registered in the allowlist →
  transport throws before any network call.
- **R** — token never appears in `--json` output,
  terminal output, or any error message (asserted by
  comparing the rendered strings against the token value).
- **S** — deterministic severity precedence: stale
  reconciliation + active hold + ingestion stale tick →
  final verdict `UNHEALTHY`, exit 30 (max of individual
  severities).
- **T** — `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=false`
  (default) → fixture assertion: no request to
  `/execution/account/summary`.
- **U** — workspace assertion (documented + enforced in
  CI): `pnpm --filter @ikbr/paper-verify-stack test` and
  root `pnpm test` both run this suite.
- **V-set** — `EXECUTION_KILL_SWITCH`:
  - V1: `enabled=true, triggered=false, complete=true,
    netLiquidation>0, snapshotCacheAgeMs<=threshold` →
    `HEALTHY`.
  - V2: `triggered=true` → `UNHEALTHY`, exit 30.
  - V3: `enabled=true, complete=false` → `UNHEALTHY`.
  - V4: `enabled=true, netLiquidation` missing →
    `UNHEALTHY`.
  - V4b: `enabled=true, netLiquidation<=0` →
    `UNHEALTHY`.
  - V5a: `enabled=true, snapshotCacheAgeMs` missing →
    `UNHEALTHY`.
  - V5b: `enabled=true, snapshotCacheAgeMs >
    PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS` →
    `UNHEALTHY`.
  - V6: `enabled=false` → `DEGRADED`, exit 40, note
    string cites disabled protection.
  - V7: malformed body → `UNHEALTHY` (covered by C).
  - V8: token value never appears in the kill-switch
    check output (extends R).
- **W-set** — HTTP taxonomy (per §4.1):
  - W1: connection refused → `UNREACHABLE`, exit 20.
  - W2: request exceeds `PAPER_VERIFY_TIMEOUT_MS` →
    `UNREACHABLE`, exit 20.
  - W3: Bearer endpoint returns 401 → `CONFIG_ERROR`,
    exit 10; error message contains no token substring.
  - W4: Bearer endpoint returns 403 → `CONFIG_ERROR`,
    exit 10.
  - W5: expected endpoint returns 404 → `UNHEALTHY`,
    exit 30.
  - W6: readiness returns HTTP 200 with `ready=false` →
    `UNHEALTHY`, exit 30.
  - W7: readiness returns HTTP 503 with parseable body →
    `UNHEALTHY`, exit 30 (not `UNREACHABLE`).
  - W8: arbitrary HTTP 500 without readiness shape →
    `UNHEALTHY`, exit 30.
- **X-set** — per-service health rules (§4.3):
  - X1: ingestion `ok=false` → `UNHEALTHY`.
  - X1b: ingestion `ok` missing → `UNHEALTHY`
    (`malformed_response`).
  - X2: ingestion `connected=false` → `UNHEALTHY`.
  - X3: ingestion `bootstrapped=false` → `UNHEALTHY`.
  - X4: watchlist empty → `UNHEALTHY`.
  - X5: no `subscribed=true` entry → `UNHEALTHY`.
  - X6: `subscribed=true` with missing `conid` →
    `UNHEALTHY`.
  - X7: `subscribed=true` with `marketState=null` →
    `UNHEALTHY`.
  - X8: `marketState.ts` older than threshold on a
    required symbol → `UNHEALTHY`.
  - X9a: `SIGNAL_HEALTH.ok=false` (or missing) →
    `UNHEALTHY`.
  - X9b: `SIGNAL_RUNTIME_HEALTH.ok=false` (or missing)
    → `UNHEALTHY`.
  - X9c: `EXECUTION_HEALTH.ok=false` (or missing) →
    `UNHEALTHY`.
  - X10: `SIGNAL_RUNTIME_READY.ready=false` →
    `UNHEALTHY`.
  - X10b: signal runtime readiness with any
    `checks.<name>.ok=false` → `UNHEALTHY`.
  - X10c: `SIGNAL_EXECUTE_READY.ready=false` →
    `UNHEALTHY`.
  - X10d: `SIGNAL_EXECUTE_READY.checks.redis.ok=false`
    → `UNHEALTHY`.
  - X10e: `SIGNAL_EXECUTE_READY.checks.postgres.ok=false`
    → `UNHEALTHY`.
  - X10f:
    `SIGNAL_EXECUTE_READY.checks.paperGuard.ok=false` →
    `UNHEALTHY`.
  - X10g: `SIGNAL_EXECUTE_READY` missing `checks.redis`
    / `checks.postgres` / `checks.paperGuard` (three
    sub-scenarios) → `UNHEALTHY`
    (`malformed_response`).
  - X10h: `SIGNAL_EXECUTE_READY` returns HTTP 503 with a
    parseable body (`{ready:false, checks:{...}}`) →
    `UNHEALTHY` (per §4.1 readiness rule; NOT
    `UNREACHABLE`).
  - X10i: `SIGNAL_EXECUTE_READY` returns HTTP 200 with
    `ready=true` and every `checks.*.ok=true` →
    `HEALTHY` for this check.
  - X11a: `EXECUTION_READY.ready=false` → `UNHEALTHY`.
  - X11b: `EXECUTION_READY.environment="live"` →
    `UNHEALTHY`.
  - X11c: `EXECUTION_READY.account=null` →
    `UNHEALTHY`.
  - X11d: any `EXECUTION_READY.checks.<name>=false`
    (raw boolean; NOT `{ok}`) → `UNHEALTHY`.
  - X11e: `EXECUTION_READY.reasons` non-empty →
    `UNHEALTHY`.
  - X11f: `EXECUTION_READY` missing any required field
    → `UNHEALTHY` (`malformed_response`).
- **Y-set** — DISABLED aggregation neutrality (pure
  aggregator unit tests — base health checks are ALWAYS
  executed so a real end-to-end run cannot legitimately
  reach an all-DISABLED verdict; these tests exercise the
  aggregator in isolation):
  - Y1: some checks HEALTHY + others DISABLED (execution
    runtime absent) → `HEALTHY`, exit 0.
  - Y2 (aggregator only): every check DISABLED →
    `DISABLED`, exit 0.
  - Y3: DEGRADED + DISABLED → `DEGRADED`, exit 40.
  - Y4: UNHEALTHY + DISABLED → `UNHEALTHY`, exit 30.
  - Y5: UNREACHABLE + DISABLED → `UNREACHABLE`, exit
    20.
- **Z-set** — account-summary / kill-switch cache
  coupling (§4.4):
  - Z1: opt-out (default) + fresh process (cache empty)
    + kill-switch `enabled=true` → `UNHEALTHY` (reason
    `kill_switch_cache_unpopulated`); rendered output
    contains the remediation hint
    `enable PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true`.
  - Z2: opt-in + account-summary HTTP 2xx + valid schema
    + fresh kill-switch cache → `HEALTHY`; fixture
    request-log assertion: account-summary precedes
    kill-switch, kill-switch was issued.
  - Z3a: opt-in + account-summary connection refused →
    account-summary `UNREACHABLE`; kill-switch check
    recorded `UNHEALTHY /
    dependency_failed_account_summary`; fixture
    assertion: NO kill-switch request issued; aggregate
    verdict `UNREACHABLE` (exit 20).
  - Z3b: opt-in + account-summary exceeds
    `PAPER_VERIFY_TIMEOUT_MS` → account-summary
    `UNREACHABLE`; kill-switch NOT issued; aggregate
    `UNREACHABLE`.
  - Z3c: opt-in + account-summary DNS failure →
    account-summary `UNREACHABLE`; kill-switch NOT
    issued; aggregate `UNREACHABLE`.
  - Z4a: opt-in + account-summary returns HTTP 401 →
    account-summary `CONFIG_ERROR` (no token substring
    in output); kill-switch NOT issued; aggregate
    `CONFIG_ERROR` (exit 10).
  - Z4b: opt-in + account-summary returns HTTP 403 →
    account-summary `CONFIG_ERROR`; kill-switch NOT
    issued; aggregate `CONFIG_ERROR`.
  - Z5a: opt-in + account-summary returns malformed
    body → account-summary `UNHEALTHY`
    (`malformed_response`); kill-switch NOT issued;
    aggregate `UNHEALTHY` (exit 30).
  - Z5b: opt-in + account-summary returns HTTP 503 or
    HTTP 500 → account-summary `UNHEALTHY`; kill-switch
    NOT issued; aggregate `UNHEALTHY`.
  - Z5c: opt-in + account-summary returns HTTP 404 →
    account-summary `UNHEALTHY`; kill-switch NOT
    issued; aggregate `UNHEALTHY`.
  - Z6: opt-out (default) + fixture assertion: no
    request to `/execution/account/summary`.
  - Z7: assertion across Z3–Z5: kill-switch verdict
    (`UNHEALTHY /
    dependency_failed_account_summary`) NEVER lowers
    the aggregate below the account-summary category
    — the aggregate follows §4 severity ordering,
    not the kill-switch's local category.

## 6. CLI contract

```
Usage:
  pnpm paper:verify-stack          # table output
  pnpm paper:verify-stack --json   # machine-readable
Env:
  PAPER_VERIFY_{INGESTION,SIGNAL,EXECUTION}_URL
  PAPER_VERIFY_EXECUTION_TOKEN | EXECUTION_API_TOKEN
  PAPER_VERIFY_TIMEOUT_MS
  PAPER_VERIFY_ALLOW_NON_LOOPBACK={true|false}
  PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY={true|false}
  PAPER_VERIFY_RUNTIME_EXPECTED_STATE={registered|absent}
  PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE={registered|absent}
  PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE={enabled|disabled|absent}
  PAPER_VERIFY_MAX_{TICK,CANDLE,MARKET_STATE}_AGE_MS
  PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS
  PAPER_VERIFY_LOOP_STARTUP_GRACE_MS
Exit codes:
  0 HEALTHY | 10 CONFIG_ERROR | 20 UNREACHABLE
  30 UNHEALTHY | 40 DEGRADED
```

## 7. CI plan

Amend `.github/workflows/ci.yml`:

- Insert `- run: pnpm lint` between `pnpm install
  --frozen-lockfile` and `pnpm typecheck`. Mandatory step.
- Keep `pnpm test:integration` unchanged (verified:
  Postgres service, explicit `TEST_POSTGRES_URL`, PG
  suites all green).
- Ensure the tool's `test` script runs under root
  `pnpm test` — automatic once the workspace globs cover
  it.

## 8. Runbook

`docs/runbooks/PAPER_STACK_VERIFICATION.md`:

- Prereqs (Docker, `.env` from `.env.example`,
  `TRADING_LOOP_ENABLED=false`, `IBKR_ENVIRONMENT=paper`).
- Safe defaults callout (execution disabled everywhere).
- `docker compose up -d postgres redis ingestion
  signal-engine execution-engine`.
- `pnpm install --frozen-lockfile` (needed after workspace
  change).
- `pnpm paper:verify-stack` → interpret table + exit
  codes.
- Explicit expectation-env matrix
  (`RUNTIME_EXPECTED_STATE`,
  `EXECUTION_RUNTIME_EXPECTED_STATE`,
  `TRADING_LOOP_EXPECTED_STATE`) with the four allowed
  combinations enumerated and the four fail-fast
  `CONFIG_ERROR` reasons cited.
- Kill-switch env
  (`PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS`,
  default `60000`) and the resulting HEALTHY/UNHEALTHY/
  DEGRADED matrix.
- Optional `PAPER_VERIFY_LOOP_STARTUP_GRACE_MS` semantics
  (default `0`, i.e. no grace).
- Troubleshooting matrix: IB Gateway down, Redis absent,
  Postgres migrations lagging, `EXECUTION_API_TOKEN`
  empty, stale market data, reconciliation stale or held.
- Explicit warning: **PR15.1 does not activate any
  instrument and does not submit orders.**

## 9. Risks & rollback

- Risk: renaming envs in docs contradicts running
  services → covered by Zod parsing in each service's
  `config.ts`; docs never touched at runtime.
- Risk: adding `tools/*` to the workspace pulls the new
  package into `pnpm -r` scripts before its own
  dependencies land → mitigated by declaring explicit
  `dependencies` on `zod` and `devDependencies` on
  `tsx`, `typescript`, `@types/node`; `pnpm install`
  regenerates `pnpm-lock.yaml` so the new resolutions
  are captured before any tool code runs.
- Risk: verify tool accidentally issues a mutating
  request → three layers: `http.ts` hard-coded `GET`,
  closed endpoint allowlist, transport-log assertions in
  tests.
- Rollback: revert PR15.1 commits; no schema changes, no
  runtime deps in any existing service.

## 10. Acceptance Criteria

- Every Phase 2 doc references the actual endpoints
  (`/execution/execute-ticket`,
  `/execution/reconciliation/…`) and the actual env names
  (`TRADING_LOOP_*`, `EXECUTION_RUNTIME_*`,
  `RECONCILIATION_*`, `RUNTIME_ENABLED`).
- OD-1..OD-6 annotated with resolution + code pointer.
- CI runs `pnpm lint` as a mandatory step before
  typecheck.
- `pnpm-workspace.yaml` and root `package.json.workspaces`
  cover `tools/*`; `pnpm install --frozen-lockfile`
  succeeds; `pnpm-lock.yaml` regenerated (via a prior
  `pnpm install` run) to capture `zod`, `tsx`,
  `typescript`, `@types/node` resolutions for the new
  package.
- `@ikbr/paper-verify-stack` declares EXPLICIT
  `devDependencies` on `@types/node`, `tsx`,
  `typescript` (pnpm workspaces do not hoist types /
  runtime deps); `zod` in `dependencies`. `@types/node`
  is mandatory because the tool consumes `node:http`,
  `node:test`, `process`, and `NodeJS.*` types.
- `@ikbr/paper-verify-stack` package exists with its own
  `test`, `typecheck`, `build`, `start` scripts.
- `pnpm paper:verify-stack` runs the tool via the
  workspace filter.
- Verify tool covers ALL 14 allowlisted endpoints
  (`INGESTION_HEALTH`, `INGESTION_WATCHLIST`,
  `SIGNAL_HEALTH`, `SIGNAL_RUNTIME_HEALTH`,
  `SIGNAL_RUNTIME_READY`, `SIGNAL_EXECUTE_READY`,
  `SIGNAL_LOOP_STATUS`, `SIGNAL_LOOP_READY`,
  `EXECUTION_HEALTH`, `EXECUTION_READY`,
  `EXECUTION_KILL_SWITCH`, `RECON_LATEST`,
  `RECON_HOLDS_ACTIVE`, `EXECUTION_ACCOUNT_SUMMARY`),
  including malformed-JSON + malformed-shape tests for
  each.
- Expected-state invariants enforced: only the four
  allowed combinations parse; every other combination
  is `CONFIG_ERROR`.
- HTTP taxonomy (§4.1) tested: timeout /
  ECONNREFUSED / 401 / 403 / 404 / 4xx / 5xx / 503 with
  readiness body / 200 with `ready=false` / malformed
  body.
- Per-service health rules (§4.3) tested. `EXECUTION_
  READY` schema uses the ACTUAL contract from
  `apps/execution-engine/src/readiness.ts`:
  `checks: { brokerSocket, activeAccountKnown,
    accountMatchesEnvironment, auditWriteAvailable,
    reconciliationFresh, positionSnapshotHealthy }`
  as raw booleans plus top-level
  `reasons: string[]`. NO `{ok, error?}` object per
  check on execution-engine (that shape belongs to
  signal-runtime readiness only).
- Kill-switch account-snapshot freshness enforced via
  `PAPER_VERIFY_MAX_ACCOUNT_SNAPSHOT_AGE_MS`; missing or
  stale `snapshotCacheAgeMs` under `enabled=true` →
  `UNHEALTHY`. Fresh-process cache coupling (§4.4)
  covered by Z-set tests. Opt-in path issues
  account-summary BEFORE kill-switch and preserves the
  account-summary's own HTTP-taxonomy category
  (`UNREACHABLE` / `CONFIG_ERROR` / `UNHEALTHY`); on any
  non-HEALTHY account-summary the kill-switch request is
  NOT issued and the kill-switch check records
  `UNHEALTHY / dependency_failed_account_summary`. The
  aggregate verdict follows §4 severity ordering.
- `SIGNAL_EXECUTE_READY` classification (§4.3 X10c–X10i):
  `ready`, `checks.redis.ok`, `checks.postgres.ok`,
  `checks.paperGuard.ok` each drive `UNHEALTHY` on
  failure; missing sub-check → `malformed_response`;
  HTTP 503 with parseable body → `UNHEALTHY`;
  HTTP 200 with `ready=true` and every `checks.*.ok=true`
  → the endpoint's HEALTHY.
- `DISABLED` is neutral in aggregation: HEALTHY +
  DISABLED = HEALTHY (exit 0); all-DISABLED = DISABLED
  (exit 0) verified only via a pure-aggregator unit
  test (base health checks always run in real E2E);
  any UNHEALTHY / DEGRADED / UNREACHABLE /
  CONFIG_ERROR dominates.
- Verify tool code path uses ONLY GET; transport rejects
  unknown endpoint keys; ESLint `no-restricted-globals`
  blocks `fetch` outside `src/http.ts`.
- Verify tool cannot submit, cancel, reset, run
  reconciliation, bootstrap, or resolve a hold — asserted
  by transport request-log tests.
- Bearer token + account IDs never appear in tool logs,
  errors, or JSON output (asserted).
- All response bodies parsed through Zod; malformed →
  `UNHEALTHY`.
- Response interpretation uses only fields actually
  returned by each endpoint (ingestion `connected`,
  watchlist `marketState.ts`, reconciliation `stale` /
  `maxAgeSeconds` / `run.snapshotComplete`).
- Root `pnpm test`, `pnpm typecheck`, `pnpm build`,
  `pnpm lint`, `pnpm test:integration`, `git diff --check`
  all pass.
- `pnpm paper:verify-stack --json` executed against a
  fixture stack completes without any mutating request
  (verified in tests).
- Tooling tests run under root `pnpm test`.
- No change to trading behaviour, strategy, risk, ticket
  builder, submission service, reconciliation logic, or
  broker adapter.

## 11. Explicit exclusions

- No `executionEnabled=true` flip anywhere.
- No `executionPolicy` change.
- No SI / PL / futures conflict resolution.
- No futures roll implementation.
- No live paper-broker test order.
- No signal / risk / decision logic touched.
- No exit management.
- No change to reconciliation semantics or to the
  `submission-service` outcome union.
- LLM agent stays off; no new integration.
- Live enablement stays off; no change to
  `IBKR_ENVIRONMENT` handling.
- No AGENTS.md edit.

## 12. Suggested commit sequence

1. `chore(workspace): add tools/* to workspaces; scaffold
   @ikbr/paper-verify-stack package with explicit deps`.
2. `docs(phase2): resolve OD-1..OD-6; rename ORCH_* → real
   env family; correct ticket endpoint path`.
3. `docs(phase2): update RUNTIME_FLOW / STATE / FAILURE
   for PR15 semantics`.
4. `docs(phase2): PHASE_2_ROADMAP status stamp +
   PR15.1–15.3 sub-tracks; note entry-only loop + legacy
   LLM`.
5. `ci: run pnpm lint as mandatory step`.
6. `feat(tools): paper:verify-stack — GET-only allowlisted
   stack probe (transport + endpoints + schemas)`.
7. `test(tools): paper:verify-stack fixture scenarios
   A–Z (severity, allowlist, mask, expectations,
   HTTP taxonomy, per-service health, kill-switch cache
   coupling)`.
8. `docs(runbooks): PAPER_STACK_VERIFICATION runbook`.

## 13. Post-implementation verification (MUST run)

```
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
git diff --check
pnpm paper:verify-stack --json    # against local fixture/stack
```

Additionally confirm from the resulting logs / test
output:

- No mutating request was issued by the tool (transport
  request log ⊆ `{ GET × allowlisted paths }`).
- Every tooling test executed under root `pnpm test`
  (workspace inclusion visible in the aggregated
  summary).

## 14. Open decisions

1. **Runbook location** — `docs/runbooks/` does not yet
   exist. **Resolution**: create it as part of PR15.1
   (single new file `PAPER_STACK_VERIFICATION.md`).
   **Consequence for tests**: fixture-independent test
   asserts the runbook file exists at the expected path
   (guards against accidental revert).
2. **Trading-loop status shape** — verified in
   `apps/signal-engine/src/runtime/trading-loop/routes.ts:57`:
   response is
   `{enabled: boolean, running: boolean,
     startedAt: string|null, lastCycleAt: string|null,
     nextCycleAt: string|null,
     activeInstruments: string[], cycleCount: number,
     lastOutcomes: Record<string, {
       cycleId, instrumentId, startedAt, finishedAt,
       durationMs, outcome: { kind, idempotencyKey?,
         reason?, message? }
     }>}`.
   **Resolution**: encode this exact shape (with the
   nullable timestamps and optional `outcome` fields) in
   the Zod schema; verdict logic reads only `enabled`,
   `running`, `nextCycleAt`, `lastCycleAt`.
   **Consequence for tests**: schema test asserts every
   field on the fixture matches the route response;
   drift surfaces at run-time as `malformed_response`.
3. **Bearer scope on signal-engine runtime GETs** —
   verified in
   `apps/signal-engine/src/runtime/execution/routes.ts:80`:
   `GET /runtime/execute/ready` is registered without a
   Bearer preHandler; only `POST /runtime/execute` uses
   Bearer. **Resolution**: verify tool sends no
   `Authorization` header to `/runtime/execute/ready`
   (and to `/runtime/*` in general).
   **Consequence for tests**: fixture request-log
   assertion — no `authorization` header on any signal-
   engine request; only execution-engine Bearer-protected
   endpoints receive it.
