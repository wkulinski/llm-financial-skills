import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {prepareRun} from '../../.agents/skills/bank-market-scan/tools/prepare-run.mjs';
import {finalizeRun} from '../../.agents/skills/bank-market-scan/tools/finalize-run.mjs';
import {abortRun} from '../../.agents/skills/bank-market-scan/tools/abort-run.mjs';
import {readReviewContext} from '../../.agents/skills/bank-market-scan/tools/read-review-context.mjs';
import {buildEvidenceId} from '../../.agents/skills/bank-market-scan/tools/lib/evidence-store.mjs';
import {normalizationArtifactPath} from '../../.agents/skills/bank-market-scan/tools/lib/normalization-artifact.mjs';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');
const fixturePath = path.resolve('tests/fixtures/bank-market-scan-e2e-lifecycle.json');

function readFixture() {
    return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function writeJsonl(filePath, rows) {
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
}

function toolEnv(root) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root};
}

function emptyRow(item) {
    return {lp: item.lp, institution_id: item.institution_id, review_status: 'unchecked', qualifies: null};
}

function evidenceFor(item, category, url, contentSha, runId) {
    const base = {
        run_id: runId,
        institution_id: item.institution_id,
        lp: item.lp,
        product_id: `product-${item.lp}`,
        field_path: category,
        category,
        url,
        content_sha256: contentSha,
        fetched_at: '2026-08-04T00:00:00Z',
        text_excerpt: item.text,
        source_role: item.source_role,
        used_for_decision: false
    };
    return {...base, evidence_id: buildEvidenceId(base)};
}

function rowUpdate(item, evidenceRows, resolveAmbiguous, runId) {
    const decision = item.lp === 3 && resolveAmbiguous ? 'explicitly_not_qualified' : item.decision;
    if (decision === 'qualified') {
        const evidenceByCategory = new Map(evidenceRows.map(row => [row.category, row]));
        return {
            run_id: runId, lp: item.lp, institution_id: item.institution_id, decision_status: decision,
            review_status: 'checked', checked_at: '2026-08-04', website_available: true, qualifies: true,
            qualification: {
                housing_or_mortgage_loan_confirmed: true,
                refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: true,
                periodically_fixed_rate_confirmed: true,
                reason_codes: ['housing_or_mortgage_loan_confirmed', 'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed', 'periodically_fixed_rate_confirmed']
            },
            decision_audit: {
                product_scope: 'Kredyt mieszkaniowy',
                same_product_variant_confirmed: true,
                criterion_evidence_urls: {
                    housing: [evidenceByCategory.get('product').url],
                    refinancing: [evidenceByCategory.get('refinancing').url],
                    fixed_rate: [evidenceByCategory.get('fixed_rate').url]
                }
            },
            field_evidence: {
                'qualification.housing_or_mortgage_loan_confirmed': [evidenceByCategory.get('product')],
                'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed': [evidenceByCategory.get('refinancing')],
                'qualification.periodically_fixed_rate_confirmed': [evidenceByCategory.get('fixed_rate')]
            }
        };
    }
    if (decision === 'pending_review') {
        return {
            run_id: runId, lp: item.lp, institution_id: item.institution_id, decision_status: decision,
            review_status: 'needs_review', checked_at: null, website_available: true, qualifies: null
        };
    }
    return {
        run_id: runId, lp: item.lp, institution_id: item.institution_id, decision_status: decision,
        review_status: 'checked', checked_at: '2026-08-04', website_available: true, qualifies: false,
        qualification: {non_qualification_reason_codes: [item.lp === 4 ? 'excluded_context' : 'no_refinance_or_repayment_confirmed']}
    };
}

