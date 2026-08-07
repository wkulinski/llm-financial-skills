import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const nextBatch = path.resolve('.agents/skills/bank-market-scan/tools/next-batch.mjs');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bank-next-batch-'));
}

function env(root) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root};
}

function expectCommandFailure(root, args) {
    expect(() => execFileSync(node, args, {
        cwd: root,
        encoding: 'utf8',
        env: env(root),
        stdio: ['ignore', 'pipe', 'ignore']
    })).toThrow();
}

function writeFixture(root, {manifestStatus = 'complete', cacheRunId = 'run-1', includePreviousComplete = false} = {}) {
    fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data/work/source-refresh-runs'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data/cache/institutions/001-bank-a'), {recursive: true});
    fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({
        institutions: [{lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: 'https://bank-a.example'}]
    }));
    fs.writeFileSync(path.join(root, 'data/work/analysis-state.json'), JSON.stringify({rows: [{lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}]}));
    fs.writeFileSync(path.join(root, 'data/work/automation-state.json'), JSON.stringify({tasks: [{lp: 1, institution_id: 'bank_a', stage: 'unchanged_sources', attempt_count: 1, preprocessing_risk_flags: []}]}));
    fs.writeFileSync(path.join(root, 'data/cache/institutions/001-bank-a/candidates.json'), JSON.stringify({
        institution_id: 'bank_a',
        lp: 1,
        source_refresh_run_id: cacheRunId,
        sources_refreshed_at: '2026-07-13T12:00:00.000Z',
        offer_changed_since_last_fetch: true,
        candidates: [{url: 'https://bank-a.example/offer', offer_changed_since_last_fetch: true}]
    }));
    fs.writeFileSync(path.join(root, 'data/work/source-refresh-runs/run-1.json'), JSON.stringify({
        run_id: 'run-1',
        status: manifestStatus,
        completed_at: '2026-07-13T12:01:00.000Z',
        expected_institution_ids: ['bank_a'],
        completed_institution_ids: manifestStatus === 'complete' ? ['bank_a'] : [],
        errors: manifestStatus === 'complete' ? [] : [{institution_id: 'bank_a', error: 'failed'}]
    }));
    if (includePreviousComplete) {
        fs.writeFileSync(path.join(root, 'data/work/source-refresh-runs/run-0.json'), JSON.stringify({
            run_id: 'run-0',
            status: 'complete',
            completed_at: '2026-07-13T11:01:00.000Z',
            expected_institution_ids: ['bank_a'],
            completed_institution_ids: ['bank_a'],
            errors: []
        }));
    }
}

describe('next-batch changed-sources', () => {
    it('uses only changed offers after a complete matching refresh', () => {
        const root = makeTempDir();
        writeFixture(root);
        const output = execFileSync(node, [nextBatch, '--mode', 'changed-sources', '--n', '1'], {
            cwd: root,
            encoding: 'utf8',
            env: env(root)
        });
        const rows = JSON.parse(output);
        expect(rows).toHaveLength(1);
        expect(rows[0].source_changes.changed).toBe(true);
        expect(rows[0].source_refresh_run_id).toBe('run-1');
    });

    it('rejects a partial refresh instead of selecting from stale cache', () => {
        const root = makeTempDir();
        writeFixture(root, {manifestStatus: 'partial', includePreviousComplete: true});
        expectCommandFailure(root, [nextBatch, '--mode', 'changed-sources']);
    });

    it('rejects cache from a different refresh cycle', () => {
        const root = makeTempDir();
        writeFixture(root, {cacheRunId: 'run-old'});
        expectCommandFailure(root, [nextBatch, '--mode', 'changed-sources']);
    });
});
