import {normalizeText, scoreUrl} from './common.mjs';

const NEGATIVE_SIGNALS = [
    ['contact', /kontakt|contact/],
    ['privacy', /rodo|polityka|prywatn/],
    ['career', /karier|praca|rekrut/],
    ['login', /logowan|login|e-banking/],
    ['sitemap', /sitemap|mapa witryny/],
    ['news', /aktualno|news|komunikat/]
];

export function rankSearchResults(results, keywordGroups) {
    return results
        .map(result => {
            const haystack = `${result.url || ''} ${result.title || ''} ${result.snippet || ''}`;
            const score = scoreUrl(result.url, haystack, keywordGroups);
            const normalized = normalizeText(haystack);
            const negativeSignals = NEGATIVE_SIGNALS
                .filter(([, pattern]) => pattern.test(normalized))
                .map(([name]) => name);
            return {
                ...result,
                url_score: score.score,
                positive_signals: [...new Set(score.hits.map(hit => hit.category))],
                negative_signals: negativeSignals,
                hits: score.hits
            };
        })
        .sort((a, b) => {
            const rankDelta = (a.search_rank ?? Number.MAX_SAFE_INTEGER) - (b.search_rank ?? Number.MAX_SAFE_INTEGER);
            if (rankDelta !== 0) return rankDelta;
            return (b.url_score || 0) - (a.url_score || 0);
        });
}

export function selectSearchSeeds(rankedResults, {maxResults = 8} = {}) {
    const limit = Math.max(1, Number(maxResults) || 8);
    const selected = [];
    const selectedUrls = new Set();
    const add = result => {
        if (!result || selected.length >= limit || selectedUrls.has(result.url)) return;
        selected.push({...result, selected_seed: true});
        selectedUrls.add(result.url);
    };

    add(rankedResults[0]);
    for (const category of ['product', 'refinancing', 'fixed_rate', 'pricing', 'documents']) {
        add(rankedResults.find(result => result.positive_signals?.includes(category)));
    }
    for (const result of rankedResults) add(result);
    return selected;
}

export function aggregateSearchStatus(runs) {
    if (!runs.length || runs.every(run => run.status === 'unavailable')) return 'unavailable';
    if (runs.some(run => run.status !== 'ok')) return 'partial';
    return 'ok';
}

export function mergeSearchResults(runs) {
    const seen = new Set();
    const merged = [];
    for (const run of runs) {
        for (const result of run.results || []) {
            if (seen.has(result.url)) continue;
            seen.add(result.url);
            merged.push({...result, query: run.query});
        }
    }
    return merged;
}
