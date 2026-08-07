import fs from "node:fs";
import path from "node:path";

import {canonicalJson, sha256Hex} from "./canonical-json.mjs";
import {
    validateEvidenceRecord,
    validateSourceArtifact
} from "./run-contract-validate.mjs";
import {
    ResearchError,
    atomicWriteJson,
    isPlainObject,
    readEvidenceJsonl,
    readJson
} from "./research-runtime.mjs";

/**
 * The interpreter boundary is deliberately smaller than the research
 * boundary.  It receives validated evidence and deterministic metadata only;
 * raw source bytes never cross this boundary.
 */
export const REVIEW_CONTEXT_VERSION = "1.0.0";

/**
 * Read and validate the closed evidence set for one exact-scope entry.
 *
 * @param {{run: object, entryId: string, evidenceRecords?: Array<object>, fixtureEntry?: object}} options
 * @returns {object}
 */
export function readReviewContext(options) {
    const evidenceRecords = options.evidenceRecords ?? readEvidenceJsonl(options.run.context.evidence_path);
    const sourceArtifacts = options.sourceArtifacts ?? loadSourceArtifacts(options.run, options.entryId);
    return buildReviewContext({...options, evidenceRecords, sourceArtifacts});
}

/**
 * Build the immutable, canonical input passed to the deterministic
 * interpreter.  A missing evidence set is a valid closed set and is handled
 * as an unconfirmed business result; an invalid non-empty set is a technical
 * evidence mismatch and must stop before interpretation.
 */
export function buildReviewContext({run, entryId, evidenceRecords = [], sourceArtifacts = [], fixtureEntry = undefined}) {
    const scopeEntry = run?.manifest?.scope?.entries?.find((entry) => entry.entry_id === entryId);
    if (!scopeEntry) {
        throw new ResearchError("entry_out_of_scope", `${entryId} is not part of the exact run scope`, {exitCode: 10});
    }
    if (!Array.isArray(evidenceRecords)) {
        throw new ResearchError("evidence_mismatch", "review context evidence must be an array", {exitCode: 20});
    }

    const records = evidenceRecords.filter((record) => record?.entry_id === entryId);
    const foreignRecords = evidenceRecords.filter((record) => record?.entry_id !== entryId);
    if (foreignRecords.length > 0) {
        throw evidenceMismatch("evidence set contains a record outside the targeted entry", {
            entry_ids: [...new Set(foreignRecords.map((record) => record?.entry_id ?? null))]
        });
    }

    const artifacts = indexSourceArtifacts(sourceArtifacts);
    const seen = new Map();
    for (const record of records) {
        if (!isPlainObject(record)) {
            throw evidenceMismatch("evidence record must be an object");
        }
        const previous = seen.get(record.evidence_id);
        if (previous && canonicalJson(previous) !== canonicalJson(record)) {
            throw evidenceMismatch(`evidence_id ${record.evidence_id} has conflicting records`);
        }
        seen.set(record.evidence_id, record);
        const artifact = artifacts.get(record.source_artifact_id);
        if (!artifact) {
            throw evidenceMismatch(`evidence ${record.evidence_id} references an unknown source artifact`);
        }
        const artifactValidation = validateSourceArtifact(artifact, {
            manifest: run.manifest,
            context: run.context
        });
        if (!artifactValidation.valid) {
            throw evidenceMismatch(`source artifact ${artifact.artifact_id} failed validation`, {
                errors: artifactValidation.errors
            });
        }
        const validation = validateEvidenceRecord(record, {
            manifest: run.manifest,
            sourceArtifact: artifact
        });
        if (!validation.valid) {
            throw evidenceMismatch(`evidence ${record.evidence_id} failed validation`, {
                errors: validation.errors
            });
        }
        assertRawContentIntegrity(run, artifact);
    }

    const sortedRecords = [...records].sort(compareEvidence);
    const metadata = normalizeFixtureMetadata(fixtureEntry, sortedRecords, scopeEntry, run.manifest.created_at);
    const sourceArtifactIds = [...new Set(sortedRecords.map((record) => record.source_artifact_id))].sort();
    const contextInput = {
        run_id: run.manifest.run_id,
        entry_id: scopeEntry.entry_id,
        institution_id: scopeEntry.institution_id,
        evidence: sortedRecords,
        metadata
    };

    return {
        schema_version: REVIEW_CONTEXT_VERSION,
        run_id: run.manifest.run_id,
        entry_id: scopeEntry.entry_id,
        lp: scopeEntry.lp,
        institution_id: scopeEntry.institution_id,
        institution_type: scopeEntry.institution_type,
        observed_at: metadata.observation_date,
        evidence: sortedRecords,
        source_artifact_ids: sourceArtifactIds,
        metadata,
        input_fingerprint: sha256Hex(canonicalJson(contextInput))
    };
}

/**
 * Persist a context as a run-local diagnostic artifact.  This helper is not a
 * publication path and intentionally contains no raw source content.
 */
export function writeReviewContext(run, context) {
    const filePath = path.join(run.runRoot, "artifacts", "review-context", `${context.entry_id}.json`);
    atomicWriteJson(filePath, context);
    return filePath;
}

