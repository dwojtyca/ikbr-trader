# WSH i newsy jako kontekst decyzji AI

Decyzja właściciela z 7 października 2026: strategia techniczna nadal tworzy
propozycję wejścia. AI dostaje tę propozycję, raporty emitenta, dostępne prognozy
i wyniki, wiadomości oraz kalendarz WSH. Ocenia, czy informacje wspierają wejście,
i odpowiada EXECUTE albo REJECT. Bliskość wydarzenia nie uruchamia blokady 24 h,
7 dni ani innego stałego okresu. Deterministyczne kontrole ryzyka nadal obowiązują.

## Co otrzymuje AI

- Dane techniczne oraz dokładną cenę, stop, cel i ilość z istniejącej propozycji.
- Wymagane raporty i dane finansowe z dotychczasowych źródeł.
- Newsy Marketaux, dostępne opisy i fragmenty oraz sentyment przypisany dokładnie
  do sprawdzonego emitenta. Sentyment dostawcy nie jest prognozą wyników.
- Wszystkie rekordy z poprawnej, ograniczonej odpowiedzi WSH: terminy, statusy,
  rodzaje wydarzeń, dostępne wartości wyników/prognoz i informacje opisowe.
  Nieznany rodzaj wydarzenia pozostaje opisanym kontekstem dostawcy.

Niepotwierdzona data wyników nie oznacza negatywnej prognozy finansowej.
Brak opcjonalnej prognozy lub opisu jest jawny; nie staje się zerem ani automatyczną
odmową. WSH nie gwarantuje wszystkich wydarzeń na świecie. Pusta odpowiedź oznacza
brak rekordów w danym zapytaniu. Data wydarzenia nie jest datą publikacji informacji;
gdy ta ostatnia nie jest znana, zapisujemy moment pierwszej trwałej obserwacji.

