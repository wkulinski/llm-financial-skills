import {describe, expect, it} from 'vitest';
import {
    CONTRACT_NAMES,
    assertValidContract,
    canonicalJson,
    computeEvidenceId,
    compileAllContracts,
    sha256Hex,
    scopeSha256,
    validateContract,
    validateEvidenceRecord,
    validateInterpretationResult,
    validatePointer,
    validateProductBundle,
    validatePublicationRecord,
    validateRunContext,
    validateRunEvent,
    validateRunManifest,
    validateSourceArtifact,
    validateTelemetry,
    validateCheckpoint
} from '../../.agents/skills/mortgage-refinancing-scan/lib/run-contract-validate.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const RUN_ID = 'run-20260805T120000Z-abc123';
const ENTRY = {
    entry_id: 'bank-001',
    lp: 1,
    institution_id: 'example-bank',
    institution_type: 'cooperative_bank'
};
const TIMESTAMP = '2026-08-05T12:00:00Z';

describe('mortgage-refinancing-scan Phase 1 contracts', () => {
    it('registers and compiles every strict contract schema', () => {
        const names = compileAllContracts();

        expect(names).toEqual([...CONTRACT_NAMES].sort());
        expect(names).toEqual([
            'entry-state',
            'evidence-record',
            'institution-registry-snapshot',
            'interpretation-result',
            'pointer',
            'product-bundle',
            'publication-record',
            'run-checkpoint',
            'run-context',
            'run-event',
            'run-manifest',
            'snapshot',
            'source-artifact',
            'telemetry'
        ]);
    });

    it('keeps canonical JSON and scope hashes stable', () => {
        expect(canonicalJson({b: 2, a: 1})).toBe('{"a":1,"b":2}');
        expect(canonicalJson(['ą|', '😀'])).toBe('["ą|","😀"]');
        expect(sha256Hex(canonicalJson(['ą|', '😀']))).toBe('ea4ddf28f236dc1d8d91d69ee4ce433f99122924c3b903407cd051f7170fe5b6');
        expect(canonicalJson(['ab', 'c'])).not.toBe(canonicalJson(['a', 'bc']));
        const sparse = [];
        sparse[1] = 'value';
        expect(() => canonicalJson(sparse)).toThrow(/sparse array/);
        expect(scopeSha256([ENTRY])).toMatch(/^[0-9a-f]{64}$/);
        const evidenceIdParts = {
            institution_id: ENTRY.institution_id,
            product_id: 'prd-aaaaaaaaaaaaaaaaaaaaaaaa',
            field_path: 'qualification.housing',
            url: 'https://example.test/offer',
            content_sha256: HASH_D,
            normalized_excerpt: 'kredyt mieszkaniowy'
        };
        expect(computeEvidenceId(evidenceIdParts)).toBe(
            `ev-${sha256Hex(canonicalJson([
                evidenceIdParts.institution_id,
                evidenceIdParts.product_id,
                evidenceIdParts.field_path,
                evidenceIdParts.url,
                evidenceIdParts.content_sha256,
                evidenceIdParts.normalized_excerpt
            ])).slice(0, 24)}`
        );
        const withSeparator = computeEvidenceId({...evidenceIdParts, normalized_excerpt: 'kredyt | mieszkaniowy'});
        const withUnicode = computeEvidenceId({...evidenceIdParts, normalized_excerpt: 'kredyt mieszkaniowy — stała stopa'});
        expect(withSeparator).not.toBe(computeEvidenceId(evidenceIdParts));
        expect(withUnicode).not.toBe(computeEvidenceId(evidenceIdParts));
    });

    it('accepts representative valid contracts across the full Phase 1 surface', () => {
        const manifest = makeManifest();
        const context = makeContext();
        const artifact = makeSourceArtifact();
        const evidence = makeEvidence(artifact);
        const refinancingEvidence = makeEvidence(artifact, 'qualification.refinancing');
        const fixedRateEvidence = makeEvidence(artifact, 'qualification.fixed_rate');
        const evidenceRecords = [evidence, refinancingEvidence, fixedRateEvidence];
        const bundle = makeBundle(evidence, [refinancingEvidence, fixedRateEvidence]);
        const businessResult = makeBusinessResult(bundle, evidence);
        const technicalResult = makeTechnicalResult();
        const checkpoint = makeCheckpoint();
        const telemetry = makeTelemetry();
        const publication = makePublication();
        const pointer = makePointer();
        const event = makeEvent();
        const samples = {
            'run-manifest': manifest,
            'run-context': context,
            'run-event': event,
            'run-checkpoint': checkpoint,
            'source-artifact': artifact,
            'evidence-record': evidence,
            'product-bundle': bundle,
            'interpretation-result': businessResult,
            'telemetry': telemetry,
            'publication-record': publication,
            pointer
        };

        for (const [name, value] of Object.entries(samples)) {
            expect(validateContract(name, value), name).toMatchObject({valid: true, errors: []});
        }
        expect(validateRunManifest(manifest)).toMatchObject({valid: true, errors: []});
        expect(validateRunContext(context, {manifest})).toMatchObject({valid: true, errors: []});
        expect(validateRunEvent(event, {manifest})).toMatchObject({valid: true, errors: []});
        expect(validateCheckpoint(checkpoint, {manifest})).toMatchObject({valid: true, errors: []});
        expect(validateSourceArtifact(artifact, {manifest, context})).toMatchObject({valid: true, errors: []});
        for (const record of evidenceRecords) {
            expect(validateEvidenceRecord(record, {manifest, sourceArtifact: artifact})).toMatchObject({valid: true, errors: []});
        }
        expect(validateProductBundle(bundle, {manifest})).toMatchObject({valid: true, errors: []});
        expect(validateInterpretationResult(businessResult, {manifest, evidenceRecords})).toMatchObject({valid: true, errors: []});
        expect(validateInterpretationResult(technicalResult, {manifest})).toMatchObject({valid: true, errors: []});
        expect(validateTelemetry(telemetry, {manifest, checkpoint})).toMatchObject({valid: true, errors: []});
        expect(validatePublicationRecord(publication, {manifest, checkpoint})).toMatchObject({valid: true, errors: []});
        expect(validatePointer(pointer, {manifest, publicationRecord: publication, publicationSha256: HASH_F})).toMatchObject({valid: true, errors: []});
    });

    it('rejects unknown fields and semantic scope/hash violations', () => {
        const manifest = makeManifest();
        const unknownField = validateContract('run-manifest', {...manifest, unexpected: true});
        expect(unknownField.valid).toBe(false);
        expect(unknownField.errors.some((error) => error.keyword === 'additionalProperties')).toBe(true);

        const wrongHash = validateRunManifest({
            ...manifest,
            scope: {...manifest.scope, scope_sha256: HASH_A}
        });
        expect(wrongHash.valid).toBe(false);
        expect(wrongHash.errors.map((error) => error.code)).toContain('scope_sha256_mismatch');

        const duplicateInstitution = {...ENTRY, entry_id: 'bank-002', lp: 2};
        const duplicateResult = validateRunManifest({
            ...manifest,
            scope: {
                entries: [ENTRY, duplicateInstitution],
                scope_sha256: scopeSha256([ENTRY, duplicateInstitution])
            }
        });
        expect(duplicateResult.valid).toBe(false);
        expect(duplicateResult.errors.map((error) => error.code)).toContain('scope_entry_duplicate');

        const registryMismatch = validateRunManifest(manifest, {
            registryEntries: [{...ENTRY, lp: 9}]
        });
        expect(registryMismatch.valid).toBe(false);
        expect(registryMismatch.errors.map((error) => error.code)).toContain('scope_identity_mismatch');
    });

    it('binds context, events and artifacts to the exact run scope', () => {
        const manifest = makeManifest();
        const context = makeContext();
        expect(validateRunContext({...context, run_id: 'run-20260805T120001Z-def456'}, {manifest}).errors.map((error) => error.code))
            .toContain('run_id_mismatch');
        expect(validateRunContext({
            ...context,
            manifest_path: `${context.run_root}/../outside/manifest.json`
        }, {manifest}).errors.map((error) => error.code)).toContain('path_outside_run_root');
        expect(validateRunContext({...context, run_root: `/tmp/${RUN_ID}`}, {manifest}).errors.map((error) => error.code))
            .toContain('run_root_outside_canonical_runtime');

        const illegalEvent = {...makeEvent(), previous_state: 'RUNNING', next_state: 'PREPARED'};
        expect(validateRunEvent(illegalEvent, {manifest}).errors.map((error) => error.code))
            .toContain('illegal_state_transition');

        const artifact = makeSourceArtifact();
        const outOfScopeArtifact = {...artifact, entry_id: 'bank-999'};
        expect(validateSourceArtifact(outOfScopeArtifact, {manifest, context}).errors.map((error) => error.code))
            .toContain('entry_out_of_scope');
        expect(validateSourceArtifact(artifact, {manifest}).errors.map((error) => error.code))
            .toContain('source_artifact_context_missing');
        expect(validateSourceArtifact({
            ...artifact,
            run_local_path: `${context.run_root}/../outside/source.html`
        }, {manifest, context}).errors.map((error) => error.code))
            .toContain('source_artifact_path_outside_artifact_root');
        expect(validateSourceArtifact({
            ...artifact,
            run_local_path: `${context.run_root}/other/source.html`
        }, {manifest, context}).errors.map((error) => error.code))
            .toContain('source_artifact_path_outside_artifact_root');
        expect(validateSourceArtifact({...artifact, http_status: 304}, {manifest, context}).errors.map((error) => error.code))
            .toContain('artifact_cache_status_mismatch');
    });

    it('enforces technical-error checkpoint publication policy', () => {
        const manifest = makeManifest();
        const degraded = makeCheckpoint({
            interpreted_count: 0,
            terminal_entry_count: 1,
            qualified_count: 0,
            unconfirmed_count: 0,
            internal_error_count: 1,
            technical_error_count: 1,
            status: 'ready_with_errors',
            coverage_status: 'degraded'
        });
        expect(validateCheckpoint(degraded, {manifest})).toMatchObject({valid: true, errors: []});

        const invalidReady = {...degraded, status: 'ready'};
        expect(validateCheckpoint(invalidReady, {manifest}).valid).toBe(false);

        const technicalResult = makeTechnicalResult();
        expect(validateInterpretationResult({...technicalResult, product_bundle: null}, {manifest}).valid).toBe(false);
    });

    it('requires a period for periodically fixed offers and currency for amount commissions', () => {
        const manifest = makeManifest();
        const artifact = makeSourceArtifact();
        const evidence = makeEvidence(artifact);
        const bundle = makeBundle(evidence);
        const periodicallyFixedWithoutPeriod = makeBusinessResult(bundle, evidence);
        periodicallyFixedWithoutPeriod.offer.fixed_rate_period_years_exact = null;
        expect(validateInterpretationResult(periodicallyFixedWithoutPeriod, {manifest, evidenceRecords: [evidence]}).valid).toBe(false);

        const amountWithoutCurrency = makeBusinessResult(bundle, evidence);
        amountWithoutCurrency.offer.commission_unit = 'amount';
        amountWithoutCurrency.offer.commission_currency = null;
        expect(validateInterpretationResult(amountWithoutCurrency, {manifest, evidenceRecords: [evidence]}).valid).toBe(false);

        expect(validateInterpretationResult({...makeTechnicalResult(), retryable: true}, {manifest}).valid).toBe(false);
        expect(validateInterpretationResult({...makeTechnicalResult(), qualifies: true}, {manifest}).valid).toBe(false);
    });

    it('requires deterministic evidence identity and matching source material', () => {
        const manifest = makeManifest();
        const artifact = makeSourceArtifact();
        const evidence = makeEvidence(artifact);
        const wrongId = validateEvidenceRecord({...evidence, evidence_id: 'ev-bbbbbbbbbbbbbbbbbbbbbbbb'}, {
            manifest,
            sourceArtifact: artifact
        });
        expect(wrongId.valid).toBe(false);
        expect(wrongId.errors.map((error) => error.code)).toContain('evidence_id_mismatch');

        const wrongHash = validateEvidenceRecord({...evidence, content_sha256: HASH_E}, {
            manifest,
            sourceArtifact: artifact
        });
        expect(wrongHash.valid).toBe(false);
        expect(wrongHash.errors.map((error) => error.code)).toContain('evidence_content_hash_mismatch');

        const missingReference = makeBusinessResult(makeBundle(evidence), evidence);
        missingReference.field_evidence['qualification.housing'] = ['ev-bbbbbbbbbbbbbbbbbbbbbbbb'];
        expect(validateInterpretationResult(missingReference, {manifest, evidenceRecords: [evidence]}).errors.map((error) => error.code))
            .toContain('qualified_evidence_reference_missing');

        const bundleArtifactMismatch = makeBundle(evidence);
        bundleArtifactMismatch.source_artifact_ids = ['src-bbbbbbbbbbbbbbbbbbbbbbbb'];
        const mismatchedBundleResult = makeBusinessResult(bundleArtifactMismatch, evidence);
        expect(validateInterpretationResult(mismatchedBundleResult, {manifest, evidenceRecords: [evidence]}).errors.map((error) => error.code))
            .toContain('qualified_evidence_source_artifact_mismatch');
        const wrongFieldEvidence = {...evidence, field_path: 'offer.rrso'};
        expect(validateInterpretationResult(makeBusinessResult(makeBundle(evidence), evidence), {
            manifest,
            evidenceRecords: [wrongFieldEvidence]
        }).errors.map((error) => error.code)).toContain('qualified_evidence_field_path_mismatch');

        const crossRunArtifact = {...artifact, run_id: 'run-20260805T120001Z-def456'};
        expect(validateEvidenceRecord(evidence, {manifest, sourceArtifact: crossRunArtifact}).errors.map((error) => error.code))
            .toContain('evidence_artifact_run_mismatch');
        const wrongSourceType = {...artifact, source_type: 'official_pdf'};
        expect(validateEvidenceRecord(evidence, {manifest, sourceArtifact: wrongSourceType}).errors.map((error) => error.code))
            .toContain('evidence_source_type_mismatch');
    });

    it('covers source, cache, stage, rate and entry-error enum variants', () => {
        const manifest = makeManifest();
        const context = makeContext();
        const artifact = makeSourceArtifact();
        for (const sourceType of ['official_product_page', 'official_tariff', 'official_pdf', 'official_form', 'official_registry']) {
            expect(validateSourceArtifact({...artifact, source_type: sourceType}, {manifest, context}).valid).toBe(true);
        }
        expect(validateSourceArtifact({...artifact, cache_status: 'refetched'}, {manifest, context}).valid).toBe(true);
        expect(validateSourceArtifact({
            ...artifact,
            http_status: 304,
            cache_status: 'revalidated',
            cache_lineage: {
                origin: 'revalidated_transport_cache',
                etag: '"example"',
                last_modified: null,
                vary: 'Accept-Encoding',
                revalidated_at: TIMESTAMP
            }
        }, {manifest, context}).valid).toBe(true);

        for (const stage of ['discovery', 'fetched', 'normalized', 'evidence_ready', 'interpreted', 'technical_error']) {
            expect(validateRunEvent({...makeEvent(), stage}, {manifest}).valid).toBe(true);
        }
        for (const errorCode of [
            'required_source_unavailable',
            'request_timeout_after_retries',
            'robots_denied',
            'official_host_violation',
            'evidence_mismatch'
        ]) {
            expect(validateInterpretationResult({...makeTechnicalResult(), error_code: errorCode}, {manifest}).valid).toBe(true);
        }
        expect(validateProductBundle({...makeBundle(makeEvidence(artifact)), rate_type: 'permanent_fixed'}, {manifest}).valid).toBe(true);
    });

    it('rejects checkpoint counter overflows and inconsistent telemetry', () => {
        const manifest = makeManifest();
        expect(validateCheckpoint({...makeCheckpoint(), discovered_count: 2}, {manifest}).errors.map((error) => error.code))
            .toContain('checkpoint_counter_overflow');
        expect(validateCheckpoint({...makeCheckpoint(), discovered_count: 0}, {manifest}).errors.map((error) => error.code))
            .toContain('checkpoint_discovered_count_mismatch');
        expect(validateCheckpoint({...makeCheckpoint(), unconfirmed_count: 1}, {manifest}).errors.map((error) => error.code))
            .toContain('checkpoint_interpreted_count_mismatch');
        const telemetry = makeTelemetry();
        telemetry.run.errors.entry_technical_error_count = 1;
        expect(validateTelemetry(telemetry, {manifest, checkpoint: makeCheckpoint()}).errors.map((error) => error.code))
            .toContain('telemetry_error_count_mismatch');
    });

    it('rejects nested unknown properties and publication/pointer mismatches', () => {
        const manifest = makeManifest();
        expect(validateContract('run-manifest', {
            ...manifest,
            scope: {...manifest.scope, unexpected: true}
        }).valid).toBe(false);
        const artifact = makeSourceArtifact();
        const evidence = makeEvidence(artifact);
        expect(validateContract('evidence-record', {
            ...evidence,
            source_locator: {...evidence.source_locator, unexpected: true}
        }).valid).toBe(false);

        const checkpoint = makeCheckpoint();
        const publication = makePublication();
        expect(validatePublicationRecord({...publication, coverage_status: 'degraded'}, {manifest, checkpoint}).errors.map((error) => error.code))
            .toContain('publication_coverage_mismatch');
        const pointer = makePointer();
        expect(validatePointer({...pointer, snapshot_sha256: HASH_E}, {
            manifest,
            publicationRecord: publication,
            publicationSha256: HASH_F
        }).errors.map((error) => error.code)).toContain('pointer_hash_mismatch');
        expect(validatePointer({...pointer, published_dir: `data/mortgage-refinancing-scan/published/../outside/${RUN_ID}`}, {
            manifest,
            publicationRecord: publication,
            publicationSha256: HASH_F
        }).errors.map((error) => error.code)).toContain('pointer_dir_run_id_mismatch');
    });

    it('rejects invalid URL/hash/status values and exposes assert validation', () => {
        const artifact = makeSourceArtifact();
        expect(validateContract('source-artifact', {...artifact, canonical_url: 'http://example.test/offer'}).valid).toBe(false);
        expect(validateContract('source-artifact', {...artifact, raw_content_sha256: HASH_A.toUpperCase()}).valid).toBe(false);
        expect(validateContract('run-event', {...makeEvent(), stage: 'unknown_stage'}).valid).toBe(false);
        expect(() => assertValidContract('source-artifact', artifact)).not.toThrow();
        expect(() => assertValidContract('source-artifact', {...artifact, http_status: 99})).toThrow(/contract "source-artifact" validation failed/);
    });

    it('covers publication blockers, pointer hashes and remaining counter boundaries', () => {
        const manifest = makeManifest();
        const checkpoint = makeCheckpoint();
        expect(validateCheckpoint({...checkpoint, scope_count: 2}, {manifest}).errors.map((error) => error.code))
            .toContain('checkpoint_scope_count_mismatch');
        expect(validateCheckpoint({...checkpoint, terminal_entry_count: 0}, {manifest}).errors.map((error) => error.code))
            .toContain('checkpoint_terminal_count_mismatch');
        expect(validateCheckpoint({...checkpoint, terminal_entry_count: 0, interpreted_count: 0, qualified_count: 0}, {manifest}).errors.map((error) => error.code))
            .toContain('checkpoint_incomplete_scope');
        expect(validateCheckpoint({...checkpoint, fatal_error_count: 1}, {manifest}).errors.map((error) => error.code))
            .toContain('checkpoint_fatal_error_blocks_publication');

        const publication = makePublication();
        expect(validatePublicationRecord(publication, {
            manifest,
            checkpoint: {...checkpoint, fatal_error_count: 1}
        }).errors.map((error) => error.code)).toContain('publication_blocked_by_fatal_error');

        const pointer = makePointer();
        expect(validatePointer({...pointer, manifest_sha256: HASH_E}, {
            manifest,
            publicationRecord: publication,
            publicationSha256: HASH_F
        }).errors.map((error) => error.code)).toContain('pointer_hash_mismatch');
        expect(validatePointer({...pointer, coverage_status: 'degraded'}, {
            manifest,
            publicationRecord: publication,
            publicationSha256: HASH_F
        }).errors.map((error) => error.code)).toContain('pointer_coverage_mismatch');
        expect(validatePointer(pointer, {
            manifest,
            publicationRecord: publication,
            publicationSha256: HASH_E
        }).errors.map((error) => error.code)).toContain('pointer_publication_hash_mismatch');

        const telemetry = makeTelemetry();
        telemetry.run.errors.fatal_error_count = 1;
        expect(validateTelemetry(telemetry, {manifest, checkpoint}).errors.map((error) => error.code))
            .toContain('telemetry_error_count_mismatch');
    });

    it('covers strict nested objects and unsupported canonical JSON values', () => {
        const artifact = makeSourceArtifact();
        expect(validateContract('source-artifact', {
            ...artifact,
            cache_lineage: {...artifact.cache_lineage, unexpected: true}
        }).valid).toBe(false);
        const telemetry = makeTelemetry();
        expect(validateContract('telemetry', {
            ...telemetry,
            run: {...telemetry.run, resources: {...telemetry.run.resources, unexpected: true}}
        }).valid).toBe(false);
        const evidence = makeEvidence(artifact);
        const businessResult = makeBusinessResult(makeBundle(evidence), evidence);
        expect(validateContract('interpretation-result', {
            ...businessResult,
            offer: {...businessResult.offer, unexpected: true}
        }).valid).toBe(false);

        for (const value of [undefined, NaN, Infinity, -Infinity, () => {}, Symbol('value'), 1n]) {
            expect(() => canonicalJson(value)).toThrow();
        }
        expect(canonicalJson({'\u{10000}': 1, '\uE000': 2})).toBe('{"𐀀":1,"":2}');
    });
});

