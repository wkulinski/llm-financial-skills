#!/usr/bin/env node
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {Command} from 'commander';
import {ensureDir, pathExists, readJson, writeJson, writeJsonl, todayIso, bundledPath, dataPath} from './lib/common.mjs';

const program = new Command();
program
    .option('--force', 'overwrite existing current JSON files')
    .parse(process.argv);
const opts = program.opts();

for (const d of [
    dataPath('base'),
    dataPath('work'),
    dataPath('work/review-packs'),
    dataPath('work/row-updates'),
    dataPath('cache/base-list'),
    dataPath('cache/institutions'),
    dataPath('exports')
]) await ensureDir(d);

if (!(await pathExists(dataPath('base/institutions.current.json')))) {
    console.log('No institutions.current.json; building from BFG...');
    const r = spawnSync(process.execPath, [bundledPath('tools/build-institution-list.mjs'), '--cross-check-knf'], {stdio: 'inherit'});
    if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!(await pathExists(dataPath('work/analysis-state.json'))) || opts.force) {
    const institutions = await readJson(dataPath('base/institutions.current.json'));
    const rows = institutions.institutions.map(inst => ({
        institution_id: inst.institution_id,
        lp: inst.lp,
        review_status: 'unchecked',
        checked_at: null,
        website_available: null,
        qualifies: null,
        status_text: '',
        qualification: {
            housing_or_mortgage_loan_confirmed: null,
            refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: null,
            periodically_fixed_rate_confirmed: null,
            reason_codes: [],
            non_qualification_reason_codes: [],
            notes: ''
        },
        offer: {},
        requirements: {},
        promotion: {},
        professional_groups: {},
        documents: {},
        source_urls: {},
        field_status: {},
        field_evidence: {},
        research_notes: '',
        basis: ''
    }));
    await writeJson(dataPath('work/analysis-state.json'), {
        schema_version: '1.1',
        updated_at: todayIso(),
        methodology_version: '2026-07-06-refinance-fixed-rate-v4-field-evidence',
        notes: '',
        rows
    });
}

if (!(await pathExists(dataPath('work/evidence.jsonl'))) || opts.force) {
    await writeJsonl(dataPath('work/evidence.jsonl'), []);
}

if (!(await pathExists(dataPath('work/automation-state.json'))) || opts.force) {
    const institutions = await readJson(dataPath('base/institutions.current.json'));
    await writeJson(dataPath('work/automation-state.json'), {
        schema_version: '1.0',
        updated_at: todayIso(),
        tasks: institutions.institutions.map(inst => ({
            lp: inst.lp,
            institution_id: inst.institution_id,
            stage: 'pending_prepare',
            attempt_count: 0,
            preprocessing_risk_flags: [],
            preprocessing_status: 'pending',
            preprocessing_technical_flags: [],
            preprocessing_insufficient_flags: [],
            preprocessing_quality_warnings: [],
            last_error: null,
            last_processed_at: null
        }))
    });
}

console.log('Initialized project in /data.');
