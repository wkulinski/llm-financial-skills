import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {prepareRun} from '../../.agents/skills/bank-market-scan/tools/prepare-run.mjs';
import {finalizeRun} from '../../.agents/skills/bank-market-scan/tools/finalize-run.mjs';
import {abortRun} from '../../.agents/skills/bank-market-scan/tools/abort-run.mjs';
import {buildEvidenceId} from '../../.agents/skills/bank-market-scan/tools/lib/evidence-store.mjs';
import {runStatusPath} from '../../.agents/skills/bank-market-scan/tools/lib/run-manifest.mjs';

function qualifiedRow(evidence) {
    return {
        lp: 1,
        institution_id: 'bank_1',
        decision_status: 'qualified',
        review_status: 'checked',
        checked_at: '2026-08-03',
        website_available: true,
        qualifies: true,
        qualification: {
            housing_or_mortgage_loan_confirmed: true,
            refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: true,
            periodically_fixed_rate_confirmed: true,
            reason_codes: ['housing_or_mortgage_loan_confirmed', 'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed', 'periodically_fixed_rate_confirmed']
        },
        decision_audit: {
            product_scope: 'Kredyt mieszkaniowy',
            same_product_variant_confirmed: true,
            criterion_evidence_urls: {housing: [evidence.url], refinancing: [evidence.url], fixed_rate: [evidence.url]}
        },
        field_evidence: {
            'qualification.housing_or_mortgage_loan_confirmed': [evidence],
            'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed': [evidence],
            'qualification.periodically_fixed_rate_confirmed': [evidence]
        },
        offer: {fixed_rate_period_years_exact: 5, fixed_nominal_rate_exact: 0.061, rrso_exact: 0.071, rrso_description: 'wariant okresowo stały'}
    };
}

function completeReviewStatus(runId, summary = {}) {
    return {
        run_id: runId,
        phase: 'review',
        status: 'complete',
        summary: {
            selected_count: 1,
            manifest_count: 1,
            interpreted_count: 1,
            processed: 1,
            applied: 1,
            ready_for_review: 0,
            needs_user_review: 0,
            missing_row_update_count: 0,
            pending_count: 0,
            errors: 0,
            ...summary
        }
    };
}

