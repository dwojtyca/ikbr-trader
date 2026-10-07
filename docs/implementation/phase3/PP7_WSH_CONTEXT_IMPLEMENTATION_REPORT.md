# PP7 — kalendarz i wiadomości jako kontekst AI

Data: 2026-10-07. Bazowy commit: `59e7f96d4194cff3f1dcefc3c3b291a7a5a54cad`.
Status: implementacja i lokalna weryfikacja zakończone; publikacja/CI są ostatnią bramką. Brak wdrożenia i brak nowej transakcji Paper.
Kontrakt: [plan integracji](PP7_WSH_PROSPECTIVE_IMPLEMENTATION_PLAN.md).
Niezależna akceptacja planu: Astra/high, 14:36:25 UTC, bez uwag blokujących;
SHA-256 planu `cba6b4c1fc8e66af78e207389563bb921a6c3577ea07cbfd709465e56771c2f3`.
Niezależny przegląd implementacji i dokumentacji: **ACCEPT**, 16:11:40 UTC,
bez nierozwiązanych uwag. Lista 49 plików ma SHA-256
`1e846921ff8cdad79b682068f7a2a42a490d5fd673d6f568a1e396313ff1d26b`.

## Zachowanie

Właściciel odrzucił blokowanie wejść wyłącznie ze względu na bliskość wydarzenia.
Istniejąca strategia nadal generuje propozycję techniczną. AI dostaje raporty,
dostępne prognozy/wyniki, newsy i wydarzenia WSH, po czym ocenia wsparcie dla
konkretnej propozycji. Nie dodano strategii ani nowych sygnałów i nie zmieniono
wielkości pozycji, progów strategii, ochrony lub deterministycznego ryzyka.

Usunięto regułę `RESEARCH_EVENT_BLACKOUT` oraz wygaśnięcie kwalifikacji wynikające
z granicy wydarzenia dla V1 i V2. Nowy prompt nie narzuca odmowy przed ani po
wydarzeniu. Zachowane są kontrole pochodzenia, aktualności, wymaganych raportów,
budżetów, tożsamości propozycji i zatwierdzenia AI.

WSH jest jedynym źródłem kalendarza. V2 przechowuje rzeczywiste pochodzenie socketowe
i trwałą pierwszą obserwację, bez wymyślonej daty publikacji. Terminy wyników,
walne zgromadzenia, EPS i pozostałe typy zdarzeń trafiają do kontekstu z zachowaną
niepewnością. Dostępne opisy/fragmenty Marketaux i sentyment właściwego emitenta
są częścią tego samego, niezmiennego zapisu. Brak opcjonalnego pola pozostaje jawny.

Pobieranie WSH jest szeregowane per endpoint, każde wywołanie ma wcześniejszą
trwałą rezerwację, a nieznany wynik odczytu zachowuje koszt i historię. Kolejny
termin odświeżania używa nowej sesji. Poprzedni poprawny zapis może służyć AI
podczas odświeżania wyłącznie do pierwotnego terminu ważności. Publikacja nowego
zapisu i końcowe wysłanie zlecenia używają istniejącej blokady bieżącego zapisu;
nowe dane unieważniają poprzednią zgodę AI. Nie zmieniono zasad nieznanych
zleceń brokerskich i nie dodano ponowień wywołania modelu.

Nowy aktywny prompt: `pp7-research-context-v2`; request:
`pp7-ai-context-request-v2`. Wspólny kontrakt sprawdza dokładny prompt i treść
żądania zarówno przed wywołaniem AI, jak i w execution. Historyczne V1 pozostaje
czytelne bez przepisywania jego JSON/hashy. Stara zgoda nie wykonuje zlecenia
w nowej wersji. [Runbook](../../runbooks/RESEARCH_CONTEXT_WSH.md) opisuje migrację,
wyłączony przykład i diagnostykę po polsku.

Treść kontekstu w żądaniu modelu jest najpierw normalizowana do JSON (w tym daty
do ISO), następnie serializowana w stabilnej kolejności kluczy. Dzięki temu zapis
i odczyt PostgreSQL JSONB nie powoduje fałszywego `AI_WIRE_REQUEST_MISMATCH`.
Rzeczywista zmiana treści nadal odrzuca zgodę; historycznych hashy nie zmieniono.

## Dowody i ograniczenia

Testy szczegółowe obejmują propozycje przed/w trakcie/po wydarzeniu, przekazanie
pełnego dostępnego kontekstu do AI, obie decyzje modelu, błędne tożsamości,
nieznane typy/daty, granice rozmiaru, trwałość pierwszej obserwacji, budżety,
timeout i spóźnione odpowiedzi, awarie zapisu/COMMIT oraz wyścig publikacja–dispatch.
Wykorzystano wyłącznie syntetyczne fixture i odizolowany PostgreSQL.

