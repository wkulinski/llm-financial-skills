import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
    buildRunManifest,
    manifestIncludes,
    runAnalysisStatePath,
    runAutomationStatePath,
    runEvidencePath,
    runReviewPackPath,
    runRowUpdatePath,
    validateRunManifest
} from '../../.agents/skills/bank-market-scan/tools/lib/run-manifest.mjs';

describe('exact run manifest', () => {
    const institutions = {institutions: Array.from({length: 6}, (_, index) => ({
        lp: index + 1,
        institution_id: `bank_${index + 1}`,
        name: `Bank ${index + 1}`
    }))};

    it('contains exact institution ids and rejects records outside the scope', () => {
        const manifest = buildRunManifest({run_id: 'run-exact', institutions: institutions.institutions.slice(0, 5), mode: 'fresh'});
        expect(validateRunManifest(manifest, institutions)).toEqual([]);
        expect(manifest.lps).toEqual([1, 2, 3, 4, 5]);
        expect(manifestIncludes(manifest, 'bank_5', 5)).toBe(true);
        expect(manifestIncludes(manifest, 'bank_6', 6)).toBe(false);
    });

    it('rejects duplicate, mismatched and unknown scope entries', () => {
        const manifest = buildRunManifest({run_id: 'run-invalid', institution_ids: ['bank_1', 'bank_2'], lps: [1, 2]});
        expect(validateRunManifest({...manifest, institution_ids: ['bank_1', 'bank_1']}, institutions)).toContain('duplicate institution_ids');
        expect(validateRunManifest({...manifest, institution_ids: ['bank_1', 'bank_2'], lps: [1, 3]}, institutions)).toContain('institution/lp mismatch: bank_2 != 3');
        expect(validateRunManifest({...manifest, institution_ids: ['bank_99'], lps: [99]}, institutions)).toContain('unknown institution_id: bank_99');
    });

    it('derives run-local state and review artifact paths', () => {
        const manifestPath = path.join(os.tmpdir(), 'runs', 'run-exact', 'manifest.json');
        expect(runAnalysisStatePath(manifestPath)).toBe(path.join(os.tmpdir(), 'runs', 'run-exact', 'analysis-state.json'));
        expect(runAutomationStatePath(manifestPath)).toBe(path.join(os.tmpdir(), 'runs', 'run-exact', 'automation-state.json'));
        expect(runEvidencePath(manifestPath)).toBe(path.join(os.tmpdir(), 'runs', 'run-exact', 'evidence.jsonl'));
        expect(runReviewPackPath(manifestPath, 5)).toBe(path.join(os.tmpdir(), 'runs', 'run-exact', 'review-packs', 'lp-005.md'));
        expect(runRowUpdatePath(manifestPath, 5)).toBe(path.join(os.tmpdir(), 'runs', 'run-exact', 'row-updates', 'lp-005.json'));
    });
});
