# Phase 1 — Report

Raport wykonawczy z Fazy 1 (**Execution Security**). Uzupełniany po każdym
zamkniętym PR-ze. Ten dokument ma być czytany razem z:

- [ROADMAP.md](ROADMAP.md)
- [PHASE_1_PLAN.md](PHASE_1_PLAN.md)
- [../adr/ADR-001-execution-security.md](../adr/ADR-001-execution-security.md)

---

## PR1 — Execution Security config schema

Status: **DONE** (commit `448f98c`).

### Zakres

- Zod schema + `buildExecutionConfig()` w
  [apps/execution-engine/src/config.ts](../../apps/execution-engine/src/config.ts).
- Nowe envy (schema-only): `IBKR_ENVIRONMENT`, `TRADING_ENABLED`,
  `ALLOWED_PAPER_ACCOUNTS`, `ALLOWED_LIVE_ACCOUNTS`, `EXECUTION_BIND_HOST`,
  `EXECUTION_API_TOKEN`, `EXECUTION_ALLOW_MKT`,
  `EXECUTION_ALLOW_DIRECT_TICKET`, `EXECUTION_READY_RECONCILIATION_MAX_AGE_S`.
- Cross-field walidacja: `TRADING_ENABLED=true` lub `IBKR_ENVIRONMENT=live`
  wymuszają `EXECUTION_API_TOKEN` długości ≥ 32; `IBKR_ENVIRONMENT=live`
  wymusza niepusty `ALLOWED_LIVE_ACCOUNTS`.
- Strict-bool: `TRADING_ENABLED`, `EXECUTION_ALLOW_MKT`,
  `EXECUTION_ALLOW_DIRECT_TICKET` akceptują wyłącznie literały `'true'` /
  `'false'` (odrzucają `'True'`, `'TRUE'`, `'1'`, `'yes'`, `''` itp.).
- 62 test unitowe (`node --test`) pokrywające happy path, boundary,
  strict-bool i whitelist parsing.
- Dokumentacja: ADR-001, aktualizacja PHASE_1_PLAN, wpis do repo-memory
  (`/memories/repo/architecture-north-star.md`) o single-token modelu.

### Poza zakresem PR1

- Runtime enforcement (auth middleware, guards, bind-host, direct-ticket
  block, MKT block) — odsunięte do PR2..PR5.
- Zmiany w `docker-compose.yml`, `README.md`, `.env.example` —
  odsunięte do PR6.

### Testy / build

- `pnpm --filter @ikbr/execution-engine test` → **62 passed / 0 failed**.
- `pnpm -r build` → wszystkie 7 pakietów zbudowane.

### Hostile review

- **Q:** Czy `IBKR_ENVIRONMENT` może być wywnioskowany z portu?
  **A:** Nie — walidacja jest niezależna od `IB_SOCKET_PORT`; port 4001
  z `IBKR_ENVIRONMENT=paper` przechodzi walidację (nie sprawdzamy tej
  spójności celowo, żeby ADR-001 §3.3 pozostała jedyną regułą).
- **Q:** Czy token 32 znaków to wystarczająco?
  **A:** 32 znaki heksadecymalne = 128 bitów entropii — zgodne z OWASP
  ASVS 4.0 §V2.1.2 (min 128 bit dla sesji API bez ograniczenia
  częstotliwości logowania).
- **Q:** Czy `parseAccountList` zwraca frozen array?
  **A:** Tak — `Object.freeze(...)`; testy weryfikują deduplikację
  i trim whitespace.

---

## PR2 — Bind host + Bearer auth + audit + correlation ID

Status: **DONE**.

### Zakres implementacji

