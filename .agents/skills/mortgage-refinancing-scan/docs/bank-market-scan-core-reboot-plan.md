# Mortgage Refinancing Scan — standalone plan

**Status:** approved for implementation  
**Skill:** `mortgage-refinancing-scan`  
**Agent wykonawczy:** `mortgage-refinancing-scan-runner`  
**Zakres:** samodzielny skill, agent wykonawczy, kontrakty danych i lifecycle
runu. Dokument nie zezwala jeszcze na implementację runtime'u.

**Rewizja wydajności:** plan uwzględnia bounded concurrency między niezależnymi
originami, rewalidowany transport cache, pipeline etapów, deduplikację,
strumieniowe I/O oraz finalizację z jawnymi błędami per instytucja. Decyzje
biznesowe pozostają deterministyczne i niezależne od kolejności odpowiedzi.

**Źródło prawdy implementacji:** ten dokument po akceptacji. Dokument
[external research](../../../docs/draft/bank-market-scan-external-research.md) zawiera wyłącznie
uzasadnienia, porównania i źródła wspierające. Wzmianka o rozwiązaniu w
external research nie oznacza zgody na jego wdrożenie. Implementer nie traktuje
external research ani innych dokumentów pomocniczych jako wejścia
implementacyjnego; obowiązujące są wyłącznie zamknięte kontrakty z tego planu.

**Reguła dla implementera:** wszystkie decyzje z tego dokumentu są zamknięte.
Implementer nie zmienia wariantu po cichu na podstawie researchu.

> **NIEZMIENNA ZASADA: ZERO LEGACY DECISION STATE I ZERO KOMPATYBILNOŚCI WSTECZNEJ**
>
> Nowe rozwiązanie jest całkowicie niezależne od poprzednich rozwiązań. W czasie
> realizacji planu ani podczas działania nowego rozwiązania nie wolno czytać,
> analizować, wykorzystywać, migrować ani sugerować się poprzednimi skillami,
> agentami, narzędziami, schematami, decyzjami, evidence ani dokumentacją.
> Nie wolno tworzyć adapterów, mostów, ścieżek zgodności, współdzielonego
> decision state ani fallbacków do legacy. Nowe rozwiązanie ma własne kontrakty,
> artefakty, entrypointy i runtime. Wyjątkiem jest wyłącznie nowy, rewalidowany
> transport cache surowej treści i normalizacji, który nie zawiera decyzji i jest
> opisany w kontrakcie `transport_cache_policy`.

## 1. Cel i granice

### 1.1. Cel biznesowy

Skill przygotowuje powtarzalny raport o bankach spółdzielczych w Polsce. Zakres
nie obejmuje SKOK-ów. Dla każdego banku ma odpowiedzieć, czy istnieje jeden konkretny
produkt i wariant kredytu, który jednocześnie:

1. jest kredytem mieszkaniowym, hipotecznym, mieszkaniowo-hipotecznym albo
   równoważnym kredytem zabezpieczonym hipotecznie na cele mieszkaniowe;
2. służy spłacie albo refinansowaniu istniejącego kredytu mieszkaniowego lub
   hipotecznego na cele mieszkaniowe;
3. ma oprocentowanie stałe bezterminowo albo okresowo stałe.

Warunki muszą być potwierdzone dla tego samego `product_id` i `variant_id`.
Nie wolno sumować sygnałów z różnych produktów, wariantów ani kontekstów.
Literalna fraza „z innego banku” nie jest wymagana, jeżeli źródło jednoznacznie
opisuje spłatę albo refinansowanie istniejącego kredytu mieszkaniowego lub
hipotecznego.

### 1.2. Wynik dla instytucji

Canonicalnym wynikiem jest jeden rekord statusu na bank spółdzielczy. Rekord
może zawierać decyzję biznesową albo jawny `technical_error` bez decyzji:

| `decision_status` | Znaczenie | `qualifies` (wyliczane) |
|---|---|---:|
| `qualified` | trzy kryteria potwierdzone dla jednego wariantu | `true` |
| `explicitly_not_qualified` | źródła wyraźnie wykluczają co najmniej jedno kryterium | `false` |
| `unconfirmed` | analiza zakończona, ale dowód jest niewystarczający lub niejednoznaczny | `null` |
| `technical_error` | analiza konkretnej instytucji nie mogła się zakończyć z powodu błędu technicznego | `null` |

`qualifies` nie jest przechowywane w canonicalnym snapshotcie; exporter wylicza
je z `decision_status`. `review_status` również jest projekcją eksportową:
`qualified`/`explicitly_not_qualified` → `checked`, `unconfirmed` →
`needs_review`, `technical_error` → `error`. Brak danych ani błąd techniczny nie
może być mapowany na `false`. `unchecked` może wystąpić tylko przed wykonaniem
analizy, nigdy w opublikowanym wyniku. `technical_error` jest publikowany jako
jawny rekord wpisu z `error_code`, bez produktu, oferty i dowodów decyzyjnych;
nie jest negatywną decyzją biznesową.

Dla `qualified` wymagane są co najmniej kody:

```json
[
  "housing_or_mortgage_loan_confirmed",
  "refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed",
  "fixed_rate_confirmed"
]
```

Przykładowe biznesowe kody negatywne:

```text
no_housing_or_mortgage_loan_confirmed
no_refinance_or_repayment_confirmed
no_fixed_rate_confirmed
only_variable_rate_found
only_refinancing_of_own_costs_found
ambiguous_sources
```

Przykładowe kody błędów są odrębnymi enumami zakresu wpisu i zakresu runu:

```text
EntryRunErrorCode:
required_source_unavailable
request_timeout_after_retries
robots_denied
official_host_violation
evidence_mismatch

FatalRunErrorCode:
schema_mismatch
dependency_missing
publication_io_failure
```

### 1.3. Wykluczenia domenowe

Nie kwalifikować jako `qualified`:

- refinansowania własnych kosztów lub zwrotu poniesionych wydatków bez spłaty
  kredytu;
- pożyczki hipotecznej na dowolny cel bez jednoznacznego związku ze spłatą
  kredytu mieszkaniowego lub hipotecznego;
- kredytu konsolidacyjnego bez potwierdzenia objęcia kredytu mieszkaniowego lub
  hipotecznego;
- oferty wyłącznie ze zmiennym oprocentowaniem;
- zmiany oprocentowania istniejącego kredytu bez oferty nowego kredytu;
- połączenia trzech kryteriów znalezionych dla różnych produktów lub wariantów.

Nie zapisywać w polach ofertowych danych dotyczących okresu po zakończeniu
stałej stopy. Dotyczy to późniejszego WIBOR-u, marży i oprocentowania
zmiennego. Takie informacje mogą pozostać w notatce źródłowej wyłącznie jako
kontekst wykluczający.

### 1.4. Zakres pierwszego MVP

MVP zbiera i publikuje tylko dane potrzebne do decyzji oraz podstawowego
porównania:

- identyfikator i typ instytucji;
- produkt i wariant;
- trzy kryteria kwalifikacji;
- nazwa produktu i URL;
- typ stopy (`permanent_fixed` albo `periodically_fixed`) i, gdy dotyczy, okres stałej stopy;
- nominalne oprocentowanie stałe;
- RRSO dla kwalifikującego wariantu;
- prowizja;
- maksymalny okres kredytowania;
- status, kody powodów, datę obserwacji i evidence.

Pola liczbowe mogą mieć wartość dokładną albo zakres `min`/`max`. Zakresów nie
wolno uśredniać. Szczegółowe wymagania konta, wpływów, kart, ubezpieczeń,
formalności i grup zawodowych pozostają poza osobnymi kolumnami MVP, ale
istotny kontekst może pozostać w artefakcie źródłowym.

Arkusz XLSX jest eksportem. Źródłem prawdy są zwalidowane artefakty JSON/JSONL
i opublikowany snapshot.

### 1.5. Poza zakresem MVP

- automatyczne przenoszenie danych lub formatów;
- współdzielenie stanu albo ukryte przełączanie do innego lifecycle'u;
- automatyczne poprawianie niejednoznacznych decyzji;
- współbieżność bez manifestu;
- OCR, renderowanie przeglądarkowe i zewnętrzny backend telemetryczny;
- niejawna współbieżność ani automatyczne zwiększanie limitów poza manifestem;
- zmiana zakresu pól bez osobnej decyzji metodologicznej.

## 2. Zasady nienegocjowalne

1. **Exact scope:** manifest jest niezmiennym i jedynym źródłem zakresu runu.
2. **Run isolation:** run nie czyta wyników ani stanu innego runu, aby ustalić
   bieżącą decyzję. Każdy pełny run zaczyna od własnego snapshotu listy banków
   i własnego discovery; nie istnieje tryb aktualizujący poprzedni wynik.
3. **One state machine:** status runu, statusy wpisów i checkpoint mają jedną
   semantykę; nie tworzyć równoległych liczników o podobnych nazwach.
4. **No early publication:** przetwarzanie zapisuje artefakty decyzji wyłącznie
   do stagingu bieżącego runu. Dozwolony jest atomowy zapis rewalidowanego
   transport/normalization cache, który nie jest publikacją ani źródłem decyzji.
   Publikacja następuje dopiero w `finalize`.
5. **Evidence-first:** interpreter dostaje tylko evidence, które przeszło
   walidację identyfikatora, URL-a, hash'u, zakresu i kategorii.
6. **Product bundle:** `qualified` wymaga trzech kryteriów dla tego samego
   produktu i wariantu.
7. **No silent substitution:** brak wymaganej telemetryki albo narzędzia jest
   jawnym błędem, a nie powodem do niejawnej zmiany ścieżki.
