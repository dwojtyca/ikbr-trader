# PR15.5B — Futures backtest execution model — IMPLEMENTATION PLAN (r1)

Status: complete locally; owner-approved; independent hostile review approved

Owner approval recorded in the implementation thread on 2026-09-15 before
code changes began.

Date: 2026-09-15

## 0. Purpose

Build and verify a deterministic futures execution model inside
`apps/backtest-engine`. This PR fixes simulation semantics only. It does not
acquire an ES dataset, judge strategy performance, add `FUT` to a strategy,
enable an instrument, run Paper E2E, or contact IBKR.

PR15.5B is a prerequisite for the isolated dataset work in PR15.5C and the ES
compatibility experiment in PR15.5D.

## 1. Confirmed baseline gaps

The current backtest engine:

1. has no test script, so root `pnpm test` skips the app;
2. treats commission as per-share or bps, not per futures contract per side;
3. accepts a symbol multiplier override but has no required futures contract
   specification or ES tick-size validation;
4. uses prices without a futures price-grid normalization step;
5. has no explicit slippage model measured in ticks;
6. processes partial targets before stop/target collision resolution;
7. ignores protective exits on the entry candle;
8. exposes higher-timeframe rows whose timestamp is the bucket start, allowing
   an in-progress aggregate to be consumed before its close;
9. aggregates higher timeframes in epoch/UTC buckets rather than CME sessions;
10. indexes simulator history and positions primarily by symbol, allowing a
    futures roll to mix contract histories and synthetic roll gaps;
11. has no explicit expiry boundary or deterministic roll transition policy;
12. records gross P&L, commission, and net P&L, but not the futures execution
    assumptions needed to reproduce each fill.

## 2. Non-negotiable safety constraints

- `executionEnabled=false` remains unchanged for every seed.
- No production strategy gains `FUT`, `CMDTY`, or `ETF` support.
- No broker connection, historical-data request, Paper E2E, or strategy
  performance run is allowed.
- Do not change live/paper execution-engine behavior.
- Do not redesign the backtest service or merge service responsibilities.
- Equity/stock simulation remains backward compatible unless a test proves an
  existing result depended on look-ahead; such a result must be corrected, not
  preserved.
- A futures run missing any required contract economics, calendar coverage, or
  contract identity fails closed before simulation.

## 3. Trusted futures specification

Add a validated, backtest-only `FuturesContractSpec` keyed by trading class.
It contains:

- `tradingClass`, `secType: "FUT"`, currency;
- `multiplier`;
- `tickSize`;
- `commissionPerContractPerSide`;
- non-negative integer `slippageTicks`;
- `sessionTemplate` and IANA timezone;
- versioned calendar identifier.

Configuration is supplied through explicit `BACKTEST_FUTURES_SPECS_JSON`.
There is no silent futures default and no fallback to the equity commission
model. Omission or malformed values for a futures symbol abort the run with an
operator-safe configuration error.

For trading class `ES`, validation requires:

- multiplier `50`;
- tick size `0.25`;
- quantity in positive whole contracts;
- timezone `America/Chicago`;
- session template `cme_equity_index`.

Commission and slippage remain explicit experiment inputs; PR15.5B must not
invent an IBKR pricing tier. PR15.5D will pre-register their concrete values.

## 4. Price grid and execution costs

All futures instructions are normalized to the tick grid before touch checks:

| Instruction | Grid rule |
| --- | --- |
| BUY limit | floor to tick (never more aggressive) |
| SELL limit | ceil to tick (never more aggressive) |
| BUY stop | ceil to tick |
| SELL stop | floor to tick |

Rules for fills:

- Limit entry and take-profit fill at their normalized limit with no favorable
  price improvement.
- Market and stop fills apply `slippageTicks` in the adverse direction.
- A gap through a stop fills from the worse of the normalized stop and bar
  open, then applies adverse slippage.
- Dataset-end and contract-roll liquidation are market exits and apply adverse
  slippage.
- Commission is
  `contracts * commissionPerContractPerSide` for each executed side.
- Gross P&L is
  `direction * (exitFill - entryFill) * contracts * multiplier * fxRate`.
- Because actual fill prices already include slippage, net P&L is gross P&L
  minus entry and exit commission only. Persisted slippage cost is an
  informational attribution and must not be subtracted a second time.
- Every entry, stop, target, partial target, and exit price must be an exact
  tick multiple after normalization. Floating-point comparison uses integer
  tick units internally, not epsilon-based price equality.

