#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import * as cheerio from 'cheerio';
import {
    ensureDir,
    writeJson,
    DEFAULT_BFG_URL,
    DEFAULT_KNF_URL,
    fetchText,
    stableInstitutionId,
    normalizeText,
    cleanWhitespace,
    absolutizeUrl,
    todayIso,
    sourceDateFromText,
    sha256,
    dataPath
} from './lib/common.mjs';

const program = new Command();
program
    .option('--out <path>', 'output JSON', dataPath('base/institutions.current.json'))
    .option('--bfg-url <url>', 'BFG source URL', DEFAULT_BFG_URL)
    .option('--bfg-html <path>', 'local BFG HTML fixture to parse instead of fetching')
    .option('--knf-url <url>', 'KNF control URL', DEFAULT_KNF_URL)
    .option('--cross-check-knf', 'cross-check bank names against KNF')
    .option('--cache-dir <path>', 'cache dir', dataPath('cache/base-list'))
    .option('--min-institutions <number>', 'minimum expected number of parsed institutions', v => parseInt(v, 10), 20)
    .option('--force-refresh', 'ignore cache')
    .parse(process.argv);
const opts = program.opts();

const ALLOWED_SECTION_TYPES = new Map([
    [normalizeText('Banki spółdzielcze'), 'bank_spoldzielczy'],
    [normalizeText('SKOK-i'), 'skok']
]);

async function getCached(url, name) {
    await ensureDir(opts.cacheDir);
    const file = path.join(opts.cacheDir, name);
    if (!opts.forceRefresh) {
        try {
            return await fs.readFile(file, 'utf8');
        } catch {
        }
    }
    const r = await fetchText(url);
    if (!r.ok) throw new Error(`Fetch failed ${url}: ${r.status}`);
    await fs.writeFile(file, r.text, 'utf8');
    return r.text;
}

function sectionType(sectionName) {
    return ALLOWED_SECTION_TYPES.get(normalizeText(sectionName));
}

export function parseBfgInstitutions(html, {baseUrl = DEFAULT_BFG_URL, sourceDate = null, minInstitutions = 20} = {}) {
    const $ = cheerio.load(html);
    const rows = $('div.pog-post-content table tbody tr').toArray();
    if (!rows.length) {
        throw new Error('Nie znaleziono tabeli instytucji BFG w sekcji treści.');
    }
    const institutions = [];
    const seen = new Set();
    let currentSection = null;
    for (const tr of rows) {
        const cell = $(tr).children().first();
        if (!cell.length) continue;
        const tag = cell[0].tagName || cell[0].name || '';
        if (tag.toLowerCase() === 'th') {
            currentSection = cleanWhitespace(cell.text());
            continue;
        }
        const type = currentSection ? sectionType(currentSection) : null;
        if (!type) continue;
        const name = cleanWhitespace(cell.text());
        if (name.length < 4) continue;
        if (/więcej|czytaj|pdf|pobierz|facebook|twitter|linkedin|kontakt|dane osobowe|nota prawna|mapa witryny/i.test(name)) continue;
        const href = cell.find('a[href]').first().attr('href') || null;
        const website_url = href ? absolutizeUrl(href, baseUrl) : null;
        const nameKey = `${type}|${normalizeText(name)}`;
        if (seen.has(nameKey)) continue;
        seen.add(nameKey);
        const base_list_status = website_url ? 'active' : 'missing_website_url';
        institutions.push({
            institution_id: stableInstitutionId(type, name),
            lp: null,
            type,
            type_label: type === 'skok' ? 'SKOK' : 'Bank spółdzielczy',
            name,
            website_url,
            source: {
                name: 'BFG',
                section: currentSection,
                url: baseUrl,
                source_date: sourceDate
            },
            knf_cross_check: {matched: null, name: '', notes: ''},
            base_list_status,
            base_list_notes: website_url ? '' : 'Brak homepage URL w źródle BFG; wykluczone z aktywnego flow.'
        });
    }
    const counts = institutions.reduce((acc, inst) => {
        acc[inst.type] = (acc[inst.type] || 0) + 1;
        return acc;
    }, {});
    if (!counts.bank_spoldzielczy || !counts.skok) {
        throw new Error(`Nie udało się wyodrębnić obu sekcji BFG. bank_spoldzielczy=${counts.bank_spoldzielczy || 0}, skok=${counts.skok || 0}.`);
    }
    if (institutions.length < minInstitutions) {
        throw new Error(`Zbyt mało instytucji z BFG (${institutions.length}); parser mógł trafić w zły blok strony.`);
    }
    return institutions;
}