8. **Bounded resources:** limity, timeouty i retry są częścią manifestu oraz
   telemetryki, a nie domyślną konfiguracją ukrytą w narzędziu.
9. **Origin-safe concurrency:** współbieżność jest jawna, ograniczona globalnie
   i per origin; opóźnienie oraz `Retry-After` blokują tylko właściwą kolejkę,
   nigdy wszystkich niezależnych originów.
10. **Order-independent decisions:** kolejność requestów, eventów i zakończenia
   workerów nie może wpływać na bundle, evidence, status ani ranking.
11. **Immutable publication:** opublikowany snapshot jest niezmienny; wskaźnik
   `current.json` jest podmieniany atomowo.
12. **Auditability:** cały wynik runu musi dać się odtworzyć z jego manifestu,
     eventów, artefaktów, evidence, checkpointu i metadanych publikacji.
13. **Zero legacy decision state:** poprzednie rozwiązania i poprzednie decyzje
    nie są wejściem, zależnością, migracją ani źródłem wiedzy. Dozwolony jest
    wyłącznie nowy, rewalidowany transport cache treści i normalizacji opisany w
    §5.3 oraz §6.2; nie jest on źródłem decyzji.
14. **Zero legacy:** poprzednie rozwiązania nie są wejściem, zależnością,
     migracją, źródłem wiedzy ani powierzchnią kompatybilności. Runtime nowego
     rozwiązania używa wyłącznie dedykowanego katalogu
     `data/mortgage-refinancing-scan/`.

## 3. Architektura standalone

### 3.1. Skill i moduły wewnętrzne

#### `mortgage-refinancing-scan`

To jest jedyny publiczny skill. Poniższe odpowiedzialności są modułami
wewnętrznymi tego skilla, a nie osobnymi skillami.

##### Moduł `core`

Odpowiada wyłącznie za:

- schematy manifestu, kontekstu, eventów, checkpointu i wyniku;
- walidację kontraktów i przejść;
- run-local store;
- retry, abort, finalize i publikację;
- telemetrykę oraz diagnostykę.

Nie zawiera promptów interpretacyjnych ani reguł wyboru oferty.

##### Moduł `research`

Odpowiada za:

- listę instytucji i kontrolę kompletności;
- discovery oficjalnych źródeł;
- origin-aware scheduler, HTTP fetch, robots, sitemapę, rewalidowany transport
  cache i integralność treści;
- ekstrakcję tekstu;
- wymaganą normalizację Morfeuszem 2;
- tworzenie evidence.

Każdy adapter otrzymuje jawny `RunContext` i zwraca artefakt etapowy. Adapter
nie zapisuje globalnego decision state ani publikacji; `source-fetch` może
wykonać atomowy zapis do jawnego transport cache zgodnie z manifestem.

##### Moduł `interpretation`

Odpowiada za:

- zgrupowanie źródeł w `ProductBundle`;
- ocenę trzech kryteriów;
- mapowanie evidence na pola;
- zwrot `InterpretationResult` w ścisłym schemacie;
- wybór najwyżej jednej oferty na instytucję.

W MVP interpretacja jest deterministyczna. Niejednoznaczność daje `unconfirmed`;
nie ma osobnej ścieżki odroczenia ani modelu językowego.

##### Moduł `qa`

Moduł pomocniczy, uruchamiany poza produkcyjnym runem. Obejmuje fault injection,
fixture'y, gold set decyzji, benchmarki czasu/zasobów i raport regresji.

### 3.2. Nowe agenty

#### `mortgage-refinancing-scan-runner`

Jedyny agent sterujący lifecycle'em. Tworzy manifest, uruchamia etapy w
ustalonej kolejności, waliduje checkpointy, wykonuje retry/abort/finalize i
raportuje telemetrykę.

Nie podejmuje samodzielnie decyzji biznesowych i nie zapisuje `row-update` poza
kontraktem narzędzia.

Runner przyjmuje jawnie `--registry-snapshot`, `--run-root`, `--mode full` i
tryb `--live`; wynik końcowy zwraca jako strukturalny JSON zawierający `run_id`,
status, checkpoint path i publication pointer albo abort reason. Nie zapisuje
poza dedykowanym runtime rootem, nie wykonuje własnych requestów HTTP i nie
interpretuje treści. Uruchamia logiczne etapy w bounded pipeline, a nie przez
niejawne tworzenie workerów dla każdego requestu. `SIGINT`, `SIGTERM`, utrata
procesu narzędzia i niezerowy exit code entrypointu prowadzą do `abort.mjs`
albo jawnego recovery.

W MVP tworzy się tylko runnera. Read-only audit pozostaje narzędziem
`run-audit.mjs` uruchamianym po runie, a nie kolejnym agentem.

### 3.3. Techniczna granica implementacji deterministycznej

Wszystkie narzędzia runtime nowego skilla są implementowane jako skrypty
Node.js ESM z rozszerzeniem `.mjs`. Każdy skrypt ma jawny input/output i działa
poza promptem agenta; każdy entrypoint poza `run-init.mjs` uruchamia się z
`--run-manifest`. Agent
`mortgage-refinancing-scan-runner` wyłącznie wywołuje te entrypointy i obsługuje
lifecycle; nie zawiera logiki decyzji biznesowych.

Publiczne entrypointy deterministyczne to:

- `run-state.mjs` — eventy, projekcja wpisów, checkpoint i telemetryka;
- `normalize.mjs` — normalizacja przy tym samym wejściu i wersji Morfeusza;
- `evidence.mjs` — budowa i walidacja evidence;
- `interpret.mjs` — ReviewContext, ProductBundle, kryteria, ranking i strict output.

Publiczne entrypointy I/O to: `run-init.mjs`, `institution-list.mjs`,
`source-discovery.mjs`, `source-fetch.mjs`, `finalize.mjs`, `abort.mjs` i
`export-workbook.mjs`. `run-audit.mjs` jest narzędziem read-only po MVP.
Walidacja kontraktów, szczegółowe funkcje interpretacji i projekcja pomocnicza
metryk są modułami `lib/*.mjs`, a nie osobnymi CLI. Wyniki zewnętrzne mogą
zależeć od sieci, czasu lub systemu plików, ale reguły retry, limitów,
canonicalizacji, hashy, serializacji i obsługi błędów muszą być powtarzalne na
fixture’ach. Czas, losowość i identyfikatory runu mogą być metadanymi, lecz nie
mogą wpływać na decyzję ani ranking.

Implementer może dzielić kod na moduły `.mjs`, ale nie może przenosić logiki
kwalifikacji, wyboru oferty ani przejść lifecycle'u do promptu agenta.

Każdy produkcyjny plik `.mjs` wymieniony w tej sekcji albo w tabeli narzędzi
ma obowiązkową pozycję w macierzy testów i co najmniej jeden znaczący test
automatyczny. Dla modułów czysto deterministycznych jest to test unit/contract;
dla entrypointów I/O — test fixture/integration/fault obejmujący input, output,
exit code i artefakty. Sam import pliku bez asercji zachowania nie spełnia tego
wymogu.

### 3.4. Layout kodu i kontrakt CLI

Canonicalny layout nowego skilla jest następujący:

```text
.agents/skills/mortgage-refinancing-scan/
  SKILL.md
  package.json
  package-lock.json
  tools/*.mjs
  lib/*.mjs
  schemas/*.schema.json
  fixtures/...
  tests/test-matrix.json
```

Każdy entrypoint poza `run-init.mjs` przyjmuje `--run-manifest <path>`.
`run-init.mjs` nie przyjmuje manifestu, tylko:

- `--registry-snapshot <path>`;
- `--mode full`;
- `--run-root <path>`;
- jawny output manifestu.

`export-workbook.mjs` przyjmuje manifest finalized runu i ścieżkę outputu XLSX;
nie przyjmuje globalnego pliku analizy jako alternatywnego źródła. Każdy
entrypoint zwraca kod `0` po sukcesie, kod niezerowy po błędzie kontraktu lub
runu oraz strukturalny raport błędu na stderr. Canonicalne kody CLI to: `0`
success, `2` invalid invocation, `10` contract/schema failure, `20` fatal run
error i `30` publication/recovery failure. Status `ABORTED` zapisany poprawnie
przez `abort.mjs` nie jest błędem samego narzędzia i może zwrócić `0`; przyczyna
pozostaje w artefakcie runu.

## 4. Kontrakt danych

### 4.1. `RunManifest`

Manifest jest tworzony raz i po utworzeniu nie może być nadpisany.

```json
{
  "schema_version": "1.0.0",
  "run_id": "run-20260805T010203Z-a1b2c3",
  "scope": {
    "entries": [
      {
        "entry_id": "bank-001",
        "lp": 1,
        "institution_id": "example-bank",
        "institution_type": "cooperative_bank"
      },
      {
        "entry_id": "bank-002",
        "lp": 2,
        "institution_id": "example-bank-2",
        "institution_type": "cooperative_bank"
      }
    ],
    "scope_sha256": "..."
  },
  "source_registry_sha256": "...",
  "mode": "full",
  "live": false,
  "discovery_policy": "deterministic_official_sources",
  "resource_policy": {
    "max_active_institutions": 24,
    "max_http_in_flight": 24,
    "max_in_flight_per_origin": 1,
    "max_in_flight_per_institution": 1,
    "max_normalization_workers": 4,
    "max_event_batch_size": 64,
    "max_discovery_requests_per_institution": 256,
    "max_source_bytes_per_institution": 134217728,
    "max_artifact_html_bytes": 8388608,
    "max_artifact_pdf_bytes": 33554432,
    "max_redirects": 5,
    "max_attempts": 2,
    "html_timeout_ms": 15000,
    "pdf_timeout_ms": 30000,
    "robots_timeout_ms": 10000,
    "institution_deadline_ms": 120000,
    "run_deadline_ms": 86400000,
    "retry_after_cap_ms": 60000,
    "origin_delay_ms": 500
  },
  "transport_cache_policy": "revalidate_conditional",
  "methodology_version": "mortgage-refinancing-scan@1.0.0",
  "created_at": "...",
  "input_fingerprint": "...",
  "environment_fingerprint": {
    "node_version": "...",
    "package_lock_sha256": "...",
    "morfeusz_version": "...",
    "locale": "C.UTF-8",
    "timezone": "UTC"
  }
}
```

