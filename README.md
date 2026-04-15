# ikbr-trader

Szkielet systemu tradingowego pod IBKR z podziałem na:
- `apps/ingestion` - sesja TWS/IB Gateway Socket API, subskrypcje market data, agregacja 1m candles, zapis do Postgresa, cache rynku w Redisie
- `apps/signal-engine` - silnik sygnałów (EMA20/50, RSI14, ATR14, risk model, zapis proposed orders)
- `apps/execution-engine` - wykonanie zleceń przez TWS Socket API na bazie `proposed_orders` lub ręcznego ticketu
- `packages/shared` - wspólne typy domenowe

## Quick start

1. `cp .env.example .env`
2. `docker compose up -d`
3. `POST http://localhost:3101/bootstrap`
4. `POST http://localhost:3103/execution/bootstrap`
5. Otwórz `http://localhost:5173`

## Local dev (bez Dockera dla appów)

1. `cp .env.example .env`
2. `docker compose up -d postgres redis`
3. `pnpm install`
4. `pnpm dev:ingestion`
5. `pnpm dev:signal`
6. `pnpm dev:execution`
7. `pnpm dev:ui`

## TWS / IB Gateway setup

1. Zaloguj się do IB Gateway/TWS (paper albo live).
2. Włącz `Configure -> API -> Settings -> Enable ActiveX and Socket Clients`.
3. Dodaj `127.0.0.1` do `Trusted IPs`.
4. Ustaw port socket zgodny z trybem (paper zwykle `4002`, live zwykle `4001`).
5. W `.env` ustaw `IB_SOCKET_PORT` i opcjonalnie `IBKR_ACCOUNT_ID`.
6. Uruchom ingestion i wykonaj `POST /bootstrap`.

Przy uruchomieniu przez Docker Compose:
- kontenery `ingestion` i `execution-engine` łączą się do TWS przez `host.docker.internal` (nie przez `127.0.0.1` z `.env`).
- jeśli widzisz `TWS connect timeout waiting for nextValidId`, sprawdź w TWS:
- `Enable ActiveX and Socket Clients` jest włączone
- poprawny port (`4002` paper / `4001` live)
- odznaczone `Allow connections from localhost only` (dla połączeń z kontenera)

Najważniejsze zmienne środowiskowe:
- `PORT` - port ingestion (`3101`)
- `SIGNAL_PORT` - port signal-engine (`3102`)
- `EXECUTION_PORT` - port execution-engine (`3103`)
- `IB_SOCKET_HOST`, `IB_SOCKET_PORT`, `IB_CLIENT_ID` - połączenie do TWS/IB Gateway (Socket API)
- `EXECUTION_CLIENT_ID` - osobny client ID dla execution socket
- `IB_MARKET_DATA_TYPE` - typ danych rynkowych (`1` live, `2` frozen, `3` delayed, `4` delayed frozen)
- `EXECUTION_DEFAULT_TIF`, `EXECUTION_ORDER_TIMEOUT_MS`, `EXECUTION_DRY_RUN` - parametry wykonania zleceń
- `WATCHLIST_SYMBOLS` - symbole do subskrypcji i liczenia sygnałów
- `INGESTION_BACKFILL_1M_CANDLES` - ile świec 1m dociągnąć z historii na `POST /bootstrap` (domyślnie: `SIGNAL_MIN_CANDLES`)
- `SIGNAL_ASSET_CLASS_OVERRIDES` - ręczne mapowanie klasy aktywa (`AAPL:stock,GC:commodity,SPY:index`)
- `MAX_RISK_PER_TRADE_PCT`, `MAX_EXPOSURE_PCT`, `MAX_OPEN_POSITIONS` - limity ryzyka

## Etap 1 (zaimplementowane)

- połączenie do TWS/IB Gateway Socket API
- pobranie managed accounts (`reqManagedAccts`)
- lookup contract details (`reqContractDetails`) i `conid`
- historyczny backfill świec 1m na `POST /bootstrap` (dla szybkiego startu signal-engine)
- streaming market data (`reqMktData`)
- agregacja ticków do świec 1m + automatyczna agregacja 5m/1h + persist do Postgresa
- aktualny stan instrumentu do Redis (`market-state:{conid}`)

## Etap 2 (zaimplementowane)

