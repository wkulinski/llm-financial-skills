#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {Command} from 'commander';
import {z} from 'zod';
import {readJson, writeJsonAtomic, todayIso, ensureDir, deepMergeDefined, dataPath} from './lib/common.mjs';
import {DECISION_STATUSES, normalizeRowFields} from './lib/decision-model.mjs';

const EvidenceItem = z.object({
    evidence_id: z.string().optional(),
    url: z.string().optional(),
    source_type: z.string().optional(),
    fetched_at: z.string().optional(),
    text_excerpt: z.string().optional(),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
    notes: z.string().optional()
}).passthrough();

export const RowUpdate = z.object({
    institution_id: z.string().min(1),
    lp: z.number().int().positive(),
    run_id: z.string().min(1).optional(),
    decision_status: z.enum(DECISION_STATUSES).optional(),
    review_status: z.enum(['unchecked', 'checked', 'needs_review', 'error']),
    checked_at: z.string().nullable(),
    website_available: z.boolean().nullable(),
    qualifies: z.boolean().nullable(),
    status_text: z.string().optional().default(''),
    qualification: z.object({
        reason_codes: z.array(z.string()).optional(),
        non_qualification_reason_codes: z.array(z.string()).optional()
    }).passthrough().optional().default({}),
    decision_audit: z.object({
        product_scope: z.string().min(1),
        same_product_variant_confirmed: z.boolean(),
        criterion_evidence_urls: z.object({
            housing: z.array(z.string().min(1)).min(1),
            refinancing: z.array(z.string().min(1)).min(1),
            fixed_rate: z.array(z.string().min(1)).min(1)
        }).passthrough(),
        excluded_alternative_sources: z.array(z.string()).optional().default([])
    }).passthrough().optional(),
    offer: z.object({}).passthrough().optional().default({}),
    product_bundles: z.array(z.object({}).passthrough()).optional().default([]),
    bundle_decision: z.object({}).passthrough().optional().default({}),
    requirements: z.object({}).passthrough().optional().default({}),
    promotion: z.object({}).passthrough().optional().default({}),
    professional_groups: z.object({}).passthrough().optional().default({}),
    documents: z.object({}).passthrough().optional().default({}),
    source_urls: z.object({}).passthrough().optional().default({}),
    field_status: z.record(z.enum(['found', 'not_found', 'not_applicable', 'ambiguous', 'not_checked'])).optional().default({}),
    field_evidence: z.record(z.array(EvidenceItem)).optional().default({}),
    research_notes: z.string().optional().default(''),
    basis: z.string().optional().default('')
}).passthrough();

const NESTED_KEYS = [
    'qualification', 'decision_audit', 'offer', 'product_bundles', 'bundle_decision', 'requirements', 'promotion', 'professional_groups',
    'documents', 'source_urls', 'field_status', 'field_evidence'
];

export function decisionAuditWarnings(update) {
    if (update?.qualifies !== true) return [];
    const audit = update.decision_audit;
    const warnings = [];
    if (!audit) return ['qualifies=true requires decision_audit.'];
    if (audit.same_product_variant_confirmed !== true) {
        warnings.push('qualifies=true requires same_product_variant_confirmed=true.');
    }
    for (const key of ['housing', 'refinancing', 'fixed_rate']) {
        if (!Array.isArray(audit.criterion_evidence_urls?.[key]) || audit.criterion_evidence_urls[key].length === 0) {
            warnings.push(`qualifies=true requires decision_audit.criterion_evidence_urls.${key}.`);
        }
    }
    return warnings;
}

export function mergeRowUpdate(existing, update) {
    const merged = {...existing, ...update};
    for (const key of NESTED_KEYS) {
        merged[key] = key === 'field_evidence' && update?.[key] !== undefined
            ? update[key]
            : deepMergeDefined(existing?.[key], update?.[key]);
    }
    return merged;
}

export function findRowForUpdate(rows, update) {
    const byId = rows.findIndex(r => r.institution_id === update.institution_id);
    const byLp = rows.findIndex(r => r.lp === update.lp);
    if (byId >= 0 && byLp >= 0 && byId !== byLp) {
        throw new Error(`Refusing to update ambiguous row: institution_id matches row index ${byId}, but lp=${update.lp} matches row index ${byLp}.`);
    }
    if (byId >= 0) {
        if (rows[byId].lp !== update.lp) {
            throw new Error(`Refusing to update row ${update.institution_id}: lp mismatch; state has ${rows[byId].lp}, update has ${update.lp}.`);
        }
        return byId;
    }
    if (byLp >= 0) {
        if (rows[byLp].institution_id !== update.institution_id) {
            throw new Error(`Refusing to update lp=${update.lp}: institution_id mismatch; state has ${rows[byLp].institution_id}, update has ${update.institution_id}.`);
        }
        return byLp;
    }
    return -1;
}

async function main() {
    const program = new Command();
    program
        .requiredOption('--input <path>', 'row update JSON')
        .option('--state <path>', 'state file', dataPath('work/analysis-state.json'))
        .option('--expected-run-id <id>', 'reject updates from another preparation run')
        .option('--no-backup', 'do not create state backup')
        .parse(process.argv);
    const opts = program.opts();
    const update = normalizeRowFields(RowUpdate.parse(JSON.parse(await fs.readFile(opts.input, 'utf8'))));
    const auditWarnings = decisionAuditWarnings(update);
    if (auditWarnings.length) throw new Error(auditWarnings.join(' '));
    if (opts.expectedRunId && update.run_id !== opts.expectedRunId) {
        throw new Error(`Row update run_id mismatch: expected ${opts.expectedRunId}, got ${update.run_id || 'missing'}.`);
    }
    const state = await readJson(opts.state);
    if (!Array.isArray(state.rows)) throw new Error(`Invalid state file ${opts.state}: missing rows array.`);

    if (opts.backup !== false) {
        const backupDir = path.join(path.dirname(opts.state), 'backups');
        await ensureDir(backupDir);
        await fs.copyFile(opts.state, path.join(backupDir, `analysis-state.${Date.now()}.json`));
    }

    const idx = findRowForUpdate(state.rows, update);
    if (idx < 0) state.rows.push(update);
    else state.rows[idx] = normalizeRowFields(mergeRowUpdate(state.rows[idx], update));
    state.updated_at = todayIso();
    state.methodology_version = state.methodology_version || '2026-07-06-refinance-fixed-rate-v2';
    await writeJsonAtomic(opts.state, state);
    console.log(`Updated lp=${update.lp} institution_id=${update.institution_id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
