#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {Command} from 'commander';
import {readJson, readJsonl, writeJson, slug, dataPath} from './lib/common.mjs';
import {ensureTask, markTask, assessPreprocessing, needsRetry} from './lib/automation.mjs';
import {
    ensureRunSnapshot,
    manifestIncludes,
    readRunManifest,
    runAnalysisStatePath,
    runAutomationStatePath,
    runManifestPath,
    runReviewPackPath,
    runRowUpdatePath,
    runStatusPath
} from './lib/run-manifest.mjs';
import {prepareRun} from './prepare-run.mjs';

const program = new Command();
program
    .option('--from <lp>', 'start from Lp', v => parseInt(v, 10))
    .option('--limit <number>', 'batch size', v => parseInt(v, 10), 20)
    .option('--refresh', 'refresh source discovery')
    .option('--fresh', 'start selected source discovery without a previous baseline')
    .option('--run-id <id>', 'run identifier propagated to generated artifacts')
    .option('--run-manifest <path>', 'exact-scope run manifest')
    .option('--skip-discovery', 'reuse existing candidates cache and skip discover-sources')
    .option('--url-ranking', 'rank fallback URLs with the configured OpenCode agent')
    .option('--url-ranking-deterministic', 'use deterministic ranking instead of OpenCode')
    .option('--ranking-provider <provider>', 'URL ranking provider: auto or deterministic', value => {
        if (!['auto', 'deterministic'].includes(value)) throw new Error('Ranking provider must be auto or deterministic.');
        return value;
    }, 'deterministic')
    .option('--enable-google-search', 'enable external Google search; disabled by default')
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .option('--continue-on-error', 'continue processing after errors', true)
    .parse(process.argv);
const opts = program.opts();
if (opts.urlRanking) console.error('Warning: --url-ranking is deprecated; ranking now runs automatically after discovery.');
let runId = opts.runId || `run-${Date.now()}-${process.pid}`;

const institutions = await readJson(opts.institutions);
let state = await readJson(opts.state);
let automation = await readJson(opts.automationState);
let taskById = new Map((automation.tasks || []).map(task => [task.institution_id, task]));
let stateById = new Map((state.rows || []).map(row => [row.institution_id, row]));
let runManifest = opts.runManifest ? await readRunManifest(opts.runManifest) : null;
let activeRunManifestPath = opts.runManifest || runManifestPath(runId);
if (runManifest) runId = runManifest.run_id;

function run(args, {stdio = 'pipe'} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {stdio});
        let stdout = '';
        let stderr = '';
        if (stdio === 'pipe') {
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
        }
        child.on('error', reject);
        child.on('close', status => {
            if (status !== 0) reject(new Error(stderr.trim() || `${args.join(' ')} failed with status ${status}`));
            else resolve(stdout);
        });
    });
}

function shouldInclude(inst, task, row) {
    if (!task) return false;
    if (!inst.website_url || inst.base_list_status === 'missing_website_url') return false;
    if (row?.review_status === 'checked') return false;
    if (runManifest && !manifestIncludes(runManifest, inst.institution_id, inst.lp)) return false;
    if (opts.from && inst.lp < opts.from) return false;
    return task.stage === 'retry_pending' || task.stage === 'retry';
}

function rankingArgs() {
    return ['--ranking-provider', opts.urlRanking ? 'auto' : (opts.urlRankingDeterministic ? 'deterministic' : opts.rankingProvider)];
}

function rankingMetadata(candidates) {
    const ranking = candidates?.url_ranking;
    if (!ranking) return null;
    return {
        provider: ranking.provider || null,
        mode: ranking.mode || null,
        run_id: candidates.run_id || null,
        inventory_sha256: ranking.inventory_sha256 || null,
        candidate_count: ranking.candidate_count || 0,
        model_candidate_count: ranking.model_candidate_count || 0,
        locked_noise_count: ranking.locked_noise_count || 0,
        selected_pool_count: Array.isArray(ranking.selected_pool) ? ranking.selected_pool.length : 0,
        expanded_pool_count: Array.isArray(ranking.expanded_pools)
            ? ranking.expanded_pools.reduce((count, pool) => count + (Array.isArray(pool) ? pool.length : 0), 0)
            : 0,
        fallback_reason: ranking.fallback_reason || null
    };
}

async function invalidateDerivedArtifacts(inst) {
    const lp = String(inst.lp).padStart(3, '0');
    await fs.rm(runReviewPackPath(activeRunManifestPath, lp), {force: true});
    await fs.rm(runRowUpdatePath(activeRunManifestPath, lp), {force: true});
}

let selected = institutions.institutions
    .filter(inst => shouldInclude(inst, taskById.get(inst.institution_id), stateById.get(inst.institution_id)));
