# PP6 — obsługa terminalowa, wdrożenie i odzyskiwanie

Ten runbook obsługuje odczyt i istniejące kontrole PP5. Raport nie jest zgodą na
handel. PP4 nadal ma blokady rzeczywistych źródeł; testy PP6 nie usuwają braków
kwotowań, completed orders ani rozliczeń brokera. PP7 wymaga osobnej autoryzacji.
`apps/ui` nie jest wymagane. Dotychczasowy interfejs pozostaje w repozytorium.

## Codzienny odczyt

Z katalogu repozytorium, Node zgodny z package.json i pnpm 9.5.0:

```sh
pnpm paper:ops --help
pnpm paper:ops --env-file .env status
pnpm paper:ops --env-file .env status --instrument pko_wse
pnpm paper:ops --env-file .env logs --follow --instrument aapl_smart
pnpm paper:ops --env-file .env logs --severity CRITICAL
pnpm paper:ops --env-file .env logs --reason NO_SIGNAL
pnpm paper:ops --env-file .env trace --proposal 42
pnpm paper:ops --env-file .env trace --evaluation UUID_Z_RAPORTU
pnpm paper:ops --env-file .env session --from 2026-10-04T07:00:00Z --to 2026-10-04T15:00:00Z
pnpm paper:ops --env-file .env export --from 2026-10-04T07:00:00Z --to 2026-10-04T15:00:00Z --output diagnostyka.txt
```

Identyfikatory/czas są przykładami; użyj wartości z raportu. `--json` daje te same
pola w wersjonowanym formacie maszynowym. Normalna obsługa używa polskiego tekstu,
bez SQL i jq. `--timezone` zmienia tylko prezentację (domyślnie Europe/Warsaw).
Filtry `--from`/`--to` przyjmują UTC z Z; zakres maksymalnie 31 dni, limit 1–1000.
Domyślnie ostatnia godzina i 200 zdarzeń. Id instrumentu jest istotniejszy niż ticker:
raport zawiera także conId, rynek i wersję konfiguracji.

`trace` dla dokładnego ID odczytuje zachowaną historię tej oceny/propozycji oraz
powiązanego zamknięcia także poza ostatnią godziną. Podany zakres raportu opisuje
odnalezione dowody. Nadal obowiązuje limit 1000 zdarzeń/2 MiB i jawne pominięcia;
nie odtwarza to usuniętych ocen ani niezapisanych przejść stanu. Limit 31 dni
obowiązuje wyszukiwanie czasowe logs/session/export.

Względne ścieżki `--env-file` i `--output` odnoszą się do katalogu wywołania
`pnpm paper:ops`, a ścieżki bezwzględne pozostają bez zmian.

Token pochodzi z `EXECUTION_API_TOKEN` w środowisku albo wskazanego `--env-file`.
Nie wpisuj go do argumentów, historii powłoki ani plików raportu. Odczyt wymaga
uwierzytelnienia także przy wyłączonych zapisach. Domyślny adres to loopback na porcie 3103;
wewnątrz Compose można jawnie podać `--base-url http://execution-engine:3103`.
Klient odmawia dowolnych zewnętrznych adresów i przekierowań. Kontenerowy wariant:

```sh
docker compose exec -T execution-engine pnpm paper:ops --base-url http://execution-engine:3103 status
```

`logs` czyta utrwalone dowody i wyniki ocen, nie losowo próbkowaną konsolę.
`--follow` odświeża odczyt co 5 s, powtarza okno do 5 min i usuwa duplikaty identyfikatorów.
Po rozłączeniu pokazuje ograniczenie odtworzenia; szerszą przerwę sprawdź przez
`session` z jawnym zakresem. Przekroczenie limitu, rotacja, brak heartbeat i zmiana
procesu nie oznaczają kompletnej sesji. Powtarzalne INFO są agregowane z liczbą i
czasem pierwszej/ostatniej obserwacji. Krytyczne zdarzenia i rozwiązania pozostają
oddzielne; całe wyniki ocen są przechowywane niezależnie od skrótu tekstowego.

## Jak czytać wynik

| Sytuacja | Znaczenie i reakcja |
| --- | --- |
| Brak sygnału | Strategia została oceniona, ale nie wybrała wejścia. Nie zmieniaj parametrów tylko po to, by uzyskać transakcję. |
| Odrzucenie AI/ryzyka | Otwórz `trace` dla propozycji; zobacz zapisane uzasadnienie, riskFlags, ryzyko i odniesienia do źródeł. |
| Pauza wejść | Sprawdź trwałą pauzę, ustawienie startowe i master. Pauza nie zatrzymuje automatycznych wyjść. |
| Zamknięty rynek | Dowód kalendarza wskazuje przerwę sesji; nie jest to to samo co awaria źródła. |
| Dane nieaktualne/brak | Sprawdź wiek, zakres i powód braku kwotowań/historii/badań. Brak nie jest wartością zero. |
| UNKNOWN/HOLD | Nie ponawiaj zlecenia ani zamknięcia. Potrzebne jest obsługiwane uzgodnienie z brokerem i wyjaśnienie niepewności. |
| Wysłano | Nie dowodzi realizacji. Oddzielnie sprawdź broker acknowledgement, fill, ochronę, zamknięcie i rozliczenie. |
| Opłaty niepełne/różne waluty | Wynik netto pozostaje niepotwierdzony albo podzielony na waluty. Nie sumuj PLN i USD. |
| Alert dostarczony | Potwierdzenie dostawcy nie dowodzi przeczytania przez człowieka, rozwiązania błędu ani płaskiej pozycji. |

