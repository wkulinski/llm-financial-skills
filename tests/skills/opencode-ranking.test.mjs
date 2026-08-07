import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {DEFAULT_OPENCODE_TIMEOUT_MS, parseOpenCodeOutput, runOpenCodeRanking} from '../../.agents/skills/bank-market-scan/tools/lib/opencode-ranking.mjs';
import {DEFAULT_RANKING_BUDGET_MS, DEFAULT_RANKING_TIMEOUT_MS, buildRankingManifest, rankManifest} from '../../.agents/skills/bank-market-scan/tools/lib/url-ranking.mjs';

function validRanking() {
    return JSON.stringify({
        schema_version: '1.1',
        institution_id: 'bank_a',
        run_id: 'run-test',
        ranked_candidates: [{
            candidate_ref: 'c0001',
            priority: 3,
            role: 'core',
            reason: 'Metadata identifies a mortgage offer.',
            model_confidence: 'medium'
        }],
        model: {provider: 'opencode', model: 'test', prompt_version: '1'}
    });
}

function rankingForPrompt(prompt) {
    const start = prompt.indexOf('<manifest_json>') + '<manifest_json>'.length;
    const end = prompt.indexOf('</manifest_json>');
    const manifest = JSON.parse(prompt.slice(start, end));
    return JSON.stringify({
        schema_version: manifest.schema_version,
        institution_id: manifest.institution_id,
        run_id: manifest.run_id,
        ranked_candidates: manifest.candidates.map(candidate => ({
            candidate_ref: candidate.candidate_ref,
            priority: 1,
            role: 'unknown',
            reason: 'Metadata requires content verification.',
            model_confidence: 'low'
        })),
        model: {provider: 'opencode', model: 'test', prompt_version: '1'}
    });
}

function createChild({stdout = '', stderr = '', code = 0, delay = 0, onKill} = {}) {
    const child = new EventEmitter();
    child.pid = 987654;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => onKill?.();
    if (delay !== null) {
        setTimeout(() => {
            if (stdout) child.stdout.emit('data', stdout);
            if (stderr) child.stderr.emit('data', stderr);
            child.emit('close', code, null);
        }, delay);
    }
    return child;
}

async function manifestPath() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-ranking-'));
    const filePath = path.join(directory, 'manifest.json');
    await fs.writeFile(filePath, JSON.stringify({
        schema_version: '1.1',
        institution_id: 'bank_a',
        run_id: 'run-test',
        candidates: [{candidate_ref: 'c0001', url: 'https://bank.example/offer'}]
    }));
    return filePath;
}

