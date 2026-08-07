#!/usr/bin/env node
import {Command} from 'commander';
import {readJson, writeJsonAtomic} from './lib/common.mjs';
import {readRunManifest, runStatusPath} from './lib/run-manifest.mjs';

export async function abortRun({runManifestPath, reason = 'aborted by operator'} = {}) {
    const manifest = await readRunManifest(runManifestPath);
    const statusPath = runStatusPath(runManifestPath);
    const current = await readJson(statusPath, {});
    if (current.status === 'finalized') throw new Error('Cannot abort a finalized run.');
    const status = {...current, run_id: manifest.run_id, phase: 'abort', status: 'aborted', reason, aborted_at: new Date().toISOString(), manifest_path: runManifestPath};
    await writeJsonAtomic(statusPath, status);
    return status;
}

async function main() {
    const program = new Command();
    program.requiredOption('--run-manifest <path>').requiredOption('--reason <reason>');
    program.parse(process.argv);
    const opts = program.opts();
    console.log(JSON.stringify(await abortRun({runManifestPath: opts.runManifest, reason: opts.reason}), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
