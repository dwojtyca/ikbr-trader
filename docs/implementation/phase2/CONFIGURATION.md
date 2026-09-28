# Current runtime configuration

Reviewed 2026-09-26. This page describes settings implemented in the audited code.
The [proposed independent strategy/instrument format](../../architecture/STRATEGY_INSTRUMENT_CONFIGURATION.md)
is not loadable yet. [Current state](../CURRENT_STATE.md) records support limits.

## Authoritative sources and flags

| Purpose | Current setting / source | Meaning |
| --- | --- | --- |
| Environment | IBKR_ENVIRONMENT | Explicit paper/live identity; never inferred from socket port |
| Accounts | ALLOWED_PAPER_ACCOUNTS / ALLOWED_LIVE_ACCOUNTS | Allowlisted actual broker account, kept private |
| Broker writes | TRADING_ENABLED | Master gate; full close currently requires true; false does not flatten or cancel protection |
| Auth | EXECUTION_API_TOKEN | Shared current internal bearer, required length/activation checks; never a browser bundle value |
| Runtime | RUNTIME_ENABLED, default true | Registers data runtime |
| Entry runtime | EXECUTION_RUNTIME_ENABLED, default false | Registers entry runtime and trading-loop routes |
| Scheduler | TRADING_LOOP_ENABLED, default false | Starts periodic entry evaluation; false does not imply data/strategy readiness |
| Cadence | TRADING_LOOP_INTERVAL_MS, default30000, minimum5000 | Entry loop frequency |
| Scope | TRADING_LOOP_INSTRUMENT_IDS | Registry ID allowlist; does not define instruments or subscriptions |
| Binding | INSTRUMENT_BINDINGS_JSON | Exact existing registry instrument to broker contract binding, validated independently by consumers |
| Legacy watchlist | WATCHLIST_SYMBOLS / WATCHLIST_CONTRACT_OVERRIDES | Additional legacy data scope; explicitly empty for current exclusive bound test |
| Test profiles | GPW_PROFILE_ENABLED / AAPL_PROFILE_ENABLED | Mutually exclusive Paper stock opt-ins, not a general instrument configuration loader |
| Momentum variant | GPW_MOMENTUM_PROFILE | default / pko_mild_v1 / pko_moderate_v1, with explicit PKO opt-in rules |
| Broker windows | GPW_RUN_* / AAPL_RUN_* | Current separate bounded one-attempt profiles, defined in their runbooks |
| Reconciliation | RECONCILIATION_* / EXECUTION_READY_RECONCILIATION_MAX_AGE_S | Coverage cadence and freshness; consult schema, not old line-number references |

Source: [signal config](../../../apps/signal-engine/src/config.ts),
[loop config](../../../apps/signal-engine/src/runtime/trading-loop/config.ts),
[execution config](../../../apps/execution-engine/src/config.ts),
[ingestion config](../../../apps/ingestion/src/config.ts),
[AI config](../../../apps/llm-agent/src/config.ts),
[configured registry](../../../packages/shared/src/instruments/configured-registry.ts).

## Current execution shape

Bound entries require immutable clientOrderId/clientOrderHash in the body,
instrument identity, persisted proposal/AI review and fresh risk. A binding does
not grant execution. Current scope is one whole long stock share, LMT bracket,
USD or WSE/PLN with supported account evidence. Direct unpersisted tickets are
refused by the production HTTP route. No Idempotency-Key header or separate
execution_tickets table is introduced by these docs.

Use the current [PKO](../../runbooks/GPW_PAPER_ROUND_TRIP.md) or
[AAPL](../../runbooks/AAPL_PAPER_ROUND_TRIP.md) runbook only after authorized scope
and live preflight. Do not combine both opt-ins; PP1–PP3 remove that restriction.

## Target migration

PP1 introduces a read-only versioned bundle with strategyInstances and instruments.
PP2 resolves parameterized factories and assignment-aware evaluation. PP3 generalizes
windows/budgets. Until delivered, no invented CONFIG_PATH/strategy JSON setting is
accepted. Old ORCH_*, EXECUTION_TICKET_ENDPOINT_PATH, EXECUTION_IDEMPOTENCY_HEADER
and LIVE_STARTUP_DRY_READ names in early drafts are not runtime configuration.
