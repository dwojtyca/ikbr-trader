# PHASE 1 PLAN — Execution Security

> **Zakres Fazy 1** (za [ROADMAP.md](ROADMAP.md)):
> API authentication • localhost by default • Paper/Live verification •
> Remove unsafe execution paths • Disable default market orders
>
> **Faza 1 nie wprowadza:** idempotency (Faza 2), Decision Engine (Faza 5),
> Market Context Engine (Faza 6), Instrument Registry (Faza 4).
> Faza 1 **utwardza istniejące bramki**, nie przebudowuje architektury.
>
> **Ten dokument NIE implementuje kodu.** Wymaga akceptacji przed startem PR1.

Data: 2026-07-10
Bazuje na: [PHASE_0_PLAN.md](PHASE_0_PLAN.md) (§9 §10 §19 §20)
Konstytucja: [../../AGENTS.md](../../AGENTS.md)

---

## 1. Cel Fazy 1

Wprowadzić minimalne, deterministyczne bramki bezpieczeństwa dla wszystkich
write-path’ów w `execution-engine` tak, aby:

1. **Żaden nieautoryzowany klient** nie mógł złożyć / anulować zlecenia w IBKR.
2. **Żaden klient wewnętrzny** (llm-agent, signal-engine, UI proxy) nie mógł
   nawiązać połączenia z `execution-engine` bez ważnego Bearer tokenu.
3. **Żaden request** z akcją mutującą nie mógł wykonać się, jeżeli aktywne
   konto IBKR nie pasuje do środowiska (`IBKR_ENVIRONMENT` + odpowiednia
   whitelista).
4. **Żadne write endpointy** nie mogły ominąć proposal flow, kill-switcha,
   ani zabezpieczeń środowiska — **z jednym wyjątkiem** za flagą
   `EXECUTION_ALLOW_DIRECT_TICKET=true`, jawnie audytowaną.
5. **Domyślny typ zlecenia MKT** został usunięty — każdy ticket musi jawnie
   wskazać `orderType`.

**Zasada nadrzędna (decyzja architektoniczna, sekcja 3):** Execution Engine
**nigdy** nie podejmuje decyzji biznesowych. Wszystkie zmiany w Fazie 1 są
walidacją, autoryzacją, synchronizacją lub odrzuceniem — nigdy nie
wprowadzają logiki „czy warto handlować”.

---

## 2. Non-goals Fazy 1

Wyraźnie **poza** Fazą 1:

- Idempotency keys / retry policy (→ Faza 2).
- Rebuild / modify / partial close / cancel-all / broker-side global kill
  switch przez `reqGlobalCancel` (→ Faza 3).
- Instrument Registry i migracja z `WATCHLIST_SYMBOLS` (→ Faza 4).
- Decision Engine, odcięcie llm-agenta od execution-engine (→ Faza 5).
- Market Context Engine, snapshot builder (→ Faza 6).
- **`TRADING_MODE` (`shadow` / `advisory` / `autonomous`) — potrzebne dopiero
  w Fazie 8 (Autonomous Paper Trading). Faza 1 nie wprowadza tego envu ani
  nie zmienia semantyki działania.**
- ESLint / static analysis (odłożone, patrz PHASE_0 §19 D2).
- Prometheus metrics, OTLP tracing (Observability faza po Fazie 1).
- **Retention / cleanup `execution_audit_log`** — Faza 1 tylko tworzy tabelę
  i pisze; retention policy w osobnej fazie observability.
- **Soft-mode dla auth** — brak. `execution-engine` egzekwuje Bearer token
  bezwarunkowo od PR2 (patrz sekcja 4 D5). Rollout klientów wewnętrznych
  koordynowany deploymentowo, nie feature-flagą.
- Konsolidacja SQL do `002_migration_*.sql` (osobna faza porządkowa).

---

## 3. Wpływ na docelowy pipeline

Docelowy pipeline (zaktualizowany po akceptacji PHASE_0_PLAN.md §14):

```
Signal Engine
    → Market Context Engine    (deterministyczny snapshot dla AI)
        → Decision Engine      (agreguje sygnały + kontekst + alokację)
            → Risk Engine      (deterministyczna, ostatnia bramka)
                → Execution Engine   (jedyny writer do IBKR)
```

**Reguła immutable:** `Execution Engine` jest **czysto mechaniczny** —
jedyne operacje jakie mu wolno wykonać to:

| Operacja | Dozwolona? |
| --- | --- |
| `validate` (schema, tick, RTH, whitelist, kill-switch, positionEffect) | ✅ TAK |
| `execute` (`ib.placeOrder`, `ib.cancelOrder` na już zwalidowanym tickecie) | ✅ TAK |
| `synchronize` (`reqAccountUpdates`, `reqExecutions`, reconciliation) | ✅ TAK |
| `reject` (odrzucenie ticketu z audytowanym powodem) | ✅ TAK |
| „decydować czy warto grać sygnałem” | ❌ NIE |
| liczyć wskaźniki, regime, alokację | ❌ NIE |
| wołać AI / OpenAI / Marketaux | ❌ NIE |
| pobierać newsy, event calendar, macro | ❌ NIE |

**Konsekwencja dla Fazy 1:** wszystkie nowe guardy w `execution-engine` mogą
tylko **odrzucać** (albo przepuszczać) tickety — nigdy nie mogą modyfikować
zawartości ticketu na podstawie „inteligentnej” heurystyki. Guard = boolean
+ powód odrzucenia. Zabronione są np. „automatyczne dopasowanie ilości do
limitu”, „automatyczne przełączanie MKT → LMT” itp.

**Instrument Registry (Faza 4)** będzie zawierał `riskProfile`
(`maxPositionSize`, `maxLeverage`, `allowOvernight`, `maxSpread`,
`maxSlippage`). Faza 1 **musi nie zamknąć drogi** do tego — nie kodujemy
nowych hardcoded regułowo-instrumentowych limitów w `execution-engine`
poza globalnymi `EXECUTION_MAX_*` które już istnieją.

---

## 4. Decyzje odziedziczone z PHASE_0_PLAN.md §19 (D1–D4)

| ID | Decyzja | Zastosowanie w Fazie 1 |
| --- | --- | --- |
| D1 | `EXECUTION_ALLOW_DIRECT_TICKET=false` default; `persist=false` za flagą | PR4 |
| D2 | Faza 1 wymaga tylko `build` / `typecheck` / `test`; ESLint odłożony | PR6 |
| D3 | `Authorization: Bearer <EXECUTION_API_TOKEN>` na `execution-engine` | PR2 |
| D4 | `ALLOWED_PAPER_ACCOUNTS` + `ALLOWED_LIVE_ACCOUNTS` (dwa envy CSV) | PR3 |

