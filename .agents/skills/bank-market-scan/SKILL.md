---
name: bank-market-scan
description: "Cykliczne badanie ofert banków spółdzielczych i SKOK-ów w Polsce pod kątem refinansowania/spłaty wcześniejszego kredytu mieszkaniowego z okresowo stałym oprocentowaniem; źródłem prawdy są JSON/JSONL, XLSX jest eksportem."
---

# Cel

Przygotuj i aktualizuj powtarzalny raport rynkowy dla banków spółdzielczych i SKOK-ów w Polsce. Raport ma wskazywać, czy dana instytucja oferuje kredyt mieszkaniowy/hipoteczny, który można wykorzystać do spłaty/refinansowania wcześniejszego albo innego kredytu mieszkaniowego/hipotecznego oraz który ma wariant okresowo stałego oprocentowania.

# Architektura danych

Źródłem prawdy dla agenta są pliki w repozytoryjnym katalogu `/data`:

- `/data/base/institutions.current.json` — aktualna lista instytucji.
- `/data/work/analysis-state.json` — aktualne ustalenia dla instytucji.
- `/data/work/evidence.jsonl` — fragmenty i URL-e źródeł użyte jako dowody.
- `/data/work/automation-state.json` — stan operacyjny kolejki automatu, retry i etapów przygotowania.

Arkusz XLSX jest wyłącznie eksportem dla użytkownika. Nie edytuj XLSX ręcznie jako źródła prawdy. Generuj go przez `tools/export-workbook.mjs`.

Katalog skilla ma zawierać wyłącznie kod, manifest i schematy. Wszystkie pliki robocze, cache, eksporty i stan analizy zapisuj do `/data` w katalogu głównym projektu, a nie obok skilla.

# Lista bazowa instytucji

Jeżeli `/data/base/institutions.current.json` nie istnieje, utwórz ją automatycznie:

```bash
node tools/build-institution-list.mjs --cross-check-knf
```

Główne źródło listy: BFG, strona „Podmioty objęte gwarancjami”, sekcje „Banki spółdzielcze” i „SKOK-i”. KNF służy jako źródło kontrolne dla banków spółdzielczych. List BPS/SGB nie używaj jako źródła kompletności, chyba że użytkownik poprosi o kolumnę zrzeszenia.

# Kryterium kwalifikacji TAK

Wpisz `qualifies: true` tylko wtedy, gdy łącznie potwierdzisz z publicznych źródeł instytucji:

1. Produkt jest kredytem mieszkaniowym, hipotecznym, mieszkaniowo-hipotecznym albo równoważnym kredytem zabezpieczonym hipotecznie na cele mieszkaniowe.
2. Produkt może służyć spłacie/refinansowaniu wcześniejszego albo innego kredytu mieszkaniowego/hipotecznego.
3. Produkt ma wariant okresowo stałego oprocentowania.

Nie wymagaj literalnej frazy „z innego banku”. Wystarczy jednoznaczne sformułowanie typu „spłata innego kredytu mieszkaniowego”, „spłata wcześniejszego kredytu mieszkaniowego”, „refinansowanie obecnego kredytu hipotecznego” albo „przeniesienie kredytu hipotecznego”, o ile kontekst wskazuje kredyt mieszkaniowy/hipoteczny.

Dla `qualifies: true` wpisz w `qualification.reason_codes` co najmniej:

```json
[
  "housing_or_mortgage_loan_confirmed",
  "refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed",
  "periodically_fixed_rate_confirmed"
]
```

Dla `qualifies: false` wpisz `qualification.non_qualification_reason_codes`, np.:

- `no_housing_or_mortgage_loan_confirmed`
- `no_refinance_or_repayment_confirmed`
- `no_periodically_fixed_rate_confirmed`
- `only_variable_rate_found`
- `only_refinancing_of_own_costs_found`
- `website_unavailable`
- `ambiguous_sources`

# Czego nie kwalifikować jako TAK

Nie kwalifikuj jako TAK:

- samego „refinansowania kosztów poniesionych na cele mieszkaniowe”, jeżeli chodzi o zwrot własnych wydatków, a nie spłatę kredytu;
- pożyczki hipotecznej na dowolny cel, jeżeli nie jest jasno połączona ze spłatą wcześniejszego kredytu mieszkaniowego/hipotecznego;
- kredytu konsolidacyjnego hipotecznego, jeżeli nie wynika, że obejmuje spłatę kredytu mieszkaniowego/hipotecznego;
- oferty wyłącznie ze zmiennym oprocentowaniem;
- strony informującej tylko o możliwości zmiany oprocentowania już posiadanego kredytu, jeśli nie ma oferty nowego kredytu refinansującego/spłacającego;
- oferty, w której okresowo stała stopa dotyczy innego produktu niż produkt ze spłatą/refinansowaniem kredytu mieszkaniowego.