Offline sprawdzono również wcześniej zapisane odpowiedzi dostawcy: zachowano
3/3 rekordy PKO i 14/14 AAPL. Nie wykonano nowych zapytań WSH, Marketaux ani
OpenAI. Stare odpowiedzi nie stanowią świeżej kwalifikacji ani dowodu preflight.
Nie zapisano ich surowej treści w repozytorium.

Końcowe lint i typecheck przeszły. `pnpm test`: 3080 PASS, 145 testów PG pominiętych
bez URL testowej bazy, 0 FAIL. Osobne `pnpm test:integration`: 2468 PASS, 0 pominiętych,
0 FAIL, z odizolowanym PostgreSQL 15.12 na loopback:55479, bazą
`ikbr_trader_wsh_test`. Dwa ostrzeżenia lint o nieużywanym eslint-disable dotyczą
niezmienionych plików bazowych; nie ma błędów lint. Końcowy `pnpm build` oraz
`docker compose --env-file .env.example build --no-cache ingestion signal-engine execution-engine llm-agent`
przeszły z exit 0. Nie uruchomiono usług. Obrazy i pełne wyniki są zapisane
w prywatnym `checks.json`, sekcja `finalValidation`, wraz z poprzednimi porażkami.
Sprawdzono 49 plików pakietu oraz niezmienione hashe 25 wcześniejszych plików.
41 plików kodu/konfiguracji/testów ma zamrożony zestaw hashy; pozostałe to dokumentacja.

CI jest ostatnią bramką po pushu i musi dotyczyć dokładnego SHA. Jego wynik i URL
zostaną zapisane w prywatnym potwierdzeniu publikacji i odpowiedzi końcowej;
niniejszy dokument jest częścią commitu oczekującego na tę kontrolę.

Wstępna weryfikacja ujawniła trzy odrębne problemy: ograniczenie sandboxa dla
lokalnych serwerów testowych (`listen EPERM`), zależną od obciążenia 20 ms rezerwację
w istniejącym teście timeoutu oraz rzeczywisty błąd kolejności JSONB opisany wyżej.
Kontrole z dostępem do loopback i niezmieniony test timeoutu przeszły; jego asercji
ani czasu nie osłabiano. Po poprawce serializacji wszystkie 21 testów PG wejścia,
schedulera i migracji przeszły w izolacji. Uzupełniono oczekiwaną listę migracji
o 28; pozostałe asercje istniejących scenariuszy PG nie wymagały zmian.
Backtest nie jest wymagany: strategia i symulator pozostają poza zakresem.
25 wcześniejszych plików ES/backtest/signal jest zachowanych i wykluczonych
z przygotowania wydania; walidacja używa bazowego archiwum plus zakres pakietu.

Pakiet nie potwierdza jeszcze uruchomienia Paper. Potrzebne pozostają świeży
manifest/uprawnienia/budżety, wdrożenie z wyłączonymi zleceniami, brokerowy preflight
i normalny sygnał w autoryzowanym oknie sesji. UI nie jest wymagane. Live pozostaje
wyłączone.

## Routing modeli i przeglądy

| Praca | Żądany / przydzielony model i wysiłek | Wynik / naprawy |
| --- | --- | --- |
| Plan kontekstu | `gpt-6-astra` / high | Przyjęty przez innego agenta Astra/high; 0 uwag blokujących |
| Niezależny przegląd planu | `gpt-6-astra` / high | 54 s; akceptacja powyższego hasha |
| Typy, kwalifikacja, trwały zapis i migracja | `gpt-6-astra` / high | Testy szczegółowe i PG pozytywne; 2 poprawki czasu w fixture; 1 aktualizacja oczekiwanej listy migracji |
| Mapowanie rekordów WSH | `gpt-6-luna` / medium | Testy syntetyczne; lead Astra poprawił nazwy typów/indeksów i semantykę dat/rozbieżności |
| Pola opisowe Marketaux | `gpt-6-luna` / medium | 7/7 testów; bez napraw; około 3 min |
| Transport, AI i kontrola execution | Lead `gpt-6-astra` | Testy kontekstu i transportu pozytywne; 2 iteracje naprawy serializacji JSONB/Date |
| Odświeżanie i łączenie danych | `gpt-6-astra` / high | 44 testy szczegółowe i 2 PG pozytywne; naprawa pominiętego terminu odświeżania |
| Niezależny przegląd implementacji | Inny `gpt-6-astra` / high niż recenzent planu; nie pisał kodu | ACCEPT 16:11:40 UTC; 31 min 04 s z oczekiwaniem na walidację. Trzy uwagi: termin odświeżania, fałszywa precyzja daty i kolejność JSONB — poprawione |
| Przygotowanie i kontrole mechaniczne | `gpt-5.6-luna` / low niedostępny; `gpt-6-luna` / low | Jawny fallback; bez edycji źródeł |

Nie ma niezależnej telemetrii rzeczywistego backendu ani tokenów; zużycie jest
**unavailable**, nie zero. Czasy bez pomiaru są unavailable. Nie deklarujemy
procentowej oszczędności ani gwarancji jakości na podstawie nazwy modelu.
