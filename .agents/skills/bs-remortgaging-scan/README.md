# bs-remortgaging-scan

Niezależny skill pilota Parallel Search → metadata preflight → Extract → Luna do badania ofert
refinansowania kredytów mieszkaniowych/hipotecznych w bankach spółdzielczych.

## Zakres

Pilot klasyfikuje ofertę zakorzenioną na oficjalnej stronie produktu.
Jeżeli strona nie zawiera kompletnego dowodu, Luna wskazuje maksymalnie trzy
bezpośrednie oficjalne linki do jednorazowego doczytania. Druga decyzja
korzysta ze strony produktu i pobranych dokumentów jako jawnych `source_id`.

## Elementy

- `lib/parallel-search-pilot.mjs` — discovery Search.
- `lib/metadata-prefilter.mjs` — deterministyczny preflight URL/title/description
  oraz wspólny post-Extract backstop.
- `lib/parallel-extract-pilot.mjs` — bounded Extract z `direct_links`
  i `runSelectedLinkExtract`; banki homepage-only/bez dedykowanego kandydata
  otrzymują `not_found` bez requestu Extract.
- `lib/parallel-review-classifier-pilot.mjs` — klasyfikator Luna
  z jedną bounded rundą follow-upu.
- `tools/` — CLI Search, Extract i klasyfikatora.
- `docs/parallel-pilot-repeatable-verification.md` — runbook weryfikacji.

## Powiązane kontrakty

- [`SKILL.md`](./SKILL.md) — operacyjny kontrakt skilla;
- [`docs/parallel-pilot-repeatable-verification.md`](./docs/parallel-pilot-repeatable-verification.md)
  — runbook powtarzalnej weryfikacji pilota.

Procedury QA, audytu i commitów pozostają w odpowiednich skillach; ten README
opisuje architekturę pilota, a nie zastępuje ich instrukcji operacyjnych.
