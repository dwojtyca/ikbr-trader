# Automatyczne odzyskiwanie rozliczeń po błędzie zegara

Data: 2026-10-18. Status: plan i finalny dokument zaakceptowane w niezależnych recenzjach; wyłącznie dokumentacja.
Zlecenie właściciela: kompletny plan automatycznego odzyskiwania bez restartu bota.
Nie jest to zgoda na implementację, wdrożenie, zmianę ustawień ani zlecenia brokera.

## 1. Wynik i granice

Działający execution-engine ma sam rozpoznać izolowaną blokadę
`ACCOUNTING_CLOCK_INVALID`, uzyskać nowe wiarygodne dowody rozliczeń i usunąć
wyłącznie tę blokadę. Nie wymaga to restartu procesu, TWS ani ponownego `pnpm start`.
Dotyczy zarówno blokady odziedziczonej przy starcie, jak i powstałej podczas sesji.
Nowe wejścia pozostają zablokowane do pełnego potwierdzenia rozliczeń i przejścia
wszystkich dotychczasowych bramek. Awaria nie musi zakończyć się odzyskaniem:
niejednoznaczność, trwały zły zegar lub sprzeczne dane wymagają interwencji.

Zakres operacyjny: istniejący tryb ciągły Paper PKO/AAPL, dotychczasowe ilości,
strategie, budżety i odpowiedzialności usług. Live nie otrzymuje aktywacji tego
mechanizmu. Implementacja używa wspólnych modułów rozliczeń; różnicę dopuszczenia
stanowi jawna polityka środowiska, a nie alternatywna logika księgowania.
Nie zmieniamy progu zegara 2 s, wyliczania dnia, kosztów, limitów strat,
kwalifikacji TWS, reguł wejścia ani ryzyka zamknięcia.

Wykluczone: automatyczna synchronizacja czasu systemu, zmiana TWS, reset bazy,
kasowanie historii, reset budżetów, ogólne zdejmowanie holdów, retry zleceń,
nowy dashboard, strategie i zmiany w niezwiązanych lokalnych plikach ES/backtest.

## 2. Ustalenia ze źródeł i ostatniej pracy

- `accounting/source-collector.ts` odrzuca niecałkowite/niepoprawne sekundy epoki
  albo bezwzględną różnicę czasu odbioru i brokera większą niż 2000 ms.
  `clock_rejected` zawiera ograniczone diagnostyki wartości i odchylenia.
- `source-store.ts` zachowuje hold podczas `begin`; dobra kolejna odpowiedź go
  nie usuwa. Obecny `recoverClock` odnawia socket i atomowo zapisuje dowód oraz
  usuwa clock hold, pozostawiając `gap=true` i nieodnowioną kwalifikację.
- Publiczny `POST /execution/accounting/source/recover-clock` wymaga Paper,
  `TRADING_ENABLED=false` i efektywnej pauzy. Te wymagania pozostają bez zmian.
- `source-service.ts` serializuje inspect/join/qualify/recovery przez `busy`.
  `index.ts` sprawdza rozliczenia przy dopuszczaniu i końcowym zezwoleniu wejścia.
- `FullCloseService.refresh` korzysta z `reconScheduler.triggerFresh()`.
  Adapter `reconciliation/ib-broker-adapter.ts` zachowuje jednak zwykły snapshot
  brokera po nieudanym accounting join, celowo dla wyjść. Sam clock hold nie musi
  blokować close. Brak świeżych pozycji/zleceń lub innych wymaganych dowodów nadal
  blokuje wyjście; nie wolno utożsamiać snapshotu dla close z entry accounting proof.
- Logi 15–16.10 zawierały błędy zegara/replay, utratę połączenia, późniejsze
  ECONNREFUSED i WSH timeout. macOS odnotował 15.10 o 18:41:47 CEST uśpienie przez
  zamknięcie pokrywy, przed błędami połączeń. To korelacja, nie dowód przyczyny
  każdego odrzucenia zegara; dokładny pierwotny skew wymaga obserwacji w bazie.