Reguły:

- `scope.entries` jest jedynym źródłem par identyfikatorów;
- kolejność wpisów i `scope_sha256` są kanoniczne;
- `scope_sha256` jest hashem canonical JSON uporządkowanych wpisów scope;
- `source_registry_sha256` identyfikuje snapshot listy banków użyty do runu;
- `scope_sha256`, `source_registry_sha256` i `input_fingerprint` są lowercase
  SHA-256 nad UTF-8 canonical JSON według JCS (RFC 8785); ich format nie jest
  dowolny;
- `input_fingerprint` obejmuje wszystkie dane i wersje narzędzi wpływające na
  decyzję, w tym `environment_fingerprint`, ale nie obejmuje `run_id`,
  `created_at` ani metadanych telemetrycznych;
- `input_fingerprint` obejmuje również `transport_cache_policy`, politykę
  ekstrakcji i kluczowe nagłówki requestu; nie obejmuje przypadkowego hit/miss
  cache ani czasu odpowiedzi, jeżeli treść i wersje narzędzi są identyczne;
- `created_at` jest RFC 3339 UTC, a `run_id` spełnia regex
  `^run-[0-9]{8}T[0-9]{6}Z-[a-z0-9]{6,}$`;
- każdy etap odrzuca wpis spoza scope;
- zmiana zakresu tworzy nowy `run_id`;
- `live:false` zabrania requestów sieciowych;
- wszystkie limity użyte przez run są zapisane w manifeście;
- `max_active_institutions` ogranicza pamięć i liczbę aktywnych pipeline'ów;
- `max_http_in_flight` jest limitem globalnym, a `max_in_flight_per_origin`
  i `max_in_flight_per_institution` są limitami lokalnymi;
- opóźnienie originu i `Retry-After` nie zajmują globalnego slotu podczas
  oczekiwania;
- `transport_cache_policy=revalidate_conditional` pozwala używać wyłącznie
  rewalidowanych treści transportowych, nigdy poprzednich decyzji;
- wartości limitów z przykładu są zatwierdzonymi limitami startowymi i muszą
  przejść kalibrację na fixture corpusie przed Fazą 5; zmiana wymaga aktualizacji
  tego planu.

Normatywny schema manifestu musi wymagać wszystkich pól pokazanych powyżej,
ustalić enumy (`mode=full`, `live`, `discovery_policy`,
`transport_cache_policy=revalidate_conditional`), odrzucać nieznane pola oraz
walidować zakresy liczbowe i regexy identyfikatorów. Placeholdery z przykładu
nie mogą występować w faktycznym artefakcie.

Taką samą zasadę strict schema, semver i `additionalProperties=false` stosuje
się do `RunContext`, `RunEvent`, `RunCheckpoint`, `SourceArtifact`,
`EvidenceRecord`, `ProductBundle`, `InterpretationResult`, telemetryki,
publication record i pointera. Wszystkie schema są wersjonowane w
`schemas/*.schema.json`, a wersja artefaktu jest zapisywana w samym artefakcie.

### 4.1.1. `InstitutionRegistrySnapshot`

`prepare` przyjmuje jeden snapshot registry i zapisuje jego niemodyfikowalną
kopię pod runem. Snapshot ma `schema_version`, `snapshot_id`, `source_kind`,
`observed_at` i tablicę `entries`; wszystkie pola są strict schema. Minimalny
rekord banku zawiera:

```json
{
  "entry_id": "bank-001",
  "lp": 1,
  "institution_id": "example-bank",
  "institution_type": "cooperative_bank",
  "legal_name": "Example Bank Spółdzielczy",
  "official_hosts": ["example.test"],
  "allowed_redirect_hosts": ["example.test", "cdn.example.test"],
  "registry_sources": ["bfg", "knf"],
  "observed_at": "2026-08-05T01:02:03Z"
}
```

`source_registry_sha256` jest hashem całego snapshotu, a `scope.entries` jest
wyłącznie jego uporządkowaną projekcją. Po `prepare` żaden etap nie odczytuje
mutowalnego źródła registry. Duplikat `institution_id`, `lp`, hosta albo
sprzeczność BFG/KNF kończy run przed discovery. Redirect poza
`official_hosts`/`allowed_redirect_hosts` jest błędem kontraktu.

### 4.2. `RunContext`

Każde narzędzie otrzymuje jeden jawny kontekst:

```json
{
  "run_id": "...",
  "manifest_path": "data/mortgage-refinancing-scan/work/runs/<run_id>/manifest.json",
  "run_root": "data/mortgage-refinancing-scan/work/runs/<run_id>",
  "registry_snapshot_path": "data/mortgage-refinancing-scan/work/runs/<run_id>/registry.json",
  "source_registry_sha256": "...",
  "scope": { "entries": [] },
  "artifact_root": "data/mortgage-refinancing-scan/work/runs/<run_id>/artifacts",
  "transport_cache_root": "data/mortgage-refinancing-scan/cache/http",
  "normalization_cache_root": "data/mortgage-refinancing-scan/cache/normalized",
  "evidence_path": "data/mortgage-refinancing-scan/work/runs/<run_id>/evidence.jsonl",
  "event_path": "data/mortgage-refinancing-scan/work/runs/<run_id>/events.jsonl",
  "checkpoint_path": "data/mortgage-refinancing-scan/work/runs/<run_id>/checkpoint.json"
}
```

Operacja modyfikująca bez `RunContext` jest błędem kontraktu. Etapy robocze nie
otrzymują ścieżek globalnej publikacji; jawne cache roots są wyłącznie
transportowym/normalizacyjnym cache i podlegają `transport_cache_policy`.

### 4.3. State machine runu

```text
CREATED
  → PREPARED
  → RUNNING
  → READY
  → FINALIZING
  → FINALIZED

Każdy stan niekońcowy → ABORTED przy blockerze lub błędzie kontraktu.
```

Dozwolone przejścia i guardy są następujące:

| Przejście | Warunek wejścia | Warunek sukcesu |
|---|---|---|
| `CREATED → PREPARED` | poprawny `run-init` i immutable manifest | istnieje registry snapshot, scope i event przygotowania |
| `PREPARED → RUNNING` | kompletne scope | każdy wpis ma dokładnie jeden rekord stanu |
| `RUNNING → READY` | zakończone wszystkie etapy wpisów | każdy wpis ma terminalny status biznesowy albo `technical_error`, a checkpoint jest poprawny |
| `READY → FINALIZING` | checkpoint spełnia guardy | kompletny scope, brak błędu fatalnego i poprawne rekordy błędów per wpis |
| `FINALIZING → FINALIZED` | zwalidowany snapshot i publication record | pointer wskazuje kompletny snapshot |
| dowolny stan niekońcowy → `ABORTED` | fatalny błąd, przerwanie lub naruszenie kontraktu | zapisano przyczynę i nie opublikowano danych |

Retry nie tworzy przejścia stanu runu. Zwiększa `attempt`, zapisuje osobny event
i artefakt, a po wyczerpaniu limitu kończy dany wpis jako `technical_error`.
Niepowodzenie pojedynczego źródła nie przerywa innych wpisów. `ABORTED` dotyczy
wyłącznie błędu fatalnego runu, nie może być wznawiany, a ponowienie zawsze
tworzy nowy `run_id`. Projection stanu wpisów
jest wyliczana wyłącznie z eventów i manifestu, a checkpoint wyłącznie z tej
projekcji.

Minimalny `RunEvent` zawiera `event_id`, `run_id`, monotoniczne `sequence`,
`operation_id`, `occurred_at`, `previous_state`, `next_state`, `attempt`,
`input_artifact_ids`, `output_artifact_ids` i `validation_result`. `stage` wpisu
przechodzi niezależnie przez `discovery`, `fetched`, `normalized`, `evidence_ready`
i `interpreted`; run pozostaje w `RUNNING` aż wszystkie wpisy będą terminalne.
`operation_id` zapewnia idempotencję retry, `sequence` wykrywa lukę/duplikat,
a `event_id` jest unikalny w runie. Worker nie zapisuje eventu bezpośrednio:
centralny event writer nadaje monotoniczną sekwencję i wykonuje grupowy zapis
małych rekordów. Kolejność eventów jest audytowa i nie może wpływać na decyzję.
Zapis częściowego eventu jest błędem recovery, nie powodem do cichego usunięcia
lub naprawy rekordu.

Błąd techniczny ograniczony do jednego wpisu kończy ten wpis jako
`technical_error`; agent nie łata danych ani nie tworzy częściowej decyzji dla
tego wpisu, ale kontynuuje niezależne wpisy. Błąd kontraktowy, uszkodzenie
event logu, brak zależności globalnej albo błąd publikacji prowadzi do
`ABORTED`, który nie publikuje żadnego snapshotu. `FINALIZED` może zawierać
`unconfirmed` oraz jawne rekordy `technical_error`; taki run ma
`coverage_status=degraded`. `unconfirmed` oznacza zakończoną analizę bez
wystarczającego dowodu, a `technical_error` oznacza brak zakończonej analizy.

