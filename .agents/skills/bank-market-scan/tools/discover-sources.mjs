#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Command} from 'commander';
import * as cheerio from 'cheerio';
import {XMLParser} from 'fast-xml-parser';
import pLimit from 'p-limit';
import {
    readJson,
    writeJson,
    writeJsonAtomic,
    ensureDir,
    fetchText,
    fetchBuffer,
    absolutizeUrl,
    normalizeText,
    slug,
    scoreUrl,
    todayIso,
    isProbablyPdfUrl,
    sourceRelation,
    sha256,
    normalizeUrlIdentity,
    sourceCacheFile,
    bundledPath,
    dataPath
} from './lib/common.mjs';
import {
    fetchGoogleSearch,
    normalizeSearchResultUrl
} from './search-provider.mjs';
import {
    aggregateSearchStatus,
    mergeSearchResults,
    rankSearchResults,
    selectSearchSeeds
} from './lib/discovery.mjs';
import {evaluateContent} from './lib/content-check.mjs';
import {normalizeMaterial} from './lib/material.mjs';
import {isCriticalSourceCandidate, isHardExcludedSourceCandidate, sourceBufferIntegrityErrors, validateCandidateCaches} from './lib/source-integrity.mjs';
import {DEFAULT_RANKING_TIMEOUT_MS, buildRankingManifest, buildSelectionReport, rankManifest, selectAdditionalPool, selectInitialPool} from './lib/url-ranking.mjs';
import {manifestIncludes, readRunManifest} from './lib/run-manifest.mjs';

const DEFAULT_SEARCH_QUERIES = [
    '"kredyt mieszkaniowy"',
    '"kredyt hipoteczny"',
    '"oprocentowanie okresowo stałe"'
];
const SECONDARY_SEARCH_QUERIES = [
    '("refinansowanie kredytu" OR "spłata wcześniejszego kredytu" OR "przeniesienie kredytu")',
    '("tabela oprocentowania" OR "opłaty i prowizje")'
];

const program = new Command();
program
    .option('--lp <number>', 'institution Lp', value => parseInt(value, 10))
    .option('--institution-id <id>', 'institution_id')
    .option('--url <url>', 'website URL override')
    .option('--institutions <path>', 'institutions JSON', dataPath('base/institutions.current.json'))
    .option('--max <number>', 'deprecated alias for --priority-max', value => parseInt(value, 10))
    .option('--priority-max <number>', 'max prioritized candidates', value => parseInt(value, 10), 30)
    .option('--full-max <number>', 'max broad candidate set kept in fallback cache', value => parseInt(value, 10), 120)
    .option('--seed-max <number>', 'max search-first seed URLs to fetch', value => parseInt(value, 10), 8)
    .option('--search-query <query>', 'override a search query; repeatable', (value, previous) => [...previous, value], [])
    .option('--google-host <host>', 'Google host', 'www.google.com')
    .option('--google-base-url <url>', 'override Google base URL; requires --enable-google-search')
    .option('--search-timeout-ms <number>', 'search timeout', value => parseInt(value, 10), 15000)
    .option('--enable-google-search', 'enable Google search; disabled by default')
    .option('--refresh', 'refresh cached candidate list')
    .option('--fresh', 'ignore previous candidates and monitored source baseline')
    .option('--run-id <id>', 'run identifier propagated to generated artifacts')
    .option('--run-manifest <path>', 'exact-scope run manifest')
    .option('--skip-unchanged', 'when refreshing, do not rewrite cached source files if content hash did not change')
    .option('--source-refresh-run-id <id>', 'source refresh cycle identifier')
    .option('--lightweight-refresh', 'refresh only previously monitored URLs; skip search, crawl and ranking')
    .option('--ranking-provider <provider>', 'URL ranking provider: auto or deterministic', value => {
        if (!['auto', 'deterministic'].includes(value)) throw new Error('Ranking provider must be auto or deterministic.');
        return value;
    }, 'deterministic')
    .option('--ranking-timeout-ms <number>', 'OpenCode ranking timeout', value => parseInt(value, 10), DEFAULT_RANKING_TIMEOUT_MS)
    .option('--fetch-timeout-ms <number>', 'per-URL fetch timeout', value => parseInt(value, 10), 8000)
    .option('--max-additional-pools <number>', 'maximum adaptive pools after the initial ranking pool', value => parseInt(value, 10), 1)
    .option('--url-ranking', 'deprecated alias for --ranking-provider auto')
    .option('--url-ranking-deterministic', 'compatibility alias for --ranking-provider deterministic')
    .option('--allow-external', 'deprecated; use allowed_source_hosts on the institution instead')
    .parse(process.argv);
const opts = program.opts();
if (!Number.isInteger(opts.fetchTimeoutMs) || opts.fetchTimeoutMs < 1) throw new Error('--fetch-timeout-ms must be a positive integer.');
if (!Number.isInteger(opts.maxAdditionalPools) || opts.maxAdditionalPools < 0) throw new Error('--max-additional-pools must be a non-negative integer.');