function parseKnfNames(html) {
    const $ = cheerio.load(html);
    const text = $('body').text();
    const names = new Set();
    $('a,td,li,p').each((_, el) => {
        const t = cleanWhitespace($(el).text());
        if (/Bank Spółdzielczy|Spółdzielczy Bank|BS\b/i.test(t) && t.length < 180) names.add(t);
    });
    if (!names.size) {
        for (const line of text.split(/\r?\n/).map(cleanWhitespace)) {
            if (/Bank Spółdzielczy|Spółdzielczy Bank/i.test(line) && line.length < 180) names.add(line);
        }
    }
    return [...names];
}

const bfgHtml = opts.bfgHtml ? await fs.readFile(opts.bfgHtml, 'utf8') : await getCached(opts.bfgUrl, `bfg-${todayIso()}.html`);
const bfgHtmlSha256 = sha256(bfgHtml);
const $ = cheerio.load(bfgHtml);
const sourceDate = sourceDateFromText($.text());
const previousOutput = await (async () => {
    try {
        return JSON.parse(await fs.readFile(opts.out, 'utf8'));
    } catch {
        return null;
    }
})();
const previousById = new Map((previousOutput?.institutions || []).map(inst => [inst.institution_id, inst]));
let institutions = parseBfgInstitutions(bfgHtml, {baseUrl: opts.bfgUrl, sourceDate, minInstitutions: opts.minInstitutions});

institutions = institutions.map(inst => {
    const previous = previousById.get(inst.institution_id);
    const allowed = Array.isArray(previous?.allowed_source_hosts)
        ? previous.allowed_source_hosts.filter(host => typeof host === 'string' && host.trim())
        : [];
    return allowed.length ? {...inst, allowed_source_hosts: [...new Set(allowed)]} : inst;
});

institutions = institutions.map((x, i) => ({...x, lp: i + 1}));

let knfSourceMeta = null;
if (opts.crossCheckKnf) {
    try {
        const knfHtml = await getCached(opts.knfUrl, `knf-${todayIso()}.html`);
        const knfHtmlSha256 = sha256(knfHtml);
        knfSourceMeta = {
            name: 'KNF - banki spółdzielcze',
            url: opts.knfUrl,
            fetched_at: todayIso(),
            content_sha256: knfHtmlSha256
        };
        const knfNames = parseKnfNames(knfHtml);
        const normKnf = knfNames.map(n => ({raw: n, norm: normalizeText(n)}));
        for (const inst of institutions) {
            if (inst.type !== 'bank_spoldzielczy') continue;
            const n = normalizeText(inst.name);
            const match = normKnf.find(k => k.norm.includes(n) || n.includes(k.norm));
            inst.knf_cross_check = match ? {matched: true, name: match.raw, notes: ''} : {
                matched: false,
                name: '',
                notes: 'Brak prostego dopasowania w KNF; wymaga ręcznej weryfikacji.'
            };
        }
    } catch (err) {
        for (const inst of institutions) {
            if (inst.type === 'bank_spoldzielczy') inst.knf_cross_check = {
                matched: null,
                name: '',
                notes: `Błąd cross-check KNF: ${err.message}`
            };
        }
    }
}

const out = {
    schema_version: '1.0',
    generated_at: todayIso(),
    primary_source: {
        name: 'BFG - Podmioty objęte gwarancjami',
        url: opts.bfgUrl,
        source_date: sourceDate,
        fetched_at: todayIso(),
        content_sha256: bfgHtmlSha256
    },
    control_sources: knfSourceMeta ? [knfSourceMeta] : [],
    institutions
};
await writeJson(opts.out, out);
console.log(`Saved ${institutions.length} institutions to ${opts.out}`);
