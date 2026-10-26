# Paper account-day accounting source

Status: F1 implementation accepted by hostile review; full release validation is
pending. This document is not evidence that an
operator's broker host is qualified. The
[source contract](../implementation/phase3/PP7_ACCOUNTING_SOURCE_CONTRACT.md)
defines the supported capability and evidence boundary. Continue to use the
[Paper lifecycle runbook](PAPER_LIFECYCLE_SUPERVISION.md) for position management.

## Supported host and controls

The positive route uses TWS with seven-day Trade Log retrieval and Master Client
ID 0. A dedicated read-only accounting socket uses client ID 0; the existing
execution socket keeps its own nonzero ID and remains the order writer. The
accounting endpoint must match the configured execution host/port exactly. Other
configured clients must not occupy ID 0. IB Gateway's current-day retrieval is
not qualified as complete coverage of a Warsaw account day by this implementation.

Qualification records operator-observed settings that the API cannot attest. The
API handshake supplies protocol and account evidence; it does not prove the TWS
product build or Trade Log setting. Do not claim otherwise in an evidence record.

Keep `IBKR_ENVIRONMENT=paper`, `TRADING_ENABLED=false`, entries paused and the
trading loop disabled while preparing or qualifying the source. The allowlisted
Paper account, explicit `EXECUTION_BROKER_TIME_ZONE` (`UTC` or `Europe/Warsaw`)
and authenticated execution API must already be configured. Do not infer the
environment from the socket port. Qualifying the source does not enable trading.

## Private configuration and qualification

Create an operator-controlled directory with mode `0700`. Files read by the CLI
or service must be regular, nonsymlink files with mode `0600`; their containing
directory must have mode `0700`. Use absolute, canonical paths. Do not commit
account IDs, captures or host-setting evidence.

The source settings file is strict JSON with these fields:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `sourceKind` | `ibkr-tws-seven-day-v1` |
| `environment` | `paper` |
| `accountId` | Actual allowlisted Paper account |
| `endpoint` | Object containing the actual execution `host` and integer `port` |
| `sourceClientId` | `0` |
| `executionTimeZone` | Actual broker execution timestamp timezone, matching execution configuration |

Set `EXECUTION_ACCOUNTING_SOURCE_PATH` to this file and
`EXECUTION_ACCOUNTING_SOURCE_SHA256` to the SHA-256 of its exact bytes. A Docker
deployment needs an explicit read-only bind mount for the private directory, with
the path expressed inside the container. Do not bake this directory into an image
or loosen its permissions to bypass validation. Adopt migration
`000027_broker_accounting_source.sql` through the existing reviewed migration and
backup procedure before starting the disabled service.

With a valid API token in the process environment, the operator commands are:

```sh
pnpm --filter @ikbr/execution-engine accounting:source status
pnpm --filter @ikbr/execution-engine accounting:source inspect --out /absolute/private/inspection.json
pnpm --filter @ikbr/execution-engine accounting:source qualify --input /absolute/private/qualification.json --evidence-dir /absolute/private
pnpm --filter @ikbr/execution-engine accounting:source invalidate --reason "TWS settings changed"
```

The CLI defaults to `http://127.0.0.1:3103`. Set
`EXECUTION_ACCOUNTING_API_URL` for another endpoint; nonloopback endpoints require
HTTPS. It refuses redirects. `inspect` writes a new private file and does not
overwrite an existing receipt. All commands use the service's accounting socket;
the CLI must not open a competing client-0 connection.

Prepare the qualification JSON from actual host evidence and the latest
inspection ID. The strict fields are defined by `qualificationSchema` in
`apps/execution-engine/src/accounting/config.ts`. Record the actual operator,
observation time, TWS product version/build, seven-day retrieval, Master 0,
execution timezone and the exact settings-file digest. The four evidence kinds
are `tws-product-build`, `tws-trade-log-seven-days`, `tws-master-client-zero` and
`execution-timezone`. Each references a relative PNG, JPEG or UTF-8 text path,
its exact SHA-256 and observation time. Each file is bounded at 5 MiB, total
20 MiB. The CLI validates local bytes; the server receives metadata and digests,
not arbitrary filesystem paths to read.

Observe the settings and submit qualification within 30 minutes. Confirmations
must reflect the real endpoint/account and current host session, unchanged
settings, and the operator's commitment to pause and requalify before settings
changes. Do not create a positive record from this runbook or sample values.
Historical executions are useful corroboration; an empty account needs no test
trade to fabricate that evidence. Qualification requires entries to be paused.

## Freshness and recovery

A settings qualification expires after seven days. Revoke it immediately on any
account, host, build, Master ID, retrieval-window or execution-timezone change.
Revocation is available while the bot runs and immediately prevents further
entries. It does not cancel protection or close positions.

