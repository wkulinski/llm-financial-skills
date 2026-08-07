import {describe, expect, it} from 'vitest';
import {buildProductBundles, evaluateProductBundles} from '../../.agents/skills/bank-market-scan/tools/lib/product-bundles.mjs';

const source = (url, title, text, role = 'core') => ({url, title, text, source_role: role});

describe('product bundles', () => {
    it('qualifies only one product bundle with all three criteria', () => {
        const bundles = buildProductBundles({
            institution_id: 'bank-1',
            sources: [source('https://bank.example/mortgage', 'Kredyt mieszkaniowy', 'Kredyt mieszkaniowy Refinansowanie kredytu mieszkaniowego Stała stopa')],
            criterionByUrl: {'https://bank.example/mortgage': ['housing', 'commercial_refinance', 'fixed_rate']}
        });
        expect(bundles).toHaveLength(1);
        expect(evaluateProductBundles(bundles)).toMatchObject({decision_status: 'qualified', qualified_bundle_count: 1});
        expect(bundles[0].product_id).toMatch(/^product-/);
    });

    it('does not join criteria from different products or excluded context', () => {
        const bundles = buildProductBundles({
            institution_id: 'bank-1',
            sources: [
                source('https://bank.example/mortgage', 'Kredyt mieszkaniowy', 'Kredyt mieszkaniowy'),
                source('https://bank.example/support', 'Fundusz Wsparcia', 'Refinansowanie kredytu', 'excluded_context'),
                source('https://bank.example/rate', 'Karta oprocentowania', 'Stała stopa', 'supporting')
            ],
            criterionByUrl: {
                'https://bank.example/mortgage': ['housing'],
                'https://bank.example/support': ['commercial_refinance'],
                'https://bank.example/rate': ['fixed_rate']
            }
        });
        expect(evaluateProductBundles(bundles).decision_status).not.toBe('qualified');
    });
});
