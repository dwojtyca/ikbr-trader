# Paper: blokady i plan odzyskiwania — 23 października 2026

Status: plan, nie wdrożony automat ani potwierdzenie gotowości handlu.
Zakres właściciela: przywrócić ciągły Paper PKO/AAPL i przygotować plan napraw
każdej aktualnej blokady. Obowiązuje [tryb ciągły](../../runbooks/CONTINUOUS_PAPER.md),
jedna akcja i jedna pozycja na instrument, istniejące AI, ryzyko i budżety.

## Zakres bieżącego pakietu i kryteria odbioru

Ten pakiet obejmuje diagnostykę operacyjną i dokumentację. Nie wdraża lokalnych
niezatwierdzonych zmian kodu, nie usuwa rekordów i nie zmienia flag handlu.
Odbiór: każda zaobserwowana blokada ma dowód, przyczynę z oznaczeniem niepewności,
procedurę doraźną, zakres automatyzacji i test odbioru; niezależne recenzje planu
i dokumentu; lokalna kontrola linków/diffu; publikacja tylko tego dokumentu i CI
dokładnego commitu. Runtime suites nie są potrzebne do samej dokumentacji.

## Dowody i wykonane działania

Początkowo Docker daemon był niedostępny. Uruchomiono Docker Desktop oraz
istniejące kontenery PostgreSQL i Redis. Aplikacje pozostają zatrzymane.
Nie wykonano zleceń, wywołań płatnych dostawców, migracji ani resetów blokad.
Stan brokerowy nie został odczytany; lokalna baza nie dowodzi braku ekspozycji.
Przyczyna wyłączenia Dockera nie została ustalona.

`docker compose ps --all` po uruchomieniu Dockera: cztery usługi bota exited,
infrastruktura exited od czterech dni, UI/backtest created. Ostatnie logi execution
z 19 października pokazują `ACCOUNTING_SOURCE_OWNER_UNRETIRED`, a AI
`CONFIG_SERVICE_UNAVAILABLE`. Dane poniżej odczytano transakcjami READ ONLY.
Daty bazy w tej sekcji są UTC. Brak aktywnych reconciliation holds nie dowodzi
bieżącego CLEAN, ponieważ usługi nie wykonują aktualnego uzgodnienia.

## Blokady, przyczyny i osobne plany

