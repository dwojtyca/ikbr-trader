# ikbr-trader

Auto-trading platform for Interactive Brokers (IBKR), built as a TypeScript monorepo. It ingests live market data from IB Gateway, runs a multi-strategy signal engine with market-regime detection, gates orders through an LLM agent (OpenAI + news context), executes bracket orders on TWS, and ships with a separate backtest engine and a React operator UI.

> ⚠️ **Not financial advice.** This is a personal trading research project. Run it on a **paper** account first. The author accepts no responsibility for losses.

---

## What is this project?

A self-hosted, modular trading system that:

- streams market data from IB Gateway, persists 1m candles + higher-timeframe aggregates (5m, 1h, 4h, 1d, 1w);
- runs multi-timeframe **market-regime detection** (`bull_trend` / `bear_trend` / `range` × volatility);
- generates `proposed_orders` from a portfolio of pluggable strategies (momentum breakout/breakdown, gap fade, range reversal, trend following — see [STRATEGIES.md](STRATEGIES.md));
- optionally asks an **LLM agent** (OpenAI) with news context (Marketaux) to `EXECUTE` or `REJECT` each proposed order;
- sends bracket orders (parent + take-profit + stop-loss) through TWS;
- runs a **separate backtest engine** against an isolated Postgres DB with historical IB data;
- exposes everything in a **React UI** at `http://localhost:5173`.

Architecture and conventions for AI coding agents: [AGENTS.md](AGENTS.md).
Strategy specifications: [STRATEGIES.md](STRATEGIES.md).

### Services

| App                     | Port | Role                                                                     |
| ----------------------- | ---- | ------------------------------------------------------------------------ |
| `apps/ingestion`        | 3101 | TWS socket, market data, candle aggregation, persistence                 |
| `apps/signal-engine`    | 3102 | Indicators, regime detection, strategies, risk engine, `proposed_orders` |
| `apps/execution-engine` | 3103 | TWS execution, bracket orders, account summary, trades view              |
| `apps/backtest-engine`  | 3104 | Historical fetch + simulator + strategy lab                              |
| `apps/llm-agent`        | —    | OpenAI + Marketaux EXECUTE/REJECT gate                                   |
| `apps/ui`               | 5173 | Operator dashboard (Vite + React)                                        |
| `postgres`              | 5432 | Live DB `ikbr_trader` + backtest DB `ikbr_trader_backtest`               |
| `redis`                 | 6379 | Market-state cache                                                       |

---

## Prerequisites

You will need:

1. **An Interactive Brokers account** (paper is enough to start). Sign up at <https://www.interactivebrokers.com/>.
   - IBKR is currently the only broker with a free, well-documented Socket API and global market access (US, LSE, WSE, etc.). Alternatives like Alpaca are US-only and don't expose the same instruments.
   - Use the **paper trading** account first (`Settings → Paper Trading Account`). All defaults in this repo target the paper account.
   - Costs: paper trading is **free**. Live trading on IBKR Lite has $0 US-stock commissions; the system itself adds no fees.
2. **IB Gateway** (lightweight, headless TWS) from <https://www.interactivebrokers.com/en/trading/ibgateway-stable.php>.
   - Use IB Gateway, not full TWS, for stability on a server.
   - Paper port: `4002`. Live port: `4001`.
