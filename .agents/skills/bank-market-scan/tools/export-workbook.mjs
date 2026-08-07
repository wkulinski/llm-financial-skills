#!/usr/bin/env node
import path from 'node:path';
import {Command} from 'commander';
import ExcelJS from 'exceljs';
import {readJson, readJsonl, getDeep, boolToPl, ensureDir, bundledPath, dataPath} from './lib/common.mjs';
import {normalizeRowFields} from './lib/decision-model.mjs';
import {readRunManifest, runStatusPath} from './lib/run-manifest.mjs';
import {validateFieldEvidenceReferences} from './lib/evidence-store.mjs';
import {validateRows} from './validate-state.mjs';

const program = new Command();
program
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--analysis <path>', 'analysis JSON', dataPath('work/analysis-state.json'))
    .option('--evidence <path>', 'evidence JSONL', dataPath('work/evidence.jsonl'))
    .option('--run-manifest <path>', 'finalized exact-scope run manifest')
    .option('--out <path>', 'output XLSX', dataPath('exports/rynek-bs-skok.xlsx'))
    .parse(process.argv);
const opts = program.opts();
const institutions = await readJson(opts.institutions);
const state = await readJson(opts.analysis);
const evidence = await readJsonl(opts.evidence);
const columns = await readJson(bundledPath('schemas/workbook-columns.json'));
if (opts.runManifest) {
    const manifest = await readRunManifest(opts.runManifest);
    const status = await readJson(runStatusPath(opts.runManifest));
    if (status.status !== 'finalized') throw new Error(`Export requires finalized run; current status is ${status.status || 'unknown'}.`);
    const scopedRows = state.rows.filter(row => manifest.institution_ids.includes(row.institution_id));
    const validationWarnings = validateRows(scopedRows, {requireFieldEvidence: true});
    const evidenceErrors = validateFieldEvidenceReferences(scopedRows, evidence, {runId: manifest.run_id, strict: true});
    if (validationWarnings.length || evidenceErrors.length) {
        throw new Error(`Export blocked by evidence validation: ${[...validationWarnings, ...evidenceErrors].join(' | ')}`);
    }
}
const analysisById = new Map(state.rows.map(r => [r.institution_id, r]));
const exactFallbacks = new Map([
    ['offer.commission_min', 'offer.commission_exact'],
    ['offer.commission_max', 'offer.commission_exact'],
    ['offer.fixed_nominal_rate_min', 'offer.fixed_nominal_rate_exact'],
    ['offer.fixed_nominal_rate_max', 'offer.fixed_nominal_rate_exact'],
    ['offer.rrso_min', 'offer.rrso_exact'],
    ['offer.rrso_max', 'offer.rrso_exact']
    ,['offer.fixed_rate_period_years_min', 'offer.fixed_rate_period_years_exact']
    ,['offer.fixed_rate_period_years_max', 'offer.fixed_rate_period_years_exact']
]);

function countFieldEvidence(row) {
    const ev = row?.field_evidence || {};
    return Object.values(ev).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
}

function valueFor(col, inst, row) {
    let v;
    if (col.key === 'review_status_checked') v = row?.review_status === 'checked' ? true : null;
    else if (col.key === 'field_evidence_count') v = countFieldEvidence(row);
    else if (col.source === 'institution') v = getDeep(inst, col.key);
    else {
        const canonicalRow = normalizeRowFields(row || {});
        v = getDeep(canonicalRow, col.key);
        const exactKey = exactFallbacks.get(col.key);
        if (v == null && exactKey) v = getDeep(canonicalRow, exactKey);
    }
    if (col.type === 'bool_pl') return boolToPl(v);
    if (col.type === 'list') return Array.isArray(v) ? v.join('; ') : (v ?? '');
    return v == null ? '' : v;
}

function addAoASheet(wb, name, rows) {
    const ws = wb.addWorksheet(name);
    rows.forEach(row => ws.addRow(row));
    ws.views = [{state: 'frozen', ySplit: 1}];
    for (let i = 1; i <= ws.columnCount; i++) ws.getColumn(i).width = i <= 5 ? 20 : 30;
    return ws;
}

