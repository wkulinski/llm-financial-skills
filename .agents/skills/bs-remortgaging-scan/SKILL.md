---
name: bs-remortgaging-scan
description: Standalone Parallel Search → Extract → Luna pilot for BS remortgaging offers with periodically fixed rates.
---

# bs-remortgaging-scan

Niezależny skill pilota Parallel Search → Extract → Luna do badania ofert
refinansowania kredytów mieszkaniowych/hipotecznych w bankach spółdzielczych.
Skill jest całkowicie niezależnym bytem; nie zależy od innych skilli
i nie współdzieli z nimi kodu, kontraktów ani artefaktów.

## Cel

Dla każdego banku pilot szuka oferty zakorzenionej na oficjalnej stronie
produktu, która potwierdza:

1. kredyt mieszkaniowy, hipoteczny albo równoważny kredyt na cele mieszkaniowe;
2. spłatę lub refinansowanie istniejącego kredytu mieszkaniowego/hipotecznego;
3. oprocentowanie stałe — okresowo albo bezterminowo.

Jeżeli strona produktu nie zawiera kompletnego dowodu, Luna może wskazać
maksymalnie trzy bezpośrednie oficjalne `link_id` do jednorazowego doczytania
przez Parallel Extract. Druga decyzja korzysta ze strony produktu i pobranych
dokumentów jako jawnych `source_id`; trzecia runda nie istnieje.

## Architektura

```text
Parallel Search
→ official-domain canonical deduplication
→ metadata-only preflight (homepage/noise audit przed requestami)
→ Parallel Extract każdego pozostałego wyniku Search wraz z bounded `direct_links`
→ pierwsza klasyfikacja każdej strony produktu przez Lunę
→ opcjonalne `needs_more_evidence` z 1–3 istniejącymi `link_id`
→ jednorazowy Parallel Extract dokładnie wybranych bezpośrednich dokumentów
→ druga i ostateczna klasyfikacja jednej oferty na jawnych `source_id`
→ deterministyczny rollup banku
```

- `lib/parallel-search-pilot.mjs` — izolowane discovery Search (jeden POST
  na bank, official-domain filter, canonicalizacja, deduplikacja, kolejność API).
- `lib/metadata-prefilter.mjs` — współdzielony, deterministyczny predykat
  metadata-only dla preflightu przed Extract i backstopu klasyfikatora.
- `lib/parallel-extract-pilot.mjs` — bounded Extract (płaskie page records,
  jeden rekord na tożsamość, `direct_links` jako metadane discovery,
  `runSelectedLinkExtract` do jednorazowego follow-upu); homepage’y i znany
  metadata-only noise są audytowane bez requestu, a bank bez dedykowanego
  kandydata otrzymuje `not_found`.
- `lib/parallel-review-classifier-pilot.mjs` — klasyfikator Luna
  (niezależna decyzja strony, exact cytaty grounded w `source_id`,
  jedna bounded runda follow-up, deterministyczny rollup).
- `tools/parallel-search-pilot.mjs` — CLI Search.
- `tools/parallel-extract-pilot.mjs` — CLI Extract.
- `tools/parallel-review-classifier-pilot.mjs` — CLI klasyfikatora
  z wpiętym `runSelectedLinkExtract` jako follow-up extractorem.

Kod deterministyczny sprawdza schema, URL/host, budżet i grounding.
Nie interpretuje semantyki refinansowania regexem po decyzji Luny.
Anchor, kontekst i URL linku są metadanymi discovery, a nie evidence.
Preflight używa wyłącznie URL/title/description, chroni ścieżki
`hipotec...`/`mieszkaniow...` i nie traktuje `not_found` jako dowodu braku oferty
w banku. Błędy techniczne i puste treści po Extract pozostają `unresolved`.

## Weryfikacja

Powtarzalna procedura offline/replay/live znajduje się w
[`docs/parallel-pilot-repeatable-verification.md`](./docs/parallel-pilot-repeatable-verification.md).
Runbook jest źródłem prawdy wyłącznie dla weryfikacji tego pilota.

Tryb offline (bez kluczy API):

```bash
npm test -- \
  tests/skills/bs-remortgaging-scan-parallel-search-pilot.test.mjs \
  tests/skills/bs-remortgaging-scan-parallel-extract-pilot.test.mjs \
  tests/skills/bs-remortgaging-scan-parallel-review-classifier-pilot.test.mjs
git diff --check
```

Search, Extract lub model można uruchomić live wyłącznie po jawnym poleceniu
użytkownika obejmującym kosztowy przebieg. Sesja weryfikacyjna jest read-only
względem kodu, promptów, fixtures i gold setu.

## Niezależność

- Ten skill nie importuje kodu z innych skilli.
- Artefakty sesji trafiają do `var/agent/cache/bs-remortgaging-scan/`;
  istniejących artefaktów nie wolno nadpisywać.
- Brak dowodu w niekompletnym lub błędnie pobranym dokumencie oznacza
  `unresolved`, a nie brak oferty.
