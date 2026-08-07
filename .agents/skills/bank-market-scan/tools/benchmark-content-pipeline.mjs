#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Command} from 'commander';
import * as cheerio from 'cheerio';
import {htmlToText} from 'html-to-text';
import {normalizeMaterial} from './lib/material.mjs';
import {bundledPath} from './lib/common.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const program = new Command();
program
    .option('--lps <list>', 'comma-separated LP numbers', '1,2,3,4,5')
    .option('--python <path>', 'Python executable with morfeusz2', process.env.MORFEUSZ_PYTHON || 'python3')
    .option('--out <path>', 'JSON report path', path.join(repoRoot, 'data', 'work', 'runs', `content-pipeline-benchmark-${Date.now()}.json`))
    .parse(process.argv);

const opts = program.opts();
const lps = opts.lps.split(',').map(value => Number.parseInt(value.trim(), 10)).filter(Number.isInteger);
const root = path.join(repoRoot, 'data', 'cache', 'institutions');
const worker = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'morphology-worker.py');
const keywords = JSON.parse(await fs.readFile(bundledPath('schemas/evidence-keywords.json'), 'utf8'));
const gold = JSON.parse(await fs.readFile(path.join(repoRoot, 'tests', 'fixtures', 'content-pipeline-gold.json'), 'utf8'));

const normalize = value => String(value || '').toLocaleLowerCase('pl-PL').replace(/\s+/g, ' ').trim();
const findInstitutionDir = async lp => (await fs.readdir(root)).find(name => name.startsWith(`${String(lp).padStart(3, '0')}-`));

async function loadSources() {
    const sources = [];
    for (const lp of lps) {
        const dir = await findInstitutionDir(lp);
        if (!dir) continue;
        const candidates = JSON.parse(await fs.readFile(path.join(root, dir, 'candidates.json'), 'utf8'));
        const seen = new Set();
        for (const candidate of candidates.candidates || []) {
            if (!candidate.cache_file || /\.pdf$/i.test(candidate.cache_file) || seen.has(candidate.cache_file)) continue;
            seen.add(candidate.cache_file);
            sources.push({
                id: `${lp}:${sources.length}`,
                lp,
                url: candidate.final_url || candidate.url,
                cache_file: candidate.cache_file,
                html: await fs.readFile(candidate.cache_file, 'utf8')
            });
        }
    }
    return sources;
}

function runWorker(python, records) {
    return new Promise((resolve, reject) => {
        const child = spawn(python, [worker], {stdio: ['pipe', 'pipe', 'pipe']});
        let output = '';
        let errors = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { errors += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(`Morfeusz worker exited ${code}: ${errors.trim()}`));
            try {
                resolve(output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
            } catch (error) {
                reject(new Error(`Morfeusz worker returned invalid JSON: ${error.message}`));
            }
        });
        child.stdin.end(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    });
}

function parseLegacy(source) {
    const $ = cheerio.load(source.html);
    $('script,style,nav,footer,header,form,noscript,svg').remove();
    return htmlToText($.html(), {
        wordwrap: false,
        selectors: [{selector: 'a', options: {ignoreHref: true}}]
    });
}

async function parseMainContent(source) {
    return normalizeMaterial(Buffer.from(source.html), {contentType: 'text/html', fileName: source.cache_file});
}

function coverage(text, lemmaText = null) {
    const fields = {};
    for (const [category, terms] of Object.entries(keywords)) {
        const surface = normalize(text);
        const surfaceHits = terms.filter(term => surface.includes(normalize(term)));
        const lemmaHits = lemmaText === null ? [] : terms.filter(term => normalize(lemmaText).includes(normalize(term)));
        fields[category] = {
            surface: surfaceHits,
            lemma: lemmaHits,
            present: surfaceHits.length > 0 || lemmaHits.length > 0
        };
    }
    return fields;
}

