import {
    canonicalJson,
    canonicalSha256,
    computeEvidenceId,
    scopeSha256,
    sha256Hex
} from "./canonical-json.mjs";
import {
    CONTRACT_NAMES,
    COMMON_SCHEMA_NAME,
    ContractValidationError,
    SCHEMA_NAMES,
    assertValidContract,
    compileAllContracts,
    getSchema,
    getValidator,
    listContractNames,
    schemaId,
    validateContract
} from "./schema-registry.mjs";
import {basename, dirname, resolve as resolvePath, sep} from "node:path";

export {
    CONTRACT_NAMES,
    COMMON_SCHEMA_NAME,
    ContractValidationError,
    SCHEMA_NAMES,
    assertValidContract,
    canonicalJson,
    canonicalSha256,
    compileAllContracts,
    computeEvidenceId,
    getSchema,
    getValidator,
    listContractNames,
    schemaId,
    scopeSha256,
    sha256Hex,
    validateContract
};

/** Legal run state transitions of the single run state machine. */
export const RUN_STATE_TRANSITIONS = Object.freeze({
    CREATED: Object.freeze(["PREPARED", "ABORTED"]),
    PREPARED: Object.freeze(["RUNNING", "ABORTED"]),
    RUNNING: Object.freeze(["READY", "ABORTED"]),
    READY: Object.freeze(["FINALIZING", "ABORTED"]),
    FINALIZING: Object.freeze(["FINALIZED", "ABORTED"]),
    FINALIZED: Object.freeze([]),
    ABORTED: Object.freeze([])
});

/** Terminal run states; they never transition again. */
export const TERMINAL_RUN_STATES = Object.freeze(["FINALIZED", "ABORTED"]);

/** Reason codes that a `qualified` decision must always carry. */
export const QUALIFIED_REQUIRED_REASON_CODES = Object.freeze([
    "housing_or_mortgage_loan_confirmed",
    "refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed",
    "fixed_rate_confirmed"
]);

/** Reason codes that can justify an explicit negative business decision. */
export const NEGATIVE_REASON_CODES = Object.freeze([
    "no_housing_or_mortgage_loan_confirmed",
    "no_refinance_or_repayment_confirmed",
    "no_fixed_rate_confirmed",
    "only_variable_rate_found",
    "only_refinancing_of_own_costs_found",
    "ambiguous_sources"
]);

/** Criterion evidence paths required by a `qualified` decision. */
export const QUALIFICATION_FIELD_PATHS = Object.freeze([
    "qualification.housing",
    "qualification.refinancing",
    "qualification.fixed_rate"
]);

const TECHNICAL_ERROR_DECISION_KEYS = Object.freeze([
    "product_bundle",
    "offer",
    "criterion_status",
    "qualification",
    "field_status",
    "field_evidence"
]);
const CANONICAL_RUNTIME_ROOT = "data/mortgage-refinancing-scan";

/**
 * @param {string} previousState
 * @param {string} nextState
 * @returns {boolean} true when the run state machine allows the transition;
 *   a retry keeps the same state and is allowed.
 */
export function isAllowedRunStateTransition(previousState, nextState) {
    if (!Object.hasOwn(RUN_STATE_TRANSITIONS, previousState)) {
        return false;
    }
    if (previousState === nextState) {
        return !TERMINAL_RUN_STATES.includes(previousState);
    }
    return RUN_STATE_TRANSITIONS[previousState].includes(nextState);
}

/**
 * @param {object} manifest
 * @param {{entry_id?: string, lp?: number, institution_id?: string}} identity
 * @returns {object|null} the exact scope entry or null when out of scope
 */
export function findScopeEntry(manifest, identity) {
    const entries = manifest?.scope?.entries;
    if (!Array.isArray(entries) || !isPlainObject(identity)) {
        return null;
    }
    return entries.find((entry) => {
        if (identity.entry_id !== undefined && entry.entry_id !== identity.entry_id) {
            return false;
        }
        if (identity.lp !== undefined && entry.lp !== identity.lp) {
            return false;
        }
        if (identity.institution_id !== undefined && entry.institution_id !== identity.institution_id) {
            return false;
        }
        return true;
    }) ?? null;
}

/**
 * @param {object} manifest
 * @param {{entry_id?: string, lp?: number, institution_id?: string}} identity
 * @returns {boolean}
 */
export function isEntryInScope(manifest, identity) {
    return findScopeEntry(manifest, identity) !== null;
}

