import {selectBestOffer} from "./offer-select.mjs";
import {
    assertValidInterpretationOutput,
    validateReviewContext,
    validateBundles
} from "./interpretation-validate.mjs";
import {ResearchError} from "./research-runtime.mjs";

export const INTERPRETER_VERSION = "deterministic:1.0.0";

const CRITERIA = Object.freeze(["housing", "refinancing", "fixed_rate"]);
const QUALIFICATION_REASON_CODES = Object.freeze({
    housing: "housing_or_mortgage_loan_confirmed",
    refinancing: "refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed",
    fixed_rate: "fixed_rate_confirmed"
});
const OFFER_FIELDS = Object.freeze([
    "fixed_rate_type",
    "fixed_nominal_rate",
    "rrso",
    "commission",
    "fixed_rate_period_years",
    "max_loan_term_years"
]);

/**
 * Group validated evidence with Map indexes.  The key is intentionally the
 * product and variant identity already carried by evidence; no keyword-only
 * or cross-product matching is performed.
 */
export function buildProductBundles(context, {manifest = undefined} = {}) {
    const contextValidation = validateReviewContext(context);
    if (!contextValidation.valid) {
        throw interpretationSchemaError("ReviewContext failed validation", contextValidation.errors);
    }
    const metadataByKey = new Map((context.metadata?.products ?? [])
        .map((product) => [`${product.product_id}:${product.variant_id}`, product]));
    const groups = new Map();
    for (const record of context.evidence) {
        const key = `${record.product_id}:${record.variant_id}`;
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
    }

    const bundles = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, records]) => {
        const orderedRecords = [...records].sort(compareRecord);
        const [productId, variantId] = key.split(":");
        const metadata = metadataByKey.get(key) ?? {};
        const fieldEvidence = groupFieldEvidence(orderedRecords);
        const negative = classifyNegativeEvidence(orderedRecords, metadata);
        const criterionStatus = buildCriterionStatus(orderedRecords, negative);
        const fixedEvidence = orderedRecords.filter((record) => record.field_path === "qualification.fixed_rate");
        const inferredRateType = fixedEvidence.length > 0 ? inferRateType(fixedEvidence) : null;
        if (metadata.rate_type && inferredRateType && metadata.rate_type !== inferredRateType) {
            throw new ResearchError("schema_mismatch", `rate_type metadata conflicts with fixed-rate evidence for ${key}`, {exitCode: 10});
        }
        const rateType = metadata.rate_type ?? inferredRateType ?? "periodically_fixed";
        const bundle = {
            schema_version: "1.0.0",
            institution_id: context.institution_id,
            product_id: productId,
            variant_id: variantId,
            product_name: metadata.product_name || inferProductName(records, productId),
            canonical_product_url: metadata.canonical_product_url ?? orderedRecords[0].url,
            audience: metadata.audience ?? "consumer_standard",
            source_artifact_ids: [...new Set(records.map((record) => record.source_artifact_id))].sort(),
            rate_type: rateType,
            criterion_status: criterionStatus,
            field_evidence: fieldEvidence
        };
        const offer = buildOffer({context, records: orderedRecords, metadata, criterionStatus});
        return attachInternalBundleData(bundle, {
            offer,
            records: orderedRecords,
            negative_reason_codes: negative.reason_codes,
            explicit_negative_criteria: negative.criteria,
            promotion: metadata.promotion ?? null,
            warnings: negative.ambiguous ? ["conflicting positive and exclusion evidence"] : []
        });
    });
    const validation = validateBundles(bundles.map(toPublicBundle), manifest ?? {
        scope: {entries: [{institution_id: context.institution_id}]}
    });
    if (!validation.valid) {
        throw interpretationSchemaError("ProductBundle validation failed", validation.errors);
    }
    return bundles;
}

