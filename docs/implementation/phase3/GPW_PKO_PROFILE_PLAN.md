# PKO mechanics profile comparison and durable readiness

## Scope

Owner accepted comparing milder parameters of the existing momentum breakout
strategy for PKO and fixing stale readiness before another supervised Paper test.
Work on main; preserve the 29 research files recorded in the private baseline.
No new strategy, fabricated signal, altered candle, relaxed risk/AI gate or broker
write. Deploy with writes/scheduler disabled. Operational trading is conditional
on sufficient comparison evidence and the existing supervised runbook scope.

## Parameter profiles

Keep existing defaults byte-for-byte in behavior for all callers by default.
Introduce two immutable named candidates, changing only three momentum thresholds:

| profile | daily20 minimum % | hourly4 minimum % | minute60 minimum % |
| --- | --- | --- | --- |
| default | 8 | 1 | 0.2 |
| pko_mild_v1 | 5 | 0.5 | 0.15 |
| pko_moderate_v1 | 3 | 0.3 | 0.1 |

Freeze these candidates before replay; do not search a grid or further lower
values to obtain a current signal. All trend/RSI/breakout/volume/candle-quality,
reward, stops and take-profit rules remain unchanged. One-share/PLN limits,
mandatory AI, fresh data, session/window and one-attempt budget stay unchanged.

An optional typed profile ID on InstrumentExecutionPolicy flows through the
production StrategyContextLoader into internal StrategyContext. Named opt-in
GPW_MOMENTUM_PROFILE defaults to default; configured registry accepts candidates
only with explicit GPW_PROFILE_ENABLED=true and paper environment, applies them
only to pko_wse. No environment branching inside strategy business logic. Candidate
selection requires exact instrument/bound PKO STK/WSE/PLN/conid identity. The pure
strategy also refuses candidate use for non-PKO symbol/conid/secType; malformed
profile IDs fail closed. Unrelated and legacy contexts retain baseline defaults.
Record profile identity in emitted signal metadata/reason for diagnostics. No
caller-controlled ticket field can select a profile or bypass attribution.

## Reproducible history comparison

Add a read-only offline replay command under signal-engine, not the dirty
backtest subsystem. Input is a frozen, hashed JSON export of existing PKO native
candles for 1m/5m/1h/4h/1d/1w. Export through a read-only database query; no writes
or extra IBKR fetcher. Keep raw market/account evidence out of git. Validate input
identity, finite OHLCV, native source, valid timeframes and unique timestamps.

Replay each eligible closed1m point with the real StrategyContextLoader,
indicator/regime computation and existing strategy/portfolio evaluator. Higher
bars enter only after their actual WSE interval end; no lookahead or synthetic
higher bars. Reconstructed last price comes from the latest closed1m candle and
is labelled historical, not a broker BBO. This is signal-frequency/rejection
comparison, NOT a fill simulator, profitability proof or broker validation.

Report frozen dataset hash/range/counts, eligible vs unavailable context reasons,
per-profile signals/rejection counts per Warsaw session and a chronological
session split. Minimum selection evidence: four fully represented eligible
sessions: only Warsaw dates strictly before the frozen export date, with sufficient
preceding warmup enforced by the real loader; at least90% of the196 minute
evaluation points in the fixed13:15–16:30 Warsaw test interval must have valid
eligible context, endpoints must be covered and no gap may exceed5minutes.
Exclude/report every partial, still-current, sparse or gapped date. Split eligible
sessions chronologically: first floor(N/2) development, remainder holdout, at least two sessions
in each. Candidate must yield at least one genuine signal in BOTH partitions;
evaluate default first under the same evidence criteria and retain it if it qualifies;
otherwise select mild then moderate, the least-relaxed qualifying candidate. Overlapping signals are reported
as signal observations, not independent trades. Insufficient sessions or zero
qualifying candidates yields INSUFFICIENT_EVIDENCE / NO_CANDIDATE, never an auto
activation or threshold retune. Initial observed history is only ~430 native1m
bars over two sessions; expect insufficient evidence and state that limitation.
Profiles stay default unless selection criteria pass. Do not promise another
Paper entry without a genuine signal and all operational gates.

Tests: default behavior equivalence; exact PKO opt-in identity and malformed/
foreign cases; each threshold boundary with otherwise valid real strategy fixture;
unchanged breakout/volume/risk-sensitive signal levels. Replay determinism, future
bar exclusion, insufficient history, held-out session separation and least-relaxed
selection, including four sparse dates with signals still rejected as insufficient. Run the replay against real frozen history as the behavior check.

## Readiness source of truth

Replace local lastReconciliationAt as /ready freshness input with completedAt from
the SAME latest durable reconciliation row used for health, for captured account
and current process session. Keep legacy timestamp only if needed for legacy
response compatibility. No startedAt, older CLEAN or recent legacy shim fallback.
RUNNING/FAILED/ABANDONED/wrong-session/missing/incomplete records remain unhealthy
per existing semantics. Invalid/future completedAt never establishes freshness.
Use the existing bounded age, preserving exact boundary behavior. Capture account
and broker connection generation before DB awaits; recheck afterwards. DB failure
and any session/account transition fail closed. Position snapshot health and
existing per-instrument reconciliation policy remain unchanged.

Extract a testable production readiness loader/wiring helper if needed, without
duplicating the HTTP handler. Tests use the same helper as /ready: scheduled fresh
run after stale startup passes, old durable run despite fresh legacy timestamp
fails, latest failed/running/foreign record cannot borrow older CLEAN freshness,
DB errors and invalid/future time fail, exact boundary and reconnect/account race.
Include PostgreSQL repository integration and explicit production-route wiring.

## Delivery

Independent plan ACCEPT, implementation, different independent hostile reviewer
ACCEPT; full clean lint/typecheck/unit/PostgreSQL/build, real history replay and
clean Docker build. Preserve unrelated hashes and secrets. Write sanitized report,
exact-stage commit/push main and verify exact CI. Deploy compatible reviewed image
with profile default unless evidence qualifies and with writes/scheduler disabled;
verify /ready follows durable periodic captures without restart beyond15min (or
use equivalent controlled clock integration evidence plus observed timestamp
advancement, clearly distinguishing observations). No forced signal to finish.

## Validation amendment — existing close fixture clock ordering

The full isolated PostgreSQL suite exposed three existing close-fixture failures;
 two explicitly report `close_position_generation_unusable`. The fixture writes
host-clock position timestamps and relies on a 3 ms sleep before a DB-clock
reconciliation timestamp. Replace only the fixture's position timestamp with a
preceding PostgreSQL `clock_timestamp()` reading, use it for both refresh writes,
and remove that sleep. Preserve all production guards and the existing bounded
completion-to-host synchronization. Add the returned reason to the retry assertion.
Re-run the close integration file and full clean gates; independently review this
bounded test-only amendment before implementation and its diff afterwards.