describe('prepare/finalize/abort run lifecycle', () => {
    it('finalizes only complete staging and merges evidence idempotently', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-finalize-'));
        const institutions = {institutions: [{lp: 1, institution_id: 'bank_1', name: 'Bank 1'}]};
        const {manifestPath, statusPath} = await prepareRun({runId: 'run-finalize', institutions, selected: institutions.institutions, output: path.join(root, 'data/work/runs/run-finalize/manifest.json')});
        const runDir = path.dirname(manifestPath);
        const globalState = path.join(root, 'analysis-state.json');
        const globalAutomation = path.join(root, 'automation-state.json');
        const stagedState = path.join(runDir, 'analysis-state.json');
        const evidenceBase = {run_id: 'run-finalize', institution_id: 'bank_1', lp: 1, product_id: 'product-1', field_path: 'qualification.housing', url: 'https://bank.example/offer', content_sha256: 'sha-current', fetched_at: '2026-08-03T00:00:00Z', text_excerpt: 'Kredyt mieszkaniowy'};
        const evidence = {...evidenceBase, evidence_id: buildEvidenceId(evidenceBase)};
        await fs.writeFile(path.join(runDir, 'evidence.jsonl'), `${JSON.stringify(evidence)}\n`);
        await fs.writeFile(stagedState, JSON.stringify({schema_version: '1.0', rows: [qualifiedRow(evidence)]}));
        await fs.writeFile(path.join(runDir, 'automation-state.json'), JSON.stringify({tasks: [{lp: 1, institution_id: 'bank_1', stage: 'checked'}]}));
        await fs.writeFile(statusPath, JSON.stringify(completeReviewStatus('run-finalize')));
        await fs.writeFile(globalState, JSON.stringify({schema_version: '1.0', rows: [{lp: 99, institution_id: 'bank_other', review_status: 'checked'}]}));
        await fs.writeFile(globalAutomation, JSON.stringify({schema_version: '1.0', tasks: [{lp: 99, institution_id: 'bank_other', stage: 'checked'}]}));

        const result = await finalizeRun({runManifestPath: manifestPath, statePath: globalState, automationStatePath: globalAutomation, stagedStatePath: stagedState, globalEvidencePath: path.join(root, 'evidence.jsonl')});
        expect(result.status).toBe('finalized');
        expect(JSON.parse(await fs.readFile(statusPath, 'utf8')).status).toBe('finalized');
        expect(JSON.parse(await fs.readFile(globalState, 'utf8')).rows.find(row => row.institution_id === 'bank_1').decision_status).toBe('qualified');
        expect(JSON.parse(await fs.readFile(globalState, 'utf8')).rows.find(row => row.institution_id === 'bank_other').review_status).toBe('checked');
        expect(JSON.parse(await fs.readFile(globalAutomation, 'utf8')).tasks.find(task => task.institution_id === 'bank_other').stage).toBe('checked');
        expect((await fs.readFile(path.join(root, 'evidence.jsonl'), 'utf8')).trim().split(/\r?\n/)).toHaveLength(1);
        await expect(finalizeRun({runManifestPath: manifestPath, statePath: globalState, automationStatePath: globalAutomation, globalEvidencePath: path.join(root, 'evidence.jsonl')})).rejects.toThrow(/already finalized/);
    });

    it('blocks stale/foreign evidence and does not finalize a partial run', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-finalize-blocked-'));
        const institutions = {institutions: [{lp: 1, institution_id: 'bank_1', name: 'Bank 1'}]};
        const {manifestPath, statusPath} = await prepareRun({runId: 'run-blocked', institutions, selected: institutions.institutions, output: path.join(root, 'data/work/runs/run-blocked/manifest.json')});
        const runDir = path.dirname(manifestPath);
        const foreign = {run_id: 'old-run', institution_id: 'bank_1', lp: 1, product_id: 'product-1', field_path: 'qualification.housing', url: 'https://bank.example/offer', content_sha256: 'sha-old', fetched_at: '2026-08-03T00:00:00Z', text_excerpt: 'old'};
        foreign.evidence_id = buildEvidenceId(foreign);
        await fs.writeFile(path.join(runDir, 'evidence.jsonl'), `${JSON.stringify(foreign)}\n`);
        await fs.writeFile(path.join(runDir, 'analysis-state.json'), JSON.stringify({rows: [qualifiedRow(foreign)]}));
        await fs.writeFile(statusPath, JSON.stringify({run_id: 'run-blocked', status: 'partial'}));
        await expect(finalizeRun({runManifestPath: manifestPath, statePath: path.join(root, 'analysis-state.json'), automationStatePath: path.join(root, 'automation-state.json'), stagedStatePath: path.join(runDir, 'analysis-state.json'), globalEvidencePath: path.join(root, 'evidence.jsonl')})).rejects.toThrow(/partial/);
        await fs.writeFile(path.join(root, 'automation-state.json'), JSON.stringify({tasks: []}));
        await fs.writeFile(path.join(runDir, 'automation-state.json'), JSON.stringify({tasks: [{lp: 1, institution_id: 'bank_1', stage: 'checked'}]}));
        await fs.writeFile(statusPath, JSON.stringify(completeReviewStatus('run-blocked')));
        await expect(finalizeRun({runManifestPath: manifestPath, statePath: path.join(root, 'analysis-state.json'), automationStatePath: path.join(root, 'automation-state.json'), stagedStatePath: path.join(runDir, 'analysis-state.json'), globalEvidencePath: path.join(root, 'evidence.jsonl')})).rejects.toThrow(/validation failed/);
    });

    it('blocks a complete-looking review with a missing row update', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-finalize-scope-'));
        const institutions = {institutions: [{lp: 1, institution_id: 'bank_1', name: 'Bank 1'}]};
        const {manifestPath, statusPath} = await prepareRun({runId: 'run-scope', institutions, selected: institutions.institutions, output: path.join(root, 'data/work/runs/run-scope/manifest.json')});
        await fs.writeFile(statusPath, JSON.stringify({
            ...completeReviewStatus('run-scope'),
            summary: {...completeReviewStatus('run-scope').summary, applied: 0, missing_row_update_count: 1, pending_count: 1}
        }));
        await expect(finalizeRun({runManifestPath: manifestPath, statePath: path.join(root, 'analysis-state.json'), globalEvidencePath: path.join(root, 'evidence.jsonl')})).rejects.toThrow(/missing row-updates/);
    });

    it('rejects historical evidence from the global index for unchanged staged rows', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-finalize-history-'));
        const institutions = {institutions: [{lp: 1, institution_id: 'bank_1', name: 'Bank 1'}]};
        const {manifestPath} = await prepareRun({runId: 'run-history', institutions, selected: institutions.institutions, output: path.join(root, 'data/work/runs/run-history/manifest.json')});
        const runDir = path.dirname(manifestPath);
        const globalState = path.join(root, 'analysis-state.json');
        const stagedState = path.join(runDir, 'analysis-state.json');
        const historicalBase = {run_id: 'old-run', institution_id: 'bank_1', lp: 1, product_id: 'product-1', field_path: 'qualification.housing', url: 'https://bank.example/offer', content_sha256: 'sha-old', fetched_at: '2026-07-29T00:00:00Z', text_excerpt: 'Kredyt mieszkaniowy'};
        const historical = {...historicalBase, evidence_id: buildEvidenceId(historicalBase)};
        await fs.writeFile(path.join(runDir, 'evidence.jsonl'), '');
        await fs.writeFile(path.join(root, 'evidence.jsonl'), `${JSON.stringify(historical)}\n`);
        await fs.writeFile(stagedState, JSON.stringify({schema_version: '1.0', rows: [qualifiedRow(historical)]}));
        await fs.writeFile(path.join(runDir, 'automation-state.json'), JSON.stringify({tasks: [{lp: 1, institution_id: 'bank_1', stage: 'checked'}]}));
        await fs.writeFile(runStatusPath(manifestPath), JSON.stringify(completeReviewStatus('run-history')));
        await fs.writeFile(globalState, JSON.stringify({schema_version: '1.0', rows: []}));

        await expect(finalizeRun({runManifestPath: manifestPath, statePath: globalState, automationStatePath: path.join(root, 'automation-state.json'), stagedStatePath: stagedState, globalEvidencePath: path.join(root, 'evidence.jsonl')})).rejects.toThrow(/validation failed/);
        expect(JSON.parse(await fs.readFile(globalState, 'utf8')).rows).toHaveLength(0);
    });

    it('aborts without changing final state', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-abort-'));
        const institutions = {institutions: [{lp: 1, institution_id: 'bank_1', name: 'Bank 1'}]};
        const {manifestPath} = await prepareRun({runId: 'run-abort', institutions, selected: institutions.institutions, output: path.join(root, 'data/work/runs/run-abort/manifest.json')});
        const statePath = path.join(root, 'analysis-state.json');
        await fs.writeFile(statePath, JSON.stringify({rows: [{institution_id: 'bank_1', lp: 1, qualifies: null}]}));
        const before = await fs.readFile(statePath, 'utf8');
        const result = await abortRun({runManifestPath: manifestPath, reason: 'test failure'});
        expect(result.status).toBe('aborted');
        expect(await fs.readFile(statePath, 'utf8')).toBe(before);
    });
});
