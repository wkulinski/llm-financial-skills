#!/usr/bin/env node
import path from 'node:path';
import {Command} from 'commander';
import {readJson, writeJsonAtomic, dataPath, slug} from './lib/common.mjs';
import {buildRankingManifest} from './lib/url-ranking.mjs';

const program = new Command();
program
    .option('--lp <number>', 'institution Lp', value => parseInt(value, 10))
    .option('--institution-id <id>', 'institution id')
    .option('--run-id <id>', 'ranking run id')
    .option('--candidates <path>', 'candidates.json path')
    .option('--out <path>', 'manifest output path')
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .parse(process.argv);
const opts = program.opts();
const institutions = await readJson(opts.institutions);
const institution = institutions.institutions.find(item =>
    (opts.lp && item.lp === opts.lp) || (opts.institutionId && item.institution_id === opts.institutionId)
);
if (!institution) throw new Error('Institution not found.');
const cacheDir = dataPath('cache/institutions', `${String(institution.lp).padStart(3, '0')}-${slug(institution.name)}`);
const candidatesPath = opts.candidates || path.join(cacheDir, 'candidates.json');
const candidates = await readJson(candidatesPath);
const runId = opts.runId || candidates.run_id || `run-${Date.now()}-${process.pid}`;
const manifest = buildRankingManifest({
    institution,
    homepageUrl: institution.website_url,
    runId,
    candidates: candidates.all_candidates || candidates.candidates || [],
    discovery: {
        mode: candidates.discovery_mode || 'unknown',
        complete: candidates.discovery_complete ?? false
    }
});
const out = opts.out || path.join(cacheDir, 'url-ranking-input.json');
await writeJsonAtomic(out, manifest);
console.log(out);
