import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {sha256} from '../../.agents/skills/bank-market-scan/tools/lib/common.mjs';
import {normalizationArtifactPath} from '../../.agents/skills/bank-market-scan/tools/lib/normalization-artifact.mjs';
import {readReviewContext} from '../../.agents/skills/bank-market-scan/tools/read-review-context.mjs';

async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function writeJsonl(filePath, rows) {
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
}

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-review-context-'));
    const runDir = path.join(root, 'runs', 'run-context');
    const cacheDir = path.join(root, 'cache', '001-bank-1');
    const text = 'Kredyt mieszkaniowy pozwala na spłatę kredytu mieszkaniowego z innego banku. Oprocentowanie okresowo stałe.';
    const url = 'https://bank.example/kredyt';
    await writeJson(path.join(runDir, 'manifest.json'), {
        schema_version: '1.0',
        run_id: 'run-context',
        institution_ids: ['bank-1'],
        lps: [1],
        mode: 'fresh',
        status: 'prepared'
    });
    await writeJson(path.join(root, 'institutions.json'), {institutions: [{lp: 1, institution_id: 'bank-1', name: 'Bank 1'}]});
    await writeJsonl(path.join(cacheDir, 'source-text.jsonl'), [{
        institution_id: 'bank-1', lp: 1, run_id: 'run-context', url, title: 'Kredyt mieszkaniowy',
        source_type: 'html', content_sha256: 'content-hash', text_sha256: sha256(text), text
    }]);
    await writeJson(path.join(cacheDir, 'candidates.json'), {
        content_check: {
            product: {status: 'present', decision_status: 'present', matches: 1, urls: [url], eligible_urls: [url]},
            refinancing: {status: 'present', decision_status: 'present', matches: 1, urls: [url], eligible_urls: [url]},
            fixed_rate: {status: 'present', decision_status: 'present', matches: 1, urls: [url], eligible_urls: [url]},
            product_relation: {status: 'confirmed'}
        }
    });
    await writeJson(normalizationArtifactPath({cacheDir, runManifestPath: path.join(runDir, 'manifest.json'), lp: 1}), {
        schema_version: '1.0', run_id: 'run-context', institution_id: 'bank-1', lp: 1,
        engine: 'morfeusz2', status: 'complete', generated_at: '2026-08-03T00:00:00Z',
        source_count: 1, normalized_source_count: 1, unreadable_source_count: 0,
        sources: [{url, content_sha256: 'content-hash', source_text_sha256: sha256(text), status: 'normalized', error: null, lemma_text: '', tokens: []}],
        keywords: {product: [], refinancing: [], fixed_rate: [], pricing: []}
    });
    await writeJsonl(path.join(runDir, 'evidence.jsonl'), [
        {run_id: 'run-context', institution_id: 'bank-1', lp: 1, evidence_id: 'ev-product', category: 'product', keyword: 'kredyt mieszkaniowy', source_role: 'core', url, title: 'Kredyt mieszkaniowy', content_sha256: 'content-hash', text_excerpt: text},
        {run_id: 'run-context', institution_id: 'bank-1', lp: 1, evidence_id: 'ev-excluded', category: 'product', keyword: 'kredyt hipoteczny', source_role: 'excluded_context', url, title: 'Kredyt hipoteczny', content_sha256: 'content-hash', text_excerpt: 'Kredyt hipoteczny dla firm.'}
    ]);
    return {root, manifestPath: path.join(runDir, 'manifest.json'), institutionsPath: path.join(root, 'institutions.json'), cacheRoot: path.join(root, 'cache')};
}

describe('read-review-context', () => {
    it('returns compact original excerpts and only requested heuristic fields', async () => {
        const paths = await fixture();
        const result = await readReviewContext({runManifestPath: paths.manifestPath, institutionsPath: paths.institutionsPath, cacheRoot: paths.cacheRoot, lp: 1, criterion: 'all', maxPerCategory: 2});
        const item = result.items[0];
        expect(item.source_coverage.normalized_source_count).toBe(1);
        expect(Object.keys(item.heuristic)).toEqual(['product', 'refinancing', 'fixed_rate']);
        expect(item.criteria.product.evidence[0].text_excerpt).toContain('spłatę');
        expect(item.criteria.product.excluded_context.evidence).toHaveLength(0);
        expect(item.criteria.product.excluded_context.evidence_ids).toEqual(['ev-excluded']);
    });

    it('supports exact evidence lookup with excluded-context excerpts', async () => {
        const paths = await fixture();
        const result = await readReviewContext({runManifestPath: paths.manifestPath, institutionsPath: paths.institutionsPath, cacheRoot: paths.cacheRoot, lp: 1, criterion: 'product', evidenceId: 'ev-excluded', includeExcludedContext: true});
        expect(result.items[0].criteria.product.evidence).toHaveLength(0);
        expect(result.items[0].criteria.product.excluded_context.evidence[0].text_excerpt).toContain('dla firm');
    });

    it('rejects evidence outside the exact run manifest', async () => {
        const paths = await fixture();
        await fs.appendFile(path.join(path.dirname(paths.manifestPath), 'evidence.jsonl'), `${JSON.stringify({
            run_id: 'run-context', institution_id: 'bank-2', lp: 2, evidence_id: 'ev-outside', category: 'product'
        })}\n`);
        await expect(readReviewContext({
            runManifestPath: paths.manifestPath,
            institutionsPath: paths.institutionsPath,
            cacheRoot: paths.cacheRoot,
            lp: 1
        })).rejects.toThrow(/outside the manifest/);
    });
});
