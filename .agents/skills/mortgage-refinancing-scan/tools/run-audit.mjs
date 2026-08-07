#!/usr/bin/env node

import {auditPublication} from "../lib/publication-audit.mjs";
import {formatCliError, parseArgs} from "../lib/research-runtime.mjs";

const VALUE_OPTIONS = new Set(["run-manifest"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), VALUE_OPTIONS, ["run-manifest"]);
        const report = auditPublication({runManifestPath: args["run-manifest"]});
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (!report.valid) process.exitCode = 30;
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error?.exitCode ?? 30;
    }
}
