# PR15.5D — Pre-registered ES compatibility experiment — PLAN

Status: Stage A implemented and independently approved locally; awaiting commit and CI

Date: 2026-09-17

## 1. Goal

Run one pre-registered, auditable compatibility experiment for
`momentum_breakout_long_v1` on the finalized real IBKR ES dataset delivered by
PR15.5C.1. The experiment answers one bounded question:

> Does the unchanged long momentum-breakout decision logic produce sufficient
> and economically viable ES trades under the PR15.5B futures execution model?

The result is exactly one of:

- `ACCEPTED_FOR_ES` — all pre-registered acceptance gates pass;
- `REJECTED_FOR_ES` — the experiment completes validly but at least one gate
  fails, including insufficient trade count;
- `INCONCLUSIVE` — data identity, implementation identity, simulator integrity,
  or execution of the registered experiment cannot be established.

`ACCEPTED_FOR_ES` is research evidence only. It may permit planning a separate
production-activation PR, but it does not enable Paper or Live trading.

## 2. Frozen inputs

### Dataset identity

- database: `ikbr_trader_backtest_pr15_5a` only;
- provenance: `ibkr-es-20250622-20260831-e39a59790324`;
- fingerprint:
  `6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026`;
- candle SHA-256:
  `9d40e586a77c29f036cf0df270f71ef59bcd36ea3f7625941cd81c99fbef7ca3`;
- range: `2025-06-22T22:00:00.000Z` through
  `2026-08-31T20:59:00.000Z`;
- symbol: `ES`;
- exact contract sequence: `ESU5`, `ESZ5`, `ESH6`, `ESM6`, `ESU6`;
- roll policy: `ibkr-es-volume-crossover-next-session-v2`;
- calendar: `cme-equity-index-2024-2026-v1`.

The loader must reject a numeric dataset ID as authority. It resolves the
runtime ID only after exact provenance and fingerprint verification, and then
recomputes/reads back the same fingerprint before scheduling a run.

### Strategy identity

- experiment ID: `pr15.5d-es-momentum-breakout-long-v1`;
- strategy: `momentum_breakout_long_v1` only;
- direction: long only;
- symbol universe: `ES` only;
- strategy thresholds and signal logic: unchanged from the implementation
  committed before the operational run;
- no parameter search, threshold sweep, symbol substitution, date-range
  change, alternate roll rule, or post-result rerun is allowed.

The production strategy and shared profile remain `STK`/`IND` only. PR15.5D
must not add `FUT` to `MomentumBreakoutLongStrategy.secTypes`, the shared
profile, the default registry, or the bot portfolio.

### Research-only strategy seam

The momentum-breakout calculation will be extracted into a pure evaluator.
The production class retains its existing `STK`/`IND` boundary and must remain
behaviorally identical under parity tests. A research-only adapter may expose
that exact evaluator to `FUT` for this experiment. The adapter:

- is injectable only by the research runner;
- is not registered by `createStrategies()`;
- is not returned by `listStrategyProfiles()`;
- is unavailable to signal-engine production startup;
- uses one frozen ES parameter object; initially it is byte-for-byte equal in
  values to the existing momentum-breakout parameter set, not a tuned ES set.

Any change to a strategy threshold after plan approval invalidates the
pre-registration and requires a new plan/version before a real run.

## 3. Frozen execution and risk assumptions

The primary scenario is:

- starting equity: USD 100,000;
- target and maximum risk per trade: 0.50% of current equity;
- quantity: positive whole contracts only;
- maximum open positions: 1;
- research notional/exposure ceiling: 400% of equity, solely to permit one
  full-size ES contract under the existing notional-based sizing guard;
- multiplier: 50;
- tick size: 0.25;
- commission: USD 2.50 per contract per executed side;
- adverse slippage: 1 tick for market, stop, roll, expiry, and dataset-end
  fills, as defined by PR15.5B;
- same-bar stop/target collision: stop wins;
- limit-entry mode: existing `touch` behavior;
- order TTL: 2 one-minute candles;
- strategy cooldown: 12 hours;
- minimum warm-up: 220 candles;
- maximum synthetic spread: 12 bps, with a 2 bps generated spread;
- minimum signal confidence: 0.55;
- volume filter: off (strategy-internal volume confirmation remains unchanged);
- futures minimum-stop overlay: 0 bps; the unchanged strategy stop remains
  authoritative;
- limit-entry buffer: 0 bps;
- no pyramiding;
- no fractional quantity;
- base currency: USD; no FX conversion.

The 400% ceiling is a research accommodation, not an approved production risk
policy or margin model. A later activation PR must define a broker- and
account-appropriate futures margin/exposure policy.