COMPLETE dotyczy wskazanego ograniczonego odczytu zapisanych rekordów. Nie jest
certyfikatem gotowości brokera. Aktualizowana migawka nadzoru/zamknięcia nie pozwala
odtworzyć wszystkich wcześniejszych przejść; raport oznacza takie braki. Źródła AI
są odczytywane z zapisanych snapshotów, nigdy pobierane odpłatnie przez polecenie
raportowe. Dokładne `auditRef` prowadzą do istniejących uwierzytelnionych API.

Eksport jest ograniczony do 1 MiB / 1000 zdarzeń / 31 dni, ma uprawnienia 0600 i nie
nadpisuje pliku ani dowiązania. Pseudonimy korelacji są spójne w jednym eksporcie;
nowy eksport używa nowej losowej soli. Kwoty i niezaufana treść AI są pomijane,
a odnośniki do dokładnych prywatnych rekordów usuwane. Zachowane są schema/config
hash i jawne pominięcia. To diagnostyka do udostępnienia, nie pełny backup audytu.

## Kontrole i ręczna interwencja IBKR

Poniższe polecenia zmieniają stan przez dotychczasowe API. W tej dostawie nie były
wykonywane na rzeczywistym koncie ani odbiorcach. Warunki są opisane w
[PAPER_LIFECYCLE_SUPERVISION](PAPER_LIFECYCLE_SUPERVISION.md).

```sh
pnpm paper:ops --env-file .env control supervision
pnpm paper:ops --env-file .env control pause --reason 'Przegląd incydentu'
pnpm paper:ops --env-file .env control resume --reason 'Usunięto potwierdzone blokady'
pnpm paper:ops --env-file .env control close --proposal 42 --request-id ZAPISANY_UUID --limit-price 100
pnpm paper:ops --env-file .env control reconcile --proposal 42
```

Pause/resume mają trwały audyt. Resume nie kasuje holdów, prób ani bramek AI/ryzyka.
Close wymaga oryginalnego ownership, dokładnie jednej obsługiwanej akcji, świeżego
ryzyka, master=true i tego samego wcześniej zapisanego requestId. Klient nie generuje
nowego UUID i nie ponawia POST. Timeout oznacza wynik niepotwierdzony; zbadaj istniejący
request, nie twórz nowego, aby ominąć rezerwację. Przy master=false pełne zamknięcie
jest blokowane; brokerowe TP/SL pozostają aktywne. Samo ustawienie master=false nie
cofa już wysłanej operacji.

Ręczna sprzedaż może wyprzedzić automatyczny close; ręczna zmiana ilości albo obce
zlecenie ochronne może pozostawić HOLD. Nie sprzedawaj ponownie na podstawie starej
migawki. Niezwiązana ręczna pozycja uczestniczy w ryzyku całego konta, ale nie jest
samoczynnie przejmowana przez bota. PP5 nie oferuje ogólnego, dowiedzionego protokołu
zatrzymania zarządzania i płynnego przejęcia ręcznego. Pauza wejść nie jest takim
protokołem. Przed taką interwencją trzeba sprawdzić aktywną operację close i ochronę;
obsługa bezpiecznego przejęcia wymaga osobno zrecenzowanej zdolności.

Po autoryzowanej interwencji właściciela potwierdź świeżą ilość IBKR, outstanding
orders, executions i ownership przez obsługiwane uzgodnienie. Niewiadome pozostają
HOLD. Nie usuwaj lokalnych rekordów, nie zeruj budżetu i nie zgaduj autora zlecenia.
Agent nie automatyzuje aplikacji IBKR. Ten runbook nie upoważnia do transakcji.

## Wdrożenie bez UI

Wdrożenie wymaga odrębnie ustalonego środowiska i przejścia bramek projektu. Poniższa
procedura zachowuje zapisy wyłączone. Najpierw prywatny backup i zapis manifestu:
commit, digest obrazu, hash plików konfiguracji, wersje/checksum migracji oraz datę UTC.
Nie kopiuj `.env` do raportu. Używaj obrazu sprawdzonego w CI dla dokładnego SHA.

Ustaw w prywatnej konfiguracji `IBKR_ENVIRONMENT=paper`, `TRADING_ENABLED=false`,
`EXECUTION_ENTRIES_PAUSED=true`, `EXECUTION_LIFECYCLE_AUTOMATION_ENABLED=false`.
Nie zmieniaj allowlist ani tokena, aby ominąć problem. PP5 pierwszej adopcji wymaga
wyłączonych zapisów. Zatrzymaj UI; wybierz usługi jawnie:

```sh
docker compose build --no-cache ingestion signal-engine execution-engine llm-agent
docker compose stop ui
docker compose up -d postgres redis ingestion execution-engine signal-engine llm-agent
pnpm paper:ops --env-file .env status
```

Start rzeczywistego llm-agent może uruchomić skonfigurowane źródła; start execution
z rzeczywistym Telegramem wysyła procesowy probe PP5. Nie używaj rzeczywistych
sekretów/odbiorców podczas prób. Izolowane próby używają fixture API i własnego
Postgresa, bez ładowania indeksów usług uruchamiających broker/provider/alerty.
Backtest i UI nie są zależnościami tej obsługi. Wyłączenie aplikacji z aktywną
pozycją wymaga osobno skoordynowanego planu, aby nie utracić nadzoru wyjść.

Logi Docker używają lokalnego drivera z limitem 10 MiB × 3 na usługę. Kopie ocen PP6
mają retencję 30 dni / 100000 wierszy i watermark usunięcia. Watermark/braki są pokazywane
w raportach. Audyt zleceń, ownership, attempt, research, close i PP5 alerty nie są
usuwane przez retencję diagnostyki. Obserwuj zajętość wolumenu Postgresa i prywatne
kopie zapasowe. Awaria zapisu diagnostyki emituje jawny błąd; proces nie może obiecać
trwałości w trakcie niedostępności bazy.

`ACCOUNT_PROPOSAL_MISMATCH` oznacza sprzeczne zapisane powiązanie konta i propozycji.
Diagnostyka całego konta pozostaje wtedy niedostępna, aby nie przypisać cudzych
dowodów do transakcji. Tak samo traktowana jest niemożność wykonania kontroli
tożsamości. Potrzebne jest obsługiwane uzgodnienie i wyjaśnienie niespójności;
nie naprawiaj tego przez usuwanie rekordów lub ponowienie zlecenia.

## Backup, odtworzenie i rollback

W uzgodnionym oknie, przy wyłączonych zapisach i bez nieskoordynowanej pozycji,
wykonaj prywatny dump. Nie umieszczaj go w Git ani eksporcie diagnostycznym:

```sh
umask 077
docker compose exec -T postgres pg_dump -U postgres -d ikbr_trader -Fc > /prywatny/katalog/ikbr_trader.dump
```

Kopia zawiera dane konta; przechowuj ją szyfrowaną poza repozytorium zgodnie z
przyjętą polityką backupów. Osobno zachowaj prywatne `.env`, oryginalne pliki
config/research, commit i digest. Sam Redis ani logi konsoli nie są backupem audytu.
Nigdy nie testuj przywracania na operacyjnej bazie.

Przywróć do nowej izolowanej bazy za pomocą `pg_restore --exit-on-error --no-owner`.
Najpierw uruchom tylko PostgreSQL, żadnego execution/llm/brokera. Porównaj spisy i
hash danych ownership, oryginalnych konfiguracji, research/AI, attempts, close,
entry-control, fault/delivery i migracji. Dostarczony fixture drill w
`apps/execution-engine/src/diagnostics/recovery-drill.ts` używa wyłącznie
`TEST_POSTGRES_URL` z nazwą `pp6_restore_*`, komend `seed` i `verify` oraz prawdziwego
pg_dump/pg_restore. Nie przyjmuje operacyjnej nazwy bazy. Raport PP6 podaje wynik
wykonanej próby, a nie obietnicę odzyskania rzeczywistego konta.

Po rzeczywistym restore pozostaw master=false i pauzę. Kopia nie mówi, czy po jej
dacie pojawiły się brokerowe zlecenia. Wymagane są aktualna identyfikacja konta,
pełne uzgodnienie IBKR oraz zgodne ownership i oryginalne markery nieznanych operacji.
Nie włączaj writerów przed wyjaśnieniem rozbieżności. Nie odtwarzaj z backupu
fałszywego „flat”. Nie ponawiaj UNKNOWN ani nie kasuj historycznych rezerwacji.

Rollback: zatrzymaj nowe wejścia, zachowaj nadzór istniejącej ekspozycji w obsługiwanej
wersji i przygotuj backup. Użyj poprzedniego kompatybilnego obrazu, który rozumie
PP5 ownership/pauzę/close; nie cofaj migracji 25 ani migracji 1–24. PP6 dodaje
kopie diagnostyczne, ale rollback nie może cofać trwałych ograniczeń PP5. Gdy
zgodność obrazu jest niepewna, pozostaw zapisy wyłączone i użyj sprawdzonej wersji
odzyskiwania. Po uruchomieniu raportuj brak/nową generację obserwacji aż do świeżego
uzgodnienia. Żaden raport nie kasuje holdów i nie przyznaje uprawnienia do resume.