- Sprawdzenie prywatnego profilu/obrazu przeszło 18.10. Usługi były zatrzymane;
  aktualny hold, kwalifikacja i pozycje nie zostały potwierdzone. W tym planie
  nie wykonujemy operacji na bazie operacyjnej ani połączeń brokerskich.

Referencje: [obecne recovery](PP7_ACCOUNTING_CLOCK_RECOVERY_PLAN.md),
[runbook rozliczeń](../../runbooks/PAPER_ACCOUNTING_SOURCE.md),
[ciągły Paper](../../runbooks/CONTINUOUS_PAPER.md),
[nadzór pozycji](../../runbooks/PAPER_LIFECYCLE_SUPERVISION.md),
[roadmap](../ROADMAP.md), [routing agentów](MODEL_ROUTING_GUIDE.md).

## 3. Niezmienne warunki bezpieczeństwa

1. Recovery odczytuje brokera; nie składa, nie anuluje ani nie modyfikuje zleceń.
2. Nie przełącza `TRADING_ENABLED`, startup entry pause ani trwałej pauzy operatora.
   Nie wywołuje `/resume`. Usunięcie technicznej blokady nie nadaje zgody na handel.
3. Istniejące wejścia wymagają finalnego accounting fence. Błąd przed wysłaniem
   uniemożliwia wysyłkę; wysłane/nieznane zlecenie pozostaje własnością dotychczasowego
   lifecycle i nie jest ponawiane. Recovery nie unieważnia rezerwacji zleceń.
4. W trakcie recovery dotychczasowy hold/gap oraz nowy stan epizodu blokują wejścia.
   Po zdjęciu clock hold stan VERIFYING nadal blokuje wejścia do nowego capture.
5. Zachowujemy wszystkie sprawdzenia obecnego store recovery: pełny replay, prowizje,
   tożsamości, historię sprzeczności, obie generacje, revision, lanes, ważność czasu
   procesu i bazy, końcowy fence przed COMMIT. Żaden dobry ping nie wystarcza.
6. Otwarte pozycje nie wyłączają recovery. Ich zmiany unieważniają nieaktualny dowód.
   TP/SL pozostają u brokera. Nadzór działa, ale brak wymaganych dowodów nadal blokuje
   konkretne zamknięcie i wywołuje istniejący alert. Nie dodajemy obejścia close-risk.
7. Nie odnawiamy kwalifikacji, nie zerujemy opłat/P&L ani nie ignorujemy innych holdów.
8. Nowy błąd zegara po zatwierdzeniu recovery od razu unieważnia gotowość. Restart,
   zmiana daty i przełączenie flagi nie resetują niepewnego epizodu ani limitów prób.

## 4. Architektura i uprawnienia

Dodać mały koordynator `accounting/clock-recovery-coordinator.ts` wewnątrz
execution-engine. Uruchamia się po inicjalizacji źródła; kończy i drenuje pracę
przy shutdown. Istniejący scheduler uzgodnień pozostaje właścicielem zwykłych
odczytów. Koordynator nie tworzy dodatkowego klienta accounting ani usługi.

Nowa opcja `EXECUTION_ACCOUNTING_AUTO_CLOCK_RECOVERY_ENABLED`, strict boolean,
domyślnie false. True wymaga jawnego Paper i poprawnie skonfigurowanego źródła;
Live/nieobsługiwane ustawienie odrzuca startup. Włączenie flagi we wdrożeniu jest
osobnym krokiem po recenzji, testach i CI. Nie zmienia zgody na broker writes.

Manualny endpoint zachowuje pełne obecne auth/account/write-disabled/pause guards.
Nie dodawać parametru `force`/`automatic` do API ani ogólnego bypassu w serwisie.
Wyodrębnić wspólny prywatny mechanizm dowodowy, z dwoma wejściami: obecnym manualnym
oraz wewnętrznym, przyjmującym niepodrabialną przez HTTP rezerwację koordynatora.
Wewnętrzna rezerwacja wiąże konto, źródło, epizod, owner/process, fencing token,
ustawienia i obowiązujący stan. Sprawdzać ją ponownie przed publikacją.

