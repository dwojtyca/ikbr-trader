# GPW1 — PLN valuation evidence and risk limits

Status: ACCEPTED by independent gpw1_plan_review (2026-09-23). Work on main. No broker order,
service restart, instrument activation, paid API request or FX conversion.

## Owner scope and observed environment

The owner selected GPW instead of AAPL and authorized recommended test limits,
strategy inspection, and read-only use of their Paper Gateway. On 2026-09-23
Gateway resolved PKO BANK POLSKI SA: conId 35146360, WSE, PLN,
ISIN PLPKO0000016, Europe/Warsaw. Main account summary metrics arrived in USD.
A live-data request failed with 10197 (competing live session); this does not
prove whether a WSE subscription is present. No orders were sent.

## Delivery sequence

1. **This PR: GPW1 currency-risk foundation.** Preserve the current USD path;
   capture explicit account FX/cash evidence and implement PLN-to-USD risk
   valuation in the mandatory entry assessor with server-owned caps. No stock
   definition/activation; lifecycle remains USD-only until GPW2. Thus passing
   a PLN unit test is NOT permission or readiness to trade PLN.
2. **GPW2 market and lifecycle integration.** Authoritative WSE tick schedule
   (not the current approximate hardcoded ladder, not contract minTick alone),
   price-aware entry/TP/SL/close validation, broker calendar + Warsaw continuous
   session, PLN ownership/full close, disabled PKO catalogue entry and explicit
   activation configuration. Review plan independently before implementation.
3. **GPW3 faithful strategy and controlled run.** Preserve strategy levels in
   bound submission, warm up all required history, prove mandatory AI gate,
   define one-round-trip entry budget, and validate currency-labelled P&L/fees,
   operator close/reconcile and abort runbook. No forced signal or AI approval.
   Strategy early-exit routing is currently absent; either implement it in this
   phase or explicitly restrict this mechanics run to broker SL/TP + supervised
   full close. Full autonomous strategy lifecycle is not yet delivered.

## GPW1 implementation

- Keep `riskEvidence.usdMetrics` and existing USD account validation compatible.
  Add optional explicit account `exchangeRatesToBase` and `cashByCurrency` maps,
  sourced ONLY from matching-account `updateAccountValue` ExchangeRate and
  CashBalance events within this request. Publish on matching accountDownloadEnd.
  Accept finite decimal numeric strings below the IB unset threshold; ignore
  empty/BASE currency keys, blanks, NaN, Infinity, unset and non-decimal input.
  A fresh request has fresh maps; never carry data from previous requests.
- Do not reuse the UI P&L FX helper: it guesses rate direction. IB documents
  ExchangeRate as currency-to-base. For a PLN entry require configured base USD,
  explicit USD account metrics, explicit USD ExchangeRate=1, positive PLN rate,
  and sufficient explicit nonnegative PLN cash. Missing evidence fails closed.
- Entry assessor supports exactly existing USD stocks and PLN WSE stocks;
  bound and instrument currencies/exchanges must agree for the new shape.
  Keep one whole-share BUY LMT, bracket, identity, AI, freshness and policy
  safeguards. No short, fractional, futures or generic multicurrency expansion.
- Convert PLN notional and planned stop risk to USD using raw PLN-to-base
  ExchangeRate multiplied by 1.02 as a valuation buffer. Compare these USD
  amounts with explicit USD AvailableFunds, NetLiquidation and GrossPositionValue.
  Record original PLN values, rate, buffer, valuation currency and cash in the
  persisted evidence; original `notional`/`stopRisk` remain account USD values.
  This is account valuation data, not an executable FX quote or auto-conversion.
  Freshness means receipt in a completed account snapshot (<10 seconds), not
  a claim that IB updates account valuation ticks every ten seconds.
- Server-owned PLN defaults: max notional 500 PLN, planned stop risk 5 PLN,
  fee/cash reserve 30 PLN. Require PLN CashBalance >= notional + reserve.
  Both quote-currency caps and existing percent/account caps must pass.
  PLN cap configuration must be positive and finite; clients cannot supply it.
  Proposed percent limits for this test: notional 1%, stop risk 0.05%, total
  account exposure 1%. Apply these to local .env without disclosing secrets;
  TRADING_ENABLED and TRADING_LOOP_ENABLED stay false. No other local secrets
  or unrelated settings changed. Production default percentages stay compatible.
- Planned PKO spread/slippage caps are 0.05 PLN each, quantity one, DAY LMT,
  only a supervised round trip. They are applied in the GPW2 instrument profile,
  not claimed as enforced by this currency-only PR. 5 PLN excludes commissions
  and gaps; SL is not a guaranteed maximum realized loss.

