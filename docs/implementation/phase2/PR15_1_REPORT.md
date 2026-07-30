# PR15.1 — Runtime Truth & Paper Operator Tooling — REPORT

> Sub-track of PR15 (`87eff1c`). Blocks PR15.2 (authoritative
> instrument binding) and PR15.3 (entry-only Paper E2E).
> **This report closes PR15.1 only.** PR15.2 and PR15.3
> remain pending and were not started by this change.

## 1. Scope delivered

Aligned with [PR15_1_PLAN.md](PR15_1_PLAN.md):

1. Phase 2 documentation reconciled against shipped PR11–PR15
   runtime truth (real endpoints, real env names, OD-1..OD-6
   resolutions, no fictional `POST /execution/tickets`, no
   fictional `ORCH_*` family).
2. `tools/*` added to `pnpm-workspace.yaml` and root
   `package.json.workspaces`; `pnpm-lock.yaml` regenerated
   consistently.
3. CI (`.github/workflows/ci.yml`) runs `pnpm lint` as a
   mandatory step between `pnpm install --frozen-lockfile`
   and `pnpm typecheck`.
4. New workspace `@ikbr/paper-verify-stack` under
   `tools/paper-verify-stack/`: read-only, GET-only,
   allowlist-bound stack verifier with Zod-validated response
   schemas, redactor, JSON + table renderers, closed
   14-endpoint allowlist, dependency-injectable transport.
5. Test suite (Node native test runner) covering:
   severity taxonomy, HTTP taxonomy, per-service health rules,
   expected-state matrix (four allowed combinations + fail-fast
   rejections), kill-switch cache coupling, DISABLED-neutral
   aggregation, transport GET-only assertion, closed-allowlist
   assertion, token/account-ID redaction, malformed-response
   fail-closed, opt-in/opt-out account-summary/kill-switch
   ordering, unexpected-rejection stderr redaction (new in this
   report).
6. Operator runbook
   [docs/runbooks/PAPER_STACK_VERIFICATION.md](../../runbooks/PAPER_STACK_VERIFICATION.md).
7. Hostile review completed (see §5); every finding either
   resolved in-tree or explicitly documented as out of scope.

## 2. Files changed / added

Modified (staged from working tree at review time):

- `.github/workflows/ci.yml` — added mandatory `pnpm lint`
  step.
- `eslint.config.js` — flat config, plus scoped
  `no-restricted-globals` rule blocking global `fetch` outside
  `tools/paper-verify-stack/src/http.ts`.
- `package.json` — root workspaces globs updated + new
  `paper:verify-stack` script.
- `pnpm-workspace.yaml` — added `tools/*`.
- `pnpm-lock.yaml` — regenerated to include the new tool.
- `docs/implementation/phase2/CONFIGURATION.md` — replaced
  fictional `ORCH_*` / `EXECUTION_TICKET_ENDPOINT_PATH` /
  `EXECUTION_IDEMPOTENCY_HEADER` / `LIVE_STARTUP_DRY_READ`
  content with the actual `TRADING_LOOP_*`,
  `EXECUTION_RUNTIME_*`, `RECONCILIATION_*`,
  `RUNTIME_ENABLED` families; marked retired names in a
  dedicated section.
- `docs/implementation/phase2/FAILURE_AND_RECOVERY.md`,
  `RUNTIME_FLOW.md`, `STATE_AND_RECONCILIATION.md`,
  `TESTING_AND_ROLLOUT.md`, `README.md` — reconciled endpoint
  names (`/execution/execute-ticket`,
  `/execution/reconciliation/*`), OD-1..OD-6 pointers, PR15
  outcome union, entry-only loop callout.
- `docs/implementation/phase2/PHASE_2_ROADMAP.md` — PR15
  shipped stamp + PR15.1/15.2/15.3 sub-track table; this
  report flips PR15.1 to **shipped**.
- `docs/implementation/phase2/PR15_PLAN.md`,
  `PR15_REPORT.md` — historical status headers.

Added:

- `docs/implementation/phase2/PR15_1_PLAN.md` (r6).
- `docs/implementation/phase2/PR15_1_REPORT.md` (this file).
- `docs/runbooks/PAPER_STACK_VERIFICATION.md` (runbook).
- `tools/paper-verify-stack/package.json`,
  `tools/paper-verify-stack/tsconfig.json`.