Every entry independently requires a fresh complete replay, broker-clock anchor,
execution/account identity and finite matching commissions and realized P&L.
Settings qualification is not a seven-day trading-data cache. Reconnect, restart
or day rollover requires fresh full replay and a new capture; an unexpired
unchanged settings qualification can be reused. Missing fees and IBKR unset
sentinels are never treated as zero.

New execution or fee callbacks prevent admission before their persistence has
completed. Exact persisted replay duplicates do not change economic state.
Corrections, contradictory records, buffer overflow and failed persistence retain
holds. Neither restarting nor deleting local rows resolves a durable accounting
contradiction. Keep source observations and qualification history for audit.

For a durable `ACCOUNTING_CLOCK_INVALID` alone, use the authenticated recovery
command with `TRADING_ENABLED=false` and effective entries paused:

```sh
pnpm --filter @ikbr/execution-engine accounting:source -- recover-clock --out /absolute/private/clock-recovery.json
```

The output directory must have mode 0700; the command creates a new mode-0600
file and refuses existing files or symlink paths. It never changes trading switches.
Recovery retires the accounting socket, verifies a fresh connection and clock, and
completes the existing execution/commission replay. It atomically records the
recovery receipt and clears only the clock hold. Qualification identity and expiry
remain unchanged; a missing qualification remains missing. The source retains its
gap and needs a subsequent joined reconciliation capture before entry admission.

Recovery refuses non-clock holds, persistence problems, missing costs and retained
contradictions, including failures that an older clock update may have overwritten.
Restart or a good clock callback alone cannot clear the hold. A failed recovery
retires its attempted connection; another explicit attempt needs fresh evidence.
Rejected clock diagnostics are retained without inventing missing values from
older failures. Fix settings and obtain fresh operator qualification evidence if
settings changed. This command does not resolve execution corrections or retry orders.

`status` reports the current hold, qualification expiry, pending persistence and
capture identity. A qualified source can still be held by stale broker evidence,
incomplete reconciliation or other entry requirements. Healthy source status does
not establish research coverage, an AI approval, a strategy signal or permission
to trade. The supervised entry and exit still follow the selected
[AAPL](AAPL_PAPER_ROUND_TRIP.md) or [GPW](GPW_PAPER_ROUND_TRIP.md) runbook and current PP7 gates.

## Automatyczne odzyskiwanie zegara w Paper

`EXECUTION_ACCOUNTING_AUTO_CLOCK_RECOVERY_ENABLED=true` wybiera ograniczone
odzyskiwanie izolowanego `ACCOUNTING_CLOCK_INVALID` w działającym execution-engine.
Domyślnie flaga jest wyłączona. Wymagane są Paper, skonfigurowane źródło accounting
oraz istniejąca ważna kwalifikacja ustawień. Sama flaga nie udziela zgody na handel.

Automat utrzymuje blokadę nowych wejść, odnawia wyłącznie połączenie accounting,
weryfikuje czas, pełny replay wykonań i prowizji, zapisuje dowód, a następnie wymaga
nowego qualified capture. Nie zmienia master switch ani ręcznej/startup pauzy,
nie zatrzymuje execution socketu i nie składa lub ponawia zleceń. Zwykły snapshot
brokera dla wyjść pozostaje dostępny przy błędzie accounting; nadal obowiązują
pełne reguły ownership, close-risk i świeżości danych.

Stan jest w accounting status, supervision oraz `pnpm status`: `WAITING`,
`RECOVERING`, `BACKOFF`, `VERIFYING`, `RECOVERED`, `OPERATOR_REQUIRED` lub
`OUTCOME_UNKNOWN`. `RECOVERED` dotyczy tylko rozliczeń; ręczna pauza i inne blokady
pozostają niezależne. Brak aktualnego statusu nie jest dowodem powodzenia.

Automat wykonuje najwyżej trzy próby na epizod, z odstępami 30/120 s po błędach,
oraz najwyżej sześć akwizycji na źródło w godzinę. Niepewny zapis lub rozłączenie,
konflikt tożsamości, koszty, sprzeczności i utrata kwalifikacji wymagają operatora.
Restart i zmiana flagi nie kasują historii ani nie odnawiają limitu. Nie zmieniać
zegara i nie usypiać hosta, aby testować odzyskiwanie na rachunku z pozycją.

Manualny `recover-clock` nadal wymaga wyłączonych zapisów i efektywnej pauzy.
Gdy dowód recovery już istnieje, lecz końcowa weryfikacja wymagała operatora,
manualna ścieżka może zamknąć epizod na podstawie aktualnego poprawnego capture;
nie tworzy wtedy kolejnego recovery ani nie kasuje innych holdów. Wygasła
kwalifikacja wymaga istniejącej procedury `qualify` i rzeczywistych dowodów.
Nie wolno wyłączać master writes tylko w celu recovery, gdy pozycje wymagają
automatycznych wyjść: najpierw uzgodnić obsługę ekspozycji.

