# mortgage-refinancing-scan

Standalone skill do powtarzalnego badania ofert refinansowania kredytów
mieszkaniowych/hipotecznych w bankach spółdzielczych. Ten README opisuje architekturę
badania i granice odpowiedzialności etapów. Ścisłe kontrakty artefaktów, lifecycle'u,
schema i publikacji pozostają w
[`docs/bank-market-scan-core-reboot-plan.md`](./docs/bank-market-scan-core-reboot-plan.md)
oraz w `schemas/`.

## Cel badania

Dla każdego banku szukamy jednej konkretnej oferty i wariantu, które na oficjalnej
podstronie potwierdzają:

1. kredyt mieszkaniowy, hipoteczny albo równoważny kredyt na cele mieszkaniowe;
2. spłatę lub refinansowanie istniejącego kredytu mieszkaniowego/hipotecznego;
3. oprocentowanie stałe — okresowo albo bezterminowo.

Parametry oferty są pobierane z tej samej podstrony, o ile są tam dostępne. Do dalszego
porównania potrzebujemy **RRSO albo stałej stopy nominalnej** — RRSO nie jest obowiązkowe,
jeżeli strona podaje porównywalne oprocentowanie nominalne. Nie wolno jednak dopisywać
żadnej wartości, której nie ma w źródle.

## Docelowy przepływ badania

### 1. Zakres banków

Runner pracuje na immutable registry snapshot. Banki mogą być pobierane i przetwarzane
partiami, ale każdy run ma exact scope zapisany w manifeście.

### 2. Discovery podstron

Dla każdego banku discovery zbiera oficjalne podstrony z homepage, sitemap i dozwolonych
linków wewnętrznych. URL-e są canonicalizowane i deduplikowane.

### 3. Normalizacja URL-i

Każdy URL przechodzi tę samą deterministyczną ścieżkę normalizacji co tekst:

- tokenizacja segmentów ścieżki, parametrów istotnych dla strony i slugów;
- normalizacja znaków, separatorów i wielkości liter;
- lematyzacja Morfeuszem 2;
- zapis tokenów, lematów i wersji normalizacji w artefakcie.

URL nie jest evidence. Służy wyłącznie do filtrowania i priorytetyzacji kandydata.

### 4. Wstępne filtrowanie i ranking URL-i

Na znormalizowanych lematyzowanych tokenach działają dwa słowniki:

- **negatywny** — odrzuca ewidentny szum, np. `kontakt`, `rodo`, `regulamin`,
  `kariera`, `lokata`, `konto`, `karta`, `gotówka`, `leasing`;
- **pozytywny** — podnosi URL-e zawierające sygnały typu `mieszkaniowy`,
  `hipoteczny`, `refinansowanie`, `spłata`, `oprocentowanie`, `stałe`, `rrso`.

Reguły negatywne muszą być ostrożne: twarde odrzucenie jest zarezerwowane dla ewidentnych
stron użytkowych lub produktów spoza zakresu. W pozostałych przypadkach termin negatywny
obniża ranking, ale nie niszczy recall. Liczba i jakość pozytywnych sygnałów wpływa na
kolejność URL-i, nie na decyzję biznesową.

Każdy kandydat otrzymuje wyjaśnialny score i powody odrzucenia/premii. Discovery może
zakończyć się wcześniej po pełnym dowodzie na stronie, ale przy braku dowodu musi zachować
listę pozostałych kandydatów do Review.

### 5. Analiza podstrony oferty

Po rankingu pobierane są najlepsze URL-e. Treść HTML/PDF jest zapisywana jako
`SourceArtifact`, a następnie przechodzi ekstrakcję tekstu, normalizację, lematyzację i
budowę source-bound evidence.

Na jednej canonicalnej podstronie oceniamy najpierw, czy faktycznie jest to szukana
oferta, a dopiero potem wyciągamy pola:

- `qualification.housing`;
- `qualification.refinancing`;
- `qualification.fixed_rate`;
- `offer.rrso` — jeżeli występuje;
- `offer.fixed_nominal_rate` — jeżeli występuje, także pod innym typowym opisem
  oprocentowania nominalnego;
- `offer.commission`, `offer.fixed_rate_period_years` i inne pola MVP, gdy mają
  source-bound potwierdzenie.

RRSO i stopa nominalna są alternatywnymi podstawami porównania. Nie wolno traktować braku
RRSO jako braku oferty, jeżeli istnieje porównywalna stała stopa nominalna. Nie wolno też
porównywać RRSO ze stopą nominalną.

### 6. Kandydaci słabsi i brak pełnego sygnału

Jeżeli jedna podstrona ma wszystkie wymagane kryteria i dane porównawcze, przechodzi do
interpretacji. Jeżeli znaleziono tylko kilka słabszych stron, zapisujemy je jako
uporządkowaną listę do Review wraz z powodami i evidence.