- `tools/paper-verify-stack/src/index.ts` — CLI entry +
  `formatFatalError` structural redaction helper (**new in
  this report**, addresses hostile-review finding H-2).
- `tools/paper-verify-stack/src/config.ts` — Zod env parsing
  + expected-state matrix + fail-fast on missing token.
- `tools/paper-verify-stack/src/endpoints.ts` — closed
  allowlist (14 endpoints).
- `tools/paper-verify-stack/src/http.ts` — GET-only transport;
  ONLY module importing global `fetch`.
- `tools/paper-verify-stack/src/mask.ts` — account-ID +
  Bearer-token redactor.
- `tools/paper-verify-stack/src/schema.ts` — Zod schemas
  mirroring the real service responses.
- `tools/paper-verify-stack/src/report.ts` — table + JSON
  renderers, redactor-passed.
- `tools/paper-verify-stack/src/checks/{types,ingestion,signal,execution}.ts`
  — per-service classifiers, severity aggregation.
- `tools/paper-verify-stack/src/config.test.ts`,
  `coverage.test.ts`, `http.test.ts`, `launcher.test.ts`,
  `mask.test.ts`, `run.test.ts`, `fatal.test.ts` (**new in
  this report**), `checks/*` — tests.
- `tools/paper-verify-stack/scripts/fixture-stack.ts`
  (**new in this report**) — deterministic local fixture stack
  for the CLI acceptance verification described in §6.

Not changed:

- Any trading logic, strategy, `RiskEngine`, submission
  service, reconciliation logic, broker adapter, or DB
  schema.
- `AGENTS.md` — untouched, per plan §1.6.
- Any production `Instrument` — all six remain
  `executionEnabled: false`.
- `.env.example` — `TRADING_LOOP_ENABLED=false`,
  `IBKR_ENVIRONMENT=paper` unchanged.

## 3. Acceptance-criteria matrix

