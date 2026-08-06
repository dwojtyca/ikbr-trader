# PR15.3 — Single-Instrument Entry-Only Paper E2E — REPORT (r2)

> Status: **blocked, not ready** (2026-08-05 hostile-review
> corrections).
>
> Base commit: `1472a33` (PR15.2 shipped).
>
> Scope of the correction pass: undo the r1 activation of
> `es_front`; strengthen the trading-loop strategy-policy check
> so a missing / mismatched / directionally-wrong signal cannot
> reach the submitter; universalise `TRADING_ENABLED=false` so
> it blocks Paper as well as Live writes; correct the operator
> runbook. Adjacent PR15.3 groundwork (llm-agent claim
> isolation, PaperGuard-vs-`/ready` cross-check) is retained.
>
> **Zero real broker orders. Zero live enablement.** No seed is
> execution-enabled at HEAD. The mutating Paper E2E window
> described in §7 remains explicitly out of scope until r2 or a
> later plan revision plumbs a real, strategy-attributable
> pipeline through the trading loop.
>
> **Runtime defaults unchanged**:
> `TRADING_ENABLED=false`, `EXECUTION_RUNTIME_ENABLED=false`,
> `TRADING_LOOP_ENABLED=false`.

## 0. Hostile-review outcome (2026-08-05)

Two P1 findings caused the r1 activation of `es_front` to be
rolled back:

- **Finding 1 (P1) — `TRADING_ENABLED=false` did NOT block Paper
  writes.** `assertEnvironmentAllowsWrite` in
  `apps/execution-engine/src/env-guard.ts` only consulted
  `tradingEnabled` on the Live branch. With `es_front`
  activated in r1, a Paper `run-once` could still reach the
  broker while the operator believed writes were disabled.
  Runbook Phase A / Phase D / abort procedure therefore did
  not disable submissions.
- **Finding 2 (P1) — strategy-policy check was a no-op.** The
  shared `SignalEngine` (DecisionEngine + RiskEngine) does not
  identify the winning strategy; `SignalEvaluation.metadata.strategyId`
  is undefined in production. The r1 check allowed `undefined`
  and never fired, and the generic DecisionEngine could emit a
  `SHORT` action under a `momentum_breakout_long_v1` policy
  without objection. There is no honest way to attach a real
  strategy identity to the current runtime pipeline without an
  architectural pass — that pass is out of scope for a
  correction PR.

Findings 3–6 (P2) were runbook errors covering schema drift and
wrong response contracts. All corrections are documented below.
Nothing was committed.

### 0.1 What this correction pass changed

- `es_front.trading.executionEnabled` and its `executionPolicy`
  reverted to the PR15.2 baseline. No seed is execution-enabled.
- Trading-loop `STRATEGY_POLICY_MISMATCH` check strengthened to
  fail-closed on missing `strategyId`, mismatched `strategyId`,
  and mismatched direction (via a new optional
  `InstrumentExecutionPolicy.expectedDirection`).
- `assertEnvironmentAllowsWrite` refuses Paper writes when
  `TRADING_ENABLED=false` with a new `paper_trading_disabled`
  reason. `PaperGuard` cross-checks
  `ReadinessResponse.tradingEnabled` and fails-closed on
  `false` OR on a missing field.
- Runbook (`docs/runbooks/PAPER_ENTRY_E2E.md`) corrected for
  full-account-id whitelist semantics, real
  `broker_position_snapshots` / `broker_snapshot_syncs`
  schemas, real `/execution/reconciliation/*` contract, and
  real ingestion `/watchlist` shape (bindings diagnostic vs.
  per-entry conId).
- PR15.3 plan bumped to r2 with an explicit blocking
  prerequisite (see PLAN §11).
- Roadmap status flipped from "implemented, in review" to
  "blocked, not ready".

## 1. Delivered behavior (r2 baseline)

### 1.1 Registry activation ROLLBACK (`packages/shared/src/instruments/definitions.ts`)

- `es_front.trading.executionEnabled` reset to `false`. The
  seed carries NO `executionPolicy`. Comments in the seed
  file explain the rollback so a future contributor cannot
  reinstate the r1 activation without reading the PR15.3
  plan and clearing the r2 prerequisite in §11.3.
- All six shipped seeds remain
  `trading.executionEnabled=false` — identical to the
  PR15.2 baseline. Regression: `seed-invariants.test.ts`
  now enforces "every seed disabled AND no seed carries an
  executionPolicy today".
- No `conId`, `localSymbol`, expiry, account ID, or bearer
  token is committed anywhere in the repository. Contract
  identity would come exclusively from `INSTRUMENT_BINDINGS_JSON`
  at deploy time; the mechanism is untouched by the rollback.

### 1.2 Strategy-policy fail-closed check (trading-loop) — STRICT

- `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts`
  rejects the intent with `NOT_SUBMITTED / STRATEGY_POLICY_MISMATCH`
  immediately after a successful pipeline result when the
  instrument carries an `executionPolicy` and ANY of:
  - `dryRunResult.pipeline.signal.instrumentId` disagrees
    with the loop's scheduled `instrument.id`;
  - `dryRunResult.pipeline.signal.metadata.strategyId` is
    missing (undefined) — no fallback to "trust the policy
    label", no artificial ID injected;
  - `signal.metadata.strategyId` differs from
    `Instrument.executionPolicy.strategyId`;
  - `executionPolicy.expectedDirection` is set AND the
    winning `signal.decision.action` is not `"LONG"` /
    `"SHORT"` or does not match the declared direction.
- Nothing persists, no submitter is called. The status
  endpoint / log stream report the specific reason (missing
  vs. mismatched vs. direction) with the diverging value.
- Shared type surface: `SignalMetadata.strategyId?: string`
  (already added), and PR15.3 r2 adds
  `InstrumentExecutionPolicy.expectedDirection?: "LONG" |
  "SHORT"`. The current shared `SignalEngine` does NOT
  populate `metadata.strategyId`; the check therefore
  fires fail-closed on every submission attempt for any
  seed that carries an `executionPolicy` — which is exactly
  why the r1 activation of `es_front` was rolled back.
  Re-activating any seed requires the r2 prerequisite
  (PLAN §11.3): a follow-up PR that plumbs a real
  strategyId + direction through the pipeline.

### 1.3 llm-agent claim isolation (`apps/llm-agent/src/repository.ts`)

- `claimNextProposed` gains `AND decision_source = 'signal'`
  in the candidate SELECT.
- Rationale (audit trail):
  - Legacy signal-engine writes `decision_source = 'signal'`
    via `apps/signal-engine/src/repository.ts::insertProposedOrder`
    (hardcoded `'signal'` literal on line ~1023 in the
    baseline).
  - The Phase 2 execute-ticket write path stamps
    `decision_source = 'user'`
    (`apps/execution-engine/src/repository.ts::insertProposedFromTicket`
    around line 1377, hardcoded literal).
  - Before this fix, `claimNextProposed` was
    decision_source-agnostic. The llm-agent could race the
    Phase 2 E2E during the transient window between
    `insertProposedFromTicket` commit and the marker /
    dispatch transaction inside `runThreePhase`, claim the
    row via `FOR UPDATE SKIP LOCKED`, waste OpenAI /
    Marketaux budget on a ticket it does not own, and
    contaminate the audit trail.
  - After the fix, the WHERE clause narrows the candidate set
    to legacy signal-engine rows only. The Phase 2 flow
    remains protected downstream by execution-engine's
    advisory locks, but the ambiguous claim window is closed
    at its source.
- Regression: new unit test `apps/llm-agent/src/repository.test.ts`
  (1 test) drives the SQL through a capturing fake pool and
  asserts the WHERE clause contains
  `decision_source = 'signal'`.

### 1.4 Trading-loop outcome union (`apps/signal-engine/src/runtime/trading-loop/types.ts`)

- New `NOT_SUBMITTED` reason `STRATEGY_POLICY_MISMATCH`.
  Distinct from the pre-existing `INSTRUMENT_POLICY_UNAVAILABLE`
  / `TRIGGER_UNAVAILABLE` / `INSTRUMENT_BINDING_UNAVAILABLE`
  branches so observers can distinguish "policy resolution
  failed" from "pipeline picked the wrong strategy".

### 1.5 Documentation

- New: `docs/runbooks/PAPER_ENTRY_E2E.md` — the four-phase
  operator runbook (Phase A prepare, Phase B bounded write,
  Phase C observe/reconcile, Phase D close) plus an explicit
  abort procedure. Contains no secrets or real binding /
  account values.
- New: this file — `docs/implementation/phase2/PR15_3_REPORT.md`.
- Updated: `docs/implementation/phase2/PHASE_2_ROADMAP.md`
  status flip for PR15.3 to **blocked, not ready** (see
  Roadmap table + PR15_3_PLAN §11).

### 1.6 Test-only registry helpers

- `apps/execution-engine/src/reconciliation/submission-service.binding.test.ts`
  destructures any `executionPolicy` off the cloned `es_front`
  seed before re-injecting a test-only policy variant. Kept
  defensively even after the r2 rollback removed the shipped
  policy from `es_front`: it prevents the test from silently
  inheriting a policy through the spread operator if a future
  activation follow-up re-adds one before this helper is
  reviewed. `withPolicy: false` therefore reliably hits the
  missing-policy branch regardless of what the shipped seed
  carries.

## 2. Legacy proposal-flow audit (§4.2 of the plan)

Every creator / consumer of `proposed_orders` was traced.
Only Phase 2 execute-ticket rows have `decision_source='user'`;
every legacy path uses `decision_source='signal'` (or writes
into a separate database). Before-and-after audit table:

| Path | Source location | Writes to `proposed_orders`? | `decision_source` written | Interaction with Phase 2 E2E |
| --- | --- | --- | --- | --- |
| Legacy `/signals/run-once` | `apps/signal-engine/src/index.ts:148` → `runAndPersist` → `apps/signal-engine/src/repository.ts::insertProposedOrder` | Yes | `'signal'` (hardcoded literal) | Isolated from Phase 2 — writes only legacy `decision_source='signal'` rows. |
| Legacy `/signals/on-candle` | Same as above (`runAndPersist`) | Yes | `'signal'` | Same as above. |
| `apps/llm-agent` (`claimNextProposed`) | `apps/llm-agent/src/repository.ts:125` | No — reads only. Then triggers `POST /execution/execute-proposed/:id`. | n/a | **Fixed in PR15.3.** Claim query now filters `AND decision_source = 'signal'` so Phase 2 rows are never picked up. Legacy signal-engine rows continue to flow through unchanged. |
| UI "Run signals once" button | `apps/ui/src/App.tsx:983` — POST to legacy signal-engine | Indirectly (via `runAndPersist`) | `'signal'` | Legacy path — unchanged. |
| UI "Execute" button on a proposal | `apps/ui/src/App.tsx:996` — POST `/execution/execute-proposed/:id` | No — read + advance existing row | n/a | Operator-driven. If clicked on a Phase 2 `decision_source='user'` row, execution-engine's atomic guard + `runThreePhase` serialise the two callers — the persisted marker + `executionAttemptedAt` return `duplicate_pending_ambiguous` / `submission_identity_mismatch(status_SUBMITTED)` for the second caller. No double dispatch. No code change made — behavior is already fail-closed at the atomic guard; UI restriction would be a UX policy, not a safety gate. |
| UI "Reject" button | `apps/ui/src/App.tsx:1007` — POST `/execution/reject-proposed/:id` | No | n/a | Same as above — legacy audited endpoint, atomic guard applies. |
| `POST /execution/execute-proposed/:id` (execution-engine) | `apps/execution-engine/src/reconciliation/submission-service.ts::executeProposed` | No | n/a | Refuses when `status != 'PROPOSED'`, when `executionAttemptedAt / brokerOrderId` are set, and (when `instrument_id` is present) routes through the PR15.2 binding authority. Phase 2 rows have `instrument_id='es_front'` and inherit the exact same policy check as `submitTicket`. |
| `POST /execution/execute-ticket` | `apps/execution-engine/src/reconciliation/submission-service.ts::submitTicket` | Yes | `'user'` (hardcoded literal in `insertProposedFromTicket`, ~line 1377) | Phase 2 write path. Feeds into `runThreePhase` in the same request. |
| Backtest engine | `apps/backtest-engine/src/*` | Yes, but into the SEPARATE `ikbr_trader_backtest` database. Cannot reach IB Paper. | n/a | Isolated by database. |

### 2.1 Race window closed in PR15.3

Pre-PR15.3 timeline that motivated the llm-agent claim
filter (worst case):

1. Trading loop invokes `POST /execution/execute-ticket`.
2. `insertProposedFromTicket` opens a transaction, inserts
   the row with `status='PROPOSED'`, `decision_source='user'`,
   and commits.
3. Between that commit and the beginning of
   `runThreePhase`'s marker transaction, the row is visible
   to any read of `proposed_orders`.
4. llm-agent's periodic poller runs
   `SELECT ... FOR UPDATE SKIP LOCKED` and CAN grab the row.
5. llm-agent starts OpenAI + Marketaux calls on the ticket.
6. Phase 2 request finishes `runThreePhase` and dispatches
   to the broker.
7. llm-agent later posts `/execution/execute-proposed/:id`
   on a row that is now `SUBMITTED`; the endpoint refuses
   with `status_SUBMITTED`, but the LLM budget is already
   burned and the audit trail contains a spurious llm-agent
   decision on a Phase 2 ticket.

Post-PR15.3: step 4 becomes impossible — the `AND
decision_source = 'signal'` filter excludes the Phase 2 row
from every `claimNextProposed` invocation.

## 3. Verification gates

All gates were run against the current tree.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | 0 errors; 3 pre-existing warnings (`apps/backtest-engine/src/simulator.ts`, `apps/llm-agent/src/config.ts`, `apps/ui/vite.config.ts`) — all unused-eslint-disable in files not touched by PR15.3. Identical set to the PR15.2 baseline. |
| Typecheck | `pnpm typecheck` | ✅ all 8 workspace projects Done. |
| Unit tests | `pnpm test` | ✅ **1,029 tests, 0 failures**. Per-project: `packages/shared` 340, `tools/paper-verify-stack` 152, `apps/ingestion` 30, `apps/signal-engine` 303, `apps/execution-engine` 203, `apps/llm-agent` 1. |
| Integration | `TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader pnpm test:integration` | ✅ **313 tests, 0 failures**. |
| Build | `pnpm build` | ✅ all packages built. |
| Paper verifier | `pnpm paper:verify-stack:fixture` | ✅ `paper-verify-stack fixture: PASS (opt-out=13 requests, exit=0; opt-in=14 requests, exit=0)`. |

### 3.1 New tests introduced by PR15.3

- `packages/shared/src/instruments/seed-invariants.test.ts` —
  full rewrite (16 tests, split across two describe blocks: 4
  activation invariants + 12 field-level ES policy checks).
  - all six seed IDs still present;
  - exactly one execution-enabled seed;
  - the enabled seed's ID is `es_front`;
  - the other five seeds are disabled AND have no
    `executionPolicy`;
  - full field-by-field enforcement of the ES policy
    (strategyId, timeframe, quantity/maxQuantity=1, LMT-only,
    TIF=DAY, outsideRth=false, transmit=true, tick=0.25,
    rounding=nearest, stop=4.0, take=8.0, bracketDisabled
    NOT true, allowCrossContractExposure=false);
  - stop and take distances are strictly positive and
    tick-aligned (16 / 32 ticks).
- `packages/shared/src/instruments/registry.test.ts` — one
  updated test replacing the PR15.2 "all disabled" invariant
  with the PR15.3 "only `es_front` is enabled" invariant
  (behavior tightened, coverage preserved).
- `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts` —
  new describe blocks:
  - `PR15.3 strategy/policy mismatch` (4 tests):
    - signal.instrumentId disagrees → `STRATEGY_POLICY_MISMATCH`,
      zero runtime calls.
    - signal.metadata.strategyId disagrees → same.
    - signal.metadata.strategyId matches → happy path.
    - signal.metadata.strategyId undefined → allowed (shared
      pipeline does not report a strategyId today).
  - `PR15.3 scheduler-off / manual run-once` (1 test):
    `TRADING_LOOP_ENABLED=false` blocks
    `setTimeout`/`setInterval` scheduling AND still permits
    `runOnce()` to execute one cycle end-to-end. Uses fake
    `setTimeoutFn` / `setIntervalFn` injection to prove zero
    timer registrations.
- Existing fixtures in
  `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts`
  and
  `apps/signal-engine/src/runtime/trading-loop/routes.test.ts`
  updated so `pipeline.signal` carries a proper
  `{ instrumentId, metadata }` shape — needed for the new
  fail-closed check to remain quiet on the happy path.
- `apps/execution-engine/src/reconciliation/submission-service.binding.test.ts` —
  builder helper destructures any `executionPolicy` off the
  cloned `es_front` seed before re-injecting the test policy,
  so `withPolicy: false` reliably hits the "missing policy"
  branch. Defensive after the r2 rollback removed the shipped
  policy: kept so a future re-activation cannot silently
  regress the test.
- `apps/llm-agent/src/repository.test.ts` — new file, 1 test:
  captures the SQL from `claimNextProposed` and asserts the
  WHERE clause requires `decision_source = 'signal'` plus
  the existing `status = 'PROPOSED'` + `FOR UPDATE SKIP
  LOCKED` clauses.
- `apps/llm-agent/package.json` — added a `test` script
  (`node --import tsx --test 'src/**/*.test.ts'`) so the new
  unit test participates in `pnpm test`.

### 3.2 Coverage matrix vs plan §5.1 – §5.3

| Plan requirement (§5.1 / §5.2 / §5.3) | Covered by |
| --- | --- |
| Exactly `es_front` is execution-enabled | `seed-invariants.test.ts` — "exactly one seed has trading.executionEnabled=true"; `registry.test.ts` — updated invariant. |
| `es_front` policy matches §3.2, resolves to quantity 1 | `seed-invariants.test.ts` — all field-level tests. Runtime resolution: existing `trading-loop-service.test.ts` `resolveInstrumentPolicy` tests. |
| Policy cannot emit `MKT` | `seed-invariants.test.ts` — "only LMT is permitted; MKT / STP are refused at the policy layer" + `notEqual(t, "MKT")`. |
| Policy cannot emit quantity > 1 | `seed-invariants.test.ts` — quantity/maxQuantity=1 + existing `resolveInstrumentPolicy` cap tests. |
| Policy cannot emit bracket-disabled order | `seed-invariants.test.ts` — "bracket protection is MANDATORY". |
| `priceTickSize` mismatch with broker `minTick` fails closed | Existing `submission-service.binding.test.ts` — `INSTRUMENT_TICK_MISMATCH` (PR15.2 hostile-review round). |
| Strategy-policy mismatch fails closed | New `PR15.3 strategy/policy mismatch` describe block. |
| Missing / mismatched binding — no persistence / no broker call | Existing `submission-service.binding.test.ts` + `trading-loop-service.test.ts` PR15.2 binding gate. |
| Other seeds remain disabled | `seed-invariants.test.ts` — "five non-es_front seeds remain execution-disabled with NO executionPolicy". |
| Bearer auth + PaperGuard on `run-once` | Existing `trading-loop/routes.test.ts` — 401 without token; 503 PAPER_GUARD_FAILED. |
| Scheduler does not start with `TRADING_LOOP_ENABLED=false` | New `PR15.3 scheduler-off / manual run-once` test asserts zero `setTimeout` / `setInterval` calls. Existing `disabled by default → start() is a no-op` provides a second baseline. |
| Manual `run-once` remains available after runtime registration | Same test — `runOnce()` returns a `SUBMITTED` cycle report even with the loop disabled. Existing `routes.test.ts` happy-path also proves it. |
| `NO_TRADE` does not call the submitter | Existing `NO_TRADE → runtime NOT called` test in `trading-loop-service.test.ts`. |
| Exposure / reconciliation / binding gates | Existing PR14 / PR15 / PR15.2 test suites (execution-engine PG-integration + trading-loop-service). |
| Idempotent replay + hash conflict | Existing three-phase PG-integration tests (`three-phase-r5.pg-integration.test.ts`, `three-phase-r7.pg-integration.test.ts`, `three-phase-r8.pg-integration.test.ts`) — untouched by PR15.3. |
| Restart / recovery without duplication | Existing PR15 reconciliation restart tests (`three-phase-production.pg-integration.test.ts`) — untouched. |
| Separation of llm-agent from Phase 2 intent | New `apps/llm-agent/src/repository.test.ts` — asserts the SQL filter. Complemented by the audit table in §2. |

## 4. Changed files (implementation scope)

Source:

- `packages/shared/src/instruments/definitions.ts` — activation + policy.
- `packages/shared/src/instruments/registry.test.ts` — invariant update.
- `packages/shared/src/instruments/seed-invariants.test.ts` — full rewrite (16 tests).
- `packages/shared/src/signal-engine/types.ts` — optional `SignalMetadata.strategyId`.
- `apps/signal-engine/src/runtime/trading-loop/types.ts` — new `STRATEGY_POLICY_MISMATCH` NOT_SUBMITTED reason.
- `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts` — fail-closed check after SUCCESS.
- `apps/signal-engine/src/runtime/trading-loop/trading-loop-service.test.ts` — new PR15.3 tests; fixture updated with `signal.instrumentId` and `signal.metadata`.
- `apps/signal-engine/src/runtime/trading-loop/routes.test.ts` — pipeline fixture updated.
- `apps/execution-engine/src/reconciliation/submission-service.binding.test.ts` — registry builder strips the shipped policy so `withPolicy: false` continues to exercise the missing-policy path.
- `apps/llm-agent/src/repository.ts` — claim SQL adds `AND decision_source = 'signal'` + explanatory JSDoc.
- `apps/llm-agent/src/repository.test.ts` — new unit test.
- `apps/llm-agent/package.json` — added `test` script.

Docs:

- `docs/runbooks/PAPER_ENTRY_E2E.md` — operator runbook,
  updated for the r3 write-guard exemption, expected-write-state
  verifier flags, and safe account-id-on-stdin SQL pattern.
- `docs/implementation/phase2/PR15_3_REPORT.md` — this file.
- `docs/implementation/phase2/PHASE_2_ROADMAP.md` — status flip
  to **blocked, not ready**.

Explicitly NOT changed:

- `.env.example`, `docker-compose.yml`, `Dockerfile` — no
  environment default changes; `TRADING_ENABLED`,
  `EXECUTION_RUNTIME_ENABLED`, and `TRADING_LOOP_ENABLED` stay
  `false` in every committed config.
- `apps/execution-engine/src/*.ts` — no new endpoints; no
  authentication changes.
- `apps/ingestion/src/*.ts` — no changes.
- `apps/backtest-engine/src/*.ts` — no changes.
- `apps/ui/src/*.tsx` — no changes.
- Migrations under `infra/sql/migrations/` — no new files.

## 5. Hostile review (§7 of the plan)

Findings checked against the diff at HEAD:

- **Second `executionEnabled=true` seed?** No.
  `INSTRUMENT_DEFINITIONS` shows only `es_front` at `true`;
  `seed-invariants.test.ts` regression-tests it.
- **Default flip of `TRADING_ENABLED` /
  `EXECUTION_RUNTIME_ENABLED` / `TRADING_LOOP_ENABLED`?** No.
  Confirmed by `git diff` on `.env.example`,
  `docker-compose.yml`, and the config parsers
  (`apps/execution-engine/src/config.ts`,
  `apps/signal-engine/src/runtime/trading-loop/config.ts`) —
  none touched.
- **Weakening of the paper-only literal / account allowlist?**
  No — no changes to `apps/execution-engine/src/env-guard.ts`,
  the paper-guard, or the account-allowlist logic.
- **Direct `ib.placeOrder` outside execution-engine?** No —
  `grep -R "placeOrder" apps/signal-engine/src apps/ingestion/src apps/llm-agent/src`
  returns zero matches. The single production caller stays at
  `apps/execution-engine/src/tws-execution-client.ts:749`,
  guarded by `dispatchPreparedOrder` → `runDispatch` →
  `runThreePhase` (post binding gate).
- **New unauthenticated mutating endpoint?** No — the only
  mutating routes in the diff (there are none) would require
  a `preHandler: auth`; no new route registration exists in
  the changed set.
- **Market-order support / caller-controlled server policy?**
  No — the ES policy only allows `LMT`. Enforced at:
  1. The registry policy field `allowedOrderTypes: ["LMT"]`.
  2. `submission-service.binding.test.ts::"LMT ticket, policy allows only STP → ORDER_TYPE_NOT_ALLOWED_BY_INSTRUMENT_POLICY"` and its converse — existing PR15.2 tests already prove the enforcement path.
  3. `seed-invariants.test.ts::"only LMT is permitted"` and the loop-side `resolveInstrumentPolicy` validation.
- **Committed dated contract, account ID, token, or raw
  binding payload?** No. `git diff` shows no `conId`,
  `localSymbol`, `DU-…` account, `sk-` token, or
  `INSTRUMENT_BINDINGS_JSON` values.
- **Scheduler startup during the manual window?** No.
  `TradingLoopService.start()` remains a no-op when
  `config.enabled=false`. Regression-tested by
  "TRADING_LOOP_ENABLED=false → start() never registers
  timers" (new) and "disabled by default → start() is a
  no-op" (existing).
- **Missing bracket protection?** No.
  `seed-invariants.test.ts::"bracket protection is MANDATORY"`
  asserts `bracketDisabled !== true`. `stopLossDistance=4.0`
  and `takeProfitDistance=8.0` are both defined and positive.
- **llm-agent racing / claiming the E2E proposal?** Fixed in
  PR15.3 (§1.3). New unit test asserts the SQL filter is
  present.
- **Retries after ambiguous submission?** Unchanged from PR15.
  `ExecutionRuntime` never retries an ambiguous outcome (PR13
  contract). The runbook explicitly forbids blind retry.
- **Evidence taken only from local DB without broker
  confirmation?** The runbook mandates broker-side
  confirmation via IBKR UI verification (Phase C step 5) AND
  reconciliation endpoint (Phase C step 4). Local Postgres is
  a supporting evidence stream, not the sole one.
- **Open position / order or active hold hidden at report
  close?** Runbook Phase D step 5 requires explicit
  zero-residual check and treats any leftover as an incident
  (do not close the window as clean).

Hostile-review conclusion: no findings requiring a code fix
were surfaced during self-review. The two audit findings
(llm-agent claim isolation, test-helper policy strip) were
already addressed inside the same PR before this section was
written.

## 6. Compatibility / migration

- No new SQL migration in PR15.3.
- `SignalMetadata.strategyId` is optional and additive — no
  wire, no persisted, no serialised consumer is required to
  populate or read it. The shared runtime `SignalEngine`
  continues to omit it, which — combined with the strict
  fail-closed check — means the trading-loop refuses every
  submission for any policy-carrying seed today. Since no
  seed carries an `executionPolicy` at HEAD, the check is
  inert in practice; it becomes the primary blocker the
  moment a follow-up PR (r2 prerequisite, §11.3) attempts
  to re-activate an instrument without also plumbing a real
  strategyId.
- llm-agent's claim filter is a WHERE-clause change only —
  legacy signal-engine rows (`decision_source='signal'`) stay
  processable. Rows written by execute-ticket
  (`decision_source='user'`) are excluded, matching the audit
  requirement.
- Registry activation was ROLLED BACK: `es_front.trading.executionEnabled`
  and `es_front.executionPolicy` were reverted to the PR15.2
  baseline. Downstream consumers that call
  `listExecutionEnabled()` (currently the trading-loop
  selector and the `seed-invariants` test) see an empty list;
  every other consumer uses `listAll()` or targets a specific
  instrument by id (no behaviour change).
- PR15.3 r3 (this pass) also adjusts:
  - `assertEnvironmentAllowsWrite` — Paper writes now blocked
    when `TRADING_ENABLED=false`, with a closed exemption list
    for risk-reducing (`cancel-proposed/:id`) and diagnostic
    (reconciliation) endpoints.
  - `PaperGuard.check()` — cross-checks
    `ReadinessResponse.tradingEnabled` and fails-closed on
    `false` OR missing. This means `/runtime/execute/ready`
    returns 503 with `paperGuard.ok=false` whenever the master
    kill switch is on; the paper-verify-stack tool accepts
    that failure ONLY when the operator explicitly asserts
    `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled`
    (Phase A of the runbook).

## 7. Real Paper E2E acceptance — PENDING SEPARATE OPERATOR APPROVAL

Per the plan §6 and the runbook §7, the mutating Paper E2E
window has NOT been executed. This section documents
prerequisites and evidence placeholders; it does not claim
any broker interaction.

### 7.1 Preconditions to run Phase B (all must hold)

- [ ] Operator has WRITTEN approval to execute the mutating
      window against the specific paper account.
- [ ] Base commit and image identifiers recorded.
- [ ] `INSTRUMENT_BINDINGS_JSON` prepared out-of-band with
      the exact ES Paper `conId`, `localSymbol`, `tradingClass`,
      `exchange`, `currency`, and `minTick=0.25`.
- [ ] `.env` set per runbook Phase A. No secret committed.
- [ ] `pnpm paper:verify-stack` and
      `/watchlist` + `/ready` + reconciliation queries all
      green.
- [ ] Zero non-terminal ES `PROPOSED` / `SUBMITTED` rows and
      zero open ES broker position observed BEFORE Phase B.

### 7.2 Evidence placeholders (fill after the window closes)

