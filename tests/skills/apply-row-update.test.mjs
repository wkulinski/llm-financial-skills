import {describe, expect, it} from 'vitest';
import {findRowForUpdate, mergeRowUpdate} from '../../.agents/skills/bank-market-scan/tools/apply-row-update.mjs';

describe('apply-row-update safety', () => {
    const rows = [
        {
            institution_id: 'bank_a',
            lp: 1,
            offer: {product_name: 'Old', rrso: 0.061},
            requirements: {account_required: true}
        },
        {institution_id: 'bank_b', lp: 2, offer: {fixed_nominal_rate: 0.063}}
    ];

    it('finds a row only when institution_id and lp point to the same row', () => {
        expect(findRowForUpdate(rows, {institution_id: 'bank_a', lp: 1})).toBe(0);
        expect(() => findRowForUpdate(rows, {institution_id: 'bank_a', lp: 2})).toThrow(/ambiguous|mismatch/i);
        expect(() => findRowForUpdate(rows, {institution_id: 'bank_x', lp: 1})).toThrow(/mismatch/i);
    });

    it('deep-merges nested update objects instead of replacing the whole section', () => {
        const merged = mergeRowUpdate(rows[0], {
            institution_id: 'bank_a',
            lp: 1,
            review_status: 'checked',
            offer: {product_name: 'New'},
            requirements: {card_payments_required: true}
        });
        expect(merged.offer).toEqual({product_name: 'New', rrso: 0.061});
        expect(merged.requirements).toEqual({account_required: true, card_payments_required: true});
    });

    it('replaces field evidence for a fresh interpretation instead of retaining stale IDs', () => {
        const merged = mergeRowUpdate({
            institution_id: 'bank_a',
            lp: 1,
            field_evidence: {
                product: [{evidence_id: 'old-product'}],
                refinancing: [{evidence_id: 'old-refinancing'}]
            }
        }, {
            institution_id: 'bank_a',
            lp: 1,
            field_evidence: {
                product: [{evidence_id: 'new-product'}]
            }
        });
        expect(merged.field_evidence).toEqual({product: [{evidence_id: 'new-product'}]});
    });
});
