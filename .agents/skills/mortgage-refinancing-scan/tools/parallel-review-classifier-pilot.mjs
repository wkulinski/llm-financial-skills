#!/usr/bin/env node

import path from "node:path";
import {fileURLToPath} from "node:url";

import {
    DEFAULT_BATCH_CONCURRENCY,
    DEFAULT_BATCH_PAGES,
    DEFAULT_TIMEOUT_MS,
    MODEL,
    PilotError,
    VARIANT,
    VARIANTS,
    formatCliError,
    parseArgs,
    parseBatchConcurrency,
    parseBatchPages,
    parsePositiveInt,
    runClassifier
} from "../lib/parallel-review-classifier-pilot.mjs";
import {writeJsonAtomic} from "../lib/parallel-search-pilot.mjs";
import {runSelectedLinkExtract} from "../lib/parallel-extract-pilot.mjs";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, "../../..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "var", "agent", "cache", "mortgage-refinancing-scan", "parallel-review-classifier-pilot");

const VALUE_OPTIONS = new Set(["input", "output", "timeout-ms", "batch-pages", "batch-concurrency", "variant", "model", "run-dir"]);
const FLAG_OPTIONS = new Set(["dry-run", "no-prefilter", "session-reuse"]);

/**
 * Wire the existing bounded selected-link extractor from
 * parallel-extract-pilot as the follow-up extractor: it receives the exact
 * source page and the selected link objects and submits exactly those URLs
 * once, with no extra autonomous browsing. PARALLEL_API_KEY is only required
 * when Luna actually requests a follow-up.
 */
function followupExtractor({bank, sourcePage, selected, apiKey, dryRun, timeoutMs}) {
    return runSelectedLinkExtract({bank, sourcePages: [sourcePage], selected, apiKey, dryRun, timeoutMs});
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const args = parseArgs(process.argv.slice(2), {
            valueOptions: VALUE_OPTIONS,
            flagOptions: FLAG_OPTIONS,
            required: ["input"]
        });
        const inputPath = path.resolve(args["input"]);
        const timeoutMs = args["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : parsePositiveInt("timeout-ms", args["timeout-ms"]);
        const batchPages = args["batch-pages"] === undefined ? DEFAULT_BATCH_PAGES : parseBatchPages("batch-pages", args["batch-pages"]);
        const batchConcurrency = args["batch-concurrency"] === undefined ? DEFAULT_BATCH_CONCURRENCY : parseBatchConcurrency("batch-concurrency", args["batch-concurrency"]);
        const variant = args.variant ?? VARIANT;
        if (!VARIANTS.includes(variant)) {
            throw new PilotError("invalid_invocation", `--variant must be one of ${VARIANTS.join(", ")}`, {exitCode: 2});
        }
        const model = args.model ?? MODEL;
        const dryRun = args["dry-run"] === true;
        const prefilter = args["no-prefilter"] !== true;
        const sessionReuse = args["session-reuse"] === true;
        const runDir = args["run-dir"] ?? null;
        const apiKey = process.env.PARALLEL_API_KEY;
        const outputPath = args["output"] !== undefined
            ? path.resolve(args["output"])
            : path.join(DEFAULT_OUTPUT_DIR, `classification-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);

        const report = await runClassifier({inputPath, timeoutMs, batchPages, batchConcurrency, variant, model, dryRun, apiKey, followupExtractor, prefilter, sessionReuse, runDir});

        writeJsonAtomic(outputPath, report);
        process.stdout.write(`${JSON.stringify({
            status: dryRun ? "dry_run" : "completed",
            output_path: path.relative(process.cwd(), outputPath),
            prompt_page_count: report.prompt.page_count,
            batch_count: report.prompt.batch_count,
            followup_requests: report.followup?.requested?.length ?? 0,
            summary: report.summary,
            prompt_sha256: report.prompt.aggregate_sha256
        }, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${JSON.stringify(formatCliError(error))}\n`);
        process.exitCode = error instanceof PilotError || error?.exitCode !== undefined ? error.exitCode : 20;
    }
}
