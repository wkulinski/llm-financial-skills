#!/usr/bin/env node
import fs from 'node:fs/promises';
import {Command} from 'commander';
import {readJson, writeJson, dataPath} from './lib/common.mjs';
import {validateRanking} from './lib/url-ranking.mjs';

const program = new Command();
program
    .requiredOption('--manifest <path>', 'input manifest JSON')
    .requiredOption('--ranking <path>', 'ranking JSON')
    .option('--out <path>', 'normalized ranking output')
    .option('--report <path>', 'diagnostic report output', dataPath('work/url-ranking-validation.json'))
    .option('--no-fill-missing', 'fail when the model omits an input candidate')
    .parse(process.argv);
const opts = program.opts();
const manifest = await readJson(opts.manifest);
const ranking = await readJson(opts.ranking);
const result = validateRanking(manifest, ranking, {allowPartial: opts.fillMissing});
const report = {
    valid: result.ok,
    errors: result.errors,
    missing_candidate_ids: result.missing.map(candidate => candidate.candidate_id),
    manifest: opts.manifest,
    ranking: opts.ranking,
    validated_at: new Date().toISOString()
};
await writeJson(opts.report, report);
if (result.ok && opts.out) await writeJson(opts.out, result.normalized);
console.log(JSON.stringify(report, null, 2));
if (!result.ok) process.exitCode = 1;
