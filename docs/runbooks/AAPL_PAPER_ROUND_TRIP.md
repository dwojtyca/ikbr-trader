# Supervised one-share AAPL Paper test

Use only after the reviewed adapter fix and AAPL code pass exact-commit CI. This
runbook changes instrument, not the strategy → AI → risk → execution flow. Never
submit directly through IBKR or manufacture an entry signal.

## Disabled deployment

Keep `IBKR_ENVIRONMENT=paper`, `TRADING_ENABLED=false`, `TRADING_LOOP_ENABLED=false`
and the AI worker stopped while preparing. Set `GPW_PROFILE_ENABLED=false`,
`GPW_MOMENTUM_PROFILE=default`, `AAPL_PROFILE_ENABLED=true`. Clear legacy
`WATCHLIST_SYMBOLS` and allow only `aapl_nasdaq` in the bound runtime/loop. Ensure
no competing producer/proposal or pending AI delivery remains. Set the same secret
execution token in internal clients without logging it.

Verify Gateway contract AAPL/conId265598, SMART routing, NASDAQ primary exchange,
USD, localSymbolAAPL and current minTick. Configure exact binding in the existing
INSTRUMENT_BINDINGS_JSON shape; do not use a guessed conId/tick. Default policy is
one whole share, LONG/LMT/DAY, outsideRthfalse, mandatory TP+SL and existing default
momentum_breakout_long_v1 parameters. PKO's relaxed profile must not carry over.

Server risk caps default to maxnotional500USD, stoprisk5USD and fee reserve5USD:
`EXECUTION_AI_AAPL_MAX_NOTIONAL_USD`, `EXECUTION_AI_AAPL_MAX_STOP_RISK_USD`,
`EXECUTION_AI_AAPL_FEE_RESERVE_USD`. Require explicit available USD cash for entry
plus reserve, not total account equity or a PLN balance. Existing percentage,
account-wide exposure, spread/slippage, daily-loss and freshness checks remain.

## Operational gates

- Current allowlisted Paper account, fresh account risk evidence and USD cash.
- Current-session CLEAN reconciliation, complete source coverage and no unresolved
  holds. Other-contract positions/orders must retain valid known identities and
  pass account-wide checks. No AAPL position/working orders or competing proposal.
- Fresh exact-contract bid/ask with marketDataType1, not delayed/frozen. A market
  data subscription description or successful contract lookup is insufficient.
- Actual current broker liquidHours contain the complete chosen window, including
  holiday/early-close handling. The application's weekday09:30–15:45ET envelope
  is only a conservative additional guard, not an exchange calendar.
- Closed, identity-matching 1m/5m/1h/4h/1d/1w history and valid indicators. Existing
  minima are1m220 and each retained higher timeframe50; counts alone are not proof
  of closed valid bars. Set bootstrap12hcount0. AAPL deliberately excludes legacy
  12h rows because that path can label IB8h bars as12h. Do not relabel data to pass.
  Require `ibkr_session_rth_native_v1` provenance from the shared native bootstrap/refresh
  path and inspect `sessionWarmup` at `/backfill-progress`. See
  [instrument-independent readiness](INSTRUMENT_SESSION_READINESS.md). Intraday eligibility uses the authoritative persisted
  IBKR `SCHEDULE` response and session-clipped UTC buckets. In New York summer time
  4h buckets are09:30–12:00 and12:00–16:00; in winter they are09:30–11:00,
  11:00–15:00 and15:00–16:00. Early-close sessions clip the last bucket. Daily/weekly retain conservative
  next-midnight/next-Monday finality. Before today's first completed higher bar,
  the exact last completed slot from the previous trading session can be used.
  Missing a newly due bar blocks after90s publication grace; a previous-session
  minute never satisfies the current-session1m requirement.
- Pre-open: warm all six timeframes and inspect schedule generation/status,
  coverage, received time and expected/latest slots in `sessionWarmup`. Schedule
  evidence must be READY, at most6h old, cover the current time and complete prior
  week, and survive reconnect/refresh without a newer invalidation. Pre-open
  context remains blocked until a current-session minute closes. Earliest normal
  evaluation is approximately09:31ET plus ingestion/AI latency, assuming history
  is already warm. This is eligibility, not a promise of a signal or fill.
  The dedicated schedule clientId must differ from ingestion, execution and
  other Gateway clients. Do not run parallel backtest history loading.
- AI provider/worker readiness, no competing pending reviews. Missing research or
  rejected AI decision remains a valid refusal.

Choose a fresh run ID and explicit UTC ISO AAPL_RUN_START/AAPL_RUN_END for one
20–30minute supervised test, on the same New York date, max60minutes. Set
AAPL_RUN_ACCOUNT to the verified allowlisted account. Keep the window wholly
inside the persisted broker session and confirmed liquidHours and before an operator exit deadline at least15min
before close. `/execution/aapl-window` reports durable eligibility. A consumed
attempt cannot be reset by restarting or changing run ID. Unknown submission
consumes the attempt and must be reconciled, never blindly retried.

The bound AI worker requires exact AAPL proposal identity, configured binding and
raw ingestion metadata with `source=ibkr`: STK, SMART routing, NASDAQ primary
exchange, USD, local symbol AAPL and trading class NMS. Missing or contradictory
evidence rejects before provider calls. A valid identity does not verify
symbol-only news or provide missing fundamentals. Inspect persisted review
coverage and the actual EXECUTE/REJECT reason; provider configuration or a
successful model request alone is not proof of complete research.

Only after every gate passes may the authorized Paper writes, AI worker and loop
be enabled for that bounded window. Observe durable proposal, AI, risk and broker
outcome. No signal is not a defect or authorization to force one. Expired entry
window blocks new entry, but does not cancel protective orders or close positions.

## Exit and evidence

Use the existing audited one-share `POST /execution/lifecycle/:id/close` lifecycle and
its ownership/idempotency/close-risk checks, as described in the
[GPW runbook](GPW_PAPER_ROUND_TRIP.md). Keep writes enabled until a needed supported close is
complete; turning writes off does not flatten a position. Never reverse or retry
an unknown close. Collect read-only `GET /execution/lifecycle/:id/round-trip` evidence
after broker reconciliation; use local
proposal ID and original persisted AAPL window binding. AAPL grossPnl.currency is
USD; netPnlUSD requires compatible complete commissions. Mixed currencies are
reported without fabricated FX/net profit. GPW netPnlPLN output remains compatible.

Stop the loop/AI worker, disable writes and verify final state after the supervised
run. Record actual outcome without claiming profitability from one mechanical test.
