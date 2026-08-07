import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    canonicalJson,
    canonicalSha256,
    sha256Hex
} from "./canonical-json.mjs";
import {
    isAllowedRunStateTransition,
    validateCheckpoint,
    validateEntryState,
    validateInstitutionRegistrySnapshot,
    validatePointer,
    validatePublicationRecord,
    validateRunContext,
    validateRunEvent,
    validateRunManifest,
    validateSnapshot,
    validateTelemetry,
    validateContract
} from "./run-contract-validate.mjs";

export const RUNTIME_ROOT = "data/mortgage-refinancing-scan";
export const RUNS_ROOT = `${RUNTIME_ROOT}/work/runs`;
export const PUBLISHED_ROOT = `${RUNTIME_ROOT}/published`;
export const TRANSPORT_CACHE_ROOT = `${RUNTIME_ROOT}/cache/http`;
export const NORMALIZATION_CACHE_ROOT = `${RUNTIME_ROOT}/cache/normalized`;

const EVENT_FILE = "events.jsonl";
const PROJECTION_FILE = "projection.json";
const CHECKPOINT_FILE = "checkpoint.json";
const METRICS_FILE = "metrics.json";
const LOCK_TIMEOUT_MS = 30_000;
const ENTRY_STAGE_TRANSITIONS = Object.freeze({
    discovery: new Set(["discovery", "fetched", "technical_error"]),
    fetched: new Set(["fetched", "normalized", "technical_error"]),
    normalized: new Set(["normalized", "evidence_ready", "technical_error"]),
    evidence_ready: new Set(["evidence_ready", "interpreted", "technical_error"]),
    interpreted: new Set(["interpreted"]),
    technical_error: new Set(["technical_error"])
});
const FATAL_RUN_ERROR_CODES = new Set(["schema_mismatch", "dependency_missing", "publication_io_failure"]);

export class LifecycleError extends Error {
    constructor(code, message, {exitCode = 20, details = undefined, cause = undefined} = {}) {
        super(message, cause === undefined ? undefined : {cause});
        this.name = "LifecycleError";
        this.code = code;
        this.exitCode = exitCode;
        this.details = details;
    }
}

export class FaultInjectionError extends LifecycleError {
    constructor(point) {
        super("fault_injected", `fault injection at ${point}`, {exitCode: 20, details: {point}});
        this.name = "FaultInjectionError";
        this.point = point;
    }
}

/**
 * Loads and validates the immutable manifest and derives the only run context
 * accepted by all modifying operations.
 */
export function loadRun(manifestPath, cwd = process.cwd()) {
    if (typeof manifestPath !== "string" || manifestPath.length === 0) {
        throw new LifecycleError("invalid_invocation", "--run-manifest is required", {exitCode: 2});
    }
    const absoluteManifestPath = path.resolve(cwd, manifestPath);
    const manifest = readJson(absoluteManifestPath, "manifest");
    const manifestResult = validateRunManifest(manifest);
    if (!manifestResult.valid) {
        throw contractError("run-manifest", manifestResult.errors);
    }
    if (path.basename(absoluteManifestPath) !== "manifest.json") {
        throw new LifecycleError("manifest_path_invalid", "run manifest must be named manifest.json", {exitCode: 10});
    }
    const runRoot = path.dirname(absoluteManifestPath);
    const expectedRoot = path.resolve(cwd, `${RUNS_ROOT}/${manifest.run_id}`);
    if (runRoot !== expectedRoot) {
        throw new LifecycleError(
            "run_root_invalid",
            `run manifest must be under ${RUNS_ROOT}/${manifest.run_id}`,
            {exitCode: 10, details: {runRoot: toRepoPath(runRoot, cwd), expectedRoot: toRepoPath(expectedRoot, cwd)}}
        );
    }
    const context = buildRunContext(manifest, cwd);
    const contextResult = validateRunContext(context, {manifest});
    if (!contextResult.valid) {
        throw contractError("run-context", contextResult.errors);
    }
    const storedManifestHashPath = path.join(runRoot, "manifest.sha256");
    if (!fs.existsSync(storedManifestHashPath)) {
        throw new LifecycleError("manifest_provenance_missing", "manifest.sha256 is required for an immutable run", {exitCode: 10});
    }
    const manifestHash = canonicalSha256(manifest);
    const storedHash = fs.readFileSync(storedManifestHashPath, "utf8").trim();
    if (storedHash !== manifestHash) {
        throw new LifecycleError("manifest_changed", "immutable manifest hash does not match manifest.json", {exitCode: 10});
    }
    const registryPath = path.resolve(cwd, context.registry_snapshot_path);
    const registry = readJson(registryPath, "registry snapshot");
    const registryValidation = validateInstitutionRegistrySnapshot(registry);
    if (!registryValidation.valid || canonicalSha256(registry) !== manifest.source_registry_sha256) {
        throw new LifecycleError("registry_snapshot_changed", "run-local registry snapshot does not match the manifest", {exitCode: 10});
    }
    return {
        cwd,
        manifest,
        manifestPath: absoluteManifestPath,
        manifestHash,
        runRoot,
        context,
        eventsPath: path.join(runRoot, EVENT_FILE),
        projectionPath: path.join(runRoot, PROJECTION_FILE),
        checkpointPath: path.join(runRoot, CHECKPOINT_FILE),
        metricsPath: path.join(runRoot, METRICS_FILE),
        entriesRoot: path.join(runRoot, "entries"),
        publishedRoot: path.resolve(cwd, PUBLISHED_ROOT)
    };
}

/**
 * Creates a new exact-scope run. The registry is copied before any event is
 * appended, and every mutable artifact is contained below the generated run.
 */
