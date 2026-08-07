#!/usr/bin/env node
import {Command} from 'commander';
import {readJson, dataPath, slug} from './lib/common.mjs';

const program = new Command();
program
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .parse(process.argv);
const opts = program.opts();

const institutions = await readJson(opts.institutions);
const state = await readJson(opts.state);
const automation = await readJson(opts.automationState, {tasks: []});

const checked = state.rows.filter(r => r.review_status === 'checked').length;
const yes = state.rows.filter(r => r.review_status === 'checked' && r.qualifies === true).length;
const no = state.rows.filter(r => r.review_status === 'checked' && r.qualifies === false).length;
const unresolved = state.rows.filter(r => r.review_status === 'checked' && r.qualifies == null).length;

const stageCounts = new Map();
for (const task of automation.tasks || []) {
    const stage = task.stage || 'unknown';
    stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);
}

const orderedStages = [
    'pending_prepare',
    'preparing',
    'prepared',
    'ready_for_review',
    'unchanged_sources',
    'retry_pending',
    'retry',
    'checked',
    'needs_user_review',
    'escalated',
    'error'
];

const institutionById = new Map(institutions.institutions.map(inst => [inst.institution_id, inst]));
const rankingCounts = new Map();
let rankingFallbacks = 0;
let rankingInventoryCandidates = 0;
let rankingSelectedPool = 0;
let rankingExpandedPool = 0;
for (const task of automation.tasks || []) {
    const inst = institutionById.get(task.institution_id);
    const cachePath = inst
        ? dataPath('cache/institutions', `${String(inst.lp).padStart(3, '0')}-${slug(inst.name)}`, 'candidates.json')
        : null;
    const candidates = cachePath ? await readJson(cachePath, null) : null;
    const ranking = task.url_ranking || candidates?.url_ranking;
    if (!ranking?.provider) continue;
    rankingCounts.set(ranking.provider, (rankingCounts.get(ranking.provider) || 0) + 1);
    if (ranking.fallback_reason) rankingFallbacks += 1;
    rankingInventoryCandidates += ranking.candidate_count || 0;
    rankingSelectedPool += ranking.selected_pool_count || ranking.selected_pool?.length || 0;
    rankingExpandedPool += ranking.expanded_pool_count
        || (ranking.expanded_pools || []).reduce((count, pool) => count + (Array.isArray(pool) ? pool.length : 0), 0);
}

console.log(`Institutions: ${institutions.institutions.length}`);
console.log(`Checked: ${checked}`);
console.log(`TAK: ${yes}`);
console.log(`NIE: ${no}`);
console.log(`Checked unresolved: ${unresolved}`);
for (const stage of orderedStages) {
    console.log(`${stage}: ${stageCounts.get(stage) || 0}`);
}
console.log('Ranking providers:');
for (const [provider, count] of [...rankingCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${provider}: ${count}`);
}
console.log(`Ranking fallbacks: ${rankingFallbacks}`);
console.log(`Ranking inventory candidates: ${rankingInventoryCandidates}`);
console.log(`Ranking selected pool URLs: ${rankingSelectedPool}`);
console.log(`Ranking expanded pool URLs: ${rankingExpandedPool}`);
