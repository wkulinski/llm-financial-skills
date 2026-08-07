import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import ExcelJS from 'exceljs';
import {describe, expect, it} from 'vitest';
import {sha256} from '../../.agents/skills/bank-market-scan/tools/lib/common.mjs';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');
const execFileAsync = promisify(execFile);

function send(response, status, body, contentType = 'text/html') {
    response.writeHead(status, {'content-type': contentType});
    response.end(body);
}

describe('clean batch integration', () => {
    it('resets, prepares, reviews and exports without stale data', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-clean-run-'));
        fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(root, 'data/work'), {recursive: true});
        fs.mkdirSync(path.join(root, 'data/work/review-packs'), {recursive: true});
        fs.mkdirSync(path.join(root, 'data/work/row-updates'), {recursive: true});
        fs.mkdirSync(path.join(root, 'data/cache/institutions/001-bank-a'), {recursive: true});
        fs.writeFileSync(path.join(root, 'data/cache/institutions/001-bank-a/old.html'), 'old cache');

        const server = http.createServer((request, response) => {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/search') return send(response, 429, 'blocked');
            if (url.pathname === '/a') return send(response, 200, '<a href="/a/offer">Oferta mieszkaniowa</a>');
            if (url.pathname === '/a/offer') return send(response, 200, 'Kredyt mieszkaniowy. Spłata wcześniejszego kredytu. Oprocentowanie okresowo stałe przez 5 lat. RRSO 7,10%.');
            if (url.pathname === '/b') return send(response, 200, '<a href="/b/offer">Oferta mieszkaniowa</a>');
            if (url.pathname === '/b/offer') return send(response, 200, 'Kredyt mieszkaniowy dla klientów indywidualnych.');
            if (url.pathname === '/sitemap.xml') return send(response, 404, 'not found');
            if (url.pathname === '/c') throw new Error('LP3 must not be fetched in this scoped run');
            return send(response, 404, 'not found');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({institutions: [
            {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: `${base}/a`},
            {lp: 2, institution_id: 'bank_b', type: 'bank_spoldzielczy', name: 'Bank B', website_url: `${base}/b`},
            {lp: 3, institution_id: 'bank_c', type: 'bank_spoldzielczy', name: 'Bank C', website_url: `${base}/c`}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/analysis-state.json'), JSON.stringify({schema_version: '1.1', rows: [
            {lp: 1, institution_id: 'bank_a', review_status: 'checked', qualifies: false, offer: {old_rate: 0.09}},
            {lp: 2, institution_id: 'bank_b', review_status: 'unchecked', qualifies: null},
            {lp: 3, institution_id: 'bank_c', review_status: 'unchecked', qualifies: null}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/automation-state.json'), JSON.stringify({tasks: [
            {lp: 1, institution_id: 'bank_a', stage: 'checked', attempt_count: 3},
            {lp: 2, institution_id: 'bank_b', stage: 'pending_prepare', attempt_count: 0},
            {lp: 3, institution_id: 'bank_c', stage: 'pending_prepare', attempt_count: 0}
        ]}));
        fs.writeFileSync(path.join(root, 'data/work/evidence.jsonl'), `${JSON.stringify({lp: 1, institution_id: 'bank_a', text: 'old evidence'})}\n`);
        fs.writeFileSync(path.join(root, 'data/work/review-packs/lp-001.md'), 'old pack');
        try {
            const env = {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root};
            execFileSync(node, [path.join(skillRoot, 'tools/reset-batch.mjs'), '--from', '1', '--limit', '2', '--clear-cache', '--clear-analysis', '--run-id', 'clean-test'], {cwd: root, env, encoding: 'utf8'});
            const prepareOutput = await execFileAsync(node, [
                path.join(skillRoot, 'tools/prepare-batch.mjs'), '--from', '1', '--limit', '2', '--refresh', '--fresh', '--ranking-provider', 'deterministic',
                '--google-base-url', base
            ], {cwd: root, env, maxBuffer: 4 * 1024 * 1024});
            const prepareSummary = JSON.parse(prepareOutput.stdout);
            const runId = prepareSummary.run_id;
            const runDir = path.join(root, 'data/work/runs', runId);
            const runManifest = path.join(runDir, 'manifest.json');

            const candidates = JSON.parse(fs.readFileSync(path.join(root, 'data/cache/institutions/001-bank-a/candidates.json'), 'utf8'));
            const sourceRows = fs.readFileSync(path.join(root, 'data/cache/institutions/001-bank-a/source-text.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
            const evidenceRows = fs.readFileSync(path.join(root, 'data/cache/institutions/001-bank-a/evidence.candidates.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
            const automation = JSON.parse(fs.readFileSync(path.join(runDir, 'automation-state.json'), 'utf8'));
            expect(automation.tasks.find(task => task.lp === 1).run_id).toBe(runId);
            expect(candidates.run_id).toBe(runId);
            expect(sourceRows.length).toBe(candidates.candidates.length);
            expect(sourceRows.every(row => row.run_id === runId)).toBe(true);
            for (const source of sourceRows) {
                const candidate = candidates.candidates.find(item => (item.final_url || item.url) === source.url);
                expect(candidate).toBeTruthy();
                expect(sha256(fs.readFileSync(candidate.cache_file))).toBe(candidate.content_sha256);
            }
            expect(evidenceRows.length).toBeGreaterThan(0);
            expect(evidenceRows.every(row => row.run_id === runId)).toBe(true);
            expect(automation.tasks.find(task => task.lp === 1).stage).toBe('prepared');
            expect(automation.tasks.find(task => task.lp === 2).stage).toBe('retry_pending');
            expect(automation.tasks.find(task => task.lp === 3).stage).toBe('pending_prepare');
            expect(fs.existsSync(path.join(root, 'data/cache/institutions/003-bank-c/andidates.json'))).toBe(false);

            fs.writeFileSync(path.join(runDir, 'row-updates/lp-001.json'), JSON.stringify({
                run_id: runId, lp: 1, institution_id: 'bank_a', review_status: 'checked', checked_at: '2026-07-14',
                website_available: true, qualifies: true,
                qualification: {
                    housing_or_mortgage_loan_confirmed: true,
                    refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: true,
                    periodically_fixed_rate_confirmed: true,
                    reason_codes: ['housing_or_mortgage_loan_confirmed', 'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed', 'periodically_fixed_rate_confirmed']
                },
                decision_audit: {
                    product_scope: 'Kredyt mieszkaniowy testowy',
                    same_product_variant_confirmed: true,
                    criterion_evidence_urls: {
                        housing: ['http://127.0.0.1/product'],
                        refinancing: ['http://127.0.0.1/product'],
                        fixed_rate: ['http://127.0.0.1/product']
                    }
                },
                field_evidence: {
                    'qualification.housing_or_mortgage_loan_confirmed': [{url: `${base}/a/offer`, text_excerpt: 'Kredyt mieszkaniowy'}],
                    'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed': [{url: `${base}/a/offer`, text_excerpt: 'Spłata wcześniejszego kredytu'}],
                    'qualification.periodically_fixed_rate_confirmed': [{url: `${base}/a/offer`, text_excerpt: 'Oprocentowanie okresowo stałe'}]
                },
                offer: {product_name: 'Kredyt mieszkaniowy', fixed_rate_period_years: 5, fixed_nominal_rate_exact: 0.061, rrso_exact: 0.071, rrso_description: 'wariant z oprocentowaniem okresowo stałym'}
            }));
            execFileSync(node, [
                path.join(skillRoot, 'tools/review-batch.mjs'), '--limit', '1',
                '--state', path.join(runDir, 'analysis-state.json'),
                '--automation-state', path.join(runDir, 'automation-state.json'),
                '--updates-dir', path.join(runDir, 'row-updates'),
                '--review-packs-dir', path.join(runDir, 'review-packs')
            ], {cwd: root, env, encoding: 'utf8'});
            const state = JSON.parse(fs.readFileSync(path.join(runDir, 'analysis-state.json'), 'utf8'));
            expect(state.rows.find(row => row.lp === 1)).toMatchObject({review_status: 'checked', qualifies: true});
            expect(state.rows.find(row => row.lp === 1).offer.fixed_nominal_rate_exact).toBe(0.061);

            const out = path.join(root, 'data/exports/out.xlsx');
            execFileSync(node, [
                path.join(skillRoot, 'tools/export-workbook.mjs'), '--out', out,
                '--analysis', path.join(runDir, 'analysis-state.json'),
                '--evidence', path.join(runDir, 'evidence.jsonl')
            ], {cwd: root, env, encoding: 'utf8'});
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(out);
            const sheet = workbook.getWorksheet('Analiza ofert');
            expect(sheet.rowCount).toBe(4);
            const headers = sheet.getRow(1).values.slice(1);
            const values = sheet.getRow(2).values.slice(1);
            expect(values[headers.indexOf('Oferta spełnia kryteria')]).toBe('TAK');
            expect(values[headers.indexOf('Oprocentowanie okresowo stałe min')]).toBe(0.061);
            expect(sheet.getRow(3).values[headers.indexOf('Oferta spełnia kryteria') + 1]).toBe('');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    }, 30000);
});
