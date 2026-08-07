import {getDeep, setDeep, sha256} from './common.mjs';

export const DECISION_STATUSES = Object.freeze([
    'qualified',
    'explicitly_not_qualified',
    'unconfirmed',
    'technical_error',
    'pending_review'
]);

export const REVIEW_STATUSES = Object.freeze(['unchecked', 'checked', 'needs_review', 'error']);

export const CANONICAL_PERIOD_FIELDS = Object.freeze([
    'offer.fixed_rate_period_years_exact',
    'offer.fixed_rate_period_years_min',
    'offer.fixed_rate_period_years_max'
]);

export const CANONICAL_PERCENT_FIELDS = Object.freeze([
    'offer.fixed_nominal_rate_exact',
    'offer.fixed_nominal_rate_min',
    'offer.fixed_nominal_rate_max',
    'offer.rrso_exact',
    'offer.rrso_min',
    'offer.rrso_max',
    'offer.commission_exact',
    'offer.commission_min',
    'offer.commission_max'
]);

export function decisionStatusFromLegacy({decision_status, qualifies, review_status, last_error} = {}) {
    if (DECISION_STATUSES.includes(decision_status)) return decision_status;
    if (review_status === 'error' || last_error) return 'technical_error';
    if (qualifies === true) return 'qualified';
    if (qualifies === false) return 'explicitly_not_qualified';
    if (review_status === 'needs_review') return 'pending_review';
    return 'unconfirmed';
}

export function qualifiesForDecisionStatus(status) {
    if (status === 'qualified') return true;
    if (status === 'explicitly_not_qualified') return false;
    return null;
}

export function reviewStatusForDecisionStatus(status, {unchecked = false} = {}) {
    if (unchecked) return 'unchecked';
    if (status === 'qualified' || status === 'explicitly_not_qualified') return 'checked';
    if (status === 'technical_error') return 'error';
    return 'needs_review';
}

export function normalizeDecision(row, {preserveUnchecked = true} = {}) {
    const status = decisionStatusFromLegacy(row);
    const unchecked = preserveUnchecked && row?.review_status === 'unchecked' && !row?.decision_status;
    return {
        ...row,
        decision_status: status,
        qualifies: qualifiesForDecisionStatus(status),
        review_status: reviewStatusForDecisionStatus(status, {unchecked}),
    };
}

export function normalizePeriodToYears(value, unit = 'years') {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    if (unit === 'months') return numeric / 12;
    if (unit !== 'years') return null;
    return numeric;
}

function normalizePeriodField(offer, target, legacyNames) {
    const direct = getDeep(offer, target);
    if (direct != null) return direct;
    for (const name of legacyNames) {
        const value = getDeep(offer, name);
        if (value != null) return normalizePeriodToYears(value, name.includes('months') ? 'months' : 'years');
    }
    return undefined;
}

export function normalizeCanonicalOffer(offer = {}) {
    const normalized = {...offer};
    const conflicts = Array.isArray(offer.normalization_conflicts) ? [...offer.normalization_conflicts] : [];
    const periodMappings = [
        ['fixed_rate_period_years_exact', ['fixed_rate_period_months_exact', 'fixed_rate_period_exact', 'fixed_rate_period_years']],
        ['fixed_rate_period_years_min', ['fixed_rate_period_months_min', 'fixed_rate_period_min']],
        ['fixed_rate_period_years_max', ['fixed_rate_period_months_max', 'fixed_rate_period_max']]
    ];
    for (const [target, legacy] of periodMappings) {
        const value = normalizePeriodField(offer, target, legacy);
        const directLegacyValue = legacy.map(name => getDeep(offer, name)).find(item => item != null);
        if (getDeep(offer, target) != null && directLegacyValue != null) {
            const convertedLegacy = normalizePeriodToYears(directLegacyValue, legacy.find(name => name.includes('months')) ? 'months' : 'years');
            if (convertedLegacy != null && Number(getDeep(offer, target)) !== convertedLegacy) conflicts.push(`${target}:direct_vs_legacy`);
        }
        if (value != null) normalized[target] = value;
    }
    for (const field of ['fixed_rate_period_months_exact', 'fixed_rate_period_months_min', 'fixed_rate_period_months_max']) {
        delete normalized[field];
    }
    if (conflicts.length) normalized.normalization_conflicts = [...new Set(conflicts)];
    return normalized;
}

export function detectOfferConflicts(offer = {}) {
    const conflicts = [];
    for (const base of ['fixed_rate_period_years', 'fixed_nominal_rate', 'commission', 'rrso']) {
        const exact = offer[`${base}_exact`] ?? offer[base];
        const min = offer[`${base}_min`];
        const max = offer[`${base}_max`];
        if (min != null && max != null && Number(min) > Number(max)) conflicts.push(`${base}:min_gt_max`);
        if (exact != null && min != null && Number(exact) < Number(min)) conflicts.push(`${base}:exact_below_min`);
        if (exact != null && max != null && Number(exact) > Number(max)) conflicts.push(`${base}:exact_above_max`);
    }
    return conflicts;
}

export function normalizeRowFields(row = {}) {
    const normalized = normalizeDecision(row);
    if (row.offer) normalized.offer = normalizeCanonicalOffer(row.offer);
    return normalized;
}

export function productId({institution_id, product_name, audience = 'individual', rate_variant = 'periodically_fixed', canonical_product_url = ''} = {}) {
    const normalizedName = String(product_name || 'unknown').trim().toLowerCase().replace(/\s+/g, ' ');
    return `product-${sha256([institution_id || '', normalizedName, audience, rate_variant, canonical_product_url || ''].join('|')).slice(0, 24)}`;
}

export function canonicalValue(row, fieldPath) {
    return getDeep(normalizeRowFields(row), fieldPath);
}

export function setCanonicalValue(row, fieldPath, value) {
    const copy = structuredClone(row);
    setDeep(copy, fieldPath, value);
    return normalizeRowFields(copy);
}
