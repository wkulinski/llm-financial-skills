import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {DEFAULT_MORFEUSZ_PYTHON, findLemmaMatch, prepareMorphology} from '../../.agents/skills/bank-market-scan/tools/lib/morphology.mjs';

async function materialFile() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-morphology-'));
    const cacheFile = path.join(directory, 'source.html');
    await fs.writeFile(cacheFile, '<html></html>');
    return {url: 'https://bank.example.pl/oferta', text: 'spłatę kredytu mieszkaniowego', cache_file: cacheFile};
}

describe('required Morfeusz morphology', () => {
    it('starts the Morfeusz worker and matches an inflected form by lemma', async () => {
        const material = await materialFile();
        const morphology = await prepareMorphology([material], {refinancing: ['spłata kredytu mieszkaniowego']});

        expect(DEFAULT_MORFEUSZ_PYTHON).toMatch(/\.venv[\\/]bin[\\/]python$/);
        expect(morphology.available).toBe(true);
        expect(findLemmaMatch(material, morphology, 'refinancing', 0)).toEqual(expect.objectContaining({
            text_excerpt: expect.stringContaining('spłatę kredytu mieszkaniowego')
        }));
    });

    it('fails instead of silently using surface-form matching when Morfeusz is unavailable', async () => {
        const material = await materialFile();

        await expect(prepareMorphology([material], {refinancing: ['spłata']}, {
            pythonCommand: '/definitely/missing/morfeusz-python'
        })).rejects.toThrow(/surface-form fallback is disabled|Morfeusz 2 is required/);
    });
});