/**
 * Validates a run manifest against the schema and the exact-scope rules.
 *
 * @param {unknown} manifest
 * @param {{registryEntries?: Array<object>}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateRunManifest(manifest, options = {}) {
    const schemaResult = validateContract("run-manifest", manifest);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const entries = manifest.scope.entries;
    collectScopeIdentityErrors(entries, errors);

    const expectedScopeHash = scopeSha256(entries);
    if (manifest.scope.scope_sha256 !== expectedScopeHash) {
        errors.push(semanticError(
            "scope_sha256_mismatch",
            `scope_sha256 ${manifest.scope.scope_sha256} does not match canonical scope hash ${expectedScopeHash}`,
            "/scope/scope_sha256"
        ));
    }

    if (Array.isArray(options.registryEntries)) {
        collectRegistryErrors(entries, options.registryEntries, errors);
    }
    return toResult(errors);
}

/**
 * Validates the immutable registry snapshot consumed by run-init.
 *
 * @param {unknown} snapshot
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateInstitutionRegistrySnapshot(snapshot) {
    const schemaResult = validateContract("institution-registry-snapshot", snapshot);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const entries = snapshot.entries;
    collectScopeIdentityErrors(entries, errors);
    for (const [index, entry] of entries.entries()) {
        const allowed = new Set(entry.allowed_redirect_hosts);
        for (const host of entry.official_hosts) {
            if (!allowed.has(host)) {
                errors.push(semanticError(
                    "registry_official_host_not_allowed",
                    `official host ${host} must be present in allowed_redirect_hosts`,
                    `/entries/${index}/allowed_redirect_hosts`
                ));
            }
        }
    }
    return toResult(errors);
}

/**
 * Validates an atomic entry projection and binds it to the exact manifest scope.
 *
 * @param {unknown} state
 * @param {{manifest?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateEntryState(state, options = {}) {
    const schemaResult = validateContract("entry-state", state);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    if (isPlainObject(options.manifest)) {
        collectRunIdError(state.run_id, options.manifest.run_id, "/run_id", errors);
        const scopeEntry = findScopeEntry(options.manifest, {entry_id: state.entry_id});
        if (!scopeEntry) {
            errors.push(semanticError(
                "entry_out_of_scope",
                `${state.entry_id} is not part of the exact run scope`,
                "/entry_id"
            ));
        } else {
            for (const field of ["lp", "institution_id"]) {
                if (state[field] !== scopeEntry[field]) {
                    errors.push(semanticError(
                        "entry_identity_mismatch",
                        `${field} ${state[field]} does not match scope value ${scopeEntry[field]}`,
                        `/${field}`
                    ));
                }
            }
        }
    }
    if (state.stage !== "technical_error" && state.error_code !== null) {
        errors.push(semanticError(
            "entry_error_code_without_technical_error",
            "error_code is only allowed for a technical_error entry",
            "/error_code"
        ));
    }
    if (state.stage === "technical_error" && state.entry_outcome !== undefined && state.entry_outcome !== null && state.decision_status !== null) {
        errors.push(semanticError(
            "entry_error_carries_decision_status",
            "external or internal entry errors must not carry a business decision status",
            "/decision_status"
        ));
    }
    const entryOutcome = state.entry_outcome ?? (state.decision_status === "technical_error" ? "internal_error" : null);
    if (state.stage === "technical_error" && !["external_source_error", "internal_error"].includes(entryOutcome)) {
        errors.push(semanticError(
            "entry_error_outcome_invalid",
            "technical entry errors require external_source_error or internal_error outcome",
            "/entry_outcome"
        ));
    }
    if (state.stage === "technical_error" && state.retryable) {
        errors.push(semanticError(
            "terminal_entry_retryable",
            "technical_error is terminal and cannot be retryable",
            "/retryable"
        ));
    }
    return toResult(errors);
}

/**
 * Validates an immutable snapshot and ensures it has one row for every scope entry.
 *
 * @param {unknown} snapshot
 * @param {{manifest?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateSnapshot(snapshot, options = {}) {
    const schemaResult = validateContract("snapshot", snapshot);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const manifest = options.manifest;
    if (isPlainObject(manifest)) {
        collectRunIdError(snapshot.run_id, manifest.run_id, "/run_id", errors);
        if (snapshot.scope_sha256 !== manifest.scope.scope_sha256) {
            errors.push(semanticError(
                "snapshot_scope_hash_mismatch",
                "snapshot scope_sha256 does not match the immutable manifest",
                "/scope_sha256"
            ));
        }
        const expected = manifest.scope.entries;
        if (snapshot.entries.length !== expected.length) {
            errors.push(semanticError(
                "snapshot_scope_incomplete",
                `snapshot entries ${snapshot.entries.length} do not cover scope ${expected.length}`,
                "/entries"
            ));
        }
        for (const [index, entry] of snapshot.entries.entries()) {
            const scopeEntry = findScopeEntry(manifest, {entry_id: entry.entry_id});
            if (!scopeEntry) {
                errors.push(semanticError(
                    "snapshot_entry_out_of_scope",
                    `${entry.entry_id} is not part of the exact run scope`,
                    `/entries/${index}/entry_id`
                ));
                continue;
            }
            for (const field of ["lp", "institution_id", "institution_type"]) {
                if (entry[field] !== scopeEntry[field]) {
                    errors.push(semanticError(
                        "snapshot_identity_mismatch",
                        `${field} ${entry[field]} does not match scope value ${scopeEntry[field]}`,
                        `/entries/${index}/${field}`
                    ));
                }
            }
            if (entry.result !== null && entry.result !== undefined) {
                const resultValidation = validateContract("interpretation-result", entry.result);
                if (!resultValidation.valid) {
                    errors.push(...resultValidation.errors.map((error) => ({
                        ...error,
                        path: `/entries/${index}/result${error.path === "/" ? "" : error.path}`
                    })));
                }
                if (entry.result.run_id !== snapshot.run_id
                    || entry.result.entry_id !== entry.entry_id
                    || entry.result.institution_id !== entry.institution_id
                    || entry.result.decision_status !== entry.decision_status) {
                    errors.push(semanticError(
                        "snapshot_result_identity_mismatch",
                        `result for ${entry.entry_id} does not match the snapshot entry`,
                        `/entries/${index}/result`
                    ));
                }
            }
        }
    }
    const hasEntryError = snapshot.entries.some((entry) => ["external_source_error", "internal_error"].includes(entry.entry_outcome ?? (entry.decision_status === "technical_error" ? "internal_error" : null)));
    for (const [index, entry] of snapshot.entries.entries()) {
        const entryOutcome = entry.entry_outcome ?? (entry.decision_status === "technical_error" ? "internal_error" : "business_decision");
        if (["external_source_error", "internal_error"].includes(entryOutcome)
            && (!entry.error_code || !entry.error_message)) {
            errors.push(semanticError(
                "snapshot_entry_error_details_missing",
                "external/internal error snapshot entries require error_code and error_message",
                `/entries/${index}`
            ));
        }
        if (!['external_source_error', 'internal_error'].includes(entryOutcome)
            && (entry.error_code !== null || entry.error_message !== null)) {
            errors.push(semanticError(
                "snapshot_business_entry_carries_error",
                "business snapshot entries must not carry technical error details",
                `/entries/${index}`
            ));
        }
        if (entryOutcome === "business_decision" && !["qualified", "explicitly_not_qualified", "unconfirmed"].includes(entry.decision_status)) {
            errors.push(semanticError("snapshot_business_outcome_status_missing", "business_decision requires a business decision status", `/entries/${index}/decision_status`));
        }
        if (["external_source_error", "internal_error"].includes(entryOutcome) && entry.decision_status !== null && entry.decision_status !== "technical_error") {
            errors.push(semanticError("snapshot_entry_error_carries_decision", "entry errors must not carry a business decision status", `/entries/${index}/decision_status`));
        }
        if (entry.export_ready !== undefined) {
            if (typeof entry.export_ready !== "boolean" || !["complete", "incomplete"].includes(entry.data_status) || !Array.isArray(entry.export_blockers)) {
                errors.push(semanticError("snapshot_export_readiness_shape_invalid", "export_ready requires boolean export_ready, data_status and export_blockers", `/entries/${index}`));
            }
            if (entry.export_ready && (entry.data_status !== "complete" || entry.export_blockers.length > 0)) {
                errors.push(semanticError("snapshot_export_ready_inconsistent", "export_ready=true requires data_status=complete and no blockers", `/entries/${index}`));
            }
            if (!entry.export_ready && entry.data_status !== "incomplete") {
                errors.push(semanticError("snapshot_export_incomplete_status_invalid", "export_ready=false requires data_status=incomplete", `/entries/${index}`));
            }
            if (entry.decision_status !== "qualified" && entry.export_ready) {
                errors.push(semanticError("snapshot_nonqualified_export_ready", "only a qualified entry can be export_ready", `/entries/${index}/export_ready`));
            }
        }
    }
    const expectedCoverage = hasEntryError ? "degraded" : "complete";
    if (snapshot.coverage_status !== expectedCoverage) {
        errors.push(semanticError(
            "snapshot_coverage_mismatch",
            `coverage_status must be ${expectedCoverage} for the snapshot entries`,
            "/coverage_status"
        ));
    }
    return toResult(errors);
}

/**
 * Validates a run context against the schema, the manifest and the run layout.
 *
 * @param {unknown} context
 * @param {{manifest?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateRunContext(context, options = {}) {
    const schemaResult = validateContract("run-context", context);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const manifest = options.manifest;
    if (isPlainObject(manifest)) {
        if (context.run_id !== manifest.run_id) {
            errors.push(semanticError(
                "run_id_mismatch",
                `context run_id ${context.run_id} does not match manifest run_id ${manifest.run_id}`,
                "/run_id"
            ));
        }
        const contextScopeHash = scopeSha256(context.scope.entries);
        if (contextScopeHash !== manifest.scope?.scope_sha256) {
            errors.push(semanticError(
                "scope_mismatch",
                `context scope hash ${contextScopeHash} does not match manifest scope_sha256 ${manifest.scope?.scope_sha256}`,
                "/scope/entries"
            ));
        }
        if (context.source_registry_sha256 !== manifest.source_registry_sha256) {
            errors.push(semanticError(
                "source_registry_sha256_mismatch",
                "context source_registry_sha256 does not match the manifest",
                "/source_registry_sha256"
            ));
        }
    }
    collectContextPathErrors(context, errors);
    return toResult(errors);
}

/**
 * Validates a checkpoint against the schema, the manifest scope and the
 * counter/status/coverage policy.
 *
 * @param {unknown} checkpoint
 * @param {{manifest?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateCheckpoint(checkpoint, options = {}) {
    const schemaResult = validateContract("run-checkpoint", checkpoint);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const manifest = options.manifest;
    if (isPlainObject(manifest)) {
        if (checkpoint.run_id !== manifest.run_id) {
            errors.push(semanticError(
                "run_id_mismatch",
                `checkpoint run_id ${checkpoint.run_id} does not match manifest run_id ${manifest.run_id}`,
                "/run_id"
            ));
        }
        const scopeCount = manifest.scope?.entries?.length;
        if (checkpoint.scope_count !== scopeCount) {
            errors.push(semanticError(
                "checkpoint_scope_count_mismatch",
                `scope_count ${checkpoint.scope_count} does not match manifest scope size ${scopeCount}`,
                "/scope_count"
            ));
        }
    }
    collectCheckpointCounterErrors(checkpoint, errors);
    collectCheckpointStatusErrors(checkpoint, errors);
    return toResult(errors);
}

/**
 * Validates a run event, its scope binding and its state transition.
 *
 * @param {unknown} event
 * @param {{manifest?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateRunEvent(event, options = {}) {
    const schemaResult = validateContract("run-event", event);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const manifest = options.manifest;
    if (isPlainObject(manifest)) {
        collectRunIdError(event.run_id, manifest.run_id, "/run_id", errors);
        if (event.entry_id !== undefined && !isEntryInScope(manifest, {entry_id: event.entry_id})) {
            errors.push(semanticError(
                "entry_out_of_scope",
                `entry_id ${event.entry_id} is not part of the exact run scope`,
                "/entry_id"
            ));
        }
    }
    if (!isAllowedRunStateTransition(event.previous_state, event.next_state)) {
        errors.push(semanticError(
            "illegal_state_transition",
            `transition ${event.previous_state} -> ${event.next_state} is not allowed`,
            "/next_state"
        ));
    }
    return toResult(errors);
}

/**
 * Validates a source artifact, its scope binding and its cache lineage.
 *
 * @param {unknown} artifact
 * @param {{manifest?: object, context?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateSourceArtifact(artifact, options = {}) {
    const schemaResult = validateContract("source-artifact", artifact);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const manifest = options.manifest;
    if (isPlainObject(manifest)) {
        collectRunIdError(artifact.run_id, manifest.run_id, "/run_id", errors);
        collectScopeBindingError(manifest, {entry_id: artifact.entry_id}, "/entry_id", errors);
    }
    if (!isPlainObject(options.context)) {
        errors.push(semanticError(
            "source_artifact_context_missing",
            "SourceArtifact validation requires RunContext to verify run-local_path",
            "/run_local_path"
        ));
    } else {
        collectSourceArtifactPathErrors(artifact, options.context, errors);
    }
    const notModified = artifact.http_status === 304;
    const revalidated = artifact.cache_status === "revalidated";
    if (notModified !== revalidated) {
        errors.push(semanticError(
            "artifact_cache_status_mismatch",
            `http_status ${artifact.http_status} is inconsistent with cache_status ${artifact.cache_status}`,
            "/cache_status"
        ));
    }
    return toResult(errors);
}

/**
 * Validates an evidence record against the schema, the exact scope, the
 * deterministic evidence id and the referenced source artifact.
 *
 * @param {unknown} evidence
 * @param {{manifest?: object, sourceArtifact?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateEvidenceRecord(evidence, options = {}) {
    const schemaResult = validateContract("evidence-record", evidence);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const manifest = options.manifest;
    if (isPlainObject(manifest)) {
        collectRunIdError(evidence.run_id, manifest.run_id, "/run_id", errors);
        collectScopeBindingError(
            manifest,
            {entry_id: evidence.entry_id, institution_id: evidence.institution_id},
            "/entry_id",
            errors
        );
    }
    const expectedEvidenceId = computeEvidenceId(evidence);
    if (evidence.evidence_id !== expectedEvidenceId) {
        errors.push(semanticError(
            "evidence_id_mismatch",
            `evidence_id ${evidence.evidence_id} does not match deterministic id ${expectedEvidenceId}`,
            "/evidence_id"
        ));
    }
    const artifact = options.sourceArtifact;
    if (isPlainObject(artifact)) {
        collectEvidenceArtifactErrors(evidence, artifact, errors);
    }
    return toResult(errors);
}

/**
 * Validates a product bundle and its scope binding.
 *
 * @param {unknown} bundle
 * @param {{manifest?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateProductBundle(bundle, options = {}) {
    const schemaResult = validateContract("product-bundle", bundle);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    if (isPlainObject(options.manifest)) {
        collectScopeBindingError(
            options.manifest,
            {institution_id: bundle.institution_id},
            "/institution_id",
            errors
        );
    }
    return toResult(errors);
}

/**
 * Validates an interpretation result: strict business decision or explicit
 * technical error without any decision payload.
 *
 * @param {unknown} result
 * @param {{manifest?: object, evidenceRecords?: Array<object>}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateInterpretationResult(result, options = {}) {
    const errors = [];
    if (isPlainObject(result) && result.decision_status === "technical_error") {
        const carried = TECHNICAL_ERROR_DECISION_KEYS.filter((key) => Object.hasOwn(result, key));
        if (carried.length > 0) {
            errors.push(semanticError(
                "technical_error_result_carries_decision_data",
                `technical_error result must not carry decision data: ${carried.join(", ")}`,
                "/decision_status"
            ));
        }
    }
    const schemaResult = validateContract("interpretation-result", result);
    errors.push(...schemaResult.errors);
    if (errors.length > 0) {
        return toResult(errors);
    }
    if (isPlainObject(options.manifest)) {
        collectRunIdError(result.run_id, options.manifest.run_id, "/run_id", errors);
        collectScopeBindingError(
            options.manifest,
            {entry_id: result.entry_id, institution_id: result.institution_id},
            "/entry_id",
            errors
        );
    }
    if (result.decision_status === "qualified") {
        collectQualifiedErrors(result, options, errors);
    }
    if (result.decision_status === "explicitly_not_qualified") {
        collectExplicitNegativeErrors(result, errors);
    }
    return toResult(errors);
}

/**
 * Validates run telemetry against the schema, the manifest and the checkpoint.
 *
 * @param {unknown} telemetry
 * @param {{manifest?: object, checkpoint?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validateTelemetry(telemetry, options = {}) {
    const schemaResult = validateContract("telemetry", telemetry);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    const manifest = options.manifest;
    if (isPlainObject(manifest)) {
        collectRunIdError(telemetry.run_id, manifest.run_id, "/run_id", errors);
        for (const [index, entry] of telemetry.entries.entries()) {
            collectScopeBindingError(
                manifest,
                {entry_id: entry.entry_id, institution_id: entry.institution_id},
                `/entries/${index}/entry_id`,
                errors
            );
        }
    }
    const checkpoint = options.checkpoint;
    if (isPlainObject(checkpoint)) {
        collectRunIdError(telemetry.run_id, checkpoint.run_id, "/run_id", errors);
        collectTelemetryCounterErrors(telemetry, checkpoint, errors);
    }
    return toResult(errors);
}

/**
 * Validates a publication record against the manifest and the checkpoint.
 *
 * @param {unknown} record
 * @param {{manifest?: object, checkpoint?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validatePublicationRecord(record, options = {}) {
    const schemaResult = validateContract("publication-record", record);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    if (isPlainObject(options.manifest)) {
        collectRunIdError(record.run_id, options.manifest.run_id, "/run_id", errors);
    }
    const checkpoint = options.checkpoint;
    if (isPlainObject(checkpoint)) {
        collectRunIdError(record.run_id, checkpoint.run_id, "/run_id", errors);
        if (record.coverage_status !== checkpoint.coverage_status) {
            errors.push(semanticError(
                "publication_coverage_mismatch",
                `coverage_status ${record.coverage_status} does not match checkpoint coverage_status ${checkpoint.coverage_status}`,
                "/coverage_status"
            ));
        }
        if (checkpoint.fatal_error_count > 0) {
            errors.push(semanticError(
                "publication_blocked_by_fatal_error",
                "a run with fatal errors must never be published",
                "/status"
            ));
        }
    }
    return toResult(errors);
}

/**
 * Validates the atomic publication pointer against its publication record.
 *
 * @param {unknown} pointer
 * @param {{publicationRecord?: object, publicationSha256?: string, manifest?: object}} [options]
 * @returns {{valid: boolean, errors: Array<object>}}
 */
