import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const root = path.resolve('.');
const skillRoot = path.join(root, '.agents/skills/bank-market-scan');

describe('bank-market-scan documentation contract', () => {
    it('documents the automated refresh cycle and its change gate', () => {
        const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
        const readme = fs.readFileSync(path.join(skillRoot, 'README.md'), 'utf8');

        for (const document of [skill, readme]) {
            expect(document).toContain('prepare-batch.mjs --mode changed-only --refresh');
            expect(document).toContain('source-refresh-runs');
            expect(document).toContain('offer_changed_since_last_fetch');
            expect(document).toContain('material_sha256');
            expect(document).toContain('next-batch.mjs --mode changed-sources');
        }
    });

    it('keeps the changed-only mode visible in the CLI contract', () => {
        const help = execFileSync(process.execPath, [
            path.join(skillRoot, 'tools/prepare-batch.mjs'),
            '--help'
        ], {encoding: 'utf8'});

        expect(help).toContain('pending_prepare|retry|all|changed-only');
        expect(help).toContain('--changed-only');
    });

    it('documents automatic ranking and supersedes the legacy discovery plan', () => {
        const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
        const legacyPlan = fs.readFileSync(
            path.join(root, 'docs/draft/old/bank-market-scan-subagent-discovery-plan.md'),
            'utf8'
        );

        expect(skill).toContain('## Ranking URL-i po discovery');
        expect(skill).toContain('automatycznie po zamknięciu discovery');
        expect(skill).toContain('--ranking-provider deterministic');
        expect(skill).toContain('selection-report.json');
        expect(skill).toContain('nie dzieli listy na niezależne porcje');
        expect(legacyPlan).toContain('**Superseded.**');
        expect(legacyPlan).toContain('docs/draft/bank-market-scan-automatic-url-ranking-plan.md');
    });

    it('requires the runner to use exact-scope review checkpoints', () => {
        const agent = fs.readFileSync(path.join(root, '.opencode/agents/bank-market-scan-runner.md'), 'utf8');

        expect(agent).toContain('read-review-context.mjs --run-manifest');
        expect(agent).toContain('selected_count == manifest_count');
        expect(agent).toContain('interpreted_count == manifest_count');
        expect(agent).toContain('pending_count == 0');
        expect(agent).toContain('--offline --skip-discovery');
        expect(agent).toContain('live:false');
        expect(agent).toContain('Nie traktuj globalnego `analysis-state`');
        expect(agent).toContain('nie naprawiaj globalnego stanu przed przygotowaniem runu');
        expect(agent).toContain('selected`, `interpreted`, `applied` oraz `pending`');
    });
});