/** Interpret one canonical ReviewContext into a strict business result. */
export function interpretReviewContext(context, {manifest = undefined} = {}) {
    const contextValidation = validateReviewContext(context);
    if (!contextValidation.valid) {
        throw interpretationSchemaError("ReviewContext failed validation", contextValidation.errors);
    }
    const bundles = buildProductBundles(context, {manifest});
    const qualified = bundles.filter((bundle) => isQualifiedBundle(bundle));
    if (qualified.length > 0) {
        const selection = selectBestOffer(qualified.map((bundle) => ({
            bundle,
            offer: bundle.offer,
            promotion: bundle.promotion
        })));
        if (selection.status === "selected") {
            const result = buildBusinessResult(context, selection.candidate.bundle, "qualified", Object.values(QUALIFICATION_REASON_CODES));
            return finalizeResult(result, {manifest, evidenceRecords: context.evidence, bundles});
        }
        const result = buildUnconfirmedResult(context, {
            criterion_status: ambiguousCriteria(qualified),
            warning: `offer selection unresolved: ${selection.reason}`
        });
        return finalizeResult(result, {manifest, evidenceRecords: context.evidence, bundles});
    }

    const explicitNegatives = bundles
        .filter((bundle) => isExplicitNegativeBundle(bundle))
        .sort(compareBundle);
    if (explicitNegatives.length > 0) {
        const bundle = explicitNegatives[0];
        const result = buildBusinessResult(context, bundle, "explicitly_not_qualified", bundle.negative_reason_codes);
        return finalizeResult(result, {manifest, evidenceRecords: context.evidence, bundles});
    }

    const partial = bundles.length === 1 ? bundles[0] : null;
    const result = partial
        ? buildBusinessResult(context, partial, "unconfirmed", ["ambiguous_sources"])
        : buildUnconfirmedResult(context, {
            criterion_status: context.evidence.length === 0 ? notFoundCriteria() : ambiguousCriteria(bundles),
            warning: bundles.length > 1 ? "criteria were found on different product bundles" : "evidence is insufficient for a deterministic decision"
        });
    return finalizeResult(result, {manifest, evidenceRecords: context.evidence, bundles});
}

export const interpretEntry = interpretReviewContext;

export function buildInterpretationResult(context, options = {}) {
    return interpretReviewContext(context, options);
}

/** Build the deterministic empty-evidence result before interpreter dispatch. */
export function createUnconfirmedResult(context, warning = "evidence set is empty") {
    return buildUnconfirmedResult(context, {
        criterion_status: notFoundCriteria(),
        warning
    });
}

export function createTechnicalErrorResult({runId, entryId, institutionId, errorCode, errorMessage}) {
    return {
        schema_version: "1.0.0",
        run_id: runId,
        entry_id: entryId,
        institution_id: institutionId,
        decision_status: "technical_error",
        export_ready: false,
        data_status: "incomplete",
        export_blockers: ["internal_error"],
        error_code: errorCode,
        error_message: String(errorMessage).slice(0, 2048),
        retryable: false,
        warnings: [],
        interpreter_version: INTERPRETER_VERSION
    };
}

function buildBusinessResult(context, bundle, decisionStatus, reasonCodes) {
    const resultBundle = {
        product_id: bundle.product_id,
        variant_id: bundle.variant_id,
        product_name: bundle.product_name,
        canonical_product_url: bundle.canonical_product_url,
        source_artifact_ids: bundle.source_artifact_ids
    };
    const offer = bundle.offer;
    const fieldStatus = buildFieldStatus(bundle);
    const fieldEvidence = cloneFieldEvidence(bundle.field_evidence);
    const exportAssessment = assessExportReadiness(offer, decisionStatus);
    return {
        schema_version: "1.0.0",
        run_id: context.run_id,
        entry_id: context.entry_id,
        institution_id: context.institution_id,
        decision_status: decisionStatus,
        export_ready: exportAssessment.export_ready,
        data_status: exportAssessment.data_status,
        export_blockers: exportAssessment.export_blockers,
        product_bundle: resultBundle,
        criterion_status: bundle.criterion_status,
        qualification: {reason_codes: uniqueReasonCodes(reasonCodes)},
        offer,
        field_status: fieldStatus,
        field_evidence: fieldEvidence,
        warnings: [...new Set(bundle.warnings ?? [])].sort(),
        interpreter_version: INTERPRETER_VERSION
    };
}

function toPublicBundle(bundle) {
    const {
        offer,
        records,
        negative_reason_codes,
        explicit_negative_criteria,
        promotion,
        warnings,
        ...publicBundle
    } = bundle;
    return publicBundle;
}

function attachInternalBundleData(bundle, data) {
    return Object.defineProperties({...bundle}, Object.fromEntries(Object.entries(data).map(([key, value]) => [key, {
        value,
        enumerable: false,
        writable: false,
        configurable: false
    }])));
}

function buildUnconfirmedResult(context, {criterion_status, warning}) {
    return {
        schema_version: "1.0.0",
        run_id: context.run_id,
        entry_id: context.entry_id,
        institution_id: context.institution_id,
        decision_status: "unconfirmed",
        export_ready: false,
        data_status: "incomplete",
        export_blockers: ["decision_unconfirmed"],
        product_bundle: null,
        criterion_status,
        qualification: {reason_codes: ["ambiguous_sources"]},
        offer: null,
        field_status: {
            "qualification.housing": criterion_status.housing,
            "qualification.refinancing": criterion_status.refinancing,
            "qualification.fixed_rate": criterion_status.fixed_rate
        },
        field_evidence: {},
        warnings: [warning],
        interpreter_version: INTERPRETER_VERSION
    };
}