| ID | Dowód i przyczyna | Doraźna naprawa i automatyzacja | Kryterium odbioru |
| --- | --- | --- | --- |
| B1 | Docker niedostępny; kontenery zatrzymane. Przyczyna zatrzymania hosta/daemonu nieznana. | Docker i DB/cache uruchomione. Zaprojektować hostowy nadzór dostępności Dockera i usług z ograniczonym backoff, rozróżniający awarię od świadomego stop. Start tylko przypiętego wydania i przez normalne bramki. Bot wewnątrz kontenera nie uruchomi wyłączonego Dockera. | Restart hosta/daemonu przy autoryzowanym autostarcie przywraca nadzór; jawny stop pozostaje skuteczny; niedostępność nie uruchamia pętli restartów ani wejść przed bramkami. |
| B2 | `paper:runtime check`: `PAPER_CONFIG_CHANGED`. Wszystkie 23 hashe plików i hash rendered Compose zgodne. Walidator zwykłego startu wymaga `TRADING_ENABLED=true`; trzy usługi mają false. Walidacja maintenance przechodzi. | Zachować profil maintenance. Osobny pakiet: diagnostyka `WRITES_DISABLED`/maintenance zamiast ogólnego drift; odróżniać sprawdzenie integralności od gotowości startu. Przejście do pracy dopiero po bramkach, z audytem i nowym dowodem profilu. Nie naprawiać drift przez automatyczne przepisanie hashy. | Profil maintenance jest rozpoznany, rzeczywisty drift odrzucony; automat nie zmienia master switch, image ani zatwierdzonego zakresu. |
| B3 | Obraz z 19 października ma receipt `dirty=true`, `CI=UNVERIFIED_LOCAL_WORKTREE`, bazę 28f87fed; migrację 37. Nowa procedura owner recovery jest nieopublikowaną pracą lokalną, raport zawiera pending checks/review/CI. | Dokończyć istniejący pakiet owner recovery, nie tworzyć alternatywnego obejścia. Pełne wymagane kontrole, niezależna recenzja, publikacja i exact CI, czysty obraz, backup i migracja istniejącym runnerem. Automatyzować tylko weryfikację zatwierdzonego artefaktu i blokowanie niezgodności. | Dokładny source commit/image i migracje są potwierdzone; niezatwierdzony dirty build nie zostaje automatycznie dopuszczony do handlu. |
| B4 | `accounting_source_owners`: ACTIVE, generation 1, acquired 2026-10-19 09:41:10, brak retired_at. Execution pada przed HTTP. Brak trwałego dowodu zakończenia starego właściciela; dokładny przebieg utraty dowodu nieustalony. | Po B3 użyć istniejącego offline recovery z obserwowanym ręcznym restartem TWS i świeżymi dowodami operatora. Lokalnie zero prób wysłania zleceń; to tylko jeden warunek procedury, nie dowód płaskiego rachunku. Zapobiegać nawrotom przez potwierdzone zamknięcie socketu, trwałe retirement i dopiero zwolnienie locka. Crash/UNKNOWN nadal wymaga dowodu; TTL lub wolny lock nie wystarcza. | Testy SIGTERM, crash, utraty DB i spóźnionych callbacków: nigdy dwóch właścicieli; brak potwierdzenia nie daje RETIRED. Recovery nie usuwa historii ani nie wznawia wejść. |
| B5 | Source hold `ACCOUNTING_CLOCK_INVALID`, gap=true; epizod WAITING, attempt_count=0, zapis 19 października. Brak wystarczającego dowodu pierwotnej przyczyny odrzucenia zegara. | Po odzyskaniu ownera i kwalifikacji zebrać diagnostykę broker/local/DB czasu; wykorzystać istniejący ograniczony auto-clock recovery, gdy jego preconditions są spełnione. Pełny replay i joined capture po recovery. Nie kasować hold SQL-em ani traktować nowego callbacku jako pełnego dowodu. | Poprawny izolowany błąd odzyskuje się w limitach; skew, obce holdy, brak kosztów, UNKNOWN i zmiana sesji pozostają blokadą. Pauza operatora nie jest zmieniana. |
| B6 | Jedyna kwalifikacja wygasła 2026-10-14 21:48:23 UTC. Wymagane ustawienia TWS nie są w całości potwierdzalne przez API. | Nowa inspekcja i rzeczywiste świeże dowody operatora zgodnie z runbookiem. Plan automatyzuje ostrzeżenia przed terminem (np. 48h i 24h), formularz kompletności i wykrycie zmian; nie odnawia kwalifikacji z poprzedniej deklaracji. Pełne auto-odnawianie wymaga osobnego wiarygodnego źródła atestacji i nowego kontraktu. | Powiadomienie przed wygaśnięciem; expiry i zmiana ustawień blokują; stare/niepełne artefakty odrzucone, brak fikcyjnej daty obserwacji. |
| B7 | Marketaux: PKO UNKNOWN/RESEARCH_SOURCE_TIMEOUT z 15 października; AAPL STARTED z 15 października 18:19. Przerwane pobranie i brak terminalnego rozstrzygnięcia; dokładna przyczyna przerwania nieustalona. | Istniejące recovery wybiera automatyczny dowód tylko dla prób z właściwym protokołem deadline/clock. Starsze próby: maintenance, zatrzymani producenci, prepare/observe/commit według runbooka. Następnie nowe zwykłe pobranie. | Zabicie workera przed/po odpowiedzi nie publikuje starego wyniku, nie odnawia kosztów/TTL i nie wykonuje równoległych prób; brak dowodu zostaje HOLD. |
| B8 | Najnowszy WSH UNKNOWN/RESEARCH_WSH_ABANDONED_ATTEMPT, cleanup UNKNOWN, verified_local_closure=false, start 15 października 22:17. | Istniejące WSH recovery z obserwowanym ręcznym restartem TWS. Na przyszłość trwałe próby i potwierdzone zamknięcie lokalnego socketu; ograniczony retry tylko przy udowodnionym cleanup. Brak dowodu starej sesji wymaga operatora; samo ponowne połączenie nie wystarcza. | Crash na connect/events/cleanup nie daje fałszywego CONFIRMED ani nie uruchamia równoległych żądań; legacy UNKNOWN wymaga prawidłowego receipt. |
| B9 | Snapshot heads PKO/AAPL ostatnio zapisane 15 października; źródła przekraczają 24h polityki, aplikacje nie odświeżają. Dokładną bieżącą kwalifikację każdego źródła potwierdzi runtime po recovery. | Przywrócić istniejące godzinne odświeżanie Marketaux/WSH po B7/B8, z cache i budżetem. Przed sygnałem sprawdzić świeży manifest/snapshot; dane cenowe uzupełnić istniejącym auto-bootstrap po potwierdzeniu aktualnego stanu ingestion. | Stare dane dają WAITING bez propozycji/AI; świeże dane prowadzą do nowej oceny sygnału. Restart nie przesuwa TTL ani nie zeruje budżetu. |
| B10 | Pauza trwała true, revision 53 z 19 października. AI miał CONFIG_SERVICE_UNAVAILABLE wskutek niedostępnego execution. | Pauza jest kontrolą operatora, nie błędem do samoczynnego usunięcia. Po naprawach zastosować autoryzowany start z CAS/revision, przygotowaniem danych i odczytem wyniku. Diagnostyka powinna wskazać pierwotną przyczynę, nie tylko wtórny błąd AI. | Jawny stop wygrywa z oczekującym startem; nieznanego resume nie ponawia się. Brak sygnału lub odmowa AI pozostają poprawnym wynikiem. |

