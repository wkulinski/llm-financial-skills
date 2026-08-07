#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

import {preflightMorfeusz} from "../lib/normalization.mjs";
import {loadRun, replayRun} from "../lib/run-lifecycle.mjs";
import {atomicWriteJson, readFixture, ResearchError} from "../lib/research-runtime.mjs";
import {runBoundedPipeline, pipelineStages} from "../lib/pipeline.mjs";
import {buildFullReport} from "../lib/full-report.mjs";
import {auditPublication} from "../lib/publication-audit.mjs";
import {exportPublishedWorkbook} from "../lib/export-workbook.mjs";

const execFileAsync = promisify(execFile);
const VALUE_OPTIONS = new Set([
    "registry-snapshot",
    "run-root",
    "mode",
    "live",
    "run-id",
    "fixture",
    "engine",
    "python-command",
    "morfeusz-worker",
    "cache-root",
    "fault-at",
    "export-workbook"
]);
if (import.meta.url === `file://${process.argv[1]}`) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`${JSON.stringify(formatError(error))}\n`);
        process.exitCode = error?.exitCode ?? 20;
    });
}

export async function runControlledScan({
    cwd = process.cwd(),
    registrySnapshot,
    runRoot,
    mode = "full",
    live = false,
    runId = undefined,
    fixture = undefined,
    engine = undefined,
    pythonCommand = undefined,
    morfeuszWorker = undefined,
    cacheRoot = undefined,
    faultAt = undefined,
    exportWorkbook = undefined,
    executeTool = executeToolProcess
}) {
    if (mode !== "full") throw runnerError("invalid_invocation", "--mode must be full", 2);
    if (typeof live !== "boolean") throw runnerError("invalid_invocation", "--live must be true or false", 2);
    if (!registrySnapshot || !runRoot) throw runnerError("invalid_invocation", "registry snapshot and run root are required", 2);
    if (live && fixture !== undefined) throw runnerError("invalid_invocation", "live mode does not accept --fixture", 2);
    if (!live && !fixture) throw runnerError("invalid_invocation", "offline mode requires --fixture", 2);
    if (live && engine === "fixture") throw runnerError("invalid_invocation", "live mode requires Morfeusz 2", 2);

    const previousTransportCacheRoot = process.env.MORTGAGE_REFINANCING_SCAN_TRANSPORT_CACHE_ROOT;
    const previousNormalizationCacheRoot = process.env.MORTGAGE_REFINANCING_SCAN_NORMALIZATION_CACHE_ROOT;
    if (cacheRoot) {
        process.env.MORTGAGE_REFINANCING_SCAN_TRANSPORT_CACHE_ROOT = `${cacheRoot}/http`;
        process.env.MORTGAGE_REFINANCING_SCAN_NORMALIZATION_CACHE_ROOT = `${cacheRoot}/normalized`;
    }
    let manifestPath;
    let preflight;
    try {
        if (live) {
            preflight = await preflightMorfeusz({
                engine: "morfeusz2",
                workerPath: morfeuszWorker,
                pythonCommand: pythonCommand ?? "python3"
            });
            process.env.MORFEUSZ_VERSION = preflight.version;
        }
        const init = await executeTool("run-init.mjs", [
            "--registry-snapshot", registrySnapshot,
            "--mode", mode,
            "--live", String(live),
            "--run-root", runRoot,
            ...(runId ? ["--run-id", runId] : [])
        ], {cwd});
        manifestPath = path.resolve(cwd, init.manifest_path);
        await executeTool("run-state.mjs", [
            "--run-manifest", manifestPath,
            "--action", "transition",
            "--next-state", "RUNNING"
        ], {cwd});

        const run = loadRun(manifestPath, cwd);
        const fixtureValue = live ? null : readFixture(path.resolve(cwd, fixture), "runner fixture");
        const registry = JSON.parse(fs.readFileSync(path.resolve(cwd, run.context.registry_snapshot_path), "utf8"));
        const tasks = buildPipelineTasks({run, registry, fixture: fixtureValue});
        const pipeline = await runBoundedPipeline({
            runId: run.manifest.run_id,
            tasks,
            stages: pipelineStages(),
            resourcePolicy: run.manifest.resource_policy,
            worker: (stage, task) => executePipelineStage({
                stage,
                task,
                manifestPath,
                fixturePath: live ? undefined : path.resolve(cwd, fixture),
                live,
                engine,
                pythonCommand,
                morfeuszWorker,
                executeTool,
                cwd
            })
        });
        atomicWriteJson(path.join(run.runRoot, "pipeline-telemetry.json"), pipeline.telemetry);
        const fatal = pipeline.results.find((result) => result.fatal_error);
        if (fatal) {
            throw runnerError(
                fatal.fatal_error.code ?? "publication_io_failure",
                `bounded pipeline failed for ${fatal.entry_id}: ${fatal.fatal_error.message}`
            );
        }
        await executeTool("run-state.mjs", [
            "--run-manifest", manifestPath,
            "--action", "transition",
            "--next-state", "READY"
        ], {cwd});
        const finalized = await executeTool("finalize.mjs", [
            "--run-manifest", manifestPath,
            ...(faultAt ? ["--fault-at", faultAt] : [])
        ], {cwd});
        return buildReport({cwd, manifestPath, status: "FINALIZED", finalized, preflight, live, exportWorkbook});
    } catch (error) {
        if (!manifestPath) throw error;
        const run = loadRun(manifestPath, cwd);
        const projection = replayRun(run);
        if (projection.runState === "FINALIZED") {
            return buildReport({cwd, manifestPath, status: "FINALIZED", preflight, live, exportWorkbook});
        }
        if (!["FINALIZED", "ABORTED"].includes(projection.runState)) {
            try {
                await executeTool("abort.mjs", [
                    "--run-manifest", manifestPath,
                    "--error-code", mapAbortCode(error?.code),
                    "--reason", `runner failure: ${truncate(error?.message ?? String(error))}`
                ], {cwd});
            } catch (abortError) {
                error.abortError = abortError;
                if (publicationPointerReferencesRun(run)) {
                    try {
                        const recovered = await executeTool("finalize.mjs", ["--run-manifest", manifestPath], {cwd});
                        return buildReport({cwd, manifestPath, status: "FINALIZED", finalized: recovered, preflight, live, exportWorkbook});
                    } catch (recoveryError) {
                        error.recoveryError = recoveryError;
                    }
                }
            }
        }
        return buildReport({cwd, manifestPath, status: "ABORTED", abortError: error, preflight, live, exportWorkbook});
    } finally {
        restoreEnv("MORTGAGE_REFINANCING_SCAN_TRANSPORT_CACHE_ROOT", previousTransportCacheRoot);
        restoreEnv("MORTGAGE_REFINANCING_SCAN_NORMALIZATION_CACHE_ROOT", previousNormalizationCacheRoot);
    }
}

