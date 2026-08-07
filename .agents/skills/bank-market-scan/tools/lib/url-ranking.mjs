import fs from 'node:fs/promises';
import path from 'node:path';
import {
    dataPath,
    normalizeUrlIdentity,
    sha256,
    scoreUrl,
    writeJson,
    writeJsonAtomic,
    ensureDir
} from './common.mjs';
import {runOpenCodeRanking, parseOpenCodeOutput} from './opencode-ranking.mjs';
import {NAVIGATION_NOISE_RE, hardExclusionReason, isHardExcludedSourceCandidate} from './source-integrity.mjs';

export {runOpenCodeRanking, parseOpenCodeOutput};

export const LEGACY_RANKING_SCHEMA_VERSION = '1.0';
export const RANKING_SCHEMA_VERSION = '1.1';
export const SUPPORTED_RANKING_SCHEMA_VERSIONS = new Set([
    LEGACY_RANKING_SCHEMA_VERSION,
    RANKING_SCHEMA_VERSION
]);
export const DEFAULT_RANKING_TIMEOUT_MS = 120000;
export const DEFAULT_RANKING_RETRIES = 1;
export const DEFAULT_RANKING_BUDGET_MS = 150000;
export const RANKING_ROLES = new Set(['core', 'supporting', 'excluded_context', 'unknown']);
export const RANKING_CONFIDENCE = new Set(['low', 'medium', 'high']);
const DETERMINISTIC_KEYWORDS = {
    product: ['kredyt mieszkaniowy', 'kredyt hipoteczny', 'mieszkaniowo-hipoteczny', 'cele mieszkaniowe'],
    refinancing: ['refinansowanie kredytu', 'przeniesienie kredytu', 'spłata kredytu', 'splata kredytu', 'saldo kredytu'],
    fixed_rate: ['okresowo stałe', 'okresowo-stałe', 'stała stopa', 'stala stopa', 'oprocentowanie stałe'],
    pricing: ['oprocentowanie', 'tabela oprocentowania', 'taryfa', 'prowizja', 'rrso']
};
const OBVIOUS_NOISE_RULES = [
    ['cards', /karta|karty|kart kredyt/i],
    ['deposits', /lokat|depozyt/i],
    ['cash_or_auto_loan', /gotówk|gotowk|samochod|samochodowy|auto[- ]?kredyt/i],
    ['login', /logowan|login|e[- ]?bank|bankow(?:ość|osc)[- ]?(?:internet|elektron|online)/i],
    ['contact', /kontakt|contact/i],
    ['privacy', /rodo|polityk[aę] pryw|prywatno|cookies?/i],
    ['career', /karier|rekrut|praca/i],
    ['navigation_or_archive', NAVIGATION_NOISE_RE],
    ['technical_security', /bezpiecze(?:ń|n)stw[oa].*bankow|security/i]
];

export function candidateId(url) {
    return `url-${sha256(normalizeUrlIdentity(url)).slice(0, 32)}`;
}

export function candidateToManifest(candidate) {
    const url = candidate.final_url || candidate.url;
    return {
        candidate_id: candidate.candidate_id || candidateId(url),
        candidate_ref: candidate.candidate_ref || null,
        url,
        title: String(candidate.title || candidate.html_title || url),
        anchor_text: String(candidate.anchor_text || candidate.title || ''),
        snippet: String(candidate.snippet || ''),
        source: String(candidate.source || 'unknown'),
        query: candidate.query ?? null,
        search_rank: candidate.search_rank ?? null,
        relation: String(candidate.relation || 'unknown'),
        technical_status: candidate.technical_status || (candidate.available === false ? 'unavailable' : 'candidate'),
        status: candidate.status ?? null,
        available: candidate.available ?? null,
        canonical_url: candidate.canonical_url || null,
        source_integrity_flags: [...new Set(candidate.source_integrity_flags || [])],
        url_signals: [...new Set(candidate.url_signals || candidate.positive_signals || [])].map(String)
    };
}

function canonicalInventoryCandidate(candidate) {
    return {
        url: candidate.url,
        title: candidate.title,
        anchor_text: candidate.anchor_text,
        snippet: candidate.snippet || '',
        source: candidate.source,
        query: candidate.query ?? null,
        search_rank: candidate.search_rank ?? null,
        relation: candidate.relation,
        technical_status: candidate.technical_status
    };
}