export function validatePointer(pointer, options = {}) {
    const schemaResult = validateContract("pointer", pointer);
    if (!schemaResult.valid) {
        return schemaResult;
    }
    const errors = [];
    if (isPlainObject(options.manifest)) {
        collectRunIdError(pointer.run_id, options.manifest.run_id, "/run_id", errors);
    }
    if (!isPublishedRunPath(pointer.published_dir, pointer.run_id)) {
        errors.push(semanticError(
            "pointer_dir_run_id_mismatch",
            `published_dir ${pointer.published_dir} does not point at run ${pointer.run_id}`,
            "/published_dir"
        ));
    }
    const record = options.publicationRecord;
    if (isPlainObject(record)) {
        collectRunIdError(pointer.run_id, record.run_id, "/run_id", errors);
        for (const field of ["manifest_sha256", "snapshot_sha256", "evidence_sha256"]) {
            if (pointer[field] !== record[field]) {
                errors.push(semanticError(
                    "pointer_hash_mismatch",
                    `pointer ${field} does not match the publication record`,
                    `/${field}`
                ));
            }
        }
        if (pointer.coverage_status !== record.coverage_status) {
            errors.push(semanticError(
                "pointer_coverage_mismatch",
                "pointer coverage_status does not match the publication record",
                "/coverage_status"
            ));
        }
    }
    if (typeof options.publicationSha256 === "string"
        && pointer.publication_sha256 !== options.publicationSha256) {
        errors.push(semanticError(
            "pointer_publication_hash_mismatch",
            "pointer publication_sha256 does not match the published publication.json hash",
            "/publication_sha256"
        ));
    }
    return toResult(errors);
}

