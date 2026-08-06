# PR15.3 — Single-Instrument Entry-Only Paper E2E — PLAN (r2)

> Status: **BLOCKED — awaiting r2 plan approval covering real
> strategy integration**.
>
> Gates on: PR15.2 shipped as `1472a33`.
>
> Scope: opt in exactly one registry instrument (`es_front`) with a
> conservative execution policy, prove the complete
> ingestion → signal-engine → execution-engine → IBKR Paper path with
> one operator-triggered `run-once`, and capture durable evidence from
> the broker, Postgres, and reconciliation.
>
> **Paper only. Entry only. One contract maximum. Scheduler remains
> off. No Live enablement. No automatic roll. No unattended trading.**

## 0. r2 — status after hostile-review

The r1 activation attempt (patch `es_front.executionEnabled=true`
plus a defence-in-depth strategy-policy check) was ROLLED BACK on
2026-08-05 after a hostile review identified two P1 defects the r1
plan did not anticipate:

- **P1 — `TRADING_ENABLED=false` did not block Paper writes.**
  `assertEnvironmentAllowsWrite` only consulted the flag in the Live
  branch, so a Paper `run-once` could still reach the broker when
  the operator believed writes were disabled. Fixed in this
  correction PR (see §11.1) — the flag now short-circuits both
  environments before the account whitelist check, and `PaperGuard`
  cross-checks `/ready.tradingEnabled` for early-signal fail-closed.
- **P1 — strategy-policy check was a no-op.** The shared
  `SignalEngine` (DecisionEngine + RiskEngine) does NOT identify
  the winning strategy; `SignalEvaluation.metadata.strategyId` is
  undefined in production. The r1 check allowed `undefined` and
  therefore never fired. Worse, the generic decision layer could
  emit a `SHORT` action under a `momentum_breakout_long_v1` policy
  without any objection. The check is now strict fail-closed for
  missing / mismatched strategyId AND for mismatched direction,
  but activating `es_front` still requires a plumbing pass that
  routes a real, strategy-attributable identity from the pipeline.
  Until that pass lands, `es_front.executionEnabled` STAYS `false`
  and the strict check fires only in tests. See §11.2.

The runbook is authoritative for the eventual window but MUST NOT
be executed while PR15.3 is blocked.

## 1. Why this PR exists

PR15.2 made contract identity authoritative but intentionally left every
registry seed disabled. The runtime can now prove that one logical
`instrumentId` maps to one exact, operator-selected IBKR contract, but no
production seed has both:

- `trading.executionEnabled=true`; and
- a complete `Instrument.executionPolicy`.

Consequently, the real Phase 2 path has not yet demonstrated that a
generated signal can become one persisted, idempotent, broker-observed
Paper order whose identity and lifecycle reconcile cleanly.

PR15.3 closes only that gap. It is a bounded smoke window, not the
multi-instrument 24-hour "stable paper" promotion defined in
[TESTING_AND_ROLLOUT.md](TESTING_AND_ROLLOUT.md).

## 2. Outcome

> Until the r2 blocking prerequisite (§11.3) is met, the outcomes in
> this section are the **target state**, not the state at HEAD. As of
> the 2026-08 hostile-review corrections (r2 + r3), `es_front` is
> rolled back to `executionEnabled=false`, no seed carries an
> `executionPolicy`, PR15.3 is **blocked, not ready**, and the
> operator MUST NOT execute Phase B of the runbook. When the
> prerequisite lands and this plan flips to `implemented`, the
> outcomes below become the target semantics for that follow-up.

After PR15.3 (target state):

1. `es_front` is the only shipped seed with
   `trading.executionEnabled=true` and a complete, auditable execution
   policy.
2. All other registry seeds remain execution-disabled.
3. A real dated ES Paper contract is supplied only through
   `INSTRUMENT_BINDINGS_JSON`; no expiring `conId` is committed.
4. The stack refuses to run the E2E unless the broker environment is
   `paper`, the active DU account is explicitly allowlisted, the exact
   binding is broker-verified, reconciliation is fresh and clean, and
   broker position state is complete.