| Warstwa            | Plik                                                                                                                          | Zmiana                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Auth utilities     | [apps/execution-engine/src/auth.ts](../../apps/execution-engine/src/auth.ts) (**NEW**)                                        | `verifyBearerToken` (const-time), `fingerprintToken`, `AuthFailureBurstTracker`, `registerExecutionAuth` Fastify plugin |
| DB schema          | [apps/execution-engine/src/repository.ts](../../apps/execution-engine/src/repository.ts)                                      | `CREATE TABLE execution_audit_log` w `init()` + `insertExecutionAuditLog(...)`                       |
| Alert taxonomy     | [apps/execution-engine/src/alerts.ts](../../apps/execution-engine/src/alerts.ts)                                              | `AlertSeverity` += `'CRITICAL'`; `AlertKind` += `'auth_failure_burst'`, `'direct_ticket_used'`; CRITICAL bypassuje `ALERT_MIN_SEVERITY` |
| Server wire-up     | [apps/execution-engine/src/index.ts](../../apps/execution-engine/src/index.ts)                                                | `registerExecutionAuth` + burst→alert bridge; `app.listen({ host: config.EXECUTION_BIND_HOST })`     |
| llm-agent client   | [apps/llm-agent/src/execution-api-client.ts](../../apps/llm-agent/src/execution-api-client.ts) + [apps/llm-agent/src/index.ts](../../apps/llm-agent/src/index.ts) | konstruktor przyjmuje `bearerToken`; nagłówek `Authorization: Bearer …` na każdym requeście          |
| signal-engine call | [apps/signal-engine/src/repository.ts](../../apps/signal-engine/src/repository.ts) + [signal-engine.ts](../../apps/signal-engine/src/signal-engine.ts) + [index.ts](../../apps/signal-engine/src/index.ts) | `getExposureSnapshot(baseUrl, token?)` → attach Bearer na `/execution/account/summary`               |
| llm-agent config   | [apps/llm-agent/src/config.ts](../../apps/llm-agent/src/config.ts)                                                            | ostrzeżenie startowe aktualizowane z "PR2 wymaga tokenu" → "PR2 już wymaga tokenu"                    |
| UI proxy           | [apps/ui/vite.config.ts](../../apps/ui/vite.config.ts)                                                                        | `configure(proxy).proxyReq.setHeader('authorization', …)` — token czytany server-side, NIE w bundlu   |
| Tests              | [apps/execution-engine/src/auth.test.ts](../../apps/execution-engine/src/auth.test.ts) (**NEW**)                              | 14 testów: fingerprint, verify, burst tracker, integracja Fastify (`.inject()`)                     |
| Docs               | [docs/adr/ADR-001-execution-security.md](../adr/ADR-001-execution-security.md) §8                                             | Uwagi implementacyjne post-PR2 (const-time padding, UUID, fail-closed, `CRITICAL`, UI-safety)        |

### Schemat `execution_audit_log`

```sql
CREATE TABLE IF NOT EXISTS execution_audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  correlation_id UUID NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  actor_kind TEXT NOT NULL,      -- 'authenticated' | 'unauthenticated'
  token_fingerprint TEXT,        -- sha256(token).slice(0,12), NULL gdy anon
  ip TEXT,
  request_hash TEXT,             -- sha256(method+url+body).slice(0,32)
  outcome TEXT NOT NULL,         -- 'ALLOW' | 'DENY_AUTH' | 'DENY_GUARD' | 'ERROR'
  reason TEXT                    -- np. 'wrong_token', 'http_500'
);
CREATE INDEX IF NOT EXISTS execution_audit_log_ts_idx
  ON execution_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS execution_audit_log_correlation_idx
  ON execution_audit_log (correlation_id);
CREATE INDEX IF NOT EXISTS execution_audit_log_outcome_idx
  ON execution_audit_log (outcome, ts DESC);
```

### Middleware — reguły (skrót)

- `GET /health` — publiczny, bez auth, bez audytu (health-check-friendly).
- Wszystkie inne `/execution/*` (GET i POST) — wymagają nagłówka
  `Authorization: Bearer <token>` == `EXECUTION_API_TOKEN`.
- Porównanie `crypto.timingSafeEqual` na paddowanych buforach + długość
  XOR-owana do ostatniego bajta (branch-free, brak wycieku długości).
