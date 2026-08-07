import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {afterEach, describe, expect, it} from 'vitest';

import {selectBestOffer} from '../../.agents/skills/mortgage-refinancing-scan/lib/offer-select.mjs';
import {buildProductBundles, interpretReviewContext} from '../../.agents/skills/mortgage-refinancing-scan/lib/interpretation.mjs';
import {buildReviewContext, readReviewContext} from '../../.agents/skills/mortgage-refinancing-scan/lib/review-context.mjs';
import {validateContract, validateInterpretationResult} from '../../.agents/skills/mortgage-refinancing-scan/lib/run-contract-validate.mjs';
import {readEvidenceJsonl, readJson} from '../../.agents/skills/mortgage-refinancing-scan/lib/research-runtime.mjs';
import {loadRun, replayRun} from '../../.agents/skills/mortgage-refinancing-scan/lib/run-lifecycle.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const TOOLS = path.join(ROOT, '.agents/skills/mortgage-refinancing-scan/tools');
const FIXTURE = path.join(ROOT, 'tests/fixtures/mortgage-refinancing-scan-interpretation.json');
const REGISTRY = path.join(ROOT, 'tests/fixtures/mortgage-refinancing-scan-research-registry.json');
const RUNS_ROOT = path.join(ROOT, 'data/mortgage-refinancing-scan/work/runs');
const CACHE_ROOT = path.join(ROOT, `data/mortgage-refinancing-scan/cache/interpretation-${process.pid}`);
process.env.MORTGAGE_REFINANCING_SCAN_TRANSPORT_CACHE_ROOT = `data/mortgage-refinancing-scan/cache/interpretation-${process.pid}/http`;
process.env.MORTGAGE_REFINANCING_SCAN_NORMALIZATION_CACHE_ROOT = `data/mortgage-refinancing-scan/cache/interpretation-${process.pid}/normalized`;
const PUBLISHED_ROOT = path.join(ROOT, 'data/mortgage-refinancing-scan/published');
const activeRuns = new Set();
let sequence = 0;

