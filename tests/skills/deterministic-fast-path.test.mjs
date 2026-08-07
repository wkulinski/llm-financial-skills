import {describe, expect, it} from 'vitest';
import {buildRankingManifest, deterministicRank, rankManifest, shouldUseOpenCode} from '../../.agents/skills/bank-market-scan/tools/lib/url-ranking.mjs';

function manifest(candidates) {
    return buildRankingManifest({
        institution: {institution_id: 'bank-1', lp: 1, name: 'Bank 1'},
        homepageUrl: 'https://bank.example/',
        runId: 'run-fast-path',
        candidates,
        discovery: {mode: 'test', complete: true}
    });
}

describe('deterministic ranking fast path', () => {
    it('does not call OpenCode for a clear deterministic product', async () => {
        const input = manifest([{url: 'https://bank.example/kredyt-mieszkaniowy-refinansowanie', title: 'Kredyt mieszkaniowy refinansowanie stała stopa', anchor_text: 'Oprocentowanie okresowo stałe', source: 'test', relation: 'same_website'}]);
        expect(shouldUseOpenCode(input, deterministicRank(input))).toBe(false);
        const result = await rankManifest(input, {workDir: '/tmp/bank-fast-path-test', useOpenCode: true, spawnImpl: () => { throw new Error('OpenCode must not run on fast path'); }});
        expect(result.provider).toBe('deterministic_fast_path');
    });

    it('marks ties and multiple product candidates as OpenCode exceptions', () => {
        const input = manifest([
            {url: 'https://bank.example/kredyt-a', title: 'Kredyt mieszkaniowy A', source: 'test', relation: 'same_website'},
            {url: 'https://bank.example/kredyt-b', title: 'Kredyt hipoteczny B', source: 'test', relation: 'same_website'}
        ]);
        expect(shouldUseOpenCode(input)).toBe(true);
    });
});