## Acceptance

- Existing USD happy/negative cases unchanged.
- PLN positive arithmetic fixture: entry 100, stop 99, rate .25 -> buffered
  notional 25.5 USD and stop risk .255 USD; cash reserve checked in PLN.
- PLN negative matrix: wrong exchange/currency, missing/inverted base evidence,
  absent/zero/negative/NaN FX, insufficient/missing cash, absolute cap exceeded,
  invalid caps, overflow, stale account/quote, all existing identity safeguards.
- Fake IB account stream: foreign account and mismatched completion ignored;
  maps isolated across requests; BASE/invalid numeric input not promoted.
- Production submission PostgreSQL coverage: correct PLN evidence persisted on
  approved dispatch; pending never dispatches; missing currency evidence denies
  with zero broker preparation/dispatch. No real IBKR calls in automated tests.
- A new independent implementation review must ACCEPT after corrections.
  Then lint, typecheck, test, build and full disposable-PG integration checks.
  No strategy behavior changes, hence no strategy-performance backtest required.
  Report exact remaining GPW gates, commit/push only this scope, verify GitHub CI.

## Sources and audit

IB ExchangeRate definition:
https://interactivebrokers.github.io/tws-api/interfaceIBApi_1_1EWrapper.html
IB minTick limitations:
https://www.interactivebrokers.com/docs/tws-api/doc/orders/minimum-price-increment/introduction

Independent strategy audit: 54 tests passed. Current daily20 >=8%, H1 four-bar
return >=1%, volume >=1.2x, SL ATR/structure, TP5R; no data-backed reason to tune.
UTC strategy window 08:00-20:59 is not a GPW calendar. Bound loop currently drops
strategy prices; all of those limitations remain explicitly tracked above.

Review additions: test rejection of out-of-registry PLN binding; invalid newer
account values must replace rather than preserve earlier valid values; reject
arithmetic overflow. Read-only account stream confirmed explicit USD rate=1 and
PLN-to-USD rate, but no positive PLN cash. GPW2/3 must not activate trading until
all run prerequisites pass. No virtual funds were converted.

## CI follow-up — duplicate close requests (ACCEPTED)

Independent gpw1_plan_review accepted this correction on 2026-09-23.

CI run 35921020165 failed the existing `parallel same-key requests dispatch once`
PostgreSQL test. Reproduced against a clean copy of fdebe6e by staggering the
second initial refresh: both callers returned BLOCKED with
`close_position_generation_unusable`, zero cancellations/preparations/dispatches.
Both requests can read no existing operation before either reserves it; each
then refreshes broker state. The duplicate's refresh invalidates the first
request's evidence. The safety rejection is correct; duplicate request work is
unnecessary. This is a lifecycle concurrency fix, not a PLN valuation change.

Proposed narrowly scoped correction:
- Coalesce in-flight requests per original proposal inside FullCloseService.
  Register synchronously before the first asynchronous lookup. Same request UUID
  and price await the existing operation promise; different UUID/price conflict.
- Remove the in-process entry on success or failure. After settlement, retain
  existing durable read-only replay behavior. Never re-drive an unknown close.
  Preserve database reservations, account locks, snapshot/connection generation
  fences and exact plan checks unchanged; cross-process contention remains
  conservatively fail-closed. No distributed liveness guarantee is introduced.
- PostgreSQL regression uses a barrier on the first repository lookup (no timing
  sleeps): concurrent identical requests perform one initial lookup and produce
  one shared submitted operation/one cancel per leg/one prepare/one dispatch.
  Test conflicting key/price while blocked; verify read-only replay after
  settlement and cleanup after an initial refresh failure before reservation.
- Keep and rerun existing invalidation, unknown-result and concurrency tests.
  Obtain independent plan acceptance, implement, obtain independent implementation
  acceptance, then rerun full local gates, commit/push main and check fresh CI.

Additional test-fixture correction ACCEPTED by gpw1_plan_review: a full close-suite run exposed
`snapshot_time_invalid` in the fake broker's production-runner test. That fake
uses host `new Date()` for capture while run start/completion use PostgreSQL's
clock. Align the fake capture with a `SELECT clock_timestamp()` from the test DB
and, before returning fixture refresh, wait only until the persisted completion
instant is no longer in the host's future. This coordinates test clock domains;
it does not relax production timestamp validation or retry the operation. Keep
bounded waiting and descriptive failure if test clocks differ materially.

Clock-domain mismatch is the likely explanation, not a deterministically
reproduced root cause. The wait targets the specific completed run with a
100ms maximum clock difference; no close/reconciliation retries are allowed.
Production clock consistency remains a required operational condition.