5. The operator invokes exactly one bearer-protected
   `POST /runtime/trading-loop/run-once` while
   `TRADING_LOOP_ENABLED=false`.
6. If the strategy produces `NO_TRADE`, the outcome is recorded as a
   safe, valid attempt and no order is forced or synthesized. The
   operator may repeat on a later distinct evaluation bucket only after
   re-running all preflight checks.
7. If a signal is generated, at most one parent intent and its expected
   protective children reach IBKR Paper; the same trigger cannot create
   a duplicate submission.
8. Post-run evidence proves agreement between IBKR, `proposed_orders`,
   order/fill persistence, and reconciliation.
9. The registry default is active only at the instrument gate; all
   process-level write switches remain opt-in and default off.

## 3. Fixed design decisions

### 3.1 One instrument: `es_front`

PR15.3 enables `es_front` only.

Rationale:

- ES is already a curated FUT seed and supported by the active momentum
  strategies;
- it has a stable 0.25 minimum tick and generally deep Paper-market
  liquidity;
- using one instrument keeps binding, exposure, and audit evidence
  unambiguous.

No other seed may be enabled as a side effect. The dated ES contract
(`conId`, `localSymbol`, exchange and trading class) remains an operator
configuration value and must be verified by IBKR at startup.

### 3.2 Conservative execution policy

Add an `Instrument.executionPolicy` to `es_front` with these invariants:

- `strategyId: "momentum_breakout_long_v1"`;
- `timeframe: "1m"`;
- `quantity: 1` and `maxQuantity: 1` contract;
- `quantityUnit: "contracts"`;
- `allowedOrderTypes: ["LMT"]` and `defaultOrderType: "LMT"`;
- `timeInForce: "DAY"`;
- `outsideRth: false`;
- `transmit: true`;
- `priceTickSize: 0.25`;
- `priceRoundingMode: "nearest"`;
- `stopLossDistance: 4.0` (16 ticks, USD 200 per ES contract before
  fees/slippage);
- `takeProfitDistance: 8.0` (32 ticks, 2:1 reward/risk before
  fees/slippage);
- bracket protection is mandatory (`bracketDisabled` must not be true);
- `allowCrossContractExposure: false`.

The implementation pass must confirm these distances against the existing
IBKR bracket translation. They must remain positive, tick-aligned and
covered by tests. They are not operator-overridable through the HTTP
request. Any proposed change to these values requires a plan revision and
fresh approval rather than an implementation-time guess.

If broker verification reports a `minTick` other than `0.25`, startup or
submission must fail closed; the code must not silently rewrite policy.

### 3.3 Manual `run-once`, never the scheduler

The E2E uses the existing
`POST /runtime/trading-loop/run-once` endpoint. During the entire window:

- `TRADING_LOOP_ENABLED=false`;
- `EXECUTION_RUNTIME_ENABLED=true` only to register the runtime and
  trading-loop routes;
- `TRADING_LOOP_INSTRUMENT_IDS=es_front`;
- no interval/startup-delay tuning is used to obtain a submission;
- one operator action equals one cycle.

The endpoint's existing bearer authentication and `PaperGuard` remain
mandatory. PR15.3 must not add an unauthenticated or bypass route.

### 3.4 No forced signal and no broker test order

PR15.3 must exercise the real deterministic pipeline. It must not:

- inject a fake `SignalEvaluation` into production wiring;
- lower strategy or risk thresholds solely to manufacture a trade;
- call `ib.placeOrder` from a test helper;
- submit directly to execution-engine with a hand-built ticket as a
  substitute for the signal-engine path;
- use a market order.

`NO_TRADE` is therefore an acceptable result for an individual attempt,
but does not complete the broker-submission acceptance items. A later
operator-approved attempt may be made on a new evaluation bucket.

### 3.5 Position and cleanup policy

The Phase 2 trading loop remains entry-only. PR15.3 does not implement a
new exit-management subsystem.

