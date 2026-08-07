import fs from "node:fs";
import path from "node:path";

import {computeEvidenceId, sha256Hex} from "./canonical-json.mjs";
import {validateEvidenceRecord} from "./run-contract-validate.mjs";
import {
    artifactId,
    canonicalizeUrl,
    normalizedExcerptFromTokens,
    productId,
    replaceEvidenceForEntry,
    readJson,
    ResearchError,
    variantId,
    makeTelemetryOperation
} from "./research-runtime.mjs";
import {validateNormalizationArtifact} from "./normalization.mjs";

/**
 * Turn only explicitly supplied, source-bound fixture matches into evidence.
 * No keyword-only evidence is invented here; the later interpreter receives
 * exactly the records that passed these checks.
 */
export function buildEvidenceForEntry({run, fixtureEntry, fetchSummary, normalizationSummary, observationTime}) {
    const startedAt = Date.now();
    const sourceByUrl = new Map();
    for (const sourceArtifact of fetchSummary.source_artifacts) {
        sourceByUrl.set(sourceArtifact.canonical_url, sourceArtifact);
    }
    const normalizationBySource = new Map();
    for (const normalization of normalizationSummary.artifacts) {
        const normalizationPath = path.resolve(run.cwd, normalization.run_local_path);
        const artifact = readJson(normalizationPath, "normalization artifact");
        validateNormalizationArtifact(artifact, {
            runId: run.manifest.run_id,
            entryId: fixtureEntry.entry_id,
            sourceArtifactId: normalization.source_artifact_id
        });
        normalizationBySource.set(normalization.source_artifact_id, artifact);
    }

    const records = [];
    const failures = [];
    for (const match of fixtureEntry.evidence ?? []) {
        try {
            const record = buildEvidenceRecord({
                run,
                fixtureEntry,
                match,
                sourceByUrl,
                normalizationBySource,
                observationTime
            });
            const validation = validateEvidenceRecord(record, {
                manifest: run.manifest,
                sourceArtifact: sourceByUrl.get(record.url)
            });
            if (!validation.valid) {
                throw new ResearchError("evidence_mismatch", `evidence ${record.evidence_id} failed validation`, {exitCode: 20, details: {errors: validation.errors}});
            }
            records.push(record);
        } catch (error) {
            const normalized = error instanceof ResearchError
                ? error
                : new ResearchError("evidence_mismatch", String(error), {exitCode: 20, cause: error});
            failures.push({code: normalized.code, message: normalized.message, field_path: match?.field_path ?? null});
        }
    }
    // A mismatch stops the entry before interpretation; do not leave a
    // partial set of records that could be mistaken for a complete bundle.
    const acceptedRecords = failures.length === 0 ? records : [];
    replaceEvidenceForEntry(run.context.evidence_path, fixtureEntry.entry_id, acceptedRecords);
    const sortedFailures = failures.sort((left, right) => String(left.field_path).localeCompare(String(right.field_path)) || left.message.localeCompare(right.message));
    // The explicit hash below avoids using process/time data in the artifact id.
    const summaryArtifactId = artifactId("evs", {
        entry_id: fixtureEntry.entry_id,
        institution_id: fixtureEntry.institution_id,
        evidence_ids: acceptedRecords.map((record) => record.evidence_id).sort(),
        failures: sortedFailures
    });
    const summary = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        entry_id: fixtureEntry.entry_id,
        institution_id: fixtureEntry.institution_id,
        observed_at: observationTime,
        artifact_id: summaryArtifactId,
        evidence_ids: acceptedRecords.map((record) => record.evidence_id).sort(),
        failures: sortedFailures,
        stats: {
            evidence_count: acceptedRecords.length,
            failure_count: failures.length,
            elapsed_ms: Math.max(0, Date.now() - startedAt)
        }
    };
    return {
        summary,
        artifactId: summaryArtifactId,
        records,
        failures,
        metrics: makeTelemetryOperation({
            operationId: `evidence:${run.manifest.run_id}:${fixtureEntry.entry_id}`,
            stage: "evidence_ready",
            entry: fixtureEntry,
            durationMs: summary.stats.elapsed_ms,
            bytes: {downloaded: 0, reused_from_cache: 0},
            errorCount: failures.length,
            technicalErrorCount: failures.length > 0 ? 1 : 0,
            errorCode: failures[0]?.code ?? null
        })
    };
}

