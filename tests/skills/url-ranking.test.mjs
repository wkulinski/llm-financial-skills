import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
    buildRankingManifest,
    deterministicRank,
    rankManifest,
    normalizeCompactRanking,
    selectAdditionalPool,
    selectInitialPool,
    validateRanking
} from '../../.agents/skills/bank-market-scan/tools/lib/url-ranking.mjs';

function manifestWithCandidates(candidates = []) {
    return buildRankingManifest({
        institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
        homepageUrl: 'https://bank.example/',
        runId: 'run-test',
        candidates: candidates.map(url => ({url, title: url, source: 'homepage', relation: 'same_host'}))
    });
}

describe('URL ranking contract', () => {
    it('creates stable IDs and keeps every input URL in the deterministic ranking', () => {
        const manifest = manifestWithCandidates([
            'https://bank.example/kredyt-mieszkaniowy',
            'https://bank.example/tabela-oprocentowania.pdf',
            'https://bank.example/karta'
        ]);
        const ranking = deterministicRank(manifest);
        expect(new Set(ranking.ranked_candidates.map(item => item.url))).toEqual(new Set(manifest.candidates.map(item => item.url)));
        expect(ranking.ranked_candidates[0].priority).toBe(3);
        expect(ranking.ranked_candidates.at(-1).role).toBe('excluded_context');
        expect(validateRanking(manifest, ranking).ok).toBe(true);
    });

    it('rejects added, modified, duplicated, and mismatched candidates', () => {
        const manifest = manifestWithCandidates(['https://bank.example/offer']);
        const ranking = deterministicRank(manifest);
        ranking.ranked_candidates[0].url = 'https://bank.example/changed';
        ranking.ranked_candidates.push({...ranking.ranked_candidates[0], url: 'https://bank.example/other'});
        ranking.run_id = 'other-run';
        const result = validateRanking(manifest, ranking, {allowPartial: false});
        expect(result.ok).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining(['run_id_mismatch', 'candidate_url_mismatch', 'duplicate_candidate']));
    });

    it('rejects an obvious product/noise priority inversion', () => {
        const manifest = manifestWithCandidates([
            'https://bank.example/kredyt-mieszkaniowy',
            'https://bank.example/karta-kredytowa'
        ]);
        const ranking = deterministicRank(manifest);
        ranking.ranked_candidates[0].priority = 0;
        ranking.ranked_candidates[1].priority = 3;
        const result = validateRanking(manifest, ranking);
        expect(result.ok).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining(['obvious_product_misclassified', 'obvious_noise_misclassified']));
    });

    it('accepts equivalent URL identity forms and restores the manifest URL', () => {
        const manifest = manifestWithCandidates(['https://bank.example/offer']);
        const ranking = deterministicRank(manifest);
        ranking.ranked_candidates[0].url = 'https://www.bank.example/offer/';
        const result = validateRanking(manifest, ranking);
        expect(result.ok).toBe(true);
        expect(result.normalized.ranked_candidates[0].url).toBe('https://bank.example/offer');
    });

    it('deduplicates equivalent URL forms before assigning candidate IDs', () => {
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-test',
            candidates: [
                {url: 'https://bank.example/offer', title: 'Offer', source: 'homepage', relation: 'same_host'},
                {url: 'https://www.bank.example/offer/', title: 'Offer duplicate', source: 'sitemap', relation: 'same_host'}
            ]
        });
        expect(manifest.candidates).toHaveLength(1);
    });

    it('fills a compact model entry URL only from its known candidate ID', () => {
        const manifest = manifestWithCandidates(['https://bank.example/offer']);
        const compact = {
            ranked_candidates: [{candidate_id: manifest.candidates[0].candidate_id, priority: 1, role: 'unknown', reason: 'Ambiguous.', model_confidence: 'low'}]
        };
        expect(normalizeCompactRanking(manifest, compact).ranked_candidates[0].url).toBe('https://bank.example/offer');
    });

    it('fills omitted candidates as unknown safety entries', () => {
        const manifest = manifestWithCandidates(['https://bank.example/one', 'https://bank.example/two']);
        const ranking = deterministicRank(manifest);
        ranking.ranked_candidates.pop();
        const result = validateRanking(manifest, ranking);
        expect(result.ok).toBe(true);
        expect(result.normalized.ranked_candidates).toHaveLength(2);
        expect(result.normalized.ranked_candidates.at(-1).role).toBe('unknown');
        expect(result.normalized.ranked_candidates.at(-1).priority).toBe(0);
    });

    it('selects a bounded diverse initial pool without requiring a fixed count', () => {
        const manifest = manifestWithCandidates([
            'https://bank.example/kredyt-mieszkaniowy-refinansowanie',
            'https://bank.example/oprocentowanie-stale',
            'https://bank.example/tabela.pdf'
        ]);
        const ranking = deterministicRank(manifest);
        const pool = selectInitialPool(ranking, manifest.candidates, {min: 12, max: 16});
        expect(pool).toHaveLength(3);
        expect(new Set(pool.map(item => item.url)).size).toBe(3);
    });

    it('writes normalized artifacts and continues when OpenCode is unavailable', async () => {
        const manifest = manifestWithCandidates(['https://bank.example/kredyt-mieszkaniowy']);
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-'));
        const result = await rankManifest(manifest, {useOpenCode: false, workDir});
        expect(result.provider).toBe('deterministic');
        expect(result.ranking.ranked_candidates).toHaveLength(1);
        const output = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
        expect(output.model.provider).toBe('deterministic');
        expect(output.ranked_candidates[0]).not.toHaveProperty('candidate_ref');
    });

    it('expands the pool toward a missing evidence category', () => {
        const manifest = manifestWithCandidates([
            'https://bank.example/kredyt-mieszkaniowy',
            'https://bank.example/refinansowanie-kredytu',
            'https://bank.example/tabela-oprocentowania-stale'
        ]);
        const ranking = deterministicRank(manifest);
        const next = selectAdditionalPool(ranking, manifest.candidates, {
            alreadyFetchedUrls: [manifest.candidates[0].url],
            missingCategories: ['refinancing'],
            limit: 1
        });
        expect(next).toHaveLength(1);
        expect(next[0].url).toContain('refinansowanie');
    });

    it('splits large manifests and writes a diagnostic validation report', async () => {
        const manifest = manifestWithCandidates([
            'https://bank.example/kredyt-mieszkaniowy',
            'https://bank.example/oprocentowanie-stale',
            'https://bank.example/tabela-oprocentowania.pdf'
        ]);
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-chunks-'));
        const result = await rankManifest(manifest, {useOpenCode: false, workDir, maxCandidates: 1});
        const report = JSON.parse(await fs.readFile(result.validationPath, 'utf8'));
        expect(report.chunk_count).toBe(3);
        expect(report.candidate_count).toBe(3);
        expect(report.chunks).toHaveLength(3);
        expect(report.final_provider).toBe('deterministic');
    });
});