describe('mortgage-refinancing-scan Phase 4 interpretation vertical slice', () => {
    afterEach(() => {
        for (const runId of activeRuns) {
            fs.rmSync(path.join(RUNS_ROOT, runId), {recursive: true, force: true});
            fs.rmSync(path.join(PUBLISHED_ROOT, runId), {recursive: true, force: true});
        }
        activeRuns.clear();
        fs.rmSync(CACHE_ROOT, {recursive: true, force: true});
    });

    it('covers T08: qualifies only one bundle, emits strict output, and reruns idempotently', () => {
        const init = createRunningRun();
        prepareEntry(init, 'bank-positive');
        const first = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        expect(first.results[0]).toMatchObject({status: 'interpreted', decision_status: 'qualified'});

        const run = loadRun(init.manifestPath);
        const context = readReviewContext({run, entryId: 'bank-positive', evidenceRecords: readEvidenceJsonl(run.context.evidence_path), fixtureEntry: readJson(FIXTURE).entries.find((entry) => entry.entry_id === 'bank-positive')});
        expect(buildProductBundles(context).every((bundle) => validateContract('product-bundle', bundle).valid)).toBe(true);
        const replayedContext = readReviewContext({
            run,
            entryId: 'bank-positive',
            evidenceRecords: [...readEvidenceJsonl(run.context.evidence_path)].reverse(),
            fixtureEntry: readJson(FIXTURE).entries.find((entry) => entry.entry_id === 'bank-positive')
        });
        expect(interpretReviewContext(replayedContext, {manifest: run.manifest})).toEqual(
            interpretReviewContext(context, {manifest: run.manifest})
        );
        const resultPath = path.join(init.runRoot, 'artifacts/interpretation/bank-positive.json');
        const result = readJson(resultPath);
        expect(validateInterpretationResult(result, {manifest: run.manifest, evidenceRecords: readEvidenceJsonl(run.context.evidence_path)}).valid).toBe(true);
        expect(result.decision_status).toBe('qualified');
        expect(result).toMatchObject({export_ready: true, data_status: 'complete', export_blockers: []});
        expect(result.criterion_status).toEqual({housing: 'found', refinancing: 'found', fixed_rate: 'found'});
        expect(result.field_evidence['qualification.housing']).toHaveLength(1);
        expect(fs.existsSync(path.join(init.runRoot, 'artifacts/review-context/bank-positive.json'))).toBe(true);
        const eventsBefore = fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8');

        const second = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        expect(second.results[0]).toMatchObject({status: 'interpreted', decision_status: 'qualified', idempotent: true});
        expect(fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8')).toBe(eventsBefore);
        expect(replayRun(loadRun(init.manifestPath)).entries.get('bank-positive').stage).toBe('interpreted');

        const withoutRates = readEvidenceJsonl(run.context.evidence_path)
            .filter((record) => !record.field_path.startsWith('offer.fixed_nominal_rate') && !record.field_path.startsWith('offer.rrso'));
        const incompleteContext = readReviewContext({
            run,
            entryId: 'bank-positive',
            evidenceRecords: withoutRates,
            fixtureEntry: readJson(FIXTURE).entries.find((entry) => entry.entry_id === 'bank-positive')
        });
        const incomplete = interpretReviewContext(incompleteContext, {manifest: run.manifest});
        expect(incomplete).toMatchObject({decision_status: 'qualified', export_ready: false, data_status: 'incomplete'});
        expect(incomplete.export_blockers).toContain('missing_nominal_or_rrso');

        fs.writeFileSync(resultPath, `${JSON.stringify({...result, run_id: 'run-20260806T140000Z-tampered'}, null, 2)}\n`);
        const tamperedRerun = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive'], 10);
        expect(tamperedRerun.error.code).toBe('schema_mismatch');
    });

    it('keeps explicit exclusions, missing criteria and split products distinct', () => {
        const init = createRunningRun();
        for (const entryId of ['bank-own-costs', 'bank-housing-only', 'bank-variable', 'bank-split-products']) {
            prepareEntry(init, entryId);
        }
        const output = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE]);
        const byEntry = new Map(output.results.map((item) => [item.entry_id, item]));
        expect(byEntry.get('bank-own-costs')).toMatchObject({status: 'interpreted', decision_status: 'explicitly_not_qualified'});
        expect(byEntry.get('bank-variable')).toMatchObject({status: 'interpreted', decision_status: 'explicitly_not_qualified'});
        expect(byEntry.get('bank-housing-only')).toMatchObject({status: 'interpreted', decision_status: 'unconfirmed'});
        expect(byEntry.get('bank-split-products')).toMatchObject({status: 'interpreted', decision_status: 'unconfirmed'});
        expect(readJson(path.join(init.runRoot, 'artifacts/interpretation/bank-split-products.json')).product_bundle).toBeNull();
    });

    it('selects the comparable RRSO winner without using promotion and supports permanent fixed rates', () => {
        const init = createRunningRun();
        prepareEntry(init, 'bank-html-pdf');
        const output = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-html-pdf']);
        expect(output.results[0]).toMatchObject({status: 'interpreted', decision_status: 'qualified'});
        const result = readJson(path.join(init.runRoot, 'artifacts/interpretation/bank-html-pdf.json'));
        expect(result.product_bundle.product_id).toBe('prd-888888888888888888888888');
        expect(result.offer.rrso_exact).toBe(6.9);

        const permanent = makeOffer({fixed_rate_type: 'permanent_fixed', rrso_exact: 7, commission_exact: 1});
        const periodic = makeOffer({fixed_rate_type: 'periodically_fixed', rrso_exact: 7, commission_exact: 1, fixed_rate_period_years_exact: 5});
        expect(selectBestOffer([{offer: permanent}, {offer: periodic}]).status).toBe('selected');
        expect(selectBestOffer([{offer: permanent}, {offer: {...periodic, comparison_context: {...periodic.comparison_context, currency: 'EUR'}}}])).toMatchObject({status: 'unconfirmed'});

        const nominalA = makeOffer({rrso_exact: null, rrso_min: null, rrso_max: null, fixed_nominal_rate_exact: 7});
        const nominalB = makeOffer({rrso_exact: null, rrso_min: null, rrso_max: null, fixed_nominal_rate_exact: 6.5});
        expect(selectBestOffer([{offer: nominalA}, {offer: nominalB}]).candidate.offer.fixed_nominal_rate_exact).toBe(6.5);

        const disjointRange = makeOffer({rrso_exact: null, rrso_min: 6, rrso_max: 7});
        const higherRange = makeOffer({rrso_exact: null, rrso_min: 7.5, rrso_max: 8});
        expect(selectBestOffer([{offer: disjointRange}, {offer: higherRange}]).status).toBe('selected');

        const overlappingRange = makeOffer({rrso_exact: null, rrso_min: 6.5, rrso_max: 7.5});
        expect(selectBestOffer([{offer: disjointRange}, {offer: overlappingRange}])).toMatchObject({status: 'unconfirmed'});

        const amountCommission = makeOffer({rrso_exact: 7, commission_unit: 'amount', commission_currency: 'PLN'});
        expect(selectBestOffer([{offer: permanent}, {offer: amountCommission}])).toMatchObject({status: 'unconfirmed'});
    });

    it('rejects mismatched evidence before the interpreter boundary', () => {
        const init = createRunningRun();
        prepareEntry(init, 'bank-positive');
        const run = loadRun(init.manifestPath);
        const records = readEvidenceJsonl(run.context.evidence_path);
        const tampered = records.map((record) => record.entry_id === 'bank-positive' ? {...record, content_sha256: 'f'.repeat(64)} : record);
        expect(() => readReviewContext({run, entryId: 'bank-positive', evidenceRecords: tampered})).toThrowError(expect.objectContaining({code: 'evidence_mismatch'}));

        const emptyContext = buildReviewContext({run, entryId: 'bank-positive', evidenceRecords: [], sourceArtifacts: []});
        expect(emptyContext.evidence).toEqual([]);
    });

    it('terminalizes tampered entries while continuing independent entries', () => {
        const init = createRunningRun();
        prepareEntry(init, 'bank-positive');
        prepareEntry(init, 'bank-own-costs');
        const run = loadRun(init.manifestPath);
        const source = readJson(path.join(init.runRoot, 'artifacts/fetch/bank-positive.json')).source_artifacts[0];
        const sourcePath = path.resolve(ROOT, source.run_local_path);
        fs.writeFileSync(sourcePath, Buffer.alloc(source.raw_content_bytes, 0x58));

        const output = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE]);
        const byEntry = new Map(output.results.map((item) => [item.entry_id, item]));
        expect(byEntry.get('bank-positive')).toMatchObject({status: 'technical_error', error_code: 'evidence_mismatch'});
        expect(byEntry.get('bank-own-costs')).toMatchObject({status: 'interpreted', decision_status: 'explicitly_not_qualified'});
        expect(readJson(path.join(init.runRoot, 'entries/bank-positive/state.json'))).toMatchObject({stage: 'technical_error', error_code: 'evidence_mismatch'});
        expect(fs.existsSync(path.join(init.runRoot, 'artifacts/interpretation/bank-positive.json'))).toBe(false);
    });

    it('turns an empty closed evidence set into unconfirmed without false', () => {
        const init = createRunningRun();
        for (const [index, stage] of ['fetched', 'normalized', 'evidence_ready'].entries()) {
            runTool('run-state.mjs', [
                '--run-manifest', init.manifestPath,
                '--action', 'entry',
                '--entry-id', 'bank-shared-origin-one',
                '--stage', stage,
                '--operation-id', `empty-evidence:${index}`
            ]);
        }
        const output = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--entry-id', 'bank-shared-origin-one']);
        expect(output.results[0]).toMatchObject({status: 'interpreted', decision_status: 'unconfirmed'});
        const result = readJson(path.join(init.runRoot, 'artifacts/interpretation/bank-shared-origin-one.json'));
        expect(result.decision_status).toBe('unconfirmed');
        expect(result.qualifies).toBeUndefined();
        expect(readJson(path.join(init.runRoot, 'entries/bank-shared-origin-one/state.json'))).toMatchObject({stage: 'interpreted', decision_status: 'unconfirmed'});
    });

    it('terminalizes a tampered evidence record before interpretation', () => {
        const init = createRunningRun();
        prepareEntry(init, 'bank-positive');
        const run = loadRun(init.manifestPath);
        const tampered = readEvidenceJsonl(run.context.evidence_path).map((record, index) => index === 0 ? {...record, content_sha256: 'f'.repeat(64)} : record);
        fs.writeFileSync(path.resolve(ROOT, run.context.evidence_path), `${tampered.map((record) => JSON.stringify(record)).join('\n')}\n`);
        const output = runTool('interpret.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        expect(output.results[0]).toMatchObject({status: 'technical_error', error_code: 'evidence_mismatch'});
        expect(fs.existsSync(path.join(init.runRoot, 'artifacts/interpretation/bank-positive.json'))).toBe(false);
    });
});

