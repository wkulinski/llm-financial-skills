import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {classifyRefinancingContext, evaluateContent} from '../../.agents/skills/bank-market-scan/tools/lib/content-check.mjs';

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
    it('classifies refinancing context instead of treating every keyword as commercial evidence', () => {
        expect(classifyRefinancingContext({title: 'Oferta kredytu'}, 'refinansowanie kosztów poniesionych na cele mieszkaniowe')).toBe('refinance_of_own_housing_expenses');
        expect(classifyRefinancingContext({title: 'Fundusz Wsparcia'}, 'spłata zaległych rat kredytu')).toBe('existing_debt_support');
        expect(classifyRefinancingContext({title: 'Kredyt dla wspólnot'}, 'refinansowanie kredytu')).toBe('community_or_business_loan');
        expect(classifyRefinancingContext({title: 'Kredyt mieszkaniowy'}, 'spłata kredytu mieszkaniowego zaciągniętego w innym banku')).toBe('commercial_refinance_of_mortgage');
    });

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
        expect(result.missing_categories).toEqual(expect.arrayContaining(['refinancing', 'fixed_rate']));
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

    it('recognizes the bank wording for repayment of a mortgage from another bank', async () => {
        const result = await evaluateContent([
            candidate('https://bank.example.pl/oferta', materialFile(
                'Kredyt mieszkaniowy. Możliwa jest spłatę kredytu mieszkaniowego zaciągniętego w innym banku. Oprocentowanie okresowo stałe.'
            ))
        ], {
            ...keywords,
            refinancing: ['spłatę kredytu mieszkaniowego zaciągniętego w innym banku'],
            fixed_rate: ['oprocentowanie okresowo stałe']
        });
        expect(result.refinancing.status).toBe('present');
        expect(result.refinancing.matches).toBeGreaterThan(0);
    });

    it('excludes debt-support pages from new-loan refinancing evidence', async () => {
        const result = await evaluateContent([
            candidate('https://bank.example.pl/kredyty/mieszkaniowy', materialFile(
                'Kredyt mieszkaniowy. Oprocentowanie okresowo stałe przez 60 miesięcy.'
            )),
            candidate('https://bank.example.pl/fundusz-wsparcia/', materialFile(
                'Fundusz Wsparcia Kredytobiorców. Refinansowanie kredytu nie jest ofertą nowego kredytu. Pomoc obejmuje spłatę kredytu mieszkaniowego i zaległych rat.'
            ), 'Fundusz Wsparcia Kredytobiorców')
        ], keywords);

        expect(result.refinancing.status).toBe('present');
        expect(result.refinancing.review_required).toBe(true);
        expect(result.refinancing.context_flags).toEqual([
            {url: 'https://bank.example.pl/fundusz-wsparcia/', reason: 'existing_debt_support'}
        ]);
        expect(result.refinancing.decision_status).toBe('excluded_context');
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
