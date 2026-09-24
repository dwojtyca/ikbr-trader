# PKO parameter profiles and durable readiness — 2026-09-24

## Implemented

The [accepted plan](GPW_PKO_PROFILE_PLAN.md) adds two explicit PKO-only parameter
profiles of the existing momentum strategy. `default` remains unchanged. Only
three momentum thresholds differ; trend, RSI, breakout, volume, protective levels,
Risk Engine, AI review and execution controls retain their existing behavior.
The registry and production context loader enforce the opt-in instrument identity.

A read-only offline replay command uses the real context loader, indicators,
regime and portfolio evaluator, excluding unfinished higher-timeframe candles.
It validates and hashes a frozen input, reports rejection reasons per session,
and checks coverage before chronological development/holdout selection. It keeps
default if it qualifies, otherwise considers mild before moderate.

`/ready` now reads freshness and reconciliation health from the same latest durable
record. It rejects invalid/future timestamps, repository failures, account changes
and broker reconnects; it cannot borrow freshness from an older CLEAN record.

Independent plan and implementation reviewers accepted the scope and amendments.
The full suite exposed an existing close-test fixture's host/DB clock ordering
assumption. Its position timestamps now use a preceding PostgreSQL clock reading
instead of a 3 ms sleep. This is a test-only correction; production guards remain
unchanged. Two initial failures named the corresponding generation gate; this is
not proof that every initial failure had that sole cause.

## Frozen historical comparison

Command: `pnpm --filter @ikbr/signal-engine gpw:profile-replay <private-export.json>`.
Dataset SHA-256: `d774911688ceef5a62c639fcfe6fe8a31a8910147cdf665e5f70b34bdf447a3b`.
Export cutoff: 2026-09-24 12:26:03 UTC. Native candle counts:
1m=435, 5m=100, 1h=63, 4h=61, 1d=60, 1w=60.
The 1m range is 2026-09-23 13:15 through 2026-09-24 12:24 UTC.

There are 86 eligible contexts; 219 points lack the required 1m warmup and 130
have stale 4h context. All eligible observations belong to September 24.

| Profile | Signals | Rejections across all 86 eligible points |
| --- | ---: | --- |
| default | 0 | daily momentum too weak: 86 |
| pko_mild_v1 | 0 | hourly momentum too weak: 86 |
| pko_moderate_v1 | 0 | below EMA50: 42; RSI not rising: 22; below EMA200: 7; EMA20 not above EMA50: 6; no confirmed breakout: 5; intraday momentum too weak: 4 |

The fixed 13:15–16:30 Warsaw selection interval has zero eligible points on
September 23 and 71 on the still-current September 24. Neither date qualifies;
there are no development or holdout sessions. Within the 71-point interval,
default and mild each reject all 71 points on their respective momentum gate;
moderate rejects 35 below EMA50, 16 RSI, 7 below EMA200, 6 EMA alignment,
4 intraday momentum and 3 breakout. Every profile has zero interval signals.

Result: **INSUFFICIENT_EVIDENCE**, no selected candidate. Keep `default` and trading
disabled. Four adequately covered completed sessions, with prior warmup, are
required before candidate selection. This replay measures signal observations,
not fills, transaction costs or profitability; it cannot establish a successful
broker entry/exit. No thresholds were further adjusted to force a signal.

## Validation and delivery

Final check results and disabled deployment observations are recorded below.
No account identifiers, balances, position quantities, broker order identifiers
or private provider evidence are included in this report.

Final clean-copy gates: lint PASS (three pre-existing warnings), typecheck PASS,
`pnpm test`: 2,123 passed, 18 integration tests skipped without a DB;
`pnpm test:integration`: 1,226 passed, none skipped; build PASS.
The close fixture's 53 cases are included in the passing PostgreSQL run.
Frozen replay completed successfully and was independently checked.
Final Docker image digest:
`sha256:0a928814f3753469ed6285f37dabaa875a008547873da875eb1b13882a3f840a`.
All 29 unrelated research-file hashes and the local environment file are unchanged.
Commit CI and post-deployment checks remain pending at this report revision.
