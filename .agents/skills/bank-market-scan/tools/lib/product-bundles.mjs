import {normalizeText, normalizeUrlIdentity} from './common.mjs';
import {productId} from './decision-model.mjs';
import {classifySourceRole} from './source-roles.mjs';

export const BUNDLE_CRITERIA = Object.freeze(['housing', 'commercial_refinance', 'fixed_rate']);

function sourceUrl(source) {
    return source.final_url || source.url;
}

function sourceProductName(source) {
    return source.product_name || source.product_scope || source.title || 'unknown product';
}

function inferAudience(source) {
    const identity = normalizeText(`${source.title || ''} ${source.url || ''}`);
    if (/firm|biznes|wspolnot|dewelop/.test(identity)) return 'business_or_community';
    return 'individual';
}

function inferRateVariant(source) {
    return /stał|stala|okresowo|fixed/i.test(`${source.title || ''} ${source.text || ''}`) ? 'periodically_fixed' : 'unknown';
}

export function createProductBundle({institution_id, source, product_name, audience, rate_variant, canonical_product_url, criteria = {}} = {}) {
    const name = product_name || sourceProductName(source || {});
    const resolvedAudience = audience || inferAudience(source || {});
    const resolvedVariant = rate_variant || inferRateVariant(source || {});
    const canonicalUrl = canonical_product_url || sourceUrl(source || '');
    return {
        product_id: productId({institution_id, product_name: name, audience: resolvedAudience, rate_variant: resolvedVariant, canonical_product_url: canonicalUrl}),
        institution_id,
        name,
        audience: resolvedAudience,
        rate_variant: resolvedVariant,
        canonical_product_url: canonicalUrl,
        sources: [],
        criteria: Object.fromEntries(BUNDLE_CRITERIA.map(key => [key, Array.isArray(criteria[key]) ? [...criteria[key]] : []]))
    };
}

export function addSourceToBundle(bundle, source, {role, criteria = []} = {}) {
    const resolvedRole = role || source.source_role || classifySourceRole(source, criteria);
    const url = sourceUrl(source);
    if (url && !bundle.sources.some(item => normalizeUrlIdentity(item.url) === normalizeUrlIdentity(url))) {
        bundle.sources.push({url, role: resolvedRole, title: source.title || '', content_sha256: source.content_sha256 || null});
    }
    for (const criterion of criteria) {
        if (!BUNDLE_CRITERIA.includes(criterion)) continue;
        const evidence = {url, role: resolvedRole, excerpt: source.text_excerpt || source.text || ''};
        if (!bundle.criteria[criterion].some(item => item.url === evidence.url && item.excerpt === evidence.excerpt)) bundle.criteria[criterion].push(evidence);
    }
    return bundle;
}

export function buildProductBundles({institution_id, sources = [], criterionByUrl = {}, summaries = {}} = {}) {
    const bundles = new Map();
    for (const source of sources) {
        const url = sourceUrl(source);
        const explicitProductId = source.product_id || source.product_bundle_id;
        const key = explicitProductId || `${normalizeText(sourceProductName(source))}|${inferAudience(source)}|${inferRateVariant(source)}`;
        if (!bundles.has(key)) bundles.set(key, createProductBundle({institution_id, source, product_name: sourceProductName(source), audience: inferAudience(source), rate_variant: inferRateVariant(source), canonical_product_url: url}));
        const criteria = criterionByUrl[url] || [];
        addSourceToBundle(bundles.get(key), source, {criteria});
    }
    // Summaries can provide criterion evidence for a source that did not carry a
    // precomputed criterionByUrl entry. This remains deterministic and URL-bound.
    for (const [criterion, summary] of Object.entries(summaries)) {
        const mapped = criterion === 'product' ? 'housing' : (criterion === 'refinancing' ? 'commercial_refinance' : criterion === 'fixed_rate' ? 'fixed_rate' : null);
        if (!mapped) continue;
        for (const url of summary.eligible_urls || summary.urls || []) {
            const bundle = [...bundles.values()].find(item => item.sources.some(source => normalizeUrlIdentity(source.url) === normalizeUrlIdentity(url)));
            if (bundle && !bundle.criteria[mapped].some(item => item.url === url)) bundle.criteria[mapped].push({url, role: 'core', excerpt: ''});
        }
    }
    return [...bundles.values()];
}

export function bundleHasAllCriteria(bundle) {
    return Boolean(bundle
        && BUNDLE_CRITERIA.every(criterion => Array.isArray(bundle.criteria?.[criterion]) && bundle.criteria[criterion].length > 0)
        && bundle.sources.some(source => source.role === 'core'));
}

export function evaluateProductBundles(bundles = []) {
    const qualified = bundles.filter(bundleHasAllCriteria);
    return {
        qualified,
        decision_status: qualified.length === 1 ? 'qualified' : (qualified.length > 1 ? 'pending_review' : 'unconfirmed'),
        product_bundle_count: bundles.length,
        qualified_bundle_count: qualified.length
    };
}