Every submitted entry must carry the existing protective bracket. The
operator must observe the parent and both protective legs before leaving
the window unattended. If the parent fills, the position may be closed
only through an existing audited execution-engine close/cancel workflow
or by allowing the verified protective child to execute. IBKR UI
automation is forbidden.

The E2E is not complete while an unexpected open position, orphan order,
active reconciliation hold, or `SUBMIT_UNKNOWN` remains unresolved.

## 4. Implementation scope

### 4.1 Registry activation and policy

Update `packages/shared/src/instruments/definitions.ts`:

- flip only `es_front.trading.executionEnabled` to `true`;
- add the fixed execution policy from §3.2;
- keep all other seed definitions unchanged;
- do not add a `conId`, `localSymbol`, or expiry to the seed.

Replace the PR15.2 all-disabled invariant with a PR15.3 invariant:

- exactly one seed is execution-enabled;
- its ID is exactly `es_front`;
- it has a complete policy with quantity/max quantity = 1;
- only `LMT` is permitted;
- bracket protection is enabled;
- tick size is 0.25;
- the other five seeds remain disabled and have no accidental policy
  activation.

Update tests that intentionally relied on the old all-disabled catalogue
without weakening generic registry or risk-engine coverage.

Add a fail-closed check on the loop path that the successful pipeline
signal's `strategyId` equals `Instrument.executionPolicy.strategyId`.
`executionPolicy.strategyId` must describe the actual trade intent, not
only label its idempotency key. A different winning strategy returns
`STRATEGY_POLICY_MISMATCH`, persists nothing, and calls no submitter.

### 4.2 Re-audit legacy proposal entry points

PR15.2 explicitly deferred this audit. Before enabling the seed, trace and
document every creator/consumer of `proposed_orders`, including:

- signal-engine legacy `/signals/run-once` persistence;
- `apps/llm-agent` polling and EXECUTE/REJECT flow;
- UI proposal actions;
- `POST /execution/execute-proposed/:id`;
- backtest-engine simulator/database paths.

Required outcome:

- enabling `es_front` cannot cause a legacy proposal to bypass the
  authoritative binding, risk engine, bearer auth, account allowlist,
  or exposure guard;
- backtest writes remain isolated in `ikbr_trader_backtest` and cannot
  reach broker execution;
- the llm-agent cannot race the Phase 2 E2E proposal. During the E2E
  window it must be disabled, or the audited code must prove it ignores
  the Phase 2 ticket source deterministically;
- any discovered unsafe ambiguity blocks implementation and is fixed in
  scope before the activation flip.

Record the audit with source locations in the PR15.3 report.

### 4.3 Paper preflight gate

Extend the operator documentation and, where needed, read-only status
output so the following checks are explicit and observable before any
POST:

- `IBKR_ENVIRONMENT=paper`;
- active broker account is a masked member of
  `ALLOWED_PAPER_ACCOUNTS`;
- `ALLOWED_LIVE_ACCOUNTS` is not used for the active account;
- `TRADING_ENABLED=true` only on execution-engine for the bounded
  window;
- `EXECUTION_API_TOKEN` is present, at least 32 characters, identical
  across the two internal services, and never printed;
- `EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT=paper`;
- `EXECUTION_RUNTIME_ENABLED=true`;
- `TRADING_LOOP_ENABLED=false`;
- `TRADING_LOOP_INSTRUMENT_IDS=es_front`;
- `INSTRUMENT_BINDINGS_JSON` contains exactly the intended ES binding
  for this window and is identical in ingestion, signal-engine, and
  execution-engine;
- ingestion `/watchlist` reports the binding as broker-verified with the
  expected `instrumentId` and `conId`;
- signal runtime, execution-engine, Postgres and Redis are ready;
- reconciliation is fresh, complete, and has no active hold;
- kill switch is not engaged;
- no active intent or open ES position exists under the server's
  cross-contract exposure policy;
- market data is fresh enough for the ticket builder.

Use `pnpm paper:verify-stack --json` as the read-only baseline. Extend it
only if an existing GET response already provides necessary binding
evidence; do not grant the verifier POST capability.

