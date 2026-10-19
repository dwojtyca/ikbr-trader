# Plan naprawy przygotowania danych przy starcie Paper

Data: 2026-10-19. Status: plan etapowy przyjęty w niezależnej recenzji; implementacja niewykonana.
Baza: `7df517dfbabb3d809eaa27de6ae2934c52ced77f`.
Zakres zgody w tej rozmowie: przygotowanie planu, nie implementacja tego pakietu.

## Cel i granice

Jedno `pnpm start` ma automatycznie przygotować dostępne dane, odzyskać bezpiecznie
przerwane odczyty i wznowić wejścia dopiero po istniejących kontrolach. Jeżeli
odzyskanie wymaga faktu, którego aplikacja nie potrafi potwierdzić, ma wskazać
konkretną czynność operatora i dowód, zamiast pozostawić nieopisany trwały HOLD.
Zakres: Marketaux, WSH i kalendarz sesji/native warmup. Diagnostyka startu jest
częścią tych trzech napraw, nie osobnym przebudowanym systemem.

Zachowujemy PKO/AAPL, jedną akcję/pozycję na instrument, istniejące strategie,
progi, politykę dwóch źródeł (odświeżanie godzinne, ważność 24h), budżety i pacing.
Nie zmieniamy ryzyka, AI, powiązań propozycji, zasad brokerowych ani automatyki
wyjść. Brak nowego UI, resetowania historii, zmiany clientId w celu obejścia
ograniczeń, nowych dostawców lub płatnych planów. Nie ponawiamy zleceń ani modelu.
Naprawa odczytów nie jest mechanizmem odzyskiwania brokerowych zapisów.

Dokumenty nadrzędne: [roadmap](../ROADMAP.md),
[ciągły Paper](CONTINUOUS_PAPER_OPERATION_PLAN.md),
[runbook](../../runbooks/CONTINUOUS_PAPER.md),
[dwa źródła](TWO_SOURCE_RESEARCH_HOURLY_PLAN.md),
[WSH recovery](WSH_FRESHNESS_RECOVERY_PLAN.md),
[gotowość sesji](../../runbooks/INSTRUMENT_SESSION_READINESS.md).
Wprowadzenie nowego dowodu odzyskania WSH wymaga jawnego uzupełnienia wcześniejszego
kontraktu: upływ czasu i restart nadal nie dowodzą zamknięcia poprzedniego socketu.

## Ustalone fakty i niewiadome

Odczyty 19 października ok. 08:41–08:45 Europe/Warsaw:

- Ingestion i execution zgłaszały połączenie z IBKR. Auto-bootstrap był włączony,
  zakończony i bez własnego błędu. To nie dowodzi gotowości źródeł i świec.
- Start zakończył się błędami `RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED`,
  `RESEARCH_WSH_ABANDONED_ACQUISITION`, `RESEARCH_WSH_ATTEMPT_UNRESOLVED`,
  `RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED` oraz `RESEARCH_CALENDAR_ERROR`.
  Marketaux zachował `AbortError`, `ABORT_ERR`, `The operation was aborted`.
  Przyczyna przerwania wcześniejszego procesu nie została ustalona.
- `claimMarketauxAttempt` blokuje poprzednie STARTED/FINALIZING/UNKNOWN; sam
  upływ deadline nie uprawnia nowej próby. Nie wiadomo jeszcze, które konkretne
  rekordy i rezerwacje tworzą dzisiejszą blokadę.
- WSH wykrywa porzuconą operację, ale nieznane zamknięcie sesji blokuje endpoint
  lub emitenta także pomiędzy manifestami. Nie wolno dorobić `CONFIRMED`.