Pauza techniczna jest odrębna od pauzy operatora: durable accounting state oraz
lokalny fence, bez wywoływania entry-control pause/resume. Gdy przed awarią wejścia
były dozwolone, odzyskanie usuwa tylko techniczną przeszkodę. Ręczna pauza przed,
w trakcie lub po recovery pozostaje skuteczna, także po restarcie.

## 5. Trwały epizod, współbieżność i nieznany COMMIT

Dodać addytywną migrację o kolejnym wolnym numerze ustalonym przy implementacji:
trwałe epizody i próby recovery, unikalny aktywny epizod na source/account.
Minimalne dane: episodeId, origin clock-gap observation, state, attempt count,
first/last error, nextAttemptAt, owner process, fencing generation, lease expiry,
attemptId, outcome, inspection/receipt/capture IDs, created/updated times.
Historia prób i wyników jest niemutowalna; stan bieżący jest aktualizowany CAS.
Stały porządek krótkich transakcji: source control -> episode -> attempt; nie
pozyskiwać account/lifecycle locks pod tymi blokadami. Końcowe entry dispatch
recheck musi czytać także aktywny epizod, przy utrzymaniu istniejącego final fence.
Receipt, zdjęcie clock hold i przejście do VERIFYING są jedną transakcją.
Publikacja późniejszego capture/gap=false i RECOVERED są jedną transakcją albo
fence-preserving CAS sprawdzającym capture hash, qualification i aktualny control;
do udanego CAS epizod nadal bezwarunkowo blokuje wejścia. Automatyczny terminalny
CAS jest dozwolony tylko z VERIFYING; OPERATOR_REQUIRED wymaga manualnej gałęzi
z sekcji 8. Inne publish/qualify
nie mogą ominąć tego fence. Failed/unknown COMMIT zostawia lokalne blokowanie.
READINESS dla capture nie może zależeć od zamknięcia epizodu (brak cyklu); entry
admission dodatkowo wymaga jego zakończenia. Zmiana manual pause pozostaje osobna.
Nie umieszczać sekretów ani surowych odpowiedzi providera.

Identyfikacja epizodu: kolejne odrzucenia zegara podczas tego samego nierozwiązanego
incydentu nie tworzą nowych budżetów. Epizod zamyka dopiero nowy poprawny capture.
Stan exhausted/unknown wymaga jawnego, audytowanego działania operatora; flaga,
restart i kolejny zły callback nie odblokowują go. Rekurencja po zakończonym
odzyskaniu tworzy nowy epizod, lecz podlega wspólnemu limitowi source.

Przed `initialize()/store.begin()` oraz każdym pierwszym `collector.connect()`
uzyskać session advisory lock na osobnym połączeniu DB, kluczowany kanonicznym
endpointem TWS i clientId=0 (nie tylko kontem). Lock obejmuje cały czas życia źródła,
także flag=false, manual recovery i zwykły join. `begin` nie może nadpisać ownera
bez tego uprawnienia. Wszystkie wejścia do socketu sprawdzają ten sam owner fence.
Utrata locka natychmiast blokuje publikację/wejścia i zleca rozłączenie. Nie jest
dowodem zniknięcia starego socketu. Inny proces nie łączy się, dopóki trwały stan
retirement nie potwierdza jego zamknięcia; awaria ownera może wymagać operatora.

Collector otrzyma osobną, ograniczoną ścieżkę potwierdzenia disconnect starego
socketu (maks. 2 s). Callback zakończenia transportu może zamknąć retirement, ale
żadne jego spóźnione dane nie mogą certyfikować nowej generacji. Obecne `close()`
bez potwierdzenia nie jest wystarczającym dowodem. Brak ack -> OUTCOME_UNKNOWN.

