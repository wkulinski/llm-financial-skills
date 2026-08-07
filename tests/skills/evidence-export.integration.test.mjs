import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {describe, expect, it} from 'vitest';
import {prepareRun} from '../../.agents/skills/bank-market-scan/tools/prepare-run.mjs';
import {finalizeRun} from '../../.agents/skills/bank-market-scan/tools/finalize-run.mjs';
import {buildEvidenceId} from '../../.agents/skills/bank-market-scan/tools/lib/evidence-store.mjs';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeEvidence(runId, category, fieldPath) {
    const record = {
        run_id: runId,
        institution_id: 'bank-1',
        lp: 1,
        product_id: 'product-1',
        field_path: category,
        category,
        url: 'https://bank.example/product',
        content_sha256: `sha-${category}`,
        fetched_at: '2026-08-03T00:00:00Z',
        text_excerpt: `${category} evidence`
    };
    return {...record, evidence_id: buildEvidenceId(record), field_reference: fieldPath};
}

function buildRow(evidence) {
    const byCategory = Object.fromEntries(evidence.map(item => [item.category, item]));
    return {
        lp: 1,
        institution_id: 'bank-1',
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
            criterion_evidence_urls: {housing: [byCategory.product.url], refinancing: [byCategory.refinancing.url], fixed_rate: [byCategory.fixed_rate.url]}
        },
        field_evidence: {
            'qualification.housing_or_mortgage_loan_confirmed': [{...byCategory.product}],
            'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed': [{...byCategory.refinancing}],
            'qualification.periodically_fixed_rate_confirmed': [{...byCategory.fixed_rate}]
        },
        offer: {product_name: 'Kredyt mieszkaniowy', fixed_rate_period_years_exact: 5, fixed_nominal_rate_exact: 0.061, rrso_exact: 0.071, rrso_description: 'wariant okresowo stały'}
    };
}

describe('evidence merge and workbook export', () => {
    it('exports the same canonical values and approved evidence as JSON', async () => {
        const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bank-evidence-export-'));
        const data = path.join(root, 'data');
        fs.mkdirSync(path.join(data, 'base'), {recursive: true});
        const institutionsPath = path.join(data, 'base/institutions.current.json');
        const statePath = path.join(data, 'work/analysis-state.json');
        const globalEvidencePath = path.join(data, 'work/evidence.jsonl');
        const outPath = path.join(data, 'exports/out.xlsx');
        const institutions = {institutions: [{lp: 1, institution_id: 'bank-1', type: 'bank_spoldzielczy', name: 'Bank 1', website_url: 'https://bank.example'}]};
        await fsPromises.writeFile(institutionsPath, JSON.stringify(institutions));
        const {manifestPath, statusPath} = await prepareRun({runId: 'run-export', institutions, selected: institutions.institutions, output: path.join(root, 'data/work/runs/run-export/manifest.json')});
        const evidence = ['product', 'refinancing', 'fixed_rate'].map(category => makeEvidence('run-export', category, category));
        const row = buildRow(evidence);
        const runDir = path.dirname(manifestPath);
        await fsPromises.writeFile(path.join(runDir, 'evidence.jsonl'), `${evidence.map(JSON.stringify).join('\n')}\n`);
        await fsPromises.writeFile(path.join(runDir, 'analysis-state.json'), JSON.stringify({schema_version: '1.0', rows: [row]}));
        await fsPromises.writeFile(path.join(runDir, 'automation-state.json'), JSON.stringify({schema_version: '1.0', tasks: [{lp: 1, institution_id: 'bank-1', stage: 'checked'}]}));
        await fsPromises.writeFile(statusPath, JSON.stringify({
            run_id: 'run-export', phase: 'review', status: 'complete',
            summary: {selected_count: 1, manifest_count: 1, interpreted_count: 1, applied: 1, pending_count: 0, needs_user_review: 0, missing_row_update_count: 0, errors: 0}
        }));
        await fsPromises.writeFile(statePath, JSON.stringify({schema_version: '1.0', rows: []}));
        await fsPromises.writeFile(path.join(root, 'data/work/automation-state.json'), JSON.stringify({schema_version: '1.0', tasks: []}));
        await finalizeRun({runManifestPath: manifestPath, statePath, automationStatePath: path.join(root, 'data/work/automation-state.json'), stagedStatePath: path.join(runDir, 'analysis-state.json'), globalEvidencePath});
        const mergedEvidence = (await fsPromises.readFile(globalEvidencePath, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
        expect(mergedEvidence).toHaveLength(3);
        expect(mergedEvidence.every(item => item.used_for_decision === true && item.run_id === 'run-export')).toBe(true);

        execFileSync(node, [path.join(skillRoot, 'tools/export-workbook.mjs'), '--institutions', institutionsPath, '--analysis', statePath, '--evidence', globalEvidencePath, '--run-manifest', manifestPath, '--out', outPath], {cwd: root, encoding: 'utf8'});
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(outPath);
        const analysis = workbook.getWorksheet('Analiza ofert');
        const headers = analysis.getRow(1).values.slice(1);
        const values = analysis.getRow(2).values.slice(1);
        expect(values[headers.indexOf('Status decyzji')]).toBe('qualified');
        expect(values[headers.indexOf('Okres stałego oprocentowania (lata) exact')]).toBe(5);
        expect(workbook.getWorksheet('Źródła Evidence').rowCount).toBe(4);
    });

    it('blocks a finalized export with empty evidence', async () => {
        const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bank-empty-evidence-'));
        const institutions = {institutions: [{lp: 1, institution_id: 'bank-1', type: 'bank_spoldzielczy', name: 'Bank 1'}]};
        const institutionsPath = path.join(root, 'institutions.json');
        const statePath = path.join(root, 'state.json');
        const evidencePath = path.join(root, 'evidence.jsonl');
        await fsPromises.writeFile(institutionsPath, JSON.stringify(institutions));
        const {manifestPath, statusPath} = await prepareRun({runId: 'run-empty-evidence', institutions, selected: institutions.institutions, output: path.join(root, 'runs/run-empty-evidence/manifest.json')});
        await fsPromises.writeFile(statePath, JSON.stringify({rows: [buildRow(['product', 'refinancing', 'fixed_rate'].map(category => makeEvidence('run-empty-evidence', category, category)))]}));
        await fsPromises.writeFile(evidencePath, '');
        await fsPromises.writeFile(statusPath, JSON.stringify({run_id: 'run-empty-evidence', status: 'finalized'}));
        await expect(() => execFileSync(node, [path.join(skillRoot, 'tools/export-workbook.mjs'), '--institutions', institutionsPath, '--analysis', statePath, '--evidence', evidencePath, '--run-manifest', manifestPath, '--out', path.join(root, 'out.xlsx')], {cwd: root, encoding: 'utf8', stdio: 'pipe'})).toThrow(/evidence validation/);
    });
});
