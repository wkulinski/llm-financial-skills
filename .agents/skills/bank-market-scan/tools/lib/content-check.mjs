import fs from 'node:fs/promises';
import {findAllNormalizedSnippets, normalizeText} from './common.mjs';
import {normalizeMaterial} from './material.mjs';
import {isCriticalSourceCandidate, sourceBufferIntegrityErrors} from './source-integrity.mjs';
import {findLemmaMatch, prepareMorphology} from './morphology.mjs';
import {buildProductBundles, evaluateProductBundles} from './product-bundles.mjs';
import {classifySourceRole} from './source-roles.mjs';

const COVERAGE_CATEGORIES = ['product', 'refinancing', 'fixed_rate'];

export function classifyRefinancingContext(material = {}, excerpt = '') {
    const pageIdentity = normalizeText(`${material.url} ${material.title}`);
    const context = normalizeText(`${material.title} ${excerpt}`);
    if (/fundusz[- ]wsparcia|wsparcie[- ]kredytobiorc|zalegl|restrukturyzacj|windykacj|wakacj kredytow/.test(`${pageIdentity} ${context}`)) {
        return 'existing_debt_support';
    }
    if (/wsp[oó]lnot|dewelop|firm|biznes|przedsięb|działalnoś/.test(`${pageIdentity} ${context}`)) {
        return 'community_or_business_loan';
    }
    if (/refinansowan\w* koszt\w*|zwrot\w* wydatk\w*|wlasnych wydatk\w*|poniesion\w* koszt\w*/.test(context)) {
        return 'refinance_of_own_housing_expenses';
    }
    if (/konsolidacj/.test(context) && !/spłat\w* kredyt\w* mieszk|kredyt\w* hipotecz/.test(context)) {
        return 'consolidation_ambiguous';
    }
    if (/refinansowan|splat\w* (?:wczesniejsz|inn|obecn|kredyt\w*)/.test(context)
        && /kredyt\w* (?:mieszk|hipotecz)|mieszkaniow|hipotecz/.test(context)) {
        return 'commercial_refinance_of_mortgage';
    }
    return null;
}

function canonicalUrl(value, baseUrl = null) {
    try {
        const url = new URL(value, baseUrl || undefined);
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (key.toLowerCase().startsWith('utm_') || ['gclid', 'fbclid', 'msclkid'].includes(key.toLowerCase())) url.searchParams.delete(key);
        }
        return url.toString();
    } catch {
        return null;
    }
}

async function readMaterial(candidate) {
    if (!candidate.cache_file || candidate.available === false) {
        return {readable: false, text: '', links: [], cache_file: candidate.cache_file || null, error: candidate.error || 'source_unavailable'};
    }
    try {
        const buffer = await fs.readFile(candidate.cache_file);
        const integrityErrors = sourceBufferIntegrityErrors(candidate, buffer);
        if (integrityErrors.length) {
            return {readable: false, text: '', links: [], cache_file: candidate.cache_file, error: integrityErrors.join(',')};
        }
        const material = await normalizeMaterial(buffer, {
            contentType: candidate.content_type || '',
            fileName: candidate.cache_file
        });
        if (/\.pdf$/i.test(candidate.cache_file) || /pdf/i.test(candidate.content_type || '')) {
            return {readable: Boolean(material.text), text: material.text, links: material.links || [], cache_file: candidate.cache_file, error: null};
        }
        const links = (material.links || [])
            .map(href => canonicalUrl(href, candidate.final_url || candidate.url))
            .filter(Boolean);
        return {readable: Boolean(material.text), text: material.text, links, cache_file: candidate.cache_file, error: null};
    } catch (error) {
        return {readable: false, text: '', links: [], cache_file: candidate.cache_file || null, error: error.message};
    }
}

