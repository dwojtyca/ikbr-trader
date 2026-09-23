# GPW1 — PLN currency-risk foundation

Implementation ACCEPTED by independent gpw1_implementation_review. Local gates passed. GitHub CI is checked separately after push.
Plan: [GPW1_CURRENCY_RISK_PLAN.md](GPW1_CURRENCY_RISK_PLAN.md).

The owner selected GPW for the first supervised Paper round trip. This bounded
PR captures explicit IB account ExchangeRate/CashBalance currency evidence and
extends the entry risk assessor to value WSE PLN stocks against a USD account.
It preserves current USD behavior, one-share/long/bracket safeguards and AI
approval. There is no enabled stock in the production catalogue; this PR alone
cannot activate PLN entry, and ownership/full-close remains USD-only.

PLN notional and stop risk are multiplied by IB's explicit PLN-to-base rate
with a 2% valuation buffer. USD ExchangeRate must equal one, configured base
must be USD, and the complete recent account snapshot must carry explicit USD
metrics. No heuristic inversion, BASE fallback or automatic currency conversion.
FX freshness describes receipt of the account snapshot, not FX tick freshness.
Currency-labelled amounts, rate, buffer and cash evidence are durably stored
with the AI-reviewed submission. Missing/invalid evidence denies execution.

Server defaults: max notional 500 PLN; planned stop risk 5 PLN; PLN cash reserve
30 PLN. Local `.env` uses 1% notional, 0.05% stop-risk and 1% gross-exposure caps,
in addition to those PLN caps. Trading and the loop remain disabled. No secrets
are published. Planned spread/slippage limits 0.05 PLN each belong to GPW2,
not this PR. Stop risk excludes commissions and price gaps; reserve is a cash
buffer, not a forecast or guarantee of broker fees.

## Verification

- Independent plan review: ACCEPT (`gpw1_plan_review`).
- 162 targeted currency/account/config/binding tests passed.
- 21 PostgreSQL AI-gate tests passed, including PLN evidence persistence,
  pending and invalid-FX rejection and exactly-once approved fake dispatch.
- Execution-engine typecheck passed.
- Independent implementation review: ACCEPT after overflow correction.
- Full `pnpm test`: 1742 passed; full disposable-PG integration: 823 passed.
- `pnpm lint`: passed with three pre-existing warnings; typecheck and build passed.
- No strategy behavior was changed; the existing backtest suite was included in
  the full tests. No new strategy-performance experiment was run.

## Operational evidence and remaining gates

Read-only Gateway checks on 2026-09-23 resolved PKO BANK POLSKI SA at WSE,
PLN, conId 35146360, ISIN PLPKO0000016. The account supplied explicit USD
metrics, USD parity and a PLN conversion rate, but no positive PLN cash.
Market data returned 10197 (competing live session). Existing WSE data entitlement
remains unproven. No broker order, FX trade or paid API request occurred.

GPW2 must replace the approximate WSE price ladder with authoritative price-band
rules, implement Warsaw/broker session checks and PLN ownership/full-close.
Contract minTick=0.0001 alone does not prove the applicable tick at order prices.
GPW3 must carry strategy entry/SL/TP through bound runtime, define/verify the
single-round-trip budget, complete warmup, AI data coverage, currency-labelled
P&L and supervised close/reconcile/abort procedure. Activation remains off until
all gates pass. Positive PLN cash and fresh live BBO are operational prerequisites.

The separate strategy audit passed 54 tests. Momentum parameters were preserved:
daily20 gain >=8%, H1 four-bar gain >=1%, volume >=1.2x, ATR/structure stop and
5R target. No signal is a valid outcome; no profitability tuning was attempted.
Current bound runtime drops strategy SL/TP in favour of static distances and
does not route strategy early exits. The UTC 08:00-20:59 strategy filter is not
a GPW session calendar. These gaps are tracked in the next stages, not hidden
by the passing currency tests. No full Paper round trip has been proven.

Implementation review caught intermediate overflow in percentage comparisons.
All three caps now divide percentages before multiplication; a regression
checks notional, stop-risk and exposure caps with finite large inputs.
