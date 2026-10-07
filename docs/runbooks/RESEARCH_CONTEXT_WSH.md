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
bazy, migrację 28 i kontrolowane przyjęcie manifestu przez obie usługi. Stare
archiwalne manifesty i decyzje pozostają czytelne; stare zatwierdzenie AI nie może
wykonać zlecenia według nowego promptu. Zaktualizuj hash prywatnego manifestu.
Nie usuwaj historii, żeby ominąć nieznane wyniki wcześniejszych operacji.

Odświeżanie WSH odbywa się nie częściej niż co 15 minut. Metadane i wydarzenia
mają osobne trwałe rezerwacje budżetu; zapytania jednego endpointu są szeregowane.
Podczas odświeżania poprzedni poprawny zapis zachowuje pierwotną ważność.
Nowy poprawny lub negatywny zapis unieważnia zgodę AI opartą na poprzednim.
Błąd zapisu nie przedłuża ważności starych danych. Timeout odczytu nie powoduje
natychmiastowego ponowienia; następny termin używa nowej sesji. Ta zasada nie
pozwala ponawiać nieznanego zlecenia brokerskiego ani wywołania modelu.

Raport `pnpm paper:ops --env-file .env status --instrument pko_wse` pokazuje rolę kalendarza, liczbę wydarzeń, liczbę newsów
z treścią oraz aktualność i blokady źródeł. Nie wyświetla surowych odpowiedzi WSH.
Nieaktualne dane, błędny emitent, wyczerpany budżet lub niepełna odpowiedź nadal
mogą uniemożliwić ocenę; sama data wydarzenia nie może tego zrobić.

Uruchomienie Paper wymaga aktualnego preflight i zwykłego sygnału strategii według
[runbooka PKO](GPW_PAPER_ROUND_TRIP.md). Testy tej integracji nie dowodzą wykonanej
transakcji. Wycofanie wdrożenia zatrzymuje odświeżanie i nowe wejścia, zachowując
historię V2; nie usuwa tabel ani nie przywraca po cichu starej zgody AI.