function makeManifest(entries = [ENTRY]) {
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        scope: {entries, scope_sha256: scopeSha256(entries)},
        source_registry_sha256: HASH_B,
        mode: 'full',
        live: false,
        discovery_policy: 'deterministic_official_sources',
        resource_policy: {
            max_active_institutions: 24,
            max_http_in_flight: 24,
            max_in_flight_per_origin: 1,
            max_in_flight_per_institution: 1,
            max_normalization_workers: 4,
            max_event_batch_size: 64,
            max_discovery_requests_per_institution: 256,
            max_source_bytes_per_institution: 134217728,
            max_artifact_html_bytes: 8388608,
            max_artifact_pdf_bytes: 33554432,
            max_redirects: 5,
            max_attempts: 2,
            html_timeout_ms: 15000,
            pdf_timeout_ms: 30000,
            robots_timeout_ms: 10000,
            institution_deadline_ms: 120000,
            run_deadline_ms: 86400000,
            retry_after_cap_ms: 60000,
            origin_delay_ms: 500
        },
        transport_cache_policy: 'revalidate_conditional',
        methodology_version: 'mortgage-refinancing-scan@1.0.0',
        created_at: TIMESTAMP,
        input_fingerprint: HASH_C,
        environment_fingerprint: {
            node_version: 'v22.21.1',
            package_lock_sha256: HASH_D,
            morfeusz_version: '2.1.0',
            locale: 'C.UTF-8',
            timezone: 'UTC'
        }
    };
}

