import {describe, expect, it} from 'vitest';
import {
    aggregateSearchStatus,
    mergeSearchResults,
    rankSearchResults,
    selectSearchSeeds
} from '../../.agents/skills/bank-market-scan/tools/lib/discovery.mjs';

const keywords = {
    product: ['kredyt hipoteczny'],
    refinancing: ['refinansowanie kredytu'],
    fixed_rate: ['stała stopa'],
    pricing: ['tabela oprocentowania'],
    documents: ['zaświadczenie z banku']
};

describe('search-first discovery selection', () => {
    it('keeps Google position primary and uses local score as a tie-breaker', () => {
        const ranked = rankSearchResults([
            {url: 'https://bank.example.pl/kontakt', title: 'Kontakt', snippet: '', search_rank: 1},
            {url: 'https://bank.example.pl/kredyt-hipoteczny', title: 'Kredyt hipoteczny stała stopa', snippet: '', search_rank: 2},
            {url: 'https://bank.example.pl/kredyt-hipoteczny-2', title: 'Kredyt hipoteczny', snippet: '', search_rank: 2}
        ], keywords);
        expect(ranked.map(result => result.search_rank)).toEqual([1, 2, 2]);
        expect(ranked[1].url).toBe('https://bank.example.pl/kredyt-hipoteczny');
        expect(ranked[1].positive_signals).toContain('product');
        expect(ranked[0].negative_signals).toContain('contact');
    });

    it('does not require a minimum number and preserves material diversity when available', () => {
        const ranked = rankSearchResults([
            {url: 'https://bank.example.pl/product', title: 'Kredyt hipoteczny', snippet: '', search_rank: 1},
            {url: 'https://bank.example.pl/rate', title: 'Tabela oprocentowania stała stopa', snippet: '', search_rank: 2},
            {url: 'https://bank.example.pl/refi', title: 'Refinansowanie kredytu', snippet: '', search_rank: 3}
        ], keywords);
        const selected = selectSearchSeeds(ranked, {maxResults: 3});
        expect(selected).toHaveLength(3);
        expect(selected.map(result => result.url)).toEqual([
            'https://bank.example.pl/product',
            'https://bank.example.pl/refi',
            'https://bank.example.pl/rate'
        ]);
        expect(selectSearchSeeds(ranked, {maxResults: 1})).toHaveLength(1);
    });

    it('aggregates provider statuses and deduplicates URLs across queries', () => {
        const runs = [
            {query: 'one', status: 'ok', results: [{url: 'https://bank.example.pl/a'}]},
            {query: 'two', status: 'unavailable', results: []}
        ];
        expect(aggregateSearchStatus(runs)).toBe('partial');
        expect(mergeSearchResults([...runs, {query: 'three', status: 'ok', results: [{url: 'https://bank.example.pl/a'}, {url: 'https://bank.example.pl/b'}]}])).toHaveLength(2);
    });
});
