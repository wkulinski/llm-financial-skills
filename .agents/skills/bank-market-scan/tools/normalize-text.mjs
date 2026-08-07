#!/usr/bin/env node
import path from 'node:path';
import {Command} from 'commander';
import {bundledPath, dataPath, readJson, readJsonl, sha256, slug} from './lib/common.mjs';
import {manifestIncludes, readRunManifest} from './lib/run-manifest.mjs';
import {prepareMorphology} from './lib/morphology.mjs';
import {
    buildNormalizationArtifact,
    normalizationArtifactPath,
    writeNormalizationArtifact
} from './lib/normalization-artifact.mjs';

const program = new Command();
program
    .option('--lp <number>', 'institution Lp', value => parseInt(value, 10))
    .option('--cache-dir <path>', 'institution cache directory override')
    .option('--run-manifest <path>', 'exact-scope run manifest')
    .option('--output <path>', 'normalization artifact output path')
    .parse(process.argv);

const opts = program.opts();
if (opts.lp == null && !opts.cacheDir) throw new Error('Pass --lp or --cache-dir.');

const institutions = opts.lp == null ? null : await readJson(dataPath('base/institutions.current.json'));
const inst = opts.lp == null ? null : institutions.institutions.find(item => Number(item.lp) === opts.lp);
if (opts.lp != null && !inst) throw new Error(`Institution with lp=${opts.lp} not found.`);

const cacheDir = opts.cacheDir || dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
const sourceFile = path.join(cacheDir, 'source-text.jsonl');
const sources = await readJsonl(sourceFile);
if (!sources.length) throw new Error(`No extracted sources found at ${sourceFile}. Run extract-text first.`);

const runManifest = opts.runManifest ? await readRunManifest(opts.runManifest) : null;
for (const source of sources) {
    if (runManifest && !manifestIncludes(runManifest, source.institution_id, source.lp)) {
        throw new Error(`Source outside run manifest: institution_id=${source.institution_id} lp=${source.lp}`);
    }
}

const keywordGroups = await readJson(bundledPath('schemas/evidence-keywords.json'));
const readableSources = [];
const sourceHashes = new Map();
const uniqueSources = [];
for (const source of sources) {
    const sourceHash = sha256(source.text || '');
    if (source.url && sourceHashes.has(source.url)) {
        if (sourceHashes.get(source.url) !== sourceHash) throw new Error(`Conflicting text for source URL: ${source.url}`);
        continue;
    }
    if (source.url) sourceHashes.set(source.url, sourceHash);
    uniqueSources.push(source);
    if (!source.text || source.error) continue;
    readableSources.push({
        url: source.url,
        text: source.text,
        cache_file: source.cache_file || null
    });
}

const morphology = await prepareMorphology(readableSources, keywordGroups);
const firstSource = sources.find(source => source.institution_id && source.lp);
const runId = runManifest?.run_id || firstSource?.run_id || null;
const artifact = buildNormalizationArtifact({
    sources: uniqueSources,
    keywordGroups,
    morphology,
    runId,
    institutionId: firstSource?.institution_id || inst?.institution_id || null,
    lp: firstSource?.lp ?? inst?.lp ?? opts.lp
});
const output = opts.output || normalizationArtifactPath({
    cacheDir,
    runManifestPath: opts.runManifest,
    lp: firstSource?.lp ?? inst?.lp ?? opts.lp
});
await writeNormalizationArtifact(output, artifact);
console.log(JSON.stringify({
    output,
    run_id: artifact.run_id,
    source_count: artifact.source_count,
    normalized_source_count: artifact.normalized_source_count,
    unreadable_source_count: artifact.unreadable_source_count,
    cache_hits: morphology.cache_hits,
    cache_misses: morphology.cache_misses
}));
