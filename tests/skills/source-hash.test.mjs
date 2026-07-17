import {describe, expect, it} from 'vitest';
import {sha256} from '../../.agents/skills/bank-market-scan/tools/lib/common.mjs';

describe('source hash helpers', () => {
    it('computes stable sha256 hashes for buffers and strings', () => {
        expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});