WSH jest jedynym źródłem kalendarza. Ten pakiet nie wymaga dodatkowej subskrypcji
kalendarza ani potwierdzania terminów na stronach emitentów. Pola EPS mogą być
zwracane przez WSH; dostępność trzeba sprawdzić dla instrumentu. Dokumentacja
ogranicza konsensus `estimated_eps` do publikacji dzisiejszych lub wczorajszych.
[Słownik WSH](https://www.interactivebrokers.com/campus/wp-content/uploads/sites/2/2023/09/WSHEclassesandfieldsforIBAPI2022-12-23.pdf),
[pola wiadomości Marketaux](https://www.marketaux.com/documentation).

## Konfiguracja i wdrożenie

Użyj manifestu badań `schemaVersion: 2` oraz promptu `pp7-research-context-v2`;
schemat odpowiedzi pozostaje `pp4-decision-v1`. [Fragment źródła WSH](../../config/research/wsh-source.example.json)
jest celowo niezakwalifikowany, wygasły i ma zerowy budżet. To fragment źródła,
nie gotowy manifest. Zastępuje stare źródło roli `calendar` dla danego emitenta.
WSH wymaga zgodnego ISIN, conId, strefy IANA, aktualnego uprawnienia, kwalifikacji
metadanych i jawnego budżetu. Źródła raportów i newsów pozostają osobnymi rolami.

W lokalnym `.env` ustaw `RESEARCH_WSH_ENABLED`, identyfikator endpointu
`RESEARCH_WSH_ENDPOINT_ID`, host/port oraz osobny niezerowy
`RESEARCH_WSH_CLIENT_ID`. Port nie określa Paper/Live; robi to nadal
`IBKR_ENVIRONMENT`. Compose łączy się z TWS na hoście. Nie używaj identyfikatora
klienta ingestion lub execution. Włączenie WSH nie włącza zleceń.

Przed wdrożeniem zachowaj wyłączone zlecenia i wstrzymane wejścia, wykonaj kopię
bazy, aktualny łańcuch migracji aż do 33 (28 jest historyczną podstawą WSH)
i kontrolowane przyjęcie manifestu przez obie usługi. Migracje i przyjęcie
manifestu wykonuj przy wyłączonych zapisach oraz wstrzymanych wejściach. Stare
archiwalne manifesty i decyzje pozostają czytelne; stare zatwierdzenie AI nie może
wykonać zlecenia według nowego promptu. Zaktualizuj hash prywatnego manifestu.
Nie usuwaj historii, żeby ominąć nieznane wyniki wcześniejszych operacji.

Zwykłe odświeżanie WSH odbywa się co 15 minut. Zgodnie z decyzją właściciela
z 14 października nowy profil może ustawić `maxAgeMs=86400000`: poprawny
kalendarz, również poprawnie potwierdzony pusty wynik, zachowuje ważność przez
24 godziny od rzeczywistego pobrania. Dokładnie po 24 godzinach jest już
nieaktualny. Starsze manifesty z `maxAgeMs=900000` zachowują wcześniejsze
15 minut; zmiana wymaga przyjęcia nowego manifestu, nie edycji historii.
Wcześniejsze wygaśnięcie uprawnień lub kwalifikacji nadal ogranicza ważność.

Przejściowy błąd odświeżenia nie zastępuje poprawnego, nadal ważnego kalendarza.
Bot zachowuje jego pierwotne daty i dowody, a błąd próby zapisuje osobno.
Nie odświeża wieku danych samym ponowieniem. Błędna tożsamość, uprawnienia,
metadane lub niepoprawna odpowiedź pozostają blokadą; stary sukces nie maskuje
takiego błędu. Nowy poprawny wynik aktualizuje kontekst i jego powiązanie z AI.

W jednym cyklu dopuszczalne są najwyżej dwie dodatkowe próby odczytu:
po 30 sekundach od zapisania potwierdzonego zakończenia pierwszej sesji w bazie
oraz po 120 sekundach od zapisania zakończenia kolejnej. Liczniki i terminy są trwałe;
restart ich nie zeruje. Ponowienia nie przesuwają zwykłego cyklu 15 minut.
Wymagają zakończenia poprzedniego zadania i potwierdzenia zamknięcia jego
lokalnego połączenia. Kod `10281`, niepewne sprzątanie lub awaria procesu
nie uprawniają do szybkiego ponowienia. Bez pewnego dowodu zamknięcia dokładnie
tej lokalnej sesji kolejne żądania na jej połączeniu lub dla tego emitenta
pozostają zablokowane i wymagają diagnostyki; restart nie usuwa tej blokady.
Gdy potwierdzono samo zamknięcie, ale anulowanie pozostaje niepewne, możliwy
jest dopiero kolejny zwykły cykl. Poprawnie pobrany kalendarz zachowuje przy
tym pierwotną ważność. Każde nowe żądanie zachowuje odrębną
rezerwację budżetu; poprzednie nieznane wyniki pozostają w audycie.
Zasady te dotyczą odczytów WSH, nie ponawiania zleceń ani wywołań modelu.

Bez ważnego kalendarza bot czeka na dopuszczoną próbę, a po wyczerpaniu prób
wstrzymuje wejścia. Z ważnym kalendarzem przejściowy błąd odświeżenia pozostaje
widoczną informacją i sam nie blokuje pracy. Niepewność zapisu wyniku wymagająca
odzyskania stanu nadal blokuje użycie danych. Zmiana innej części manifestu
nie przenosi automatycznie kalendarza między wersjami konfiguracji.
Szczegóły kontraktu: [ważność i odzyskiwanie WSH](../implementation/phase3/WSH_FRESHNESS_RECOVERY_PLAN.md).

Raport `pnpm paper:ops --env-file .env status --instrument pko_wse` pokazuje rolę kalendarza, liczbę wydarzeń, liczbę newsów
z treścią oraz aktualność i blokady źródeł. Nie wyświetla surowych odpowiedzi WSH.
Nieaktualne dane, błędny emitent, wyczerpany budżet lub niepełna odpowiedź nadal
mogą uniemożliwić ocenę; sama data wydarzenia nie może tego zrobić.

## Błędy dostawcy i zatrzymanie

`RESEARCH_CALENDAR_ERROR` oznacza nieudane pozyskanie wydarzeń WSH, a nie błędną
datę ani harmonogram sesji giełdy. Nowe negatywne zapisy zachowują kod i oryginalny
komunikat dostawcy. Start i raport stanu pokazują ten opis przy źródle kalendarza.
Sekrety i identyfikatory rachunku są ukrywane, znaki sterujące escapowane, a tekst
ograniczony do 1000 znaków. Starsze wpisy mogą nie zawierać oryginalnego opisu;
diagnostyka mówi o jego braku zamiast odtwarzać go z numeru błędu.

Zatrzymanie agenta przerywa pobieranie WSH i przed rozłączeniem zleca anulowanie
własnych żądań wydarzeń i metadanych. Tą samą drogą sprzątane są zakończone
pobrania, timeouty i obsługiwalne błędy. Wysłanie anulowania nie jest
potwierdzeniem jego wykonania przez IBKR. SIGKILL, utrata zasilania lub zerwane
połączenie uniemożliwiają zagwarantowanie dostarczenia anulowania; zachowane
nieznane wyniki i limity pobierania pozostają obowiązujące. `10281` nadal wymaga
odczytania opisu dostawcy, nie resetowania historii lub zmiany clientId w ciemno.

`ACCOUNTING_CLOCK_INVALID` jest osobnym błędem modułu rozliczeń. Odpowiedź czasu
IBKR musi być poprawną całkowitą liczbą sekund epoki i różnić się od czasu procesu
w chwili odbioru najwyżej o dwie sekundy. Przekroczenie może wynikać z opóźnienia
odpowiedzi lub różnicy zegarów; sam kod nie dowodzi źle ustawionego zegara IBKR.
Kontrola pomaga potwierdzić aktualność historii wykonanych transakcji używanej do
dziennego wyniku i limitu straty. Próg jest regułą aplikacji, nie wymaganiem API.
Ten pakiet go nie zmienia. Utrwalony błąd wymaga istniejącej weryfikowanej ścieżki
[odzyskania rozliczeń](../implementation/phase3/PP7_ACCOUNTING_CLOCK_RECOVERY_REPORT.md),
a nie usunięcia wpisu lub uznania braku danych za zerową stratę.

Uruchomienie Paper wymaga aktualnego preflight i zwykłego sygnału strategii według
[runbooka PKO](GPW_PAPER_ROUND_TRIP.md). Testy tej integracji nie dowodzą wykonanej
transakcji. Wycofanie wdrożenia zatrzymuje odświeżanie i nowe wejścia, zachowując
historię V2; nie usuwa tabel ani nie przywraca po cichu starej zgody AI.
