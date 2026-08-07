import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeTempDir(prefix = 'bank-review-batch-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function toolEnv(projectRoot) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: projectRoot};
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('review-batch', () => {
    it('applies ready row-updates and moves missing ones to ready_for_review', () => {
        const cwd = makeTempDir();
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work/row-updates'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work/review-packs'), {recursive: true});

        fs.writeFileSync(path.join(cwd, 'data/base/institutions.current.json'), JSON.stringify({
            schema_version: '1.0',
            institutions: [
                {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: 'https://bank-a.example'},
                {lp: 2, institution_id: 'bank_b', type: 'bank_spoldzielczy', name: 'Bank B', website_url: 'https://bank-b.example'}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/analysis-state.json'), JSON.stringify({
            schema_version: '1.1',
            rows: [
                {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null},
                {lp: 2, institution_id: 'bank_b', review_status: 'unchecked', qualifies: null}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({
            schema_version: '1.0',
            tasks: [
                {lp: 1, institution_id: 'bank_a', stage: 'prepared', attempt_count: 1, preprocessing_risk_flags: [], last_error: null, last_processed_at: '2026-07-10'},
                {lp: 2, institution_id: 'bank_b', stage: 'prepared', attempt_count: 1, preprocessing_risk_flags: [], last_error: null, last_processed_at: '2026-07-10'}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/review-packs/lp-002.md'), '# LP 2');
        fs.writeFileSync(path.join(cwd, 'data/work/row-updates/lp-001.json'), JSON.stringify({
            lp: 1,
            institution_id: 'bank_a',
            review_status: 'checked',
            checked_at: '2026-07-10',
            website_available: true,
            qualifies: true,
            qualification: {
                housing_or_mortgage_loan_confirmed: true,
                refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: true,
                periodically_fixed_rate_confirmed: true,
                reason_codes: [
                    'housing_or_mortgage_loan_confirmed',
                    'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed',
                    'periodically_fixed_rate_confirmed'
                ]
            },
            decision_audit: {
                product_scope: 'Kredyt mieszkaniowy testowy',
                same_product_variant_confirmed: true,
                criterion_evidence_urls: {
                    housing: ['https://bank-a.example'],
                    refinancing: ['https://bank-a.example'],
                    fixed_rate: ['https://bank-a.example']
                }
            },
            field_evidence: {
                'qualification.housing_or_mortgage_loan_confirmed': [{url: 'https://bank-a.example', text_excerpt: 'kredyt mieszkaniowy'}],
                'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed': [{url: 'https://bank-a.example', text_excerpt: 'spłata wcześniejszego kredytu'}],
                'qualification.periodically_fixed_rate_confirmed': [{url: 'https://bank-a.example', text_excerpt: 'okresowo stałe oprocentowanie'}]
            }
        }));

        const summary = execFileSync(node, [path.join(skillRoot, 'tools/review-batch.mjs'), '--limit', '2'], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        });
        expect(summary).toContain('"applied": 1');
        expect(summary).toContain('"ready_for_review": 1');

        const state = readJson(path.join(cwd, 'data/work/analysis-state.json'));
        const automation = readJson(path.join(cwd, 'data/work/automation-state.json'));
        expect(state.rows.find(row => row.institution_id === 'bank_a').review_status).toBe('checked');
        expect(automation.tasks.find(task => task.institution_id === 'bank_a').stage).toBe('checked');
        expect(automation.tasks.find(task => task.institution_id === 'bank_b').stage).toBe('ready_for_review');
    });

    it('does not apply a row update from another preparation run', () => {
        const cwd = makeTempDir();
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work/row-updates'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work/review-packs'), {recursive: true});
        fs.writeFileSync(path.join(cwd, 'data/base/institutions.current.json'), JSON.stringify({institutions: [
            {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: 'https://bank-a.example'}
        ]}));
        fs.writeFileSync(path.join(cwd, 'data/work/analysis-state.json'), JSON.stringify({rows: [
            {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}
        ]}));
        fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({tasks: [
            {lp: 1, institution_id: 'bank_a', stage: 'prepared', run_id: 'run-current', attempt_count: 1}
        ]}));
        fs.writeFileSync(path.join(cwd, 'data/work/row-updates/lp-001.json'), JSON.stringify({
            run_id: 'run-stale', lp: 1, institution_id: 'bank_a', review_status: 'checked', checked_at: '2026-07-14',
            website_available: true, qualifies: false
        }));

        const summary = execFileSync(node, [path.join(skillRoot, 'tools/review-batch.mjs'), '--limit', '1'], {
            cwd, encoding: 'utf8', env: {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: cwd}
        });
        expect(summary).toContain('"needs_user_review": 1');
        expect(JSON.parse(fs.readFileSync(path.join(cwd, 'data/work/analysis-state.json'), 'utf8')).rows[0].review_status).toBe('unchecked');
    });

    it('keeps exact-scope review state and updates inside the run directory', () => {
        const cwd = makeTempDir();
        const runDir = path.join(cwd, 'data/work/runs/run-review');
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work'), {recursive: true});
        fs.mkdirSync(path.join(runDir, 'row-updates'), {recursive: true});
        fs.writeFileSync(path.join(cwd, 'data/base/institutions.current.json'), JSON.stringify({institutions: [
            {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: 'https://bank-a.example'}
        ]}));
        fs.writeFileSync(path.join(cwd, 'data/work/analysis-state.json'), JSON.stringify({rows: [
            {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}
        ]}));
        fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({tasks: [
            {lp: 1, institution_id: 'bank_a', run_id: 'run-review', stage: 'prepared', attempt_count: 1}
        ]}));
        fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
            schema_version: '1.0', run_id: 'run-review', institution_ids: ['bank_a'], lps: [1], mode: 'fresh', status: 'prepared'
        }));
        fs.writeFileSync(path.join(runDir, 'row-updates/lp-001.json'), JSON.stringify({
            run_id: 'run-review', lp: 1, institution_id: 'bank_a', review_status: 'checked', checked_at: '2026-08-04',
            website_available: true, qualifies: false,
            qualification: {non_qualification_reason_codes: ['no_refinance_or_repayment_confirmed']}
        }));

        execFileSync(node, [
            path.join(skillRoot, 'tools/review-batch.mjs'),
            '--mode', 'all',
            '--run-manifest', path.join(runDir, 'manifest.json'),
            '--limit', '1'
        ], {cwd, encoding: 'utf8', env: toolEnv(cwd)});

        expect(readJson(path.join(runDir, 'analysis-state.json')).rows[0].review_status).toBe('checked');
        expect(readJson(path.join(runDir, 'automation-state.json')).tasks[0].stage).toBe('checked');
        expect(readJson(path.join(cwd, 'data/work/analysis-state.json')).rows[0].review_status).toBe('unchecked');
        expect(readJson(path.join(cwd, 'data/work/automation-state.json')).tasks[0].stage).toBe('prepared');

        fs.writeFileSync(path.join(runDir, 'analysis-state.json'), JSON.stringify({rows: [
            {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}
        ]}));
        fs.writeFileSync(path.join(runDir, 'automation-state.json'), JSON.stringify({tasks: [
            {lp: 1, institution_id: 'bank_a', run_id: 'run-review', stage: 'prepared', attempt_count: 1}
        ]}));
        fs.writeFileSync(path.join(runDir, 'row-updates/lp-001.json'), JSON.stringify({
            lp: 1, institution_id: 'bank_a', review_status: 'checked', checked_at: '2026-08-04',
            website_available: true, qualifies: false,
            qualification: {non_qualification_reason_codes: ['no_refinance_or_repayment_confirmed']}
        }));
        const missingRunId = JSON.parse(execFileSync(node, [
            path.join(skillRoot, 'tools/review-batch.mjs'), '--mode', 'all', '--run-manifest', path.join(runDir, 'manifest.json'), '--limit', '1'
        ], {cwd, encoding: 'utf8', env: toolEnv(cwd)}));
        expect(missingRunId.needs_user_review).toBe(1);
        expect(readJson(path.join(runDir, 'automation-state.json')).tasks[0].stage).toBe('needs_user_review');
    });
});
