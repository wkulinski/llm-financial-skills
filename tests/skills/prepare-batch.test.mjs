import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');
const execFileAsync = promisify(execFile);

function makeTempDir(prefix = 'bank-prepare-batch-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function toolEnv(projectRoot) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: projectRoot};
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeProjectState(cwd, baseUrl, {stage = 'pending_prepare'} = {}) {
    fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
    fs.mkdirSync(path.join(cwd, 'data/work'), {recursive: true});
    fs.writeFileSync(path.join(cwd, 'data/base/institutions.current.json'), JSON.stringify({
        schema_version: '1.0',
        institutions: [{
            lp: 1,
            institution_id: 'bank_a',
            type: 'bank_spoldzielczy',
            name: 'Bank A',
            website_url: baseUrl
        }]
    }));
    fs.writeFileSync(path.join(cwd, 'data/work/analysis-state.json'), JSON.stringify({
        schema_version: '1.1',
        rows: [{lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}]
    }));
    fs.writeFileSync(path.join(cwd, 'data/work/evidence.jsonl'), '');
    fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({
        schema_version: '1.0',
        tasks: [{
            lp: 1,
            institution_id: 'bank_a',
            stage,
            attempt_count: 0,
            preprocessing_risk_flags: [],
            last_error: null,
            last_processed_at: null
        }]
    }));
}

function writeCandidateCache(cwd, {baseUrl, html, sufficientForAnalysis, urlRanking = null}) {
    const cacheDir = path.join(cwd, 'data/cache/institutions/001-bank-a');
    fs.mkdirSync(cacheDir, {recursive: true});
    const htmlPath = path.join(cacheDir, 'offer.html');
    fs.writeFileSync(htmlPath, html);
    const url = `${baseUrl}/offer`;
    const candidate = {
        url,
        final_url: url,
        title: 'Kredyt mieszkaniowy',
        source: 'search',
        relation: 'same_website',
        score: 5,
        hits: [{category: 'product', keyword: 'kredyt mieszkaniowy'}],
        available: true,
        status: 200,
        content_type: 'text/html',
        content_sha256: 'hash',
        content_length: html.length,
        cache_file: htmlPath,
        changed_since_last_fetch: true
    };
    fs.writeFileSync(path.join(cacheDir, 'candidates.json'), JSON.stringify({
        institution_id: 'bank_a',
        lp: 1,
        name: 'Bank A',
        website_url: baseUrl,
        sufficient_for_analysis: sufficientForAnalysis,
        product_relation: {status: 'unknown'},
        preprocessing_risk_flags: [],
        homepage_changed_since_last_fetch: true,
        url_ranking: urlRanking,
        candidates: [candidate],
        all_candidates: [candidate]
    }));
}

function startServer(handler) {
    const server = http.createServer(handler);
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve({server, baseUrl: `http://127.0.0.1:${address.port}`});
    }));
}

function stopServer(server) {
    return new Promise(resolve => server.close(resolve));
}

function send(response, status, body, contentType = 'text/html') {
    response.writeHead(status, {'content-type': contentType});
    response.end(body);
}

function googleHtml(url) {
    return `<html><body><div id="search"><a href="${url}"><h3>Kredyt mieszkaniowy</h3><div>Oferta banku</div></a></div></body></html>`;
}

