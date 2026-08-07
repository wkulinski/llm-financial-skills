import {canonicalJson} from "./canonical-json.mjs";

/**
 * Deterministic comparison of already-qualified offer candidates.
 * `null` from compareOffers means that the contract cannot establish a
 * strict ordering; callers must return `unconfirmed` instead of guessing.
 */
export function compareOffers(left, right) {
    const leftOffer = left?.offer ?? left;
    const rightOffer = right?.offer ?? right;
    if (!leftOffer || !rightOffer) return null;

    const leftContext = leftOffer.comparison_context;
    const rightContext = rightOffer.comparison_context;
    if (!leftContext || !rightContext || canonicalJson(leftContext) !== canonicalJson(rightContext)) {
        return null;
    }

    const rrsoLeft = numericRange(leftOffer, "rrso");
    const rrsoRight = numericRange(rightOffer, "rrso");
    const nominalLeft = numericRange(leftOffer, "fixed_nominal_rate");
    const nominalRight = numericRange(rightOffer, "fixed_nominal_rate");
    const useRrso = rrsoLeft !== null && rrsoRight !== null;
    const primary = useRrso
        ? compareRanges(rrsoLeft, rrsoRight)
        : compareRanges(nominalLeft, nominalRight);
    if (primary === null) return null;
    if (primary !== 0) return primary;

    const commission = compareCommission(leftOffer, rightOffer);
    if (commission === null) return null;
    if (commission !== 0) return commission;

    const period = comparePeriods(leftOffer, rightOffer);
    if (period === null) return null;
    return period;
}

/**
 * Select one offer with a single reduction after the common comparison
 * context and metric have been established.  No input order is used as an
 * implicit tie breaker.
 */
export function selectBestOffer(candidates = []) {
    const normalized = candidates.filter(Boolean);
    if (normalized.length === 0) {
        return {status: "unconfirmed", reason: "no_qualified_offer"};
    }
    if (normalized.length === 1) {
        return {status: "selected", candidate: normalized[0], comparison_mode: comparisonMode(normalized)};
    }
    const contexts = normalized.map((candidate) => candidate.offer?.comparison_context);
    if (contexts.some((context) => !context) || contexts.some((context) => canonicalJson(context) !== canonicalJson(contexts[0]))) {
        return {status: "unconfirmed", reason: "incomparable_contexts"};
    }

    const mode = comparisonMode(normalized);
    if (!mode) {
        return {status: "unconfirmed", reason: "missing_comparable_rate"};
    }
    let winner = normalized[0];
    for (let index = 1; index < normalized.length; index += 1) {
        const comparison = compareOffers(winner, normalized[index]);
        if (comparison === null) {
            return {status: "unconfirmed", reason: "overlapping_or_incomparable_offer_ranges"};
        }
        if (comparison > 0) {
            winner = normalized[index];
        }
    }

    // A second candidate with an identical complete tie is not ordered by the
    // time it arrived, its promotion flag, or its identifier.
    const tied = normalized.filter((candidate) => candidate !== winner && compareOffers(winner, candidate) === 0);
    if (tied.length > 0) {
        return {status: "unconfirmed", reason: "unresolved_offer_tie"};
    }
    return {status: "selected", candidate: winner, comparison_mode: mode};
}

export function comparisonMode(candidates = []) {
    if (candidates.length === 0) return null;
    const offers = candidates.map((candidate) => candidate?.offer ?? candidate);
    if (offers.every((offer) => numericRange(offer, "rrso") !== null)) return "rrso";
    if (offers.every((offer) => numericRange(offer, "fixed_nominal_rate") !== null)) return "nominal_rate";
    return null;
}

function compareCommission(left, right) {
    if (left.commission_unit !== right.commission_unit || left.commission_currency !== right.commission_currency) {
        return null;
    }
    const leftRange = numericRange(left, "commission");
    const rightRange = numericRange(right, "commission");
    return compareRanges(leftRange, rightRange);
}

function comparePeriods(left, right) {
    const leftPeriod = left.fixed_rate_type === "permanent_fixed"
        ? {min: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY}
        : numericRange(left, "fixed_rate_period_years");
    const rightPeriod = right.fixed_rate_type === "permanent_fixed"
        ? {min: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY}
        : numericRange(right, "fixed_rate_period_years");
    if (!leftPeriod || !rightPeriod) return null;
    const result = compareRanges(leftPeriod, rightPeriod);
    return result === null ? null : -result;
}

/** Return -1 when left is cheaper, 1 when right is cheaper, 0 for a tie. */
export function compareRanges(left, right) {
    if (!left || !right) return null;
    if (left.max < right.min) return -1;
    if (right.max < left.min) return 1;
    if (left.min === right.min && left.max === right.max) return 0;
    return null;
}

function numericRange(offer, prefix) {
    if (!offer || typeof offer !== "object") return null;
    const exact = offer[`${prefix}_exact`];
    const min = offer[`${prefix}_min`];
    const max = offer[`${prefix}_max`];
    if (typeof exact === "number" && Number.isFinite(exact)) return {min: exact, max: exact};
    if (typeof min === "number" && Number.isFinite(min) && typeof max === "number" && Number.isFinite(max) && min <= max) {
        return {min, max};
    }
    return null;
}