/**
 * Build a conservative live evidence set from normalized source text. The
 * matcher only emits exact excerpts found in the current artifact; it never
 * infers a positive decision from a URL or from a missing category.
 */
export function buildEvidenceForLiveEntry({run, entry, fetchSummary, normalizationSummary, observationTime}) {
    const matches = [];
    for (const normalization of normalizationSummary.artifacts ?? []) {
        const normalizationPath = path.resolve(run.cwd, normalization.run_local_path);
        const artifact = readJson(normalizationPath, "normalization artifact");
        const source = fetchSummary.source_artifacts.find((candidate) => candidate.artifact_id === normalization.source_artifact_id);
        if (!source) continue;
        const text = artifact.extracted_text;
        if (typeof text !== "string") {
            throw new ResearchError("evidence_mismatch", `normalization artifact ${normalization.source_artifact_id} has no extracted text`, {exitCode: 20});
        }
        const productName = `Oferta ${new URL(source.canonical_url).pathname.replaceAll("/", " ").trim() || "mieszkaniowa"}`.trim();
        const rateType = /stał[\p{L}\p{M}]*\s+(?:przez\s+cały\s+okres|cały\s+okres)|bezterminow[\p{L}\p{M}]*/iu.test(text)
            ? "permanent_fixed"
            : "periodically_fixed";
        const detected = [];
        for (const [fieldPath, pattern] of LIVE_EVIDENCE_PATTERNS) {
            const match = pattern.exec(text);
            if (!match) continue;
            // Long official pages repeat global navigation before the product
            // body. Never treat those early menu labels as live evidence;
            // conservative omission is safer than a false qualification.
            if (text.length > 1000 && match.index < 1000) continue;
            detected.push({fieldPath, excerpt: match[0], index: match.index});
        }
        const positions = detected.map((match) => match.index);
        const sectionStart = positions.length > 0 ? Math.min(...positions) : 0;
        const sectionEnd = positions.length > 0 ? Math.max(...positions) : 0;
        const sharedText = text.slice(sectionStart, sectionEnd);
        const sameSection = detected.length === 3
            && sectionEnd - sectionStart <= 160
            && !/[.!?;|•—–:()]/u.test(sharedText);
        for (const detectedMatch of detected) {
            // Keep one canonical source page as one provisional product bundle
            // even when its criteria are in separate sections. Splitting by
            // field_path manufactured different products from one official
            // page and made the adaptive selector over-conservative. The
            // interpreter still remains conservative when explicit product or
            // variant identities disagree across source pages.
            const scopedProductName = productName;
            const product = productId({
                institution_id: entry.institution_id,
                canonical_product_url: source.canonical_url,
                product_name: scopedProductName,
                audience: "consumer"
            });
            const variant = variantId({
                product_id: product,
                rate_type: rateType,
                fixed_rate_period: null,
                currency: "PLN",
                comparison_context: sameSection ? "live" : "live:source-page"
            });
            matches.push({
                field_path: detectedMatch.fieldPath,
                url: source.canonical_url,
                product_id: product,
                variant_id: variant,
                product_name: scopedProductName,
                audience: "consumer",
                rate_type: rateType,
                excerpt: detectedMatch.excerpt
            });
        }
    }
    return buildEvidenceForEntry({
        run,
        fixtureEntry: {...entry, evidence: matches},
        fetchSummary,
        normalizationSummary,
        observationTime
    });
}

