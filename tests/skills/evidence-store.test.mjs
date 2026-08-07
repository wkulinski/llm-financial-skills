import {describe, expect, it} from 'vitest';
import {buildEvidenceId, mergeEvidence, validateFieldEvidenceReferences} from '../../.agents/skills/bank-market-scan/tools/lib/evidence-store.mjs';

const base = {
    run_id: 'run-1',
    institution_id: 'bank-1',
    lp: 1,
    product_id: 'product-1',
    field_path: 'product',
    category: 'product',
    url: 'https://bank.example/product',
    content_sha256: 'sha-1',
    fetched_at: '2026-08-03T00:00:00Z',
    text_excerpt: 'Kredyt mieszkaniowy'
};

describe('run evidence store', () => {
    it('creates a deterministic id without run_id in the hash material', () => {
        const first = buildEvidenceId(base);
        const second = buildEvidenceId({...base, run_id: 'run-2'});
        expect(first).toMatch(/^ev-[a-f0-9]{24}$/);
        expect(second).toBe(first);
    });

    it('deduplicates unchanged evidence but preserves decision usage', () => {
        const merged = mergeEvidence([{...base, evidence_id: buildEvidenceId(base), used_for_decision: false}], [{...base, evidence_id: buildEvidenceId(base), used_for_decision: true}]);
        expect(merged).toHaveLength(1);
        expect(merged[0].used_for_decision).toBe(true);
    });

    it('rejects foreign run, URL and source hash references', () => {
        const evidence = {...base, evidence_id: buildEvidenceId(base)};
        const errors = validateFieldEvidenceReferences([{
            lp: 1,
            institution_id: 'bank-1',
            field_evidence: {housing: [{evidence_id: evidence.evidence_id, url: 'https://other.example', content_sha256: 'sha-old'}]}
        }], [{...evidence, run_id: 'old-run'}], {runId: 'run-1', strict: true});
        expect(errors.join('\n')).toMatch(/run_id mismatch|url mismatch|content hash mismatch/);
    });
});
