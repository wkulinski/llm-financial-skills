import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bank-normalize-text-'));
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

describe('separate Morfeusz normalization step', () => {
    it('writes hash-bound tokens and lets evidence matching use the original excerpt', () => {
        const cwd = makeTempDir();
        const cacheDir = path.join(cwd, 'cache');
        fs.mkdirSync(cacheDir, {recursive: true});
        const text = 'Kredyt mieszkaniowy umożliwia spłatę kredytu mieszkaniowego zaciągniętego w innym banku. Oprocentowanie okresowo stałe.';
        fs.writeFileSync(path.join(cacheDir, 'source-text.jsonl'), `${JSON.stringify({
            institution_id: 'bank_a',
            lp: 1,
            name: 'Bank A',
            run_id: 'run-normalize-1',
            url: 'https://bank-a.example/oferta',
            title: 'Kredyt mieszkaniowy',
            source_type: 'html',
            content_sha256: 'content-hash',
            fetched_at: '2026-08-03',
            text
        })}\n`);

        execFileSync(node, [path.join(skillRoot, 'tools/normalize-text.mjs'), '--cache-dir', cacheDir], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        });
        const artifact = readJson(path.join(cacheDir, 'normalized-text.json'));
        const source = artifact.sources[0];
        expect(artifact.status).toBe('complete');
        expect(source.status).toBe('normalized');
        expect(source.source_text_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(source.tokens.some(token => token.surface === 'spłatę' && token.lemma === 'spłata')).toBe(true);

        execFileSync(node, [path.join(skillRoot, 'tools/grep-evidence.mjs'), '--cache-dir', cacheDir], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        });
        const evidence = readJsonl(path.join(cacheDir, 'evidence.candidates.jsonl'));
        const refinancing = evidence.find(row => row.category === 'refinancing' && row.keyword === 'spłatę kredytu mieszkaniowego zaciągniętego w innym banku');
        expect(refinancing).toBeDefined();
        expect(refinancing.match_type).toBe('lemma');
        expect(refinancing.text_excerpt).toContain('spłatę kredytu mieszkaniowego');
    });

    it('rejects a partial normalization artifact instead of silently falling back', () => {
        const cwd = makeTempDir();
        const cacheDir = path.join(cwd, 'cache');
        fs.mkdirSync(cacheDir, {recursive: true});
        fs.writeFileSync(path.join(cacheDir, 'source-text.jsonl'), `${JSON.stringify({
            institution_id: 'bank_a',
            lp: 1,
            url: 'https://bank-a.example/oferta',
            title: 'Oferta',
            source_type: 'html',
            text: 'Kredyt mieszkaniowy.'
        })}\n`);
        fs.writeFileSync(path.join(cacheDir, 'normalized-text.json'), JSON.stringify({
            schema_version: '1.0',
            engine: 'morfeusz2',
            status: 'partial',
            sources: [],
            keywords: {}
        }));

        expect(() => execFileSync(node, [path.join(skillRoot, 'tools/grep-evidence.mjs'), '--cache-dir', cacheDir], {
            cwd,
            encoding: 'utf8',
            env: toolEnv(cwd)
        })).toThrow(/not complete/);
    });
});