3. **Docker Desktop** (or any Docker + Compose v2 setup).
4. **Node.js 20+** and **pnpm 9+** if you want to run apps natively for development.
5. _(Optional)_ an **OpenAI API key** if you want the LLM execution gate active. Without it, set `LLM_AGENT_ENABLED=false`.
6. _(Optional)_ a **Marketaux API key** (<https://www.marketaux.com/>) for the LLM agent's news context. Free tier is enough for low polling rates.
7. _(Optional)_ a **Telegram bot token + chat id** for alerts.

---

## IB Gateway setup

1. Install and log in to IB Gateway with your **paper** credentials.
2. `Configure → Settings → API → Settings`:
   - ✅ `Enable ActiveX and Socket Clients`
   - ❌ Uncheck `Read-Only API`
   - ❌ Uncheck `Allow connections from localhost only` (needed when ikbr-trader runs in Docker)
   - Add `127.0.0.1` (and your Docker host IP if relevant) to `Trusted IPs`
   - Confirm the socket port matches your `.env`:
     - paper: `4002`
     - live: `4001`
3. Make sure the Gateway is running **before** you start the Docker stack — `apps/ingestion` and `apps/execution-engine` connect to TWS at startup.

For market-data subscriptions: paper accounts can read delayed data for free (`IB_MARKET_DATA_TYPE=3`). For live data on US stocks you'll need to subscribe to the relevant market-data packages inside IBKR Client Portal.

---

## Quick start (Docker, recommended)

```bash
# 1. clone + enter
git clone <repo-url> ikbr-trader
cd ikbr-trader

# 2. configure env
cp .env.example .env
# edit .env: at minimum set WATCHLIST_SYMBOLS, IB_SOCKET_PORT,
# and (optional) LLM_AGENT_OPENAI_API_KEY / LLM_AGENT_MARKETAUX_API_KEY

# 3. start IB Gateway on the host and log in (paper)

# 4. bring the stack up
docker compose up -d --build

# 5. bootstrap ingestion and execution (resolves contracts, backfills candles)
curl -X POST http://localhost:3101/bootstrap
curl -X POST http://localhost:3103/execution/bootstrap

# 6. open the UI
open http://localhost:5173
```

The UI shows account summary, ingestion progress, live signals, proposed/active orders, FIFO-matched trades with realized P&L, and backtest controls.

To stop everything: `docker compose down`. Data persists in the `pgdata` volume.

---

## Local development (apps natively, infra in Docker)

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
# in separate shells (or via `pnpm -r dev` if you wire it up):
pnpm dev:ingestion
pnpm dev:signal
pnpm dev:execution
pnpm dev:llm
pnpm dev:backtest
pnpm dev:ui
```

Note: when apps run natively, `IB_SOCKET_HOST=127.0.0.1` is correct. When they run inside Docker, the compose file rewrites `IB_SOCKET_HOST=host.docker.internal` so containers can reach the Gateway on the host.

---

## Configuration

All configuration is via environment variables. See [.env.example](.env.example) for the full list with comments.

Key things to set the first time:

- `WATCHLIST_SYMBOLS` — comma-separated tickers. Use IBKR's exact symbol (e.g. `MSFT`, `CSPX`, `PZU`).
- `WATCHLIST_CONTRACT_OVERRIDES` — optional `conid` / `exchange` / `currency` hints for symbols that don't resolve uniquely on SMART (most non-US tickers).
- `IB_SOCKET_PORT` — `4002` paper, `4001` live.
- `IB_MARKET_DATA_TYPE` — `1` live, `3` delayed (use `3` if you don't have live data subscriptions).
- `SIGNAL_MAX_RISK_PER_TRADE_PCT`, `SIGNAL_MAX_EXPOSURE_PCT`, `MAX_NOTIONAL_PER_TRADE_PCT`, `SIGNAL_MAX_OPEN_POSITIONS` — risk caps.
- `SIGNAL_FRACTIONAL_SYMBOLS` — only IBKR-fractional-eligible US mega-caps. Don't add WSE/LSE or leveraged ETFs.
- `LLM_AGENT_ENABLED` — set to `false` if you don't have an OpenAI key.

---

## Useful endpoints

```bash
# ingestion
curl http://localhost:3101/ingestion/progress
curl -X POST http://localhost:3101/bootstrap

# signal-engine
curl -X POST http://localhost:3102/signals/run-once
curl http://localhost:3102/signals/recent?limit=50

# execution-engine
curl http://localhost:3103/execution/account/summary
curl http://localhost:3103/execution/orders?limit=50
curl http://localhost:3103/execution/trades?limit=50

# backtest-engine
curl http://localhost:3104/backtest/dataset
```

---

## Running tests / typecheck

```bash
pnpm typecheck
pnpm test
pnpm build
```

Tests use the Node.js native test runner (`node --test`). No Jest.

---

## Project layout

```text
apps/
  ingestion/        # TWS socket, market data, candle aggregation
  signal-engine/    # indicators, regime detection, strategies, risk
  execution-engine/ # TWS execution, bracket orders, trades view
  backtest-engine/  # historical fetch + simulator + strategy lab
  llm-agent/        # OpenAI EXECUTE/REJECT gate
  ui/               # React operator dashboard
packages/
  shared/           # shared domain types, strategy-profiles
infra/sql/          # schema migrations
docker-compose.yml
```

---

## Further reading

- [STRATEGIES.md](STRATEGIES.md) — per-strategy specs (entries, stops, TPs, scoring, market-context filters).
- [AGENTS.md](AGENTS.md) — conventions for AI coding agents working on this repo.

---

## License & disclaimer

Personal project, no warranty. Trading involves substantial risk of loss. Test on paper accounts before risking real capital.
