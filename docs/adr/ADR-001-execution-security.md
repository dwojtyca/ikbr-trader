# ADR-001 — Execution Security

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Operator (owner of ikbr-trader)
- **Phase:** 1 — Execution Security ([ROADMAP.md](../implementation/ROADMAP.md))
- **Related documents:**
  [PHASE_0_PLAN.md](../implementation/PHASE_0_PLAN.md),
  [PHASE_1_PLAN.md](../implementation/PHASE_1_PLAN.md),
  [AGENTS.md](../../AGENTS.md)

---

## 1. Problem

Przed Fazą 1 `execution-engine` można wystawić na sieci lokalnej i skłonić
do złożenia zlecenia w IBKR **bez żadnego uwierzytelnienia ani rozpoznania,
w jakim środowisku (paper/live) faktycznie pracuje**. Konkretnie:

- Każdy proces na tej samej maszynie (lub w tej samej sieci Docker) może
  wywołać `POST /execution/orders` i skłonić bota do wysłania zlecenia.
- Rozróżnienie paper vs live opiera się wyłącznie na numerze portu TWS
  (`IB_SOCKET_PORT`). Zamiana portu w `.env` lub pomyłka w konfiguracji
  Gateway powoduje niezauważalne przełączenie na konto live.
- Endpoint `POST /execution/execute-ticket` z `persist=false` pozwala
  ominąć `proposed_orders` i risk-engine.
- `orderType` domyślnie `MKT` — jedna literówka w payloadzie i bot wysyła
  market order zamiast limit.
- `/health` łączy liveness i readiness; orchestrator nie wie, czy serwis
  utrzymuje sesję IBKR czy tylko procesu.
- Brak audytu na warstwie HTTP — nie da się po fakcie odtworzyć, kto/co
  wywołało dany order.

Faza 1 musi zamknąć wszystkie te luki **jednocześnie**, deterministycznie
i fail-closed — jest to jedyna faza, która może dołożyć bramki zanim
system dotknie live account, więc nie stać nas na "postawię i doszlifuję
później".

---

## 2. Kontekst

`execution-engine` jest jedynym miejscem w kodzie, które składa lub anuluje
zlecenia w IBKR (`ib.placeOrder`, `ib.cancelOrder`). Przed Fazą 1 serwis:

- nasłuchuje na `0.0.0.0:3103` bez żadnej autoryzacji,
- rozróżnia paper od live wyłącznie po numerze portu (`IB_SOCKET_PORT`
  4001 vs 4002),
- akceptuje pojedynczy env `IBKR_ACCOUNT_ID` bez walidacji, na jakim
  środowisku wolno się na niego zalogować,
- przyjmuje domyślnie `orderType='MKT'` w `ticketSchema` (`.default("MKT")`),
- udostępnia `POST /execution/execute-ticket` z `persist=false`, który
  omija tabelę `proposed_orders` i risk-engine,
- ma jeden endpoint `/health` — bez rozróżnienia liveness od readiness,
- nie utrwala audytu na poziomie warstwy HTTP.

AGENTS.md wymaga:

- „AI proposes decisions. The execution layer validates them."
- „Every execution must pass the deterministic Risk Engine."
- „Every execution must be auditable."
- „Never identify environment using only port numbers."
- „Never bypass proposal flow."
- Zmienne środowiskowe: `IBKR_ENVIRONMENT`, `ALLOWED_PAPER_ACCOUNTS`,
  `ALLOWED_LIVE_ACCOUNTS`, `TRADING_ENABLED`, `EXECUTION_API_TOKEN`.

Faza 1 (Execution Security) jest jedyną fazą, w której możemy dołożyć bramki
zanim system dotknie live account. Musi być deterministyczna, testowalna
i fail-closed w każdej ścieżce błędu.

---

## 3. Rozstrzygnięcia (decisions)

### 3.1 Bearer auth dla `execution-engine`

Wszystkie endpointy `execution-engine` z wyjątkiem `GET /health` wymagają
nagłówka:

```
Authorization: Bearer <EXECUTION_API_TOKEN>
```

- `EXECUTION_API_TOKEN` generowany losowo (rekomendacja: `openssl rand -hex 32`),
  długość ≥ 32 znaków.
- Weryfikacja **constant-time** (`crypto.timingSafeEqual`) po dopełnieniu
  długości, żeby uniknąć timing attack.
- Token **nigdy** nie jest logowany. W logach i audycie zapisujemy wyłącznie
  `tokenFingerprint = sha256(token).slice(0, 12)`.
