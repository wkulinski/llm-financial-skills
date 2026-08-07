#!/usr/bin/env node

import path from "node:path";

import {OriginScheduler} from "../lib/origin-scheduler.mjs";
import {fetchEntrySources} from "../lib/source-fetch.mjs";
import {fetchLiveEntrySources} from "../lib/live-research.mjs";
import {
    atomicWriteJson,
    formatCliError,
    loadResearchRun,
    makeTelemetryOperation,
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
        requireRunning(run, "source-fetch");
        const fixture = run.manifest.live === false
            ? readFixture(path.resolve(requireValue(args, "fixture")), "fetch fixture")
            : null;
        if (run.manifest.live === true && args.fixture !== undefined) {
            throw new ResearchError("invalid_invocation", "live fetch does not accept --fixture", {exitCode: 2});
        }
        if (fixture !== null) requireOffline(run, "source-fetch");
        const registry = readJson(path.resolve(run.cwd, run.context.registry_snapshot_path), "run registry snapshot");
        const discoveryRoot = path.resolve(run.cwd, run.context.artifact_root, "discovery");
        const selected = selectScopeEntries(run, args["entry-id"]);
        const projection = replayRun(run);
        const tasks = selected.filter((entry) => projection.entries.get(entry.entry_id).stage === "discovery").map((entry) => {
            const registryEntry = registry.entries.find((candidate) => candidate.entry_id === entry.entry_id);
            return {
                entry,
                registryEntry,
                fixtureEntry: fixture?.entries?.find((candidate) => candidate.entry_id === entry.entry_id),
                origin: fixture?.entries?.find((candidate) => candidate.entry_id === entry.entry_id)?.origin ?? registryEntry?.official_hosts?.[0] ?? "unknown",
                institution_id: entry.institution_id,
                operation_id: `fetch:${run.manifest.run_id}:${entry.entry_id}`
            };
        });
        const scheduler = new OriginScheduler({
            maxActive: run.manifest.resource_policy.max_http_in_flight,
            maxActiveInstitutions: run.manifest.resource_policy.max_active_institutions,
            maxInFlightPerOrigin: run.manifest.resource_policy.max_in_flight_per_origin,
            maxInFlightPerInstitution: run.manifest.resource_policy.max_in_flight_per_institution,
            originDelayMs: run.manifest.resource_policy.origin_delay_ms,
            retryAfterCapMs: run.manifest.resource_policy.retry_after_cap_ms
        });
        const scheduled = await scheduler.run(tasks, async (task) => {
            try {
                const discovery = readJson(path.join(discoveryRoot, `${task.entry.entry_id}.json`), `discovery ${task.entry.entry_id}`);
                const result = run.manifest.live === true
                    ? await fetchLiveEntrySources({
                        run,
                        entry: task.entry,
                        registryEntry: task.registryEntry,
                        discovery,
                        observationTime: new Date().toISOString(),
                        originDelayMs: run.manifest.resource_policy.origin_delay_ms
                    })
                    : await fetchEntrySources({
                        run,
                        fixtureEntry: task.fixtureEntry,
                        registryEntry: task.registryEntry,
                        discovery,
                        observationTime: fixture.observed_at ?? run.manifest.created_at
                    });
                return {...result, task};
            } catch (error) {
                if (!isEntryError(error)) throw error;
                return {task, technicalError: {code: error.code, message: error.message}, metrics: makeTelemetryOperation({
                    operationId: task.operation_id,
                    stage: "fetched",
                    entry: task.entry,
                    errorCount: 1,
                    technicalErrorCount: 1,
                    errorCode: error.code
                }), retryAfterMs: 0};
            }
        });
        const results = [];
        for (const scheduledResult of scheduled.sort((left, right) => left.task.entry.lp - right.task.entry.lp)) {
            const task = scheduledResult.task;
            const result = scheduledResult.result;
            if (result.summary) {
                const outputPath = path.resolve(run.cwd, run.context.artifact_root, "fetch", `${task.entry.entry_id}.json`);
                atomicWriteJson(outputPath, result.summary);
                recordResearchTelemetry(run, result.metrics);
                if (result.technicalError) {
                    updateEntryError(run, task.entry.entry_id, result.technicalError.code, result.technicalError.message, task.operation_id, [result.artifactId]);
                    results.push({entry_id: task.entry.entry_id, status: "technical_error", artifact_id: result.artifactId, error_code: result.technicalError.code});
                } else {
                    const outputIds = [result.artifactId, ...result.artifacts.map((artifact) => artifact.artifact_id)];
                    updateEntry(run, {
                        entryId: task.entry.entry_id,
                        stage: "fetched",
                        operationId: task.operation_id,
                        inputArtifactIds: [result.summary.discovery_artifact_id],
                        outputArtifactIds: outputIds
                    });
                    results.push({entry_id: task.entry.entry_id, status: "fetched", artifact_id: result.artifactId, source_count: result.artifacts.length});
                }
            } else {
                recordResearchTelemetry(run, result.metrics);
                updateEntryError(run, task.entry.entry_id, result.technicalError.code, result.technicalError.message, task.operation_id, []);
                results.push({entry_id: task.entry.entry_id, status: "technical_error", error_code: result.technicalError.code});
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
    if (!args[name]) throw new ResearchError("invalid_invocation", `${name} is required for offline fetch`, {exitCode: 2});
    return args[name];
}