Nie wolno kwalifikować oferty przez sumowanie przypadkowych słów z różnych produktów. Brak
pełnego dowodu daje `unconfirmed`, a nie `qualified` ani
`explicitly_not_qualified`.

## Granica LLM

Podstawowa ścieżka powinna być deterministyczna:

- tokenizacja, lematyzacja, słowniki URL-i i ranking;
- parser typowych zapisów RRSO, stopy nominalnej, prowizji i okresu stałej stopy;
- walidacja excerptów, locatorów i hashy;
- końcowa decyzja i ranking ofert.

LLM może być później użyty jako **ograniczony fallback** dla wysoko ocenionych podstron,
gdy struktura HTML/PDF albo opis tabeli jest semantycznie trudny dla parsera. Nie
powinien:

- odkrywać banków ani URL-i;
- zastępować rankingu URL-i;
- łączyć niezależnych podstron;
- dopisywać brakujących wartości;
- podejmować końcowej decyzji biznesowej.

Wynik LLM musiałby być strict JSON-em zawierającym pola, confidence oraz dokładne
excerpt/offsety ze źródła. Każdy excerpt byłby ponownie sprawdzany deterministycznie wobec
bieżącego `SourceArtifact`; nieweryfikowalna odpowiedź staje się `unconfirmed`/Review.
Integracja LLM nie jest jeszcze częścią bieżącego kontraktu MVP.

## Znaczenie `ProductBundle`

`ProductBundle` reprezentuje jedną canonicalną ofertę:

```text
jedna canonicalna podstrona produktu
+ ewentualnie jawnie powiązany oficjalny PDF/taryfa
```

Nie jest to zbiór wszystkich stron banku, na których wystąpiły podobne słowa. Keyword-only
matching nie może tworzyć wspólnego bundle. HTML i PDF mogą być powiązane tylko wtedy, gdy
relacja wynika jawnie z linku, canonical URL albo innej zwalidowanej tożsamości produktu.

## Inwarianty runtime

- registry snapshot i manifest określają exact scope;
- `live:true` pobiera bieżące oficjalne źródła, `live:false` jest offline;
- evidence zawsze wskazuje bieżący artefakt, hash, URL i locator;
- interpreter otrzymuje wyłącznie zwalidowane evidence;
- `qualified` wymaga trzech kryteriów dla tego samego produktu/wariantu;
- `export_ready` wymaga danych stopy stałej oraz RRSO albo stopy nominalnej;
- brak dowodu nie jest negatywną decyzją;
- publikacja następuje wyłącznie przez `finalize`, a błędny run przez `abort`;
- runtime nie korzysta z legacy decision state.

## Znane luki do zamknięcia

Ostatni live run ujawnił trzy rozbieżności między zamysłem a implementacją:

1. ranking URL-i używa zbyt ubogich sygnałów i przepuszcza dużo stron pobocznych;
2. live evidence matcher rozpoznaje kryteria kwalifikacji, ale nie buduje jeszcze
   `offer.*` dla RRSO/stopy nominalnej/prowizji;
3. ogólny komunikat o wielu bundle’ach ukrywa, czy problemem był szum URL-i, brak
   parametrów oferty czy rzeczywiste rozdzielenie produktów.

Priorytetem jest najpierw doprowadzenie URL filtering/ranking i ekstrakcji
`offer.*` do powyższego kontraktu. Dopiero później należy oceniać, czy potrzebny jest
fallback LLM albo dodatkowe powiązanie HTML–PDF.

## Powiązane kontrakty

- [`SKILL.md`](./SKILL.md) — operacyjny kontrakt skilla;
- [`schemas/`](./schemas/) — strict JSON Schema;
- [`docs/adaptation-plan.md`](./docs/adaptation-plan.md) — plan dostosowania
  obecnej implementacji do architektury page-first;
- [`docs/parallel-pilot-repeatable-verification.md`](./docs/parallel-pilot-repeatable-verification.md)
  — runbook powtarzalnej weryfikacji eksperymentalnego pilota Parallel
  Search → Extract → Luna z jednorundowym follow-upem;
- [`tools/runner.mjs`](./tools/runner.mjs) — controlled runner;
- [`.opencode/agents/mortgage-refinancing-scan-runner.md`](../../../.opencode/agents/mortgage-refinancing-scan-runner.md)
  — ograniczenia agenta wykonawczego;
- [`docs/bank-market-scan-core-reboot-plan.md`](./docs/bank-market-scan-core-reboot-plan.md)
  — normatywny plan kontraktów i lifecycle.

Procedury QA, audytu, eksportu i commitów pozostają w odpowiednich skillach; ten README
opisuje architekturę, a nie zastępuje ich instrukcji operacyjnych.