export function inventorySha256(candidates = []) {
    const records = candidates
        .map(candidate => canonicalInventoryCandidate(candidateToManifest(candidate)))
        .sort((left, right) => {
            const leftIdentity = normalizeUrlIdentity(left.url);
            const rightIdentity = normalizeUrlIdentity(right.url);
            if (leftIdentity < rightIdentity) return -1;
            if (leftIdentity > rightIdentity) return 1;
            const leftJson = JSON.stringify(left);
            const rightJson = JSON.stringify(right);
            return leftJson < rightJson ? -1 : (leftJson > rightJson ? 1 : 0);
        });
    return sha256(JSON.stringify(records));
}

export const buildInventoryHash = inventorySha256;

export function buildRankingManifest({institution, homepageUrl, runId, candidates, discovery = {}}) {
    const seen = new Set();
    const manifestCandidates = [];
    for (const candidate of candidates || []) {
        const item = candidateToManifest(candidate);
        const identity = normalizeUrlIdentity(item.url);
        if (!item.url || seen.has(identity)) continue;
        seen.add(identity);
        manifestCandidates.push({
            ...item,
            candidate_ref: `c${String(manifestCandidates.length + 1).padStart(4, '0')}`
        });
    }
    const inventory_sha256 = inventorySha256(manifestCandidates);
    const locked_noise_count = manifestCandidates.filter(candidate => !isHardExcludedSourceCandidate(candidate) && isObviousNoiseCandidate(candidate)).length;
    const hard_excluded_count = manifestCandidates.filter(isHardExcludedSourceCandidate).length;
    return {
        schema_version: RANKING_SCHEMA_VERSION,
        institution_id: institution.institution_id,
        lp: institution.lp,
        name: institution.name || '',
        homepage_url: homepageUrl || institution.website_url,
        run_id: runId,
        discovery: {
            ...discovery,
            mode: discovery.mode || 'unknown',
            complete: discovery.complete ?? false,
            candidate_count: manifestCandidates.length,
            model_candidate_count: manifestCandidates.filter(candidate => !isObviousNoiseCandidate(candidate) && !isHardExcludedSourceCandidate(candidate)).length,
            locked_noise_count,
            hard_excluded_count,
            inventory_sha256
        },
        candidates: manifestCandidates
    };
}

function contains(text, words) {
    const value = String(text || '').toLowerCase();
    return words.some(word => value.includes(word));
}

export function isObviousNoiseCandidate(candidate) {
    return Boolean(obviousNoiseReason(candidate));
}

export function obviousNoiseReason(candidate) {
    const metadata = `${candidate.url} ${candidate.title} ${candidate.anchor_text}`;
    return OBVIOUS_NOISE_RULES.find(([, pattern]) => pattern.test(metadata))?.[0] || null;
}

export function deterministicRank(manifest) {
    const schemaVersion = manifest.schema_version || RANKING_SCHEMA_VERSION;
    return {
        schema_version: schemaVersion,
        institution_id: manifest.institution_id,
        run_id: manifest.run_id,
        model: {
            provider: 'deterministic',
            model: 'deterministic-scoreUrl',
            prompt_version: '1'
        },
        ranked_candidates: manifest.candidates.map(candidate => {
            const haystack = `${candidate.url} ${candidate.title} ${candidate.anchor_text}`.toLowerCase();
            const scored = scoreUrl(candidate.url, `${candidate.title} ${candidate.anchor_text}`, DETERMINISTIC_KEYWORDS);
            const noise = isObviousNoiseCandidate(candidate);
            const hardExcluded = isHardExcludedSourceCandidate(candidate);
            const product = contains(haystack, ['kredyt mieszk', 'kredyt hipotecz', 'mieszkaniow', 'hipotecz']);
            const refinance = contains(haystack, ['refinans', 'przeniesienie kredytu', 'spłata kredytu', 'splata kredytu', 'saldo kredytu']);
            const fixed = contains(haystack, ['okresowo sta', 'okresowo-sta', 'stała stopa', 'stala stopa', 'oprocentowanie sta']);
            const supporting = contains(haystack, ['tabela oprocent', 'taryfa', 'prowiz', 'rrso', '.pdf', 'dokument']);
            const priority = hardExcluded || noise ? 0 : (product ? 3 : ((refinance || supporting || scored.score > 0) ? 2 : 1));
            const role = hardExcluded || noise ? 'excluded_context' : (product || refinance ? 'core' : (supporting ? 'supporting' : 'unknown'));
            const signals = [product && 'product', refinance && 'refinancing', fixed && 'fixed_rate'].filter(Boolean);
            return {
                ...(schemaVersion === RANKING_SCHEMA_VERSION ? {candidate_ref: candidate.candidate_ref} : {}),
                candidate_id: candidate.candidate_id,
                url: candidate.url,
                priority,
                role,
                reason: hardExcluded
                    ? `Hard excluded: ${hardExclusionReason(candidate)}.`
                    : noise
                    ? `Locked noise: ${obviousNoiseReason(candidate)}.`
                    : (signals.length ? `Signals: ${signals.join(', ')}.` : 'No decisive signal; retained for safety.'),
                model_confidence: signals.length >= 2 ? 'medium' : 'low'
            };
        }).sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url))
    };
}

