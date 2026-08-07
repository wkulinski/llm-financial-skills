#!/usr/bin/env node
import path from 'node:path';
import {Command} from 'commander';
import {dataPath, readJson, readJsonl, sha256, slug, writeJsonAtomic} from './lib/common.mjs';
import {manifestIncludes, readRunManifest, runEvidencePath} from './lib/run-manifest.mjs';
import {normalizationArtifactPath, readNormalizationArtifact} from './lib/normalization-artifact.mjs';

const CRITERION_CATEGORIES = Object.freeze({
    product: ['product'],
    refinancing: ['refinancing'],
    fixed_rate: ['fixed_rate'],
    pricing: ['pricing']
});

function parseCriteria(value) {
    const requested = String(value || 'all').split(',').map(item => item.trim()).filter(Boolean);
    if (requested.includes('all')) return Object.keys(CRITERION_CATEGORIES);
    const unknown = requested.filter(item => !CRITERION_CATEGORIES[item]);
    if (unknown.length) throw new Error(`Unknown criterion: ${unknown.join(', ')}`);
    return [...new Set(requested)];
}

function compactHeuristic(contentCheck = {}, categories = []) {
    const allowed = new Set(categories.flatMap(category => CRITERION_CATEGORIES[category] || []));
    return Object.fromEntries(Object.entries(contentCheck)
        .filter(([category]) => allowed.has(category))
        .map(([category, value]) => [category, {
        status: value.status || null,
        decision_status: value.decision_status || null,
        matches: value.matches || 0,
        urls_count: Array.isArray(value.urls) ? value.urls.length : 0,
        eligible_urls_count: Array.isArray(value.eligible_urls) ? value.eligible_urls.length : 0
        }]));
}

function compactSource(source, normalized) {
    if (!source) return null;
    return {
        url: source.url,
        title: source.title || null,
        source_type: source.source_type || null,
        content_sha256: source.content_sha256 || null,
        source_text_sha256: normalized?.source_text_sha256 || (source.text ? sha256(source.text) : null),
        fetched_at: source.fetched_at || null,
        run_id: source.run_id || null
    };
}

function excerpt(row, source, window) {
    const text = String(row.text_excerpt || '');
    if (text.length <= window) return text;
    const sourceStart = Number.isInteger(row.source_start) ? row.source_start : null;
    if (sourceStart != null && source?.text) {
        const from = Math.max(0, sourceStart - Math.floor(window / 2));
        return source.text.slice(from, from + window);
    }
    return text.slice(0, window);
}

function compactEvidence(row, source, normalized, {includeExcerpt, window}) {
    const result = {
        evidence_id: row.evidence_id,
        category: row.category || row.field_path || null,
        keyword: row.keyword || null,
        match_type: row.match_type || null,
        source_role: row.source_role || 'unknown',
        url: row.url || null,
        title: row.title || source?.title || null,
        content_sha256: row.content_sha256 || source?.content_sha256 || null,
        source_text_sha256: source?.text_sha256 || null,
        source: compactSource(source, normalized)
    };
    if (includeExcerpt) result.text_excerpt = excerpt(row, source, window);
    return result;
}