function categorySummary(materials, keywordGroups, category, morphology) {
    const matches = [];
    const urls = [];
    const contextFlags = [];
    let readableSources = 0;
    for (const material of materials) {
        if (material.readable) readableSources += 1;
        const keywords = keywordGroups[category] || [];
        const sourceMatches = keywords.flatMap((keyword, keywordIndex) => {
            const surfaceMatches = findAllNormalizedSnippets(material.text, keyword, 550, 20)
                .map(snippet => {
                    const contextClass = category === 'refinancing' ? classifyRefinancingContext(material, snippet.text_excerpt) : null;
                    if (contextClass) contextFlags.push({url: material.url, reason: contextClass});
                    return {
                    keyword,
                    match_type: 'surface',
                    context_class: contextClass,
                    source_start: snippet.source_start,
                    text_excerpt: snippet.text_excerpt
                    };
                });
            const lemmaMatch = findLemmaMatch(material, morphology, category, keywordIndex);
            if (!lemmaMatch) return surfaceMatches;
            const contextClass = category === 'refinancing' ? classifyRefinancingContext(material, lemmaMatch.text_excerpt) : null;
            if (contextClass) contextFlags.push({url: material.url, reason: contextClass});
            return [...surfaceMatches, {
                    keyword,
                    match_type: 'lemma',
                    context_class: contextClass,
                    source_start: lemmaMatch.source_start,
                    text_excerpt: lemmaMatch.text_excerpt
                }];
        });
        if (sourceMatches.length) {
            urls.push(material.url);
            matches.push(...sourceMatches);
        }
    }
    // Recompute at material level so an excluded context cannot satisfy the criterion.
    const eligibleMaterialUrls = [...new Set(materials
        .filter(material => urls.includes(material.url))
        .filter(material => !contextFlags.some(flag => flag.url === material.url && flag.reason !== 'commercial_refinance_of_mortgage'))
        .map(material => material.url))];
    return {
        status: matches.length ? 'present' : (readableSources ? 'absent' : 'unknown'),
        urls: [...new Set(urls)],
        eligible_urls: category === 'refinancing' ? eligibleMaterialUrls : [...new Set(urls)],
        decision_status: matches.length === 0 ? (readableSources ? 'absent' : 'unknown') : (category === 'refinancing' && eligibleMaterialUrls.length === 0 ? 'excluded_context' : 'present'),
        matches: matches.length,
        match_details: matches.slice(0, 20),
        context_flags: [...new Map(contextFlags.map(item => [`${item.url}:${item.reason}`, item])).values()],
        review_required: contextFlags.length > 0
    };
}

function explicitProductRelation(materials, summaries) {
    const productSources = materials.filter(material => summaries.product.urls.includes(material.url));
    const fixedSources = new Set([...summaries.fixed_rate.eligible_urls, ...summaries.pricing.eligible_urls, ...summaries.documents.eligible_urls]);
    for (const product of productSources) {
        const linked = product.links.find(url => fixedSources.has(url));
        if (linked) return {status: 'confirmed', basis: 'product_page_links_to_rate_or_document', urls: [product.url, linked]};
    }

    const titleGroups = new Map();
    for (const material of materials) {
        const title = normalizeText(material.title);
        if (title.split(' ').filter(Boolean).length < 2 || /^(kredyt hipoteczny|kredyt mieszkaniowy)$/.test(title)) continue;
        if (!titleGroups.has(title)) titleGroups.set(title, []);
        titleGroups.get(title).push(material.url);
    }
    for (const urls of titleGroups.values()) {
        if (urls.length > 1 && urls.some(url => summaries.product.urls.includes(url)) && urls.some(url => fixedSources.has(url))) {
            return {status: 'confirmed', basis: 'same_explicit_product_title', urls};
        }
    }

    if (summaries.product.status === 'present' && summaries.refinancing.status === 'present' && summaries.fixed_rate.status === 'present') {
        return {status: 'possible', basis: 'coverage_without_explicit_relation', urls: [...new Set([
            ...summaries.product.urls,
            ...summaries.refinancing.urls,
            ...summaries.fixed_rate.urls
        ])]};
    }
    return {status: 'unknown', basis: 'insufficient_readable_relation_material', urls: []};
}

