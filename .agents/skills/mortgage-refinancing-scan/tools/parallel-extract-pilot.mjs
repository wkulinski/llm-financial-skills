#!/usr/bin/env node

import path from "node:path";
import {fileURLToPath} from "node:url";

import {
    DEFAULT_BATCH_SIZE,
    DEFAULT_CONCURRENCY,
    DEFAULT_EXCERPT_CHARS,
    DEFAULT_FULL_CONTENT_CHARS,
    DEFAULT_MAX_COST_USD,
    DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_TIMEOUT_MS,
    PilotError,
    formatCliError,
    parseArgs,
    parsePositiveInt,
    parsePositiveNumber,
    runExtractPilot,
    writeJsonAtomic
} from "../lib/parallel-extract-pilot.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, "../../..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "var", "agent", "cache", "mortgage-refinancing-scan", "parallel-extract-pilot");

const VALUE_OPTIONS = new Set([
    "input",
    "output",
    "batch-size",
    "concurrency",
    "timeout-ms",
    "max-response-bytes",
    "excerpt-chars",
    "full-content-chars",
    "max-cost-usd"
]);
const FLAG_OPTIONS = new Set(["dry-run"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), {valueOptions: VALUE_OPTIONS, flagOptions: FLAG_OPTIONS, required: ["input"]});
        const inputPath = path.resolve(args["input"]);
        const batchSize = args["batch-size"] === undefined ? DEFAULT_BATCH_SIZE : parsePositiveInt("batch-size", args["batch-size"]);
        const concurrency = args.concurrency === undefined ? DEFAULT_CONCURRENCY : parsePositiveInt("concurrency", args.concurrency);
        const timeoutMs = args["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : parsePositiveInt("timeout-ms", args["timeout-ms"]);
        const maxResponseBytes = args["max-response-bytes"] === undefined ? DEFAULT_MAX_RESPONSE_BYTES : parsePositiveInt("max-response-bytes", args["max-response-bytes"]);
        const excerptChars = args["excerpt-chars"] === undefined ? DEFAULT_EXCERPT_CHARS : parsePositiveInt("excerpt-chars", args["excerpt-chars"]);
        const fullContentChars = args["full-content-chars"] === undefined ? DEFAULT_FULL_CONTENT_CHARS : parsePositiveInt("full-content-chars", args["full-content-chars"]);
        const maxCostUsd = args["max-cost-usd"] === undefined ? DEFAULT_MAX_COST_USD : parsePositiveNumber("max-cost-usd", args["max-cost-usd"]);
        const dryRun = args["dry-run"] === true;
        const outputPath = args["output"] !== undefined
            ? path.resolve(args["output"])
            : path.join(DEFAULT_OUTPUT_DIR, `extract-pack-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);

        const pack = await runExtractPilot({
            inputPath,
            batchSize,
            concurrency,
            timeoutMs,
            maxResponseBytes,
            excerptChars,
            fullContentChars,
            maxCostUsd,
            dryRun,
            apiKey: process.env.PARALLEL_API_KEY
        });

        writeJsonAtomic(outputPath, pack);
        process.stdout.write(`${JSON.stringify({
            status: dryRun ? "dry_run" : "completed",
            output_path: path.relative(process.cwd(), outputPath),
            bank_count: pack.summary.bank_count,
            submitted: pack.summary.submitted,
            extracted: pack.summary.extracted,
            error: pack.summary.error,
            api_request_count: pack.summary.api_request_count,
            estimated_cost_usd: pack.summary.estimated_cost_usd
        }, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error instanceof PilotError || error?.exitCode !== undefined ? error.exitCode : 20;
    }
}