function collectScopeIdentityErrors(entries, errors) {
    const seenEntryIds = new Set();
    const seenLps = new Set();
    const seenInstitutionIds = new Set();
    let previousLp = 0;
    for (const [index, entry] of entries.entries()) {
        addDuplicateError(seenEntryIds, entry.entry_id, "entry_id", index, errors);
        addDuplicateError(seenLps, entry.lp, "lp", index, errors);
        addDuplicateError(seenInstitutionIds, entry.institution_id, "institution_id", index, errors);
        if (entry.lp <= previousLp) {
            errors.push(semanticError(
                "scope_not_canonically_ordered",
                `scope entries must be ordered by ascending lp; lp ${entry.lp} follows ${previousLp}`,
                `/scope/entries/${index}/lp`
            ));
        }
        previousLp = entry.lp;
    }
}

function addDuplicateError(seen, value, field, index, errors) {
    if (seen.has(value)) {
        errors.push(semanticError(
            "scope_entry_duplicate",
            `duplicate ${field} ${value} in scope`,
            `/scope/entries/${index}/${field}`
        ));
        return;
    }
    seen.add(value);
}

function collectRegistryErrors(entries, registryEntries, errors) {
    const registry = new Map(registryEntries.map((entry) => [entry.entry_id, entry]));
    for (const [index, entry] of entries.entries()) {
        const known = registry.get(entry.entry_id);
        if (!known) {
            errors.push(semanticError(
                "scope_entry_unknown",
                `entry_id ${entry.entry_id} is not present in the registry snapshot`,
                `/scope/entries/${index}/entry_id`
            ));
            continue;
        }
        for (const field of ["lp", "institution_id", "institution_type"]) {
            if (known[field] !== undefined && known[field] !== entry[field]) {
                errors.push(semanticError(
                    "scope_identity_mismatch",
                    `${field} ${entry[field]} does not match registry value ${known[field]} for ${entry.entry_id}`,
                    `/scope/entries/${index}/${field}`
                ));
            }
        }
    }
}

