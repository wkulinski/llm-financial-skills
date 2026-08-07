import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {normalizeUrlIdentity, sourceCacheFile, sha256} from '../../.agents/skills/bank-market-scan/tools/lib/common.mjs';
import {hardExclusionReason, isCriticalSourceCandidate, validateCandidateCaches} from '../../.agents/skills/bank-market-scan/tools/lib/source-integrity.mjs';
import {evaluateContent} from '../../.agents/skills/bank-market-scan/tools/lib/content-check.mjs';

describe('source integrity', () => {
    it('treats www, trailing slash and index.html as the same URL identity', () => {
        expect(normalizeUrlIdentity('https://www.bank.example/oferta/index.html'))
            .toBe(normalizeUrlIdentity('https://bank.example/oferta/'));
    });

    it('does not make low-priority crawl noise a critical source error', () => {
        expect(isCriticalSourceCandidate({source: 'homepage', score: 0, prioritized_candidate: false})).toBe(false);
        expect(isCriticalSourceCandidate({source: 'search', score: 0})).toBe(true);
    });

    it('hard-excludes canonical mismatches, blocked/error pages, and pagination noise', () => {
        expect(hardExclusionReason({source_integrity_flags: ['source_url_mismatch']})).toBe('source_url_mismatch');
        expect(hardExclusionReason({status: 403})).toBe('http_403');
        expect(hardExclusionReason({url: 'https://bank.example/page/2/?et_blog=', title: 'Starsze wpisy'}))
            .toBe('navigation_or_archive_noise');
    });
    it('creates different cache files for different URLs with the same title prefix', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-source-integrity-'));
        const first = sourceCacheFile(dir, 'https://auretbank.pl/klienci-indywidualni/kredyty/kredyt-mieszkaniowy');
        const second = sourceCacheFile(dir, 'https://auretbank.pl/klienci-indywidualni/oszczednosci/lokata-na-nowe-srodki');
        expect(first).not.toBe(second);
    });

    it('reports a cache collision and a content hash mismatch', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-source-integrity-'));
        const file = path.join(dir, 'source.html');
        const body = Buffer.from('mortgage offer');
        fs.writeFileSync(file, body);
        const errors = await validateCandidateCaches([
            {url: 'https://bank.example/mortgage', cache_file: file, content_sha256: sha256(body), content_length: body.length},
            {url: 'https://bank.example/deposit', cache_file: file, content_sha256: sha256('deposit'), content_length: 7}
        ]);
        expect(errors.map(error => error.type)).toEqual(expect.arrayContaining(['cache_file_collision', 'content_hash_mismatch', 'content_length_mismatch']));
    });

    it('does not use HTML marked as a canonical URL mismatch for coverage', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-source-integrity-'));
        const file = path.join(dir, 'source.html');
        fs.writeFileSync(file, '<html><body>Kredyt hipoteczny. Refinansowanie kredytu. Stała stopa przez 5 lat.</body></html>');
        const result = await evaluateContent([{
            url: 'https://bank.example/mortgage',
            final_url: 'https://bank.example/mortgage',
            title: 'Oferta',
            cache_file: file,
            available: true,
            content_type: 'text/html',
            source_integrity_flags: ['source_url_mismatch']
        }], {
            product: ['kredyt hipoteczny'],
            refinancing: ['refinansowanie kredytu'],
            fixed_rate: ['stała stopa']
        });
        expect(result.sufficient_for_analysis).toBe(false);
        expect(result.integrity_errors).toContain('source_url_mismatch');
    });
});
