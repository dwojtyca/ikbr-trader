# PP7: od kontraktu WSH do pierwszej nadzorowanej transakcji PKO

Data: 2026-10-07. Status: plan zaakceptowany w niezależnym przeglądzie Astra/high.
Akceptacja planu nie zatwierdza jeszcze rozstrzygnięć kontraktu WSH z G1
ani aktywacji operacyjnej z G3/G4.
Dokument uszczegóławia cztery punkty wybrane przez właściciela w rozmowie.
Kontynuuje [plan domknięcia PP7](PP7_CLOSURE_PLAN.md),
[plan dostarczenia Paper](PAPER_PRODUCTION_DELIVERY_PLAN.md) i
[roadmapę](../ROADMAP.md). Nie rozpoczyna ponownie PP0–PP6.

## 1. Cel i granice

Rezultat tego zakresu: zweryfikowany kalendarz zdarzeń w istniejącym przepływie
research, pozytywny preflight wdrożenia z wyłączonym handlem oraz dowód normalnego
wejścia, ochrony i wyjścia na **jednej całej akcji PKO** na IBKR Paper.
Strategia pozostaje `momentum_breakout_long_v1`, instrument `pko_wse`, WSE, PLN.

Przygotowanie adaptera i kwalifikacja danych obejmują PKO oraz AAPL. Pierwsza
autoryzowana próba handlu dotyczy wyłącznie PKO. Nie rozszerzamy teraz strategii,
liczby równoczesnych pozycji, ilości akcji, UI ani Live. Zachowujemy istniejące
parametry strategii, Risk Engine, mandatory AI, audyt, ownership i reconciliation.

Jedna próba PKO zamyka wyłącznie część Gate B dla PKO. Pełne PP7 nadal wymaga
pozostałych dowodów AAPL, Gate C i Gate D z nadrzędnego planu; ten dokument nie
zmienia liczby wymaganych sesji ani zasad ich zaliczenia.

**Bieżące zadanie jest dokumentacyjne:** przygotować, niezależnie sprawdzić
i opublikować ten plan, raport jego dostarczenia oraz odsyłacz w planie nadrzędnym.
Nie uruchamia adaptera, dostawców, powiadomień ani handlu. Wykonanie przyszłych
pakietów korzysta z wcześniejszego zlecenia domknięcia PP7, lecz nadal wymaga
ich konkretnych zaakceptowanych kontraktów i odrębnych bramek operacyjnych.

## 2. Stan wejściowy i dowody

Baza kodu: `b4bcc371cc2c3b9053ce7bc31ce4b2586effda4e` na `main`.
[Raport dotychczasowej implementacji](PP7_CLOSURE_REPORT.md) opisuje wydane E1a,
E1b i F1. Poniższe późniejsze obserwacje pochodzą z diagnostyki 2026-10-07;
nie zastępują świeżych dowodów przy uruchomieniu.

| Obszar | Zaobserwowane | Nadal nieudowodnione |
| --- | --- | --- |
| TWS Paper | Połączenie API, zgodność konta z allowlistą, zegar; operator potwierdził Warsaw, Master 0 i siedem dni historii | Operacyjna kwalifikacja F1 dla wdrożonego endpointu, aktualne dane rachunku i reconciliation |
| WSH | Dostęp po restarcie; 3 rekordy PKO i 14 AAPL; właściwe conId i ISIN w każdym rekordzie | Pełny kontrakt zakresu/kompletności, znaczenie filtrów, uprawnienia do utrwalania i produkcyjny adapter |
| Daty WSH | Walne PKO 14 października; niepotwierdzone daty wyników; DATE i INSTANT | Wszystkie 3 rekordy PKO i 12 z 14 AAPL nie mają `announce_*`; pozostałe pola wymagają weryfikacji znaczenia |
| Marketaux | AAPL: 17 rekordów, zgodne dwa pełne przebiegi; PKO.PR: zgodne dwa puste przebiegi w jednym oknie 24 h | Rzeczywisty plan konta, operacyjna kwalifikacja/expiry, odpowiednia przydatność pokrycia PKO i budżet dalszej pracy |
| OpenAI | Jedna syntetyczna próba przez produkcyjny decider: `gpt-5.4-2026-03-05`, 4709/159 tokenów, ok. 5,9 s | Przyjęty operacyjny manifest modelu i budżet; rzeczywista ocena propozycji handlowej |