function collectContextPathErrors(context, errors) {
    const runRoot = resolvePath(context.run_root);
    const canonicalRunRoot = resolvePath(`${CANONICAL_RUNTIME_ROOT}/work/runs`);
    const canonicalCacheRoot = resolvePath(`${CANONICAL_RUNTIME_ROOT}/cache`);
    if (!isWithinOrEqual(canonicalRunRoot, runRoot)) {
        errors.push(semanticError(
            "run_root_outside_canonical_runtime",
            `run_root ${context.run_root} is outside ${CANONICAL_RUNTIME_ROOT}/work/runs`,
            "/run_root"
        ));
    }
    if (!isWithinOrEqual(canonicalCacheRoot, resolvePath(context.transport_cache_root))
        || !isWithinOrEqual(canonicalCacheRoot, resolvePath(context.normalization_cache_root))) {
        errors.push(semanticError(
            "cache_root_outside_canonical_runtime",
            `cache roots must be inside ${CANONICAL_RUNTIME_ROOT}/cache`,
            "/transport_cache_root"
        ));
    }
    if (!endsWithSegment(runRoot, context.run_id)) {
        errors.push(semanticError(
            "run_root_run_id_mismatch",
            `run_root ${context.run_root} does not end with run_id ${context.run_id}`,
            "/run_root"
        ));
    }
    const runLocalFields = [
        "manifest_path",
        "registry_snapshot_path",
        "artifact_root",
        "evidence_path",
        "event_path",
        "checkpoint_path"
    ];
    for (const field of runLocalFields) {
        if (!isInside(runRoot, context[field])) {
            errors.push(semanticError(
                "path_outside_run_root",
                `${field} ${context[field]} is not inside run_root ${context.run_root}`,
                `/${field}`
            ));
        }
    }
    for (const field of ["transport_cache_root", "normalization_cache_root"]) {
        if (isInside(runRoot, context[field])) {
            errors.push(semanticError(
                "cache_root_inside_run_root",
                `${field} ${context[field]} must be a shared cache root outside run_root`,
                `/${field}`
            ));
        }
    }
}

