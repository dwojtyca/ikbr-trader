# AAPL native history implementation

The [accepted plan](AAPL_NATIVE_HISTORY_PLAN.md) is implemented without changing
strategy parameters or entry policy. Exact AAPL now uses six native IBKR RTH
series with source `ibkr_aapl_rth_native_v1`. Legacy aggregate timestamps cannot
suppress warmup, overwrite canonical native data or satisfy strategy context.
SQL filters contract and source before LIMIT. The separate bounded refresh uses
the existing historical pacing budget and publishes per-timeframe evidence/errors.

Intraday timestamps require broker epoch seconds; daily/weekly dates require
strict valid New York calendar dates. Closed-bar filtering rejects unfinished,
foreign, malformed and pre/post-market bars. Freshness uses the conservative bar
end with unchanged ceilings. The first 09:30 ET four-hour candle is not eligible
before 13:30 ET; stale preceding-session history legitimately blocks earlier tests.
No 12h data is requested or consumed. WSE and other instruments retain their paths.

Independent implementation review accepted after correcting permissive historical
timestamp parsing. Reviewer checks passed 18 shared finality/calendar tests,
13 ingestion adapter/refresh tests, 137 strategy-context/loop tests and two
isolated PostgreSQL source-before-LIMIT regressions. Frozen six-timeframe replay
produces identical indicators, regime and default-strategy result through the
production loader and directly from the native fixture: one evaluation, zero
signals in both paths. This is deterministic mechanics evidence, not a return
estimate. Existing strategy and simulator suites remain part of the full checks.

Full clean-copy checks, Docker, exact commit CI and disabled operational validation
are recorded below. No order or window is enabled by this change.

## Final local validation

The reviewed clean copy passed lint, typecheck, build and Docker build. Unit run:
2,309 PASS with 48 database-dependent skips; isolated PostgreSQL integration run:
1,944 PASS, zero failures/skips. Root integration now includes ingestion and
signal-engine so both provenance SQL regressions run in GitHub CI.
Image digest: `sha256:8ecfef6061192f6f01e35c6eb855b08d3b8d91796561c83a41a507b53b44c3d8`.
All 29 unrelated research files remain byte-for-byte unchanged.
Exact implementation-commit CI for `4f164666ba8bcf94fba6781ad4883bd4171953cf`
passed ([run 36026893317](https://github.com/dwojtyca/ikbr-trader/actions/runs/36026893317)).
The reviewed image was deployed to execution, ingestion and signal-engine with
Paper writes and loop disabled; the AI worker remained stopped.
No AAPL order or run window has been activated.

## Disabled broker-backed preflight — 2026-09-24

At approximately 16:27 UTC, supported ingestion bootstrap and the production
read-only context loader confirmed exact AAPL contract and source:

| Timeframe | Valid closed stored bars | Latest start UTC | Conservative end UTC |
| --- | ---: | --- | --- |
| 1m | 230 | Sep 24 16:25 | Sep 24 16:26 |
| 5m | 60 | Sep 24 16:20 | Sep 24 16:25 |
| 1h | 60 | Sep 24 15:00 | Sep 24 16:00 |
| 4h | 60 | Sep 23 16:00 | Sep 23 20:00 |
| 1d | 60 | Sep 23 04:00 | Sep 24 04:00 |
| 1w | 60 | Sep 18 04:00 | Sep 21 04:00 |

All inspected native rows were valid and closed. Counts satisfy unchanged
minimums. The default strategy resolves as active, but the production context
loader correctly returns `STRATEGY_CONTEXT_UNAVAILABLE` for stale 4h history.
Today’s first 09:30 ET bar cannot satisfy full-duration finality until 13:30 ET
(17:30 UTC / 19:30 Warsaw). This is the earliest next opportunity to recheck,
not a promise of a strategy signal or execution. Native refresh remains active.

Current broker quotes were realtime (`marketDataType=1`) with fresh exact-contract
bid/ask. Completed account evidence confirms enough explicit USD cash for the
configured notional cap plus reserve. Normal reconciliation is CLEAN with complete
source coverage and zero active holds; the false CASH hold resolved with its audit
note. No manual state repair was used.

Execution and loop remain disabled, AAPL window remains unconfigured and the AI
worker remains stopped. AI provider/research availability and the complete chosen
entry/exit window must be checked again before activation, alongside refreshed
quotes, account risk, reconciliation, exposure and context. This preflight did not
submit a proposal, consume an entry attempt, start autonomous trading or prove an
entry/exit round trip. No future activation was scheduled. The read-only stack verifier passed with
12 HEALTHY and two expected DISABLED checks; this confirms disabled infrastructure,
not strategy history readiness or permission to trade.