### 4.4. Stan wpisu scope

Każdy wpis ma dokładnie jeden rekord stanu:

```json
{
  "entry_id": "bank-001",
  "lp": 1,
  "institution_id": "example-bank",
  "stage": "interpreted|technical_error",
  "attempt": 1,
  "started_at": "...",
  "finished_at": "...",
  "elapsed_ms": 1234,
  "input_artifact_ids": ["..."],
  "output_artifact_ids": ["..."],
  "decision_status": "qualified",
  "error_code": null,
  "error_message": null,
  "retryable": false
}
```

Brak wpisu albo duplikat wpisu w scope jest błędem przed rozpoczęciem
przetwarzania. Dla `stage=technical_error` `decision_status` ma wartość
`technical_error`, `error_code` i `error_message` są wymagane, a
`output_artifact_ids` nie mogą udawać kompletnej decyzji. Taki wpis jest
terminalny i może zostać opublikowany wyłącznie jako jawny rekord błędu.

### 4.5. `SourceArtifact`

Każdy pobrany materiał jest artefaktem z:

- `artifact_id`, `run_id`, `entry_id`;
- canonicalnym URL-em i typem źródła;
- timestampem pobrania;
- `raw_content_sha256` i rozmiarem;
- content type, kodowaniem, statusem HTTP i redirectami;
- hashem metadanych request/response bez sekretów;
- ścieżką run-local oraz polityką robots;
- informacją o próbie, retry i błędzie.

Treść HTML/PDF pozostaje w cache runu. Dopuszczalny jest również nowy,
content-addressed transport cache poza katalogiem runu, ale wyłącznie po
conditional GET/304 albo po jawnym pobraniu bieżącej treści. `SourceArtifact`
zapisuje `cache_status`, `cache_key` i `cache_lineage`; parser nie może
wskazywać pliku spoza runu bez jawnej deklaracji artefaktu wejściowego.

### 4.6. `EvidenceRecord`

Evidence ma identyfikator deterministyczny:

```text
ev-<sha256(JCS([
  institution_id,
  product_id,
  field_path,
  url,
  content_sha256,
  normalized_excerpt
]))[0:24]>
```

Tablica jest kodowana przez canonical JSON (JCS), aby granice wartości były
jednoznaczne również wtedy, gdy URL albo znormalizowany excerpt zawiera znak
`|`. Nie wolno wracać do konkatenacji pól separatorem.

Minimalne pola:

```json
{
  "evidence_id": "ev-...",
  "run_id": "...",
  "entry_id": "bank-001",
  "institution_id": "example-bank",
  "product_id": "prd-<24hex>",
  "variant_id": "var-<24hex>",
  "field_path": "qualification.refinancing",
  "source_artifact_id": "src-...",
  "url": "https://example.test/offer",
  "content_sha256": "...",
  "excerpt": "...",
  "normalized_excerpt": "...",
  "source_type": "official_product_page",
  "source_locator": {
    "page": null,
    "line_start": 12,
    "line_end": 18,
    "char_start": 320,
    "char_end": 612
  },
  "normalization_version": "morfeusz-2:<version>"
}
```

Evidence jest ważne tylko wtedy, gdy:

- ma bieżący `run_id` i wpis w exact scope;
- URL i hash odpowiadają `SourceArtifact`;
- `field_path` pasuje do kategorii dowodu;
- cytat pochodzi z bieżącego artefaktu;
- `source_locator` wskazuje dokładny fragment HTML/PDF albo jawnie oznacza
  brak pozycji dla artefaktu, który nie ma stabilnych offsetów;
- `field_evidence` wskazuje istniejący rekord.

Mismatch jest odrzucany przed interpretacją. Po `finalize` wykorzystane rekordy
mogą zostać zdeduplikowane wyłącznie w immutable `published/<run_id>/evidence.jsonl`;
MVP nie wykonuje globalnego merge evidence między runami.

Canonicalne klucze kryteriów to wyłącznie `housing`, `refinancing` i
`fixed_rate`. `field_path` ma format `qualification.<criterion>` albo
`offer.<field>`, a suffix musi należeć do tego enumu lub do jawnego enumu pól
ofertowych. Implementer nie może wprowadzać równoległych nazw dla tego samego
kryterium. `content_sha256` evidence musi być hashem surowej treści
`SourceArtifact`, a `normalized_excerpt` jest reprodukowalny według
`normalization_version`. `source_type` jest enumem co najmniej:
`official_product_page`, `official_tariff`, `official_pdf`, `official_form` i
`official_registry`.

### 4.7. `ProductBundle` i `InterpretationResult`

`ProductBundle` grupuje wyłącznie dowody dotyczące tej samej instytucji,
produktu i wariantu:

```text
product_key = institution_id | canonical_product_url |
              normalize(product_name) | audience
product_id  = prd-<sha256(JCS(product_key))[0:24]>
variant_key = product_id | rate_type | fixed_rate_period |
              currency | comparison_context
variant_id  = var-<sha256(JCS(variant_key))[0:24]>
```

Źródła są grupowane tylko przy zgodności tych kluczy i jawnych identyfikatorów
produktu. Keyword-only matching nie tworzy wspólnego bundle.

Grupowanie jest wykonywane przez indeksy `Map` po `product_key` i `variant_key`,
a nie przez porównywanie każdej pary evidence. Zbiór dowodów jest łączony
komutatywnie i sortowany po canonicalnym kluczu przed walidacją, więc wynik nie
zależy od kolejności zakończenia fetchu, normalizacji ani workerów. Identyczne
canonical URL-e i treści są pobierane/normalizowane najwyżej raz w obrębie runu,
po czym mogą być referencjonowane przez wiele wpisów evidence.

```json
{
  "institution_id": "example-bank",
  "product_id": "prd-<24hex>",
  "variant_id": "var-<24hex>",
  "product_name": "Kredyt mieszkaniowy",
  "canonical_product_url": "https://example.test/offer",
  "audience": "consumer",
  "source_artifact_ids": ["src-..."],
  "rate_type": "permanent_fixed|periodically_fixed",
  "criterion_status": {
    "housing": "found|not_found|ambiguous",
    "refinancing": "found|not_found|ambiguous",
    "fixed_rate": "found|not_found|ambiguous"
  },
  "field_evidence": {}
}
```

Wynik interpretera:

```json
{
  "schema_version": "1.0.0",
  "run_id": "...",
  "entry_id": "bank-001",
  "institution_id": "example-bank",
  "decision_status": "qualified",
  "product_bundle": {
    "product_id": "prd-<24hex>",
    "variant_id": "var-<24hex>",
    "product_name": "Kredyt mieszkaniowy",
    "canonical_product_url": "https://example.test/offer",
    "source_artifact_ids": ["src-..."]
  },
  "criterion_status": {
    "housing": "found",
    "refinancing": "found",
    "fixed_rate": "found"
  },
  "qualification": {
    "reason_codes": []
  },
  "offer": {
    "fixed_rate_type": "permanent_fixed|periodically_fixed",
    "comparison_context": {
      "currency": "PLN",
      "representative_amount": null,
      "term_years": null,
      "customer_profile": "consumer_standard",
      "observation_date": "..."
    },
    "fixed_nominal_rate_exact": null,
    "fixed_nominal_rate_min": null,
    "fixed_nominal_rate_max": null,
    "rrso_exact": null,
    "rrso_min": null,
    "rrso_max": null,
    "commission_exact": null,
    "commission_min": null,
    "commission_max": null,
    "fixed_rate_period_years_exact": null,
    "max_loan_term_years": null
  },
  "field_status": {},
  "field_evidence": {},
  "warnings": [],
  "interpreter_version": "..."
}
```

`qualified` wymaga trzech statusów `found`, poprawnego `ProductBundle` i
kompletnych referencji. Brak któregoś dowodu daje `unconfirmed`, nigdy ciche
`qualified`.

`explicitly_not_qualified` wymaga evidence wskazującego jawne wykluczenie
konkretnego kryterium dla tego samego bundle. Sam brak keywordu, brak strony,
`not_found` albo błąd techniczny nie może ustawić `qualifies=false`.

Dla `permanent_fixed` pola okresu stałej stopy są `not_applicable`/puste; dla
`periodically_fixed` zawierają wyłącznie okres stałej stopy. W żadnym wariancie
nie zapisuje się parametrów po zakończeniu stałej stopy.

Jeżeli istnieje kilka kwalifikujących wariantów, wybór jest deterministyczny i
nie zależy od tego, czy oferta jest promocyjna:

1. jeżeli RRSO jest dostępne i porównywalne dla wszystkich porównywanych ofert
   danego banku, wygrywa niższe RRSO;
2. jeżeli nie, RRSO nie bierze udziału w rankingu i porównywane są nominalne
   stopy oprocentowania dla wszystkich ofert;
3. nigdy nie porównuj RRSO z nominalną stopą oprocentowania;
4. przy remisie wygrywa niższa prowizja;
5. następnie wygrywa dłuższy okres stałej stopy; dla stopy bezterminowej okres
   jest traktowany jako nieograniczony;
6. brak porównywalnej wartości albo nierozstrzygalny przypadek daje
   `unconfirmed`.

Implementacja rankingu wykonuje najwyżej dwa liniowe przebiegi po wariantach:
najpierw wyznacza wspólny `comparison_context`, a następnie stosuje powyższy
comparator. Nie wolno stosować reguły „pierwszy ukończony wariant wygrywa” ani
porównania `O(n²)` bez uzasadnienia kontraktowego.

