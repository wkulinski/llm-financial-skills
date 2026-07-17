#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {Command} from 'commander';
import {readJson, readJsonl, writeJson, slug, dataPath} from './lib/common.mjs';
import {markTask, assessPreprocessing, needsRetry} from './lib/automation.mjs';

const program = new Command();
program
    .option('--from <lp>', 'start from Lp', v => parseInt(v, 10))
    .option('--limit <number>', 'batch size', v => parseInt(v, 10), 20)
    .option('--refresh', 'refresh source discovery')
    .option('--fresh', 'start selected source discovery without a previous baseline')
    .option('--run-id <id>', 'run identifier propagated to generated artifacts')
    .option('--skip-discovery', 'reuse existing candidates cache and skip discover-sources')
    .option('--url-ranking', 'rank fallback URLs with the configured OpenCode subagent')
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .option('--continue-on-error', 'continue processing after errors', true)
    .parse(process.argv);
const opts = program.opts();
const runId = opts.runId || `run-${Date.now()}-${process.pid}`;

const institutions = await readJson(opts.institutions);
const state = await readJson(opts.state);
const automation = await readJson(opts.automationState);
const taskById = new Map((automation.tasks || []).map(task => [task.institution_id, task]));
const stateById = new Map((state.rows || []).map(row => [row.institution_id, row]));

function run(args, {stdio = 'pipe'} = {}) {
    const r = spawnSync(process.execPath, args, {stdio, encoding: 'utf8'});
    if (r.status !== 0) {
        const stderr = `${r.stderr || ''}`.trim();
        throw new Error(stderr || `${args.join(' ')} failed with status ${r.status}`);
    }
    return r.stdout || '';
}

function shouldInclude(inst, task, row) {
    if (!task) return false;
    if (!inst.website_url || inst.base_list_status === 'missing_website_url') return false;
    if (row?.review_status === 'checked') return false;
    if (opts.from && inst.lp < opts.from) return false;
    return task.stage === 'retry_pending' || task.stage === 'retry';
}

async function invalidateDerivedArtifacts(inst) {
    const lp = String(inst.lp).padStart(3, '0');
    await fs.rm(dataPath('work/review-packs', `lp-${lp}.md`), {force: true});
    await fs.rm(dataPath('work/row-updates', `lp-${lp}.json`), {force: true});
}

const selected = institutions.institutions
    .filter(inst => shouldInclude(inst, taskById.get(inst.institution_id), stateById.get(inst.institution_id)))
    .slice(0, opts.limit);

const summary = {
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
            last_error: null
        });
        await writeJson(opts.automationState, automation);

        if (!opts.skipDiscovery) {
            run([
                path.resolve(path.dirname(new URL(import.meta.url).pathname), 'discover-sources.mjs'),
                '--lp', String(inst.lp),
                '--allow-external',
                '--priority-max', '60',
                '--full-max', '200',
                '--run-id', runId,
                ...(opts.fresh ? ['--fresh'] : []),
                ...(opts.refresh ? ['--refresh'] : []),
                ...(opts.urlRanking ? ['--url-ranking'] : []),
                '--skip-unchanged'
            ]);
        }

        run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'extract-text.mjs'), '--lp', String(inst.lp)]);
        run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'grep-evidence.mjs'), '--lp', String(inst.lp), '--max-per-keyword', '5']);
        run([path.resolve(path.dirname(new URL(import.meta.url).pathname), 'prepare-review-pack.mjs'), '--lp', String(inst.lp), '--skip-preprocess', '--expanded']);

        const candidates = await readJson(path.join(cacheDir, 'candidates.json'));
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
            preprocessing_risk_flags: assessment.preprocessing_risk_flags
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
            await writeJson(opts.automationState, automation);
            throw error;
        }
    }
}

automation.updated_at = new Date().toISOString().slice(0, 10);
await writeJson(opts.automationState, automation);
console.log(JSON.stringify(summary, null, 2));
