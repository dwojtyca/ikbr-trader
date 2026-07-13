# AGENTS.md

Instructions for AI coding agents (Copilot / Claude / Codex) working in this
repository. Read this before making changes.

# AI Trading Platform – Project Constitution

## Purpose

This repository contains an AI-assisted trading platform integrated with
Interactive Brokers (IBKR).

The long-term goal is **one codebase** that supports both Paper and Live
trading. The only intended behavioral difference between environments is
configuration and safety policy, not business logic.

---

## Project context

TypeScript monorepo (pnpm workspaces) for an IBKR trading bot.
**Do not redesign it from scratch.**

Apps (all run via Docker Compose, also runnable individually via
`pnpm dev:<name>`):

- `apps/ingestion` (port `3101`) — TWS/IB Gateway Socket API, market data
  subscriptions, 1m candle aggregation + higher-timeframe aggregation
  (5m, 1h, 4h, 1d, 1w), persistence to Postgres, Redis market-state cache,
  REST `POST /bootstrap`, progress endpoint.
- `apps/signal-engine` (port `3102`) — indicators, multi-timeframe
  `MarketRegimeDetector`, `StrategyPortfolioManager`, `RiskEngine`, persists
  `proposed_orders`. Strategy implementations live in
  `apps/signal-engine/src/strategies/`.
- `apps/execution-engine` (port `3103`) — TWS socket execution, bracket orders
  (parent + TP + SL), `/execution/orders`, `/execution/trades` (FIFO-matched
  entries+exits with realized P&L), `/execution/account/summary`,
  kill-switches.
- `apps/backtest-engine` (port `3104`) — separate Postgres DB
  `ikbr_trader_backtest`, historical fetch with token-bucket pacing +
  concurrency cap, strategy-lab worker, simulator.
- `apps/llm-agent` — autonomous EXECUTE/REJECT gate that polls `PROPOSED`
  orders, fetches news (Marketaux), calls OpenAI, and posts decisions to
  execution-engine.
- `apps/ui` (port `5173`, Vite + React) — operator dashboard: account summary,
  ingestion progress, signals, orders, trades, backtest controls.
- `packages/shared` — shared domain types and `strategy-profiles.ts`.

## Strategy registry

Implemented strategies are registered in
`apps/signal-engine/src/strategies/strategy-registry.ts`. Profiles (incl.
`enabledInBot` flag) are in `packages/shared/src/strategy-profiles.ts`.

Currently active in bot/backtest:

- `momentum_breakout_long_v1`
- `momentum_breakdown_short_v1`
- `gap_fade_short_v1`

Implemented but disabled:

- `range_reversal_v1`
- `trend_following_long_v1`

See [STRATEGIES.md](STRATEGIES.md) for the full per-strategy spec.

---

# Core Principles

1. Never rewrite an existing subsystem without strong justification.
2. Prefer extending the current architecture.
3. IBKR is the source of truth for:
   - positions
   - orders
   - executions
   - account state
4. Every execution must be auditable.
5. Every execution must pass the deterministic Risk Engine.
6. AI proposes decisions. The execution layer validates them.

## Core rules (implementation)

- Do not rewrite the whole project. Prefer incremental refactors.
- Keep `SignalEngine`, `backtest-engine`, `execution-engine`, and the
  `proposed_orders` schema compatible unless explicitly asked.
- Strategies must not execute orders directly. They emit `StrategySignal`s;
  routing/execution is the job of `signal-engine` → `execution-engine`.
- Broker integration (`ib@0.2.9`) must stay outside strategy code.
- Prefer TypeScript, clean architecture, testable modules. Use the Node.js
  native test runner (`pnpm test`).
- Do not add new strategies unless asked.
- Do not add error handling for cases that cannot happen. Validate at
  boundaries.
- Do not add docstrings/comments to code you didn't change.
- Use existing helpers; don't introduce new abstractions for one-time
  operations.

---

# Current Services

- apps/ingestion
- apps/signal-engine
- apps/execution-engine
- apps/llm-agent
- apps/backtest-engine
- apps/ui
- packages/shared

Do not merge responsibilities between these services without documenting the
architectural decision.

---

# Responsibilities

## ingestion

Responsible only for:

- IBKR connectivity for market data
- candle aggregation
- persistence
- publishing market events

Must NEVER submit orders.

## signal-engine

Responsible for:

- technical strategies
- indicator calculations
- signal generation

Must NEVER communicate directly with IBKR execution.

## execution-engine

Responsible for:

- create orders
- modify orders
- cancel orders
- close positions
- reconciliation
- order lifecycle

