import {qualifiesForDecisionStatus, reviewStatusForDecisionStatus} from './decision-model.mjs';

export function decideFromCriteria({
    housing = false,
    refinancing_context = null,
    fixed_rate = false,
    same_product = false,
    evidence_complete = false,
    explicit_exclusion = false,
    technical_error = false
} = {}) {
    let decision_status = 'unconfirmed';
    if (technical_error) decision_status = 'technical_error';
    else if (explicit_exclusion) decision_status = 'explicitly_not_qualified';
    else if (housing && refinancing_context === 'commercial_refinance_of_mortgage' && fixed_rate && same_product && evidence_complete) decision_status = 'qualified';
    else if (housing && fixed_rate && refinancing_context && !['commercial_refinance_of_mortgage'].includes(refinancing_context)) decision_status = 'unconfirmed';
    else if (housing && fixed_rate && refinancing_context === 'commercial_refinance_of_mortgage' && !same_product) decision_status = 'pending_review';
    return {
        decision_status,
        qualifies: qualifiesForDecisionStatus(decision_status),
        review_status: reviewStatusForDecisionStatus(decision_status),
        reason: decision_status === 'qualified' ? 'all_criteria_same_product_with_evidence' : `decision_${decision_status}`
    };
}
