# Powtarzalna weryfikacja pilota Parallel Search → Extract → Luna follow-up

> **Status:** eksperymentalny, izolowany pilot. Ten runbook nie jest częścią
> domyślnego produkcyjnego lifecycle `mortgage-refinancing-scan`.

## Cel

Instrukcja służy do powtarzania testów aktualnego, izolowanego pilota w kolejnych
sesjach bez dostrajania kodu, promptu lub gold setu do wyniku bieżącego
przebiegu. Aktualny pilot klasyfikuje ofertę zakorzenioną na stronie produktu.
Jeżeli strona nie zawiera kompletnego dowodu, Luna może wskazać maksymalnie trzy
bezpośrednie oficjalne `link_id` do jednorazowego doczytania przez Parallel
Extract. Druga decyzja korzysta ze strony produktu i pobranych dokumentów jako
jawnych `source_id`; trzecia runda nie istnieje.

Źródłem prawdy dla zachowania testowego są aktualne implementacje i testy:

- `.agents/skills/mortgage-refinancing-scan/lib/parallel-extract-pilot.mjs`;
- `.agents/skills/mortgage-refinancing-scan/lib/parallel-review-classifier-pilot.mjs`;
- odpowiadające im pliki `tests/skills/*parallel*pilot.test.mjs`.

Instrukcja nie zatwierdza live API calls. Search, Extract lub model można uruchomić
live wyłącznie po jawnym poleceniu użytkownika obejmującym kosztowy przebieg.

## Niezmienne zasady

1. Sesja weryfikacyjna jest read-only względem kodu, promptów, fixtures i gold
   setu. Znaleziony błąd należy zaraportować; nie wolno go naprawiać w tej samej
   sesji testowej.
2. Nie wolno zmieniać parametrów po zobaczeniu częściowych wyników, ponawiać
   przebiegu w celu wybrania lepszego wyniku ani usuwać nieudanych artefaktów.
3. Przed przebiegiem należy zapisać dokładny zakres, wejścia, model, reasoning,
   limity kosztu/czasu, polecenia i wersję `HEAD` w manifeście sesji.
4. Wszystkie artefakty sesji trafiają do nowego katalogu pod
   `var/agent/cache/mortgage-refinancing-scan/`; istniejących artefaktów nie wolno
   nadpisywać.
5. Existing 20-bank adjudicated corpus jest zbiorem regresyjnym/development,
   a nie niezależnym holdoutem. Wynik na nim nie może być raportowany jako
   estymacja generalizacji.
6. Brak dowodu w niekompletnym lub błędnie pobranym dokumencie oznacza
   `unresolved`, a nie brak oferty.
7. Anchor, kontekst i URL linku są metadanymi discovery, a nie evidence. Cytat
   końcowy musi pochodzić z jawnego `source_id` i być dokładnym fragmentem jego
   treści.
8. Kod deterministyczny sprawdza schema, URL/host, budżet i grounding. Nie
   interpretuje semantyki refinansowania regexem po decyzji Luny.
9. Jedną ofertę mogą wspierać tylko strona produktu i dokumenty bezpośrednio z
   niej podlinkowane, wybrane przez Lunę i pobrane w jednej bounded rundzie.
10. Scored PASS/FAIL wymaga jednego autorytatywnego gold setu zgodnego z
    offer-level kontraktem. Niespójne adjudykacje blokują ocenę liczbową, ale nie
    blokują technicznego wykonania i raportu diagnostycznego.

## Tryby

### Tryb A — deterministic offline regression

Uruchamiany po każdej implementacji i możliwy bez API keys:

```bash
npm test -- \
  tests/skills/mortgage-refinancing-scan-parallel-search-pilot.test.mjs \
  tests/skills/mortgage-refinancing-scan-parallel-extract-pilot.test.mjs \
  tests/skills/mortgage-refinancing-scan-parallel-review-classifier-pilot.test.mjs
git diff --check
```

Agent dodatkowo sprawdza w izolowanym kodzie pilota, że nie ma osiągalnej
ścieżki używającej:

- lokalnego `max_candidates` jako selekcji semantycznej;
- `discoverChildLinks` lub `runBankChildren`;
- `compactPageEvidence` lub `allocateBundleEvidence`;
- `hasRefinancingEvidence` albo innego deterministycznego semantic downgrade;
- keyword score/ranking do wybierania dokumentów do follow-upu;
- legacy adaptera omijającego aktualne ograniczenia.

Agent potwierdza również, że:

- model może wskazać wyłącznie istniejące `direct_links[].link_id`, maksymalnie
  trzy dla strony produktu;
- `runSelectedLinkExtract` waliduje oficjalny host, credentials, deduplikację,
  redirect host, koszt, timeout i rozmiar odpowiedzi;
- druga runda grounduje evidence wyłącznie w jawnych `source_id` strony produktu
  i pomyślnie pobranych dokumentów;
- kolejna prośba o link lub nieudane pobranie kończy ofertę jako `unresolved`,
  bez trzeciej rundy.

