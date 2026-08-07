#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Command} from 'commander';
import {readJson, writeJson, todayIso, dataPath} from './lib/common.mjs';
import {RowUpdate, decisionAuditWarnings, findRowForUpdate, mergeRowUpdate} from './apply-row-update.mjs';
import {validateRows} from './validate-state.mjs';
import {
    ensureRunSnapshot,
    manifestIncludes,
    readRunManifest,
    runAnalysisStatePath,
    runAutomationStatePath,
    runEvidencePath,
    runReviewPacksPath,
    runRowUpdatesPath
} from './lib/run-manifest.mjs';
import {validateFieldEvidenceReferences} from './lib/evidence-store.mjs';
import {normalizeRowFields} from './lib/decision-model.mjs';

const program = new Command();
program
    .option('--from <lp>', 'start from Lp', v => parseInt(v, 10))
    .option('--limit <number>', 'batch size', v => parseInt(v, 10), 20)
    .option('--mode <mode>', 'prepared|ready_for_review|all', 'prepared')
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .option('--updates-dir <path>', 'row updates directory', dataPath('work/row-updates'))
    .option('--review-packs-dir <path>', 'review packs directory', dataPath('work/review-packs'))
    .option('--run-manifest <path>', 'exact-scope run manifest')
    .option('--staged-state <path>', 'staged analysis state for this run')
    .option('--require-field-evidence', 'require field evidence for qualifying rows before auto-apply')
    .option('--continue-on-error', 'continue processing after errors', true)
    .option('--backup-each', 'let apply-row-update create a backup for each applied row', false)
    .parse(process.argv);
const opts = program.opts();

let automation = await readJson(opts.automationState);
let state = await readJson(opts.state);
const runManifest = opts.runManifest ? await readRunManifest(opts.runManifest) : null;
const runStatePath = runManifest ? runAnalysisStatePath(opts.runManifest) : opts.state;
const runAutomationPath = runManifest ? runAutomationStatePath(opts.runManifest) : opts.automationState;
const stagedStatePath = opts.stagedState || runStatePath;
if (runManifest) {
    await ensureRunSnapshot(runStatePath, opts.state, state);
    await ensureRunSnapshot(runAutomationPath, opts.automationState, automation);
    state = await readJson(runStatePath);
    automation = await readJson(runAutomationPath);
}
const updatesDir = runManifest ? runRowUpdatesPath(opts.runManifest) : opts.updatesDir;
const reviewPacksDir = runManifest ? runReviewPacksPath(opts.runManifest) : opts.reviewPacksDir;
const evidenceRows = runManifest
    ? (await fs.readFile(runEvidencePath(opts.runManifest), 'utf8').then(text => text.split(/\r?\n/).filter(Boolean).map(JSON.parse)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)))
    : [];

function run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => status === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || stdout.trim() || `${args.join(' ')} failed`)));
    });
}

function markTask(task, patch) {
    Object.assign(task, patch, {last_processed_at: todayIso()});
}

function queueStageForUpdate(update) {
    if (update.review_status === 'checked') return 'checked';
    if (update.review_status === 'needs_review') return 'needs_user_review';
    return 'error';
}

function shouldInclude(task, row) {
    if (!task) return false;
    if (runManifest && !manifestIncludes(runManifest, task.institution_id, task.lp)) return false;
    if (!(runManifest && opts.mode === 'all') && row?.review_status === 'checked') return false;
    if (opts.from && task.lp < opts.from) return false;
    if (opts.mode === 'prepared') return task.stage === 'prepared';
    if (opts.mode === 'ready_for_review') return task.stage === 'ready_for_review';
    return ['prepared', 'ready_for_review'].includes(task.stage);
}

function validateUpdateAgainstState(update, currentRows) {
    const idx = findRowForUpdate(currentRows, update);
    const merged = idx < 0 ? update : mergeRowUpdate(currentRows[idx], update);
    return validateRows([merged], {requireFieldEvidence: opts.requireFieldEvidence});
}

function validateUpdateRun(update, task, expectedRunId = null) {
    if (expectedRunId) {
        if (!task.run_id) return `Task run_id missing for exact run ${expectedRunId}.`;
        if (!update.run_id) return `Row update run_id missing; expected ${expectedRunId}.`;
        if (update.run_id !== expectedRunId) return `Row update run_id mismatch: expected ${expectedRunId}, got ${update.run_id}.`;
    } else if (task.run_id && update.run_id !== task.run_id) {
        return `Row update run_id mismatch: expected ${task.run_id}, got ${update.run_id || 'missing'}.`;
    }
    return null;
}