function collectSourceArtifactPathErrors(artifact, context, errors) {
    if (!isInside(context.run_root, artifact.run_local_path)
        || !isInside(context.artifact_root, artifact.run_local_path)) {
        errors.push(semanticError(
            "source_artifact_path_outside_artifact_root",
            `run_local_path ${artifact.run_local_path} is not inside artifact_root ${context.artifact_root}`,
            "/run_local_path"
        ));
    }
}

function collectCheckpointCounterErrors(checkpoint, errors) {
    const scopeCount = checkpoint.scope_count;
    for (const field of ["discovered_count", "interpreted_count", "terminal_entry_count"]) {
        if (checkpoint[field] > scopeCount) {
            errors.push(semanticError(
                "checkpoint_counter_overflow",
                `${field} ${checkpoint[field]} exceeds scope_count ${scopeCount}`,
                `/${field}`
            ));
        }
    }
    if (checkpoint.interpreted_count > checkpoint.discovered_count) {
        errors.push(semanticError(
            "checkpoint_discovered_count_mismatch",
            `interpreted_count ${checkpoint.interpreted_count} exceeds discovered_count ${checkpoint.discovered_count}`,
            "/interpreted_count"
        ));
    }
    const externalSourceErrorCount = checkpoint.external_source_error_count ?? 0;
    const internalErrorCount = checkpoint.internal_error_count ?? checkpoint.technical_error_count ?? 0;
    const terminalTotal = checkpoint.interpreted_count + externalSourceErrorCount + internalErrorCount;
    if (terminalTotal !== checkpoint.terminal_entry_count) {
        errors.push(semanticError(
            "checkpoint_terminal_count_mismatch",
            `terminal_entry_count ${checkpoint.terminal_entry_count} must equal interpreted_count + external_source_error_count + internal_error_count (${terminalTotal})`,
            "/terminal_entry_count"
        ));
    }
    const decidedTotal = checkpoint.qualified_count + checkpoint.unconfirmed_count;
    if (decidedTotal !== checkpoint.interpreted_count) {
        errors.push(semanticError(
            "checkpoint_interpreted_count_mismatch",
            `interpreted_count ${checkpoint.interpreted_count} must equal qualified_count + unconfirmed_count (${decidedTotal})`,
            "/qualified_count"
        ));
    }
}

