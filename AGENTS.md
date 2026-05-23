# AGENTS.md

Instructions for AI coding agents (Copilot / Claude / Codex) working in this repository. Read this before making changes.

## Project context

TypeScript monorepo (pnpm workspaces) for an IBKR trading bot. **Do not redesign it from scratch.**

Apps (all run via Docker Compose, also runnable individually via `pnpm dev:<name>`):

- `apps/ingestion` (port `3101`) — TWS/IB Gateway Socket API, market data subscriptions, 1m candle aggregation + higher-timeframe aggregation (5m, 1h, 4h, 1d, 1w), persistence to Postgres, Redis market-state cache, REST `POST /bootstrap`, progress endpoint.
- `apps/signal-engine` (port `3102`) — indicators, multi-timeframe `MarketRegimeDetector`, `StrategyPortfolioManager`, `RiskEngine`, persists `proposed_orders`. Strategy implementations live in `apps/signal-engine/src/strategies/`.
- `apps/execution-engine` (port `3103`) — TWS socket execution, bracket orders (parent + TP + SL), `/execution/orders`, `/execution/trades` (FIFO-matched entries+exits with realized P&L), `/execution/account/summary`, kill-switches.
- `apps/backtest-engine` (port `3104`) — separate Postgres DB `ikbr_trader_backtest`, historical fetch with token-bucket pacing + concurrency cap, strategy-lab worker, simulator.
- `apps/llm-agent` — autonomous EXECUTE/REJECT gate that polls `PROPOSED` orders, fetches news (Marketaux), calls OpenAI, and posts decisions to execution-engine.
- `apps/ui` (port `5173`, Vite + React) — operator dashboard: account summary, ingestion progress, signals, orders, trades, backtest controls.
- `packages/shared` — shared domain types and `strategy-profiles.ts`.

## Strategy registry

Implemented strategies are registered in `apps/signal-engine/src/strategies/strategy-registry.ts`. Profiles (incl. `enabledInBot` flag) are in `packages/shared/src/strategy-profiles.ts`.

Currently active in bot/backtest:

- `momentum_breakout_long_v1`
- `momentum_breakdown_short_v1`
- `gap_fade_short_v1`

Implemented but disabled:

- `range_reversal_v1`
- `trend_following_long_v1`

See [STRATEGIES.md](STRATEGIES.md) for the full per-strategy spec.

## Core rules

- Do not rewrite the whole project. Prefer incremental refactors.
- Keep `SignalEngine`, `backtest-engine`, `execution-engine`, and the `proposed_orders` schema compatible unless explicitly asked.
- Strategies must not execute orders directly. They emit `StrategySignal`s; routing/execution is the job of `signal-engine` → `execution-engine`.
- Broker integration (`ib@0.2.9`) must stay outside strategy code.
- Prefer TypeScript, clean architecture, testable modules. Use the Node.js native test runner (`pnpm test`).
- Do not add new strategies unless asked.
- Do not add error handling for cases that cannot happen. Validate at boundaries.
- Do not add docstrings/comments to code you didn't change.
- Use existing helpers; don't introduce new abstractions for one-time operations.

## Target architecture

- strategy + symbol + direction + market regime
- separate `Strategy` interface (`strategy.types.ts`)
- separate `MarketRegimeDetector` (`signal-engine/src/regime/`)
- separate `RiskEngine` (`signal-engine/src/risk/`)
- separate `StrategyPortfolioManager` (`signal-engine/src/portfolio/`)
- legacy strategies should be wrapped/adapted, not deleted abruptly

## IBKR / broker notes

- Paper account uses IB Gateway on `127.0.0.1:4002` (port `4001` for live, `7497/7496` for TWS paper/live).
- IBKR historical-data pacing is **60 requests / 10 min per account**, shared across all clientIds. Backtest fetch defaults: `BACKTEST_HISTORY_CONCURRENCY=2`, `BACKTEST_HISTORY_PACING_PER_10MIN=50`.
- Fractional shares: only mega-cap US stocks (MSFT, META, GOOGL, TSLA, AMZN, NVDA, QQQ, SPY). **Never** fractional for WSE/LSE/leveraged ETFs (cancel code 320).
- KID compliance: leveraged ETFs (TQQQ, SOXL) are blocked for EU retail without KID docs (cancel code 201).
- AMD/ARM/SOXL pre-market cancellations are expected without `outsideRTH=true`; we keep `outsideRTH` off for liquidity reasons.

## Default research mode

When asked to "research a strategy" without a tighter scope:

- max 5 symbols
- long only
- daily candles first
- one strategy at a time
- simple risk management (no portfolio-level optimization yet)

## Verification before finishing

Before declaring a change done, run or suggest:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- the relevant backtest command if behavior-affecting

## Operational notes

- Live DB: `docker compose exec -T postgres psql -U postgres -d ikbr_trader`
- Backtest DB: `docker compose exec -T postgres psql -U postgres -d ikbr_trader_backtest`
- Restarting a single app: `docker compose up -d --build <service>` (e.g. `ui`, `signal-engine`).
- Secrets (OpenAI, Marketaux, Telegram) live in `.env` only. Never write them into committed code, tests, or markdown.