## Kolejność i granice

1. Zakończyć B3 oraz ustalić przyczynę pozostawienia ownera B4 na podstawie
   zachowanych logów. Nie wdrażać całego brudnego drzewa z niezwiązanymi zmianami ES.
2. Przygotować obsługiwaną topologię offline recovery. Zweryfikować realny rachunek,
   wszystkie pozycje/zlecenia i klientów brokera z właścicielem. Istniejące kontenery
   UI/backtest w stanie Created wymagają jawnego uwzględnienia w preflight narzędzia.
   Ta procedura wymaga całego rachunku bez pozycji i otwartych zleceń, bez historii
   prób bota (`execution_attempted_at`), rezerwacji i nierozstrzygniętych operacji.
   Nawet znana ręczna ekspozycja na innym instrumencie wyklucza ten wariant recovery;
   samo jej obejrzenie nie wystarcza. Nie zamykać jej ani nie kasować historii
   tylko w celu obejścia tego ograniczenia. To zakres węższy od akceptacji handlu.
3. Owner i WSH mają oddzielne protokoły obserwacji; nie zakładać, że pojedynczy
   wcześniejszy restart TWS spełnia oba. Każdy receipt wymaga własnych warunków.
4. Kwalifikacja, zegar, pełna rekonsyliacja, badania, świece, quote/session,
   kontrole ryzyka, koszty i alerty. Pozostałe blokady mogą ujawnić się dopiero
   po przywróceniu execution; nie twierdzimy, że lista jest pełnym live preflight.
5. Zatwierdzony profil pracy i normalny start. Weryfikować świeży stan per instrument,
   bez wymuszania sygnału, AI ani transakcji. Soak obejmuje zmianę dnia, sesji,
   restart i awarie źródeł; brak transakcji nie potwierdza round trip.

Automat musi naprawiać przyczynę i ponownie uzyskać dowód. Nie może po prostu
usuwać każdej blokady: wygaśnięta deklaracja TWS, nieznana sesja i brak dowodu
brokera nie mają dziś bezpiecznej w pełni automatycznej ścieżki. Są ograniczeniami
obecnej implementacji i źródeł, nie zakazem uruchomienia bota przez właściciela.

## Realizacja następnych pakietów i walidacja

Przed zmianami kodu każdy powyższy pakiet potrzebuje dokładnego kontraktu plików,
limitów prób i stop conditions. Astra high ustala semantykę odzyskiwania i dokonuje
niezależnej recenzji; różni agenci recenzują plan i implementację. Luna medium
może implementować czyste formatowanie pod zaakceptowanym kontraktem; Sol medium
znane wiring. Stosować [routing guide](MODEL_ROUTING_GUIDE.md).
Wymagane lint, typecheck, test, integration na izolowanym PostgreSQL, build,
czysty Docker build dla wdrożenia, backup/migration/rollback i CI dokładnego commitu.
Rollback nie może uruchomić starego writera wobec nowego maintenance fence.
Nie ma zgody na kasowanie historii, zmianę strategii, zwiększanie budżetów ani Live.

Źródła procedur: [accounting](../../runbooks/PAPER_ACCOUNTING_SOURCE.md),
[startup research](../../runbooks/PAPER_STARTUP_RESEARCH_RECOVERY.md).
Lokalny `PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md` i nowa sekcja owner recovery
w runbooku accounting były nieopublikowaną pracą podczas diagnostyki. Opublikowana
wersja runbooka nie zawiera jeszcze tej procedury; obecność lokalnych plików nie
oznacza zatwierdzenia wydania. B3 musi opublikować te zależności osobno.

## Recenzje i publikacja tego dokumentu

Diagnostyka profilu: niezależny gpt-6-astra/high; wszystkie hashe zgodne,
maintenance=true przechodzi. Tokeny i dokładny czas agenta: niedostępne.
Recenzja planu: gpt-6-astra/high, ACCEPT po jednej rundzie poprawek (jawny wąski
zakres offline recovery i usunięcie linku do nieopublikowanej zależności).
Końcowa recenzja dokumentu: inny gpt-6-astra/high, ACCEPT bez uwag blokujących,
bez poprawek i eskalacji. Recenzenci nie edytowali dokumentu. Ustawienia requested
i dispatch były zgodne; niezależna telemetria actual oraz tokeny są niedostępne.
Linki istnieją w HEAD, lokalna kontrola diffu przeszła. Runtime suites nie były
powtarzane dla tej dokumentacji. Publikacja i CI dokładnego commitu są osobnym
końcowym dowodem; nie stanowią akceptacji nieukończonej implementacji recovery.
