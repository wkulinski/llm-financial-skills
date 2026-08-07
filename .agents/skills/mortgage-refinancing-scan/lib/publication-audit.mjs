import fs from "node:fs";
import path from "node:path";

import {sha256Hex} from "./canonical-json.mjs";
import {
    loadRun,
    replayRun
} from "./run-lifecycle.mjs";
import {
    validateCheckpoint,
    validateEvidenceRecord,
    validateInterpretationResult,
    validatePointer,
    validatePublicationRecord,
    validateSnapshot,
    validateTelemetry
} from "./run-contract-validate.mjs";

/**
 * Read-only validation of a finalized publication.  No artifact is repaired,
 * rewritten or removed by this module.
 */
export function auditPublication({runManifestPath, cwd = process.cwd()} = {}) {
    const errors = [];
    let run;
    try {
        run = loadRun(runManifestPath, cwd);
    } catch (error) {
        return failedAudit({cwd, errors: [errorRecord(error?.code ?? "schema_mismatch", error?.message ?? String(error))]});
    }

    const projection = replayRun(run);
    const paths = publicationPaths(run);
    const checks = {
        finalized_state: projection.runState === "FINALIZED",
        checkpoint: false,
        telemetry: false,
        snapshot: false,
        evidence: false,
        publication: false,
        pointer: false,
        hashes: false,
        interpretation_results: false
    };
    if (!checks.finalized_state) {
        errors.push(errorRecord("run_not_finalized", `run state is ${projection.runState}, expected FINALIZED`, "run"));
    }

    const checkpoint = readJson(paths.checkpointPath, errors, "checkpoint");
    if (checkpoint) {
        const validation = validateCheckpoint(checkpoint, {manifest: run.manifest});
        appendValidationErrors(errors, "checkpoint", validation.errors);
        checks.checkpoint = validation.valid;
    }
    const telemetry = readJson(paths.metricsPath, errors, "telemetry");
    if (telemetry) {
        const validation = validateTelemetry(telemetry, {manifest: run.manifest, checkpoint});
        appendValidationErrors(errors, "telemetry", validation.errors);
        checks.telemetry = validation.valid;
    }
    const pointer = readJson(paths.pointerPath, errors, "publication pointer");
    const snapshotBytes = readBuffer(paths.snapshotPath, errors, "published snapshot");
    const evidenceBytes = readBuffer(paths.evidencePath, errors, "published evidence");
    const publicationBytes = readBuffer(paths.publicationPath, errors, "publication record");
    const snapshot = parseBuffer(snapshotBytes, errors, "published snapshot");
    const evidence = parseEvidence(evidenceBytes, errors);
    const publication = parseBuffer(publicationBytes, errors, "publication record");

    if (snapshot) {
        const validation = validateSnapshot(snapshot, {manifest: run.manifest});
        appendValidationErrors(errors, "snapshot", validation.errors);
        checks.snapshot = validation.valid;
    }
    if (publication && checkpoint) {
        const validation = validatePublicationRecord(publication, {manifest: run.manifest, checkpoint});
        appendValidationErrors(errors, "publication", validation.errors);
        checks.publication = validation.valid;
    }
    if (pointer && publication) {
        const validation = validatePointer(pointer, {
            manifest: run.manifest,
            publicationRecord: publication,
            publicationSha256: publicationBytes ? sha256Hex(publicationBytes) : ""
        });
        appendValidationErrors(errors, "pointer", validation.errors);
        checks.pointer = validation.valid;
    }
    if (evidence && snapshot) {
        const evidenceValidation = validateEvidence(evidence, run.manifest);
        appendValidationErrors(errors, "evidence", evidenceValidation.errors);
        checks.evidence = evidenceValidation.valid;
        if (checks.snapshot) {
            const resultValidation = validateSnapshotResults(snapshot, evidence, run.manifest);
            appendValidationErrors(errors, "interpretation", resultValidation.errors);
            checks.interpretation_results = resultValidation.valid;
        }
    }

    if (pointer && path.resolve(cwd, String(pointer.published_dir ?? "")) !== paths.publishedDir) {
        errors.push(errorRecord("pointer_path_mismatch", "pointer does not reference the selected run publication", "/published_dir"));
    }
    if (pointer && publication && snapshotBytes && evidenceBytes && publicationBytes) {
        const hashErrors = [
            ["snapshot_sha256", sha256Hex(snapshotBytes)],
            ["evidence_sha256", sha256Hex(evidenceBytes)],
            ["publication_sha256", sha256Hex(publicationBytes)]
        ].filter(([field, expected]) => pointer[field] !== expected || (field !== "publication_sha256" && publication[field] !== expected));
        if (hashErrors.length > 0) {
            for (const [field, expected] of hashErrors) {
                errors.push(errorRecord("publication_hash_mismatch", `${field} does not match the immutable artifact hash`, `/${field}`, {expected}));
            }
        } else {
            checks.hashes = true;
        }
    }

    return {
        schema_version: "1.0.0",
        audit_version: "1.0.0",
        run_id: run.manifest.run_id,
        status: errors.length === 0 ? "passed" : "failed",
        valid: errors.length === 0,
        read_only: true,
        errors,
        checks,
        paths: {
            manifest_path: relative(cwd, run.manifestPath),
            checkpoint_path: relative(cwd, paths.checkpointPath),
            telemetry_path: relative(cwd, paths.metricsPath),
            pointer_path: relative(cwd, paths.pointerPath),
            snapshot_path: relative(cwd, paths.snapshotPath),
            evidence_path: relative(cwd, paths.evidencePath),
            publication_path: relative(cwd, paths.publicationPath)
        }
    };
}