async function createFixtureRun(runId, {resolveAmbiguous = false} = {}) {
    const fixture = readFixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-e2e-lifecycle-'));
    const institutions = {institutions: fixture.cases.map(item => ({
        lp: item.lp, institution_id: item.institution_id, name: item.name, website_url: `https://bank-${item.lp}.example`
    }))};
    const globalStatePath = path.join(root, 'data/work/analysis-state.json');
    const globalAutomationPath = path.join(root, 'data/work/automation-state.json');
    const globalEvidencePath = path.join(root, 'data/work/evidence.jsonl');
    await writeJson(path.join(root, 'data/base/institutions.current.json'), institutions);
    await writeJson(globalStatePath, {schema_version: '1.1', rows: fixture.cases.map(emptyRow)});
    await writeJson(globalAutomationPath, {schema_version: '1.0', tasks: fixture.cases.map(item => ({
        lp: item.lp, institution_id: item.institution_id, run_id: runId, stage: 'prepared', attempt_count: 1
    }))});
    await writeJsonl(globalEvidencePath, []);

    const {manifestPath} = await prepareRun({
        runId,
        institutions,
        selected: institutions.institutions,
        output: path.join(root, 'data/work/runs', runId, 'manifest.json')
    });
    const runDir = path.dirname(manifestPath);
    await fs.copyFile(globalStatePath, path.join(runDir, 'analysis-state.json'));
    await fs.copyFile(globalAutomationPath, path.join(runDir, 'automation-state.json'));

    const runEvidence = [];
    for (const item of fixture.cases) {
        const url = `https://bank-${item.lp}.example/offer`;
        const contentSha = `content-${item.lp}`;
        const cacheDir = path.join(root, 'data/cache/institutions', `${String(item.lp).padStart(3, '0')}-${item.name.toLowerCase().replaceAll(' ', '-')}`);
        await writeJsonl(path.join(cacheDir, 'source-text.jsonl'), [{
            run_id: runId, institution_id: item.institution_id, lp: item.lp, url, title: item.name,
            source_type: 'html', source_role: item.source_role, content_sha256: contentSha, text: item.text
        }]);
        await writeJson(path.join(cacheDir, 'candidates.json'), {run_id: runId, institution_id: item.institution_id, lp: item.lp, content_check: {}});
        await writeJson(normalizationArtifactPath({cacheDir, runManifestPath: manifestPath, lp: item.lp}), {
            schema_version: '1.0', run_id: runId, institution_id: item.institution_id, lp: item.lp,
            engine: fixture.normalization_engine, status: 'complete', generated_at: '2026-08-04T00:00:00Z',
            source_count: 1, normalized_source_count: 1, unreadable_source_count: 0,
            sources: [{url, content_sha256: contentSha, source_text_sha256: createHash('sha256').update(item.text).digest('hex'), status: 'normalized', error: null, lemma_text: '', tokens: []}],
            keywords: {product: [], refinancing: [], fixed_rate: [], pricing: []}
        });
        const evidenceRows = item.categories.map(category => evidenceFor(item, category, url, contentSha, runId));
        runEvidence.push(...evidenceRows);
        await writeJson(path.join(runDir, 'row-updates', `lp-${String(item.lp).padStart(3, '0')}.json`), rowUpdate(item, evidenceRows, resolveAmbiguous, runId));
    }
    await writeJsonl(path.join(runDir, 'evidence.jsonl'), runEvidence);
    return {root, fixture, manifestPath, runDir, globalStatePath, globalAutomationPath, globalEvidencePath};
}

async function createCanonicalPreprocessRun() {
    const fixture = readFixture();
    const item = fixture.cases[0];
    const runId = 'fixture-preprocess';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-e2e-preprocess-'));
    const institution = {lp: item.lp, institution_id: item.institution_id, name: item.name, website_url: 'https://bank-preprocess.example'};
    const institutions = {institutions: [institution]};
    const globalStatePath = path.join(root, 'data/work/analysis-state.json');
    const globalAutomationPath = path.join(root, 'data/work/automation-state.json');
    await writeJson(path.join(root, 'data/base/institutions.current.json'), institutions);
    await writeJson(globalStatePath, {schema_version: '1.1', rows: [emptyRow(item)]});
    await writeJson(globalAutomationPath, {schema_version: '1.0', tasks: [{
        lp: item.lp, institution_id: item.institution_id, run_id: runId, stage: 'pending_prepare', attempt_count: 0
    }]});
    const {manifestPath} = await prepareRun({
        runId,
        institutions,
        selected: [institution],
        output: path.join(root, 'data/work/runs', runId, 'manifest.json')
    });
    const runDir = path.dirname(manifestPath);
    await fs.copyFile(globalStatePath, path.join(runDir, 'analysis-state.json'));
    await fs.copyFile(globalAutomationPath, path.join(runDir, 'automation-state.json'));

    const cacheDir = path.join(root, 'data/cache/institutions/001-bank-tak');
    const htmlPath = path.join(cacheDir, 'offer.html');
    const html = '<html><body><main><h1>Kredyt mieszkaniowy</h1><p>Spłata wcześniejszego kredytu mieszkaniowego. Oprocentowanie okresowo stałe przez 5 lat.</p></main></body></html>';
    await fs.mkdir(cacheDir, {recursive: true});
    await fs.writeFile(htmlPath, html);
    const contentSha = createHash('sha256').update(html).digest('hex');
    const candidate = {
        url: 'https://bank-preprocess.example/offer',
        final_url: 'https://bank-preprocess.example/offer',
        title: 'Oferta kredytu mieszkaniowego',
        source: 'homepage',
        source_role: 'core',
        relation: 'same_website',
        score: 5,
        hits: [{category: 'product', keyword: 'kredyt mieszkaniowy'}],
        selected_seed: true,
        prioritized_candidate: true,
        fetched_at: '2026-08-04T00:00:00Z',
        available: true,
        status: 200,
        content_type: 'text/html',
        content_sha256: contentSha,
        content_length: Buffer.byteLength(html),
        cache_file: htmlPath,
        error: null
    };
    await writeJson(path.join(cacheDir, 'candidates.json'), {
        run_id: runId, institution_id: item.institution_id, lp: item.lp, name: item.name,
        website_url: institution.website_url, fetched_at: '2026-08-04T00:00:00Z',
        discovery_mode: 'crawl_fallback', search_provider_status: 'disabled',
        sufficient_for_analysis: true, product_relation: {status: 'confirmed'},
        candidates: [candidate], all_candidates: [candidate]
    });
    return {root, manifestPath, runDir, cacheDir, item, globalStatePath, globalAutomationPath};
}