export function openCodeEscalationReasons(manifest, deterministicRanking = deterministicRank(manifest)) {
    const candidates = manifest?.candidates || [];
    const ranked = (deterministicRanking.ranked_candidates || []).filter(item => item.role !== 'excluded_context');
    const reasons = [];
    if (ranked.length >= 2 && Math.abs((ranked[0].priority || 0) - (ranked[1].priority || 0)) <= 1) reasons.push('top_two_tie_or_near_tie');
    if (candidates.filter(candidate => /kredyt[- ]mieszk|kredyt[- ]hipotecz|mieszkaniowo[- ]hipotecz/i.test(`${candidate.url} ${candidate.title} ${candidate.anchor_text}`)).length > 1) reasons.push('multiple_product_candidates');
    if (candidates.some(candidate => candidate.canonical_url && normalizeUrlIdentity(candidate.canonical_url) !== normalizeUrlIdentity(candidate.url))) reasons.push('canonical_conflict');
    if (candidates.some(candidate => candidate.rate_variant_conflict || candidate.source_role_conflict)) reasons.push('metadata_conflict');
    const topSignals = ranked.slice(0, 3).flatMap(item => `${item.url} ${item.reason}`);
    if (!/kredyt|mieszk|hipotecz/i.test(topSignals.join(' ')) || !/refinans|przenies|splat|stał|stal|oprocent/i.test(topSignals.join(' '))) reasons.push('insufficient_deterministic_coverage');
    return [...new Set(reasons)];
}

export function shouldUseOpenCode(manifest, deterministicRanking = deterministicRank(manifest)) {
    return openCodeEscalationReasons(manifest, deterministicRanking).length > 0;
}

export function validateManifest(manifest, {allowLegacy = true} = {}) {
    const errors = [];
    const version = manifest?.schema_version;
    if (!SUPPORTED_RANKING_SCHEMA_VERSIONS.has(version) || (version === LEGACY_RANKING_SCHEMA_VERSION && !allowLegacy)) {
        errors.push('invalid_input_schema_version');
    }
    if (!manifest?.institution_id || !manifest?.run_id || !Array.isArray(manifest?.candidates)) {
        errors.push('invalid_input_shape');
    }
    if (version === RANKING_SCHEMA_VERSION) {
        if (!manifest.discovery || typeof manifest.discovery !== 'object') errors.push('invalid_discovery_metadata');
        if (manifest.discovery?.candidate_count !== manifest.candidates?.length) errors.push('discovery_candidate_count_mismatch');
        if (manifest.discovery
            && manifest.discovery.model_candidate_count + manifest.discovery.locked_noise_count + (manifest.discovery.hard_excluded_count || 0) !== manifest.candidates?.length) {
            errors.push('discovery_candidate_breakdown_mismatch');
        }
        if (manifest.discovery?.inventory_sha256 !== inventorySha256(manifest.candidates || [])) {
            errors.push('inventory_hash_mismatch');
        }
    }
    const refs = new Set();
    const ids = new Set();
    const urls = new Set();
    const requiresStage1Fields = version === RANKING_SCHEMA_VERSION;
    for (const candidate of manifest?.candidates || []) {
        if (!/^c[0-9]{4}$/.test(candidate.candidate_ref || '') || !candidate.candidate_id
            || typeof candidate.url !== 'string' || !candidate.url || typeof candidate.title !== 'string'
            || typeof candidate.anchor_text !== 'string' || (requiresStage1Fields && typeof candidate.snippet !== 'string')
            || !candidate.source || (requiresStage1Fields && candidate.query !== null && typeof candidate.query !== 'string')
            || (requiresStage1Fields && candidate.search_rank !== null && !Number.isInteger(candidate.search_rank))
            || !candidate.relation || !candidate.technical_status
            || (requiresStage1Fields && !Array.isArray(candidate.url_signals))) {
            errors.push('invalid_input_candidate');
        }
        if (refs.has(candidate.candidate_ref)) errors.push('duplicate_candidate_ref');
        if (ids.has(candidate.candidate_id)) errors.push('duplicate_candidate_id');
        if (urls.has(normalizeUrlIdentity(candidate.url))) errors.push('duplicate_candidate_url');
        refs.add(candidate.candidate_ref);
        ids.add(candidate.candidate_id);
        urls.add(normalizeUrlIdentity(candidate.url));
    }
    return {ok: errors.length === 0, errors: [...new Set(errors)]};
}

