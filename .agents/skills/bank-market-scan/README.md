# Bank Market Scan Skill

Zestaw skilla i lokalnych narzędzi dla agenta Codex do cyklicznego badania ofert banków spółdzielczych i SKOK-ów w Polsce pod kątem kredytów mieszkaniowych/hipotecznych służących spłacie/refinansowaniu wcześniejszego albo innego kredytu mieszkaniowego/hipotecznego z wariantem okresowo stałego oprocentowania.

Źródłem prawdy dla agenta są pliki JSON/JSONL zapisywane do repozytoryjnego katalogu `/data`. XLSX jest tylko eksportem dla człowieka.

Katalog skilla zawiera wyłącznie kod, manifest i schematy. Pliki robocze, cache, eksporty i stan analizy trafiają do `/data` w katalogu głównym projektu.

Dodatkowy stan operacyjny automatu jest trzymany w `/data/work/automation-state.json`. Służy do śledzenia etapów kolejki i retry, nie zastępuje `analysis-state.json`.
Każdy nowy przebieg ma również exact-scope manifest i status w `/data/work/runs/<run_id>/`.

## Szybki start

```bash
npm install
uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt
node tools/init-project.mjs
node tools/progress-report.mjs
node tools/queue-report.mjs
node tools/prepare-run.mjs --run-id run-example --from 1 --limit 5
node tools/prepare-batch.mjs --limit 25 --refresh
node tools/next-batch.mjs --n 5
```

Benchmark ekstrakcji treści uruchamia macierz starego parsera i `main-content`,
każdy wariant z lematyzacją Morfeusz 2 i bez niej. Morfeusz 2 jest uruchamiany
jako jeden lokalny worker Python na cały batch:

```bash
npm run benchmark-content -- \
  --python /ścieżka/do/python-z-morfeusz2 \
  --out /data/work/runs/content-pipeline-benchmark.json
```

Podczas zwykłego discovery worker Morfeusza jest uruchamiany automatycznie.
Morfeusz 2 jest wymagany — brak modułu kończy analizę jawnym błędem, a pipeline
nie używa fallbacku surface-form. Jeżeli interpreter nie jest domyślnym
`.venv/bin/python`, ustaw `MORFEUSZ_PYTHON`.

Po ekstrakcji tekstu batch zapisuje również tymczasowy artefakt
`normalized-text.json` (dla runu exact-scope pod `/data/work/runs/<run_id>/normalization/`).
Artefakt zawiera lematy, tokeny i offsety związane z hashem oryginalnego tekstu.
`grep-evidence.mjs` wymaga kompletnego artefaktu i pobiera cytaty z oryginalnego
tekstu, używając znormalizowanych tokenów wyłącznie do dopasowania.

Do interpretacji używaj celowanego odczytu zamiast otwierania pełnych artefaktów:

```bash
node tools/read-review-context.mjs --run-manifest /data/work/runs/<run_id>/manifest.json --lp 3 --criterion all
```

Narzędzie zwraca oryginalne cytaty, identyfikatory evidence, role źródeł,
hashy i kompaktowy wynik heurystyki. Pełny tekst lub `excluded_context` dociągaj
tylko przez `--evidence-id`, `--url` albo `--include-excluded-context`.

Przed nowym runem wykonaj preflight spójności stanu:

```bash
node tools/reconcile-state.mjs --fail-on-orphans
```

Naprawa historycznych evidence jest jawna i nie usuwa danych:

```bash
node tools/reconcile-state.mjs --repair-from-backups --normalize-state --fail-on-orphans
```

Czysty, zakresowy restart wykonuj wyłącznie przez `reset-batch.mjs`, który
najpierw tworzy backup, a potem czyści wybrane źródła i stan:

```bash
node tools/reset-batch.mjs --from 1 --limit 5 --clear-cache --clear-analysis
node tools/prepare-batch.mjs --from 1 --limit 5 --refresh --fresh
```

W zwykłym trybie `--from` i `--limit` ograniczają również odświeżanie discovery.
Pełne odświeżenie wszystkich instytucji jest zarezerwowane dla jawnego trybu
`changed-only`.

Dla jednej instytucji:

```bash
node tools/prepare-review-pack.mjs --lp 47 --refresh
# Agent analizuje /data/work/review-packs/lp-047.md i tworzy row-update.json
node tools/apply-row-update.mjs --input /data/work/row-updates/lp-047.json
node tools/validate-state.mjs
node tools/export-workbook.mjs --out /data/exports/rynek-bs-skok.xlsx
node tools/audit-report.mjs --out /data/exports/review-report.md
```

## Co zmieniło się w aktualnej wersji

- Dodano `field_evidence`: dowody źródłowe per konkretne pole, a nie tylko per instytucja.
- Dodano `field_status`: status `found`, `not_found`, `ambiguous`, `not_applicable`, `not_checked` dla pól roboczych.
- Dodano kody powodów `qualification.reason_codes` i `qualification.non_qualification_reason_codes`.
- Dodano pola zakresowe typu `*_min`, `*_max`, `*_exact` dla oprocentowania, prowizji i RRSO.
- Dodano hashe SHA-256 i długość treści dla pobranych źródeł, aby wykrywać zmiany.
- Dodano tryb `next-batch --mode changed-sources` do kolejek ponownego sprawdzania zmienionych źródeł.
- Dodano `audit-report.mjs`, czyli raport kontrolny Markdown z ostrzeżeniami i nietypowymi wartościami.
- Eksport XLSX korzysta z `exceljs`; podatne `xlsx` zostało usunięte.
- Dodano test integracyjny pełnego mini-flow JSON → update → validate → XLSX.
- Dodano search-first z crawl fallbackiem, deterministyczny content check i retry zależny od `sufficient_for_analysis`.
- Discovery rejestruje kanoniczny host po przekierowaniu strony głównej i akceptuje aliasy `www`/non-`www`, dzięki czemu fallback nie odrzuca linków aktualnego hosta banku.
- Dodano baseline monitorowanych URL-i, `material_sha256`, ETag/Last-Modified i obsługę `304 Not Modified`.
- Dodano automatyczny cykl `changed-only` z Fazą A odświeżenia i Fazą B pełnego przygotowania zmian.
- Dodano manifesty `data/work/source-refresh-runs/<run_id>.json` oraz ochronę przed częściowym/starym cache.
- Ograniczono pierwszy przebieg do 23 pól decyzyjnych eksportowanych do XLSX.
- Usunięto z pierwszego przebiegu osobne pola/evidence dla WIBOR-u, marży, wymagań i dokumentów; warunki promocji są zachowywane tylko wtedy, gdy są potrzebne do interpretacji wybranego wariantu.
- Review-pack zawiera indeks pełnych materiałów `source-text.jsonl`; snippety służą wyłącznie jako nawigacja.
- Każdy run ma `run_id`, a decyzja z innego runu nie może zostać zastosowana do bieżącej kolejki.
- Manifest runu zawiera dokładne `institution_ids` i `lps`; każdy downstreamowy etap odrzuca rekord spoza manifestu.
- `decision_status` jest kanonicznym źródłem decyzji, a `qualifies` jest wyłącznie polem kompatybilności.
- `finalize-run` jest jedynym miejscem scalającym evidence runu z globalnym indeksem; `abort-run` nie zmienia finalnego stanu.
- Pliki źródłowe cache są identyfikowane hashem pełnego URL-a, więc różne strony nie mogą nadpisać sobie treści.
- Discovery i ekstrakcja sprawdzają hash, rozmiar, canonical URL oraz spójność `cache_file`; niespójność jest błędem technicznym, nie brakiem oferty.
- Heurystyka słów kluczowych nie jest już samodzielną bramką odrzucającą; czytelny materiał z co najmniej dwoma sygnałami trafia do oceny agenta.
- Canonical `www`/non-`www`, końcowy `/` i `/index.html` są normalizowane; błędy canonical na pobocznych stronach są ostrzeżeniami, nie blokadą całego banku.
- Review-pack oznacza źródła jako `core`, `supporting` albo `excluded_context`, a `row-update` dla `TAK` wymaga `decision_audit` potwierdzającego wspólny produkt i wariant.
- Product bundle łączy trzy kryteria z jednym produktem/wariantem; sama fraza refinansowania, źródło `excluded_context`, homepage, sitemap lub kalkulator nie może dać `TAK`.
- Gold set semantyczny znajduje się w `tests/fixtures/golden-decisions.json` i obejmuje 30 przypadków z oczekiwanym `decision_status`.
- Ranking deterministyczny jest domyślną szybką ścieżką; OpenCode jest eskalowany tylko dla remisu, wielu bundle, konfliktu metadanych albo brakującego coverage. `changed-only` wykonuje najpierw lekki refresh monitorowanych URL-i.

