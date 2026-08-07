import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {dataPath, readJson, writeJsonAtomic} from './common.mjs';

export const RUN_MANIFEST_VERSION = '1.0';

function unique(values) {
    return [...new Set(values)];
}

export function buildRunManifest({
    run_id,
    institutions = [],
    institution_ids,
    lps,
    mode = 'fresh',
    search_enabled = false,
    methodology_version = '2026-08-bank-market-scan-v3',
    created_at = new Date().toISOString()
} = {}) {
    const records = Array.isArray(institutions) ? institutions : [];
    const hasExplicitPairs = Array.isArray(institution_ids) && Array.isArray(lps);
    const orderedRecords = records
        .filter(item => item?.institution_id && Number.isInteger(Number(item.lp)))
        .sort((a, b) => Number(a.lp) - Number(b.lp) || String(a.institution_id).localeCompare(String(b.institution_id)));
    const ids = unique((hasExplicitPairs ? institution_ids : orderedRecords.map(item => item.institution_id)).filter(Boolean));
    const lpValues = unique((hasExplicitPairs ? lps : orderedRecords.map(item => Number(item.lp))).filter(Number.isInteger));
    if (!run_id) throw new Error('run_id is required for a run manifest.');
    if (ids.length !== lpValues.length) throw new Error('Run manifest requires one institution_id per lp.');
    return {
        schema_version: RUN_MANIFEST_VERSION,
        run_id,
        institution_ids: ids,
        lps: lpValues,
        mode,
        search_enabled: Boolean(search_enabled),
        methodology_version,
        created_at,
        status: 'prepared'
    };
}

export function validateRunManifest(manifest, institutions = null) {
    const errors = [];
    if (!manifest || typeof manifest !== 'object') return ['manifest must be an object'];
    if (manifest.schema_version !== RUN_MANIFEST_VERSION) errors.push(`unsupported schema_version: ${manifest.schema_version}`);
    if (!manifest.run_id || typeof manifest.run_id !== 'string') errors.push('run_id is required');
    if (!Array.isArray(manifest.institution_ids) || manifest.institution_ids.length === 0) errors.push('institution_ids must be a non-empty array');
    if (!Array.isArray(manifest.lps) || manifest.lps.length === 0) errors.push('lps must be a non-empty array');
    if (Array.isArray(manifest.institution_ids) && new Set(manifest.institution_ids).size !== manifest.institution_ids.length) errors.push('duplicate institution_ids');
    if (Array.isArray(manifest.lps) && new Set(manifest.lps).size !== manifest.lps.length) errors.push('duplicate lps');
    if (Array.isArray(manifest.institution_ids) && Array.isArray(manifest.lps) && manifest.institution_ids.length !== manifest.lps.length) errors.push('institution_ids and lps must have equal length');
    if (institutions?.institutions) {
        const byId = new Map(institutions.institutions.map(item => [item.institution_id, item]));
        const byLp = new Map(institutions.institutions.map(item => [Number(item.lp), item]));
        for (const id of manifest.institution_ids || []) if (!byId.has(id)) errors.push(`unknown institution_id: ${id}`);
        for (const lp of manifest.lps || []) if (!byLp.has(Number(lp))) errors.push(`unknown lp: ${lp}`);
        for (let i = 0; i < Math.min(manifest.institution_ids?.length || 0, manifest.lps?.length || 0); i += 1) {
            const inst = byId.get(manifest.institution_ids[i]);
            if (inst && Number(inst.lp) !== Number(manifest.lps[i])) errors.push(`institution/lp mismatch: ${manifest.institution_ids[i]} != ${manifest.lps[i]}`);
        }
    }
    return errors;
}

export function manifestIncludes(manifest, institutionOrId, lp = undefined) {
    const institutionId = typeof institutionOrId === 'string' ? institutionOrId : institutionOrId?.institution_id;
    const institutionLp = lp ?? (typeof institutionOrId === 'object' ? institutionOrId?.lp : undefined);
    return Boolean(manifest
        && manifest.institution_ids?.includes(institutionId)
        && manifest.lps?.includes(Number(institutionLp)));
}

