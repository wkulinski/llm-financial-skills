#!/usr/bin/env node
import {Command} from 'commander';
import * as cheerio from 'cheerio';
import {fileURLToPath} from 'node:url';

const DEFAULT_GOOGLE_HOST = 'www.google.com';
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 bank-market-scan search-provider';
const TRACKING_PARAM_NAMES = new Set([
    'dclid',
    'fbclid',
    'gclid',
    'gbraid',
    'mc_cid',
    'mc_eid',
    'msclkid',
    'referrer',
    'wbraid'
]);

function cleanWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHost(value) {
    return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.$/, '');
}

function withoutWww(hostname) {
    return normalizeHost(hostname).replace(/^www\./, '');
}

function isGoogleHost(hostname) {
    const host = normalizeHost(hostname);
    return host === 'google.com' || host.endsWith('.google.com') || host === 'google.pl' || host.endsWith('.google.pl');
}

function decodeRepeatedly(value, maxPasses = 3) {
    let decoded = String(value || '');
    for (let i = 0; i < maxPasses; i++) {
        let next;
        try {
            next = decodeURIComponent(decoded);
        } catch {
            break;
        }
        if (next === decoded) break;
        decoded = next;
    }
    return decoded;
}

function extractGoogleTarget(rawHref) {
    let candidate = String(rawHref || '').trim();
    if (!candidate) return null;

    for (let i = 0; i < 3; i++) {
        let parsed;
        try {
            parsed = new URL(candidate, `https://${DEFAULT_GOOGLE_HOST}`);
        } catch {
            return null;
        }

        if (isGoogleHost(parsed.hostname) && parsed.pathname === '/url') {
            const target = parsed.searchParams.get('q')
                || parsed.searchParams.get('url')
                || parsed.searchParams.get('u');
            if (!target) return null;
            candidate = decodeRepeatedly(target);
            continue;
        }

        candidate = decodeRepeatedly(candidate);
        try {
            const target = new URL(candidate);
            if (isGoogleHost(target.hostname) && target.pathname === '/url') continue;
        } catch {
        }
        return candidate;
    }

    return candidate;
}

function isAllowedHost(hostname, allowedHosts) {
    if (!allowedHosts?.length) return true;
    const host = normalizeHost(hostname);
    return allowedHosts.some(allowed => {
        const expected = normalizeHost(allowed);
        return host === expected
            || host.endsWith(`.${expected}`)
            || withoutWww(host) === withoutWww(expected);
    });
}

export function buildGoogleSearchUrl(query, {
    googleHost = DEFAULT_GOOGLE_HOST,
    googleBaseUrl = null,
    maxResults = DEFAULT_MAX_RESULTS,
    language = 'pl',
    country = 'pl'
} = {}) {
    const url = new URL('/search', googleBaseUrl || `https://${normalizeHost(googleHost)}`);
    url.searchParams.set('q', String(query || '').trim());
    url.searchParams.set('num', String(Math.max(1, Math.min(100, Number(maxResults) || DEFAULT_MAX_RESULTS))));
    if (language) url.searchParams.set('hl', language);
    if (country) url.searchParams.set('gl', country);
    return url.toString();
}

export function normalizeSearchResultUrl(rawHref, {allowedHosts = []} = {}) {
    const target = extractGoogleTarget(rawHref);
    if (!target) return null;

    let url;
    try {
        url = new URL(target);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!isAllowedHost(url.hostname, allowedHosts)) return null;

    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
        if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAM_NAMES.has(key.toLowerCase())) {
            url.searchParams.delete(key);
        }
    }
    url.searchParams.sort();
    if (url.port === '80' && url.protocol === 'http:') url.port = '';
    if (url.port === '443' && url.protocol === 'https:') url.port = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
}