export function compareEvidence(left, right) {
    return [
        left.institution_id,
        left.product_id,
        left.variant_id,
        left.field_path,
        left.url,
        left.evidence_id
    ].map(String).join("\u0000").localeCompare(
        [
            right.institution_id,
            right.product_id,
            right.variant_id,
            right.field_path,
            right.url,
            right.evidence_id
        ].map(String).join("\u0000")
    );
}

export function loadSourceArtifacts(run, entryId) {
    const summaryPath = path.join(run.runRoot, "artifacts", "fetch", `${entryId}.json`);
    if (!fs.existsSync(summaryPath)) {
        return [];
    }
    const summary = readJson(summaryPath, `fetch summary for ${entryId}`);
    if (!Array.isArray(summary.source_artifacts)) {
        throw evidenceMismatch(`fetch summary for ${entryId} has no source_artifacts array`);
    }
    return summary.source_artifacts;
}

function indexSourceArtifacts(sourceArtifacts) {
    if (!Array.isArray(sourceArtifacts)) {
        throw evidenceMismatch("source artifacts must be an array");
    }
    const indexed = new Map();
    for (const artifact of sourceArtifacts) {
        if (!isPlainObject(artifact) || typeof artifact.artifact_id !== "string") {
            throw evidenceMismatch("source artifact must contain an artifact_id");
        }
        const previous = indexed.get(artifact.artifact_id);
        if (previous && canonicalJson(previous) !== canonicalJson(artifact)) {
            throw evidenceMismatch(`source artifact ${artifact.artifact_id} has conflicting records`);
        }
        indexed.set(artifact.artifact_id, artifact);
    }
    return indexed;
}

function assertRawContentIntegrity(run, artifact) {
    const filePath = path.resolve(run.cwd, artifact.run_local_path);
    if (!fs.existsSync(filePath)) {
        throw evidenceMismatch(`source artifact bytes are missing for ${artifact.artifact_id}`);
    }
    let content;
    try {
        content = fs.readFileSync(filePath);
    } catch (error) {
        throw evidenceMismatch(`source artifact bytes cannot be read for ${artifact.artifact_id}`, {cause: error});
    }
    if (content.length !== artifact.raw_content_bytes || sha256Hex(content) !== artifact.raw_content_sha256) {
        throw evidenceMismatch(`source artifact bytes changed for ${artifact.artifact_id}`);
    }
}

function normalizeFixtureMetadata(fixtureEntry, records, scopeEntry, observationDate) {
    if (fixtureEntry?.institution_id !== undefined && fixtureEntry.institution_id !== scopeEntry.institution_id) {
        throw new ResearchError("schema_mismatch", `interpretation fixture entry ${fixtureEntry.entry_id} does not match the immutable scope`, {exitCode: 10});
    }
    const raw = isPlainObject(fixtureEntry) ? fixtureEntry.interpretation ?? fixtureEntry : {};
    const rawProducts = raw.products ?? raw.bundles ?? [];
    if (rawProducts !== undefined && !Array.isArray(rawProducts)) {
        throw new ResearchError("schema_mismatch", "interpretation fixture products must be an array", {exitCode: 10});
    }
    const products = rawProducts
        .filter((product) => isPlainObject(product))
        .map((product) => normalizeProductMetadata(product, observationDate))
        .sort((left, right) => `${left.product_id}:${left.variant_id}`.localeCompare(`${right.product_id}:${right.variant_id}`));
    const validKeys = new Set(records.map((record) => `${record.product_id}:${record.variant_id}`));
    const filteredProducts = products.filter((product) => validKeys.has(`${product.product_id}:${product.variant_id}`));
    return {
        observation_date: raw.observation_date ?? fixtureEntry?.observed_at ?? observationDate,
        products: filteredProducts,
        customer_profile: raw.customer_profile ?? "consumer_standard"
    };
}

function normalizeProductMetadata(product, observationDate) {
    const productId = product.product_id;
    const variantId = product.variant_id;
    if (typeof productId !== "string" || typeof variantId !== "string") {
        throw new ResearchError("schema_mismatch", "interpretation product metadata requires product_id and variant_id", {exitCode: 10});
    }
    const comparisonContext = product.comparison_context ?? {};
    return {
        product_id: productId,
        variant_id: variantId,
        product_name: product.product_name ?? null,
        audience: product.audience ?? "consumer_standard",
        rate_type: product.rate_type ?? null,
        comparison_context: {
            currency: comparisonContext.currency ?? "PLN",
            representative_amount: comparisonContext.representative_amount ?? null,
            term_years: comparisonContext.term_years ?? null,
            customer_profile: comparisonContext.customer_profile ?? "consumer_standard",
            observation_date: comparisonContext.observation_date ?? product.observation_date ?? observationDate
        },
        offer: isPlainObject(product.offer) ? {...product.offer} : {},
        exclusions: Array.isArray(product.exclusions) ? [...product.exclusions] : [],
        promotion: product.promotion ?? null
    };
}

function evidenceMismatch(message, details = undefined) {
    return new ResearchError("evidence_mismatch", message, {exitCode: 20, details});
}
