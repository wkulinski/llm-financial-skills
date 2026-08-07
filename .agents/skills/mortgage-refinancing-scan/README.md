# mortgage-refinancing-scan

Standalone skill kontraktów dla raportu refinansowania kredytów hipotecznych.

Faza 1, Faza 2, Faza 3, Faza 4, Faza 5 i Faza 6 zawierają:

- strict JSON Schema 2020-12 z Ajv 8;
- wspólne definicje identyfikatorów, statusów i limitów;
- deterministyczną canonicalizację JSON oraz SHA-256;
- walidatory schema i reguł semantycznych dla manifestu, kontekstu, eventów,
  checkpointu, artefaktów, evidence, bundle, wyników, telemetryki, registry,
  stanu wpisu, snapshotu i publikacji;
- `run-init`, `run-state`, `finalize` i `abort` jako offline core lifecycle;
- append-only event store, atomowe stany wpisów, retry, centralny writer,
  origin-aware bounded scheduler, checkpoint z jednej projekcji oraz atomowy
  publication pointer z recovery.
- offline research vertical slice: BFG/KNF registry audit, deterministic
  discovery, fixture-backed fetch z retry/304 cache, Morfeusz 2 normalization
  oraz source-bound evidence.
- interpretation vertical slice: exact-scope `ReviewContext`, grupowanie
  `ProductBundle`, deterministyczna ocena trzech kryteriów, ranking oferty i
  strict `InterpretationResult`; brak lub mismatch evidence zatrzymuje wpis
  przed interpretacją.
- controlled runner i live transport: `tools/runner.mjs` wykonuje publiczne
  entrypointy w jednym lifecycle, a `live:true` używa wyłącznie registry
  allowlisty, robots, bounded HTTP/retry, conditional transport cache i
  source-bound evidence. `live:false` pozostaje bezsieciowym trybem fixture.
- pełny raport Fazy 6: bounded pipeline, pipeline/full-report telemetryka,
  analiza bottlenecków i jakości per instytucja, read-only audit publikacji oraz
  eksport XLSX wyłącznie z opublikowanego snapshotu; `qualified` jest decyzją
  biznesową, a `export_ready` wymaga typu/okresu stopy i nominalnej stopy lub
  RRSO, przy czym niegotowe wpisy pozostają w arkuszu Review.

Macierz testów znajduje się w `tests/test-matrix.json`; wiersze T01/T02/T09/T10
pokrywają core lifecycle, T03–T07 research, a T08 interpretację. Każdy test
działa offline, z fixture registry i bez ręcznej edycji artefaktów.
Wiersze T13–T15 pokrywają runner, gold-set oraz deterministyczny benchmark
zasobów. Pełny profil benchmarku uruchamia się jawnie:

```bash
node tools/resource-benchmark.mjs --iterations 30 --entries 500 --urls 100 \
  --output data/mortgage-refinancing-scan/work/resource-benchmark.json
```

Audit i eksport po finalized runie:

```bash
node tools/run-audit.mjs \
  --run-manifest data/mortgage-refinancing-scan/work/runs/<run_id>/manifest.json
node tools/export-workbook.mjs \
  --run-manifest data/mortgage-refinancing-scan/work/runs/<run_id>/manifest.json \
  --out data/mortgage-refinancing-scan/work/<run_id>.xlsx
```

Domyślna normalizacja wymaga dostępnego Morfeusza
2. Tryb `--engine fixture` jest jawny i służy tylko offline testom — nie jest
fallbackiem dla brakującej zależności.

```bash
npm --prefix .agents/skills/mortgage-refinancing-scan run check
npm test -- tests/skills/mortgage-refinancing-scan-contracts.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-core-lifecycle.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-research.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-interpretation.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-phase5.test.mjs
npm test -- tests/skills/mortgage-refinancing-scan-phase6.test.mjs
```