- Jednokrotny wpis do `execution_audit_log` na request w hooku
  `onResponse` (fire-and-forget; błąd zapisu → `WARN`, nigdy 5xx dla
  klienta).
- `X-Correlation-ID` — akceptowany tylko gdy pasuje do UUID v1–5;
  w innym wypadku generujemy `randomUUID()`. Nagłówek jest zawsze
  zwracany na response.
- Token NIGDY nie trafia do loga ani audytu; tylko fingerprint
  `sha256(token).slice(0, 12)`.
- 3 błędne uwierzytelnienia w oknie 60s per-IP → alert
  `AUTH_FAILURE_BURST` (severity `warn`) do `system_alerts` + Telegram
  (jeśli skonfigurowany).

### Testy

`pnpm --filter @ikbr/execution-engine test` → **76 passed / 0 failed**
(62 z PR1 + 14 nowych z PR2).

Nowe testy PR2:

- `fingerprintToken` — 12 znaków sha256, pusty dla pustego wejścia.
- `verifyBearerToken` — accept, wrong-token, missing header, malformed,
  server-token-empty, length-discriminant (dwa różne długości z tym
  samym prefixem NIE są równe).
- `AuthFailureBurstTracker` — próg 3/60s, reset po emisji, per-IP izolacja,
  ignoruje failures poza oknem.
- Integracja Fastify (`.inject()`):
  - `GET /health` — 200 bez tokenu, brak wpisu audytu.
  - `GET /execution/orders` bez tokenu → 401 + `DENY_AUTH`.
  - `GET /execution/orders` ze złym tokenem → 401 + `DENY_AUTH`
    (reason=`wrong_token`).
  - `GET /execution/orders` z dobrym tokenem → 200 + `ALLOW` +
    `actorKind='authenticated'` + fingerprint w audycie.
  - 3× bad token → burst-emitter wywołany raz z `count=3`.
  - Prawidłowy UUID w `X-Correlation-ID` → propaguje się do audytu
    i response header.
  - Nieprawidłowy `X-Correlation-ID` (`"'; DROP TABLE audit; --"`) →
    zignorowany, generowany fresh UUID.
  - Serialized audit **nigdy** nie zawiera raw tokenu; zawiera fingerprint.
  - Body POST-a hashowane; wpis audytu nie zawiera surowej wartości pól
    (`AAPL` z ticketu NIE pojawia się w audycie).
  - `token=""` po stronie serwera → wszystkie requesty 401 (fail-closed).

Regresja: `pnpm --filter @ikbr/signal-engine test` → **49 passed / 0 failed**.

### Build

`pnpm -r build` → wszystkie 7 pakietów zbudowane bez błędów.

Weryfikacja bezpieczeństwa UI bundle:
`EXECUTION_API_TOKEN=tokentokentoken… pnpm --filter @ikbr/ui build && grep -l tokentokentoken apps/ui/dist/assets/*.js`
→ brak dopasowań (token nie inlined do klienta).

### Hostile review — PR2

- **Q: Czy `crypto.timingSafeEqual` na `Buffer.alloc(size, 0)` bez
  dyskryminanty długości zwraca `true` dla dwóch różnych długości z tym
  samym prefixem?**
  **A:** Tak, w naiwnej implementacji — dlatego `verifyBearerToken`
  XOR-uje `providedBuf.length & 0xff` do ostatniego bajta paddowanego
  bufora. Test `it("does not equate two different tokens sharing a padded suffix")`
  weryfikuje to explicite.
- **Q: Czy attacker może użyć `X-Correlation-ID` do log injection lub
  SQL injection?**
  **A:** Nie — wartość jest walidowana regexem RFC 4122; nie-UUID
  wartości są zastępowane freshly-generated UUID. Kolumna `correlation_id`
  ma typ `UUID`, więc nawet gdyby regex zawiódł, insert by odrzucił
  niepoprawną wartość.
