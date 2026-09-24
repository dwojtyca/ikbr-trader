# Supervised PKO Paper round trip

GPW3 prepares code only. This runbook does not authorize activation, orders or
paid provider calls. Obtain a separate owner-approved window and record its exact
commit. No real Paper round trip or profitability is proven by local tests.

## Prepare with trading disabled

Use only PKO BP, `pko_wse`, IB conId `35146360`, WSE, PLN, one whole share, long
`momentum_breakout_long_v1`, LMT DAY bracket. No forced signals, shorts, partials,
trailing exits, overnight holding or bot trading in extra instruments. Existing
positions and manual orders on other verified contracts (for example SMR) may
remain on the account; this procedure neither closes nor cancels them. Keep the scheduler off;
an operator invokes one evaluation at a time. An AI rejection/no signal is a
valid inconclusive result; do not alter thresholds or fabricate approval.

Prepare these settings in the local secret environment, never commit real account
IDs or tokens. Keep the same registry opt-in and binding on ingestion, signal and
execution. The opt-in alone does not authorize broker writes. Explicitly set
`WATCHLIST_SYMBOLS=` (empty) in ingestion and signal-engine; the legacy default
AAPL/MSFT/XOM watchlist is independent of the new loop allowlist. Remove competing
legacy producers and resolve any old pending proposals before enabling writes.

```dotenv
IBKR_ENVIRONMENT=paper
GPW_PROFILE_ENABLED=true
TRADING_ENABLED=false
EXECUTION_RUNTIME_ENABLED=true
EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT=paper
TRADING_LOOP_ENABLED=false
TRADING_LOOP_INSTRUMENT_IDS=pko_wse
WATCHLIST_SYMBOLS=
EXECUTION_AI_MAX_NOTIONAL_PLN=500
EXECUTION_AI_MAX_STOP_RISK_PLN=5
EXECUTION_AI_FEE_RESERVE_PLN=30
```

Set `ALLOWED_PAPER_ACCOUNTS` and `GPW_RUN_ACCOUNT` to the full verified Paper
account ID, `ALLOWED_LIVE_ACCOUNTS` empty, and `EXECUTION_API_TOKEN` to the same
secret (at least 32 characters) in all internal clients. Set `GPW_RUN_ID` to a
new unique identifier and `GPW_RUN_START`/`GPW_RUN_END` to explicit UTC ISO times
on the same Warsaw date, at most 60 minutes apart. The server validates its own
clock and permits at most one attempted entry per account/Warsaw date; restarting
or changing run ID does not replenish a consumed budget. Unknown dispatch consumes
the budget. There is no rearm/reset endpoint.

Use a 20–30 minute supervised entry window, provisionally 13:10–13:40 Warsaw,
only after actual history readiness is green and well before 16:45. Conservative
4h finality requires the complete four-hour interval plus the existing freshness
limit; an early morning start may have no usable 4h bar. The strategy also retains
its UTC 08–20 filter, so a summer 09:05 Warsaw start cannot produce an entry. Never
relax history age/finality to force readiness. Choose an operator exit deadline at least 15 minutes
before 16:45; a limit close is not guaranteed to fill. Entry-window expiry does
not cancel protection or close a position.

Configure `INSTRUMENT_BINDINGS_JSON` using the existing binding format:

```json
[{"instrumentId":"pko_wse","conId":35146360,"localSymbol":"PKO","tradingClass":"PKO","exchange":"WSE","currency":"PLN","minTick":0.0001}]
```

Confirm these values against current read-only broker metadata. `minTick` is
contract metadata, not a price rounding rule; current market-rule bands are the
pricing authority. Verify metadata client ID does not collide with other clients.
The default checked-in registry remains disabled.

## Preflight

After separately approved deployment, prepare the services with writes disabled.
Use the stack verifier in its explicit disabled-write mode:

```sh
env PAPER_VERIFY_RUNTIME_EXPECTED_STATE=registered \
  PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE=registered \
  PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE=disabled \
  PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled \
  PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true \
  PAPER_VERIFY_EXECUTION_TOKEN="$EXECUTION_API_TOKEN" pnpm paper:verify-stack
```

The verifier is infrastructure evidence, not sufficient launch authorization.
Check the following GET responses using the bearer token from the local shell:

```sh
curl --fail-with-body -sS -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  http://127.0.0.1:3103/execution/gpw-window
curl --fail-with-body -sS -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  http://127.0.0.1:3103/execution/instruments/pko_wse/market-rules
curl --fail-with-body -sS -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  http://127.0.0.1:3103/execution/account/summary
curl --fail-with-body -sS -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  http://127.0.0.1:3103/execution/reconciliation/latest
curl --fail-with-body -sS -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  'http://127.0.0.1:3103/execution/reconciliation/holds?active=true'
curl --fail-with-body -sS http://127.0.0.1:3101/watchlist
curl --fail-with-body -sS http://127.0.0.1:3101/backfill-progress
curl --fail-with-body -sS http://127.0.0.1:3102/runtime/trading-loop/ready
```

