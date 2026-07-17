import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {evaluateContent} from '../../.agents/skills/bank-market-scan/tools/lib/content-check.mjs';

const keywords = {
    product: ['kredyt hipoteczny'],
    refinancing: ['refinansowanie kredytu'],
    fixed_rate: ['stała stopa'],
    pricing: ['tabela oprocentowania'],
    documents: ['zaświadczenie z banku']
};

function materialFile(content, extension = '.html') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-content-check-'));
    const file = path.join(dir, `source${extension}`);
    fs.writeFileSync(file, content);
    return file;
}

function candidate(url, cacheFile, title = 'Kredyt hipoteczny') {
    return {url, final_url: url, title, cache_file: cacheFile, available: true, content_type: 'text/html'};
}

describe('deterministic content check', () => {
    it('accepts a single readable URL with all three coverage categories', async () => {
        const result = await evaluateContent([
            candidate('https://bank.example.pl/oferta', materialFile('<html><body>Kredyt hipoteczny. Refinansowanie kredytu. Stała stopa przez 5 lat.</body></html>'))
        ], keywords);
        expect(result.product.status).toBe('present');
        expect(result.refinancing.status).toBe('present');
        expect(result.fixed_rate.status).toBe('present');
        expect(result.single_url_full_coverage).toBe(true);
        expect(result.sufficient_for_search_first).toBe(true);
        expect(result.product_relation.basis).toBe('single_url_full_coverage');
    });

    it('confirms multi-source coverage only when the product page links to the rate source', async () => {
        const productUrl = 'https://bank.example.pl/oferta';
        const rateUrl = 'https://bank.example.pl/tabela';
        const result = await evaluateContent([
            candidate(productUrl, materialFile(`<a href="${rateUrl}">Tabela oprocentowania</a>Kredyt hipoteczny. Refinansowanie kredytu.`)),
            candidate(rateUrl, materialFile('Tabela oprocentowania: stała stopa przez 5 lat.'), 'Tabela oprocentowania')
        ], keywords);
        expect(result.single_url_full_coverage).toBe(false);
        expect(result.product_relation).toMatchObject({status: 'confirmed', basis: 'product_page_links_to_rate_or_document'});
        expect(result.multi_source_coverage).toBe(true);
        expect(result.sufficient_for_search_first).toBe(true);
    });

    it('does not confirm sources merely because they share a domain', async () => {
        const result = await evaluateContent([
            candidate('https://bank.example.pl/product', materialFile('Kredyt hipoteczny.'), 'Oferta produktu A'),
            candidate('https://bank.example.pl/refi', materialFile('Refinansowanie kredytu.'), 'Informacja B'),
            candidate('https://bank.example.pl/rate', materialFile('Stała stopa przez 5 lat.'), 'Tabela C')
        ], keywords);
        expect(result.product_relation.status).toBe('possible');
        expect(result.multi_source_coverage).toBe(false);
        expect(result.sufficient_for_search_first).toBe(false);
    });

    it('returns unknown instead of absent for an unreadable source', async () => {
        const result = await evaluateContent([{
            url: 'https://bank.example.pl/unavailable',
            title: 'Oferta',
            cache_file: '/tmp/does-not-exist-bank-market-scan.html',
            available: false
        }], keywords);
        expect(result.product.status).toBe('unknown');
        expect(result.refinancing.status).toBe('unknown');
        expect(result.fixed_rate.status).toBe('unknown');
        expect(result.unknown_source_count).toBe(1);
    });

    it('recognizes an inflected refinancing phrase from a bank page', async () => {
        const result = await evaluateContent([
            candidate('https://bank.example.pl/oferta', materialFile(
                'Kredyt hipoteczny. Możliwa jest splatę zadłuzenia z tytulu innego kredytu mieszkaniowego z innego banku. Stała stopa przez 5 lat.'
            ))
        ], {
            ...keywords,
            refinancing: ['spłatę zadłużenia z tytułu innego kredytu mieszkaniowego']
        });
        expect(result.refinancing.status).toBe('present');
        expect(result.single_url_full_coverage).toBe(true);
    });

    it('passes readable two-signal material to the model instead of rejecting it heuristically', async () => {
        const result = await evaluateContent([
            candidate('https://bank.example.pl/oferta', materialFile(
                'Kredyt hipoteczny. Stała stopa przez 60 miesięcy.'
            ))
        ], keywords);
        expect(result.sufficient_for_search_first).toBe(false);
        expect(result.sufficient_for_analysis).toBe(true);
        expect(result.sufficiency_basis).toBe('multi_signal_analysis');
    });
});