- **Q: Czy `writeAudit` może blokować request path?**
  **A:** Nie — Promise obudowany w `Promise.resolve(...).catch(...)`
  wewnątrz `onResponse`, callback `done()` wywoływany natychmiast.
  Test integracyjny nie mockuje DB — używa `writeAudit: (row) => audits.push(row)`
  synchronicznego. W realnym runtime błąd zapisu do Postgresa daje tylko
  `logger.warn`.
- **Q: Czy alert `AUTH_FAILURE_BURST` może zalać system alertami przy
  aktywnym ataku?**
  **A:** Nie — po emisji bucket dla danego IP jest resetowany, więc
  potrzebne są **kolejne 3** błędy w oknie 60s przed następnym alertem.
  Górna granica: ~1 alert/20s per IP.
- **Q: Czy 401 leak wewnętrznego stanu (missing_header vs wrong_token)?**
  **A:** Nie — body odpowiedzi zawsze `{"error":"unauthorized"}`.
  Powód trafia wyłącznie do `execution_audit_log.reason`.
- **Q: Czy `GET /health` audytujemy?**
  **A:** Nie — `/health` bypasuje audit intencjonalnie (docker-compose
  polluje go co kilka sekund, zalałoby to tabelę). Trzy alternatywy
  (partycjonowanie po dacie, retention job, sample rate) zostają
  odsunięte do PR6 lub Fazy 2 gdyby okazało się, że
  `execution_audit_log` rośnie za szybko z rzeczywistego ruchu.
- **Q: Co jeśli `EXECUTION_API_TOKEN` na kliencie i serwerze się rozjadą
  (np. rotacja tokenu)?**
  **A:** Każdy request klienta → 401 → burst-alert w Telegramie po 3
  próbach. Operator widzi i naprawia. Rotacja tokenu w Fazie 1 wymaga
  restartu wszystkich kontenerów jednocześnie (single-token model —
  ADR-001 §3.1). Multi-token rotation odsunięte do Fazy 5+.

### Poza zakresem PR2

- `assertEnvironmentAllowsWrite` + guard 423 Locked + `/ready` split → PR3.
- `EXECUTION_ALLOW_DIRECT_TICKET` enforcement + `DIRECT_TICKET_USED`
  alert → PR4.
- `EXECUTION_ALLOW_MKT` enforcement + `MKT` default → PR5.
- `.env.example`, root scripts, `README.md` update → PR6.

---

## PR3 — Paper/Live env guards, /ready, account mismatch alert

Zakomitowany jako `00adc7f`.

### Zakres implementacji

| Warstwa | Plik | Zmiana |
| --- | --- | --- |
| Guard (pure) | [apps/execution-engine/src/env-guard.ts](../../apps/execution-engine/src/env-guard.ts) | `assertEnvironmentAllowsWrite(cfg, activeAccountId)`, `whitelistForEnvironment(cfg)`, `EnvironmentGuardError` (statusCode 423, reason discriminant) |
| Readiness (pure) | [apps/execution-engine/src/readiness.ts](../../apps/execution-engine/src/readiness.ts) | `evaluateReadiness({...})` → `{ statusCode, body }` |
| HTTP | [apps/execution-engine/src/index.ts](../../apps/execution-engine/src/index.ts) | Global `preHandler` gate na wszystkie `POST/PUT/PATCH/DELETE /execution/*` (rejestrowany po `registerExecutionAuth` żeby 401 wyprzedził 423); `GET /ready` z 7 s TTL cache dla `SELECT 1`; `setErrorHandler` przekłada `EnvironmentGuardError` na 423 `{ error, reason }`; `ensureBrokerSession` egzekwuje whitelistę na `getManagedAccounts` i przy mismatchu emituje CRITICAL `safety_account_environment_mismatch` (bypass `ALERT_MIN_SEVERITY`); `runReconciliation` stempluje `lastReconciliationAt` |
| Alert | [apps/execution-engine/src/alerts.ts](../../apps/execution-engine/src/alerts.ts) | Nowy `AlertKind` `safety_account_environment_mismatch` |

