#!/usr/bin/env node
import path from 'node:path';
import {Command} from 'commander';
import {
    readJson,
    readJsonl,
    writeJsonl,
    sha256,
    slug,
    todayIso,
    bundledPath,
    dataPath
} from './lib/common.mjs';
import {classifySourceRole} from './lib/source-roles.mjs';
import {buildEvidenceId, writeRunEvidence} from './lib/evidence-store.mjs';
import {readRunManifest, manifestIncludes, runEvidencePath} from './lib/run-manifest.mjs';
import {
    findNormalizedSpans,
    normalizationArtifactPath,
    readNormalizationArtifact
} from './lib/normalization-artifact.mjs';

const program = new Command();
program
    .option('--lp <number>', 'institution Lp', v => parseInt(v, 10))
    .option('--cache-dir <path>', 'cache dir override')
    .option('--context <number>', 'chars around hit', v => parseInt(v, 10), 550)
    .option('--max-per-keyword <number>', 'max snippets per keyword per source', v => parseInt(v, 10), 3)
    .option('--run-manifest <path>', 'exact-scope run manifest')
    .option('--normalization-file <path>', 'normalization artifact override')
    .parse(process.argv);
const opts = program.opts();
if (!opts.lp && !opts.cacheDir) throw new Error('Pass --lp or --cache-dir.');
const institutions = opts.lp ? await readJson(dataPath('base/institutions.current.json')) : null;
const inst = opts.lp ? institutions.institutions.find(i => i.lp === opts.lp) : null;
if (opts.lp && !inst) throw new Error(`Institution with lp=${opts.lp} not found.`);
const cacheDir = opts.cacheDir || dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
const runManifest = opts.runManifest ? await readRunManifest(opts.runManifest) : null;
if (runManifest && !manifestIncludes(runManifest, inst.institution_id, inst.lp)) {
    throw new Error(`LP ${opts.lp} is outside run manifest.`);
}
const keywords = await readJson(bundledPath('schemas/evidence-keywords.json'));
const sources = await readJsonl(path.join(cacheDir, 'source-text.jsonl'));
const normalizationFile = opts.normalizationFile || normalizationArtifactPath({
    cacheDir,
    runManifestPath: opts.runManifest,
    lp: opts.lp
});
const normalization = await readNormalizationArtifact(normalizationFile, {runId: runManifest?.run_id || null});
const normalizedSources = new Map(normalization.sources.map(source => [source.url, source]));
const normalizedKeywords = Object.fromEntries(Object.entries(normalization.keywords).map(([category, terms]) => [
    category,
    new Map(terms.map(term => [term.keyword, term]))
]));
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
    const normalizedSource = normalizedSources.get(src.url);
    if (!normalizedSource) throw new Error(`Missing normalization result for source: ${src.url}`);
    const expectedTextHash = sha256(src.text);
    if (normalizedSource.source_text_sha256 !== expectedTextHash) {
        throw new Error(`Normalization text hash mismatch for source: ${src.url}`);
    }
    const sourceMatches = new Map();
    for (const [category, words] of Object.entries(keywords)) {
        const categoryMatches = [];
        for (const keyword of words) {
            const normalizedKeyword = normalizedKeywords[category]?.get(keyword);
            categoryMatches.push(...findNormalizedSpans(src.text, normalizedSource, normalizedKeyword, {
                context: opts.context,
                maxMatches: opts.maxPerKeyword
            }).map(snippet => ({category, keyword, ...snippet})));
        }
        if (categoryMatches.length) sourceMatches.set(category, categoryMatches);
    }
    const sourceCategories = [...sourceMatches.keys()];
    const source_role = classifySourceRole(src, sourceCategories);
    for (const [category, matches] of sourceMatches) {
        for (const snippet of matches) {
            const key = `${src.url}|${category}|${snippet.keyword}|${snippet.source_start}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const evidence = {
                run_id: src.run_id || runManifest?.run_id || null,
                institution_id: src.institution_id,
                lp: src.lp,
                name: src.name,
                product_id: src.product_id || null,
                field_path: category,
                category,
                keyword: snippet.keyword,
                match_type: 'lemma',
                url: src.url,
                title: src.title,
                source_type: src.source_type,
                source: src.source || null,
                content_sha256: src.content_sha256 || null,
                fetched_at: src.fetched_at || todayIso(),
                text_excerpt: snippet.text_excerpt,
                used_for_decision: false,
                ...discoveryMeta,
                source_role
            };
            evidence.evidence_id = buildEvidenceId(evidence);
            rows.push(evidence);
        }
    }
}
await writeJsonl(path.join(cacheDir, 'evidence.candidates.jsonl'), rows);
if (runManifest) await writeRunEvidence(runEvidencePath(opts.runManifest), rows, runManifest.run_id);
console.log(`Found ${rows.length} evidence snippets in ${cacheDir}`);