Claim pod blokadą wiersza; trwały token fencing sprawdzany w transakcji recovery.
Jeden aktywny odczyt źródła: manual recovery, inspect, qualify, join i auto recovery
korzystają z jednego arbitra. Busy nie jest błędem brokera i nie zużywa próby.
Nie trzymać transakcji DB przez połączenie sieciowe. Lease nie daje prawa uruchomienia
kolejnego socketu, dopóki poprzedni właściciel nie został jednoznacznie wyłączony.
Przejęcie przez drugi żywy proces jest niedozwolone; konflikt właściciela blokuje
recovery. Restart wymaga dowodu wyłączności endpoint/client-0, a brak dowodu kończy
się OPERATOR_REQUIRED, nie przejęciem przez sam timeout lease.

Przed pierwszym broker read utrwalić CHARGED/RUNNING attempt. Crash po tej granicy
zużywa próbę. Lost COMMIT nie prowadzi do ponowienia transakcji w ciemno: odczytać
receipt według stabilnego attemptId i sprawdzić aktualne control/episode. Potwierdzony
commit przechodzi do VERIFYING, potwierdzony rollback może przejść do BACKOFF,
a brak jednoznaczności do OUTCOME_UNKNOWN. Próba bez potwierdzonego zakończenia
starego socketu również wymaga operatora. Retry odczytu DB nie jest retry brokera.

## 6. Maszyna stanów i limity

| Stan | Zachowanie / przejście |
| --- | --- |
| IDLE | Brak clock hold; normalne kontrole. Brak wywołań recovery. |
| WAITING | Hold wykryty, wejścia blokowane. Czekanie na stabilną tożsamość/połączenie i termin próby. |
| RECOVERING | Jedna zarezerwowana próba: nowy socket, clock, pełny replay, kontrola kosztów i transakcja. |
| VERIFYING | Receipt zatwierdzony, gap nadal true. Wymagany nowy joined capture z ważną kwalifikacją. |
| RECOVERED | Capture potwierdzony, epizod zamknięty. Inne bramki i pauza pozostają niezależne. |
| BACKOFF | Potwierdzony przejściowy błąd i zakończony socket; czekanie na kolejny termin. |
| OPERATOR_REQUIRED | Wyczerpanie limitu, sprzeczność, brak kwalifikacji lub brak dowodu wyłączności. |
| OUTCOME_UNKNOWN | Niepewny commit/cleanup/owner; brak automatycznej kolejnej akwizycji. |

Ustalić v1 jako stałe, testowane wartości, bez rozbudowanej konfiguracji:
- Tick 5 s, bez nakładania przebiegów; 10 s stabilnego connected/account/settings
  execution-source przed pierwszą próbą, mierzone zegarem monotonicznym. Nie
  wymagać ready starego accounting socketu: nowe połączenie tworzy sama próba.
- Maksymalnie 3 automatyczne akwizycje na epizod; odczekanie 30 s po pierwszym niepowodzeniu,
  120 s po drugim. Maksymalnie 6 rozpoczętych akwizycji na source w kroczącym 1 h.
- Budżet operacji: 9 s na odczyt sieciowy, 2 s łącznie na oczekiwanie persistence/
  transakcję (statement/lock timeout i cancellation), 2 s na cleanup. Cel pełnego
  przebiegu do 13 s, bez poluzowania dowodów freshness; spóźniony dowód odrzucić.
  Timeout DB nie dowodzi rollbacku: ustalić outcome według attemptId. Nie publikować
  sukcesu z późnego Promise. Po deadline proces pozostaje responsywny, lecz przy
  niepotwierdzonym cleanup zachowuje owner fence i nie zaczyna nowej akwizycji.
- VERIFYING: próby zwykłego capture najczęściej co 5 s, maksymalnie 60 s od
  potwierdzenia receipt; potem OPERATOR_REQUIRED, bez kolejnego czyszczenia holda.
- DB UTC jest trwałą podstawą nextAttemptAt i limitów. Czas procesu monotoniczny
  służy do interwałów w jednej instancji. Skok czasu procesu/DB do przodu lub tyłu
  nie może skrócić backoff/resetować limitu: wykryta niespójność blokuje nowe próby
  i wymaga operatora; brak dowodu poprawności czasu po restarcie nie pozwala rearm.
