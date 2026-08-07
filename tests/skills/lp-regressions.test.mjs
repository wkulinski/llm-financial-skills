import {describe, expect, it} from 'vitest';
import {decideFromCriteria} from '../../.agents/skills/bank-market-scan/tools/lib/semantic-decision.mjs';

describe('LP1-LP5 semantic regressions', () => {
    it('keeps known review outcomes separated from keyword matches', () => {
        const cases = [
            ['LP1', {housing: true, refinancing_context: null, fixed_rate: true, same_product: true, evidence_complete: true}, 'unconfirmed'],
            ['LP2', {housing: true, refinancing_context: 'commercial_refinance_of_mortgage', fixed_rate: true, same_product: false, evidence_complete: true}, 'pending_review'],
            ['LP3', {housing: true, refinancing_context: 'commercial_refinance_of_mortgage', fixed_rate: true, same_product: true, evidence_complete: true}, 'qualified'],
            ['LP4', {housing: true, refinancing_context: 'existing_debt_support', fixed_rate: true, same_product: true, evidence_complete: true}, 'unconfirmed'],
            ['LP5', {housing: true, refinancing_context: 'commercial_refinance_of_mortgage', fixed_rate: true, same_product: true, evidence_complete: true}, 'qualified']
        ];
        for (const [lp, input, expected] of cases) {
            expect(decideFromCriteria(input).decision_status, lp).toBe(expected);
        }
    });
});