- Odświeżanie sesji istnieje: timer 60s, single-flight i wspólny pacing.
  Adapter żąda `SCHEDULE` dla `14 D`. Walidator wymaga pokrycia poprzedniego
  tygodnia i granicy bieżącego poniedziałku; walidacja bieżącego handlu osobno
  wymaga pokrycia chwili obecnej. Oba instrumenty zwracały
  `session_schedule_coverage_missing`, a wszystkie timeframe'y miały FAILED.
  Nie zapisano dotąd dokładnych granic odrzuconej odpowiedzi. Weekend/przedotwarcie
  to hipoteza, nie ustalona przyczyna. Zera w warmup nie dowodzą pustej bazy świec.

## Etap 0 — dowody i zamrożenie kontraktów

Przed edycją runtime zebrać minimalne, zanonimizowane dowody: identyfikatory i
stany prób, deadline, wynik commit/readback, powiązane rezerwacje, owner/generację
procesu, WSH endpoint/session i istniejące dowody cleanup. Bez surowych payloadów,
sekretów lub pełnych logów rachunku. Odczyt DB jest tylko do odczytu.

Dla sesji przechwycić podczas jednego normalnego, limitowanego odświeżenia:
identity, requestedAt/receivedAt, timezone, coverageStart/End, zakres dat sesji,
granice oczekiwane przez walidator i przyczynę odrzucenia. Zachować błąd źródłowy
w sanitizowanej postaci. Nie uruchamiać konkurencyjnego fetchera poza wspólnym pacing.
Powtórzyć na fixture odtwarzającym dokładny błąd, bez zgadywania odpowiedzi IBKR.

Astra/high ustala na podstawie dowodów dokładne stany, API, migrację i dowód
quiescence dla odczytów. Dopisać do tego planu macierz przejść z nazwami pól,
limitami, błędami i zakresem plików; niezależny recenzent musi ją zaakceptować
przed implementacją recovery lub zmianą walidacji. Brak wykonalnego dowodu WSH
oznacza jawny wariant operatora, nie automatyczne poluzowanie warunku.

## Poprawka 1 — Marketaux po przerwaniu procesu

Rozszerzyć istniejący store/refresh/repair, bez nowego serwisu:

1. Recovery działa przed claim i w zwykłym harmonogramie; jedno atomowe przejęcie
   pod istniejącą blokadą account/issuer. Żywa próba przed deadline pozostaje WAITING.
2. Po deadline najpierw dokładny odczyt wyniku: zatwierdzony kompletny wynik można
   rozpoznać wyłącznie po zgodnych identity, stronach/obu przebiegach, snapshot,
   hashach i atomowym stanie publikacji. Nie publikować ponownie na ślepo.
3. Gdy wyniku nie ma, ustalić, że poprzedni worker nie może już publikować ani
   wysyłać kolejnych stron. Nowe próby wymagają trwałego fencing i dowodu wygaśnięcia
   właściciela; deadline pojedynczego HTTP nie jest takim dowodem. Jeśli obecny
   runtime nie daje tego dowodu, dodać bounded owner lease/generation z fencing
   każdej wysyłki i publikacji albo pozostawić OPERATOR_REQUIRED do potwierdzonego
   zatrzymania starego workera. Dokładny wariant zatwierdza etap 0.
4. Zapisać oddzielny audyt odzyskania; historyczny UNKNOWN pozostaje UNKNOWN.
   Zachować wszystkie obciążenia/rezerwacje nieznanych wywołań. Nie zwalniać
   budżetu na podstawie timeoutu. Nowe pobranie ma nowy identyfikator i rezerwację,
   normalny godzinny odstęp i pełną walidację; nie kontynuuje nieznanej paginacji.
5. Admission nie uznaje samego recovery za poprawne badania. Po nierozstrzygniętej
   próbie wymagany jest nowy pełny sukces albo dokładny dowód już zatwierdzonego
   wyniku. Stare dane nie dostają nowej daty/TTL; odmowa dostępu i wadliwa tożsamość
   nie stają się błędem przejściowym.