- Każdy nowy invalid-clock w VERIFYING ponownie zamyka fence i wraca do tego samego
  epizodu/budżetu; nie generuje nieograniczonej serii nowych epizodów.

Klasyfikacja jest jawna:

| Kod | Wynik przy potwierdzonym cleanup i bez silniejszego holda |
| --- | --- |
| ACCOUNTING_CLOCK_INVALID | BACKOFF w tym samym epizodzie, do limitu |
| ACCOUNTING_REPLAY_INCOMPLETE / ACCOUNTING_SOURCE_GAP | BACKOFF po potwierdzonym błędzie odczytu; brak ack -> OUTCOME_UNKNOWN |
| ACCOUNTING_CLOCK_RECOVERY_CHANGED / ACCOUNTING_REVISION_CHANGED | BACKOFF po zwykłym nowym fill/fee lub zmianie generacji; korekta/tożsamość -> OPERATOR_REQUIRED |
| ACCOUNTING_SOURCE_BUSY | WAITING, bez charge i bez nowego socketu |
| ACCOUNTING_QUALIFICATION_REQUIRED / ACCOUNTING_QUALIFICATION_EXPIRED | OPERATOR_REQUIRED, istniejąca procedura kwalifikacji |
| Inne kody, w tym costs/history/persistence | OPERATOR_REQUIRED albo OUTCOME_UNKNOWN, bez automatycznego retry |

Klasyfikacja błędów jest allowlistą: potwierdzony timeout odczytu, chwilowy brak
połączenia lub zmiana obserwowanej generacji może kwalifikować się do BACKOFF
wyłącznie po dowodzie zakończenia akwizycji. Nieznany kod jest terminalny.
Identity/settings mismatch, brak kosztów, historia korekt, błędy persistence,
nieznany wynik i nieważna kwalifikacja nie są automatycznie kasowane.
Zwykły `ACCOUNTING_REPLAY_INCOMPLETE` bez clock hold pozostaje obsługiwany przez
normalny scheduler i nie uruchamia nowego mechanizmu zdejmowania blokady.

## 7. Otwarte pozycje, wyjścia i brak zagłodzenia

Nie wyłączać master writes, nie zatrzymywać observera, nie anulować TP/SL i nie
przerywać rozpoczętego close. Odnawiany jest wyłącznie dedicated accounting socket;
execution socket i jego callbacki pozostają aktywne. Napływający fill/fee zmienia
barierę i uniemożliwia zatwierdzenie starego dowodu; normalne ownership nadal działa.

Arbiter daje pierwszeństwo nadzorowi/wyjściom. Zwykłe join przy znanym clock hold
lub zajętym recovery zwracają natychmiast accounting-unavailable; nie czekają
w kolejce blokującej snapshot pozycji/zleceń. Zachować istniejący fallback adaptera
bez accounting proof i wszystkie obecne close evidence/risk guards. Nie wprowadzać
nowego alternatywnego snapshotu ani używać fallbacku jako dowodu dopuszczenia entry.
Recovery uruchamia niezależny koordynator, nigdy synchroniczne join. Po receipt
zleca świeży capture dopiero po zwolnieniu arbitra, przez scheduler; bez cyklu
scheduler -> join -> recovery -> triggerFresh. Koordynator nie trzyma źródła
podczas BACKOFF ani VERIFYING. Ograniczenia czasowe z sekcji 6 nie są gwarancją
czasu wykonania SELL. Alerty, wykonania i event loop nie czekają na recovery.

Testować produkcyjne powiązanie observer -> refresh -> scheduler -> adapter ->
accounting -> close, w tym równoległy deadline close podczas recovery, kompletność
zwykłego snapshotu i odmowę entry na tym samym fallbacku. Jeśli wymagane zmiany
wykraczają poza zachowanie tego kontraktu, zatrzymać implementację i zrecenzować
amendment; żadnego obchodzenia close-risk.
Przy deadline z nieodzyskanymi danymi zachować dotychczasowe reguły odmowy i alarm
operatora. Brak gwarancji zamknięcia przy niedostępnym brokerze lub niespójnych
rozliczeniach jest jawną granicą; automat nie może obiecywać SELL za wszelką cenę.

