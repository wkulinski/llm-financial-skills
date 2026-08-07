#!/usr/bin/env node

import {OriginScheduler} from "../lib/origin-scheduler.mjs";
import {
    LifecycleError,
    loadRun,
    replayRun,
    retryEntry,
    transitionRun,
    updateEntry
} from "../lib/run-lifecycle.mjs";

const VALUE_OPTIONS = new Set([
    "run-manifest",
    "action",
    "next-state",
    "entry-id",
    "stage",
    "decision-status",
    "error-code",
    "error-message",
    "operation-id",
    "input-artifact-ids",
    "output-artifact-ids",
    "retryable",
    "operations",
    "fault-at"
]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const run = loadRun(args["run-manifest"]);
        const result = await execute(run, args);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatError(error))}\n`);
        process.exitCode = error instanceof LifecycleError ? error.exitCode : 20;
    }
}

async function execute(run, args) {
    const action = args.action;
    if (action === "transition") {
        if (!args["next-state"]) {
            throw new LifecycleError("invalid_invocation", "transition requires --next-state", {exitCode: 2});
        }
        return resultEnvelope(run, transitionRun(run, args["next-state"], {
            operationId: args["operation-id"],
            faultAt: args["fault-at"]
        }));
    }
    if (action === "entry") {
        for (const option of ["entry-id", "stage"]) {
            if (!args[option]) {
                throw new LifecycleError("invalid_invocation", `entry action requires --${option}`, {exitCode: 2});
            }
        }
        return resultEnvelope(run, updateEntry(run, {
            entryId: args["entry-id"],
            stage: args.stage,
            operationId: args["operation-id"],
            decisionStatus: args["decision-status"],
            errorCode: args["error-code"],
            errorMessage: args["error-message"],
            retryable: parseBoolean(args.retryable ?? "false", "--retryable"),
            inputArtifactIds: parseList(args["input-artifact-ids"]),
            outputArtifactIds: parseList(args["output-artifact-ids"]),
            faultAt: args["fault-at"]
        }));
    }
    if (action === "retry") {
        if (!args["entry-id"]) {
            throw new LifecycleError("invalid_invocation", "retry action requires --entry-id", {exitCode: 2});
        }
        return resultEnvelope(run, retryEntry(run, {
            entryId: args["entry-id"],
            operationId: args["operation-id"],
            errorCode: args["error-code"],
            errorMessage: args["error-message"],
            faultAt: args["fault-at"]
        }));
    }
    if (action === "batch") {
        if (!args.operations) {
            throw new LifecycleError("invalid_invocation", "batch action requires --operations", {exitCode: 2});
        }
        return resultEnvelope(run, await applyBatch(run, args.operations));
    }
    if (action === "show") {
        return resultEnvelope(run, {projection: replayRun(run)});
    }
    throw new LifecycleError("invalid_invocation", `unknown --action ${action}`, {exitCode: 2});
}

async function applyBatch(run, operationsPath) {
    const operations = JSON.parse(await import("node:fs").then(({readFileSync}) => readFileSync(operationsPath, "utf8")));
    if (!Array.isArray(operations) || operations.length === 0) {
        throw new LifecycleError("invalid_invocation", "batch operations must be a non-empty JSON array", {exitCode: 2});
    }
    const scheduler = new OriginScheduler({
        maxActive: run.manifest.resource_policy.max_http_in_flight,
        maxActiveInstitutions: run.manifest.resource_policy.max_active_institutions,
        maxInFlightPerOrigin: run.manifest.resource_policy.max_in_flight_per_origin,
        maxInFlightPerInstitution: run.manifest.resource_policy.max_in_flight_per_institution,
        originDelayMs: run.manifest.resource_policy.origin_delay_ms,
        retryAfterCapMs: run.manifest.resource_policy.retry_after_cap_ms
    });
    const planned = await scheduler.run(operations, async (operation) => ({operation}));
    const applied = [];
    for (const {task} of planned.sort((left, right) => String(left.task.operation_id).localeCompare(String(right.task.operation_id)))) {
        const normalized = {
            entryId: task.entryId ?? task.entry_id,
            operationId: task.operationId ?? task.operation_id,
            stage: task.stage,
            decisionStatus: task.decisionStatus ?? task.decision_status,
            errorCode: task.errorCode ?? task.error_code,
            errorMessage: task.errorMessage ?? task.error_message,
            retryable: task.retryable,
            inputArtifactIds: task.inputArtifactIds ?? task.input_artifact_ids ?? [],
            outputArtifactIds: task.outputArtifactIds ?? task.output_artifact_ids ?? []
        };
        if (task.action === "retry") {
            applied.push(retryEntry(run, normalized));
        } else {
            applied.push(updateEntry(run, normalized));
        }
    }
    return {batch_count: applied.length, results: applied.map((item) => item.event)};
}

function resultEnvelope(run, result) {
    const projection = replayRun(run);
    return {
        run_id: run.manifest.run_id,
        status: projection.runState,
        event_count: projection.events.length,
        terminal_entry_count: [...projection.entries.values()].filter((entry) => ["interpreted", "technical_error"].includes(entry.stage)).length,
        result: normalizeResult(result)
    };
}

function normalizeResult(result) {
    if (!result || typeof result !== "object" || result.projection === undefined) {
        return result;
    }
    const projection = result.projection;
    return {
        ...result,
        projection: {
            run_state: projection.runState,
            last_event_sequence: projection.events.length,
            entries: [...projection.entries.values()].sort((left, right) => left.lp - right.lp)
        }
    };
}

function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) {
            throw new LifecycleError("invalid_invocation", `unexpected argument ${token}`, {exitCode: 2});
        }
        const name = token.slice(2);
        if (!VALUE_OPTIONS.has(name)) {
            throw new LifecycleError("invalid_invocation", `unknown option --${name}`, {exitCode: 2});
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new LifecycleError("invalid_invocation", `option --${name} requires a value`, {exitCode: 2});
        }
        if (Object.hasOwn(result, name)) {
            throw new LifecycleError("invalid_invocation", `option --${name} was provided twice`, {exitCode: 2});
        }
        result[name] = value;
        index += 1;
    }
    if (!result["run-manifest"] || !result.action) {
        throw new LifecycleError("invalid_invocation", "--run-manifest and --action are required", {exitCode: 2});
    }
    return result;
}

function parseList(value) {
    if (!value) return [];
    return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value, label) {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new LifecycleError("invalid_invocation", `${label} must be true or false`, {exitCode: 2});
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