function collectCheckpointStatusErrors(checkpoint, errors) {
    const externalSourceErrorCount = checkpoint.external_source_error_count ?? 0;
    const internalErrorCount = checkpoint.internal_error_count ?? checkpoint.technical_error_count ?? 0;
    if (checkpoint.terminal_entry_count !== checkpoint.scope_count) {
        errors.push(semanticError(
            "checkpoint_incomplete_scope",
            `terminal_entry_count ${checkpoint.terminal_entry_count} does not cover scope_count ${checkpoint.scope_count}`,
            "/terminal_entry_count"
        ));
    }
    if (checkpoint.fatal_error_count > 0) {
        errors.push(semanticError(
            "checkpoint_fatal_error_blocks_publication",
            `fatal_error_count ${checkpoint.fatal_error_count} blocks finalization; the run must be ABORTED`,
            "/fatal_error_count"
        ));
    }
    const entryErrorCount = externalSourceErrorCount + internalErrorCount;
    if (checkpoint.status === "ready" && entryErrorCount > 0) {
        errors.push(semanticError(
            "checkpoint_status_conflict",
            "status ready requires external_source_error_count + internal_error_count = 0",
            "/status"
        ));
    }
    if (checkpoint.status === "ready_with_errors" && entryErrorCount === 0) {
        errors.push(semanticError(
            "checkpoint_status_conflict",
            "status ready_with_errors requires an entry error",
            "/status"
        ));
    }
    const expectedCoverage = entryErrorCount > 0 ? "degraded" : "complete";
    if (checkpoint.coverage_status !== expectedCoverage) {
        errors.push(semanticError(
            "checkpoint_coverage_conflict",
            `coverage_status must be ${expectedCoverage} for technical_error_count ${checkpoint.technical_error_count}`,
            "/coverage_status"
        ));
    }
}

function collectEvidenceArtifactErrors(evidence, artifact, errors) {
    if (evidence.run_id !== artifact.run_id) {
        errors.push(semanticError(
            "evidence_artifact_run_mismatch",
            `evidence run_id ${evidence.run_id} does not match artifact run_id ${artifact.run_id}`,
            "/run_id"
        ));
    }
    if (evidence.source_artifact_id !== artifact.artifact_id) {
        errors.push(semanticError(
            "evidence_artifact_mismatch",
            `source_artifact_id ${evidence.source_artifact_id} does not match artifact ${artifact.artifact_id}`,
            "/source_artifact_id"
        ));
    }
    if (evidence.url !== artifact.canonical_url) {
        errors.push(semanticError(
            "evidence_source_url_mismatch",
            `url ${evidence.url} does not match artifact canonical_url ${artifact.canonical_url}`,
            "/url"
        ));
    }
    if (evidence.content_sha256 !== artifact.raw_content_sha256) {
        errors.push(semanticError(
            "evidence_content_hash_mismatch",
            "content_sha256 does not match the raw content hash of the source artifact",
            "/content_sha256"
        ));
    }
    if (evidence.source_type !== artifact.source_type) {
        errors.push(semanticError(
            "evidence_source_type_mismatch",
            `source_type ${evidence.source_type} does not match artifact source_type ${artifact.source_type}`,
            "/source_type"
        ));
    }
    if (artifact.entry_id !== undefined && evidence.entry_id !== artifact.entry_id) {
        errors.push(semanticError(
            "evidence_artifact_mismatch",
            `entry_id ${evidence.entry_id} does not match artifact entry_id ${artifact.entry_id}`,
            "/entry_id"
        ));
    }
}