Testy: restart w STARTED/FINALIZING, przed/po HTTP, przed/po COMMIT i utrata ACK;
dwa workery, spóźniona odpowiedź starej generacji, śmierć w samym recovery,
niepełna paginacja, oba przebiegi, zmiana manifestu/konta, rollover UTC, wyczerpany
budżet, znany hard failure. Wynik: co najwyżej jedno nowe pobranie, brak podwójnej
publikacji i brak odnowienia kosztów/historycznych dat.

## Poprawka 2 — WSH po utracie sesji

1. Zachować dokładne rozróżnienie: anulowanie zlecone, lokalny socket zamknięty,
   wynik dostawcy nieznany. Nie udawać brokerowego ACK.
2. Żywy transport sprząta tylko własną sesję, zapisuje istniejący rzeczywisty
   dowód zamknięcia i podlega obecnym ograniczeniom retry.
3. Po awarii procesu właściciela brak możliwości odzyskania starego socketu nie
   daje dowodu jego zamknięcia. Potrzebny jest nowy, trwały recovery receipt,
   odrębny od cleanup starej próby: dokładne endpoint/session/owner, generacja,
   metoda potwierdzenia, czas, zakres poprzednich blokad i audyt aktora.
   Potwierdzenie śmierci kontenera samo nie dowodzi cleanup po stronie IBKR.
4. Etap 0 musi sprawdzić możliwości zainstalowanego SDK/brokera i zdefiniować
   weryfikowalny dowód unieważnienia starej sesji. Jeśli nie istnieje automatyczny
   dowód, wspierany wariant to udokumentowana, uwierzytelniona procedura operatora
   z wymaganymi dowodami resetu sesji/endpointu i walidacją reconnect. Nie automatyzować
   UI IBKR ani restartu Gateway; nie przyjmować gołego kliknięcia „odblokuj”.
   Restart Gateway wymaga koordynacji istniejących pozycji, zleceń i klientów.
5. Receipt dopuszcza najwyżej następny zwykły cykl, nigdy szybki replay.
   Globalny zakres endpoint/issuer, nextRegularAt, budżet, uprawnienia, metadata
   i tożsamość pozostają sprawdzane atomowo. Receipt nie czyści innych HOLD.
6. Historyczne UNKNOWN/cleanup i koszty są niezmienne; stare kalendarze nie
   odzyskują ważności. Nowy poprawny wynik dopiero przywraca eligibility.
   Nowe tabele/receipts muszą być kompatybilne; rollback do obrazu nieznającego
   receipt pozostaje zablokowany, a nie czyści stare próby.

Testy: SIGKILL/crash, brak socketu, socket zastąpiony, disconnect bez close,
niepewny COMMIT, 10281, timeout, spóźnione zdarzenia, równoległe procesy i konta,
wspólny endpoint i emitent, receipt stary/fałszywy/dla innej sesji, ponowne użycie
receipt i crash podczas recovery. Bez dowodu nadal HOLD z konkretną instrukcją;
z zaakceptowanym dowodem tylko jedna nowa regularna próba i pełne nowe dane.

## Poprawka 3 — kalendarz sesji i prawdziwa gotowość startu

Po reprodukcji z etapu 0 wybrać najmniejszą naprawę:

- Jeśli odpowiedź nie obejmuje wymaganej historii, skorygować zakres/endDateTime
  żądania w istniejącym adapterze. Ewentualne łączenie ograniczonych odpowiedzi
  musi sprawdzać ciągłość coverage, tożsamość, strefę i sprzeczne sesje. Budżet
  liczby żądań ustalić przed wdrożeniem, w dotychczasowym pacing i limicie 2 walorów.
- Jeśli walidacja błędnie wymaga aktualnej sesji dla zakończonej historii w dzień
  wolny/przed otwarciem, rozdzielić udokumentowane pokrycie historii od godzin
  bieżącego handlu. `liquidHours` nie zastępuje brakującej historii, a historyczny
  SCHEDULE nie dowodzi otwartego rynku. Nie rozszerzać coverage przez dopisanie
  dat, kopiowanie piątku ani syntetyczne świece.
