import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeTempDir(prefix = 'bank-skill-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function toolEnv(projectRoot) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: projectRoot};
}

describe('CLI path stability', () => {
    it('initializes project files outside the repo root', () => {
        const cwd = makeTempDir();
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.writeFileSync(path.join(cwd, 'data/base/institutions.current.json'), JSON.stringify({
            schema_version: '1.0',
            institutions: [{
                lp: 1,
                institution_id: 'bank_a',
                type: 'bank_spoldzielczy',
                name: 'Bank A',
                website_url: 'https://bank-a.example',
                source: {url: 'https://bfg.example', source_date: '2026-07-07'}
            }]
        }));
        execFileSync(node, [path.join(skillRoot, 'tools/init-project.mjs')], {cwd, encoding: 'utf8', env: toolEnv(cwd)});

        const institutions = readJson(path.join(cwd, 'data/base/institutions.current.json'));
        const state = readJson(path.join(cwd, 'data/work/analysis-state.json'));
        const automation = readJson(path.join(cwd, 'data/work/automation-state.json'));
        expect(Array.isArray(institutions.institutions)).toBe(true);
        expect(institutions.institutions.length).toBeGreaterThan(0);
        expect(state.schema_version).toBe('1.1');
        expect(Array.isArray(state.rows)).toBe(true);
        expect(state.rows.length).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(cwd, 'data/work/evidence.jsonl'))).toBe(true);
        expect(Array.isArray(automation.tasks)).toBe(true);
        expect(automation.tasks[0].stage).toBe('pending_prepare');
    });

    it('exports workbook columns with bundled schema outside the repo root', () => {
        const cwd = makeTempDir();
        const institutionsPath = path.join(cwd, 'institutions.json');
        const statePath = path.join(cwd, 'state.json');
        const evidencePath = path.join(cwd, 'evidence.jsonl');
        const outPath = path.join(cwd, 'out.xlsx');

        fs.writeFileSync(institutionsPath, JSON.stringify({
            schema_version: '1.0',
            institutions: [{
                lp: 1,
                institution_id: 'bank_a',
                type: 'bank_spoldzielczy',
                name: 'Bank A',
                website_url: 'https://bank-a.example',
                source: {url: 'https://bfg.example', source_date: '2026-07-07'}
            }]
        }));
        fs.writeFileSync(statePath, JSON.stringify({
            schema_version: '1.1',
            rows: [{
                lp: 1,
                institution_id: 'bank_a',
                review_status: 'checked',
                checked_at: '2026-07-07',
                website_available: true,
                qualifies: true,
                qualification: {
                    housing_or_mortgage_loan_confirmed: true,
                    refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: true,
                    periodically_fixed_rate_confirmed: true,
                    reason_codes: ['housing_or_mortgage_loan_confirmed', 'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed', 'periodically_fixed_rate_confirmed'],
                    non_qualification_reason_codes: []
                },
                offer: {
                    product_name: 'Kredyt testowy',
                    fixed_nominal_rate_exact: 0.061
                },
                field_evidence: {
                    'qualification.housing_or_mortgage_loan_confirmed': [{url: 'https://bank-a.example', text_excerpt: 'kredyt mieszkaniowy'}],
                    'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed': [{url: 'https://bank-a.example', text_excerpt: 'spłata wcześniejszego kredytu'}],
                    'qualification.periodically_fixed_rate_confirmed': [{url: 'https://bank-a.example', text_excerpt: 'oprocentowanie okresowo stałe'}]
                }
            }]
        }));
        fs.writeFileSync(evidencePath, '');

        execFileSync(node, [path.join(skillRoot, 'tools/export-workbook.mjs'), '--institutions', institutionsPath, '--analysis', statePath, '--evidence', evidencePath, '--out', outPath], {cwd, encoding: 'utf8', env: toolEnv(cwd)});
        expect(fs.existsSync(outPath)).toBe(true);
        expect(fs.statSync(outPath).size).toBeGreaterThan(0);
    });

    it('greps evidence snippets with bundled keywords outside the repo root', () => {
        const cwd = makeTempDir();
        const cacheDir = path.join(cwd, 'cache');
        fs.mkdirSync(cacheDir, {recursive: true});
        fs.writeFileSync(path.join(cacheDir, 'source-text.jsonl'), [
            {
                institution_id: 'bank_a',
                lp: 1,
                name: 'Bank A',
                url: 'https://bank-a.example/oferta',
                title: 'Oferta kredytowa',
                source_type: 'html',
                fetched_at: '2026-07-07',
                text: 'To jest kredyt mieszkaniowy z oprocentowanie okresowo stałe. Drugi kredyt mieszkaniowy też istnieje.'
            }
        ].map(row => JSON.stringify(row)).join('\n') + '\n');

        execFileSync(node, [path.join(skillRoot, 'tools/normalize-text.mjs'), '--cache-dir', cacheDir], {cwd, encoding: 'utf8', env: toolEnv(cwd)});
        execFileSync(node, [path.join(skillRoot, 'tools/grep-evidence.mjs'), '--cache-dir', cacheDir], {cwd, encoding: 'utf8', env: toolEnv(cwd)});
        const rows = readJsonl(path.join(cacheDir, 'evidence.candidates.jsonl'));
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].institution_id).toBe('bank_a');
        expect(rows.filter(r => r.keyword === 'kredyt mieszkaniowy').length).toBeGreaterThan(1);
    });

    it('reports queue state outside the repo root', () => {
        const cwd = makeTempDir();
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work'), {recursive: true});
        fs.writeFileSync(path.join(cwd, 'data/base/institutions.current.json'), JSON.stringify({
            schema_version: '1.0',
            institutions: [
                {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: 'https://bank-a.example'},
                {lp: 2, institution_id: 'bank_b', type: 'bank_spoldzielczy', name: 'Bank B', website_url: 'https://bank-b.example'}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/analysis-state.json'), JSON.stringify({
            schema_version: '1.1',
            rows: [
                {lp: 1, institution_id: 'bank_a', review_status: 'checked', qualifies: true},
                {lp: 2, institution_id: 'bank_b', review_status: 'unchecked', qualifies: null}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({
            schema_version: '1.0',
            tasks: [
                {lp: 1, institution_id: 'bank_a', stage: 'prepared', attempt_count: 1, preprocessing_risk_flags: [], last_error: null, last_processed_at: '2026-07-10', url_ranking: {provider: 'opencode', candidate_count: 3, selected_pool_count: 2}},
                {lp: 2, institution_id: 'bank_b', stage: 'retry_pending', attempt_count: 2, preprocessing_risk_flags: ['few_sources'], last_error: null, last_processed_at: '2026-07-10', url_ranking: {provider: 'deterministic_fallback', candidate_count: 5, selected_pool_count: 3, fallback_reason: 'timeout'}}
            ]
        }));
        const report = execFileSync(node, [path.join(skillRoot, 'tools/queue-report.mjs')], {cwd, encoding: 'utf8', env: toolEnv(cwd)});
        expect(report).toContain('Checked: 1');
        expect(report).toContain('pending_prepare: 0');
        expect(report).toContain('prepared: 1');
        expect(report).toContain('retry_pending: 1');
        expect(report).toContain('opencode: 1');
        expect(report).toContain('deterministic_fallback: 1');
        expect(report).toContain('Ranking fallbacks: 1');
        expect(report).toContain('Ranking inventory candidates: 8');
        expect(report).toContain('Ranking selected pool URLs: 5');
    });

    it('parses only the BFG institution table and ignores nav/legal links', () => {
        const cwd = makeTempDir();
        const htmlPath = path.join(cwd, 'bfg.html');
        const outPath = path.join(cwd, 'institutions.json');
        const cacheDir = path.join(cwd, 'cache');
        fs.writeFileSync(htmlPath, `<!doctype html>
<html><body>
  <div class="pog-menu">
    <a href="/gwarantowanie-depozytow/podmioty-objete-gwarancjami/">Podmioty objęte gwarancjami</a>
    <a href="/dane-osobowe/">Dane osobowe</a>
    <a href="/nota-prawna/">Nota prawna</a>
  </div>
  <div class="pog-post-content">
    <table><tbody>
      <tr><th>Banki komercyjne</th></tr>
      <tr><td><a href="https://commercial.example">Bank komercyjny</a></td></tr>
      <tr><th>Banki spółdzielcze</th></tr>
      <tr><td><a href="https://bank-a.example">Bank A</a></td></tr>
      <tr><th>SKOK-i</th></tr>
      <tr><td><a href="https://skok-a.example">SKOK A</a></td></tr>
      <tr><th>Podmioty w upadłości</th></tr>
      <tr><td><a href="https://failure.example">Bank w upadłości</a></td></tr>
    </tbody></table>
  </div>
</body></html>`);

        fs.writeFileSync(outPath, JSON.stringify({
            schema_version: '1.0',
            institutions: [{
                institution_id: 'bank_spoldzielczy_bank_a',
                allowed_source_hosts: ['docs.bank-a.example']
            }]
        }));

        execFileSync(node, [
            path.join(skillRoot, 'tools/build-institution-list.mjs'),
            '--bfg-html', htmlPath,
            '--out', outPath,
            '--cache-dir', cacheDir,
            '--min-institutions', '2'
        ], {cwd, encoding: 'utf8', env: toolEnv(cwd)});

        const result = readJson(outPath);
        expect(result.institutions.map(i => i.name)).toEqual(['Bank A', 'SKOK A']);
        expect(result.institutions.find(i => i.name === 'Bank A').allowed_source_hosts).toEqual(['docs.bank-a.example']);
        expect(result.institutions.every(i => i.website_url && !/dane-osobowe|nota-prawna/i.test(i.website_url))).toBe(true);
    });

    it('marks BFG rows without a homepage URL and keeps them out of next-batch', () => {
        const cwd = makeTempDir();
        const htmlPath = path.join(cwd, 'bfg.html');
        const institutionsPath = path.join(cwd, 'institutions.json');
        const statePath = path.join(cwd, 'state.json');
        const cacheDir = path.join(cwd, 'cache');
        fs.writeFileSync(htmlPath, `<!doctype html>
<html><body>
  <div class="pog-post-content">
    <table><tbody>
      <tr><th>Banki spółdzielcze</th></tr>
      <tr><td><a href="https://bank-a.example">Bank A</a></td></tr>
      <tr><td>Bank bez strony</td></tr>
      <tr><th>SKOK-i</th></tr>
      <tr><td><a href="https://skok-a.example">SKOK A</a></td></tr>
    </tbody></table>
  </div>
</body></html>`);
        execFileSync(node, [
            path.join(skillRoot, 'tools/build-institution-list.mjs'),
            '--bfg-html', htmlPath,
            '--out', institutionsPath,
            '--cache-dir', cacheDir,
            '--min-institutions', '2'
        ], {cwd, encoding: 'utf8', env: toolEnv(cwd)});
        const institutions = readJson(institutionsPath);
        const missing = institutions.institutions.find(i => i.name === 'Bank bez strony');
        expect(missing.base_list_status).toBe('missing_website_url');
        expect(missing.base_list_notes).toContain('Brak homepage URL');

        fs.writeFileSync(statePath, JSON.stringify({
            schema_version: '1.1',
            rows: institutions.institutions.map(i => ({lp: i.lp, institution_id: i.institution_id, review_status: 'unchecked', qualifies: null}))
        }));
        const batch = execFileSync(node, [
            path.join(skillRoot, 'tools/next-batch.mjs'),
            '--institutions', institutionsPath,
            '--state', statePath,
            '--n', '10'
        ], {cwd, encoding: 'utf8', env: toolEnv(cwd)});
        expect(batch).not.toContain('Bank bez strony');
        expect(batch).toContain('Bank A');
        expect(batch).toContain('SKOK A');
    });
});
