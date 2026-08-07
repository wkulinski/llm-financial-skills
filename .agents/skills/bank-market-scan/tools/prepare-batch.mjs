#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {Command} from 'commander';
import pLimit from 'p-limit';
import {readJson, readJsonl, writeJson, todayIso, slug, dataPath} from './lib/common.mjs';
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
    .option('--bank-concurrency <number>', 'parallel bank preprocessing limit', v => parseInt(v, 10), 2)
    .option('--mode <mode>', 'pending_prepare|retry|all|changed-only', 'pending_prepare')
    .option('--refresh', 'refresh source discovery')
    .option('--offline', 'prohibit network discovery; requires --skip-discovery')
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
    .option('--google-host <host>', 'Google host override')
    .option('--google-base-url <url>', 'Google base URL override for controlled providers')
    .option('--enable-google-search', 'enable external Google search; disabled by default')
    .option('--changed-only', 'only continue when source content changed since last fetch')
    .option('--skip-unchanged', 'pass through to discover-sources', true)
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .option('--continue-on-error', 'continue processing the batch after errors', true)
    .parse(process.argv);
const opts = program.opts();
if (opts.offline && !opts.skipDiscovery) throw new Error('--offline requires --skip-discovery.');
if (opts.offline && (opts.refresh || opts.enableGoogleSearch)) throw new Error('--offline cannot be combined with --refresh or --enable-google-search.');
if (opts.urlRanking) console.error('Warning: --url-ranking is deprecated; ranking now runs automatically after discovery.');
const changedOnlyMode = opts.mode === 'changed-only' || opts.changedOnly;
let runId = opts.runId || `run-${Date.now()}-${process.pid}`;

const institutions = await readJson(opts.institutions);
let state = await readJson(opts.state);
let automation = await readJson(opts.automationState);
let taskById = new Map((automation.tasks || []).map(task => [task.institution_id, task]));
let stateById = new Map((state.rows || []).map(row => [row.institution_id, row]));
let runManifest = opts.runManifest ? await readRunManifest(opts.runManifest) : null;
let activeRunManifestPath = opts.runManifest || runManifestPath(runId);
if (runManifest) runId = runManifest.run_id;