Sam symbol `PKO` w Marketaux identyfikuje PIMCO Income Opportunity Fund.
Kandydat `PKO.PR` został znaleziony przez entity search; jego związek z ISIN
`PLPKO0000016` potwierdzają [giełda w Pradze](https://www.pse.cz/en/detail/PLPKO0000016)
i [emitent](https://www.pkobp.pl/relacje-inwestorskie/akcjonariusze).
Kraj `cz` i `exchange: null` są danymi dostawcy, nie zmianą instrumentu wykonania
na rynek czeski. Pusty wynik nie dowodzi braku wiadomości o banku na świecie.

Prywatny indeks diagnostyki: `qualification-summary.json` w katalogu
`/private/tmp/pp7-provider-qualification-20261007`. Zawiera ścieżki, hashe i
rozliczenie wywołań. Przed operacją przenieść potrzebne dowody do trwałego
prywatnego katalogu zgodnie z runbookiem; pliki tymczasowe nie są gwarancją retencji.
Nie kopiować do Git identyfikatorów rachunku, sekretów, artykułów ani surowych
licencjonowanych payloadów. Fixtures mają używać danych syntetycznych.

Jednorazowa zgoda: **Marketaux 20/20 wywołań wykorzystane**, OpenAI **1/5**,
szacowany standardowy koszt użycia modelu 0,0141575 USD, konserwatywna rezerwacja
1 USD z limitu 5 USD. Rezerwacja nie jest rachunkiem dostawcy. Pozostałych czterech
wywołań OpenAI nie traktować jako zgody na regularną pracę; limit Marketaux jest
wyczerpany. Ta publikacja nie wykonuje nowych wywołań.

## 3. Kolejność i bramki

| Punkt | Pakiet w PP7 | Produkt | Warunek rozpoczęcia następnego punktu |
| --- | --- | --- | --- |
| 1 | E1c: kontrakt WSH | Konkretny, niezależnie zaakceptowany kontrakt źródła i reprezentacji danych | G1: rozstrzygnięte pytania krytyczne; dodatnia ścieżka ma oparcie w dowodach |
| 2 | E1c: implementacja | Adapter, integracja, testy, runbook, przejrzany commit i obraz | G2: hostile review, wymagane checks, czysty build Docker i CI dokładnego SHA |
| 3 | Gate A | Prywatny manifest wdrożenia i raport preflight przy wyłączonym handlu | G3: wszystkie wymagane kontrole pozytywne oraz konkretna autoryzacja próby |
| 4 | Gate B — PKO | Dowód wejścia, ochrony, wyjścia i rozliczenia jednej akcji | G4: normalny round trip udowodniony; dalsza aktywacja pozostaje odrębna |

Brak danych, błąd albo nieznany wynik zatrzymuje zależny etap. Można kontynuować
niezależne przygotowania i testy offline. Nie uznawać blokady za zaliczenie etapu.

## 4. Punkt 1 — ustalenie kontraktu WSH

### Prace

1. Zweryfikować oficjalną dokumentację i faktyczne możliwości zainstalowanego
   `@stoqey/ib` 1.6.10 / TWS. Zapisać dokładny request, wersję metadanych i odpowiedź.
   Punkty odniesienia: [aktualne WSH API](https://www.interactivebrokers.com/docs/tws-api/doc/wall-street-horizon/introduction)
   oraz [opis wywołań i ograniczenia współbieżności](https://interactivebrokers.github.io/tws-api/fundamentals.html).
   Dokumentacja potwierdza API, nie kwalifikuje sama kompletności naszego odczytu.
2. Zdefiniować tożsamość: skonfigurowany instrument → broker-resolved conId → ISIN
   emitenta → zdarzenia. Sprawdzanie tożsamości każdego wiersza jest obowiązkowe.
   Bez listy aktywacyjnej tickerów w parserze; kolejne wspierane akcje mają korzystać
   z tego samego kontraktu po konfiguracji i kwalifikacji źródła.
3. Rozstrzygnąć zakres zapytania: jawne daty, strefa, typy zdarzeń, parametry
   `fillWatchlist/fillPortfolio/fillCompetitors`, `filter` i `totalLimit`.
   Wyjaśnić obserwowane `filterSource=watchlist` przy żądaniu dla conId z fill=false.
   Nie włączać rozszerzenia portfela/watchlisty w celu uzyskania wyniku.
4. Udokumentować warunek kompletności i zakończenia: limity, ewentualna paginacja
   lub podział okna, brak ukrytego obcięcia, błędy i odpowiedź pusta. Sam callback,
   liczba mniejsza niż limit albo powtórzony identyczny wynik nie stanowią dowodu
   bez ustalonej semantyki dostawcy. Okno wystąpień ma obejmować co najmniej cały
   wymagany horyzont zakazu wejścia, także graniczne pełne dni lokalne.
5. Ustalić klasyfikację zdarzeń i wersjonowanie: earnings/material/other,
   powiązanie `wshe_ed` i `wshe_fq`, duplikaty, zmiany daty, odwołania, konflikty,
   zdarzenia wielodniowe i nieznane typy. Zmiana lub brak rekordu nie dowodzi
   odwołania. Nieznany istotny typ/stan nie może po cichu znikać z oceny.
6. Ustalić uprawnienia, retencję, wygaśnięcie dostępu trial, limity wywołań,
   timeouty, rozmiary odpowiedzi i termin ważności kwalifikacji. Zakup trial przez
   operatora i działający socket nie zastępują tych ustaleń.

### Czas publikacji, czas obserwacji i niepewne terminy

Obecny `ResearchEvidence.published` jest obowiązkowy. WSH nie dostarczył go
dla większości badanych zdarzeń. Nie wolno wpisać w to miejsce czasu pobrania
ani daty samego wydarzenia. Punkt 1 ma zakończyć się wyborem jednej jawnej,
implementowalnej ścieżki dla każdego wymaganego rodzaju danych:

- Pole publikacji o potwierdzonym znaczeniu lub ograniczone, kwalifikowane źródło
  ogłoszenia emitenta. Dodatkowe pobrania wymagają konkretnego allowlistu,
  provenance, budżetu i własnych reguł walidacji; bez ogólnego crawlera.
- Albo osobny, wersjonowany model wiedzy o **kalendarzu prospektywnym**:
  publikacja jawnie nieznana, a pierwsza obserwacja danej wersji zdarzenia
  potwierdzona trwałym odczytem dostawcy. Dane mogą obowiązywać najwcześniej od
  tej obserwacji; nie mogą udawać publikacji ani wiedzy historycznej. To kandydat
  na zmianę kontraktu, **nie zatwierdzony wyjątek od obecnej eligibility**.
  Wymaga osobnego rozstrzygnięcia Astra i niezależnego przeglądu przed kodem:
  wersja schematu, migracja/czytanie historii, hashe, prompt/binding AI,
  aktualizacja i unieważnianie dowodów oraz brak look-ahead.

Nie rozszerzać takiej ewentualnej reprezentacji na raporty finansowe lub newsy.
Do akceptacji konkretnego rozwiązania obowiązuje dotychczasowe odrzucenie
niepełnych dowodów. Jeśli żadnej ścieżki nie da się uzasadnić, G1 pozostaje
zablokowana z dokładnym wskazaniem brakującego pola/gwarancji i możliwego źródła.

`DATE` pozostaje datą w potwierdzonej strefie IANA, `INSTANT` wymaga jawnego
offsetu lub równoważnego dowodu. `CET/EST`, „After Market” i „Unspecified” nie
uprawniają do zgadywania dokładnej godziny. Kontrakt obejmuje DST i 23/25-godzinne
dni. Zakaz wejścia dla earnings/material pozostaje co najmniej 24 h przed i po
całym potwierdzonym przedziale zdarzenia; nie skracamy go w tym pakiecie.

Status `UNCONFIRMED` musi pozostać widoczny. Kontrakt zdecyduje, czy można dowieść
skończonego konserwatywnego przedziału niepewności, czy kalendarz pozostaje
UNVERIFIED. Nie zamieniać daty szacunkowej na pewną, nie usuwać zdarzenia i nie
przepisywać go na `other`, żeby dopuścić wejście. Brak granic niepewności pozostaje
blokadą; sama odległa data szacunkowa nie dowodzi bezpiecznego dzisiejszego okna.

### G1 — kryteria odbioru

- Powstaje konkretny kontrakt E1c: pola, wersje, request/receipt, limity,
  tożsamość, czas, pewność, kompletność, licencja i tabela wyników negatywnych.
- Każda krytyczna niewiadoma ma rozstrzygnięcie poparte źródłem lub pozostaje
  nazwaną blokadą. Nie wysyłać z tego powodu wiadomości do IBKR/WSH bez zgody
  operatora na kontakt; przygotowanie pytania nie wymaga jej ponownie.
- Istnieje uzasadniony scenariusz AVAILABLE i poprawnie udowodnionego EMPTY,
  a także scenariusze odmowy. Sam adapter zwracający zawsze UNVERIFIED nie
  spełnia celu uruchomienia.
- Niezależny Astra/high akceptuje kontrakt oraz zakres zmian. Uzupełnienie
  reprezentacji danych nie może po cichu osłabić pozostałych warunków wejścia.

## 5. Punkt 2 — adapter i integracja z istniejącym przepływem

### Zakres implementacji po G1

1. Dodać wyłącznie reprezentację WSH/source receipt i ewentualne zmiany typu
   czasu/statusu zatwierdzone w G1. Zachować czytelność starych snapshotów,
   niezmienność audytu i jawne zachowanie starego writera/rollbacku.
2. Dodać wąski transport odczytu w obszarze research `llm-agent`, bez metod
   składania/zmiany zleceń. Korzystać z istniejącego SDK przez jawną zależność
   pakietu. Dedykowany niezerowy clientId nie może kolidować z execution,
   ingestion, completed orders, metadata, backtest ani księgowym client 0.
   Nie przenosić research do strategii lub execution-engine.
3. Metadane pobierać przed event data, a operacje WSH serializować według
   kwalifikowanego kontraktu także między procesami/emitentami. Każde wywołanie,
   w tym metadane i segmenty, ma rezerwację przed wysłaniem, limit czasu/rozmiaru,
   korelację requestId i odcięcie późnych callbacków po zakończeniu. Błąd/timeout
   nie zwraca budżetu i nie uruchamia ślepej ponownej próby.
4. Napisać czysty normalizer, podłączyć `ResearchRefreshScheduler`, istniejące
   `reserveCall`/`recordCallOutcome`, immutable snapshot i walidację eligibility.
   Tożsamość odczytu socketowego musi być jawna; nie tworzyć fikcyjnego endpointu
   HTTPS. Link WSH/emitenta jest referencją, nie automatycznym prawem pobrania.
   Nie przepisywać HTTP na HTTPS ani nie rozszerzać globalnych reguł SSRF/URL.
5. Niepełny/błędny odczyt publikuje aktualny stan negatywny zgodnie z istniejącą
   semantyką refresh. Nie zachowuje starego AVAILABLE jako bieżącego sukcesu.
   W razie awarii DB, gdy zapisu nie da się potwierdzić, admission pozostaje
   zablokowane; brak zapisu nie jest pozytywnym odświeżeniem.
6. Ponownie sprawdzać kwalifikację/expiry przy rezerwacji, odczycie, publikacji,
   przygotowaniu AI i finalnym dispatch. Zmiana/wygaśnięcie źródła, konfiguracji
   lub snapshotu unieważnia poprzednie powiązanie decyzji.
7. Dodać polskie komunikaty PP6, nieaktywne przykłady konfiguracji i runbook WSH:
   kwalifikacja, rekwalifikacja, brak dostępu/limitu/danych, restart i odzyskanie.

Przewidywane granice plików: `packages/shared/src/instrument-research/*`,
`apps/llm-agent/src/research-*`, niezbędne wiring/config llm-agent, ich testy,
`config/research/paper.example.json`, jawne zależności/lockfile, wymagane mounty
Compose i dokumentacja. Migracja DB lub zmiana binderów execution/signal tylko
w dokładnym, wcześniej przejrzanym zakresie G1. Nie dotykać trwających prac ES,
strategii ani symulatora. Wspólne kontrakty integrować przed równoległymi writerami.

### Testy wymagane

| Grupa | Przypadki i oczekiwany dowód |
| --- | --- |
| Tożsamość i zakres | PKO/AAPL oraz trzeci syntetyczny instrument z konfiguracji; błędny conId/ISIN; wyciek watchlisty; niekwalifikowany filtr; brak ticker branch |
| Czas | DATE/INSTANT, jawny offset, DST, wielodniowy zakres, brak publikacji wg przyjętego kontraktu; zakaz użycia obserwacji przed jej utrwaleniem |
| Treść/zmiany | UNCONFIRMED, konflikt, odwołanie/przesunięcie, nieznany typ, ed/fq, duplikaty; brak cichego pomijania zdarzeń |
| Kompletność | Udowodnione AVAILABLE/EMPTY, obcięcie/limit, brak segmentu, częściowa odpowiedź, odmowa dostępu, błędny JSON i zbyt duży payload |
| Odporność | Timeout/późny callback, disconnect/restart, dwa procesy i dwa instrumenty, jednorazowe rezerwacje, brak refundacji, wygasająca kwalifikacja i awaria persistence |
| Integracja | Produkcyjne wiring na stubach → refresh → snapshot → AI binding → finalne admission; zmiana/negatywny refresh po AI blokuje dispatch; żadnych prawdziwych provider calls lub broker writes w testach |
| Regresja | Dotychczasowe raporty/news/blackout, Risk Engine, ownership, pause, budżety i close; stare snapshoty pozostają audytowalne |

### G2 — wydanie

Wymagane: inny niezależny Astra/high akceptuje implementację i hostile cases;
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration` na izolowanym
PostgreSQL oraz `pnpm build` przechodzą. Zmieniony runtime/Compose wymaga czystego
builda Docker. Brak zmian strategii/symulatora oznacza brak nowych backtestów;
po zmianie takiego zakresu konieczny nowy przegląd i właściwe backtesty.

Przygotować raport, przejrzeć dokładny diff, commit/push na `main` i zweryfikować
CI dokładnego SHA. Zapisać digest obrazu i mapowanie do źródeł. Nie budować wydania
z nieprzejrzanych lokalnych zmian; zachować wszystkie 25 zastanych dirty files.
G2 oznacza wydany kod, nie gotowość brokera ani autoryzację handlu.

## 6. Punkt 3 — wdrożenie z wyłączonym handlem i Gate A

### Przygotowanie przed połączeniem usług

1. Z [szablonu manifestu](PP7_LAUNCH_MANIFEST.template.json) przygotować prywatny
   manifest: SHA, CI, digest, migracje, config/research hashes, tożsamość konta,
   instrumentów/strategii, dostawcy, model, limity, okna i odpowiedzialny operator.
   Nieuzgodnione kwoty/czasy zostają jawnie unresolved, nie są domyślną zgodą.
2. Potwierdzić rzeczywisty plan Marketaux, expiry WSH, uprawnienia i budżety
   wszystkich konsumentów kluczy. Dwa przebiegi co 15 min wymagają co najmniej
   192 wywołań/emitenta/dobę przed paginacją. [Free](https://www.marketaux.com/pricing)
   reklamuje 100/dobę i 3 artykuły/odczyt; plan właściciela nadal nie jest potwierdzony.
   Dzisiejsze 17 wiadomości AAPL wymagało 12 odczytów na jedno pełne odświeżenie.
   To obserwacja, nie prognoza liczby wiadomości każdego dnia.
3. Dla krótkiej próby policzyć warm-up, paginację obu wymaganych źródeł, odświeżenia,
   metadane WSH, ewentualną AI oraz rezerwę. Codzienny refresh nie zatrzymuje się
   automatycznie wraz z końcem okna wejścia. Ustalić rozpoczęcie/zakończenie pracy
   research i twarde dzienne limity; zatrzymanie research nie wyłącza potrzebnej
   obsługi otwartej pozycji. Bez zmiany kadencji lub zakresu newsów dla ukrycia
   braku kwoty. Regularne sesje wymagają osobnego wyliczenia po tej próbie.
4. Uzyskać tylko brakującą zgodę na konkretny koszt/liczbę dalszych wywołań,
   rzeczywisty test/dostarczenie alertów i uruchomienie usług, jeżeli nie mieści
   się to w już zapisanej autoryzacji. Aktualnej zgody na testy nie rozszerzać
   na regularne koszty ani Telegram. Nie kupować planu automatycznie.

### Kolejność wdrożenia i weryfikacji

- Potwierdzić właściwy Docker context/host i bazę operacyjną; przygotować
  sprawdzony backup/restore. Migracje wykonywać przez istniejącą procedurę.
  Fixtures integracyjne nigdy nie korzystają z bazy operacyjnej.
- Uruchomić przejrzane usługi bez UI: `IBKR_ENVIRONMENT=paper`,
  `TRADING_ENABLED=false`, `TRADING_LOOP_ENABLED=false`, startup entries paused
  i trwała pauza aktywne. Pierwsza adopcja PP5 wymaga wyłączonych zapisów.
  Automatyczne zarządzanie pozostaje wyłączone do właściwej autoryzowanej konfiguracji.
  Wyłączyć stary/legacy writer i konkurujące procesy używające tych samych kont/kluczy.
- Potwierdzić zgodne hashe konfiguracji wszystkich wymaganych usług i wymagalne
  migracje, w tym F1 `000027_broker_accounting_source.sql`.
  Sprawdzić dostęp kontener → TWS: hostowy `127.0.0.1:7497` nie dowodzi działania
  `host.docker.internal:7497`. Nie osłabiać ochrony dostępu do socketu; potrzebną
  zmianę sieci/mountów objąć przejrzanym zakresem wdrożenia.
- Kwalifikować F1 według [runbooka rachunkowości](../../runbooks/PAPER_ACCOUNTING_SOURCE.md):
  dokładny wspólny endpoint z execution, dedykowany client 0, rzeczywisty TWS
  build, siedem dni historii, Master 0 i strefa czasu. Dowody ustawień muszą być
  świeże (do 30 min), kwalifikacja ważna, a każdy replay aktualny. Wcześniejsze
  potwierdzenia operatora i pusty replay nie stanowią automatycznej kwalifikacji.
  `inspect`/kwalifikacja i account-summary mogą zapisywać stan w DB — nie
  przedstawiać ich jako diagnostyki bez skutków. Mount 0700/0600 pozostaje prywatny.
- Przy aktualnej sesji sprawdzić contract details, market rules/tick, kalendarz
  sesji, strefy, uprawnienia i real-time bid/ask, zamknięte świece oraz warm-up
  dla aktywnego zakresu. Obserwować oba skonfigurowane instrumenty; każdy dopuszczony
  do przyszłych wejść potrzebuje własnej pozytywnej kwalifikacji.
- Sprawdzić rzeczywiste raporty, newsy i kalendarz: pochodzenie, issuer mapping,
  okresy/jednostki, kompletność, expiry, brak konfliktów i utrwalone bieżące
  snapshoty. Przykład `UNVERIFIED_MODEL` oraz samo `LLM_AGENT_MODEL` nie są
  aktywnym manifestem research. Przyjąć konkretny model z limitem wejścia/wyjścia
  i kosztu; jedna próba syntetyczna nie dowodzi jakości decyzji handlowej.
- Wykonać świeże rachunkowe i brokerowe reconciliation: positions, otwarte oraz
  ukończone zlecenia, executions, prowizje, P&L i account-wide risk. Znane pozycje
  obcych instrumentów uwzględnić według istniejącego instrument-scoped contract;
  nie wymagać zamknięcia całego konta ani nie przejmować tych pozycji. Nieznane
  wyniki, braki ukończonych zleceń, brakujące fees lub nierozpoznana ekspozycja
  pozostają HOLD. End callback nie dowodzi arbitralnej historii zleceń.
- Sprawdzić auth, trwałą pauzę, obserwatora ochrony/wyjść, świeżość jego danych,
  potwierdzenie transportu alertów oraz PP6: stan, powody odmowy, timeline,
  raport sesji i redakcję sekretów. UI pozostaje zatrzymane. Kwalifikowany
  alert transport oznacza potwierdzenie dostawcy, nie odbiór przez człowieka.

### G3 — decyzja o gotowości

Raport Gate A wymienia osobno PASS/BLOCKED/UNVERIFIED dla każdej powyższej kontroli,
czas dowodu i konfigurację. Odczyty muszą być nadal świeże przy uzbrojeniu próby;
nie istnieje ręczny przełącznik „Gate A PASS” obchodzący guardy runtime.
Historyczne `/ready`, liczba świec lub sam obraz z zielonym CI nie wystarczają.

Przed punktem 4 przygotować kompletne warunki próby do zatwierdzenia przez
operatora. Nie pytać ponownie o autoryzację, która już obejmuje dokładnie te
warunki, ale obecna zgoda na diagnostykę nie obejmuje aktywacji handlu.

## 7. Punkt 4 — nadzorowana próba jednej akcji PKO

### Warunki przed aktywacją

Prywatny manifest musi wskazywać: allowlisted Paper account, dokładny dzień,
początek/koniec okna z timezone/UTC, operatora nadzorującego, PKO/WSE/PLN,
jedną całą akcję long, profil/strategię/revision, skończone limity notional,
stop-risk i straty dziennej, koszty dostawców i **jedną próbę wejścia na
rachunek/dzień Europe/Warsaw**. Zdefiniować oryginalny deadline wyjścia względem
zweryfikowanego zamknięcia sesji, z istniejącym marginesem 15–60 minut i zasadą
braku overnight. Koniec okna wejścia nie jest automatycznym zamknięciem pozycji.

Wpisać ścieżkę eskalacji operatora oraz obsługę niewypełnionego LMT, disconnectu,
nieznanego wyniku i braku ochrony. Użytkownik włącza brokerową możliwość zapisów
w TWS dopiero w autoryzowanym oknie, jeżeli API jest nadal read-only; agent nie
automatyzuje UI. Ustawienia F1 zmienione przy tym wymagają rekwalifikacji według
runbooka. Nie wolno uruchamiać Gate C lub drugiego instrumentu przy tej zgodzie.

### Wykonanie

1. Powtórzyć świeże kontrole Gate A i sprawdzić, że nie ma aktywnego lub nieznanego
   wcześniejszego intentu zużywającego limit. Przyjąć istniejące supervised window
   przez wspierany audytowany przepływ, z zachowaniem trwałych liczników.
2. Włączyć wymagane flagi runtime/lifecycle/master i zwolnić trwałą pauzę tylko
   według runbooka i przy spełnionych guardach. Rzeczywista strategia ma wygenerować
   sygnał z bieżących danych, następnie persisted proposal → obowiązkowa AI →
   świeży deterministyczny Risk Engine → execution-engine → IBKR.
3. Zebrać oryginalne IDs/hash/revision, decyzję AI i cytowane dowody, finalną ocenę
   ryzyka, broker fill jednej akcji i potwierdzoną ochronę TP/SL. Nie zasiewać
   zatwierdzonej propozycji, nie wywoływać ad hoc IB placeOrder, nie stroić
   progów/AI w trakcie okna w celu uzyskania transakcji.
4. Obserwować normalne wyjście przez TP/SL lub automatyczny deadline close PP5.
   Close korzysta z oryginalnej ownership, bieżącej ilości, własnego risk check
   i idempotencji; nie potrzebuje nowej zgody entry AI. Wyścig TP/SL/close nie
   może sprzedać drugi raz. Zlecenie LMT nie gwarantuje wypełnienia.
5. Potwierdzić niezależnie w IBKR zerową pozycję PKO i brak pracujących zleceń PKO,
   dopasować entry/exit executions, prowizje i P&L z walutami. Raport nie twierdzi,
   że całe konto jest płaskie; obca ekspozycja pozostaje wyraźnie opisana.
6. Zablokować kolejne wejścia. Dopiero po potwierdzonym zakończeniu zarządzania PKO
   wyłączyć master writes/scheduler i wykonać końcowy disabled verifier. Zachować
   audyt, budżety i private receipts; nie usuwać stanów w celu wyzerowania limitu.

### Wynik G4

- **PASS — mechanika PKO:** normalny sygnał, realne entry, potwierdzona ochrona,
  normalne exit, końcowa flat/no-working-order evidence i kompletny audyt.
  Prowizje oraz P&L rozliczone; brakujące fees oznaczają osobny stan
  ACCOUNTING_PENDING, a cały punkt pozostaje niezamknięty do ich uzgodnienia.
- **INCONCLUSIVE:** brak sygnału, prawidłowe AI REJECT lub niewypełnione wejście
  przy pozytywnie udowodnionym terminalnym stanie wszystkich nóg. Nie jest to
  zaliczona transakcja ani uprawnienie do nowej próby w zużytym budżecie.
- **HOLD/INCIDENT:** nieznane wysłanie/anulowanie, brak ochrony, residual position,
  nieuzgodnione zlecenia, niewypełniony close lub utracone wymagane dowody.
  Pauzujemy wejścia, zachowujemy wspierane zarządzanie/ochronę i eskalujemy.
  Nie ponawiamy nieznanego write pod nowym ID. `TRADING_ENABLED=false` nie zamyka
  pozycji i blokuje wspierany full-close, więc nie jest uniwersalnym pierwszym
  krokiem przy otwartej ekspozycji. Manualna akcja właściciela wymaga koordynacji
  i późniejszego reconciliation; nie zastępuje dowodu normalnego wyjścia bota.

Dowody zbierać przez [aktualny runbook akceptacji](../../runbooks/PRODUCTION_PAPER_ACCEPTANCE.md),
[GPW round trip](../../runbooks/GPW_PAPER_ROUND_TRIP.md),
[PP5 supervision](../../runbooks/PAPER_LIFECYCLE_SUPERVISION.md) i
[PP6 terminal operations](../../runbooks/PAPER_HEADLESS_OPERATIONS.md).
Nie stosować historycznych kroków omijających obecny bound research/runtime flow.
Sam zysk/strata z jednej transakcji nie ocenia rentowności strategii.

## 8. Odpowiedzialność, przeglądy i raportowanie

| Zadanie | Wykonanie | Niezależna kontrola |
| --- | --- | --- |
| Kontrakt WSH, czas/kompletność, eligibility, budżety i integracja krytyczna | `gpt-6-astra` / high | `gpt-6-astra` / high |
| Czysty mapper i testy po przyjęciu ścisłej specyfikacji | `gpt-6-luna` / medium | Finalna kontrola krytyczna Astra/high |
| Znane wiring i czytelne komunikaty bez zmian guardów | `gpt-6-sol` / medium | Finalna kontrola krytyczna Astra/high |
| Określone checks, scoped commit/push i dokładne CI | `gpt-5.6-luna` / low | Lead ocenia dowody |
| Wdrożenie, interpretacja broker evidence, go/no-go i próba Paper | Lead Astra/high w autoryzowanym zakresie | Niezależny krytyczny przegląd zakresu i dowodów |

Każdy worker dostaje zaakceptowany kontrakt, dokładne pliki, zależności,
dozwolone działania, komendy/testy, invariants i stop conditions według
[routing guide](MODEL_ROUTING_GUIDE.md). Reviewer planu i reviewer implementacji
muszą być różnymi agentami; żaden nie ocenia własnych zmian. Nie delegować
semantyki bezpieczeństwa mapperowi. Niedostępność modelu ujawnić i zastosować
dozwolony równy/silniejszy fallback, zachowując niezależność review.

Raport każdego pakietu oddziela: kontrakt, wydany kod, kwalifikację źródeł,
preflight oraz broker proof. Zawiera komendy i wyniki, SHA/CI, hashe prywatnych
dowodów, otwarte blokady, requested/actual model i effort, liczbę napraw/eskalacji,
czas oraz token usage, jeżeli jest dostępne. Brak danych o tokenach to unavailable.

## 9. Odbiór i publikacja samego planu

Zakres tej publikacji: ten dokument, `PP7_WSH_TO_FIRST_PAPER_PLAN_REPORT.md`
oraz odsyłacz w `PP7_CLOSURE_PLAN.md`. Lead przygotowuje plan; niezależny
Astra/high sprawdza go przed uznaniem za przyjęty. Inny Astra/high kontroluje
gotową dokumentację pod kątem źródeł, zgodności z kontraktami i nieuprawnionych
obietnic/aktywacji. Poprawki materialne wracają do przeglądu.

Lokalna walidacja obejmuje istnienie odsyłaczy repozytorium, zgodność faktów
z zapisanymi dowodami i źródłami, brak sekretów/private payloadów, `git diff
--check`, wyłączny zakres staging i niezmienność hashy 25 zastanych plików.
To dokumentacja: nie uruchamiać ponownie niezmienionych lokalnych runtime suites
wyłącznie dla prozy. Commit/push na `main` i dokładne GitHub CI są wymagane
zgodnie z AGENTS.md. Wynik publikacji zapisuje raport; pełne przyszłe checks G2
i operacyjne G3/G4 pozostają osobnymi pracami.
