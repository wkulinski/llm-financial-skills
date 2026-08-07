import path from 'node:path';
import {readJson, sha256, writeJsonAtomic} from './common.mjs';

export const NORMALIZATION_SCHEMA_VERSION = '1.0';

export function normalizationArtifactPath({cacheDir, runManifestPath = null, lp = null} = {}) {
    const fileName = lp == null ? 'normalized-text.json' : `lp-${String(lp).padStart(3, '0')}.json`;
    if (runManifestPath) return path.join(path.dirname(runManifestPath), 'normalization', fileName);
    if (!cacheDir) throw new Error('cacheDir or runManifestPath is required for normalization artifact path.');
    return path.join(cacheDir, 'normalized-text.json');
}

function normalizedSourceRecord(source, morphology) {
    const text = String(source.text || '');
    const sourceTextSha256 = sha256(text);
    if (!text || source.error) {
        return {
            url: source.url || null,
            content_sha256: source.content_sha256 || null,
            source_text_sha256: sourceTextSha256,
            status: 'unreadable',
            error: source.error || 'empty_text',
            lemma_text: '',
            tokens: []
        };
    }

    const normalized = morphology.materials.get(source.url);
    if (!normalized) throw new Error(`Missing morphology result for source: ${source.url}`);
    return {
        url: source.url,
        content_sha256: source.content_sha256 || null,
        source_text_sha256: sourceTextSha256,
        status: 'normalized',
        error: null,
        lemma_text: normalized.lemma_text || '',
        tokens: normalized.tokens || []
    };
}

export function buildNormalizationArtifact({sources = [], keywordGroups = {}, morphology, runId = null, institutionId = null, lp = null} = {}) {
    if (!morphology?.available) throw new Error('Cannot build a normalization artifact without available Morfeusz morphology.');

    const normalizedSources = sources.map(source => normalizedSourceRecord(source, morphology));
    const keywords = Object.fromEntries(Object.entries(keywordGroups).map(([category, terms]) => [
        category,
        terms.map((keyword, index) => {
            const normalized = morphology.keywords.get(`${category}:${index}`);
            if (!normalized) throw new Error(`Missing morphology result for keyword: ${category}[${index}]`);
            return {
                keyword,
                lemma_text: normalized.lemma_text || '',
                tokens: normalized.tokens || []
            };
        })
    ]));

    const unreadableSources = normalizedSources.filter(source => source.status !== 'normalized').length;
    return {
        schema_version: NORMALIZATION_SCHEMA_VERSION,
        run_id: runId,
        institution_id: institutionId,
        lp: lp == null ? null : Number(lp),
        engine: 'morfeusz2',
        status: 'complete',
        generated_at: new Date().toISOString(),
        source_count: normalizedSources.length,
        normalized_source_count: normalizedSources.length - unreadableSources,
        unreadable_source_count: unreadableSources,
        sources: normalizedSources,
        keywords
    };
}

export async function writeNormalizationArtifact(filePath, artifact) {
    await writeJsonAtomic(filePath, artifact);
    return filePath;
}

export async function readNormalizationArtifact(filePath, {runId = null} = {}) {
    const artifact = await readJson(filePath);
    const errors = validateNormalizationArtifact(artifact, {runId});
    if (errors.length) throw new Error(`Invalid normalization artifact: ${errors.join('; ')}`);
    return artifact;
}

export function validateNormalizationArtifact(artifact, {runId = null} = {}) {
    const errors = [];
    if (!artifact || typeof artifact !== 'object') return ['artifact must be an object'];
    if (artifact.schema_version !== NORMALIZATION_SCHEMA_VERSION) errors.push(`unsupported schema_version: ${artifact.schema_version}`);
    if (artifact.engine !== 'morfeusz2') errors.push(`unsupported engine: ${artifact.engine}`);
    if (artifact.status !== 'complete') errors.push(`artifact is not complete: ${artifact.status || 'missing'}`);
    if (runId && artifact.run_id !== runId) errors.push(`run_id mismatch: ${artifact.run_id || 'missing'}`);
    if (!Array.isArray(artifact.sources)) errors.push('sources must be an array');
    if (!artifact.keywords || typeof artifact.keywords !== 'object') errors.push('keywords must be an object');

    const urls = new Set();
    for (const source of artifact.sources || []) {
        if (!source.url) errors.push('source url is required');
        if (source.url && urls.has(source.url)) errors.push(`duplicate source url: ${source.url}`);
        if (source.url) urls.add(source.url);
        if (!['normalized', 'unreadable'].includes(source.status)) errors.push(`invalid source status: ${source.status || 'missing'}`);
        if (source.status === 'normalized' && !Array.isArray(source.tokens)) errors.push(`tokens missing for source: ${source.url}`);
    }
    for (const [category, terms] of Object.entries(artifact.keywords || {})) {
        if (!Array.isArray(terms)) errors.push(`keyword category must be an array: ${category}`);
        for (const term of terms || []) if (!Array.isArray(term.tokens)) errors.push(`keyword tokens missing: ${category}/${term.keyword || 'unknown'}`);
    }
    return errors;
}

export function findNormalizedSpans(text, source, keyword, {context = 550, maxMatches = 3} = {}) {
    if (!text || source?.status !== 'normalized' || !keyword?.tokens?.length || !source.tokens?.length) return [];
    const keywordTokens = keyword.tokens.map(token => token.lemma).filter(Boolean);
    if (!keywordTokens.length) return [];
    const spans = [];
    for (let index = 0; index <= source.tokens.length - keywordTokens.length && spans.length < maxMatches; index += 1) {
        const matches = keywordTokens.every((lemma, offset) => source.tokens[index + offset]?.lemma === lemma);
        if (!matches) continue;
        const start = source.tokens[index].start;
        const end = source.tokens[index + keywordTokens.length - 1].end;
        const from = Math.max(0, start - context);
        const to = Math.min(text.length, end + context);
        spans.push({source_start: start, text_excerpt: text.slice(from, to)});
    }
    return spans;
}
