# GPW disabled-write preflight — 2026-09-24

## Deployment fix

Independent plan and implementation reviews ACCEPT. Dockerfile now copies the
paper-verify-stack workspace manifest before frozen dependency installation.
The clean ab74890 source plus this one-line patch builds successfully (image
sha256:6f9b3c8b3421e2a7ae1890e1c6837085e817771da18dc84331ee37d6dace9973).
No strategy, risk guard, lockfile or default trading behavior changed.

All checks passed in that clean image: lint (three existing warnings, no errors),
typecheck, unit tests, build, and isolated PostgreSQL integration tests
(1059 execution +18 backtest +7 AI repository; zero integration failures/skips).
The Docker context contains no host node_modules or unrelated research edits.

## Operational observations (not launch approval)

Owner authorized preparing PKO with writes disabled. A protected local database
backup was taken before startup migrations. Ingestion, signal-engine and
execution-engine were started with the reviewed image; existing backtest service
was not restarted. Local configuration selects only pko_wse/conId35146360,
real-time data, no legacy watchlist, no candle-triggered producer, disabled trading
loop and disabled master writes. AI worker was not started; no broker orders or
paid model/news requests were sent. Telegram delivery was disabled in the local
deployment override. No trading window was armed.

Broker metadata confirms PKO BANK POLSKI SA, WSE, PLN, ISIN PLPKO0000016 and
current market-rule1874. The paper account ID was verified from managedAccounts
(letter O must not be transcribed as zero). Account snapshot at09:01:57UTC:
explicit PLN cash5811.0746, one unrelated position4172SMR, no working orders in
the reconciliation snapshot. No active PROPOSED/SUBMITTED local orders or holds.

Six native history timeframes reached required counts. At09:00UTC the newest
closed4h bar still started on the previous day at12:00UTC; count readiness is not
freshness/strategy readiness. Current bid/ask is unavailable: IBKR error10197,
No market data during competing live session. Cached old market state is not
acceptable quote evidence. The owner was asked to end the competing live session
and decide how to handle the unrelated SMR paper position; neither was modified.

Reconciliation is INCOMPLETE because the production ib@0.2.9 adapter explicitly
reports completedOrders unavailable/unsupported_by_ib_module. Supporting that
source in the actual adapter is a remaining implementation prerequisite for the
runbook's CLEAN/full-coverage gate. Do not weaken the gate or relabel unavailable
data as complete. The first verifier additionally observed disconnected sockets
and account timeout after the earlier successful broker reads; rerun after the
owner confirms Gateway/session recovery.

Preflight outcome: BLOCKED, not ready for an entry. Remaining requirements:
restore real-time quotes/session, resolve unrelated account exposure, implement
and independently validate completed-order reconciliation, verify fresh closed
history, rerun full preflight, and then agree and configure a supervised window.
