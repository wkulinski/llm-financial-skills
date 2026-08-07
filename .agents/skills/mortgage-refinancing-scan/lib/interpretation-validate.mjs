import {canonicalJson} from "./canonical-json.mjs";
import {
    validateInterpretationResult,
    validateProductBundle
} from "./run-contract-validate.mjs";

const QUALIFICATION_FIELDS = Object.freeze([
    "qualification.housing",
    "qualification.refinancing",
    "qualification.fixed_rate"
]);

/**
 * Validate the small internal context before it reaches the interpreter.
 * Schema validation of the public result remains delegated to the canonical
 * Phase 1 validator.
 */
export function validateReviewContext(context) {
    const errors = [];
    if (!context || typeof context !== "object" || Array.isArray(context)) {
        return {valid: false, errors: [{code: "review_context_invalid", message: "ReviewContext must be an object"}]};
    }
    for (const field of ["run_id", "entry_id", "institution_id", "input_fingerprint"]) {
        if (typeof context[field] !== "string" || context[field].length === 0) {
            errors.push({code: "review_context_field_missing", message: `${field} is required`});
        }
    }
    if (!Array.isArray(context.evidence)) {
        errors.push({code: "review_context_evidence_invalid", message: "evidence must be an array"});
    }
    if (!Array.isArray(context.source_artifact_ids)) {
        errors.push({code: "review_context_sources_invalid", message: "source_artifact_ids must be an array"});
    }
    const evidenceIds = new Set();
    for (const record of context.evidence ?? []) {
        if (evidenceIds.has(record.evidence_id)) {
            errors.push({code: "review_context_duplicate_evidence", message: `duplicate evidence ${record.evidence_id}`});
        }
        evidenceIds.add(record.evidence_id);
        if (record.run_id !== context.run_id || record.entry_id !== context.entry_id || record.institution_id !== context.institution_id) {
            errors.push({code: "review_context_scope_mismatch", message: `evidence ${record.evidence_id} is outside the context scope`});
        }
    }
    return {valid: errors.length === 0, errors};
}

/**
 * Check that all result evidence references point into the current validated
 * set and, when a bundle is present, to that exact product/variant.
 */
export function validateInterpretationOutput(result, {manifest, evidenceRecords = [], bundles = []} = {}) {
    const errors = [];
    const publicValidation = validateInterpretationResult(result, {manifest, evidenceRecords});
    errors.push(...publicValidation.errors);
    const recordsById = new Map(evidenceRecords.map((record) => [record.evidence_id, record]));
    const bundleByKey = new Map(bundles.map((bundle) => [`${bundle.product_id}:${bundle.variant_id}`, bundle]));

    if (result?.product_bundle && bundles.length > 0) {
        const key = `${result.product_bundle.product_id}:${result.product_bundle.variant_id}`;
        const bundle = bundleByKey.get(key);
        if (!bundle) {
            errors.push({code: "interpretation_bundle_not_in_context", message: `result bundle ${key} is not in ReviewContext`});
        } else if (canonicalJson(bundle.source_artifact_ids) !== canonicalJson(result.product_bundle.source_artifact_ids)) {
            errors.push({code: "interpretation_bundle_source_mismatch", message: `result bundle ${key} has different source artifacts`});
        }
    }

    for (const [fieldPath, references] of Object.entries(result?.field_evidence ?? {})) {
        for (const evidenceId of references) {
            const record = recordsById.get(evidenceId);
            if (!record) {
                errors.push({code: "interpretation_evidence_reference_missing", message: `evidence ${evidenceId} is not in ReviewContext`});
                continue;
            }
            if (record.field_path !== fieldPath) {
                errors.push({code: "interpretation_evidence_field_mismatch", message: `evidence ${evidenceId} is not evidence for ${fieldPath}`});
            }
        }
    }

    if (result?.decision_status === "qualified") {
        for (const fieldPath of QUALIFICATION_FIELDS) {
            if (result.criterion_status?.[fieldPath.slice("qualification.".length)] !== "found") {
                errors.push({code: "interpretation_qualified_criterion_missing", message: `qualified result does not mark ${fieldPath} found`});
            }
        }
    }
    return {valid: errors.length === 0, errors};
}

export function assertValidInterpretationOutput(result, options = {}) {
    const validation = validateInterpretationOutput(result, options);
    if (!validation.valid) {
        const error = new Error(`interpretation output validation failed: ${validation.errors.map((item) => item.message).join("; ")}`);
        error.code = "schema_mismatch";
        error.exitCode = 10;
        error.details = {errors: validation.errors};
        throw error;
    }
    return result;
}

export function qualifiedEvidenceFields() {
    return [...QUALIFICATION_FIELDS];
}

export function sameBundleEvidence(records) {
    const keys = new Set(records.map((record) => `${record.product_id}:${record.variant_id}`));
    return keys.size === 1;
}

/** Strict semantic ProductBundle validation used before result construction. */
export function validateBundles(bundles, manifest) {
    const errors = [];
    for (const bundle of bundles) {
        const validation = validateProductBundle(bundle, {manifest});
        errors.push(...validation.errors);
    }
    return {valid: errors.length === 0, errors};
}
