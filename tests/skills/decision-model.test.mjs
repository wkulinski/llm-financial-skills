import {describe, expect, it} from 'vitest';
import {decisionStatusFromLegacy, normalizeCanonicalOffer, normalizeDecision, qualifiesForDecisionStatus, reviewStatusForDecisionStatus} from '../../.agents/skills/bank-market-scan/tools/lib/decision-model.mjs';

describe('canonical decision model and units', () => {
    it.each([
        ['qualified', true, 'checked'],
        ['explicitly_not_qualified', false, 'checked'],
        ['unconfirmed', null, 'needs_review'],
        ['technical_error', null, 'error'],
        ['pending_review', null, 'needs_review']
    ])('maps %s consistently', (status, qualifies, reviewStatus) => {
        expect(qualifiesForDecisionStatus(status)).toBe(qualifies);
        expect(reviewStatusForDecisionStatus(status)).toBe(reviewStatus);
        expect(normalizeDecision({decision_status: status, qualifies: 'wrong', review_status: 'unchecked'})).toMatchObject({decision_status: status, qualifies, review_status: reviewStatus});
    });

    it('maps legacy fields without turning unchecked into a decision', () => {
        expect(decisionStatusFromLegacy({qualifies: true, review_status: 'checked'})).toBe('qualified');
        expect(decisionStatusFromLegacy({qualifies: false, review_status: 'checked'})).toBe('explicitly_not_qualified');
        expect(normalizeDecision({qualifies: null, review_status: 'unchecked'}).review_status).toBe('unchecked');
    });

    it('normalizes months to years and removes non-canonical month fields', () => {
        expect(normalizeCanonicalOffer({fixed_rate_period_months_exact: 60})).toMatchObject({fixed_rate_period_years_exact: 5});
        expect(normalizeCanonicalOffer({fixed_rate_period_years: 5})).toMatchObject({fixed_rate_period_years_exact: 5});
        expect(normalizeCanonicalOffer({fixed_rate_period_months_min: 36, fixed_rate_period_months_max: 60})).toMatchObject({fixed_rate_period_years_min: 3, fixed_rate_period_years_max: 5});
        expect(normalizeCanonicalOffer({fixed_rate_period_months_exact: 60})).not.toHaveProperty('fixed_rate_period_months_exact');
    });
});
