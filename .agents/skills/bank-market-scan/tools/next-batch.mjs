#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {readJson, writeJson, pathExists, slug, dataPath} from './lib/common.mjs';

const program = new Command();
program
    .option('--n <number>', 'batch size', v => parseInt(v, 10), 5)
    .option('--from <lp>', 'start from Lp', v => parseInt(v, 10))
    .option('--only-unchecked', 'only unchecked rows', true)
    .option('--mode <mode>', 'unchecked|changed-sources|needs-review|prepared|retry|escalation', 'unchecked')
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .option('--cache-root <path>', 'cache root', dataPath('cache/institutions'))
    .option('--out <path>', 'optional output JSON')
    .parse(process.argv);
const opts = program.opts();

const institutions = await readJson(opts.institutions);
const state = await readJson(opts.state);
const automation = await readJson(opts.automationState, {tasks: []});
const byId = new Map(state.rows.map(r => [r.institution_id, r]));
const taskById = new Map((automation.tasks || []).map(t => [t.institution_id, t]));

async function latestCompleteRefreshManifest() {
    const runDir = dataPath('work/source-refresh-runs');
    let entries;
    try {
        entries = await fs.readdir(runDir, {withFileTypes: true});
    } catch {
        throw new Error('No source refresh manifest found. Run prepare-batch --mode changed-only --refresh first.');
    }
    const manifests = [];
    for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))) {
        try {
            const manifest = await readJson(path.join(runDir, entry.name));
            manifests.push(manifest);
        } catch {
        }
    }
    manifests.sort((a, b) => String(b.completed_at || b.updated_at || '').localeCompare(String(a.completed_at || a.updated_at || '')));
    const latest = manifests[0];
    if (!latest || latest.status !== 'complete') throw new Error('The latest source refresh is not complete. Partial refresh cannot feed changed-sources.');
    if (latest.errors?.length || latest.expected_institution_ids?.length !== latest.completed_institution_ids?.length) {
        throw new Error('The latest source refresh manifest is incomplete.');
    }
    return latest;
}

async function sourceChangeSummary(inst, refreshManifest) {
    const cacheDir = path.join(opts.cacheRoot, `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`);
    const candidatesPath = path.join(cacheDir, 'candidates.json');
    if (!(await pathExists(candidatesPath))) return {has_cache: false, valid: false, changed: null, changed_count: null};
    const c = await readJson(candidatesPath);
    const valid = c.source_refresh_run_id === refreshManifest.run_id && Boolean(c.sources_refreshed_at);
    if (!valid) {
        return {
            has_cache: true,
            valid: false,
            changed: null,
            changed_count: null,
            error: 'stale_source_refresh_metadata'
        };
    }
    const changedCount = (c.candidates || []).filter(x => x.offer_changed_since_last_fetch === true).length;
    return {
        has_cache: true,
        valid: true,
        changed: c.offer_changed_since_last_fetch === true,
        changed_count: changedCount,
        discovery_changed: c.discovery_changed_since_last_fetch === true,
        source_refresh_run_id: c.source_refresh_run_id,
        sources_refreshed_at: c.sources_refreshed_at
    };
}

const refreshManifest = opts.mode === 'changed-sources'
    ? await latestCompleteRefreshManifest()
    : null;

let rows = [];
for (const i of institutions.institutions) {
    const row = byId.get(i.institution_id) || {};
    const hasWebsite = typeof i.website_url === 'string' && i.website_url.trim().length > 0;
    const base = {
        lp: i.lp,
        institution_id: i.institution_id,
        type: i.type,
        name: i.name,
        website_url: i.website_url,
        base_list_status: i.base_list_status || '',
        review_status: row.review_status ?? 'unchecked',
        qualifies: row.qualifies ?? null,
        checked_at: row.checked_at ?? null
    };
    const task = taskById.get(i.institution_id);
    if (task) {
        Object.assign(base, {
            queue_stage: task.stage ?? null,
            attempt_count: task.attempt_count ?? 0,
            preprocessing_risk_flags: task.preprocessing_risk_flags ?? []
        });
    }
    if (!hasWebsite || i.base_list_status === 'missing_website_url') continue;
    if (opts.mode === 'changed-sources') {
        const sourceChanges = await sourceChangeSummary(i, refreshManifest);
        if (!sourceChanges.valid) throw new Error(`Invalid source refresh cache for lp=${i.lp}: ${sourceChanges.error || 'missing metadata'}`);
        Object.assign(base, {
            source_changes: sourceChanges,
            source_refresh_run_id: sourceChanges.source_refresh_run_id,
            sources_refreshed_at: sourceChanges.sources_refreshed_at
        });
    }
    rows.push(base);
}
if (opts.from) rows = rows.filter(r => r.lp >= opts.from);
if (opts.mode === 'unchecked' && opts.onlyUnchecked !== false) rows = rows.filter(r => !['checked'].includes(r.review_status));
if (opts.mode === 'changed-sources') rows = rows.filter(r => r.source_changes?.changed === true);
if (opts.mode === 'needs-review') rows = rows.filter(r => ['needs_review', 'error'].includes(r.review_status));
if (opts.mode === 'prepared') rows = rows.filter(r => ['prepared', 'ready_for_review'].includes(r.queue_stage));
if (opts.mode === 'retry') rows = rows.filter(r => ['retry_pending', 'retry'].includes(r.queue_stage));
if (opts.mode === 'escalation') rows = rows.filter(r => ['escalated', 'needs_user_review'].includes(r.queue_stage));
rows = rows.slice(0, opts.n);
if (opts.out) await writeJson(opts.out, rows);
console.log(JSON.stringify(rows, null, 2));