Negatywne sprawdzenie musi obejmować wyłącznie izolowane pliki pilota i ich testy;
historyczne artefakty `var/` pozostają immutable i mogą zawierać stare pola.

### Tryb B — replay od zamrożonego root Extract packu

Tryb izoluje wynik od zmian Search i ponownego pobrania stron root. Nie jest
jednak w pełni offline: jeżeli Luna zwróci `needs_more_evidence`, aktualny CLI
warunkowo pobierze wskazane dokumenty przez Parallel Extract i wykona drugą
klasyfikację. Taki replay wymaga jawnej zgody kosztowej i mierzy
`Luna → conditional Extract → Luna`, a nie samą pierwszą decyzję modelu.

Przed uruchomieniem agent musi mieć:

- immutable Extract pack schema `parallel-extract-pilot/2.0.0`, wygenerowany
  przez aktualny Extract i zawierający `direct_links` dla stron, na których ma
  być oceniany follow-up;
- jego SHA-256;
- dokładny model i reasoning;
- parametry batchingu i timeout;
- ścieżkę i SHA autorytatywnego offer-level gold setu, jeśli wynik ma być
  ewaluowany;
- zgodę na warunkowe wywołania Parallel Extract oraz Lunę albo deklarację, że
  przebieg ma zakończyć się błędem, jeśli model poprosi o follow-up bez klucza.

Agent przed pierwszym wywołaniem zapisuje te wartości oraz dokładne argv
klasyfikatora w `session-manifest.json`. Polecenie należy zbudować na podstawie
aktualnego `--help` narzędzia po implementacji; nie wolno odtwarzać usuniętych
opcji child/bundle/evidence-window.

Jedna sesja wykonuje dokładnie jeden zaplanowany replay. Bounded retry należący
do samego klasyfikatora jest dozwolony i musi pozostać widoczny w raporcie;
ręczny retry całej sesji tworzy nowy `RUN_ID` i jest raportowany jako osobna
próba, nie jako zamiennik nieudanego wyniku.

Raport replay zawiera co najmniej:

- SHA wejściowego Extract packu i gold setu;
- model, reasoning, prompt SHA, batch count i attempts;
- `exact_offer`, `related_page`, `noise`, `unresolved`;
- liczbę `needs_more_evidence`, wybrane `link_id`, statusy fetchu i wynik drugiej
  rundy; `needs_more_evidence` nie może pozostać etykietą końcową;
- TP, FP i FN, jeśli istnieje zamrożony gold set;
- listę rozbieżności względem wskazanego baseline’u;
- czas i koszt oraz informację, że wynik modelu nie jest deterministyczny.

Historyczny schema-2 pack bez `direct_links` może służyć wyłącznie do regresji
pierwszej rundy. Nie jest testem mechanizmu doczytywania. Pełny offline replay
follow-upu wymagałby osobnego, zamrożonego transportu/fixture; bieżący CLI go nie
udostępnia i instrukcja nie może sugerować, że taki test został wykonany.

### Tryb C — pełny live end-to-end

Tryb wymaga osobnej, jednoznacznej zgody użytkownika na live Search, Extract
i klasyfikację modelową.

Przed wywołaniem API agent:

1. ładuje środowisko wyłącznie przez
   `.agents/skills/_shared/scripts/env-load.sh` i nie wypisuje sekretów;
2. zamraża manifest banków, queries/objective, limity API, model/reasoning,
   batching, timeouty, cost caps oraz dokładne argv wszystkich trzech etapów;
3. zapisuje `HEAD`, dirty status i SHA wszystkich wejść;
4. tworzy nowy katalog sesji i nie używa istniejących output paths;
5. deklaruje z góry, czy przebieg jest regresją na znanym korpusie, czy
   niezależnym holdoutem.

Kolejność jest stała:

```text
Parallel Search
→ official-domain canonical deduplication
→ Parallel Extract każdego głównego wyniku Search wraz z bounded `direct_links`
→ pierwsza klasyfikacja każdej strony produktu przez Lunę
→ opcjonalne `needs_more_evidence` z 1–3 istniejącymi `link_id`
→ jednorazowy Parallel Extract dokładnie wybranych bezpośrednich dokumentów
→ druga i ostateczna klasyfikacja jednej oferty na jawnych `source_id`
→ deterministyczny rollup banku
→ ewaluacja względem zamrożonego gold setu
```

Etap kolejny nie startuje po nieudanym etapie poprzednim. Agent zachowuje także
częściowe i błędne artefakty. Follow-up nie jest ogólnym child crawlem: Luna może
wybrać tylko bezpośrednie linki strony produktu, nie ma keyword rankingu ani
lokalnego top-k, a orkiestrator nie podąża za linkami z pobranych dokumentów.

Raport live zawiera:

- liczbę oficjalnych i unikalnych wyników Search per bank;
- liczbę prób Extract, sukcesów, błędów i dokumentów jawnie niekompletnych;
- liczbę ofert proszących o follow-up, wskazane i faktycznie pobrane `link_id`,
  fetch errors oraz liczbę decyzji drugiej rundy;
- rozkład decyzji Luny i bank rollup;
- TP, FP, FN i listę konkretnych błędów względem frozen gold;
- koszt oraz czas każdego etapu;
- porównanie z baseline’em bez zmiany gold setu;
- oddzielną listę problemów Search, Extract, completeness, modelu i walidatora.

Przed live runem należy potwierdzić, że root Extract rzeczywiście wyprodukował
`direct_links`. Brak linku potrzebnego do rozstrzygnięcia jest problemem
Search/Extract completeness; wybór niewłaściwego istniejącego linku jest
problemem decyzji Luny; cytat spoza zadeklarowanego `source_id` jest problemem
walidacji model response.

## Warunki interpretacji

- PASS offline oznacza tylko zgodność implementacji i kontraktów.
- PASS replay oznacza wynik na jednym zamrożonym root packu; nie mierzy Search.
  Jeżeli wystąpił follow-up live, mierzy również bieżącą treść wybranych
  dokumentów i nie może być opisany jako całkowicie zamrożony classifier replay.
- PASS live na znanych 20 bankach oznacza regresję development corpus, nie
  generalizację.
- Twierdzenie o generalizacji wymaga uprzednio zamrożonego, niezależnego
  holdoutu, którego nie użyto do implementacji ani strojenia.
- Każda zmiana kodu, promptu lub gold setu kończy sesję weryfikacyjną. Poprawka
  i ponowny test muszą odbyć się w nowej, jawnie oznaczonej iteracji.

## Kryterium (B) w prompcie Luny — stan po zmianie

Kryterium (B) (`periodic_fixed_rate`) w prompcie klasyfikatora
(`parallel-review-classifier-pilot.mjs`, funkcja `buildPromptText`) akceptuje:

1. jawne termy stopy w tekście strony (np. `oprocentowanie okresowo-stałe`,
   `stała stopa procentowa`, `okresowo stałe`, `RRSO`, procent z `stałe`);
2. **wyłącznie na tej samej oficjalnej stronie produktu kredytowego, która
   ustanawia kryterium (A)** — nazwaną kategorię stopy (np. `Oprocentowanie
   okresowo-stałe` jako nagłówek, pozycja menu albo link podstrony).

Nazwana kategoria stopy na stronie głównej, ogólnej liście ofert, newsach lub
innej stronie nieproduktowej **nie wystarcza sama w sobie** — to chroni przed
fałszywymi pozytywami (obserwowany przypadek: strona główna Pieńska
zaklasyfikowana jako `exact_offer` po pierwotnym poluzowaniu).

Ewaluacja tej zmiany na development corpus (run `live-20260902T203747Z`,
porównanie `prompt-comparison-v1-v2.json`):

| Prompt | Precision | Recall | F1 |
|---|---|---|---|
| przed zmianą (baseline) | 1.000 | 0.750 | 0.857 |
| v1 (kategoria wszędzie) | 0.875 | 0.875 | 0.875 |
| v2 (kategoria tylko na stronie produktu) | 1.000 | 0.875 | 0.933 |

Złotów przeszedł z FN do TP; jedyny pozostały FN to Biała Rawska, z przyczyną
techniczną po stronie banku (niekompletny łańcuch certyfikatów TLS), nie
zachowaniem klasyfikatora.

## Standardowy raport końcowy

```text
Mode: offline | replay | live
Result: PASS | FAIL | BLOCKED
Code revision: <HEAD oraz dirty status>
Inputs: <ścieżki i SHA>
Configuration: <model, reasoning, limits, exact argv>
Checks: <uruchomione polecenia i exit codes>
Metrics: <final counts, follow-up requested/fetched/resolved, TP/FP/FN, cost, elapsed>
Artifact directory: <nowy katalog sesji>
Deviations from baseline: <lista albo none>
Failures by stage: Search | root Extract | direct-link completeness | follow-up Extract | Luna round 1/2 | validation
Generalization claim: not assessed | holdout result
Code or gold modified during session: no
```

## Prompt do użycia w kolejnej sesji

```text
Powtórz weryfikację pilota Parallel Search → Extract → Luna z jednorundowym
model-requested follow-upem zgodnie z
.agents/skills/mortgage-refinancing-scan/docs/parallel-pilot-repeatable-verification.md.

Tryb: <offline | replay-root-pack | live>.
Baseline/root Extract pack/gold/holdout: <wskaż istniejące artefakty i SHA>.
Live consent: <none | conditional Extract+Luna | Search+Extract+Luna>.

Nie modyfikuj kodu, promptów, fixtures ani gold setu. Najpierw zapisz manifest
sesji i zamroź parametry, w tym limit 3 direct links i jedną rundę follow-up.
Zachowaj wszystkie artefakty, także nieudane, i zakończ raportem w formacie
określonym w instrukcji.
```