function publicationPaths(run) {
    const publishedDir = path.join(run.publishedRoot, run.manifest.run_id);
    return {
        publishedDir,
        pointerPath: path.join(run.publishedRoot, "current.json"),
        snapshotPath: path.join(publishedDir, "snapshot.json"),
        evidencePath: path.join(publishedDir, "evidence.jsonl"),
        publicationPath: path.join(publishedDir, "publication.json"),
        checkpointPath: run.checkpointPath,
        metricsPath: run.metricsPath
    };
}

function validateEvidence(records, manifest) {
    const errors = [];
    const ids = new Set();
    for (const [index, record] of records.entries()) {
        if (ids.has(record.evidence_id)) {
            errors.push(errorRecord("duplicate_evidence_id", `duplicate evidence_id ${record.evidence_id}`, `/evidence/${index}/evidence_id`));
            continue;
        }
        ids.add(record.evidence_id);
        const validation = validateEvidenceRecord(record, {manifest});
        appendValidationErrors(errors, `evidence/${index}`, validation.errors);
    }
    return {valid: errors.length === 0, errors};
}

function validateSnapshotResults(snapshot, evidence, manifest) {
    const errors = [];
    const evidenceIds = new Set(evidence.map((record) => record.evidence_id));
    for (const [index, entry] of snapshot.entries.entries()) {
        if (entry.result === null || entry.result === undefined) continue;
        if (entry.result.entry_id !== entry.entry_id || entry.result.institution_id !== entry.institution_id) {
            errors.push(errorRecord("snapshot_result_identity_mismatch", `result identity does not match ${entry.entry_id}`, `/entries/${index}/result`));
            continue;
        }
        if (entry.result.decision_status !== entry.decision_status) {
            errors.push(errorRecord("snapshot_result_status_mismatch", `result status does not match ${entry.decision_status}`, `/entries/${index}/result/decision_status`));
        }
        for (const id of resultEvidenceIds(entry.result)) {
            if (!evidenceIds.has(id)) {
                errors.push(errorRecord("snapshot_result_evidence_missing", `result references unpublished evidence ${id}`, `/entries/${index}/result/field_evidence`));
            }
        }
        const validation = validateInterpretationResult(entry.result, {manifest, evidenceRecords: evidence});
        appendValidationErrors(errors, `entries/${index}/result`, validation.errors);
    }
    return {valid: errors.length === 0, errors};
}

function resultEvidenceIds(result) {
    return [...new Set(Object.values(result.field_evidence ?? {}).flatMap((ids) => Array.isArray(ids) ? ids : []))];
}

function parseEvidence(buffer, errors) {
    if (!buffer) return null;
    const text = buffer.toString("utf8");
    if (text === "") return [];
    if (!text.endsWith("\n")) {
        errors.push(errorRecord("evidence_partial_record", "published evidence is not terminated by a complete record", "evidence"));
        return null;
    }
    return text.trimEnd().split("\n").map((line, index) => {
        try {
            return JSON.parse(line);
        } catch {
            errors.push(errorRecord("evidence_invalid_json", `evidence record ${index + 1} is invalid JSON`, `/evidence/${index}`));
            return null;
        }
    }).filter(Boolean);
}

function readBuffer(filePath, errors, label) {
    try {
        return fs.readFileSync(filePath);
    } catch (error) {
        errors.push(errorRecord("artifact_missing", `${label} cannot be read`, filePath, {message: error.message}));
        return null;
    }
}

function readJson(filePath, errors, label) {
    const buffer = readBuffer(filePath, errors, label);
    return parseBuffer(buffer, errors, label);
}

function parseBuffer(buffer, errors, label) {
    if (!buffer) return null;
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch (error) {
        errors.push(errorRecord("artifact_invalid_json", `${label} is not valid JSON`, label, {message: error.message}));
        return null;
    }
}

function appendValidationErrors(target, prefix, source = []) {
    for (const error of source) {
        target.push(errorRecord(error.code ?? "schema_violation", `${prefix}: ${error.message ?? "validation failed"}`, error.path ?? `/${prefix}`));
    }
}

function errorRecord(code, message, location = "/", details = undefined) {
    return {code, message, location, ...(details ? {details} : {})};
}

function failedAudit({cwd, errors}) {
    return {
        schema_version: "1.0.0",
        audit_version: "1.0.0",
        run_id: null,
        status: "failed",
        valid: false,
        read_only: true,
        errors,
        checks: {},
        paths: {cwd: relative(cwd, cwd)}
    };
}

function relative(cwd, filePath) {
    return path.relative(cwd, filePath).split(path.sep).join("/");
}