function collectQualifiedErrors(result, options, errors) {
    const reasonCodes = new Set(result.qualification.reason_codes);
    for (const code of QUALIFIED_REQUIRED_REASON_CODES) {
        if (!reasonCodes.has(code)) {
            errors.push(semanticError(
                "qualified_missing_reason_code",
                `qualified decision requires reason code ${code}`,
                "/qualification/reason_codes"
            ));
        }
    }
    for (const fieldPath of QUALIFICATION_FIELD_PATHS) {
        const references = result.field_evidence[fieldPath];
        if (!Array.isArray(references) || references.length === 0) {
            errors.push(semanticError(
                "qualified_missing_evidence",
                `qualified decision requires evidence for ${fieldPath}`,
                "/field_evidence"
            ));
        }
    }
    if (!Array.isArray(options.evidenceRecords)) {
        errors.push(semanticError(
            "qualified_evidence_context_missing",
            "qualified decision validation requires the set of validated evidence records",
            "/field_evidence"
        ));
        return;
    }
    const recordsById = new Map(options.evidenceRecords.map((record) => [record.evidence_id, record]));
    for (const [fieldPath, references] of Object.entries(result.field_evidence)) {
        for (const evidenceId of references) {
            const evidence = recordsById.get(evidenceId);
            if (!evidence) {
                errors.push(semanticError(
                    "qualified_evidence_reference_missing",
                    `evidence ${evidenceId} for ${fieldPath} is not present in the validated evidence set`,
                    "/field_evidence"
                ));
                continue;
            }
            const expected = {
                run_id: result.run_id,
                entry_id: result.entry_id,
                institution_id: result.institution_id,
                product_id: result.product_bundle.product_id,
                variant_id: result.product_bundle.variant_id
            };
            for (const [field, value] of Object.entries(expected)) {
                if (evidence[field] !== value) {
                    errors.push(semanticError(
                        "qualified_evidence_reference_mismatch",
                        `evidence ${evidenceId} field ${field} does not match the qualified result`,
                        "/field_evidence"
                    ));
                }
            }
            if (evidence.field_path !== fieldPath) {
                errors.push(semanticError(
                    "qualified_evidence_field_path_mismatch",
                    `evidence ${evidenceId} field_path ${evidence.field_path} does not match ${fieldPath}`,
                    "/field_evidence"
                ));
            }
            if (!result.product_bundle.source_artifact_ids.includes(evidence.source_artifact_id)) {
                errors.push(semanticError(
                    "qualified_evidence_source_artifact_mismatch",
                    `evidence ${evidenceId} references source artifact ${evidence.source_artifact_id} outside the product bundle`,
                    "/field_evidence"
                ));
            }
        }
    }
}

function collectExplicitNegativeErrors(result, errors) {
    const reasonCodes = result.qualification.reason_codes;
    if (!reasonCodes.some((code) => NEGATIVE_REASON_CODES.includes(code))) {
        errors.push(semanticError(
            "explicitly_not_qualified_missing_reason_code",
            "explicitly_not_qualified requires at least one negative decision reason code",
            "/qualification/reason_codes"
        ));
    }
    const statuses = Object.values(result.criterion_status);
    if (!statuses.includes("not_found")) {
        errors.push(semanticError(
            "explicitly_not_qualified_missing_exclusion",
            "explicitly_not_qualified requires at least one criterion explicitly excluded",
            "/criterion_status"
        ));
    }
    if (result.product_bundle === null) {
        errors.push(semanticError(
            "explicitly_not_qualified_missing_bundle",
            "explicitly_not_qualified requires the product bundle the exclusion applies to",
            "/product_bundle"
        ));
    }
}

function collectTelemetryCounterErrors(telemetry, checkpoint, errors) {
    const counters = [
        ["entry_technical_error_count", "technical_error_count"],
        ["fatal_error_count", "fatal_error_count"]
    ];
    for (const [telemetryField, checkpointField] of counters) {
        if (telemetry.run.errors[telemetryField] !== checkpoint[checkpointField]) {
            errors.push(semanticError(
                "telemetry_error_count_mismatch",
                `${telemetryField} ${telemetry.run.errors[telemetryField]} does not match checkpoint ${checkpointField} ${checkpoint[checkpointField]}`,
                `/run/errors/${telemetryField}`
            ));
        }
    }
}

function collectRunIdError(actual, expected, path, errors) {
    if (expected !== undefined && actual !== expected) {
        errors.push(semanticError(
            "run_id_mismatch",
            `run_id ${actual} does not match ${expected}`,
            path
        ));
    }
}

function collectScopeBindingError(manifest, identity, path, errors) {
    if (!isEntryInScope(manifest, identity)) {
        errors.push(semanticError(
            "entry_out_of_scope",
            `${canonicalJson(identity)} is not part of the exact run scope`,
            path
        ));
    }
}

function semanticError(code, message, path) {
    return {code, message, path, keyword: null, contract: "semantic"};
}

function toResult(errors) {
    return {valid: errors.length === 0, errors};
}

function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function endsWithSegment(value, segment) {
    const normalized = resolvePath(value);
    return normalized === segment || normalized.endsWith(`${sep}${segment}`);
}

function isInside(root, candidate) {
    if (typeof root !== "string" || typeof candidate !== "string") {
        return false;
    }
    const normalizedRoot = resolvePath(root);
    const normalizedCandidate = resolvePath(candidate);
    return normalizedCandidate !== normalizedRoot
        && normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function isWithinOrEqual(root, candidate) {
    if (typeof root !== "string" || typeof candidate !== "string") {
        return false;
    }
    const normalizedRoot = resolvePath(root);
    const normalizedCandidate = resolvePath(candidate);
    return normalizedCandidate === normalizedRoot
        || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function isPublishedRunPath(value, runId) {
    if (!endsWithSegment(value, runId)) {
        return false;
    }
    return basename(dirname(resolvePath(value))) === "published";
}
