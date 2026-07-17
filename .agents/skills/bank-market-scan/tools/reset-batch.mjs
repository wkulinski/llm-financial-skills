#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {ensureDir, pathExists, readJson, slug, todayIso, writeJson, dataPath} from './lib/common.mjs';

const program = new Command();
program
    .option('--from <lp>', 'start from Lp', value => parseInt(value, 10))
    .option('--limit <number>', 'number of institutions', value => parseInt(value, 10))
    .option('--lp <lp>', 'explicit Lp; repeatable', (value, previous) => [...previous, parseInt(value, 10)], [])
    .option('--clear-cache', 'remove source cache and derived artifacts for selected institutions')
    .option('--clear-analysis', 'reset analysis rows for selected institutions')
    .option('--run-id <id>', 'run identifier')
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .parse(process.argv);
const opts = program.opts();

if (!opts.clearCache && !opts.clearAnalysis) throw new Error('Select at least one action: --clear-cache and/or --clear-analysis.');
if (opts.limit != null && opts.limit < 1) throw new Error('--limit must be positive.');

const institutions = await readJson(opts.institutions);
const selectedLps = opts.lp.length
    ? new Set(opts.lp)
    : new Set(institutions.institutions
        .filter(inst => !opts.from || inst.lp >= opts.from)
        .sort((a, b) => a.lp - b.lp)
        .slice(0, opts.limit ?? institutions.institutions.length)
        .map(inst => inst.lp));
const selected = institutions.institutions.filter(inst => selectedLps.has(inst.lp));
if (!selected.length) throw new Error('No institutions match the requested scope.');

const runId = opts.runId || `reset-${Date.now()}-${process.pid}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = dataPath('work/backups', `${runId}-${stamp}`);
const runDir = dataPath('work/runs');
await ensureDir(backupDir);
await ensureDir(runDir);

async function copyIfExists(source, relativeTarget) {
    if (!(await pathExists(source))) return false;
    const target = path.join(backupDir, relativeTarget);
    await ensureDir(path.dirname(target));
    await fs.cp(source, target, {recursive: true});
    return true;
}

const state = await readJson(opts.state);
const automation = await readJson(opts.automationState);
const selectedIds = new Set(selected.map(inst => inst.institution_id));
const backupManifest = {
    run_id: runId,
    created_at: new Date().toISOString(),
    selected_lps: selected.map(inst => inst.lp),
    selected_institution_ids: selected.map(inst => inst.institution_id),
    actions: {clear_cache: Boolean(opts.clearCache), clear_analysis: Boolean(opts.clearAnalysis)},
    backup_dir: backupDir,
    files: []
};

for (const relative of ['work/analysis-state.json', 'work/automation-state.json', 'work/evidence.jsonl']) {
    if (await copyIfExists(dataPath(relative), relative)) backupManifest.files.push(relative);
}
for (const inst of selected) {
    const cacheRelative = path.join('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
    if (await copyIfExists(dataPath(cacheRelative), cacheRelative)) backupManifest.files.push(cacheRelative);
    for (const relative of [
        path.join('work/review-packs', `lp-${String(inst.lp).padStart(3, '0')}.md`),
        path.join('work/row-updates', `lp-${String(inst.lp).padStart(3, '0')}.json`)
    ]) {
        if (await copyIfExists(dataPath(relative), relative)) backupManifest.files.push(relative);
    }
}
await writeJson(path.join(backupDir, 'manifest.json'), backupManifest);

if (opts.clearCache) {
    for (const inst of selected) {
        const cacheDir = dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
        await fs.rm(cacheDir, {recursive: true, force: true});
        await fs.rm(dataPath('work/review-packs', `lp-${String(inst.lp).padStart(3, '0')}.md`), {force: true});
        await fs.rm(dataPath('work/row-updates', `lp-${String(inst.lp).padStart(3, '0')}.json`), {force: true});
    }
    const evidenceLines = (await fs.readFile(dataPath('work/evidence.jsonl'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)))
        .split(/\r?\n/)
        .filter(Boolean)
        .filter(line => {
            try {
                const row = JSON.parse(line);
                return !selectedIds.has(row.institution_id) && !selectedLps.has(Number(row.lp));
            } catch {
                return true;
            }
        });
    await fs.writeFile(dataPath('work/evidence.jsonl'), evidenceLines.length ? `${evidenceLines.join('\n')}\n` : '', 'utf8');
}

function blankAnalysisRow(inst) {
    return {
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
    };
}

if (opts.clearAnalysis) {
    const byId = new Map(selected.map(inst => [inst.institution_id, inst]));
    state.rows = (state.rows || []).map(row => byId.has(row.institution_id) ? blankAnalysisRow(byId.get(row.institution_id)) : row);
    state.updated_at = todayIso();
    await writeJson(opts.state, state);
}

const taskById = new Map((automation.tasks || []).map(task => [task.institution_id, task]));
for (const inst of selected) {
    const task = taskById.get(inst.institution_id);
    if (!task) continue;
    Object.assign(task, {
        stage: 'pending_prepare',
        attempt_count: 0,
        preprocessing_status: 'pending',
        preprocessing_risk_flags: [],
        preprocessing_technical_flags: [],
        preprocessing_insufficient_flags: [],
        preprocessing_quality_warnings: [],
        last_error: null,
        last_processed_at: null,
        run_id: runId
    });
}
automation.updated_at = todayIso();
await writeJson(opts.automationState, automation);

const runManifest = {
    run_id: runId,
    mode: 'reset',
    status: 'complete',
    created_at: new Date().toISOString(),
    selected_lps: selected.map(inst => inst.lp),
    selected_institution_ids: selected.map(inst => inst.institution_id),
    actions: {clear_cache: Boolean(opts.clearCache), clear_analysis: Boolean(opts.clearAnalysis)},
    backup_dir: backupDir
};
await writeJson(path.join(runDir, `${runId}.json`), runManifest);
console.log(JSON.stringify(runManifest, null, 2));