Trzy nowe decyzje architektoniczne (świeżo zatwierdzone przez operatora):

| ID | Decyzja | Zastosowanie w Fazie 1 |
| --- | --- | --- |
| A1 | Docelowy pipeline: Signal → **Market Context** → Decision → Risk → Execution | Zapisane w sekcji 3; brak zmian w kodzie w Fazie 1 (Market Context to Faza 6) |
| A2 | Execution Engine nigdy nie podejmuje decyzji biznesowych — tylko validate/execute/synchronize/reject | Reguła weryfikowana w architecture review każdego PR-a Fazy 1 (patrz sekcja 11.3) |
| A3 | Instrument Registry zawiera `riskProfile` (`maxPositionSize`, `maxLeverage`, `allowOvernight`, `maxSpread`, `maxSlippage`) | Faza 1 nie tworzy Instrument Registry, ale nie może wprowadzać per-instrument regułek konfliktowych z A3 |

Cztery decyzje szczegółowe rozstrzygnięte przy akceptacji planu
(**dawne Q1–Q4**):

| ID | Decyzja | Zastosowanie w Fazie 1 |
| --- | --- | --- |
| D5 | **`execution-engine` egzekwuje auth bezwarunkowo od PR2**; brak `EXECUTION_AUTH_ENFORCE`, brak soft mode | PR2 |
| D6 | Alert `DIRECT_TICKET_USED` idzie do **`system_alerts` + Telegram** z **`severity='CRITICAL'`** | PR4 + PR2 (nowa kategoria w `alerts.ts`) |
| D7 | `/ready` zwraca **200** także gdy `TRADING_ENABLED=false`; w response body wystawione jawne pole `tradingEnabled: false` | PR3 |
| D8 | **Brak retention / cleanup `execution_audit_log` w Fazie 1** | Ryzyko P1.R6 przyjęte świadomie — cleanup w osobnej fazie observability |

**Referencja architektoniczna:** [ADR-001 Execution Security](../adr/ADR-001-execution-security.md)
dokumentuje uzasadnienia D3–D8 i konsekwencje długoterminowe.

---

## 5. Zmiany konfiguracyjne (envs)

Nowe zmienne środowiskowe (wszystkie **czytane** w PR1, **egzekwowane** w
PR2–PR5). Wszystkie pojawiają się jednocześnie w [.env.example](../../.env.example)
i [docker-compose.yml](../../docker-compose.yml).

| Zmienna | Typ | Default | Serwis | Rola |
| --- | --- | --- | --- | --- |
| `IBKR_ENVIRONMENT` | `'paper'` \| `'live'` | `'paper'` | execution-engine | źródło prawdy o środowisku; nie może być inferowane z portu |
| `TRADING_ENABLED` | `'true'` \| `'false'` (strict) | `'false'` | execution-engine | master switch — write endpointy fail-closed gdy `false` w live |
| `ALLOWED_PAPER_ACCOUNTS` | CSV string | `''` | execution-engine | whitelist kont dozwolonych w `paper` |
| `ALLOWED_LIVE_ACCOUNTS` | CSV string | `''` | execution-engine | whitelist kont dozwolonych w `live` |
| `EXECUTION_BIND_HOST` | string | `'127.0.0.1'` | execution-engine | Fastify bind host |
| `EXECUTION_API_TOKEN` | string (min. 32 znaki, po decode >= 24B entropii) | **wymagane** gdy `IBKR_ENVIRONMENT=live` lub `TRADING_ENABLED=true` | wszystkie (execution-engine, signal-engine, llm-agent, ui) | wspólny Bearer token w Fazie 1 |
| `EXECUTION_ALLOW_MKT` | `'true'` \| `'false'` (strict) | `'false'` | execution-engine | pozwala na `orderType='MKT'`; w live zawsze fail-closed do jawnego opt-in |
| `EXECUTION_ALLOW_DIRECT_TICKET` | `'true'` \| `'false'` (strict) | `'false'` | execution-engine | pozwala `POST /execution/execute-ticket` z `persist=false` |
| `EXECUTION_READY_RECONCILIATION_MAX_AGE_S` | integer (sekundy) | `900` | execution-engine | wiek ostatniej reconciliation po którym `/ready` przełącza się w 503 (patrz PR3) |

**Uwaga (D5):** brak `EXECUTION_AUTH_ENFORCE`. Auth jest zawsze aktywna od
chwili merge'a PR2. Rollout klientów wewnętrznych koordynowany kolejnością
PR-ów i restartów, nie feature-flagą.

**Uwaga:** `TRADING_MODE` (`shadow` / `advisory` / `autonomous`) **nie**
jest wprowadzany w Fazie 1 — pojawi się w Fazie 8 (Autonomous Paper Trading).

**Zasada nazewnictwa i tokeny (Faza 1, ADR-001):** każdy serwis — zarówno
execution-engine, jak i jego klienci wewnętrzni (llm-agent, signal-engine,
ui) — czyta tę samą zmienną `EXECUTION_API_TOKEN`. W Fazie 1 wszystkie
klienty MUSZą używać tej samej wartości co serwer. Osobne tokeny
per klient / rotacja niezależna wymagają multi-token auth po stronie
serwera i pojawią się w późniejszej fazie.

**Boolean envs (strict):** wszystkie boolean-flag envy z Fazy 1
(`TRADING_ENABLED`, `EXECUTION_ALLOW_MKT`, `EXECUTION_ALLOW_DIRECT_TICKET`)
akceptują **wyłącznie** dokładny string `'true'` lub `'false'`. Każda inna
wartość (np. `'True'`, `'1'`, `'yes'`, pusta) = ZodError przy starcie.
Zapobiega niejednoznacznościom typu `'True'` czy `'yes'` w środowiskach
live.

---

## 6. Struktura PR-ów

Sześć PR-ów, sekwencyjnie. Każdy PR musi przejść **`build + typecheck +
test`** przed mergem. Każdy PR ma osobny hostile review checklist w sekcji 11.

### 6.1 PR1 — Config schema + envs (no-op runtime)

**Cel:** wprowadzić wszystkie nowe zmienne środowiskowe i ich walidację
w Zod, **bez** egzekwowania. Kod czyta i loguje; jeszcze niczego nie blokuje.

**Pliki modyfikowane:**