const keywords = await readJson(bundledPath('schemas/evidence-keywords.json'));
const institutions = opts.url ? null : await readJson(opts.institutions);
const inst = opts.url ? null : institutions.institutions.find(i => (opts.lp && i.lp === opts.lp) || (opts.institutionId && i.institution_id === opts.institutionId));
if (!opts.url && (opts.lp || opts.institutionId) && !inst) throw new Error('Institution not found.');
const baseUrl = opts.url || inst?.website_url;
if (!baseUrl) throw new Error('No website URL. Pass --url or valid --lp/--institution-id.');
const id = inst?.institution_id || `manual_${slug(baseUrl)}`;
const runManifest = opts.runManifest ? await readRunManifest(opts.runManifest) : null;
if (runManifest && !manifestIncludes(runManifest, id, inst?.lp)) {
    throw new Error(`Record outside run manifest: institution_id=${id} lp=${inst?.lp ?? 'manual'}`);
}
const cacheDir = dataPath('cache/institutions', `${String(inst?.lp ?? 'manual').padStart(3, '0')}-${slug(inst?.name || baseUrl)}`);
await ensureDir(cacheDir);
const outFile = path.join(cacheDir, 'candidates.json');
const runId = runManifest?.run_id || opts.runId || `run-${Date.now()}-${process.pid}`;
const rankingProvider = opts.urlRanking
    ? 'auto'
    : (opts.urlRankingDeterministic ? 'deterministic' : (opts.rankingProvider || 'deterministic'));
const googleSearchEnabled = runManifest ? runManifest.search_enabled === true : Boolean(opts.enableGoogleSearch);
if (opts.urlRanking) console.error('Warning: --url-ranking is deprecated; ranking now runs automatically after discovery.');

let previous = null;
if (!opts.fresh) {
    try {
        previous = JSON.parse(await fs.readFile(outFile, 'utf8'));
    } catch {
    }
}
if (!opts.refresh && previous) {
    console.log(JSON.stringify(previous, null, 2));
    process.exit(0);
}

const baseHost = new URL(baseUrl).hostname;
const allowedHosts = [baseHost, ...(Array.isArray(inst?.allowed_source_hosts) ? inst.allowed_source_hosts : [])];
const previousByUrl = new Map((previous?.all_candidates || previous?.candidates || []).map(candidate => [String(candidate.url).split('#')[0], candidate]));
const previousMonitoredUrls = [...new Set(
    previous?.monitored_urls
    || (previous?.candidates || []).map(candidate => candidate.final_url || candidate.url)
)];
const prioritizedMax = opts.max ?? opts.priorityMax;
const discoveryStartedAt = Date.now();
const fetchCounts = {
    search_results: 0,
    seed_urls: 0,
    previous_monitored_urls: 0,
    fallback_urls: 0,
    conditional_304: 0,
    material_normalized: 0
};
const sourceMetadataByUrl = new Map();

async function tryFetch(url) {
    try {
        return await fetchText(url, {timeoutMs: opts.fetchTimeoutMs});
    } catch (error) {
        return {ok: false, status: 0, text: '', error: error.message, finalUrl: url, contentType: ''};
    }
}

function normalizeAllowedUrl(url) {
    return normalizeSearchResultUrl(url, {allowedHosts});
}

function registerFinalHost(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (hostname && !allowedHosts.includes(hostname)) allowedHosts.push(hostname);
    } catch {
        // Ignore malformed redirect targets; URL validation remains the gate.
    }
}

function addCandidate(target, collection, source) {
    const url = normalizeAllowedUrl(target.url);
    if (!url) return;
    const relation = sourceRelation(url, baseUrl);
    const score = target.url_score == null
        ? scoreUrl(url, target.title || '', keywords)
        : {score: target.url_score, hits: target.hits || []};
    collection.push({
        url,
        title: target.title || url,
        snippet: target.snippet || '',
        source,
        query: target.query || null,
        search_rank: target.search_rank ?? null,
        relation,
        score: score.score,
        url_score: score.score,
        hits: score.hits,
        positive_signals: target.positive_signals || [...new Set(score.hits.map(hit => hit.category))],
        negative_signals: target.negative_signals || [],
        broad_candidate: true,
        prioritized_candidate: score.score > 0,
        selected_seed: target.selected_seed === true
    });
}