function makeContext() {
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        manifest_path: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}/manifest.json`,
        run_root: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}`,
        registry_snapshot_path: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}/registry.json`,
        source_registry_sha256: HASH_B,
        scope: {entries: [ENTRY]},
        artifact_root: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}/artifacts`,
        transport_cache_root: 'data/mortgage-refinancing-scan/cache/http',
        normalization_cache_root: 'data/mortgage-refinancing-scan/cache/normalized',
        evidence_path: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}/evidence.jsonl`,
        event_path: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}/events.jsonl`,
        checkpoint_path: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}/checkpoint.json`
    };
}

function makeEvent() {
    return {
        schema_version: '1.0.0',
        event_id: 'evt-abcdef12',
        run_id: RUN_ID,
        sequence: 1,
        operation_id: 'op-abcdef12',
        occurred_at: TIMESTAMP,
        previous_state: 'PREPARED',
        next_state: 'RUNNING',
        stage: 'discovery',
        attempt: 1,
        entry_id: ENTRY.entry_id,
        input_artifact_ids: [],
        output_artifact_ids: [],
        validation_result: {status: 'passed'}
    };
}

function makeCheckpoint(overrides = {}) {
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        scope_count: 1,
        discovered_count: 1,
        interpreted_count: 1,
        terminal_entry_count: 1,
        qualified_count: 1,
        unconfirmed_count: 0,
        external_source_error_count: 0,
        internal_error_count: 0,
        technical_error_count: 0,
        fatal_error_count: 0,
        status: 'ready',
        coverage_status: 'complete',
        ...overrides
    };
}

function makeSourceArtifact() {
    return {
        schema_version: '1.0.0',
        artifact_id: 'src-aaaaaaaaaaaaaaaaaaaaaaaa',
        run_id: RUN_ID,
        entry_id: ENTRY.entry_id,
        canonical_url: 'https://example.test/offer',
        source_type: 'official_product_page',
        fetched_at: TIMESTAMP,
        raw_content_sha256: HASH_D,
        raw_content_bytes: 128,
        content_type: 'text/html',
        content_encoding: 'utf-8',
        http_status: 200,
        redirect_chain: [],
        request_response_metadata_sha256: HASH_E,
        run_local_path: `data/mortgage-refinancing-scan/work/runs/${RUN_ID}/artifacts/src.html`,
        robots_policy: {
            status: 'allow',
            robots_url: 'https://example.test/robots.txt',
            checked_at: TIMESTAMP
        },
        cache_status: 'miss',
        cache_key: HASH_F,
        cache_lineage: {
            origin: 'network',
            etag: null,
            last_modified: null,
            vary: null,
            revalidated_at: null
        },
        attempt: 1,
        retry_count: 0,
        error: null
    };
}

function makeEvidence(artifact, fieldPath = 'qualification.housing') {
    const evidence = {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        entry_id: ENTRY.entry_id,
        institution_id: ENTRY.institution_id,
        product_id: 'prd-aaaaaaaaaaaaaaaaaaaaaaaa',
        variant_id: 'var-aaaaaaaaaaaaaaaaaaaaaaaa',
        field_path: fieldPath,
        source_artifact_id: artifact.artifact_id,
        url: artifact.canonical_url,
        content_sha256: artifact.raw_content_sha256,
        excerpt: 'Kredyt mieszkaniowy',
        normalized_excerpt: 'kredyt mieszkaniowy',
        source_type: artifact.source_type,
        source_locator: {
            page: null,
            line_start: 1,
            line_end: 1,
            char_start: 0,
            char_end: 20
        },
        normalization_version: 'morfeusz-2:2.1.0'
    };
    return {
        ...evidence,
        evidence_id: computeEvidenceId(evidence)
    };
}

function makeBundle(evidence, additionalEvidence = []) {
    const evidenceRecords = [evidence, ...additionalEvidence];
    const evidenceFor = (fieldPath) => evidenceRecords.find((record) => record.field_path === fieldPath)?.evidence_id ?? evidence.evidence_id;
    return {
        schema_version: '1.0.0',
        institution_id: ENTRY.institution_id,
        product_id: evidence.product_id,
        variant_id: evidence.variant_id,
        product_name: 'Kredyt mieszkaniowy',
        canonical_product_url: evidence.url,
        audience: 'consumer_standard',
        source_artifact_ids: [evidence.source_artifact_id],
        rate_type: 'periodically_fixed',
        criterion_status: {
            housing: 'found',
            refinancing: 'found',
            fixed_rate: 'found'
        },
        field_evidence: {
            'qualification.housing': [evidenceFor('qualification.housing')],
            'qualification.refinancing': [evidenceFor('qualification.refinancing')],
            'qualification.fixed_rate': [evidenceFor('qualification.fixed_rate')]
        }
    };
}

function makeBusinessResult(bundle, evidence) {
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        entry_id: ENTRY.entry_id,
        institution_id: ENTRY.institution_id,
        decision_status: 'qualified',
        product_bundle: {
            product_id: bundle.product_id,
            variant_id: bundle.variant_id,
            product_name: bundle.product_name,
            canonical_product_url: bundle.canonical_product_url,
            source_artifact_ids: bundle.source_artifact_ids
        },
        criterion_status: bundle.criterion_status,
        qualification: {
            reason_codes: [
                'housing_or_mortgage_loan_confirmed',
                'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed',
                'fixed_rate_confirmed'
            ]
        },
        offer: {
            fixed_rate_type: 'periodically_fixed',
            comparison_context: {
                currency: 'PLN',
                representative_amount: 300000,
                term_years: 25,
                customer_profile: 'consumer_standard',
                observation_date: TIMESTAMP
            },
            fixed_nominal_rate_exact: 0.063,
            fixed_nominal_rate_min: null,
            fixed_nominal_rate_max: null,
            rrso_exact: 0.067,
            rrso_min: null,
            rrso_max: null,
            commission_exact: 0.01,
            commission_min: null,
            commission_max: null,
            commission_unit: 'percent',
            commission_currency: null,
            fixed_rate_period_years_exact: 5,
            max_loan_term_years: 35
        },
        field_status: {
            'qualification.housing': 'found',
            'qualification.refinancing': 'found',
            'qualification.fixed_rate': 'found'
        },
        field_evidence: bundle.field_evidence,
        warnings: [],
        interpreter_version: 'deterministic:1.0.0'
    };
}

function makeTechnicalResult() {
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        entry_id: ENTRY.entry_id,
        institution_id: ENTRY.institution_id,
        decision_status: 'technical_error',
        error_code: 'required_source_unavailable',
        error_message: 'The required source was unavailable after retries.',
        retryable: false,
        warnings: [],
        interpreter_version: 'deterministic:1.0.0'
    };
}

function makeTelemetry() {
    const requests = {total: 1, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 1};
    const cache = {misses: 1, revalidated_not_modified: 0, refetched: 0, hit_rate: 0};
    const bytes = {downloaded: 128, reused_from_cache: 0};
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        generated_at: TIMESTAMP,
        run: {
            wall_clock_ms: 100,
            entry_duration_ms_p50: 100,
            entry_duration_ms_p95: 100,
            requests,
            cache,
            bytes,
            resources: {cpu_user_ms: 10, cpu_system_ms: 1, max_rss_bytes: 1024},
            event_writer: {events_written: 1, batches_written: 1, max_batch_size: 1, max_lag_ms: 2},
            errors: {retryable_error_count: 0, entry_technical_error_count: 0, entry_external_source_error_count: 0, entry_internal_error_count: 0, fatal_error_count: 0}
        },
        stages: [{stage: 'discovery', entry_count: 1, wall_clock_ms: 10, requests, bytes, error_count: 0}],
        entries: [{
            entry_id: ENTRY.entry_id,
            institution_id: ENTRY.institution_id,
            final_stage: 'interpreted',
            attempts: 1,
            wall_clock_ms: 100,
            requests,
            cache,
            bytes,
            error_code: null
        }]
    };
}

function makePublication() {
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        manifest_sha256: HASH_A,
        snapshot_sha256: HASH_B,
        evidence_sha256: HASH_C,
        published_at: TIMESTAMP,
        status: 'published',
        coverage_status: 'complete'
    };
}

function makePointer() {
    return {
        schema_version: '1.0.0',
        run_id: RUN_ID,
        published_dir: `data/mortgage-refinancing-scan/published/${RUN_ID}`,
        manifest_sha256: HASH_A,
        snapshot_sha256: HASH_B,
        evidence_sha256: HASH_C,
        publication_sha256: HASH_F,
        published_at: TIMESTAMP,
        status: 'published',
        coverage_status: 'complete'
    };
}