export function initializeRun({
    registrySnapshotPath,
    mode = "full",
    live = false,
    runRoot,
    runId = undefined,
    cwd = process.cwd()
}) {
    if (mode !== "full") {
        throw new LifecycleError("invalid_invocation", "--mode must be full", {exitCode: 2});
    }
    if (typeof live !== "boolean") {
        throw new LifecycleError("invalid_invocation", "live must be boolean", {exitCode: 2});
    }
    const sourcePath = path.resolve(cwd, requireString(registrySnapshotPath, "--registry-snapshot"));
    const sourceSnapshot = readJson(sourcePath, "registry snapshot");
    const registryResult = validateInstitutionRegistrySnapshot(sourceSnapshot);
    if (!registryResult.valid) {
        throw contractError("institution-registry-snapshot", registryResult.errors);
    }
    const resolvedRunId = runId ?? createRunId();
    if (!/^run-[0-9]{8}T[0-9]{6}Z-[a-z0-9]{6,}$/.test(resolvedRunId)) {
        throw new LifecycleError("invalid_invocation", "--run-id does not match the run id contract", {exitCode: 2});
    }
    const parentRoot = path.resolve(cwd, requireString(runRoot, "--run-root"));
    const canonicalParent = path.resolve(cwd, RUNS_ROOT);
    const finalRunRoot = path.basename(parentRoot) === resolvedRunId ? parentRoot : path.join(parentRoot, resolvedRunId);
    if (path.dirname(finalRunRoot) !== canonicalParent) {
        throw new LifecycleError(
            "run_root_invalid",
            `--run-root must be exactly ${RUNS_ROOT} or its generated run directory`,
            {exitCode: 10}
        );
    }
    if (fs.existsSync(finalRunRoot)) {
        throw new LifecycleError("run_exists", `run ${resolvedRunId} already exists`, {exitCode: 10});
    }

    const scopeEntries = sourceSnapshot.entries.map((entry) => ({
        entry_id: entry.entry_id,
        lp: entry.lp,
        institution_id: entry.institution_id,
        institution_type: entry.institution_type
    }));
    const sourceRegistrySha256 = canonicalSha256(sourceSnapshot);
    const scopeHash = canonicalSha256(scopeEntries);
    const resourcePolicy = approvedResourcePolicy();
    const environmentFingerprint = environmentFingerprintFor(cwd);
    const manifestBase = {
        schema_version: "1.0.0",
        run_id: resolvedRunId,
        scope: {entries: scopeEntries, scope_sha256: scopeHash},
        source_registry_sha256: sourceRegistrySha256,
        mode,
        live: Boolean(live),
        discovery_policy: "deterministic_official_sources",
        resource_policy: resourcePolicy,
        transport_cache_policy: "revalidate_conditional",
        methodology_version: "mortgage-refinancing-scan@1.0.0",
        created_at: nowUtc(),
        input_fingerprint: "0".repeat(64),
        environment_fingerprint: environmentFingerprint
    };
    const fingerprintInput = {
        phase: "core-lifecycle",
        scope: manifestBase.scope,
        source_registry_sha256: sourceRegistrySha256,
        mode,
        live: Boolean(live),
        discovery_policy: manifestBase.discovery_policy,
        resource_policy: resourcePolicy,
        transport_cache_policy: manifestBase.transport_cache_policy,
        methodology_version: manifestBase.methodology_version,
        environment_fingerprint: environmentFingerprint
    };
    const manifest = {...manifestBase, input_fingerprint: canonicalSha256(fingerprintInput)};
    const manifestResult = validateRunManifest(manifest, {registryEntries: scopeEntries});
    if (!manifestResult.valid) {
        throw contractError("run-manifest", manifestResult.errors);
    }

    fs.mkdirSync(path.join(finalRunRoot, "entries"), {recursive: true});
    fs.mkdirSync(path.join(finalRunRoot, "artifacts"), {recursive: true});
    writeJsonAtomic(path.join(finalRunRoot, "manifest.json"), manifest);
    writeTextAtomic(path.join(finalRunRoot, "manifest.sha256"), `${canonicalSha256(manifest)}\n`);
    writeJsonAtomic(path.join(finalRunRoot, "registry.json"), sourceSnapshot);
    writeTextAtomic(path.join(finalRunRoot, EVENT_FILE), "");
    writeTextAtomic(path.join(finalRunRoot, "evidence.jsonl"), "");
    for (const entry of scopeEntries) {
        writeJsonAtomic(
            path.join(finalRunRoot, "entries", entry.entry_id, "state.json"),
            initialEntryState(manifest.run_id, entry)
        );
    }
    const run = loadRun(path.join(toRepoPath(finalRunRoot, cwd), "manifest.json"), cwd);
    appendLifecycleEvent(run, {
        operationId: `run-init:${resolvedRunId}`,
        nextState: "PREPARED",
        stage: "discovery",
        validationResult: {status: "passed"}
    });
    repairRunArtifacts(run);
    return summarizeRun(run);
}

/**
 * Appends one validated event through the central writer and repairs all
 * projections from the append-only log. Replaying an existing operation ID is
 * idempotent and also repairs a projection after a crash between file writes.
 */
export function appendLifecycleEvent(run, {
    operationId,
    nextState = undefined,
    stage = "discovery",
    entryId = undefined,
    attempt = undefined,
    inputArtifactIds = [],
    outputArtifactIds = [],
    validationResult = {status: "passed"},
    entryState = undefined,
    faultAt = undefined
}) {
    const operation = requireString(operationId, "operation_id");
    return withFileLock(`${run.eventsPath}.lock`, () => {
        const projection = replayRun(run);
        const existing = projection.events.find((event) => event.operation_id === operation);
        if (existing) {
            const requested = eventIntent({
                run_id: run.manifest.run_id,
                operation_id: operation,
                previous_state: existing.previous_state,
                next_state: nextState ?? existing.next_state,
                stage,
                attempt: attempt ?? existing.attempt,
                entry_id: entryId,
                input_artifact_ids: inputArtifactIds,
                output_artifact_ids: outputArtifactIds,
                validation_result: validationResult,
                entry_state: entryState
            });
            if (canonicalJson(eventIntent(existing)) !== canonicalJson(requested)) {
                throw new LifecycleError("operation_conflict", `operation_id ${operation} was already used with another event`, {exitCode: 10});
            }
            repairRunArtifacts(run);
            return {event: existing, projection: replayRun(run), idempotent: true};
        }
        const targetState = nextState ?? projection.runState;
        if (!isAllowedRunStateTransition(projection.runState, targetState)) {
            throw new LifecycleError(
                "illegal_state_transition",
                `transition ${projection.runState} -> ${targetState} is not allowed`,
                {exitCode: 10}
            );
        }
        if (entryId !== undefined && !projection.entries.has(entryId)) {
            throw new LifecycleError("entry_out_of_scope", `${entryId} is not part of the exact run scope`, {exitCode: 10});
        }
        const currentEntry = entryId === undefined ? undefined : projection.entries.get(entryId);
        const eventAttempt = attempt ?? (currentEntry ? Math.max(1, currentEntry.attempt) : 1);
        if (!Number.isInteger(eventAttempt) || eventAttempt < 1) {
            throw new LifecycleError("invalid_event", "event attempt must be a positive integer", {exitCode: 10});
        }
        if (currentEntry) {
            if (!ENTRY_STAGE_TRANSITIONS[currentEntry.stage]?.has(stage)) {
                throw new LifecycleError(
                    "illegal_entry_stage_transition",
                    `entry ${entryId} cannot transition ${currentEntry.stage} -> ${stage}`,
                    {exitCode: 10}
                );
            }
            if (eventAttempt > currentEntry.attempt + 1 || eventAttempt < currentEntry.attempt) {
                throw new LifecycleError("invalid_entry_attempt", `entry ${entryId} attempt must advance by at most one`, {exitCode: 10});
            }
            if (stage === "technical_error" && (!entryState || !["external_source_error", "internal_error"].includes(entryState.entry_outcome))) {
                throw new LifecycleError("entry_error_outcome_missing", "terminal entry error requires external_source_error or internal_error outcome", {exitCode: 10});
            }
            if (stage === "technical_error" && (!entryState.error_code || !entryState.error_message)) {
                throw new LifecycleError("technical_error_details_missing", "technical_error requires error_code and error_message", {exitCode: 10});
            }
            if (stage === "interpreted" && (!entryState || !["qualified", "explicitly_not_qualified", "unconfirmed"].includes(entryState.decision_status))) {
                throw new LifecycleError("decision_state_missing", "interpreted requires a business decision status", {exitCode: 10});
            }
        }
        const event = {
            schema_version: "1.0.0",
            event_id: eventId(run.manifest.run_id, operation, projection.events.length + 1),
            run_id: run.manifest.run_id,
            sequence: projection.events.length + 1,
            operation_id: operation,
            occurred_at: nowUtc(),
            previous_state: projection.runState,
            next_state: targetState,
            stage,
            attempt: eventAttempt,
            ...(entryId === undefined ? {} : {entry_id: entryId}),
            input_artifact_ids: sortedUnique(inputArtifactIds),
            output_artifact_ids: sortedUnique(outputArtifactIds),
            validation_result: validationResult,
            ...(entryState === undefined ? {} : {entry_state: normalizeEntryEventState(entryState)})
        };
        const eventResult = validateRunEvent(event, {manifest: run.manifest});
        if (!eventResult.valid) {
            throw contractError("run-event", eventResult.errors);
        }
        fault(faultAt, "event-before-append");
        appendJsonLine(run.eventsPath, event);
        fault(faultAt, "event-after-append");
        const nextProjection = replayRun(run);
        writeProjection(run, nextProjection, faultAt);
        if (entryId !== undefined) {
            writeEntryState(run, nextProjection.entries.get(entryId), faultAt);
        }
        if (isCheckpointState(nextProjection.runState) && allEntriesTerminal(nextProjection)) {
            writeDerivedArtifacts(run, nextProjection, faultAt);
        }
        return {event, projection: nextProjection, idempotent: false};
    });
}