Jeżeli brakuje jednoznacznego potwierdzenia któregokolwiek z trzech warunków, wpisz `qualifies: false` albo zostaw `qualifies: null`, jeśli strona/dokumenty są niedostępne. Wyjaśnij decyzję w `status_text`, `research_notes` i kodach powodów.

# Najważniejsza zasada dotycząca oprocentowania

Nie zapisuj żadnych danych dotyczących okresu po zakończeniu okresowo stałej stopy. Dotyczy to zwłaszcza późniejszego WIBOR-u, późniejszej marży i późniejszego oprocentowania zmiennego.

Wypełniaj wyłącznie parametry dotyczące okresu stałego:

- okres stałej stopy;
- nominalne oprocentowanie okresowo stałe;
- RRSO dla wariantu okresowo stałego;
- prowizję dla tej oferty;
- warunki dodatkowe dla tej oferty.

Jeżeli bank podaje RRSO, oprocentowanie, WIBOR albo marżę tylko dla wariantu zmiennego lub okresu po stałej stopie, nie przepisuj tych danych do pól liczbowych. Wpisz krótką uwagę, że publicznie znalezione dane dotyczą innego wariantu.

# Dane liczbowe, zakresy i statusy pól

Procenty w JSON zapisuj jako liczby dziesiętne, np. `0.063` dla 6,3%.

Jeżeli źródło podaje pojedynczą wartość, wpisz ją jako `*_exact`. Dla kompatybilności wstecz można również wpisać stare pole, np. `offer.fixed_nominal_rate`, ale preferowane są pola jawne:

- `offer.fixed_nominal_rate_exact`
- `offer.fixed_nominal_rate_min`
- `offer.fixed_nominal_rate_max`
- `offer.commission_exact`
- `offer.commission_min`
- `offer.commission_max`
- `offer.rrso_exact`
- `offer.rrso_min`
- `offer.rrso_max`

Jeżeli źródło podaje zakres, nie uśredniaj go. Wpisz `*_min` i `*_max`, a warunki zakresu opisz w `*_description`.

Jeżeli strona zawiera kilka wariantów tej samej oferty, nie łącz ich wartości w jeden zakres. Dla celu porównania wybierz jako główny wariant promocyjny, jeżeli jest aktualny, jawnie opisany i spełnienie jego warunków jest możliwe do zweryfikowania. Ustaw `promotion.is_promotional: true`, zapisz warunki promocji w JSON/notatce i zachowaj wariant standardowy wyłącznie jako alternatywę w evidence/notatce. Jeżeli promocja jest niedostępna, nieaktualna albo jej warunki są niejasne, wybierz wariant standardowy.

Dla istotnych pól możesz doprecyzować status w `field_status`:

- `found`
- `not_found`
- `ambiguous`
- `not_applicable`
- `not_checked`

W XLSX puste pole oznacza brak jednoznacznej informacji dla kwalifikującego wariantu; w JSON preferuj doprecyzowanie przez `field_status`.

# Dowody per pole

Dla każdej krytycznej liczby i każdego z trzech kryteriów kwalifikacji zapisuj dowody w `field_evidence`.

Minimalnie dla `qualifies: true` zapisz dowody dla:

- `qualification.housing_or_mortgage_loan_confirmed`
- `qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed`
- `qualification.periodically_fixed_rate_confirmed`

Dla danych liczbowych zapisuj dowody np. dla:

- `offer.fixed_nominal_rate`
- `offer.rrso`
- `offer.commission`
- `offer.max_loan_term_years`
- `offer.fixed_rate_period_years`

Dowód powinien zawierać `evidence_id`, jeśli pochodzi z `grep-evidence.mjs`, albo co najmniej URL, typ źródła, krótki fragment i `confidence`.

# Zakres danych pierwszego przebiegu

Pierwszy przebieg zbiera wyłącznie dane potrzebne do odpowiedzi na pytanie, czy oferta kwalifikuje się do badania oraz do podstawowego porównania ofert:

- identyfikacja instytucji i URL produktu;
- trzy kryteria kwalifikacji;
- nazwa produktu;
- maksymalny okres kredytowania;
- okres okresowo stałej stopy;
- oprocentowanie okresowo stałe `min/max`;
- prowizja `min/max`;
- RRSO `min/max`;
- flaga oferty promocyjnej.

Nie przetwarzaj w pierwszym przebiegu jako osobnych pól:

- WIBOR-u i marży;
- wymogu konta, wpływów, kart i bankowości internetowej;
- ubezpieczeń i zabezpieczeń;
- dokumentów dochodowych i formalnych;
- ograniczeń dla grup zawodowych;
- dat i opisów promocji jako osobnych kolumn eksportu; warunki promocji potrzebne do interpretacji głównego wariantu zachowaj w JSON/notatce;
- opisowych duplikatów okresu, prowizji, oprocentowania, RRSO i terminu.

Pełny HTML/PDF pozostaje w cache i może być czytany przez agenta. Powyższe ograniczenie dotyczy zakresu pól decyzyjnych i eksportu, nie prawa agenta do przeczytania istotnego kontekstu źródła.

# Workflow Agenta

Ta sekcja jest kontraktem operacyjnym. Agent ma wykonywać pracę według tej kolejności i tych reguł przejścia.

## Wejście

Wejściem dla agenta jest jedno z poleceń użytkownika:

- pełny przebieg od zera,
- kolejny przebieg `changed-only`,
- domknięcie kolejki już przygotowanej,
- analiza wyjątków.

Minimalny zestaw plików wejściowych:

- `/data/base/institutions.current.json`
- `/data/work/analysis-state.json`
- `/data/work/evidence.jsonl`
- `/data/work/automation-state.json`

Jeżeli któregoś z tych plików nie ma, agent najpierw uruchamia:

```bash
node tools/init-project.mjs
```

## Cel operacyjny

Agent ma sam prowadzić proces, a nie wymagać od użytkownika sterowania pojedynczymi LP.

Wyjątek:

- jeśli użytkownik explicite zleci pracę na jednym LP albo małej, wskazanej grupie, agent może zejść do poziomu pojedynczych `prepare-review-pack` i `row-update`.

W standardowym trybie agent pracuje wsadowo.

## Reguła wyboru przebiegu

Nie utrzymuj dwóch osobnych procedur operacyjnych typu `full run` i `changed-only`. Utrzymuj jeden workflow i wybieraj tylko sposób wejścia do Etapu 2.

Użyj pełnego przebiegu, gdy:

- użytkownik mówi wprost, że chce start od zera, pełny przebieg albo czysty restart,
- stan projektu został właśnie zainicjalizowany,
- brakuje wcześniejszego sensownego stanu roboczego.

Użyj przebiegu `changed-only`, gdy:

- użytkownik mówi o odświeżeniu, kolejnym przebiegu albo sprawdzeniu tylko zmian,
- istnieje wcześniejszy stan projektu,
- celem jest ponowna kontrola tylko tych instytucji, których źródła się zmieniły.

Domyślna reguła:

- świeży projekt albo brak stanu roboczego -> pełny przebieg,
- istniejący projekt i kolejna iteracja -> `changed-only`.

Różnica między tymi ścieżkami dotyczy tylko sposobu wejścia do Etapu 2; reszta workflow pozostaje taka sama.

Jeżeli użytkownik żąda startu „na czysto”, nie czyść plików ręcznie. Użyj:

```bash
node tools/reset-batch.mjs --from 1 --limit 5 --clear-cache --clear-analysis
node tools/prepare-batch.mjs --from 1 --limit 5 --refresh --fresh
```

`--fresh` oznacza brak użycia poprzednich kandydatów i monitorowanych URL-i.
Reset stanu analizy i reset źródeł są osobnymi operacjami, dlatego przy pełnym
restarcie podaj jawnie oba przełączniki resetu.

W trybie przyrostowym nie uruchamiaj ręcznie discovery dla każdego LP i nie
wybieraj banków między fazami. Jedno polecenie uruchamia automatyczny cykl:

```bash
node tools/prepare-batch.mjs --mode changed-only --refresh --limit 25
```

`--changed-only` bez `--mode changed-only` pozostaje kompatybilnym aliasem.
Najpierw wykonywana jest Faza A dla wszystkich instytucji z `website_url`, a
`--limit` działa dopiero w Fazie B na zmienionych ofertach. Jest to jedyny tryb,
w którym odświeżenie całego baseline'u jest zamierzone.

