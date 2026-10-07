# PP7 E1c — przygotowanie integracji WSH

Data: 2026-10-07. Baza: `94f1cb7d908edf1cdac7f8d103e73f66be029fff`.
Status: kod przygotowania offline zaakceptowany; końcowe checks PASS,
publikacja i CI zablokowane. G1/G2 pozostają niezaliczone.

## Zakres i ustalenia

Właściciel zlecił implementację [czteropunktowego planu](PP7_WSH_TO_FIRST_PAPER_PLAN.md).
[Kontrakt E1c](PP7_WSH_E1C_CONTRACT.md) rozdziela brakujące gwarancje źródła
od przygotowania, które można wykonać bez połączenia z dostawcą.

Wcześniejszy odczyt używał `totalLimit=1000`; aktualna dokumentacja IBKR podaje
maksimum 100. Dostęp do WSH i zgodność tożsamości zwróconych rekordów nie
potwierdzają kompletności kalendarza. Nadal brakuje kwalifikacji zakresu,
zakończenia odpowiedzi, niepewnych terminów, czasu wiedzy oraz praw do
zamierzonego użycia danych. Szczegóły i niewysłane pytania do dostawcy są
w kontrakcie. Nie dopisano gwarancji na podstawie samego udanego odczytu.

Pakiet przygotowawczy obejmuje wyłącznie czysty inspektor żądania i struktury
danych, syntetyczne testy oraz dokumentację. Nie jest adapterem produkcyjnym.
W tym zakresie nie ma uruchomienia handlu, nowych odczytów WSH/Marketaux/OpenAI,
zmian prywatnej konfiguracji, operacyjnej bazy ani powiadomień.

`inspectWshRequest` sprawdza jawne pola żądania, daty, conId, wyłączone fill flags
i limit 1–100. `inspectWshEventRows` zlicza kategorie struktury, zgodność wskazanej
tożsamości oraz obecność pól ogłoszenia. Zwraca wyłącznie stałe kody i liczniki;
nie zwraca danych emitenta, treści, dat wydarzeń ani statusu dopuszczenia do handlu.
Pusta tablica nie jest dowodem pustego kalendarza. Moduł nie ma produkcyjnych
wywołań ani połączeń z bazą, plikami lub siecią.

Osobne uruchomienie offline na wcześniejszych prywatnych odpowiedziach potwierdziło
`INVALID_TOTAL_LIMIT` dla poprzedniego żądania oraz zgodność tożsamości 3 rekordów
PKO i 14 AAPL. Pola `announce_*` były nieobecne w 3/3 i 12/14 rekordów; wszystkie
miały tag watchlist. To zgodność inspekcji struktury, nie kwalifikacja źródła.
Surowych odpowiedzi nie dodano do repozytorium ani fixtures.

## Modele i przeglądy

| Zadanie | Requested / assigned | Wynik i pomiar |
| --- | --- | --- |
| Inwentaryzacja SDK i istniejących receipts | Preferowane `gpt-5.6-luna` / low niedostępne; fallback `gpt-6-luna` / low | Zakończona, 12:39:31–12:40:13 UTC; 0 napraw |
| Kontrakt i rozstrzygnięcie granic G1 | `gpt-6-astra` / high | Gotowy; §6 zaakceptowana, G1 BLOCKED; 12:39:41–około 12:48 UTC; 1 eskalacja blokady źródła |
| Niezależny przegląd planu przygotowania | `gpt-6-astra` / high | ACCEPT; inny agent niż autor; 112 s; 0 blokujących ustaleń |
| Implementacja czystego inspektora | `gpt-6-luna` / medium | 14 testów i typecheck PASS; 12:50:12–12:53:02 UTC; 1 wstępna runda napraw |
| Naprawa klasyfikacji dodatkowych accessorów tablicy | `gpt-6-sol` / medium | 15 testów i typecheck PASS; 59 s; 1 runda, późniejszy review wykrył regresję drugiego odczytu deskryptora |
| Naprawa drugiego odczytu deskryptora | `gpt-6-astra` / high | Regresja odtworzona przed poprawką; 16 testów i typecheck PASS po poprawce; 42 s; 1 runda |
| Niezależny przegląd implementacji | `gpt-6-astra` / high | 2 ustalenia P2 zamknięte; końcowe ACCEPT; odczyty 80 s + 31 s + 7 s, dokumentacja 12 s; inny agent niż reviewer planu i autorzy |
| Przygotowanie izolowanych checks | `gpt-6-luna` / low, fallback trasy mechanicznej | Środowisko gotowe; pierwsza próba instalacji offline nieudana, druga udana; osobny wiarygodny pomiar elapsed unavailable |
| Końcowe pełne checks i integracja raportu | Lead; identyfikator modelu/effort sesji unavailable | PASS, 13:01:46–13:04:53 UTC, około 187 s dla pięciu poleceń; fallback po odmowie wznowienia workera z powodu limitu wątków |