- [apps/execution-engine/src/config.ts](../../apps/execution-engine/src/config.ts)
  — nowe pola:
  - `IBKR_ENVIRONMENT`, `TRADING_ENABLED`,
  - `ALLOWED_PAPER_ACCOUNTS`, `ALLOWED_LIVE_ACCOUNTS` (parsowane do `readonly string[]`),
  - `EXECUTION_BIND_HOST`, `EXECUTION_API_TOKEN`,
  - `EXECUTION_ALLOW_MKT`, `EXECUTION_ALLOW_DIRECT_TICKET`,
  - `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`.
- [apps/llm-agent/src/config.ts](../../apps/llm-agent/src/config.ts)
  — nowe pole `EXECUTION_API_TOKEN` (wspólna nazwa z serwerem, ADR-001).
- [apps/signal-engine/src/config.ts](../../apps/signal-engine/src/config.ts)
  — nowe pole `EXECUTION_API_TOKEN` (wspólna nazwa z serwerem, ADR-001).
- [apps/ui/vite.config.ts](../../apps/ui/vite.config.ts) — **bez zmian w PR1**;
  integracja `configure` hooka z tokenem należy do PR2, które dopisuje
  częściowy diff w tym samym pliku razem z faktycznym dołączaniem nagłówka.
- [.env.example](../../.env.example) — sekcja „Execution Security"
  z komentarzami o defaultach.
- [docker-compose.yml](../../docker-compose.yml) — propagacja envów do
  serwisów `execution-engine`, `llm-agent`, `signal-engine`, `ui`.

**Walidacje Zod (kluczowe):**

- Jeżeli `IBKR_ENVIRONMENT === 'live'` **lub** `TRADING_ENABLED === true` →
  `EXECUTION_API_TOKEN` obowiązkowe i długość ≥ 32.
- Jeżeli `IBKR_ENVIRONMENT === 'live'` → `ALLOWED_LIVE_ACCOUNTS` **nie może**
  być pusta.
- Jeżeli `IBKR_ENVIRONMENT === 'paper'` → `ALLOWED_PAPER_ACCOUNTS` powinna
  być niepusta (warn, nie fail — bo nowa instalacja może jeszcze nie znać
  numeru).
- `EXECUTION_ALLOW_MKT === true` → warn w logu startowym
  (`"MKT allowed globally"`).
- `EXECUTION_ALLOW_DIRECT_TICKET === true` → warn w logu startowym z
  `SAFETY` prefix (`"DIRECT-TICKET ENABLED — unsafe path active"`).

**Zachowanie runtime:** żadnego blokowania. Endpointy działają jak przed
Fazą 1. Nowe pola tylko logowane w `structured startup summary`.

**Nowe testy:**

- `apps/execution-engine/src/config.test.ts` (nowy plik):
  - happy path paper defaults,
  - `live + brak tokenu` → throw,
  - `live + puste ALLOWED_LIVE_ACCOUNTS` → throw,
  - `MKT` warn,
  - `DIRECT_TICKET` warn.

**Acceptance PR1:**

- [ ] `pnpm -r build` przechodzi.
- [ ] `pnpm --filter @ikbr/execution-engine test` — nowe testy przechodzą.
- [ ] `pnpm --filter @ikbr/signal-engine test` — regresja nie występuje.
- [ ] Startup execution-engine loguje wszystkie nowe envy (bez wartości
  tokenu — tylko `tokenPresent: true/false`).
- [ ] `.env.example` uzupełniony.
- [ ] Compose ready — `docker compose config` wypluwa nowe envy.

### 6.2 PR2 — Bind host + auth middleware + audit log

**Cel:** ograniczyć bind Fastify do `127.0.0.1` domyślnie, wymusić Bearer
token, zapisać każde żądanie mutujące w audit logu.

**Pliki modyfikowane:**

- [apps/execution-engine/src/index.ts](../../apps/execution-engine/src/index.ts)
  — zmiana `app.listen({ port, host: '0.0.0.0' })` na
  `app.listen({ port, host: config.EXECUTION_BIND_HOST })`;
  dodanie `preHandler` weryfikującego Bearer token; hook `onRequest` który
  wpisuje audit rekord dla każdej ścieżki mutującej.
- [apps/execution-engine/src/repository.ts](../../apps/execution-engine/src/repository.ts)
  — nowa metoda `insertExecutionAuditLog(row)` + tworzenie tabeli
  `execution_audit_log` w `init()`.
- [apps/execution-engine/src/alerts.ts](../../apps/execution-engine/src/alerts.ts)
  — nowe kategorie alertów:
  - `AUTH_FAILURE_BURST` (≥3 fail/60s), `severity='warn'`.
  - `DIRECT_TICKET_USED` (przygotowane, użycie w PR4), `severity='CRITICAL'`
    (patrz D6). Sink: `system_alerts` **oraz** Telegram niezależnie od
    `ALERT_MIN_SEVERITY` (bo `CRITICAL` > wszystkie istniejące).
    Rozszerzyć enum `severity` w `alerts.ts` o `'CRITICAL'`.
- [apps/llm-agent/src/execution-api-client.ts](../../apps/llm-agent/src/execution-api-client.ts)
  — dołączenie `Authorization: Bearer <token>` do każdego request'u.
- [apps/signal-engine/src/repository.ts](../../apps/signal-engine/src/repository.ts)
  (w miejscu wywołania `GET /execution/account/summary`) — dołączenie tokenu.
- [apps/ui/vite.config.ts](../../apps/ui/vite.config.ts) — proxy
  `configure` hook: dołącz `Authorization: Bearer ${EXECUTION_API_TOKEN}`
  do wychodzącego requestu (server-side).

**Nowa tabela DB:**

```
CREATE TABLE IF NOT EXISTS execution_audit_log (
  id                bigserial PRIMARY KEY,
  ts                timestamptz NOT NULL DEFAULT now(),
  correlation_id    uuid NOT NULL,
  route             text NOT NULL,
  method            text NOT NULL,
  actor_kind        text NOT NULL,                 -- 'unauthenticated' | 'authenticated'
  token_fingerprint text,                          -- sha256(token) - pierwsze 12 znaków hex
  ip                text,
  request_hash      text,                          -- sha256(body) - do audytu bez wycieków
  outcome           text NOT NULL,                 -- 'ALLOW' | 'DENY_AUTH' | 'DENY_GUARD' | 'ERROR'
  reason            text
);
CREATE INDEX IF NOT EXISTS idx_exec_audit_ts ON execution_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_exec_audit_correlation ON execution_audit_log (correlation_id);
```