function assessExportReadiness(offer, decisionStatus) {
    const blockers = [];
    if (decisionStatus !== "qualified") blockers.push("decision_not_qualified");
    if (!offer || typeof offer !== "object") blockers.push("missing_offer");
    else {
        const hasRate = hasNumericOfferValue(offer, "fixed_nominal_rate") || hasNumericOfferValue(offer, "rrso");
        if (!hasRate) blockers.push("missing_nominal_or_rrso");
        if (!["permanent_fixed", "periodically_fixed"].includes(offer.fixed_rate_type)) blockers.push("missing_fixed_rate_type");
        if (offer.fixed_rate_type === "periodically_fixed"
            && !hasPositiveOfferValue(offer, "fixed_rate_period_years")) blockers.push("missing_fixed_rate_period");
    }
    return {
        export_ready: blockers.length === 0,
        data_status: blockers.length === 0 ? "complete" : "incomplete",
        export_blockers: [...new Set(blockers)]
    };
}

function hasNumericOfferValue(offer, name) {
    return [offer[`${name}_exact`], offer[`${name}_min`], offer[`${name}_max`]]
        .some((value) => typeof value === "number" && Number.isFinite(value));
}

function hasPositiveOfferValue(offer, name) {
    return [offer[`${name}_exact`], offer[`${name}_min`], offer[`${name}_max`]]
        .some((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function finalizeResult(result, options) {
    try {
        return assertValidInterpretationOutput(result, options);
    } catch (error) {
        throw interpretationSchemaError(error.message, error.details?.errors ?? []);
    }
}

function buildCriterionStatus(records, negative) {
    return Object.fromEntries(CRITERIA.map((criterion) => {
        const criterionRecords = records.filter((record) => record.field_path === `qualification.${criterion}`);
        const positive = criterionRecords.some((record) => !negative.evidence_ids.has(record.evidence_id));
        const excluded = negative.criteria.has(criterion);
        return [criterion, negative.ambiguous_criteria.has(criterion) || positive && excluded
            ? "ambiguous"
            : positive ? "found" : "not_found"];
    }));
}

function groupFieldEvidence(records) {
    const grouped = new Map();
    for (const record of records) {
        const values = grouped.get(record.field_path) ?? [];
        values.push(record.evidence_id);
        grouped.set(record.field_path, values);
    }
    return Object.fromEntries([...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldPath, ids]) => [fieldPath, [...new Set(ids)].sort()]));
}

function classifyNegativeEvidence(records, metadata) {
    const reasonCodes = new Set();
    const criteria = new Set();
    const ambiguousCriteria = new Set();
    const evidenceIds = new Set();
    let ambiguous = false;
    for (const record of records) {
        const text = `${record.normalized_excerpt} ${record.excerpt}`.toLocaleLowerCase("pl-PL");
        const variable = /(oprocentowanie|stopa).{0,40}zmienn/u.test(text);
        const fixed = /(oprocentowanie|stopa).{0,40}(stał|beztermin|cały okres|okresowo)/u.test(text);
        if (variable && fixed) {
            ambiguous = true;
            if (record.field_path.startsWith("qualification.")) {
                ambiguousCriteria.add(record.field_path.slice("qualification.".length));
            }
            continue;
        }
        if (/(zwrot|refund|rekompensat).*(koszt|wydatk)|koszt.*(ponies|włas)/u.test(text)
            || /(własnych koszt|poniesionych wydat)/u.test(text)) {
            reasonCodes.add("only_refinancing_of_own_costs_found");
            criteria.add("refinancing");
            evidenceIds.add(record.evidence_id);
        }
        if (variable) {
            reasonCodes.add("only_variable_rate_found");
            criteria.add("fixed_rate");
            evidenceIds.add(record.evidence_id);
        }
        if (record.field_path === "qualification.housing"
            && /\b(?:nie jest|nie obejmuje|bez)\b.{0,40}(mieszk|hipotek|kredyt)/u.test(text)) {
            reasonCodes.add("no_housing_or_mortgage_loan_confirmed");
            criteria.add("housing");
            evidenceIds.add(record.evidence_id);
        }
        if (record.field_path === "qualification.fixed_rate"
            && /\b(?:brak|bez|nie)\b.{0,40}(stał|stałej stopy|oprocentowania stał)/u.test(text)) {
            reasonCodes.add("no_fixed_rate_confirmed");
            criteria.add("fixed_rate");
            evidenceIds.add(record.evidence_id);
        }
        if (/\b(?:nie|brak|bez)\b.{0,40}(spłat|refinans|kredyt)/u.test(text) && record.field_path === "qualification.refinancing") {
            reasonCodes.add("no_refinance_or_repayment_confirmed");
            criteria.add("refinancing");
            evidenceIds.add(record.evidence_id);
        }
    }
    for (const exclusion of metadata.exclusions ?? []) {
        const code = typeof exclusion === "string" ? exclusion : exclusion?.reason_code;
        const criterion = typeof exclusion === "object" ? exclusion.criterion : null;
        const refs = typeof exclusion === "object" && Array.isArray(exclusion.evidence_ids) ? exclusion.evidence_ids : [];
        if (code && refs.length > 0 && refs.every((id) => records.some((record) => record.evidence_id === id))) {
            reasonCodes.add(code);
            if (criterion) criteria.add(criterion);
            refs.forEach((id) => evidenceIds.add(id));
        }
    }
    for (const criterion of criteria) {
        const positive = records.some((record) => record.field_path === `qualification.${criterion}` && !evidenceIds.has(record.evidence_id));
        if (positive) ambiguous = true;
    }
    return {
        reason_codes: [...reasonCodes],
        criteria,
        ambiguous_criteria: ambiguousCriteria,
        evidence_ids: evidenceIds,
        ambiguous
    };
}

function buildOffer({context, records, metadata, criterionStatus}) {
    if (criterionStatus.fixed_rate !== "found") return null;
    const fixedRecords = records.filter((record) => record.field_path === "qualification.fixed_rate");
    const fixedRateType = metadata.rate_type ?? inferRateType(fixedRecords);
    const period = valueForField("fixed_rate_period_years_exact", metadata.offer, records, ["offer.fixed_rate_period_years", "offer.fixed_rate_period"])
        ?? parseYears(fixedRecords.map((record) => record.excerpt).join(" "));
    if (fixedRateType === "periodically_fixed" && !(typeof period === "number" && period > 0)) return null;

    const fieldValue = (name, aliases = [`offer.${name}`]) => valueForField(name, metadata.offer, records, aliases);
    const commissionUnit = fieldValue("commission_unit", ["offer.commission_unit"]) ?? (hasAnyField(records, ["offer.commission"]) ? "percent" : null);
    const commissionCurrency = fieldValue("commission_currency", ["offer.commission_currency"]);
    if (commissionUnit === "amount" && !commissionCurrency) return null;
    const contextMetadata = metadata.comparison_context ?? {};
    return {
        fixed_rate_type: fixedRateType,
        comparison_context: {
            currency: contextMetadata.currency ?? "PLN",
            representative_amount: contextMetadata.representative_amount ?? null,
            term_years: contextMetadata.term_years ?? null,
            customer_profile: contextMetadata.customer_profile ?? context.customer_profile ?? "consumer_standard",
            observation_date: contextMetadata.observation_date ?? context.observed_at
        },
        fixed_nominal_rate_exact: fieldValue("fixed_nominal_rate_exact", ["offer.fixed_nominal_rate", "offer.fixed_nominal_rate_exact"]) ?? null,
        fixed_nominal_rate_min: fieldValue("fixed_nominal_rate_min", ["offer.fixed_nominal_rate_min"]) ?? null,
        fixed_nominal_rate_max: fieldValue("fixed_nominal_rate_max", ["offer.fixed_nominal_rate_max"]) ?? null,
        rrso_exact: fieldValue("rrso_exact", ["offer.rrso", "offer.rrso_exact"]) ?? null,
        rrso_min: fieldValue("rrso_min", ["offer.rrso_min"]) ?? null,
        rrso_max: fieldValue("rrso_max", ["offer.rrso_max"]) ?? null,
        commission_exact: fieldValue("commission_exact", ["offer.commission", "offer.commission_exact"]) ?? null,
        commission_min: fieldValue("commission_min", ["offer.commission_min"]) ?? null,
        commission_max: fieldValue("commission_max", ["offer.commission_max"]) ?? null,
        commission_unit: commissionUnit,
        commission_currency: commissionCurrency ?? null,
        fixed_rate_period_years_exact: fixedRateType === "permanent_fixed" ? null : period,
        max_loan_term_years: fieldValue("max_loan_term_years", ["offer.max_loan_term_years", "offer.max_loan_term"]) ?? null
    };
}

function valueForField(name, metadataOffer = {}, records = [], aliases = []) {
    const metadataValue = metadataOffer?.[name];
    const matching = records.filter((record) => aliases.includes(record.field_path));
    if (matching.length === 0) return null;
    const excerpt = matching.map((record) => record.excerpt).join(" ");
    const parsed = name.includes("rate") || name.includes("rrso") || name === "commission_exact"
        ? parsePercent(excerpt)
        : name.includes("term") || name.includes("period")
            ? parseYears(excerpt)
            : name === "commission_unit" && /%/.test(excerpt) ? "percent" : null;
    if (metadataValue !== undefined && metadataValue !== null) {
        if (parsed !== null && metadataValue !== parsed) {
            throw new ResearchError("schema_mismatch", `offer metadata conflicts with evidence for ${name}`, {exitCode: 10});
        }
        return metadataValue;
    }
    return parsed;
}

function hasAnyField(records, fields) {
    return records.some((record) => fields.includes(record.field_path));
}

function buildFieldStatus(bundle) {
    const result = {
        "qualification.housing": bundle.criterion_status.housing,
        "qualification.refinancing": bundle.criterion_status.refinancing,
        "qualification.fixed_rate": bundle.criterion_status.fixed_rate
    };
    for (const field of OFFER_FIELDS) {
        const fieldPath = `offer.${field}`;
        if (field === "fixed_rate_type") {
            result[fieldPath] = bundle.criterion_status.fixed_rate === "found" ? "found" : "not_found";
        } else if (field === "fixed_rate_period_years") {
            result[fieldPath] = bundle.offer?.fixed_rate_type === "permanent_fixed"
                ? "not_applicable"
                : bundle.offer?.fixed_rate_period_years_exact != null ? "found" : "not_found";
        } else {
            result[fieldPath] = bundle.field_evidence[fieldPath]?.length > 0 ? "found" : "not_found";
        }
    }
    return result;
}

function inferProductName(records, productId) {
    const housing = records.find((record) => record.field_path === "qualification.housing");
    return (housing?.excerpt ?? `Product ${productId}`).trim().slice(0, 255);
}

function inferRateType(records) {
    const text = records.map((record) => `${record.excerpt} ${record.normalized_excerpt}`).join(" ").toLocaleLowerCase("pl-PL");
    return /(beztermin|cały okres|całym okres)/u.test(text) ? "permanent_fixed" : "periodically_fixed";
}

function parsePercent(value) {
    const match = String(value).match(/(\d+(?:[,.]\d+)?)\s*%/u);
    return match ? Number(match[1].replace(",", ".")) : null;
}

function parseYears(value) {
    const match = String(value).match(/(?:przez|na|okresowo stałe przez)\s+(\d+(?:[,.]\d+)?)\s*(?:lat|lata|rok|lata)/iu);
    return match ? Number(match[1].replace(",", ".")) : null;
}

function isQualifiedBundle(bundle) {
    return CRITERIA.every((criterion) => bundle.criterion_status[criterion] === "found")
        && bundle.offer !== null
        && !bundle.warnings.length;
}

function isExplicitNegativeBundle(bundle) {
    return bundle.negative_reason_codes.length > 0
        && bundle.explicit_negative_criteria.size > 0
        && Object.values(bundle.criterion_status).some((status) => status === "not_found");
}

function ambiguousCriteria(bundles) {
    const values = Object.fromEntries(CRITERIA.map((criterion) => [criterion, "ambiguous"]));
    if (bundles.length === 1) {
        for (const criterion of CRITERIA) values[criterion] = bundles[0].criterion_status[criterion];
    }
    return values;
}

function notFoundCriteria() {
    return Object.fromEntries(CRITERIA.map((criterion) => [criterion, "not_found"]));
}

function cloneFieldEvidence(value) {
    return Object.fromEntries(Object.entries(value).map(([key, ids]) => [key, [...ids].sort()]));
}

function uniqueReasonCodes(values) {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareRecord(left, right) {
    return [left.field_path, left.url, left.evidence_id].join("\u0000").localeCompare([right.field_path, right.url, right.evidence_id].join("\u0000"));
}

function compareBundle(left, right) {
    return `${left.product_id}:${left.variant_id}`.localeCompare(`${right.product_id}:${right.variant_id}`);
}

function interpretationSchemaError(message, details = []) {
    return new ResearchError("schema_mismatch", message, {exitCode: 10, details: {errors: details}});
}