- Klienci wewnętrzni (`llm-agent`, `signal-engine`, `ui` przez Vite proxy)
  **w Fazie 1 czytają dokładnie tę samą zmienną `EXECUTION_API_TOKEN`** co
  serwer. Wartość musi być identyczna po obu stronach; walidacja
  równości sprowadza się do porównania stringów w middleware serwera.
- Osobne tokeny per klient / rotacja niezależna wymagają multi-token auth
  po stronie serwera i pojawią się w kolejnej fazie. W tej fazie **nie**
  wprowadzamy osobnych zmiennych typu `LLM_AGENT_EXECUTION_API_TOKEN`,
  żeby uniknąć iluzji rozdzielenia, którego serwer nie egzekwuje.
- UI **nigdy** nie otrzymuje tokenu w bundlu JS. Token dołączany po stronie
  serwera Vite (dev) lub reverse-proxy (prod).
- Auth egzekwowana **bezwarunkowo** od merge'a PR2 — brak `EXECUTION_AUTH_ENFORCE`,
  brak soft-mode. Rollout klientów wewnętrznych koordynowany kolejnością
  PR-ów i sekwencyjnym deployem, nie feature-flagiem.

### 3.2 Osobne whitelisty paper/live

Zamiast pojedynczej listy `ALLOWED_ACCOUNT_IDS` z AGENTS.md wprowadzamy dwie:

- `ALLOWED_PAPER_ACCOUNTS` — CSV kont dozwolonych w `IBKR_ENVIRONMENT=paper`.
- `ALLOWED_LIVE_ACCOUNTS` — CSV kont dozwolonych w `IBKR_ENVIRONMENT=live`.

`execution-engine` wybiera whitelistę na podstawie `IBKR_ENVIRONMENT`.
`ensureBrokerSession()` po `reqManagedAccts` porównuje aktywne `accountId`
z whitelistą i kończy fail-closed przy mismatchu (start się nie uda,
`/ready` = 503, alert `SAFETY:ACCOUNT_ENVIRONMENT_MISMATCH`).

**Uzasadnienie separacji dwóch list zamiast jednej wspólnej:**

- Wyklucza scenariusz „paper account skonfigurowany w konfiguracji live"
  jednym zapisem w kodzie: sprawdzenie należy do listy odpowiadającej
  środowisku, nie do sumy list.
- Jeden `.env` może opisywać wiele profili (dev / staging / prod)
  bez ryzyka, że paper accounts wpadną do live whitelist.
- Rotacja / dodanie live account nie zmienia paper whitelist i vice versa.

### 3.3 `TRADING_ENABLED` jako master switch

`TRADING_ENABLED` (boolean) jest globalnym killswitchem write-actionów w
`execution-engine`:

- `IBKR_ENVIRONMENT=live` + `TRADING_ENABLED=false` → wszystkie write
  endpointy zwracają `423 Locked` z `reason='live_trading_disabled'`.
- `IBKR_ENVIRONMENT=live` + `TRADING_ENABLED=true` → warunek konieczny
  (nie wystarczający) do wykonania write akcji.
- Zmiana `TRADING_ENABLED` wymaga restartu procesu (env jest czytany raz
  na starcie). Świadome — killswitch nie może być zmienialny bez restartu
  z powodów audytowych.
- HTTP `423` wybrany celowo, żeby odróżnić „zablokowane polityką" od `401`
  (brak auth) i `403` (brak uprawnień).

**`TRADING_MODE` (`shadow` / `advisory` / `autonomous`) NIE jest częścią
tej decyzji.** Wchodzi w Fazie 8 (Autonomous Paper Trading). Faza 1
świadomie pomija ten env, żeby nie budować niedokończonej semantyki.

### 3.4 Domyślna blokada MKT

Wszędzie w `execution-engine`:

- Usunięty `.default('MKT')` z `ticketSchema.orderType`. `orderType` staje
  się jawnie wymaganym polem walidacji Zod.
- Nowy validator `assertOrderTypeAllowed(ticket, config)`:
  gdy `ticket.orderType === 'MKT'` i `EXECUTION_ALLOW_MKT !== true` → `400`.
- `EXECUTION_ALLOW_MKT=false` jest defaultem. Włączenie flagi jest jawnym
  opt-inem operatora (najczęściej dla emergency close / bailout tools).
- Audyt użyć MKT w signal-engine i strategies wykonywany w PR5;
  wynik → `PHASE_1_REPORT.md`. Signal-engine nie jest modyfikowany
  w Fazie 1 (out of scope Execution Security); ewentualny konflikt
  z MKT block ujawnia się jako `400` na granicy execution-engine.