**Reguły middleware:**

- `GET /health` → **zawsze bez auth** (Docker healthcheck).
- Wszystkie pozostałe endpointy `/execution/*` → wymagany `Authorization: Bearer <token>`.
  - Brak nagłówka → `401` + `outcome='DENY_AUTH'`.
  - Zły token (constant-time compare) → `401` + `outcome='DENY_AUTH'` + counter
    `authFailureBurst` inkrementowany.
  - `authFailureBurst >= 3` w ostatnich 60s → alert `SAFETY:AUTH_FAILURE_BURST`
    (idempotencyjny w oknie 60s).
- Correlation ID:
  - Jeżeli klient przekazał `X-Correlation-ID` (UUID) → używamy.
  - W przeciwnym razie generujemy nowe UUID i zwracamy w response header.

**Zabezpieczenia:**

- Porównanie tokenu **constant-time** (`crypto.timingSafeEqual` po dopełnieniu
  długości), żeby uniknąć timing attack.
- Token **NIGDY** nie trafia do logów — logujemy tylko `tokenFingerprint`
  = `sha256(token).slice(0,12)`.
- `EXECUTION_BIND_HOST` domyślnie `127.0.0.1`; w `docker-compose.yml`
  ustawiamy **jawnie** `0.0.0.0` (żeby inne kontenery mogły się połączyć).
  Zabezpieczenie w Dockerze robi warstwa auth + brak port mappingu na
  hosta w kolejnych fazach.

**Nowe testy:**

- `apps/execution-engine/src/auth.test.ts`:
  - `GET /health` bez tokenu → 200,
  - `GET /execution/orders` bez tokenu → 401 + audit `DENY_AUTH`,
  - `GET /execution/orders` ze złym tokenem → 401 + audit `DENY_AUTH`,
  - `GET /execution/orders` z dobrym tokenem → 200 + audit `ALLOW`,
  - 3 kolejne złe tokeny w 60s → alert `AUTH_FAILURE_BURST` w `system_alerts`,
  - constant-time compare: token krótszy → 401 (bez ujawnienia długości),
  - `X-Correlation-ID` propaguje się do audit logu.

**Acceptance PR2:**

- [ ] `pnpm -r build` przechodzi.
- [ ] Wszystkie nowe testy przechodzą.
- [ ] `POST /execution/account/summary` z UI działa (proxy dokłada token).
- [ ] `POST /execution/execute-proposed/:id` z llm-agenta działa
  (klient dokłada token).
