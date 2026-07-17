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
});