export function transitionRun(run, nextState, options = {}) {
    const projection = replayRun(run);
    if (projection.runState === nextState) {
        repairRunArtifacts(run);
        return {event: projection.lastEvent, projection: replayRun(run), idempotent: true};
    }
    if (nextState === "RUNNING" && projection.runState !== "PREPARED") {
        throw new LifecycleError("invalid_transition_input", "RUNNING requires a PREPARED run", {exitCode: 10});
    }
    if (nextState === "READY") {
        assertReadyProjection(projection);
    }
    if (nextState === "FINALIZING") {
        assertReadyProjection(projection);
        const checkpoint = readJsonIfExists(run.checkpointPath);
        if (!checkpoint || !validateCheckpoint(checkpoint, {manifest: run.manifest}).valid) {
            throw new LifecycleError("checkpoint_invalid", "READY run has no valid checkpoint", {exitCode: 10});
        }
    }
    return appendLifecycleEvent(run, {
        operationId: options.operationId ?? `transition:${nextState}:${projection.events.length + 1}`,
        nextState,
        stage: options.stage ?? "discovery",
        validationResult: options.validationResult ?? {status: "passed"},
        faultAt: options.faultAt
    });
}

export function updateEntry(run, {
    entryId,
    stage,
    operationId = undefined,
    attempt = undefined,
    decisionStatus = undefined,
    entryOutcome = undefined,
    errorCode = undefined,
    errorMessage = undefined,
    retryable = false,
    inputArtifactIds = [],
    outputArtifactIds = [],
    faultAt = undefined
}) {
    const projection = replayRun(run);
    if (projection.runState !== "RUNNING") {
        throw new LifecycleError("entry_update_requires_running", "entry updates require a RUNNING run", {exitCode: 10});
    }
    const entry = projection.entries.get(entryId);
    if (!entry) {
        throw new LifecycleError("entry_out_of_scope", `${entryId} is not part of the exact run scope`, {exitCode: 10});
    }
    if (entry.stage === "interpreted" || entry.stage === "technical_error") {
        throw new LifecycleError("entry_already_terminal", `entry ${entryId} is already terminal`, {exitCode: 10});
    }
    const eventAttempt = attempt ?? Math.max(1, entry.attempt);
    const finished = stage === "interpreted" || stage === "technical_error";
    const state = {
        decision_status: decisionStatus ?? null,
        entry_outcome: entryOutcome ?? (stage === "technical_error" ? "internal_error" : stage === "interpreted" ? "business_decision" : null),
        error_code: errorCode ?? null,
        error_message: errorMessage ?? null,
        retryable: Boolean(retryable),
        started_at: entry.started_at ?? nowUtc(),
        finished_at: finished ? nowUtc() : null,
        elapsed_ms: finished ? Math.max(0, Date.now() - parseTimestamp(entry.started_at ?? nowUtc())) : null
    };
    return appendLifecycleEvent(run, {
        operationId: operationId ?? `entry:${entryId}:${stage}:${eventAttempt}`,
        stage,
        entryId,
        attempt: eventAttempt,
        inputArtifactIds,
        outputArtifactIds,
        validationResult: {status: "passed"},
        entryState: state,
        faultAt
    });
}

export function retryEntry(run, {
    entryId,
    operationId = undefined,
    errorCode = "request_timeout_after_retries",
    errorMessage = "retryable entry failure",
    faultAt = undefined
}) {
    const projection = replayRun(run);
    const entry = projection.entries.get(entryId);
    if (!entry) {
        throw new LifecycleError("entry_out_of_scope", `${entryId} is not part of the exact run scope`, {exitCode: 10});
    }
    if (entry.stage === "interpreted" || entry.stage === "technical_error") {
        throw new LifecycleError("entry_not_retryable", `entry ${entryId} is already terminal`, {exitCode: 10});
    }
    if (entry.attempt >= run.manifest.resource_policy.max_attempts) {
        return updateEntry(run, {
            entryId,
            stage: "technical_error",
            operationId: operationId ?? `retry-exhausted:${entryId}:${entry.attempt}`,
            errorCode,
            errorMessage: `max_attempts exhausted: ${errorMessage}`
        });
    }
    return appendLifecycleEvent(run, {
        operationId: operationId ?? `retry:${entryId}:${entry.attempt + 1}`,
        stage: entry.stage,
        entryId,
        attempt: Math.max(1, entry.attempt + 1),
        validationResult: {status: "failed", errors: [errorCode]},
        entryState: {
            decision_status: null,
            entry_outcome: null,
            error_code: null,
            error_message: null,
            retryable: false,
            started_at: nowUtc(),
            finished_at: null,
            elapsed_ms: null
        },
        faultAt
    });
}

export function abortRun(run, {
    operationId = undefined,
    errorCode = "publication_io_failure",
    reason = "run aborted",
    faultAt = undefined
} = {}) {
    if (!FATAL_RUN_ERROR_CODES.has(errorCode)) {
        throw new LifecycleError("invalid_abort_error_code", `${errorCode} is not a FatalRunErrorCode`, {exitCode: 2});
    }
    const projection = replayRun(run);
    if (projection.runState === "FINALIZED") {
        throw new LifecycleError("run_already_finalized", "a FINALIZED run cannot be aborted", {exitCode: 10});
    }
    if (projection.runState === "ABORTED") {
        const existingRecord = readJsonIfExists(path.join(run.runRoot, "abort.json"));
        if (existingRecord) {
            return {event: projection.lastEvent, projection, abortRecord: existingRecord, idempotent: true};
        }
        const recoveredRecord = {
            schema_version: "1.0.0",
            run_id: run.manifest.run_id,
            state: "ABORTED",
            error_code: errorCode,
            reason: String(reason).slice(0, 2048),
            occurred_at: nowUtc()
        };
        writeJsonAtomic(path.join(run.runRoot, "abort.json"), recoveredRecord);
        removePath(path.join(run.runRoot, "publication.json"));
        removeRunPublicationTemp(run);
        return {event: projection.lastEvent, projection, abortRecord: recoveredRecord, idempotent: true};
    }
    const currentPointer = readJsonIfExists(path.join(run.publishedRoot, "current.json"));
    if (currentPointer?.run_id === run.manifest.run_id) {
        throw new LifecycleError(
            "publication_recovery_required",
            "the publication pointer already references this run; recover finalize instead of aborting",
            {exitCode: 30}
        );
    }
    removePath(path.join(run.publishedRoot, run.manifest.run_id));
    const abortRecord = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        state: "ABORTED",
        error_code: errorCode,
        reason: String(reason).slice(0, 2048),
        occurred_at: nowUtc()
    };
    const result = appendLifecycleEvent(run, {
        operationId: operationId ?? `abort:${run.manifest.run_id}:${projection.events.length + 1}`,
        nextState: "ABORTED",
        stage: "technical_error",
        validationResult: {status: "failed", errors: [errorCode]},
        faultAt
    });
    writeJsonAtomic(path.join(run.runRoot, "abort.json"), abortRecord);
    removePath(path.join(run.runRoot, "publication.json"));
    removeRunPublicationTemp(run);
    return {...result, abortRecord};
}