RRSO jest porównywalne tylko przy zgodności `comparison_context`: waluta,
reprezentatywna kwota, okres, profil klienta, data obserwacji i zakres kosztów.
Nominalne stopy podlegają tej samej zasadzie. Nie wolno porównywać wartości
z różnych kontekstów, jednostek ani walut. Zakres liczbowy można uporządkować
automatycznie tylko wtedy, gdy cały zakres jednej oferty jest korzystniejszy
od całego zakresu drugiej; zakresy nachodzące na siebie dają `unconfirmed`.
Stopa ma jednostkę procentową, a prowizja zapisuje jednostkę `percent` albo
`amount` wraz z walutą; mieszanie tych jednostek daje `unconfirmed`.

### 4.8. Model błędów

Kody decyzji biznesowych i kody błędów runu są rozłączne. `DecisionReasonCode`
może uzasadniać `explicitly_not_qualified`/`unconfirmed`, ale nie może oznaczać
błędu technicznego. Błędy mają jawny zakres `entry` albo `run`:

- `EntryRunErrorCode` dotyczy wyłącznie jednego banku, ustawia dla niego
  `technical_error`, pozwala kontynuować niezależne wpisy i nigdy nie ustawia
  `qualifies=false`;
- `FatalRunErrorCode` oznacza naruszenie kontraktu, uszkodzenie wspólnego stanu,
  brak globalnej zależności albo błąd publikacji i kończy cały run jako
  `ABORTED`.

`RetryableRunError` jest klasą przejściową dla 429/5xx/timeout, a nie trzecim
rodzajem finalnego statusu. Po wyczerpaniu prób mapuje się na konkretny
`EntryRunErrorCode` i `technical_error` wpisu.

| Zdarzenie | Klasa | Zachowanie |
|---|---|---|
| brak kryterium, tylko stopa zmienna, własne koszty | `DecisionReasonCode` | wynik biznesowy, bez abortu |
| brak opcjonalnego URL-a, HTTP 404 kandydata | `DiscoveryOutcome` | kandydat odrzucony; brak evidence nie daje `qualified` |
| 429, 5xx, timeout | `RetryableRunError` | retry według manifestu; po limicie `technical_error` tego wpisu |
| robots deny wymaganej ścieżki, niedozwolony redirect/host | `EntryRunErrorCode` | jawny `technical_error` wpisu, bez obchodzenia polityki |
| DNS/TLS/401/403, wymagany source unavailable | `EntryRunErrorCode` | jawny `technical_error` wpisu i telemetryka |
| zły hash/URL/category jednego wpisu | `EntryRunErrorCode` | wpis zatrzymany przed interpretacją jako `technical_error` |
| schema mismatch manifestu/eventu, brak globalnej zależności | `FatalRunErrorCode` | abort przed następnym etapem |
| uszkodzony snapshot/pointer albo błąd I/O publikacji | `FatalRunErrorCode` | recovery albo `ABORTED`, bez publikacji |

Pełna lista enumów `DecisionReasonCode`, `DiscoveryOutcome`,
`EntryRunErrorCode` i `FatalRunErrorCode` jest częścią schema i musi mieć test
dla każdej wartości. Zakres błędu jest zapisywany także w telemetryce i
checkpoint projection.

## 5. Workflow i granica publikacji

### 5.1. Lifecycle

```text
prepare → process → validate → finalize
                         ↘ abort
```

`prepare`:

- tworzy `run_id`, manifest i pełny szkielet wpisów;
- wylicza `scope_sha256` i fingerprint wejścia;
- waliduje kompletność zakresu;
- nie pobiera źródeł i nie publikuje danych.

`process`:

- wykonuje discovery, fetch, normalizację, evidence i interpretację w bounded
  pipeline, równolegle dla niezależnych originów;
- zapisuje wyłącznie artefakty run-local;
- po każdym etapie waliduje kontrakt i zapisuje event przez centralny writer;
- po błędzie ograniczonym do jednego wpisu zapisuje jego `technical_error` i
  zwalnia zasoby dla pozostałych wpisów.

`validate`:

- sprawdza wszystkie wpisy scope;
- sprawdza dowody, bundle, statusy, telemetrykę i checkpoint;
- rozróżnia błędy per wpis od błędów fatalnych runu;
- nie zmienia publikacji.

`finalize`:

1. waliduje wszystkie artefakty i checkpoint;
2. buduje kompletny snapshot w tymczasowym katalogu publikacji, w tym jawne
   rekordy `technical_error` dla wpisów bez decyzji;
3. zapisuje `snapshot.json`, `evidence.jsonl` i `publication.json` oraz ich
   SHA-256;
4. synchronizuje pliki i katalog, a następnie atomowo przenosi kompletny katalog
   do `published/<run_id>/`;
5. zapisuje tymczasowy `current.json` z hashami snapshotu, evidence i publication,
   synchronizuje go i atomowo podmienia aktywny pointer;
6. ponownie odczytuje pointer i dopiero wtedy zapisuje `FINALIZED`.

`abort`:

- zapisuje przyczynę i kończy run jako `ABORTED`;
- nie tworzy published snapshotu, nie zmienia pointera ani żadnego artefaktu
  poza run-local.

Finalize musi być idempotentny dla tego samego `run_id`. Przerwanie przed
podmianą pointera pozostawia poprzedni aktywny snapshot. Przerwanie po podmianie
pointera, ale przed `FINALIZED`, jest recovery, nie drugim publikowaniem: narzędzie
sprawdza hashy pointera, kończy zapis `FINALIZED` albo jawnie oznacza run jako
`ABORTED`, jeżeli snapshot jest niekompletny. Snapshot z kompletnym scope i
jawnymi błędami per wpis jest kompletny, ale ma `coverage_status=degraded`.
MVP nie obsługuje równoległego finalize; druga próba tego samego runu zwraca
istniejący wynik po walidacji hashy.

### 5.2. Checkpoint

Checkpoint jest jedynym źródłem podsumowania finalizacyjnego:

```json
{
  "run_id": "...",
  "scope_count": 5,
  "discovered_count": 5,
  "interpreted_count": 5,
  "terminal_entry_count": 5,
  "qualified_count": 1,
  "unconfirmed_count": 4,
  "technical_error_count": 0,
  "fatal_error_count": 0,
  "status": "ready",
  "coverage_status": "complete"
}
```

Checkpoint jest wyliczany ze stanu wpisów i manifestu. Nie utrzymywać drugiego
niezależnego licznika scope. `status=ready` jest dozwolony przy kompletnym
scope, `fatal_error_count=0` i `technical_error_count=0`. Jeżeli
`technical_error_count>0`, checkpoint
przyjmuje `status=ready_with_errors` i `coverage_status=degraded`; każdy taki
wpis musi mieć error code, brak decyzji biznesowej i brak referencji evidence
udających decyzję. Błąd fatalny lub niekompletny scope blokuje finalizację i
kończy run jako `ABORTED`.

Schema checkpointu wymaga enumów `status=ready|ready_with_errors` oraz
`coverage_status=complete|degraded`; `ready` i `complete` są dozwolone tylko
przy `technical_error_count=0`.

### 5.3. Layout artefaktów

```text
data/mortgage-refinancing-scan/
  base/
    registry-source.json
  cache/
    http/<cache_key>/...
    normalized/<normalization_key>.json
  work/
    runs/<run_id>/
      manifest.json
      registry.json
      events.jsonl
      checkpoint.json
      metrics.json
      evidence.jsonl
      entries/<entry_id>/...
      publication.json
  published/
    <run_id>/snapshot.json
    <run_id>/evidence.jsonl
    <run_id>/publication.json
    current.json
```

`current.json` ma minimalnie `run_id`, `manifest_sha256`, `snapshot_sha256`,
`evidence_sha256`, `publication_sha256`, `coverage_status` i `published_at`.
Każdy hash jest
sprawdzany przed uznaniem runu za `FINALIZED`. Nie istnieje globalny indeks;
wszystkie materialized views są częścią immutable katalogu konkretnego runu.

`publication.json` zawiera ten sam zestaw hashy, `run_id`, `schema_version`,
`published_at`, status publikacji i `coverage_status`. Pointer nie może wskazywać
katalogu bez zgodnego `publication.json`. Opublikowany snapshot może zawierać
rekordy `technical_error`, ale nie może zawierać niezwalidowanej decyzji ani
nieuzasadnionego `qualifies=false`.

`export-workbook` eksportuje również taki rekord, zachowuje jego `error_code` i
`review_status=error`, a pola produktu, oferty i evidence pozostawia puste.

Run nie odczytuje `current.json` do ustalenia bieżącej decyzji. Pointer jest
wyłącznie materializowanym wynikiem publikacji i znajduje się pod dedykowanym
runtime rootem nowego rozwiązania.

### 5.4. State store

**Implementation choice:** MVP używa append-only `events.jsonl` plus
deterministycznie walidowany projection `checkpoint.json` i stan wpisów.
Współbieżne workery przekazują małe eventy do jednego event writera; nie ma
alternatywnego store'u ani drugiej ścieżki implementacyjnej.

Agent może wybrać szczegóły mechaniki zapisu i format identyfikatorów eventów,
ale nie może zmienić inwariantów:
append-only, brak dwóch logicznych przejść dla jednego retry, monotoniczna
kolejność nadawana przez writer, wykrywanie częściowego zapisu, deterministyczny
replay projection oraz jawny recovery albo `ABORTED` po uszkodzeniu. Group commit
jest dozwolony dla eventów i telemetryki, o ile po awarii częściowy rekord jest
wykrywany, a nie cicho pomijany.

## 6. Research i polityka zasobów

### 6.1. Źródła instytucji

