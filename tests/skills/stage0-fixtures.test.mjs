import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const fixtureRoot = path.resolve('tests/fixtures');

function readFixture(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), 'utf8'));
}

describe('bank market scan stage 0 fixtures', () => {
    it('keeps small, distinct search-first and crawl-fallback scenarios', () => {
        const search = readFixture('discovery-search-first.json');
        const crawl = readFixture('discovery-crawl-fallback.json');

        expect(search.scenario).toBe('search_first');
        expect(search.search.provider_status).toBe('ok');
        expect(search.expected.discovery_mode).toBe('search_first');
        expect(crawl.scenario).toBe('crawl_fallback');
        expect(crawl.search.provider_status).toBe('unavailable');
        expect(crawl.expected.discovery_mode).toBe('crawl_fallback');
        expect(search.institution.institution_id).not.toBe(crawl.institution.institution_id);
    });

    it('contains one baseline row per LP1-LP11 and internally consistent totals', () => {
        const baseline = readFixture('bank-market-scan-stage0-baseline.json');
        const rows = baseline.rows;

        expect(rows.map(row => row.lp)).toEqual(Array.from({length: 11}, (_, index) => index + 1));
        expect(rows.reduce((sum, row) => sum + row.all_candidates, 0)).toBe(baseline.aggregates.all_candidates);
        expect(rows.reduce((sum, row) => sum + row.active_candidates, 0)).toBe(baseline.aggregates.active_candidates);
        expect(rows.reduce((sum, row) => sum + row.downloaded_sources, 0)).toBe(baseline.aggregates.downloaded_sources);
        expect(Object.values(baseline.aggregates.providers).reduce((sum, count) => sum + count, 0)).toBe(rows.length);
        expect(baseline.aggregates.fallback_count).toBe(baseline.aggregates.providers.deterministic_fallback);
        expect(baseline.repository.status_short_at_capture.length).toBeGreaterThan(0);
    });
});
