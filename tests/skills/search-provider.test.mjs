import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
    buildGoogleSearchUrl,
    fetchGoogleSearch,
    normalizeSearchResultUrl,
    parseGoogleSearchHtml
} from '../../.agents/skills/bank-market-scan/tools/search-provider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async name => fs.readFile(path.join(here, '..', 'fixtures', name), 'utf8');

describe('Google search provider', () => {
    it('builds an encoded Google search URL with bounded result count', () => {
        const url = new URL(buildGoogleSearchUrl('site:bank.example.pl kredyt hipoteczny', {maxResults: 200}));
        expect(url.hostname).toBe('www.google.com');
        expect(url.pathname).toBe('/search');
        expect(url.searchParams.get('q')).toBe('site:bank.example.pl kredyt hipoteczny');
        expect(url.searchParams.get('num')).toBe('100');
    });

    it('normalizes Google redirects and removes tracking parameters', () => {
        expect(normalizeSearchResultUrl(
            '/url?q=https%3A%2F%2Fbank.example.pl%2Foferta%3Futm_medium%3Dcpc%26rok%3D2026%23rates',
            {allowedHosts: ['bank.example.pl']}
        )).toBe('https://bank.example.pl/oferta?rok=2026');
        expect(normalizeSearchResultUrl(
            'https://bank.example.pl/oferta',
            {allowedHosts: ['www.bank.example.pl']}
        )).toBe('https://bank.example.pl/oferta');
        expect(normalizeSearchResultUrl(
            'https://www.bank.example.pl/oferta',
            {allowedHosts: ['bank.example.pl']}
        )).toBe('https://www.bank.example.pl/oferta');
        expect(normalizeSearchResultUrl('https://other.example.net/oferta', {allowedHosts: ['bank.example.pl']})).toBeNull();
    });

    it('parses valid results, keeps raw URLs and filters external domains', async () => {
        const html = await fixture('google-results.html');
        const parsed = parseGoogleSearchHtml(html, {allowedHosts: ['bank.example.pl', 'docs.example.pl']});
        expect(parsed.status).toBe('ok');
        expect(parsed.results).toHaveLength(2);
        expect(parsed.results[0]).toMatchObject({
            url: 'https://bank.example.pl/kredyt-hipoteczny?rok=2026',
            title: 'Kredyt hipoteczny',
            search_rank: 1
        });
        expect(parsed.results[0].raw_url).toContain('/url?q=');
        expect(parsed.results[0].snippet).toContain('okresowo stałym');
        expect(parsed.results[1].url).toBe('https://docs.example.pl/tabela.pdf?version=3');
    });

    it('classifies blocked and unrecognized pages as unavailable', async () => {
        const blocked = parseGoogleSearchHtml(await fixture('google-blocked.html'), {allowedHosts: ['bank.example.pl']});
        expect(blocked).toMatchObject({status: 'unavailable', diagnostic_code: 'search_blocked', results: []});
        expect(parseGoogleSearchHtml('<html><body>plain page</body></html>')).toMatchObject({
            status: 'unavailable',
            diagnostic_code: 'search_html_unrecognized'
        });
    });

    it('fetches HTML with a bounded request and returns the adapter contract', async () => {
        const html = await fixture('google-results.html');
        let request;
        const result = await fetchGoogleSearch('site:bank.example.pl kredyt', {
            allowedHosts: ['bank.example.pl', 'docs.example.pl'],
            fetchImpl: async (url, options) => {
                request = {url, options};
                return new Response(html, {status: 200, headers: {'content-type': 'text/html'}});
            }
        });
        expect(result).toMatchObject({provider: 'google', status: 'ok', query: 'site:bank.example.pl kredyt'});
        expect(result.results).toHaveLength(2);
        expect(request.options.headers.accept).toContain('text/html');
        expect(request.options.headers['user-agent']).toContain('bank-market-scan');
        expect(request.url).toContain('q=site%3Abank.example.pl+ kredyt'.replace(' ', ''));
    });
});
