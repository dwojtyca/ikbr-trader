# Ciągła praca Paper

Zakres zatwierdzony przez właściciela 12 października 2026: PKO i AAPL, po jednej
całej akcji, najwyżej jedna otwarta pozycja na instrument, bez dziennego limitu
liczby prób wejścia. Budżet AI wynosi 5 USD na dobę UTC, wspólnie dla obu
instrumentów. Obowiązują dotychczasowe limity finansowe ryzyka i kosztów źródeł.
Status wydania, kontroli i wdrożenia jest w
[raporcie](../implementation/phase3/CONTINUOUS_PAPER_OPERATION_REPORT.md).

## Co oznacza praca ciągła

Usługi działają między sesjami i wracają po restarcie. Nowy tryb `recurring_sessions`
w polityce v3 nie wymaga kolejnego półgodzinnego okna ani nowej polityki każdego
dnia. Każde wejście nadal należy do konkretnej, aktualnie potwierdzonej sesji
brokera. Przerwy, święta i skrócone sesje wynikają z tych danych. Pozycja ma
przypisany termin wyjścia przed końcem swojej sesji; ten zakres nie obejmuje
utrzymywania pozycji przez noc.

Brak limitu liczby prób nie oznacza ponawiania zlecenia o nieznanym wyniku.
Niepewny wynik, problem z ochroną albo uzgodnieniem rachunku wstrzymuje nowe
wejścia. Każda próba zachowuje własny zapis, a kolejne poprawne transakcje tego
samego instrumentu nie zastępują historii poprzednich.

AI ocenia każdą nową propozycję ze świeżym kontekstem cenowym i sprawdzonym
zestawem danych badawczych. Nie musi za każdym razem pobierać tych samych wiadomości i kalendarza. Używa aktualnej, zapisanej wersji źródeł, przypisanej niezmiennie do tej
oceny. Zużycie oraz zachowawcze rezerwacje kosztu są wspólne dla rachunku;
restart ani nowa propozycja nie odnawiają budżetu. Wyczerpanie 5 USD może
wstrzymać dalsze oceny do następnej doby UTC.

## Gdy brakuje danych

Przed utworzeniem propozycji bot sprawdza kompletność badań. Znany brak lub
nieaktualne dane uruchamiają kolejkę uzupełnienia przez dotychczasowego dostawcę.
Stan `WAITING` nie rezerwuje wejścia ani nie wywołuje AI. Kolejny cykl strategii
sprawdza od nowa sygnał, ceny i ryzyko po uzupełnieniu danych.

Decyzja właściciela z 15 października 2026 wybiera politykę
`TWO_SOURCE_HOURLY_V1`: wyłącznie Marketaux i WSH, oba odświeżane co godzinę,
oba ważne przez 24 godziny od poprawnego pobrania. Start korzysta od razu
z ważnego zestawu. Brakujące lub przeterminowane źródło uzupełnia przed
wznowieniem wejść. Zwykłe odświeżanie działa w tle niezależnie od sygnałów.
Raporty SEC i PKO oraz ich terminy publikacji nie są wymagane w tej polityce.
Stan wdrożenia i dowody są w [raporcie pakietu](../implementation/phase3/TWO_SOURCE_RESEARCH_HOURLY_REPORT.md).

Nowa polityka wymaga `RESEARCH_MARKETAUX_ON_DEMAND=false`. Starsze manifesty
zachowują swój harmonogram i tryb na żądanie; sama zmiana flagi nie przełącza
polityki. Przyjęcie nowego manifestu nie przenosi starych danych pod nowy hash.

Chwilowy, potwierdzony błąd odświeżenia może pozostawić poprzednie ważne dane.
Ich pierwotny czas pobrania i termin ważności nie zmieniają się. Oryginalny błąd
pozostaje w diagnostyce. Nieznany wynik, nieprawidłowa odpowiedź lub utrata
potwierdzonego dostępu pozostają jawną blokadą. Pobieranie respektuje wspólny
budżet i odstępy dostawcy; restart nie odnawia limitu ani nie przyspiesza cyklu.

Jeżeli dane zestarzeją się już po zapisaniu propozycji, można poczekać na ich
uzupełnienie tylko przed przypisaniem badań i wywołaniem modelu. Pierwotny termin
ważności propozycji pozostaje niezmieniony. Po jego upływie potrzebny jest nowy
naturalny sygnał; wcześniejsza propozycja nie jest odtwarzana.

## Start danych i historia cen

`INGESTION_AUTO_BOOTSTRAP_ENABLED=true` włącza automatyczne przygotowanie danych
po uruchomieniu oraz po utracie połączenia. Domyślna wartość pozostaje `false`.
Bot sprawdza zachowane świece i uzupełnia potrzebne braki z IBKR. Nie usuwa historii.
Jednocześnie trwa najwyżej jedno przygotowanie; przerwa po błędzie rośnie od
30 sekund do pięciu minut. Dotychczasowy limit pobierania pozostaje bez zmian.

