#!/usr/bin/env node
import {Command} from 'commander';
import {readJson, dataPath} from './lib/common.mjs';

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

console.log(`Institutions: ${institutions.institutions.length}`);
console.log(`Checked: ${checked}`);
console.log(`TAK: ${yes}`);
console.log(`NIE: ${no}`);
console.log(`Checked unresolved: ${unresolved}`);
for (const stage of orderedStages) {
    console.log(`${stage}: ${stageCounts.get(stage) || 0}`);
}