export function validateRanking(manifest, ranking, {allowPartial = true} = {}) {
    const errors = [];
    const manifestValidation = validateManifest(manifest);
    errors.push(...manifestValidation.errors);
    if (!ranking || !SUPPORTED_RANKING_SCHEMA_VERSIONS.has(ranking.schema_version)) errors.push('invalid_output_schema_version');
    if (manifest?.schema_version && ranking?.schema_version && manifest.schema_version !== ranking.schema_version) {
        errors.push('schema_version_mismatch');
    }
    if (!ranking?.model || typeof ranking.model.provider !== 'string'
        || typeof ranking.model.model !== 'string' || typeof ranking.model.prompt_version !== 'string') {
        errors.push('invalid_output_model');
    }
    if (ranking?.institution_id !== manifest?.institution_id) errors.push('institution_id_mismatch');
    if (ranking?.run_id !== manifest?.run_id) errors.push('run_id_mismatch');
    const inputById = new Map((manifest?.candidates || []).map(candidate => [candidate.candidate_id, candidate]));
    const inputByIdentity = new Map((manifest?.candidates || []).map(candidate => [normalizeUrlIdentity(candidate.url), candidate]));
    const seenIds = new Set();
    const seenUrls = new Set();
    if (!Array.isArray(ranking?.ranked_candidates)) errors.push('invalid_ranked_candidates');
    for (const item of ranking?.ranked_candidates || []) {
        if (ranking.schema_version === RANKING_SCHEMA_VERSION && !item.candidate_ref) errors.push('missing_candidate_ref');
        const input = manifest?.candidates?.find(candidate => candidate.candidate_ref === item.candidate_ref)
            || inputById.get(item.candidate_id);
        const candidateId = item.candidate_id || input?.candidate_id;
        const itemIdentity = item.url ? normalizeUrlIdentity(item.url) : input ? normalizeUrlIdentity(input.url) : '';
        if ((candidateId && seenIds.has(candidateId)) || (itemIdentity && seenUrls.has(itemIdentity))) errors.push('duplicate_candidate');
        if (candidateId) seenIds.add(candidateId);
        if (itemIdentity) seenUrls.add(itemIdentity);
        if (!input) errors.push(item.candidate_ref ? 'candidate_ref_not_in_manifest' : 'candidate_id_not_in_manifest');
        else if (item.url && normalizeUrlIdentity(input.url) !== itemIdentity) errors.push('candidate_url_mismatch');
        else if (item.url && !inputByIdentity.has(itemIdentity)) errors.push('url_not_in_manifest');
        if (!candidateId) errors.push('candidate_id_not_in_manifest');
        if (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 3) errors.push('invalid_priority');
        if (!RANKING_ROLES.has(item.role)) errors.push('invalid_role');
        if (!RANKING_CONFIDENCE.has(item.model_confidence)) errors.push('invalid_model_confidence');
        if (typeof item.reason !== 'string' || !item.reason.trim()) errors.push('invalid_reason');
        if (input) {
            const metadata = `${input.url} ${input.title} ${input.anchor_text}`.toLowerCase();
            const obviousNoise = isObviousNoiseCandidate(input);
            const hardExcluded = isHardExcludedSourceCandidate(input);
            const obviousProduct = /kredyt[- ]mieszk|kredyt[- ]hipotecz|mieszkaniowo[- ]hipotecz/.test(metadata);
            if (obviousNoise && (item.priority !== 0 || item.role !== 'excluded_context')) errors.push('obvious_noise_misclassified');
            if (hardExcluded && (item.priority !== 0 || item.role !== 'excluded_context')) errors.push('hard_excluded_misclassified');
            if (obviousProduct && (item.priority < 2 || item.role === 'excluded_context')) errors.push('obvious_product_misclassified');
        }
    }
    const missing = (manifest?.candidates || []).filter(candidate => !seenIds.has(candidate.candidate_id));
    if (missing.length && !allowPartial) errors.push('missing_candidates');
    const normalized = {
        ...ranking,
        ranked_candidates: [
            ...(ranking?.ranked_candidates || []).map(item => {
                const input = manifest?.candidates?.find(candidate => candidate.candidate_ref === item.candidate_ref)
                    || inputById.get(item.candidate_id);
                return input && (!item.url || normalizeUrlIdentity(input.url) === normalizeUrlIdentity(item.url))
                    ? {...item, candidate_ref: input.candidate_ref, candidate_id: input.candidate_id, url: input.url}
                    : item;
            }),
            ...missing.map(candidate => ({
                candidate_ref: candidate.candidate_ref,
                candidate_id: candidate.candidate_id,
                url: candidate.url,
                priority: 0,
                role: 'unknown',
                reason: 'Model did not rank this candidate; retained as a safety fallback.',
                model_confidence: 'low'
            }))
        ]
    };
    return {ok: errors.length === 0, errors: [...new Set(errors)], missing, normalized};
}

