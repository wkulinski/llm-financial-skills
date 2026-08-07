import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {benchmarkPerformance} from '../../.agents/skills/bank-market-scan/tools/benchmark-performance.mjs';

describe('deterministic performance smoke', () => {
    it('benchmarks 5/25/50 candidates with RSS and process limits', async () => {
        const report = await benchmarkPerformance({sizes: [5, 25, 50]});
        expect(report.results.map(item => item.size)).toEqual([5, 25, 50]);
        for (const result of report.results) {
            expect(result.peak_rss_bytes).toBeGreaterThan(0);
            expect(result.active_processes).toBe(1);
            expect(result.timeout_count).toBe(0);
            expect(result.swap_bytes).toBe(0);
            expect(result.opencode_calls).toBe(0);
            expect(result.quality_comparable).toBe(true);
            expect(result.cache_growth_bytes).toBeGreaterThanOrEqual(0);
            expect(result.provider).toBe('deterministic');
        }
    });

    it('keeps the normal batch transport asynchronous and unchunked', () => {
        for (const file of ['prepare-batch.mjs', 'retry-batch.mjs', 'review-batch.mjs', 'prepare-review-pack.mjs']) {
            const source = fs.readFileSync(path.join(process.cwd(), '.agents/skills/bank-market-scan/tools', file), 'utf8');
            expect(source).not.toContain('spawnSync');
        }
        const ranking = fs.readFileSync(path.join(process.cwd(), '.agents/skills/bank-market-scan/tools/lib/url-ranking.mjs'), 'utf8');
        expect(ranking).not.toContain('.part-');
    });
});
