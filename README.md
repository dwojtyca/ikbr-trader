# ikbr-trader

Szkielet systemu tradingowego pod IBKR z podziałem na:
- `apps/ingestion` - sesja TWS/IB Gateway Socket API, subskrypcje market data, agregacja 1m candles, zapis do Postgresa, cache rynku w Redisie
- `apps/signal-engine` - silnik sygnałów (EMA20/50, RSI14, ATR14, risk model, zapis proposed orders)
- `apps/execution-engine` - wykonanie zleceń przez TWS Socket API na bazie `proposed_orders` lub ręcznego ticketu
- `apps/llm-agent` - autonomiczny agent LLM analizujący `PROPOSED` + newsy i decydujący `EXECUTE` / `REJECT`
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
7. `pnpm dev:llm`
8. `pnpm dev:ui`

## TWS / IB Gateway setup

1. Zaloguj się do IB Gateway/TWS (paper albo live).
2. Włącz `Configure -> API -> Settings -> Enable ActiveX and Socket Clients`.
3. Dodaj `127.0.0.1` do `Trusted IPs`.
4. Ustaw port socket zgodny z trybem (paper zwykle `4002`, live zwykle `4001`).
5. W `.env` ustaw `IB_SOCKET_PORT`.
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
- `EXECUTION_DEFAULT_TIF`, `EXECUTION_ORDER_TIMEOUT_MS`, `EXECUTION_SUBMITTED_AUTO_CANCEL_MS`, `EXECUTION_RETRY_AS_MKT_ON_CODE_110`, `EXECUTION_MIN_TICK_OVERRIDES` - parametry wykonania zleceń
- `LLM_AGENT_*`, `OPENAI_API_KEY`, `MARKETAUX_API_KEY` - parametry autonomicznego agenta LLM
- `WATCHLIST_SYMBOLS` - symbole do subskrypcji i liczenia sygnałów
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
- wyliczanie poziomów `SL/TP` (ATR multipliers) dla sygnałów wejścia
- zapis wyników do `proposed_orders` ze statusem `PROPOSED`/`REJECTED`
- limity pozycji/ekspozycji liczone są z live snapshotu konta (`/execution/account/summary`), z fallbackiem do lokalnego DB gdy execution API jest niedostępne

## API signal-engine

- `POST /signals/run-once` - policz sygnały dla watchlisty lub przekazanych symboli
- `GET /signals/recent?limit=50` - ostatnie propozycje/rejekcje sygnałów
- `GET /health`

## API execution-engine

- `POST /execution/bootstrap` - połączenie socket + odczyt managed accounts
- `GET /execution/account/summary` - snapshot konta z TWS (equity/cash/margins/PnL + open positions)
- `GET /execution/orders?limit=50&status=PROPOSED` - przegląd orders z DB (+ filtry `decisionSource` i `aiDecision`)
- `POST /execution/execute-proposed/:id` - wykonaj istniejący `PROPOSED`, lub `REJECTED` z `overrideRejected=true`
- `POST /execution/reject-proposed/:id` - systemowe/manualne odrzucenie `PROPOSED`
- `POST /execution/execute-ticket` - wykonaj ręczny, ustrukturyzowany signal ticket (opcjonalnie persist)
- execution wysyła bracket (`parent + TP + SL`) jeśli ticket ma `stop` i `takeProfit` oraz `positionEffect=OPEN_OR_ADD`
- przy `positionEffect=CLOSE_OR_REDUCE` bracket nie jest zakładany (order tylko zamyka/redukuje pozycję)

Przykład ręcznego ticketu:

```bash
curl -X POST http://127.0.0.1:3103/execution/execute-ticket \
  -H 'content-type: application/json' \
  -d '{
    "ticket": {
      "instrument": "AAPL",
      "side": "BUY",
      "positionEffect": "OPEN_OR_ADD",
      "orderType": "MKT",
      "quantity": 1,
      "stop": 250,
      "takeProfit": 275,
      "reason": "manual execution test",
      "confidence": 0.7,
      "riskCheckStatus": "PASS"
    },
    "persist": true
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
- `Reject` (manual reject dla `PROPOSED`)
- `Execute override` (dla orderów `REJECTED` przez AI)
- Widoki:
- watchlista (symbol, conid, last/bid/ask/spread, ostatnia świeca 1m)
- tabela `proposed_orders` z metadanymi AI (`Decision Source`, `AI Decision`, `AI Model`, `AI Reason`)

## LLM Agent (autonomiczny execution gate)

- Agent cyklicznie pobiera i atomowo claimuje nowe `PROPOSED` z DB.
- Buduje kontekst z:
- order ticketu (symbol/side/qty/entry/SL/TP/strategy/confidence),
- aktualnego stanu konta i pozycji z `/execution/account/summary`,
- newsów symbolu z MarketAux (okno `LLM_AGENT_NEWS_WINDOW_HOURS`).
- Następnie podejmuje decyzję przez OpenAI (`LLM_AGENT_MODEL`) i:
- `EXECUTE`: wywołuje `/execution/execute-proposed/:id`,
- `REJECT`: wywołuje `/execution/reject-proposed/:id`.
- Każda decyzja trafia do `llm_order_decisions` (audit trail).
- Fail-closed: przy błędzie LLM/news/API order dostaje `REJECTED` z technicznym powodem.
- Cooldown na symbol (`LLM_AGENT_SYMBOL_COOLDOWN_MS`) ogranicza spam decyzji na tym samym tickerze.
- Uwaga: przy `LLM_AGENT_ENABLED=true` i brakujących `OPENAI_API_KEY` / `MARKETAUX_API_KEY` agent będzie odrzucał `PROPOSED` (fail-closed).

## Istotne uwagi IBKR

- W TWS/IB Gateway trzeba mieć włączone `Enable ActiveX and Socket Clients`.
- Dodaj `127.0.0.1` do `Trusted IPs` i używaj poprawnego portu socket (paper zwykle `4002`, live zwykle `4001`).
- Limity market data lines i snapshotów ograniczają rozmiar watchlisty.
- Obsługiwane typy orderów i routing trzeba potwierdzić manualnie w TWS przed automatyzacją.
- Ingestion i Execution muszą mieć różne client IDs (`IB_CLIENT_ID` vs `EXECUTION_CLIENT_ID`).

## Najbliższe kroki (Etap 3/4)

- dodać worker oceniający outcome sygnału ex post (`signal_outcomes`)
- dodać dashboard jakości sygnałów (win rate, median return, drawdown)
- dodać execution-engine z circuit breakers i potwierdzeniem sesji IBKR
- przenieść komunikację signal -> execution na kolejkę (np. Redis streams / RabbitMQ)

## Analiza strategii i rekomendacje taktyczne (2026-04-29)

Ten rozdział opisuje stan bota na podstawie lokalnej bazy, live snapshotu IBKR i aktualnej logiki `signal-engine`. Nie jest to obietnica zysku. Przy realnym koncie pierwszym celem powinno być ograniczenie strat i zebranie statystycznie wiarygodnej probki, a dopiero potem skalowanie.

### Obecny stan konta

Snapshot IBKR z 2026-04-29 22:14 CEST:

- Net liquidation: `1,164,411.50`
- Total cash: `1,135,006.32`
- Gross exposure: `116,435.38`, czyli ok. `10.0%` NAV
- Daily realized PnL: `-230.24`
- Cumulative realized PnL: `-9,156.84`, czyli ok. `-0.79%` NAV
- Unrealized PnL: `-746.57`
- Otwarte pozycje:
- `PKO` long `1191`, market value `114,213.35`, average cost `98.32`, market price `95.90`, unrealized base PnL ok. `-792.52`
- `SGLN` short `34`, market value `-2,222.03`, unrealized base PnL ok. `+43.60`

### Co pokazuje baza transakcyjna

W `proposed_orders` aktualny rozklad statusow to:

- `REJECTED`: `1146`
- `SUPERSEDED`: `1043`
- `CANCELLED`: `548`
- `FILLED`: `91`
- `EXPIRED`: `16`

W `broker_execution_fills` jest `171` pojedynczych fill rows, odpowiadajacych wielu czesciowym wykonaniom. Suma proxy `realized_pnl - commission` bez przeliczenia wszystkich walut do base wynosi ok. `-12,185`, natomiast live metryka konta po przeliczeniach pokazuje `-9,156.84` cumulative realized PnL.

Najwieksze negatywne epizody w danych wykonania to:

- `TSLA BUY` 2026-04-27: ok. `-5,540` po prowizjach w proxy waluty wykonania
- `PZU SELL` 2026-04-23: ok. `-3,586`
- `META SELL` 2026-04-28: ok. `-2,245`
- `NVDA BUY` 2026-04-24: ok. `-1,047`
- `CDR SELL` 2026-04-29: ok. `-861`

To oznacza, ze wynik nie jest rozproszonym szumem z setek malych strat. Kilka duzych decyzji/pozycji odpowiada za wiekszosc drawdownu.

### Jak dziala obecna strategia

`signal-engine` dziala event-driven na swiecach 1m. Dla symbolu pobiera ok. `SIGNAL_MIN_CANDLES + 80` swiec 1m i do 160 swiec 1h, liczy m.in. `EMA20/50/200`, `RSI14`, `ATR14`, `MACD`, Bollinger Bands, Donchian 20 i OBV slope.

Logika doboru strategii:

- instrument jest klasyfikowany jako `stock`, `index` albo `commodity`
- reżim rynku jest klasyfikowany jako `trend`, `range` albo `high_volatility`
- profil strategii dobierany jest z `strategy-profiles.ts`, np. `stocks_trend_v1`, `indices_range_v1`, `commodities_trend_v1`
- score BUY/SELL musi przekroczyc `entryScore` profilu oraz przewage `decisionEdge`
- confidence jest dodatkowo karane za spread
- sizing bazuje na `MAX_RISK_PER_TRADE_PCT`, ATR stop distance, `quantityFactor`, limitach notional/exposure i live snapshotcie konta
- dla `OPEN_OR_ADD` bot zaklada bracket order z TP/SL
- dla `CLOSE_OR_REDUCE` bot zamyka/redukuje pozycje bez bracketu
- przy pozycji otwartej bot moze wygenerowac managed exit po czasie lub po zalamaniu momentum

Istotne aktualne parametry:

- `MAX_RISK_PER_TRADE_PCT=0.35`
- `MAX_NOTIONAL_PER_TRADE_PCT=5`
- `MAX_EXPOSURE_PCT=25`
- `MAX_OPEN_POSITIONS=5`
- `SIGNAL_MIN_CONFIDENCE=0.55`
- `ATR_STOP_MULT=1.5`
- `ATR_TP_MULT=3`
- `SIGNAL_MAX_MARKET_STATE_AGE_MS=45000`
- `SIGNAL_FRACTIONAL_SYMBOLS=` - pozycje powinny byc calkowite, co jest potrzebne dla IBKR socket API przy tych instrumentach

### Najwieksze problemy

1. Zbyt niska selektywnosc przy obecnym rozmiarze pozycji.

   `MAX_NOTIONAL_PER_TRADE_PCT=5` oznacza, ze pojedynczy sygnal moze dostac istotny kapital. To nie musi byc problemem, jezeli filtr wejsc ma dodatnia expectancy. Obecne wyniki sugeruja jednak, ze kapital jest czasem alokowany do setupow rozciagnietych lub niskiej jakosci. Wniosek: nie zmniejszac limitow, tylko podniesc prog jakosci sygnalu, ktory dopuszcza uzycie pelnego size.

2. Stop distance jest czesto zbyt waski wobec szumu intraday.

   W wielu przegranych `signal_outcomes` stop byl trafiany przy ruchu rzedu `0.2-0.3%`. To jest bardzo wasko dla pojedynczych akcji i instrumentow o roznych sesjach/plynnosci. Efekt: bot moze miec technicznie sensowny kierunek, ale zostaje wybity przez normalny mikro-szum.

3. Time stop konkuruje z logika TP/SL.

   Managed exit zamyka range po ok. `18m`, trend po ok. `30m`, breakout po ok. `24m`, jezeli PnL jest mniejszy niz `0.2%`. To moze ucinac pozycje zanim setup zdazy dojrzec. W danych widac duzo `mark_to_market` i strat z wyjsc czasowych.

4. Profil `stocks_trend_v1` ma ujemna probke.

   W `signal_outcomes`:

   - `stocks_trend_v1 BUY`: `13` probek, avg `-0.0108%`, mediana `-0.1944%`, `3` wygrane / `10` przegranych
   - `stocks_trend_v1 SELL`: `12` probek, avg `-0.0508%`, mediana `-0.2546%`, `5` wygranych / `7` przegranych

   To za mala probka na finalny wyrok, ale wystarczajaca, zeby nie skalowac tej strategii na realnym koncie.

5. Kierunek short/long bywa otwierany po ruchu juz rozciagnietym.

   LLM czesto odrzucal sygnaly typu short po silnym spadku i oversold RSI albo long przy overbought RSI. To nie powinno byc tylko opinia LLM. Taka regule trzeba przeniesc do deterministic signal layer.

6. Watchlista miesza rozne rynki i waluty w jednym modelu.

   Ten sam silnik obsluguje US tech, polskie akcje, indeksowe ETF-y i zloto notowane w GBP. To utrudnia kontrolowanie prowizji, spreadow, sesji, tick size, FX i plynnosci. Aktualna strategia probuje byc uniwersalna, a wyniki sugeruja, ze trzeba ja rozdzielic na koszyki.

7. Execution layer nadal jest czescia strategii.

   Duza liczba `CANCELLED` i wczesniejsze problemy z fractional sizes pokazaly, ze wynik bota nie zalezy tylko od entry/exit. Jezeli broker odrzuca lub opoznia order, strategia staje sie inna niz ta, ktora zakladamy w sygnalach.

8. Brakuje rankingu profili wedlug aktualnej expectancy.

   Obecnie profil z ujemna mediana moze nadal konkurowac o kapital podobnie jak profil z dodatnia mediana. Lepszym podejsciem jest dynamiczne podbijanie progow dla slabszych profili i preferowanie tych, ktore maja dodatnia expectancy po kosztach, osobno dla symbolu, kierunku i reżimu.

### Rekomendowane zmiany pod poprawe expectancy

Zalozenie operacyjne: `MAX_NOTIONAL_PER_TRADE_PCT` i `MAX_RISK_PER_TRADE_PCT` zostaja bez zmian. Ponizsze zmiany nie maja sluzyc prostemu "ucinaniu strat" przez mniejsza ekspozycje. Celem jest zwiekszenie oczekiwanej wartosci transakcji: mniej wejsc po slabym setupie, wiekszy udzial transakcji z dodatnim R, lepsze prowadzenie zwyciezcow i alokacja kapitalu do profili, ktore faktycznie maja przewage.

Priorytet 1 - poprawic jakosc wejsc, nie zmniejszac size:

- dla trend BUY: nie otwierac long, gdy `RSI14 > 68`, chyba ze jest osobny profil breakout z potwierdzonym wybiciem i wolumenem
- dla trend SELL: nie otwierac short, gdy `RSI14 < 32-38`, chyba ze jest potwierdzony breakdown i instrument jest plynny do shortowania
- dla short single-stock na US tech dodac twardsze potwierdzenie: cena ponizej `EMA20`, `EMA20 < EMA50`, MACD histogram spada przez kilka swiec, a nie tylko jest ujemny
- dla long single-stock wymagac zgodnosci z 1h trendem, nie tylko fallback `EMA200_1m`
- dla range BUY wymagac ceny blisko dolnego pasma Bollingera i RSI wracajacego z oversold, a nie samego faktu niskiego RSI
- dla range SELL wymagac ceny blisko gornego pasma i RSI schodzacego z overbought, a nie sprzedawac wyłącznie dlatego, ze cena jest wysoko

Priorytet 2 - poprawic profil zysku przez wyjscia:

- podniesc minimalny stop dla akcji z obecnych kilkunastu bps do ok. `30-50 bps`
- dla indeksow/ETF ustawic minimalny stop ok. `15-25 bps`
- rozwazyc `ATR_STOP_MULT=2.0` oraz `ATR_TP_MULT=3.5-4.0`, pod warunkiem ze backtest/forward test poprawia expectancy po kosztach
- usunac agresywny time stop `30m` dla trendu albo podniesc go do `90-180m`
- dla pozycji z zyskiem wprowadzic trailing stop po osiagnieciu `+0.5R`, zamiast zamykac tylko na sztywny czas
- dla trendow testowac czesciowe TP: np. zamkniecie czesci pozycji przy `1R`, reszta prowadzona trailingiem do `2.5-4R`
- dla range trzymac TP blizej srodka/przeciwnego pasma, a nie wymuszac jednego ATR modelu dla wszystkich symboli

Szerszy stop nie jest tu mechanizmem "mniej strat", tylko sposobem na unikniecie wybijania poprawnych setupow przez normalny szum 1m. Przy stalym `MAX_RISK_PER_TRADE_PCT` sizing oparty o risk-per-unit powinien automatycznie dostosowac ilosc akcji.

Priorytet 3 - alokowac kapital do profili z przewaga:

- osobne profile dla `US large cap`, `US index ETF`, `PL stocks`, `LSE gold ETC`
- osobne progi spreadu, min volume, tick size i sesji dla kazdego koszyka
- preferowac profile/symbole z dodatnia rolling expectancy po kosztach, zamiast traktowac cala watchliste rowno
- dla profili o ujemnej medianie obnizac ranking sygnalu albo wymagac dodatkowego potwierdzenia, zamiast mechanicznie blokowac caly handel
- nie laczyc w jednej decyzji taktycznej instrumentow z roznymi walutami bez pelnego modelu FX i prowizji

Priorytet 4 - nauczyc system na wlasnych wynikach:

- codziennie licz `expectancy = avg(win) * win_rate - avg(loss) * loss_rate - costs`
- dla kazdego profilu licz osobno expectancy dla BUY i SELL; np. `stocks_trend_v1 BUY` i `stocks_trend_v1 SELL` nie powinny miec tego samego progu, jesli ich wyniki sa rozne
- zamiast stalego `SIGNAL_MIN_CONFIDENCE`, wyznacz dynamiczny prog per profil na bazie historycznej skutecznosci i kosztow
- zapisuj MAE/MFE dla kazdego orderu, czyli maksymalny ruch przeciwko i na korzysc pozycji
- zapisuj slippage: `fill_price - intended_entry` dla BUY i `intended_entry - fill_price` dla SELL
- porownuj wynik sygnalu przed LLM i po LLM; jesli LLM poprawia wynik, przenies jego powtarzalne reguly do deterministic layer

Priorytet 5 - egzekucja jako element edge:

- nie otwierac pozycji, jezeli broker nie potwierdzi parent order i protective children bracket
- po bledzie IBKR `INACTIVE`, parser error, timeout lub braku orderStatus nie wysylac kolejnych orderow dla tego symbolu przez cooldown
- dla instrumentow z duzym tick size albo nietypowa waluta uzywac osobnej konfiguracji min tick i roundingu ceny
- mierzyc fill quality i preferowac symbole, gdzie slippage jest stabilnie niski; edge strategii 1m moze zniknac przez slippage szybciej niz przez sam kierunek rynku

### Docelowa taktyka

Docelowo bot powinien byc bardziej selektywny i lepiej wykorzystywac zwyciezcow, bez mechanicznego zmniejszania globalnego ryzyka:

1. Najpierw handlowac tylko najlepsze profile z dodatnia rolling expectancy.
2. Dla trendow dawac pozycji wiecej czasu i prowadzic zysk trailingiem.
3. Dla range brac szybsze, bardziej precyzyjne TP i nie gonoc ceny po rozciagnieciu.
4. Odcinac lub obnizac ranking strategii, symboli i kierunkow, ktore maja ujemna mediane.
5. Traktowac koszty, slippage i odrzucenia brokera jako czesc strategii, nie jako problemy poboczne.

### Zrodla i zalozenia

- SEC opisuje day trading jako aktywnosc wysokiego ryzyka, szczegolnie przy dzwigni i szybkim obrocie, oraz ostrzega przed zalozeniami o latwych zyskach: https://www.sec.gov/about/reports-publications/investorpubsdaytipshtm
- CFA Institute wskazuje, ze backtesting, scenariusze i symulacje sluza do oceny relacji risk-return oraz ze trzeba uwazac na biasy i zmiany reżimow: https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/backtesting-and-simulation
- FINRA opisuje ryzyka margin, wymogi utrzymania zabezpieczen i mozliwosc likwidacji pozycji przy niedoborze margin: https://www.finra.org/rules-guidance/key-topics/margin-accounts

## Aktualna strategia po implementacji zmian

Ta sekcja opisuje faktycznie zaimplementowana logike po zmianach z 2026-04-29. Globalne limity `MAX_NOTIONAL_PER_TRADE_PCT` i `MAX_RISK_PER_TRADE_PCT` pozostaja bez zmian. Optymalizacja polega na lepszym wyborze sygnalow, dynamicznym progu jakosci i innym prowadzeniu pozycji.

### Pipeline sygnalu

1. `ingestion` zapisuje swiece 1m do Postgresa i dla kazdej gotowej swiecy wywoluje `POST /signals/on-candle` z `symbol` oraz `candleTs`.
2. `signal-engine` sprawdza, czy dla `instrument + generated_from_candle_ts` byl juz zapisany sygnal. Jesli tak, zwraca `already_processed_for_candle`.
3. Dla symbolu pobierane sa swiece:
   - 1m: `SIGNAL_MIN_CANDLES + 80`
   - 1h: do `160`
4. Silnik liczy snapshot techniczny:
   - `EMA20`, `EMA50`, `EMA200`
   - `RSI14` i `RSI14Prev`
   - `ATR14`
   - `MACD line/signal/histogram` oraz poprzedni histogram
   - Bollinger Bands 20: upper/middle/lower/width
   - Donchian 20: upper/lower
   - OBV slope
   - trend filter: preferencyjnie `EMA50_1h`, fallback `EMA200_1m`
5. Symbol jest klasyfikowany jako `stock`, `index` albo `commodity`.
6. Reżim rynku jest klasyfikowany jako `trend`, `range` albo `high_volatility`.
7. Dobierany jest profil strategii, np. `stocks_trend_v1`, `indices_range_v1`, `commodities_trend_v1`.
8. Silnik liczy score BUY/SELL zgodnie ze stylem profilu: `trend`, `range` albo `breakout`.
9. Jesli score nie przechodzi `entryScore` i `decisionEdge`, powstaje `REJECTED/HOLD` z powodem `No edge`.
10. Jesli sygnal przechodzi score, wchodza dodatkowe filtry jakosci wejscia, opisane nizej.
11. Jesli przejdzie filtry, silnik liczy entry, stop, take profit, sizing i confidence.
12. `PROPOSED` trafia do `proposed_orders`, skad jest claimowany przez `llm-agent`.

### Filtry techniczne przed utworzeniem PROPOSED

Filtry ponizej dotycza nowych pozycji `OPEN_OR_ADD`. Zamkniecia/redukcje `CLOSE_OR_REDUCE` sa traktowane bardziej liberalnie, bo ich celem jest zarzadzanie istniejaca pozycja.

Trend:

- trend BUY jest odrzucany, gdy `RSI14 > 68`, bo wejscie jest uznane za overextended
- trend SELL jest odrzucany, gdy `RSI14 < 36`, bo short jest uznany za spozniony/oversold
- stock trend BUY wymaga trend filter z 1h (`EMA50_1h`) oraz ceny powyzej tego filtra
- stock trend SELL wymaga breakdown confirmation:
  - cena ponizej `EMA20`
  - `EMA20 < EMA50`
  - `MACD hist` spada wzgledem poprzedniego histogramu

Range:

- range BUY wymaga ceny blisko dolnego pasma Bollingera, RSI reversal oraz poprawiajacego sie MACD histogram
- range SELL wymaga ceny blisko gornego pasma Bollingera, RSI reversal oraz slabnacego MACD histogram
- strefa dolnego/gornego pasma jest liczona jako ok. `38%` odleglosci od bandy do srodka pasma
- BUY nie wystarczy sam niski RSI; musi byc tez zachowanie ceny przy dolnym paśmie
- SELL nie wystarczy sama wysoka cena; musi byc tez zachowanie ceny przy gornym paśmie

### Dynamiczny prog confidence

Podstawowy prog to:

```text
SIGNAL_MIN_CONFIDENCE * profile.minConfidenceMultiplier
```

Nastepnie silnik sprawdza rolling performance w `signal_outcomes`:

- per `strategy + side`, limit ostatnich `40` wynikow
- per `instrument + strategy + side`, limit ostatnich `30` wynikow

Jesli profil ma co najmniej `8` probek i jednoczesnie:

- `expectancyPct < 0`
- `medianPnlPct < 0`

to minimalny confidence jest podnoszony o `0.08`.

Jesli symbol/profil/kierunek ma co najmniej `4` probki i jednoczesnie:

- `expectancyPct < 0`
- `medianPnlPct < 0`

to minimalny confidence jest podnoszony o kolejne `0.05`.

To nie zmniejsza globalnego size. Mechanizm wymaga mocniejszego sygnalu, zeby kapital mogl byc alokowany do slabszego historycznie profilu.

### Sizing i ryzyko

Sizing pozostaje oparty o:

- live `accountEquity` z execution account summary, z fallbackiem do `ACCOUNT_EQUITY`
- `MAX_RISK_PER_TRADE_PCT`
- odleglosc entry-stop (`riskPerUnit`)
- `profile.quantityFactor`
- `MAX_EXPOSURE_PCT`
- `MAX_NOTIONAL_PER_TRADE_PCT`
- limit ekspozycji kierunkowej
- limit koncentracji symbolu
- `MAX_OPEN_POSITIONS`

Ilość jest zaokraglana do kroku symbolu:

- standardowo `1`
- fractional tylko dla symboli w `SIGNAL_FRACTIONAL_SYMBOLS`

Aktualnie `SIGNAL_FRACTIONAL_SYMBOLS=` jest puste, wiec bot generuje calkowite ilosci, co jest wymagane dla obecnej integracji z IBKR przy obserwowanych instrumentach.

### Entry, SL i TP

Entry jest wybierane wedlug `SIGNAL_LMT_ENTRY_MODE`:

- `touch`: BUY po ask, SELL po bid
- `mid`: srodek bid/ask
- `last`: ostatnia cena
- fallback: last price

Opcjonalny buffer `SIGNAL_LMT_ENTRY_BUFFER_BPS` przesuwa entry:

- BUY wyzej
- SELL nizej

Stop i take profit:

- stop = `ATR14 * ATR_STOP_MULT * profile.atrStopMultFactor`
- take profit = `ATR14 * ATR_TP_MULT * profile.atrTpMultFactor`
- jesli stop jest mniejszy niz minimalny stop bps dla klasy aktywa, stop jest poszerzany do minimum, a TP jest przeliczane tak, by zachowac RR

Dla `OPEN_OR_ADD` execution-engine zaklada bracket order. Dla `CLOSE_OR_REDUCE` nie zaklada bracketu, bo order zamyka lub redukuje pozycje.

### Managed exit

Jesli istnieje pozycja w symbolu, signal-engine najpierw ocenia wyjscie zarzadzane.

Aktualne maksymalne czasy trzymania:

- `range`: `30m`
- `trend`: `120m`
- `breakout`: `90m`

Time stop generuje `CLOSE_OR_REDUCE`, jezeli czas zostal przekroczony i `pnlPct < 0.2%` albo PnL nie jest dostepny.

Profit protection:

- jesli pozycja ma dodatni PnL
- i osiagnela ok. `0.5R` lub brak danych do R
- i momentum zaczyna sie cofac:
  - dla longa: cena spada pod `EMA20`, a MACD histogram slabnie
  - dla shorta: cena wychodzi nad `EMA20`, a MACD histogram rosnie

to silnik generuje `CLOSE_OR_REDUCE` z powodem `Managed exit: profit protection`.

Momentum breakdown:

- long jest zamykany, gdy cena jest ponizej trend filter, `EMA20 < EMA50`, `MACD hist < 0`, `RSI14 < 48`
- short jest zamykany, gdy cena jest powyzej trend filter, `EMA20 > EMA50`, `MACD hist > 0`, `RSI14 > 52`

### Reguly zapisu do proposed_orders

Nie kazdy wynik symbolu trafia do tabeli:

- `REJECTED/HOLD` z powodami `No edge`, `Liquidity filter rejected signal` albo `Spread filter rejected signal` nie sa zapisywane
- duplikaty `REJECTED/HOLD` z tym samym instrumentem i reason sa deduplikowane przez `SIGNAL_HOLD_REJECT_DEDUP_MS`
- nowe `PROPOSED` dla instrumentu oznacza starsze nieprzetwarzane `PROPOSED` tego instrumentu jako `SUPERSEDED`
- stare nieprzetworzone `PROPOSED` przechodza w `EXPIRED` po `SIGNAL_PROPOSAL_TTL_MS`

## Jak sygnal jest przekazywany do LLM

`llm-agent` claimuje tylko ordery ze statusem `PROPOSED`. Claim ustawia `processing_owner` i `processing_claimed_at`, zeby wielu workerow nie obrabialo tego samego orderu.

### Warunki przed LLM

Order nie trafia do modelu, jezeli:

- `riskCheckStatus` nie jest `PASS`
- symbol jest w cooldownie `LLM_AGENT_SYMBOL_COOLDOWN_MS`
- nie mozna pobrac account summary i `LLM_AGENT_FAIL_CLOSED=true`
- brakuje `MARKETAUX_API_KEY` i fail-closed jest wlaczony
- MarketAux zwroci blad i fail-closed jest wlaczony
- brakuje `OPENAI_API_KEY` i fail-closed jest wlaczony

W trybie fail-closed taki order jest odrzucany jako `REJECTED`.

### User payload do OpenAI

LLM dostaje JSON jako user message. Struktura:

```json
{
  "promptVersion": "string",
  "now": "ISO timestamp",
  "order": {
    "id": 123,
    "instrument": "NVDA",
    "side": "BUY",
    "positionEffect": "OPEN_OR_ADD",
    "orderType": "LMT",
    "quantity": 100,
    "entry": 200.12,
    "stop": 198.5,
    "takeProfit": 203.4,
    "strategy": "stocks_trend_v1",
    "confidence": 0.82,
    "reason": "Signal BUY: profile=..."
  },
  "indicatorSummary": {
    "ema20": 201.1,
    "ema50": 199.8,
    "ema200": 190.2,
    "rsi14": 61.5,
    "atr14": 1.2,
    "macdHist": 0.15,
    "bbWidthPct": 0.018,
    "trendFilterValue": 198.7,
    "trendFilterSource": "EMA50_1h",
    "assetClass": "stock",
    "regime": "trend",
    "strategyProfile": "stocks_trend_v1"
  },
  "account": {
    "accountId": "DUO...",
    "metrics": {
      "netLiquidation": 1164411.5,
      "totalCashValue": 1135006.32,
      "buyingPower": 7593692.47,
      "availableFunds": 1139053.87,
      "excessLiquidity": 1148443.53,
      "equityWithLoanValue": 1164410.37
    },
    "totals": {
      "positionsCount": 2,
      "grossExposure": 116435.38,
      "netExposure": 111991.32,
      "unrealizedPnL": -746.57,
      "realizedPnL": -230.24
    },
    "openPositions": [
      {
        "symbol": "PKO",
        "position": 1191,
        "marketValue": 114213.35,
        "averageCost": 98.32,
        "unrealizedPnL": -2883.65,
        "realizedPnL": 0
      }
    ]
  },
  "currentPosition": {
    "symbol": "PKO",
    "qty": 1191,
    "averageCost": 98.32,
    "unrealizedPnL": -2883.65,
    "marketValue": 114213.35
  },
  "news": [
    {
      "title": "headline",
      "description": "short text",
      "url": "https://...",
      "source": "source",
      "publishedAt": "ISO timestamp",
      "sentiment": "positive|neutral|negative"
    }
  ]
}
```

`indicatorSummary` jest celowo kompaktowy. Nie zawiera pelnego `indicator_snapshot`, tylko najwazniejsze wartosci techniczne potrzebne do drugiej warstwy oceny.

### System prompt LLM

Model dziala jako execution gatekeeper. Najwazniejsze reguly w promptcie:

- wybiera tylko `EXECUTE` albo `REJECT`
- ma byc konserwatywny przy niejasnym rynku/newsach
- ocenia order wzgledem calego portfela, nie tylko tego symbolu
- odrzuca duplikacje ekspozycji, niezdrowa koncentracje i konflikt z pozycjonowaniem portfela
- dla `OPEN_OR_ADD` zwraca uwage na koncentracje jednej nazwy i ekspozycje w tym samym kierunku
- ordery powyzej ok. `8%` net liquidation maja byc zwykle odrzucane, chyba ze setup ma wyjatkowo mocne uzasadnienie
- `CLOSE_OR_REDUCE` ma byc traktowany bardziej liberalnie niz nowe otwarcie
- dla longow wspierajace jest `EMA20 > EMA50 >= EMA200`
- dla shortow wspierajace jest `EMA20 < EMA50 <= EMA200`
- dodatni `macdHist` wspiera long, ujemny wspiera short
- RSI > 70 zwieksza ostroznosc przy nowych longach
- RSI < 30 zwieksza ostroznosc przy nowych shortach
- wysokie `bbWidthPct` albo duzy `atr14` wymagaja mocniejszego potwierdzenia
- w reżimie `trend` model preferuje zgodnosc z trendem
- w reżimie `range` model ma preferowac mean reversion, a nie breakout continuation
- w reżimie `high_volatility` model podnosi poprzeczke dla nowych pozycji

### Oczekiwana odpowiedz LLM

Model musi zwrocic strict JSON:

```json
{
  "decision": "EXECUTE",
  "confidence": 0.74,
  "reason": "one concise sentence",
  "riskFlags": ["optional", "strings"]
}
```

Schemat walidacji:

- `decision`: `EXECUTE` albo `REJECT`
- `confidence`: liczba od `0` do `1`
- `reason`: string min. 3 znaki
- `riskFlags`: opcjonalna tablica stringow

### Co dzieje sie po decyzji

Kazda decyzja jest zapisywana do `llm_order_decisions`:

- `proposed_order_id`
- `symbol`
- `decision`
- `decision_reason`
- `model`
- `prompt_version`
- `decision_confidence`
- `news_count`
- `position_snapshot_json`
- `news_snapshot_json`
- `source_error`

Jesli LLM zwroci `EXECUTE`, agent wywoluje:

```text
POST /execution/execute-proposed/:id
```

z metadanymi:

- `actor=llm-agent`
- `decisionSource=llm`
- `aiDecision=EXECUTE`
- `aiReason`
- `aiModel`
- `aiDecisionConfidence`
- `llmDecisionId`

Jesli LLM zwroci `REJECT`, agent wywoluje:

```text
POST /execution/reject-proposed/:id
```

z `reason` zaczynajacym sie od `AI reject: ...` oraz tymi samymi metadanymi AI.

Jesli LLM zdecyduje `EXECUTE`, ale execution endpoint zwroci blad, agent w trybie fail-closed odrzuca order i zapisuje blad w `source_error`.
