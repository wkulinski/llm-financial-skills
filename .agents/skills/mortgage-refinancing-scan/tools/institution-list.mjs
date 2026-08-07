#!/usr/bin/env node

import path from "node:path";

import {auditRunRegistry} from "../lib/institution-list.mjs";
import {
    formatCliError,
    loadResearchRun,
    parseArgs,
    readJson,
    ResearchError,
    requireOffline
} from "../lib/research-runtime.mjs";

const VALUE_OPTIONS = new Set(["run-manifest", "bfg", "knf"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), VALUE_OPTIONS, ["run-manifest", "bfg", "knf"]);
        const run = loadResearchRun(args["run-manifest"]);
        requireOffline(run, "institution-list");
        const outputPath = path.resolve(run.cwd, run.context.artifact_root, "institution-list", "registry-validation.json");
        const result = auditRunRegistry(run, {
            bfg: readJson(path.resolve(args.bfg), "BFG fixture"),
            knf: readJson(path.resolve(args.knf), "KNF fixture"),
            outputPath
        });
        process.stdout.write(`${JSON.stringify({
            run_id: run.manifest.run_id,
            status: "passed",
            artifact_id: result.artifactId,
            path: outputPath
        }, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error instanceof ResearchError || error?.exitCode !== undefined ? error.exitCode : 20;
    }
}
