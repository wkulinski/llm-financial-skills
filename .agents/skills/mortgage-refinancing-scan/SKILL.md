---
name: mortgage-refinancing-scan
description: Standalone contract foundation for the exact-scope mortgage refinancing scan of Polish cooperative banks.
---

# mortgage-refinancing-scan

Źródłem prawdy dla tego skilla jest
`docs/bank-market-scan-core-reboot-plan.md`. Runtime używa wyłącznie
dedykowanego katalogu `data/mortgage-refinancing-scan/` i nie korzysta z
legacy decision state.

## Faza 1, Faza 2, Faza 3, Faza 4, Faza 5 i Faza 6

Faza 1 dostarcza strict JSON Schema 2020-12, walidację Ajv 8 oraz walidatory
semantyczne dla manifestu, kontekstu, eventów, checkpointu, source artifacts,
evidence, product bundles, wyników interpretacji, telemetryki, registry, stanu
wpisu, snapshotu i publikacji.

`entry_outcome` rozróżnia `business_decision`, `external_source_error` i
`internal_error`; `decision_status` pozostaje wyłącznie decyzją biznesową, a
`technical_error` jest wewnętrznym terminalnym markerem lifecycle'u. Pole
`qualifies` nie jest zapisywane w canonicalnym wyniku, a exporter wylicza je z
`decision_status`. Błędy fatalne runu są osobnym `FatalRunErrorCode`.

Faza 2 dodaje wyłącznie core lifecycle: `run-init.mjs`, `run-state.mjs`,
`finalize.mjs` i `abort.mjs`. Run ma append-only `events.jsonl`, centralnego
event writera, atomowe projekcje wpisów, retry, bounded origin-aware scheduler,
checkpoint wyliczany z jednej projekcji oraz immutable publication pointer.
Finalize jest idempotentny i potrafi dokończyć publikację po przerwaniu po
podmianie pointera. `live:false` nie wykonuje żądań sieciowych.

Faza 3 dodaje offline, fixture-backed vertical slice badań:

- `institution-list.mjs` scala i kontroluje źródła BFG/KNF bez rozwiązywania
  konfliktu przez wybór jednej strony;
- `source-discovery.mjs` wykonuje canonicalizację URL-i, deduplikację,
  deterministic tiers, robots, allowlistę hostów, fallback i limity;
- `source-fetch.mjs` pobiera wyłącznie odpowiedzi z jawnego fixture'u, zapisuje
  `SourceArtifact`, obsługuje retry 429/5xx/timeout, limity, redirecty i
  rewalidowany transport cache 304;
- `normalize.mjs` wymaga Morfeusza 2 w domyślnej ścieżce, zapisuje tokeny,
  lematy, offsety i cache; `--engine fixture` jest wyłącznie jawnym trybem
  testowym offline i nie jest fallbackiem produkcyjnym;
- `evidence.mjs` tworzy wyłącznie source-bound evidence po walidacji hashy,
  URL-i, locatorów, kategorii i deterministycznego ID.

Żaden z tych etapów nie interpretuje decyzji biznesowej. Wpis kończący się
błędem technicznym dostaje jawny `technical_error`; poprawny wpis pozostaje na
`evidence_ready` do czasu Fazy 4. Wszystkie artefakty są run-local, a fixture
nie wykonuje żądań sieciowych.

Faza 4 dodaje deterministyczny etap `interpret.mjs`:

- `review-context.mjs` zamyka exact-scope evidence po walidacji źródeł, hashy i
  kategorii; interpreter nie otrzymuje surowych artefaktów ani wpisów
  `technical_error`;
- `interpretation.mjs` grupuje dowody dla tego samego produktu i wariantu,
  ocenia `housing`, `refinancing` i `fixed_rate` oraz tworzy strict
  `InterpretationResult`; odległe kryteria z jednej oficjalnej strony pozostają
  jednym provisional source-page bundle, ale kryteriów nie wolno łączyć między
  różnymi canonicalnymi stronami produktów;
- `offer-select.mjs` wykonuje deterministyczny ranking RRSO/nominalnej stopy,
  prowizji i okresu stałej stopy; promocja nie jest tie-breakerem, a brak
  porównywalności daje `unconfirmed`;