## 5. Frozen intra-candle ordering

Signals generated from the close of minute `t` remain eligible no earlier than
the next 1m candle.

For a position open before the current candle:

1. apply opening-gap adverse stop logic;
2. determine whether the existing stop is touched;
3. if stop and any favorable target are both touched, the stop wins;
4. only when no stop is touched, process partial targets in price order and
   then the final target;
5. ratchet breakeven/trailing levels only after the candle survives, for use on
   the next candle.

For an entry filled during the current candle:

- a protective stop touched by the same candle closes the new position;
- a favorable target touched on the same candle is not credited because OHLC
  cannot prove it occurred after entry;
- if both stop and target are touched, the stop wins;
- an entry and exit must be persisted as separate sides with their own
  commissions and slippage.

These rules intentionally choose the adverse deterministic interpretation when
OHLC does not reveal event order.

## 6. Look-ahead prevention

- A 1m signal may use the current completed 1m candle close; its order remains
  deferred to the next candle.
- Higher-timeframe candles are visible only when their computed
  `completedAt <= evaluationTime`.
- Bucket start timestamps must never be treated as completion timestamps.
- FUT `1h`, `4h`, and `1d` aggregation is session-anchored and contract-aware.
- Strategy history is partitioned by `symbol + conId`; data from a new contract
  cannot silently inherit indicators from the outgoing contract.
- Tests use sentinel future prices to prove no incomplete candle or later
  contract data can affect an earlier decision.

## 7. CME calendar contract

Implement a pure `CmeSessionCalendar` with no network or filesystem access.
The calendar consumes versioned, injected closure/early-close data and:

- uses `America/Chicago` wall time;
- models the regular equity-index session from 17:00 previous business day to
  16:00 session day;
- excludes the daily 16:00–17:00 maintenance break and the Friday-close to
  Sunday-open weekend break;
- handles DST transitions deterministically;
- rejects timestamps outside its declared calendar coverage;
- supports full closures and early closes from the injected versioned table;
- assigns stable session IDs and anchors intraday/daily buckets to the session,
  never UTC midnight.

PR15.5B supplies only deterministic calendar fixtures and engine behavior.
PR15.5C must provide and fingerprint the actual calendar coverage used by an
ES dataset.

## 8. Contract roll and expiry contract

The model consumes explicit contract metadata (`conId`, local symbol,
trading class, expiry/last-trade timestamp) and the ordered candle stream.

- A change of `conId` for the same root symbol is a roll transition.
- The outgoing position is closed at its last observed tradable candle using a
  market roll exit; it is never marked at the incoming contract price.
- Pending outgoing orders are cancelled with `contract_roll`.
- Positions are never transferred or automatically reopened.
- Indicator history and pending state reset at the transition.
- A sequence that returns to an already retired `conId`, overlaps contract
  windows, lacks identity metadata, or contains candles after last trade fails
  closed.
- New entries are prohibited at or after the contract's last-trade boundary.
- An open position that reaches expiry without an earlier roll is closed at
  the last observed tradable candle before the boundary with reason `expiry`;
  it is never valued from a post-expiry candle.
- No back-adjustment is applied in PR15.5B; therefore roll gaps cannot become
  trade P&L or synthetic indicator moves.

The policy selecting the actual roll instant and contract universe remains a
PR15.5C dataset responsibility. PR15.5B validates and executes the supplied
transition without guessing it.

## 9. Persistence and auditability

Extend backtest fill persistence additively so each futures fill records:

- `entry_reference_price`, `entry_fill_price`;
- `exit_reference_price`, `exit_fill_price`;
- `multiplier`, `tick_size`;
- `entry_slippage`, `exit_slippage`, total `slippage_cost`;
- `commission_per_contract_side`, total commission;
- entry and exit `conId`;
- execution-model version and calendar version;
- exit reason including `stop`, `take_profit`, `contract_roll`, `expiry`, or
  `dataset_end`.

Existing `entry_price`/`exit_price`, gross, commission, and net columns remain
compatible and represent actual simulated fills. Schema changes use additive
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; no historical table is dropped or
reset by migration.

## 10. Test architecture

Add `test` and `test:integration` scripts to backtest-engine.

Unit tests must cover at least:

- ES spec acceptance and rejection of wrong multiplier/tick;
- missing/malformed futures spec fails closed;
- whole-contract enforcement;
- every price-grid rule, including negative/half-tick boundaries;
- long and short gross/net P&L, two-sided commission, and adverse slippage;
- limit, stop, market, gap-through-stop, dataset-end, and roll fills;
- stop/target and stop/partial collisions for long and short;
- same-bar entry/stop and same-bar favorable-target suppression;
- trailing/breakeven updates take effect on the next candle only;
- higher-timeframe completion and sentinel look-ahead tests;
- CME session IDs, maintenance/weekend exclusion, DST spring/fall cases,
  closure, early close, and out-of-coverage rejection;
- conId history isolation, roll liquidation, pending-order cancellation,
  retired-contract reappearance, overlap, missing expiry, and post-expiry
  rejection;
- unchanged STK commission and fill behavior where not affected by the general
  look-ahead correction.

PostgreSQL integration tests must prove:

- additive schema initialization is idempotent;
- all futures audit fields round-trip exactly;
- gross/commission/slippage/net values stored by the simulator are consistent;
- a failed validation produces no partial order/fill writes.

Integration tests create and drop only uniquely named disposable databases.
They must reject the shared `ikbr_trader_backtest` database as a target. Root
`test:integration` and CI must include both execution-engine and backtest-engine
integration suites.

## 11. Expected implementation paths

The implementation is limited to these areas unless the report justifies a
smaller equivalent change:

- `.env.example`
- `package.json`
- `apps/backtest-engine/package.json`
- `apps/backtest-engine/src/config.ts`
- `apps/backtest-engine/src/types.ts`
- `apps/backtest-engine/src/futures-model.ts`
- `apps/backtest-engine/src/futures-model.test.ts`
- `apps/backtest-engine/src/cme-session-calendar.ts`
- `apps/backtest-engine/src/cme-session-calendar.test.ts`
- `apps/backtest-engine/src/bar-execution.ts`
- `apps/backtest-engine/src/bar-execution.test.ts`
- `apps/backtest-engine/src/simulator.ts`
- `apps/backtest-engine/src/simulator.test.ts`
- `apps/backtest-engine/src/repository.ts`
- `apps/backtest-engine/src/repository.pg-integration.test.ts`
- `apps/backtest-engine/src/index.ts`
- `apps/backtest-engine/src/strategy-lab-worker.ts`
- `docs/implementation/phase2/PHASE_2_ROADMAP.md`
- `docs/implementation/phase2/PR15_5B_FUTURES_BACKTEST_MODEL_PLAN.md`
- `docs/implementation/phase2/PR15_5B_REPORT.md`

No dependency is planned. If implementation proves a timezone/calendar
dependency necessary, stop and revise this plan before adding it.

## 12. Required gates

Run and record:

- `pnpm --filter @ikbr/backtest-engine test`
- `pnpm --filter @ikbr/backtest-engine typecheck`
- `pnpm --filter @ikbr/backtest-engine build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- PostgreSQL integration tests against a disposable test database
- `pnpm build`
- `git diff --check`
- independent hostile review by a second agent

No strategy backtest command is allowed in this PR because PR15.5C has not yet
provided an approved reproducible ES dataset.

## 13. Acceptance criteria

PR15.5B is complete only when:

- a FUT run cannot start without validated economics, calendar, conId, and
  expiry metadata;
- ES uses multiplier 50, tick 0.25, and whole contracts;
- all simulated futures prices lie on the tick grid;
- commission and slippage are explicit, adverse, two-sided, and auditable;
- same-bar ambiguity follows the frozen adverse ordering;
- no incomplete higher-timeframe candle is visible;
- CME sessions and DST are deterministic and coverage-bound;
- roll/expiry never mixes contracts or books a synthetic roll gap;
- unit and isolated PostgreSQL integration tests pass;
- existing stock behavior remains regression-covered;
- no production execution or strategy support is activated;
- hostile review has no unresolved blocker;
- `PR15_5B_REPORT.md` records implementation, evidence, limitations, and the
  next permitted step: prepare and approve PR15.5C.

## 14. Explicit exclusions

- acquiring/importing ES history;
- choosing real contract months or a production roll date;
- producing an ES performance metric;
- tuning strategy thresholds;
- adding `FUT` to momentum strategy/profile support;
- changing execution-engine, signal-engine, or llm-agent behavior;
- activating a seed or changing a trading switch;
- Paper or Live broker operations;
- implementing PR15.5C or PR15.5D.

## 15. Stop condition

After this plan is approved, implement only PR15.5B, run all gates, perform
independent hostile review, write the report, and stop. Any need to choose a
calendar dependency, acquire market data, or expand into dataset identity
requires a plan revision and separate approval.
