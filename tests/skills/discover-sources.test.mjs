import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');
const discoverTool = path.join(skillRoot, 'tools/discover-sources.mjs');
const execFileAsync = promisify(execFile);

function startServer(handler) {
    const server = http.createServer(handler);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve({server, port: address.port, baseUrl: `http://127.0.0.1:${address.port}`});
    }));
}

function stopServer(server) {
    return new Promise(resolve => server.close(resolve));
}

function send(response, status, body, contentType = 'text/html') {
    response.writeHead(status, {'content-type': contentType});
    response.end(body);
}

function googleHtml(urls) {
    return `<!doctype html><html><body><div id="search">${urls.map((url, index) => `
        <a href="${url}"><h3>Wynik ${index + 1}</h3><div>Opis wyniku kredyt hipoteczny</div></a>
    `).join('')}</div></body></html>`;
}

function projectWithInstitution(root, websiteUrl, extra = {}) {
    fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
    fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({
        schema_version: '1.0',
        institutions: [{
            lp: 1,
            institution_id: 'bank_a',
            type: 'bank_spoldzielczy',
            name: 'Bank A',
            website_url: websiteUrl,
            ...extra
        }]
    }));
}

async function runDiscover(root, googleBaseUrl, extraArgs = []) {
    const result = await execFileAsync(node, [
        discoverTool,
        '--lp', '1',
        '--refresh',
        '--skip-unchanged',
        '--google-base-url', googleBaseUrl,
        ...extraArgs
    ], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root}
    });
    return result.stdout;
}

function readCandidates(root) {
    return JSON.parse(fs.readFileSync(path.join(root, 'data/cache/institutions/001-bank-a/candidates.json'), 'utf8'));
}