function dedupeEvidence(rows) {
    const seen = new Set();
    return rows.filter(row => {
        const key = row.evidence_id || `${row.url}|${row.category}|${row.keyword}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function selectEvidence(rows, {category, evidenceId, url, maxPerCategory, includeExcludedContext, window, sourceByUrl, normalizedByUrl}) {
    const matches = rows.filter(row => {
        if (row.category !== category && row.field_path !== category) return false;
        if (evidenceId && row.evidence_id !== evidenceId) return false;
        if (url && row.url !== url) return false;
        return true;
    });
    const included = dedupeEvidence(matches.filter(row => row.source_role !== 'excluded_context'));
    const excluded = dedupeEvidence(matches.filter(row => row.source_role === 'excluded_context'));
    const visible = evidenceId || url ? included : included.slice(0, maxPerCategory);
    const omitted = evidenceId || url ? [] : included.slice(maxPerCategory).map(row => row.evidence_id);
    return {
        available_count: included.length,
        truncated: omitted.length > 0,
        omitted_evidence_ids: omitted,
        evidence: visible.map(row => compactEvidence(row, sourceByUrl.get(row.url), normalizedByUrl.get(row.url), {includeExcerpt: true, window})),
        excluded_context: {
            available_count: excluded.length,
            evidence: excluded.slice(0, includeExcludedContext ? maxPerCategory : 0).map(row => compactEvidence(row, sourceByUrl.get(row.url), normalizedByUrl.get(row.url), {includeExcerpt: includeExcludedContext, window})),
            evidence_ids: excluded.map(row => row.evidence_id)
        }
    };
}

async function resolveInstitution(institutions, manifest, lp) {
    const index = manifest.lps.indexOf(lp);
    const institutionId = manifest.institution_ids[index];
    const institution = institutions.institutions.find(item => item.institution_id === institutionId);
    if (!institution) throw new Error(`Institution not found for LP ${lp}: ${institutionId}`);
    return institution;
}

export async function readReviewContext({
    runManifestPath,
    lp = null,
    criterion = 'all',
    evidenceId = null,
    url = null,
    window = 900,
    maxPerCategory = 8,
    includeExcludedContext = false,
    institutionsPath = dataPath('base/institutions.current.json'),
    cacheRoot = dataPath('cache/institutions'),
    runEvidenceFile = null,
    outputPath = null
} = {}) {
    if (!runManifestPath) throw new Error('--run-manifest is required.');
    if (window < 100 || window > 5000) throw new Error('--window must be between 100 and 5000.');
    if (maxPerCategory < 1 || maxPerCategory > 100) throw new Error('--max-per-category must be between 1 and 100.');
    const manifest = await readRunManifest(runManifestPath);
    const institutions = await readJson(institutionsPath);
    const criteria = parseCriteria(criterion);
    const selectedLps = lp == null ? manifest.lps : [Number(lp)];
    for (const selectedLp of selectedLps) {
        if (!manifest.lps.includes(selectedLp)) throw new Error(`LP ${selectedLp} is outside the run manifest.`);
    }

    const evidencePath = runEvidenceFile || runEvidencePath(runManifestPath);
    const evidenceRows = await readJsonl(evidencePath);
    const foreignEvidence = evidenceRows.filter(row => row.run_id !== manifest.run_id);
    if (foreignEvidence.length) throw new Error(`Run evidence contains ${foreignEvidence.length} foreign record(s).`);
    const outOfScopeEvidence = evidenceRows.filter(row => !manifestIncludes(manifest, row.institution_id, row.lp));
    if (outOfScopeEvidence.length) throw new Error(`Run evidence contains ${outOfScopeEvidence.length} record(s) outside the manifest.`);

    const items = [];
    for (const selectedLp of selectedLps) {
        const institution = await resolveInstitution(institutions, manifest, selectedLp);
        const cacheDir = path.join(cacheRoot, `${String(institution.lp).padStart(3, '0')}-${slug(institution.name)}`);
        const sourceRows = await readJsonl(path.join(cacheDir, 'source-text.jsonl'));
        const foreignSources = sourceRows.filter(source => source.run_id !== manifest.run_id);
        if (foreignSources.length) throw new Error(`Source text contains ${foreignSources.length} foreign record(s) for LP ${selectedLp}.`);
        const outOfScopeSources = sourceRows.filter(source => !manifestIncludes(manifest, source.institution_id, source.lp));
        if (outOfScopeSources.length) throw new Error(`Source text contains ${outOfScopeSources.length} record(s) outside the manifest for LP ${selectedLp}.`);
        const candidates = await readJson(path.join(cacheDir, 'candidates.json')).catch(() => ({}));
        const normalizationFile = normalizationArtifactPath({cacheDir, runManifestPath, lp: selectedLp});
        const normalization = await readNormalizationArtifact(normalizationFile, {runId: manifest.run_id});
        const normalizedByUrl = new Map(normalization.sources.map(source => [source.url, source]));
        const sourceByUrl = new Map(sourceRows.map(source => [source.url, source]));
        const hashErrors = [];
        for (const source of normalization.sources.filter(item => item.status === 'normalized')) {
            const original = sourceByUrl.get(source.url);
            if (!original) {
                hashErrors.push(`missing source text: ${source.url}`);
                continue;
            }
            if (sha256(original.text || '') !== source.source_text_sha256) hashErrors.push(`source text hash mismatch: ${source.url}`);
        }
        if (hashErrors.length) throw new Error(`Review context integrity failure for LP ${selectedLp}: ${hashErrors.join('; ')}`);

        const rows = evidenceRows.filter(row => row.lp === selectedLp && row.institution_id === institution.institution_id);
        const criteriaOutput = Object.fromEntries(criteria.map(category => [category, selectEvidence(rows, {
            category,
            evidenceId,
            url,
            maxPerCategory,
            includeExcludedContext,
            window,
            sourceByUrl,
            normalizedByUrl
        })]));
        const selectedEvidenceCount = Object.values(criteriaOutput).reduce((sum, value) => sum + value.evidence.length, 0);
        items.push({
            lp: selectedLp,
            institution_id: institution.institution_id,
            name: institution.name,
            run_id: manifest.run_id,
            source_coverage: {
                source_count: normalization.source_count,
                normalized_source_count: normalization.normalized_source_count,
                unreadable_source_count: normalization.unreadable_source_count,
                engine: normalization.engine,
                selected_evidence_count: selectedEvidenceCount
            },
            heuristic: compactHeuristic(candidates.content_check, criteria),
            criteria: criteriaOutput,
            warnings: hashErrors
        });
    }

    const result = {
        schema_version: '1.0',
        run_id: manifest.run_id,
        scope: {lps: selectedLps, institution_ids: selectedLps.map(selectedLp => manifest.institution_ids[manifest.lps.indexOf(selectedLp)])},
        criteria,
        filters: {evidence_id: evidenceId, url, window, max_per_category: maxPerCategory, include_excluded_context: includeExcludedContext},
        generated_at: new Date().toISOString(),
        items
    };
    if (outputPath) await writeJsonAtomic(outputPath, result);
    return result;
}

async function main() {
    const program = new Command();
    program
        .requiredOption('--run-manifest <path>', 'exact-scope run manifest')
        .option('--lp <number>', 'single LP', value => parseInt(value, 10))
        .option('--criterion <criteria>', 'all or comma-separated product,refinancing,fixed_rate,pricing', 'all')
        .option('--evidence-id <id>', 'return one exact evidence record')
        .option('--url <url>', 'limit evidence to one URL')
        .option('--window <number>', 'original-text excerpt length', value => parseInt(value, 10), 900)
        .option('--max-per-category <number>', 'maximum visible evidence records per category', value => parseInt(value, 10), 8)
        .option('--include-excluded-context', 'include excerpts for excluded_context evidence', false)
        .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
        .option('--cache-root <path>', 'institution cache root', dataPath('cache/institutions'))
        .option('--output <path>', 'optional JSON output path')
        .parse(process.argv);
    const opts = program.opts();
    const result = await readReviewContext({
        runManifestPath: opts.runManifest,
        lp: opts.lp,
        criterion: opts.criterion,
        evidenceId: opts.evidenceId,
        url: opts.url,
        window: opts.window,
        maxPerCategory: opts.maxPerCategory,
        includeExcludedContext: opts.includeExcludedContext,
        institutionsPath: opts.institutions,
        cacheRoot: opts.cacheRoot,
        outputPath: opts.output
    });
    console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