export function replayRun(run) {
    const events = readEventLines(run);
    let runState = "CREATED";
    const entries = new Map(run.manifest.scope.entries.map((entry) => [entry.entry_id, initialEntryState(run.manifest.run_id, entry)]));
    const operationIds = new Set();
    const eventIds = new Set();
    for (const event of events) {
        if (operationIds.has(event.operation_id)) {
            throw new LifecycleError("event_log_duplicate_operation", `duplicate operation_id ${event.operation_id}`, {exitCode: 20});
        }
        if (eventIds.has(event.event_id)) {
            throw new LifecycleError("event_log_duplicate_event", `duplicate event_id ${event.event_id}`, {exitCode: 20});
        }
        operationIds.add(event.operation_id);
        eventIds.add(event.event_id);
        if (event.sequence !== operationIds.size) {
            throw new LifecycleError("event_log_sequence_gap", `event sequence ${event.sequence} is not ${operationIds.size}`, {exitCode: 20});
        }
        const validation = validateRunEvent(event, {manifest: run.manifest});
        if (!validation.valid) {
            throw contractError("run-event", validation.errors, 20);
        }
        if (event.previous_state !== runState || !isAllowedRunStateTransition(event.previous_state, event.next_state)) {
            throw new LifecycleError(
                "event_log_state_mismatch",
                `event ${event.sequence} does not continue run state ${runState}`,
                {exitCode: 20}
            );
        }
        if (event.entry_id !== undefined) {
            const entry = entries.get(event.entry_id);
            if (!entry) {
                throw new LifecycleError("event_entry_out_of_scope", `${event.entry_id} is not in scope`, {exitCode: 20});
            }
            applyEntryEvent(entry, event);
        }
        runState = event.next_state;
    }
    return {
        runState,
        events,
        entries,
        lastEvent: events.at(-1) ?? null
    };
}

export function repairRunArtifacts(run) {
    const projection = replayRun(run);
    writeProjection(run, projection);
    for (const entry of projection.entries.values()) {
        writeEntryState(run, entry);
    }
    if (isCheckpointState(projection.runState) && allEntriesTerminal(projection)) {
        writeDerivedArtifacts(run, projection);
    }
    return projection;
}

export function buildSnapshot(run, projection = replayRun(run)) {
    if (!allEntriesTerminal(projection)) {
        throw new LifecycleError("scope_incomplete", "cannot build a snapshot before every scope entry is terminal", {exitCode: 10});
    }
    const hasEntryErrors = [...projection.entries.values()].some((entry) => ["external_source_error", "internal_error"].includes(entry.entry_outcome));
    const snapshot = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        scope_sha256: run.manifest.scope.scope_sha256,
        coverage_status: hasEntryErrors ? "degraded" : "complete",
        entries: [...projection.entries.values()]
            .sort((left, right) => left.lp - right.lp)
            .map((entry) => {
                const result = readInterpretationResult(run, entry);
                const exportReady = result?.export_ready === true;
                return {
                    entry_id: entry.entry_id,
                    lp: entry.lp,
                    institution_id: entry.institution_id,
                    institution_type: "cooperative_bank",
                    decision_status: entry.decision_status,
                    entry_outcome: entry.entry_outcome,
                    export_ready: exportReady,
                    data_status: exportReady ? "complete" : "incomplete",
                    export_blockers: result?.export_blockers ?? (entry.entry_outcome === "external_source_error"
                        ? ["external_source_error"]
                        : entry.entry_outcome === "internal_error" ? ["internal_error"] : ["decision_incomplete"]),
                    error_code: entry.error_code,
                    error_message: entry.error_message,
                    result
                };
            })
    };
    const validation = validateSnapshot(snapshot, {manifest: run.manifest});
    if (!validation.valid) {
        throw contractError("snapshot", validation.errors);
    }
    return snapshot;
}

function readInterpretationResult(run, entry) {
    const filePath = path.join(run.runRoot, "artifacts", "interpretation", `${entry.entry_id}.json`);
    if (!fs.existsSync(filePath)) return null;
    let result;
    try {
        result = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new LifecycleError("schema_mismatch", `interpretation result ${entry.entry_id} is invalid JSON`, {exitCode: 20, cause: error});
    }
    const validation = validateContract("interpretation-result", result);
    if (!validation.valid) {
        throw contractError("interpretation-result", validation.errors);
    }
    if (result.run_id !== run.manifest.run_id || result.entry_id !== entry.entry_id || result.institution_id !== entry.institution_id) {
        throw new LifecycleError("schema_mismatch", `interpretation result ${entry.entry_id} is not bound to the current run entry`, {exitCode: 20});
    }
    if (result.decision_status !== entry.decision_status) {
        throw new LifecycleError("schema_mismatch", `interpretation result ${entry.entry_id} status does not match the entry projection`, {exitCode: 20});
    }
    return result;
}

export function finalizeRun(run, {faultAt = undefined} = {}) {
    let projection = replayRun(run);
    if (projection.runState === "FINALIZED") {
        return recoverFinalizedRun(run, projection);
    }
    if (projection.runState === "READY") {
        transitionRun(run, "FINALIZING", {operationId: `finalize-start:${run.manifest.run_id}`, faultAt});
        projection = replayRun(run);
    }
    if (projection.runState !== "FINALIZING") {
        throw new LifecycleError("finalize_requires_ready", `finalize requires READY or FINALIZING, got ${projection.runState}`, {exitCode: 10});
    }
    const checkpoint = readJsonIfExists(run.checkpointPath);
    const checkpointResult = validateCheckpoint(checkpoint, {manifest: run.manifest});
    if (!checkpointResult.valid) {
        throw contractError("run-checkpoint", checkpointResult.errors);
    }
    const snapshot = buildSnapshot(run, projection);
    const publication = publishSnapshot(run, snapshot, checkpoint, faultAt);
    fault(faultAt, "finalize-before-final-state");
    appendLifecycleEvent(run, {
        operationId: `finalize-complete:${run.manifest.run_id}`,
        nextState: "FINALIZED",
        stage: "interpreted",
        validationResult: {status: "passed"},
        faultAt
    });
    projection = replayRun(run);
    return {run: summarizeRun(run, projection), publication, recovered: false};
}

