import fs from 'node:fs/promises';
import * as cheerio from 'cheerio';
import {findAllNormalizedSnippets, normalizeText} from './common.mjs';
import {normalizeMaterial} from './material.mjs';
import {isCriticalSourceCandidate, sourceBufferIntegrityErrors} from './source-integrity.mjs';

const COVERAGE_CATEGORIES = ['product', 'refinancing', 'fixed_rate'];

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
        return {readable: false, text: '', links: [], error: candidate.error || 'source_unavailable'};
    }
    try {
        const buffer = await fs.readFile(candidate.cache_file);
        const integrityErrors = sourceBufferIntegrityErrors(candidate, buffer);
        if (integrityErrors.length) {
            return {readable: false, text: '', links: [], error: integrityErrors.join(',')};
        }
        const material = await normalizeMaterial(buffer, {
            contentType: candidate.content_type || '',
            fileName: candidate.cache_file
        });
        if (/\.pdf$/i.test(candidate.cache_file) || /pdf/i.test(candidate.content_type || '')) {
            return {readable: Boolean(material.text), text: material.text, links: []};
        }
        const html = buffer.toString('utf8');
        const $ = cheerio.load(html);
        const links = $('a[href]').toArray()
            .map(anchor => canonicalUrl($(anchor).attr('href'), candidate.final_url || candidate.url))
            .filter(Boolean);
        return {readable: Boolean(material.text), text: material.text, links};
    } catch (error) {
        return {readable: false, text: '', links: [], error: error.message};
    }
}

function categorySummary(materials, keywordGroups, category) {
    const matches = [];
    const urls = [];
    let readableSources = 0;
    for (const material of materials) {
        if (material.readable) readableSources += 1;
        const keywords = keywordGroups[category] || [];
        const sourceMatches = keywords.flatMap(keyword => findAllNormalizedSnippets(material.text, keyword, 550, 20).map(snippet => ({
            keyword,
            source_start: snippet.source_start,
            text_excerpt: snippet.text_excerpt
        })));
        if (sourceMatches.length) {
            urls.push(material.url);
            matches.push(...sourceMatches);
        }
    }
    return {
        status: matches.length ? 'present' : (readableSources ? 'absent' : 'unknown'),
        urls: [...new Set(urls)],
        matches: matches.length,
        match_details: matches.slice(0, 20)
    };
}

function explicitProductRelation(materials, summaries) {
    const productSources = materials.filter(material => summaries.product.urls.includes(material.url));
    const fixedSources = new Set([...summaries.fixed_rate.urls, ...summaries.pricing.urls, ...summaries.documents.urls]);
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

export async function evaluateContent(candidates, keywordGroups) {
    const materials = [];
    const integrityErrors = [];
    const integrityWarnings = [];
    for (const candidate of candidates || []) {
        const sourceFlags = candidate.source_integrity_flags || [];
        const material = sourceFlags.includes('source_url_mismatch')
            ? {readable: false, text: '', links: [], error: 'source_url_mismatch'}
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
            error: material.error || null
        });
    }

    const summaries = Object.fromEntries([...COVERAGE_CATEGORIES, 'pricing', 'documents'].map(category => [
        category,
        categorySummary(materials, keywordGroups, category)
    ]));
    const fullCoverageSources = materials.filter(material => COVERAGE_CATEGORIES.every(category => {
        return summaries[category].urls.includes(material.url);
    }));
    const productRelation = explicitProductRelation(materials, summaries);
    const singleUrlFullCoverage = fullCoverageSources.length > 0;
    const multiSourceCoverage = !singleUrlFullCoverage
        && COVERAGE_CATEGORIES.every(category => summaries[category].status === 'present')
        && productRelation.status === 'confirmed';
    const sufficientForSearchFirst = singleUrlFullCoverage || multiSourceCoverage;
    const analysisSignalCount = COVERAGE_CATEGORIES.filter(category => summaries[category].status === 'present').length;
    // Discovery should maximize recall; the model resolves missing literal terms.
    const sufficientForAnalysis = materials.some(material => material.readable) && analysisSignalCount >= 2;
    const coverageUrls = [...new Set(COVERAGE_CATEGORIES.flatMap(category => summaries[category].urls))];

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
        sufficiency_basis: singleUrlFullCoverage
            ? 'single_url_full_coverage'
            : (multiSourceCoverage ? 'multi_source_coverage' : (sufficientForAnalysis ? 'multi_signal_analysis' : null)),
        coverage_urls: coverageUrls,
        readable_source_count: materials.filter(material => material.readable).length,
        unknown_source_count: materials.filter(material => !material.readable).length,
        integrity_errors: [...new Set(integrityErrors)],
        integrity_warnings: [...new Set(integrityWarnings)]
    };
}