Powyższe identyfikatory opisują ustawienia dispatchu. Odrębna telemetria modelu
runtime i zużycie tokenów są unavailable; nie wyliczono oszczędności.
Sol wykonał naprawę po eskalacji; zakres nadal nie ma integracji z usługami
produkcyjnymi. W kodzie były trzy rundy napraw i dwie eskalacje L → S → A.
Niezależny końcowy reviewer nie pisał kodu ani kontraktu. Faktu, że tanie modele
zaczęły implementację, nie traktujemy jako dowodu oszczędności po uwzględnieniu
przeglądów i napraw.

## Walidacja i ograniczenia wydania

Walidacja używa eksportu śledzonej bazy Git z dodanymi wyłącznie plikami tego
pakietu. Zastane 25 lokalnych zmian pozostaje poza testowanym i publikowanym
zakresem. Prywatny baseline oraz receipts znajdują się pod
`/private/tmp/pp7-wsh-e1c`.

Przygotowano osobny PostgreSQL 15.12 na loopback, porcie 55479, z bazą
`ikbr_trader_wsh_test`. Docker daemon jest niedostępny; nie uruchamiano stosu
operacyjnego. GitHub CI używa PostgreSQL 16, więc wynik lokalny nie zastępuje CI.
Pierwsza instalacja zależności offline nie powiodła się; instalacja z zamrożonym
lockfile i preferencją cache zakończyła się powodzeniem bez pobierania pakietów.

Pierwszy pełny przebieg lint, typecheck, test, test:integration i build przeszedł,
ale reviewer wykrył błąd niepokryty wcześniejszymi testami. Po końcowej poprawce
i akceptacji kodu uruchomiono wszystkie pięć poleceń ponownie dla dokładnych
końcowych plików. Wszystkie zakończyły się kodem 0, a hashe źródeł pozostały
niezmienione. Końcowy zestaw testów inspektora ma 16 przypadków. Receipts i logi
są w `/private/tmp/pp7-wsh-e1c/checks.json`; wcześniejszy przebieg zachowano
oddzielnie. Lokalne odsyłacze i niezmienność 25 zastanych plików: PASS.
Czysty inspektor nie zmienia strategii, symulatora,
wdrożenia ani konfiguracji budowania; nie wymaga nowego backtestu lub obrazu Docker.

Push dwóch wcześniejszych commitów dokumentacji został ponownie odrzucony przez
automatyczny review pomimo potwierdzenia właściciela. Podany powód: brak zaufanej
zgody wystarczająco precyzyjnej dla docelowego repozytorium i całego zakresu
commitów. Nie zastosowano obejścia. Receipt:
`/private/tmp/pp7-model-routing-update/publication-approved.json`.
Publikacja i dokładne CI pozostają niepotwierdzone; praca lokalna nie oznacza wydania.
Lokalny commit obejmuje wyłącznie dwa pliki inspektora i dwa dokumenty tego
pakietu. Jego pełny SHA, końcowy zakres staging i status publikacji zapisuje
`/private/tmp/pp7-wsh-e1c/publication.json`; raport nie zakłada przyszłego wyniku CI.

## Następny warunek integracji produkcyjnej

Zamknięcie S1–S6 z kontraktu, konkretna reprezentacja kalendarza i niezależny
przegląd G1 poprzedzają adapter produkcyjny. Dopiero sprawdzony i wydany adapter
pozwala przejść do Gate A oraz nadzorowanej próby jednej akcji PKO. Przygotowanie
offline nie jest dowodem gotowości do tej próby ani domknięciem PP7.