export function normalizeCompactRanking(manifest, ranking) {
    const byRef = new Map((manifest.candidates || []).map(candidate => [candidate.candidate_ref, candidate]));
    const byId = new Map((manifest.candidates || []).map(candidate => [candidate.candidate_id, candidate]));
    const rankedCandidates = (ranking?.ranked_candidates || []).map(item => {
        const input = byRef.get(item.candidate_ref) || byId.get(item.candidate_id);
        if (!input) return item;
        return {
            ...item,
            candidate_id: input.candidate_id,
            candidate_ref: input.candidate_ref,
            url: input.url
        };
    });
    return {
        schema_version: ranking?.schema_version || manifest.schema_version || RANKING_SCHEMA_VERSION,
        institution_id: ranking?.institution_id || manifest.institution_id,
        run_id: ranking?.run_id || manifest.run_id,
        model: ranking?.model || {provider: 'opencode', model: 'openai/gpt-5.6-luna', prompt_version: '1'},
        ...ranking,
        ranked_candidates: rankedCandidates
    };
}

export function buildSelectionReport(manifest, ranking, {
    provider = ranking?.model?.provider || 'unknown',
    selectedPool = [],
    expandedPools = [],
    expansionReasons = [],
    fetchedUrls = [],
    skippedUrls = [],
    maxAdditionalPools = null,
    expansionStopReason = null,
    discoveryMs = null,
    rankingMs = null,
    fetchMs = null
} = {}) {
    const selectedUrls = selectedPool.map(candidate => typeof candidate === 'string' ? candidate : candidate?.url).filter(Boolean);
    const selectedIds = new Set(selectedPool.map(candidate => typeof candidate === 'string' ? null : candidate?.candidate_id).filter(Boolean));
    const rankedById = new Map((ranking?.ranked_candidates || []).map(candidate => [candidate.candidate_id, candidate]));
    const coverage = new Set();
    for (const candidateId of selectedIds) {
        const item = rankedById.get(candidateId);
        const text = `${item?.url || ''} ${item?.reason || ''}`;
        if (/kredyt|mieszk|hipotecz/i.test(text)) coverage.add('product');
        if (/refinans|przenies|spłat|splat|saldo/i.test(text)) coverage.add('refinancing');
        if (/stał|stal|oprocent|fixed/i.test(text)) coverage.add('fixed_rate');
        if (/oprocent|taryf|prowiz|rrso|\.pdf/i.test(text)) coverage.add('pricing');
    }
    return {
        schema_version: RANKING_SCHEMA_VERSION,
        institution_id: manifest.institution_id,
        run_id: manifest.run_id,
        inventory_sha256: manifest.discovery?.inventory_sha256 || null,
        candidate_count: manifest.candidates?.length || 0,
        model_candidate_count: manifest.discovery?.model_candidate_count ?? (manifest.candidates?.length || 0),
        locked_noise_count: manifest.discovery?.locked_noise_count ?? 0,
        selected_pool: selectedUrls,
        selected_pool_coverage: [...coverage],
        expanded_pools: expandedPools,
        expansion_reasons: expansionReasons,
        max_additional_pools: maxAdditionalPools,
        expansion_stop_reason: expansionStopReason,
        fetched_urls: fetchedUrls,
        skipped_urls: skippedUrls,
        provider,
        timings_ms: {
            discovery: discoveryMs,
            ranking: rankingMs,
            fetch: fetchMs
        },
        generated_at: new Date().toISOString()
    };
}

