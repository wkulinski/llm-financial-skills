#!/usr/bin/env node

import path from "node:path";

import {buildEvidenceForEntry, buildEvidenceForLiveEntry} from "../lib/evidence.mjs";
import {
    atomicWriteJson,
    formatCliError,
    loadResearchRun,
    parseArgs,
    readFixture,
    readJson,
    recordResearchTelemetry,
    requireOffline,
    requireRunning,
    ResearchError,
    replayRun,
    selectScopeEntries,
    updateEntryError
} from "../lib/research-runtime.mjs";
import {updateEntry} from "../lib/run-lifecycle.mjs";

const VALUE_OPTIONS = new Set(["run-manifest", "fixture", "entry-id"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), VALUE_OPTIONS, ["run-manifest"]);
        const run = loadResearchRun(args["run-manifest"]);
        requireRunning(run, "evidence");
        const fixture = run.manifest.live === false
            ? readFixture(path.resolve(requireValue(args, "fixture")), "evidence fixture")
            : null;
        if (run.manifest.live === true && args.fixture !== undefined) {
            throw new ResearchError("invalid_invocation", "live evidence does not accept --fixture", {exitCode: 2});
        }
        if (fixture !== null) requireOffline(run, "evidence");
        const selected = selectScopeEntries(run, args["entry-id"]);
        const projection = replayRun(run);
        const results = [];
        for (const entry of selected) {
            const state = projection.entries.get(entry.entry_id);
            if (state.stage !== "normalized") {
                results.push({entry_id: entry.entry_id, status: "skipped", stage: state.stage});
                continue;
            }
            try {
                const fixtureEntry = fixture?.entries?.find((candidate) => candidate.entry_id === entry.entry_id) ?? entry;
                const fetchSummary = readJson(path.resolve(run.cwd, run.context.artifact_root, "fetch", `${entry.entry_id}.json`), `fetch ${entry.entry_id}`);
                const normalizationSummary = readJson(path.resolve(run.cwd, run.context.artifact_root, "normalization", `${entry.entry_id}.json`), `normalization ${entry.entry_id}`);
                const result = run.manifest.live === true
                    ? buildEvidenceForLiveEntry({
                        run,
                        entry,
                        fetchSummary,
                        normalizationSummary,
                        observationTime: new Date().toISOString()
                    })
                    : buildEvidenceForEntry({
                        run,
                        fixtureEntry,
                        fetchSummary,
                        normalizationSummary,
                        observationTime: fixture.observed_at ?? run.manifest.created_at
                    });
                atomicWriteJson(path.resolve(run.cwd, run.context.artifact_root, "evidence", `${entry.entry_id}.json`), result.summary);
                recordResearchTelemetry(run, result.metrics);
                if (result.failures.length > 0) {
                    updateEntryError(run, entry.entry_id, "evidence_mismatch", result.failures[0].message, `evidence:${run.manifest.run_id}:${entry.entry_id}`, [result.artifactId]);
                    results.push({entry_id: entry.entry_id, status: "technical_error", artifact_id: result.artifactId, error_code: "evidence_mismatch"});
                } else {
                    updateEntry(run, {
                        entryId: entry.entry_id,
                        stage: "evidence_ready",
                        operationId: `evidence:${run.manifest.run_id}:${entry.entry_id}`,
                        inputArtifactIds: normalizationSummary.artifacts.map((artifact) => artifact.artifact_id),
                        outputArtifactIds: [result.artifactId, ...result.records.map((record) => record.evidence_id)]
                    });
                    results.push({entry_id: entry.entry_id, status: "evidence_ready", artifact_id: result.artifactId, evidence_count: result.records.length});
                }
            } catch (error) {
                if (!isEntryError(error)) throw error;
                updateEntryError(run, entry.entry_id, error.code, error.message, `evidence:${run.manifest.run_id}:${entry.entry_id}`, []);
                results.push({entry_id: entry.entry_id, status: "technical_error", error_code: error.code});
            }
        }
        process.stdout.write(`${JSON.stringify({run_id: run.manifest.run_id, status: "completed", results}, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error?.exitCode ?? 20;
    }
}

function isEntryError(error) {
    return ["required_source_unavailable", "request_timeout_after_retries", "robots_denied", "official_host_violation", "evidence_mismatch"].includes(error?.code);
}

function requireValue(args, name) {
    if (!args[name]) throw new ResearchError("invalid_invocation", `${name} is required for offline evidence`, {exitCode: 2});
    return args[name];
}