- BFG jest podstawowym źródłem listy banków spółdzielczych;
- KNF jest źródłem kontrolnym dla banków spółdzielczych;
- kompletność listy, duplikaty i identyfikatory są walidowane przed runem;
- dowód kwalifikacji musi pochodzić z oficjalnego źródła instytucji.

### 6.2. Discovery i fetch

Proponowany MVP używa bounded concurrent HTTP fetchu i Cheerio. Requesty do
jednego originu są sekwencyjne i podlegają throttlingowi, natomiast niezależne
originy są obsługiwane równolegle przez jawny scheduler:

- jawny User-Agent;
- `robots.txt` i sitemap jako ograniczenie discovery;
- wyłącznie `official_hosts` oraz `allowed_redirect_hosts` z registry snapshotu;
- brak `robots.txt` jest obsługiwany według jawnej polityki manifestu, a deny/error
  dla wymaganej ścieżki jest `EntryRunErrorCode`;
- scheduler prowadzi osobną kolejkę per origin, respektuje
  `max_in_flight_per_origin` i `origin_delay_ms`, a oczekiwanie na
  `Retry-After` zwalnia globalny slot;
- `max_active_institutions` ogranicza liczbę aktywnych pipeline'ów i pamięć;
- robots, sitemapę i identyczne canonical URL-e deduplikuje w obrębie runu;
- URL-e są canonicalizowane i priorytetowane deterministycznie, ale niski score
  nie usuwa kandydata bez sprawdzonej reguły recall; przy niepełnym dowodzie
  uruchamiany jest fallback do pozostałych kandydatów;
- strumieniowy zapis i hash surowych bajtów bez buforowania całych HTML/PDF w RAM;
- limit redirectów;
- telemetryka każdego requestu;
- zamknięcie discovery po pełnym dowodzie, wykluczeniu, wyczerpaniu grafu albo
  timeoutcie.

Canonicalizacja usuwa fragment, normalizuje host/port i rozstrzyga redirecty
wyłącznie w ramach allowlisty. Strona wymagająca JavaScript/renderowania
przeglądarkowego nie jest cicho zastępowana innym źródłem; zostaje jawnie
sklasyfikowana.

Transport cache jest content-addressed i używany między runami wyłącznie przez
conditional GET. `ETag`/`Last-Modified` i odpowiedni `Vary` są częścią klucza
cache; odpowiedź `304` pozwala ponownie użyć bajtów i artefaktu normalizacji,
ale tworzy nowy run-local `SourceArtifact` z lineage i eventem. Brak validatora
albo odpowiedź `200` wymaga pobrania i zahashowania bieżącej treści. Stary
materiał bez rewalidacji nie może wpływać na decyzję.

Scheduler używa keep-alive/connection pooling per origin, nie uruchamia requestu
do niedozwolonego hosta i nie trzyma globalnego workera podczas snu retry.
Współbieżność może zmieniać czas zakończenia, ale nie może zmieniać zbioru
artefaktów, evidence, decyzji ani rankingu.

Morfeusz 2 jest wymaganym etapem normalizacji. Artefakt normalizacji przechowuje
tokeny, lematy, offsety, wersję narzędzia i hash wejścia. Normalizacja jest
deterministyczna i cache'owana po kombinacji `content_sha256`, wersji Morfeusza,
locale oraz polityki ekstrakcji. Workerzy normalizacji są rozgrzani i ograniczeni przez
`max_normalization_workers`; nie uruchamia się nowego procesu dla każdego
artefaktu. Wyniki są zapisywane w canonicalnym porządku po hash'u, niezależnie
od kolejności ukończenia workerów.

Przed runem wykonywany jest preflight dostępności Morfeusza 2. Wersja
interpretera i wersja biblioteki są zapisywane w manifeście; brak wymaganej
zależności przerywa run i nie uruchamia cichego fallbacku.

### 6.3. Proponowane limity MVP

| Parametr | Propozycja |
|---|---:|
| `max_active_institutions` | `24` |
| `max_http_in_flight` | `24` |
| `max_in_flight_per_origin` | `1` |
| `max_in_flight_per_institution` | `1` |
| `max_normalization_workers` | `4` |
| `max_event_batch_size` | `64` |
| maks. requestów discovery na instytucję | `256` |
| maks. łączny rozmiar źródeł na instytucję | `128 MiB` |
| timeout HTML | `15 s` |
| timeout PDF | `30 s` |
| deadline instytucji | `120 s` |
| maks. artefakt HTML | `8 MiB` |
| maks. artefakt PDF | `32 MiB` |
| maks. redirectów | `5` |
| maks. prób | `2` |
| backoff | `1 s`, `5 s` |
| limit `Retry-After` | `60 s` |
| opóźnienie per origin | `500 ms` |
| timeout robots | `10 s` |
| deadline całego runu | `24 h` |

Wartości są zatwierdzone jako bezpieczny profil startowy i w każdym runie są
zapisywane w manifeście. Są to bezpieczniki, nie kryteria obcinania normalnego
przebiegu: limity per origin i globalne ograniczają scheduler, a przekroczenie
limitu treści/requestów kończy tylko właściwy wpis jako `technical_error`, o ile
nie jest to błąd kontraktowy. Profil musi zostać skalibrowany na reprezentatywnym
corpusie tak, aby nie odrzucać standardowych stron bankowych.

### 6.4. Retry i błędy

- 429, 5xx i timeout mogą być retryable według limitu manifestu;
- `Retry-After` jest respektowany z limitem;
- 404 opcjonalnego kandydata jest `DiscoveryOutcome`, ale brak wymaganego
  źródła, trwały błąd robots i nieobsługiwany format są `EntryRunErrorCode`;
- po wyczerpaniu prób wpis otrzymuje `technical_error`, a scheduler zwalnia jego
  zasoby i kontynuuje niezależne wpisy; nie wolno kontynuować na częściowym
  materiale tego wpisu ani mapować błędu na `false`;
- uszkodzenie wspólnego event logu, manifestu, schematu lub publication jest
  `FatalRunErrorCode` i kończy run jako `ABORTED`;
- retry nie tworzy drugiego `entry_id` ani nie zmienia scope;
- każdy retry ma osobny event i powiązane artefakty.

### 6.5. Optymalizacje bez pogorszenia wyników

Poniższe optymalizacje są częścią MVP. Ich celem jest skrócenie czasu zdrowego
runu dla około 500 banków, bez zmiany kontraktu kwalifikacji ani rankingu.

1. **Współbieżność między originami.** Scheduler może obsługiwać wiele
   niezależnych banków równolegle, ale zachowuje `max_in_flight_per_origin=1`,
   `max_in_flight_per_institution=1`, `origin_delay_ms` i osobne kolejki retry.
   Limit globalny oraz liczba aktywnych instytucji są jawne w manifeście.

2. **Rewalidowany HTTP cache.** `ETag`/`Last-Modified`/`Vary` pozwalają na
   `304` i ponowne użycie bajtów oraz normalizacji. Cache nie może dostarczyć
   decyzji ani starego evidence bez bieżącej rewalidacji; każdy run otrzymuje
   własny `SourceArtifact` i lineage.

3. **Pipeline z bounded queues.** Discovery, fetch, normalizacja, evidence i
   interpretacja pracują jako nakładające się etapy per bank. Kolejki mają limit,
   a zapis artefaktów i eventów ma backpressure; nie wolno tworzyć zadań dla
   całego grafu w pamięci.

4. **Priorytetowanie discovery bez utraty recall.** URL-e z sitemap i stron
   oficjalnych są canonicalizowane, deduplikowane i porządkowane po stabilnym
   score. Score zmienia wyłącznie kolejność. Kandydat może zostać pominięty
   dopiero po udowodnieniu kompletności dowodu albo po jawnej regule fallbacku;
   nie wolno zamienić niskiego score na negatywną decyzję.

5. **Deduplikacja i ciepła normalizacja.** Robots, sitemap, canonical URL-e,
   treści po hash'u oraz artefakty Morfeusza są współdzielone w zakresie
   dozwolonym przez klucze cache. Workerzy Morfeusza pozostają uruchomieni,
   a artefakty są zapisywane i linkowane canonicalnie.

6. **Liniowe, niezależne od kolejności przetwarzanie.** Product bundle buduje
   indeks `Map`, evidence jest scalane komutatywnie, a ranking wykonuje najwyżej
   dwa liniowe przebiegi po porównywalnych wariantach. Wynik jest identyczny dla
   sekwencyjnego i współbieżnego zakończenia tych samych artefaktów.

7. **Strumieniowe I/O i walidacja.** HTML/PDF są hashowane i zapisywane
   strumieniowo. Ajv kompiluje schema raz na proces, duże treści nie są kopiowane
   przez kolejne etapy, evidence przechowuje excerpt/locator, a event writer
   stosuje bezpieczny group commit. Finalize nie wykonuje ponownego fetchu ani
   wielokrotnego parsowania całego materiału.

Bezpieczność tych optymalizacji jest sprawdzana przez differential replay:
ten sam corpus artefaktów musi dać identyczny `decision_status`,
`product_id`/`variant_id`, ranking i referencje evidence niezależnie od
harmonogramu workerów. W live runie brak odpowiedzi, timeout lub limit nie może
być zamieniony na `explicitly_not_qualified`; kończy tylko właściwy wpis jako
`technical_error`, jeżeli nie jest błędem fatalnym runu.

Cel wydajnościowy jest mierzony jako SLO zdrowego runu, a nie gwarancja dla
nieosiągalnych originów: początkowy profil 24 aktywnych instytucji i 24
globalnych requestów HTTP powinien zostać skalibrowany na 500-entry load test.
Telemetryka musi obejmować wall-clock, p50/p95 czasu wpisu, liczbę requestów,
304/cache hit rate, bytes, 429/5xx, CPU, RAM, opóźnienie event writera i różnice
decyzji względem sekwencyjnego baseline'u.