One pre-registered stress scenario reruns the identical signals and date range
with:

- commission: USD 3.50 per contract per executed side;
- adverse slippage: 2 ticks.

No other economic scenario may influence the decision.

## 4. Acceptance gates

The primary and stress runs must both complete without simulator, calendar,
contract-transition, expiry, tick-grid, look-ahead, or persistence invariant
failure.

`ACCEPTED_FOR_ES` requires all of the following:

1. at least 30 closed primary-scenario trades;
2. primary net P&L greater than zero after commissions and slippage;
3. primary profit factor at least 1.20, calculated from net trade P&L;
4. primary maximum peak-to-trough drawdown no worse than USD -10,000;
5. primary mean net expectancy per closed trade greater than zero;
6. stress-scenario net P&L greater than zero;
7. stress-scenario profit factor at least 1.05;
8. no open position, pending order, or unclosed fill remains after dataset-end
   liquidation;
9. no fill violates whole-contract quantity, 0.25 tick grid, multiplier 50,
   exact contract validity, roll, or `lastTradeAt` rules;
10. the strategy is not permanently disabled by its loss controls;
11. dataset content and fingerprint are unchanged before and after both runs.

A valid completed experiment that fails any gate is `REJECTED_FOR_ES`.
Insufficient trades are a rejection, not permission to shorten the range,
change thresholds, or relabel the result as inconclusive.

`INCONCLUSIVE` is reserved for evidence failures: identity mismatch, dirty or
unidentifiable implementation, corrupted data, invariant failure, interrupted
run without an auditable deterministic resume, or inability to reproduce the
registered primary result.

## 5. Metrics and result artifact

The report must record, for primary and stress scenarios:

- implementation commit SHA and experiment-spec SHA-256;
- provenance, fingerprint, candle SHA-256, contract sequence, and roll dates;
- exact assumptions from section 3;
- run status and deterministic result fingerprint;
- closed trades, wins, losses, win rate;
- gross P&L, commissions, slippage cost, net P&L;
- mean and median net P&L, net expectancy per trade;
- gross wins, gross losses, profit factor;
- maximum drawdown;
- counts by month, contract, exit reason, and directional/volatility regime;
- largest winning and losing trade;
- signal rejection diagnostics;
- roll, expiry, and dataset-end exits;
- every acceptance gate as an explicit pass/fail row;
- final verdict: `ACCEPTED_FOR_ES`, `REJECTED_FOR_ES`, or `INCONCLUSIVE`.

The canonical result JSON excludes database-local run IDs and wall-clock
timestamps from its result fingerprint. Runtime run IDs remain in the report
only as local audit references.

## 6. Architecture and implementation scope

### Pure request and decision boundaries

Add `apps/backtest-engine/src/research-run-request.ts`:

- strict Zod schema for the exact registered experiment;
- pure validation only — no file, database, network, server, or broker I/O;
- canonical JSON and SHA-256 calculation;
- pure verdict evaluator over canonical metrics and the gates in section 4.

Add fixture-based `research-run-request.test.ts` without server startup or a
database connection.

### Dataset loader

Add `apps/backtest-engine/src/research-dataset-loader.ts`:

- connect only to the fixed research database;
- require one finalized `ready` dataset;
- load manifest, provenance, fingerprint, and candle count;
- verify the exact registered identities before returning a runtime dataset ID;
- reject shared/mutable databases, absent finalization, duplicates, or any
  mismatch before creating a run.

### Research strategy adapter

Extract the pure momentum-breakout evaluator without altering production
behavior. Add a backtest-only adapter/factory that opts this evaluator into
`FUT` only when the exact experiment request has passed validation.

The simulator receives strategies by dependency injection for the research
path. Existing bot and isolated paths keep using the production registry.

### Runner and HTTP wiring

Add a dedicated `POST /backtest/research/es-compatibility` route. `index.ts`
contains wiring only:

```text
loader -> pure request validator -> single-run guard -> research scheduler
```

The existing `/backtest/run` and all `/backtest/history*` routes remain blocked
on the protected research database. The dedicated route accepts only the exact
pre-registered request and returns `409` for an existing/running experiment.

The run config persists experiment ID, spec SHA-256, implementation SHA,
durable dataset identity, scenario, and all assumptions. Primary and stress
runs are linked as one experiment. No endpoint may mutate dataset, candle,
contract, calendar, aggregation, provenance, or fingerprint content.

### Repository/report additions

Extend repository reads/writes only for research run metadata, metrics, and
reports. Do not weaken PR15.5C immutability triggers. The result builder reads
fills in chronological order and computes canonical metrics with no floating
ordering dependence.

Expected implementation paths include:

