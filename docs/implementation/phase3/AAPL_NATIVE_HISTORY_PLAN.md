# AAPL native closed RTH history

## Objective and observed gap

Prepare truthful strategy context for the owner-authorized supervised one-share
AAPL Paper test. Do not manufacture a signal or relax the existing risk, AI,
reconciliation, window or account/day attempt controls. Keep execution and the
loop disabled during deployment and history verification.

The existing US bootstrap can create a few aggregate higher-timeframe bars from
its minute batch, then treat their timestamps as evidence that native history is
already fresh. Those counts do not satisfy the strategy minimums. The legacy US
historical request uses extended hours (`useRTH=0`), does not mark provenance and
can return an unfinished current bar. Existing AAPL exclusion of mislabeled 12h
history remains in force. Unknown legacy rows cannot establish native provenance.

Implement an additive exact-AAPL path, following the existing WSE native refresh
pattern. Preserve WSE behavior, futures research, all unrelated dirty files and
especially `apps/signal-engine/src/signal-engine.ts`.

## Bounded implementation

1. Add shared AAPL candle helpers and tests. Define the unique source
`ibkr_aapl_rth_native_v1`, supported timeframes 1m/5m/1h/4h/1d/1w and unchanged
minimums 220/50/50/50/50/50. Use explicit America/New_York calendar conversion for
IB date-only daily/weekly timestamps, validating the date including leap years
and DST offset round trips. Intraday epoch timestamps remain authoritative UTC.
Reject unsupported timeframes, malformed timestamps, foreign sources, nonpositive
or incoherent OHLC and nonfinite/negative volume. Require exact symbol/contract
at the ingestion and context boundaries.

2. Define conservative closed-bar end times. Intraday bars become eligible only
after their full nominal duration (1m/5m/1h/4h) has elapsed. Validate intraday starts
inside New York weekday regular hours; reject pre/post-market starts even when a
producer mislabels provenance. A date-only daily bar closes at next New York
midnight; a weekly bar closes at the next Monday New York midnight. Calendar
arithmetic must handle DST without assuming every day/week is 24/168 hours.
Never infer a premature close from partial volume or the wall clock. In particular,
a 09:30 ET four-hour bar is not eligible before 13:30 ET. Preserve the existing
freshness limits measured from the calculated end; lack of fresh eligible 4h
history before that time is a legitimate activation blocker. Do not use extended
hours, shorten the bar or increase the freshness limit to force a test.

IB `useRTH=1` supplies actual exchange-session history, including holidays and
short sessions. This change does not introduce a holiday-calendar service or
infer normal sessions on holidays. Conservative full-duration eligibility can
retain a short-session partial bar longer before accepting it; tests must prove
it cannot be accepted early. Operational preflight still checks current broker
liquidHours and the authorized entry/exit interval. Broker date-only finality is
conservatively delayed as above, not guessed from normal close hours.

3. Add exact-AAPL subscription detection and a dedicated native refresh worker.
Only aapl_nasdaq/AAPL/conId265598/STK/SMART/USD can use the source. The historical
adapter requests TRADES, `useRTH=1`, rejects 12h and filters all results for closed
valid source-bearing bars before returning/persisting them. Existing WSE parsing
and requests stay unchanged; all other subscriptions retain their current path.
Request sufficient extra bars beyond the required count so removal of unfinished
bars does not reduce a complete source to an artificial warmup failure.

4. Add source-specific DB reads using the existing candle `source` column; no
migration or relabeling of old rows is needed. Filter provenance in SQL before
ORDER BY/LIMIT so a large recent batch of legacy rows cannot hide eligible native
history. Native fetch may upsert broker-returned bars at existing timestamp keys;
this is replacement with new broker evidence, not backfilling provenance onto old
values. Exact-AAPL minute aggregation, higher aggregation, shutdown flushes and
legacy bootstrap jobs must not overwrite the canonical native rows or manufacture
12h rows. Exclude exact AAPL from those paths and send it through the native
warmup independently of recent legacy timestamps.

