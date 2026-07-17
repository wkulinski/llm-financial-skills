#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Command} from 'commander';
import {readJson, readJsonl, ensureDir, slug, boolToPl, bundledPath, dataPath} from './lib/common.mjs';
import {validateCandidateCaches} from './lib/source-integrity.mjs';
import {classifySourceRole} from './lib/source-roles.mjs';

const program = new Command();
program
    .option('--lp <number>', 'institution Lp', v => parseInt(v, 10))
    .option('--institution-id <id>')
    .option('--refresh')
    .option('--fresh')
    .option('--run-id <id>')
    .option('--skip-preprocess', 'use existing cache and do not rerun discovery/extract/grep')
    .option('--expanded', 'show a wider candidate/snippet set for retry/escalation workflows')
    .parse(process.argv);
const opts = program.opts();
if (!opts.lp && !opts.institutionId) throw new Error('Pass --lp or --institution-id.');
const institutions = await readJson(dataPath('base/institutions.current.json'));
const state = await readJson(dataPath('work/analysis-state.json'));
const inst = institutions.institutions.find(i => (opts.lp && i.lp === opts.lp) || (opts.institutionId && i.institution_id === opts.institutionId));
if (!inst) throw new Error('Institution not found.');
const cacheDir = dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
const out = dataPath('work/review-packs', `lp-${String(inst.lp).padStart(3, '0')}.md`);

function run(args) {
    const r = spawnSync(process.execPath, args, {stdio: opts.refresh ? 'inherit' : 'pipe'});
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed`);
}

if (!opts.skipPreprocess) {
    await fs.rm(out, {force: true});
    const runId = opts.runId || `pack-${Date.now()}-${process.pid}`;
    run([
        bundledPath('tools/discover-sources.mjs'), '--lp', String(inst.lp), '--run-id', runId,
        ...(opts.refresh || opts.fresh ? ['--refresh'] : []),
        ...(opts.fresh ? ['--fresh'] : [])
    ]);
    run([bundledPath('tools/extract-text.mjs'), '--lp', String(inst.lp)]);
    run([bundledPath('tools/grep-evidence.mjs'), '--lp', String(inst.lp)]);
}

const candidates = await readJson(path.join(cacheDir, 'candidates.json'));
const evidence = await readJsonl(path.join(cacheDir, 'evidence.candidates.jsonl'));
const sourceText = await readJsonl(path.join(cacheDir, 'source-text.jsonl'));
const integrityCandidates = candidates.all_candidates?.length ? candidates.all_candidates : (candidates.candidates || []);
const cacheIntegrityErrors = await validateCandidateCaches(integrityCandidates);
if (cacheIntegrityErrors.length) {
    throw new Error(`Source cache integrity failure: ${cacheIntegrityErrors.map(error => error.type).join(', ')}`);
}
if (candidates.run_id) {
    const staleSources = sourceText.filter(source => source.run_id !== candidates.run_id);
    const expectedUrls = new Set((candidates.candidates || []).map(candidate => candidate.final_url || candidate.url));
    const sourceUrls = new Set(sourceText.map(source => source.url));
    const missingSources = [...expectedUrls].filter(url => !sourceUrls.has(url));
    if (staleSources.length || missingSources.length) {
        throw new Error(`Source text is not complete for run ${candidates.run_id}: stale=${staleSources.length}, missing=${missingSources.length}.`);
    }
}
const current = state.rows.find(r => r.institution_id === inst.institution_id);
const decisionCategories = new Set(['product', 'refinancing', 'fixed_rate', 'pricing']);
const decisionEvidence = evidence.filter(ev => decisionCategories.has(ev.category));
const byCat = new Map();
const evidenceUrls = new Set();
const maxCandidates = opts.expanded ? 50 : 20;
for (const ev of decisionEvidence) {
    evidenceUrls.add(ev.url);
    if (!byCat.has(ev.category)) byCat.set(ev.category, []);
    byCat.get(ev.category).push(ev);
}

const prioritizedCandidates = candidates.candidates || [];
const allCandidates = candidates.all_candidates || prioritizedCandidates;
const candidateUrls = new Set(prioritizedCandidates.map(c => c.final_url || c.url));
const sourcesWithoutSnippets = prioritizedCandidates.filter(c => !evidenceUrls.has(c.final_url || c.url));
const candidateByUrl = new Map(allCandidates.map(candidate => [candidate.final_url || candidate.url, candidate]));
const categoriesByUrl = new Map();
for (const ev of decisionEvidence) {
    if (!categoriesByUrl.has(ev.url)) categoriesByUrl.set(ev.url, new Set());
    categoriesByUrl.get(ev.url).add(ev.category);
}
function roleForUrl(url) {
    const candidate = candidateByUrl.get(url) || {url};
    return classifySourceRole(candidate, [...(categoriesByUrl.get(url) || [])]);
}

function sec(title, rows) {
    if (!rows?.length) return `\n## ${title}\n\nBrak trafień.\n`;
    return `\n## ${title}\n\n` + rows.map((r, i) => `### ${i + 1}. role=${r.source_role || roleForUrl(r.url)}; evidence_id=${r.evidence_id || ''}; ${r.keyword} — ${r.url}\n\n> ${r.text_excerpt.replace(/\n/g, ' ').slice(0, 1400)}\n`).join('\n');
}