#### Formalne SLO `SLO-500-P90-15M`

Normatywnym celem dla zdrowego pełnego runu jest `p90(run_wall_clock) <= 900000 ms`
dla exact scope 500 instytucji. `run_wall_clock` mierzy czas od
przejścia `PREPARED → RUNNING` do `FINALIZED` i obejmuje discovery, fetch,
normalizację, evidence, interpretację, walidację i finalize; nie obejmuje
instalacji zależności, ręcznego audytu ani eksportu XLSX.

Profil referencyjny `healthy-500` musi spełniać łącznie:

- średnio nie więcej niż 12 operacji HTTP na instytucję, z zachowaniem pełnych
  reguł discovery i fallbacku;
- nie więcej niż 10 wpisów scope korzystających z jednego originu;
- p95 czasu odpowiedzi requestu nie większy niż 3 s dla HTML/robots i 10 s dla
  PDF;
- nie więcej niż 5% odpowiedzi retryable oraz `Retry-After` nie dłuższy niż 10 s;
- profil zasobów z manifestu: 24 aktywne instytucje, 24 globalne requesty,
  jeden request per origin i `origin_delay_ms=500`.

SLO jest uznane za spełnione po co najmniej 30 powtórzeniach benchmarku T15,
wykonanych na tym samym profilu obciążenia i z raportowanym p90. Każde
powtórzenie musi mieć `coverage_status=complete`, `fatal_error_count=0` oraz
identyczne decyzje, bundle, ranking i referencje evidence względem
sekwencyjnego baseline'u. Run z `coverage_status=degraded` jest raportowany
osobno i nie może służyć do zaliczenia zdrowego SLO.

Profil awaryjny z błędami per wpis nie ma obietnicy p90 15 minut; obowiązuje w
nim jednak brak fałszywych `false`, jawny `technical_error` oraz brak abortu z
powodu błędu ograniczonego do jednej instytucji.

## 7. Interpretacja deterministyczna

MVP używa wyłącznie deterministycznego `interpret.mjs`, który otrzymuje
zwalidowane evidence, grupuje `ProductBundle`, ocenia trzy kryteria, wybiera
ofertę i zwraca strict `InterpretationResult`.

Jeżeli evidence nie pozwala na pewny werdykt albo porównanie ofert, wynik jest
`unconfirmed`. Nie wolno zgadywać ani oznaczać `qualified` bez kompletu dowodów.
Interpreter uruchamia się dopiero po zamknięciu zakresu evidence danego wpisu;
otrzymuje dane posortowane canonicalnie i nie może zależeć od kolejności
ukończenia źródeł. Wpis `technical_error` nie jest przekazywany jako częściowy
ReviewContext.

## 8. Narzędzia z pojedynczą odpowiedzialnością

| Narzędzie | Odpowiedzialność | Zapis |
|---|---|---|
| `run-init` | manifest i szkielet scope | run-local |
| `run-state` | eventy, projekcja wpisów, checkpoint i telemetryka | run-local |
| `institution-list` | BFG + kontrola KNF | artefakt runu |
| `source-discovery` | deterministyczny graf oficjalnych stron, ranking URL-i i fallback | run-local |
| `source-fetch` | scheduler, pobranie, rewalidowany cache, hash, robots, retry | run-local + transport cache |
| `normalize` | Morfeusz 2, ciepły worker pool i artefakt lematyzacji | run-local + normalization cache |
| `evidence` | budowa, walidacja i serializacja evidence | run-local |
| `interpret` | ReviewContext, bundle, kryteria, ranking i strict output | run-local |
| `finalize` | snapshot, publication record i atomowy pointer | publikacja |
| `abort` | końcowy status bez publikacji | run-local |
| `run-audit` | read-only kontrola zgodności | brak |
| `export-workbook` | eksport snapshotu do XLSX | plik eksportowy |

Każde narzędzie przyjmuje `--run-manifest`, poza `run-init`, który manifest
tworzy. Żadne narzędzie run-local nie ma opcjonalnego zastępczego globalnego
pathu.

## 9. Kolejność implementacji i gate'y

### Faza 0 — akceptacja kontraktu

- zatwierdzenie zakresu instytucji;
- zatwierdzenie enumów i mapowania `qualifies`;
- potwierdzenie zamkniętej polityki: `technical_error` jest błędem per wpis,
  pozwala na `FINALIZED` z `coverage_status=degraded`, natomiast tylko
  `FatalRunErrorCode` daje `ABORTED`;
- zatwierdzenie kontraktu append-only JSONL;
- zatwierdzenie limitów zasobów i origin-aware schedulera;

Warunkiem wejścia do Fazy 1 jest usunięcie lub niedostępność poprzednich
rozwiązań dla implementera. Implementer otrzymuje wyłącznie ten plan, zamknięte
schema i materiały wymagane przez bieżący run.

**Gate:** PASSED — decyzje z rozdziału 11 są zamknięte w tym dokumencie.

### Faza 1 — schematy i walidatory

- `RunManifest` i canonicalizacja scope;
- `RunContext`, `RunEvent`, `RunCheckpoint`;
- `SourceArtifact`, `EvidenceRecord`, `ProductBundle`;
- `InterpretationResult` i schema telemetryki;
- walidatory `run_id`, scope, statusów, hashy, URL-i i kategorii.

**Gate:** walidator odrzuca obcy wpis, duplikat, brak taska, zły hash,
nielegalne przejście, brak evidence i dodatkowe pola JSON.

### Faza 2 — core lifecycle

- run-local event store;
- atomowy zapis stanu wpisów;
- retry i abort;
- bounded concurrency, per-origin throttling i centralny event writer;
- fault injection dla każdego przejścia;
- checkpoint z jednego źródła;
- immutable snapshot i atomowy pointer;
- recovery po przerwaniu finalize.

**Gate:** jeden offline run przechodzi od `run-init` do `abort` lub `finalize`
bez ręcznej edycji artefaktów, a pełna macierz testów entrypointów jest zielona.

### Faza 3 — deterministic research vertical slice

Fixture musi obejmować:

- kwalifikację pozytywną;
- wykluczenie refinansowania własnych kosztów;
- produkt mieszkaniowy bez refinansowania;
- wariant tylko zmienny;
- różne produkty z pojedynczymi kryteriami, które nie mogą zostać zsumowane;
- HTML/PDF, kodowanie UTF-8, robots allow/deny, host/redirect mismatch,
  404 kandydata, 401/403, 429, 5xx i timeout;
- wiele wpisów korzystających z jednego originu, deduplikacja canonical URL-i,
  streaming limits i rewalidacja `304`;
- Morfeusz 2, hash treści i deterministyczne evidence.

**Gate:** zero sieci w fixture, brak publikacji po abort, pełna telemetryka i
zgodność checkpointu.

### Faza 4 — interpretation vertical slice

- celowany `ReviewContext`;
- interpreter deterministyczny;
- strict schema outputu;
- brak evidence albo mismatch przed wywołaniem interpretera;
- jawny wynik `unconfirmed` dla nierozstrzygalności.

**Gate:** `qualified` nie przechodzi bez trzech dowodów tego samego bundle.

### Faza 5 — controlled live run

- dokładnie jawny, mały scope;
- ręczny audyt wszystkich evidence;
- porównanie czasu, statusów i outputu z fixture;
- publikacja po `ready` albo `ready_with_errors`, wyłącznie przy kompletnym
  scope, zerowym błędzie fatalnym i jawnych rekordach błędów per wpis.

**Gate:** zero błędów kontraktu, kompletna telemetryka, poprawna izolacja runu
i odtwarzalny snapshot. Błędy techniczne wpisów są dozwolone wyłącznie, gdy są
widoczne w snapshotcie i nie są mapowane na `false`. `T14` i `T15` muszą
przejść, a próg false-negative gold setu musi być zamknięty przed uruchomieniem
pełnego scope.

### Faza 6 — pełny raport

- pełny manifest z listą instytucji;
- bounded pipeline z równoległością między originami i sekwencyjnym throttlingiem
  per origin;
- pomiar czasu, cache hit/304, requestów, bytes, CPU/RAM, błędów i coverage;
- analiza bottlenecków i jakości per instytucja;
- eksport XLSX z opublikowanego snapshotu;
- read-only audit po publikacji.

## 10. Testy i kryteria done

### 10.1. Testy automatyczne

Vitest powinien pokrywać:

- canonical scope hash i izolację runów;
- przejścia uproszczonej state machine, eventy i idempotencję;
- kompletność wpisów;
- retry, timeout i robots;
- hash/URL/category mismatch evidence;
- bundle i reguły kwalifikacji;
- zakaz przenoszenia danych po stałej stopie;
- poprawne kodowanie i lematyzację;
- checkpoint, telemetrykę i rozbieżności liczników;
- origin-aware scheduler, fair queueing, deduplikację URL-i i zwalnianie slotu
  podczas retry/backoff;
- conditional GET/304, lineage transport cache i cache normalizacji Morfeusza;
- bounded pipeline, streaming dużych artefaktów i group commit eventów;
- identyczność decyzji względem sekwencyjnego baseline'u niezależnie od kolejności
  ukończenia workerów;
- przerwanie w każdym kroku finalize;
- brak globalnych zmian po abort;
- niezależne runy z osobnymi katalogami;
- nierozstrzygalność bez zgadywania;
- eksport z jednego snapshotu.