describe('discover-sources search-first integration', () => {
    it('uses search-first, respects the seed budget and skips homepage/sitemap', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const requests = [];
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            requests.push(url.pathname);
            if (url.pathname === '/search') {
                return send(response, 200, googleHtml([
                    `${serverInfo.baseUrl}/offer-one`,
                    `${serverInfo.baseUrl}/offer-two`
                ]));
            }
            if (url.pathname.startsWith('/offer-')) return send(response, 200, '<html><body>Kredyt hipoteczny. Refinansowanie kredytu. Stała stopa przez 5 lat.</body></html>');
            if (url.pathname === '/homepage') return send(response, 200, '<html><body>homepage must not be fetched</body></html>');
            if (url.pathname.startsWith('/sitemap')) return send(response, 200, '<urlset></urlset>', 'application/xml');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${serverInfo.baseUrl}/homepage`);
            const output = await runDiscover(root, serverInfo.baseUrl, ['--seed-max', '8']);
            const candidates = readCandidates(root);
            expect(output).toContain('search_first');
            expect(candidates.discovery_mode).toBe('search_first');
            expect(candidates.search_provider_status).toBe('ok');
            expect(candidates.selected_seed_urls).toHaveLength(2);
            expect(candidates.candidates).toHaveLength(2);
            expect(candidates.all_candidates).toHaveLength(2);
            expect(candidates.timings_ms.total).toBeGreaterThanOrEqual(0);
            expect(candidates.fetch_counts.search_results).toBeGreaterThan(0);
            expect(candidates.fetch_counts.seed_urls).toBe(2);
            expect(requests.filter(pathname => pathname === '/search')).toHaveLength(3);
            expect(requests).not.toContain('/homepage');
            expect(requests).not.toContain('/sitemap.xml');
        } finally {
            await stopServer(serverInfo.server);
        }
    }, 15000);

    it('runs the second search wave only after the first wave lacks coverage', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const requests = [];
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            requests.push(url);
            if (url.pathname === '/search') {
                const query = url.searchParams.get('q') || '';
                if (/refinansowanie|tabela|opłaty/i.test(query)) {
                    return send(response, 200, googleHtml([`${serverInfo.baseUrl}/rate`]).replace('Wynik 1', 'Tabela oprocentowania'));
                }
                return send(response, 200, googleHtml([`${serverInfo.baseUrl}/product`]).replace('Wynik 1', 'Kredyt hipoteczny'));
            }
            if (url.pathname === '/product') return send(response, 200, `<a href="${serverInfo.baseUrl}/rate">Tabela oprocentowania</a>Kredyt hipoteczny. Refinansowanie kredytu.`);
            if (url.pathname === '/rate') return send(response, 200, 'Tabela oprocentowania: stała stopa przez 5 lat.');
            if (url.pathname === '/homepage') return send(response, 200, 'homepage must not be fetched');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${serverInfo.baseUrl}/homepage`);
            await runDiscover(root, serverInfo.baseUrl);
            const candidates = readCandidates(root);
            expect(candidates.discovery_mode).toBe('search_first');
            expect(candidates.sufficient_for_search_first).toBe(true);
            expect(candidates.content_check.product_relation).toMatchObject({status: 'confirmed'});
            expect(candidates.search_queries).toHaveLength(5);
            expect(requests.filter(url => url.pathname === '/search')).toHaveLength(5);
            expect(requests.map(url => url.pathname)).not.toContain('/homepage');
        } finally {
            await stopServer(serverInfo.server);
        }
    });

    it('uses crawl fallback when both search waves lack readable coverage', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/search') return send(response, 200, googleHtml([`${serverInfo.baseUrl}/generic`]));
            if (url.pathname === '/generic') return send(response, 200, 'Kredyt hipoteczny.');
            if (url.pathname === '/homepage') return send(response, 200, `<a href="${serverInfo.baseUrl}/complete">Kredyt hipoteczny refinansowanie stała stopa</a>`);
            if (url.pathname === '/complete') return send(response, 200, 'Kredyt hipoteczny. Refinansowanie kredytu. Stała stopa przez 5 lat.');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${serverInfo.baseUrl}/homepage`);
            await runDiscover(root, serverInfo.baseUrl);
            const candidates = readCandidates(root);
            expect(candidates.discovery_mode).toBe('crawl_fallback');
            expect(candidates.fallback_trigger_reason).toBe('insufficient_content_signals');
            expect(candidates.sufficient_for_search_first).toBe(false);
            expect(candidates.sufficient_for_analysis).toBe(true);
            expect(candidates.all_candidates.some(candidate => candidate.url.endsWith('/complete'))).toBe(true);
        } finally {
            await stopServer(serverInfo.server);
        }
    });

    it('falls back to the legacy crawl when the search provider is unavailable', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const requests = [];
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            requests.push(url.pathname);
            if (url.pathname === '/search') return send(response, 503, 'temporary failure');
            if (url.pathname === '/homepage') return send(response, 200, `<a href="${serverInfo.baseUrl}/fallback-offer">Fallback oferta kredyt hipoteczny</a>`);
            if (url.pathname === '/fallback-offer') return send(response, 200, '<html><body>fallback kredyt hipoteczny</body></html>');
            if (url.pathname.startsWith('/sitemap')) return send(response, 404, 'not found');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${serverInfo.baseUrl}/homepage`);
            await runDiscover(root, serverInfo.baseUrl);
            const candidates = readCandidates(root);
            expect(candidates.discovery_mode).toBe('crawl_fallback');
            expect(candidates.search_provider_status).toBe('unavailable');
            expect(candidates.fallback_trigger_reason).toBe('search_http_503');
            expect(candidates.all_candidates.some(candidate => candidate.url.endsWith('/fallback-offer'))).toBe(true);
            expect(requests).toContain('/homepage');
            expect(requests).toContain('/sitemap.xml');
        } finally {
            await stopServer(serverInfo.server);
        }
    });

    it('ranks fallback metadata before fetching a bounded deterministic pool', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-ranking-'));
        const requests = [];
        const links = Array.from({length: 20}, (_, index) => {
            const title = index < 4 ? 'Kredyt mieszkaniowy' : `Informacje bankowe ${index + 1}`;
            return `<a href="__BASE__/candidate-${index + 1}">${title}</a>`;
        }).join('');
        let serverInfo;
        serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            requests.push(url.pathname);
            if (url.pathname === '/search') return send(response, 503, 'temporary failure');
            if (url.pathname === '/homepage') return send(response, 200, links.replaceAll('__BASE__', serverInfo.baseUrl));
            if (/^\/candidate-\d+$/.test(url.pathname)) return send(response, 200, '<html><body>neutral page</body></html>');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${serverInfo.baseUrl}/homepage`);
            await runDiscover(root, serverInfo.baseUrl, ['--url-ranking', '--url-ranking-deterministic']);
            const candidates = readCandidates(root);
            const fetchedCandidateRequests = requests.filter(pathname => /^\/candidate-\d+$/.test(pathname));
            expect(candidates.discovery_mode).toBe('crawl_fallback');
            expect(candidates.url_ranking.provider).toBe('deterministic');
            expect(candidates.all_candidates).toHaveLength(20);
            expect(fetchedCandidateRequests.length).toBeLessThanOrEqual(16);
            expect(fetchedCandidateRequests.length).toBeLessThan(20);
        } finally {
            await stopServer(serverInfo.server);
        }
    }, 15000);

    it('keeps links after the configured homepage redirects to a different host', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const requests = [];
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            requests.push({host: request.headers.host, pathname: url.pathname});
            if (url.pathname === '/search') return send(response, 503, 'temporary failure');
            if (url.pathname === '/homepage') {
                response.writeHead(302, {location: `http://localhost:${serverInfo.port}/canonical-home`});
                return response.end();
            }
            if (url.pathname === '/canonical-home') {
                return send(response, 200, `<a href="http://localhost:${serverInfo.port}/fallback-offer">Oferta kredyt hipoteczny</a>`);
            }
            if (url.pathname === '/fallback-offer') return send(response, 200, '<html><body>fallback offer</body></html>');
            if (url.pathname.startsWith('/sitemap')) return send(response, 404, 'not found');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${serverInfo.baseUrl}/homepage`);
            await runDiscover(root, serverInfo.baseUrl);
            const candidates = readCandidates(root);
            expect(candidates.discovery_mode).toBe('crawl_fallback');
            expect(candidates.all_candidates.some(candidate => candidate.url === `http://localhost:${serverInfo.port}/fallback-offer`)).toBe(true);
            expect(requests).toContainEqual({host: `localhost:${serverInfo.port}`, pathname: '/canonical-home'});
        } finally {
            await stopServer(serverInfo.server);
        }
    });

    it('falls back when all selected search sources are unavailable', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/search') return send(response, 200, googleHtml([`${serverInfo.baseUrl}/broken-offer`]));
            if (url.pathname === '/broken-offer') return send(response, 503, 'broken source');
            if (url.pathname === '/homepage') return send(response, 200, `<a href="${serverInfo.baseUrl}/fallback-offer">Fallback oferta</a>`);
            if (url.pathname === '/fallback-offer') return send(response, 200, '<html><body>fallback offer</body></html>');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${serverInfo.baseUrl}/homepage`);
            await runDiscover(root, serverInfo.baseUrl);
            const candidates = readCandidates(root);
            expect(candidates.discovery_mode).toBe('crawl_fallback');
            expect(candidates.fallback_trigger_reason).toBe('selected_sources_unavailable');
            expect(candidates.all_candidates.some(candidate => candidate.url.endsWith('/fallback-offer'))).toBe(true);
        } finally {
            await stopServer(serverInfo.server);
        }
    });

    it('accepts explicitly allowed document hosts and rejects other external hosts', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const docs = await startServer((request, response) => send(response, 200, '%PDF-1.4 test', 'application/pdf'));
        const bank = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/search') return send(response, 200, googleHtml([
                `${bank.baseUrl}/offer`,
                `http://localhost:${docs.port}/document.pdf`,
                'https://external.invalid/not-allowed'
            ]));
            if (url.pathname === '/offer') return send(response, 200, '<html><body>bank offer</body></html>');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${bank.baseUrl}/homepage`, {allowed_source_hosts: ['localhost']});
            await runDiscover(root, bank.baseUrl);
            const candidates = readCandidates(root);
            expect(candidates.all_candidates.map(candidate => candidate.url)).toContain(`http://localhost:${docs.port}/document.pdf`);
            expect(candidates.all_candidates.map(candidate => candidate.url)).not.toContain('https://external.invalid/not-allowed');
        } finally {
            await stopServer(bank.server);
            await stopServer(docs.server);
        }
    });

    it('does not let --allow-external bypass allowed_source_hosts', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-discovery-'));
        const docs = await startServer((request, response) => send(response, 200, '<html><body>external document</body></html>'));
        const bank = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/search') return send(response, 200, googleHtml([`http://localhost:${docs.port}/document.html`]));
            if (url.pathname === '/homepage') return send(response, 200, '<html><body>no links</body></html>');
            return send(response, 404, 'not found');
        });
        try {
            projectWithInstitution(root, `${bank.baseUrl}/homepage`);
            await runDiscover(root, bank.baseUrl, ['--allow-external']);
            const candidates = readCandidates(root);
            expect(candidates.all_candidates.map(candidate => candidate.url)).not.toContain(`http://localhost:${docs.port}/document.html`);
        } finally {
            await stopServer(bank.server);
            await stopServer(docs.server);
        }
    });
});