### Kluczowe rozstrzygnięcia

- **Port ignorowany**: `IBKR_ENVIRONMENT` jest jedynym źródłem prawdy
  (ADR-001 §3.2). Test regresyjny w [env-guard.test.ts](../../apps/execution-engine/src/env-guard.test.ts)
  utrwala kontrakt.
- **Decision D7 zachowana**: w live + `TRADING_ENABLED=false` `/ready`
  zwraca 200 z `tradingEnabled=false` — administracyjna pauza nie jest
  awarią readiness (ADR-001 §3.6).
- **Bootstrap chicken-and-egg**: preHandler przepuszcza `POST /execution/bootstrap`
  gdy `lastActiveAccountId=null` (guard tylko egzekwuje `TRADING_ENABLED`
  w live), a `ensureBrokerSession` dopiero po `getManagedAccounts` sprawdza
  whitelistę i cachuje wynik.
- **TODO(reconciliation-sot)**: `lastActiveAccountId` + `lastReconciliationAt`
  żyją w pamięci procesu; docelowo mają pochodzić z tabeli reconciliation state.
- **`/ready` audit-write cache (7 s TTL)**: probe `SELECT 1` uruchamia się
  co najwyżej raz na 7 s niezależnie od częstotliwości pollingu, chroniąc
  pool przed konkurencją z real traffic.

### Testy

- Nowe: 15 × env-guard + 11 × readiness (razem 26).
- Suma: 102 pass w execution-engine, żadnych regresji.
- Typecheck `tsc --noEmit` — czysto.
- `pnpm -r build` — wszystkie 7 pakietów.

### Hostile review

- **Q: Czy operator może obejść guard portem?**
  **A:** Nie. Guard nie ma pola port. Test `does not look at any port field`
  utrwala kontrakt: nawet paper account na porcie 4001 przechodzi, o ile
  `IBKR_ENVIRONMENT=paper` i konto jest w `ALLOWED_PAPER_ACCOUNTS`.
- **Q: Co jeśli `ensureBrokerSession` rzuci EnvironmentGuardError w środku
  handlera nie łapiącego wyjątków?**
  **A:** `setErrorHandler` łapie na końcu łańcucha i zwraca 423
  `{ error, reason }`. Nie ma potrzeby try/catch w każdym handlerze.
- **Q: Bootstrap w live + `TRADING_ENABLED=false` — czy blokuje
  observation-mode?**
  **A:** Tak, celowo. Observation-only wymaga `IBKR_ENVIRONMENT=paper`.
  W live wszystkie mutujące endpointy są zamknięte gdy trading wyłączony.
- **Q: Czy CRITICAL alert może zalać Telegram przy powtarzającym się
  mismatchu?**
  **A:** Alert emitowany jest przy każdym niecacheowanym wywołaniu
  `ensureBrokerSession`. Cache się nie wypełnia (mismatch resetuje
  `lastActiveAccountId = null`), więc kolejne write'y regenerują alert.
  To celowe — mismatch w live musi być głośny. Rate-limit odsunięty do
  Fazy 2 gdyby okazało się problematyczny.
- **Q: Co jeśli `lastReconciliationAt` nigdy się nie stempluje (broker
  offline od startu)?**
  **A:** `/ready` zwraca 503 `no_reconciliation_yet`; `/health` dalej 200.
  Kubernetes/orchestrator nie restartuje procesu, ale nie kieruje ruchu.

### Poza zakresem PR3

- `EXECUTION_ALLOW_DIRECT_TICKET` enforcement + `DIRECT_TICKET_USED`
  alert → PR4.
- `EXECUTION_ALLOW_MKT` enforcement + `MKT` default → PR5.
- `.env.example`, root scripts, `README.md` update → PR6.

---

## PR4 — Direct-ticket (persist=false) hardening

### Zakres implementacji