### 4.4 E2E runbook

Create `docs/runbooks/PAPER_ENTRY_E2E.md` with four explicit phases.

#### Phase A — prepare with writes disabled

1. Configure the exact operator-selected ES Paper binding.
2. Start/rebuild ingestion, signal-engine, and execution-engine with
   `TRADING_ENABLED=false`, `EXECUTION_RUNTIME_ENABLED=true`, and
   `TRADING_LOOP_ENABLED=false`.
3. Run the GET-only stack verifier and binding/readiness checks.
4. Confirm zero ES position, zero non-terminal ES intent, zero active
   reconciliation hold, and no unknown submission.
5. Record masked account, exact `instrumentId`, `conId`, `localSymbol`,
   image/commit ID, and UTC start time. Never copy secrets into the
   report.

#### Phase B — bounded write window

1. Set `TRADING_ENABLED=true` for execution-engine only and restart that
   service.
2. Re-run readiness and reconciliation checks.
3. Invoke one authenticated
   `POST /runtime/trading-loop/run-once` from an operator terminal.
4. Save the sanitized response, cycle ID, outcome, idempotency key,
   proposed-order ID, and broker order IDs when present.
5. Do not invoke a second cycle in the same evaluation bucket.

#### Phase C — observe and reconcile

1. Poll only existing read endpoints and query Postgres read-only.
2. Verify exact `instrument_id`, symbol and `conid` agreement.
3. Verify the persisted `client_order_id/hash` and submission marker.
4. Verify IBKR observes the expected parent/protective order topology.
5. If filled, verify fill capture and broker position snapshot.
6. Run/observe reconciliation through the existing authenticated
   operator workflow and require a clean, complete result.
7. Re-submit the same trigger only in the controlled idempotency test
   described in §5.3; expect duplicate/conflict semantics and no second
   broker parent.

#### Phase D — close the window

1. Restore `TRADING_ENABLED=false` and restart execution-engine.
2. Keep `TRADING_LOOP_ENABLED=false`.
3. Resolve/cancel any remaining Paper orders with existing audited
   workflows and ensure no unexpected ES position remains.
4. Re-run the GET-only verifier and final reconciliation.
5. Record UTC end time and sanitized final evidence.

The runbook must include immediate abort instructions for account
mismatch, live environment, stale reconciliation, binding mismatch,
unexpected position, unexpected second order, or ambiguous submission.
Abort means disable writes first; it never means blind retry.

### 4.5 Documentation status

During implementation:

- update this plan's status only through the normal report lifecycle;
- keep `PHASE_2_ROADMAP.md` at `blocked, not ready` until the r2
  prerequisite in §11.3 is satisfied; only then may the roadmap flip
  to `implemented, in review` and later to a shipped commit;
- update `TESTING_AND_ROLLOUT.md` to distinguish the PR15.3
  single-instrument smoke window from the later stable-paper gate;
- create `PR15_3_REPORT.md` with sanitized evidence and explicit residual
  state.

Do not put account IDs, tokens, raw `INSTRUMENT_BINDINGS_JSON`, or other
secrets in committed documentation.

## 5. Automated verification

### 5.1 Unit tests

Add/update tests proving:

- exactly `es_front` is execution-enabled;
- `es_front` policy matches §3.2 and resolves to quantity 1;
- the policy cannot emit `MKT`, quantity > 1, or a bracket-disabled
  order;
- a pipeline signal whose `strategyId` differs from the instrument
  policy's `strategyId` fails closed before ticket submission;
- `priceTickSize` mismatch with broker-verified `minTick` fails closed;
- missing/unknown/mismatched ES binding fails before persistence;
- all other seeds remain execution-disabled;
- the manual route remains bearer-protected and paper-only;
- `TRADING_LOOP_ENABLED=false` never starts a timer yet still permits
  authenticated `run-once` through the already registered runtime;
- a `NO_TRADE` cycle performs zero submitter/broker calls.

### 5.2 Integration tests

Use the existing Postgres integration harnesses to prove:

- exact `es_front + conId` persists to `proposed_orders.instrument_id`
  and broker-facing identity columns;
