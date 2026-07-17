import {describe, expect, it} from 'vitest';
import {
    findAllNormalizedSnippets,
    findNormalizedSnippet,
    normalizeText,
    sourceDateFromText,
    isSameWebsite,
    sourceRelation
} from '../../.agents/skills/bank-market-scan/tools/lib/common.mjs';

describe('common text/date helpers', () => {
    it('normalizes Polish diacritics and punctuation consistently', () => {
        expect(normalizeText('Spłata kredytu mieszkaniowego – okresowo-stałe')).toBe('splata kredytu mieszkaniowego okresowo stale');
    });

    it('extracts snippets using original text positions despite normalization', () => {
        const text = 'Warunek: SPŁATA kredytu mieszkaniowego, a potem oprocentowanie okresowo-stałe przez 60 miesięcy.';
        const snippet = findNormalizedSnippet(text, 'spłata kredytu mieszkaniowego', 9);
        expect(snippet).not.toBeNull();
        expect(snippet.text_excerpt).toContain('SPŁATA kredytu mieszkaniowego');
        expect(snippet.text_excerpt).not.toContain('undefined');
    });

    it('extracts multiple normalized snippets for repeated keywords', () => {
        const text = 'Kredyt mieszkaniowy A. Potem przerwa. Kredyt mieszkaniowy B.';
        const snippets = findAllNormalizedSnippets(text, 'kredyt mieszkaniowy', 5, 5);
        expect(snippets).toHaveLength(2);
        expect(snippets[0].source_start).toBeLessThan(snippets[1].source_start);
    });

    it('parses numeric and Polish month source dates', () => {
        expect(sourceDateFromText('Ostatnia aktualizacja: 24.04.2026')).toBe('2026-04-24');
        expect(sourceDateFromText('Data aktualizacji: 24 kwietnia 2026 r.')).toBe('2026-04-24');
        expect(sourceDateFromText('Stan na dzień 2026-07-06')).toBe('2026-07-06');
    });

    it('treats www and non-www of the same host as the same website', () => {
        expect(isSameWebsite('https://www.example.pl/kredyty', 'https://example.pl')).toBe(true);
        expect(isSameWebsite('https://external.example.com/kredyty', 'https://example.com')).toBe(false);
    });

    it('distinguishes same website, related host and external host', () => {
        expect(sourceRelation('https://docs.example.pl/plik.pdf', 'https://www.example.pl')).toBe('related_host');
        expect(sourceRelation('https://cdn.other.net/plik.pdf', 'https://www.example.pl')).toBe('external');
    });
});