Po utracie właściciela socketu lub braku potwierdzenia jego zakończenia źródło
pozostaje zablokowane. Wygaśnięcie locka/lease nie dowodzi rozłączenia brokera.
Nie usuwać wierszy właściciela, epizodu ani prób. Eskalować nieznany wynik.
Wdrożenie i rollback muszą zachować kompatybilny writer i trwałe entry fences.
Szczegółowe kryteria są w [planie](../implementation/phase3/ACCOUNTING_AUTOMATIC_CLOCK_RECOVERY_PLAN.md).

## Porzucony właściciel `ACCOUNTING_SOURCE_OWNER_UNRETIRED`

Ta blokada powstaje przed startem HTTP execution. Nie rozwiązuje jej `recover-clock`
ani sam restart Dockera. Nie usuwać ani ręcznie oznaczać jako zakończony wiersza
`accounting_source_owners`: wolny lock PostgreSQL nie potwierdza zakończenia
poprzedniego połączenia z TWS.

Polecenie `pnpm paper:accounting-owner-recovery` służy do osobnej, nadzorowanej
procedury offline. Wdrożenie kodu nie oznacza wykonania recovery ani zgody na
handel. Wymagany jest opublikowany, przypięty obraz zawierający tę funkcję oraz
migracja `000038_accounting_owner_recovery.sql` przez istniejący runner, po
wykonaniu backupu. Nie uruchamiać starego obrazu przy oczekującym maintenance.

Obsługiwany zakres to lokalny macOS, Docker Desktop przez lokalny socket, natywny
TWS, jawny Paper i dokładnie jeden dozwolony rachunek. Wszystkie usługi aplikacji
muszą być zatrzymane; brak opcjonalnego kontenera UI/backtest jest dopuszczalny.
Master writes muszą być wyłączone, a istniejąca trwała pauza wejść potwierdzona.
Pozostałych ustawień profilu nie należy zmieniać na potrzeby tej procedury.

Pierwsza wersja obsługuje wyłącznie rachunek bez historii prób wysłania zleceń
przez bota. Nawet historyczny, pozornie zakończony `execution_attempted_at`
wyklucza ten zakres. Wykluczają go też rezerwacje i nierozstrzygnięte operacje.
Nie kasować historii w celu spełnienia tego warunku. Rachunek musi być w całości
bez pozycji i otwartych zleceń, także ręcznych lub dotyczących innych instrumentów.
Brak ekspozycji sprawdza właściciel w TWS; lokalna baza nie zastępuje tego dowodu.

Przygotować prywatny JSON dowodu operatora i trzy różne pliki potwierdzające
rachunek/środowisko, pozycje oraz otwarte zlecenia. Katalog ma mieć tryb `0700`,
pliki `0600`, bez symlinków. Obsługiwane są PNG, JPEG i UTF-8 TXT, do 5 MiB każdy.
Dokładny schemat `OwnerRecoveryOperatorEvidence` jest w
`packages/shared/src/accounting-owner-recovery.ts`. Dowód zawiera rzeczywiste
identyfikatory rachunku, endpointu, hashe ustawień i przypiętego wdrożenia,
tożsamość operatora, czas obserwacji i hashe plików. Potwierdzenia dotyczą także
braku innych klientów brokera i zakazu ich uruchamiania w trakcie procedury.
To jawna deklaracja operatora poparta integralnością plików, nie automatyczna
interpretacja zrzutu ekranu. Nie tworzyć pozytywnych deklaracji z przykładu.

W procesie wywołującym ustawić `OWNER_RECOVERY_OPERATOR` oraz niezależnie
dostarczony `OWNER_RECOVERY_API_TOKEN`, zgodny z tokenem execution w przypiętym
profilu. Nie wpisywać tokenu w argumentach polecenia ani w pliku dowodów.
Przed `prepare` hashe ustawień i wdrożenia należy odczytać z prywatnego,
zweryfikowanego profilu. Po wymianie procesu `observe` wypisuje dokładny obiekt
`afterReset` i najwcześniejszy dopuszczalny czas nowych dowodów.

