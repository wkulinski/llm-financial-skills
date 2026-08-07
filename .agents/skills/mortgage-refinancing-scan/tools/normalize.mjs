#!/usr/bin/env node

import path from "node:path";

import {normalizeEntrySources} from "../lib/normalization.mjs";
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

const VALUE_OPTIONS = new Set(["run-manifest", "fixture", "entry-id", "engine", "morfeusz-worker", "python-command"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), VALUE_OPTIONS, ["run-manifest"]);
        const run = loadResearchRun(args["run-manifest"]);
        requireRunning(run, "normalize");
        const fixture = run.manifest.live === false
            ? readFixture(path.resolve(requireValue(args, "fixture")), "normalization fixture")
            : null;
        if (run.manifest.live === true && args.fixture !== undefined) {
            throw new ResearchError("invalid_invocation", "live normalization does not accept --fixture", {exitCode: 2});
        }
        if (fixture !== null) requireOffline(run, "normalize");
        const selected = selectScopeEntries(run, args["entry-id"]);
        const projection = replayRun(run);
        const results = [];
        for (const entry of selected) {
            const state = projection.entries.get(entry.entry_id);
            if (state.stage !== "fetched") {
                results.push({entry_id: entry.entry_id, status: "skipped", stage: state.stage});
                continue;
            }
            try {
                const fixtureEntry = fixture?.entries?.find((candidate) => candidate.entry_id === entry.entry_id) ?? entry;
                const fetchSummary = readJson(path.resolve(run.cwd, run.context.artifact_root, "fetch", `${entry.entry_id}.json`), `fetch ${entry.entry_id}`);
                const result = await normalizeEntrySources({
                    run,
                    fixtureEntry,
                    fetchSummary,
                    observationTime: fixture?.observed_at ?? new Date().toISOString(),
                    engine: args.engine ?? "morfeusz2",
                    workerPath: args["morfeusz-worker"],
                    pythonCommand: args["python-command"] ?? "python3"
                });
                atomicWriteJson(path.resolve(run.cwd, run.context.artifact_root, "normalization", `${entry.entry_id}.json`), result.summary);
                recordResearchTelemetry(run, result.metrics);
                updateEntry(run, {
                    entryId: entry.entry_id,
                    stage: "normalized",
                    operationId: `normalize:${run.manifest.run_id}:${entry.entry_id}`,
                    inputArtifactIds: fetchSummary.source_artifacts.map((artifact) => artifact.artifact_id),
                    outputArtifactIds: [result.artifactId, ...result.artifacts.map((artifact) => artifact.artifact_id)]
                });
                results.push({entry_id: entry.entry_id, status: "normalized", artifact_id: result.artifactId, source_count: result.artifacts.length});
            } catch (error) {
                if (!isEntryError(error)) throw error;
                updateEntryError(run, entry.entry_id, error.code, error.message, `normalize:${run.manifest.run_id}:${entry.entry_id}`, []);
                recordResearchTelemetry(run, {
                    operation_id: `normalize:${run.manifest.run_id}:${entry.entry_id}`,
                    stage: "normalized",
                    entry_id: entry.entry_id,
                    institution_id: entry.institution_id,
                    duration_ms: 0,
                    attempts: 1,
                    requests: {total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0},
                    cache: {misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0},
                    bytes: {downloaded: 0, reused_from_cache: 0},
                    error_count: 1,
                    retryable_error_count: 0,
                    technical_error_count: 1,
                    fatal_error_count: 0,
                    error_code: error.code
                });
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
    if (!args[name]) throw new ResearchError("invalid_invocation", `${name} is required for offline normalization`, {exitCode: 2});
    return args[name];
}
