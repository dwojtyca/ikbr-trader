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
`pnpm test`: 2,127 passed, 18 integration tests skipped without a DB;
`pnpm test:integration`: 1,230 passed, none skipped; build PASS.
The close fixture's 53 cases are included in the passing PostgreSQL run.
Frozen replay completed successfully and was independently checked.
Final Docker image digest:
`sha256:d029337600e7b8f34ce9f353139a6b09658f5672e3104ed7525f58ad58b20ee6`.
All 29 unrelated research-file hashes and the local environment file are unchanged.
Delivery results are recorded below.


Pre-deployment review also caught a global-readiness regression for recovery-only
incompleteness. The helper now retains valid same-row freshness and the unchanged
`incomplete_recovery` classification; existing per-instrument submission gates
remain authoritative. Fresh recovery-only evidence passes global readiness;
stale/future evidence and incomplete exposure fail. The plan clarification and
implementation were independently accepted; the counts above include the full
repeat after this fix. The initial feature commit f99d8cb passed
[GitHub CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/36001295087).
The policy correction 5a01ab84cc0db8991d2766be8fbe587019810e39 passed
[GitHub CI](https://github.com/dwojtyca/ikbr-trader/actions/runs/36001881202).

## Disabled deployment verification

Execution and signal services run image `ikbr-trader-gpw:5a01ab8` with the digest
above. The environment file is unchanged: Paper, default profile, trading writes
disabled and trading scheduler disabled. Other service images were not updated.

The read-only stack verifier reports HEALTHY: 12 healthy checks, 2 intentionally
disabled trading-loop checks, no degraded/unhealthy/unreachable/config errors.
`/ready` returns HTTP 200. Its timestamp exactly matches the latest durable CLEAN
completion at 12:55:56.333 UTC, advances to 12:56:21.859 after an explicit capture,
and then to 12:56:43.964 on the periodic scheduler. Container start time stayed
unchanged. The last observation used GET only, with no manual capture or restart.

This operational observation proves timestamp advancement, not a 15-minute soak.
Controlled-clock tests separately cover stale evidence beyond 900 seconds and the
exact freshness boundary. Together they validate the planned bounded alternative.
No trading loop was activated and no entry test was forced by this deployment.
The historical selection remains INSUFFICIENT_EVIDENCE; the next evidence step is
to obtain adequately covered completed sessions and repeat the frozen comparison.