function summarize(rows) {
    const byLp = new Map();
    for (const row of rows) {
        if (!byLp.has(row.lp)) byLp.set(row.lp, []);
        byLp.get(row.lp).push(row);
    }
    return [...byLp.entries()].map(([lp, items]) => {
        const categories = Object.fromEntries(Object.keys(keywords).map(category => [
            category,
            items.filter(item => item.coverage[category].present).length
        ]));
        const expected = gold[lp] || null;
        const accuracy = expected
            ? Object.fromEntries(Object.keys(expected).filter(category => keywords[category]).map(category => {
                const detected = items.some(item => item.coverage[category].present);
                return [category, {expected: expected[category], detected, correct: detected === expected[category]}];
            }))
            : null;
        return {lp, source_count: items.length, category_source_counts: categories, gold_match: accuracy};
    });
}

const sources = await loadSources();
const parserResults = {};
const timings = {};
let parserStarted = performance.now();
parserResults.legacy = [];
for (const source of sources) parserResults.legacy.push({source, text: parseLegacy(source)});
timings.legacy_ms = Math.round(performance.now() - parserStarted);
parserStarted = performance.now();
parserResults.main_content = [];
for (const source of sources) {
    const extracted = await parseMainContent(source);
    parserResults.main_content.push({source, text: extracted.text, extraction: extracted.extraction});
}
timings.main_content_ms = Math.round(performance.now() - parserStarted);

const report = {
    schema_version: 'content-pipeline-benchmark-1.0',
    created_at: new Date().toISOString(),
    lps,
    source_count: sources.length,
    timings_ms: timings,
    variants: {},
    morfeusz: {python: opts.python, available: false}
};

for (const [parser, items] of Object.entries(parserResults)) {
    if (!Array.isArray(items)) continue;
    const parserRows = items.map(({source, text, error = null, extraction = null}) => ({
        lp: source.lp,
        url: source.url,
        chars: text.length,
        words: text.split(/\s+/).filter(Boolean).length,
        error,
        extraction,
        coverage: coverage(text)
    }));
    report.variants[`${parser}_surface`] = {parser, morphology: 'none', summary: summarize(parserRows), rows: parserRows};
    report.variants[`${parser}_morfeusz`] = {parser, morphology: 'morfeusz2_pending', summary: null, rows: []};
}

try {
    const lemmaInputs = [];
    for (const [parser, items] of Object.entries(parserResults)) {
        if (!Array.isArray(items)) continue;
        for (const {source, text} of items) lemmaInputs.push({id: `${parser}:${source.id}`, text});
    }
    for (const [category, terms] of Object.entries(keywords)) {
        for (const [index, term] of terms.entries()) lemmaInputs.push({id: `keyword:${category}:${index}`, text: term});
    }
    parserStarted = performance.now();
    const lemmaRows = await runWorker(opts.python, lemmaInputs);
    timings.morfeusz_ms = Math.round(performance.now() - parserStarted);
    const lemmaById = new Map(lemmaRows.map(row => [row.id, row]));
    const lemmaKeywords = Object.fromEntries(Object.entries(keywords).map(([category, terms]) => [
        category,
        terms.map((_, index) => lemmaById.get(`keyword:${category}:${index}`)?.lemma_text || '')
    ]));
    report.morfeusz.available = true;
    for (const [parser, items] of Object.entries(parserResults)) {
        if (!Array.isArray(items)) continue;
        const rows = items.map(({source, text, error = null, extraction = null}) => {
            const lemma = lemmaById.get(`${parser}:${source.id}`)?.lemma_text || '';
            const fields = coverage(text, lemma);
            for (const [category, terms] of Object.entries(lemmaKeywords)) {
                fields[category].lemma = terms.filter(term => term && normalize(lemma).includes(normalize(term)));
                fields[category].present = fields[category].surface.length > 0 || fields[category].lemma.length > 0;
            }
            return {lp: source.lp, url: source.url, chars: text.length, words: text.split(/\s+/).filter(Boolean).length, error, extraction, coverage: fields};
        });
        report.variants[`${parser}_morfeusz`] = {parser, morphology: 'morfeusz2', summary: summarize(rows), rows};
    }
} catch (error) {
    report.morfeusz.error = error.message;
}

const outputPath = path.isAbsolute(opts.out) ? opts.out : path.join(repoRoot, opts.out);
await fs.mkdir(path.dirname(outputPath), {recursive: true});
await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({out: outputPath, source_count: sources.length, variants: Object.keys(report.variants), morfeusz: report.morfeusz}, null, 2));