export function selectInitialPool(ranking, candidates, {min = 12, max = 16} = {}) {
    const byId = new Map(candidates.map(candidate => [candidate.candidate_id, candidate]));
    const ranked = [...(ranking.ranked_candidates || [])];
    const eligible = ranked.filter(item => item.role !== 'excluded_context');
    const selected = [];
    const selectedIds = new Set();
    const add = item => {
        if (!item || selectedIds.has(item.candidate_id) || !byId.has(item.candidate_id)) return;
        selectedIds.add(item.candidate_id);
        selected.push(byId.get(item.candidate_id));
    };
    const addMatching = predicate => eligible.filter(predicate).slice(0, 3).forEach(add);
    addMatching(item => item.role === 'core' && item.priority >= 2);
    addMatching(item => /refinans|przenies|spłat|splat|saldo/i.test(`${item.url} ${item.reason}`));
    addMatching(item => /stał|stal|oprocent|fixed/i.test(`${item.url} ${item.reason}`));
    addMatching(item => item.role === 'supporting');
    addMatching(item => item.role === 'unknown' || (item.priority <= 1 && item.role !== 'excluded_context'));
    for (const item of eligible) {
        if (selected.length >= max) break;
        add(item);
    }
    if (selected.length < Math.min(min, eligible.length)) {
        for (const candidate of candidates) {
            if (selected.length >= Math.min(min, eligible.length)) break;
            const rankedCandidate = eligible.find(item => item.candidate_id === candidate.candidate_id);
            add(rankedCandidate);
        }
    }
    return selected.slice(0, max);
}

export function selectAdditionalPool(ranking, candidates, {
    alreadyFetchedUrls = [],
    missingCategories = [],
    limit = 8
} = {}) {
    const fetched = new Set(alreadyFetchedUrls.map(normalizeUrlIdentity));
    const missing = new Set(missingCategories);
    const byId = new Map(candidates.map(candidate => [candidate.candidate_id, candidate]));
    const available = (ranking.ranked_candidates || []).filter(item =>
        item.role !== 'excluded_context'
        && !fetched.has(normalizeUrlIdentity(item.url))
        && byId.has(item.candidate_id)
    );
    const matches = category => available.filter(item => {
        const text = `${item.url} ${item.reason}`;
        if (category === 'product') return /kredyt|mieszk|hipotecz/i.test(text);
        if (category === 'refinancing') return /refinans|przenies|spłat|splat|saldo/i.test(text);
        if (category === 'fixed_rate') return /stał|stal|oprocent|fixed/i.test(text);
        if (category === 'pricing') return /oprocent|taryf|prowiz|rrso|\.pdf/i.test(text);
        return false;
    });
    const selected = [];
    const selectedIds = new Set();
    const add = item => {
        if (!item || selected.length >= limit || selectedIds.has(item.candidate_id)) return;
        selectedIds.add(item.candidate_id);
        selected.push(byId.get(item.candidate_id));
    };
    for (const category of missing) matches(category).slice(0, 3).forEach(add);
    available.forEach(add);
    return selected.slice(0, limit);
}

