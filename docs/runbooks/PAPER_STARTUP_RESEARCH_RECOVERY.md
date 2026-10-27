# Odzyskiwanie danych przy starcie Paper

Zakres: zatwierdzony lokalny profil Docker Paper, Marketaux i WSH. Kalendarz sesji
opisuje [oddzielny runbook](INSTRUMENT_SESSION_READINESS.md). Wdrożenie tej zmiany
wymaga migracji 37, nowego obrazu i zgodnego prywatnego dowodu wydania. Najpierw
zatrzymaj producentów przez `pnpm stop`; execution i ingestion obsługują nadzór
oraz wyjścia. Nie wykonuj migracji na aktywnych producentach.

Nowe próby Marketaux zapisują protokół ograniczający wysyłkę i publikację do
pierwotnego budżetu czasu. Scheduler sprawdza przerwane próby również wtedy, gdy
gotowość badań ma stan HOLD. Automatyczne recovery wymaga zgodnego zegara bazy,
lokalnego zegara i domeny zegara jądra. Stare próby bez tego dowodu wymagają
procedury operatora. Restart kontenera nie zeruje limitów ani historii błędów.

Recovery pozwala na kolejne zwykłe pobranie. Nie przywraca ważności starego cache,
nie przesuwa TTL, nie zamienia UNKNOWN w sukces i nie wznawia wejść. Dopiero
kompletne nowe dane przechodzą normalną kontrolę gotowości i propozycji.

## Przygotowanie

Polecenia korzystają z przypiętego profilu `.local/paper-runtime`, lokalnego
Dockera oraz uwierzytelnionych odczytów execution-engine. Stan wejść musi być
trwale wstrzymany. Wyłączony master `TRADING_ENABLED` jest dozwolony, jeżeli tak
zapisano w zgodnym prywatnym profilu. Narzędzie nie przełącza tych ustawień.

Obsługiwany kolektor to macOS i bezpośredni lokalny TWS/IB Gateway. Zdalny endpoint,
proxy, nieznany producent, inny obraz lub niepełna inwentaryzacja wymagają osobnej
diagnostyki. Narzędzie nie przyjmuje ręcznie wpisanego `confirmed=true`.

Kontener `llm-agent` utworzony przez wdrożenie z `--no-start` może pozostać w stanie
`created`; nie uruchamiaj go tylko po to, aby następnie go zatrzymać. Kolektor
akceptuje ten stan wyłącznie przy `Running`, `Paused` i `Restarting` równych
`false`, PID równym zero oraz obu czasach `StartedAt` i `FinishedAt` dokładnie
`0001-01-01T00:00:00Z`. Zapisuje rzeczywisty czas Docker `Created` w kanonicznym
UTC jako `createdAt`, a `startedAt` i `finishedAt` jako `null`. Brak, niepoprawna
lub przyszła data utworzenia blokuje recovery. Dowody `exited`/`dead` zachowują
dotychczasowy format. Kontener, obraz, konfiguracja i stan muszą pozostać zgodne
we wszystkich obserwacjach; wymiana lub uruchomienie producenta unieważnia dowód.
Stan `created` nie zastępuje obserwowanego resetu endpointu WSH ani handshake.
Obsługa `created` wymaga również migracji 40: po wykonaniu kopii zapasowej zastosuj
ją istniejącym runnerem migracji przed poleceniami recovery. Migracja rozszerza
walidację dowodu w bazie i zachowuje dotychczasową historię.

Po `pnpm stop` wybierz instrument z bieżącego manifestu:

```sh
pnpm paper:research-recovery prepare --kind marketaux --instrument pko_wse
```

Polecenie zwraca identyfikator recovery. W bazie powstaje trwałe wstrzymanie
przygotowania badań i wznowienia wejść. Upływ 15 minut nie usuwa tego wstrzymania.
Lokalne pliki dowodów mają uprawnienia prywatne; nie kopiuj do nich obcych danych.

```sh
pnpm paper:research-recovery observe --challenge <uuid>
pnpm paper:research-recovery commit --challenge <uuid>
```

Dla Marketaux `observe` sprawdza zatrzymanych producentów przed i po obserwacji.
`commit` ponownie sprawdza ten sam zbiór producentów, tożsamość wdrożenia i stan
maintenance. Rezerwacje kosztów, poprzednie wyniki i odstęp zwykłego cyklu pozostają.

## WSH: obserwowany ręczny restart

Niepewny wynik WSH może dotyczyć sesji, której obecny worker już nie posiada.
Nowe połączenie ani zakończenie workera nie dowodzą zamknięcia starej sesji.
Przed ręcznym restartem TWS/Gateway skoordynuj pozostałych klientów, otwarte
pozycje i ochronę; podczas restartu dostęp do API jest przerwany.

```sh
pnpm paper:research-recovery prepare --kind wsh --instrument pko_wse
pnpm paper:research-recovery observe --challenge <uuid>
```

Pozostaw `observe` uruchomione. Dopiero po jego komunikacie zamknij ręcznie cały
proces TWS/Gateway. Poczekaj na potwierdzenie, że poprzedni proces i nasłuch zniknęły,
a następnie uruchom aplikację ponownie. Samo rozłączenie API nie wystarcza.
Kolektor sprawdza nową tożsamość procesu, ten sam endpoint i producentów.
Jednorazowy proces wykonuje wyłącznie ograniczony handshake na dotychczasowym
WSH clientId, sprawdza oczekiwane konto i potwierdza rzeczywiste zamknięcie własnego
socketu. Nie pobiera metadanych, zdarzeń, historii ani nie wysyła zleceń.

Po zapisaniu obserwacji wykonaj `commit`. Nie powtarzaj automatycznie restartu po
niepewnym wyniku. Dowód obejmuje dokładnie wskazane stare próby; kolejne UNKNOWN
wymaga własnego dowodu. Próba na innym endpointzie nie jest naprawiana restartem
bieżącego endpointu.

## Niepewny zapis i nieaktualne recovery

Polecenia zapisują identyfikator operacji przed mutacją i po utracie odpowiedzi
wykonują odczyt dokładnego wyniku. Nie wysyłają ponownie możliwego zapisu.
Jeśli zaginęła odpowiedź `prepare`, użyj wypisanego identyfikatora operacji:

```sh
pnpm paper:research-recovery status --kind marketaux --instrument pko_wse --challenge <operation-uuid>
```

Gdy restart execution, nowa rewizja pauzy lub upływ ważności unieważniły przygotowane
recovery, można zastąpić je nowym, zachowując ciągłość wstrzymania:

```sh
pnpm paper:research-recovery supersede --challenge <old-uuid> --instrument pko_wse
```

To wymaga świeżego dowodu zatrzymania producentów i bieżącej uprawnionej tożsamości.
Operacja atomowo pozostawia stare recovery w historii i tworzy nowe PREPARED.
Nie usuwa niepewności źródła, nie wydaje dowodu odzyskania ani nie zmienia generacji
endpointu. Brak zgodnego mapowania źródła w nowym manifeście pozostaje blokadą.

Po potwierdzonym recovery uruchom normalne `pnpm start`. Dalsze pobranie nadal
podlega uprawnieniom dostawcy, budżetom, zwykłemu harmonogramowi, AI i ryzyku.
Stan usług w Dockerze nie oznacza gotowości każdego instrumentu do wejścia.

Kontrakt i kryteria testów: [startup research recovery](../implementation/phase3/PAPER_STARTUP_RESEARCH_RECOVERY_CONTRACT.md).