const rowsById = new Map((state.rows || []).map(row => [row.institution_id, row]));
const selected = (automation.tasks || [])
    .filter(task => shouldInclude(task, rowsById.get(task.institution_id)))
    .slice(0, opts.limit);

const summary = {
    selected_count: selected.length,
    manifest_count: runManifest ? runManifest.lps.length : selected.length,
    interpreted_count: 0,
    processed: 0,
    applied: 0,
    ready_for_review: 0,
    needs_user_review: 0,
    missing_row_update_count: 0,
    pending_count: 0,
    errors: 0,
    items: []
};

for (const task of selected) {
    const lpPadded = String(task.lp).padStart(3, '0');
    const updatePath = path.join(updatesDir, `lp-${lpPadded}.json`);
    const reviewPackPath = path.join(reviewPacksDir, `lp-${lpPadded}.md`);
    try {
        const updateRaw = await fs.readFile(updatePath, 'utf8').catch(err => err.code === 'ENOENT' ? null : Promise.reject(err));
        if (!updateRaw) {
            markTask(task, {
                stage: 'ready_for_review',
                last_error: null
            });
            summary.processed += 1;
            summary.ready_for_review += 1;
            summary.missing_row_update_count += 1;
            summary.pending_count += 1;
            summary.items.push({
                lp: task.lp,
                institution_id: task.institution_id,
                stage: 'ready_for_review',
                review_pack: reviewPackPath
            });
            continue;
        }

        const update = normalizeRowFields(RowUpdate.parse(JSON.parse(updateRaw)));
        summary.interpreted_count += 1;
        const warnings = validateUpdateAgainstState(update, state.rows || []);
        warnings.push(...decisionAuditWarnings(update));
        if (runManifest) warnings.push(...validateFieldEvidenceReferences([update], evidenceRows, {runId: runManifest.run_id, strict: true}));
        const runWarning = validateUpdateRun(update, task, runManifest?.run_id || null);
        if (runWarning) warnings.push(runWarning);
        if (warnings.length > 0) {
            markTask(task, {
                stage: 'needs_user_review',
                last_error: warnings.join(' | ')
            });
            summary.processed += 1;
            summary.needs_user_review += 1;
            summary.pending_count += 1;
            summary.items.push({
                lp: task.lp,
                institution_id: task.institution_id,
                stage: 'needs_user_review',
                warnings
            });
            continue;
        }

        await run([
            path.resolve(path.dirname(new URL(import.meta.url).pathname), 'apply-row-update.mjs'),
            '--input', updatePath,
            '--state', stagedStatePath,
            ...(task.run_id ? ['--expected-run-id', task.run_id] : []),
            ...(opts.backupEach ? [] : ['--no-backup'])
        ]);

        const refreshedState = await readJson(stagedStatePath);
        state.rows = refreshedState.rows;
        state.updated_at = refreshedState.updated_at;
        rowsById.set(update.institution_id, refreshedState.rows.find(row => row.institution_id === update.institution_id));

        const queueStage = queueStageForUpdate(update);
        markTask(task, {
            stage: queueStage,
            last_error: null
        });
        summary.processed += 1;
        if (queueStage === 'checked') summary.applied += 1;
        else if (queueStage === 'needs_user_review') {
            summary.needs_user_review += 1;
            summary.pending_count += 1;
        }
        else summary.errors += 1;
        summary.items.push({
            lp: task.lp,
            institution_id: task.institution_id,
            stage: queueStage,
            update_path: updatePath
        });
    } catch (error) {
        markTask(task, {
            stage: 'error',
            last_error: error.message
        });
        summary.processed += 1;
        summary.errors += 1;
        summary.pending_count += 1;
        summary.items.push({
            lp: task.lp,
            institution_id: task.institution_id,
            stage: 'error',
            error: error.message
        });
        if (!opts.continueOnError) {
            automation.updated_at = todayIso();
        await writeJson(runAutomationPath, automation);
            throw error;
        }
    }
}

automation.updated_at = todayIso();
await writeJson(runAutomationPath, automation);
if (runManifest) {
    await writeJson(path.join(path.dirname(opts.runManifest), 'status.json'), {
        run_id: runManifest.run_id,
        phase: 'review',
        status: summary.errors || summary.missing_row_update_count || summary.needs_user_review || summary.selected_count !== summary.manifest_count ? 'partial' : 'complete',
        manifest_path: opts.runManifest,
        summary,
        updated_at: new Date().toISOString()
    });
}
console.log(JSON.stringify(summary, null, 2));
