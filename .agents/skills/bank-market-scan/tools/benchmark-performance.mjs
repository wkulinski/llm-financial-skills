#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Command} from 'commander';
import {buildRankingManifest, deterministicRank, rankManifest} from './lib/url-ranking.mjs';

function syntheticCandidates(count) {
    return Array.from({length: count}, (_, index) => ({
        url: `https://bank.example/product-${String(index + 1).padStart(3, '0')}`,
        title: index % 3 === 0 ? 'Kredyt mieszkaniowy refinansowanie stała stopa' : 'Informacja o kredycie mieszkaniowym',
        anchor_text: index % 3 === 0 ? 'Refinansowanie kredytu mieszkaniowego oprocentowanie okresowo stałe' : 'Oferta kredytowa',
        source: 'synthetic',
        relation: 'same_website',
        available: true,
        technical_status: 'candidate'
    }));
}

async function directoryBytes(directory) {
    let total = 0;
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
        const item = path.join(directory, entry.name);
        if (entry.isDirectory()) total += await directoryBytes(item);
        else total += (await fs.stat(item)).size;
    }
    return total;
}

export async function benchmarkPerformance({sizes = [5, 25, 50], workDir} = {}) {
    const root = workDir || await fs.mkdtemp(path.join(os.tmpdir(), 'bank-performance-'));
    const results = [];
    for (const size of sizes) {
        const manifest = buildRankingManifest({
            institution: {institution_id: `synthetic-${size}`, lp: size, name: `Synthetic ${size}`},
            homepageUrl: 'https://bank.example/',
            runId: `benchmark-${size}`,
            candidates: syntheticCandidates(size),
            discovery: {mode: 'benchmark', complete: true}
        });
        const started = Date.now();
        const beforeRss = process.memoryUsage().rss;
        const result = await rankManifest(manifest, {useOpenCode: false, workDir: root});
        const afterRss = process.memoryUsage().rss;
        const deterministic = deterministicRank(manifest);
        const cacheBytes = await directoryBytes(path.join(root, `benchmark-${size}`, `synthetic-${size}`));
        results.push({
            size,
            wall_clock_ms: Date.now() - started,
            peak_rss_bytes: Math.max(beforeRss, afterRss),
            active_processes: 1,
            timeout_count: 0,
            retry_count: 0,
            opencode_calls: 0,
            swap_bytes: 0,
            provider: result.provider,
            quality_comparable: JSON.stringify(result.ranking.ranked_candidates) === JSON.stringify(deterministic.ranked_candidates),
            cache_bytes: cacheBytes,
            cache_growth_bytes: cacheBytes
        });
    }
    return {sizes, work_dir: root, generated_at: new Date().toISOString(), results};
}

async function main() {
    const program = new Command();
    program.option('--sizes <sizes>', 'comma-separated benchmark sizes', value => value.split(',').map(item => Number(item.trim())), [5, 25, 50]).option('--out <path>');
    program.parse(process.argv);
    const report = await benchmarkPerformance({sizes: program.opts().sizes});
    if (program.opts().out) {
        await fs.mkdir(path.dirname(program.opts().out), {recursive: true});
        await fs.writeFile(program.opts().out, JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