function recoverFinalizedRun(run, projection) {
    const pointer = readJsonIfExists(path.join(run.publishedRoot, "current.json"));
    const publishedDir = path.join(run.publishedRoot, run.manifest.run_id);
    const publicationRecord = readJsonIfExists(path.join(publishedDir, "publication.json"));
    if (!pointer || !publicationRecord) {
        throw new LifecycleError("publication_recovery_failed", "FINALIZED run has no complete publication artifacts", {exitCode: 30});
    }
    const checkpoint = readJsonIfExists(run.checkpointPath);
    const published = validatePublishedDirectory(run, publishedDir, checkpoint);
    const pointerResult = validatePointer(pointer, {
        manifest: run.manifest,
        publicationRecord,
        publicationSha256: published.publicationSha256
    });
    if (!pointerResult.valid) {
        throw contractError("pointer", pointerResult.errors, 30);
    }
    return {run: summarizeRun(run, projection), publication: pointer, recovered: true};
}

function publishSnapshot(run, snapshot, checkpoint, faultAt) {
    const publishedDir = path.join(run.publishedRoot, run.manifest.run_id);
    const tempDir = path.join(run.publishedRoot, `.tmp-${run.manifest.run_id}-${process.pid}`);
    fs.mkdirSync(run.publishedRoot, {recursive: true});
    fault(faultAt, "finalize-before-publication-temp");
    if (fs.existsSync(publishedDir)) {
        const existing = readJsonIfExists(path.join(publishedDir, "publication.json"));
        if (!existing) {
            throw new LifecycleError("publication_conflict", `published directory for ${run.manifest.run_id} is incomplete`, {exitCode: 30});
        }
        const pointer = readJsonIfExists(path.join(run.publishedRoot, "current.json"));
        if (pointer?.run_id === run.manifest.run_id) {
            const published = validatePublishedDirectory(run, publishedDir, checkpoint);
            const pointerValidation = validatePointer(pointer, {
                manifest: run.manifest,
                publicationRecord: published.publication,
                publicationSha256: published.publicationSha256
            });
            if (!pointerValidation.valid) {
                throw contractError("pointer", pointerValidation.errors, 30);
            }
            return pointer;
        }
        return recoverPublishedDirectory(run, publishedDir, checkpoint, faultAt);
    }
    removePath(tempDir);
    fs.mkdirSync(tempDir, {recursive: true});
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const evidencePath = path.join(tempDir, "evidence.jsonl");
    const snapshotBytes = `${JSON.stringify(snapshot, null, 2)}\n`;
    const runEvidencePath = path.resolve(run.cwd, run.context.evidence_path);
    const evidenceBytes = fs.existsSync(runEvidencePath) ? fs.readFileSync(runEvidencePath) : Buffer.alloc(0);
    writeTextAtomic(snapshotPath, snapshotBytes);
    fault(faultAt, "finalize-after-snapshot-write");
    writeTextAtomic(evidencePath, evidenceBytes);
    fault(faultAt, "finalize-after-evidence-write");
    const publication = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        manifest_sha256: run.manifestHash,
        snapshot_sha256: sha256Hex(snapshotBytes),
        evidence_sha256: sha256Hex(evidenceBytes),
        published_at: nowUtc(),
        status: "published",
        coverage_status: checkpoint.coverage_status
    };
    const publicationValidation = validatePublicationRecord(publication, {manifest: run.manifest, checkpoint});
    if (!publicationValidation.valid) {
        throw contractError("publication-record", publicationValidation.errors, 30);
    }
    const publicationPath = path.join(tempDir, "publication.json");
    const publicationBytes = `${JSON.stringify(publication, null, 2)}\n`;
    writeTextAtomic(publicationPath, publicationBytes);
    fault(faultAt, "finalize-after-publication-write");
    writeJsonAtomic(path.join(run.runRoot, "publication.json"), publication);
    fsyncDirectory(tempDir);
    fault(faultAt, "finalize-before-publication-rename");
    fs.renameSync(tempDir, publishedDir);
    fsyncDirectory(run.publishedRoot);
    fault(faultAt, "finalize-after-publication-rename");
    const pointer = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        published_dir: toRepoPath(publishedDir, run.cwd),
        manifest_sha256: run.manifestHash,
        snapshot_sha256: sha256Hex(snapshotBytes),
        evidence_sha256: sha256Hex(evidenceBytes),
        publication_sha256: sha256Hex(publicationBytes),
        published_at: publication.published_at,
        status: "published",
        coverage_status: publication.coverage_status
    };
    const pointerValidation = validatePointer(pointer, {
        manifest: run.manifest,
        publicationRecord: publication,
        publicationSha256: sha256Hex(publicationBytes)
    });
    if (!pointerValidation.valid) {
        throw contractError("pointer", pointerValidation.errors, 30);
    }
    fault(faultAt, "finalize-before-pointer-write");
    writeJsonAtomic(path.join(run.publishedRoot, "current.json"), pointer);
    fault(faultAt, "finalize-after-pointer-write");
    fsyncDirectory(run.publishedRoot);
    return pointer;
}

function recoverPublishedDirectory(run, publishedDir, checkpoint, faultAt) {
    const published = validatePublishedDirectory(run, publishedDir, checkpoint);
    const {publication, snapshotSha256, evidenceSha256, publicationSha256} = published;
    const pointer = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        published_dir: toRepoPath(publishedDir, run.cwd),
        manifest_sha256: publication.manifest_sha256,
        snapshot_sha256: snapshotSha256,
        evidence_sha256: evidenceSha256,
        publication_sha256: publicationSha256,
        published_at: publication.published_at,
        status: publication.status,
        coverage_status: publication.coverage_status
    };
    const pointerValidation = validatePointer(pointer, {
        manifest: run.manifest,
        publicationRecord: publication,
        publicationSha256: published.publicationSha256
    });
    if (!pointerValidation.valid) {
        throw contractError("pointer", pointerValidation.errors, 30);
    }
    fault(faultAt, "finalize-before-pointer-write");
    writeJsonAtomic(path.join(run.publishedRoot, "current.json"), pointer);
    fault(faultAt, "finalize-after-pointer-write");
    fsyncDirectory(run.publishedRoot);
    return pointer;
}

function validatePublishedDirectory(run, publishedDir, checkpoint) {
    const snapshotBytes = readFile(path.join(publishedDir, "snapshot.json"));
    const evidenceBytes = readFile(path.join(publishedDir, "evidence.jsonl"));
    const publicationBytes = readFile(path.join(publishedDir, "publication.json"));
    let snapshot;
    let publication;
    try {
        snapshot = JSON.parse(snapshotBytes.toString("utf8"));
        publication = JSON.parse(publicationBytes.toString("utf8"));
    } catch (error) {
        throw new LifecycleError("publication_recovery_failed", "published artifacts contain invalid JSON", {exitCode: 30, cause: error});
    }
    const snapshotValidation = validateSnapshot(snapshot, {manifest: run.manifest});
    if (!snapshotValidation.valid) {
        throw contractError("snapshot", snapshotValidation.errors, 30);
    }
    const publicationValidation = validatePublicationRecord(publication, {manifest: run.manifest, checkpoint});
    if (!publicationValidation.valid) {
        throw contractError("publication-record", publicationValidation.errors, 30);
    }
    const snapshotSha256 = sha256Hex(snapshotBytes);
    const evidenceSha256 = sha256Hex(evidenceBytes);
    const publicationSha256 = sha256Hex(publicationBytes);
    if (publication.manifest_sha256 !== run.manifestHash
        || publication.snapshot_sha256 !== snapshotSha256
        || publication.evidence_sha256 !== evidenceSha256) {
        throw new LifecycleError("publication_hash_mismatch", "published hashes do not match immutable artifacts", {exitCode: 30});
    }
    return {snapshotBytes, evidenceBytes, publicationBytes, publication, snapshotSha256, evidenceSha256, publicationSha256};
}

