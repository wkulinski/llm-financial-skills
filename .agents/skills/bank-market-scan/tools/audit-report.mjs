#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {readJson, ensureDir, boolToPl, getDeep, dataPath} from './lib/common.mjs';
import {validateRows} from './validate-state.mjs';

const program = new Command();
program
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--out <path>', 'markdown report', dataPath('exports/review-report.md'))
    .option('--require-field-evidence', 'include missing field-evidence warnings for TAK rows')
    .parse(process.argv);
const opts = program.opts();
const institutions = await readJson(opts.institutions);
const state = await readJson(opts.state);
const rows = state.rows || [];
const byId = new Map(institutions.institutions.map(i => [i.institution_id, i]));
const checked = rows.filter(r => r.review_status === 'checked');
const yes = checked.filter(r => r.qualifies === true);
const no = checked.filter(r => r.qualifies === false);
const unavailable = checked.filter(r => r.website_available === false);
const warnings = validateRows(rows, {requireFieldEvidence: opts.requireFieldEvidence});

function title(r) {
    const i = byId.get(r.institution_id);
    return `Lp. ${r.lp} — ${i?.name || r.institution_id}`;
}

function bulletRows(items, mapper) {
    if (!items.length) return '_Brak._\n';
    return items.map(r => `- **${title(r)}** — ${mapper(r)}`).join('\n') + '\n';
}

const suspiciousRates = checked.filter(r => {
    const fixed = getDeep(r, 'offer.fixed_nominal_rate_exact') ?? getDeep(r, 'offer.fixed_nominal_rate');
    const rrso = getDeep(r, 'offer.rrso_exact') ?? getDeep(r, 'offer.rrso');
    return (fixed != null && fixed > 0.12) || (rrso != null && fixed != null && rrso + 0.005 < fixed);
});

const md = `# Raport kontrolny rynku BS/SKOK\n\n` +
    `Wygenerowano: ${new Date().toISOString()}\n\n` +
    `## Podsumowanie\n\n` +
    `- Instytucje w liście bazowej: ${institutions.institutions.length}\n` +
    `- Sprawdzone: ${checked.length}\n` +
    `- TAK: ${yes.length}\n` +
    `- NIE: ${no.length}\n` +
    `- Strona niedostępna: ${unavailable.length}\n` +
    `- Ostrzeżenia walidatora: ${warnings.length}\n\n` +
    `## Ostrzeżenia walidatora\n\n` + (warnings.length ? warnings.map(w => `- ${w}`).join('\n') + '\n' : '_Brak._\n') +
    `\n## Nietypowe wartości do ręcznej kontroli\n\n` + bulletRows(suspiciousRates, r => `fixed=${getDeep(r, 'offer.fixed_nominal_rate_exact') ?? getDeep(r, 'offer.fixed_nominal_rate') ?? ''}; RRSO=${getDeep(r, 'offer.rrso_exact') ?? getDeep(r, 'offer.rrso') ?? ''}`) +
    `\n## Oferty TAK\n\n` + bulletRows(yes, r => `${r.offer?.product_name || ''}; stała=${r.offer?.fixed_nominal_rate_exact ?? r.offer?.fixed_nominal_rate ?? ''}; RRSO=${r.offer?.rrso_exact ?? r.offer?.rrso ?? ''}`) +
    `\n## Oferty NIE — powody\n\n` + bulletRows(no, r => `${(r.qualification?.non_qualification_reason_codes || []).join('; ') || r.status_text || 'brak kodu powodu'}`) +
    `\n## Strony niedostępne\n\n` + bulletRows(unavailable, r => r.status_text || 'strona niedostępna');
await ensureDir(path.dirname(opts.out));
await fs.writeFile(opts.out, md, 'utf8');
console.log(opts.out);
