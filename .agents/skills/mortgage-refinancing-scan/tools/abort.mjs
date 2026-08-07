#!/usr/bin/env node

import {abortRun, LifecycleError, loadRun} from "../lib/run-lifecycle.mjs";

const VALUE_OPTIONS = new Set(["run-manifest", "error-code", "reason", "operation-id", "fault-at"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const run = loadRun(args["run-manifest"]);
        const result = abortRun(run, {
            errorCode: args["error-code"] ?? "publication_io_failure",
            reason: args.reason ?? "run aborted",
            operationId: args["operation-id"],
            faultAt: args["fault-at"]
        });
        process.stdout.write(`${JSON.stringify({run_id: run.manifest.run_id, status: "ABORTED", result}, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatError(error))}\n`);
        process.exitCode = error instanceof LifecycleError ? error.exitCode : 20;
    }
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
    if (!result["run-manifest"]) {
        throw new LifecycleError("invalid_invocation", "--run-manifest is required", {exitCode: 2});
    }
    return result;
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