function writeDerivedArtifacts(run, projection, faultAt = undefined) {
    const checkpoint = buildCheckpoint(run, projection);
    const checkpointValidation = validateCheckpoint(checkpoint, {manifest: run.manifest});
    if (!checkpointValidation.valid) {
        throw contractError("run-checkpoint", checkpointValidation.errors);
    }
    fault(faultAt, "checkpoint-before-write");
    writeJsonAtomic(run.checkpointPath, checkpoint);
    fault(faultAt, "checkpoint-after-write");
    const telemetry = buildTelemetry(run, projection, checkpoint);
    const telemetryValidation = validateTelemetry(telemetry, {manifest: run.manifest, checkpoint});
    if (!telemetryValidation.valid) {
        throw contractError("telemetry", telemetryValidation.errors);
    }
    writeJsonAtomic(run.metricsPath, telemetry);
}

function buildCheckpoint(run, projection) {
    const entries = [...projection.entries.values()];
    const externalSourceErrors = entries.filter((entry) => entry.entry_outcome === "external_source_error").length;
    const internalErrors = entries.filter((entry) => entry.entry_outcome === "internal_error").length;
    const interpreted = entries.filter((entry) => entry.stage === "interpreted").length;
    return {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        scope_count: entries.length,
        discovered_count: entries.filter((entry) => entry.stage !== "discovery" || entry.entry_outcome !== null).length,
        interpreted_count: interpreted,
        terminal_entry_count: entries.filter(isTerminalEntry).length,
        qualified_count: entries.filter((entry) => entry.decision_status === "qualified").length,
        unconfirmed_count: entries.filter((entry) => entry.decision_status === "unconfirmed" || entry.decision_status === "explicitly_not_qualified").length,
        external_source_error_count: externalSourceErrors,
        internal_error_count: internalErrors,
        technical_error_count: internalErrors,
        fatal_error_count: 0,
        status: externalSourceErrors + internalErrors > 0 ? "ready_with_errors" : "ready",
        coverage_status: externalSourceErrors + internalErrors > 0 ? "degraded" : "complete"
    };
}

function buildTelemetry(run, projection, checkpoint) {
    const entries = [...projection.entries.values()].sort((left, right) => left.lp - right.lp);
    const research = readResearchTelemetry(run);
    const pipeline = readJsonIfExists(path.join(run.runRoot, "pipeline-telemetry.json"));
    const zeroRequests = () => ({total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0});
    const zeroCache = () => ({misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0});
    const zeroBytes = () => ({downloaded: 0, reused_from_cache: 0});
    const stageCounts = new Map();
    for (const entry of entries) {
        stageCounts.set(entry.stage, (stageCounts.get(entry.stage) ?? 0) + 1);
    }
    return {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        generated_at: nowUtc(),
        run: {
            wall_clock_ms: pipeline?.wall_clock_ms ?? research.run.wall_clock_ms,
            entry_duration_ms_p50: percentile(entries.map((entry) => research.entries.get(entry.entry_id)?.wall_clock_ms ?? entry.elapsed_ms ?? 0), 0.5),
            entry_duration_ms_p95: percentile(entries.map((entry) => research.entries.get(entry.entry_id)?.wall_clock_ms ?? entry.elapsed_ms ?? 0), 0.95),
            requests: research.run.requests,
            cache: research.run.cache,
            bytes: research.run.bytes,
            resources: pipeline?.resources ?? {cpu_user_ms: 0, cpu_system_ms: 0, max_rss_bytes: process.memoryUsage().rss},
            event_writer: {
                events_written: projection.events.length,
                batches_written: projection.events.length === 0 ? 0 : 1,
                max_batch_size: projection.events.length,
                max_lag_ms: 0
            },
            errors: {
                retryable_error_count: projection.events.filter((event) => event.validation_result.status === "failed").length + research.run.retryable_error_count,
                entry_technical_error_count: checkpoint.technical_error_count,
                entry_external_source_error_count: checkpoint.external_source_error_count ?? 0,
                entry_internal_error_count: checkpoint.internal_error_count ?? checkpoint.technical_error_count ?? 0,
                fatal_error_count: checkpoint.fatal_error_count
            }
        },
        stages: [...new Set([...stageCounts.keys(), ...research.stages.keys()])]
            .sort((left, right) => entryStageOrder(left) - entryStageOrder(right))
            .map((stage) => {
                const metric = research.stages.get(stage);
                const entryCount = stageCounts.get(stage) ?? 0;
                return {
                    stage,
                    entry_count: metric?.entry_ids.size ?? entryCount,
                    wall_clock_ms: metric?.wall_clock_ms ?? 0,
                    requests: metric?.requests ?? zeroRequests(),
                    bytes: metric?.bytes ?? zeroBytes(),
                    error_count: (metric?.error_count ?? 0) + (stage === "technical_error" ? entryCount : 0)
                };
            }),
        entries: entries.map((entry) => ({
            ...(() => {
                const metric = research.entries.get(entry.entry_id);
                return {
                    requests: metric?.requests ?? zeroRequests(),
                    cache: metric?.cache ?? zeroCache(),
                    bytes: metric?.bytes ?? zeroBytes(),
                    wall_clock_ms: metric?.wall_clock_ms ?? entry.elapsed_ms ?? 0,
                    attempts: Math.max(Math.max(1, entry.attempt), metric?.attempts ?? 1),
                    error_code: entry.error_code ?? metric?.error_code ?? null
                };
            })(),
            entry_id: entry.entry_id,
            institution_id: entry.institution_id,
            final_stage: entry.stage,
        }))
    };
}

function readResearchTelemetry(run) {
    const zeroRequests = () => ({total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0});
    const zeroCache = () => ({misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0});
    const zeroBytes = () => ({downloaded: 0, reused_from_cache: 0});
    const empty = {
        run: {
            wall_clock_ms: 0,
            requests: zeroRequests(),
            cache: zeroCache(),
            bytes: zeroBytes(),
            retryable_error_count: 0
        },
        stages: new Map(),
        entries: new Map()
    };
    const filePath = path.join(run.runRoot, "research-telemetry.json");
    if (!fs.existsSync(filePath)) {
        return empty;
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new LifecycleError("schema_mismatch", "research telemetry is invalid JSON", {exitCode: 20, cause: error});
    }
    if (raw?.run_id !== run.manifest.run_id || !Array.isArray(raw.operations)) {
        throw new LifecycleError("schema_mismatch", "research telemetry is not bound to the current run", {exitCode: 20});
    }
    const add = (target, source) => {
        for (const key of Object.keys(target)) {
            target[key] += Number(source?.[key] ?? 0);
        }
    };
    for (const operation of raw.operations) {
        add(empty.run.requests, operation.requests);
        add(empty.run.cache, operation.cache);
        add(empty.run.bytes, operation.bytes);
        empty.run.wall_clock_ms += Number(operation.duration_ms ?? 0);
        empty.run.retryable_error_count += Number(operation.retryable_error_count ?? 0);
        const stage = empty.stages.get(operation.stage) ?? {
            entry_ids: new Set(),
            wall_clock_ms: 0,
            requests: zeroRequests(),
            bytes: zeroBytes(),
            error_count: 0
        };
        stage.entry_ids.add(operation.entry_id);
        stage.wall_clock_ms += Number(operation.duration_ms ?? 0);
        add(stage.requests, operation.requests);
        add(stage.bytes, operation.bytes);
        stage.error_count += Number(operation.error_count ?? 0);
        empty.stages.set(operation.stage, stage);
        const entry = empty.entries.get(operation.entry_id) ?? {
            requests: zeroRequests(),
            cache: zeroCache(),
            bytes: zeroBytes(),
            wall_clock_ms: 0,
            attempts: 1,
            error_code: null
        };
        add(entry.requests, operation.requests);
        add(entry.cache, operation.cache);
        add(entry.bytes, operation.bytes);
        entry.wall_clock_ms += Number(operation.duration_ms ?? 0);
        entry.attempts = Math.max(entry.attempts, Number(operation.attempts ?? 1));
        if (operation.error_code) entry.error_code = operation.error_code;
        empty.entries.set(operation.entry_id, entry);
    }
    empty.run.cache.hit_rate = cacheHitRate(empty.run.cache);
    for (const entry of empty.entries.values()) {
        entry.cache.hit_rate = cacheHitRate(entry.cache);
    }
    return empty;
}