## 8. Diagnostyka i obsługa operatora

Rozszerzyć istniejący accounting status, polskie logi, `pnpm status` i supervision
bez nowego UI. Pokazać flagę, epizod, fazę, attempt/limit, nextAttemptAt, wiek błędu,
sanitary original cause, skuteczność blokady wejść, receipt oraz wynik capture.
W odrzuceniu czasu podać dostępne requested/received/reported/skew i generację;
wartości brakujących nie rekonstruować. Korelacja z uśpieniem pozostaje hipotezą.

Przykłady: „Błąd zegara: wejścia wstrzymane, odzyskiwanie 1/3”, „Odczyt poprawny;
czekam na uzgodnienie”, „Rozliczenia odzyskane; ręczna pauza nadal aktywna”,
„Odzyskiwanie wymaga operatora: …”. RECOVERED nie oznacza automatycznie TRADING_READY.

Wykorzystać istniejący trwały transport alertów. Lokalny błąd widoczny od razu;
alert terminalnego/niepewnego wyniku oraz zagrożenia wyjścia, deduplikowany epizodem.
Nie wyciszać istniejących faultów lifecycle ani nie uznawać wysłania za rozwiązanie.
Jawny rearm OPERATOR_REQUIRED wymaga odrębnej audytowanej kontroli z auth/account,
aktualnym dowodem przyczyny i bez kasowania limitu godzinowego. W v1 rozszerzyć istniejącą
manualną ścieżkę przy niezmienionych auth/Paper/write-disabled/pause guardach:
(a) gdy clock hold istnieje, zwykłe recovery; (b) gdy receipt już istnieje, a hold
jest null (np. timeout VERIFYING), gałąź evidence-only wiąże aktualny ważny capture
z epizodem i zamyka go przez CAS. Gałąź (b) nie tworzy socketu, nowego receipt,
nie czyści holdów ani nie resetuje limitów; przy braku capture odmawia. Wygasłą
kwalifikację odnawia wyłącznie istniejąca procedura qualify z rzeczywistymi dowodami,
a scheduler pozyskuje nowy capture. Unknown COMMIT musi być wcześniej rozstrzygnięty.
Nie dodawać uniwersalnego endpointu reset. Zakończenie po manualnym receipt/capture
musi być testowane i nie może usuwać innych faultów ani samoczynnie resume wejść.

## 9. Pakiety implementacyjne i pliki

| Pakiet / zależność | Zakres | Wykonawca |
| --- | --- | --- |
| A: kontrakt, przed B–D | Typy epizodu, migracja, claim/fencing/limity, protokół unknown, final entry fence | gpt-6-astra / high |
| B: po A | Koordynator, wspólny mechanizm dowodowy, arbiter, shutdown/startup, Paper gating | gpt-6-astra / high |
| C: po A+B | Pełna integracja reconciliation/observer/entry oraz wyścigi wyjść | gpt-6-astra / high |
| D: po zamrożeniu A–C | Czyste formatowanie statusu/logów pod zaakceptowany kontrakt | gpt-6-luna / medium |
| E | Niezależna hostile review całego pakietu | inny gpt-6-astra / high |
| F: po akceptacji | Kontrole, scoped commit/push, CI dokładnego SHA | gpt-5.6-luna / low |

Przewidywany zakres: `apps/execution-engine/src/accounting/{source-service,
source-store,source-collector,types,routes}.ts`, nowy coordinator i testy,
`apps/execution-engine/src/index.ts`, istniejący scheduler/adapter uzgodnień,
`apps/execution-engine/src/config.ts`, `infra/sql/migrations/`,
`apps/execution-engine/src/migrations.ts`,
`packages/shared/src/diagnostics/{types,presentation}.ts` oraz
`tools/paper-verify-stack/src/operator-cli.ts` i `paper-runtime.ts`.
Runbook rozliczeń, ciągłego Paper i raport pakietu. Numer migracji i konieczne pliki testowe ustalić przed task packet;
bez rozszerzania semantyki.
Nie edytować strategii ani istniejących niezwiązanych zmian lokalnych.