**Uzasadnienie:** MKT w płynnych, niskospreadowych papierach jest OK; MKT
domyślny w każdej ścieżce jest niebezpieczny, bo:

- w rzadko handlowanych papierach (WSE small-cap) daje slippage rzędu
  1-3 % nawet dla małych zleceń,
- w extended-hours (US pre/post) MKT często dostaje 200-500 bps gorsze
  fill niż mid,
- MKT ignoruje `EXECUTION_BLOCK_OUTSIDE_US_RTH` guard po stronie kliencie —
  broker akceptuje.

### 3.5 Domyślna blokada direct-ticket (`persist=false`)

`POST /execution/execute-ticket` z `persist=false` pozostaje w kodzie
za feature-flagiem `EXECUTION_ALLOW_DIRECT_TICKET`:

- Default: `false` → wszystkie requesty z `persist=false` → `403`
  z `reason='direct_ticket_disabled'`.
- `true` → wymaga jawnego `decisionSource='user_override'` w body;
  wszystkie użycia generują alert `SAFETY:DIRECT_TICKET_USED`
  (**severity CRITICAL** — patrz 2.7).
- Guard belt-and-suspenders w `tws-execution-client.ts` w `placeSignalOrder`:
  ticket bez `proposedOrderId` w `IBKR_ENVIRONMENT=live` bez opt-inu →
  throw (drugi punkt odmowy, nawet gdyby ktoś obszedł handler-level guard).

**Dlaczego zostawiamy tę ścieżkę zamiast całkowicie usunąć:**

- Operator potrzebuje mechanizmu do emergency close pozycji, gdy signal-engine
  jest wyłączony lub uszkodzony.
- Wymuszenie audytu (`CRITICAL` alert + wpis do `system_alerts` + Telegram)
  sprawia, że każde użycie jest natychmiast widoczne.
- Domyślny `false` gwarantuje, że w normalnym stanie ścieżka nie istnieje
  z punktu widzenia atakującego (endpoint istnieje, ale odpowiada 403).

### 3.6 Split `/health` vs `/ready`

- `GET /health` — **liveness**. Zwraca `200` tak długo, jak proces
  Node żyje i Fastify odpowiada. Używany przez Docker `HEALTHCHECK` i
  zewnętrzne monitory dostępności.
- `GET /ready` — **readiness**. Zwraca `200` tylko jeżeli:
  - broker socket up,
  - `activeAccountId` znany i pasuje do whitelisty odpowiadającej
    `IBKR_ENVIRONMENT`,
  - `execution_audit_log` write dostępny (INSERT sanity),
  - ostatni reconciliation < `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`
    (default 900 s).
- **`TRADING_ENABLED=false` w live NIE powoduje 503.** `/ready` zwraca `200`
  z body zawierającym jawne pole `tradingEnabled: false`:

  ```json
  {
    "ready": true,
    "environment": "live",
    "tradingEnabled": false,
    "account": "...",
    "reconciliation": { "ageSeconds": 42, "maxAgeSeconds": 900 }
  }
  ```

  Konsument (UI, orchestrator) odróżnia dwa stany:
  - `ready === true && tradingEnabled === true` — gotowy do handlu.
  - `ready === true && tradingEnabled === false` — system żyje i wie, że
    jest wyłączony administracyjnie.

  To rozróżnienie jest istotne dla przyszłej Fazy 8 (Autonomous Paper
  Trading) i uniknięcia zbędnych alertów operacyjnych, gdy system jest
  celowo w trybie „nie handluj".

- `/health` bez autoryzacji (`Bearer` niewymagany).
- `/ready` **wymaga autoryzacji** — może zdradzić czy account jest znany,
  czy audit log DB działa, itp.

### 3.7 `execution_audit_log`

Nowa tabela w bazie `ikbr_trader`. Idempotent `CREATE TABLE IF NOT EXISTS`
w `apps/execution-engine/src/repository.ts` w istniejącym `init()`.

Schema:

```sql
CREATE TABLE IF NOT EXISTS execution_audit_log (
  id                bigserial PRIMARY KEY,
  ts                timestamptz NOT NULL DEFAULT now(),
  correlation_id    uuid NOT NULL,
  route             text NOT NULL,
  method            text NOT NULL,
  actor_kind        text NOT NULL,   -- 'unauthenticated' | 'authenticated'
  token_fingerprint text,            -- sha256(token) — pierwsze 12 znaków hex
  ip                text,
  request_hash      text,            -- sha256(body) — do audytu bez wycieków
  outcome           text NOT NULL,   -- 'ALLOW' | 'DENY_AUTH' | 'DENY_GUARD' | 'ERROR'
  reason            text
);
CREATE INDEX IF NOT EXISTS idx_exec_audit_ts ON execution_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_exec_audit_correlation ON execution_audit_log (correlation_id);
```

Zasady:

- Wpis dodawany dla **każdego** requestu na endpoint mutujący (niezależnie
  od outcome — auth failure też trafia do audytu).
- **Nigdy** nie zapisujemy: tokenu w plaintext, ciała requestu, PII.
  Zapisujemy fingerprint (12 hex) + hash body (sha256 hex).
- Correlation ID:
  - Jeżeli klient przekazał `X-Correlation-ID` (UUID) — używamy.
  - W przeciwnym razie generujemy nowy UUID i zwracamy w response header.
- **Brak retention / cleanup w Fazie 1.** Świadome (decyzja D8):
  retention policy trafia do osobnej fazy observability. W Fazie 1
  akceptujemy ryzyko wzrostu tabeli (ryzyko P1.R6 w PHASE_1_PLAN.md §12);
  operator monitoruje rozmiar tabeli w `PHASE_1_REPORT.md`.
- Nowy alert `SAFETY:AUTH_FAILURE_BURST` gdy ≥3 nieudane auth w 60 s
  (idempotentny w oknie 60 s).
- Nowy alert `SAFETY:DIRECT_TICKET_USED` z `severity='CRITICAL'`:
  - trafia do `system_alerts` (INSERT),
  - **i** do Telegram niezależnie od `ALERT_MIN_SEVERITY` (`CRITICAL`
    zawsze dochodzi),
  - bez rate-limitu — każde użycie flagi to jawny incident.
  Wymaga rozszerzenia enumu `severity` w `alerts.ts` o `'CRITICAL'`.

### 3.8 Rozłożenie egzekwowania na kolejne PR-y (PR1..PR6)

Cała powyższa polityka jest wdrażana w **sześciu** sekwencyjnych PR-ach
w ramach Fazy 1, a **nie** jednym dużym commitem:

- **PR1 (config schema).** Tylko definicje envów, walidacja Zod
  cross-field, testy jednostkowe konfiguracji. Runtime **niczego** nie
  blokuje. Powód: dopuszczenie deploy-u samych envów i sprawdzenie
  w środowisku dev, że schemat nie odrzuca poprawnej konfiguracji, zanim
  jakikolwiek endpoint zacznie fail-closed.
- **PR2 (bind + auth + audit).** Zmiana `EXECUTION_BIND_HOST`, middleware
  Bearer, `execution_audit_log`. Klienci wewnętrzni w tym samym PR
  dołączają nagłówek. Powód: to jest **atomowy** krok — nie można wypuścić
  auth bez zmiany klientów, ani zmiany klientów bez auth (jedno bez
  drugiego wywali produkcję albo zostawi dziurę).
- **PR3 (env guards + /ready).** `TRADING_ENABLED`, whitelisty
  account↔env, split `/health` vs `/ready`. Powód: guardy zależą od
  faktycznego numeru konta z `reqManagedAccts`, który przychodzi po
  connect'cie — musi być po PR2 (żeby endpoint miał sens tylko
  z auth).
- **PR4 (direct-ticket flag).** Wyłączenie `persist=false`
  za `EXECUTION_ALLOW_DIRECT_TICKET`, alert `CRITICAL`. Powód: to jest
  osobna decyzja produktowa, warta osobnego review — miksowanie
  jej z PR3 zwiększyłoby powierzchnię code-review.
- **PR5 (MKT default).** Zamiana domyślnego `orderType` na `LMT`,
  wymóg opt-inu na MKT. Powód: dotyka `ticketSchema` i ma osobne testy
  regresyjne strategii; separuje ryzyko od PR2/PR3.
- **PR6 (root scripts + docs).** `pnpm test`, `pnpm typecheck`,
  `pnpm security-check`, hostile checklists, aktualizacja README/AGENTS.
  Powód: dokumentacja + workflow lepiej trafiają na koniec, kiedy
  faktyczne endpointy są już w docelowym kształcie.

