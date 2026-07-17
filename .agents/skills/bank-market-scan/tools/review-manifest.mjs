#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {readJson, dataPath} from './lib/common.mjs';

const program = new Command();
program
    .option('--from <lp>', 'start from Lp', v => parseInt(v, 10))
    .option('--limit <number>', 'batch size', v => parseInt(v, 10), 50)
    .option('--mode <mode>', 'ready|escalation|all', 'all')
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--state <path>', 'analysis state JSON', dataPath('work/analysis-state.json'))
    .option('--automation-state <path>', 'automation state JSON', dataPath('work/automation-state.json'))
    .option('--review-packs-dir <path>', 'review packs directory', dataPath('work/review-packs'))
    .option('--updates-dir <path>', 'row updates directory', dataPath('work/row-updates'))
    .option('--out <path>', 'optional JSON output path')
    .option('--md-out <path>', 'optional Markdown output path', dataPath('exports/review-queue.md'))
    .parse(process.argv);
const opts = program.opts();

const institutions = await readJson(opts.institutions);
const state = await readJson(opts.state);
const automation = await readJson(opts.automationState, {tasks: []});

const institutionById = new Map((institutions.institutions || []).map(inst => [inst.institution_id, inst]));
const rowById = new Map((state.rows || []).map(row => [row.institution_id, row]));

function includeTask(task) {
    if (opts.from && task.lp < opts.from) return false;
    if (opts.mode === 'ready') return task.stage === 'ready_for_review';
    if (opts.mode === 'escalation') return ['escalated', 'needs_user_review', 'error'].includes(task.stage);
    return ['ready_for_review', 'escalated', 'needs_user_review', 'error'].includes(task.stage);
}

async function exists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

const selectedTasks = (automation.tasks || [])
    .filter(includeTask)
    .sort((a, b) => a.lp - b.lp)
    .slice(0, opts.limit);

const items = [];
for (const task of selectedTasks) {
    const inst = institutionById.get(task.institution_id) || {};
    const row = rowById.get(task.institution_id) || {};
    const lpPadded = String(task.lp).padStart(3, '0');
    const reviewPackPath = path.resolve(opts.reviewPacksDir, `lp-${lpPadded}.md`);
    const updatePath = path.resolve(opts.updatesDir, `lp-${lpPadded}.json`);
    items.push({
        lp: task.lp,
        institution_id: task.institution_id,
        name: inst.name || '',
        type: inst.type || '',
        website_url: inst.website_url || '',
        review_status: row.review_status ?? 'unchecked',
        qualifies: row.qualifies ?? null,
        queue_stage: task.stage || 'unknown',
        run_id: task.run_id || null,
        attempt_count: task.attempt_count || 0,
        preprocessing_risk_flags: task.preprocessing_risk_flags || [],
        preprocessing_status: task.preprocessing_status || 'unknown',
        preprocessing_technical_flags: task.preprocessing_technical_flags || [],
        preprocessing_insufficient_flags: task.preprocessing_insufficient_flags || [],
        preprocessing_quality_warnings: task.preprocessing_quality_warnings || [],
        last_error: task.last_error || null,
        review_pack_path: await exists(reviewPackPath) ? reviewPackPath : null,
        row_update_path: await exists(updatePath) ? updatePath : null
    });
}

const summary = {
    mode: opts.mode,
    total: items.length,
    ready_for_review: items.filter(item => item.queue_stage === 'ready_for_review').length,
    escalated: items.filter(item => item.queue_stage === 'escalated').length,
    needs_user_review: items.filter(item => item.queue_stage === 'needs_user_review').length,
    error: items.filter(item => item.queue_stage === 'error').length
};

const manifest = {
    generated_at: new Date().toISOString(),
    summary,
    items
};

if (opts.out) {
    await fs.mkdir(path.dirname(opts.out), {recursive: true});
    await fs.writeFile(opts.out, JSON.stringify(manifest, null, 2), 'utf8');
}

const md = [
    '# Review Queue',
    '',
    `- Mode: ${summary.mode}`,
    `- Total: ${summary.total}`,
    `- ready_for_review: ${summary.ready_for_review}`,
    `- escalated: ${summary.escalated}`,
    `- needs_user_review: ${summary.needs_user_review}`,
    `- error: ${summary.error}`,
    '',
    '## Items',
    '',
    ...items.map(item => [
        `### LP ${item.lp} - ${item.name || item.institution_id}`,
        '',
        `- queue_stage: ${item.queue_stage}`,
        `- review_status: ${item.review_status}`,
        `- qualifies: ${item.qualifies === null ? 'null' : item.qualifies}`,
        `- attempt_count: ${item.attempt_count}`,
        `- preprocessing_status: ${item.preprocessing_status}`,
        `- preprocessing_risk_flags: ${(item.preprocessing_risk_flags || []).join(', ') || 'brak'}`,
        `- preprocessing_technical_flags: ${(item.preprocessing_technical_flags || []).join(', ') || 'brak'}`,
        `- preprocessing_insufficient_flags: ${(item.preprocessing_insufficient_flags || []).join(', ') || 'brak'}`,
        `- preprocessing_quality_warnings: ${(item.preprocessing_quality_warnings || []).join(', ') || 'brak'}`,
        `- last_error: ${item.last_error || 'brak'}`,
        `- review_pack_path: ${item.review_pack_path || 'brak'}`,
        `- row_update_path: ${item.row_update_path || 'brak'}`,
        `- website_url: ${item.website_url || 'brak'}`,
        ''
    ].join('\n'))
].join('\n');

if (opts.mdOut) {
    await fs.mkdir(path.dirname(opts.mdOut), {recursive: true});
    await fs.writeFile(opts.mdOut, md, 'utf8');
}

console.log(JSON.stringify(manifest, null, 2));
