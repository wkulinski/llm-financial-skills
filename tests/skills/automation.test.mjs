import {describe, expect, it} from 'vitest';
import {assessPreprocessing, ensureTask, markTask, needsRetry} from '../../.agents/skills/bank-market-scan/tools/lib/automation.mjs';

function readableSource() {
    return [{source_type: 'html', text: 'czytelny tekst źródłowy'}];
}

describe('preprocessing automation contract', () => {
    it('initializes a missing run-local task without mutating global state', () => {
        const automation = {tasks: [{lp: 1, institution_id: 'bank_a', stage: 'checked'}]};
        const task = ensureTask(automation, {lp: 2, institution_id: 'bank_b'}, 'run-test');

        expect(task).toMatchObject({lp: 2, institution_id: 'bank_b', stage: 'pending_prepare', run_id: 'run-test', attempt_count: 0});
        expect(automation.tasks).toHaveLength(2);
    });

    it('fails explicitly instead of masking a missing automation task', () => {
        expect(() => markTask(undefined, {stage: 'error'})).toThrow('automation task is required');
    });

    it('does not retry when content is sufficient despite a missing literal keyword', () => {
        const assessment = assessPreprocessing(
            {sufficient_for_analysis: true},
            [{category: 'product'}, {category: 'refinancing'}],
            readableSource()
        );

        expect(assessment.preprocessing_status).toBe('sufficient');
        expect(assessment.preprocessing_quality_warnings).toContain('missing_fixed_rate_hits');
        expect(assessment.preprocessing_insufficient_flags).toEqual([]);
        expect(needsRetry(assessment)).toBe(false);
    });

    it('retries readable material when discovery says analysis is insufficient', () => {
        const assessment = assessPreprocessing(
            {sufficient_for_analysis: false},
            [{category: 'product'}],
            readableSource()
        );

        expect(assessment.preprocessing_status).toBe('insufficient');
        expect(assessment.preprocessing_technical_flags).toEqual([]);
        expect(assessment.preprocessing_insufficient_flags).toEqual(['insufficient_for_analysis']);
        expect(needsRetry(assessment)).toBe(true);
    });

    it('classifies missing sources as a technical retry', () => {
        const assessment = assessPreprocessing({sufficient_for_analysis: false}, [], []);

        expect(assessment.preprocessing_status).toBe('technical_error');
        expect(assessment.preprocessing_technical_flags).toContain('no_sources');
        expect(assessment.preprocessing_insufficient_flags).toContain('insufficient_for_analysis');
        expect(needsRetry(assessment)).toBe(true);
    });

    it('does not retry a sufficient result because one auxiliary source failed', () => {
        const assessment = assessPreprocessing(
            {sufficient_for_analysis: true},
            [{category: 'product'}, {category: 'refinancing'}, {category: 'fixed_rate'}],
            [{source_type: 'html', text: 'pełny materiał'}, {source_type: 'error', text: '', error: 'timeout'}]
        );

        expect(assessment.preprocessing_status).toBe('sufficient');
        expect(assessment.preprocessing_technical_flags).toContain('source_text_extraction_errors');
        expect(needsRetry(assessment)).toBe(false);
    });
});