Każdy PR musi przejść `build + typecheck + test` przed mergem i ma osobną
hostile-safety checklistę w [PHASE_1_PLAN.md](../implementation/PHASE_1_PLAN.md)
§11. Rollout w tej kolejności eliminuje okno "auth wprowadzone, klienci
nieaktualni" (P0.R1 w PHASE_1_PLAN.md §12) — właściwie takie okno w ogóle
nie istnieje, bo PR2 jest atomowy pod tym względem.

---

## 4. Konsekwencje

### 4.1 Pozytywne

- **Fail-closed:** każda ścieżka, w której brakuje jednoznacznej autoryzacji
  lub uprawnienia, zwraca błąd i nie wykonuje operacji brokerowej.
- **Auditowalność:** każdy write-request (nawet odrzucony) trafia do
  `execution_audit_log` z fingerprintem tokenu, correlation ID, wynikiem
  i powodem. Post-mortem staje się deterministyczny.
- **Weryfikowalność live/paper:** niemożliwe jest przypadkowe wysłanie
  zlecenia na live account, jeżeli `IBKR_ENVIRONMENT=paper`
  (i vice versa) — nawet gdy port `IB_SOCKET_PORT` byłby przełączony.
- **Zgodność z AGENTS.md:** wszystkie safety rules („never bypass proposal
  flow", „never submit directly to live accounts", „every execution must
  be auditable") mają egzekutywę na warstwie HTTP.
- **Minimalny blast radius zmian:** brak modyfikacji logiki tradingowej,
  wskaźników, strategii. Execution Engine pozostaje mechaniczny
  (patrz PHASE_1_PLAN.md §3, reguła A2).

### 4.2 Negatywne / koszty

- **Skoordynowany deploy PR2:** merge musi objąć jednocześnie
  `execution-engine` + wszystkich klientów wewnętrznych. Brak soft-mode
  oznacza brak marginesu na desynchronizację (decyzja D5, ryzyko P1.R1
  w PHASE_1_PLAN.md § 12).
- **Rotacja tokenu wymaga restartu 4 serwisów.** Faza 1 nie dostarcza
  `EXECUTION_API_TOKEN_PREVIOUS` — rotacja bez okna niedostępności to
  scope Fazy 2 (Reliability).
- **Wzrost `execution_audit_log` bez limitu.** Świadome (D8). Dla
  hobbystycznego wolumenu (~kilka-kilkadziesiąt zleceń dziennie) rząd
  wielkości MB/rok — akceptowalne do wprowadzenia retention w fazie
  observability.
- **Nowy typ błędu `423 Locked`** wymaga świadomej obsługi po stronie UI
  i llm-agenta (semantycznie ≠ 401 ≠ 403).
- **`ALLOW_MKT=false` domyślnie** wymaga audytu strategii signal-engine
  produkujących MKT (PR5). Jeżeli któraś strategia obecnie się na to
  polega — trzeba świadomie ustawić flagę i wpisać uzasadnienie do raportu
  (patrz ryzyko P1.R4 w PHASE_1_PLAN.md §12).

### 4.3 Ryzyka rezydualne po Fazie 1

Nie zamykane w Fazie 1, przechodzą do backlogu / kolejnych faz:

- Brak idempotency keys → duplikat placeOrder możliwy przy retry (Faza 2).
- Brak `reqGlobalCancel` po stronie brokera → nie ma one-click emergency
  cancel-all (Faza 3).
- Brak Decision Engine → llm-agent nadal wywołuje `execution-engine`
  bezpośrednio (Faza 5).
- Brak retention `execution_audit_log` (observability phase).
- Brak wielu tokenów per klient / rotacji online (Faza 2+).
- Brak Prometheus / OTLP (observability phase).

---

## 5. Alternatywy rozważane i odrzucone

### 5.1 mTLS zamiast Bearer

**Odrzucone.** Wprowadza znaczącą złożoność (rotacja cert, cert store, CA)
przy porównywalnym poziomie bezpieczeństwa w scenariuszu single-host
Docker. Bearer + jednolity token dla wszystkich klientów (Faza 1) +
HTTPS na front-proxy w produkcji daje wystarczający poziom przy dużo
niższym koszcie operacyjnym.

### 5.2 Wspólna lista `ALLOWED_ACCOUNT_IDS`

**Odrzucone.** Jedna lista wymaga dodatkowej metadany „które konto na
którym środowisku" i zwiększa ryzyko błędu konfiguracyjnego. Dwie osobne
listy odpowiadające `IBKR_ENVIRONMENT` są prostsze i strukturalnie
zapobiegają błędnej klasyfikacji.

### 5.3 `TRADING_ENABLED` w bazie zamiast env

**Odrzucone dla Fazy 1.** Killswitch w DB wymaga polling / cache
invalidation. Env + restart procesu jest deterministyczny, audytowalny
(zmiana wymaga zmiany deploymentu), i wystarczający dla obecnej skali.
Wprowadzenie DB-based killswitcha to potencjalna Faza 3 (Order Lifecycle
+ Kill Switch).

### 5.4 Soft-mode auth przez pierwsze 24h

**Odrzucone (decyzja D5).** Soft-mode zwiększa ryzyko niekompletnego
wdrożenia — jeśli któryś klient zapomni dołączać token, auth przechodzi
w cichości. Twarda enforcement zmusza do deployu wszystkich klientów
jednocześnie i ujawnia niedoskonałości natychmiast.

### 5.5 `/ready` → 503 gdy `TRADING_ENABLED=false`

**Odrzucone (decyzja D7).** Byłoby to mylące dla orchestrator'a i UI:
system żyje i jest technicznie gotowy, tylko operacyjnie wyłączony.
Zamiast semantycznie sprzecznego 503 zwracamy 200 z jawnym polem
`tradingEnabled: false`, żeby konsument mógł jednoznacznie odróżnić
awarię (503) od stanu „wyłączony celowo" (200 + `tradingEnabled: false`).

### 5.6 Automatic retention policy w PR2

**Odrzucone (decyzja D8).** Retention wymaga polityki (co przechowywać,
przez jak długo, dla jakich outcome), której nie chcemy prowizorycznie
kodować pod presją Fazy 1. Trafia do osobnej fazy observability razem
z Prometheus / OTLP i schematem retencji per kategoria danych.

### 5.7 Usunięcie `execute-ticket persist=false` w całości

**Odrzucone.** Emergency close ścieżka jest potrzebna. Feature-flag
`EXECUTION_ALLOW_DIRECT_TICKET=false` z default off + wymaganym
`user_override` + `CRITICAL` alertem daje lepszy kompromis niż całkowite
usunięcie: mechanizm zostaje, ale nie może być użyty bez świadomej
decyzji operatora, która natychmiast pojawia się w audycie i na Telegramie.

---

## 6. Konsekwencje dla kolejnych faz

- **Faza 2 (Reliability):** wprowadzi idempotency keys i
  `EXECUTION_API_TOKEN_PREVIOUS` do rotacji online. Struktura tokenu
  z Fazy 1 (Bearer + fingerprint w audit logu) jest bezpośrednio
  kompatybilna.
- **Faza 3 (Order Lifecycle):** doda broker-side kill-switch
  (`reqGlobalCancel`) i cancel-all. `TRADING_ENABLED=false` z Fazy 1
  pozostaje HTTP-level gate; kill-switch broker-level to nowa warstwa.
- **Faza 4 (Instrument Registry):** wprowadzi per-instrument `riskProfile`
  (`maxPositionSize`, `maxLeverage`, `allowOvernight`, `maxSpread`,
  `maxSlippage`). Faza 1 nie może wprowadzać żadnych hardcoded
  per-instrument regułek w `execution-engine` konfliktowych z riskProfile
  (patrz PHASE_1_PLAN.md §3 A3).
- **Faza 5 (Decision Engine):** odetnie llm-agenta od execution-engine.
  `execution_audit_log` z Fazy 1 pozostaje kompatybilny — dodane zostanie
  tylko nowe pole `decision_id` (nullable, backfill = NULL dla
  historycznych wpisów).
- **Faza 8 (Autonomous Paper Trading):** doda `TRADING_MODE`
  (`shadow` / `advisory` / `autonomous`). `/ready` już zwraca
  `tradingEnabled` — dorzucenie `tradingMode` do body będzie
  addytywne, nie breaking change.

---

## 7. Referencje

- [AGENTS.md](../../AGENTS.md) — safety rules, source-of-truth policy.
- [ROADMAP.md](../implementation/ROADMAP.md) — Phase 1 scope.
- [PHASE_0_PLAN.md](../implementation/PHASE_0_PLAN.md) — architecture
  baseline, target pipeline, north-star.
- [PHASE_1_PLAN.md](../implementation/PHASE_1_PLAN.md) — implementacja
  tego ADR w podziale na PR1–PR6.
- OWASP ASVS 4.0 §V2.1 (Authentication) — Bearer token best practices.
- [RFC 4918 §11.3](https://datatracker.ietf.org/doc/html/rfc4918#section-11.3)
  — HTTP `423 Locked` semantics.