## Etap 1: Rozpoznanie stanu

Agent zawsze zaczyna od:

```bash
node tools/progress-report.mjs
node tools/queue-report.mjs
```

Cel:

- ustalić, ile rekordów jest już zamkniętych,
- ile jest w `pending_prepare`,
- ile w `prepared`,
- ile w `ready_for_review`,
- ile w `retry_pending`,
- ile w `escalated`,
- ile w `needs_user_review`,
- czy istnieją błędy techniczne.

Na podstawie tego agent wybiera następny etap.

## Etap 2: Przygotowanie wsadowe

W pełnym przebiegu, jeżeli są rekordy `pending_prepare`, agent uruchamia:

```bash
node tools/prepare-batch.mjs --limit 25 --refresh
```

Jeżeli pełny przebieg ma dotyczyć zakresu LP, zakres ogranicza również
discovery, a nie tylko późniejsze przygotowanie:

```bash
node tools/prepare-batch.mjs --from 1 --limit 5 --refresh
```

W kolejnym przebiegu agent używa jednego automatycznego cyklu:

```bash
node tools/prepare-batch.mjs --mode changed-only --refresh --limit 25
```

### Faza A: odświeżenie źródeł

Faza A:

- obejmuje wszystkie instytucje z `website_url`, niezależnie od `review_status`
  i `queue_stage`;
- nie uruchamia `extract-text`, `grep-evidence` ani `prepare-review-pack`;
- nie jest ograniczana przez `--limit`;
- zapisuje `/data/work/source-refresh-runs/<run_id>.json`;
- zapisuje w `candidates.json` `source_refresh_run_id`,
  `sources_refreshed_at`, `monitored_urls`, hashe oraz sygnały zmiany.
- zapisuje `run_id` i w zwykłym przebiegu nie może zapisywać źródeł poza
  wybranym zakresem.

Jeżeli choć jedna instytucja zakończy się błędem, manifest ma status `partial`
i Faza B nie rozpoczyna analizy na częściowym snapshotcie.

### Faza B: pełne przygotowanie zmian

Po kompletnym zakończeniu Fazy A agent przygotowuje wyłącznie instytucje z
`offer_changed_since_last_fetch: true`. W tej fazie `--limit` ogranicza liczbę
pełnych preprocessów. Rekordy bez zmiany otrzymują `unchanged_sources` i nie
przechodzą ponownie przez ekstrakcję ani evidence.

`discovery_changed_since_last_fetch` i `search_results_sha256` są sygnałami
diagnostycznymi. Bramką do pełnego preprocessingu jest wyłącznie
`offer_changed_since_last_fetch`, wyliczany z `material_sha256`, nowych lub
niedostępnych URL-i oraz odpowiedzi warunkowych `304`.

Wejście pełnego przebiegu:

- rekordy w `pending_prepare`
- opcjonalnie rekordy wskazane przez użytkownika przez zakres LP

Wejście przebiegu `changed-only`:

- bieżący `/data/base/institutions.current.json`;
- istniejący cache źródeł albo automatycznie tworzony baseline;
- kompletna Faza A tego samego cyklu.

Każdy `cache_file` jest przypisany do pełnego znormalizowanego URL-a. Przed
ekstrakcją trzeba potwierdzić hash i rozmiar pliku oraz brak kolizji ścieżki.
`www`, końcowy `/` i `/index.html` są równoważnymi postaciami URL-a. Canonical
przekierowany do `/404.html` albo innego niepowiązanego zasobu jest błędem tylko
dla źródła krytycznego; błąd na pobocznej stronie crawl-u jest ostrzeżeniem i
nie blokuje całego banku. Kolizja cache albo niezgodność hashy pozostają błędami
technicznymi.

Heurystyka słów kluczowych służy do rankingu i nawigacji, nie do odrzucania
oferty. Brak literalnego trafienia refinansowania nie blokuje przygotowania,
jeżeli są czytelne źródła i co najmniej dwa niezależne sygnały produktu.

Wyjście tego etapu:

- `prepared` dla rekordów z wystarczającym materiałem,
- `retry_pending` dla rekordów z ryzykiem preprocessingu,
- `unchanged_sources` dla rekordów bez zmiany materiału w przebiegu `changed-only`,
- `error` dla problemów technicznych.

Agent nie podejmuje tu jeszcze decyzji merytorycznej o `qualifies`.