Must NEVER contain AI reasoning.

## llm-agent

Responsible for:

- market interpretation
- trade reasoning
- proposal generation

Must NEVER bypass Risk Engine.

---

# Target architecture

- strategy + symbol + direction + market regime
- separate `Strategy` interface (`strategy.types.ts`)
- separate `MarketRegimeDetector` (`signal-engine/src/regime/`)
- separate `RiskEngine` (`signal-engine/src/risk/`)
- separate `StrategyPortfolioManager` (`signal-engine/src/portfolio/`)
- legacy strategies should be wrapped/adapted, not deleted abruptly

# Source of Truth

Market Data:
    ingestion

Signals:
    signal-engine

Trade Decision:
    decision-engine (future)

Execution:
    execution-engine

Broker State:
    IBKR

---

# Paper vs Live

Business logic must remain identical.

Environment changes ONLY through configuration.

Required configuration:

- `IBKR_ENVIRONMENT` (`paper` | `live`) — the single source of truth for
  broker environment. Never inferred from `IB_SOCKET_PORT`.
- `ALLOWED_PAPER_ACCOUNTS` — CSV whitelist of paper account IDs.
- `ALLOWED_LIVE_ACCOUNTS` — CSV whitelist of live account IDs.
- `TRADING_ENABLED` (`true` | `false`) — master switch for write actions.
- `EXECUTION_API_TOKEN` — Bearer for all mutating execution-engine endpoints.
  Required (≥32 chars) when `IBKR_ENVIRONMENT=live` or `TRADING_ENABLED=true`.
  In Phase 1 the same token is used by every internal client
  (`llm-agent`, `signal-engine`, `ui`); per-client tokens require a
  multi-token server implementation and are deferred.

Never identify environment using only port numbers.

## IBKR / broker notes

- Paper account uses IB Gateway on `127.0.0.1:4002` (port `4001` for live,
  `7497/7496` for TWS paper/live).
- IBKR historical-data pacing is **60 requests / 10 min per account**, shared
  across all clientIds. Backtest fetch defaults:
  `BACKTEST_HISTORY_CONCURRENCY=2`, `BACKTEST_HISTORY_PACING_PER_10MIN=50`.
- Fractional shares: only mega-cap US stocks (MSFT, META, GOOGL, TSLA, AMZN,
  NVDA, QQQ, SPY). **Never** fractional for WSE/LSE/leveraged ETFs (cancel
  code 320).
- KID compliance: leveraged ETFs (TQQQ, SOXL) are blocked for EU retail
  without KID docs (cancel code 201).
- AMD/ARM/SOXL pre-market cancellations are expected without
  `outsideRTH=true`; we keep `outsideRTH` off for liquidity reasons.

---

# Default research mode

When asked to "research a strategy" without a tighter scope:

- max 5 symbols
- long only
- daily candles first
- one strategy at a time
- simple risk management (no portfolio-level optimization yet)

---

# Development Workflow

For every implementation:

1. Read AGENTS.md.
2. Read `docs/implementation/ROADMAP.md`.
3. Find first unfinished phase.
4. Create `docs/implementation/PHASE_X_PLAN.md`.
5. Wait for approval.
6. Implement only that phase.
7. Run:
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
   - the relevant backtest command if behavior-affecting
8. Perform hostile review.
9. Create `docs/implementation/PHASE_X_REPORT.md`.
10. Stop.

Note: ESLint is not required in Phase 1 (introduced in a later phase).

---

# Safety Rules

Never:

- bypass proposal flow
- bypass risk engine
- retry unknown submissions
- treat timeout as cancellation
- reverse a position during close
- submit directly to live accounts
- automate IBKR UI

---

# Definition of Done

A phase is complete only if:

- acceptance criteria pass
- tests pass
- build passes
- documentation updated
- hostile review completed

---

# Operational notes

- Live DB: `docker compose exec -T postgres psql -U postgres -d ikbr_trader`
- Backtest DB:
  `docker compose exec -T postgres psql -U postgres -d ikbr_trader_backtest`
- Restarting a single app: `docker compose up -d --build <service>`
  (e.g. `ui`, `signal-engine`).
- Secrets (OpenAI, Marketaux, Telegram, `EXECUTION_API_TOKEN`) live in `.env`
  only. Never write them into committed code, tests, or markdown.

---

# Long-term Vision

Transform the current bot into a modular AI Trading Platform with:

- Market Context Engine
- Decision Engine
- Portfolio Manager
- Strategy Framework
- Autonomous Paper Trading
- Live Trading Readiness