export async function evaluateContent(candidates, keywordGroups, {institution_id = candidates?.[0]?.institution_id || null} = {}) {
    const materials = [];
    const integrityErrors = [];
    const integrityWarnings = [];
    for (const candidate of candidates || []) {
        const sourceFlags = candidate.source_integrity_flags || [];
        const material = sourceFlags.includes('source_url_mismatch')
            ? {readable: false, text: '', links: [], cache_file: candidate.cache_file || null, error: 'source_url_mismatch'}
            : await readMaterial(candidate);
        if (sourceFlags.includes('source_url_mismatch')) {
            const bucket = isCriticalSourceCandidate(candidate) ? integrityErrors : integrityWarnings;
            bucket.push('source_url_mismatch');
        }
        if (material.error?.includes('content_hash_mismatch') || material.error?.includes('content_length_mismatch')) {
            integrityErrors.push(material.error);
        }
        materials.push({
            url: candidate.final_url || candidate.url,
            title: candidate.title || '',
            source: candidate.source || null,
            readable: material.readable,
            text: material.text,
            links: material.links,
            cache_file: material.cache_file,
            error: material.error || null
        });
    }

    const morphology = await prepareMorphology(materials, keywordGroups);

    const summaries = Object.fromEntries([...COVERAGE_CATEGORIES, 'pricing', 'documents'].map(category => [
        category,
        categorySummary(materials, keywordGroups, category, morphology)
    ]));
    const fullCoverageSources = materials.filter(material => COVERAGE_CATEGORIES.every(category => {
        return summaries[category].eligible_urls.includes(material.url);
    }));
    const productRelation = explicitProductRelation(materials, summaries);
    const singleUrlFullCoverage = fullCoverageSources.length > 0;
    const multiSourceCoverage = !singleUrlFullCoverage
        && COVERAGE_CATEGORIES.every(category => summaries[category].decision_status === 'present')
        && productRelation.status === 'confirmed';
    const sufficientForSearchFirst = singleUrlFullCoverage || multiSourceCoverage;
    const analysisSignalCount = COVERAGE_CATEGORIES.filter(category => summaries[category].decision_status === 'present').length;
    // Discovery should maximize recall; the model resolves missing literal terms.
    const sufficientForAnalysis = materials.some(material => material.readable) && analysisSignalCount >= 2;
    const missingCategories = COVERAGE_CATEGORIES.filter(category => summaries[category].decision_status !== 'present');
    const coverageUrls = [...new Set(COVERAGE_CATEGORIES.flatMap(category => summaries[category].eligible_urls))];
    const criterionByUrl = {};
    for (const [category, criterion] of [['product', 'housing'], ['refinancing', 'commercial_refinance'], ['fixed_rate', 'fixed_rate']]) {
        for (const url of summaries[category].eligible_urls) criterionByUrl[url] = [...(criterionByUrl[url] || []), criterion];
    }
    const bundleSources = materials.map(material => ({
        ...material,
        source_role: classifySourceRole(material, Object.entries(summaries).filter(([, summary]) => summary.urls.includes(material.url)).map(([category]) => category))
    }));
    const productBundles = buildProductBundles({institution_id, sources: bundleSources, criterionByUrl, summaries});
    const bundleDecision = evaluateProductBundles(productBundles);

    return {
        product: summaries.product,
        refinancing: summaries.refinancing,
        fixed_rate: summaries.fixed_rate,
        product_relation: singleUrlFullCoverage
            ? {status: 'confirmed', basis: 'single_url_full_coverage', urls: [fullCoverageSources[0].url]}
            : productRelation,
        single_url_full_coverage: singleUrlFullCoverage,
        multi_source_coverage: multiSourceCoverage,
        sufficient_for_search_first: sufficientForSearchFirst,
        sufficient_for_analysis: sufficientForAnalysis,
        missing_categories: missingCategories,
        sufficiency_basis: singleUrlFullCoverage
            ? 'single_url_full_coverage'
            : (multiSourceCoverage ? 'multi_source_coverage' : (sufficientForAnalysis ? 'multi_signal_analysis' : null)),
        coverage_urls: coverageUrls,
        product_bundles: productBundles,
        bundle_decision: bundleDecision,
        readable_source_count: materials.filter(material => material.readable).length,
        unknown_source_count: materials.filter(material => !material.readable).length,
        integrity_errors: [...new Set(integrityErrors)],
        integrity_warnings: [...new Set(integrityWarnings)],
        morphology: {
            engine: 'morfeusz2',
            available: morphology.available,
            error: morphology.error,
            cache_hits: morphology.cache_hits,
            cache_misses: morphology.cache_misses
        }
    };
}
