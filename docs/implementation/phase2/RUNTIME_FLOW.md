# Current bound runtime flow

Reviewed 2026-09-26. [Capability limits](../CURRENT_STATE.md).
The production path uses existing services; there is no separate orchestrator app.

## Entry sequence

1. Ingestion resolves exact bound contracts, obtains broker schedules and native
   closed candles, subscribes to market data, persists history and updates Redis.
2. Signal runtime verifies binding, exposure/reconciliation and session/history
   readiness. It resolves enabled strategies, loads technical context and evaluates
   the portfolio. Strategy attribution/direction must agree with instrument policy.
3. The shared deterministic decision/risk/ticket pipeline produces an attributed
   intent. The current market-context builder registers only price; technical
   strategy context comes through the dedicated context loader.
4. Authenticated execution ticket handoff validates identity/hash and persists the
   proposal plus pending AI review. It cannot bypass the mandatory review.
5. llm-agent claims the review, builds available technical/order/account/news
   evidence, calls the configured model and stores EXECUTE/REJECT under the claim.
   Missing configured sources or invalid output reject; company reports are not
   currently fetched. Delivery marker is persisted before one execution request.
6. Execution validates persisted approval, immutable identity, current policy/run
   window and fresh deterministic risk. A durable broker plan/reservation precedes
   dispatch. Unknown outcomes remain unresolved until broker evidence proves state.
7. Broker events and reconciliation update orders/fills/ownership. Entry response,
   AI approval and HTTP2xx are not proof of broker fill or complete protection.

## Ownership

| Service/module | Owns | Boundary |
| --- | --- | --- |
| Ingestion | Quote/history/session evidence | Never submits orders |
| Signal app | Strategy/regime/portfolio evaluation and ticket handoff | No broker write or AI execution reasoning |
| Shared pipeline | Deterministic decision/risk/ticket composition | No broker/network/persistence |
| llm-agent | Persisted entry adjudication and one-shot delivery request | No bypass of risk, identity or proposal flow |
| Execution | Broker submission, audit, reconciliation, ownership and supported close | No LLM reasoning |
| Backtest | Isolated simulation/research | Not evidence of real broker acceptance |
| UI | Operator reads/actions through APIs | Never a second execution path |

## Exits

SL/TP can execute at the broker. An owner-requested supported full close uses
original ownership, current quantity, deterministic close risk and cancellation
confirmation, then a bounded SELL limit. It does not need new entry AI approval.
Current close completion requires explicit reconciliation observation; background
close supervision is planned in PP5. An unfilled close after protective cancellation
requires attention and is not safe unattended completion.

## Current versus target selection

Today enabled algorithm candidates are evaluated before the winner is matched to
instrument strategy policy. PP2 replaces this with explicitly assigned named
strategy instances and separate parameters/state. See
[configuration contract](../../architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md).
The legacy /signals/run-once and /signals/on-candle routes return503; use the
supported authenticated bound runtime, not the existing stale UI action.

Implementation entry points: [trading loop](../../../apps/signal-engine/src/runtime/trading-loop/trading-loop-service.ts),
[AI worker](../../../apps/llm-agent/src/bound-review-worker.ts),
[submission service](../../../apps/execution-engine/src/reconciliation/submission-service.ts).