Każde zlecenie agentowi: zaakceptowany kontrakt, dokładne pliki, model/effort,
zależności, invariants, komendy testowe, stop conditions i wymagane dowody.
Rozdzielić pliki równoległych autorów; wspólne kontrakty integrować pierwsze.
Plan i implementację recenzują różni niezależni agenci; finalny reviewer nie jest
współautorem. Brak modelu ujawnić i użyć równoważnej/silniejszej trasy.

## 10. Kryteria akceptacji i testy wrogich scenariuszy

- Startup z trwałym izolowanym holdem oraz błąd w trakcie pracy: odzyskanie w tym
  samym PID, bez restartu TWS, bez `/resume`, bez przełączania master i bez zleceń.
- Poprawny clock + pełny replay + zgodne koszty: jeden receipt, potem nowy capture;
  wejście przed capture odrzucone, po capture zależy od wszystkich normalnych bramek.
- Manualna pauza przed/w trakcie/po recovery oraz równoległe operator resume:
  zachowanie revision/guardów, brak automatycznej zmiany decyzji operatora.
- Jedna/dwie posiadane akcje, działające TP/SL, deadline close, fill TP/SL w czasie
  recovery, SELL/fee między inspekcją i COMMIT: brak utraty ochrony przez recovery,
  duplikatu, odwrócenia pozycji, pominięcia kosztu lub zatwierdzenia starej bariery.
- Błąd między permit a wysłaniem entry: brak nowej wysyłki; po wysłaniu brak retry.
- Obce konta, zmiana konfiguracji/źródła/generacji, wygasła kwalifikacja, korekty,
  brak fees, orphan fee, invalid event/history conflict: hold i odmowa pozostają.
- Zły/NaN/fractional/future clock, >2 s skew, brak odpowiedzi, stary callback,
  pre-request callback, zły dzień, brak replay end: odmowa, brak fałszywego receipt.
- Join/inspect/qualify/manual/auto równocześnie, dwa procesy i wygaśnięcie lease:
  jeden właściciel od initialize/begin, bez dwóch client-0 również przy flag=false,
  lock loss/retirement timeout, busy bez charge, brak starvation i cyklu schedulera.
- Crash przed claim, po charge, podczas replay, przed/po COMMIT i przed capture;
  utracona odpowiedź COMMIT, deadlock, lock delay, DB outage: deterministyczna
  rekonstrukcja albo OUTCOME_UNKNOWN; nigdy reset budżetu lub ślepy retry.
- Zegary hosta/DB cofają się/skaczą, sleep/wake, midnight i restart: zachowane
  limity/backoff/freshness, brak samoczynnego rearm; downtime nie jest dowodem zdrowia.
- Wyłączenie flagi w aktywnym epizodzie: brak nowych prób, fence pozostaje,
  odczyt statusu i manual recovery dostępne według istniejących reguł.
- Brak clock hold lub sama niekompletność replay: brak auto clear; flaga false
  zachowuje poprzednie zachowanie. Live/auth guards manualnego API bez zmian.
- Udane manual recovery po auto exhaustion: powiązanie receipt/capture, zachowane
  próby/history/hourly cap i operator pause. Niepewny auto wynik nadal wyjaśniany.
- Diagnostyki nie ujawniają sekretów/raw payload; utrata transportu alertów nie
  udaje powodzenia i nie omija istniejących warunków unattended admission.