async function main(argv) {
    const args = parseArgs(argv);
    const report = await runControlledScan({
        registrySnapshot: args["registry-snapshot"],
        runRoot: args["run-root"],
        mode: args.mode,
        live: parseBoolean(args.live ?? "false", "--live"),
        runId: args["run-id"],
        fixture: args.fixture,
        engine: args.engine,
        pythonCommand: args["python-command"],
        morfeuszWorker: args["morfeusz-worker"],
        cacheRoot: args["cache-root"],
        faultAt: args["fault-at"],
        exportWorkbook: args["export-workbook"]
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status === "ABORTED" && report.fatal_error) process.exitCode = 20;
}

async function executeToolProcess(tool, args, {cwd}) {
    const toolPath = path.resolve(cwd, ".agents/skills/mortgage-refinancing-scan/tools", tool);
    try {
        const {stdout} = await execFileAsync(process.execPath, [toolPath, ...args], {
            cwd,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024
        });
        return stdout.trim() ? JSON.parse(stdout) : {};
    } catch (error) {
        const parsed = parseJson(error.stderr);
        const details = parsed?.error ?? {message: error.message};
        const wrapped = runnerError(details.code ?? "tool_failed", details.message ?? `tool ${tool} failed`, exitCodeForTool(tool));
        wrapped.details = {...(details.details ?? {}), tool, status: error.status ?? null};
        throw wrapped;
    }
}

function buildReport({cwd, manifestPath, status, finalized = undefined, abortError = undefined, preflight = undefined, live, exportWorkbook = undefined}) {
    const run = loadRun(manifestPath, cwd);
    const projection = replayRun(run);
    const checkpoint = readOptionalJson(run.checkpointPath);
    const coreTelemetry = readOptionalJson(run.metricsPath);
    const researchTelemetry = readOptionalJson(path.join(run.runRoot, "research-telemetry.json"));
    const pipelineTelemetry = readOptionalJson(path.join(run.runRoot, "pipeline-telemetry.json"));
    const audit = status === "FINALIZED" ? auditPublication({runManifestPath: manifestPath, cwd}) : null;
    const snapshot = audit?.valid && audit.paths?.snapshot_path
        ? readOptionalJson(path.resolve(cwd, audit.paths.snapshot_path))
        : null;
    let exportResult = null;
    let exportError = null;
    if (status === "FINALIZED" && exportWorkbook) {
        try {
            exportResult = exportPublishedWorkbook({runManifestPath: manifestPath, outputPath: exportWorkbook, cwd});
        } catch (error) {
            exportError = {code: error?.code ?? "publication_io_failure", message: truncate(error?.message ?? String(error))};
        }
    }
    const fullReport = buildFullReport({
        run,
        projection,
        checkpoint,
        telemetry: coreTelemetry,
        pipelineTelemetry,
        snapshot,
        publication: audit?.valid ? {
            status: "published",
            pointer_path: audit.paths.pointer_path,
            snapshot_path: audit.paths.snapshot_path
        } : null,
        audit,
        cwd
    });
    const evidencePath = path.join(run.runRoot, "evidence.jsonl");
    const evidenceCount = fs.existsSync(evidencePath)
        ? fs.readFileSync(evidencePath, "utf8").split(/\r?\n/u).filter(Boolean).length
        : 0;
    const entryStatuses = [...projection.entries.values()]
        .sort((left, right) => left.lp - right.lp)
        .map((entry) => ({
            entry_id: entry.entry_id,
            lp: entry.lp,
            institution_id: entry.institution_id,
            stage: entry.stage,
            decision_status: entry.decision_status,
            entry_outcome: entry.entry_outcome,
            error_code: entry.error_code,
            elapsed_ms: entry.elapsed_ms
        }));
    const report = {
        ...fullReport,
        mode: live ? "live" : "test",
        status,
        manifest_path: relative(cwd, run.manifestPath),
        run_root: relative(cwd, run.runRoot),
        checkpoint_path: fs.existsSync(run.checkpointPath) ? relative(cwd, run.checkpointPath) : null,
        telemetry_path: fs.existsSync(run.metricsPath) ? relative(cwd, run.metricsPath) : null,
        research_telemetry_path: fs.existsSync(path.join(run.runRoot, "research-telemetry.json"))
            ? relative(cwd, path.join(run.runRoot, "research-telemetry.json"))
            : null,
        pipeline_telemetry_path: fs.existsSync(path.join(run.runRoot, "pipeline-telemetry.json"))
            ? relative(cwd, path.join(run.runRoot, "pipeline-telemetry.json"))
            : null,
        full_report_path: relative(cwd, path.join(run.runRoot, "full-report.json")),
        publication_pointer: audit?.valid ? audit.paths.pointer_path : null,
        publication_record: finalized?.publication ?? null,
        publication_summary: fullReport.publication,
        audit,
        export: exportResult,
        export_error: exportError,
        abort_reason: abortError ? truncate(abortError.message ?? String(abortError)) : null,
        fatal_error: Boolean(abortError && !isEntryError(abortError.code)),
        preflight: preflight ?? null,
        checkpoint,
        telemetry: coreTelemetry,
        research_telemetry: researchTelemetry,
        evidence_count: evidenceCount,
        entry_statuses: entryStatuses,
        terminal_entry_count: entryStatuses.filter((entry) => ["interpreted", "technical_error"].includes(entry.stage)).length
    };
    // Keep the Phase 5 publication field as the pointer returned by finalize;
    // Phase 6 consumers should use publication_summary/audit for diagnostics.
    report.publication = finalized?.publication ?? null;
    if (status === "ABORTED" && abortError?.abortError) {
        report.abort_error = truncate(abortError.abortError.message ?? String(abortError.abortError));
    }
    try {
        atomicWriteJson(path.join(run.runRoot, "full-report.json"), report);
    } catch (error) {
        report.report_write_error = {code: error?.code ?? "publication_io_failure", message: truncate(error?.message ?? String(error))};
    }
    return report;
}

function buildPipelineTasks({run, registry, fixture}) {
    const fixtureByEntry = new Map((fixture?.entries ?? []).map((entry) => [entry.entry_id, entry]));
    return run.manifest.scope.entries.map((entry) => {
        const registryEntry = registry.entries.find((candidate) => candidate.entry_id === entry.entry_id);
        const fixtureEntry = fixtureByEntry.get(entry.entry_id);
        return {
            entry_id: entry.entry_id,
            lp: entry.lp,
            institution_id: entry.institution_id,
            origin: fixtureEntry?.origin ?? registryEntry?.official_hosts?.[0] ?? "unknown"
        };
    }).sort((left, right) => left.lp - right.lp);
}

async function executePipelineStage({
    stage,
    task,
    manifestPath,
    fixturePath,
    live,
    engine,
    pythonCommand,
    morfeuszWorker,
    executeTool,
    cwd
}) {
    const shared = ["--run-manifest", manifestPath, "--entry-id", task.entry_id];
    const fixtureArgs = live ? [] : ["--fixture", fixturePath];
    const args = stage === "discovery"
        ? [...shared, ...fixtureArgs]
        : stage === "fetched"
            ? [...shared, ...fixtureArgs]
            : stage === "normalized"
                ? [
                    ...shared,
                    ...fixtureArgs,
                    ...(live
                        ? ["--python-command", pythonCommand ?? "python3", ...(morfeuszWorker ? ["--morfeusz-worker", morfeuszWorker] : [])]
                        : ["--engine", engine ?? "fixture"])
                ]
                : stage === "evidence_ready"
                    ? [...shared, ...fixtureArgs]
                    : [...shared, ...(live ? [] : fixtureArgs)];
    const tool = {
        discovery: "source-discovery.mjs",
        fetched: "source-fetch.mjs",
        normalized: "normalize.mjs",
        evidence_ready: "evidence.mjs",
        interpreted: "interpret.mjs"
    }[stage];
    try {
        const output = await executeTool(tool, args, {cwd});
        const result = output?.results?.find((candidate) => candidate.entry_id === task.entry_id);
        if (!result) {
            return {
                status: "fatal_error",
                fatal_error: {code: "schema_mismatch", message: `${tool} returned no result for ${task.entry_id}`}
            };
        }
        if (result.status === "technical_error") {
            return {status: "technical_error", terminal: true, error_code: result.error_code ?? null};
        }
        if (result.status === "skipped") {
            return {
                status: "fatal_error",
                fatal_error: {code: "schema_mismatch", message: `${tool} skipped ${task.entry_id} in a fresh pipeline`}
            };
        }
        return {status: result.status ?? "completed"};
    } catch (error) {
        return {
            status: "fatal_error",
            fatal_error: {
                code: error?.code ?? "publication_io_failure",
                message: truncate(error?.message ?? String(error))
            }
        };
    }
}

function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) throw runnerError("invalid_invocation", `unexpected argument ${token}`, 2);
        const name = token.slice(2);
        if (!VALUE_OPTIONS.has(name)) throw runnerError("invalid_invocation", `unknown option --${name}`, 2);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw runnerError("invalid_invocation", `option --${name} requires a value`, 2);
        if (Object.hasOwn(result, name)) throw runnerError("invalid_invocation", `option --${name} was provided twice`, 2);
        result[name] = value;
        index += 1;
    }
    for (const name of ["registry-snapshot", "run-root", "mode"]) {
        if (!result[name]) throw runnerError("invalid_invocation", `--${name} is required`, 2);
    }
    return result;
}

