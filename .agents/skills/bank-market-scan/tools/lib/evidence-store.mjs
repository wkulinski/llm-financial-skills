import fs from 'node:fs/promises';
import path from 'node:path';
import {readJsonl, sha256, writeJsonl} from './common.mjs';

function normalizedExcerpt(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

export function buildEvidenceId({institution_id = '', product_id = '', field_path = '', url = '', content_sha256 = '', text_excerpt = ''} = {}) {
    return `ev-${sha256([institution_id, product_id, field_path, url, content_sha256, normalizedExcerpt(text_excerpt)].join('|')).slice(0, 24)}`;
}

export function normalizeEvidenceRecord(record = {}, {runId = record.run_id} = {}) {
    const normalized = {
        ...record,
        run_id: runId || null,
        institution_id: record.institution_id || null,
        lp: record.lp == null ? null : Number(record.lp),
        product_id: record.product_id || null,
        field_path: record.field_path || record.category || null,
        url: record.url || null,
        content_sha256: record.content_sha256 || null,
        text_excerpt: normalizedExcerpt(record.text_excerpt || record.notes),
        used_for_decision: record.used_for_decision === true,
    };
    normalized.evidence_id = record.evidence_id || buildEvidenceId(normalized);
    return normalized;
}

export function validateEvidenceRecord(record, {runId, institutionId, productId: expectedProductId} = {}) {
    const errors = [];
    if (!record?.evidence_id) errors.push('missing evidence_id');
    if (runId && record.run_id !== runId) errors.push(`run_id mismatch: ${record.run_id || 'missing'}`);
    if (institutionId && record.institution_id !== institutionId) errors.push(`institution_id mismatch: ${record.institution_id || 'missing'}`);
    if (expectedProductId && record.product_id && record.product_id !== expectedProductId) errors.push(`product_id mismatch: ${record.product_id}`);
    if (!record?.url) errors.push('missing url');
    if (!record?.content_sha256) errors.push('missing content_sha256');
    if (!record?.fetched_at) errors.push('missing fetched_at');
    return errors;
}

export function validateFieldEvidenceReferences(rows, evidenceRows, {runId, strict = true} = {}) {
    const byId = new Map(evidenceRows.map(item => [item.evidence_id, item]));
    const errors = [];
    for (const row of rows || []) {
        for (const [fieldPath, references] of Object.entries(row.field_evidence || {})) {
            if (!Array.isArray(references)) continue;
            for (const reference of references) {
                if (!reference.evidence_id) {
                    if (strict) errors.push(`lp=${row.lp} ${fieldPath}: missing evidence_id`);
                    continue;
                }
                const evidence = byId.get(reference.evidence_id);
                if (!evidence) {
                    errors.push(`lp=${row.lp} ${fieldPath}: unknown evidence_id ${reference.evidence_id}`);
                    continue;
                }
                errors.push(...validateEvidenceRecord(evidence, {runId, institutionId: row.institution_id}).map(error => `lp=${row.lp} ${fieldPath}: ${error}`));
                if (reference.url && evidence.url !== reference.url) errors.push(`lp=${row.lp} ${fieldPath}: url mismatch for ${reference.evidence_id}`);
                if (reference.content_sha256 && evidence.content_sha256 !== reference.content_sha256) errors.push(`lp=${row.lp} ${fieldPath}: content hash mismatch for ${reference.evidence_id}`);
                const expectedCategory = fieldPath.includes('refinanc') ? 'refinancing'
                    : (fieldPath.includes('fixed_rate') ? 'fixed_rate' : (fieldPath.includes('housing') ? 'product' : null));
                if (expectedCategory && evidence.category && evidence.category !== expectedCategory && evidence.field_path !== expectedCategory) {
                    errors.push(`lp=${row.lp} ${fieldPath}: evidence category mismatch for ${reference.evidence_id}`);
                }
            }
        }
    }
    return errors;
}

export function mergeEvidence(existing, incoming) {
    const merged = new Map();
    for (const row of [...existing, ...incoming]) {
        const normalized = normalizeEvidenceRecord(row);
        const key = `${normalized.institution_id}|${normalized.evidence_id}|${normalized.content_sha256}`;
        const previous = merged.get(key);
        merged.set(key, previous ? {...previous, ...normalized, used_for_decision: previous.used_for_decision || normalized.used_for_decision} : normalized);
    }
    return [...merged.values()].sort((a, b) => `${a.institution_id}|${a.evidence_id}`.localeCompare(`${b.institution_id}|${b.evidence_id}`));
}

export async function writeRunEvidence(filePath, rows, runId) {
    const normalized = rows.map(row => normalizeEvidenceRecord(row, {runId}));
    const invalid = normalized.flatMap(row => validateEvidenceRecord(row, {runId}));
    if (invalid.length) throw new Error(`Invalid run evidence: ${invalid.join('; ')}`);
    const existing = await readJsonl(filePath);
    const merged = mergeEvidence(existing, normalized);
    await writeJsonl(filePath, merged);
    return merged;
}

export async function mergeRunEvidence({runEvidencePath, globalEvidencePath, runId, rows = []} = {}) {
    const incoming = rows.length ? rows : await readJsonl(runEvidencePath);
    const normalized = incoming.map(row => normalizeEvidenceRecord(row, {runId}));
    const errors = normalized.flatMap(row => validateEvidenceRecord(row, {runId}));
    if (errors.length) throw new Error(`Cannot merge invalid evidence: ${errors.join('; ')}`);
    const existing = await readJsonl(globalEvidencePath);
    const merged = mergeEvidence(existing, normalized);
    await fs.mkdir(path.dirname(globalEvidencePath), {recursive: true});
    const temporaryPath = `${globalEvidencePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, merged.map(row => `${JSON.stringify(row)}\n`).join(''), 'utf8');
    await fs.rename(temporaryPath, globalEvidencePath);
    return {merged, added: merged.length - mergeEvidence(existing, []).length};
}

export function runEvidencePath(manifestPath) {
    return path.join(path.dirname(manifestPath), 'evidence.jsonl');
}