export function buildEvidenceRecord({run, fixtureEntry, match, sourceByUrl, normalizationBySource, observationTime}) {
    if (!match || typeof match !== "object") {
        throw new ResearchError("evidence_mismatch", "evidence match must be an object", {exitCode: 20});
    }
    const fieldPath = match.field_path;
    if (!/^(qualification\.(housing|refinancing|fixed_rate)|offer\.[a-z0-9_]+)$/.test(fieldPath ?? "")) {
        throw new ResearchError("evidence_mismatch", `invalid evidence field_path ${fieldPath}`, {exitCode: 20});
    }
    const url = canonicalizeUrl(match.url ?? match.source_url ?? "");
    const sourceArtifact = sourceByUrl.get(url);
    if (!sourceArtifact) {
        throw new ResearchError("evidence_mismatch", `no fetched source artifact for ${url}`, {exitCode: 20});
    }
    const normalization = normalizationBySource.get(sourceArtifact.artifact_id);
    if (!normalization) {
        throw new ResearchError("evidence_mismatch", `no normalization artifact for ${sourceArtifact.artifact_id}`, {exitCode: 20});
    }
    const sourcePath = path.resolve(run.cwd, sourceArtifact.run_local_path);
    const raw = fs.readFileSync(sourcePath);
    if (raw.length !== sourceArtifact.raw_content_bytes || sha256Hex(raw) !== sourceArtifact.raw_content_sha256) {
        throw new ResearchError("evidence_mismatch", `source content hash mismatch for ${sourceArtifact.artifact_id}`, {exitCode: 20});
    }
    const text = normalization.extracted_text;
    const excerpt = match.excerpt;
    if (typeof excerpt !== "string" || excerpt.length === 0) {
        throw new ResearchError("evidence_mismatch", "evidence excerpt must be non-empty", {exitCode: 20});
    }
    const normalized = normalizedExcerptFromTokens(normalization.tokens, excerpt, text);
    const product = match.product_id ?? productId({
        institution_id: fixtureEntry.institution_id,
        canonical_product_url: url,
        product_name: match.product_name ?? "fixture product",
        audience: match.audience ?? "consumer"
    });
    const variant = match.variant_id ?? variantId({
        product_id: product,
        rate_type: match.rate_type ?? "periodically_fixed",
        fixed_rate_period: match.fixed_rate_period ?? null,
        currency: match.currency ?? "PLN",
        comparison_context: match.comparison_context ?? "fixture"
    });
    const recordWithoutId = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        entry_id: fixtureEntry.entry_id,
        institution_id: fixtureEntry.institution_id,
        product_id: product,
        variant_id: variant,
        field_path: fieldPath,
        source_artifact_id: sourceArtifact.artifact_id,
        url,
        content_sha256: sourceArtifact.raw_content_sha256,
        excerpt,
        normalized_excerpt: normalized.normalizedExcerpt,
        source_type: sourceArtifact.source_type,
        source_locator: normalized.locator,
        normalization_version: normalization.normalization_version
    };
    return {...recordWithoutId, evidence_id: computeEvidenceId(recordWithoutId)};
}

const LIVE_EVIDENCE_PATTERNS = Object.freeze([
    ["qualification.housing", /\b(?:kredyt[\p{L}\p{M}]*\s+(?:mieszkaniow[\p{L}\p{M}]*|hipoteczn[\p{L}\p{M}]*)|(?:mieszkaniow[\p{L}\p{M}]*|hipoteczn[\p{L}\p{M}]*)\s+kredyt[\p{L}\p{M}]*)/iu],
    ["qualification.refinancing", /\b(?:spłat[\p{L}\p{M}]*\s+(?:wcześniejsz[\p{L}\p{M}]*\s+)?kredyt[\p{L}\p{M}]*|refinans[\p{L}\p{M}]*\s+(?:istniej[\p{L}\p{M}]*\s+)?kredyt[\p{L}\p{M}]*|kredyt[\p{L}\p{M}]*\s+(?:zaciągnięt[\p{L}\p{M}]*|istniej[\p{L}\p{M}]*)\s+(?:w\s+)?(?:inn[\p{L}\p{M}]*\s+)?bank[\p{L}\p{M}]*)/iu],
    ["qualification.fixed_rate", /\b(?:oprocentowan[\p{L}\p{M}]*\s+(?:okresowo\s+)?stał[\p{L}\p{M}]*|stał[\p{L}\p{M}]*\s+(?:oprocentowan[\p{L}\p{M}]*|stop[\p{L}\p{M}]*))/iu]
]);