5. Wire refresh at bootstrap and on a bounded timer, with one refresh in flight,
awaited shutdown/bootstrap coordination and per-timeframe throttling. Reuse the
existing historical request pacing path; the 60 requests/10 minutes broker limit
is account-wide across client IDs. Never use a separate unpaced socket or retry
loop. Refresh required minute bars at most once per minute, higher bars only
when their expected closed successor is due or counts are insufficient, with
bounded failure backoff. Other service history traffic still shares the account
budget, so operational loading must remain serialized and respect broker pacing
errors. Publish truthful AAPL warmup count/latest/checkedAt/error fields alongside
the existing WSE status, without calling stale counts ready.

6. Extend the signal repository/context-loader read contract for exact-AAPL source
selection while preserving existing WSE boolean/call compatibility and all other
instrument behavior. Apply valid-closed AAPL filtering to every required timeframe
and calculate freshness from the bar end. Preserve minimums, current quote and
binding validation, required six timeframes and default strategy parameters. Do
not consume the legacy 12h source. No edits to the dirty legacy signal-engine.ts
are necessary: the bound runtime context loader is the production test path.

## Expected files and constraints

- New shared `aapl-candles.ts` and tests; shared index exports.
- New ingestion `aapl-native-refresh.ts` and tests; targeted historical adapter
  tests; ingestion `tws-client.ts`, `db.ts`, `index.ts` wiring.
- Signal repository/source selection and runtime strategy-context-loader tests.
- PostgreSQL provenance/overwrite regression using isolated test databases.
- AAPL runbook and implementation report with sanitized operational evidence.

Prefer additive helpers rather than generalizing WSE/futures behavior in this
patch. If actual IB timestamps or source availability contradict the proposed
finality rules, stop activation and amend this plan for independent review rather
than weakening validation or guessing session alignment.

## Acceptance and validation

Independent plan ACCEPT precedes implementation; a different independent agent
reviews implementation, hostile cases and completeness, with findings fixed to
acceptance. Required tests include:

- Exact AAPL identity only, six native RTH requests, no 12h request and unchanged
  WSE/other-symbol request behavior.
- Epoch/date-only conversion, DST boundary weeks, valid leap day/invalid dates,
  intraday RTH boundaries, partial current 1m/4h/daily/weekly bars and short-session
  conservative finality; malformed OHLC/volume/provenance refusal.
- SQL source filtering before LIMIT with many newer legacy rows; native rows
  selected and legacy/aggregate/current partial bars excluded.
- Insufficient but recent legacy aggregates trigger native warmup; native data is
  not overwritten by tick/higher aggregation or shutdown flush.
- One refresh in flight, bounded request frequency/failure backoff, bootstrap and
  shutdown await refresh, pacing failure remains observable and blocks readiness.
- Loader refuses insufficient/stale native closed history and accepts sufficient
  valid history with freshness measured from the end; untouched non-AAPL/WSE
  behavior, unchanged counts and absence of 12h consumption.

Run clean-copy lint/typecheck/unit/isolated-PostgreSQL integration/build and a
clean Docker build. Run deterministic existing-strategy replay over a frozen,
validated six-timeframe fixture with the changed data path, comparing actual
context/strategy outputs to the same native bars read directly. Report signal
counts as mechanics evidence, never as profitability. Perform relevant existing
strategy/backtest regressions without tuning parameters. Commit/push on main and
verify exact-commit CI before disabled deployment.

## Operational validation and rollback

Rebuild/redeploy only the affected services with Paper trading/loop disabled.
Bootstrap exact AAPL through ingestion's supported API, inspect real broker-backed
native source counts and oldest/latest closed times for all six timeframes,
verify no future/unfinished bars and current live quote identity. Re-run account,
AI, reconciliation, window and lifecycle readiness checks. If a gate is unavailable
or the market window has passed, leave trading off and report the precise blocker.
Activation remains within the owner's bounded supervised authorization only after
all gates pass. No ad hoc SQL history fabrication, provenance relabeling, manual
strategy signal or bypass of AI/risk is permitted.

Rollback consists of leaving writes and loop disabled, stopping refresh and
redeploying the prior reviewed images. Keep broker positions/orders reconciled;
never delete them or reset consumed entry budgets. Persisted source-marked history
can remain for inspection; rollback does not establish readiness to trade.