Testy jednostkowe fake sockets/clocks, integracyjne z rzeczywistym store/scheduler
na izolowanym PostgreSQL i testy pełnego lifecycle/admission. Zero broker/provider
calls w testach. Wymagane: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm test:integration` na disposable PostgreSQL, `pnpm build`, clean Docker build.
Brak zmiany strategii/symulatora: backtest nie stanowi dowodu dla tego mechanizmu.

## 11. Wdrożenie, walidacja operacyjna i rollback

1. Zatwierdzony plan, implementacja i niezależna hostile review; wszystkie lokalne
   kontrole oraz CI dokładnego commitu zielone. Zbudować czysty obraz z reviewed SHA.
2. Backup audytu/DB i prywatnych profili, stan rachunku/pozycji/zleceń i kwalifikacji.
   Wdrożenie w uzgodnionym oknie z pauzą wejść; preferowane potwierdzone flat.
   Nie wyłączać działającego nadzoru dla aktywnej pozycji bez planu jej obsługi.
3. Migracja addytywna, flag false, sprawdzenie zgodności profilu i statusu. Nie
   deklarować starego obrazu kompatybilnym z aktywnym nowym stanem bez dowodu.
4. Jawnie zatwierdzony Paper opt-in flagi; przy izolowanym realnym clock hold
   obserwować jeden epizod, receipt i capture bez restartu. Nie psuć zegara hosta
   ani nie uśpić urządzenia z ekspozycją w celu testu. Fault injection wyłącznie
   izolowane środowisko; brak naturalnego incydentu oznacza operacyjnie nieudowodnione.
5. Soak przez pełne sesje GPW i USA, obserwacja następnego startu/dnia, brak powodzi
   prób/alertów i zachowanie pauz. Open-position race proof w testach; dowód realnego
   trade/close odrębny, wyłącznie w zakresie autoryzacji właściciela. Nie wymuszać sygnału.
6. Rollback: wyłączyć nowe próby, utrzymać pauzę wejść i kompatybilny nadzór; zachować
   epizody, receipt, próby i fence. Nie usuwać migracji ani resetować holdów. Stary
   writer ignorujący nowe epizody jest niedozwolony, gdy istnieje niezamknięty epizod;
   w takim przypadku wdrożyć kompatybilną poprawkę. Zmiana flagi nie jest recovery.

Dla operatora docelowo: Docker + TWS Paper + `pnpm start`; podczas przejściowego
clock fault automat podejmuje ograniczone odzyskanie bez ponownego startu. Nadal
wymagane zasilanie, brak sleep i poprawne ustawienia TWS. Interwencja tylko dla
jawnie nierozwiązywalnego/niepewnego wyniku, a nie każdego przejściowego odrzucenia.

## 12. Dostarczenie samego planu

Ten dokument przechodzi niezależną recenzję planu, poprawki oraz osobną recenzję
finalnego dokumentu. Sprawdzić fakty, lokalne linki i scoped diff; nie uruchamiać
runtime suites dla samej dokumentacji. Zgodnie z AGENTS.md commit/push na main
obejmuje wyłącznie ten plan; następnie zweryfikować CI dokładnego SHA lub jawnie
podać ograniczenie dostępu. Implementacja i wdrożenie pozostają przyszłymi etapami.

### Ewidencja dostarczenia planu

- Autor: bieżący lead; dokładna telemetria modelu/effort niedostępna.
- `clock_plan_review`: żądany gpt-6-astra/high, uruchomiony z tym ustawieniem;
  zaakceptował po jednej rundzie pięciu poprawek opisanych poniżej.
- Poprawki: istniejący fallback wyjść; owner fence przed initialize/connect i ack
  retirement; manualne zamknięcie epizodu z hold=null; budżety czasu całej operacji;
  atomowe przejścia/fence pomiędzy receipt, capture i gotowością wejść.
- `clock_document_review`: odrębny gpt-6-astra/high, bez autorstwa zmian; ACCEPT, bez ustaleń blokujących. Sprawdził 6 linków
  lokalnych, 12 istniejących ścieżek i zgodność kluczowych twierdzeń ze źródłami.
- Nie eskalowano modeli. Zużycie tokenów i dokładny czas recenzji niedostępne;
  brak deklaracji oszczędności. Testy runtime celowo nieuruchamiane dla prose.
- Lokalne linki i whitespace sprawdzone, brak zmian implementacji. Publikacja
  i CI dokładnego commitu są potwierdzane w końcowym komunikacie dostarczenia;
  ten zapis nie deklaruje ich wyniku przed utworzeniem commitu.