function cacheHitRate(cache) {
    const total = cache.misses + cache.revalidated_not_modified + cache.refetched;
    return total === 0 ? 0 : cache.revalidated_not_modified / total;
}

function entryStageOrder(stage) {
    return ["discovery", "fetched", "normalized", "evidence_ready", "interpreted", "technical_error"].indexOf(stage);
}

function writeProjection(run, projection, faultAt = undefined) {
    const value = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        run_state: projection.runState,
        last_event_sequence: projection.events.length,
        entries: [...projection.entries.values()].sort((left, right) => left.lp - right.lp)
    };
    fault(faultAt, "projection-before-rename");
    writeJsonAtomic(run.projectionPath, value);
    fault(faultAt, "projection-after-rename");
}

function writeEntryState(run, entry, faultAt = undefined) {
    const validation = validateEntryState(entry, {manifest: run.manifest});
    if (!validation.valid) {
        throw contractError("entry-state", validation.errors);
    }
    const target = path.join(run.entriesRoot, entry.entry_id, "state.json");
    fault(faultAt, "entry-state-before-rename");
    writeJsonAtomic(target, entry);
    fault(faultAt, "entry-state-after-rename");
}

function readEventLines(run) {
    if (!fs.existsSync(run.eventsPath)) {
        throw new LifecycleError("event_log_missing", "events.jsonl is missing", {exitCode: 20});
    }
    const text = fs.readFileSync(run.eventsPath, "utf8");
    if (text.length === 0) {
        return [];
    }
    if (!text.endsWith("\n")) {
        throw new LifecycleError("event_log_partial_record", "events.jsonl does not end at a complete record", {exitCode: 20});
    }
    return text.trimEnd().split("\n").map((line, index) => {
        if (line.trim() === "") {
            throw new LifecycleError("event_log_blank_record", `events.jsonl contains a blank record at ${index + 1}`, {exitCode: 20});
        }
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new LifecycleError("event_log_invalid_json", `events.jsonl record ${index + 1} is invalid JSON`, {exitCode: 20, cause: error});
        }
    });
}

function applyEntryEvent(entry, event) {
    if (event.attempt < entry.attempt || event.attempt > entry.attempt + 1) {
        throw new LifecycleError("event_entry_attempt_mismatch", `entry ${entry.entry_id} attempt sequence is invalid`, {exitCode: 20});
    }
    const allowed = ENTRY_STAGE_TRANSITIONS[entry.stage];
    if (!allowed?.has(event.stage)) {
        throw new LifecycleError("event_entry_stage_mismatch", `entry ${entry.entry_id} stage ${entry.stage} cannot become ${event.stage}`, {exitCode: 20});
    }
    const update = event.entry_state ?? {};
    entry.stage = event.stage;
    entry.attempt = event.attempt;
    entry.input_artifact_ids = event.input_artifact_ids;
    entry.output_artifact_ids = event.output_artifact_ids;
    if (update.started_at !== undefined) {
        entry.started_at = update.started_at;
    } else if (entry.started_at === null) {
        entry.started_at = event.occurred_at;
    }
    if (update.finished_at !== undefined) {
        entry.finished_at = update.finished_at;
    }
    if (update.elapsed_ms !== undefined) {
        entry.elapsed_ms = update.elapsed_ms;
    }
    if (update.decision_status !== undefined) {
        entry.decision_status = update.decision_status;
    }
    if (update.entry_outcome !== undefined) {
        entry.entry_outcome = update.entry_outcome;
    } else if (event.stage === "technical_error" && entry.entry_outcome === null) {
        entry.entry_outcome = "internal_error";
    } else if (event.stage === "interpreted" && entry.entry_outcome === null) {
        entry.entry_outcome = "business_decision";
    }
    if (update.error_code !== undefined) {
        entry.error_code = update.error_code;
    }
    if (update.error_message !== undefined) {
        entry.error_message = update.error_message;
    }
    if (update.retryable !== undefined) {
        entry.retryable = update.retryable;
    }
}

function eventIntent(event) {
    return {
        run_id: event.run_id,
        operation_id: event.operation_id,
        previous_state: event.previous_state,
        next_state: event.next_state,
        stage: event.stage,
        attempt: event.attempt,
        ...(event.entry_id === undefined ? {} : {entry_id: event.entry_id}),
        input_artifact_ids: event.input_artifact_ids ?? [],
        output_artifact_ids: event.output_artifact_ids ?? [],
        validation_result: event.validation_result,
        ...(event.entry_state === undefined ? {} : {entry_state: eventStateIdentity(event.entry_state)})
    };
}

function eventStateIdentity(state) {
    return {
        decision_status: state.decision_status ?? null,
        entry_outcome: state.entry_outcome ?? null,
        error_code: state.error_code ?? null,
        error_message: state.error_message ?? null,
        retryable: Boolean(state.retryable)
    };
}

function normalizeEntryEventState(state) {
    return {
        decision_status: state.decision_status ?? null,
        entry_outcome: state.entry_outcome ?? null,
        error_code: state.error_code ?? null,
        error_message: state.error_message ?? null,
        retryable: Boolean(state.retryable),
        ...(state.started_at === undefined ? {} : {started_at: state.started_at}),
        ...(state.finished_at === undefined ? {} : {finished_at: state.finished_at}),
        ...(state.elapsed_ms === undefined ? {} : {elapsed_ms: state.elapsed_ms})
    };
}