## Etap 3: Retry techniczne

Jeżeli są rekordy `retry_pending`, agent uruchamia:

```bash
node tools/retry-batch.mjs --limit 25 --refresh
```

Wejście tego etapu:

- rekordy `retry_pending`

Wyjście tego etapu:

- `prepared`, jeśli drugi przebieg dał wystarczający materiał,
- `escalated`, jeśli nadal brakuje minimalnych sygnałów jakości,
- `error`, jeśli wystąpił błąd techniczny.

Agent nadal nie podejmuje tu jeszcze decyzji merytorycznej o `qualifies`.

## Etap 4: Zebranie kolejki do oceny

Jeżeli są rekordy w stanach:

- `ready_for_review`
- `escalated`
- `needs_user_review`
- `error`

agent generuje zbiorczy manifest:

```bash
node tools/review-manifest.mjs --out /data/exports/review-queue.json --md-out /data/exports/review-queue.md
```

Wejście tego etapu:

- `automation-state.json`
- `review-packs`
- ewentualne istniejące `row-update`

Wyjście tego etapu:

- JSON i Markdown z listą rekordów do dalszej pracy,
- ścieżki do `review-pack`,
- ścieżki do `row-update`, jeśli już istnieją,
- `preprocessing_risk_flags`,
- `last_error`.

To jest podstawowy interfejs agenta do pracy seriami, a nie po jednym LP.

## Etap 5: Ocena merytoryczna przez agenta

To jest etap wykonywany przez model, nie przez sam skrypt.

### Wejście etapu

Agent bierze jako wejście:

- `review-manifest.json` albo wynik `review-manifest.mjs`,
- odpowiadające mu `review-pack`,
- lokalny `source-text.jsonl` wskazany w indeksie review-packa;
- pełne rekordy źródeł z indeksu, nie tylko snippety;
- lokalny cache instytucji tylko wtedy, gdy `source-text.jsonl` jest zbyt ubogi albo niespójny.

Review-pack jest uporządkowanym indeksem i nawigacją. Snippety nie są samodzielnym dowodem i nie mogą zastępować przeczytania pełnego źródła relevantnego dla decyzji.

Agent nie bierze naraz całej kolejki do merytorycznej oceny. Pracuje seriami.

### Wielkość serii

Domyślna seria oceny:

- `5` rekordów

Maksymalna seria oceny:

- `10` rekordów

Nie oceniaj merytorycznie serii większych niż `10`, chyba że użytkownik wyraźnie tego zażąda.

### Kolejność doboru rekordów

Priorytet kolejki:

1. `ready_for_review`
2. `escalated`
3. `needs_user_review`
4. `error` tylko wtedy, gdy problem nie jest już czysto techniczny albo błąd zniknął i rekord da się normalnie ocenić

W ramach tej samej grupy wybieraj rekordy rosnąco po `lp`.

### Algorytm dla pojedynczego rekordu

1. Otwórz wpis rekordu z manifestu.
2. Otwórz odpowiadający `review-pack`.
3. Odczytaj pełne rekordy źródeł wskazane w indeksie `source-text.jsonl`.
4. Oceń ofertę główną, FAQ, promocje, przykłady reprezentatywne i warianty oprocentowania na podstawie ich kontekstu.
5. Jeśli nadal brakuje danych:
   - sięgnij szerzej do cache tylko tej instytucji,
   - czytaj lokalne źródła tej instytucji,
   - nie rozszerzaj pracy na inne banki.
6. Przy każdej wartości liczbowej zapisz dokładny cytat i krótko wyjaśnij wybór, jeżeli w źródłach występują alternatywne wartości.
7. Ustal jedną z trzech sytuacji:
   - `qualifies: true`
   - `qualifies: false`
   - brak bezpiecznej decyzji

### Kiedy utworzyć `row-update`

Utwórz `row-update`, tylko gdy spełnione są wszystkie warunki:

- decyzja jest jednoznaczna,
- istnieją wystarczające dowody publiczne,
- nie ma konfliktu źródeł wymagającego politycznej interpretacji,
- da się wskazać konkretne `field_evidence`,
- da się wpisać poprawne `reason_codes` albo `non_qualification_reason_codes`.

### Kiedy NIE tworzyć `row-update`

Nie twórz finalnego `row-update`, gdy:

- źródła są sprzeczne,
- materiał jest zbyt ubogi,
- nie da się odróżnić produktu kwalifikującego od podobnego, ale niekwalifikującego,
- nie wiadomo, czy brak informacji oznacza realne `NIE`, czy tylko brak danych,
- istnieje wysokie ryzyko nadinterpretacji.