Require the actual ingestion watchlist to contain exactly PKO/conId35146360,
with no AAPL/MSFT/XOM or other legacy subscriptions. Abort if any other producer,
pending legacy proposal or competing AI delivery remains. An empty loop allowlist
is not proof of exclusive ownership. The disabled scheduler's `/ready` may return
`ready:true,checks:{}`; this is not warmup evidence. Inspect `/backfill-progress`
`wseWarmup` for all six required native closed timeframes and confirm no errors;
the real context loader still enforces freshness/indicators at evaluation time.
Require exact configured/active allowlisted Paper account, no live session conflict,
current unused window, exact PKO contract, fresh real-time bid/ask (no delayed/frozen
feed), open broker liquidHours inside the application window, complete closed-bar
history and all required strategy indicators. WSE 12h context is intentionally
omitted; no synthetic 8h/12h substitution. Wait for paced historical bootstrap;
do not repeatedly restart or launch another fetcher against the shared IB budget.
Require explicit PLN cash covering maximum planned notional plus 30 PLN reserve;
USD account caps still apply through verified FX evidence. Require current-session
CLEAN reconciliation, complete positions/orders/executions coverage, no holds,
existing PKO exposure, working PKO orders or competing bot proposals. Record
other-contract positions and manual orders separately; validate their identities
and the complete account snapshot. They remain subject to account-wide risk,
cash, margin and reconciliation checks. Unknown contract identity, collisions
with PKO ownership evidence, account holds or incomplete reconciliation still
block the test. Do not infer readiness
from a large account total in another currency.

Confirm the AI worker is configured and its mandatory news/model providers are
available. Calls during the operational test may incur provider costs. Current
coverage includes technical/account evidence and symbol-based news; PKO symbol-only
news is excluded as unverified exchange/issuer identity. Company financial
statements, earnings, macro and broader market trends are explicitly unavailable.
The model may reject insufficient context. This is not comprehensive fundamental
research.

## Entry, observation and supervised exit

Only after separate launch authorization, enable master writes for the agreed
window, restart the relevant service, and rerun the verifier with
`PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=enabled`. Keep scheduler disabled.
Invoke the existing authenticated signal loop once:

```sh
curl --fail-with-body -sS -X POST -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  http://127.0.0.1:3102/runtime/trading-loop/run-once
```

Record the cycle/proposal identifiers and AI outcome. Approval and submission
must follow the normal persisted proposal/risk/AI flow. Observe parent/SL/TP,
owned fills and reconciliation. Use the LOCAL `proposed_orders.id`, never an IB
broker order ID, for the lifecycle URLs. No second attempted entry is allowed.

Before the chosen exit deadline, stop invoking the producer and keep writes
available for the authorized risk-reducing workflow. If still open, inspect
`GET /execution/lifecycle/$PROPOSED_ORDER_ID`, obtain a fresh valid WSE SELL limit
from current BBO/market-rule metadata, and use the existing full-close endpoint
with one saved UUID request ID:

```sh
curl --fail-with-body -sS -X POST -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @close-request.json \
  "http://127.0.0.1:3103/execution/lifecycle/$PROPOSED_ORDER_ID/close"
```

`close-request.json` contains only `requestId` (saved UUID) and `limitPrice`
(verified finite positive PLN limit). Preview the concrete values before sending.
This workflow validates ownership/session/risk, confirms protective cancellations,
and sends at most one exact remaining close. Do not cancel protective legs
separately to create a naked position. HTTP 202 is not evidence of a fill.

Inspect `GET /execution/lifecycle/$PROPOSED_ORDER_ID/close`; when needed call its
`POST /close/reconcile` endpoint to observe existing broker outcome. It does not
send a replacement close. Unknown submission/cancellation, BLOCKED state, missing
coverage, session change, stale quotes or approaching session end require operator
review, never a fresh request ID or blind retry.

## Completion and accounting

Refresh reconciliation via the authorized existing
`POST /execution/reconciliation/run` and collect:

```sh
curl --fail-with-body -sS -H "Authorization: Bearer $EXECUTION_API_TOKEN" \
  "http://127.0.0.1:3103/execution/lifecycle/$PROPOSED_ORDER_ID/round-trip"
```

The response distinguishes `gpwWindowRunId` (durable trading window) from
`reconciliationRunId` (broker observation). The consumed proposal and attempt must
match the persisted window; the report remains collectable after window expiry.

`status=COMPLETED` proves the scoped one-share entry/exit, original approved AI/risk
identity, fresh current-session flat PKO position and absence of working PKO orders.
`completionScope=INSTRUMENT` binds completion to the report account/instrumentId/
conid. `outsideScope` reports other nonzero positions and working-order count,
with observation timestamps; COMPLETED does not assert that the whole account
is flat. Other-contract fills, realized P&L and commissions do not enter PKO P&L.
Missing/partial/stale/unrelated evidence yields `NOT_PROVEN`; a flat balance alone
is insufficient. The collector is GET-only and reads a consistent DB snapshot;
it does not request a broker refresh. Collect promptly after reconciliation.

`grossPnl` is labelled PLN. `commissionsByCurrency` retains original currencies;
missing fees produce `PENDING_FEES`, foreign fees `MIXED_CURRENCY`, and net PLN stays
null until all fees are explicitly available in PLN. A broker-reported zero P&L
is retained as zero; raw broker realized P&L is not used for unverified currency
conversion. Do not use legacy `/execution/trades` as acceptance P&L evidence.
A loss can pass mechanics; a single profit does not establish strategy profitability.

After authoritative PKO flat/no working PKO orders, disable master writes, leave scheduler
off and rerun the explicit disabled-write verifier. Save sanitized report, exact
commit/window timestamps, proposal IDs, AI coverage, fills, commissions and any
incomplete accounting. Mask account IDs; never publish tokens, raw .env or secrets.

## Emergency

Master `TRADING_ENABLED=false` blocks new writes but does not flatten positions.
It also blocks full-close and close-reconcile endpoints; normal planned exit must
happen before this switch is disabled. Broker protective orders remain broker-side.
Do not promise unattended flattening, bypass safeguards, automate the IBKR UI or
retry an unknown submission. Read current broker state/reconciliation and escalate
to the supervising operator. Any required re-enablement or further broker action
needs an explicit incident decision; do not mark the test complete with residual
PKO exposure, unresolved PKO orders or ambiguous account evidence. Known
other-contract positions/orders are reported separately and are not managed by
this procedure.