Agent może dobrać konkretne pliki, fixture'y i harness testowy podczas
implementacji. Plan określa jednak obowiązkowe zachowania, których testy muszą
dowodzić: błąd per wpis tworzy jawny `technical_error` bez publikowania fałszywej
decyzji, błąd fatalny prowadzi do abortu, abort nie publikuje danych, pełny run nie
czyta poprzednich decyzji, a wybór najtańszej oferty ignoruje flagę promocji,
porównuje RRSO tylko wtedy, gdy jest dostępne dla wszystkich porównywanych ofert
i nigdy nie miesza RRSO z nominalną stopą. Zielony test nie może być osiągany
przez osłabienie kontraktu.

Macierz testów musi pokrywać każdy produkcyjny skrypt `.mjs` co najmniej jednym
znaczącym testem. Nie wolno zakończyć fazy ani uznać implementacji za gotową,
jeżeli którykolwiek entrypoint lub nietrywialny moduł produkcyjny nie ma
przypisanego i przechodzącego testu.

Kontrakt runnera należy sprawdzać przez `opencode debug agent`. Testy live nie
są częścią MVP i nie mogą zastępować testów offline.

### 10.2. Obowiązkowa macierz testów

Macierz jest zapisywana w
`.agents/skills/mortgage-refinancing-scan/tests/test-matrix.json`. Każdy wiersz
ma `test_id`, skrypt, klasę testu, fixture/input, oczekiwany output, exit code i
artefakty do sprawdzenia. Jeden wiersz może pokrywać kilka funkcji wewnętrznych,
ale każda nietrywialna funkcja `lib/*.mjs` musi być wymieniona w mapowaniu
testu. Minimalny zakres:

| Test ID | Skrypt | Obowiązkowy zakres |
|---|---|---|
| `T01` | `run-init.mjs` | CLI bez manifestu, registry snapshot, immutable manifest, brak sieci |
| `T02` | `run-state.mjs` + `lib/run-contract-validate.mjs` | schema/enumy/hashy, uproszczone przejścia, concurrent event writer, checkpoint, telemetryka i retry |
| `T03` | `institution-list.mjs` | BFG/KNF fixture, deduplikacja, konflikt registry, allowlist hostów |
| `T04` | `source-discovery.mjs` | sitemap, robots, canonicalizacja, deterministic tiers/fallback, redirect poza allowlistą, JS-shell i limity URL |
| `T05` | `source-fetch.mjs` | 404 kandydata, 401/403, 429, 5xx, timeout, retry, 304/cache lineage, shared-origin throttling, limity bytes i telemetryka |
| `T06` | `normalize.mjs` | UTF-8, Morfeusz preflight/brak zależności, offsety, warm workers, cache po hash'u i powtarzalność |
| `T07` | `evidence.mjs` | hash/URL/category/locator mismatch, enumy i deterministyczne ID |
| `T08` | `interpret.mjs` + moduły `review-context`, `interpretation-validate`, `offer-select` | ReviewContext, strict schema, bundle, trzy kryteria, negatywy, oba typy stopy, ranking i zakresy |
| `T09` | `finalize.mjs` | awaria po każdym kroku, hash pointera, idempotencja, recovery i `ready_with_errors` |
| `T10` | `abort.mjs` | reason/error code, brak zmian w published i brak globalnej publikacji |
| `T11` | `export-workbook.mjs` | eksport wyłącznie ze snapshotu/pointera oraz blokada niekompletnego snapshotu |
| `T12` | `run-audit.mjs` | mismatch manifestu, snapshotu, evidence, publication i pointera; po MVP |
| `T13` | `mortgage-refinancing-scan-runner` | `opencode debug agent`, argumenty, exit code, signal abort, permissions i brak decyzji w prompt |
| `T14` | `gold-set` | oczekiwany status, bundle, ranking i evidence dla każdego przypadku domenowego |
| `T15` | `resource-benchmark` | 100-URL extraction corpus oraz co najmniej 30 powtórzeń 500-entry load testu profilu `healthy-500`: SLO `p90(run_wall_clock) <= 900000 ms`, cache/304, requesty, bytes, CPU/RAM, 429/5xx, event lag i parity decyzji |

Macierz musi zawierać również scenariusze przekrojowe: `live:false` bez żadnego
requestu, niezależne runy z osobnymi katalogami, brak legacy decision state,
pełny scope banków spółdzielczych, wiele banków na jednym originie, wpisy z
`technical_error` finalizowane w `ready_with_errors` oraz deterministyczny replay
z tych samych artefaktów.

Canonicalny gate QA uruchamia z katalogu skilla `npm test -- --run` oraz walidator
kompletności `test-matrix.json`. Każdy brakujący, pominięty albo nieprzechodzący
wiersz zwraca kod niezerowy i blokuje kolejną fazę.

Gold set ma twardy zakaz false-positive `qualified`: żadna oferta bez trzech
dowodów tego samego bundle nie może zostać zakwalifikowana. Każdy przypadek ma
oczekiwany `decision_status`, `product_id`, `variant_id`, ranking i referencje
evidence. False-negative pozostaje jawnie raportowany jako `unconfirmed`; przed
Fazą 5 wymagane jest co najmniej 90% recall dla przypadków gold setu, które
powinny być `qualified`. Żadna optymalizacja nie może obniżyć recall ani zmienić
decyzji względem sekwencyjnego baseline'u na tym samym corpusie; replay musi
wykazać identyczność statusów, bundle, rankingu i evidence.

### 10.3. Kryteria done

Plan i implementacja są gotowe dopiero, gdy:

- każdy etap ma jawny input/output i `RunContext`;
- każdy wpis manifestu ma jeden terminalny wynik biznesowy albo jawny
  `technical_error`; tylko błąd fatalny kończy run jako abort;
- każdy produkcyjny skrypt `.mjs` ma znaczący, przechodzący test automatyczny;
- każdy wiersz `test-matrix.json` jest wykonywany w wymaganej komendzie QA;
- checkpoint jest wyliczany z jednego źródła;
- evidence mismatch jest wykrywany przed interpretacją;
- `qualified` wymaga trzech dowodów jednego bundle;
- brak danych nigdy nie staje się automatycznie `false`;
- retry, limity, czas i zasoby są jawne;
- abort nie publikuje danych;
- każdy błąd fatalny lub kontraktowy kończy run jako `ABORTED`, a błąd per wpis
  jest widoczny w snapshotcie i nie staje się `false`;
- pełny run jest niezależny od poprzednich decyzji, ale może używać wyłącznie
  rewalidowanego transport cache i cache normalizacji;
- bounded concurrency, pipeline, deduplikacja i strumieniowe I/O przechodzą
  benchmark 500-entry oraz differential replay;
- `SLO-500-P90-15M` jest spełnione dla profilu `healthy-500` w co najmniej 30
  powtórzeniach T15, przy `coverage_status=complete` i pełnej parity decyzji;
- implementacja nie ma żadnej ścieżki legacy ani kompatybilności wstecznej;
- finalize jest idempotentny i odporny na przerwanie;
- aktywny snapshot wskazuje kompletny i zwalidowany run;
- kontrolowany live run przechodzi przed pełnym raportem;
- XLSX nie jest wymagany do odtworzenia decyzji.

## 11. Zatwierdzone decyzje

Poniższe wartości są obowiązującym kontraktem implementacji.

| Temat | Zatwierdzenie |
|---|---|
| Event store | append-only `events.jsonl` i projection z sekcji 5.4 |
| `technical_error` | błąd ograniczony do wpisu daje jawny rekord `technical_error`; run może zostać `FINALIZED` z `coverage_status=degraded`; tylko `FatalRunErrorCode` daje `ABORTED` |
| SLO zdrowego runu | `SLO-500-P90-15M`: p90 pełnego runu 500 instytucji `<=900000 ms` w profilu `healthy-500`; minimum 30 powtórzeń T15, `coverage_status=complete` i parity względem baseline'u |
| Zakres instytucji | wyłącznie banki spółdzielcze |
| Typ stopy | `permanent_fixed` albo `periodically_fixed` |
| Przyrostowość | każdy pełny run jest niezależny od poprzednich decyzji; dozwolony jest wyłącznie rewalidowany transport/normalization cache |
| Legacy/kompatybilność | zero legacy, zero migracji, zero kompatybilności |
| Najtańsza oferta | RRSO tylko gdy jest porównywalne dla wszystkich ofert banku; w przeciwnym razie nominalna stopa; nigdy mieszanie RRSO z nominalną stopą; promocja nie wpływa na wybór |
| Współbieżność | `max_active_institutions=24`, `max_http_in_flight=24`, `max_in_flight_per_origin=1`, `max_in_flight_per_institution=1`; `origin_delay_ms=500` |
| Retry | maks. 2 próby, backoff `1s/5s` |
| Limity fetchu | HTML `8 MiB`, PDF `32 MiB`, redirecty `5`, discovery `256` requestów i `128 MiB` źródeł na bank |
| Timeouty | HTML `15s`, PDF `30s`, robots `10s`, instytucja `120s`, run `24h` |
| Canonicalizacja | JCS + SHA-256 lowercase dla hashy kontraktowych |
| Jakość gold set | zero false-positive `qualified`; co najmniej 90% recall oraz brak regresji względem sekwencyjnego baseline'u |

Implementacja pozostaje całkowicie niezależna od jakiegokolwiek poprzedniego
rozwiązania zgodnie z zasadą `Zero legacy`.

## 12. Protokół zatwierdzenia

Plan jest zatwierdzony do implementacji. Następny krok to rozpoczęcie Fazy 1.
Live run pozostaje zabroniony do czasu spełnienia gate'ów Faz 2–5. Każda zmiana
zamkniętego kontraktu wymaga aktualizacji tego dokumentu przed implementacją.
