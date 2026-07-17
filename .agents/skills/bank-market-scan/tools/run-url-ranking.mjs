#!/usr/bin/env node
import {Command} from 'commander';
import {readJson} from './lib/common.mjs';
import {rankManifest} from './lib/url-ranking.mjs';

const program = new Command();
program
    .requiredOption('--manifest <path>', 'input manifest JSON')
    .option('--no-opencode', 'use deterministic ranking')
    .parse(process.argv);
const opts = program.opts();
const manifest = await readJson(opts.manifest);
const result = await rankManifest(manifest, {useOpenCode: opts.opencode});
console.log(JSON.stringify({
    provider: result.provider,
    manifest: result.manifestPath,
    raw_response: result.rawPath,
    ranking: result.outputPath
}, null, 2));