function parseBoolean(value, label) {
    if (value === "true") return true;
    if (value === "false") return false;
    throw runnerError("invalid_invocation", `${label} must be true or false`, 2);
}

function readOptionalJson(filePath) {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function publicationPointerReferencesRun(run) {
    return readOptionalJson(path.join(run.publishedRoot, "current.json"))?.run_id === run.manifest.run_id;
}

function parseJson(value) {
    if (typeof value !== "string" || value.trim() === "") return null;
    try { return JSON.parse(value); } catch { return null; }
}

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function relative(cwd, filePath) {
    return path.relative(cwd, filePath).split(path.sep).join("/");
}

function runnerError(code, message, exitCode = 20) {
    const error = new ResearchError(code, message, {exitCode});
    error.exitCode = exitCode;
    return error;
}

function formatError(error) {
    return {
        error: {
            code: error?.code ?? "fatal_run_error",
            message: error?.message ?? String(error),
            ...(error?.details === undefined ? {} : {details: error.details})
        }
    };
}

function mapAbortCode(code) {
    if (["dependency_missing", "schema_mismatch", "publication_io_failure"].includes(code)) return code;
    return "publication_io_failure";
}

function exitCodeForTool(tool) {
    if (tool === "finalize.mjs") return 30;
    if (["run-init.mjs", "run-state.mjs", "source-discovery.mjs", "source-fetch.mjs", "normalize.mjs", "evidence.mjs", "interpret.mjs"].includes(tool)) return 20;
    return 20;
}

function isEntryError(code) {
    return ["required_source_unavailable", "request_timeout_after_retries", "robots_denied", "official_host_violation", "evidence_mismatch"].includes(code);
}

function truncate(value) {
    return String(value).slice(0, 2048);
}
