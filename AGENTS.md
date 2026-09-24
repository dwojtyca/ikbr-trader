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
  kill-switches, durable proposal/AI/risk checks, reconciliation and an audited
  full-close lifecycle for the supported one-share stock scope.
- `apps/backtest-engine` (port `3104`) — separate Postgres DB
  `ikbr_trader_backtest`, historical fetch with token-bucket pacing +
  concurrency cap, strategy-lab worker, simulator.
- `apps/llm-agent` — mandatory EXECUTE/REJECT entry gate for bound proposals;
  claims persisted AI reviews, fetches news (Marketaux), calls OpenAI and delivers
  decisions to execution-engine. Provider configuration alone does not prove
  complete research coverage or model availability.
- `apps/ui` (port `5173`, Vite + React) — operator dashboard: account summary,
  ingestion progress, signals, orders, trades, backtest controls.
- `packages/shared` — shared domain types and `strategy-profiles.ts`.
- `tools/paper-verify-stack` — read-only infrastructure/preflight verifier.

## Current delivery priority

Prove a supervised Paper entry and exit on **one PKO share** before tuning
strategies or enabling unattended trading. The PKO profile uses `pko_wse`, WSE,
PLN and `momentum_breakout_long_v1`, with explicit configuration opt-in, a bounded
entry window and a durable one-entry-attempt-per-account/day budget.

Read [the GPW runbook](docs/runbooks/GPW_PAPER_ROUND_TRIP.md) before operational
work. [The 2026-09-24 preflight report](docs/implementation/phase3/GPW_PREFLIGHT_DOCKER_REPORT.md)
records observed blockers; recheck them against current IBKR evidence. Passing
tests, `/ready` or history counts alone does not prove launch readiness. In
particular, the preflight found unavailable completed-order coverage in the
production reconciliation adapter, competing-session quote failures and unrelated
account exposure. The [instrument-scoped acceptance plan](docs/implementation/phase3/GPW_INSTRUMENT_SCOPE_PLAN.md)
allows known other-contract positions/orders to remain; account-wide risk,
reconciliation and identity checks still apply. This does not resolve missing
completed-order coverage or unavailable quotes.

## Strategy registry

Implemented strategies are registered in
`apps/signal-engine/src/strategies/strategy-registry.ts`. Profiles (incl.
`enabledInBot` flag) are in `packages/shared/src/strategy-profiles.ts`.

Use those files as the source of truth rather than a duplicated activation list.
`enabledInBot` is not permission to trade: instrument configuration, bindings,
loop allowlist, risk/AI checks and environment controls also apply. The configured
GPW profile is in `packages/shared/src/instruments/configured-registry.ts`.
See [STRATEGIES.md](STRATEGIES.md) for strategy specifications.

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
- Broker integration must stay outside strategy code. The existing execution
  and ingestion sockets use `ib`; WSE metadata uses `@stoqey/ib`. Check the
  installed versions and actual adapter capabilities before assuming API support.
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

Must NEVER submit directly to IBKR. It may call the execution-engine API through
the supported proposal/runtime flow.

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
    llm-agent entry adjudication, validated by execution-engine
    (a separate decision-engine remains a future architecture goal)

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
- `TRADING_ENABLED` (`true` | `false`) — master switch for guarded write actions.
  The explicit cancel/reconciliation exemptions retain auth/account guards;
  full-close currently requires writes enabled. Switching it off does not close
  positions or cancel broker-side protective orders.
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

Work directly on `main`, as requested by the owner. Do not create a branch or
GitHub PR unless asked. Preserve unrelated local work; stage only the reviewed
scope, never use blanket staging in a dirty tree.

For every implementation changing repository code or versioned configuration:

1. Read this file, `docs/implementation/ROADMAP.md` and the relevant current
   delivery documents. Follow the owner's selected next stage; do not restart
   an unrelated unfinished roadmap phase.
2. Create a detailed bounded plan in the relevant `docs/implementation/phase*/`
   directory, with acceptance criteria and validation.
3. Have an independent agent review the plan. Fix it until the reviewer accepts.
   The owner's existing instruction to implement plus this acceptance is enough
   to proceed; do not request the same approval again.
4. Implement that scope. Material scope changes require an updated plan/review.
5. Have a different independent agent review the implementation against the plan,
   including completeness and hostile failure cases. Fix findings until accepted.
6. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` against
   isolated PostgreSQL, and `pnpm build`. Run relevant backtests for strategy or
   simulator behavior changes. Deployment changes also require a clean Docker
   build. Do not use the operational database for destructive test fixtures.
7. Write the implementation report, commit and push on `main`, and verify GitHub
   CI for that exact commit. Do not call the work complete while checks fail or
   CI is unverified; report access limitations explicitly.

Documentation-only changes still receive independent plan and document reviews;
validate facts, links and the staged diff locally. Do not add tests or rerun
unchanged runtime suites just for prose. Commit/push and verify CI normally.
Read-only operational diagnostics and applying existing runbook settings during
an authorized deployment do not require a new code implementation plan.

## Operational authorization and capability

- Carry forward explicit owner authorization within its scope. Read-only checks
  and an authorized disabled-write deployment/preflight do not require repeated
  confirmation. Do not infer trading activation from a request to implement code
  or check readiness. Activate only within the owner's authorized Paper scope,
  after the operational gates pass. Keep paid provider calls within that scope.
- An owner-requested close is a risk-reducing operation, not a new strategy entry.
  It does not need a fabricated entry signal or new entry AI approval. Use the
  supported audited close workflow, its original ownership evidence, deterministic
  close-risk checks, current broker quantity and idempotency controls.
- Distinguish authorization from implementation support. A request to close an
  old position does not add missing legacy-position ownership or quantity support.
  State the exact unsupported capability and use an authorized implementation
  extension or owner-operated IBKR action. Do not substitute an ad hoc broker
  submission that bypasses proposal/risk/audit controls.
- Deleting local rows is never evidence that an IBKR position is closed. After a
  manual close, confirm broker position, outstanding orders and reconciliation.
- If blocked, identify the actual code limitation or quote the applicable rule.
  Do not present project instructions as an external platform prohibition.

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
