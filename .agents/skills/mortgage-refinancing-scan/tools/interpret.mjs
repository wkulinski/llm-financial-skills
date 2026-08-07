#!/usr/bin/env node

import path from "node:path";

import {artifactId, atomicWriteJson, formatCliError, loadResearchRun, parseArgs, readFixture, readEvidenceJsonl, readJson, recordResearchTelemetry, requireRunning, selectScopeEntries, updateEntryError} from "../lib/research-runtime.mjs";
import {readReviewContext, writeReviewContext} from "../lib/review-context.mjs";
import {createUnconfirmedResult, interpretReviewContext} from "../lib/interpretation.mjs";
import {validateInterpretationResult} from "../lib/run-contract-validate.mjs";
import {replayRun, updateEntry} from "../lib/run-lifecycle.mjs";

const VALUE_OPTIONS = new Set(["run-manifest", "fixture", "entry-id"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), VALUE_OPTIONS, ["run-manifest"]);
        const run = loadResearchRun(args["run-manifest"]);
        requireRunning(run, "interpret");
        const fixture = args.fixture ? readFixture(path.resolve(args.fixture), "interpretation fixture") : null;
        const evidenceRecords = readEvidenceJsonl(run.context.evidence_path);
        const selected = selectScopeEntries(run, args["entry-id"]);
        const results = [];
        for (const entry of selected) {
            const projection = replayRun(run);
            const state = projection.entries.get(entry.entry_id);
            if (state.stage === "technical_error") {
                results.push({entry_id: entry.entry_id, status: "technical_error", error_code: state.error_code});
                continue;
            }
            if (state.stage === "interpreted") {
                results.push(readExistingInterpretation(run, entry, evidenceRecords));
                continue;
            }
            if (state.stage !== "evidence_ready") {
                results.push({entry_id: entry.entry_id, status: "skipped", stage: state.stage});
                continue;
            }
            try {
                const fixtureEntry = fixture?.entries?.find((candidate) => candidate.entry_id === entry.entry_id);
                const context = readReviewContext({
                    run,
                    entryId: entry.entry_id,
                    evidenceRecords: evidenceRecords.filter((record) => record.entry_id === entry.entry_id),
                    fixtureEntry
                });
                writeReviewContext(run, context);
                const result = context.evidence.length === 0
                    ? createUnconfirmedResult(context)
                    : interpretReviewContext(context, {manifest: run.manifest});
                const validation = validateInterpretationResult(result, {
                    manifest: run.manifest,
                    evidenceRecords: context.evidence
                });
                if (!validation.valid) {
                    throw interpretationContractError(validation.errors);
                }
                const resultArtifactId = artifactId("int", {
                    entry_id: entry.entry_id,
                    result
                });
                const outputPath = path.join(run.runRoot, "artifacts", "interpretation", `${entry.entry_id}.json`);
                atomicWriteJson(outputPath, result);
                recordResearchTelemetry(run, {
                    operation_id: `interpret:${run.manifest.run_id}:${entry.entry_id}`,
                    stage: "interpreted",
                    entry_id: entry.entry_id,
                    institution_id: entry.institution_id,
                    duration_ms: 0,
                    attempts: state.attempt,
                    requests: zeroRequests(),
                    cache: zeroCache(),
                    bytes: zeroBytes(),
                    error_count: 0,
                    retryable_error_count: 0,
                    technical_error_count: 0,
                    fatal_error_count: 0,
                    error_code: null
                });
                updateEntry(run, {
                    entryId: entry.entry_id,
                    stage: "interpreted",
                    operationId: `interpret:${run.manifest.run_id}:${entry.entry_id}`,
                    decisionStatus: result.decision_status,
                    inputArtifactIds: context.evidence.map((record) => record.evidence_id),
                    outputArtifactIds: [resultArtifactId]
                });
                results.push({
                    entry_id: entry.entry_id,
                    status: "interpreted",
                    decision_status: result.decision_status,
                    artifact_id: resultArtifactId,
                    evidence_count: context.evidence.length,
                    output_path: path.relative(run.cwd, outputPath).split(path.sep).join("/")
                });
            } catch (error) {
                if (error?.code !== "evidence_mismatch") throw error;
                updateEntryError(
                    run,
                    entry.entry_id,
                    "evidence_mismatch",
                    error.message,
                    `interpret:evidence-mismatch:${run.manifest.run_id}:${entry.entry_id}`,
                    []
                );
                results.push({entry_id: entry.entry_id, status: "technical_error", error_code: "evidence_mismatch"});
            }
        }
        process.stdout.write(`${JSON.stringify({run_id: run.manifest.run_id, status: "completed", results}, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error?.exitCode ?? 20;
    }
}

function readExistingInterpretation(run, entry, evidenceRecords) {
    const filePath = path.join(run.runRoot, "artifacts", "interpretation", `${entry.entry_id}.json`);
    const result = readJson(filePath, `interpretation ${entry.entry_id}`);
    const validation = validateInterpretationResult(result, {
        manifest: run.manifest,
        evidenceRecords: evidenceRecords.filter((record) => record.entry_id === entry.entry_id)
    });
    if (!validation.valid) {
        throw interpretationContractError(validation.errors);
    }
    return {
        entry_id: entry.entry_id,
        status: "interpreted",
        decision_status: result.decision_status,
        idempotent: true,
        output_path: path.relative(run.cwd, filePath).split(path.sep).join("/")
    };
}

function interpretationContractError(errors) {
    const error = new Error("interpretation result failed strict validation");
    error.code = "schema_mismatch";
    error.exitCode = 10;
    error.details = {errors};
    return error;
}

function zeroRequests() {
    return {total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0};
}

function zeroCache() {
    return {misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0};
}

function zeroBytes() {
    return {downloaded: 0, reused_from_cache: 0};
}