- `apps/signal-engine/src/strategies/momentum-breakout-long.strategy.ts`;
- a new pure evaluator test beside that strategy;
- `apps/backtest-engine/src/research-run-request.ts` and tests;
- `apps/backtest-engine/src/research-dataset-loader.ts` and tests;
- `apps/backtest-engine/src/research-es-strategy.ts` and tests;
- `apps/backtest-engine/src/research-es-experiment.ts` and tests;
- `apps/backtest-engine/src/repository.ts`;
- `apps/backtest-engine/src/index.ts`;
- integration tests using disposable PostgreSQL;
- this plan, the roadmap, a decision record, and a final report.

## 7. Staged execution

PR15.5D is executed in two irreversible-evidence stages.

### Stage A — build the runner, do not inspect real strategy results

1. implement the pure validator, loader, adapter, scheduler, metrics, and
   decision evaluator;
2. test only with synthetic fixtures;
3. run all repository gates;
4. perform independent hostile review;
5. commit and obtain green CI for the runner implementation;
6. record the exact implementation commit SHA and experiment-spec SHA-256.

Stage A must not start the real ES strategy run.

### Stage B — one authorized operational experiment

After separate owner approval of the exact Stage-A commit and spec hash:

1. verify the worktree is clean and `HEAD` equals the approved commit;
2. read back the registered dataset identity/fingerprint;
3. execute primary and stress scenarios exactly once;
4. verify the dataset fingerprint is unchanged;
5. reproduce the primary result once from the same inputs; a mismatch is
   `INCONCLUSIVE`, not a reason to choose the better run;
6. generate the canonical result JSON, decision record, and report;
7. perform final independent hostile review;
8. stop before any activation change.

An interrupted Stage-B attempt may resume only if the persisted state proves
that no completed scenario is being silently replaced. Every attempt and
failure is reported.

## 8. Tests

Unit tests must cover:

- exact request acceptance and every identity mismatch;
- canonical request/result hashing and key order;
- all verdict boundaries, including exactly 30 trades, profit-factor equality,
  drawdown equality, stress failure, and insufficient-trade rejection;
- production STK/IND evaluator parity before and after extraction;
- production strategy still rejects `FUT`;
- research adapter accepts only the registered strategy and `FUT` context;
- no adapter registration in the production strategy registry/profile list;
- exact primary/stress assumptions and whole-contract/tick enforcement;
- no look-ahead at higher-timeframe boundaries;
- deterministic metrics regardless of database row return order;
- result fingerprint excludes runtime IDs/timestamps and changes for every
  durable input or metric change.

Disposable-PostgreSQL integration tests must prove:

- wrong database, provenance, fingerprint, status, finalization, manifest, or
  duplicate dataset fails before any run row is created;
- ordinary history/run routes remain locked;
- only the dedicated exact research request can create runs;
- duplicate/concurrent submissions cannot create a second experiment;
- synthetic multi-contract primary+stress execution writes auditable orders,
  fills, diagnostics, and result metadata;
- failure rolls back or marks the attempt without changing dataset content;
- dataset fingerprint before and after runs is identical;
- no broker, IBKR historical, execution-engine, or order-submission port is
  invoked.

## 9. Required gates

Before Stage A commit:

```text
pnpm --filter @ikbr/signal-engine test
pnpm --filter @ikbr/backtest-engine test
pnpm --filter @ikbr/backtest-engine test:integration
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
git diff --check
```

Stage B additionally requires the operational identity checks, deterministic
reproduction, dataset fingerprint before/after proof, and final hostile review.

## 10. Explicit exclusions and safety boundaries

PR15.5D must not:

- modify `executionEnabled`, instrument bindings, Paper/Live configuration, or
  execution-engine behavior;
- add `FUT` to a production strategy/profile/registry;
- tune strategy parameters after observing ES results;
- fetch, repair, shorten, extend, or replace the dataset;
- change the roll calendar or contract universe;
- treat a valid failed experiment as `INCONCLUSIVE`;
- contact IBKR, execution-engine write endpoints, llm-agent, or broker order
  APIs;
- claim that a research notional ceiling is a production margin policy;
- begin Paper E2E or production activation.

## 11. Definition of done

PR15.5D is complete only when:

- Stage A implementation has green local gates and green CI;
- both independent hostile reviews approve their respective stages;
- Stage B was separately authorized and executed against the exact identities;
- primary reproduction is deterministic;
- the dataset fingerprint is unchanged;
- a canonical result and decision record contain exactly one permitted verdict;
- roadmap and final report are updated;
- production profiles and `executionEnabled=false` remain unchanged;
- no broker operation occurred.

Approval of this plan authorizes Stage A only. Stage B requires a second,
explicit owner approval after the implementation commit and spec hash are
known.