- wrong/missing binding produces no proposal and no broker call;
- active intent and open-position guards still block before submission;
- stale/incomplete/wrong-session position snapshots fail closed;
- stale or held reconciliation blocks the cycle;
- one accepted ticket creates one durable intent and expected bracket
  dispatch only;
- audit metadata identifies the runtime source and actor;
- no legacy llm-agent consumer can claim the Phase 2 E2E intent during
  the configured test mode/window.

### 5.3 Idempotency/restart tests

Prove with fault injection or the existing three-phase harness:

- same `clientOrderId + clientOrderHash` returns the persisted duplicate
  outcome and never dispatches a second broker parent;
- same trigger with a different hash produces `CONFLICT` and no broker
  dispatch;
- timeout after broker submission is not retried blindly;
- execution-engine restart re-adopts/reconciles the same broker order;
- signal-engine restart does not create a second order for the same
  evaluation bucket.

### 5.4 Required repository gates

Run after implementation:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm paper:verify-stack:fixture
```

No behavior-affecting strategy change is planned, so no new strategy
backtest is required. If implementation changes signal/risk thresholds or
strategy behavior despite §3.4, that is a scope deviation and the relevant
backtest becomes mandatory before proceeding.

## 6. Real Paper E2E acceptance

The live Paper window requires separate operator approval after code,
tests, hostile review, and runbook review are complete.

### 6.1 Mandatory submission-path evidence

- [ ] IB Gateway reports a paper account on the expected endpoint.
- [ ] Active account matches `ALLOWED_PAPER_ACCOUNTS`.
- [ ] Exact ES binding is broker-verified in all three services.
- [ ] `TRADING_LOOP_ENABLED=false` throughout.
- [ ] Exactly one authenticated `run-once` creates the candidate cycle.
- [ ] Generated ticket is `LMT`, quantity 1, DAY, exact conId, protected
      by the expected bracket.
- [ ] One and only one parent broker order exists for the client order
      ID.
- [ ] `proposed_orders` contains the same instrument identity,
      client-order ID/hash, prices, quantity, and broker IDs.
- [ ] Same-trigger replay produces no second broker order.
- [ ] Reconciliation becomes/stays complete and clean.
- [ ] No unresolved `SUBMIT_UNKNOWN`, orphan order, active hold, or
      unexpected position remains.
- [ ] Writes are disabled again at the end of the window.

### 6.2 Acceptable non-submission attempt

A cycle ending in `NO_TRADE` or an expected deterministic blocker is safe
and must be documented, but it does not satisfy §6.1. It must show zero
proposal writes and zero broker orders. Waiting for a later natural signal
is permitted; fabricating one is not.

### 6.3 Evidence handling

The report may include:

- commit/image identifiers;
- UTC timestamps;
- instrument ID, conId and local symbol;
- cycle/client-order/proposal/broker-order IDs;
- sanitized route responses;
- read-only SQL result summaries;
- reconciliation outcome and final residual state.

The report must mask account IDs and exclude bearer tokens, `.env`
contents, raw binding JSON, and unrelated portfolio/account values.

## 7. Hostile review checklist

Before requesting approval for the Paper window, review the diff for:

- any second `executionEnabled=true` seed;
- any default flip of `TRADING_ENABLED`,
  `EXECUTION_RUNTIME_ENABLED`, or `TRADING_LOOP_ENABLED`;
- any weakening of the paper-only literal or account allowlist;
- any direct `ib.placeOrder` outside execution-engine;
- any new unauthenticated mutating endpoint;
- market-order support or caller-controlled server policy;
- a committed dated contract, account ID, token, or raw binding payload;
- scheduler startup during the manual window;
- missing bracket protection;
- llm-agent racing/claiming the E2E proposal;
- retries after ambiguous submission;
- evidence taken only from local DB without broker confirmation;
- an open position/order or active hold hidden at report close.

## 8. Rollback

> **State at HEAD:** the r1 activation of `es_front` was never
> committed to `main`. It was drafted, hostile-reviewed, and
> reverted inside the same non-committed PR15.3 correction pass
> (r2, further hardened in r3 and r4). The rollback description
> below is therefore historical — the "revert" is already the
> baseline. Kept in place so a future contributor who ships the
> re-activation follow-up (§11.3 prerequisite) has a written
> template for undoing it if hostile review finds another
> defect.

Code rollback template (for a HYPOTHETICAL future activation PR):

- revert the PR15.3 activation/policy commit;
- `es_front` returns to `executionEnabled=false`;
- remove only PR15.3-specific tests/docs changes;
- do not alter PR15.2 binding infrastructure or migration 000006.

Operational rollback/abort:

1. Set `TRADING_ENABLED=false` and restart execution-engine.
2. Keep `TRADING_LOOP_ENABLED=false`.
3. Inspect IBKR orders/positions and reconciliation state (the
   reconciliation operator surface is on the write-guard
   exemption list — `POST /execution/reconciliation/run` remains
   reachable while writes are disabled).
4. Neutralise outstanding SUBMITTED broker orders through the
   single audited endpoint that exists today:
   `POST /execution/cancel-proposed/:id` (also on the exemption
   list; still bearer + audit + account-allowlist gated). There
   is NO `close-position` / `flatten` / `exit-position` endpoint
   in the codebase — the runbook (`docs/runbooks/PAPER_ENTRY_E2E.md`
   §5 Phase D step 3) lists the operator options that do NOT
   require introducing one. Never introduce a new close/flatten
   endpoint in a rollback / incident PR — that is PR16 (Position
   / exit management) territory.
5. Never retry an unknown submission and never infer cancellation
   from a timeout.

Rollback does not itself cancel a broker order or flatten a position;
broker state remains the source of truth.

## 9. Explicit exclusions

PR15.3 does not include:

- live trading or `ALLOWED_LIVE_ACCOUNTS` activation;
- unattended/interval scheduler operation;
- more than one execution-enabled instrument;
- the ≥3-instrument, ≥2-exchange, ≥24-hour stable-paper window;
- position or exit-management implementation (PR16);
- automatic futures selection or roll;
- portfolio optimization or pyramiding;
- new strategy logic or threshold tuning;
- IBKR UI automation;
- direct broker test orders outside the proposal/risk/execution flow.

## 10. Implementation sequence and stop conditions

1. Re-audit legacy proposal flows and document findings.
2. Add the one-instrument policy and activation with regression tests.
3. Add/update integration and recovery coverage.
4. Write the bounded Paper E2E runbook.
5. Run all repository gates in §5.4.
6. Perform hostile review against §7.
7. Create `PR15_3_REPORT.md` for code/test results, with the real Paper
   evidence section explicitly marked pending.
8. **Stop and request separate operator approval for the mutating Paper
   window.**
9. After approval, execute the runbook once, capture evidence, disable
   writes, complete the report, and stop.

This plan authorizes no implementation and no broker write. Work begins
only after explicit approval of this plan.

## 11. r2 addendum — hostile-review corrections (2026-08-05)

### 11.1 Universal `TRADING_ENABLED` kill switch (Finding 1, P1)

`assertEnvironmentAllowsWrite` now short-circuits on
`tradingEnabled=false` for BOTH `paper` and `live` before touching
the account whitelist, returning `423 paper_trading_disabled` or
`423 live_trading_disabled`. `PaperGuard.check()` cross-checks
`ReadinessResponse.tradingEnabled` from execution-engine's `/ready`
and fails-closed on `false` OR on a missing field (a
non-hostile-review probe cannot silently strip the check). `/ready`
itself still returns 200 with `tradingEnabled=false` per Decision
D7 (administrative pause is a policy state, not a health failure);
the block is enforced ONLY on the write path.

Regression coverage:

- `apps/execution-engine/src/env-guard.test.ts` — new tests for
  `paper_trading_disabled` (base case, precedence over the account
  whitelist, null-account bootstrap variant).
- `apps/signal-engine/src/runtime/execution/paper-guard.test.ts` —
  new tests: `tradingEnabled=false` → guard refuses;
  `tradingEnabled` omitted → guard refuses (fail-closed on
  unknown).

### 11.2 Strategy-policy fail-closed becomes strict (Finding 2, P1)

The trading-loop strategy-policy check now refuses when the
instrument carries an `executionPolicy` and any of:

- `signal.instrumentId` differs from the scheduled instrument;
- `signal.metadata.strategyId` is missing;
- `signal.metadata.strategyId` differs from
  `executionPolicy.strategyId`;
- `executionPolicy.expectedDirection` is set AND the winning
  `decision.action` is not directional or does not match.

`InstrumentExecutionPolicy` gains an optional `expectedDirection:
"LONG" | "SHORT"` field so a future activation MUST declare which
direction the referenced `strategyId` is authorised to trade for
this instrument. The check is defence-in-depth: `es_front` stays
`executionEnabled=false` and no seed carries an `executionPolicy`
today, so the strict block fires only in tests. Regression:
`trading-loop-service.test.ts` — `PR15.3 Finding 2 — signal.metadata.strategyId
MISSING`, `SHORT decision under a LONG policy`,
`expectedDirection=LONG + non-directional decision (HOLD)`, plus the
existing symmetric "matches → SUBMITTED" happy path.

### 11.3 Prerequisite for a real activation attempt (blocking)

Re-activating any seed's `executionEnabled=true` REQUIRES a
follow-up PR that:

- routes a strategy-attributable pipeline through the trading loop
  so `SignalEvaluation.metadata.strategyId` is populated with the
  ID of the actual winning `Strategy` (no artificial label);
- forbids submission when the resolved `signal.decision.action`
  disagrees with the strategy's authorised direction, either via
  `InstrumentExecutionPolicy.expectedDirection` or an equivalent
  strategy-side declaration;
- ships tests that fail the loop for a manufactured mismatch AND
  for a manufactured missing strategyId AND for a manufactured
  wrong direction, without relying on default test fixtures to
  inject the ID.

Until that PR lands, PR15.3 activation MUST NOT proceed and this
plan MUST NOT be flipped to `implemented`.

### 11.4 Runbook corrections (Findings 3–6)

`docs/runbooks/PAPER_ENTRY_E2E.md` was corrected to reflect the
actual response schemas and DB columns:

- The `ALLOWED_PAPER_ACCOUNTS` env var carries the FULL DU
  account id (whitelist compares literal strings); masking is
  applied only in reports / logs / evidence.
- `broker_position_snapshots` columns are
  `(account_id, instrument, conid, quantity, session_id,
  observed_at)`. `complete` and `generation` live on
  `broker_snapshot_syncs`. The runbook uses two queries.
- `/execution/reconciliation/latest` returns
  `{ accountId, sessionId, run, latestInSession, latestOverall,
  stale, maxAgeSeconds }`. `run.status`, `run.snapshotComplete`,
  `run.sourceCoverage`, and `stale` are the correct evidence
  fields. Active holds come from a separate GET —
  `/execution/reconciliation/holds?active=true`.
- The `/watchlist` top-level `bindings` block is a safe
  diagnostic (`{ boundCount, ids }`) and does NOT expose `conid`.
  The exact `conId` and subscription status live in the
  corresponding `watchlist[]` entry.
- SQL feeds the account id through stdin. Each SQL block is a
  `docker compose exec -T postgres psql … <<PSQL` heredoc that
  begins with `\set account_id '$PAPER_ACCOUNT_ID'` and then
  references `:'account_id'` inside the query. The `docker
  compose exec` / `psql` process arguments contain only
  `-v ON_ERROR_STOP=1`; the full account id never appears in
  `argv`, `ps` output, or shell history. Superseded r4 style
  that passed `-v account_id="$ACCOUNT_ID"` on the command line
  was rewritten in the r4 pass — the current runbook
  (`docs/runbooks/PAPER_ENTRY_E2E.md` §5 Phase A step 5,
  Phase C step 3, and Phase D step 3) shows the exact form.
