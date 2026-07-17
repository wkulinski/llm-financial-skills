#!/usr/bin/env node
import path from 'node:path';
import {Command} from 'commander';
import {
    readJson,
    readJsonl,
    writeJsonl,
    normalizeText,
    slug,
    todayIso,
    findAllNormalizedSnippets,
    sha1,
    bundledPath,
    dataPath
} from './lib/common.mjs';
import {classifySourceRole} from './lib/source-roles.mjs';

const program = new Command();
program
    .option('--lp <number>', 'institution Lp', v => parseInt(v, 10))
    .option('--cache-dir <path>', 'cache dir override')
    .option('--context <number>', 'chars around hit', v => parseInt(v, 10), 550)
    .option('--max-per-keyword <number>', 'max snippets per keyword per source', v => parseInt(v, 10), 3)
    .parse(process.argv);
const opts = program.opts();
if (!opts.lp && !opts.cacheDir) throw new Error('Pass --lp or --cache-dir.');
const institutions = opts.lp ? await readJson(dataPath('base/institutions.current.json')) : null;
const inst = opts.lp ? institutions.institutions.find(i => i.lp === opts.lp) : null;
if (opts.lp && !inst) throw new Error(`Institution with lp=${opts.lp} not found.`);
const cacheDir = opts.cacheDir || dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
const keywords = await readJson(bundledPath('schemas/evidence-keywords.json'));
const sources = await readJsonl(path.join(cacheDir, 'source-text.jsonl'));
const discoveryMeta = sources[0] ? {
    run_id: sources[0].run_id || null,
    discovery_mode: sources[0].discovery_mode || null,
    search_provider_status: sources[0].search_provider_status || null,
    search_quality_flags: sources[0].search_quality_flags || [],
    product_relation: sources[0].product_relation || null,
    sufficient_for_search_first: sources[0].sufficient_for_search_first ?? null,
    sufficient_for_analysis: sources[0].sufficient_for_analysis ?? null,
    sufficiency_basis: sources[0].sufficiency_basis || null
} : {};
const rows = [];
const seen = new Set();
for (const src of sources) {
    if (!src.text) continue;
    const sourceCategories = Object.entries(keywords)
        .filter(([, words]) => words.some(keyword => findAllNormalizedSnippets(src.text, keyword, 550, 1).length > 0))
        .map(([category]) => category);
    const source_role = classifySourceRole(src, sourceCategories);
    for (const [category, words] of Object.entries(keywords)) {
        for (const kw of words) {
            const snippets = findAllNormalizedSnippets(src.text, kw, opts.context, opts.maxPerKeyword);
            for (const snippet of snippets) {
                const key = `${src.url}|${category}|${normalizeText(kw)}|${snippet.source_start}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const evidence_id = sha1(`${src.institution_id}|${src.url}|${category}|${normalizeText(kw)}|${snippet.source_start}`).slice(0, 16);
                rows.push({
                    evidence_id,
                    institution_id: src.institution_id,
                    lp: src.lp,
                    name: src.name,
                    category,
                    keyword: kw,
                    url: src.url,
                    title: src.title,
                    source_type: src.source_type,
                    source: src.source || null,
                    fetched_at: src.fetched_at || todayIso(),
                    text_excerpt: snippet.text_excerpt,
                    used_for_decision: false,
                    ...discoveryMeta,
                    source_role
                });
            }
        }
    }
}
await writeJsonl(path.join(cacheDir, 'evidence.candidates.jsonl'), rows);
console.log(`Found ${rows.length} evidence snippets in ${cacheDir}`);