function uniqueCandidates(candidates) {
    const seen = new Set();
    return candidates.filter(candidate => {
        const identity = normalizeUrlIdentity(candidate.url);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

function historicalCandidates() {
    return previousMonitoredUrls.map(url => {
        const previousCandidate = previousByUrl.get(url);
        return previousCandidate
            ? {...previousCandidate, url, selected_seed: false, source: 'previous_monitored'}
            : {
                url,
                title: url,
                source: 'previous_monitored',
                relation: sourceRelation(url, baseUrl),
                score: 0,
                url_score: 0,
                hits: [],
                positive_signals: [],
                negative_signals: [],
                broad_candidate: true,
                prioritized_candidate: false,
                selected_seed: false
            };
    });
}

async function fetchCandidates(candidates) {
    const limit = pLimit(5);
    return Promise.all(candidates.map(candidate => limit(async () => {
        if (candidate.source === 'search') fetchCounts.seed_urls += 1;
        if (candidate.source === 'previous_monitored') fetchCounts.previous_monitored_urls += 1;
        if (candidate.source === 'crawl' || candidate.source === 'homepage' || candidate.source === 'sitemap') fetchCounts.fallback_urls += 1;
        const fileName = `${slug(candidate.title || candidate.url, 50)}-${slug(candidate.url, 30)}`;
        const previousCandidate = previousByUrl.get(candidate.url);
            const sourceMetadata = sourceMetadataByUrl.get(normalizeUrlIdentity(candidate.url)) || {};
            const meta = {
                ...sourceMetadata,
                ...candidate,
            fetched_at: todayIso(),
            available: null,
            status: null,
            content_type: null,
            content_sha256: null,
            previous_sha256: previousCandidate?.content_sha256 || null,
            content_length: null,
            changed_since_last_fetch: null,
            cache_file: null,
            material_sha256: null,
            etag: null,
            last_modified: null,
            conditional_304: false
        };
        try {
            const expectedPreviousExtension = isProbablyPdfUrl(candidate.url) || /pdf/i.test(previousCandidate?.content_type || '') ? '.pdf' : '.html';
            const expectedCacheFile = sourceCacheFile(cacheDir, candidate.url, expectedPreviousExtension);
            let previousCacheIsCanonical = previousCandidate?.cache_file === expectedCacheFile;
            if (previousCacheIsCanonical && previousCandidate?.content_sha256) {
                try {
                    const previousBuffer = await fs.readFile(previousCandidate.cache_file);
                    previousCacheIsCanonical = sourceBufferIntegrityErrors(previousCandidate, previousBuffer).length === 0;
                } catch {
                    previousCacheIsCanonical = false;
                }
            }
            const conditionalHeaders = {};
            if (previousCacheIsCanonical && previousCandidate?.etag) conditionalHeaders['if-none-match'] = previousCandidate.etag;
            if (previousCacheIsCanonical && previousCandidate?.last_modified) conditionalHeaders['if-modified-since'] = previousCandidate.last_modified;
            const response = await fetchBuffer(candidate.url, {timeoutMs: opts.fetchTimeoutMs, headers: conditionalHeaders});
            if (response.status === 304 && previousCandidate && previousCacheIsCanonical) {
                fetchCounts.conditional_304 += 1;
                let materialSha = previousCandidate.material_sha256 || null;
                let materialChanged = false;
                if (!materialSha && previousCandidate.cache_file) {
                    const cachedBuffer = await fs.readFile(previousCandidate.cache_file);
                    const material = await normalizeMaterial(cachedBuffer, {
                        contentType: previousCandidate.content_type || '',
                        fileName: previousCandidate.cache_file
                    });
                    materialSha = material.material_sha256;
                    materialChanged = true;
                    fetchCounts.material_normalized += 1;
                }
                Object.assign(meta, {
                    available: previousCandidate.available !== false,
                    status: 304,
                    content_type: previousCandidate.content_type || response.contentType,
                    content_sha256: previousCandidate.content_sha256 || null,
                    previous_sha256: previousCandidate.content_sha256 || null,
                    content_length: previousCandidate.content_length || null,
                    changed_since_last_fetch: false,
                    cache_file: previousCandidate.cache_file || null,
                    material_sha256: materialSha,
                    offer_changed_since_last_fetch: materialChanged,
                    etag: response.etag || previousCandidate.etag || null,
                    last_modified: response.lastModified || previousCandidate.last_modified || null,
                    conditional_304: true,
                    final_url: previousCandidate.final_url || candidate.url
                });
                return meta;
            }
            const contentHash = sha256(response.buffer);
            const unchangedTransport = Boolean(previousCandidate?.content_sha256 && previousCandidate.content_sha256 === contentHash);
            meta.available = response.ok;
            meta.status = response.status;
            meta.content_type = response.contentType;
            meta.final_url = normalizeAllowedUrl(response.finalUrl || candidate.url) || candidate.url;
            meta.content_sha256 = contentHash;
            meta.content_length = response.buffer.length;
            meta.etag = response.etag || previousCandidate?.etag || null;
            meta.last_modified = response.lastModified || previousCandidate?.last_modified || null;
            meta.changed_since_last_fetch = previousCandidate ? !unchangedTransport : true;
            const ext = isProbablyPdfUrl(candidate.url) || /pdf/i.test(response.contentType) ? '.pdf' : '.html';
            const cacheFile = sourceCacheFile(cacheDir, candidate.url, ext);
            if (!(unchangedTransport && opts.skipUnchanged && previousCacheIsCanonical)) await fs.writeFile(cacheFile, response.buffer);
            meta.cache_file = cacheFile;
            meta.requested_url = candidate.url;
            meta.source_integrity_flags = [];
            if (/html/i.test(response.contentType)) {
                const $ = cheerio.load(response.buffer.toString('utf8'));
                const canonical = $('link[rel="canonical"]').attr('href');
                const canonicalUrl = canonical ? absolutizeUrl(canonical, response.finalUrl || candidate.url) : null;
                meta.canonical_url = canonicalUrl;
                meta.html_title = $('title').first().text().trim() || null;
                if (canonicalUrl && normalizeUrlIdentity(canonicalUrl) !== normalizeUrlIdentity(candidate.url)) {
                    meta.source_integrity_flags.push('source_url_mismatch');
                    meta.source_integrity_severity = isCriticalSourceCandidate(candidate) ? 'error' : 'warning';
                }
            }
            if (response.ok && (previousCandidate?.material_sha256 == null || !unchangedTransport)) {
                const material = await normalizeMaterial(response.buffer, {
                    contentType: response.contentType,
                    fileName: cacheFile
                });
                fetchCounts.material_normalized += 1;
                meta.material_sha256 = material.material_sha256;
                meta.offer_changed_since_last_fetch = previousCandidate
                    ? previousCandidate.material_sha256 !== material.material_sha256
                    : true;
            } else {
                meta.material_sha256 = previousCandidate?.material_sha256 || null;
                meta.offer_changed_since_last_fetch = previousCandidate ? !unchangedTransport : true;
            }
            if (!response.ok) meta.offer_changed_since_last_fetch = true;
        } catch (error) {
            meta.available = false;
            meta.error = error.message;
            meta.changed_since_last_fetch = previousCandidate ? true : null;
            meta.offer_changed_since_last_fetch = true;
        }
        return meta;
    })));
}

async function runLightweightRefresh() {
    if (!previous || previousMonitoredUrls.length === 0) return false;
    const refreshed = await fetchCandidates(historicalCandidates());
    const refreshedByUrl = new Map(refreshed.map(candidate => [normalizeUrlIdentity(candidate.final_url || candidate.url), candidate]));
    const allCandidates = uniqueCandidates((previous.all_candidates || previous.candidates || []).map(candidate => {
        const refreshedCandidate = refreshedByUrl.get(normalizeUrlIdentity(candidate.final_url || candidate.url));
        return refreshedCandidate ? {...candidate, ...refreshedCandidate} : candidate;
    }));
    const monitoredCandidates = refreshed.filter(candidate => candidate.available !== false);
    const offerChanged = refreshed.some(candidate => candidate.offer_changed_since_last_fetch === true);
    const output = {
        ...previous,
        run_id: runId,
        fetched_at: todayIso(),
        sources_refreshed_at: new Date().toISOString(),
        source_refresh_run_id: opts.sourceRefreshRunId || null,
        discovery_mode: 'lightweight_refresh',
        discovery_changed_since_last_fetch: false,
        offer_changed_since_last_fetch: offerChanged,
        monitored_urls: monitoredCandidates.map(candidate => candidate.final_url || candidate.url),
        previous_monitored_urls: previousMonitoredUrls,
        candidates: monitoredCandidates,
        all_candidates: allCandidates,
        fetch_counts: fetchCounts,
        timings_ms: {...(previous.timings_ms || {}), search: 0, fallback_crawl: 0, ranking: 0, total: Date.now() - discoveryStartedAt},
        google_search_enabled: false,
        fallback_trigger_reason: 'lightweight_changed_only_refresh',
        url_ranking: previous.url_ranking ? {...previous.url_ranking, provider: 'not_run_lightweight_refresh', mode: 'lightweight_refresh'} : null
    };
    await writeJsonAtomic(outFile, output);
    console.log(JSON.stringify(output, null, 2));
    return true;
}

if (opts.lightweightRefresh && await runLightweightRefresh()) process.exit(0);

async function runSearchWave(queries) {
    const runs = await Promise.all(queries.map(async query => {
        const startedAt = Date.now();
        const result = await fetchGoogleSearch(query, {
            allowedHosts,
            googleHost: opts.googleHost,
            googleBaseUrl: opts.googleBaseUrl,
            maxResults: 10,
            timeoutMs: opts.searchTimeoutMs
        });
        return {...result, elapsed_ms: Date.now() - startedAt};
    }));
    const merged = mergeSearchResults(runs);
    const ranked = rankSearchResults(merged, keywords);
    const selected = selectSearchSeeds(ranked, {maxResults: opts.seedMax});
    const inventoryCandidates = [];
    ranked.forEach(candidate => addCandidate(candidate, inventoryCandidates, 'search'));
    const searchCandidates = [];
    selected.forEach(candidate => addCandidate(candidate, searchCandidates, 'search'));
    return {
        runs,
        status: aggregateSearchStatus(runs),
        ranked,
        selected,
        inventory: uniqueCandidates(inventoryCandidates),
        candidates: uniqueCandidates(searchCandidates)
    };
}

async function runSearchFirst() {
    const queries = opts.searchQuery.length
        ? opts.searchQuery
        : DEFAULT_SEARCH_QUERIES.map(query => `site:${baseHost} ${query}`);
    return runSearchWave(queries);
}

function disabledSearchResult() {
    return {
        runs: [{query: null, status: 'unavailable', diagnostic_code: 'google_search_disabled', results: []}],
        status: 'unavailable',
        ranked: [],
        selected: [],
        inventory: [],
        candidates: []
    };
}

async function runLegacyCrawl() {
    const discovered = [];
    const home = await tryFetch(baseUrl);
    if (home.ok) {
        // A bank may have moved from an old hostname to a new canonical domain.
        // Trust the final host of the explicitly configured homepage for its links.
        registerFinalHost(home.finalUrl || baseUrl);
        const $ = cheerio.load(home.text);
        $('a[href]').each((_, anchor) => addCandidate({
            url: absolutizeUrl($(anchor).attr('href'), home.finalUrl || baseUrl),
            title: $(anchor).text()
        }, discovered, 'homepage'));
    }

    for (const sitemapPath of ['/sitemap.xml', '/sitemap_index.xml']) {
        try {
            const sitemapUrl = new URL(sitemapPath, baseUrl).toString();
            const response = await tryFetch(sitemapUrl);
            if (!response.ok || !/xml/i.test(response.contentType + response.text.slice(0, 50))) continue;
            const parser = new XMLParser({ignoreAttributes: false});
            const xml = parser.parse(response.text);
            const locations = [];
            const walk = value => {
                if (!value || typeof value !== 'object') return;
                for (const [key, child] of Object.entries(value)) {
                    if (key === 'loc') locations.push(Array.isArray(child) ? child.join(' ') : child);
                    else if (Array.isArray(child)) child.forEach(walk);
                    else walk(child);
                }
            };
            walk(xml);
            locations.forEach(url => addCandidate({url, title: url}, discovered, 'sitemap'));
        } catch {
        }
    }

    const unique = uniqueCandidates(discovered).slice(0, opts.fullMax);
    return {home, candidates: unique};
}

const searchStartedAt = Date.now();
const firstSearch = googleSearchEnabled ? await runSearchFirst() : disabledSearchResult();
let searchElapsedMs = Date.now() - searchStartedAt;
let fallbackElapsedMs = 0;
let searchRuns = firstSearch.runs;
let searchStatus = firstSearch.status;
let rankedSearchResults = firstSearch.ranked;
let selectedSearchResults = firstSearch.selected;
let searchInventoryCandidates = firstSearch.inventory;
let selectedCandidates = uniqueCandidates([...firstSearch.candidates, ...historicalCandidates()]);
let fallback = searchStatus === 'unavailable';
let fallbackTriggerReason = fallback
    ? firstSearch.runs[0]?.diagnostic_code || 'search_provider_unavailable'
    : null;
let crawl = {home: null, candidates: []};
let urlRanking = null;
let rankingElapsedMs = 0;
let fallbackStartedAt = null;
let expansionStopReason = null;
let earlyStopReason = null;

async function rankDiscoveryInventory(candidates, mode) {
    if (!candidates.length) {
        return {
            provider: 'not_run_empty_inventory',
            mode: 'automatic_after_discovery',
            discoveryMode: mode,
            selected_pool: [],
            manifest: null,
            rankingMs: 0,
            attempts: []
        };
    }

    const manifest = buildRankingManifest({
        institution: {
            institution_id: id,
            lp: inst?.lp ?? null,
            name: inst?.name ?? ''
        },
        homepageUrl: baseUrl,
        runId,
        candidates,
        discovery: {
            mode,
            complete: true
        }
    });
    for (const candidate of candidates) {
        sourceMetadataByUrl.set(normalizeUrlIdentity(candidate.url), candidate);
    }
    const startedAt = Date.now();
    const result = await rankManifest(manifest, {
        useOpenCode: rankingProvider === 'auto',
        ...(opts.rankingTimeoutMs ? {timeoutMs: opts.rankingTimeoutMs} : {})
    });
    const rankingMs = Math.max(0, Date.now() - startedAt);
    const selectedPool = selectInitialPool(result.ranking, manifest.candidates);
    return {
        ...result,
        mode: 'automatic_after_discovery',
        discoveryMode: mode,
        manifest,
        selected_pool: selectedPool.map(candidate => candidate.url),
        rankingMs
    };
}
const seedFetchStartedAt = Date.now();
let fetched = await fetchCandidates(selectedCandidates);
let seedFetchElapsedMs = Date.now() - seedFetchStartedAt;
let searchContentCheck = await evaluateContent(fetched, keywords, {institution_id: id});

if (!fallback && !searchContentCheck.sufficient_for_search_first && !opts.searchQuery.length) {
    const secondary = await runSearchWave(SECONDARY_SEARCH_QUERIES.map(query => `site:${baseHost} ${query}`));
    searchElapsedMs = Date.now() - searchStartedAt;
    searchRuns = [...searchRuns, ...secondary.runs];
    searchStatus = aggregateSearchStatus(searchRuns);
    const merged = mergeSearchResults(searchRuns);
    rankedSearchResults = rankSearchResults(merged, keywords);
    selectedSearchResults = selectSearchSeeds(rankedSearchResults, {maxResults: opts.seedMax});
    searchInventoryCandidates = uniqueCandidates([
        ...searchInventoryCandidates,
        ...secondary.inventory
    ]);
    const selectedUrls = new Set(fetched.map(candidate => candidate.url));
    const secondaryCandidates = [];
    selectedSearchResults.forEach(candidate => {
        if (selectedUrls.has(candidate.url)) return;
        const newCandidates = [];
        addCandidate(candidate, newCandidates, 'search');
        secondaryCandidates.push(...newCandidates);
    });
    selectedCandidates = uniqueCandidates([...historicalCandidates(), ...secondaryCandidates]);
    const secondarySeedFetchStartedAt = Date.now();
    fetched = [...fetched, ...(await fetchCandidates(uniqueCandidates(secondaryCandidates)))];
    seedFetchElapsedMs += Date.now() - secondarySeedFetchStartedAt;
    searchContentCheck = await evaluateContent(fetched, keywords, {institution_id: id});
}

if (!fallback) {
    if (!selectedSearchResults.length) {
        fallback = true;
        fallbackTriggerReason = 'no_search_results';
    } else if (fetched.length > 0 && fetched.every(candidate => !candidate.available)) {
        fallback = true;
        fallbackTriggerReason = 'selected_sources_unavailable';
    } else if (!searchContentCheck.sufficient_for_search_first) {
        fallback = true;
        fallbackTriggerReason = 'insufficient_content_signals';
    }
}

if (fallback) {
    fallbackStartedAt = Date.now();
    crawl = await runLegacyCrawl();
    const rankingCandidates = uniqueCandidates([
        ...fetched,
        ...searchInventoryCandidates,
        ...historicalCandidates(),
        ...crawl.candidates
    ]);
    urlRanking = await rankDiscoveryInventory(rankingCandidates, 'crawl_fallback');
    rankingElapsedMs = urlRanking.rankingMs;
} else {
    const rankingCandidates = uniqueCandidates([
        ...fetched,
        ...searchInventoryCandidates,
        ...historicalCandidates()
    ]);
    urlRanking = await rankDiscoveryInventory(rankingCandidates, 'search_first');
    rankingElapsedMs = urlRanking.rankingMs;
}

const selectionFetchStartedAt = Date.now();
const initialPool = urlRanking?.ranking && urlRanking.manifest && !searchContentCheck.single_url_full_coverage
    ? selectInitialPool(urlRanking.ranking, urlRanking.manifest.candidates)
    : [];
if (searchContentCheck.single_url_full_coverage) earlyStopReason = 'single_product_page_complete_criteria';
const alreadyFetched = new Set(fetched
    .flatMap(candidate => [candidate.url, candidate.final_url])
    .filter(Boolean)
    .map(normalizeUrlIdentity));
const initialCandidates = initialPool.filter(candidate => !alreadyFetched.has(normalizeUrlIdentity(candidate.url)));
fetched = [...fetched, ...(await fetchCandidates(initialCandidates))];

const expandedPools = [];
const expansionReasons = [];
let additionalPoolCount = 0;
let finalContentCheck;
while (true) {
    finalContentCheck = await evaluateContent(uniqueCandidates(fetched), keywords, {institution_id: id});
    const missingCategories = ['product', 'refinancing', 'fixed_rate']
        .filter(category => finalContentCheck[category]?.status !== 'present');
    if (!urlRanking?.ranking || missingCategories.length === 0) break;
    if (additionalPoolCount >= opts.maxAdditionalPools) {
        expansionStopReason = 'max_additional_pools_reached';
        break;
    }

    const additionalPool = selectAdditionalPool(urlRanking.ranking, urlRanking.manifest.candidates, {
        alreadyFetchedUrls: fetched
            .flatMap(candidate => [candidate.url, candidate.final_url])
            .filter(Boolean),
        missingCategories,
        limit: 8
    });
    if (additionalPool.length === 0) break;

    const additionalUrls = additionalPool.map(candidate => candidate.url);
    additionalPoolCount += 1;
    expandedPools.push(additionalUrls);
    expansionReasons.push({missing_categories: missingCategories, selected_urls: additionalUrls});
    fetched = [...fetched, ...(await fetchCandidates(additionalPool))];
}

if (fallbackStartedAt !== null) fallbackElapsedMs = Date.now() - fallbackStartedAt;
const fetchedCandidates = uniqueCandidates(fetched);
if (urlRanking?.selectionReportPath) {
    await writeJson(urlRanking.selectionReportPath, buildSelectionReport(urlRanking.manifest, urlRanking.ranking, {
        provider: urlRanking.provider,
        selectedPool: initialPool,
        expandedPools,
        expansionReasons,
        maxAdditionalPools: opts.maxAdditionalPools,
        expansionStopReason,
        fetchedUrls: fetchedCandidates.map(candidate => candidate.final_url || candidate.url),
        skippedUrls: urlRanking.manifest.candidates
            .filter(candidate => !fetchedCandidates.some(fetchedCandidate =>
                normalizeUrlIdentity(fetchedCandidate.final_url || fetchedCandidate.url) === normalizeUrlIdentity(candidate.url)
            ))
            .map(candidate => candidate.url),
        rankingMs: urlRanking.rankingMs,
        fetchMs: Math.max(0, Date.now() - selectionFetchStartedAt)
    }));
}

const allCandidates = uniqueCandidates([
    ...fetched,
    ...searchInventoryCandidates,
    ...historicalCandidates(),
    ...(fallback ? crawl.candidates : [])
]);
const cacheIntegrityErrors = await validateCandidateCaches(allCandidates);
const sourceUrlMismatchCount = allCandidates.filter(candidate => (candidate.source_integrity_flags || []).includes('source_url_mismatch')).length;
const integrityErrors = [
    ...cacheIntegrityErrors,
    ...(finalContentCheck.integrity_errors || []).map(error => ({type: error, source: 'content_check'}))
];
const integrityWarnings = (finalContentCheck.integrity_warnings || []).map(error => ({type: error, source: 'content_check'}));
const prioritized = allCandidates
    .filter(candidate => candidate.prioritized_candidate && !isHardExcludedSourceCandidate(candidate))
    .slice(0, prioritizedMax);
const relevantUrls = new Set(finalContentCheck.coverage_urls || []);
const relevantCandidates = allCandidates.filter(candidate => relevantUrls.has(candidate.final_url || candidate.url));
// Keep fetched failures and canonical mismatches in all_candidates for diagnostics,
// but never expose them to extraction, evidence, monitoring, or the review pack.
const activeCandidates = fetchedCandidates.filter(candidate => !isHardExcludedSourceCandidate(candidate));
if (urlRanking?.ranking && urlRanking.outputPath) {
    const hardExcludedIds = new Set(allCandidates
        .filter(isHardExcludedSourceCandidate)
        .map(candidate => candidate.candidate_id)
        .filter(Boolean));
    const hardExcludedUrls = new Set(allCandidates
        .filter(isHardExcludedSourceCandidate)
        .map(candidate => normalizeUrlIdentity(candidate.final_url || candidate.url)));
    const sanitizedRanking = {
        ...urlRanking.ranking,
        ranked_candidates: (urlRanking.ranking.ranked_candidates || []).filter(candidate =>
            !hardExcludedIds.has(candidate.candidate_id)
            && !hardExcludedUrls.has(normalizeUrlIdentity(candidate.url))
        )
    };
    urlRanking.ranking = sanitizedRanking;
    await writeJsonAtomic(urlRanking.outputPath, sanitizedRanking);
    const finalSelectionPool = selectInitialPool(sanitizedRanking, activeCandidates);
    urlRanking.selected_pool = finalSelectionPool.map(candidate => candidate.url);
    await writeJson(urlRanking.selectionReportPath, buildSelectionReport(urlRanking.manifest, sanitizedRanking, {
        provider: urlRanking.provider,
        selectedPool: finalSelectionPool,
        expandedPools,
        expansionReasons,
        expansionStopReason,
        fetchedUrls: activeCandidates.map(candidate => candidate.final_url || candidate.url),
        skippedUrls: urlRanking.manifest.candidates
            .filter(candidate => !activeCandidates.some(activeCandidate =>
                normalizeUrlIdentity(activeCandidate.final_url || activeCandidate.url) === normalizeUrlIdentity(candidate.url)
            ))
            .map(candidate => candidate.url),
        maxAdditionalPools: opts.maxAdditionalPools,
        rankingMs: urlRanking.rankingMs,
        fetchMs: Math.max(0, Date.now() - selectionFetchStartedAt)
    }));
}
const monitoredUrls = [...new Set(activeCandidates.map(candidate => candidate.final_url || candidate.url))];
const previousBaselineAvailable = Boolean(previous && previousMonitoredUrls.length);
const discoveryChangedSinceLastFetch = previousBaselineAvailable
    ? previous.search_results_sha256 !== sha256(JSON.stringify(rankedSearchResults))
    : true;
const monitoredCandidates = activeCandidates.filter(candidate => monitoredUrls.includes(candidate.final_url || candidate.url));
const offerChangedSinceLastFetch = !previousBaselineAvailable
    || monitoredCandidates.some(candidate => candidate.offer_changed_since_last_fetch === true)
    || (searchStatus === 'unavailable' && !finalContentCheck.sufficient_for_analysis);
const homepageHash = crawl.home?.ok ? sha256(crawl.home.text) : null;
const previousHomepageHash = previous?.homepage_sha256 || null;
const preprocessingRiskFlags = [];
if (allCandidates.length < 5) preprocessingRiskFlags.push('few_sources');
if (prioritized.length === 0) preprocessingRiskFlags.push('no_priority_candidates');
if (allCandidates.length > 0 && allCandidates.every(candidate => candidate.source === 'homepage')) preprocessingRiskFlags.push('homepage_links_only');
if (!allCandidates.some(candidate => isProbablyPdfUrl(candidate.url) || /pdf/i.test(candidate.content_type || ''))) preprocessingRiskFlags.push('no_pdf_candidates');
if (prioritized.length > 0 && prioritized.every(candidate => candidate.score <= 2)) preprocessingRiskFlags.push('only_low_scored_candidates');

const searchQualityFlags = [];
if (searchStatus === 'unavailable') searchQualityFlags.push('search_provider_unavailable');
if (!rankedSearchResults.length) searchQualityFlags.push('no_search_results');
if (finalContentCheck.product.status === 'present') searchQualityFlags.push('strong_product_url_found');
if (finalContentCheck.refinancing.status === 'present') searchQualityFlags.push('strong_refinancing_url_found');
if (finalContentCheck.fixed_rate.status === 'present') searchQualityFlags.push('strong_fixed_rate_url_found');
if (finalContentCheck.product.status !== 'present') searchQualityFlags.push('insufficient_product_signals');
if (finalContentCheck.refinancing.status !== 'present') searchQualityFlags.push('insufficient_refinancing_signals');
if (finalContentCheck.fixed_rate.status !== 'present') searchQualityFlags.push('insufficient_fixed_rate_signals');
if (!searchContentCheck.sufficient_for_search_first) searchQualityFlags.push('insufficient_content_signals');
if (fallback && fallbackTriggerReason === 'selected_sources_unavailable') searchQualityFlags.push('selected_sources_unavailable');

const searchQueries = searchRuns.map(run => ({
    query: run.query,
    status: run.status,
    diagnostic_code: run.diagnostic_code || null,
    elapsed_ms: run.elapsed_ms,
    result_count: run.results?.length || 0
}));
const searchResults = rankedSearchResults;
fetchCounts.search_results = searchResults.length;
const output = {
    institution_id: id,
    lp: inst?.lp ?? null,
    name: inst?.name ?? '',
    website_url: baseUrl,
    fetched_at: todayIso(),
    discovery_mode: fallback ? 'crawl_fallback' : 'search_first',
    search_provider_status: searchStatus,
    search_queries: searchQueries,
    search_results: searchResults,
    search_queries_sha256: sha256(JSON.stringify(searchRuns.map(run => normalizeText(run.query)))),
    search_results_sha256: sha256(JSON.stringify(searchResults)),
    selected_seed_urls: selectedSearchResults.map(candidate => candidate.url),
    previous_monitored_urls: previousMonitoredUrls,
    monitored_urls: monitoredUrls,
    baseline_available: previousBaselineAvailable,
    discovery_changed_since_last_fetch: discoveryChangedSinceLastFetch,
    offer_changed_since_last_fetch: offerChangedSinceLastFetch,
    source_refresh_run_id: opts.sourceRefreshRunId || null,
    run_id: runId,
    sources_refreshed_at: new Date().toISOString(),
    timings_ms: {
        search: searchElapsedMs,
        seed_fetch: seedFetchElapsedMs,
        fallback_crawl: fallbackElapsedMs || 0,
        ranking: rankingElapsedMs,
        total: Date.now() - discoveryStartedAt
    },
    fetch_counts: fetchCounts,
    fetch_timeout_ms: opts.fetchTimeoutMs,
    google_search_enabled: googleSearchEnabled,
    fallback_trigger_reason: fallbackTriggerReason,
    early_stop_reason: earlyStopReason,
    url_ranking: urlRanking ? {
        provider: urlRanking.provider,
        mode: urlRanking.mode,
        manifest_path: urlRanking.manifestPath,
        raw_response_path: urlRanking.rawPath,
        ranking_path: urlRanking.outputPath,
        validation_report_path: urlRanking.validationPath,
        selection_report_path: urlRanking.selectionReportPath || null,
        candidate_count: urlRanking.manifest?.discovery?.candidate_count || 0,
        model_candidate_count: urlRanking.manifest?.discovery?.model_candidate_count || 0,
        locked_noise_count: urlRanking.manifest?.discovery?.locked_noise_count || 0,
        inventory_sha256: urlRanking.manifest?.discovery?.inventory_sha256 || null,
         selected_pool: urlRanking.selected_pool || [],
         expanded_pools: expandedPools,
         expansion_reasons: expansionReasons,
         max_additional_pools: opts.maxAdditionalPools,
         expansion_stop_reason: expansionStopReason,
         attempts: urlRanking.attempts?.length || 0,
        fallback_reason: urlRanking.provider.startsWith('deterministic') && rankingProvider === 'auto'
            ? urlRanking.provider
            : null
    } : null,
    search_quality_flags: searchQualityFlags,
    content_quality_summary: {
        product: finalContentCheck.product.status,
        refinancing: finalContentCheck.refinancing.status,
        fixed_rate: finalContentCheck.fixed_rate.status,
        readable_source_count: finalContentCheck.readable_source_count,
        unknown_source_count: finalContentCheck.unknown_source_count
    },
    content_check: finalContentCheck,
    cache_integrity_errors: integrityErrors,
    source_url_mismatch_count: sourceUrlMismatchCount,
    critical_source_url_mismatch_count: allCandidates.filter(candidate =>
        (candidate.source_integrity_flags || []).includes('source_url_mismatch')
        && candidate.source_integrity_severity === 'error'
    ).length,
    integrity_warnings: integrityWarnings,
    product_relation: finalContentCheck.product_relation,
    sufficient_for_search_first: searchContentCheck.sufficient_for_search_first && integrityErrors.length === 0,
    sufficient_for_analysis: finalContentCheck.sufficient_for_analysis && integrityErrors.length === 0,
    sufficiency_basis: finalContentCheck.sufficiency_basis,
    homepage_available: crawl.home ? crawl.home.ok : null,
    homepage_status: crawl.home?.status ?? null,
    homepage_sha256: homepageHash,
    previous_homepage_sha256: previousHomepageHash,
    homepage_changed_since_last_fetch: crawl.home
        ? (previousHomepageHash ? previousHomepageHash !== homepageHash : crawl.home.ok)
        : null,
    broad_candidate_count: allCandidates.length,
    prioritized_candidate_count: prioritized.length,
    preprocessing_risk_flags: preprocessingRiskFlags,
    candidates: activeCandidates,
    all_candidates: allCandidates
};
await writeJsonAtomic(outFile, output);
console.log(JSON.stringify(output, null, 2));
