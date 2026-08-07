import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeTempDir(prefix = 'bank-retry-batch-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function toolEnv(projectRoot) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: projectRoot};
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeCandidateFixture(cacheDir, {baseUrl, htmlName, htmlText, riskFlags = [], sufficientForAnalysis = false, productRelation = {status: 'unknown'}, urlRanking = null}) {
    fs.mkdirSync(cacheDir, {recursive: true});
    const htmlPath = path.join(cacheDir, htmlName);
    fs.writeFileSync(htmlPath, htmlText);
    const candidate = {
        url: `${baseUrl}/${htmlName.replace(/\.html$/, '')}`,
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
        content_length: htmlText.length,
        changed_since_last_fetch: true,
        cache_file: htmlPath,
        final_url: `${baseUrl}/${htmlName.replace(/\.html$/, '')}`,
        error: null
    };
    fs.writeFileSync(path.join(cacheDir, 'candidates.json'), JSON.stringify({
        institution_id: path.basename(cacheDir).includes('001') ? 'bank_a' : 'bank_b',
        lp: path.basename(cacheDir).includes('001') ? 1 : 2,
        name: path.basename(cacheDir).includes('001') ? 'Bank A' : 'Bank B',
        website_url: baseUrl,
        fetched_at: '2026-07-10',
        homepage_available: true,
        homepage_status: 200,
        homepage_sha256: 'abc',
        previous_homepage_sha256: 'xyz',
        homepage_changed_since_last_fetch: true,
        broad_candidate_count: 1,
        prioritized_candidate_count: 1,
        preprocessing_risk_flags: riskFlags,
        url_ranking: urlRanking,
        sufficient_for_analysis: sufficientForAnalysis,
        product_relation: productRelation,
        candidates: [candidate],
        all_candidates: [candidate]
    }));
}

describe('retry-batch', () => {
    it('moves retry records either back to prepared or to escalated after the second pass', () => {
        const cwd = makeTempDir();
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work'), {recursive: true});
        const cacheA = path.join(cwd, 'data/cache/institutions/001-bank-a');
        const cacheB = path.join(cwd, 'data/cache/institutions/002-bank-b');

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
                {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null},
                {lp: 2, institution_id: 'bank_b', review_status: 'unchecked', qualifies: null}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({
            schema_version: '1.0',
            tasks: [
                {lp: 1, institution_id: 'bank_a', stage: 'retry_pending', attempt_count: 1, preprocessing_risk_flags: ['missing_refinancing_hits'], last_error: null, last_processed_at: '2026-07-10'},
                {lp: 2, institution_id: 'bank_b', stage: 'retry_pending', attempt_count: 1, preprocessing_risk_flags: ['missing_fixed_rate_hits'], last_error: null, last_processed_at: '2026-07-10'}
            ]
        }));

        writeCandidateFixture(cacheA, {
            baseUrl: 'https://bank-a.example',
            htmlName: 'full-offer.html',
            htmlText: '<html><body>Kredyt mieszkaniowy. spłata wcześniejszego kredytu mieszkaniowego. oprocentowanie okresowo stałe przez 5 lat.</body></html>',
            riskFlags: ['missing_refinancing_hits'],
            sufficientForAnalysis: true,
            productRelation: {status: 'confirmed', basis: 'single_url_full_coverage'},
            urlRanking: {
                provider: 'deterministic',
                mode: 'automatic_after_discovery',
                inventory_sha256: 'retry-inventory',
                candidate_count: 2,
                selected_pool: [`https://bank-a.example/full-offer`],
                expanded_pools: []
            }
        });
        writeCandidateFixture(cacheB, {
            baseUrl: 'https://bank-b.example',
            htmlName: 'thin-offer.html',
            htmlText: '<html><body>Kredyt mieszkaniowy dla klientów indywidualnych.</body></html>',
            sufficientForAnalysis: false
        });

        const summary = execFileSync(node, [path.join(skillRoot, 'tools/retry-batch.mjs'), '--limit', '2', '--skip-discovery'], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        });
        const result = JSON.parse(summary);
        expect(result.prepared).toBe(1);
        expect(result.escalated).toBe(1);

        const automation = readJson(path.join(cwd, 'data/work/runs', result.run_id, 'automation-state.json'));
        expect(automation.tasks.find(task => task.institution_id === 'bank_a').stage).toBe('prepared');
        expect(automation.tasks.find(task => task.institution_id === 'bank_b').stage).toBe('escalated');
        expect(automation.tasks.find(task => task.institution_id === 'bank_a').preprocessing_status).toBe('sufficient');
        expect(automation.tasks.find(task => task.institution_id === 'bank_a').preprocessing_quality_warnings).toContain('missing_refinancing_hits');
        expect(automation.tasks.find(task => task.institution_id === 'bank_a').url_ranking).toMatchObject({
            provider: 'deterministic',
            inventory_sha256: 'retry-inventory',
            candidate_count: 2,
            selected_pool_count: 1
        });
        expect(automation.tasks.find(task => task.institution_id === 'bank_b').preprocessing_insufficient_flags).toContain('insufficient_for_analysis');
        expect(readJson(path.join(cwd, 'data/work/automation-state.json')).tasks.every(task => task.stage === 'retry_pending')).toBe(true);
    });
});