describe('OpenCode ranking adapter', () => {
    it('keeps model ranking timeouts bounded for the normal path', () => {
        expect(DEFAULT_OPENCODE_TIMEOUT_MS).toBe(120_000);
        expect(DEFAULT_RANKING_TIMEOUT_MS).toBe(120_000);
        expect(DEFAULT_RANKING_BUDGET_MS).toBe(150_000);
    });

    it('parses JSON event output and keeps stderr separate', async () => {
        const result = await runOpenCodeRanking(await manifestPath(), {
            spawnImpl: (_command, _args, _options) => createChild({
                stdout: `${JSON.stringify({part: {text: validRanking()}})}\n`,
                stderr: 'diagnostic warning\n'
            })
        });

        expect(result.ranking.institution_id).toBe('bank_a');
        expect(result.stderr).toContain('diagnostic warning');
        expect(result.raw).not.toContain('diagnostic warning');
        expect(result.attempts).toHaveLength(1);
    });

    it('accepts JSON wrapped in ordinary text', () => {
        expect(parseOpenCodeOutput(`event: ${validRanking()}\n`)).toMatchObject({run_id: 'run-test'});
    });

    it('retries transport errors in the adapter', async () => {
        let calls = 0;
        const result = await runOpenCodeRanking(await manifestPath(), {
            retries: 1,
            spawnImpl: () => {
                calls += 1;
                return createChild(calls === 1
                    ? {stderr: 'temporary failure', code: 1}
                    : {stdout: validRanking()});
            }
        });

        expect(calls).toBe(2);
        expect(result.attempts.map(attempt => attempt.status)).toEqual(['error', 'accepted']);
    });

    it('retries after malformed JSON output', async () => {
        let calls = 0;
        const result = await runOpenCodeRanking(await manifestPath(), {
            retries: 1,
            spawnImpl: () => {
                calls += 1;
                return createChild({stdout: calls === 1 ? 'not-json' : validRanking()});
            }
        });

        expect(calls).toBe(2);
        expect(result.attempts.map(attempt => attempt.status)).toEqual(['error', 'accepted']);
    });

    it('rejects empty output and oversized stdout', async () => {
        await expect(runOpenCodeRanking(await manifestPath(), {
            retries: 0,
            spawnImpl: () => createChild()
        })).rejects.toThrow('Subagent response did not contain JSON');

        await expect(runOpenCodeRanking(await manifestPath(), {
            retries: 0,
            maxBuffer: 8,
            spawnImpl: () => createChild({stdout: '0123456789'})
        })).rejects.toMatchObject({code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
    });

    it('terminates a process after timeout', async () => {
        let killed = false;
        await expect(runOpenCodeRanking(await manifestPath(), {
            timeoutMs: 5,
            retries: 0,
            spawnImpl: () => createChild({delay: null, onKill: () => { killed = true; }})
        })).rejects.toMatchObject({code: 'ETIMEDOUT'});
        expect(killed).toBe(true);
    });

    it('falls back deterministically after a rankManifest timeout', async () => {
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-timeout',
            candidates: [{url: 'https://bank.example/offer', title: 'Offer', source: 'search', relation: 'same_host'}]
        });
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-timeout-fallback-'));
        const result = await rankManifest(manifest, {
            workDir,
            useOpenCode: true,
            timeoutMs: 5,
            retries: 0,
            spawnImpl: () => createChild({delay: null})
        });

        expect(result.provider).toBe('deterministic_fallback');
        expect(result.ranking.ranked_candidates).toHaveLength(1);
        expect(result.attempts).toEqual([expect.objectContaining({status: 'timeout'})]);
    });

    it('sends one complete manifest without chunk files', async () => {
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-full-manifest',
            candidates: Array.from({length: 31}, (_, index) => ({
                url: `https://bank.example/offer-${index + 1}`,
                title: `Offer ${index + 1}`,
                source: 'search',
                relation: 'same_host'
            }))
        });
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-full-manifest-'));
        let calls = 0;
        const result = await rankManifest(manifest, {
            workDir,
            useOpenCode: true,
            retries: 0,
            spawnImpl: (_command, args) => {
                calls += 1;
                return createChild({stdout: rankingForPrompt(args.at(-1))});
            }
        });
        const runDir = path.join(workDir, 'run-full-manifest', 'bank_a');
        const files = await fs.readdir(runDir);

        expect(calls).toBe(1);
        expect(result.provider).toBe('opencode');
        expect(result.ranking.ranked_candidates).toHaveLength(31);
        expect(files.some(file => file.includes('.part-'))).toBe(false);
    });

    it('instructs the LLM to exclude only high-confidence non-target URL contexts', async () => {
        let prompt = '';
        await runOpenCodeRanking(await manifestPath(), {
            spawnImpl: (_command, args) => {
                prompt = args.at(-1);
                return createChild({stdout: validRanking()});
            }
        });

        expect(prompt).toContain('fundusz wsparcia');
        expect(prompt).toContain('Use excluded_context only for high-confidence non-target pages');
        expect(prompt).toContain('Do not exclude a URL merely because it lacks positive signals');
    });

    it('keeps an LLM-excluded URL out of the initial selection pool', async () => {
        const manifest = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 4, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-llm-excluded-context',
            candidates: [
                {url: 'https://bank.example/fundusz-wsparcia', title: 'Fundusz wsparcia', source: 'homepage', relation: 'same_host'},
                {url: 'https://bank.example/kredyt-mieszkaniowy', title: 'Kredyt mieszkaniowy', source: 'homepage', relation: 'same_host'}
            ]
        });
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-excluded-context-'));
        const result = await rankManifest(manifest, {
            workDir,
            useOpenCode: true,
            retries: 0,
            spawnImpl: (_command, args) => {
                const start = args.at(-1).indexOf('<manifest_json>') + '<manifest_json>'.length;
                const end = args.at(-1).indexOf('</manifest_json>');
                const input = JSON.parse(args.at(-1).slice(start, end));
                return createChild({stdout: JSON.stringify({
                    schema_version: input.schema_version,
                    institution_id: input.institution_id,
                    run_id: input.run_id,
                    ranked_candidates: input.candidates.map(candidate => ({
                        candidate_ref: candidate.candidate_ref,
                        priority: candidate.title.includes('Fundusz') ? 0 : 3,
                        role: candidate.title.includes('Fundusz') ? 'excluded_context' : 'core',
                        reason: candidate.title.includes('Fundusz') ? 'Fundusz wsparcia, not refinancing offer.' : 'Mortgage offer.',
                        model_confidence: 'high'
                    })),
                    model: {provider: 'opencode', model: 'test', prompt_version: '1'}
                })});
            }
        });
        const selection = JSON.parse(await fs.readFile(result.selectionReportPath, 'utf8'));

        expect(result.ranking.ranked_candidates.find(candidate => candidate.role === 'excluded_context')).toBeTruthy();
        expect(selection.selected_pool).not.toContain('https://bank.example/fundusz-wsparcia');
        expect(selection.selected_pool).toContain('https://bank.example/kredyt-mieszkaniowy');
    });

    it('does not invoke OpenCode for empty or fully locked inventories', async () => {
        let calls = 0;
        const spawnImpl = () => { calls += 1; throw new Error('OpenCode must not run'); };
        const empty = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-empty',
            candidates: []
        });
        const locked = buildRankingManifest({
            institution: {institution_id: 'bank_a', lp: 1, name: 'Bank A'},
            homepageUrl: 'https://bank.example/',
            runId: 'run-locked',
            candidates: [
                {url: 'https://bank.example/karty', title: 'Karty płatnicze', source: 'homepage', relation: 'same_host'},
                {url: 'https://bank.example/polityka-cookies', title: 'Polityka cookies', source: 'homepage', relation: 'same_host'}
            ]
        });
        const emptyResult = await rankManifest(empty, {workDir: await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-empty-')), spawnImpl});
        const lockedResult = await rankManifest(locked, {workDir: await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-locked-')), spawnImpl});

        expect(calls).toBe(0);
        expect(emptyResult.provider).toBe('deterministic');
        expect(lockedResult.provider).toBe('deterministic');
        expect(lockedResult.ranking.ranked_candidates.every(candidate => candidate.role === 'excluded_context')).toBe(true);
    });
});