const sourceByUrl = new Map(sourceText.map(source => [source.url, source]));
const decisionEvidenceUrls = new Set(decisionEvidence.map(ev => ev.url));
const indexedCandidates = prioritizedCandidates
    .filter(candidate => decisionEvidenceUrls.has(candidate.final_url || candidate.url) || candidate.selected_seed === true)
    .slice(0, maxCandidates);
const sourceIndex = indexedCandidates.map((candidate, index) => {
    const url = candidate.final_url || candidate.url;
    const source = sourceByUrl.get(url);
    const categories = [...new Set(decisionEvidence.filter(ev => ev.url === url).map(ev => ev.category))];
    return `${index + 1}. role=${classifySourceRole(candidate, categories)} | ${url} | title=${candidate.title || ''} | type=${source?.source_type || candidate.content_type || ''} | fetched=${source?.fetched_at || candidate.fetched_at || ''} | chars=${source?.text?.length || 0} | evidence=${categories.join(', ') || 'none'}`;
}).join('\n');

const md = `# Lp. ${inst.lp} — ${inst.name}\n\n` +
    `## Dane bazowe\n\n- Typ: ${inst.type}\n- URL: ${inst.website_url || ''}\n- Status dotychczasowy: ${current?.review_status || 'unchecked'}\n- Dotychczas qualifies: ${boolToPl(current?.qualifies)}\n\n` +
    `## Meta preprocessingu\n\n` +
    `- Wszystkie źródła w cache: ${allCandidates.length}\n` +
    `- Źródła priorytetowe: ${prioritizedCandidates.length}\n` +
    `- Źródła z co najmniej jednym snippettem: ${candidateUrls.size - sourcesWithoutSnippets.length}\n` +
    `- Źródła bez snippetów heurystycznych: ${sourcesWithoutSnippets.length}\n` +
    `- Tryb discovery: ${candidates.discovery_mode || 'brak'}\n` +
    `- Run ID: ${candidates.run_id || 'brak'}\n` +
    `- Status dostawcy search: ${candidates.search_provider_status || 'brak'}\n` +
    `- Search-first wystarczający: ${candidates.sufficient_for_search_first == null ? 'brak' : candidates.sufficient_for_search_first}\n` +
    `- Analiza wystarczająca: ${candidates.sufficient_for_analysis == null ? 'brak' : candidates.sufficient_for_analysis}\n` +
    `- Relacja produktu: ${candidates.product_relation?.status || 'brak'}\n` +
    `- Powód fallbacku: ${candidates.fallback_trigger_reason || 'nie dotyczy'}\n` +
    `- Flagi ryzyka: ${(candidates.preprocessing_risk_flags || []).join(', ') || 'brak'}\n\n` +
    `## Indeks materiałów źródłowych\n\n` +
    `Pełny materiał znajduje się w ${path.join(cacheDir, 'source-text.jsonl')}. Agent ma czytać pełne rekordy wskazanych źródeł; poniższe snippety są wyłącznie nawigacją.\n\n` +
    `Role źródeł: **core** oznacza stronę konkretnego produktu mieszkaniowego/hipotecznego; **supporting** oznacza taryfę, dokument lub materiał pomocniczy; **excluded_context** oznacza inny produkt albo segment i nie może samodzielnie dostarczać wartości ani potwierdzać kwalifikacji.\n\n` +
    sourceIndex + '\n' +
    sec('Fragmenty: produkt mieszkaniowy/hipoteczny', byCat.get('product')) +
    sec('Fragmenty: spłata/refinansowanie wcześniejszego kredytu', byCat.get('refinancing')) +
    sec('Fragmenty: okresowo stałe oprocentowanie', byCat.get('fixed_rate')) +
    sec('Fragmenty: prowizja / RRSO / oprocentowanie', byCat.get('pricing')) +
    `\n## Uwaga o kompletności\n\nTen review-pack jest skrótem. Brak snippetów heurystycznych nie oznacza braku danych w źródłach. Przy flagach ryzyka albo skąpych trafieniach agent powinien sięgać szerzej do cache i pełnej listy źródeł. Row-update musi zawierać run_id=${candidates.run_id || 'z bieżącego zadania'}.\n` +
    `\n## Instrukcja decyzji\n\nWpisz TAK tylko jeśli potwierdzone są trzy warunki: produkt mieszkaniowy/hipoteczny, spłata/refinansowanie wcześniejszego/innego kredytu mieszkaniowego/hipotecznego, okresowo stałe oprocentowanie. Nie wymagaj literalnej frazy „refinansowanie”. Nie wpisuj danych z okresu po stałej stopie ani z role=excluded_context.\n\nDla każdej ważnej liczby i każdego z trzech kryteriów zapisz field_evidence z evidence_id albo URL-em i krótkim fragmentem. W row-update dodaj decision_audit z nazwą produktu, potwierdzeniem samego produktu/wariantu oraz URL-ami dowodów dla trzech kryteriów. Dla NIE zapisz qualification.non_qualification_reason_codes, np. no_refinance_or_repayment_confirmed albo no_periodically_fixed_rate_confirmed. Dla TAK zapisz qualification.reason_codes: housing_or_mortgage_loan_confirmed, refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed, periodically_fixed_rate_confirmed.\n\nJeżeli bank podaje zakres, używaj pól *_min i *_max; pojedynczą wartość wpisuj także jako *_exact lub do starego pola kompatybilnego wstecz.\n`;
await ensureDir(dataPath('work/review-packs'));
const tempOut = `${out}.${candidates.run_id || `tmp-${process.pid}`}.tmp`;
await fs.writeFile(tempOut, md, 'utf8');
await fs.rename(tempOut, out);
console.log(out);
