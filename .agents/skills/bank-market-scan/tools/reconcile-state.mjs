#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {dataPath, readJson, readJsonl, writeJsonAtomic} from './lib/common.mjs';
import {mergeEvidence, normalizeEvidenceRecord} from './lib/evidence-store.mjs';
import {normalizeCanonicalOffer} from './lib/decision-model.mjs';

async function listFiles(root) {
    const files = [];
    const entries = await fs.readdir(root, {withFileTypes: true}).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const entry of entries) {
        const filePath = path.join(root, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(filePath));
        else if (entry.isFile() && entry.name === 'evidence.candidates.jsonl') files.push(filePath);
    }
    return files;
}

function collectReferences(rows) {
    const references = [];
    for (const row of rows || []) {
        for (const [fieldPath, fieldReferences] of Object.entries(row.field_evidence || {})) {
            for (const reference of fieldReferences || []) {
                if (reference?.evidence_id) references.push({
                    evidence_id: reference.evidence_id,
                    institution_id: row.institution_id,
                    lp: row.lp,
                    field_path: fieldPath,
                    url: reference.url || null
                });
            }
        }
    }
    return references;
}

async function writeJsonlAtomic(filePath, rows) {
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, rows.map(row => `${JSON.stringify(row)}\n`).join(''), 'utf8');
    await fs.rename(temporaryPath, filePath);
}

async function loadBackupEvidence(root) {
    const byId = new Map();
    for (const filePath of await listFiles(root)) {
        const rows = await readJsonl(filePath);
        for (const row of rows) {
            if (!row.evidence_id) continue;
            const existing = byId.get(row.evidence_id) || [];
            existing.push({...row, _backup_path: filePath});
            byId.set(row.evidence_id, existing);
        }
    }
    return byId;
}

function chooseRecoveryCandidate(reference, candidates = []) {
    return candidates.find(candidate => candidate.institution_id === reference.institution_id && (!reference.url || candidate.url === reference.url))
        || candidates.find(candidate => candidate.institution_id === reference.institution_id)
        || null;
}

export async function reconcileState({
    statePath = dataPath('work/analysis-state.json'),
    evidencePath = dataPath('work/evidence.jsonl'),
    backupsRoot = dataPath('work/backups'),
    outputPath = dataPath('work/evidence-reconciliation.json'),
    repairFromBackups = false,
    normalizeState = false,
    failOnOrphans = false
} = {}) {
    const state = await readJson(statePath);
    const evidence = await readJsonl(evidencePath);
    const references = collectReferences(state.rows || []);
    const evidenceIds = new Set(evidence.map(row => row.evidence_id));
    const unknownReferences = references.filter(reference => !evidenceIds.has(reference.evidence_id));
    const backupEvidence = repairFromBackups ? await loadBackupEvidence(backupsRoot) : new Map();
    const recovered = [];
    for (const reference of unknownReferences) {
        const candidate = chooseRecoveryCandidate(reference, backupEvidence.get(reference.evidence_id) || []);
        if (candidate) recovered.push(normalizeEvidenceRecord(candidate));
    }

    let repairedEvidence = evidence;
    if (repairFromBackups && recovered.length) {
        repairedEvidence = mergeEvidence(evidence, recovered);
        await writeJsonlAtomic(evidencePath, repairedEvidence);
    }

    let stateBackupPath = null;
    if (normalizeState) {
        stateBackupPath = path.join(backupsRoot, `analysis-state-reconcile-${Date.now()}.json`);
        await fs.mkdir(path.dirname(stateBackupPath), {recursive: true});
        await fs.copyFile(statePath, stateBackupPath);
        await writeJsonAtomic(statePath, {
            ...state,
            rows: (state.rows || []).map(row => row.offer ? {...row, offer: normalizeCanonicalOffer(row.offer)} : row),
            updated_at: new Date().toISOString()
        });
    }

    const repairedIds = new Set(repairedEvidence.map(row => row.evidence_id));
    const unresolvedReferences = references.filter(reference => !repairedIds.has(reference.evidence_id));
    const report = {
        status: unresolvedReferences.length ? 'orphaned_references' : 'clean',
        state_path: statePath,
        evidence_path: evidencePath,
        backups_root: backupsRoot,
        reference_count: references.length,
        evidence_count_before: evidence.length,
        evidence_count_after: repairedEvidence.length,
        unknown_reference_count_before: unknownReferences.length,
        recovered_reference_count: unknownReferences.length - unresolvedReferences.length,
        unknown_reference_count_after: unresolvedReferences.length,
        recovered_evidence_ids: recovered.map(row => row.evidence_id),
        unresolved_references: unresolvedReferences,
        normalized_state: normalizeState,
        state_backup_path: stateBackupPath,
        generated_at: new Date().toISOString()
    };
    await writeJsonAtomic(outputPath, report);
    if (failOnOrphans && unresolvedReferences.length) throw new Error(`Evidence reconciliation found ${unresolvedReferences.length} unresolved reference(s). Report: ${outputPath}`);
    return report;
}

async function main() {
    const program = new Command();
    program
        .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
        .option('--evidence <path>', 'global evidence JSONL', dataPath('work/evidence.jsonl'))
        .option('--backups <path>', 'backup root', dataPath('work/backups'))
        .option('--output <path>', 'reconciliation report', dataPath('work/evidence-reconciliation.json'))
        .option('--repair-from-backups', 'recover missing evidence records from backups', false)
        .option('--normalize-state', 'write canonical offer fields to the state file', false)
        .option('--fail-on-orphans', 'exit non-zero when unresolved references remain', false)
        .parse(process.argv);
    const opts = program.opts();
    console.log(JSON.stringify(await reconcileState({
        statePath: opts.state,
        evidencePath: opts.evidence,
        backupsRoot: opts.backups,
        outputPath: opts.output,
        repairFromBackups: opts.repairFromBackups,
        normalizeState: opts.normalizeState,
        failOnOrphans: opts.failOnOrphans
    }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
