import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {decideFromCriteria} from '../../.agents/skills/bank-market-scan/tools/lib/semantic-decision.mjs';

const gold = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/golden-decisions.json'), 'utf8'));

describe('semantic decision gold set', () => {
    it('contains the required 30 manually labelled cases', () => {
        expect(gold).toHaveLength(30);
        for (const className of ['all_criteria_one_product', 'own_housing_expenses', 'debt_support', 'community_business', 'consolidation', 'different_product', 'conflict', 'http_403', 'http_404', 'canonical_mismatch']) {
            expect(gold.some(item => item.class === className)).toBe(true);
        }
    });

    it('has perfect precision and recall against the expected decision status', () => {
        const actual = gold.map(item => decideFromCriteria(item).decision_status);
        const expectedQualified = gold.filter(item => item.expected === 'qualified').map(item => item.id);
        const actualQualified = gold.filter((item, index) => actual[index] === 'qualified').map(item => item.id);
        const truePositive = actualQualified.filter(id => expectedQualified.includes(id)).length;
        const precision = truePositive / Math.max(1, actualQualified.length);
        const recall = truePositive / Math.max(1, expectedQualified.length);
        expect(precision).toBe(1);
        expect(recall).toBe(1);
        expect(actual).toEqual(gold.map(item => item.expected));
    });

    it('never qualifies an excluded-context or keyword-only case', () => {
        expect(decideFromCriteria({housing: true, refinancing_context: 'existing_debt_support', fixed_rate: true, same_product: true, evidence_complete: true}).decision_status).toBe('unconfirmed');
        expect(decideFromCriteria({housing: true, refinancing_context: null, fixed_rate: true, same_product: true, evidence_complete: true}).decision_status).toBe('unconfirmed');
    });
});