async function rankModelManifest(manifest, manifestPath, rawPath, stderrPath, {useOpenCode, timeoutMs, retries, spawnImpl}) {
    const attempts = [];
    if (!useOpenCode) {
        const error = new Error('OpenCode disabled.');
        await fs.writeFile(rawPath, `ERROR: ${error.message}\n`, 'utf8');
        return {ranking: deterministicRank(manifest), provider: 'deterministic', attempts: [{attempt: 1, status: 'disabled', error: error.message}]};
    }
    try {
        const result = await runOpenCodeRanking(manifestPath, {timeoutMs, retries, spawnImpl});
        const normalizedModelRanking = normalizeCompactRanking(manifest, result.ranking);
        const validation = validateRanking(manifest, normalizedModelRanking, {allowPartial: true});
        attempts.push(...result.attempts);
        await fs.writeFile(rawPath, result.raw, 'utf8');
        await fs.writeFile(stderrPath, result.stderr || '', 'utf8');
        if (validation.ok) return {ranking: validation.normalized, provider: 'opencode', attempts};
        return {ranking: deterministicRank(manifest), provider: 'deterministic_after_validation_error', attempts, validation};
    } catch (error) {
        attempts.push(...(error.attempts || [{attempt: 1, status: 'error', error: error.message}]));
        if (error.rawOutput) await fs.writeFile(rawPath, error.rawOutput, 'utf8');
        await fs.writeFile(stderrPath, error.stderr || '', 'utf8');
        await fs.appendFile(rawPath, `${error.rawOutput ? '\n' : ''}ERROR: ${error.message}\n`, 'utf8');
        return {ranking: deterministicRank(manifest), provider: 'deterministic_fallback', attempts};
    }
}