function detectBlockedPage(html) {
    const text = cleanWhitespace(html).toLowerCase();
    const patterns = [
        ['search_blocked', /unusual traffic|automated queries|captcha|robot check|sorry\.google/],
        ['search_consent_required', /before you continue to google|consent\.google/]
    ];
    return patterns.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

export function parseGoogleSearchHtml(html, {
    allowedHosts = [],
    maxResults = DEFAULT_MAX_RESULTS
} = {}) {
    const blockedCode = detectBlockedPage(html);
    if (blockedCode) return {status: 'unavailable', diagnostic_code: blockedCode, results: []};

    const $ = cheerio.load(String(html || ''));
    const results = [];
    const seen = new Set();
    const hasRecognizedResultMarkup = $('a[href] h3').length > 0
        || $('#search').length > 0
        || /did not match any documents/i.test(String(html || ''));

    $('a[href]').each((_, anchor) => {
        if (results.length >= maxResults) return;
        const heading = $(anchor).find('h3').first();
        if (!heading.length) return;
        const rawUrl = $(anchor).attr('href');
        const url = normalizeSearchResultUrl(rawUrl, {allowedHosts});
        if (!url || seen.has(url)) return;
        seen.add(url);

        const clone = $(anchor).clone();
        clone.find('h3').remove();
        results.push({
            url,
            raw_url: rawUrl,
            title: cleanWhitespace(heading.text()),
            snippet: cleanWhitespace(clone.text()),
            search_rank: results.length + 1
        });
    });

    if (results.length > 0) return {status: 'ok', diagnostic_code: null, results};
    if (hasRecognizedResultMarkup) return {status: 'partial', diagnostic_code: 'no_allowed_domain_results', results: []};
    return {status: 'unavailable', diagnostic_code: 'search_html_unrecognized', results: []};
}

export async function fetchGoogleSearch(query, {
    allowedHosts = [],
    googleHost = DEFAULT_GOOGLE_HOST,
    googleBaseUrl = null,
    maxResults = DEFAULT_MAX_RESULTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    language = 'pl',
    country = 'pl',
    userAgent = DEFAULT_USER_AGENT,
    fetchImpl = globalThis.fetch
} = {}) {
    const searchUrl = buildGoogleSearchUrl(query, {googleHost, googleBaseUrl, maxResults, language, country});
    const base = {provider: 'google', query: String(query || '').trim(), search_url: searchUrl};
    if (typeof fetchImpl !== 'function') {
        return {...base, status: 'unavailable', diagnostic_code: 'fetch_unavailable', results: []};
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(searchUrl, {
            signal: controller.signal,
            headers: {'user-agent': userAgent, accept: 'text/html,application/xhtml+xml'}
        });
        const html = await response.text();
        if (!response.ok) {
            return {...base, status: 'unavailable', diagnostic_code: `search_http_${response.status}`, results: []};
        }
        return {...base, ...parseGoogleSearchHtml(html, {allowedHosts, maxResults})};
    } catch (error) {
        const diagnostic_code = error?.name === 'AbortError' ? 'search_timeout' : 'search_fetch_error';
        return {...base, status: 'unavailable', diagnostic_code, error: error?.message || String(error), results: []};
    } finally {
        clearTimeout(timer);
    }
}

async function main() {
    const program = new Command();
    program
        .requiredOption('--query <query>', 'Google query')
        .requiredOption('--domain <domain>', 'bank host or domain to allow')
        .option('--google-host <host>', 'Google host', DEFAULT_GOOGLE_HOST)
        .option('--google-base-url <url>', 'override Google base URL')
        .option('--max-results <number>', 'maximum results', value => parseInt(value, 10), DEFAULT_MAX_RESULTS)
        .option('--timeout-ms <number>', 'request timeout', value => parseInt(value, 10), DEFAULT_TIMEOUT_MS)
        .option('--language <language>', 'Google language', 'pl')
        .option('--country <country>', 'Google country', 'pl')
        .parse();
    const opts = program.opts();
    const result = await fetchGoogleSearch(opts.query, {
        allowedHosts: [opts.domain],
        googleHost: opts.googleHost,
        googleBaseUrl: opts.googleBaseUrl,
        maxResults: opts.maxResults,
        timeoutMs: opts.timeoutMs,
        language: opts.language,
        country: opts.country
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'unavailable') process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