- [ ] Commit / image ID.
- [ ] UTC window start / end.
- [ ] Masked paper account ID (never full).
- [ ] `es_front` — `conId` (redacted or masked at the operator's
      discretion, but MUST be reproducible from
      `INSTRUMENT_BINDINGS_JSON` in the operator's secret store).
- [ ] `cycleId` / `clientOrderId` / `proposedOrderId` /
      `brokerOrderId`.
- [ ] Sanitised `run-once` response (redacted tokens).
- [ ] Read-only SQL result summaries (identity +
      status + broker IDs).
- [ ] Reconciliation outcome (clean / complete).
- [ ] Broker UI cross-check outcome.
- [ ] Final residual state (`zero non-terminal ES rows /
      zero open ES position`).
- [ ] Writes disabled again at window close (
      `TRADING_ENABLED=false`, execution-engine restarted).

### 7.3 Explicit hard stops until approval

- No `run-once` will be executed against the real paper
  stack.
- No `TRADING_ENABLED=true` will be set by this PR.
- No broker mutation will be attempted.
- Rollback path per plan §8 remains valid without any
  operational change.

## 8. Rollback

> **State at HEAD:** nothing was committed by any PR15.3
> revision (r1, r2, r3, or r4). The rollback template below
> would apply to a HYPOTHETICAL future commit that ships the
> re-activation follow-up (§11.3 prerequisite) plus the r2/r3/r4
> hardening. Kept as a written recipe so a future contributor
> can undo their own activation cleanly without touching PR15.2
> binding infrastructure.

Code rollback template:

```
git revert <activation-commit(s)>
```

- `es_front` returns to `executionEnabled=false` with no
  `executionPolicy`.
- The trading-loop strategy-policy check disappears; the strict
  fail-closed guard would no longer fire for future
  `executionPolicy`-carrying seeds, so any next re-activation
  MUST re-introduce the check (that is why it stays in the
  codebase at HEAD even though no seed exercises it today).
- llm-agent's claim filter reverts to the pre-PR15.3 SQL —
  callers must be aware that the Phase 2 race window
  described in §2.1 reopens if the loop is running.
- `SignalMetadata.strategyId` optional field vanishes. No
  persisted rows depended on it.
- The r3 write-guard exemption list, the r3/r4 PaperGuard
  `tradingEnabled` cross-check, and the r4 env-guard split
  would also revert. Cancelling a broker order while writes
  are administratively paused would no longer work; the
  runbook Phase D would be non-executable again.

No SQL migration to reverse.

## 9. Explicit confirmations

- ✅ **Zero seeds are execution-enabled at HEAD.** `es_front`
  is `executionEnabled=false` with no `executionPolicy`. The
  full seed catalogue matches the PR15.2 baseline. Regression:
  `seed-invariants.test.ts` + `registry.test.ts`.
- ✅ **No new environment default was flipped.**
  `TRADING_ENABLED`, `EXECUTION_RUNTIME_ENABLED`,
  `TRADING_LOOP_ENABLED` all remain `false` in every
  committed config.
- ✅ **`TRADING_ENABLED=false` now blocks Paper AND Live
  writes.** r3 introduced the closed exempt-routes list
  (cancel-proposed + reconciliation operator surface); r4
  tightened it so exempt routes bypass ONLY the write switch,
  never the account allowlist or the known-account
  requirement. Regression: `env-guard.test.ts`,
  `paper-guard.test.ts`, `write-guard-exemptions.test.ts`,
  `write-guard-integration.test.ts`.
- ✅ **Strategy-policy check is strict fail-closed.** Missing
  `strategyId`, mismatched `strategyId`, and mismatched
  direction all short-circuit before the submitter.
  Regression: `trading-loop-service.test.ts` §PR15.3 Finding 2.
- ✅ **No dated contract, account ID, token, or raw
  `INSTRUMENT_BINDINGS_JSON` is committed.**
- ✅ **Bearer auth, audit, account allowlist, reconciliation
  gate, exposure guard, and binding authority are unchanged
  in scope.** `PaperGuard` was extended in r2 (cross-checks
  `/ready.tradingEnabled`); `env-guard.ts` was split in r4 into
  `assertTradingEnabled` and `assertActiveAccountAllowed`
  while preserving all pre-r3 test invariants.
- ✅ **No `ib.placeOrder` outside execution-engine.**
- ✅ **No scheduler startup.** Defaults stay off; regression
  tests prove `TradingLoopService.start()` is a no-op when
  `TRADING_LOOP_ENABLED=false`.
- ✅ **No fake signals, no artificial strategyId injection,
  no lowered strategy thresholds.**
- ✅ **No PR16 or exit-management work in scope.** No
  close-position / flatten / exit-position endpoint exists;
  the runbook Phase D §5 explicitly documents the
  alternatives when a cancel alone cannot neutralise
  exposure.
- ⚠ **PR15.3 activation is BLOCKED.** Re-activating any seed
  requires the r2 prerequisite (PLAN §11.3) — a follow-up PR
  that plumbs a real strategyId + direction through the
  Phase 2 pipeline. Runbook Phase B MUST NOT be executed
  until then.

## 12. Hostile-review corrections (2026-08-05)

### 12.1 Findings verified against source

| Finding | Severity | Verified true against | Applied fix |
| --- | --- | --- | --- |
| 1 — `TRADING_ENABLED=false` did NOT block Paper writes | P1 | `apps/execution-engine/src/env-guard.ts` — the pre-fix function only consulted `tradingEnabled` on the `live` branch | `assertEnvironmentAllowsWrite` now short-circuits BOTH environments with reasons `paper_trading_disabled` / `live_trading_disabled` before the whitelist check. `PaperGuard` cross-checks `ReadinessResponse.tradingEnabled`. New tests in `env-guard.test.ts` (paper-off, precedence over whitelist, null-account bootstrap) and `paper-guard.test.ts` (kill-switch off, missing field). |
| 2 — strategy-policy check was a no-op | P1 | Shared `SignalEngine.evaluate` never sets `SignalMetadata.strategyId`; r1 check allowed `undefined` | Rolled back `es_front.executionEnabled`. Strengthened trading-loop check to strict fail-closed on missing / mismatched `strategyId`. Added `InstrumentExecutionPolicy.expectedDirection` and direction check against `decision.action`. Removed the "undefined → allowed" test; added strict tests: "MISSING → STRATEGY_POLICY_MISMATCH", "SHORT under LONG policy → STRATEGY_POLICY_MISMATCH", "HOLD under directional policy → STRATEGY_POLICY_MISMATCH", "LONG under LONG policy → SUBMITTED". |
| 3 — `<masked>` whitelist in runbook | P2 | Runbook literally instructed `ALLOWED_PAPER_ACCOUNTS=<masked>` | Runbook now instructs shell-expanded FULL DU id (`${PAPER_ACCOUNT_ID}`) with explicit note that the whitelist is a literal string `.includes()`; masking applies only to reports / logs / evidence. |
| 4 — wrong SQL against `broker_position_snapshots` | P2 | Real schema has `(account_id, instrument, conid, quantity, session_id, observed_at)`; `complete` + `generation` live on `broker_snapshot_syncs` (see `infra/sql/migrations/000002_execution_pr13_pr14.sql`) | Runbook queries split into two: one against `broker_position_snapshots`, one against `broker_snapshot_syncs`. Correct columns. Account id passed via `-v account_id=…` + `:'account_id'` psql substitution. |
| 5 — wrong reconciliation contract | P2 | `GET /execution/reconciliation/latest` returns `{ accountId, sessionId, run, latestInSession, latestOverall, stale, maxAgeSeconds }`; no top-level `mismatches` / `holds` / `complete` (see `apps/execution-engine/src/reconciliation/routes.ts:69–96`) | Runbook now reads `run.status`, `run.snapshotComplete`, `run.sourceCoverage`, `run.mismatchesCount`, `stale`. Active holds pulled from separate `GET /execution/reconciliation/holds?active=true` returning `{ accountId, holds }`. |
| 6 — `/watchlist.bindings` wrongly asserted to include `conId` | P2 | Ingestion `bindings` block is `authority.toDiagnostics()` = `{ boundCount, ids }` only; `conId` lives on the individual `watchlist[]` entry (`apps/ingestion/src/index.ts:172–212`) | Runbook now uses `bindings.{boundCount, ids}` for count/ID diagnostic and the per-entry `watchlist[]` element with `instrumentId === "es_front"` for exact `conid` / `subscribed` verification. |

### 12.2 Sandbox / socket note

`pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm lint`,
and `pnpm paper:verify-stack:fixture` all completed inside the
sandbox — none of the fixtures required a listening socket
outside the loopback interface, so no `listen EPERM` fallbacks
were needed. See §12.3 for numeric results.

### 12.3 Gate results at HEAD (post-correction)

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | 0 errors; 3 pre-existing warnings in unrelated files (`apps/backtest-engine/src/simulator.ts`, `apps/llm-agent/src/config.ts`, `apps/ui/vite.config.ts`) |
| Typecheck | `pnpm typecheck` | ✅ all 8 workspace projects Done |
| Unit tests | `pnpm test` | ✅ **1,022 tests, 0 failures** (packages/shared 329, tools/paper-verify-stack 152, apps/ingestion 30, apps/signal-engine 308, apps/execution-engine 206, apps/llm-agent 1) |
| Integration | `TEST_POSTGRES_URL=... pnpm test:integration` | ✅ **316 tests, 0 failures** |
| Build | `pnpm build` | ✅ all packages built |
| Paper verifier | `pnpm paper:verify-stack:fixture` | ✅ PASS (opt-out=13 requests, exit=0; opt-in=14 requests, exit=0) |

### 12.4 Second-pass hostile-review checklist

- Paper + `TRADING_ENABLED=false` → refused (env-guard fires;
  PaperGuard fires) — proven by unit tests, verified in code.
- Missing / fake `strategyId` → refused before submitter —
  proven by unit tests.
- SHORT decision under a LONG policy → refused before
  submitter — proven by unit tests.
- Zero broker call on every fail-closed path — asserted by
  `assert.equal(executionRuntime.preparedCalls.length, 0)` in
  every strategy-policy negative test.
- Runbook SQL uses real column names; account id is
  parameterised through psql `-v`. Verified against
  `infra/sql/migrations/000002_execution_pr13_pr14.sql`.
- Runbook reconciliation contract matches the real routes
  handlers in `apps/execution-engine/src/reconciliation/routes.ts`.
- No secrets, no real `conId`, no real DU account id in the
  diff. `git diff` grepped for `DU\d+`, `\bU\d{7,}\b`,
  `sk-`, and raw JSON binding payloads — clean.
- No second execution-enabled seed. `defaultInstrumentRegistry.listExecutionEnabled()`
  returns `[]`. Regression: `seed-invariants.test.ts`.
- Scheduler default and operationally OFF: `TRADING_LOOP_ENABLED`
  defaults to `false`; regression tests prove `start()` is a
  no-op; the trading-loop routes plugin only registers when
  `EXECUTION_RUNTIME_ENABLED=true`.

## 13. Hostile-review r3 corrections (2026-08-06)

Second-round hostile review uncovered four issues left after r2.
All four were addressed inside this correction pass. No commit
was made; no real broker interaction occurred; `es_front` stays
`executionEnabled=false`.

### 13.1 r3 Finding 1 — abort procedure could not neutralise broker orders

Before r3, the runbook Phase D / abort procedure asked the
operator to set `TRADING_ENABLED=false` first and only then
cancel outstanding broker orders. The environment guard in
`apps/execution-engine/src/index.ts` refused every mutating
`/execution/*` request under `TRADING_ENABLED=false` except
those under the historic `/execution/reconciliation/` prefix,
which meant `POST /execution/cancel-proposed/:id` returned
`423 paper_trading_disabled` and there was NO audited path to
cancel a live broker order. Writes-off was, in practice, worse
than useless during an incident.

**Fix.**

- New module `apps/execution-engine/src/write-guard-exemptions.ts`
  exports a **closed, exact-match** exemption list:
  1. `POST /execution/cancel-proposed/:id` — risk-reducing
     broker cancel.
  2. `POST /execution/reconciliation/run` — operator
     diagnostic path.
  3. `POST /execution/reconciliation/holds/:id/acknowledge` —
     operator acknowledge.
  4. `POST /execution/reconciliation/holds/:id/resolve` —
     operator resolve, gated by a secondary token.
- The `preHandler` hook now calls `isWriteGuardExempt(method,
  request.routeOptions.url)` — matching against the Fastify
  DECLARED route path, not the raw URL, so a query-string or
  parameter smuggling attempt cannot bypass the check. Bearer
  auth + audit still run BEFORE the guard.
- `execute-ticket`, `execute-proposed/:id`, `reject-proposed/:id`,
  `bootstrap`, `refresh-position-snapshot`, `alerts/test`, and
  the legacy `POST /execution/reconciliation` (no trailing
  slash) STAY under the guard — none of them reduce broker
  exposure.

**Regression coverage** (added in this PR):

- `apps/execution-engine/src/write-guard-exemptions.test.ts` —
  16 tests locking the closed exemption list (per-entry
  positive/negative, method case, query-string stripping,
  no-prefix-wildcard, missing route, and a full-list equality
  test that forces the reviewer to update the invariant when
  the list changes).
- `apps/execution-engine/src/write-guard-integration.test.ts` —
  16 HTTP-level tests instantiating a minimal Fastify app with
  the same `preHandler` shape as `index.ts`. Proves the exact
  Paper + writes-off / Paper + writes-on / Live + writes-off
  matrix from the plan §1 including the fabricated
  `/execution/reconciliation/holds/:id/close` sub-path (still
  423, no wildcard) and a GET regression.

### 13.2 r3 Finding 2 — Phase A verifier: false-green + impossible-green

`pnpm paper:verify-stack` had no expected-write-state input, so
Phase A (`TRADING_ENABLED=false`) with `/runtime/execute/ready`
returning 503 (because `PaperGuard.check()` now correctly
refuses `tradingEnabled=false`) surfaced as UNHEALTHY — the
operator could not verify infrastructure while writes were
administratively paused. In parallel, `execution.ready` never
compared `tradingEnabled` against operator expectation, so a
Phase-B-forgotten deploy (`TRADING_ENABLED=true` after the
window closed) would silently report HEALTHY.

**Fix.**

- `tools/paper-verify-stack/src/config.ts` — new env variable
  `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE = "enabled" | "disabled" | "absent"`.
  Default `absent` (backwards-compat: pre-PR15.3-r3 callers
  keep the pre-check behaviour). The tool refuses to accept
  `disabled` / `enabled` when the execution runtime is expected
  `absent` (nonsensical combination).
- `tools/paper-verify-stack/src/checks/execution.ts` — when
  `writeExpected=disabled` and `j.tradingEnabled !== false`,
  add reason `write_expected_disabled_but_enabled`. Symmetric
  for `enabled`. Actual + expected + result surfaced in
  `details.writeExpected`.
- `tools/paper-verify-stack/src/checks/signal.ts` — the
  `signal.execute.ready` sub-check treats the SPECIFIC
  paperGuard failure `error =~ /tradingEnabled=false/` as an
  infrastructure-side pass ONLY when
  `writeExpected=disabled`. Every other paperGuard failure
  (network error, environment mismatch, account mismatch,
  missing tradingEnabled field) still surfaces UNHEALTHY.
  Redis / Postgres subchecks remain strict.
- `POST /runtime/execute` and `POST /runtime/trading-loop/run-once`
  are UNTOUCHED — they continue to fail-closed on
  `paperGuard.ok=false`, so the expected-state gate CANNOT
  enable a submission by itself.

**Regression coverage** (added in this PR):

- `tools/paper-verify-stack/src/checks/write-expected-state.test.ts` —
  6 direct check tests: Phase A A1 (writes-off HEALTHY on both
  checks), A2 (writes-on under writeExpected=disabled →
  UNHEALTHY), A3 (unrelated paperGuard failure stays
  UNHEALTHY), Phase B B1 (writes-on HEALTHY), B2 (writes-off
  under writeExpected=enabled → UNHEALTHY), Legacy L1 (no
  expectation still HEALTHY with tradingEnabled=false).

**Runbook** (`docs/runbooks/PAPER_ENTRY_E2E.md`) now sets the
full `PAPER_VERIFY_*` variable set explicitly for Phase A and
Phase B, including
`PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled` for
Phase A / D and `enabled` for Phase B.

### 13.3 r3 Finding 3 — account ID leaked via argv

The r2 runbook fed the account ID to psql via
`-v account_id="$ACCOUNT_ID"`, which puts the full value in
`argv` (visible in `ps` output, container process listings, and
audit logs on hosts where argv is captured). Prefixing a
variable assignment on the same command line was also
misleading — it did not sanitise argv.

**Fix.**

All psql invocations in `docs/runbooks/PAPER_ENTRY_E2E.md` now
follow this pattern:

```
docker compose exec -T -i postgres psql -U postgres -d ikbr_trader \
    -v ON_ERROR_STOP=1 <<PSQL
\set account_id '$PAPER_ACCOUNT_ID'
SELECT ... WHERE account_id = :'account_id' ...;
PSQL
```

The `$PAPER_ACCOUNT_ID` interpolation happens in the operator's
local shell BEFORE `docker compose exec` is spawned; the value
is delivered to `psql` via standard input (heredoc). `argv` for
the `docker compose exec` and `psql` processes contains ONLY
`-v ON_ERROR_STOP=1`. The runbook explicitly asks the operator
to verify with `ps auxww | grep psql` that the account id does
NOT appear.

The runbook also adds a fail-closed sanity guard
`: "${PAPER_ACCOUNT_ID:?…}"` and a masked
`printf` (`XX***YYY, len=N`) so the operator can confirm the
variable is set without printing the full value.

### 13.4 r3 Finding 4 — r1 documentation remnants

Sweeping `docs/implementation/phase2/PR15_3_PLAN.md`,
`docs/implementation/phase2/PR15_3_REPORT.md`, `docs/implementation/phase2/PHASE_2_ROADMAP.md`,
and `docs/runbooks/PAPER_ENTRY_E2E.md` for r1 residue:

- "**implemented, in review**" mentions in `PR15_3_REPORT.md`
  (2 remaining after r2) → replaced with "**blocked, not
  ready**" / reference to §11 prerequisite.
- Plan §2 (Outcome) was written as if `es_front` were already
  active — it now carries a top banner stating those outcomes
  are the **target state** conditional on the r2 prerequisite,
  and reiterating that at HEAD PR15.3 is blocked.
- Plan §4.5 (Documentation status) — the roadmap flip
  instruction now explicitly gates on the r2 prerequisite
  before flipping past `blocked, not ready`.
- Report §6 (Compatibility / migration) — bullets about "the
  strategy-policy check is a no-op" and "activation flips
  `es_front`" were replaced with the accurate rollback wording
  and a note that the check is inert only because no seed
  carries an `executionPolicy` at HEAD; it becomes the primary
  blocker under any re-activation attempt without a follow-up
  strategy-plumbing PR.
- Report §1.5 (Documentation) — bullet on the roadmap flip
  updated to reflect `blocked, not ready`.
- Roadmap PR15.3 row now notes both r2 (Findings 1 & 2) and r3
  (Findings 1–4).
- No documented text claims a `close` / `flatten` endpoint
  exists; the runbook §5 Phase D step 3 explicitly states
  "There is NO audited `close-position` / `flatten` /
  `exit-position` endpoint in the current codebase" and lists
  the three operator options that do not require introducing
  one (protective children, fresh-approval bracketed close via
  the guarded write path, incident escalation).

### 13.5 r3 gate results

Executed against a running local Postgres (`postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader`)
via the operator's sandbox — no external network calls, no
IBKR, no live broker.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | **0 errors**; 3 pre-existing warnings in unrelated files (`apps/backtest-engine/src/simulator.ts`, `apps/llm-agent/src/config.ts`, `apps/ui/vite.config.ts`) — identical to the r2 baseline. |
| Typecheck | `pnpm typecheck` | ✅ all 8 workspace projects Done. |
| Unit tests | `pnpm test` | ✅ **1,066 tests, 0 failures, 0 skipped** (packages/shared 329, tools/paper-verify-stack 158, apps/ingestion 30, apps/signal-engine 308, apps/execution-engine 240, apps/llm-agent 1). |
| Integration | `TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader pnpm test:integration` | ✅ **350 tests, 0 failures, 0 skipped**. PG-integration suites were actually executed against a live Postgres — none were skipped for missing `TEST_POSTGRES_URL`. |
| Build | `pnpm build` | ✅ all packages built. |
| Paper verifier fixture | `pnpm paper:verify-stack:fixture` | ✅ PASS (opt-out=13 requests, exit=0; opt-in=14 requests, exit=0). |
| Trailing whitespace | `git diff --check` | ✅ clean. |

Delta vs. r2 baseline:

- +34 execution-engine tests (206 → 240): 16 pure predicate
  tests for the exemption list + 16 HTTP-level guard tests +
  2 pre-existing failing tests that had to be updated for the
  guard-exemption preHandler change (no — verified: baseline
  was 206 and all pre-existing tests still pass).
- +6 paper-verify-stack tests (152 → 158) — Phase A / Phase B
  / legacy write-state scenarios.
- +5 signal-engine tests unchanged (308 → 308). No signal-engine
  regression touched.
- +34 integration tests (316 → 350) reflect the same
  execution-engine test additions.

### 13.6 r3 hostile-review (self) checklist

- **Paper + `TRADING_ENABLED=false` can still submit a NEW
  order?** No. `execute-ticket` and `execute-proposed/:id`
  both return `423 paper_trading_disabled` (proven by
  `write-guard-integration.test.ts`). PaperGuard on the
  signal-engine side also fails-closed on
  `tradingEnabled=false`, so `POST /runtime/execute` and
  `POST /runtime/trading-loop/run-once` still short-circuit.
- **Exemption too broad?** No. Closed exact-match list of 4
  entries; a full-list equality test locks the invariant.
  A fabricated sub-path (`/execution/reconciliation/holds/:id/close`)
  under the reconciliation prefix stays 423.
- **Ability to cancel a broker order during administrative
  stop?** Yes — that is the point of the exemption for
  `cancel-proposed/:id`. Still bearer + audit + status
  validation.
- **False-green in Phase A?** No.
  `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled`
  requires `tradingEnabled=false` AND accepts the specific
  paperGuard `tradingEnabled=false` failure. Any other
  paperGuard failure OR `tradingEnabled=true` under
  `disabled` expectation surfaces UNHEALTHY.
- **Runbook drift from real endpoints?** Runbook now
  references only endpoints that actually exist in
  `apps/execution-engine/src/index.ts` and
  `apps/execution-engine/src/reconciliation/routes.ts`.
  Grep confirmed no lingering `close-position` /
  `flatten` / `exit-position` claims.
- **Full account id leaked to argv / logs / docs?** No. All
  psql invocations feed the value on stdin via `\set`; the
  runbook explicitly instructs `ps auxww | grep psql`
  verification; masked confirmation avoids printing the
  full value. No account id / conId / token / raw binding
  JSON in the diff — verified by
  `git diff | grep -Ei 'DU[0-9]{5,}|\\bU[0-9]{7,}\\b|sk-|BEGIN PRIVATE KEY'`
  (empty output).
- **r1 activation remnants?** Report §6, plan §2 and §4.5,
  and roadmap all reflect `blocked, not ready`. No text
  claims `es_front` is active or that PR15.3 is
  implemented / shipped.

## 14. Hostile-review r4 corrections (2026-08-06)

Fourth-round hostile review found five issues left after r3.
All were addressed inside this correction pass. No commit was
made; no real broker interaction occurred; `es_front` stays
`executionEnabled=false`; no seed carries an `executionPolicy`.

### 14.1 r4 Finding 1 — exempt routes bypassed the account allowlist

The r3 pre-handler shape was:

```ts
if (isWriteGuardExempt(...)) return;
assertEnvironmentAllowsWrite(cfg, lastActiveAccountId);
```

That `return` meant the closed exemption list (cancel-proposed
+ reconciliation operator surface) bypassed BOTH the
administrative write switch AND the account allowlist. An
operator could, at least in principle, cancel an order or
resolve a reconciliation hold against an unrelated broker
account (or against `activeAccountId === null` when the broker
session had not yet resolved). Bearer + audit still ran, but
the actual policy decision was missing.

**Fix.**

- `apps/execution-engine/src/env-guard.ts` was split into two
  composable helpers:
  - `assertTradingEnabled(cfg)` — pure administrative write
    switch. Emits `paper_trading_disabled` /
    `live_trading_disabled`. No account input.
  - `assertActiveAccountAllowed(cfg, id, opts)` — environment
    + whitelist. New `opts.requireKnownAccount` mode adds a
    fifth reason `no_active_account_for_exempt_route` for
    risk-reducing endpoints so a pre-bootstrap process cannot
    accept a cancel or reconcile against an unresolved
    account.
  - `assertEnvironmentAllowsWrite(cfg, id)` is preserved as
    the composite (`assertTradingEnabled` first, then
    `assertActiveAccountAllowed`) so every pre-r4 test
    invariant on error precedence (`paper_trading_disabled`
    fires BEFORE the whitelist) still holds.
- The Fastify pre-handler in
  `apps/execution-engine/src/index.ts` was updated:

  ```ts
  const cfg = envGuardConfig();
  if (isWriteGuardExempt(method, route)) {
    assertActiveAccountAllowed(cfg, lastActiveAccountId, {
      requireKnownAccount: true,
    });
    return;
  }
  assertEnvironmentAllowsWrite(cfg, lastActiveAccountId);
  ```

  Exempt routes now bypass ONLY the administrative write
  switch. Environment + account allowlist + known-account
  requirement + bearer + audit ALL still run.

**Regression coverage** (added in r4):

- `apps/execution-engine/src/env-guard.test.ts` — new
  `assertTradingEnabled`, `assertActiveAccountAllowed`, and
  composite-behaviour describe blocks:
  - `assertTradingEnabled` does NOT consult the account
    allowlist (locks the orthogonality invariant that the
    exempt-routes bypass relies on).
  - `assertActiveAccountAllowed` refuses null under
    `requireKnownAccount=true` with
    `no_active_account_for_exempt_route`; allows null under
    default (bootstrap phase).
  - Composite still fires `paper_trading_disabled` /
    `live_trading_disabled` BEFORE the account check.
- `apps/execution-engine/src/write-guard-integration.test.ts`
  — new `PR15.3 r4 account allowlist on exempt routes`
  describe block (7 tests):
  1. Paper + writes-off + WRONG paper account →
     cancel-proposed 423 account_not_allowed_for_paper.
  2. Paper + writes-off + WRONG account →
     reconciliation/run 423 account_not_allowed_for_paper.
  3. Paper + writes-off + WRONG account →
     reconciliation/holds/:id/resolve 423
     account_not_allowed_for_paper.
  4. Live + writes-off + WRONG live account →
     cancel-proposed 423 account_not_allowed_for_live.
  5. Paper + writes-off + NO active account →
     cancel-proposed 423
     no_active_account_for_exempt_route.
  6. Paper + writes-off + NO active account →
     reconciliation/run 423
     no_active_account_for_exempt_route.
  7. Paper + writes-on + WRONG account → execute-ticket 423
     account_not_allowed_for_paper (normal write path
     unchanged).

Delta: execution-engine unit tests **240 → 261** (+21).

### 14.2 r4 Finding 2 — `docker compose exec -T -i` is invalid

`docker compose exec` (compose v2) does not accept `-i`; the
flag is inherited from `docker exec` and is not present in the
compose command. Stdin is attached by default. Verified with
`docker compose exec --help`:

```
Usage:  docker compose exec [OPTIONS] SERVICE COMMAND [ARGS...]
  -T, --no-TTY   Disable pseudo-TTY allocation. (default true)
  … no -i flag …
```

**Fix.**

All four `-i` occurrences in `docs/runbooks/PAPER_ENTRY_E2E.md`
were removed; each block was augmented with a short reminder
that `docker compose exec` attaches stdin by default. A live
heredoc smoke test was executed against the local Postgres
container (running as `ikbr-trader-postgres-1`) with a
placeholder value `DU_placeholder_only` in place of a real
account id — the query returned the expected row and `ps auxww`
during the run confirmed the placeholder never appeared in
`argv` (only `-v ON_ERROR_STOP=1` was visible).

The Phase A §5 sanity guard for `$PAPER_ACCOUNT_ID` was also
tightened to validate the format before any downstream `\set`
interpolation:

```
set -u
: "${PAPER_ACCOUNT_ID:?…}"
if ! [[ "$PAPER_ACCOUNT_ID" =~ ^(DU|DUPAPER|DUH)[0-9]{4,10}$ ]]; then
  printf 'refusing PAPER_ACCOUNT_ID: format must match …\n' …
  return 1 2>/dev/null || exit 1
fi
```

The regex accepts real IBKR paper account prefixes and refuses
whitespace, quotes, or backslashes that could break out of the
`\set '$PAPER_ACCOUNT_ID'` binding. A masked confirmation prints
`XX***YYY, len=N` — never the full value.

### 14.3 r4 Finding 3 — Phase D used an abbreviated verifier env

The r3 Phase D block was:

```
PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled \
  pnpm paper:verify-stack
```

Every other `PAPER_VERIFY_*` variable therefore fell back to
its schema default. In particular
`PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=absent`, which
SKIPS the execution runtime + trading-loop probes entirely.
Phase D silently confirmed only the ingestion / execution
`/ready` slice and passed even if the execution runtime had
been unregistered mid-window.

**Fix.**

Runbook §3 (Phase A step 3) defines a reusable
`paper_verify_stack_phase()` shell function that encapsulates
the full `PAPER_VERIFY_*` env. Phase A, Phase B and Phase D
each invoke it with the appropriate `disabled` / `enabled`
argument. Each phase ALSO provides a fully self-contained
copy-pasteable `env … pnpm paper:verify-stack` block for
operators who prefer not to source a helper. The `env <same env
as above>` placeholder was removed.

Phase D §4 now explicitly asserts that a bare
`PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled pnpm paper:verify-stack`
is INCORRECT and lists the exact five things the full-env run
must confirm (runtime registered, loop disabled,
`tradingEnabled=false`, Redis/Postgres reachable, PaperGuard in
expected administrative-OFF state).

### 14.4 r4 Finding 4 — cancel identifier could be confused with brokerOrderId

`POST /execution/cancel-proposed/:id` expects the LOCAL
`proposed_orders.id`, but the r3 runbook used the generic
`<orderId>` placeholder. An operator copying `brokerOrderId`
from the IBKR Gateway would 404 or, worse, cancel the wrong
local row that happens to share the same numeric value.

**Fix.**

Runbook §5 Phase D step 3 was rewritten to:

1. Define three identifier types explicitly:
   `proposedOrderId` (local Postgres id, cancel URL parameter),
   `brokerOrderId` (IBKR-issued, stored on the row, NOT the
   URL parameter), and `clientOrderId` (loop idempotency key).
2. Step 3.a — LOOK UP the local row via
   `GET /execution/orders?limit=20` OR a read-only SQL query
   feeding `$PAPER_ACCOUNT_ID` on stdin. Confirm `id`,
   `client_order_id`, `broker_order_id`,
   `instrument_id='es_front'`, and `status='SUBMITTED'` ALL
   match expectations before proceeding.
3. Step 3.b — send the cancel with the LOCAL id, using a
   `PROPOSED_ORDER_ID` shell variable that is regex-validated
   to be a positive integer before the `curl` fires. Explicit
   fail-closed guard rejects non-integers.
4. Step 3.c — CONFIRM the cancel took effect. HTTP 200 alone
   is NOT proof; the operator must (a) verify the Gateway UI
   shows the parent + OCA children as `Cancelled`, (b) re-run
   the local SQL and confirm the row's `status` is
   `CANCELLED`, and (c) trigger a fresh
   `POST /execution/reconciliation/run` (on the exemption
   list) and check `run.mismatchesCount === 0`. A HTTP timeout
   on the cancel is NOT a confirmation and must NOT be
   retried before inspecting broker state.

No `close-position` / `flatten` / `exit-position` endpoint
was introduced. The runbook §7 exclusions list continues to
document that as PR16 territory.

### 14.5 r4 Finding 5 — leftover r1/r2/r3 documentation claims

Sweeping all four docs (`PR15_3_PLAN.md`, `PR15_3_REPORT.md`,
`PHASE_2_ROADMAP.md`, `PAPER_ENTRY_E2E.md`) for the specific
phrases the reviewer called out — using the exact ripgrep
command from the r4 prompt — turned up several leftovers that
r3 had missed:

- `PR15_3_PLAN.md` §8 (Rollback) was written as if `es_front`
  was still active on `main` and a "revert the activation
  commit" was still pending. Reality: nothing was ever
  committed by any PR15.3 revision. Rewrote with a top banner
  making it clear the rollback template applies to a
  HYPOTHETICAL future activation commit, kept the recipe as a
  written template for that follow-up.
- `PR15_3_PLAN.md` §8 also said "Use only existing audited
  cancel/close workflows where required." There is no
  close/flatten workflow. Rewrote to reference the single
  audited endpoint (`cancel-proposed/:id`) and to point at
  the runbook §5 Phase D step 3 for the operator options
  when a cancel alone cannot neutralise exposure.
- `PR15_3_REPORT.md` §1.6 (Test-only registry helpers) and
  §3.1 (New tests) both claimed the binding test
  "destructures the shipped policy off `es_front`" — but at
  HEAD the seed carries no policy. Rewrote to explain the
  destructuring is defensive against a future re-activation
  that might re-add one, and that `withPolicy: false` still
  reliably hits the missing-policy branch.
- `PR15_3_REPORT.md` §8 (Rollback) mirrored the plan's
  problem: it described "the trading-loop strategy-policy
  check disappears (was a no-op in production anyway)". At
  HEAD the check is strict fail-closed; it is inert only
  because no seed carries an `executionPolicy`. Rewrote to
  make that distinction clear and to note that a rollback
  would also revert the r3 write-guard exemption list, the
  r3/r4 PaperGuard cross-check, and the r4 env-guard split
  — undoing which would make the runbook Phase D
  non-executable again.
- `PR15_3_REPORT.md` §9 (Explicit confirmations) claimed
  "PaperGuard, bearer auth, account allowlist, reconciliation
  gate, exposure guard, and binding authority are untouched."
  PaperGuard WAS extended in r2 and env-guard WAS split in
  r4. Rewrote to state which surfaces stayed exactly the
  same and which were extended, with pointers to the
  regression tests that lock the new invariants.
- `PHASE_2_ROADMAP.md` PR15.3 row was updated to reflect r4
  in addition to r2 and r3.

Historical descriptions of r1 / r2 / r3 defects (the
`no-op today` in r2 Finding 2, "activation commit" in r3
Finding 1 description, "shipped as `1472a33`" for PR15.2)
were kept as historical claims; each is either wrapped by
its own hostile-review section header or is a factual claim
about an earlier PR that IS shipped.

### 14.6 r4 gate results

Executed against the running local Postgres
(`postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader`)
inside the operator's sandbox — no external network calls, no
IBKR, no live broker. No `EPERM` / loopback sandbox failures
were observed.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | **0 errors**; 3 pre-existing warnings in unrelated files (`apps/backtest-engine/src/simulator.ts`, `apps/llm-agent/src/config.ts`, `apps/ui/vite.config.ts`) — identical to the r3 baseline. |
| Typecheck | `pnpm typecheck` | ✅ all 8 workspace projects Done. |
| Unit tests | `pnpm test` | ✅ **1,087 pass / 0 fail / 0 skipped** (packages/shared 329, tools/paper-verify-stack 158, apps/ingestion 30, apps/signal-engine 308, apps/execution-engine 261, apps/llm-agent 1). Delta vs. r3: +21 in execution-engine (env-guard split + exempt-routes-allowlist regressions). |
| Integration | `TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader pnpm test:integration` | ✅ **371 pass / 0 fail / 0 skipped**. PG-integration suites were actually executed against the live Postgres container — none were skipped for missing `TEST_POSTGRES_URL`. Delta vs. r3: +21 (mirrors the execution-engine additions). |
| Build | `pnpm build` | ✅ all packages built. |
| Paper verifier fixture | `pnpm paper:verify-stack:fixture` | ✅ PASS (opt-out=13 requests, exit=0; opt-in=14 requests, exit=0). |
| Trailing whitespace | `git diff --check` | ✅ clean. |

Runtime smoke test of the runbook's psql pattern:

- `docker compose exec -T postgres psql -U postgres -d ikbr_trader -v ON_ERROR_STOP=1 <<PSQL`
  with `\set demo_var 'DU_placeholder_only'` and
  `SELECT 1 AS heredoc_smoke_test, :'demo_var' AS bound_var;`
  returned `1 | DU_placeholder_only`.
- `ps auxww | grep psql` during a concurrent `pg_sleep(0.5)`
  run showed argv `docker compose exec -T postgres psql -U
  postgres -d ikbr_trader -v ON_ERROR_STOP=1` and NO
  occurrence of the placeholder value.

### 14.7 r4 hostile-review (self) checklist

- **Does an exempt route still work for the wrong or unknown
  account?** No. `write-guard-integration.test.ts` proves
  cancel-proposed / reconciliation/run / reconciliation
  hold-resolve all return 423
  `account_not_allowed_for_paper|live` on a wrong account,
  and 423 `no_active_account_for_exempt_route` on null.
- **Does the exempt path bypass ONLY the write switch?** Yes.
  The pre-handler calls `assertActiveAccountAllowed(...,
  { requireKnownAccount: true })` on the exempt branch; the
  full-composite `assertEnvironmentAllowsWrite` runs on the
  normal write branch. Unit tests
  (`assertTradingEnabled does NOT consult the account
  allowlist`) lock the orthogonality invariant.
- **Can a new submission fire while `TRADING_ENABLED=false`?**
  No — every non-exempt mutating endpoint returns 423
  `paper_trading_disabled` / `live_trading_disabled`; the
  signal-engine `POST /runtime/execute` and
  `POST /runtime/trading-loop/run-once` short-circuit via
  `PaperGuard.check()`, which now fails-closed on the
  `/ready.tradingEnabled === false` cross-check.
- **Is every runbook block self-executable?** Yes. Every
  Phase A/B/D verifier call is either a helper invocation or
  a fully-specified `env … pnpm paper:verify-stack` block;
  no `<same env as above>` placeholder remains. Every SQL
  block starts with `docker compose exec -T` (no `-i`) and
  binds `$PAPER_ACCOUNT_ID` inside a `\set` heredoc.
- **Does `docker compose exec` use only supported flags?**
  Yes. Verified against `docker compose exec --help` and via
  a live smoke test.
- **Does Phase D actually confirm the execution runtime?**
  Yes. Phase D §4 uses the full `paper_verify_stack_phase
  disabled` (or the equivalent explicit env) and enumerates
  the five things the run must confirm; the shortcut
  `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled
  pnpm paper:verify-stack` is now explicitly called out as
  INCORRECT.
- **Can the operator confuse proposedOrderId with
  brokerOrderId?** Not without deliberately ignoring the
  runbook: §5 Phase D step 3 defines both terms, requires a
  read endpoint / SQL look-up that surfaces both, and uses a
  regex-validated `PROPOSED_ORDER_ID` shell variable so the
  cancel URL cannot accept a broker id shaped like `1.5678e6`
  or an alphanumeric.
- **Does the account id leak to argv / logs / history?** No.
  Live `ps auxww` inspection during a real query confirmed
  argv holds only the psql flags; the account id lives on
  stdin. `git diff | grep -Ei 'DU[0-9]{5,}|\bU[0-9]{7,}\b|sk-'`
  returns only the pre-existing `DU1234567` test fixture
  from `env-guard.test.ts` — no real account.
- **Any leftover r1 / r2 / r3 documentation claims?** No.
  The reviewer's targeted grep
  (`close workflow|cancel/close|returns to executionEnabled|activation commit|no-op|untouched|account_id=.*-v|implemented, in review|shipped`)
  now returns only historical descriptions of earlier PR
  revisions or of ALREADY-SHIPPED sibling PRs (PR15.2 is
  legitimately shipped as `1472a33`). No text at HEAD claims
  `es_front` is active, that PR15.3 is implemented / shipped,
  that a rollback is still pending, that a close/flatten
  workflow exists, that the strategy-policy check is a no-op,
  or that PaperGuard is untouched.

## 15. Hostile-review r5 corrections (2026-08-06)

Fifth-round hostile review found four minor documentation and
messaging defects left after r4. All were addressed inside this
correction pass. No commit was made; no real broker interaction
occurred; `es_front` stays `executionEnabled=false`; no seed
carries an `executionPolicy`.

### 15.1 r5 Finding 1 — `/execution/orders` uses camelCase; jq filter was snake_case

The r4 runbook Phase D step 3.a proposed:

```
| jq '[.[] | select(.instrument_id == "es_front" and .status == "SUBMITTED")]'
```

`/execution/orders` serialises `ProposedOrder` in **camelCase**
(the `mapRow` projection in
`apps/execution-engine/src/repository.ts` sets
`instrumentId: row.instrument_id` when non-null). Filtering by
`.instrument_id` therefore always returned the empty array; an
operator following the runbook literally would think no
matching row existed.

**Fix.**

- Runbook Phase D §5 step 3.a jq filter now reads
  `.instrumentId`. The step gains an explicit paragraph about
  the camelCase-vs-snake_case difference between the HTTP
  response and the Postgres columns, and a note that
  `clientOrderId` / `clientOrderHash` are NOT projected by
  `/execution/orders` — the SQL fallback (unchanged) is the
  source of truth for those fields.
- The confirmation list now shows both spellings
  (`instrument_id` / `.instrumentId`, `broker_order_id` /
  `.brokerOrderId`) so the operator picks the right one for
  the SQL query vs. the HTTP payload.
- Phase C §4 step 1 (which mentions `/execution/orders`
  without a jq filter) was rewritten to state the exact
  camelCase field names the endpoint returns and to point
  the operator at the SQL query in step 2 for the
  `clientOrderId` → `id` resolution.

No tests were needed — the change is purely a runbook
correction against a shipped API contract (`ProposedOrder.mapRow`
in `apps/execution-engine/src/repository.ts`).

### 15.2 r5 Finding 2 — `paper_verify_stack_phase()` forwarded the write-state to pnpm

The r4 helper was:

```
paper_verify_stack_phase() {
  local write_state="${1:?…}"
  case "$write_state" in disabled|enabled) ;; *) …;; esac
  env … pnpm paper:verify-stack "$@"
}
```

`"$@"` still contains the `$1` positional argument (`disabled`
or `enabled`), so it was forwarded to
`pnpm paper:verify-stack disabled`. `pnpm` treats unknown
positional args as script arguments; the paper-verify CLI
ignores anything that is not `--json`, so the run succeeded
by luck, but the shape was incorrect and would break if the
CLI added a positional-argument parser.

**Fix.**

Runbook §3 helper adds `shift` right after the validation:

```
paper_verify_stack_phase() {
  local write_state="${1:?…}"
  case "$write_state" in disabled|enabled) ;; *) …;; esac
  shift
  env … pnpm paper:verify-stack "$@"
}
```

Extra positional args after the write-state (e.g. `--json`)
are still forwarded verbatim: `paper_verify_stack_phase
disabled --json` works exactly as before.

### 15.3 r5 Finding 3 — env-guard message overclaimed the block scope

`assertTradingEnabled` in
`apps/execution-engine/src/env-guard.ts` threw with the
message:

```
This is the master kill switch — it blocks every mutating
/execution/* request regardless of environment.
```

That is factually WRONG after r3 introduced the closed
exempt-routes list. `POST /execution/cancel-proposed/:id`
and the three reconciliation operator endpoints DO reach
their handlers while `TRADING_ENABLED=false` (after passing
bearer + audit + account allowlist + known-account
requirement). The message contradicted the actual behaviour
and would mislead an operator reading the error body during
an incident.

**Fix.**

- Both `paper_trading_disabled` and `live_trading_disabled`
  messages now describe reality: the switch blocks
  operations that CREATE or EXPAND broker exposure; the
  closed exempt list (`cancel-proposed/:id` +
  reconciliation operator surface) remains available after
  bearer, audit, and account-allowlist checks.
- The `env-guard.ts` header comment (the block referenced as
  the "PR15.3 r3 hostile-review Finding 1" note) was
  rewritten in place — the phrase "UNIVERSAL kill switch"
  was replaced with an accurate description of what the
  switch does and does NOT block, and the four exempt
  endpoints are enumerated inline.
- The parallel comment in
  `apps/signal-engine/src/runtime/execution/ready-probe.ts`
  and the fixture note in
  `apps/signal-engine/src/runtime/execution/execution-runtime.test.ts`
  received the same softening for consistency.
- `apps/execution-engine/src/env-guard.test.ts` — the
  regression `PR15.3 — paper + TRADING_ENABLED=false → 423
  paper_trading_disabled` test now asserts:
  - `err.message` matches `/TRADING_ENABLED=false/`
    (unchanged),
  - `err.message` matches `/cancel-proposed/` — the
    exemption is documented in the error body,
  - `err.message` matches `/account-allowlist/` — the
    hierarchy of checks is documented,
  - `err.message` does NOT match `/master kill switch/i`
    — the retired overclaim would fail-loud if
    reintroduced.

Delta vs. r4: `apps/execution-engine` test count is
UNCHANGED (261 total, no new tests added; one existing test
switched assertions). No other test file needed updating —
the paper-guard result reason (`"execution-engine reports
tradingEnabled=false (TRADING_ENABLED=false — administrative
kill switch)"`) describes the state execution-engine
REPORTS via `/ready.tradingEnabled`, not what the switch
does, and stays accurate. The `write-expected-state.test.ts`
regex `/tradingEnabled=false/` still matches the paper-guard
reason string.

### 15.4 r5 Finding 4 — plan §11.4 still referenced `-v account_id=…`

The r3 plan §11.4 summary of Findings 3–6 said:

```
SQL uses parameterised psql variables (`-v account_id=…` +
`:'account_id'`) so the account id is not committed to shell
history nor visible in `ps` output.
```

That was true of r3's runbook wording but was superseded in
r4 (Finding 3 — `-v account_id="$ACCOUNT_ID"` still puts the
value in `argv`; r4 switched every SQL block to the stdin +
`\set` heredoc pattern). The plan summary was left stale.

**Fix.**

`docs/implementation/phase2/PR15_3_PLAN.md` §11.4 bullet on
SQL now describes the actual r4 form: `docker compose exec
-T postgres psql … <<PSQL` heredoc, `\set account_id
'$PAPER_ACCOUNT_ID'` on the first heredoc line,
`:'account_id'` inside the SELECT. Explicit note that the
old `-v account_id=…` shape is superseded and that the
current runbook (§5 Phase A step 5, §4 Phase C step 3, and
§5 Phase D step 3 in `PAPER_ENTRY_E2E.md`) shows the correct
form.

### 15.5 r5 gate results

Executed against the running local Postgres
(`postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader`)
inside the operator's sandbox — no external network calls,
no IBKR, no live broker. No `EPERM` / loopback sandbox
failures were observed. **No connection to a real IBKR Paper
Gateway was made in this pass** and no real Paper E2E was
executed.

| Gate | Command | Result |
| --- | --- | --- |
| `git diff --check` | `git diff --check` | ✅ clean (no whitespace / merge markers). |
| Typecheck | `pnpm typecheck` | ✅ all 8 workspace projects Done. |
| Lint | `pnpm lint` | **0 errors**; 3 pre-existing warnings in unrelated files (`apps/backtest-engine/src/simulator.ts`, `apps/llm-agent/src/config.ts`, `apps/ui/vite.config.ts`) — identical to the r3 / r4 baseline. |
| Unit tests | `pnpm test` | ✅ **1,087 pass / 0 fail / 0 skipped** — unchanged vs. r4 (packages/shared 329, tools/paper-verify-stack 158, apps/ingestion 30, apps/signal-engine 308, apps/execution-engine 261, apps/llm-agent 1). |
| Integration | `TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/ikbr_trader pnpm test:integration` | ✅ **371 pass / 0 fail / 0 skipped** — unchanged vs. r4. PG-integration suites were actually executed against the live Docker Postgres container. |
| Build | `pnpm build` | ✅ all packages built. |
| Paper verifier fixture | `pnpm paper:verify-stack:fixture` | ✅ PASS (opt-out=13 requests, exit=0; opt-in=14 requests, exit=0). |

### 15.6 r5 hostile-review (self) checklist

- **jq filter matches real API contract?** Yes.
  `apps/execution-engine/src/repository.ts::mapRow` sets
  `instrumentId` (camelCase) from `row.instrument_id`. The
  runbook now uses `.instrumentId` in jq and `instrument_id`
  in psql, and each spelling is explicitly attributed to its
  context.
- **`paper_verify_stack_phase()` forwards only intended
  args?** Yes. `shift` is applied after validating the
  write-state; `--json` and other flags are still passed
  through via `"$@"`.
- **env-guard message accurate?** Yes. The updated body
  describes exposure-creating operations being blocked and
  names the closed exempt list. Regression test locks the
  new message shape and would fail if the retired "master
  kill switch" overclaim was reintroduced.
- **PR15.3 status unchanged?** Yes. PR15.3 is still
  `blocked, not ready`; no seed is
  `executionEnabled=true`; no seed carries an
  `executionPolicy`.
- **No real Paper E2E run?** Confirmed. The only external
  process this pass talked to was the local Docker Postgres
  container (`ikbr-trader-postgres-1`) used by the
  integration test suite. IBKR Paper Gateway was NOT
  contacted; no `run-once`, no `execute-ticket`, and no
  `cancel-proposed` requests were sent against any real
  broker or paper-verify-stack fixture beyond the automated
  fixture harness.
- **Historical results preserved?** Yes. Sections 12
  (r3), 13 (unused / merged into 12/14), and 14 (r4) were
  left intact. This r5 section only adds the four items
  above.

## 16. Hostile-review r6 corrections (2026-08-06)

Sixth-round hostile review flagged two remaining terminology
inconsistencies. Both are documentation / comment fixes; NO
production code or behaviour was changed in this pass.

### 16.1 r6 Finding 1 — `paperBase` comment still said "universal kill switch"

The r5 pass updated the `assertTradingEnabled` error message
and the `env-guard.ts` header comment but left the `paperBase`
fixture comment in
`apps/execution-engine/src/env-guard.test.ts` claiming that
`TRADING_ENABLED` is "the universal kill switch". That
contradicts the r3 closed exempt-routes list which keeps
`POST /execution/cancel-proposed/:id` and the three
reconciliation operator endpoints reachable after bearer +
audit + account allowlist + known-account checks.

**Fix.**

- `apps/execution-engine/src/env-guard.test.ts` — the `paperBase`
  comment now describes the switch as an "administrative
  write switch that blocks operations that create or expand
  broker exposure" and enumerates which endpoints are
  affected vs. which stay on the closed exempt list. The
  fixture itself (`tradingEnabled: true`, one whitelisted
  paper account) is unchanged; no test body was touched;
  test count stays at 261.

### 16.2 r6 Finding 2 — abort procedure called cancel "the ONE audited write-adjacent endpoint"

`docs/runbooks/PAPER_ENTRY_E2E.md` §6 (Immediate abort
procedure) step 5 previously called
`POST /execution/cancel-proposed/:id` "the ONE audited
write-adjacent endpoint that stays reachable while
`TRADING_ENABLED=false`". The three reconciliation operator
endpoints (`/execution/reconciliation/run`,
`/execution/reconciliation/holds/:id/acknowledge`,
`/execution/reconciliation/holds/:id/resolve`) also stay
reachable — the reader could infer from the runbook that
`cancel-proposed/:id` is the ONLY exempt endpoint at all,
which is inaccurate.

**Fix.**

- Runbook §6 step 5 now says cancel-proposed is the ONLY
  audited endpoint for CANCELLING a broker order that stays
  reachable while writes are disabled, explicitly lists the
  three reconciliation operator endpoints that also stay
  reachable per the closed exemption list (with a pointer to
  `apps/execution-engine/src/write-guard-exemptions.ts`), and
  restates that there is NO automatic `close-position` /
  `flatten` / `exit-position` endpoint in the current
  codebase and one MUST NOT be introduced in scope of
  PR15.3 — that stays PR16 territory.

### 16.3 r6 gate results

Executed against the local repo; no external network, no
IBKR, no live broker.

| Gate | Command | Result |
| --- | --- | --- |
| `git diff --check` | `git diff --check` | ✅ clean. |
| Execution-engine tests | `pnpm --filter @ikbr/execution-engine test` | ✅ **261 pass / 0 fail / 0 skipped** — unchanged from r5. Only the `paperBase` comment was touched; test behaviour is bit-identical. |
| Typecheck | `pnpm typecheck` | ✅ all 8 workspace projects Done. |

Per the r6 prompt, the full unit-test suite, PostgreSQL
integration tests, `pnpm build`, and `pnpm paper:verify-stack:fixture`
were **NOT** re-run — the r6 diff is limited to one code
comment and one runbook paragraph, neither of which can affect
any of those gates. r5 results (1,087 unit pass, 371
integration pass, build ok, fixture PASS) therefore remain
authoritative.

### 16.4 r6 hostile-review (self) checklist

- **Production code changed?** No. Only a JSDoc-style comment
  in `env-guard.test.ts` (test fixture) and a runbook
  paragraph were edited. The compiled JavaScript output of
  every source file is unchanged.
- **Test behaviour changed?** No. `paperBase` still has
  `tradingEnabled: true` and one whitelisted paper account;
  every downstream `assertTradingEnabled` /
  `assertActiveAccountAllowed` / `assertEnvironmentAllowsWrite`
  assertion runs against the same input as before.
- **Terminology consistent across the codebase?** Yes.
  `env-guard.ts` header comment (r5), `assertTradingEnabled`
  error body (r5), `env-guard.test.ts` `paperBase` comment
  (r6), and `ready-probe.ts` inline comment (r5) all use
  variants of "administrative write switch" and enumerate the
  cancel + reconciliation exempt list rather than claiming
  a universal block.
- **Runbook consistent with the exempt list at HEAD?** Yes.
  §6 step 5 now names all four reachable endpoints and the
  code location (`write-guard-exemptions.ts`). §5 Phase D
  step 3 already had the same enumeration (per r3/r4).
- **PR15.3 status?** Unchanged. Still `blocked, not ready`
  in `PHASE_2_ROADMAP.md`. No seed is `executionEnabled=true`;
  no seed carries an `executionPolicy`. The r2 prerequisite
  in §11.3 (real strategy integration) remains open.
- **Real Paper E2E?** NOT performed. No connection was made
  to a real IBKR Paper Gateway in this pass. No `run-once`,
  no `execute-ticket`, no `cancel-proposed` requests were
  sent against any real broker.
