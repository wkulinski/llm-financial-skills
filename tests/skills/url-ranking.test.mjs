import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
    buildRankingManifest,
    inventorySha256,
    deterministicRank,
    obviousNoiseReason,
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

    it('keeps locked noise in the diagnostic manifest but excludes it from the model input', async () => {
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-test',
            candidates: [
                {url: 'https://bank.example/kredyt-mieszkaniowy', title: 'Kredyt mieszkaniowy', source: 'search', relation: 'same_host'},
                {url: 'https://bank.example/karty', title: 'Karty płatnicze', source: 'homepage', relation: 'same_host'},
                {url: 'https://bank.example/polityka-cookies', title: 'Polityka prywatności i cookies', source: 'homepage', relation: 'same_host'}
            ]
        });
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-noise-'));
        const result = await rankManifest(manifest, {useOpenCode: false, workDir});
        const modelInput = JSON.parse(await fs.readFile(path.join(workDir, 'run-test', 'bank_a', 'url-ranking-input.model.json'), 'utf8'));
        const validationReport = JSON.parse(await fs.readFile(result.validationPath, 'utf8'));

        expect(manifest.candidates).toHaveLength(3);
        expect(manifest.discovery.locked_noise_count).toBe(2);
        expect(modelInput.candidates.map(candidate => candidate.url)).toEqual(['https://bank.example/kredyt-mieszkaniowy']);
        expect(result.ranking.ranked_candidates).toHaveLength(3);
        expect(result.ranking.ranked_candidates.filter(candidate => candidate.role === 'excluded_context')).toHaveLength(2);
        expect(result.ranking.ranked_candidates.find(candidate => candidate.url.endsWith('/karty')).reason).toContain('Locked noise');
        expect(obviousNoiseReason({url: 'https://bank.example/polityka-cookies', title: '', anchor_text: ''})).toBe('privacy');
        expect(validationReport.locked_candidate_count).toBe(2);
    });

    it('keeps hard-excluded URLs in diagnostics but never sends them to the model or selection', async () => {
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-hard-exclusion',
            candidates: [
                {url: 'https://bank.example/kredyt-mieszkaniowy', title: 'Kredyt mieszkaniowy', source: 'search'},
                {url: 'https://bank.example/dla-ciebie/kredyty', title: 'Kredyty', source: 'search', status: 403, available: false},
                {url: 'https://bank.example/page/2/?et_blog=', title: 'Starsze wpisy', source: 'homepage'}
            ]
        });
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-hard-exclusion-'));
        const result = await rankManifest(manifest, {useOpenCode: false, workDir});
        const modelInput = JSON.parse(await fs.readFile(path.join(workDir, 'run-hard-exclusion', 'bank_a', 'url-ranking-input.model.json'), 'utf8'));
        const selected = selectInitialPool(result.ranking, manifest.candidates);

        expect(manifest.candidates).toHaveLength(3);
        expect(manifest.discovery.hard_excluded_count).toBe(2);
        expect(modelInput.candidates.map(candidate => candidate.url)).toEqual(['https://bank.example/kredyt-mieszkaniowy']);
        expect(result.ranking.ranked_candidates.filter(candidate => candidate.role === 'excluded_context')).toHaveLength(2);
        expect(selected.map(candidate => candidate.url)).toEqual(['https://bank.example/kredyt-mieszkaniowy']);
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
            'https://bank.example/tabela.pdf',
            'https://bank.example/karty'
        ]);
        const ranking = deterministicRank(manifest);
        const pool = selectInitialPool(ranking, manifest.candidates, {min: 12, max: 16});
        expect(pool).toHaveLength(3);
        expect(new Set(pool.map(item => item.url)).size).toBe(3);
        expect(pool.map(item => item.url)).not.toContain('https://bank.example/karty');
    });

    it('writes normalized artifacts and continues when OpenCode is unavailable', async () => {
        const manifest = manifestWithCandidates(['https://bank.example/kredyt-mieszkaniowy']);
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-'));
        const result = await rankManifest(manifest, {useOpenCode: false, workDir});
        expect(result.provider).toBe('deterministic');
        expect(result.ranking.ranked_candidates).toHaveLength(1);
        const output = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
        expect(output.model.provider).toBe('deterministic');
        expect(output.ranked_candidates[0].candidate_ref).toBe(manifest.candidates[0].candidate_ref);
        const selectionReport = JSON.parse(await fs.readFile(result.selectionReportPath, 'utf8'));
        expect(selectionReport).toMatchObject({
            schema_version: '1.1',
            institution_id: 'bank_a',
            run_id: 'run-test',
            provider: 'deterministic',
            candidate_count: 1,
            selected_pool: ['https://bank.example/kredyt-mieszkaniowy']
        });
        expect(selectionReport.selected_pool_coverage).toContain('product');
        expect(selectionReport.timings_ms.ranking).toBeGreaterThanOrEqual(0);
        expect(path.basename(result.selectionReportPath)).toBe('selection-report.json');
    });

    it('uses the full deterministic ranking after an OpenCode transport failure', async () => {
        const manifest = manifestWithCandidates([
            'https://bank.example/kredyt-mieszkaniowy',
            'https://bank.example/refinansowanie-kredytu'
        ]);
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-fallback-'));
        const result = await rankManifest(manifest, {
            workDir,
            useOpenCode: true,
            retries: 0,
            spawnImpl: () => { throw new Error('opencode unavailable'); }
        });
        const report = JSON.parse(await fs.readFile(result.validationPath, 'utf8'));

        expect(result.provider).toBe('deterministic_fallback');
        expect(result.ranking.ranked_candidates).toHaveLength(2);
        expect(report.attempts).toEqual([expect.objectContaining({status: 'error'})]);
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

    it('supports pricing as a missing category and compares fetched URLs by identity', () => {
        const manifest = manifestWithCandidates([
            'https://bank.example/tabela-oprocentowania.pdf',
            'https://bank.example/tabela-oprocentowania-2.pdf'
        ]);
        const ranking = deterministicRank(manifest);
        const next = selectAdditionalPool(ranking, manifest.candidates, {
            alreadyFetchedUrls: ['https://bank.example/tabela-oprocentowania.pdf#fragment'],
            missingCategories: ['pricing'],
            limit: 1
        });
        expect(next).toHaveLength(1);
        expect(next[0].url).toBe('https://bank.example/tabela-oprocentowania-2.pdf');
    });

    it('ranks the full model inventory without chunking', async () => {
        const manifest = manifestWithCandidates(Array.from({length: 31}, (_, index) => `https://bank.example/offer-${index + 1}`));
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-full-inventory-'));
        const result = await rankManifest(manifest, {useOpenCode: false, workDir});
        const report = JSON.parse(await fs.readFile(result.validationPath, 'utf8'));
        const runFiles = await fs.readdir(path.join(workDir, 'run-test', 'bank_a'));
        expect(runFiles.some(file => file.includes('.part-'))).toBe(false);
        expect(report.candidate_count).toBe(31);
        expect(report.model_input_count).toBe(31);
        expect(report).not.toHaveProperty('chunk_count');
        expect(result.ranking.ranked_candidates).toHaveLength(31);
        expect(report.final_provider).toBe('deterministic');
    });

    it('adds discovery metadata and a stable inventory hash to version 1.1 manifests', () => {
        const candidates = [{
            url: 'https://bank.example/offer',
            title: 'Offer',
            anchor_text: 'Offer',
            snippet: 'Mortgage offer',
            source: 'search',
            query: 'kredyt hipoteczny',
            search_rank: 2,
            relation: 'same_host',
            technical_status: 'candidate',
            material_sha256: 'runtime-only',
            cache_file: 'runtime-only'
        }];
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-test',
            candidates,
            discovery: {mode: 'search_first', complete: true}
        });
        expect(manifest.schema_version).toBe('1.1');
        expect(manifest.discovery).toMatchObject({
            mode: 'search_first',
            complete: true,
            candidate_count: 1,
            model_candidate_count: 1,
            locked_noise_count: 0
        });
        expect(manifest.discovery.inventory_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(manifest.discovery.inventory_sha256).toBe(inventorySha256(manifest.candidates));
        expect(manifest.discovery.inventory_sha256).toBe(inventorySha256([{...candidates[0], material_sha256: 'changed'}]));
    });

    it('keeps the inventory hash stable when discovery returns candidates in another order', () => {
        const candidates = [
            {url: 'https://bank.example/second', title: 'Second', source: 'search', relation: 'same_host'},
            {url: 'https://bank.example/first', title: 'First', source: 'homepage', relation: 'same_host'}
        ];
        expect(inventorySha256(candidates)).toBe(inventorySha256([...candidates].reverse()));
    });

    it('reads a legacy 1.0 manifest without requiring stage 1 metadata', () => {
        const current = manifestWithCandidates(['https://bank.example/offer']);
        const legacy = {...current, schema_version: '1.0'};
        delete legacy.discovery;
        const ranking = deterministicRank(legacy);
        expect(validateRanking(legacy, ranking).ok).toBe(true);
        expect(ranking.schema_version).toBe('1.0');
        expect(ranking.ranked_candidates[0]).not.toHaveProperty('candidate_ref');
    });

    it('runs a legacy 1.0 manifest through rankManifest and preserves the legacy output shape', async () => {
        const current = manifestWithCandidates(['https://bank.example/offer']);
        const legacy = {...current, schema_version: '1.0'};
        delete legacy.discovery;
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'url-ranking-legacy-'));
        const result = await rankManifest(legacy, {useOpenCode: false, workDir});
        const output = JSON.parse(await fs.readFile(result.outputPath, 'utf8'));
        expect(result.validation.ok).toBe(true);
        expect(output.schema_version).toBe('1.0');
        expect(output.ranked_candidates[0]).not.toHaveProperty('candidate_ref');
    });

    it('normalizes a compact 1.1 response from candidate_ref and restores known URL data', () => {
        const manifest = manifestWithCandidates(['https://bank.example/offer']);
        const compact = {
            schema_version: '1.1',
            institution_id: manifest.institution_id,
            run_id: manifest.run_id,
            ranked_candidates: [{
                candidate_ref: manifest.candidates[0].candidate_ref,
                priority: 2,
                role: 'core',
                reason: 'Metadata identifies a mortgage offer.',
                model_confidence: 'medium'
            }],
            model: {provider: 'opencode', model: 'test', prompt_version: '1'}
        };
        const normalized = normalizeCompactRanking(manifest, compact);
        expect(normalized.ranked_candidates[0]).toMatchObject({
            candidate_ref: manifest.candidates[0].candidate_ref,
            candidate_id: manifest.candidates[0].candidate_id,
            url: manifest.candidates[0].url
        });
        expect(validateRanking(manifest, normalized, {allowPartial: false}).ok).toBe(true);
    });

    it('rejects duplicate refs, duplicate identities and inconsistent discovery counts', () => {
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-test',
            candidates: [
                {url: 'https://bank.example/one', title: 'One', source: 'homepage', relation: 'same_host'},
                {url: 'https://bank.example/two', title: 'Two', source: 'homepage', relation: 'same_host'}
            ]
        });
        manifest.candidates[1].candidate_ref = manifest.candidates[0].candidate_ref;
        manifest.discovery.model_candidate_count += 1;
        const result = validateRanking(manifest, deterministicRank(manifest));
        expect(result.ok).toBe(false);
        expect(result.errors).toEqual(expect.arrayContaining([
            'duplicate_candidate_ref',
            'discovery_candidate_breakdown_mismatch'
        ]));

        const duplicateUrl = manifestWithCandidates(['https://bank.example/one', 'https://bank.example/two']);
        duplicateUrl.candidates[1].url = duplicateUrl.candidates[0].url;
        const duplicateUrlResult = validateRanking(duplicateUrl, deterministicRank(duplicateUrl));
        expect(duplicateUrlResult.errors).toContain('duplicate_candidate_url');
    });

    it('rejects a changed inventory under the same ranking run', () => {
        const manifest = manifestWithCandidates(['https://bank.example/offer']);
        const ranking = deterministicRank(manifest);
        manifest.discovery.inventory_sha256 = '0'.repeat(64);
        const result = validateRanking(manifest, ranking);
        expect(result.ok).toBe(false);
        expect(result.errors).toContain('inventory_hash_mismatch');
    });
});