- Zachować finalność native 1m/5m/1h/4h/1d/1w, świeżość, timezone/DST i generation
  fencing. W poniedziałek przed otwarciem prawidłowy stan może oznaczać gotową
  historię i oczekiwanie na pierwszą zamkniętą świecę, nie błąd pobrania.
- Rozszerzyć istniejące health/progress i terminal start o osobne stany transport,
  bootstrap, kalendarz, native warmup i research. Nie zmieniać znaczenia istniejących
  pól bez kompatybilności. Start pokazuje etap, przyczynę, ostatnią próbę i nextCheckAt.
  Bootstrap skończony nie może sam skutkować komunikatem o gotowym handlu.
- Po naprawialnym błędzie proces startu może czekać na zaplanowaną próbę; HOLD bez
  ścieżki automatycznej kończy się konkretną instrukcją. `stop`, zmiana rewizji pauzy
  lub przerwanie startu unieważniają jego zgodę na resume; recovery jej nie odnawia.
  Nie czekać do sesji AAPL z przygotowaniem PKO: ocena pozostaje per instrument,
  z zachowaniem wspólnych kontroli rachunku i istniejącej polityki resume.

Testy: poniedziałek przed 09:00 i po pierwszej zamkniętej 1m, weekend/święto,
skrócona sesja, DST PL/USA, różne otwarcia PKO/AAPL, granice coverage, przestarzała
odpowiedź, luki i sprzeczne sesje, reconnect podczas pobierania, pacing, fair
kolejność dwóch instrumentów. Niepełna historia i nieznany dzisiejszy rynek nadal
blokują właściwy etap. Start z `bootstrapped=true` i FAILED warmup nie ogłasza READY.

## Kolejność, pliki i routing wykonania

1. Lead Astra/high: etap 0 i dokładne kontrakty; niezależny Astra/high zatwierdza.
2. Astra/high: wspólne typy/store/migracje i testy izolowanego PG. Własność:
   `packages/shared/src/instrument-research/{store,repair,marketaux-refresh,wsh-refresh}.ts`
   oraz powiązane testy i nowa addytywna migracja.
3. Oddzielny Astra/high: dopiero po integracji kontraktu implementuje
   `apps/llm-agent/src/research-refresh.ts`, `research-marketaux-fetch.ts`,
   `research-wsh-refresh.ts`,
   scheduler/transport i ich testy; bez równoległej edycji store przez dwóch autorów.
4. Astra/high: naprawa sesji w `apps/ingestion/src/session-schedule-adapter.ts`,
   `session-schedule-refresh.ts`, `session-native-refresh.ts`, `index.ts`,
   `packages/shared/src/instrument-sessions.ts` i właściwych testach.
5. Luna/medium może wykonać wyłącznie prezentację gotowych pól/statusów i testy
   renderowania pod dokładnym kontraktem, w plikach diagnostics i
   `tools/paper-verify-stack/src/paper-runtime*.ts`; decyzje resume pozostają Astra.
6. Lead integruje i aktualizuje runbooki; inny niezależny Astra/high niż recenzent
   planu wykonuje hostile review, nie może być autorem kodu.

Każda delegacja zawiera przyjęty kontrakt, dokładne pliki, modele/effort, zależności,
invariants, komendy, zakaz broker writes/operacyjnego DB w testach i warunki STOP.
Zmiana semantyki, brak dowodu WSH, cross-service scope lub nowy koszt wraca do lead
oraz recenzji. Brak dostępnego modelu wymaga jawnej równoważnej/silniejszej trasy.
Nie ruszać istniejącego dirty ES/backtest ani `apps/signal-engine/src/signal-engine.ts`.

## Akceptacja i walidacja całego pakietu

- Normalny start sam pobiera brakujące/nieaktualne źródła; aktualne źródła zachowują
  pierwotne daty. Odzyskiwalny crash nie wymaga ręcznego SQL ani resetowania budżetu.