Every acceptance criterion is copy-quoted from
[PR15_1_PLAN.md §10](PR15_1_PLAN.md#10-acceptance-criteria).

| # | Criterion (summary) | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Phase 2 docs reference real endpoints & env names | PASS | `grep_search 'ORCH_'` in `docs/implementation/phase2/` returns zero live references; only the retired-name callouts in `CONFIGURATION.md` and the historical-finding notes in `PR15_1_PLAN.md`. |
| 2 | OD-1..OD-6 annotated with code pointers | PASS | `docs/implementation/phase2/README.md` + `PR15_1_PLAN.md §1.4`. |
| 3 | CI runs `pnpm lint` before typecheck | PASS | `.github/workflows/ci.yml` step ordering (`install --frozen-lockfile` → `lint` → `typecheck` → `test` → `test:integration` → `build`). |
| 4 | `tools/*` covered by workspace globs; frozen install succeeds | PASS | `pnpm-workspace.yaml` + `package.json.workspaces` include `tools/*`; `CI=true pnpm install --frozen-lockfile` reports "Lockfile is up to date, Already up to date, Done in 539ms". |
| 5 | Explicit `@types/node`, `tsx`, `typescript` dev deps + `zod` dep | PASS | `tools/paper-verify-stack/package.json` declares all four explicitly. |
| 6 | Package exposes its own `test`, `typecheck`, `build`, `start` scripts | PASS | Same file. |
| 7 | Root `pnpm paper:verify-stack` script wired via workspace filter | PASS | `package.json` `paper:verify-stack` script. |
| 8 | Verify tool covers all 14 allowlisted endpoints incl. malformed cases | PASS | `endpoints.ts` (14 keys) + `coverage.test.ts` C-set. |
| 9 | Expected-state invariants — 4 allowed combos, everything else CONFIG_ERROR | PASS | `config.ts` §3.3 fail-fast reasons + `run.test.ts` L3/L4. |
| 10 | HTTP taxonomy tested (timeout, network, dns, 401/403, 404, 5xx, 503+ready, 200+ready=false, malformed) | PASS | `run.test.ts` B/D/W-set + `coverage.test.ts` per-endpoint taxonomy. |
| 11 | Per-service health rules tested; `EXECUTION_READY` uses raw-boolean contract from `apps/execution-engine/src/readiness.ts` | PASS | `schema.ts` `ExecutionReadyChecksSchema` uses raw booleans; `run.test.ts` X11d asserts `checks.brokerSocket=false`. |
| 12 | Kill-switch snapshot freshness + Z-set opt-in/opt-out coupling | PASS | `checks/execution.ts` cache logic; `run.test.ts` V-set + Z-set. |
| 13 | `SIGNAL_EXECUTE_READY` classification (§4.3 X10c–X10i) | PASS | `checks/signal.ts` + `schema.ts` `SignalExecuteReadySchema` (`redis`, `postgres`, `paperGuard` sub-checks) + `run.test.ts` C/W7 + `coverage.test.ts`. |
| 14 | `DISABLED` neutral in aggregation | PASS | `checks/types.ts` aggregator + `run.test.ts` Y-set. |
| 15 | GET-only via transport hard-code + closed allowlist + ESLint block | PASS | `http.ts` hard-coded `method: "GET"` + `isEndpointKey` gate; `eslint.config.js` scoped `no-restricted-globals: fetch`. |
| 16 | Verify tool cannot submit/cancel/reset/bootstrap/hold-resolve | PASS | Allowlist excludes every POST endpoint; `run.test.ts` P + fixture-stack run in §6 confirm zero mutating requests. |
| 17 | Bearer token + account IDs never in output | PASS | `mask.ts` redactor applied in `report.ts` + `index.ts` (stderr — **new**); `run.test.ts` M/R + `launcher.test.ts` + `fatal.test.ts` (**new**). |
| 18 | All response bodies Zod-validated | PASS | `schema.ts` covers all 14 endpoints; `classifyHttp` / `classifyReadiness` fail-close to `malformed_response`. |
| 19 | Response interpretation uses only real fields | PASS | Confirmed against `apps/ingestion/src/index.ts`, `apps/execution-engine/src/index.ts`, `apps/execution-engine/src/reconciliation/routes.ts`, `apps/execution-engine/src/readiness.ts` during hostile review. |
| 20 | `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm test:integration`, `git diff --check` all pass | PASS | See §4. |
| 21 | CLI JSON path completes against a fixture stack with zero mutating requests | PASS | Fixture-stack run recorded in §6: 13 GET requests (opt-out) / 14 GET requests (opt-in), all GET, all on allowlisted paths, exit 0. |
| 22 | Tooling tests run under root `pnpm test` | PASS | `pnpm test` runs `tools/paper-verify-stack test` via `pnpm -r --if-present`; per-package summary shows `tests 125`. |
| 23 | No change to trading behaviour, strategy, risk, ticket builder, submission service, reconciliation, broker adapter | PASS | `git diff --name-only` covers only workspace config, docs, CI, eslint, and the new `tools/paper-verify-stack/` package. No file in `apps/execution-engine/src/**` outside docs, no file in `apps/signal-engine/src/**`, no file in `packages/shared/src/**`, no schema/migration change. |

## 4. Commands executed and results

All commands run from `/Users/dawidwojtyca/Development/ikbr-trader`.

```
$ CI=true pnpm install --frozen-lockfile
… "Lockfile is up to date, resolution step is skipped"
… "Already up to date"
… "Done in 539ms"

$ pnpm lint
… 0 errors, 3 warnings (all pre-existing, unrelated:
  apps/backtest-engine/src/simulator.ts:353,
  apps/llm-agent/src/config.ts:50,
  apps/ui/vite.config.ts:19 — unused eslint-disable
  directives).

$ pnpm typecheck
… all 8 workspaces green
  (packages/shared, tools/paper-verify-stack, apps/*).

$ pnpm test
per-package totals (via `ℹ tests` grep):
  packages/shared               tests 276  pass 276  fail 0
  apps/signal-engine            tests 286  pass 286  fail 0
  apps/execution-engine         tests 187  pass 187  fail 0  (PG suite SKIP without TEST_POSTGRES_URL, expected)
  tools/paper-verify-stack      tests 125  pass 125  fail 0

$ TEST_POSTGRES_URL=postgresql://postgres:postgres@localhost:5432/ikbr_trader_ci \
  pnpm test:integration
  tests 293  pass 293  fail 0  duration_ms ≈ 3847
  (integration DB `ikbr_trader_ci` was created for this run
  via `docker compose exec -T postgres psql -U postgres -c
  "CREATE DATABASE ikbr_trader_ci"`. No production or
  backtest DB was touched.)

$ pnpm build
… all packages/apps build clean, including `apps/ui`
  (vite bundle 200 kB), `tools/paper-verify-stack` (tsc → dist).

$ git diff --check
  exit 0 (no whitespace errors).
```

Test counts:

- `pnpm test`: **874 tests / 874 pass / 0 fail** across
  `packages/shared` (276) + `apps/signal-engine` (286) +
  `apps/execution-engine` (187) + `tools/paper-verify-stack`
  (125). The execution-engine PostgreSQL integration suite
  is intentionally skipped when `TEST_POSTGRES_URL` is not
  set (it prints `# SKIP` deterministically).
- `pnpm test:integration`: **293 / 293** against
  `ikbr_trader_ci`.
- New tests added in this report: **5** in
  `tools/paper-verify-stack/src/fatal.test.ts` (structural
  stderr redaction guarantee). Baseline before this report was
  120 tests in the paper-verify-stack suite; final is 125.

## 5. Hostile-review findings and resolutions

The reviewer swept the entire PR15.1 diff against every
acceptance criterion. Findings and their resolutions:

**H-1 — Runbook contradiction on "no token configured".**
The exit-code table listed `no token configured` as an
example that triggers the all-DISABLED aggregate. The
implementation (`config.ts`) and the plan both require a
Bearer token and return `CONFIG_ERROR /
execution_token_missing / exit 10 / zero HTTP requests`.

Resolution: rewrote the exit-code table in
[docs/runbooks/PAPER_STACK_VERIFICATION.md](../../runbooks/PAPER_STACK_VERIFICATION.md).
The `DISABLED (aggregate)` row now explicitly notes it is
only reachable when every expected component is configured
`absent`, and calls out that the base health checks always
run in a normal E2E, so a real stack never reaches it. The
`CONFIG_ERROR` row now explicitly names missing-token as one
of the triggers. An extra paragraph below the table states
verbatim that missing token exits `10` with reason
`execution_token_missing` before any HTTP request is issued.
The fail-fast token requirement was **not** weakened —
`config.ts` still rejects with `execution_token_missing` on
both env names being empty, and `run.test.ts` case **F**
still asserts this behaviour (exit 10, zero requests).

**H-2 — Fatal stderr redaction bypassed the redactor.**
The direct-entrypoint rejection handler in
`tools/paper-verify-stack/src/index.ts` wrote
`` `paper-verify-stack: ${msg}\n` `` to `stderr` without
routing the message through the account-ID / Bearer-token
redactor. Every documented normal render path uses
`createRedactor`; a top-level rejection therefore bypassed
the guarantee.

Resolution: extracted the top-level formatting into an
exported `formatFatalError(err, token) → string` helper that
always applies `createRedactor(token)` to the emitted string.
The direct-entrypoint block extracts the configured Bearer
token from `process.env` **before** invoking `run(...)`, so a
rejection from inside `run` (which never returns a config
object on failure) is still redacted structurally. Added
`tools/paper-verify-stack/src/fatal.test.ts` with 5 unit
tests using a synthetic fake token — never the operator's
real `EXECUTION_API_TOKEN` — proving that: (a) a raw token
substring embedded in an unexpected Error message is
replaced with `[REDACTED]`; (b) an account-ID substring is
masked to `DU-***nnn`; (c) non-Error rejections (bare
strings) are redacted identically; (d) the helper is a
no-op when no token is configured; (e) unrelated error text
is not spuriously replaced.

**H-3 — Frozen install was not conclusively verified.**
Reviewer had no evidence the current `pnpm-lock.yaml`
resolves cleanly against the added `tools/*` workspace.

Resolution: ran `CI=true pnpm install --frozen-lockfile`
non-interactively. Output: `"Lockfile is up to date,
resolution step is skipped"`, `"Already up to date"`. Zero
lockfile drift. `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and
root `package.json.workspaces` are consistent.

**H-4 — Integration tests unverified against a dedicated DB.**
Reviewer required proof that `pnpm test:integration` runs
against a dedicated `ikbr_trader_ci` — never the live
`ikbr_trader` or `ikbr_trader_backtest` DB.

Resolution: verified via
`docker compose exec -T postgres psql -U postgres -tAc
"SELECT datname FROM pg_database WHERE datname IN ('...')"`
that `ikbr_trader_ci` did not exist. Created it with
`CREATE DATABASE ikbr_trader_ci` (only that DB — the
production and backtest DBs were left untouched). Ran
`TEST_POSTGRES_URL=postgresql://postgres:postgres@localhost:5432/ikbr_trader_ci
pnpm test:integration` — 293 tests pass.

**H-5 — Hostile review and report were missing.**
Both are now delivered in this file. Additional checks
performed:

- Verified every production `Instrument` in
  `packages/shared/src/instruments/definitions.ts` retains
  `executionEnabled: false` (6/6 occurrences; the one
  `executionEnabled: true` grep hit is in
  `packages/shared/src/instruments/registry.test.ts` — a
  test factory, not a production instrument).
- Verified `.env.example:229` retains
  `TRADING_LOOP_ENABLED=false`.
- Verified `apps/execution-engine/src/index.ts` still routes
  every mutating endpoint through `POST` (auth middleware
  intact); the verify-stack allowlist only names GET
  variants.
- Verified expected-state matrix in `config.ts` matches
  `apps/signal-engine/src/index.ts:275–378` route
  registration: `EXECUTION_RUNTIME=registered ⇒
  TRADING_LOOP ∈ {enabled, disabled}` (never `absent`),
  because the loop routes live inside the same
  `if (executionRuntime.enabled)` branch as the execute
  routes.
- Verified HTTP taxonomy in `checks/types.ts` matches plan
  §4.1 — 401/403 → `CONFIG_ERROR` (`auth_rejected`),
  timeout/DNS/network → `UNREACHABLE`, 404 →
  `endpoint_not_registered` (`UNHEALTHY`), readiness 200 +
  `ready=false` → `UNHEALTHY`, readiness 503 + parseable
  body → `UNHEALTHY`, 4xx/5xx → `http_<status>`, malformed
  body → `malformed_response`.
- Verified `no-restricted-globals: fetch` scoped rule
  covers `tools/paper-verify-stack/src/**` with
  `src/http.ts` excepted. Grepped every `.test.ts` for a
  bare `fetch` identifier — every occurrence is inside
  `installFetch` / `originalFetch` / `makeFetch` / string
  literals / comments / `globalThis.fetch`; no bare use in
  first position.
- Verified `docs/implementation/phase2/**` does not
  reference `POST /execution/tickets` as a live contract —
  the only such reference is inside `PR15_1_PLAN.md`
  listing it as a **historical finding** (not a claim).
  Same for the fictional `EXECUTION_TICKET_ENDPOINT_PATH`,
  `EXECUTION_IDEMPOTENCY_HEADER`, `LIVE_STARTUP_DRY_READ` —
  `CONFIGURATION.md` marks them "Retired / never-
  implemented".
- Verified `ORCH_*` grep across `docs/implementation/phase2/**`
  returns zero occurrences.
  One remaining occurrence exists at
  `docs/architecture/MARKET_DATA_RUNTIME.md:164`
  ("Not added by PR12 (deferred): `ORCH_LOOP_ENABLED`, ...").
  This is an architecture-doc historical explanation and is
  out of scope for PR15.1 (which per plan §2 only reconciles
  `docs/implementation/phase2/**`). Recording as a
  documentation follow-up (candidate for PR15.2 doc sweep
  or a future cleanup PR); it does not misrepresent PR15.1
  runtime.
- Verified fixture-stack run in §6 emits exactly GET
  requests to allowlisted paths only; no
  `/execution/execute-ticket`, no `/execution/execute-
  proposed/:id`, no `/bootstrap`, no `/stop`, no
  `/reconciliation/run`, no hold-mutation endpoints.

## 6. Runtime verification against a fixture stack

Docker-Compose stack images are older than the working tree
and are **not** treated as validation of PR15.1. Instead,
`tools/paper-verify-stack/scripts/fixture-stack.ts` launches
three localhost HTTP servers on `127.0.0.1:{3101,3102,3103}`
that reply with the canonical fixture payloads from
`run.test.ts` and log every observed request to stderr.

### 6.1 Opt-out (default) run

```
$ node --import tsx tools/paper-verify-stack/scripts/fixture-stack.ts \
    2>/tmp/fixture-stderr.log &
$ PAPER_VERIFY_EXECUTION_TOKEN=fixture-test-fake-token-1234567890abcdefgh \
  PAPER_VERIFY_RUNTIME_EXPECTED_STATE=registered \
  PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=registered \
  PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE=disabled \
  node --import tsx tools/paper-verify-stack/src/index.ts --json
```

Result:

- Exit code: `0` (HEALTHY).
- 11 checks HEALTHY, 3 DISABLED (`signal.trading_loop.status`
  and `signal.trading_loop.ready` disabled as expected;
  `execution.account.summary` disabled per opt-out default).
- Account ID `DU1234567` masked as `DU-***567` in every
  rendered string of the JSON output.
- No token substring in stdout.

Fixture request log (13 requests observed, all GET, all on
allowlisted paths):

```
:3101  GET /health
:3101  GET /watchlist
:3102  GET /health
:3102  GET /runtime/health
:3102  GET /runtime/ready
:3102  GET /runtime/execute/ready
:3102  GET /runtime/trading-loop/status
:3102  GET /runtime/trading-loop/ready
:3103  GET /health
:3103  GET /ready
:3103  GET /execution/reconciliation/latest
:3103  GET /execution/reconciliation/holds?active=true
:3103  GET /execution/kill-switch
```

Zero requests to any mutating endpoint.

### 6.2 Opt-in (account-summary) run

Same fixture with `PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true`
adds `GET /execution/account/summary` **before**
`GET /execution/kill-switch` (per plan §4.4 dependency
ordering). Fixture log observed 14 requests, all GET,
account-summary preceded kill-switch; overall HEALTHY, exit
0. This is the fake-fixture case explicitly permitted by the
task: account-summary is only invoked because the fixture is
in-process and has no IBKR side effects.

Both runs are reproducible from the working tree; the
fixture script never contacts a real broker or the docker
stack.

## 7. Explicit safety confirmations

- **No mutating broker call occurred.** The tool's transport
  is hard-coded `method: "GET"` and the closed 14-endpoint
  allowlist contains no POST. Both fixture runs above
  observed only GETs. The Docker Compose stack was not
  restarted; the running paper stack was not driven.
- **No instrument was activated.** All six production
  instruments in
  `packages/shared/src/instruments/definitions.ts` still
  report `executionEnabled: false`.
- **Live remained disabled.** `.env.example` retains
  `IBKR_ENVIRONMENT=paper` semantics and
  `TRADING_LOOP_ENABLED=false`; no change to any config
  parser affecting live gating.
- **PR15.2, PR15.3, PR16 were not started.** No file under
  the PR15.2 (`packages/shared/src/instruments/**` binding
  authority) or PR15.3 (paper-broker order path) surfaces
  was touched. `PHASE_2_ROADMAP.md` still lists PR15.2 and
  PR15.3 as `pending` and PR16 unchanged.

## 8. Known unrelated lint warnings

Pre-existing at HEAD (not introduced by PR15.1):

- `apps/backtest-engine/src/simulator.ts:353:11` — unused
  `no-console` eslint-disable directive.
- `apps/llm-agent/src/config.ts:50:3` — same.
- `apps/ui/vite.config.ts:19:3` — same.

Left in place to keep this PR strictly scoped.

## 9. Rollback instructions

The change is additive plus documentation edits. To roll
back:

```
git revert <this-commit-hash>
```

Then:

```
pnpm install --frozen-lockfile
```

The `tools/paper-verify-stack/` package will disappear from
the workspace; no schema, service, or trading-code change
needs undoing. The dedicated `ikbr_trader_ci` DB created for
integration tests can be dropped safely with
`docker compose exec -T postgres psql -U postgres -c
"DROP DATABASE ikbr_trader_ci"` if it is no longer wanted
(purely a convenience — it does not overlap with the live
or backtest DBs and can be left in place for CI parity).

## 10. Commit metadata

This report is included in the completion commit. The commit
hash is not embedded here to avoid a self-referential
placeholder; refer to the resulting `git log` entry titled
`feat(tooling): complete PR15.1 paper stack verification`.
No push is performed as part of PR15.1. PR15.2 and PR15.3
remain pending and are explicitly not started by this
change.