Uwierzytelnione `POST /stop` usługi ingestion utrwala zatrzymanie pobierania;
restart procesu tego nie kasuje. `POST /bootstrap` jawnie wznawia pobieranie.
To kontrola danych, osobna od zatrzymania nowych transakcji. Stan automatycznego
przygotowania jest widoczny w `/health`, a świece i sesje w `/backfill-progress`.
Logowanie do TWS/IB Gateway wykonuje właściciel.

Obecny moduł odświeżania obsługuje maksymalnie dwa instrumenty. Dla 20 nie ma
zatwierdzonego czasu startu ani obsługi ciągłego odświeżania. Zimny start wymagałby
orientacyjnie sześciu pobrań historii i kalendarza na instrument, około 140 żądań.
Przy lokalnym limicie 50 żądań na 10 minut oznacza to co najmniej około 20 minut
oczekiwania na kolejne pule, plus odpowiedzi i zapis danych. To oszacowanie
hipotetycznego rozszerzenia, a nie wynik pomiaru ani obietnica obsługi 20 walorów.

## Zatrzymanie i codzienny odczyt

Zatwierdzony profil lokalny udostępnia krótkie polecenia operatora:

```sh
pnpm paper:runtime check
pnpm start
pnpm logs
pnpm status
pnpm stop
```

`start` sprawdza prywatny profil i obraz, utrwala audytowaną pauzę wejść,
uruchamia przygotowanie danych i badań, a wejścia wznawia dopiero po przejściu
istniejących bramek. Przerwanie uruchamiania zleca nową pauzę; jej brak
potwierdzenia jest zgłaszany jako nieznany wynik. Błąd odpowiedzi nie dowodzi, że
operacja nie została wykonana: nie ponawiaj nieznanego wznowienia, sprawdź stan
operatora. `stop` najpierw anuluje oczekujące lokalne starty, następnie utrwala
pauzę i zatrzymuje tylko sygnały oraz agenta AI. Gdy API jest niedostępne,
zatrzymuje te usługi i zgłasza niepotwierdzoną pauzę, zamiast ogłaszać pełny sukces. Execution i ingestion
pozostają dostępne dla nadzoru i automatycznych wyjść; sprawdź stan pozycji przed
ich ręcznym wyłączeniem. Profil lokalny i dowód wydania są prywatne, ignorowane
przez Git i pomijane w kontekście obrazu Docker.

Profil strategii jest jedynym źródłem listy instrumentów dopuszczonych do wejść.
W trybie `TRADING_CONFIG_MODE=bundle` pozostaw
`TRADING_LOOP_INSTRUMENT_IDS` puste lub usuń tę zmienną; jej niepusta wartość
powoduje odrzucenie profilu przed uruchomieniem usług. `start` sprawdza ten sam
plik i jego kanoniczny hash dla czterech usług, a następnie sam prowadzi etap
przygotowania przy utrzymanej pauzie. Komunikat `WAITING` z powodem
`ENTRY_START_CONFIGURATION_UNAVAILABLE` może zawierać znany kod diagnostyczny,
na przykład `CONFIG_SERVICE_UNAVAILABLE` albo `CONFIG_DRIFT`. Oznacza oczekiwanie
na świeże potwierdzenie wspólnej konfiguracji; nie jest poleceniem ręcznego
wznowienia wejść. Gdy diagnostyka jest niedostępna, komunikat pozostaje ogólny.

Zatrzymanie nowych wejść przez istniejący interfejs:

```sh
pnpm paper:ops --env-file .env control pause --reason 'Zatrzymanie przez właściciela'
pnpm paper:ops --env-file .env status
pnpm paper:ops --env-file .env control supervision
```

Pauza jest trwała i pozostawia nadzór wyjść. Nie wyłączaj całego procesu wykonania
ani `TRADING_ENABLED`, dopóki otwarte pozycje wymagają automatycznego zamknięcia.
Pełne wyłączenie wymaga sprawdzenia pozycji, aktywnych zleceń i uzgodnienia IBKR.
Szczegóły kontroli i ręcznej interwencji opisuje
[obsługa terminalowa](PAPER_HEADLESS_OPERATIONS.md).

## Kolejność wdrożenia

Wymagane są recenzja, testy, CI dokładnego commitu i czysty obraz. W prywatnym
zapisie wdrożenia zachowaj backup, wersje konfiguracji, digest obrazu oraz dowody
rachunku Paper, rozliczeń, źródeł, kwotowań i alertów. Nowa polityka v3 wymaga
adopcji przy wyłączonych zapisach, obu pauzach i świeżym potwierdzeniu braku
nieuzgodnionych pozycji/zleceń. Adopcja nie wznawia handlu.

Wszystkie usługi muszą używać tej samej zatwierdzonej konfiguracji. Dopiero po
przejściu kontroli włącz źródła, AI, scheduler, nadzór i zapisy w zakresie zgody
właściciela, a następnie jawnie wznów wejścia. Nie deklaruj gotowości na podstawie
samego `/ready`, liczby świec ani testów. Faktyczne zlecenie i pełny obrót wymagają
osobnych dowodów brokera.

## Przejściowy błąd zegara