- wskaźniki liczone przez `indicatorts` (`EMA`, `RSI`, `ATR`, `MACD`, `BB`, `Donchian`, `OBV`)
- automatyczny dobór strategii per symbol:
- klasyfikacja aktywa (`stock` / `commodity` / `index`)
- detekcja reżimu rynku (`trend` / `range` / `high_volatility`)
- wybór profilu (np. `stocks_trend_v1`, `commodities_trend_v1`, `indices_range_v1`)
- filtr trendu (`EMA50` na 1h, fallback do `EMA200` na 1m gdy historia 1h jest za krótka)
- filtry spreadu i płynności (profilowe limity)
- risk checks: `maxRiskPerTradePct`, `maxExposurePct`, `maxOpenPositions`
- sizing pozycji na bazie ATR stop distance + profilowego `quantityFactor`
- zapis wyników do `proposed_orders` ze statusem `PROPOSED`/`REJECTED`
- limity pozycji/ekspozycji liczone są z live snapshotu konta (`/execution/account/summary`), z fallbackiem do lokalnego DB gdy execution API jest niedostępne

## API signal-engine

- `POST /signals/run-once` - policz sygnały dla watchlisty lub przekazanych symboli
- `GET /signals/recent?limit=50` - ostatnie propozycje/rejekcje sygnałów
- `GET /health`

## API execution-engine

- `POST /execution/bootstrap` - połączenie socket + odczyt managed accounts
- `GET /execution/account/summary` - snapshot konta z TWS (equity/cash/margins/PnL + open positions)
- `GET /execution/orders?limit=50&status=PROPOSED` - przegląd orders z DB
- `POST /execution/execute-proposed/:id` - wykonaj istniejący `PROPOSED` order
- `POST /execution/execute-ticket` - wykonaj ręczny, ustrukturyzowany signal ticket (opcjonalnie persist)

Przykład ręcznego ticketu:

```bash
curl -X POST http://127.0.0.1:3103/execution/execute-ticket \
  -H 'content-type: application/json' \
  -d '{
    "ticket": {
      "instrument": "AAPL",
      "side": "BUY",
      "orderType": "MKT",
      "quantity": 1,
      "reason": "manual paper test",
      "confidence": 0.7,
      "riskCheckStatus": "PASS"
    },
    "persist": true,
    "dryRun": true
  }'
```

## UI (React)

- W compose UI działa na `http://localhost:5173`.
- W local dev `pnpm dev:ui` uruchamia panel operatorski na `http://localhost:5173`.
- UI używa proxy Vite:
- `/api/ingestion/* -> http://127.0.0.1:3101/*`
- `/api/signal/* -> http://127.0.0.1:3102/*`
- `/api/execution/* -> http://127.0.0.1:3103/*`
- Główne akcje w UI:
- `Ingestion Bootstrap`
- `Run Signals Once`
- `Execution Bootstrap`
- `Execute All Proposed`
- Widoki:
- watchlista (symbol, conid, last/bid/ask/spread, ostatnia świeca 1m)
- tabela `proposed_orders` z przyciskiem wykonania pojedynczego zlecenia

## Istotne uwagi IBKR

- W TWS/IB Gateway trzeba mieć włączone `Enable ActiveX and Socket Clients`.
- Dodaj `127.0.0.1` do `Trusted IPs` i używaj poprawnego portu socket (paper zwykle `4002`, live zwykle `4001`).
- Limity market data lines i snapshotów ograniczają rozmiar watchlisty.
- Obsługiwane typy orderów i routing trzeba potwierdzić manualnie w TWS przed automatyzacją.
- Ingestion i Execution muszą mieć różne client IDs (`IB_CLIENT_ID` vs `EXECUTION_CLIENT_ID`).
- Domyślnie `EXECUTION_DRY_RUN=true` (paper-safe); ustaw `false` dopiero gdy chcesz faktycznie wysyłać zlecenia.

## Najbliższe kroki (Etap 3/4)

- dodać worker oceniający outcome sygnału ex post (`signal_outcomes`)
- dodać dashboard jakości sygnałów (win rate, median return, drawdown)
- dodać execution-engine z circuit breakers i potwierdzeniem sesji IBKR
- przenieść komunikację signal -> execution na kolejkę (np. Redis streams / RabbitMQ)