W takich przypadkach rekord ma pozostać wyjątkiem z krótkim opisem problemu.

### Reguła dla `qualifies: false` vs brak decyzji

Wpisz `qualifies: false`, gdy z publicznych źródeł wynika brak jednego z warunków kwalifikacji.

Nie wpisuj `qualifies: false`, gdy:

- źródła są zbyt ubogie,
- źródła są niedostępne,
- nie wiadomo, czy brak informacji oznacza brak oferty.

W takich przypadkach zostaw rekord w kolejce wyjątków zamiast sztucznie produkować `NIE`.

### Minimalna zawartość `row-update`

Każdy gotowy `row-update` ma zawierać co najmniej:

- `run_id` z bieżącego review-packa
- `lp`
- `institution_id`
- `review_status`
- `checked_at`
- `website_available`
- `qualifies`
- `status_text`
- `qualification`
- `field_evidence`
- `decision_audit` dla decyzji `qualifies: true`
- `research_notes`
- `basis`

Informacje o odrzuconych alternatywnych wartościach zapisuj tylko w `field_evidence.notes` albo `research_notes`, gdy rzeczywiście wystąpiły. Nie twórz osobnych kolumn XLSX dla roboczego uzasadnienia.

Dla `qualifies: true` obowiązkowo:

- trzy potwierdzenia kwalifikacji,
- `qualification.reason_codes`,
- `field_evidence` dla trzech kryteriów kwalifikacji.
- `decision_audit.product_scope` z nazwą analizowanego produktu;
- `decision_audit.same_product_variant_confirmed: true`;
- `decision_audit.criterion_evidence_urls` z URL-ami dowodów dla `housing`, `refinancing` i `fixed_rate`.

Dla `qualifies: false` obowiązkowo:

- `qualification.non_qualification_reason_codes`,
- krótki powód w `status_text` albo `research_notes`.

### Twarde reguły jakości dla agenta

Przed zapisaniem `row-update` agent musi sprawdzić:

1. czy nie wpisał danych z okresu po zakończeniu stałej stopy,
2. czy `TAK` ma komplet trzech warunków kwalifikacji,
3. czy `NIE` ma `non_qualification_reason_codes`,
4. czy najważniejsze pola mają `field_evidence`,
5. czy nie dopisał danych, których nie ma w źródłach.
6. czy wszystkie trzy kryteria i liczby dotyczą tego samego produktu oraz wariantu;
7. czy źródła oznaczone `excluded_context` nie są podstawą decyzji.

### Wynik etapu

Wynikiem Etapu 5 ma być seria plików:

- `/data/work/row-updates/lp-XXX.json`

dla rekordów jednoznacznych oraz lista wyjątków dla rekordów niejednoznacznych.

## Etap 6: Zastosowanie gotowych decyzji

Po przygotowaniu `row-update` agent uruchamia:

```bash
node tools/review-batch.mjs --limit 25 --require-field-evidence
```

Wejście tego etapu:

- rekordy `prepared` albo `ready_for_review`,
- gotowe pliki `row-update`

Wyjście tego etapu:

- `checked`, jeśli `row-update` przeszedł walidację i został zapisany,
- `ready_for_review`, jeśli nie ma jeszcze `row-update`,
- `needs_user_review`, jeśli `row-update` istnieje, ale walidacja uznała go za zbyt ryzykowny do automatycznego zapisu,
- `error`, jeśli wystąpił błąd techniczny.

To oznacza:

- skrypt nie podejmuje decyzji merytorycznej,
- skrypt tylko aplikuje i waliduje decyzję już przygotowaną przez agenta.

## Etap 7: Kontrola jakości i eksport

Po każdej większej serii agent uruchamia:

```bash
node tools/validate-state.mjs --require-field-evidence
node tools/audit-report.mjs --require-field-evidence --out /data/exports/review-report.md
node tools/export-workbook.mjs --out /data/exports/rynek-bs-skok.xlsx
```

Agent może użyć:

```bash
node tools/validate-state.mjs --strict --require-field-evidence
```

gdy chce sprawdzić, czy nowe rekordy nie generują ostrzeżeń blokujących.

## Reguły eskalacji

Agent wraca do użytkownika tylko wtedy, gdy wystąpi jeden z warunków:

1. rekord pozostaje `escalated` po retry i nie ma bezpiecznej podstawy do decyzji,
2. rekord jest `needs_user_review`, bo przygotowany `row-update` nie przeszedł walidacji albo jest wewnętrznie niespójny,
3. źródła są sprzeczne i trzeba przyjąć politykę klasyfikacji,
4. wystąpił trwały błąd techniczny (`error`) blokujący dalszy postęp.

Agent nie powinien angażować użytkownika tylko dlatego, że rekord wymaga dodatkowego czytania. Najpierw ma sam wykonać retry i próbę oceny.

## Oczekiwane wyjście dla użytkownika

Standardowe wyjście dla użytkownika nie jest technicznym raportem kolejki, tylko krótkim podsumowaniem pracy.

Po serii agent ma oddać:

- ile rekordów przygotowano,
- ile rekordów zamknięto jako `checked`,
- ile jest `TAK`,
- ile jest `NIE`,
- ile zostało w wyjątkach,
- gdzie jest aktualny XLSX,
- krótką listę wyjątków z 1-zdaniową przyczyną.

Domyślny zestaw artefaktów końcowych:

- `/data/exports/rynek-bs-skok.xlsx`
- `/data/exports/review-report.md`
- opcjonalnie `/data/exports/review-queue.json`
- opcjonalnie `/data/exports/review-queue.md`

Agent nie powinien oczekiwać, że użytkownik będzie ręcznie czytał `review-report.md` ani pojedyncze `review-pack`. To są artefakty robocze dla procesu, nie główny interfejs użytkownika.

# Tryb changed-only przy kolejnym badaniu

Podstawowym wejściem jest jeden automatyczny cykl:

```bash
node tools/prepare-batch.mjs --mode changed-only --refresh --limit 25
```

Nie uruchamiaj ręcznie `discover-sources` dla każdego banku. Faza A odświeża
cały baseline, używa warunkowych fetchy, porównuje `content_sha256` i
`material_sha256`, a Faza B uruchamia pełny preprocessing wyłącznie dla
`offer_changed_since_last_fetch: true`.

Opcjonalnie, po kompletnym cyklu, kolejkę zmienionych ofert można podejrzeć:

```bash
node tools/next-batch.mjs --mode changed-sources --n 10
```

`next-batch` odrzuca częściowy manifest albo cache z innego cyklu. Brak
baseline'u nie jest błędem: pierwszy cykl automatycznie kieruje nowe źródła do
pełnego przygotowania.

# Narzędzia

## Ranking URL-i w fallback crawl

Ranking subagenta jest etapem nawigacyjnym, a nie decyzją finansową. Search-first
pozostaje domyślną ścieżką. Ranking włącza się jawnie dla fallbacku:

```bash
node tools/discover-sources.mjs --lp 1 --refresh --url-ranking
```

Etap ten najpierw zapisuje per-bank manifest metadanych URL-i, następnie wywołuje
agenta `bank-market-url-ranker` z projektu OpenCode i waliduje odpowiedź. Przy
braku OpenCode, błędzie odpowiedzi albo niepoprawnym JSON używany jest
deterministyczny ranking awaryjny. Nie blokuje to discovery.

Artefakty rankingu trafiają do `/data/work/subagent-runs/<run_id>/<institution_id>/`:

- `url-ranking-input.json` — manifest wejściowy;
- `raw-response.txt` — surowa odpowiedź albo diagnostyka błędu;
- `url-ranking.json` — ranking po walidacji i uzupełnieniu brakujących URL-i.

Oczywisty szum (np. karty, lokaty, logowanie i strony prawne) jest blokowany
deterministycznie i nie jest wysyłany do modelu. Większe manifesty są dzielone
na porcje po 30 niejednoznacznych kandydatów; porcje mają osobne timeouty,
retry i wpisy diagnostyczne. Łączny budżet rankingu jednego banku wynosi
domyślnie 240 sekund, po czym pozostałe porcje przechodzą na fallback.

Pełna lista kandydatów pozostaje w `candidates.json` jako `all_candidates`.
Do pierwszego fetchu wybierana jest zróżnicowana pula, zwykle 12–16 URL-i.
Kolejne URL-e można pobrać po stwierdzeniu brakujących dowodów. Żaden URL nie
jest usuwany z manifestu tylko dlatego, że otrzymał priorytet `0`.

