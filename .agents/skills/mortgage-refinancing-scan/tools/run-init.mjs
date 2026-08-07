#!/usr/bin/env node

import {initializeRun, LifecycleError} from "../lib/run-lifecycle.mjs";

const VALUE_OPTIONS = new Set(["registry-snapshot", "mode", "run-root", "run-id", "live"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const result = initializeRun({
            registrySnapshotPath: args["registry-snapshot"],
            mode: args.mode,
            live: parseBoolean(args.live ?? "false", "--live"),
            runRoot: args["run-root"],
            runId: args["run-id"]
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    for (const required of ["registry-snapshot", "mode", "run-root"]) {
        if (!result[required]) {
            throw new LifecycleError("invalid_invocation", `--${required} is required`, {exitCode: 2});
        }
    }
    return result;
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
