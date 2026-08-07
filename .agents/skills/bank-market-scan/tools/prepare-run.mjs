#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {dataPath, writeJsonAtomic} from './lib/common.mjs';
import {
    createRunManifest,
    runAnalysisStatePath,
    runAutomationStatePath,
    runEvidencePath,
    runReviewPacksPath,
    runRowUpdatesPath,
    runStatusPath
} from './lib/run-manifest.mjs';

export async function prepareRun({runId, institutions, selected, mode = 'fresh', searchEnabled = false, output} = {}) {
    const {manifest, path: manifestPath} = await createRunManifest({runId, institutions, selected, mode, search_enabled: searchEnabled, output});
    const runDir = path.dirname(manifestPath);
    await fs.mkdir(runDir, {recursive: true});
    for (const directory of ['candidates', 'source-text', 'row-updates', 'review-packs']) await fs.mkdir(path.join(runDir, directory), {recursive: true});
    const status = {
        run_id: runId,
        phase: 'prepare',
        status: 'prepared',
        manifest_path: manifestPath,
        institution_ids: manifest.institution_ids,
        lps: manifest.lps,
        state_paths: {
            analysis_state: runAnalysisStatePath(manifestPath),
            automation_state: runAutomationStatePath(manifestPath),
            evidence: runEvidencePath(manifestPath),
            row_updates: runRowUpdatesPath(manifestPath),
            review_packs: runReviewPacksPath(manifestPath)
        },
        created_at: manifest.created_at,
        updated_at: new Date().toISOString(),
        errors: []
    };
    await writeJsonAtomic(runStatusPath(manifestPath), status);
    return {manifest, manifestPath, statusPath: runStatusPath(manifestPath)};
}

async function main() {
    const program = new Command();
    program.requiredOption('--run-id <id>').requiredOption('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'));
    program.option('--from <lp>', 'start Lp', value => Number(value)).option('--limit <number>', 'count', value => Number(value), 20).option('--mode <mode>', 'run mode', 'fresh').parse(process.argv);
    const opts = program.opts();
    const institutions = JSON.parse(await fs.readFile(opts.institutions, 'utf8'));
    const selected = institutions.institutions.filter(item => opts.from == null || Number(item.lp) >= opts.from).slice(0, opts.limit);
    console.log(JSON.stringify(await prepareRun({runId: opts.runId, institutions, selected, mode: opts.mode}), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
