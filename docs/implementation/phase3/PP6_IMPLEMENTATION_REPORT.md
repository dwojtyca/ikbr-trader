# PP6 — diagnostyka i obsługa bez własnego UI

Data: 2026-10-04. Baza: `85ed46aeeba660bd967a0818f696eede3624619e`, gałąź `main`.
Status: implementacja, niezależne przeglądy i końcowe kontrole lokalne zakończone;
publikacja poprawki i CI dokładnego końcowego commitu oczekują.
Kontrakt: [przyjęty plan](PP6_IMPLEMENTATION_PLAN.md),
[specyfikacja PP6](PAPER_PRODUCTION_DELIVERY_PLAN.md#10-pp6--headless-diagnostics-deployment-and-recovery),
[procedury operatora](../../runbooks/PAPER_HEADLESS_OPERATIONS.md).

## Stan zastany i granice

Przegląd ROADMAP, CURRENT_STATE oraz raportów PP0–PP5 potwierdził dostarczone PP0,
PP1, PP2, PP3 i PP5. Ponowny odczyt GitHub Actions potwierdził udane CI dokładnej
bazy [85ed46a / run 37209661316](https://github.com/dwojtyca/ikbr-trader/actions/runs/37209661316).
Kod PP4 jest dostarczony, ale akceptacja rzeczywistych źródeł
nadal jest zablokowana: aktualny raport okresowy PKO, pełne wiadomości/zdarzenia
emitenta oraz dostępność/uprawnienia i budżet modelu wymagają dowodów. PP6 nie
rozwiązuje braków kwotowań, completed orders ani certyfikowanego rozliczenia
Warszawskiego dnia. Nie przeprowadzono nowego operacyjnego preflight IBKR.

Zachowano 25 zastanych zmienionych lub nieśledzonych plików. Kandydat publikacji
powstaje z archiwum bazowego commitu i jawnej listy plików PP6; nie zawiera `.env`
ani niezwiązanych prac ES/backtest/signal. UI pozostaje bez zmian. Nie aktywowano
handlu, nie uruchomiono PP7, rzeczywistego brokera, płatnych źródeł ani testowych
powiadomień do rzeczywistych odbiorców.

## Dostarczone mechanizmy

`pnpm paper:ops` udostępnia po polsku `logs --follow`, `status`, `trace`, `session`
i `export`, z filtrami instrumentu, czasu, powodu i ważności. `--json` korzysta
z tego samego raportu. Domyślne okno wynosi godzinę, zakres maksymalnie 31 dni,
limit 1000 zdarzeń. Dokładny `trace` stanowi wyjątek od okna czasowego: obejmuje
zachowaną historię tej samej tożsamości i powiązanego zamknięcia, z faktycznym
przedziałem dowodów i limitem 1000 zdarzeń/2 MiB. Ta poprawka kontraktu uzyskała
osobną akceptację pierwotnego reviewera planu. Wyjście tekstowe podaje strefę i przesunięcie UTC, tożsamość
instrumentu, konfiguracji, oceny, propozycji i cyklu oraz wpływ i sugerowaną reakcję.

Nowa migracja 25 przechowuje diagnostyczne wyniki ocen, generacje procesu,
heartbeat, przerwy zapisu i watermark retencji. Dane audytowe zleceń nie są
kopiowane do nowej ścieżki wykonania: odczyt łączy istniejące propozycje, AI,
snapshoty badań, próby, brokerowe powiązania/realizacje, zamknięcia, uzgodnienia,
pauzę oraz epizody i dostawy alertów PP5. Błąd wewnętrznej oceny nie staje się
brakiem sygnału. Brak konta, źródła, opłat lub historii nie staje się zerem.

Oceny starszego trybu mogą używać wyłącznie jawnego `IBKR_ACCOUNT_ID`, środowiska
i zgodnej allowlist sprawdzanych istniejącym parserem. Jest to deklarowany zakres
diagnostyki, nie dowód połączenia z brokerem ani zmiana warunków wejścia. Brak
takiego zakresu pozostaje niedostępnością. Odczyt wykonania używa znanego konta
serwera; zmiana konta w trakcie odczytu unieważnia wynik.

Przed i po złożeniu raportu kontrola zgodności wykrywa powiązania zapisów bieżącego
konta z propozycją lub oceną AI jawnie przypisaną do innego konta. Sprzeczność albo
awaria tej kontroli odmawia diagnostyki całego konta stałym kodem UNAVAILABLE;
nie ujawnia obcych identyfikatorów i nie zastępuje odrzuconych dowodów zerami.
Regresja PostgreSQL obejmuje błędne powiązania fill/order-link oraz outbox z obcym
epizodem błędu i propozycją. Testy deterministyczne sprawdzają zmianę zgodności
w trakcie odczytu i awarię kontroli tożsamości bez ujawnienia treści wyjątku. Wyjaśnienie wymaga wspieranego uzgodnienia,
nie kasowania danych ani nowej ścieżki handlowej.

Aktualizowana propozycja nie ma historycznego `updated_at`; raport nie przypisuje
jej dzisiejszego stanu do daty utworzenia. Migawki propozycji, zamknięcia i nadzoru
są jawnie częściową historią. Krytyczne zdarzenia i rozwiązania epizodów nie są
próbkowane. Zwięzłe powtórzenia zachowują liczbę, pierwszy/ostatni czas i odwołania;
pełny zapis ocen pozostaje w bazie. Rozłączenie odczytu, retencja, limit wyniku,
restart lub przerwa harmonogramu nie udają kompletnej sesji.

Status obejmuje instrumenty i instancje z konfiguracji, kwotowania i ich wiek,
kalendarz/historię, pokrycie badań, przełączniki, pauzę, nadzór i blokady. Cykl oraz
wynik brutto/netto ocenia istniejący ewaluator; kwoty są rozdzielone według walut,
a brak prowizji pozostawia wynik niepotwierdzony. Sesja pokazuje ograniczony zbiór
zapisanych wyjść bota, nie pełny wynik konta. Źródła AI są odczytywane z zapisanego
snapshotu wraz z hashami, dokumentem, publikacją i użytym modelem; raport nie
wywołuje dostawcy. Historyczny dowód ryzyka nie stanowi bieżącej zgody na zapis.

Odczyt API jest uwierzytelniony również przy wyłączonym master. Terminal ma stałą
listę lokalnych adresów, zakaz przekierowań, limit czasu i wielkości odpowiedzi.
Jawne `control` przekazuje wyłącznie istniejące PP5 pause/resume/supervision/close/
reconcile. POST nigdy nie jest automatycznie ponawiany, UUID zamknięcia musi podać
operator. Nie dodano trasy brokerskiej ani obejścia ryzyka, AI czy ownership.

Eksport używa losowych, spójnych w jednej paczce pseudonimów. Usuwa dokładne linki
audytu, kwoty i niezaufane teksty oraz redaguje sekrety/konta, także identyfikatory
w swobodnym opisie. ANSI, znaki sterujące, kierunek tekstu i niebezpieczne adresy
są neutralizowane. Limit 1 MiB dotyczy gotowego tekstu lub sformatowanego JSON.
Plik ma uprawnienia 0600; istniejące pliki i dowiązania nie są nadpisywane.

## Eksploatacja i odzyskiwanie

Docker stosuje rotację lokalnych logów 10 MiB × 3. Kopie ocen mają retencję 30 dni
i limit 100000 wierszy z ograniczonymi partiami usuwania i watermarkiem. Oryginalne
ownership, próby, research, close, pauzy, błędy i dostawy nie podlegają temu purge.
Osobne ograniczone pule odczytu/zapisu diagnostycznego chronią pulę wykonania;
błąd diagnostyki oznacza jawny brak dowodu, nie ponowienie działania handlowego.

Runbook opisuje wdrożenie z wyłączonym UI, prywatny backup, odtworzenie wyłącznie
do izolowanej bazy, zgodny rollback bez cofania migracji i warunki ponownego
uzgodnienia. Pauza wejść nie zatrzymuje automatycznych wyjść. Nie zadeklarowano
ogólnego bezpiecznego przejęcia ręcznego w IBKR; nieznana ilość, obca ochrona lub
wynik operacji pozostają HOLD do obsługi przez wspierane uzgodnienie.

Próba odzyskania używa rzeczywistego `pg_dump`/`pg_restore` i porównuje fingerprint
22 tabel z dowodami oraz metadanymi diagnostyki. Sprawdza trwałą pauzę, odmowę wejść
i master=false. Produkcyjny `FullCloseService` odczytuje przywrócone UNKNOWN:
powtórzenie tego samego UUID zwraca istniejącą operację, inny UUID otrzymuje konflikt,
żaden callback brokera/ryzyka/alertu nie jest wywołany, fingerprint nie zmienia się.

Osobny `operator-drill.ts` uruchamia rzeczywisty CLI jako proces, uwierzytelnione
Fastify i PostgreSQL wewnątrz izolowanego kontenera. Sprawdza pięć operacji oraz
status PKO, AAPL i trzeciego skonfigurowanego instrumentu, bez UI i bez brokerów.
Są to dowody testowe; nie potwierdzają poprawnego odtworzenia rzeczywistego konta.

## Przeglądy, kontrole i publikacja

Kontrakt PP6-C przyjął niezależny Astra/high przed PP6-A/B. Inny Astra/high,
niebędący autorem implementacji, zaakceptował końcowy przegląd wrogich przypadków.
Wykryte i naprawione luki obejmowały: gubienie zmian pokrycia w follow, nadmierną
kompaktację korelacji, brak metadanych w restore, błędne dopasowanie holdów,
rozmiar gotowego eksportu, redakcję krótkich ID, czas aktualizowanych migawek,
filtry po limicie, liczby BIGINT na granicy klienta, luki harmonogramu i faktyczny
kształt dowodu ryzyka oraz powiązania account/proposal/outbox/fault. Końcowy przegląd
nie pozostawił uwag blokujących; akceptacja źródeł nie zastępuje wyników kontroli
i publikacji poniżej.

| Kontrola | Wynik |
| --- | --- |
| `pnpm lint` | PASS, exit 0; 2 istniejące ostrzeżenia |
| `pnpm typecheck` | PASS, exit 0 |
| `pnpm test` | PASS: 2978 testów, 2871 PASS, 107 pominiętych bez PostgreSQL, 0 błędów |
| `pnpm test:integration`, izolowany PostgreSQL 16 | PASS: 2357/2357, 0 błędów i pominięć, exit 0; 164,13 s; kontener testowy `--cpuset-cpus 0` |
| `pnpm build` | PASS, exit 0 |
| Czysty Docker `--no-cache` | PASS, exit 0; 19,36 s; digest poniżej |
| Końcowy dump/restore i CLI bez UI | PASS: nowy dump/restore 22 tabel i produkcyjny replay UNKNOWN; root `pnpm paper:ops`, 3 instrumenty, 5 operacji, 7 GET na czystym końcowym obrazie |
| Niezależny końcowy przegląd źródeł/dokumentacji | PASS; Astra/high, bez uwag blokujących |
| Linki, diff i zachowanie zastanych plików | PASS: 25 hashów bez zmian, 48 jawnych plików PP6, linki 6 dokumentów i `git diff --check` |
| Commit/push `main` i CI dokładnego SHA | Oczekuje |

Końcowy obraz `ikbr-pp6-verification:final` ma digest
`sha256:8f49b00441f98e985813bf28f4a5dd8d9b7bdf6f45e8d1b895fbd959334b5d2b`.
Powstał przez `docker --context colima-pp1-verification build --no-cache`
z kandydata publikacji; wszystkie pliki źródłowe i konfiguracja PP6 są identyczne
z zakresem commitu. Odczyt Compose z `--env-file /dev/null`, `config --no-interpolate
--quiet` przeszedł bez uruchamiania usług i bez odczytu operacyjnego `.env`.

Pierwszy pełny przebieg integracji ujawnił nieaktualną listę wersji migracji w teście
`strategy-conversion.pg-integration.test.ts`. Dodano oczekiwaną wersję 25 bez
usuwania pozostałych asercji; osobny test migracji 4/4 PASS, następnie ponowiono
pełny zestaw. Końcowe regresje izolacji kont: 5 testów jednostkowych i 1 PostgreSQL
PASS. Pierwsze wywołanie końcowego restore drill z katalogu `/app` nie znalazło
pakietu `tsx`; poprawiono katalog polecenia na `/app/apps/execution-engine`,
bez zmiany źródeł ani wykonania operacji brokerskiej.

Nie zmieniono strategii ani symulatora; osobny backtest strategii nie ma
zastosowania. Istniejące testy backtest-engine należą do obowiązkowych zestawów.
Czasy końcowych poleceń: lint 3,62 s; typecheck 7,26 s; test 51,74 s; build 5,26 s.
Logi lokalnej sesji: `/tmp/pp6-entry-{lint,typecheck,test,build,integration}.log`
i `/tmp/pp6-entry-docker-build.log`; są dowodem tej sesji, nie trwałym archiwum.
Próba końcowego obrazu użyła nowych baz `pp6_restore_entry_source`
i `pp6_restore_entry_target`, bez publicznego portu API.

Izolacja używa wyłącznie kontekstu Docker `colima-pp1-verification` i kontenera
`pp6-postgres`, bez operacyjnej bazy i bez ingerencji w zastany `pp3-postgres`.

## Korekta udokumentowanego polecenia

Po publikacji pierwszego commitu `a4c150021c46002a8e8fa67fae810201987d9dab`
lead wykrył różnicę między bezpośrednim wywołaniem Node w pierwotnym drill a
udokumentowanym `pnpm paper:ops`: pnpm uruchamia skrypt w katalogu pakietu, więc
względne ścieżki `.env` i eksportu trafiały w niewłaściwe miejsce. Pierwotny
reviewer planu niezależnie zaakceptował doprecyzowanie kontraktu przed poprawką.
CLI rozwiązuje te dwie ścieżki względem `INIT_CWD` wywołującego, z fallback do
`process.cwd()` i zachowaniem ścieżek bezwzględnych. Nie zmienia to tokena, adresów
API, wyłączności/0600 eksportu ani kontroli transakcji.

Regresja uruchamia rzeczywistą funkcję CLI dla względnych ścieżek pnpm, ścieżek
bezwzględnych i wywołania bez `INIT_CWD`. Sprawdza uwierzytelnienie tokenem z pliku,
trzy GET, prywatne pliki i brak tokena w eksporcie. Końcowy drill uruchamia teraz
root `pnpm paper:ops` z względnym prywatnym plikiem syntetycznej konfiguracji,
bez odziedziczonego tokena, i sprawdza eksport w katalogu wywołującego. Nadal
wykonuje siedem GET, trzy instrumenty i pięć operacji bez UI. Wstępna regresja
użyła błędnego testowego trybu `export`; poprawiono fixture na rzeczywisty tryb
API `events`, zachowując walidację. Celowane testy po tej korekcie: 5/5 PASS.
Przypadkowo uruchomiony pełny pakiet w sandboxie nie mógł otwierać portów loopback
(EPERM); pełna ponowna walidacja korzysta z właściwych uprawnień testowych.

Pierwszy pełny root-pnpm drill ujawnił także, że Node 24 przechwytuje `--env-file`
nawet po ścieżce skryptu, jeśli nie zakończono parsowania jego opcji. Dodano `--`
przed skryptem w poleceniu pakietu. Dzięki temu wyłącznie parser CLI odczytuje
plik, bez wstępnego ładowania dowolnych wartości dotenv do środowiska Node.
To doprecyzowanie również przyjął pierwotny reviewer planu przed zmianą, a inny
Astra zaakceptował implementację. Nowy test uruchamia prawdziwe root-pnpm z
względnym plikiem pustego tokena i oczekuje własnej odmowy CLI przed HTTP.
Celowany zestaw 6/6 PASS; pełny drill ze skryptem nadpisanym w jednorazowym
kontenerze także 7 GET PASS. Następnie powtórzono wszystkie kontrole, czysty build
i nowy dump/restore oraz root-pnpm drill na finalnym obrazie z tabeli — PASS.

Dwa pełne przebiegi poprzedniego obrazu z domyślną współbieżnością plików nie przeszły: najpierw test
AAPL oczekiwał jednego dopuszczenia, lecz otrzymał dwa odrzucenia z powodem
`aapl_window_session_schedule_stale`; następnie test badań oczekiwał
`RESEARCH_SNAPSHOT_SUPERSEDED`, lecz wcześniejsza bramka zwróciła
`RESEARCH_PEER_MISSING_OR_DRIFTED`. To istniejące testy poza zakresem zmienionego
kodu. Nie zmieniano ich asercji ani progów świeżości. Celowane powtórzenia na
identycznym obrazie przeszły: AAPL 31/31 (9,71 s), research guard 3/3 (1,18 s).
Próbka 200000 odczytów zegara PostgreSQL nie wykazała cofnięcia czasu; przyczyna
wcześniejszych rozbieżności nie została potwierdzona. Pełne 2357/2357 przeszło
z `--cpuset-cpus 0`, ograniczając równoległość między plikami; jawne współbieżne
rezerwacje w testach pozostały aktywne. To ograniczenie lokalnego środowiska
weryfikacji jest zachowane w raporcie. Pierwszy opublikowany commit przeszedł też
standardowe [GitHub CI 37226720055](https://github.com/dwojtyca/ikbr-trader/actions/runs/37226720055);
nie zastępuje to CI poprawionego końcowego commitu.

## Modele i eskalacje

| Zadanie | Żądany model/rozumowanie | Użyta trasa i naprawy |
| --- | --- | --- |
| Krytyczny kontrakt, integracja, auth/privacy/restore | gpt-6-astra/high | Lead, bez obniżenia poziomu krytycznych decyzji |
| Niezależny przegląd planu | gpt-6-astra/high | Przyjęty bez blokujących uwag; osobno zaakceptowane doprecyzowania trace, katalogu CLI i separatora Node |
| PP6-A, czysta prezentacja | gpt-6-luna/medium | Jedna nieudana celowana naprawa testów; eskalacja do Sol |
| Naprawa prezentacji, status i akceptacja fixture | gpt-6-sol/medium | Naprawa zakończona; kolejne bounded pakiety pod przyjętym kontraktem |
| Audyt zastanego stanu i PP6-B | gpt-6-sol/medium | Uwagi krytyczne zwracane do lead/review; poprawki bez zmiany bramek |
| Niezależny przegląd implementacji | gpt-6-astra/high | Inny agent niż reviewer planu i autorzy; zaakceptowany; pierwotnie 7 przeglądów źródeł/kontraktu i 1 raportu; po korektach CLI dwa osobne przeglądy źródeł i przegląd raportu |
| Kontrole techniczne | gpt-5.6-luna/low | Model niedostępny; jawny fallback gpt-6-luna/low |

Podane są żądane i wywołane trasy. Telemetria rzeczywistego backendu, tokeny
per agent i dokładny czas per agent są niedostępne, nie zerowe. Zarejestrowano jedną
nieudaną celowaną naprawę Luna i jedną eskalację do Sol. Zachowany kontekst końcowego
reviewera obejmuje 7 zleceń przeglądu źródeł/kontraktu oraz końcowy przegląd dokumentów
(łącznie 8) i 2 końcowe rundy
naprawy izolacji kont; dokładna liczba wcześniejszych edycji wewnątrz tych rund jest
niedostępna. Po korektach CLI dochodzą dwa odrębne przeglądy źródeł i przegląd raportu
(11 żądań przed publikacją poprawionego kodu), dwie naprawy wywołania i jedna poprawka
błędnego trybu testowego, bez obniżenia poziomu modelu. Według znaczników czasu plików od zapisu inwentarza o 17:15 CEST do końcowej próby
odtworzenia o 22:21 CEST upłynęło około 306 minut; publikacja/CI są kolejnym etapem. Nie deklarujemy procentu
oszczędności ani gwarancji jakości modelu.
