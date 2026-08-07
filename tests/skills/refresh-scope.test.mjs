import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');
const execFileAsync = promisify(execFile);

function send(response, status, body, contentType = 'text/html') {
    response.writeHead(status, {'content-type': contentType});
    response.end(body);
}

describe('prepare-batch refresh scope', () => {
    it('refreshes only the selected batch in normal mode', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-refresh-scope-'));
        fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(root, 'data/work'), {recursive: true});
        const requests = [];
        const server = http.createServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            requests.push(url.pathname);
            if (url.pathname === '/search') return send(response, 503, 'blocked');
            if (url.pathname === '/bank1') return send(response, 200, '<a href="/bank1/offer">Kredyt mieszkaniowy</a>');
            if (url.pathname === '/bank1/offer') return send(response, 200, 'Kredyt mieszkaniowy.');
            if (url.pathname === '/sitemap.xml') return send(response, 404, 'not found');
            return send(response, 404, 'not found');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const base = `http://127.0.0.1:${port}`;
        fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({institutions: [
            {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: `${base}/bank1`},
            {lp: 2, institution_id: 'bank_b', type: 'bank_spoldzielczy', name: 'Bank B', website_url: `${base}/bank2`}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/analysis-state.json'), JSON.stringify({rows: [
            {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null},
            {lp: 2, institution_id: 'bank_b', review_status: 'unchecked', qualifies: null}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/automation-state.json'), JSON.stringify({tasks: [
            {lp: 1, institution_id: 'bank_a', stage: 'pending_prepare', attempt_count: 0},
            {lp: 2, institution_id: 'bank_b', stage: 'pending_prepare', attempt_count: 0}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/evidence.jsonl'), '');
        try {
            await execFileAsync(node, [
                path.join(skillRoot, 'tools/prepare-batch.mjs'), '--from', '1', '--limit', '1', '--refresh', '--continue-on-error',
                '--google-base-url', base, '--ranking-provider', 'deterministic'
            ], {cwd: root, env: {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root}, maxBuffer: 4 * 1024 * 1024});
            expect(requests).toContain('/bank1');
            expect(requests).not.toContain('/bank2');
            expect(fs.existsSync(path.join(root, 'data/cache/institutions/001-bank-a/candidates.json'))).toBe(true);
            expect(fs.existsSync(path.join(root, 'data/cache/institutions/002-bank-b/candidates.json'))).toBe(false);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    }, 15000);
});
