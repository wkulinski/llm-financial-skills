#!/usr/bin/env node

import path from "node:path";
import {fileURLToPath} from "node:url";

import {
    DEFAULT_CONCURRENCY,
    DEFAULT_LIMIT,
    DEFAULT_MAX_COST_USD,
    DEFAULT_MODE,
    DEFAULT_OFFSET,
    DEFAULT_TIMEOUT_MS,
    MODES,
    PilotError,
    formatCliError,
    parseArgs,
    parseNonNegativeInt,
    parsePositiveInt,
    parsePositiveNumber,
    runPilot,
    writeJsonAtomic
} from "../lib/parallel-search-pilot.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(TOOL_DIR, "..");
const REPO_ROOT = path.resolve(SKILL_ROOT, "../../..");
const DEFAULT_REGISTRY = path.join(REPO_ROOT, "data", "base", "institutions.current.json");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "var", "agent", "cache", "bs-remortgaging-scan", "parallel-search-pilot");

const VALUE_OPTIONS = new Set([
    "registry",
    "output",
    "limit",
    "offset",
    "concurrency",
    "mode",
    "timeout-ms",
    "max-cost-usd"
]);
const FLAG_OPTIONS = new Set(["dry-run"]);

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), {valueOptions: VALUE_OPTIONS, flagOptions: FLAG_OPTIONS});
        const mode = args["mode"] ?? DEFAULT_MODE;
        if (!MODES.includes(mode)) {
            throw new PilotError("invalid_invocation", `--mode must be one of ${MODES.join(", ")}`, {exitCode: 2});
        }
        const registryPath = path.resolve(args["registry"] ?? DEFAULT_REGISTRY);
        const limit = args["limit"] === undefined ? DEFAULT_LIMIT : parsePositiveInt("limit", args["limit"]);
        const offset = args["offset"] === undefined ? DEFAULT_OFFSET : parseNonNegativeInt("offset", args["offset"]);
        const concurrency = args["concurrency"] === undefined ? DEFAULT_CONCURRENCY : parsePositiveInt("concurrency", args["concurrency"]);
        const timeoutMs = args["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : parsePositiveInt("timeout-ms", args["timeout-ms"]);
        const maxCostUsd = args["max-cost-usd"] === undefined ? DEFAULT_MAX_COST_USD : parsePositiveNumber("max-cost-usd", args["max-cost-usd"]);
        const dryRun = args["dry-run"] === true;
        const outputPath = args["output"] !== undefined
            ? path.resolve(args["output"])
            : path.join(DEFAULT_OUTPUT_DIR, `report-${mode}-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);

        const report = await runPilot({
            registryPath,
            limit,
            offset,
            concurrency,
            mode,
            timeoutMs,
            maxCostUsd,
            dryRun,
            apiKey: dryRun ? undefined : process.env.PARALLEL_API_KEY
        });

        writeJsonAtomic(outputPath, report);
        process.stdout.write(`${JSON.stringify({
            status: dryRun ? "dry_run" : "completed",
            output_path: path.relative(process.cwd(), outputPath),
            mode: report.mode,
            sample_count: report.sample.count,
            estimated_cost_usd: report.request_budget.estimated_cost_usd,
            status_counts: report.summary.status_counts,
            request_count: report.summary.request_count
        }, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error instanceof PilotError || error?.exitCode !== undefined ? error.exitCode : 20;
    }
}