if (!runManifest) {
    selected = selected.slice(0, opts.limit);
    const preparedRun = await prepareRun({runId, institutions, selected, mode: 'retry', searchEnabled: opts.enableGoogleSearch});
    runManifest = preparedRun.manifest;
    activeRunManifestPath = preparedRun.manifestPath;
    selected = institutions.institutions.filter(inst => manifestIncludes(runManifest, inst.institution_id, inst.lp));
}
const runStatePath = runAnalysisStatePath(activeRunManifestPath);
const runAutomationPath = runAutomationStatePath(activeRunManifestPath);
await ensureRunSnapshot(runStatePath, opts.state, state);
await ensureRunSnapshot(runAutomationPath, opts.automationState, automation);
state = await readJson(runStatePath);
automation = await readJson(runAutomationPath);
for (const institution of institutions.institutions.filter(inst => manifestIncludes(runManifest, inst.institution_id, inst.lp))) {
    ensureTask(automation, institution, runId);
}
taskById = new Map((automation.tasks || []).map(task => [task.institution_id, task]));
stateById = new Map((state.rows || []).map(row => [row.institution_id, row]));
selected = institutions.institutions.filter(inst => shouldInclude(inst, taskById.get(inst.institution_id), stateById.get(inst.institution_id)));

const summary = {
    run_id: runId,
    processed: 0,
    prepared: 0,
    escalated: 0,
    errors: 0,
    items: []
};

for (const inst of selected) {
    const task = taskById.get(inst.institution_id);
    const cacheDir = dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
    try {
        await invalidateDerivedArtifacts(inst);
        markTask(task, {
            stage: 'retry',
            run_id: runId,
            attempt_count: (task.attempt_count || 0) + 1,
            last_error: null,
            url_ranking: null
        });
        await writeJson(runAutomationPath, automation);

        if (!opts.skipDiscovery) {
            await run([
                path.resolve(path.dirname(new URL(import.meta.url).pathname), 'discover-sources.mjs'),
                '--lp', String(inst.lp),
                '--allow-external',
                '--priority-max', '60',
                '--full-max', '200',
                '--run-id', runId,
                ...(opts.fresh ? ['--fresh'] : []),
                ...(opts.refresh ? ['--refresh'] : []),
                ...(opts.enableGoogleSearch ? ['--enable-google-search'] : []),
                ...rankingArgs(),
                '--run-manifest', activeRunManifestPath,
                '--skip-unchanged'
            ]);
        }

        await run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'extract-text.mjs'), '--lp', String(inst.lp), '--run-manifest', activeRunManifestPath]);
        await run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'normalize-text.mjs'), '--lp', String(inst.lp), '--run-manifest', activeRunManifestPath]);
        await run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'grep-evidence.mjs'), '--lp', String(inst.lp), '--max-per-keyword', '5', '--run-manifest', activeRunManifestPath]);
        await run([
            path.resolve(path.dirname(new URL(import.meta.url).pathname), 'prepare-review-pack.mjs'),
            '--lp', String(inst.lp),
            '--skip-preprocess',
            '--expanded',
            '--run-manifest', activeRunManifestPath,
            '--state', runStatePath,
            '--output', runReviewPackPath(activeRunManifestPath, inst.lp)
        ]);

        const candidates = await readJson(path.join(cacheDir, 'candidates.json'));
        const ranking = rankingMetadata(candidates);
        task.url_ranking = ranking;
        const evidenceRows = await readJsonl(path.join(cacheDir, 'evidence.candidates.jsonl'));
        const sourceRows = await readJsonl(path.join(cacheDir, 'source-text.jsonl'));
        const assessment = assessPreprocessing(candidates, evidenceRows, sourceRows);
        const stillRisky = needsRetry(assessment);
        const stage = stillRisky ? 'escalated' : 'prepared';
        markTask(task, {
            stage,
            preprocessing_status: assessment.preprocessing_status,
            preprocessing_risk_flags: assessment.preprocessing_risk_flags,
            preprocessing_technical_flags: assessment.preprocessing_technical_flags,
            preprocessing_insufficient_flags: assessment.preprocessing_insufficient_flags,
            preprocessing_quality_warnings: assessment.preprocessing_quality_warnings,
            last_error: stillRisky
                ? `Retry exhausted: ${assessment.preprocessing_risk_flags.join(', ') || 'insufficient evidence after retry'}`
                : null
        });
        summary.processed += 1;
        summary[stage] += 1;
        summary.items.push({
            lp: inst.lp,
            institution_id: inst.institution_id,
            stage,
            preprocessing_status: assessment.preprocessing_status,
            preprocessing_risk_flags: assessment.preprocessing_risk_flags,
            url_ranking_provider: ranking?.provider || null,
            url_ranking_fallback_reason: ranking?.fallback_reason || null
        });
    } catch (error) {
        markTask(task, {
            stage: 'error',
            preprocessing_status: 'technical_error',
            preprocessing_technical_flags: ['batch_execution_error'],
            preprocessing_insufficient_flags: [],
            preprocessing_quality_warnings: [],
            last_error: error.message
        });
        summary.processed += 1;
        summary.errors += 1;
        summary.items.push({
            lp: inst.lp,
            institution_id: inst.institution_id,
            stage: 'error',
            error: error.message
        });
        if (!opts.continueOnError) {
            await writeJson(runAutomationPath, automation);
            throw error;
        }
    }
}

automation.updated_at = new Date().toISOString().slice(0, 10);
await writeJson(runAutomationPath, automation);
await writeJson(runStatusPath(activeRunManifestPath), {
    run_id: runId,
    phase: 'retry',
    status: summary.errors ? 'partial' : 'complete',
    manifest_path: activeRunManifestPath,
    summary,
    updated_at: new Date().toISOString()
});
console.log(JSON.stringify(summary, null, 2));