function addObjectSheet(wb, name, objects, typeMap = new Map()) {
    const headers = objects.length ? Object.keys(objects[0]) : [];
    const ws = addAoASheet(wb, name, [headers, ...objects.map(o => headers.map(h => o[h]))]);
    ws.getRow(1).font = {bold: true};
    if (headers.length) ws.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: headers.length}};
    for (let c = 1; c <= headers.length; c++) {
        const type = typeMap.get(headers[c - 1]);
        if (type === 'percent') ws.getColumn(c).numFmt = '0.00%';
        if (type === 'currency') ws.getColumn(c).numFmt = '# ##0 zł';
    }
    return ws;
}

const typeMap = new Map(columns.map(c => [c.xlsx, c.type]));
const analysisRows = institutions.institutions.map(inst => {
    const row = analysisById.get(inst.institution_id) || {};
    const out = {};
    for (const col of columns) out[col.xlsx] = valueFor(col, inst, row);
    return out;
});
const podmiotyRows = institutions.institutions.map(i => ({
    'Lp': i.lp,
    'Typ podmiotu': i.type_label || (i.type === 'skok' ? 'SKOK' : 'Bank spółdzielczy'),
    'Nazwa': i.name,
    'URL strony internetowej': i.website_url || '',
    'Źródło listy bazowej': i.source?.url || '',
    'Sekcja źródła': i.source?.section || '',
    'Data źródła listy bazowej': i.source?.source_date || '',
    'Id techniczne': i.institution_id,
    'Status listy bazowej': i.base_list_status || '',
    'Uwagi listy bazowej': i.base_list_notes || ''
}));
const evidenceRows = evidence.map(e => ({
    'Evidence ID': e.evidence_id || '',
    'Lp': e.lp || '',
    'Institution ID': e.institution_id,
    'Kategoria': e.category || '',
    'Pole': e.field_path || '',
    'URL': e.url || '',
    'Typ źródła': e.source_type || '',
    'Data pobrania': e.fetched_at || '',
    'SHA-256 źródła': e.content_sha256 || '',
    'Wykorzystane do decyzji': boolToPl(e.used_for_decision),
    'Fragment / opis': e.text_excerpt || e.notes || ''
}));
const metodyka = [
    ['Pole', 'Zasada'],
    ['Kryterium TAK', 'Potwierdź: kredyt mieszkaniowy/hipoteczny + spłata/refinansowanie wcześniejszego/innego kredytu mieszkaniowego/hipotecznego + okresowo stała stopa.'],
    ['Fraza z innego banku', 'Nie jest wymagana. Wystarczy spłata/refinansowanie wcześniejszego/innego kredytu mieszkaniowego/hipotecznego.'],
    ['Okres po stałej stopie', 'Nie wpisuj żadnych danych dotyczących okresu po zakończeniu stałego oprocentowania.'],
    ['Puste pole w XLSX', 'Brak jednoznacznej informacji dla kwalifikującego wariantu. W JSON możesz doprecyzować field_status.'],
    ['Procenty w JSON', '0.063 oznacza 6,3%.'],
    ['Field evidence', 'Dla każdej krytycznej liczby i każdego z trzech kryteriów kwalifikacji zapisuj dowód w field_evidence.'],
    ['Reason codes', 'TAK/NIE powinno mieć kody powodów w qualification.reason_codes albo qualification.non_qualification_reason_codes.'],
    ['Zakresy', 'Jeżeli źródło podaje zakres, używaj pól *_min i *_max; pojedynczą wartość wpisuj jako *_exact.'],
    ['XLSX', 'Eksport dla człowieka; JSON/JSONL są źródłem prawdy.']
];
const wb = new ExcelJS.Workbook();
wb.creator = 'bank-market-scan';
wb.created = new Date();
addAoASheet(wb, 'Podsumowanie', [
    ['Metryka', 'Wartość'],
    ['Liczba instytucji', institutions.institutions.length],
    ['Sprawdzone', state.rows.filter(r => r.review_status === 'checked').length],
    ['TAK', state.rows.filter(r => r.review_status === 'checked' && r.qualifies === true).length],
    ['NIE', state.rows.filter(r => r.review_status === 'checked' && r.qualifies === false).length],
    ['Wygenerowano', new Date().toISOString().slice(0, 10)]
]);
addObjectSheet(wb, 'Podmioty', podmiotyRows);
addObjectSheet(wb, 'Analiza ofert', analysisRows, typeMap);
addObjectSheet(wb, 'Źródła Evidence', evidenceRows);
addAoASheet(wb, 'Metodyka', metodyka);
await ensureDir(path.dirname(opts.out));
await wb.xlsx.writeFile(opts.out);
console.log(opts.out);
