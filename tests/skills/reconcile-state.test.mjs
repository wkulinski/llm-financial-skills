import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {reconcileState} from '../../.agents/skills/bank-market-scan/tools/reconcile-state.mjs';

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-reconcile-'));
    const statePath = path.join(root, 'analysis-state.json');
    const evidencePath = path.join(root, 'evidence.jsonl');
    const backupsRoot = path.join(root, 'backups');
    await fs.mkdir(path.join(backupsRoot, 'old-run'), {recursive: true});
    const evidence = {
        evidence_id: 'old-evidence-1',
        run_id: 'old-run',
        institution_id: 'bank-1',
        lp: 1,
        field_path: 'qualification.housing_or_mortgage_loan_confirmed',
        category: 'product',
        url: 'https://bank.example/offer',
        content_sha256: 'content-hash',
        fetched_at: '2026-07-29',
        text_excerpt: 'Kredyt mieszkaniowy'
    };
    await fs.writeFile(path.join(backupsRoot, 'old-run', 'evidence.candidates.jsonl'), `${JSON.stringify(evidence)}\n`);
    await fs.writeFile(evidencePath, '');
    await fs.writeFile(statePath, JSON.stringify({
        schema_version: '1.0',
        rows: [{
            institution_id: 'bank-1',
            lp: 1,
            field_evidence: {
                'qualification.housing_or_mortgage_loan_confirmed': [{evidence_id: evidence.evidence_id, url: evidence.url}]
            },
            offer: {fixed_rate_period_months_exact: 60}
        }]
    }));
    return {root, statePath, evidencePath, backupsRoot, evidence};
}

describe('reconcile-state', () => {
    it('reports orphaned references without deleting or repairing by default', async () => {
        const paths = await fixture();
        const report = await reconcileState({...paths});
        expect(report.status).toBe('orphaned_references');
        expect(report.unknown_reference_count_after).toBe(1);
        expect(await fs.readFile(paths.evidencePath, 'utf8')).toBe('');
    });

    it('recovers historical evidence and normalizes legacy period fields explicitly', async () => {
        const paths = await fixture();
        const report = await reconcileState({...paths, repairFromBackups: true, normalizeState: true, failOnOrphans: true});
        expect(report.status).toBe('clean');
        expect(report.recovered_reference_count).toBe(1);
        expect(JSON.parse(await fs.readFile(paths.evidencePath, 'utf8')).evidence_id).toBe(paths.evidence.evidence_id);
        const state = JSON.parse(await fs.readFile(paths.statePath, 'utf8'));
        expect(state.rows[0].offer.fixed_rate_period_years_exact).toBe(5);
        expect(state.rows[0].offer.fixed_rate_period_months_exact).toBeUndefined();
    });
});
