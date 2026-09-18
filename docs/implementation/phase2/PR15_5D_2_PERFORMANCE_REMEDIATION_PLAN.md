# PR15.5D.2 — Backtest hot-path performance remediation — PLAN

Status: owner approved 2026-09-18; implementation in progress; no new real
experiment has started

Date: 2026-09-18

## 1. Goal

Remove the superlinear candle-lookup cost exposed by PR15.5D.1 without changing
selected data, strategy behavior, order semantics, economics, acceptance gates,
or canonical evidence. Before another real claim, produce an evidence-backed
runtime forecast for the complete 423,300-event, three-scenario experiment.

## 2. Root cause boundary

`BacktestSimulator.getRecentCandles()` has two superlinear paths. The 1m path
copies the complete growing prefix, filters it by `conId`, and then takes its
tail. Every higher-timeframe path filters the complete timeframe array on every
1m event and only then takes its tail. With 423,300 events, the 1m prefix copy is
likely the dominant quadratic cost, while the six higher-timeframe scans add
further repeated work. The correction must index 1m and all six higher
timeframes by symbol and `conId`, with binary-searchable visibility/completion
bounds and an O(log n + limit) worst-case lookup.

The optimized lookup must return exactly the same ordered candle values as the
current implementation for every evaluation time, limit, timeframe, contract
transition, early close, DST boundary, and missing-minute pattern.

## 3. Implementation scope

- add immutable per-symbol/timeframe/per-`conId` indexes for 1m and all six
  higher timeframes at simulator startup;
- precompute calendar-derived completion timestamps once;
- find the visible upper bound with binary search; add a monotonic cursor only
  if the preregistered benchmark shows it is still necessary;
- slice only the requested tail rather than filtering the complete series;
- keep generic stock and ordinary backtest behavior compatible;
- do not alter the projector, dataset, strategy, risk, fills, commissions,
  slippage, result gates, or v1/v2 evidence;
- add no parallel execution until deterministic single-process parity is proven.

## 4. Mandatory parity evidence

Tests must compare the old reference lookup with the optimized lookup across:

- 1m and every higher timeframe, with limits 0, 1, and greater than the number
  of available candles;
- the full sequence of evaluation timestamps on synthetic roll/DST/holiday and
  early-close fixtures;
- overlapping raw contracts after active projection;
- interleaved symbols, repeated calls at the same evaluation time, and time
  moving backwards;
- generic stock symbols without a futures calendar;
- incomplete buckets and weekly completion;
- roll warm-up reset and retired-contract isolation;
- deterministic primary/stress/reproduction fixtures, including orders, fills,
  diagnostics, P&L, and canonical result hashes.

The following terminal evidence is pinned in code and regression tests:

- v1 specification SHA-256
  `4afee9646d4f8aea18f35effca741c2cc80c82195b5519f6a88161077a65dff6`;
- v1 result SHA-256
  `efedef18335d2e471023879ea4ffe968a833928f840883f658274c2c30808a45`;
- v2 implementation SHA `ab072e752eb6d9e53ed79ce49b182e3c8e4133e5`;
- v2 specification SHA-256
  `22ae7af844f549d06d3eaa64715556ca028d1dee69cbd35254f55e48d82ff85e`;
- v2 terminal result SHA-256
  `4bd17e9fab5ea15150810b784da3afa4a04e959ab5511b72dae666ddd520b44c`.

The v3 routes and persistence must leave v1 and v2 responses and stored
artifacts byte-for-byte unchanged. Any semantic difference blocks the
optimization.

## 5. Runtime forecast gate

No new Stage B may be proposed until Stage A records all of the following on
the same Mac/Docker configuration intended for the experiment:

1. a full 423,300-event benchmark using the real verified projection and all
   six derived timeframes. It must exercise the complete `BacktestSimulator`
   and `SignalEngine`, including indicators, regime detection, every candle
   lookup, progress callbacks, and ordinary repository persistence. Only the
   registered strategy is replaced with a frozen no-order adapter, so no real
   signal, trade, P&L, or acceptance metric is observed;