function buildRunContext(manifest, cwd) {
    const runRoot = `${RUNS_ROOT}/${manifest.run_id}`;
    const transportCacheRoot = process.env.MORTGAGE_REFINANCING_SCAN_TRANSPORT_CACHE_ROOT ?? TRANSPORT_CACHE_ROOT;
    const normalizationCacheRoot = process.env.MORTGAGE_REFINANCING_SCAN_NORMALIZATION_CACHE_ROOT ?? NORMALIZATION_CACHE_ROOT;
    return {
        schema_version: "1.0.0",
        run_id: manifest.run_id,
        manifest_path: `${runRoot}/manifest.json`,
        run_root: runRoot,
        registry_snapshot_path: `${runRoot}/registry.json`,
        source_registry_sha256: manifest.source_registry_sha256,
        scope: {entries: manifest.scope.entries},
        artifact_root: `${runRoot}/artifacts`,
        transport_cache_root: transportCacheRoot,
        normalization_cache_root: normalizationCacheRoot,
        evidence_path: `${runRoot}/evidence.jsonl`,
        event_path: `${runRoot}/${EVENT_FILE}`,
        checkpoint_path: `${runRoot}/${CHECKPOINT_FILE}`
    };
}

function initialEntryState(runId, entry) {
    return {
        schema_version: "1.0.0",
        run_id: runId,
        entry_id: entry.entry_id,
        lp: entry.lp,
        institution_id: entry.institution_id,
        stage: "discovery",
        attempt: 0,
        started_at: null,
        finished_at: null,
        elapsed_ms: null,
        input_artifact_ids: [],
        output_artifact_ids: [],
        decision_status: null,
        entry_outcome: null,
        error_code: null,
        error_message: null,
        retryable: false
    };
}

function summarizeRun(run, projection = replayRun(run)) {
    return {
        run_id: run.manifest.run_id,
        status: projection.runState,
        manifest_path: toRepoPath(run.manifestPath, run.cwd),
        run_root: toRepoPath(run.runRoot, run.cwd),
        checkpoint_path: fs.existsSync(run.checkpointPath) ? toRepoPath(run.checkpointPath, run.cwd) : null,
        publication_pointer: fs.existsSync(path.join(run.publishedRoot, "current.json"))
            ? toRepoPath(path.join(run.publishedRoot, "current.json"), run.cwd)
            : null,
        event_count: projection.events.length,
        terminal_entry_count: [...projection.entries.values()].filter(isTerminalEntry).length
    };
}

function assertReadyProjection(projection) {
    if (projection.runState !== "RUNNING" && projection.runState !== "READY") {
        throw new LifecycleError("invalid_transition_input", `expected RUNNING or READY, got ${projection.runState}`, {exitCode: 10});
    }
    if (!allEntriesTerminal(projection)) {
        throw new LifecycleError("scope_incomplete", "all exact-scope entries must be terminal before READY", {exitCode: 10});
    }
}

function allEntriesTerminal(projection) {
    return [...projection.entries.values()].every(isTerminalEntry);
}

function isTerminalEntry(entry) {
    return entry.stage === "interpreted" || entry.stage === "technical_error";
}

function isCheckpointState(state) {
    return state === "READY" || state === "FINALIZING" || state === "FINALIZED";
}

function approvedResourcePolicy() {
    return {
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
    };
}

function environmentFingerprintFor(cwd) {
    const packageLock = path.join(cwd, ".agents/skills/mortgage-refinancing-scan/package-lock.json");
    return {
        node_version: process.version,
        package_lock_sha256: sha256Hex(readFile(packageLock)),
        morfeusz_version: process.env.MORFEUSZ_VERSION ?? "not-checked-phase-2",
        locale: "C.UTF-8",
        timezone: "UTC"
    };
}

function createRunId() {
    const date = new Date();
    const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const suffix = crypto.randomBytes(5).toString("hex").slice(0, 10);
    return `run-${stamp}-${suffix}`;
}

function eventId(runId, operationId, sequence) {
    return `evt-${sha256Hex(canonicalJson([runId, operationId, sequence])).slice(0, 24)}`;
}

function nowUtc() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseTimestamp(value) {
    const parsed = Date.parse(value ?? "");
    return Number.isFinite(parsed) ? parsed : Date.now();
}

function percentile(values, quantile) {
    if (values.length === 0) {
        return 0;
    }
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile))];
}

function sortedUnique(values) {
    if (!Array.isArray(values)) {
        throw new LifecycleError("invalid_event", "artifact ids must be arrays", {exitCode: 2});
    }
    return [...new Set(values)].sort();
}

function contractError(contract, errors, exitCode = 10) {
    return new LifecycleError(
        "contract_validation_failed",
        `contract "${contract}" validation failed`,
        {exitCode, details: {contract, errors}}
    );
}

function requireString(value, label) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new LifecycleError("invalid_invocation", `${label} must be a non-empty string`, {exitCode: 2});
    }
    return value;
}

function readJson(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new LifecycleError("invalid_json", `${label} cannot be read as JSON`, {exitCode: 10, cause: error});
    }
}

function readJsonIfExists(filePath) {
    return fs.existsSync(filePath) ? readJson(filePath, path.basename(filePath)) : null;
}

function readFile(filePath) {
    try {
        return fs.readFileSync(filePath);
    } catch (error) {
        throw new LifecycleError("dependency_missing", `required file is unavailable: ${filePath}`, {exitCode: 20, cause: error});
    }
}

function writeJsonAtomic(filePath, value) {
    writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextAtomic(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(tempPath, "wx", 0o600);
        fs.writeFileSync(descriptor, content, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(tempPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    } catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup */ }
        if (error instanceof LifecycleError) {
            throw error;
        }
        throw new LifecycleError("publication_io_failure", `atomic write failed for ${filePath}`, {exitCode: 30, cause: error});
    }
}

function appendJsonLine(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const descriptor = fs.openSync(filePath, "a", 0o600);
    try {
        fs.writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, "utf8");
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function withFileLock(lockPath, callback) {
    fs.mkdirSync(path.dirname(lockPath), {recursive: true});
    const started = Date.now();
    let descriptor;
    while (descriptor === undefined) {
        try {
            descriptor = fs.openSync(lockPath, "wx", 0o600);
            fs.writeFileSync(descriptor, `${process.pid}:${Date.now()}\n`);
            fs.fsyncSync(descriptor);
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw new LifecycleError("event_writer_lock_failure", `cannot acquire ${lockPath}`, {exitCode: 20, cause: error});
            }
            try {
                if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_TIMEOUT_MS) {
                    fs.unlinkSync(lockPath);
                    continue;
                }
            } catch {
                continue;
            }
            if (Date.now() - started > LOCK_TIMEOUT_MS) {
                throw new LifecycleError("event_writer_lock_timeout", `timed out waiting for ${lockPath}`, {exitCode: 20});
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
    }
    try {
        return callback();
    } finally {
        fs.closeSync(descriptor);
        try { fs.unlinkSync(lockPath); } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
}

function fault(faultAt, point) {
    if (faultAt === point) {
        throw new FaultInjectionError(point);
    }
}

function fsyncDirectory(directory) {
    try {
        const descriptor = fs.openSync(directory, "r");
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    } catch {
        // Directory fsync is not available on every filesystem used by tests.
    }
}

function removePath(target) {
    fs.rmSync(target, {recursive: true, force: true});
}

function removeRunPublicationTemp(run) {
    if (!fs.existsSync(run.publishedRoot)) {
        return;
    }
    for (const entry of fs.readdirSync(run.publishedRoot)) {
        if (entry.startsWith(`.tmp-${run.manifest.run_id}-`)) {
            removePath(path.join(run.publishedRoot, entry));
        }
    }
}

function toRepoPath(absolutePath, cwd) {
    const relative = path.relative(cwd, absolutePath).split(path.sep).join("/");
    return relative === "" ? "." : relative;
}
