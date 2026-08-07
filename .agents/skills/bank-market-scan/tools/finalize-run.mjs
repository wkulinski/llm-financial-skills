#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {dataPath, readJson, readJsonl, writeJsonAtomic} from './lib/common.mjs';
import {
    manifestIncludes,
    readRunManifest,
    runAnalysisStatePath,
    runAutomationStatePath,
    runEvidencePath,
    runStatusPath
} from './lib/run-manifest.mjs';
import {mergeEvidence, normalizeEvidenceRecord, validateEvidenceRecord, validateFieldEvidenceReferences} from './lib/evidence-store.mjs';
import {validateRows} from './validate-state.mjs';

export async function finalizeRun({runManifestPath, statePath = dataPath('work/analysis-state.json'), automationStatePath = dataPath('work/automation-state.json'), globalEvidencePath = dataPath('work/evidence.jsonl'), stagedStatePath, stagedAutomationStatePath, validationPath} = {}) {
    const manifest = await readRunManifest(runManifestPath);
    const statusPath = runStatusPath(runManifestPath);
    const currentStatus = await readJson(statusPath, {status: 'prepared'});
    if (['finalized', 'aborted'].includes(currentStatus.status)) throw new Error(`Run is already ${currentStatus.status}.`);
    const expectedCount = manifest.lps.length;
    const summary = currentStatus.summary || {};
    const lifecycleErrors = [];
    if (currentStatus.status !== 'complete') lifecycleErrors.push(`status=${currentStatus.status || 'missing'}`);
    if (currentStatus.phase !== 'review') lifecycleErrors.push(`phase=${currentStatus.phase || 'missing'}`);
    if (summary.errors || summary.refresh_errors) lifecycleErrors.push('processing errors present');
    if (summary.manifest_count !== expectedCount) lifecycleErrors.push(`manifest_count=${summary.manifest_count || 0}, expected ${expectedCount}`);
    if (summary.selected_count !== expectedCount) lifecycleErrors.push(`selected_count=${summary.selected_count || 0}, expected ${expectedCount}`);
    if (summary.interpreted_count !== expectedCount) lifecycleErrors.push(`interpreted_count=${summary.interpreted_count || 0}, expected ${expectedCount}`);
    if (summary.missing_row_update_count) lifecycleErrors.push(`missing row-updates=${summary.missing_row_update_count}`);
    if (summary.needs_user_review) lifecycleErrors.push(`needs_user_review=${summary.needs_user_review}`);
    if (summary.pending_count !== 0) lifecycleErrors.push(`pending_count=${summary.pending_count || 0}`);
    if (summary.applied !== expectedCount) lifecycleErrors.push(`applied=${summary.applied || 0}, expected ${expectedCount}`);
    if (lifecycleErrors.length) throw new Error(`Cannot finalize incomplete review scope: ${lifecycleErrors.join('; ')}.`);

    const stagedPath = stagedStatePath || runAnalysisStatePath(runManifestPath);
    const stagedAutomationPath = stagedAutomationStatePath || runAutomationStatePath(runManifestPath);
    const hasStagedState = await fs.access(stagedPath).then(() => true).catch(() => false);
    const hasStagedAutomation = await fs.access(stagedAutomationPath).then(() => true).catch(() => false);
    if (!hasStagedState || !hasStagedAutomation) throw new Error('Cannot finalize without run-local analysis and automation state.');
    const state = await readJson(hasStagedState ? stagedPath : statePath);
    const automation = await readJson(stagedAutomationPath);
    const scopedRows = (state.rows || []).filter(row => manifestIncludes(manifest, row.institution_id, row.lp));
    const scopedTasks = (automation.tasks || []).filter(task => manifestIncludes(manifest, task.institution_id, task.lp));
    if (scopedRows.length !== expectedCount) {
        throw new Error(`Cannot finalize: run-local analysis state has ${scopedRows.length} rows for manifest scope; expected ${expectedCount}.`);
    }
    if (scopedTasks.length !== expectedCount || scopedTasks.some(task => task.stage !== 'checked')) {
        throw new Error('Cannot finalize: run-local automation state is not checked for the full manifest scope.');
    }
    const globalState = await readJson(statePath, {rows: []});
    const globalAutomation = await readJson(automationStatePath, {tasks: []});
    const publishedState = {
        ...globalState,
        rows: [...(globalState.rows || []).filter(row => !manifestIncludes(manifest, row.institution_id, row.lp)), ...scopedRows],
        updated_at: new Date().toISOString()
    };
    const publishedAutomation = {
        ...globalAutomation,
        tasks: [...(globalAutomation.tasks || []).filter(task => !manifestIncludes(manifest, task.institution_id, task.lp)), ...scopedTasks],
        updated_at: new Date().toISOString()
    };
    const warnings = validateRows(scopedRows, {requireFieldEvidence: true});
    const evidencePath = runEvidencePath(runManifestPath);
    const evidenceRows = await fs.readFile(evidencePath, 'utf8').then(text => text.split(/\r?\n/).filter(Boolean).map(JSON.parse)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const evidenceErrors = validateFieldEvidenceReferences(
        scopedRows,
        evidenceRows,
        {strict: true}
    );
    const outOfScopeEvidenceErrors = evidenceRows
        .filter(row => !manifestIncludes(manifest, row.institution_id, row.lp))
        .map(row => `evidence ${row.evidence_id || 'missing'} is outside the run manifest.`);
    const currentEvidenceErrors = [
        ...outOfScopeEvidenceErrors,
        ...evidenceRows.flatMap(row => validateEvidenceRecord(row, {runId: manifest.run_id, institutionId: row.institution_id}))
    ];
    if (warnings.length || evidenceErrors.length || currentEvidenceErrors.length) {
        const validation = {run_id: manifest.run_id, status: 'invalid', warnings, evidence_errors: [...evidenceErrors, ...currentEvidenceErrors]};
        await writeJsonAtomic(validationPath || path.join(path.dirname(runManifestPath), 'validation.json'), validation);
        throw new Error(`Cannot finalize run: validation failed (${warnings.length + evidenceErrors.length} issue(s)).`);
    }
    const usedEvidenceIds = new Set(scopedRows
        .flatMap(row => Object.values(row.field_evidence || {}))
        .flatMap(references => Array.isArray(references) ? references : [])
        .map(reference => reference.evidence_id)
        .filter(Boolean));
    const approvedEvidence = evidenceRows.map(row => ({
        ...normalizeEvidenceRecord(row, {runId: manifest.run_id}),
        used_for_decision: usedEvidenceIds.has(row.evidence_id) || row.used_for_decision === true
    }));
    const historicalEvidenceRows = await readJsonl(globalEvidencePath);
    const mergedEvidence = mergeEvidence(historicalEvidenceRows, approvedEvidence);
    const finalized = {
        ...currentStatus,
        run_id: manifest.run_id,
        phase: 'finalize',
        status: 'finalized',
        finalized_at: new Date().toISOString(),
        evidence_count: mergedEvidence.length,
        manifest_path: runManifestPath,
        validation_path: validationPath || path.join(path.dirname(runManifestPath), 'validation.json')
    };
    const temporaryFiles = [];
    const publishedFiles = [];
    const backupFiles = [];
    const stageJson = async (value, target) => {
        await fs.mkdir(path.dirname(target), {recursive: true});
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
        temporaryFiles.push({temporary, target});
    };
    const stageEvidence = async (target) => {
        await fs.mkdir(path.dirname(target), {recursive: true});
        const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporary, mergedEvidence.map(row => `${JSON.stringify(row)}\n`).join(''), 'utf8');
        temporaryFiles.push({temporary, target});
    };
    try {
        await stageJson(publishedState, statePath);
        await stageJson(publishedAutomation, automationStatePath);
        await stageEvidence(globalEvidencePath);
        await stageJson({run_id: manifest.run_id, status: 'valid', warnings: [], evidence_errors: [], finalized_at: finalized.finalized_at}, finalized.validation_path);
        await stageJson(finalized, statusPath);
        for (const {temporary, target} of temporaryFiles) {
            const backup = `${target}.${process.pid}.${Date.now()}.bak`;
            let existed = true;
            try {
                await fs.copyFile(target, backup);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                existed = false;
            }
            backupFiles.push({backup, target, existed});
            await fs.rename(temporary, target);
            publishedFiles.push({backup, target, existed});
        }
    } catch (error) {
        for (const {backup, target, existed} of [...publishedFiles].reverse()) {
            if (existed) await fs.rename(backup, target);
            else await fs.rm(target, {force: true});
        }
        throw error;
    } finally {
        for (const {temporary} of temporaryFiles) await fs.rm(temporary, {force: true});
        for (const {backup} of backupFiles) await fs.rm(backup, {force: true});
    }
    return finalized;
}

async function main() {
    const program = new Command();
    program.requiredOption('--run-manifest <path>').option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json')).option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json')).option('--evidence <path>', 'global evidence JSONL', dataPath('work/evidence.jsonl')).option('--staged-state <path>').parse(process.argv);
    const opts = program.opts();
    console.log(JSON.stringify(await finalizeRun({runManifestPath: opts.runManifest, statePath: opts.state, automationStatePath: opts.automationState, globalEvidencePath: opts.evidence, stagedStatePath: opts.stagedState}), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
