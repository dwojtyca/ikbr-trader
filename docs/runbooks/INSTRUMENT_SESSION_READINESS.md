# Session-aware data readiness for bound IBKR instruments

The same readiness path applies to every configured, bound instrument. Selection
uses exact contract identity and registry session policy, never a ticker allowlist.
This does not enable instruments or extend strategy/AI/execution support.

## Before opening

Keep Paper writes and the trading loop disabled while preparing. Resolve the exact
contract binding and verify the registry session timezone and RTH/all-hours policy
against IBKR. The ingestion schedule-only connection checks contract details and
requests SCHEDULE for that same contract and mode. It cannot submit orders.

Bootstrap native 1m, 5m, 1h, 4h, 1d and 1w history. Required counts are 220 for 1m and
50 for each higher timeframe; they are indicator warmup minima, not permission to
trade. Generic native provenance distinguishes RTH and full-session data. Old
aggregated/ticker-specific history is not relabeled. Native 12h is unavailable;
8h data is never substituted. Explicit strategy 12h requirements fail closed.

`GET /backfill-progress` exposes `sessionWarmup`: per-contract identity/mode,
calendar generation/status/coverage, expected/latest candle slots and reasons.
Historical warming may use fresh broker calendars ending at the last close.
That does not extend coverage or make the instrument entry-ready. Runtime and
execution always require fresh current-time coverage and an active interval.

The current native polling design admits at most two concurrent bound instruments:
50 requests/10 minutes minus 20 reserved for schedules/higher bars/startup, with 12
requests per instrument for minute/five-minute maintenance. Above capacity it
invalidates calendars and reports a capacity error. Existing broker pacing is
unchanged. Do not run a separate historical loader against the shared account
budget during supervised testing. Same-conId conflicting session modes are refused
because the existing candle key cannot hold both series simultaneously.

## At the opening

After the first actual interval minute closes, the current-session 1m may combine
with the exact last closed higher-timeframe slots from previous sessions. Holidays,
early closes, timezone/DST changes, overnight reference dates and lunch intervals
come from the broker schedule. A reopening after lunch needs a new interval minute;
reference-date session-open indicators do not reset at lunch.

A newly due missing candle permits only the immediate predecessor for at most 90 s.
Afterward, the instrument is unready until the expected bar arrives. This is not
permission to use yesterday's 1m. Never fabricate missing candles or change their
labels. A weekly bar may use the final reference date or its following calendar
date; both identify one completed week with unchanged finality. Duplicate or
ambiguous weekly labels are rejected. Native alignment mismatches, invalid OHLCV, duplicate timestamps, wrong
identity/provenance, invalidated generations or stale calendars remain blocked.

Runtime strategy market-hour filters use verified instrument sessions instead of
a global UTC window. Intentional strategy waits and quantitative requirements stay:
opening-range strategies still need their opening range; momentum must still pass.
Missing opening data leaves gap/opening-range/VWAP evidence unavailable. MIDPOINT
history may have unknown volume; volume-derived indicators remain unavailable and volume-dependent strategies
reject explicitly rather than converting unknown volume to zero. Price-only
context remains usable when its required data and strategy capabilities permit.

Earliest evaluation means approximately one minute after opening plus broker,
ingestion and AI latency, assuming history is already warm. It does not guarantee
a signal, approval or fill. If the broker does not provide usable calendar/history
for a contract, report the capability failure instead of guessing a market schedule.

## Entry and diagnostics

Legacy `/signals/run-once` and `/signals/on-candle` producers cannot create proposals
without verified bound context; use the existing authenticated bound trading-loop
flow. Every bound new entry is checked against current persisted session evidence
at insertion, preparation, atomic claim and final broker dispatch. Direct submission
cannot use a forged close flag to bypass this gate. Supported lifecycle closes and
cancellations retain their separate ownership/risk rules.

The supervised PKO/AAPL windows, daily attempt budget, AI and deterministic risk
guards still apply. Switching profile or preparing data does not arm a window or
start the trading loop. Run the instrument's operational preflight during the session,
including fresh real-time BBO, cash, CLEAN reconciliation and absence of conflicts.

Live broker observations in the implementation report are limited to the markets
actually inspected. Cross-market fixture tests prove algorithmic behavior, not
market-data entitlements, tradability or profitability for every instrument.
