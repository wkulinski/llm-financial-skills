#!/usr/bin/env node
import {Command} from 'commander';
import {readJson} from './lib/common.mjs';
import {selectAdditionalPool} from './lib/url-ranking.mjs';

const program = new Command();
program
    .requiredOption('--manifest <path>', 'ranking input manifest')
    .requiredOption('--ranking <path>', 'validated ranking')
    .option('--fetched-url <url>', 'already fetched URL; repeatable', (value, previous) => [...previous, value], [])
    .option('--missing <category>', 'missing evidence category; repeatable', (value, previous) => [...previous, value], [])
    .option('--limit <number>', 'next pool size', value => parseInt(value, 10), 8)
    .parse(process.argv);
const opts = program.opts();
const manifest = await readJson(opts.manifest);
const ranking = await readJson(opts.ranking);
const selected = selectAdditionalPool(ranking, manifest.candidates, {
    alreadyFetchedUrls: opts.fetchedUrl,
    missingCategories: opts.missing,
    limit: opts.limit
});
console.log(JSON.stringify({urls: selected.map(candidate => candidate.url), candidates: selected}, null, 2));
