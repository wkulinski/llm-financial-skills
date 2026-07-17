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

function env(root) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root};
}

function send(response, status, body, headers = {'content-type': 'text/html'}) {
    response.writeHead(status, headers);
    response.end(body);
}

describe('failure and cache recovery', () => {
    it('removes an old review-pack when preparation fails', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-stale-pack-'));
        fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(root, 'data/work/review-packs'), {recursive: true});
        fs.mkdirSync(path.join(root, 'data/cache/institutions/001-bank-a'), {recursive: true});
        fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({institutions: [
            {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: 'https://bank-a.example'}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/analysis-state.json'), JSON.stringify({rows: [
            {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/automation-state.json'), JSON.stringify({tasks: [
            {lp: 1, institution_id: 'bank_a', stage: 'pending_prepare', attempt_count: 0}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/review-packs/lp-001.md'), 'stale pack');
        fs.writeFileSync(path.join(root, 'data/cache/institutions/001-bank-a/candidates.json'), JSON.stringify({
            institution_id: 'bank_a', lp: 1, name: 'Bank A', run_id: 'run-current',
            candidates: [{url: 'https://bank-a.example/offer', final_url: 'https://bank-a.example/offer', cache_file: '/tmp/missing-bank-source.html', available: true, content_type: 'text/html', content_sha256: 'a'.repeat(64), content_length: 10}],
            all_candidates: [{url: 'https://bank-a.example/offer', final_url: 'https://bank-a.example/offer', cache_file: '/tmp/missing-bank-source.html', available: true, content_type: 'text/html', content_sha256: 'a'.repeat(64), content_length: 10}],
            sufficient_for_analysis: false
        }));

        const output = execFileSync(node, [path.join(skillRoot, 'tools/prepare-batch.mjs'), '--limit', '1', '--skip-discovery'], {
            cwd: root, env: env(root), encoding: 'utf8'
        });
        expect(output).toContain('"errors": 1');
        expect(fs.existsSync(path.join(root, 'data/work/review-packs/lp-001.md'))).toBe(false);
        const automation = JSON.parse(fs.readFileSync(path.join(root, 'data/work/automation-state.json'), 'utf8'));
        expect(automation.tasks[0].stage).toBe('error');
    });

    it('refetches a corrupted cache instead of reusing it after 304', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-304-recovery-'));
        fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
        const offerBody = 'Kredyt mieszkaniowy. Spłata wcześniejszego kredytu. Oprocentowanie okresowo stałe przez 5 lat.';
        let offerRequests = 0;
        const server = http.createServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/search') return send(response, 503, 'blocked');
            if (url.pathname === '/home') return send(response, 200, '<a href="/offer">Kredyt mieszkaniowy</a>');
            if (url.pathname === '/offer') {
                offerRequests += 1;
                return send(response, 200, offerBody, {'content-type': 'text/html', etag: 'offer-v1', 'last-modified': 'Tue, 14 Jul 2026 12:00:00 GMT'});
            }
            if (url.pathname === '/sitemap.xml') return send(response, 404, 'not found');
            return send(response, 404, 'not found');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({institutions: [
            {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: `${base}/home`}
        ]}));
        try {
            const args = [path.join(skillRoot, 'tools/discover-sources.mjs'), '--lp', '1', '--refresh', '--skip-unchanged', '--google-base-url', base];
            await execFileAsync(node, [...args, '--run-id', 'run-1'], {cwd: root, env: env(root), maxBuffer: 4 * 1024 * 1024});
            const cacheDir = path.join(root, 'data/cache/institutions/001-bank-a');
            const first = JSON.parse(fs.readFileSync(path.join(cacheDir, 'candidates.json'), 'utf8'));
            const offer = first.all_candidates.find(candidate => candidate.url.endsWith('/offer'));
            expect(offer).toBeTruthy();
            fs.writeFileSync(offer.cache_file, 'corrupted cache');

            await execFileAsync(node, [...args, '--run-id', 'run-2'], {cwd: root, env: env(root), maxBuffer: 4 * 1024 * 1024});
            const second = JSON.parse(fs.readFileSync(path.join(cacheDir, 'candidates.json'), 'utf8'));
            const refreshed = second.all_candidates.find(candidate => candidate.url.endsWith('/offer'));
            expect(fs.readFileSync(refreshed.cache_file, 'utf8')).toBe(offerBody);
            expect(second.cache_integrity_errors).toEqual([]);
            expect(offerRequests).toBeGreaterThanOrEqual(2);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    }, 30000);
});