describe('prepare-batch', () => {
    it('prepares review packs and advances automation queue using existing cache', () => {
        const cwd = makeTempDir();
        const baseUrl = 'https://bank-a.example';
        const cacheDir = path.join(cwd, 'data/cache/institutions/001-bank-a');
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work'), {recursive: true});
        fs.mkdirSync(cacheDir, {recursive: true});
        fs.writeFileSync(path.join(cwd, 'data/base/institutions.current.json'), JSON.stringify({
            schema_version: '1.0',
            institutions: [{
                lp: 1,
                institution_id: 'bank_a',
                type: 'bank_spoldzielczy',
                name: 'Bank A',
                website_url: baseUrl,
                source: {}
            }]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/analysis-state.json'), JSON.stringify({
            schema_version: '1.1',
            rows: [{lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/evidence.jsonl'), '');
        fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({
            schema_version: '1.0',
            tasks: [{
                lp: 1,
                institution_id: 'bank_a',
                stage: 'pending_prepare',
                attempt_count: 0,
                preprocessing_risk_flags: [],
                last_error: null,
                last_processed_at: null
            }]
        }));
        const htmlPath = path.join(cacheDir, 'kredyt-mieszkaniowy.html');
        fs.writeFileSync(htmlPath, [
            '<html><body>',
            'Kredyt mieszkaniowy z oprocentowaniem okresowo stałym przez 5 lat. ',
            'Produkt umożliwia spłata wcześniejszego kredytu mieszkaniowego. ',
            'RRSO wynosi 6,1%.',
            '</body></html>'
        ].join(''));
        fs.writeFileSync(path.join(cacheDir, 'candidates.json'), JSON.stringify({
            institution_id: 'bank_a',
            lp: 1,
            name: 'Bank A',
            website_url: baseUrl,
            fetched_at: '2026-07-10',
            discovery_mode: 'search_first',
            search_provider_status: 'ok',
            search_quality_flags: ['strong_product_url_found'],
            product_relation: {status: 'confirmed', basis: 'single_url_full_coverage', urls: [`${baseUrl}/kredyt-mieszkaniowy`]},
            sufficient_for_search_first: true,
            sufficient_for_analysis: true,
            sufficiency_basis: 'single_url_full_coverage',
            homepage_available: true,
            homepage_status: 200,
            homepage_sha256: 'abc',
            previous_homepage_sha256: 'xyz',
            homepage_changed_since_last_fetch: true,
            broad_candidate_count: 1,
            prioritized_candidate_count: 1,
            preprocessing_risk_flags: [],
            candidates: [{
                url: `${baseUrl}/kredyt-mieszkaniowy`,
                title: 'Kredyt mieszkaniowy',
                source: 'homepage',
                relation: 'same_website',
                score: 5,
                hits: [{category: 'product', keyword: 'kredyt mieszkaniowy'}],
                broad_candidate: true,
                prioritized_candidate: true,
                fetched_at: '2026-07-10',
                available: true,
                status: 200,
                content_type: 'text/html',
                content_sha256: 'hash',
                previous_sha256: null,
                content_length: 120,
                changed_since_last_fetch: true,
                cache_file: htmlPath,
                final_url: `${baseUrl}/kredyt-mieszkaniowy`
            }],
            all_candidates: [{
                url: `${baseUrl}/kredyt-mieszkaniowy`,
                title: 'Kredyt mieszkaniowy',
                source: 'homepage',
                relation: 'same_website',
                score: 5,
                hits: [{category: 'product', keyword: 'kredyt mieszkaniowy'}],
                broad_candidate: true,
                prioritized_candidate: true,
                fetched_at: '2026-07-10',
                available: true,
                status: 200,
                content_type: 'text/html',
                content_sha256: 'hash',
                previous_sha256: null,
                content_length: 120,
                changed_since_last_fetch: true,
                cache_file: htmlPath,
                final_url: `${baseUrl}/kredyt-mieszkaniowy`
            }]
        }));

        const summary = execFileSync(node, [path.join(skillRoot, 'tools/prepare-batch.mjs'), '--limit', '1', '--skip-discovery'], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        });
        const result = JSON.parse(summary);
        expect(result.processed).toBe(1);
        expect(result.items[0].stage).toBe('prepared');

        const runDir = path.join(cwd, 'data/work/runs', result.run_id);
        const runAutomation = readJson(path.join(runDir, 'automation-state.json'));
        expect(runAutomation.tasks[0].stage).toBe('prepared');
        expect(runAutomation.tasks[0].attempt_count).toBe(1);
        expect(readJson(path.join(cwd, 'data/work/automation-state.json')).tasks[0].stage).toBe('pending_prepare');
        expect(fs.existsSync(path.join(runDir, 'review-packs/lp-001.md'))).toBe(true);
        expect(fs.existsSync(path.join(runDir, 'row-updates/lp-001.json'))).toBe(false);
        const sourceText = fs.readFileSync(path.join(cacheDir, 'source-text.jsonl'), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
        expect(sourceText[0].discovery_mode).toBe('search_first');
        expect(sourceText[0].sufficient_for_analysis).toBe(true);
        expect(sourceText[0].source).toBe('homepage');
        const reviewPack = fs.readFileSync(path.join(runDir, 'review-packs/lp-001.md'), 'utf8');
        expect(reviewPack).toContain('Tryb discovery: search_first');
        expect(reviewPack).toContain('Relacja produktu: confirmed');
        const candidates = readJson(path.join(cwd, 'data/cache/institutions/001-bank-a/candidates.json'));
        expect(Array.isArray(candidates.all_candidates)).toBe(true);
        expect(candidates.all_candidates.length).toBeGreaterThan(0);
    });

    it('moves insufficient but technically readable material to retry_pending', () => {
        const cwd = makeTempDir();
        const baseUrl = 'https://bank-a.example';
        writeProjectState(cwd, baseUrl);
        writeCandidateCache(cwd, {
            baseUrl,
            html: '<html><body>Kredyt mieszkaniowy dla klientów indywidualnych.</body></html>',
            sufficientForAnalysis: false
        });

        const summary = execFileSync(node, [path.join(skillRoot, 'tools/prepare-batch.mjs'), '--limit', '1', '--skip-discovery'], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        });
        const result = JSON.parse(summary);
        expect(result.items[0].stage).toBe('retry_pending');

        const task = readJson(path.join(cwd, 'data/work/runs', result.run_id, 'automation-state.json')).tasks[0];
        expect(task.stage).toBe('retry_pending');
        expect(task.preprocessing_status).toBe('insufficient');
        expect(task.preprocessing_technical_flags).toEqual([]);
        expect(task.preprocessing_insufficient_flags).toContain('insufficient_for_analysis');
        expect(task.preprocessing_quality_warnings).toContain('missing_refinancing_hits');
    });

    it('passes the discovery sufficiency predicate into prepare-batch', async () => {
        const cwd = makeTempDir();
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/search') return send(response, 200, googleHtml(`${serverInfo.baseUrl}/offer`));
            if (url.pathname === '/offer') return send(response, 200, '<html><body>Kredyt mieszkaniowy. Refinansowanie kredytu. Oprocentowanie okresowo stałe przez 5 lat.</body></html>');
            return send(response, 404, 'not found');
        });
        try {
            writeProjectState(cwd, `${serverInfo.baseUrl}/homepage`);
            await execFileAsync(node, [
                path.join(skillRoot, 'tools/discover-sources.mjs'),
                '--lp', '1',
                '--refresh',
                '--skip-unchanged',
                '--ranking-provider', 'deterministic',
                '--enable-google-search',
                '--google-base-url', serverInfo.baseUrl
            ], {
                cwd,
                encoding: 'utf8',
                maxBuffer: 4 * 1024 * 1024,
                env: toolEnv(cwd)
            });

            const candidates = readJson(path.join(cwd, 'data/cache/institutions/001-bank-a/candidates.json'));
            expect(candidates.sufficient_for_analysis).toBe(true);
            expect(candidates.discovery_mode).toBe('search_first');

            const prepareResult = await execFileAsync(node, [path.join(skillRoot, 'tools/prepare-batch.mjs'), '--limit', '1', '--skip-discovery'], {
                cwd,
                encoding: 'utf8',
                maxBuffer: 4 * 1024 * 1024,
                env: toolEnv(cwd)
            });
            const runResult = JSON.parse(prepareResult.stdout);
            const task = readJson(path.join(cwd, 'data/work/runs', runResult.run_id, 'automation-state.json')).tasks[0];
            expect(task.stage).toBe('prepared');
            expect(task.preprocessing_status).toBe('sufficient');
        } finally {
            await stopServer(serverInfo.server);
        }
    }, 15000);

    it('uses the baseline and material hash instead of search changes as the analysis gate', async () => {
        const cwd = makeTempDir();
        const state = {offer: 'Kredyt mieszkaniowy. Refinansowanie kredytu. Oprocentowanie okresowo stałe przez 5 lat.', searchVariant: 'A', etag: 'v1'};
        const requests = [];
        const serverInfo = await startServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            requests.push({path: url.pathname, headers: request.headers});
            if (url.pathname === '/search') return send(response, 200, googleHtml(`${serverInfo.baseUrl}/offer`).replace('Kredyt mieszkaniowy', `Kredyt mieszkaniowy ${state.searchVariant}`));
            if (url.pathname === '/offer') {
                if (request.headers['if-none-match'] === state.etag && state.etag === 'v1') {
                    response.writeHead(304, {'etag': state.etag});
                    return response.end();
                }
                response.writeHead(200, {'content-type': 'text/html', 'etag': state.etag});
                return response.end(`<html><body>${state.offer}</body></html>`);
            }
            return send(response, 404, 'not found');
        });
        try {
            writeProjectState(cwd, `${serverInfo.baseUrl}/homepage`);
            const run = async limit => execFileAsync(node, [
                path.join(skillRoot, 'tools/prepare-batch.mjs'),
                '--mode', 'changed-only',
                '--refresh',
                '--limit', String(limit),
                '--google-base-url', serverInfo.baseUrl,
                '--enable-google-search',
                '--ranking-provider', 'deterministic'
            ], {
                cwd,
                encoding: 'utf8',
                maxBuffer: 4 * 1024 * 1024,
                env: toolEnv(cwd)
            });

            const first = JSON.parse((await run(0)).stdout);
            expect(first.refreshed).toBe(1);
            expect(first.processed).toBe(0);
            expect(first.refresh_manifest_status).toBe('complete');

            state.searchVariant = 'B';
            const requestsBeforeLightweight = requests.length;
            const second = JSON.parse((await run(1)).stdout);
            expect(requests.slice(requestsBeforeLightweight).map(request => request.path)).not.toContain('/search');
            expect(requests.slice(requestsBeforeLightweight).map(request => request.path)).not.toContain('/homepage');
            expect(second.unchanged_sources).toBe(1);
            expect(readJson(path.join(cwd, 'data/work/runs', second.run_id, 'automation-state.json')).tasks[0].stage).toBe('unchanged_sources');
            const secondCandidates = readJson(path.join(cwd, 'data/cache/institutions/001-bank-a/candidates.json'));
            expect(secondCandidates.discovery_changed_since_last_fetch).toBe(false);
            expect(secondCandidates.offer_changed_since_last_fetch).toBe(false);
            expect(secondCandidates.candidates.some(candidate => candidate.conditional_304 === true)).toBe(true);
            const secondMaterialHash = secondCandidates.candidates[0].material_sha256;

            state.offer = '  Kredyt mieszkaniowy.  Refinansowanie kredytu. Oprocentowanie okresowo stałe przez 5 lat. <script>tracking=1</script> ';
            state.etag = 'v2';
            const third = JSON.parse((await run(1)).stdout);
            expect(third.unchanged_sources).toBe(1);
            const thirdCandidates = readJson(path.join(cwd, 'data/cache/institutions/001-bank-a/candidates.json'));
            expect(thirdCandidates.offer_changed_since_last_fetch).toBe(false);
            expect(thirdCandidates.candidates[0].content_sha256).not.toBe(secondCandidates.candidates[0].content_sha256);
            expect(thirdCandidates.candidates[0].material_sha256).toBe(secondMaterialHash);

            state.offer = 'Kredyt mieszkaniowy. Refinansowanie kredytu. Oprocentowanie okresowo stałe przez 5 lat. Nowa marża 1,20%.'.replace('  ', ' ');
            state.etag = 'v3';
            const fourth = JSON.parse((await run(1)).stdout);
            expect(fourth.changed_detected).toBe(1);
            expect(fourth.prepared).toBe(1);
            const fourthCandidates = readJson(path.join(cwd, 'data/cache/institutions/001-bank-a/candidates.json'));
            expect(fourthCandidates.offer_changed_since_last_fetch).toBe(true);
            expect(fourthCandidates.url_ranking.provider).toBe('not_run_lightweight_refresh');
            expect(requests.some(request => request.path === '/offer' && request.headers['if-none-match'] === 'v1')).toBe(true);
        } finally {
            await stopServer(serverInfo.server);
        }
    }, 30_000);

    it('resumes an interrupted preparing task and records ranking metadata for the queue', () => {
        const cwd = makeTempDir();
        const baseUrl = 'https://bank-a.example';
        writeProjectState(cwd, baseUrl, {stage: 'preparing'});
        writeCandidateCache(cwd, {
            baseUrl,
            html: '<html><body>Kredyt mieszkaniowy. Refinansowanie kredytu. Oprocentowanie okresowo stałe.</body></html>',
            sufficientForAnalysis: true,
            urlRanking: {
                provider: 'deterministic_fallback',
                mode: 'automatic_after_discovery',
                inventory_sha256: 'inventory-hash',
                candidate_count: 4,
                model_candidate_count: 3,
                locked_noise_count: 1,
                selected_pool: [`${baseUrl}/offer`],
                expanded_pools: [[`${baseUrl}/extra`]],
                fallback_reason: 'opencode_error'
            }
        });

        const summary = execFileSync(node, [
            path.join(skillRoot, 'tools/prepare-batch.mjs'),
            '--limit', '1',
            '--skip-discovery'
        ], {cwd, encoding: 'utf8', env: toolEnv(cwd)});
        const result = JSON.parse(summary);
        expect(result.items[0].url_ranking_provider).toBe('deterministic_fallback');

        const task = readJson(path.join(cwd, 'data/work/runs', result.run_id, 'automation-state.json')).tasks[0];
        expect(task.stage).toBe('prepared');
        expect(task.run_id).toMatch(/^run-/);
        expect(task.url_ranking).toMatchObject({
            provider: 'deterministic_fallback',
            inventory_sha256: 'inventory-hash',
            candidate_count: 4,
            selected_pool_count: 1,
            expanded_pool_count: 1,
            fallback_reason: 'opencode_error'
        });
    });
});