2. at least three clean benchmark repetitions after one warm-up run;
3. wall time, CPU time, peak RSS, events/second, and per-10,000-event timing;
4. a preregistered full-scale synthetic evaluator benchmark which invokes the
   exact momentum evaluator for all 423,300 events;
5. a deterministic high-write synthetic execution fixture that bounds the
   worst-case cost of order, fill, diagnostic, and strategy-state persistence,
   without exposing or estimating real signal/trade counts;
6. exactly three measured repetitions per component, with zero failed runs and
   no discarded repetitions or outlier removal;
7. the per-component upper bound
   `U = (median + max(0.5 * median, 2 * sampleSD)) * 1.20`;
8. the complete forecast
   `U_total = U_preflight + 3 * U_scenario + 3 * U_identity_reload + U_artifact`
   plus separately measured startup and shutdown time if they occur within the
   execution window.

Before any timed run, commit a benchmark manifest that freezes the synthetic
dataset or generator seed, repetition count, full-scale size, and
the event/order/fill/diagnostic/strategy-state-write counts. The high-write
counts must be a code-derived upper bound for any one frozen scenario; the
fixture must execute all of those counts against the fully initialized
simulator/repository state. Linear extrapolation from an early or smaller
database is forbidden because index growth, WAL/checkpoints, cache eviction,
and terminal table size may change the per-write cost.

The scenario composition is fixed before measurement:

`U_scenario = U_no_order_full + U_exact_evaluator + U_high_write`

where `U_no_order_full` is the full real-projection no-order run,
`U_exact_evaluator` is the complete upper bound for evaluating the exact
strategy on the frozen synthetic stream, and `U_high_write` is the complete
full-scale high-write persistence bound. These costs
are added in full even where production may overlap them, deliberately accepting
double counting. No subtraction, favorable post-measurement combination, or
overlap adjustment is allowed.

The next real attempt is blocked unless `U_scenario <= 30 minutes` and the
conservative end-to-end `U_total <= 2 hours`. Every measured repetition must
also remain at or below 4 GiB peak RSS. In addition to the isolated components,
a full-scale composed synthetic workload must hold the initialized indexes,
invoke the exact evaluator, and execute the frozen high-write bound in the same
process; its measured peak RSS must remain at or below 4 GiB. All runs must use
no swap and produce no OOM or memory-pressure event. The Stage A report must
record the exact Docker memory limit, Node heap limit, and resulting headroom.
The report must state the expected duration as a range, the conservative
bounds, and all assumptions. The owner must approve that forecast together
with the new implementation SHA and specification hash.

Every timed benchmark must run from the production-built Docker image for the
candidate implementation commit. Record the commit SHA, immutable image digest,
Node version and heap limit, Docker CPU/memory limits, benchmark configuration,
and host power state. The safe order is: implement and test, commit, build the
production image, record its digest, then benchmark and run CI. Any subsequent
code, dependency, runtime configuration, or image change invalidates the
forecast and requires all timed repetitions again. Documentation-only changes
may follow, but Stage B approval must name the byte-identical implementation
commit and image digest that were benchmarked.

## 6. Versioning and execution

Use a new experiment ID, expected as
`pr15.5d2-es-momentum-breakout-long-v1`, and new v3 request/result schema
versions. The terminal v1 and v2 routes, rows, schemas, and canonical artifacts
remain immutable. Stage A includes implementation, tests, benchmarks,
independent hostile review, commit, and green CI, then stops.

Stage B requires separate owner approval naming the exact implementation SHA,
specification SHA, and forecast range. It sends exactly one POST and is never
automatically retried.

## 7. Required gates

Run the repository gates from AGENTS.md, disposable PostgreSQL integration,
reference-versus-optimized parity tests, the full-scale forecast benchmark, and
an independent hostile review. Record all commands and results in a Stage A
report.

## 8. Explicit exclusions

Do not tune strategy parameters, acceptance thresholds, risk, commissions,
slippage, data, roll policy, or calendar. Do not inspect real strategy P&L in
Stage A. Do not reuse the v2 experiment identity, submit broker orders, enable
Paper/Live execution, or start the new real experiment without the separate
forecast-aware owner approval.
