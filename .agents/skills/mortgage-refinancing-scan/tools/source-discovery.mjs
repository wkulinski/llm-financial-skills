#!/usr/bin/env node

import path from "node:path";

import {discoveryArtifactId, discoverEntry, validateDiscoveryFixture} from "../lib/source-discovery.mjs";
import {discoverLiveEntry} from "../lib/live-research.mjs";
import {
    formatCliError,
    loadResearchRun,
    makeTelemetryOperation,
    parseArgs,
    readFixture,
    readJson,
    recordResearchTelemetry,
    ResearchError,
    requireOffline,
    requireRunning,
    selectScopeEntries,
    updateEntryError,
    atomicWriteJson
} from "../lib/research-runtime.mjs";
import {updateEntry, replayRun} from "../lib/run-lifecycle.mjs";

const VALUE_OPTIONS = new Set(["run-manifest", "fixture", "entry-id", "max-requests"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), VALUE_OPTIONS, ["run-manifest"]);
        const run = loadResearchRun(args["run-manifest"]);
        requireRunning(run, "source-discovery");
        const fixture = run.manifest.live === false
            ? readFixture(path.resolve(requireValue(args, "fixture")), "discovery fixture")
            : null;
        if (run.manifest.live === true && args.fixture !== undefined) {
            throw new ResearchError("invalid_invocation", "live discovery does not accept --fixture", {exitCode: 2});
        }
        requireOfflineIfFixture(run, fixture);
        const registry = readJson(path.resolve(run.cwd, run.context.registry_snapshot_path), "run registry snapshot");
        const maxRequests = args["max-requests"] === undefined
            ? run.manifest.resource_policy.max_discovery_requests_per_institution
            : parsePositiveInteger(args["max-requests"], "--max-requests");
        const results = [];
        for (const scopeEntry of selectScopeEntries(run, args["entry-id"])) {
            const projection = replayRun(run);
            const state = projection.entries.get(scopeEntry.entry_id);
            if (["fetched", "normalized", "evidence_ready", "interpreted", "technical_error"].includes(state.stage)) {
                results.push({entry_id: scopeEntry.entry_id, status: "skipped", stage: state.stage});
                continue;
            }
            const registryEntry = registry.entries.find((entry) => entry.entry_id === scopeEntry.entry_id);
            try {
                if (!registryEntry) throw new ResearchError("schema_mismatch", `registry has no ${scopeEntry.entry_id}`, {exitCode: 10});
                const startedAt = Date.now();
                let discovery;
                if (run.manifest.live === true) {
                    discovery = await discoverLiveEntry({
                        run,
                        registryEntry,
                        maxRequests,
                        observationTime: new Date().toISOString(),
                        originDelayMs: run.manifest.resource_policy.origin_delay_ms
                    });
                } else {
                    const fixtureEntry = fixture.entries?.find((entry) => entry.entry_id === scopeEntry.entry_id);
                    validateDiscoveryFixture(fixtureEntry);
                    discovery = discoverEntry({
                        fixtureEntry,
                        registryEntry,
                        maxRequests,
                        observationTime: fixture.observed_at ?? run.manifest.created_at
                    });
                }
                discovery.run_id = run.manifest.run_id;
                const outputArtifactId = discoveryArtifactId(discovery);
                discovery.artifact_id = outputArtifactId;
                const outputPath = path.resolve(run.cwd, run.context.artifact_root, "discovery", `${scopeEntry.entry_id}.json`);
                atomicWriteJson(outputPath, discovery);
                const rejection = discovery.rejected.find((item) => item.required);
                const stageError = rejection && ["robots_denied", "official_host_violation", "discovery_limit"].includes(rejection.reason)
                    ? rejection
                    : discovery.candidates.length === 0 && discovery.outcome === "required_candidates_rejected"
                        ? {reason: "required_source_unavailable", message: "all required discovery candidates were rejected"}
                        : null;
                const operationId = `discovery:${run.manifest.run_id}:${scopeEntry.entry_id}`;
                if (stageError) {
                    updateEntryError(run, scopeEntry.entry_id, mapDiscoveryError(stageError.reason), stageError.message, operationId, [outputArtifactId]);
                } else {
                    updateEntry(run, {
                        entryId: scopeEntry.entry_id,
                        stage: "discovery",
                        operationId,
                        outputArtifactIds: [outputArtifactId]
                    });
                }
                const telemetry = makeTelemetryOperation({
                    operationId,
                    stage: "discovery",
                    entry: scopeEntry,
                    durationMs: run.manifest.live ? Math.max(0, Date.now() - startedAt) : 0,
                    requests: run.manifest.live
                        ? {total: discovery.stats.requests?.total ?? 0, robots: discovery.stats.requests?.robots ?? 0}
                        : {total: 1, robots: 1},
                    errorCount: stageError ? 1 : discovery.rejected.length,
                    technicalErrorCount: stageError ? 1 : 0,
                    errorCode: stageError ? mapDiscoveryError(stageError.reason) : null
                });
                recordResearchTelemetry(run, telemetry);
                results.push({entry_id: scopeEntry.entry_id, status: stageError ? "technical_error" : "discovered", artifact_id: outputArtifactId, candidates: discovery.candidates.length});
            } catch (error) {
                if (!isEntryError(error)) throw error;
                updateEntryError(run, scopeEntry.entry_id, error.code, error.message, `discovery:${run.manifest.run_id}:${scopeEntry.entry_id}`, []);
                recordResearchTelemetry(run, makeTelemetryOperation({
                    operationId: `discovery:${run.manifest.run_id}:${scopeEntry.entry_id}`,
                    stage: "discovery",
                    entry: scopeEntry,
                    requests: {total: 1, robots: 1},
                    errorCount: 1,
                    technicalErrorCount: 1,
                    errorCode: error.code
                }));
                results.push({entry_id: scopeEntry.entry_id, status: "technical_error", error_code: error.code});
            }
        }
        process.stdout.write(`${JSON.stringify({run_id: run.manifest.run_id, status: "completed", results}, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error?.exitCode ?? 20;
    }
}

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new ResearchError("invalid_invocation", `${label} must be a positive integer`, {exitCode: 2});
    return parsed;
}

function mapDiscoveryError(reason) {
    if (reason === "robots_denied") return "robots_denied";
    if (reason === "official_host_violation") return "official_host_violation";
    return "required_source_unavailable";
}

function isEntryError(error) {
    return ["required_source_unavailable", "request_timeout_after_retries", "robots_denied", "official_host_violation", "evidence_mismatch"].includes(error?.code);
}

function requireValue(args, name) {
    if (!args[name]) throw new ResearchError("invalid_invocation", `${name} is required for offline discovery`, {exitCode: 2});
    return args[name];
}

function requireOfflineIfFixture(run, fixture) {
    if (fixture !== null) requireOffline(run, "source-discovery");
}