Profil ciągłej pracy opisany tutaj wymaga
`EXECUTION_ACCOUNTING_AUTO_CLOCK_RECOVERY_ENABLED=true`, aby execution-engine
odzyskiwał izolowaną blokadę zegara bez ponownego `pnpm start`.
Wymaga wdrożenia kompatybilnego obrazu i jawnego Paper opt-in; domyślnie pozostaje
wyłączone; wdrożenie tego profilu musi jawnie włączyć tę flagę i potwierdzić ją
w efektywnej konfiguracji. Bez niej automatyczne odzyskiwanie zegara nie działa. Nowe wejścia wracają dopiero po pełnym potwierdzeniu rozliczeń, jeśli
nie zatrzymałeś ich ręcznie i pozostałe bramki pozwalają. Automat nie zmienia pauzy
operatora, master switch, ochrony pozycji ani zleceń.

## Automatyczne odzyskiwanie po awarii

Pakiet z 28 października zastępuje rutynowe ręczne odzyskiwanie źródła rozliczeń
oraz przerwanych odczytów WSH. Status wdrożenia i wyniki kontroli znajdują się w
[raporcie odzyskiwania](../implementation/phase3/AUTOMATIC_PAPER_STARTUP_RECOVERY_REPORT.md).
Poniższe zachowanie wymaga obrazu zawierającego ten pakiet.

Uruchom zalogowane TWS Paper i wykonaj `pnpm start`. Bot sprawdza rachunek,
konfigurację API, historię wykonań, pozycje i zlecenia oraz przygotowuje dane i
badania. Nie wymaga cyklicznego ręcznego potwierdzania pustego rachunku ani
restartu TWS po awarii bazy. `pnpm status` i `pnpm logs` pokazują postęp.

Po utracie połączenia z bazą lub TWS synchronizacja ponawia odczyt z ograniczoną
częstotliwością. Nowy proces przejmuje źródło dopiero po zwolnieniu blokady sesji
bazy i zapisuje nową generację; spóźnione wyniki starego procesu są odrzucane.
Historia, pauza operatora, rezerwacje kosztów i niepewne zlecenia pozostają w bazie.
API diagnostyczne działa podczas odzyskiwania źródła. Przy niedostępnej bazie
na samym starcie proces ponawia inicjalizację i zapisuje powód w logach.

Przerwany odczyt WSH zachowuje wynik UNKNOWN. Automat odbiera mu prawo publikacji,
a kolejny zwykły odczyt dopuszcza dopiero zgodnie z pierwotnym harmonogramem i
limitami. Nie uznaje starego odczytu za udany i nie odnawia budżetu. `WAITING`
oznacza dalsze przygotowanie; brak uprawnień, niezgodność konfiguracji lub
nierozstrzygnięte zlecenie nadal wymagają właściwej diagnozy. Synchronizacja
pozostaje aktywna także wtedy, gdy nowe wejścia są wstrzymane.

Automatyczna kwalifikacja źródła potwierdza możliwości bieżącej sesji API i zakres
historii. Nie wygasa wyłącznie dlatego, że minęło siedem dni; po zmianie generacji
musi powstać świeże potwierdzenie. Strefa czasu pochodzi z jawnej konfiguracji,
a jej pochodzenie pozostaje zapisane. Automat zegara zachowuje odstępy i historię
prób, zamiast kończyć pracę po trzech niepowodzeniach.

Niepewne wysłanie zlecenia nie jest niepewnym odczytem: bot nie wysyła go ponownie,
lecz uzgadnia je z IBKR. Nie usuwaj wierszy ani nie zeruj liczników, aby wymusić
start. Starsze instrukcje ręcznego resetu pozostają dokumentacją poprzedniego
obrazu, a nie zwykłym krokiem tego uruchomienia.

Pozostaw host pod zasilaniem, bez sleep i zamykania pokrywy; automat nie zastępuje
ciągłej dostępności TWS i komputera. Wygasła sesja logowania może wymagać logowania
w IBKR. Nie wymaga to przebudowy bota ani ponownej adopcji polityki.

## Środowisko deweloperskie odczytu rozliczeń

Nowy odczyt korzysta z przypiętego oficjalnego SDK Python, przygotowanego przez
`Dockerfile`. Obsługiwana ścieżka lokalnego uruchomienia tego modułu to obraz
Docker, także podczas prac deweloperskich:

```sh
docker build -t ikbr-trader-app:local .
```

Budowanie weryfikuje hash archiwum SDK, instaluje zależności z hashami i uruchamia
testy czytnika. Samo `pnpm install` nie instaluje tego środowiska. Uruchomienie
`pnpm dev:execution` bezpośrednio na hoście z włączonym źródłem rozliczeń wymaga
wcześniejszego odtworzenia kroków instalacji z `Dockerfile`: środowiska
`/opt/ikbr-sdk/bin/python`, źródeł w `/opt/ibkr-sdk-source` oraz identycznych wersji
i hashów. Nie zastępuj ich przypadkowym systemowym Pythonem lub pakietem ibapi.
Obraz deweloperski nie zastępuje zatwierdzonego obrazu z prywatnego profilu
`pnpm start`; wdrożenie nadal wymaga kontroli wydania.
