import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeTempDir(prefix = 'bank-review-manifest-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function toolEnv(projectRoot) {
    return {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: projectRoot};
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('review-manifest', () => {
    it('exports ready and escalated queue items with file pointers', () => {
        const cwd = makeTempDir();
        fs.mkdirSync(path.join(cwd, 'data/base'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work/review-packs'), {recursive: true});
        fs.mkdirSync(path.join(cwd, 'data/work/row-updates'), {recursive: true});

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
                {lp: 2, institution_id: 'bank_b', review_status: 'needs_review', qualifies: null}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/automation-state.json'), JSON.stringify({
            schema_version: '1.0',
            tasks: [
                {lp: 1, institution_id: 'bank_a', stage: 'ready_for_review', attempt_count: 1, preprocessing_risk_flags: [], last_error: null, last_processed_at: '2026-07-10'},
                {lp: 2, institution_id: 'bank_b', stage: 'escalated', attempt_count: 2, preprocessing_risk_flags: ['missing_fixed_rate_hits'], preprocessing_status: 'insufficient', preprocessing_quality_warnings: ['missing_fixed_rate_hits'], last_error: 'Retry exhausted', last_processed_at: '2026-07-10'}
            ]
        }));
        fs.writeFileSync(path.join(cwd, 'data/work/review-packs/lp-001.md'), '# LP 1');
        fs.writeFileSync(path.join(cwd, 'data/work/row-updates/lp-002.json'), '{}');

        const manifestPath = path.join(cwd, 'data/exports/review-queue.json');
        const markdownPath = path.join(cwd, 'data/exports/review-queue.md');
        const output = execFileSync(node, [
            path.join(skillRoot, 'tools/review-manifest.mjs'),
            '--out', manifestPath,
            '--md-out', markdownPath
        ], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        });

        expect(output).toContain('"total": 2');
        const manifest = readJson(manifestPath);
        expect(manifest.summary.ready_for_review).toBe(1);
        expect(manifest.summary.escalated).toBe(1);
        expect(manifest.items.find(item => item.institution_id === 'bank_a').review_pack_path).toContain('lp-001.md');
        expect(manifest.items.find(item => item.institution_id === 'bank_b').row_update_path).toContain('lp-002.json');
        expect(manifest.items.find(item => item.institution_id === 'bank_b').preprocessing_status).toBe('insufficient');
        expect(manifest.items.find(item => item.institution_id === 'bank_b').preprocessing_quality_warnings).toContain('missing_fixed_rate_hits');
        expect(fs.existsSync(markdownPath)).toBe(true);
    });
});
