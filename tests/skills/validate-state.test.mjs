import {describe, expect, it} from 'vitest';
import {validateRows} from '../../.agents/skills/bank-market-scan/tools/validate-state.mjs';

describe('validate-state rules', () => {
    it('warns when a qualifying offer lacks one of the three core confirmations', () => {
        const warnings = validateRows([{
            lp: 1,
            institution_id: 'bank_a',
            qualifies: true,
            qualification: {},
            offer: {}
        }]);
        expect(warnings.join('\n')).toMatch(/housing\/mortgage/);
        expect(warnings.join('\n')).toMatch(/refinance\/repayment/);
        expect(warnings.join('\n')).toMatch(/fixed-rate/);
        expect(warnings.join('\n')).toMatch(/reason_codes/);
    });

    it('requires non-qualification reason codes for explicit NIE rows', () => {
        const warnings = validateRows([{
            lp: 1,
            institution_id: 'bank_a',
            qualifies: false,
            qualification: {},
            offer: {}
        }]);
        expect(warnings.join('\n')).toMatch(/non_qualification_reason_codes/);
    });

    it('warns about percent-like fields stored as strings', () => {
        const warnings = validateRows([{
            lp: 1,
            institution_id: 'bank_a',
            qualifies: false,
            qualification: {non_qualification_reason_codes: ['no_fixed_rate']},
            offer: {rrso: '6,1%'}
        }]);
        expect(warnings.join('\n')).toMatch(/offer\.rrso/);
    });

    it('warns when range min is greater than max', () => {
        const warnings = validateRows([{
            lp: 1,
            institution_id: 'bank_a',
            qualifies: null,
            qualification: {},
            offer: {fixed_nominal_rate_min: 0.07, fixed_nominal_rate_max: 0.06}
        }]);
        expect(warnings.join('\n')).toMatch(/fixed_nominal_rate_min is greater/);
    });

    it('can require field-level evidence for qualifying rows', () => {
        const row = {
            lp: 1,
            institution_id: 'bank_a',
            qualifies: true,
            qualification: {
                housing_or_mortgage_loan_confirmed: true,
                refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: true,
                periodically_fixed_rate_confirmed: true,
                reason_codes: ['housing_or_mortgage_loan_confirmed', 'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed', 'periodically_fixed_rate_confirmed']
            },
            offer: {}
        };
        const warnings = validateRows([row], {requireFieldEvidence: true});
        expect(warnings.filter(w => /missing field_evidence/.test(w))).toHaveLength(3);
    });

    it('keeps conflicting canonical values explicit instead of silently choosing one', () => {
        const warnings = validateRows([{
            lp: 1,
            institution_id: 'bank_a',
            decision_status: 'unconfirmed',
            qualifies: null,
            qualification: {},
            offer: {fixed_rate_period_years_exact: 5, fixed_rate_period_years_min: 6, fixed_rate_period_years_max: 7, rrso_exact: 0.06, rrso_min: 0.07, rrso_max: 0.08}
        }]);
        expect(warnings.join('\n')).toMatch(/conflicting offer values/);
    });
});
