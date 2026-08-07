import {describe, expect, it} from 'vitest';
import {classifySourceRole} from '../../.agents/skills/bank-market-scan/tools/lib/source-roles.mjs';

describe('review source roles', () => {
    it('keeps the mortgage product page in core sources', () => {
        expect(classifySourceRole({url: 'https://bank.example/kredyt-mieszkaniowy'}, ['product', 'fixed_rate'])).toBe('core');
    });

    it('marks unrelated cash products as excluded context', () => {
        expect(classifySourceRole({url: 'https://bank.example/kredyty-gotowkowe', title: 'Kredyt gotówkowy'}, ['fixed_rate', 'pricing'])).toBe('excluded_context');
    });

    it('keeps a tariff as supporting material', () => {
        expect(classifySourceRole({url: 'https://bank.example/taryfa-oplat'}, ['pricing'])).toBe('supporting');
    });

    it('does not treat homepage or sitemap context as core evidence', () => {
        expect(classifySourceRole({url: 'https://bank.example/'}, ['product'])).toBe('discovery_context');
        expect(classifySourceRole({url: 'https://bank.example/sitemap.xml'}, ['product'])).toBe('discovery_context');
    });

    it('does not treat a calculator as a product proof', () => {
        expect(classifySourceRole({url: 'https://bank.example/kalkulator-kredytowy', title: 'Kalkulator'}, ['product', 'fixed_rate'])).toBe('supporting');
    });
});
