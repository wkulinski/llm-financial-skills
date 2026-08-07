#!/usr/bin/env node

import {exportPublishedWorkbook} from "../lib/export-workbook.mjs";
import {formatCliError, parseArgs} from "../lib/research-runtime.mjs";

const VALUE_OPTIONS = new Set(["run-manifest", "out"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), VALUE_OPTIONS, ["run-manifest", "out"]);
        const result = exportPublishedWorkbook({
            runManifestPath: args["run-manifest"],
            outputPath: args.out
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error?.exitCode ?? 30;
    }
}
