# AGENTS.md

## Project context

This is an existing TypeScript monorepo for an IBKR trading bot. Do not redesign it from scratch.

Main modules:

- apps/ingestion: market data ingestion
- apps/signal-engine: signal generation and strategies
- apps/execution-engine: order execution
- apps/backtest-engine: backtesting
- packages/shared: shared types and config

## Core rules

- Do not rewrite the whole project.
- Prefer incremental refactors.
- Keep `SignalEngine`, backtest, execution-engine and `proposed_orders` compatible unless explicitly asked.
- Strategies must not execute orders directly.
- Broker integration must stay outside strategy code.
- Prefer TypeScript, clean architecture, testable modules.
- Do not add new strategies unless asked.
- Default research mode:
  - max 5 symbols
  - long only
  - daily candles first
  - one strategy at a time
  - simple risk management

## Trading system direction

Target architecture:

- strategy + symbol + direction + market regime
- separate Strategy Interface
- separate MarketRegimeDetector
- separate RiskEngine
- separate StrategyPortfolioManager
- legacy strategies should be wrapped/adapted, not deleted immediately

## Verification

Before finishing, run or suggest:

- pnpm typecheck
- pnpm test
- pnpm build
- relevant backtest command