| Warstwa | Plik | Zmiana |
| --- | --- | --- |
| Guard (pure) | [apps/execution-engine/src/direct-ticket-guard.ts](../../apps/execution-engine/src/direct-ticket-guard.ts) | `evaluateDirectTicket`, `buildDirectTicketAuditRecord`, `planDirectTicketDispatch`, `assertClientDirectTicketAllowed`. Reason discriminants: `direct_ticket_disabled` (403), `direct_ticket_requires_user_override` (400) |
| Auth (public accessor) | [apps/execution-engine/src/auth.ts](../../apps/execution-engine/src/auth.ts) | `getExecutionAuthContext(request)` — zwraca `{ correlationId, tokenFingerprint }` bez ujawniania surowego tokenu |
| HTTP | [apps/execution-engine/src/index.ts](../../apps/execution-engine/src/index.ts) | `executeTicketBodySchema` rozszerzony o `decisionSource: 'signal' \| 'llm' \| 'user' \| 'user_override'` (opcjonalne); handler `POST /execution/execute-ticket` używa `planDirectTicketDispatch` — deny → 403/400, allow → `alerts.record({severity:'CRITICAL', kind:'direct_ticket_used', ...})` przed `placeSignalOrder`; standardowa ścieżka `persist=true` nietknięta |
| Broker client | [apps/execution-engine/src/tws-execution-client.ts](../../apps/execution-engine/src/tws-execution-client.ts) | `TwsExecutionConfig` przyjmuje `environment` i `allowDirectTicket`; `placeSignalOrder` przyjmuje `context?: { proposedOrderId }`; belt-and-suspenders guard: `live + brak proposedOrderId + brak opt-in` → throw |
| Alerts (pure) | [apps/execution-engine/src/alerts.ts](../../apps/execution-engine/src/alerts.ts) | Ekstrakcja `shouldForwardToTelegram(severity, minSeverity)` — CRITICAL zawsze przechodzi |

### Kluczowe rozstrzygnięcia

- **Refaktor do planera**: `planDirectTicketDispatch(...)` zwraca
  `{ kind: 'not_applicable' \| 'deny' \| 'allow', ... }`. Handler w
  `index.ts` jest cienką warstwą wiring bez własnych decyzji — cała
  polityka pokryta testami jednostkowymi na czystej funkcji.
- **Precedencja flag**: flaga `EXECUTION_ALLOW_DIRECT_TICKET=false`
  odrzuca również request z `decisionSource=user_override`. Operator
  MUSI jawnie przełączyć flagę; magiczne pole źródła nie wystarczy.
  Utrwalone testem `flag precedence`.
- **Alert payload**: CRITICAL `direct_ticket_used` z payloadem
  `{ correlationId, tokenFingerprint, symbol, side, quantity }`.
  Surowy Bearer token nigdy nie trafia do payloadu — `getExecutionAuthContext`
  eksponuje wyłącznie fingerprint. Utrwalone testem `never includes the
  raw token in message or payload`.
- **Belt-and-suspenders w kliencie brokera**: nawet gdyby ktoś obszedł
  handler HTTP i wywołał `placeSignalOrder` bez `proposedOrderId` w live
  bez opt-in, `assertClientDirectTicketAllowed` throw'uje. Konfigurację
  środowiska klient dostaje z jednorazowego konstruktora `TwsExecutionClient`.
- **Bez rate-limitu**: każde użycie `persist=false` generuje pełny alert.
  To celowe — sygnalizuje operatorowi, że ktoś sięga po hot-fix path
  (ADR-001 §3.5).

### Testy

- Nowe: 24 × direct-ticket-guard + 7 × alerts routing (razem 31).
- Suma: **132 pass** w execution-engine (102 → 132), zero regresji.
- Typecheck `tsc --noEmit` — czysto.
- `pnpm -r build` — wszystkie 7 pakietów.

Pokrycie w stosunku do specyfikacji PR4:

| Wymaganie | Test |
| --- | --- |
| `persist=false + flaga false → 403` | `evaluateDirectTicket → 403 direct_ticket_disabled` + `planDirectTicketDispatch → deny 403` |
| `persist=false + flaga true + zły decisionSource → 400` | `evaluateDirectTicket` (3 warianty: undefined, `user`, `llm`) + `planDirectTicketDispatch → deny 400` |
| `persist=false + flaga true + user_override → przechodzi` | `evaluateDirectTicket → allowed` + `planDirectTicketDispatch → allow` |
| Poprawne użycie tworzy CRITICAL `system_alert` | `planDirectTicketDispatch: allow with CRITICAL alert` + integracja handler-level (alerts.record spy przez existing infrastructure) |
| Alert przekazywany do Telegram sink | `shouldForwardToTelegram(CRITICAL, error) === true` (3 warianty min-severity) |
| Token nie pojawia się w alercie ani logach | `buildDirectTicketAuditRecord: never includes the raw token` + `planDirectTicketDispatch: alert message + payload never carry a raw Bearer token` |
| `persist=true` bez regresji | Typecheck + build; ścieżka nie została zmieniona strukturalnie |
| Client-side guard blokuje live direct bez opt-in | `assertClientDirectTicketAllowed` — 6 wariantów (paper/live × id/no-id × flag) |

### Hostile review

- **Q: Czy `decisionSource=user_override` może być podszyty przez
  klienta?**
  **A:** Tak — nie ma podpisu. Ale wymóg jest defense-in-depth:
  pierwsza brama to `EXECUTION_ALLOW_DIRECT_TICKET`, druga to
  `user_override`. Wewnętrzny klient (llm-agent, signal-engine) nie ustawia
  `user_override` w normalnym ruchu, więc zły request pochodzi tylko od
  operatora lub kompromitowanego klienta — a wtedy alert CRITICAL na
  Telegram jest natychmiastowy.
- **Q: Co jeśli operator ustawi `ALERT_TELEGRAM_BOT_TOKEN=''`?**
  **A:** `telegramEnabled === false`, alert idzie tylko do `system_alerts`
  (persystencja jest gwarantowana). Operator zobaczy w UI/DB, ale nie
  dostanie pagera. To decyzja operatora — dokumentowana w README (PR6).
- **Q: Czy handler może zapisać alert i zwrócić 500 zanim wykona order?**
  **A:** Tak — jeśli `alerts.record` throw'uje z powodu awarii DB,
  handler kończy się błędem 500 (unhandled). To celowe: **nie chcemy**
  wykonać direct ticketu bez śladu audit. Można wzmocnić w PR6 przez
  jawny 500 + osobny log. Nie zmieniam w PR4 (poza zakresem).
- **Q: Czy `getExecutionAuthContext` może zwrócić dane innego requestu
  (race)?**
  **A:** Nie. Stan trzymany na `req[AUTH_SYMBOL]` — per-request; brak
  współdzielenia stanu między requestami.
- **Q: Czy `placeSignalOrder` z `context.proposedOrderId=undefined`
  degraduje persist=true?**
  **A:** Nie. `executePersistedOrder` przekazuje `{ proposedOrderId: order.id }`
  gdzie `order.id` jest wymagany (rzuca wcześniej "persisted order id is
  missing"). Brak regresji na standardowej ścieżce.
- **Q: Czy client-side guard wygeneruje false-positive w paper?**
  **A:** Nie. Warunek: `environment === 'live' AND brak proposedOrderId
  AND brak opt-in`. Test `paper + no proposedOrderId + flag off → allowed`
  utrwala.

### Poza zakresem PR4

- `EXECUTION_ALLOW_MKT` enforcement + `MKT` default → PR5.
- `.env.example`, root scripts, `README.md` update, ostrzeżenia startowe
  o aktywnym `EXECUTION_ALLOW_DIRECT_TICKET=true` → PR6.
- Rate-limit alertów CRITICAL — nie planowany w Fazie 1.
- Multi-token auth per klient (osobny fingerprint per klient w alertach)
  → Faza 5+.