## Najważniejsza reguła

Nie wpisuj żadnych danych dotyczących okresu po zakończeniu okresowo stałego oprocentowania. W szczególności nie przepisuj WIBOR/marży dla późniejszego okresu zmiennego. Jeżeli bank podaje RRSO albo oprocentowanie tylko dla zmiennej stopy, zostaw pola wariantu stałego puste i opisz to w uwagach.

## Praca okresowa / changed-only

Uruchom jeden cykl, bez ręcznego wybierania banków pomiędzy fazami:

```bash
node tools/prepare-batch.mjs --mode changed-only --refresh --limit 25
```

Faza A odświeża wszystkie instytucje z adresem strony i nie jest ograniczana
przez `--limit`. Faza B uruchamia `extract-text`, `normalize-text`, evidence i review-pack tylko
dla ofert z `offer_changed_since_last_fetch: true`; `--limit` dotyczy wyłącznie
tej fazy. Banki bez zmiany otrzymują `unchanged_sources`.

Kolejkę zmienionych ofert można dodatkowo podejrzeć po kompletnym cyklu:

```bash
node tools/next-batch.mjs --mode changed-sources --n 10
```

Pole `search_results_sha256` i `discovery_changed_since_last_fetch` są
diagnostyczne. Pełne przygotowanie uruchamia tylko zmiana materiału, nowy lub
niedostępny URL albo brak baseline'u. `changed-only` celowo odświeża cały
baseline; w zwykłym przebiegu zakres `--from`/`--limit` ogranicza zarówno
discovery, jak i preprocessing.

## Kolejka automatu

Stan kolejki i etapy techniczne można podejrzeć przez:

```bash
node tools/queue-report.mjs
```

Wsadowe przygotowanie materiału dla agenta:

```bash
node tools/prepare-batch.mjs --limit 25 --refresh
```

Wsadowe domykanie gotowych decyzji i oznaczanie rekordów do dalszej oceny:

```bash
node tools/review-batch.mjs --limit 25
```

Drugi przebieg dla rekordów ryzykownych technicznie:

```bash
node tools/retry-batch.mjs --limit 25 --refresh
```

Przy ręcznym tworzeniu `row-update` przepisz `run_id` z review-packa.
`review-batch` odrzuci decyzję bez tego identyfikatora albo z identyfikatorem
innego runu.

Zbiorczy manifest rekordów do oceny i wyjątków:

```bash
node tools/review-manifest.mjs --out /data/exports/review-queue.json --md-out /data/exports/review-queue.md
```

To jest raport operacyjny dla agenta i debugowania procesu. Standardowym wynikiem dla użytkownika nadal pozostaje eksport i krótkie podsumowanie wyjątków.

Pełny cykl `changed-only` zapisuje również manifest w
`/data/work/source-refresh-runs/`. Status `partial` nie może zasilać
`next-batch --mode changed-sources`.

## Kontrola jakości

```bash
npm test
npm run check
npm audit --omit=dev
```

Dodatkowa walidacja per-pole:

```bash
node tools/validate-state.mjs --require-field-evidence
```

Rygorystyczny pipeline:

```bash
node tools/validate-state.mjs --strict --require-field-evidence
```

Raport kontrolny:

```bash
node tools/audit-report.mjs --require-field-evidence --out /data/exports/review-report.md
```

## Zależności opcjonalne

`extract-text.mjs` automatycznie użyje `pdftotext -layout`, jeśli narzędzie jest dostępne lokalnie. Dla tabel PDF często daje to lepszy tekst niż parser JavaScript. Jeżeli `pdftotext` nie jest dostępny, skrypt wraca do `pdf-parse`.