if (!runManifest) {
    const manifestScope = changedOnlyMode
        ? institutions.institutions.filter(inst => inst.website_url && inst.base_list_status !== 'missing_website_url')
        : institutions.institutions.filter(inst => shouldInclude(inst, taskById.get(inst.institution_id), stateById.get(inst.institution_id))).slice(0, opts.limit);
    const preparedRun = await prepareRun({
        runId,
        institutions,
        selected: manifestScope,
        mode: changedOnlyMode ? 'changed-only' : (opts.mode === 'retry' ? 'retry' : 'fresh'),
        searchEnabled: opts.enableGoogleSearch
    });
    runManifest = preparedRun.manifest;
    activeRunManifestPath = preparedRun.manifestPath;
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
let automationWriteQueue = Promise.resolve();

function persistAutomation() {
    automationWriteQueue = automationWriteQueue.then(() => writeJson(runAutomationPath, automation));
    return automationWriteQueue;
}

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
    if (!inst.website_url || inst.base_list_status === 'missing_website_url') return false;
    if (runManifest && !manifestIncludes(runManifest, inst.institution_id, inst.lp)) return false;
    if (!changedOnlyMode && !(runManifest && (opts.fresh || opts.mode === 'all' || opts.mode === 'fresh')) && row?.review_status === 'checked') return false;
    if (opts.from && inst.lp < opts.from) return false;
    const stage = task?.stage || 'pending_prepare';
    if (opts.mode === 'pending_prepare') return stage === 'pending_prepare' || stage === 'preparing';
    if (opts.mode === 'retry') return stage === 'retry_pending' || stage === 'retry';
    return true;
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

function setRankingMetadata(task, candidates) {
    if (task) task.url_ranking = rankingMetadata(candidates);
    return task?.url_ranking || null;
}

async function invalidateDerivedArtifacts(inst) {
    const lp = String(inst.lp).padStart(3, '0');
    await fs.rm(runReviewPackPath(activeRunManifestPath, lp), {force: true});
    await fs.rm(runRowUpdatePath(activeRunManifestPath, lp), {force: true});
}

const summary = {
    processed: 0,
    prepared: 0,
    retry_pending: 0,
    unchanged_sources: 0,
    refreshed: 0,
    changed_detected: 0,
    refresh_errors: 0,
    refresh_manifest_status: null,
    run_id: runId,
    refresh_scope: changedOnlyMode ? 'all' : 'selected',
    errors: 0,
    items: []
};

function refreshRunId() {
    return `refresh-${Date.now()}-${process.pid}`;
}

async function refreshSources() {
    const eligible = institutions.institutions.filter(inst => inst.website_url && inst.base_list_status !== 'missing_website_url');
    const runId = refreshRunId();
    const manifestPath = dataPath('work/source-refresh-runs', `${runId}.json`);
    const manifest = {
        run_id: runId,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'running',
        expected_institution_ids: eligible.map(inst => inst.institution_id),
        completed_institution_ids: [],
        errors: []
    };
    await writeJson(manifestPath, manifest);

    for (const inst of eligible) {
        const task = taskById.get(inst.institution_id);
        try {
            await run([
                path.resolve(path.dirname(new URL(import.meta.url).pathname), 'discover-sources.mjs'),
                '--lp', String(inst.lp),
                '--refresh',
                '--run-id', runId,
                ...(opts.fresh ? ['--fresh'] : []),
                ...(changedOnlyMode ? ['--lightweight-refresh'] : []),
                ...(opts.skipUnchanged ? ['--skip-unchanged'] : []),
                ...(opts.googleHost ? ['--google-host', opts.googleHost] : []),
                ...(opts.googleBaseUrl ? ['--google-base-url', opts.googleBaseUrl] : []),
                ...(opts.enableGoogleSearch ? ['--enable-google-search'] : []),
                ...rankingArgs(),
                '--run-manifest', activeRunManifestPath,
                '--source-refresh-run-id', runId
            ]);
            const cacheDir = dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
            const candidates = await readJson(path.join(cacheDir, 'candidates.json'));
            if (candidates.source_refresh_run_id !== runId || !candidates.sources_refreshed_at) {
                throw new Error('Discovery did not write the current source refresh metadata.');
            }
            if (task) {
                task.url_ranking = rankingMetadata(candidates);
                Object.assign(task, {
                    source_refresh_run_id: runId,
                    sources_refreshed_at: candidates.sources_refreshed_at,
                    offer_changed_since_last_fetch: candidates.offer_changed_since_last_fetch === true,
                    discovery_changed_since_last_fetch: candidates.discovery_changed_since_last_fetch === true
                });
            }
            manifest.completed_institution_ids.push(inst.institution_id);
            summary.refreshed += 1;
            if (candidates.offer_changed_since_last_fetch === true) summary.changed_detected += 1;
        } catch (error) {
            manifest.errors.push({
                institution_id: inst.institution_id,
                lp: inst.lp,
                error: error.message
            });
            summary.refresh_errors += 1;
            if (task) {
                markTask(task, {
                    stage: 'error',
                    preprocessing_status: 'technical_error',
                    preprocessing_technical_flags: ['source_refresh_error'],
                    preprocessing_insufficient_flags: [],
                    preprocessing_quality_warnings: [],
                    url_ranking: null,
                    last_error: error.message
                });
            }
        }
        manifest.updated_at = new Date().toISOString();
        await writeJson(manifestPath, manifest);
        await persistAutomation();
    }

    manifest.status = manifest.errors.length ? 'partial' : 'complete';
    manifest.completed_at = new Date().toISOString();
    manifest.updated_at = manifest.completed_at;
    await writeJson(manifestPath, manifest);
    summary.refresh_manifest_status = manifest.status;
    return {eligible, manifest};
}

let selected;
if (changedOnlyMode) {
    const refresh = await refreshSources();
    if (refresh.manifest.status !== 'complete') {
        automation.updated_at = todayIso();
        await persistAutomation();
        await writeJson(runStatusPath(activeRunManifestPath), {
            run_id: runId,
            phase: 'prepare',
            status: 'partial',
            manifest_path: activeRunManifestPath,
            institution_ids: runManifest.institution_ids,
            lps: runManifest.lps,
            summary,
            updated_at: new Date().toISOString()
        });
        console.log(JSON.stringify(summary, null, 2));
        process.exit(0);
    }

    const changed = [];
    for (const inst of refresh.eligible) {
        const cacheDir = dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
        const candidates = await readJson(path.join(cacheDir, 'candidates.json'));
        const task = taskById.get(inst.institution_id);
        if (candidates.offer_changed_since_last_fetch === true) {
            changed.push(inst);
        } else if (task) {
            markTask(task, {
                stage: 'unchanged_sources',
                preprocessing_status: 'unchanged',
                preprocessing_technical_flags: [],
                preprocessing_insufficient_flags: [],
                preprocessing_quality_warnings: [],
                last_error: null
            });
            summary.processed += 1;
            summary.unchanged_sources += 1;
            summary.items.push({lp: inst.lp, institution_id: inst.institution_id, stage: 'unchanged_sources'});
        }
    }
    selected = changed.slice(0, opts.limit);
} else {
    selected = institutions.institutions.filter(inst => shouldInclude(inst, taskById.get(inst.institution_id), stateById.get(inst.institution_id)));
    if (!opts.runManifest) selected = selected.slice(0, opts.limit);
}

const bankLimit = pLimit(Math.max(1, opts.bankConcurrency || 1));
await Promise.all(selected.map(inst => bankLimit(async () => {
    const task = taskById.get(inst.institution_id);
    const cacheDir = dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
    try {
        await invalidateDerivedArtifacts(inst);
        markTask(task, {
            stage: opts.mode === 'retry' ? 'retry' : 'preparing',
            run_id: runId,
            attempt_count: (task.attempt_count || 0) + 1,
            last_error: null,
            url_ranking: null
        });
        await persistAutomation();

        if (!changedOnlyMode && !opts.skipDiscovery) {
            const discoveryArgs = [
                path.resolve(path.dirname(new URL(import.meta.url).pathname), 'discover-sources.mjs'),
                '--lp', String(inst.lp),
                '--run-id', runId,
                ...(opts.refresh || opts.fresh ? ['--refresh'] : []),
                ...(opts.fresh ? ['--fresh'] : []),
                ...(opts.skipUnchanged ? ['--skip-unchanged'] : []),
                ...(opts.googleHost ? ['--google-host', opts.googleHost] : []),
                ...(opts.googleBaseUrl ? ['--google-base-url', opts.googleBaseUrl] : []),
                ...(opts.enableGoogleSearch ? ['--enable-google-search'] : []),
                ...rankingArgs(),
                '--run-manifest', activeRunManifestPath
            ];
            await run([
                ...discoveryArgs
            ]);
        }

        const candidates = await readJson(path.join(cacheDir, 'candidates.json'));
        const ranking = setRankingMetadata(task, candidates);
        const hasChanges = candidates.homepage_changed_since_last_fetch === true
            || (candidates.all_candidates || []).some(candidate => candidate.changed_since_last_fetch === true);
        if (!changedOnlyMode && opts.changedOnly && !hasChanges) {
            const assessment = assessPreprocessing(candidates);
            markTask(task, {
                stage: 'unchanged_sources',
                preprocessing_risk_flags: assessment.preprocessing_risk_flags,
                preprocessing_status: 'unchanged',
                preprocessing_technical_flags: assessment.preprocessing_technical_flags,
                preprocessing_insufficient_flags: assessment.preprocessing_insufficient_flags,
                preprocessing_quality_warnings: assessment.preprocessing_quality_warnings,
                last_error: null
            });
            summary.processed += 1;
            summary.unchanged_sources += 1;
            summary.items.push({lp: inst.lp, institution_id: inst.institution_id, stage: 'unchanged_sources'});
            return;
        }

        await run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'extract-text.mjs'), '--lp', String(inst.lp), '--run-manifest', activeRunManifestPath]);
        await run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'normalize-text.mjs'), '--lp', String(inst.lp), '--run-manifest', activeRunManifestPath]);
        await run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'grep-evidence.mjs'), '--lp', String(inst.lp), '--run-manifest', activeRunManifestPath]);
        await run([
            path.resolve(path.dirname(new URL(import.meta.url).pathname), 'prepare-review-pack.mjs'),
            '--lp', String(inst.lp),
            '--skip-preprocess',
            '--run-manifest', activeRunManifestPath,
            '--state', runStatePath,
            '--output', runReviewPackPath(activeRunManifestPath, inst.lp)
        ]);

        const evidenceRows = await readJsonl(path.join(cacheDir, 'evidence.candidates.jsonl'));
        const sourceRows = await readJsonl(path.join(cacheDir, 'source-text.jsonl'));
        const assessment = assessPreprocessing(candidates, evidenceRows, sourceRows);
        const stage = needsRetry(assessment) ? 'retry_pending' : 'prepared';
        markTask(task, {
            stage,
            preprocessing_risk_flags: assessment.preprocessing_risk_flags,
            preprocessing_status: assessment.preprocessing_status,
            preprocessing_technical_flags: assessment.preprocessing_technical_flags,
            preprocessing_insufficient_flags: assessment.preprocessing_insufficient_flags,
            preprocessing_quality_warnings: assessment.preprocessing_quality_warnings,
            last_error: null
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
        if (task) markTask(task, {
                stage: 'error',
                preprocessing_status: 'technical_error',
                preprocessing_technical_flags: ['batch_execution_error'],
                preprocessing_insufficient_flags: [],
                preprocessing_quality_warnings: [],
                last_error: error.message
            });
        summary.processed += 1;
        summary.errors += 1;
        summary.items.push({lp: inst.lp, institution_id: inst.institution_id, stage: 'error', error: error.message});
        if (!opts.continueOnError) {
            await persistAutomation();
            throw error;
        }
    }
})));

automation.updated_at = todayIso();
await persistAutomation();
await writeJson(runStatusPath(activeRunManifestPath), {
    run_id: runId,
    phase: 'prepare',
    status: summary.errors || summary.refresh_errors ? 'partial' : 'complete',
    manifest_path: activeRunManifestPath,
    institution_ids: runManifest.institution_ids,
    lps: runManifest.lps,
    summary,
    updated_at: new Date().toISOString()
});
console.log(JSON.stringify(summary, null, 2));