- Niedowodliwy cleanup WSH ma konkretny OPERATOR_REQUIRED; nie obiecujemy pełnej
  automatyki dla nieobsługiwanego dowodu. Oba warianty są testowane.
- Awaria jednego źródła nie blokuje niezależnego przygotowania pozostałych danych;
  wejście nadal wymaga wszystkich dowodów odpowiedniego instrumentu/rachunku.
- Crash/restart podczas recovery, równoległe starty, operator pause/stop, zmiana
  config, late callback i unknown COMMIT nie tworzą dodatkowych uprawnień do wejścia.
- Fixture end-to-end obejmuje zwykły start, trzy dzisiejsze klasy blokad i pełny
  powrót do gotowości po dostarczeniu wymaganych dowodów. Bez broker/provider calls.
- Po hostile review: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  `pnpm test:integration` na izolowanym PostgreSQL i `pnpm build`; czysty Docker
  build z opublikowanego scope. Zmiana finalności/wyboru świec wymaga również
  deterministycznego replay porównującego sygnały przed/po na zamrożonych danych;
  zmian strategii/simulatora nie planujemy. Regresje finalności to blocker.
- Raport: wyniki, znalezione/naprawione problemy, requested/actual model i effort,
  czas, naprawy/escalations, tokeny (brak danych = unavailable), SHA, obraz i CI.
  Scoped commit/push na main oraz zielone CI dokładnego commitu są obowiązkowe.

## Wdrożenie i sprawdzenie rzeczywiste

Osobny etap po implementacji, przeglądzie, checkach i exact-commit CI. Zachować
istniejącą zgodę Paper w jej zakresie; plan nie włącza nowej sesji ani nie wymaga
ponownej zgody na już autoryzowane odczyty. Najpierw odczytać pozycje/zlecenia i
stan nadzoru. Zatrzymać nowe wejścia wspieraną kontrolą, pozostawić wyjścia.
Migracje, manifest/adoption i przełączenie master realizować według właściwego
runbooka, bez wyłączania potrzebnego nadzoru otwartej pozycji. Backup i kontrola
kompatybilności poprzedzają migrację. Testy awarii wyłącznie w środowisku izolowanym.

Przed wznowieniem: aktualne dwa źródła dla dopuszczonego waloru, broker session,
świece/quote, rachunek/reconciliation, risk/AI i nadzór; `pnpm start` kończy się
potwierdzonym stanem. Zapisać prywatne zanonimizowane dowody, bez wymuszania sygnału
lub transakcji. Udany start nie dowodzi round trip ani rentowności. Rollback nie
cofa bazy, audytu, budżetów ani uprawnień; jeśli stary obraz nie czyta nowych
stanów, zatrzymać producentów i utrzymać kompatybilny nadzór zamiast wymuszać downgrade.

## Status recenzji i publikacji planu

Plan review: ACCEPT — `startup_plan_review`, requested `gpt-6-astra/high`,
2026-10-19, bez uwag blokujących. Recenzent potwierdził, że etap 0 jest obowiązkową
bramką przed implementacją, a nie opcjonalnym doprecyzowaniem.
Niezależna recenzja finalnego dokumentu: ACCEPT — `startup_document_review`,
requested `gpt-6-astra/high`, 2026-10-19, bez uwag blokujących.
Sprawdzono sześć linków względnych, wskazane pliki i fakty kodu. Obserwacje
operacyjne pochodzą z odczytów lead; recenzent nie wykonywał operacji na brokerze.
Actual model/effort telemetry, token usage i pełny czas: unavailable.
Naprawy po pierwszej recenzji: 0; eskalacje: 0.
To dokument planistyczny; kod, migracje, testy awarii i wdrożenie nie są wykonane.
Dokument-only: walidacja faktów, linków i diff; bez uruchamiania runtime test suites.