export async function rankManifest(manifest, {
    useOpenCode = false,
    workDir = dataPath('work/subagent-runs'),
    timeoutMs = DEFAULT_RANKING_TIMEOUT_MS,
    retries = DEFAULT_RANKING_RETRIES,
    budgetMs = DEFAULT_RANKING_BUDGET_MS,
    spawnImpl
} = {}) {
    const runDir = path.join(workDir, manifest.run_id, String(manifest.institution_id));
    await ensureDir(runDir);
    const manifestPath = path.join(runDir, 'url-ranking-input.json');
    const rawPath = path.join(runDir, 'raw-response.txt');
    const stderrPath = path.join(runDir, 'stderr.txt');
    const outputPath = path.join(runDir, 'url-ranking.json');
    const validationPath = path.join(runDir, 'validation-report.json');
    await writeJson(manifestPath, manifest);
    const hardExcludedCandidates = manifest.candidates.filter(isHardExcludedSourceCandidate);
    const lockedCandidates = manifest.candidates.filter(candidate => !isHardExcludedSourceCandidate(candidate) && isObviousNoiseCandidate(candidate));
    const modelCandidates = manifest.candidates.filter(candidate => !isHardExcludedSourceCandidate(candidate) && !isObviousNoiseCandidate(candidate));
    const hardExcludedRanking = hardExcludedCandidates.map(candidate => ({
        candidate_ref: candidate.candidate_ref,
        candidate_id: candidate.candidate_id,
        url: candidate.url,
        priority: 0,
        role: 'excluded_context',
        reason: `Hard excluded: ${hardExclusionReason(candidate)}.`,
        model_confidence: 'low'
    }));
    const lockedRanking = lockedCandidates.length
        ? deterministicRank({...manifest, candidates: lockedCandidates}).ranked_candidates
        : [];
    const modelManifest = lockedCandidates.length || hardExcludedCandidates.length
        ? {
            ...manifest,
            discovery: manifest.discovery ? {
                ...manifest.discovery,
                candidate_count: modelCandidates.length,
                model_candidate_count: modelCandidates.length,
                locked_noise_count: 0,
                hard_excluded_count: 0,
                inventory_sha256: inventorySha256(modelCandidates)
            } : undefined,
            candidates: modelCandidates
        }
        : manifest;
    const modelManifestPath = lockedCandidates.length || hardExcludedCandidates.length
        ? path.join(runDir, 'url-ranking-input.model.json')
        : manifestPath;
    await fs.writeFile(rawPath, '', 'utf8');
    await fs.writeFile(stderrPath, '', 'utf8');
    const startedAt = Date.now();
    const deterministicBaseline = deterministicRank(modelManifest);
    const escalationReasons = useOpenCode ? openCodeEscalationReasons(modelManifest, deterministicBaseline) : [];
    let modelResult = {ranking: deterministicBaseline, provider: escalationReasons.length ? 'deterministic' : 'deterministic_fast_path', attempts: [], escalation_reasons: escalationReasons};
    if (modelCandidates.length) {
        if (lockedCandidates.length || hardExcludedCandidates.length) await writeJson(modelManifestPath, modelManifest);
        if (escalationReasons.length > 0) {
            modelResult = Date.now() - startedAt >= budgetMs
                ? {
                    ranking: deterministicBaseline,
                    provider: 'deterministic_budget_exhausted',
                    attempts: [{attempt: 0, status: 'budget_exhausted', error: `Ranking budget ${budgetMs} ms exceeded.`}],
                    escalation_reasons: escalationReasons
                }
                : await rankModelManifest(modelManifest, modelManifestPath, rawPath, stderrPath, {useOpenCode: true, timeoutMs, retries, spawnImpl});
        }
        if (modelResult.provider === 'deterministic_budget_exhausted') {
            await fs.writeFile(rawPath, `ERROR: Ranking budget ${budgetMs} ms exceeded.\n`, 'utf8');
        }
    }
    const merged = {
        schema_version: manifest.schema_version || RANKING_SCHEMA_VERSION,
        institution_id: manifest.institution_id,
        run_id: manifest.run_id,
        ranked_candidates: [...lockedRanking, ...hardExcludedRanking, ...(modelResult.ranking.ranked_candidates || [])],
        model: {provider: 'opencode', model: 'openai/gpt-5.6-luna', prompt_version: '1'}
    };
    const validation = validateRanking(manifest, merged, {allowPartial: true});
    let ranking;
    let provider;
    if (!validation.ok) {
        ranking = deterministicRank(manifest);
        provider = 'deterministic_after_validation_error';
    } else {
        ranking = validation.normalized;
        provider = !useOpenCode
            ? 'deterministic'
            : (modelCandidates.length === 0
                ? 'deterministic'
                : (modelResult.provider === 'opencode'
                    ? (lockedCandidates.length ? 'opencode_mixed' : 'opencode')
                    : modelResult.provider === 'deterministic_fast_path' ? 'deterministic_fast_path' : modelResult.provider));
    }
    ranking = manifest.schema_version === LEGACY_RANKING_SCHEMA_VERSION
        ? {
            ...ranking,
            ranked_candidates: ranking.ranked_candidates.map(({candidate_ref: _candidateRef, ...item}) => item)
        }
        : ranking;
    ranking.model = {
        provider,
        model: provider === 'opencode' || provider === 'opencode_mixed' ? 'openai/gpt-5.6-luna' : 'deterministic-scoreUrl',
        prompt_version: '1'
    };
    await writeJsonAtomic(outputPath, ranking);
    const selectionPool = selectInitialPool(ranking, manifest.candidates);
    const selectionReportPath = path.join(runDir, 'selection-report.json');
    await writeJson(selectionReportPath, buildSelectionReport(manifest, ranking, {
        provider,
        selectedPool: selectionPool,
        rankingMs: Math.max(0, Date.now() - startedAt)
    }));
    await writeJson(validationPath, {
        valid: validation.ok,
        errors: validation.errors,
        institution_id: manifest.institution_id,
        run_id: manifest.run_id,
        missing_candidate_ids: validation.missing.map(candidate => candidate.candidate_id),
        final_provider: provider,
        candidate_count: manifest.candidates.length,
        inventory_sha256: manifest.discovery?.inventory_sha256 || null,
        model_input_count: modelCandidates.length,
        locked_candidate_count: lockedCandidates.length,
        hard_excluded_candidate_count: hardExcludedCandidates.length,
        budget_ms: budgetMs,
        attempts: modelResult.attempts,
        model_input_path: modelCandidates.length ? modelManifestPath : null,
        stderr_path: stderrPath,
        validated_at: new Date().toISOString()
    });
    return {
        ranking,
        manifestPath,
        rawPath,
        outputPath,
        validationPath,
        selectionReportPath,
        stderrPath,
        provider,
        validation,
        attempts: modelResult.attempts
    };
}
