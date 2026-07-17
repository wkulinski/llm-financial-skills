#!/usr/bin/env node
import {Command} from 'commander';
import {readJson, getDeep, dataPath} from './lib/common.mjs';

export const QUALIFICATION_EVIDENCE_FIELDS = [
    'qualification.housing_or_mortgage_loan_confirmed',
    'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed',
    'qualification.periodically_fixed_rate_confirmed'
];

const PERCENT_FIELDS = [
    'offer.commission', 'offer.commission_min', 'offer.commission_max', 'offer.commission_exact',
    'offer.fixed_nominal_rate', 'offer.fixed_nominal_rate_min', 'offer.fixed_nominal_rate_max', 'offer.fixed_nominal_rate_exact',
    'offer.rrso', 'offer.rrso_min', 'offer.rrso_max', 'offer.rrso_exact',
    'offer.fixed_margin_min', 'offer.fixed_margin_specific', 'offer.fixed_wibor_base_value'
];

function isNumberInPercentRange(v) {
    return v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1.5);
}

function hasEvidence(row, fieldPath) {
    const direct = row?.field_evidence?.[fieldPath];
    if (Array.isArray(direct)) return direct.length > 0;
    const nested = getDeep(row?.field_evidence || {}, fieldPath);
    return Array.isArray(nested) && nested.length > 0;
}

export function validateRows(rows, {requireFieldEvidence = false} = {}) {
    const warnings = [];
    for (const r of rows) {
        const p = `Lp ${r.lp} ${r.institution_id}:`;
        const q = r.qualification || {};
        const offer = r.offer || {};
        if (r.qualifies === true) {
            if (q.housing_or_mortgage_loan_confirmed !== true) warnings.push(`${p} qualifies=true but housing/mortgage loan not confirmed.`);
            if (q.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed !== true) warnings.push(`${p} qualifies=true but refinance/repayment not confirmed.`);
            if (q.periodically_fixed_rate_confirmed !== true) warnings.push(`${p} qualifies=true but fixed-rate variant not confirmed.`);
            if (!Array.isArray(q.reason_codes) || q.reason_codes.length < 3) warnings.push(`${p} qualifies=true but qualification.reason_codes are missing or incomplete.`);
            if (requireFieldEvidence) {
                for (const field of QUALIFICATION_EVIDENCE_FIELDS) {
                    if (!hasEvidence(r, field)) warnings.push(`${p} qualifies=true but missing field_evidence for ${field}.`);
                }
            }
            if (!r.decision_audit?.product_scope || r.decision_audit.same_product_variant_confirmed !== true) {
                warnings.push(`${p} qualifies=true but decision_audit does not confirm the same product and variant.`);
            }
            for (const key of ['housing', 'refinancing', 'fixed_rate']) {
                if (!Array.isArray(r.decision_audit?.criterion_evidence_urls?.[key]) || r.decision_audit.criterion_evidence_urls[key].length === 0) {
                    warnings.push(`${p} qualifies=true but decision_audit is missing ${key} evidence URLs.`);
                }
            }
        }
        if (r.qualifies === false && (!Array.isArray(q.non_qualification_reason_codes) || q.non_qualification_reason_codes.length === 0)) {
            warnings.push(`${p} qualifies=false but non_qualification_reason_codes are missing.`);
        }
        for (const k of PERCENT_FIELDS) {
            const v = getDeep(r, k);
            if (!isNumberInPercentRange(v)) warnings.push(`${p} ${k} should be decimal percent, e.g. 0.063.`);
        }
        for (const base of ['offer.fixed_nominal_rate', 'offer.commission', 'offer.rrso']) {
            const min = getDeep(r, `${base}_min`);
            const max = getDeep(r, `${base}_max`);
            if (min != null && max != null && min > max) warnings.push(`${p} ${base}_min is greater than ${base}_max.`);
        }
        const fixed = offer.fixed_nominal_rate_exact ?? offer.fixed_nominal_rate;
        const rrso = offer.rrso_exact ?? offer.rrso;
        if (fixed != null && fixed > 0.12) warnings.push(`${p} unusually high fixed nominal rate (${fixed}). Verify source.`);
        if (rrso != null && fixed != null && rrso + 0.005 < fixed) warnings.push(`${p} RRSO appears materially lower than fixed nominal rate. This can happen only with specific representative-example assumptions; verify.`);
        const commission = offer.commission_exact ?? offer.commission;
        if (commission != null && commission > 0.05) warnings.push(`${p} unusually high commission (${commission}). Verify source.`);
        if (rrso != null && !/stał|stala|stałe|okresowo|fixed/i.test(`${offer.rrso_description || ''} ${r.basis || ''}`)) {
            warnings.push(`${p} RRSO present but description/basis does not clearly indicate fixed-rate variant.`);
        }
        const forbidden = `${offer.fixed_wibor_description || ''} ${offer.fixed_margin_description || ''} ${offer.fixed_nominal_rate_description || ''} ${r.research_notes || ''}`;
        if (/po\s+(okresie|zakończeniu)|zmienn[ey]m?\s+oprocent|po\s+60\s+mies/i.test(forbidden)) {
            warnings.push(`${p} possible data/description about period after fixed rate. Verify and remove if it is not strictly about fixed period.`);
        }
        if (r.review_status === 'checked' && r.website_available === null) warnings.push(`${p} checked row should specify website_available true/false.`);
    }
    return warnings;
}

async function main() {
    const program = new Command();
    program
        .option('--state <path>', 'state file', dataPath('work/analysis-state.json'))
        .option('--strict', 'exit with non-zero code when warnings are found')
        .option('--require-field-evidence', 'warn when checked TAK rows lack field-level evidence for the three qualification criteria')
        .parse(process.argv);
    const opts = program.opts();
    const state = await readJson(opts.state);
    if (!Array.isArray(state.rows)) throw new Error(`Invalid state file ${opts.state}: missing rows array.`);
    const warnings = validateRows(state.rows, {requireFieldEvidence: opts.requireFieldEvidence});
    console.log(JSON.stringify({warnings_count: warnings.length, warnings}, null, 2));
    if (opts.strict && warnings.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}
