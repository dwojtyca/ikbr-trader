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
are recorded below when completed. No order or window is enabled by this change.

## Final local validation

The reviewed clean copy passed lint, typecheck, build and Docker build. Unit run:
2,309 PASS with 48 database-dependent skips; isolated PostgreSQL integration run:
1,944 PASS, zero failures/skips. Root integration now includes ingestion and
signal-engine so both provenance SQL regressions run in GitHub CI.
Image digest: `sha256:8ecfef6061192f6f01e35c6eb855b08d3b8d91796561c83a41a507b53b44c3d8`.
All 29 unrelated research files remain byte-for-byte unchanged. Exact-commit CI
and disabled deployment/preflight remain pending at this commit; no AAPL order
or run window has been activated.
