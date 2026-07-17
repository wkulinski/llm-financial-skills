#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Command} from 'commander';
import * as cheerio from 'cheerio';
import {htmlToText} from 'html-to-text';
import {createRequire} from 'node:module';
import {readJson, writeJsonl, cleanWhitespace, slug, todayIso, sha256, dataPath} from './lib/common.mjs';
import {validateCandidateCaches} from './lib/source-integrity.mjs';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const program = new Command();
program
    .option('--lp <number>', 'institution Lp', v => parseInt(v, 10))
    .option('--cache-dir <path>', 'cache dir override')
    .option('--prefer-pdftotext', 'use external pdftotext -layout when available', true)
    .parse(process.argv);
const opts = program.opts();
if (!opts.lp && !opts.cacheDir) throw new Error('Pass --lp or --cache-dir.');
const institutions = opts.lp ? await readJson(dataPath('base/institutions.current.json')) : null;
const inst = opts.lp ? institutions.institutions.find(i => i.lp === opts.lp) : null;
if (opts.lp && !inst) throw new Error(`Institution with lp=${opts.lp} not found.`);
const cacheDir = opts.cacheDir || dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
const candidates = await readJson(path.join(cacheDir, 'candidates.json'));
const rows = [];
const integrityCandidates = candidates.all_candidates?.length ? candidates.all_candidates : (candidates.candidates || []);
const cacheIntegrityErrors = await validateCandidateCaches(integrityCandidates);
const discoveryMeta = {
    discovery_mode: candidates.discovery_mode || null,
    search_provider_status: candidates.search_provider_status || null,
    search_quality_flags: candidates.search_quality_flags || [],
    product_relation: candidates.product_relation || null,
    sufficient_for_search_first: candidates.sufficient_for_search_first ?? null,
    sufficient_for_analysis: candidates.sufficient_for_analysis ?? null,
    sufficiency_basis: candidates.sufficiency_basis || null
};

function pdftotextAvailable() {
    const r = spawnSync('pdftotext', ['-v'], {encoding: 'utf8'});
    return r.status === 0 || /pdftotext/i.test(`${r.stdout}${r.stderr}`);
}

const canUsePdftotext = opts.preferPdftotext && pdftotextAvailable();

function cleanStructuredWhitespace(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

function htmlToStructuredText(html) {
    const $ = cheerio.load(html);
    $('script,style,nav,footer,header,form,noscript,svg').remove();
    $('h1,h2,h3,h4,h5,h6').each((_, el) => {
        const level = Number(el.tagName.slice(1));
        $(el).prepend(`${'#'.repeat(level)} `).append('\n');
    });
    $('tr').each((_, el) => $(el).append('\n'));
    return cleanStructuredWhitespace(htmlToText($.html(), {
        wordwrap: false,
        selectors: [{selector: 'a', options: {ignoreHref: true}}]
    }));
}

async function extractPdfText(filePath, buffer) {
    if (canUsePdftotext) {
        const outPath = `${filePath}.layout.txt`;
        const r = spawnSync('pdftotext', ['-layout', filePath, outPath], {encoding: 'utf8'});
        if (r.status === 0) {
            const txt = await fs.readFile(outPath, 'utf8');
            if (txt.trim()) return {text: txt, extractor: 'pdftotext-layout'};
        }
    }
    const parsed = await pdfParse(buffer);
    return {text: parsed.text || '', extractor: 'pdf-parse'};
}

for (const c of candidates.candidates || []) {
    if (!c.cache_file) continue;
    try {
        const candidateIntegrityErrors = cacheIntegrityErrors
            .filter(error => error.url === c.url || error.cache_file === c.cache_file)
            .map(error => error.type);
        const sourceIntegrityErrors = c.source_integrity_severity === 'warning'
            ? []
            : (c.source_integrity_flags || []);
        if (sourceIntegrityErrors.length || candidateIntegrityErrors.length) {
            throw new Error([...new Set([...sourceIntegrityErrors, ...candidateIntegrityErrors])].join(','));
        }
        const buf = await fs.readFile(c.cache_file);
        let text = '';
        let type = 'html';
        let extractor = 'html-to-text';
        if (/\.pdf$/i.test(c.cache_file) || /pdf/i.test(c.content_type || '')) {
            type = 'pdf';
            const out = await extractPdfText(c.cache_file, buf);
            text = out.text;
            extractor = out.extractor;
        } else {
            const html = buf.toString('utf8');
            text = htmlToStructuredText(html);
        }
        rows.push({
            institution_id: candidates.institution_id,
            lp: candidates.lp,
            name: candidates.name,
            run_id: candidates.run_id || null,
            url: c.final_url || c.url,
            title: c.title,
            source_type: type,
            source: c.source || null,
            selected_seed: c.selected_seed === true,
            positive_signals: c.positive_signals || [],
            negative_signals: c.negative_signals || [],
            cache_file: c.cache_file,
            fetched_at: c.fetched_at || todayIso(),
            content_sha256: c.content_sha256 || sha256(buf),
            content_length: c.content_length || buf.length,
            extractor,
            text_sha256: sha256(text),
            text: type === 'html' ? cleanStructuredWhitespace(text) : cleanWhitespace(text),
            ...discoveryMeta
        });
    } catch (err) {
        rows.push({
            institution_id: candidates.institution_id,
            lp: candidates.lp,
            name: candidates.name,
            run_id: candidates.run_id || null,
            url: c.url,
            title: c.title,
            source_type: 'error',
            source: c.source || null,
            fetched_at: todayIso(),
            text: '',
            error: err.message,
            ...discoveryMeta
        });
    }
}
await writeJsonl(path.join(cacheDir, 'source-text.jsonl'), rows);
console.log(`Extracted ${rows.length} text sources to ${path.join(cacheDir, 'source-text.jsonl')}`);