- [ ] `curl` bez tokenu → 401.
- [ ] `execution_audit_log` rośnie po każdym requeście na endpointy
  mutujące (i na ich fail'ach auth).

### 6.3 PR3 — Paper/Live guards + account whitelist

**Cel:** wymusić zgodność aktywnego konta IBKR ze środowiskiem oraz stan
`TRADING_ENABLED` przed każdym write-actionem.

**Pliki modyfikowane:**

- [apps/execution-engine/src/index.ts](../../apps/execution-engine/src/index.ts)
  — nowa funkcja `assertEnvironmentAllowsWrite(actor)` wywoływana w
  handlerach:
  - `POST /execution/execute-proposed/:id`,
  - `POST /execution/reject-proposed/:id` (**tak — reject też**, żeby brak
    środowiska nie pozostawiał niedokończonych stanów),
  - `POST /execution/cancel-proposed/:id`,
  - `POST /execution/execute-ticket`,
  - `POST /execution/bootstrap`.
- [apps/execution-engine/src/tws-execution-client.ts](../../apps/execution-engine/src/tws-execution-client.ts)
  — w `ensureBrokerSession()`:
  - po `reqManagedAccts` sprawdzamy, że `accountId ∈ whitelist(IBKR_ENVIRONMENT)`,
  - jeżeli nie → throw + `system_alerts` (`SAFETY:ACCOUNT_ENVIRONMENT_MISMATCH`),
  - łączenie z brokerem odbywa się, ale `bootstrap` zwraca `409` — nowe wołania
    write-endpointów widzą "not bootstrapped".

**Semantyka guardów (dokładnie):**

```
assertEnvironmentAllowsWrite:
  if IBKR_ENVIRONMENT === 'live':
    if TRADING_ENABLED !== true → 423 Locked, reason='live_trading_disabled'
    if activeAccountId ∉ ALLOWED_LIVE_ACCOUNTS → 423 Locked, reason='account_not_allowed_for_live'
  if IBKR_ENVIRONMENT === 'paper':
    if activeAccountId ∉ ALLOWED_PAPER_ACCOUNTS → 423 Locked, reason='account_not_allowed_for_paper'
  # Nie sprawdzamy portu. Port jest tylko wskazówką.
```

**HTTP kod 423 (Locked)** wybrany celowo — semantycznie odróżnia „zablokowane
polityką" od `403` (brak uprawnień) i `401` (brak auth). UI musi umieć
odróżnić trzy statusy.

**Nowy split `/ready` vs `/health`:**

- `GET /health` — liveness, zwraca 200 jeżeli proces żyje.
- `GET /ready` — readiness. Zwraca 200 (`ready: true`) tylko jeżeli:
  - broker socket up,
  - `activeAccountId` znany i pasuje do środowiska,
  - `execution_audit_log` write dostępny,
  - ostatni reconciliation < `EXECUTION_READY_RECONCILIATION_MAX_AGE_S` (nowe env, default 900s).
- **`TRADING_ENABLED=false` w live NIE powoduje 503** (decyzja D7).
  `/ready` zwraca `200` z body:
  ```json
  {
    "ready": true,
    "environment": "live",
    "tradingEnabled": false,
    "account": "...",
    "reconciliation": { "ageSeconds": 42, "maxAgeSeconds": 900 }
  }
  ```
  UI/orchestrator odróżnia „gotowy do handlu" (`ready && tradingEnabled`)
  od „system żyje ale wyłączony administracyjnie" (`ready && !tradingEnabled`).
- Docker `HEALTHCHECK` w [Dockerfile](../../Dockerfile) → nadal `/health`.
  `/ready` do konsumpcji przez orchestrator w kolejnych fazach.

**Nowe testy:**

- `apps/execution-engine/src/env-guard.test.ts`:
  - `IBKR_ENVIRONMENT=live` + `TRADING_ENABLED=false` + write → 423,
  - `IBKR_ENVIRONMENT=live` + `account ∉ ALLOWED_LIVE_ACCOUNTS` → 423,
  - `IBKR_ENVIRONMENT=paper` + `account ∉ ALLOWED_PAPER_ACCOUNTS` → 423,
  - `IBKR_ENVIRONMENT=paper` + happy path → 200,
  - port `4001` z paperowym kontem w whitelist paper → **200** (port ignorowany).

**Acceptance PR3:**

- [ ] Wszystkie write-endpointy zwracają 423 gdy `TRADING_ENABLED=false` w live.
- [ ] `system_alerts` zawiera `SAFETY:ACCOUNT_ENVIRONMENT_MISMATCH` przy próbie
  bootstrap'u paper account na live env.
- [ ] `GET /ready` istnieje i respektuje reconciliation staleness.
- [ ] Regresja: dotychczasowe happy path'y działają identycznie
  (`IBKR_ENVIRONMENT=paper` + konto whitelisted + `TRADING_ENABLED=true`).

### 6.4 PR4 — Unsafe path hardening (`execute-ticket persist=false`)

**Cel:** obwarunkować bezpośrednią ścieżkę ticketu za feature-flagiem
`EXECUTION_ALLOW_DIRECT_TICKET`.

**Pliki modyfikowane:**

- [apps/execution-engine/src/index.ts](../../apps/execution-engine/src/index.ts):
  - `POST /execution/execute-ticket` — logika:

    ```
    if body.persist !== false:
      # ścieżka domyślna: PROPOSED → SUBMITTED (bez zmian)
      proceed as before
    else:
      if !config.EXECUTION_ALLOW_DIRECT_TICKET:
        return 403 { reason: 'direct_ticket_disabled' }
      if body.decisionSource !== 'user_override':
        return 400 { reason: 'direct_ticket_requires_user_override' }
      insert system_alerts:
        category='SAFETY',
        code='DIRECT_TICKET_USED',
        details={ tokenFingerprint, actor, symbol, side, qty }
      proceed with direct place (jak dziś)
    ```

- [apps/execution-engine/src/tws-execution-client.ts](../../apps/execution-engine/src/tws-execution-client.ts)
  — dodatkowy guard **client-side** w `placeSignalOrder`:
  - jeżeli ticket nie ma `proposedOrderId` **i** `IBKR_ENVIRONMENT === 'live'`
    **i** nie ma `EXECUTION_ALLOW_DIRECT_TICKET=true` → throw
    (`refused: direct ticket in live without opt-in`).
  - Ten guard jest belt-and-suspenders — mieć drugi punkt odmowy nawet
    gdyby ktoś obszedł walidację w handlerze.

**Alert `DIRECT_TICKET_USED`** (per D6):

- Kategoria: `SAFETY`.
- **Severity: `CRITICAL`** (nowa wartość, dodana w PR2 do enum `severity`).
- **Sinki (oba, obowiązkowo):**
  1. `system_alerts` (INSERT z `severity='CRITICAL'`).
  2. Telegram — z pominięciem `ALERT_MIN_SEVERITY` (CRITICAL zawsze dochodzi).
- Rate-limit: **brak** — każde użycie musi być zaraportowane. To celowe:
  jeżeli ktoś obsługowo używa flagi, każdy taki request jest jawnym incidentem.
- Payload zawiera: `tokenFingerprint`, `actor`, `symbol`, `side`, `qty`,
  `correlation_id`, `ts`.

**Nowe testy:**

- `apps/execution-engine/src/direct-ticket.test.ts`:
  - `persist=false` + flaga off → 403,
  - `persist=false` + flaga on + `decisionSource≠user_override` → 400,
  - `persist=false` + flaga on + `user_override` → 200 + alert w `system_alerts`,
  - `persist=true` (default) → 200 (regresja),
  - tws-execution-client refuzuje w live bez opt-in.

**Acceptance PR4:**

- [ ] Domyślny stan (bez flagi) blokuje wszystkie `persist=false`.
- [ ] Każde użycie flagi generuje jawny alert.
- [ ] `pnpm build` + testy nowe + regresja.

### 6.5 PR5 — Disable default MKT + explicit orderType

**Cel:** usunąć default `MKT` w `ticketSchema.orderType`; wymagać jawnego
wskazania typu; `MKT` dopuszczalny tylko przy `EXECUTION_ALLOW_MKT=true`.

**Pliki modyfikowane:**

- [apps/execution-engine/src/index.ts](../../apps/execution-engine/src/index.ts):
  - `ticketSchema.orderType`: usunąć `.default('MKT')`, uczynić polem
    wymaganym w schemacie Zod.
  - Nowy validator `assertOrderTypeAllowed(ticket, config)`:

    ```
    if ticket.orderType === 'MKT' && !config.EXECUTION_ALLOW_MKT:
      throw HttpError(400, 'mkt_disallowed')
    ```

  - Guard uruchamiany w handlerach `execute-ticket` **i** `execute-proposed/:id`
    (bo proposed order też ma `orderType` — może być MKT z signal-engine).
- [apps/signal-engine/src/**](../../apps/signal-engine/src) — audyt: czy
  jakakolwiek strategia produkuje `orderType='MKT'`? Jeżeli tak — jawnie
  wypisać listę w `PHASE_1_REPORT.md`, ale **nie zmieniać** strategii w Fazie 1
  (strategie to nie zakres Execution Security). W praktyce blokada nastąpi na
  granicy execution-engine i strategia dostanie `400`.
- [apps/ui/src/App.tsx](../../apps/ui/src/App.tsx) — jeżeli UI ma formularz
  ticketu z placeholderem MKT, usunąć default; zrobić selector wymagany.
- [packages/shared/src/index.ts](../../packages/shared/src/index.ts) — typy
  `SignalTicket.orderType` już nie mają defaultu MKT (są to unijne literały);
  weryfikacja że wszędzie w kodzie jest jawny wybór.

**Nowe testy:**

- `apps/execution-engine/src/order-type-guard.test.ts`:
  - `orderType=MKT` + flag off → 400,
  - `orderType=MKT` + flag on → 200,
  - `orderType=LMT` → 200,
  - brak `orderType` w body → 400 (validation error).

**Ryzyko regresyjne:** Signal-engine, który dziś czasem produkuje MKT (np.
`emergency close`), musi być audytowany. Wynik audytu → sekcja `Findings`
w `PHASE_1_REPORT.md`.

**Acceptance PR5:**

- [ ] Nie ma nigdzie `.default('MKT')`.
- [ ] MKT wymaga jawnego opt-in.
- [ ] Testy przechodzą.
- [ ] Audyt use'ów `MKT` w signal-engine + strategies wykonany i wpisany
  do raportu.

### 6.6 PR6 — Root scripts + dokumentacja

**Cel:** dodać root skrypty `typecheck` i `test`; zaktualizować README i
`.env.example`.

**Pliki modyfikowane:**

- [package.json](../../package.json) — dodać:
  - `"typecheck": "pnpm -r --parallel --if-present typecheck"` (i per-workspace `typecheck` = `tsc -p tsconfig.json --noEmit` w każdym `apps/*/package.json` i `packages/shared/package.json`),
  - `"test": "pnpm -r --if-present test"`.
- [apps/execution-engine/package.json](../../apps/execution-engine/package.json),
  [apps/signal-engine/package.json](../../apps/signal-engine/package.json),
  [apps/ingestion/package.json](../../apps/ingestion/package.json),
  [apps/llm-agent/package.json](../../apps/llm-agent/package.json),
  [apps/backtest-engine/package.json](../../apps/backtest-engine/package.json),
  [apps/ui/package.json](../../apps/ui/package.json),
  [packages/shared/package.json](../../packages/shared/package.json) — dodać
  per-workspace `typecheck` script. Dla usług Node.js: `tsc -p tsconfig.json --noEmit`.
  Dla `ui` (Vite): `tsc -b tsconfig.app.json --noEmit`.
- [README.md](../../README.md) — nowa sekcja „Environment & Trading Policy"
  opisująca `IBKR_ENVIRONMENT`, `TRADING_ENABLED`, `ALLOWED_PAPER_ACCOUNTS`,
  `ALLOWED_LIVE_ACCOUNTS`, `EXECUTION_API_TOKEN`, `EXECUTION_ALLOW_MKT`,
  `EXECUTION_ALLOW_DIRECT_TICKET`. Sekcja „Development" — nowe `pnpm typecheck`
  i `pnpm test`.
- [.env.example](../../.env.example) — kompletny zestaw nowych envów
  z komentarzami.

**Nowe testy:** brak (to PR czysto konfiguracyjny + dokumentacyjny).

**Regresja:** `pnpm build` + `pnpm test` + `pnpm typecheck` przechodzą.

**Acceptance PR6:**

- [ ] `pnpm typecheck` przechodzi w root.
- [ ] `pnpm test` przechodzi w root (uruchamia signal-engine testy + nowe testy
  execution-engine dodane w PR1–PR5).
- [ ] README zaktualizowany.
- [ ] `.env.example` zaktualizowany.
- [ ] `pnpm lint` **NIE istnieje** i to jest intencjonalne (D2).

---

## 7. Kolejność implementacji i strategia mergowania

```
PR1 (envs, no-op)  ──► PR2 (auth + audit)  ──► PR3 (env guards + /ready)
                                                        │
                                                        ▼
                                                PR4 (direct-ticket flag)
                                                        │
                                                        ▼
                                                PR5 (MKT default off)
                                                        │
                                                        ▼
                                                PR6 (root scripts + docs)
```

**Zasady:**

- Każdy PR merguje się dopiero po przejściu wszystkich testów + code review.
- Po **każdym** merge PR-a: krótki sanity smoke test na paper account
  (bootstrap + jeden test ticket → cancel) — udokumentowany w
  `PHASE_1_REPORT.md`.
- **Auth egzekwowana bezwarunkowo od PR2** (D5). Brak soft-mode.
  Ryzyko rozjazdu klientów wewnętrznych mitigowane kolejnością PR-ów:
  - **PR1** — envy w kodzie tylko odczytywane (klienci mogą już mieć token
    w `.env`, ale nie muszą go używać).
  - **PR2** — merge `execution-engine` **razem** z aktualizacją
    `llm-agent/execution-api-client.ts`, `signal-engine/repository.ts`
    (getExposureSnapshot) oraz `ui/vite.config.ts`, w tym samym PR.
    Klienci zaczynają wysyłać token w tym samym commit'ie, w którym
    `execution-engine` zaczyna go wymagać. Deploy: `docker compose up -d
    --build` wymusza restart wszystkich serwisów jednocześnie.
  - Weryfikacja przed mergem PR2: lokalny `docker compose up` z tokenem
    ustawionym w `.env` — wszystkie 4 serwisy startują i handshake
    działa (test integracyjny w sekcji 10.3).

---

## 8. Nowe pliki (checklist)

- `apps/execution-engine/src/auth.ts` (nowy) — middleware `bearerAuth`
  i logika `buildAuditRecord`.
- `apps/execution-engine/src/env-guard.ts` (nowy) —
  `assertEnvironmentAllowsWrite`, `resolveAllowedAccounts`.
- `apps/execution-engine/src/order-type-guard.ts` (nowy) —
  `assertOrderTypeAllowed`.
- Testy:
  - `apps/execution-engine/src/config.test.ts`
  - `apps/execution-engine/src/auth.test.ts`
  - `apps/execution-engine/src/env-guard.test.ts`
  - `apps/execution-engine/src/direct-ticket.test.ts`
  - `apps/execution-engine/src/order-type-guard.test.ts`
- Dokumenty:
  - `docs/implementation/PHASE_1_REPORT.md` (po zakończeniu PR6).

---

## 9. Nowe / zmienione tabele DB

Jedyna nowa tabela: `execution_audit_log` (definicja w sekcji 6.2).

- Dodawana w `apps/execution-engine/src/repository.ts` w istniejącym
  `init()` (idempotent `CREATE TABLE IF NOT EXISTS`).
- Brak wpływu na istniejące tabele.
- Brak wpływu na `infra/sql/001_init.sql` w Fazie 1 (konsolidacja SQL to
  osobna faza).

**Nie tworzymy** w Fazie 1: `instrument_registry`, `decisions`, `market_context`,
`positions_events`, `risk_events`. Wszystko to jest zakresem późniejszych faz.

---

## 10. Plan testów (całościowy)

### 10.1 Testy jednostkowe (nowe)

- **config schema** — PR1 (patrz 6.1).
- **auth middleware** — PR2 (patrz 6.2). W tym constant-time compare
  (weryfikacja przez benchmark: 100 iteracji, wariancja czasu < 1ms).
- **audit log write** — PR2. Weryfikacja że fingerprint tokenu nie zdradza
  tokenu (tylko 12 hex, sha256).
- **env guard** — PR3 (patrz 6.3).
- **`/ready` composite** — PR3. Broker down / reconciliation stale / audit
  write fails → `/ready` = 503.
- **direct-ticket flag** — PR4 (patrz 6.4).
- **order-type guard** — PR5 (patrz 6.5).

### 10.2 Testy regresyjne

- Wszystkie istniejące testy w `apps/signal-engine` muszą przejść bez zmian.
- Smoke test paper: bootstrap → propose signal → llm-agent EXECUTE → order
  filled → reconciliation matches (wszystko z nowymi tokenami).

### 10.3 Testy „hostile" (wykonywane manualnie, zapisane w `PHASE_1_REPORT.md`)

Odpalane po każdym PR (2, 3, 4, 5), przed mergem:

1. `curl -X POST http://127.0.0.1:3103/execution/execute-proposed/1` → 401.
2. `curl -X POST -H "Authorization: Bearer wrong" ...` → 401 (audit).
3. 3× powyższe w 60s → alert w `system_alerts`.
4. `curl` z hosta na `execution-engine` binded na `127.0.0.1` (nie w Dockerze) → connection refused.
5. `IBKR_ENVIRONMENT=live` + `TRADING_ENABLED=false` + valid token → 423.
6. Zamiana `ALLOWED_PAPER_ACCOUNTS` na fałszywe konto → `/ready` = 503.
7. `persist=false` bez flagi → 403.
8. `persist=false` + flaga + `decisionSource=llm` (nie `user_override`) → 400.
9. `orderType=MKT` + flaga off → 400.
10. Brak `orderType` w body → 400.
11. Klient przekazuje `X-Correlation-ID` → jest w audit logu i response header.
12. **Token nigdy** nie występuje w `docker logs execution-engine`
    (weryfikacja: `grep` na logach po pełnym cyklu).

---

## 11. Reguła phase-gate — checklist Fazy 1

Zgodnie z PHASE_0_PLAN.md §20. Każdy z trzech review'ów zapisywany
w `PHASE_1_REPORT.md`.

### 11.1 Code Review checklist

- [ ] TypeScript strict, brak `any` bez `// eslint-disable-next-line` uzasadnienia.
- [ ] Wszystkie nowe endpointy mają Zod schema (Fastify `schema`).
- [ ] Nowe testy pokrywają każdy nowy guard (co najmniej po jednej ścieżce
  happy + jednej fail per guard).
- [ ] Brak dodanych `console.log` (używamy Fastify logger'a).
- [ ] Brak commitów z secretami (`git log --all -p | rg -i 'token|secret|password'` w PR review).
- [ ] `pnpm typecheck` + `pnpm test` + `pnpm build` przechodzą.
- [ ] Nowe pliki mają `// SPDX-License-Identifier` jeżeli używane w repo
  (do sprawdzenia w code review).
- [ ] Rozmiar PR-a: preferujemy < 400 LOC diff per PR (PR2 może być większy —
  auth + audit; wtedy split akceptowalny).

### 11.2 Hostile Safety Review — obowiązkowe pytania

Odpowiedzi w `PHASE_1_REPORT.md`:

- [ ] Czy mogę wykonać write na `execution-engine` bez tokenu? — **Odpowiedź spodziewana: nie (401).**
- [ ] Czy mogę użyć poprawnego tokenu, ale niedozwolonego konta live?
  — **Nie (423 + alert).**
- [ ] Czy `TRADING_ENABLED=false` w live rzeczywiście blokuje 100% write path'ów? — **Wymagany dowód: test dla każdego z 5 endpointów mutujących.**
- [ ] Czy port 4001 z paperowym kontem w whitelist paper przechodzi? — **Tak, port nie jest autorytatywny.**
- [ ] Czy `EXECUTION_ALLOW_DIRECT_TICKET=true` bez `user_override` przechodzi? — **Nie (400).**
- [ ] Czy MKT jest domyślny? — **Nie, wymagany jawny wybór.**
- [ ] Czy timeout w TWS jest interpretowany jako cancel? — **Nie (istniejący kod nie zmienia się w Fazie 1; weryfikacja przez code review).**
- [ ] Czy w audit logu, `system_alerts`, telegramach albo `docker logs` gdziekolwiek pojawia się nagi token? — **Nie (test grep w sekcji 10.3 pkt 12).**
- [ ] Czy `.env.example` zawiera realne wartości tokenów / kont? — **Nie (tylko placeholdery + komentarze).**
- [ ] Co się dzieje, gdy `execution-engine` restartuje w połowie `placeOrder`? — **Zachowanie bez zmian od Fazy 0 (obecne mechanizmy — reconciliation po restarcie). Faza 1 tego nie poprawia — to jest zakres Fazy 2 (Reliability).**

Jeżeli którakolwiek odpowiedź nie brzmi „bezpiecznie" — Faza 1 nie może być
zamknięta bez wpisu w `PHASE_1_REPORT.md` do backlog jako nowe ryzyko RN.

### 11.3 Architecture Review — obowiązkowe pytania

- [ ] Czy jakakolwiek zmiana w Fazie 1 wprowadza **decyzję biznesową**
  w `execution-engine`? — **Musi być: nie.** Reguła A2 (sekcja 4).
- [ ] Czy jakakolwiek zmiana zamyka drogę do Decision Engine (Faza 5)?
- [ ] Czy jakakolwiek zmiana zamyka drogę do Market Context Engine (Faza 6)?
- [ ] Czy jakakolwiek zmiana zamyka drogę do Instrument Registry (Faza 4),
  w szczególności do `riskProfile` (decyzja A3)?
- [ ] Czy wprowadzone limity (np. `authFailureBurst`) są konfigurowalne
  w env, nie hardcoded?
- [ ] Czy audit log nadaje się do przyszłego eksportu do dedykowanego event
  bus'a (Position/Risk Events z PHASE_0_PLAN.md §15)? — schema kompatybilna.

---

## 12. Ryzyka Fazy 1 (dodatkowo do R1–R9 z PHASE_0_PLAN.md §11)

| ID | Ryzyko | Skutek | Mitigacja |
| --- | --- | --- | --- |
| P1.R1 | Klient wewnętrzny (llm-agent) nie zdąży pobrać nowego tokenu i wpadnie w LLM `fail_closed=true` odrzucając wszystkie propozycje | Ruch produktowy staje | **Bez soft mode (D5).** Mitigacja: PR2 zawiera synchronicznie zmiany w `execution-engine` i wszystkich klientach; deploy = `docker compose up -d --build` wymusza restart wszystkich serwisów naraz; przed mergem wymagany lokalny handshake test (sekcja 10.3 pkt 1) |
| P1.R2 | Rotacja tokenów w produkcji wymaga skoordynowanego restartu 4 serwisów | okno awarii przy rotacji | Faza 1 udostępnia stały env; rotacja to zadanie Ops. Rekomendacja: dodać `EXECUTION_API_TOKEN_PREVIOUS` w Fazie 2 (accept 2 tokeny podczas rotacji) |
| P1.R3 | `EXECUTION_BIND_HOST=127.0.0.1` w kontenerze Docker sprawi, że inne kontenery nie połączą się | całkowita niedostępność execution-engine wewnętrznie | `docker-compose.yml` jawnie ustawia `EXECUTION_BIND_HOST=0.0.0.0` per serwis; test integracyjny sprawdza łączność między kontenerami |
| P1.R4 | Signal-engine emituje MKT na emergency close → PR5 zablokuje | emergency close nie zadziała | Audyt w PR5 (sekcja 6.5); jeżeli faktycznie występuje — decyzja: (a) włączyć `EXECUTION_ALLOW_MKT=true` do zamknięcia Fazy 1 z warning, (b) refactor signal-engine na LMT+STP — **decyzja operatora podczas PR5 review**. Nie blokuje Fazy 1. |
| P1.R5 | Constant-time compare pochłonie CPU dla ekstremalnie długich fałszywych tokenów | mikro DoS | limit długości tokenu w headerze do 256 znaków przed compare |
| P1.R6 | Audit log rośnie bez ograniczenia (potencjalnie GB/miesiąc) | koszty DB | retention policy poza scope Fazy 1; monitor rozmiaru tabeli w `PHASE_1_REPORT.md`. Cleanup w kolejnej fazie observability |
| P1.R7 | `/ready` przy uszkodzonym `execution_audit_log` write blokuje bootstrap | fail-closed przy uszkodzonej DB | pożądane zachowanie — safety over convenience |

---

## 13. Kryteria akceptacji Fazy 1

Faza 1 jest **zakończona**, gdy wszystkie poniższe są spełnione:

- [ ] Wszystkie 6 PR-ów zmergowane.
- [ ] `pnpm build` + `pnpm typecheck` + `pnpm test` przechodzą w root.
- [ ] Zerowe ostrzeżenia TypeScript w nowych plikach.
- [ ] Testy hostile (sekcja 10.3) przeprowadzone i zapisane w
  `PHASE_1_REPORT.md`.
- [ ] Trzy review'y (Code, Hostile Safety, Architecture) zapisane
  w `PHASE_1_REPORT.md` z odpowiedziami na wszystkie checklisty.
- [ ] `execution-engine` binduje się na `127.0.0.1` lokalnie i `0.0.0.0`
  w Dockerze; auth wymuszona (`EXECUTION_AUTH_ENFORCE=true`).
- [ ] Paper account nie może otworzyć w trybie live; live account nie może
  otworzyć w trybie paper. Fail-closed z alertem.
- [ ] `POST /execution/execute-ticket` z `persist=false` domyślnie 403.
- [ ] `orderType='MKT'` domyślnie 400.
- [ ] `execution_audit_log` zawiera wpis dla każdego request'u mutującego
  wykonanego podczas smoke testu.
- [ ] Telegram / `system_alerts` alertuje: (a) burst auth failures,
  (b) direct-ticket used, (c) account/environment mismatch.
- [ ] README + `.env.example` zaktualizowane.
- [ ] `PHASE_1_REPORT.md` istnieje z sekcjami: `Summary`, `Findings`,
  `Code Review`, `Hostile Safety Review`, `Architecture Review`, `Backlog`.

---

## 14. Aktualizacja `.env.example` — kompletny wpis (referencyjny)

Zapis do `docs/implementation/PHASE_1_PLAN.md` **jako referencja**;
faktyczne wprowadzenie do `.env.example` jest częścią PR1 (envs) i PR6
(dokumentacja).

```dotenv
# =====================================================
# Execution Security (Faza 1)
# =====================================================

# Środowisko brokera. Nigdy nie inferowany z portu.
# Wartości: paper | live
IBKR_ENVIRONMENT=paper

# Globalny master switch dla write-actionów. W live musi być = true,
# żeby złożyć jakiekolwiek zlecenie. /ready nadal 200 gdy false — patrz D7.
TRADING_ENABLED=false

# Whitelisty kont IBKR per środowisko (CSV).
# Fail-closed przy mismatchu account ↔ IBKR_ENVIRONMENT.
ALLOWED_PAPER_ACCOUNTS=DU1234567
ALLOWED_LIVE_ACCOUNTS=

# Bind host Fastify serwera execution-engine.
# Local dev: 127.0.0.1. Docker: 0.0.0.0 (i tak wewnątrz sieci docker).
EXECUTION_BIND_HOST=127.0.0.1

# Bearer token do wszystkich endpointów mutujących.
# Generowanie: openssl rand -hex 32
# Wymagane gdy IBKR_ENVIRONMENT=live lub TRADING_ENABLED=true.
EXECUTION_API_TOKEN=

# Feature flag: zezwól na orderType='MKT'. Default off.
EXECUTION_ALLOW_MKT=false

# Feature flag: zezwól na execute-ticket z persist=false.
# UNSAFE — każde użycie generuje alert SAFETY:DIRECT_TICKET_USED (severity=CRITICAL).
EXECUTION_ALLOW_DIRECT_TICKET=false

# Wiek ostatniej reconciliation po którym /ready → 503 (sekundy).
EXECUTION_READY_RECONCILIATION_MAX_AGE_S=900

# Tokeny do execution-engine. Faza 1 (ADR-001): jedna wspólna wartość dla
# wszystkich klientów (execution-engine sam, signal-engine, llm-agent, ui).
# Osobne tokeny per klient wymagają multi-token auth po stronie serwera i
# pojawią się w późniejszej fazie.
# EXECUTION_API_TOKEN jest już zdefiniowany wyżej — nie duplikuj.
```

---

## 15. Następny krok

Po akceptacji tego planu (i pierwotnych rozstrzygnięć D5–D8 z sekcji 4):

1. Rozpoczynam implementację **PR1** (config schema + envy, no-op runtime).
2. Nie merguję PR-a bez zielonych `build/typecheck/test` i mini-code-review
   opisanego w sekcji 11.1.
3. Po każdym PR aktualizuję `PHASE_1_REPORT.md` fragmentarycznie (sekcja
   `Summary` + `Findings` + hostile test results dla danego PR-a).
4. Po PR6 domykam raport (`Code`, `Hostile Safety`, `Architecture` review
   sekcje) i zatrzymuję się przed Fazą 2.

**Ten plan jest zaakceptowany przez operatora 2026-07-10. Rozpoczynam PR1.**