async function readAllContexts(run) {
    for (const item of run.fixture.cases) {
        const context = await readReviewContext({
            runManifestPath: run.manifestPath,
            lp: item.lp,
            criterion: 'all',
            institutionsPath: path.join(run.root, 'data/base/institutions.current.json'),
            cacheRoot: path.join(run.root, 'data/cache/institutions')
        });
        expect(context.scope.lps).toEqual([item.lp]);
        expect(context.items[0].source_coverage.engine).toBe('morfeusz2');
        if (item.source_role === 'excluded_context') {
            expect(context.items[0].criteria.refinancing.excluded_context.available_count).toBe(1);
        }
    }
}

function runReview(run) {
    return JSON.parse(execFileSync(node, [
        path.join(skillRoot, 'tools/review-batch.mjs'), '--mode', 'all', '--limit', '5', '--run-manifest', run.manifestPath, '--require-field-evidence'
    ], {cwd: run.root, encoding: 'utf8', env: toolEnv(run.root)}));
}

describe('deterministic bank-market-scan E2E lifecycle', () => {
    it('runs canonical offline preprocessing before the review lifecycle', async () => {
        const run = await createCanonicalPreprocessRun();
        const summary = JSON.parse(execFileSync(node, [
            path.join(skillRoot, 'tools/prepare-batch.mjs'), '--run-manifest', run.manifestPath, '--skip-discovery', '--offline', '--limit', '1'
        ], {cwd: run.root, encoding: 'utf8', env: toolEnv(run.root)}));
        expect(summary.processed).toBe(1);
        expect(summary.items[0].stage).toBe('prepared');
        expect((await fs.readFile(path.join(run.cacheDir, 'source-text.jsonl'), 'utf8')).trim()).not.toBe('');
        expect((await fs.readFile(normalizationArtifactPath({runManifestPath: run.manifestPath, lp: run.item.lp}), 'utf8')).includes('"engine": "morfeusz2"')).toBe(true);
        expect((await fs.readFile(path.join(run.runDir, 'evidence.jsonl'), 'utf8')).trim()).not.toBe('');
        expect((await fs.readFile(path.join(run.runDir, 'review-packs/lp-001.md'), 'utf8')).length).toBeGreaterThan(0);
        const context = await readReviewContext({
            runManifestPath: run.manifestPath,
            lp: run.item.lp,
            criterion: 'all',
            institutionsPath: path.join(run.root, 'data/base/institutions.current.json'),
            cacheRoot: path.join(run.root, 'data/cache/institutions')
        });
        expect(context.items[0].source_coverage.engine).toBe('morfeusz2');
    });

    it('aborts an exact-scope run with an ambiguous decision and excluded context', async () => {
        const run = await createFixtureRun('fixture-blocked', {resolveAmbiguous: false});
        await readAllContexts(run);
        const summary = runReview(run);
        expect(summary.selected_count).toBe(5);
        expect(summary.interpreted_count).toBe(5);
        expect(summary.applied).toBe(4);
        expect(summary.pending_count).toBe(1);
        await expect(finalizeRun({runManifestPath: run.manifestPath, statePath: run.globalStatePath, automationStatePath: run.globalAutomationPath, globalEvidencePath: run.globalEvidencePath})).rejects.toThrow(/needs_user_review/);
        const aborted = await abortRun({runManifestPath: run.manifestPath, reason: 'ambiguous decision requires review'});
        expect(aborted.status).toBe('aborted');
    });

    it('finalizes the resolved deterministic fixture without network or model calls', async () => {
        const run = await createFixtureRun('fixture-complete', {resolveAmbiguous: true});
        await readAllContexts(run);
        const summary = runReview(run);
        expect(summary.selected_count).toBe(5);
        expect(summary.interpreted_count).toBe(5);
        expect(summary.applied).toBe(5);
        expect(summary.pending_count).toBe(0);
        const finalized = await finalizeRun({runManifestPath: run.manifestPath, statePath: run.globalStatePath, automationStatePath: run.globalAutomationPath, globalEvidencePath: run.globalEvidencePath});
        expect(finalized.status).toBe('finalized');
        const state = JSON.parse(await fs.readFile(run.globalStatePath, 'utf8'));
        expect(state.rows.find(row => row.lp === 1).decision_status).toBe('qualified');
        expect(state.rows.find(row => row.lp === 3).decision_status).toBe('explicitly_not_qualified');
        expect(JSON.parse(await fs.readFile(run.globalAutomationPath, 'utf8')).tasks.every(task => task.stage === 'checked')).toBe(true);
        expect((await fs.readFile(run.globalEvidencePath, 'utf8')).trim().split(/\r?\n/)).toHaveLength(12);
    });
});