- mismatch evidence kończy tylko właściwy wpis jako jawny `internal_error`,
  natomiast brak zamkniętych dowodów lub split kryteriów między bundle'ami daje
  `unconfirmed`; `explicitly_not_qualified` wymaga jawnego, source-bound
  dowodu negatywnego, a nie samego braku kompletnego bundle'a.

Faza 5 dodaje controlled runner i jawny transport live:

- `tools/runner.mjs` przyjmuje immutable registry snapshot, `--run-root`,
  `--mode full` i `--live`; uruchamia publiczne entrypointy w ustalonej
  kolejności i kończy run wyłącznie przez `finalize.mjs` albo `abort.mjs`;
- `live:true` odkrywa wyłącznie oficjalny host z registry, respektuje jawne
  reguły robots, allowlistę redirectów, limity, retry, timeouty, scheduler i
  rewalidowany transport cache; warianty hosta z/bez prefiksu `www` są
  równoważne, a brak/błędny/niedostępny `robots.txt` oznacza `unavailable` i
  nie blokuje dalszego discovery; redirect strony głównej poza granicę hosta
  kończy wpis jako `technical_error`, pojedynczy błąd opcjonalnej strony jest
  pomijany, a dwa niezależne takie błędy kończą wpis jako `technical_error`;
  nie przyjmuje fixture'u;
- live evidence jest budowane z bieżącego, znormalizowanego tekstu i pozostaje
  source-bound; brak pełnych trzech kryteriów daje `unconfirmed`, nigdy ciche
  `qualified`;
- adaptacyjna selekcja wybiera required/high-value candidates w batchach, ale
  zatrzymuje się wcześnie tylko po znalezieniu trzech kryteriów oraz jednej
  porównywalnej stopy w jednym source-page bundle; split signals nie kończy
  fetchu;
- `live:false` pozostaje twardym trybem offline i wymaga jawnego fixture'u.
  Raport runnera zawiera checkpoint, core/research telemetrykę, statusy wpisów,
  evidence count i pointer publikacji albo powód abortu.

CLI przyjmuje `--run-manifest`, opcjonalne `--fixture` z metadanymi oferty oraz
`--entry-id`. Wynik i artefakt interpretacji są run-local, a przejście wpisu do
`interpreted` jest idempotentne.

## Faza 6 — pełny raport

Runner uruchamia bounded pipeline per instytucja z równoległością między
niezależnymi originami oraz limitem sekwencyjnych operacji dla tego samego
originu. Zapisuje `pipeline-telemetry.json` i `full-report.json`, obejmujące
czas, cache/304, requesty, bytes, CPU/RAM, błędy, coverage, bottlenecki oraz
jakość każdego wpisu. Snapshot publikowany przez `finalize.mjs` przenosi
zwalidowany wynik interpretacji oraz `export_ready`, `data_status` i
`export_blockers`; eksport nadal czyta wyłącznie immutable published snapshot.

Po publikacji dostępne są read-only `tools/run-audit.mjs` oraz
`tools/export-workbook.mjs`. Audit sprawdza manifest, checkpoint, telemetrykę,
snapshot, evidence, publication, pointer i hashe; exporter wylicza `qualifies`
z `decision_status`, główny arkusz zawiera tylko `qualified && export_ready`, a
pozostałe wpisy trafiają do arkusza Review. XLSX jest tworzony bez dodatkowej
zależności runtime.

## Eksperymentalny pilot Parallel

Izolowany pilot Parallel Search → Extract → Luna z jednorundowym,
model-requested follow-upem nie jest częścią powyższego produkcyjnego lifecycle.
Jego powtarzalna procedura offline/replay/live znajduje się w
[`docs/parallel-pilot-repeatable-verification.md`](./docs/parallel-pilot-repeatable-verification.md).
Runbook jest źródłem prawdy wyłącznie dla weryfikacji tego pilota; nie zmienia
kontraktów produkcyjnego runnera, publikacji ani eksportu.

Sprawdzenie kontraktów:

```bash
npm --prefix .agents/skills/mortgage-refinancing-scan run check
npm test -- tests/skills/mortgage-refinancing-scan-contracts.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-core-lifecycle.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-research.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-interpretation.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-phase5.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-phase6.test.mjs
```
