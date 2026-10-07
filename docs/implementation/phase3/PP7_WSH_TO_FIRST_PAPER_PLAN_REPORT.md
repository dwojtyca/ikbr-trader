# Dostarczenie planu WSH → preflight → pierwsza próba PKO

Data: 2026-10-07. Status: plan i gotowa dokumentacja zaakceptowane;
walidacja lokalna zakończona. Wynik publikacji/CI jest rejestrowany osobno,
jak opisano poniżej.

## Zakres i rezultat

Na prośbę właściciela przygotowano
[czteropunktowy plan](PP7_WSH_TO_FIRST_PAPER_PLAN.md) rozwijający istniejący
[plan domknięcia PP7](PP7_CLOSURE_PLAN.md). Zmieniono wyłącznie te trzy dokumenty:
nowy plan, ten raport i odsyłacz w planie nadrzędnym.

Plan definiuje G1 — konkretny kontrakt WSH, G2 — sprawdzony i wydany adapter,
G3 — wdrożenie z wyłączonym handlem i aktualny preflight oraz G4 — dowód
normalnego wejścia/ochrony/wyjścia jednej akcji PKO. Pierwszy round trip nie
zastępuje dalszej akceptacji AAPL, pięciu sesji i recovery z nadrzędnego PP7.

Rozróżniono datę wydarzenia, publikację i pierwszą obserwację. Ewentualny model
kalendarza prospektywnego jest wyłącznie kandydatem wymagającym konkretnego
kontraktu i review w G1; dokument nie zmienia aktualnej eligibility. Jawne
bramki obejmują kompletność, niepotwierdzone terminy, kwalifikację F1, koszty,
uprawnienia do alertów i aktywacji oraz zachowanie close przy pauzie wejść.

## Źródła i ograniczenia

Stan repozytorium oparto na `b4bcc371cc2c3b9053ce7bc31ce4b2586effda4e`,
AGENTS.md, roadmapie, PP7 closure i aktualnych runbookach źródeł/akceptacji.
Wykorzystano wcześniejsze prywatne receipts diagnostyki 2026-10-07. W tym zadaniu
nie wykonano nowych połączeń do TWS, płatnych provider calls, zapisów DB,
powiadomień, zmian `.env`, subskrypcji lub zleceń. Odczytano publiczną
dokumentację IBKR i cennik Marketaux. Surowych payloadów i sekretów nie dodano do Git.

Operacyjne Gate A/B pozostają niezaliczone. Aktywny dostęp WSH, pozytywna próba
syntetyczna AI i dwa zgodne odczyty newsów nie dowodzą gotowości do handlu.
Wcześniejszy limit 20 odczytów Marketaux jest wyczerpany. Zgoda na kolejne
operacyjne koszty, alerty lub Paper musi obejmować konkretny zakres; istniejącej
adekwatnej zgody nie należy żądać ponownie.

## Przeglądy i modele

| Zadanie | Requested / actual model i effort | Wynik | Naprawy / eskalacje | Czas / tokeny |
| --- | --- | --- | --- | --- |
| Opracowanie i integracja planu | Lead zgodnie z trasą krytyczną; identyfikator modelu/effort sesji nieudostępniony | Plan i dokumentacja zaakceptowane | 0 napraw / 0 eskalacji | Rejestrowanie 12:01:39–12:13 UTC; tokeny unavailable |
| Niezależny przegląd planu | Requested/assigned `gpt-6-astra` / high; odrębna telemetria runtime unavailable | ACCEPT, bez ustaleń blokujących | 0 napraw / 0 eskalacji | 12:07:48–12:08:46 UTC, 58 s; tokeny unavailable |
| Niezależny przegląd dokumentacji | Requested/assigned `gpt-6-astra` / high; odrębna telemetria runtime unavailable | ACCEPT, bez ustaleń blokujących | 0 napraw / 0 eskalacji | Zarejestrowane 12:10:46–12:11:42 UTC, 56 s; wstępny odczyt przed pomiarem; tokeny unavailable |
| Mechaniczne sprawdzenie i publikacja | Preferowane `gpt-5.6-luna` / low niedostępne w aktywnym katalogu; dozwolony assigned fallback `gpt-6-luna` / low | Wynik w receipt publikacji | Liczniki w receipt; brak zmiany semantyki | Czas w receipt; tokeny unavailable, jeżeli nieudostępnione |

Reviewerzy planu i gotowej dokumentacji są różnymi agentami, bez autorstwa zmian.
Aktualne zadanie nie ustanawia wyjątków od pełnego review i testów przyszłego kodu.

## Walidacja i publikacja

- Lokalne odsyłacze: PASS; fakty i zakres potwierdzili obaj niezależni reviewerzy.
  Kontrola wzorców sekretów oraz gotowej dokumentacji: PASS. Oba przeglądy
  bez ustaleń blokujących; aktualizacja statusów zgodnie z wynikami nie zmienia planu.
- `git diff --check` oraz porównanie hashy 25 zastanych dirty files: PASS.
  Baseline zachowano prywatnie przed edycją; staging będzie sprawdzony przed commitem.
- Nie uruchamiano lokalnych lint/typecheck/test/build wyłącznie dla dokumentacji,
  zgodnie z AGENTS.md. Przyszły adapter nadal wymaga pełnych checks z G2.
- Commit/push na `main` i dokładne GitHub CI to ostatnia bramka publikacji.
  Nie uznawać jej za zakończoną bez pozytywnego wyniku. Końcowy SHA, komendy,
  kody wyjścia, link/wynik CI oraz pomiary workera są rejestrowane w prywatnym
  `/private/tmp/pp7-next-four-plan/publication.json` i wyniku zadania.
  Raport nie zawiera własnego przyszłego hasha ani z góry założonego wyniku CI.