export function assertManifestScope(manifest, {institution_id, lp} = {}) {
    if (!manifestIncludes(manifest, institution_id, lp)) {
        throw new Error(`Record outside run manifest: institution_id=${institution_id || 'missing'} lp=${lp ?? 'missing'}`);
    }
}

export async function readRunManifest(filePath) {
    const manifest = await readJson(filePath);
    const errors = validateRunManifest(manifest);
    if (errors.length) throw new Error(`Invalid run manifest: ${errors.join('; ')}`);
    return manifest;
}

export async function writeRunManifest(filePath, manifest, institutions = null) {
    const errors = validateRunManifest(manifest, institutions);
    if (errors.length) throw new Error(`Invalid run manifest: ${errors.join('; ')}`);
    await writeJsonAtomic(filePath, manifest);
    return manifest;
}

export function runManifestPath(runId) {
    return dataPath('work/runs', runId, 'manifest.json');
}

export function runDirPath(manifestPath) {
    return path.dirname(manifestPath);
}

export function runStatusPath(manifestPath) {
    return path.join(runDirPath(manifestPath), 'status.json');
}

export function runEvidencePath(manifestPath) {
    return path.join(runDirPath(manifestPath), 'evidence.jsonl');
}

export function runAnalysisStatePath(manifestPath) {
    return path.join(runDirPath(manifestPath), 'analysis-state.json');
}

export function runAutomationStatePath(manifestPath) {
    return path.join(runDirPath(manifestPath), 'automation-state.json');
}

export function runReviewPacksPath(manifestPath) {
    return path.join(runDirPath(manifestPath), 'review-packs');
}

export function runRowUpdatesPath(manifestPath) {
    return path.join(runDirPath(manifestPath), 'row-updates');
}

export function runReviewPackPath(manifestPath, lp) {
    return path.join(runReviewPacksPath(manifestPath), `lp-${String(lp).padStart(3, '0')}.md`);
}

export function runRowUpdatePath(manifestPath, lp) {
    return path.join(runRowUpdatesPath(manifestPath), `lp-${String(lp).padStart(3, '0')}.json`);
}

export async function ensureRunSnapshot(runPath, sourcePath, fallback) {
    try {
        await fs.access(runPath);
        return false;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(path.dirname(runPath), {recursive: true});
    try {
        await fs.copyFile(sourcePath, runPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await writeJsonAtomic(runPath, fallback);
    }
    return true;
}

export async function createRunManifest({runId, institutions, selected, ...options}) {
    const manifest = buildRunManifest({run_id: runId, institutions: selected, ...options});
    const filePath = options.output || runManifestPath(runId);
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await writeRunManifest(filePath, manifest, institutions);
    return {manifest, path: filePath};
}

async function main() {
    const program = new Command();
    program
        .requiredOption('--run-id <id>')
        .requiredOption('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
        .option('--lp <lp>', 'exact Lp; repeatable', (value, previous) => [...previous, Number(value)], [])
        .option('--from <lp>', 'lower Lp boundary', value => Number(value))
        .option('--limit <number>', 'number of records', value => Number(value))
        .option('--mode <mode>', 'fresh|changed-only|retry', 'fresh')
        .option('--search-enabled')
        .option('--output <path>')
        .parse(process.argv);
    const opts = program.opts();
    const institutions = await readJson(opts.institutions);
    let selected = institutions.institutions || [];
    if (opts.lp.length) selected = selected.filter(item => opts.lp.includes(Number(item.lp)));
    else if (opts.from != null) selected = selected.filter(item => Number(item.lp) >= opts.from);
    if (opts.limit != null) selected = selected.slice(0, opts.limit);
    const {manifest, path: output} = await createRunManifest({
        runId: opts.runId,
        institutions,
        selected,
        mode: opts.mode,
        search_enabled: opts.searchEnabled,
        output: opts.output
    });
    console.log(JSON.stringify({path: output, manifest}, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