Kontenery nowego, zatwierdzonego obrazu można przygotować bez uruchamiania usług
przez `docker compose up --no-start --no-deps --no-build --pull never --force-recreate` z kompletem
plików zatwierdzonego prywatnego profilu i jawną listą usług aplikacji. Najpierw
potwierdź ich zatrzymanie, backup oraz brak aktywnego obserwatora i jego
jednorazowego backendu; dla pozostawionej operacji PREPARED stosuj zasady poniżej. Nie
odtwarzaj kontenerów podczas obserwacji. `--no-deps` pozostawia bazę i Redis bez
zmian. Nie uruchamiaj producentów tylko po to,
żeby uzyskać stan zatrzymany. Nowy wariant obsługuje `Created` wyłącznie przy
potwierdzonym PID 0, braku uruchomienia, zerowych czasach start/stop i zgodnej
tożsamości obrazu oraz polecenia. Obserwacja przechowuje rzeczywisty czas utworzenia,
a nie fikcyjne czasy startu. Wymaga kompatybilnego hosta i obrazu; starsza wersja
narzędzia odrzuca ten stan. Nie zastępuje to resetu TWS ani dowodów rachunku.
Działające obce kontenery nadal powodują odmowę w tym ograniczonym trybie.
Nie zatrzymuj obcych usług bez uzgodnienia. Szczegóły:
[plan wdrożenia bez uruchamiania](../implementation/phase3/PAPER_ACCOUNTING_ZERO_START_DEPLOYMENT_PLAN.md).

Odczyt procesów w poprawce z 26 października używa jednej kompletnej listy
z zachowaniem pełnych argumentów. Błąd inwentaryzacji nadal przerywa obserwację;
nie ponawiaj jej w tej samej operacji ani nie ignoruj nieznanych procesów.
Po przerwaniu sprawdź dokładny status. Wdrożenie kolejnej zatwierdzonej poprawki
jest dopuszczalne przy pozostawionej operacji PREPARED tylko po potwierdzeniu,
że jej obserwator i jednorazowy backend już nie działają. Zachowaj maintenance,
właściciela i pauzę. Zmieniony profil wymaga świeżego dowodu operatora i
obsługiwanego `supersede`; stara obserwacja nie może być kontynuowana. Szczegóły:
[naprawa inwentaryzacji](../implementation/phase3/PAPER_ACCOUNTING_NATIVE_INVENTORY_REPAIR_PLAN.md).

Kolejność działań:

1. Po sprawdzeniu powyższych warunków wykonać
   `pnpm paper:accounting-owner-recovery prepare --operator-evidence /absolute/private/before.json`.
   Zapisać zwrócony identyfikator operacji. `PREPARED` utrwala maintenance:
   zwykłe przejęcie właściciela pozostaje zabronione, również po upływie czasu.
2. Uruchomić
   `pnpm paper:accounting-owner-recovery observe --operation <uuid> --operator-evidence /absolute/private/after.json`.
   **Ta komenda obejmuje obserwację i końcowy zapis recovery.** Nie istnieje
   osobne polecenie `commit` przyjmujące zapisany wcześniej dowód.
3. Dopiero po rozpoczęciu obserwacji ręcznie zamknąć cały TWS. Poczekać na
   potwierdzenie zniknięcia procesu i nasłuchu; wtedy ręcznie uruchomić TWS.
   Narzędzie nie steruje interfejsem brokera. Wcześniejszy restart nie spełnia
   tego warunku.
4. W nowej sesji TWS ponownie zweryfikować rachunek, brak pozycji i zleceń.
   Zapisać świeży `after.json` z nowymi artefaktami i powiązaniem `afterReset`
   z operacją, nonce i nową tożsamością procesu. Narzędzie sprawdza bieżący
   dowód, wykonuje pojedynczy odczytowy handshake klienta 0 i czeka na faktyczne
   zamknięcie tego socketu. Nie składa, nie anuluje ani nie ponawia zleceń.
5. Sprawdzić niezmienny receipt przez
   `pnpm paper:accounting-owner-recovery status --operation <uuid>`.
   Potwierdzony `COMMITTED` dotyczy wyłącznie zakończenia starego właściciela.

Cała operacja ma 15 minut od `PREPARED`, a dowody operatora muszą być świeższe
niż pięć minut. Przerwanie komendy, utrata nadzoru, zmiana konfiguracji, start
producenta lub niepewne zamknięcie pozostawiają blokadę. Nie ponawiać zapisu po
timeout: odczytać dokładną operację i request ID. Brak odpowiedzi nie oznacza
wycofania transakcji. `supersede --operation <uuid> --operator-evidence
/absolute/private/new-before.json` tworzy audytowaną operację zastępczą przy
świeżych dowodach, bez przerwy w maintenance; wymaga nowej pełnej obserwacji.

Recovery nie odświeża kwalifikacji TWS, nie kasuje `ACCOUNTING_CLOCK_INVALID`,
nie poprawia reconciliation, WSH/Marketaux ani budżetów. Następny zwykły start
musi przejść własne bramki i pełny replay. Sam receipt nie wznawia wejść.
Szczegóły dowodów, ograniczeń i stanów nieznanych zawiera
[kontrakt recovery](../implementation/phase3/PAPER_ACCOUNTING_OWNER_RECOVERY_CONTRACT.md).
