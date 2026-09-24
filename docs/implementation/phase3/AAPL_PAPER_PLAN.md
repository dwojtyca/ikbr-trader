# AAPL supervised Paper round trip

## Objective and prerequisites

The owner selected Apple for a supervised one-share Paper test while the US market
is open. Deliver the existing strategy → mandatory AI → deterministic risk → IBKR
flow for exact AAPL, without changing GPW behavior or enabling unattended trading.
Completed-zero-total repair is a separately reviewed prerequisite. Preserve the
29 unrelated research files, especially dirty signal-engine.ts. Work on main.
Default configuration stays disabled. No fabricated signal, research result,
quote, history or broker ownership. If preflight fails, do not activate.

## Bounded changes

1. Add disabled aapl_nasdaq seed (AAPL, conId265598, SMART/USD, New York us_stock_rth).
One whole share LONG LMT DAY, outsideRth false, bracket required, maxQuantity1,
maxSpread/maxSlippage0.05USD. Explicit AAPL_PROFILE_ENABLED=true activates the
existing momentum_breakout_long_v1 default profile in paper only. Reject simultaneous
GPW+AAPL enablement. PKO mild/moderate profiles remain PKO-only. Confirm bound
contract/minTick and routing before launch; tick0.01 is a provisional registry policy.
2. Add independent AAPL window module/tables via new migration; do not edit applied
migrations or repurpose GPW tables. Four required AAPL_RUN_* settings (ID, account,
start,end), explicit valid timestamps, one New York weekday, max60min and within
09:35–15:45ET. Window status read endpoint uses existing auth conventions. This is
an application safety interval, not a holiday/early-close calendar: operational
preflight must additionally verify the chosen interval against current broker
liquidHours. Refuse partial configuration or live environment.
3. Wire equivalent proposal insertion/binding, pre-prepare, atomic claim/budget,
pre-dispatch and dispatcher deadline checks for AAPL. Recognize any AAPL alias
(symbol OR instrument ID OR conId) but require all three exact before insertion;
refuse missing/mismatched identity. Persist window association before AI review.
One entry attempt per account/New York date, serialized using existing account
advisory lock and unique consumed-date constraint; restarts/reconfigured IDs cannot
reset it. Unknown dispatch consumes the attempt; do not retry it. No window gate
on the audited full-close path. GPW gates/tests remain unchanged.
4. Add AAPL-specific absolute USD limits (defaults500 notional,5 stop risk,5 fee
reserve) to existing server risk configuration/evidence. Require explicit finite
USD cash sufficient for notional+reserve; retain all existing percentage/account
exposure, quote freshness, exact identity, AI and protection checks. Reject absent
caps in direct unit/service inputs for AAPL; other USD instruments retain behavior.
Do not use configured account equity as a substitute for USD cash.
5. Exclude mislabeled legacy12h history only for exact bound AAPL in both strategy
loader and loop required-timeframe selection, with the existing six GPW timeframes
retained. Do not relax minimum counts or freshness. Configure AAPL bootstrap12h=0;
preflight must verify actual closed-bar times and contract identity for1m/5m/1h/4h/
1d/1w. No strategy tuning or new strategy. Existing US history pipeline remains;
if it cannot supply valid closed data, activation remains blocked and that data
fix requires a reviewed amendment rather than fabricating bars.
6. Extend existing read-only round-trip evidence collection to choose the persisted
AAPL window association for exact AAPL identity, preserving GPW compatibility.
Never synthesize consumed-window evidence. Add PostgreSQL regression for AAPL
consumed window plus USD fills and unchanged DB, with missing/wrong association
refused by normal assessment. Extend the same assessor's explicit shape from
PKO/WSE/PLN to additionally exact AAPL/SMART/USD. Validate approval quoteCurrency
and fill currency against that exact selected shape. Gross P&L reports its currency;
add optional netPnlUSD while preserving netPnlPLN compatibility. Never convert or
combine currencies implicitly. Test AAPL USD round trip and hostile mixed currencies,
plus unchanged GPW output.
7. Document AAPL configuration, disabled deployment, required verified real-time
bid/ask, exact metadata/bindings, account cash/risk, current-session CLEAN recovery,
no AAPL exposure/orders/competing producers, history, AI worker readiness, one
20–30min supervised window and exit deadline before the confirmed market close.
Keep GPW disabled for AAPL. Execution/loop writes turn on only after all gates
pass within owner-authorized Paper scope. Retain existing audited full-close,
protective bracket and unknown-outcome reconciliation behavior.

## Acceptance and tests

Independent plan ACCEPT before edits; different independent implementation review
including completeness and hostile cases, fixes until ACCEPT. Tests: default-off,
mutual exclusion and live refusal; exact identity aliases; timezone DST/calendar/
weekend/interval edges; window restart/reconfiguration/old proposal/expiration at
claim and dispatch; concurrency one budget consumer; unknown dispatch not retried;
no bypass of AI; USD caps/cash malformed/missing/stale/insufficient; existing quote
rejections; no AAPL12h requested or consumed; non-AAPL and GPW regressions unchanged.
Production submission-service/PostgreSQL integration must exercise actual AAPL
window binding/claim/dispatch rather than a parallel mock implementation. Existing
one-share USD close/lifecycle suite must pass; no ad hoc broker submission.

Run full clean-copy lint/typecheck/unit/isolated-PG integration/build and clean
Docker build. Existing strategy behavior is unchanged; perform deterministic
strategy-context regression/replay for the changed input timeframe set, without
claiming profitability. Exact-scope report/commit/push main and exact CI before
disabled deployment. Verify actual broker quotes and historical data read-only.
If all operational gates pass, start a bounded supervised test and report actual
outcome; no signal or AI rejection is valid, not permission to force an entry.
Otherwise record exact blocker and keep writes/loop off. No account IDs, financial
quantities, broker identifiers or secrets in committed reports; synthetic fixtures.