function makeOffer(overrides = {}) {
    return {
        fixed_rate_type: 'periodically_fixed',
        comparison_context: {
            currency: 'PLN',
            representative_amount: 300000,
            term_years: 25,
            customer_profile: 'consumer_standard',
            observation_date: '2026-08-06T00:00:00Z'
        },
        fixed_nominal_rate_exact: 6.5,
        fixed_nominal_rate_min: null,
        fixed_nominal_rate_max: null,
        rrso_exact: 6.5,
        rrso_min: null,
        rrso_max: null,
        commission_exact: 0.5,
        commission_min: null,
        commission_max: null,
        commission_unit: 'percent',
        commission_currency: null,
        fixed_rate_period_years_exact: 5,
        max_loan_term_years: 35,
        ...overrides
    };
}

function createRun() {
    sequence += 1;
    const runId = `run-20260806T14${String(sequence).padStart(4, '0')}Z-interp${process.pid}${sequence.toString(36)}`;
    const manifestPath = path.join(RUNS_ROOT, runId, 'manifest.json');
    activeRuns.add(runId);
    runTool('run-init.mjs', [
        '--registry-snapshot', REGISTRY,
        '--mode', 'full',
        '--live', 'false',
        '--run-root', 'data/mortgage-refinancing-scan/work/runs',
        '--run-id', runId
    ]);
    return {runId, manifestPath, runRoot: path.dirname(manifestPath)};
}

function createRunningRun() {
    const init = createRun();
    runTool('run-state.mjs', ['--run-manifest', init.manifestPath, '--action', 'transition', '--next-state', 'RUNNING']);
    return init;
}

function prepareEntry(init, entryId) {
    runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', entryId]);
    runTool('source-fetch.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', entryId]);
    runTool('normalize.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', entryId, '--engine', 'fixture']);
    runTool('evidence.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', entryId]);
}

function runTool(tool, args, expectedCode = 0) {
    const result = spawnSync(process.execPath, [path.join(TOOLS, tool), ...args], {cwd: ROOT, encoding: 'utf8'});
    expect(result.error, `${tool} process error`).toBeUndefined();
    expect(result.status, `${tool} stderr: ${result.stderr}`).toBe(expectedCode);
    const output = (expectedCode === 0 ? result.stdout : result.stderr).trim();
    return output ? JSON.parse(output) : {};
}
