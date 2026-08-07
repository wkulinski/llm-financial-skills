import {todayIso} from './common.mjs';

export function markTask(task, patch) {
    if (!task || typeof task !== 'object') throw new TypeError('automation task is required');
    Object.assign(task, patch, {last_processed_at: todayIso()});
}

export function ensureTask(automation, institution, runId) {
    if (!automation || typeof automation !== 'object') throw new TypeError('automation state is required');
    if (!Array.isArray(automation.tasks)) automation.tasks = [];
    let task = automation.tasks.find(item => item.institution_id === institution.institution_id);
    if (!task) {
        task = {
            lp: institution.lp,
            institution_id: institution.institution_id,
            stage: 'pending_prepare',
            attempt_count: 0,
            preprocessing_status: 'pending',
            preprocessing_risk_flags: [],
            preprocessing_technical_flags: [],
            preprocessing_insufficient_flags: [],
            preprocessing_quality_warnings: [],
            last_error: null,
            last_processed_at: null,
            url_ranking: null
        };
        automation.tasks.push(task);
    }
    task.lp = institution.lp;
    task.run_id = runId;
    return task;
}

function sourceRowsForAssessment(candidates, sourceRows) {
    if (sourceRows.length) return sourceRows;
    return candidates.candidates || candidates.all_candidates || [];
}

export function assessPreprocessing(candidates = {}, evidenceRows = [], sourceRows = []) {
    const flags = new Set(candidates.preprocessing_risk_flags || []);
    const categories = new Set(evidenceRows.map(row => row.category));
    if (evidenceRows.length === 0) flags.add('no_evidence_hits');
    if (!categories.has('product')) flags.add('missing_product_hits');
    if (!categories.has('refinancing')) flags.add('missing_refinancing_hits');
    if (!categories.has('fixed_rate')) flags.add('missing_fixed_rate_hits');

    const sources = sourceRowsForAssessment(candidates, sourceRows);
    const readableSources = sourceRows.length
        ? sourceRows.filter(row => row.source_type !== 'error' && row.text?.trim())
        : sources.filter(source => source.available === true && source.cache_file && (source.content_length || 0) > 0);
    const technicalFlags = [];
    if (sources.length === 0) technicalFlags.push('no_sources');
    if (sources.length > 0 && readableSources.length === 0) technicalFlags.push('no_readable_sources');
    if (sources.some(source => source.error || source.available === false)) technicalFlags.push('source_fetch_errors');
    if (sourceRows.some(row => row.source_type === 'error' || row.error)) technicalFlags.push('source_text_extraction_errors');
    if (candidates.cache_integrity_errors?.length || sourceRows.some(row => row.error?.match(/mismatch|collision|source_url/i))) {
        technicalFlags.push('source_cache_integrity_error');
    }
    if (candidates.critical_source_url_mismatch_count > 0 || sourceRows.some(row => row.error?.includes('source_url_mismatch'))) {
        technicalFlags.push('source_url_mismatch');
    }

    const sufficientForAnalysis = candidates.sufficient_for_analysis === true;
    const insufficientFlags = sufficientForAnalysis ? [] : ['insufficient_for_analysis'];
    const qualityWarnings = [...flags];
    const riskFlags = [...new Set([...technicalFlags, ...insufficientFlags, ...qualityWarnings])];

    return {
        sufficient_for_analysis: sufficientForAnalysis,
        preprocessing_status: sufficientForAnalysis
            ? 'sufficient'
            : (technicalFlags.length ? 'technical_error' : 'insufficient'),
        preprocessing_risk_flags: riskFlags,
        preprocessing_technical_flags: technicalFlags,
        preprocessing_insufficient_flags: insufficientFlags,
        preprocessing_quality_warnings: qualityWarnings
    };
}

export function computeRiskFlags(candidates, evidenceRows, sourceRows = []) {
    return assessPreprocessing(candidates, evidenceRows, sourceRows).preprocessing_risk_flags;
}

export function needsRetry(assessment) {
    if (assessment?.sufficient_for_analysis === true) return false;
    return Boolean(
        assessment?.preprocessing_technical_flags?.length
        || assessment?.preprocessing_insufficient_flags?.length
    );
}
