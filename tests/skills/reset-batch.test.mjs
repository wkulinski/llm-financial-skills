import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-reset-batch-'));
    fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data/work/row-updates'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data/work/review-packs'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data/cache/institutions/001-bank-a'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data/cache/institutions/002-bank-b'), {recursive: true});
    fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({institutions: [
        {lp: 1, institution_id: 'bank_a', type: 'bank_spoldzielczy', name: 'Bank A', website_url: 'https://bank-a.example'},
        {lp: 2, institution_id: 'bank_b', type: 'bank_spoldzielczy', name: 'Bank B', website_url: 'https://bank-b.example'}
    ]}));
    fs.writeFileSync(path.join(root, 'data/work/analysis-state.json'), JSON.stringify({schema_version: '1.1', rows: [
        {lp: 1, institution_id: 'bank_a', review_status: 'checked', qualifies: true, offer: {rate: 0.06}},
        {lp: 2, institution_id: 'bank_b', review_status: 'checked', qualifies: false}
    ]}));
    fs.writeFileSync(path.join(root, 'data/work/automation-state.json'), JSON.stringify({tasks: [
        {lp: 1, institution_id: 'bank_a', stage: 'prepared', attempt_count: 4},
        {lp: 2, institution_id: 'bank_b', stage: 'checked', attempt_count: 2}
    ]}));
    fs.writeFileSync(path.join(root, 'data/work/evidence.jsonl'), `${JSON.stringify({lp: 1, institution_id: 'bank_a', text: 'old'})}\n${JSON.stringify({lp: 2, institution_id: 'bank_b', text: 'keep'})}\n`);
    fs.writeFileSync(path.join(root, 'data/cache/institutions/001-bank-a/old.html'), 'old');
    fs.writeFileSync(path.join(root, 'data/cache/institutions/002-bank-b/keep.html'), 'keep');
    fs.writeFileSync(path.join(root, 'data/work/review-packs/lp-001.md'), 'old pack');
    fs.writeFileSync(path.join(root, 'data/work/row-updates/lp-001.json'), '{}');
    return root;
}

describe('reset-batch', () => {
    it('backs up and resets only the selected institutions', () => {
        const root = makeProject();
        const output = execFileSync(node, [
            path.join(skillRoot, 'tools/reset-batch.mjs'),
            '--from', '1', '--limit', '1', '--clear-cache', '--clear-analysis', '--run-id', 'test-reset'
        ], {cwd: root, encoding: 'utf8', env: {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root}});
        expect(output).toContain('test-reset');

        const state = JSON.parse(fs.readFileSync(path.join(root, 'data/work/analysis-state.json'), 'utf8'));
        const automation = JSON.parse(fs.readFileSync(path.join(root, 'data/work/automation-state.json'), 'utf8'));
        expect(state.rows[0].review_status).toBe('unchecked');
        expect(state.rows[0].offer).toEqual({});
        expect(state.rows[1].review_status).toBe('checked');
        expect(automation.tasks[0]).toMatchObject({stage: 'pending_prepare', attempt_count: 0, run_id: 'test-reset'});
        expect(automation.tasks[1].stage).toBe('checked');
        expect(fs.existsSync(path.join(root, 'data/cache/institutions/001-bank-a'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'data/cache/institutions/002-bank-b/keep.html'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'data/work/review-packs/lp-001.md'))).toBe(false);
        expect(fs.readFileSync(path.join(root, 'data/work/evidence.jsonl'), 'utf8')).toContain('bank_b');
        const backup = fs.readdirSync(path.join(root, 'data/work/backups'))[0];
        const backupRoot = path.join(root, 'data/work/backups', backup);
        const backupManifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
        expect(backupManifest.selected_lps).toEqual([1]);
        expect(JSON.parse(fs.readFileSync(path.join(backupRoot, 'work/analysis-state.json'), 'utf8')).rows[0].offer).toEqual({rate: 0.06});
        expect(fs.readFileSync(path.join(backupRoot, 'cache/institutions/001-bank-a/old.html'), 'utf8')).toBe('old');
        expect(fs.readFileSync(path.join(backupRoot, 'work/review-packs/lp-001.md'), 'utf8')).toBe('old pack');
    });
});