- `build-institution-list.mjs` — buduje listę instytucji z BFG i opcjonalnie porównuje z KNF; zapisuje hash źródła.
- `init-project.mjs` — tworzy katalogi i inicjuje JSON-y w repozytoryjnym `/data`.
- `reset-batch.mjs` — wykonuje backup i reset cache, artefaktów oraz opcjonalnie stanu analizy dla wskazanego zakresu.
- `next-batch.mjs` — zwraca małą transzę niesprawdzonych, zmienionych albo wymagających review instytucji; umie też filtrować rekordy wg stanu kolejki automatu.
- `prepare-batch.mjs` — przygotowuje wsadowo rekordy do analizy: discovery, extract, grep i review-pack oraz aktualizuje `automation-state.json`.
- `review-batch.mjs` — stosuje gotowe `row-update`, waliduje je przed zapisem i przesuwa rekordy bez decyzji do `ready_for_review`.
- `retry-batch.mjs` — wykonuje drugi przebieg dla rekordów `retry_pending`; przy wystarczających sygnałach przywraca je do `prepared`, a przy dalszych brakach eskaluje.
- `review-manifest.mjs` — eksportuje zbiorczy manifest rekordów `ready_for_review`, `escalated`, `needs_user_review` i `error` wraz ze ścieżkami do review-packów oraz row-update.
- `discover-sources.mjs` — zbiera kandydatów z search-first/fallback, zapisuje baseline, hashe transportu i materiału, nagłówki cache oraz sygnały zmiany.
- `create-url-manifest.mjs` — tworzy per-bank manifest metadanych URL-i do rankingu.
- `run-url-ranking.mjs` — uruchamia ranking OpenCode albo deterministyczny fallback.
- `validate-url-ranking.mjs` — sprawdza kompletność, integralność i dozwolone wartości rankingu.
- `expand-url-ranking.mjs` — wybiera następną porcję URL-i dla brakującej kategorii dowodów.
- `tools/lib/source-integrity.mjs` — sprawdza unikalność cache, hash, rozmiar i możliwość odczytu każdego źródła.
- `tools/lib/material.mjs` — wykonuje tanią normalizację HTML/PDF do wyliczenia `material_sha256`.
- `extract-text.mjs` — zamienia HTML/PDF na czysty tekst w cache; jeśli dostępne, używa `pdftotext -layout` dla PDF.
- `grep-evidence.mjs` — wycina krótkie fragmenty wokół fraz dowodowych i nadaje `evidence_id`.
- `prepare-review-pack.mjs` — tworzy kompaktową paczkę do decyzji agenta.
- `apply-row-update.mjs` — bezpiecznie zapisuje decyzję do `analysis-state.json`, z głębokim scalaniem sekcji.
- `validate-state.mjs` — sprawdza typy, zakresy, kody powodów, field evidence i logiczne niespójności.
- `audit-report.mjs` — generuje raport kontrolny Markdown.
- `export-workbook.mjs` — generuje XLSX z JSON/JSONL.
- `progress-report.mjs` — pokazuje postęp.
- `queue-report.mjs` — pokazuje operacyjny stan kolejki automatu i etapów retry.
- `export-evidence-index.mjs` — generuje osobny indeks źródeł.

# Kontrola jakości

Po każdej transzy sprawdź ostrzeżenia z `validate-state.mjs`. Szczególnie pilnuj:

- `qualifies: true` bez trzech potwierdzonych warunków;
- `qualifies: true` bez `qualification.reason_codes`;
- `qualifies: false` bez `qualification.non_qualification_reason_codes`;
- RRSO wpisanego mimo braku dowodu, że dotyczy wariantu okresowo stałego;
- oprocentowania wpisanego z tabeli zmiennego oprocentowania;
- danych o WIBOR/marży dotyczących okresu po stałej stopie;
- niezgodności między opisem a polami liczbowymi;
- URL-i źródłowych prowadzących do innej instytucji;
- wartości nietypowych, np. RRSO znacząco niższe od nominalnego oprocentowania stałego albo stała stopa powyżej 12%.

Przed większym użyciem albo po modyfikacji narzędzi uruchom:

```bash
npm test
npm run check
npm audit --omit=dev
```

# Wynik dla użytkownika

Po każdej transzy oddaj użytkownikowi XLSX oraz krótki opis:

- zakres pozycji uzupełnionych;
- liczba TAK/NIE/pustych;
- najważniejsze wątpliwości;
- link do pliku.

Nie obiecuj wykonania w tle. Kontynuuj kolejne transze w aktywnej sesji.
