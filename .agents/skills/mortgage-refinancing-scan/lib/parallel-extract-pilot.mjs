import fs from "node:fs";
import crypto from "node:crypto";

import {
    PilotError,
    canonicalIdentity,
    formatCliError,
    hostAllowed,
    isPlainObject,
    parseArgs,
    parsePositiveInt,
    parsePositiveNumber,
    writeJsonAtomic
} from "./parallel-search-pilot.mjs";

export {
    PilotError,
    canonicalIdentity,
    formatCliError,
    parseArgs,
    parsePositiveInt,
    parsePositiveNumber,
    writeJsonAtomic
};

/**
 * Isolated bounded Parallel Extract pilot for official offer pages.
 *
 * Consumes a `parallel-search-pilot/1.0.0` report and submits every accepted
 * candidate of each bank, in the exact order written by Search, in sequential
 * batches of at most `MAX_URLS_PER_REQUEST` URLs to
 * POST https://api.parallel.ai/v1/extract. There is no local top-k, scoring,
 * candidate selection or recovery from Search rejections: Search is the sole
 * owner of candidate preparation and has already deduplicated candidates by
 * the shared canonical identity.
 *
 * Output is flat and page-first: each bank record keeps bank/search_coverage/
 * submitted_urls/result_errors and page records live directly in
 * `banks[*].pages` — one page record per submitted identity (ok, error,
 * unresolved or dry_run). There are no bundles, parent/child relationships or
 * expansion passes.
 *
 * Results are mapped back to the submitted pages by the shared canonical
 * identity that treats www/non-www hosts, trailing slashes, default ports,
 * percent-encoded path equivalents (comma/%2C) and http/https transport as
 * equal and ignores fragments. Duplicate/unknown/cross-host results are
 * explicit result_errors and every submitted identity becomes exactly one
 * page record (ok, unresolved or error).
 *
 * This module is deliberately self-contained: it does not import the run
 * lifecycle, schema registry or transport layers of the existing skill.
 */

export const ENDPOINT = "https://api.parallel.ai/v1/extract";
export const REPORT_SCHEMA_VERSION = "parallel-extract-pilot/2.0.0";
export const SOURCE_SCHEMA_VERSION = "parallel-search-pilot/1.0.0";

export const MAX_URLS_PER_REQUEST = 20;
export const DEFAULT_BATCH_SIZE = MAX_URLS_PER_REQUEST;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EXCERPT_CHARS = 5_000;
export const DEFAULT_FULL_CONTENT_CHARS = 20_000;
export const DEFAULT_MAX_COST_USD = 1.0;
export const COST_PER_URL_USD = 0.001;
export const CLIENT_MODEL = "gpt-5.6-luna";
export const MAX_CHARS_TOTAL_CAP = 1_000_000;

/** Technical cap for the flat per-page list of direct official links. */
export const MAX_DIRECT_LINKS_PER_PAGE = 100;
/** Maximum number of existing direct links a caller may select per extract. */
export const MAX_SELECTED_LINKS = 3;
/** Short metadata window around a direct link, whitespace-collapsed. */
const DIRECT_LINK_CONTEXT_BEFORE_CHARS = 80;
const DIRECT_LINK_CONTEXT_AFTER_CHARS = 80;
const DIRECT_LINK_CONTEXT_MAX_CHARS = 240;

/**
 * Constant extract objective: targets the exact mortgage refinancing criteria
 * (repaying a mortgage taken at another bank, transferring a mortgage to this
 * bank, fixed interest rates) and excludes business/cash/account-transfer
 * products. Kept constant so every request is deterministic and auditable.
 */
export const OBJECTIVE = "Wybierz wyłącznie oficjalne podstrony banku dotyczące refinansowania kredytu hipotecznego: spłaty kredytu hipotecznego zaciągniętego w innym banku, przeniesienia kredytu hipotecznego do innego banku oraz stałego oprocentowania (RRSO). Pomiń strony, które nie są ofertami kredytów mieszkaniowych: kredyty gotówkowe i konsumenckie, kredyty dla firm i biznesowe, kredyty rolnicze, kredyty inwestycyjne, kredyty rewolwingowe, odnawialne, pomostowe, obrotowe i jubileuszowe, lokaty, konta, rachunki i limity, oszczędności, płatności (w tym odroczone), karty, ubezpieczenia, emerytury, inwestycje, bankowość internetową, logowanie, przelewy, przeniesienie rachunku (w odróżnieniu od refinansowania kredytu), aktualności i komunikaty, reklamacje, karierę, kontakt, RODO i politykę prywatności, regulaminy, pomoc, wyszukiwarkę, stronę główną, strony władz banku, zarządu, rady nadzorczej i komitetów, historię banku oraz dokumenty aplikacyjne (wnioski, kwestionariusze, taryfy), strony testowe, mapy strony, pliki cookies, deklaracje dostępności i załączniki — chyba że taka strona wprost dotyczy kredytu mieszkaniowego lub hipotecznego albo jego oprocentowania.";

export function buildExtractQueries() {
    return [
        "refinansowanie kredytu hipotecznego spłata w innym banku stałe oprocentowanie",
        "przeniesienie kredytu hipotecznego do innego banku oferta",
        "spłata kredytu hipotecznego zaciągniętego w innym banku"
    ];
}

function sha256Hex(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertPositiveInt(name, value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new PilotError("invalid_configuration", `${name} must be a positive integer`, {exitCode: 2});
    }
}

function assertBatchSize(value) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_URLS_PER_REQUEST) {
        throw new PilotError("invalid_configuration", `batch_size must be an integer between 1 and ${MAX_URLS_PER_REQUEST}`, {exitCode: 2});
    }
}

/**
 * Parse and validate a result URL from the extract API or a candidate URL:
 * must be an absolute http(s) URL without credentials. Host safety is checked
 * separately with `hostAllowed`.
 */
function parseResultUrl(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return {ok: false, code: "invalid_result_url", message: "result url is missing"};
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return {ok: false, code: "invalid_result_url", message: "result url is not a valid URL"};
    }
    if (parsed.username !== "" || parsed.password !== "") {
        return {ok: false, code: "url_with_credentials", message: "result url contains credentials"};
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return {ok: false, code: "unsupported_protocol", message: `result url protocol ${parsed.protocol} is not supported`};
    }
    return {ok: true, parsed};
}

/**
 * Strict structural validation of a `parallel-search-pilot/1.0.0` source
 * report: object shape, schema version and a banks[] array of records that
 * each carry a bank object.
 */
export function validateSourceReport(value) {
    if (!isPlainObject(value)) {
        throw new PilotError("invalid_source_report", "source report must be a JSON object", {exitCode: 10});
    }
    if (value.schema_version !== SOURCE_SCHEMA_VERSION) {
        throw new PilotError("invalid_source_report", `source report must have schema_version ${SOURCE_SCHEMA_VERSION}`, {exitCode: 10});
    }
    if (!Array.isArray(value.banks)) {
        throw new PilotError("invalid_source_report", "source report must contain a banks[] array", {exitCode: 10});
    }
    for (const [index, record] of value.banks.entries()) {
        if (!isPlainObject(record) || !isPlainObject(record.bank)) {
            throw new PilotError("invalid_source_report", `banks[${index}] must contain a bank object`, {exitCode: 10});
        }
    }
    return value;
}

function loadSource(inputPath, sourceReport) {
    if (sourceReport !== undefined) {
        validateSourceReport(sourceReport);
        return {
            report: sourceReport,
            path: inputPath ?? null,
            sha256: sha256Hex(Buffer.from(JSON.stringify(sourceReport), "utf8"))
        };
    }
    if (typeof inputPath !== "string" || inputPath === "") {
        throw new PilotError("invalid_source_report", "input report is required", {exitCode: 10});
    }
    let report;
    try {
        report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    } catch (error) {
        throw new PilotError("invalid_source_report", `source report ${inputPath} cannot be read as JSON`, {
            exitCode: 10,
            details: {path: inputPath},
            cause: error
        });
    }
    validateSourceReport(report);
    return {report, path: inputPath, sha256: sha256Hex(fs.readFileSync(inputPath))};
}

async function readBoundedBody(response, maxBytes) {
    if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) {
                    await reader.cancel().catch(() => {});
                    return {ok: false, bytes: size};
                }
                chunks.push(Buffer.from(value));
            }
        } finally {
            reader.releaseLock?.();
        }
        return {ok: true, bytes: size, buffer: Buffer.concat(chunks, size)};
    }
    const value = response.body instanceof Buffer
        ? response.body
        : Buffer.from(await response.arrayBuffer());
    if (value.length > maxBytes) {
        return {ok: false, bytes: value.length};
    }
    return {ok: true, bytes: value.length, buffer: value};
}

function bankIdentity(bank) {
    return {
        institution_id: typeof bank.institution_id === "string" ? bank.institution_id : null,
        lp: Number.isInteger(bank.lp) ? bank.lp : null,
        legal_name: typeof bank.legal_name === "string" && bank.legal_name.trim() !== "" ? bank.legal_name : bank.institution_id ?? null,
        official_hosts: Array.isArray(bank.official_hosts) ? [...bank.official_hosts] : [],
        allowed_redirect_hosts: Array.isArray(bank.allowed_redirect_hosts) ? [...bank.allowed_redirect_hosts] : []
    };
}

function searchCoverage(sourceRecord) {
    return {
        raw_result_count: Number(sourceRecord.raw_result_count ?? 0),
        official_result_count: Number(sourceRecord.official_result_count ?? 0),
        duplicate_count: Number(sourceRecord.duplicate_count ?? 0),
        rejected_count: Number(sourceRecord.rejected_count ?? 0),
        candidate_count: Array.isArray(sourceRecord.candidates) ? sourceRecord.candidates.length : 0
    };
}

/**
 * Build the submission plan for one bank: consume `source.report.banks[*]`
 * candidates in the exact order written by Search, with no top-k, scoring or
 * selection. Each accepted candidate is validated (parseable, credential-free,
 * official host) and deduplicated by the shared canonical identity keeping the
 * first position; invalid or colliding entries become result_errors and are
 * never submitted.
 */
function planBank(sourceRecord) {
    const bank = bankIdentity(sourceRecord.bank);
    const seen = new Set();
    const submitted = [];
    const invalid = [];
    for (const candidate of Array.isArray(sourceRecord.candidates) ? sourceRecord.candidates : []) {
        const candidateUrl = candidate?.canonical_url;
        const parsed = parseResultUrl(candidateUrl);
        if (!parsed.ok) {
            invalid.push({code: "invalid_candidate_url", message: parsed.message, url: typeof candidateUrl === "string" ? candidateUrl : null});
            continue;
        }
        if (!hostAllowed(parsed.parsed.hostname, bank)) {
            invalid.push({code: "cross_host_candidate", message: `candidate host ${parsed.parsed.hostname} is not allowed for ${bank.institution_id}`, url: candidateUrl});
            continue;
        }
        const identity = canonicalIdentity(candidateUrl);
        if (identity === null || seen.has(identity)) {
            invalid.push({code: "duplicate_candidate_identity", message: "candidate identity collides with an earlier candidate; not submitted", url: candidateUrl});
            continue;
        }
        seen.add(identity);
        submitted.push({candidate_url: candidateUrl, identity});
    }
    return {
        bank,
        search_coverage: searchCoverage(sourceRecord),
        submitted,
        invalid
    };
}

/**
 * Bounded extract request body for one batch of URLs. `max_chars_total` is
 * derived from the batch size (urls * excerpt chars) and capped to a safe
 * integer; nested advanced_settings bound excerpts and full content.
 */
export function buildRequestBody({urls, excerptChars = DEFAULT_EXCERPT_CHARS, fullContentChars = DEFAULT_FULL_CONTENT_CHARS} = {}) {
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_URLS_PER_REQUEST) {
        throw new PilotError("invalid_configuration", `urls must be an array of 1..${MAX_URLS_PER_REQUEST} URLs`, {exitCode: 2});
    }
    assertPositiveInt("excerpt_chars", excerptChars);
    assertPositiveInt("full_content_chars", fullContentChars);
    return {
        objective: OBJECTIVE,
        search_queries: buildExtractQueries(),
        client_model: CLIENT_MODEL,
        max_chars_total: Math.min(urls.length * excerptChars, MAX_CHARS_TOTAL_CAP),
        advanced_settings: {
            excerpt_settings: {
                max_chars_per_result: excerptChars
            },
            full_content: {
                max_chars_per_result: fullContentChars
            }
        },
        urls: [...urls]
    };
}

export function estimateCost(count) {
    return Number((count * COST_PER_URL_USD).toFixed(6));
}

/** Guard: fail before any request would exceed the configured budget. */
export function validateBudget(count, maxCostUsd) {
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        throw new PilotError("invalid_configuration", "max_cost_usd must be a positive number", {exitCode: 2});
    }
    const estimate = estimateCost(count);
    if (estimate > maxCostUsd) {
        throw new PilotError("budget_guard_exceeded", `estimated cost ${estimate} USD exceeds max_cost_usd ${maxCostUsd} USD`, {
            exitCode: 11,
            details: {estimated_cost_usd: estimate, max_cost_usd: maxCostUsd, submitted_url_count: count}
        });
    }
    return estimate;
}

/**
 * One sequential POST to the extract endpoint with an AbortController timeout
 * and a Content-Length + stream byte guard. Controlled error codes for
 * auth (401/403), rate limit (429), server errors (5xx), timeout/network,
 * oversized bodies and malformed JSON/schema. No retries in this pilot.
 */
async function postExtractBatch({requestBody, apiKey, timeoutMs, maxResponseBytes, fetchImpl, now}) {
    const startedAt = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    let response;
    try {
        response = await fetchImpl(ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
    } catch (error) {
        clearTimeout(timer);
        const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError";
        return {
            ok: false,
            code: timedOut ? "request_timeout" : "network_error",
            message: timedOut ? `timeout after ${timeoutMs} ms` : `request failed: ${String(error?.message ?? error).slice(0, 512)}`,
            http_status: null,
            latency_ms: now() - startedAt
        };
    } finally {
        clearTimeout(timer);
    }
    const latencyMs = now() - startedAt;
    const status = Number(response.status);
    if (status === 401 || status === 403) {
        response.body?.cancel?.().catch?.(() => {});
        return {ok: false, code: "auth_error", message: `HTTP ${status}: authentication rejected`, http_status: status, latency_ms: latencyMs};
    }
    if (status === 429) {
        response.body?.cancel?.().catch?.(() => {});
        return {ok: false, code: "rate_limited", message: `HTTP ${status}: rate limit reached`, http_status: status, latency_ms: latencyMs};
    }
    if (status >= 500) {
        response.body?.cancel?.().catch?.(() => {});
        return {ok: false, code: "server_error", message: `HTTP ${status}: extract API server error`, http_status: status, latency_ms: latencyMs};
    }
    if (status < 200 || status >= 300) {
        response.body?.cancel?.().catch?.(() => {});
        return {ok: false, code: "http_error", message: `HTTP ${status} from extract API`, http_status: status, latency_ms: latencyMs};
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        response.body?.cancel?.().catch?.(() => {});
        return {ok: false, code: "response_too_large", message: `content-length ${declaredLength} exceeds max_response_bytes ${maxResponseBytes}`, http_status: status, latency_ms: latencyMs};
    }
    const body = await readBoundedBody(response, maxResponseBytes);
    if (!body.ok) {
        return {ok: false, code: "response_too_large", message: `response body exceeds max_response_bytes ${maxResponseBytes}`, http_status: status, latency_ms: latencyMs};
    }
    let payload;
    try {
        payload = JSON.parse(body.buffer.toString("utf8"));
    } catch {
        return {ok: false, code: "invalid_json_response", message: "response body is not valid JSON", http_status: status, latency_ms: latencyMs};
    }
    if (!isPlainObject(payload)) {
        return {ok: false, code: "invalid_response_schema", message: "response payload must be a JSON object", http_status: status, latency_ms: latencyMs};
    }
    if (!Array.isArray(payload.results)) {
        return {ok: false, code: "invalid_response_schema", message: "response payload must contain a results[] array", http_status: status, latency_ms: latencyMs};
    }
    return {ok: true, payload, http_status: status, latency_ms: latencyMs};
}

/**
 * Bound full_content locally even when the API exceeds the configured limit.
 * The hash fingerprints the original API value; `text` is the stored slice.
 */
function boundFullContent(value, maxChars) {
    const text = typeof value === "string" ? value : "";
    const originalChars = text.length;
    const truncated = originalChars > maxChars;
    const stored = truncated ? text.slice(0, maxChars) : text;
    return {
        text: stored,
        original_chars: originalChars,
        stored_chars: stored.length,
        truncated,
        sha256: sha256Hex(Buffer.from(text, "utf8"))
    };
}

/**
 * Bound each excerpt locally. The hash fingerprints the original API array;
 * `items` contains the locally stored slices.
 */
function boundExcerpts(value, maxChars) {
    const items = Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    const originalChars = items.reduce((sum, item) => sum + item.length, 0);
    const stored = items.map((item) => (item.length > maxChars ? item.slice(0, maxChars) : item));
    const truncated = stored.some((item, index) => item.length !== items[index].length);
    return {
        items: stored,
        original_chars: originalChars,
        stored_chars: stored.reduce((sum, item) => sum + item.length, 0),
        truncated,
        sha256: sha256Hex(Buffer.from(JSON.stringify(items), "utf8"))
    };
}

const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)\s]+)\)/u;
const HTML_ANCHOR_PATTERN = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/iu;

function collapseWhitespace(value) {
    return value.replace(/\s+/gu, " ").trim();
}

/** Bounded whitespace-collapsed source window around a link occurrence. */
function linkContext(source, start, end) {
    const windowStart = Math.max(0, start - DIRECT_LINK_CONTEXT_BEFORE_CHARS);
    const windowEnd = Math.min(source.length, end + DIRECT_LINK_CONTEXT_AFTER_CHARS);
    return collapseWhitespace(source.slice(windowStart, windowEnd)).slice(0, DIRECT_LINK_CONTEXT_MAX_CHARS);
}

/**
 * Parse direct official links deterministically from the raw Extract
 * full_content returned for an OK page (before local truncation). Supports
 * ordinary Markdown links and HTML anchors; relative targets are resolved
 * against `baseUrl` (final_url/url/submitted_url priority). Only absolute
 * http(s) URLs without credentials whose host passes `hostAllowed(bank)` are
 * kept; self-links are excluded, links are deduplicated by the shared
 * canonical identity in source order and the exposed list is capped at
 * MAX_DIRECT_LINKS_PER_PAGE. Each link is stored as a stable per-page
 * `{link_id: "link-N", url, anchor_text, context}` record; `context` is a
 * short whitespace-collapsed source window and is metadata, not evidence.
 */
function extractDirectLinks(fullContent, {bank, pageIdentity, baseUrl}) {
    const source = typeof fullContent === "string" ? fullContent : "";
    const candidates = [];
    let match;
    const markdown = new RegExp(MARKDOWN_LINK_PATTERN.source, "gu");
    while ((match = markdown.exec(source)) !== null) {
        if (match.index > 0 && source[match.index - 1] === "!") {
            continue; // `![alt](url)` image syntax is not a link
        }
        candidates.push({start: match.index, end: markdown.lastIndex, anchorText: match[1], target: match[2]});
    }
    const html = new RegExp(HTML_ANCHOR_PATTERN.source, "giu");
    while ((match = html.exec(source)) !== null) {
        candidates.push({start: match.index, end: html.lastIndex, anchorText: match[3], target: match[1] ?? match[2]});
    }
    candidates.sort((left, right) => left.start - right.start || left.end - right.end);
    const links = [];
    const seen = new Set();
    for (const candidate of candidates) {
        if (links.length >= MAX_DIRECT_LINKS_PER_PAGE) {
            break;
        }
        let parsed;
        try {
            parsed = new URL(candidate.target, baseUrl);
        } catch {
            continue;
        }
        if (parsed.username !== "" || parsed.password !== "") {
            continue;
        }
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            continue;
        }
        if (!hostAllowed(parsed.hostname, bank)) {
            continue;
        }
        const identity = canonicalIdentity(parsed.href);
        if (identity === null || identity === pageIdentity || seen.has(identity)) {
            continue;
        }
        seen.add(identity);
        links.push({
            link_id: `link-${links.length + 1}`,
            url: parsed.href,
            anchor_text: collapseWhitespace(candidate.anchorText).slice(0, DIRECT_LINK_CONTEXT_MAX_CHARS),
            context: linkContext(source, candidate.start, candidate.end)
        });
    }
    return links;
}

function pageRecord(result, {submittedUrl, excerptChars, fullContentChars, bank, pageIdentity}) {
    const finalUrl = typeof result.final_url === "string" && result.final_url !== "" ? result.final_url : null;
    return {
        status: "ok",
        url: result.url,
        submitted_url: submittedUrl,
        final_url: finalUrl,
        title: typeof result.title === "string" ? result.title : null,
        publish_date: typeof result.publish_date === "string" ? result.publish_date : null,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        content: {
            full_content: boundFullContent(result.full_content, fullContentChars),
            excerpts: boundExcerpts(result.excerpts, excerptChars)
        },
        direct_links: extractDirectLinks(result.full_content, {
            bank,
            pageIdentity,
            baseUrl: finalUrl ?? result.url
        })
    };
}

/**
 * Map the results of one batch back to the submitted pages by the shared
 * canonical identity (order-independent). Unknown, duplicate and cross-host
 * results are explicit `result_errors`; every submitted identity ends up with
 * exactly one page record in submitted order (ok, unresolved or error).
 */
function analyzeBatchResponse(batchRoots, payload, {bank, excerptChars, fullContentChars}) {
    const byIdentity = new Map(batchRoots.map((root) => [root.identity, root]));
    const matched = new Map();
    const resultErrors = [];
    for (const result of payload.results) {
        if (!isPlainObject(result)) {
            resultErrors.push({code: "invalid_result", message: "result entry is not an object", result_url: null});
            continue;
        }
        const rawUrl = result.url;
        const parsed = parseResultUrl(rawUrl);
        if (!parsed.ok) {
            resultErrors.push({code: parsed.code, message: parsed.message, result_url: typeof rawUrl === "string" ? rawUrl : null});
            continue;
        }
        if (!hostAllowed(parsed.parsed.hostname, bank)) {
            resultErrors.push({code: "cross_host_result", message: `result host ${parsed.parsed.hostname} is not allowed for ${bank.institution_id}`, result_url: rawUrl});
            continue;
        }
        const rawFinalUrl = result.final_url;
        if (typeof rawFinalUrl === "string" && rawFinalUrl.trim() !== "") {
            const finalParsed = parseResultUrl(rawFinalUrl);
            if (!finalParsed.ok) {
                resultErrors.push({code: "invalid_final_url", message: finalParsed.message, result_url: rawUrl});
                continue;
            }
            if (!hostAllowed(finalParsed.parsed.hostname, bank)) {
                resultErrors.push({code: "cross_host_final_url", message: `final url host ${finalParsed.parsed.hostname} is not allowed for ${bank.institution_id}`, result_url: rawUrl});
                continue;
            }
        }
        const identity = canonicalIdentity(rawUrl);
        const root = byIdentity.get(identity);
        if (root === undefined) {
            resultErrors.push({code: "unknown_result", message: "result URL does not match any submitted page", result_url: rawUrl});
            continue;
        }
        if (matched.has(identity)) {
            resultErrors.push({code: "duplicate_result", message: "more than one result maps to the same submitted page", result_url: rawUrl});
            continue;
        }
        matched.set(identity, result);
    }
    const pages = [];
    for (const root of batchRoots) {
        const result = matched.get(root.identity);
        if (result === undefined) {
            pages.push({
                status: "unresolved",
                url: root.candidate_url,
                submitted_url: root.candidate_url,
                error: {code: "unresolved_root", message: "no result was returned for this submitted page"}
            });
            continue;
        }
        pages.push(pageRecord(result, {
            submittedUrl: root.candidate_url,
            excerptChars,
            fullContentChars,
            bank,
            pageIdentity: root.identity
        }));
    }
    return {pages, resultErrors};
}

/**
 * Run per-bank extract plans with bounded concurrency. Each worker takes the
 * next plan and processes its page batches sequentially; `concurrency`
 * workers run in parallel across banks so independent banks do not serialize
 * on the extract endpoint.
 */
async function runBankPool(plans, {batchSize, concurrency, timeoutMs, maxResponseBytes, excerptChars, fullContentChars, apiKey, fetchImpl, now}) {
    const results = new Array(plans.length);
    let next = 0;
    async function worker() {
        while (next < plans.length) {
            const index = next;
            next += 1;
            results[index] = await runBankPages(plans[index], {
                batchSize,
                timeoutMs,
                maxResponseBytes,
                excerptChars,
                fullContentChars,
                apiKey,
                fetchImpl,
                now
            });
        }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, plans.length)}, worker));
    return results;
}

/**
 * Sequential single-pass extraction for one bank: submit all planned
 * candidates in bounded batches and collect one flat page
 * record per submitted identity in Search order.
 */
async function runBankPages(plan, {batchSize, timeoutMs, maxResponseBytes, excerptChars, fullContentChars, apiKey, fetchImpl, now}) {
    const pages = [];
    const resultErrors = [...plan.invalid];
    let apiRequestCount = 0;
    for (let offset = 0; offset < plan.submitted.length; offset += batchSize) {
        const batchRoots = plan.submitted.slice(offset, offset + batchSize);
        const body = buildRequestBody({
            urls: batchRoots.map((root) => root.candidate_url),
            excerptChars,
            fullContentChars
        });
        const outcome = await postExtractBatch({requestBody: body, apiKey, timeoutMs, maxResponseBytes, fetchImpl, now});
        apiRequestCount += 1;
        if (!outcome.ok) {
            for (const root of batchRoots) {
                pages.push({
                    status: "error",
                    url: root.candidate_url,
                    submitted_url: root.candidate_url,
                    error: {code: outcome.code, message: outcome.message}
                });
            }
            continue;
        }
        const analyzed = analyzeBatchResponse(batchRoots, outcome.payload, {bank: plan.bank, excerptChars, fullContentChars});
        pages.push(...analyzed.pages);
        resultErrors.push(...analyzed.resultErrors);
    }
    return {
        bank_record: {
            bank: plan.bank,
            search_coverage: plan.search_coverage,
            submitted_urls: plan.submitted.map((root) => root.candidate_url),
            result_errors: resultErrors,
            pages
        },
        apiRequestCount
    };
}

function buildDryBank(plan) {
    return {
        bank: plan.bank,
        search_coverage: plan.search_coverage,
        submitted_urls: plan.submitted.map((root) => root.candidate_url),
        result_errors: [...plan.invalid],
        pages: plan.submitted.map((root) => ({
            status: "dry_run",
            url: root.candidate_url,
            submitted_url: root.candidate_url
        }))
    };
}

function buildPack({source, bankResults, limits, dryRun, estimatedCostUsd, apiRequestCount, elapsedMs}) {
    const pages = bankResults.flatMap((record) => record.pages);
    return {
        schema_version: REPORT_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        dry_run: dryRun,
        source_report: {
            path: source.path,
            sha256: source.sha256,
            schema_version: source.report.schema_version
        },
        config: limits,
        banks: bankResults,
        summary: {
            bank_count: bankResults.length,
            submitted: pages.length,
            extracted: pages.filter((page) => page.status === "ok").length,
            error: pages.filter((page) => page.status === "error" || page.status === "unresolved").length,
            api_request_count: apiRequestCount,
            estimated_cost_usd: estimatedCostUsd,
            elapsed_ms: elapsedMs
        }
    };
}

/**
 * Run the bounded extract pilot. `sourceReport` may be passed as an already
 * parsed report object (tests) or loaded from `inputPath`; `fetchImpl` and
 * `now` are injectable for tests. Live runs require `apiKey`; dry-run never
 * touches the network and never requires a key.
 */
export async function runExtractPilot(options) {
    const {
        inputPath = null,
        sourceReport = undefined,
        batchSize = DEFAULT_BATCH_SIZE,
        concurrency = DEFAULT_CONCURRENCY,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
        excerptChars = DEFAULT_EXCERPT_CHARS,
        fullContentChars = DEFAULT_FULL_CONTENT_CHARS,
        maxCostUsd = DEFAULT_MAX_COST_USD,
        dryRun = false,
        apiKey = undefined,
        fetchImpl = globalThis.fetch,
        now = Date.now
    } = options ?? {};
    assertBatchSize(batchSize);
    assertPositiveInt("concurrency", concurrency);
    assertPositiveInt("timeout_ms", timeoutMs);
    assertPositiveInt("max_response_bytes", maxResponseBytes);
    assertPositiveInt("excerpt_chars", excerptChars);
    assertPositiveInt("full_content_chars", fullContentChars);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        throw new PilotError("invalid_configuration", "max_cost_usd must be a positive number", {exitCode: 2});
    }

    const source = loadSource(inputPath, sourceReport);
    const startedAt = now();

    const plans = source.report.banks.map((record) => planBank(record));
    const submittedTotal = plans.reduce((sum, plan) => sum + plan.submitted.length, 0);
    const estimatedCostUsd = validateBudget(submittedTotal, maxCostUsd);

    if (!dryRun && (typeof apiKey !== "string" || apiKey.trim() === "")) {
        throw new PilotError("missing_api_key", "PARALLEL_API_KEY is required for a live run", {exitCode: 20});
    }

    const limits = {
        endpoint: ENDPOINT,
        client_model: CLIENT_MODEL,
        max_urls_per_request: MAX_URLS_PER_REQUEST,
        batch_size: batchSize,
        concurrency,
        timeout_ms: timeoutMs,
        max_response_bytes: maxResponseBytes,
        excerpt_chars: excerptChars,
        full_content_chars: fullContentChars,
        max_chars_total_cap: MAX_CHARS_TOTAL_CAP,
        max_cost_usd: maxCostUsd,
        cost_per_url_usd: COST_PER_URL_USD
    };

    let apiRequestCount = 0;
    const bankResults = [];
    if (dryRun) {
        for (const plan of plans) {
            bankResults.push(buildDryBank(plan));
        }
    } else {
        const outcomes = await runBankPool(plans, {
            batchSize,
            timeoutMs,
            maxResponseBytes,
            excerptChars,
            fullContentChars,
            apiKey,
            fetchImpl,
            concurrency,
            now
        });
        for (const outcome of outcomes) {
            apiRequestCount += outcome.apiRequestCount;
            bankResults.push(outcome.bank_record);
        }
    }

    return buildPack({
        source,
        bankResults,
        limits,
        dryRun,
        estimatedCostUsd,
        apiRequestCount,
        elapsedMs: now() - startedAt
    });
}

const SELECTED_LINK_ID_PATTERN = /^link-[1-9][0-9]*$/u;

/**
 * Bounded selected-link follow-up extraction: given the bank identity, the
 * flat source page records that already expose `direct_links` and at most
 * MAX_SELECTED_LINKS existing selected link objects, submit exactly those
 * URLs (in caller order) through the same bounded Parallel Extract
 * request/response mapping used by the flat pilot and return source-bound
 * page records that carry `link_id` and `source_url`. Selection validation
 * fails closed before any request: each selected link must be unique and
 * must exist among the source pages' direct links with a valid link_id,
 * parseable credential-free http(s) url on an allowed host. A result whose
 * `final_url` host escapes the allowed hosts is rejected so a redirect can
 * never be accepted. Dry runs are explicit and never touch the network.
 */
export async function runSelectedLinkExtract(options) {
    const {
        bank = undefined,
        sourcePages = undefined,
        selected = undefined,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
        excerptChars = DEFAULT_EXCERPT_CHARS,
        fullContentChars = DEFAULT_FULL_CONTENT_CHARS,
        maxCostUsd = DEFAULT_MAX_COST_USD,
        dryRun = false,
        apiKey = undefined,
        fetchImpl = globalThis.fetch,
        now = Date.now
    } = options ?? {};
    assertPositiveInt("timeout_ms", timeoutMs);
    assertPositiveInt("max_response_bytes", maxResponseBytes);
    assertPositiveInt("excerpt_chars", excerptChars);
    assertPositiveInt("full_content_chars", fullContentChars);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        throw new PilotError("invalid_configuration", "max_cost_usd must be a positive number", {exitCode: 2});
    }
    if (!isPlainObject(bank) || !Array.isArray(bank.official_hosts)) {
        throw new PilotError("invalid_configuration", "bank with official_hosts is required", {exitCode: 2});
    }
    if (!Array.isArray(sourcePages) || sourcePages.length === 0) {
        throw new PilotError("invalid_configuration", "sourcePages must be a non-empty array of page records", {exitCode: 2});
    }
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > MAX_SELECTED_LINKS) {
        throw new PilotError("invalid_configuration", `selected must contain between 1 and ${MAX_SELECTED_LINKS} links`, {exitCode: 2});
    }

    const bankIdentityObj = bankIdentity(bank);

    const available = new Map();
    for (const page of sourcePages) {
        if (!isPlainObject(page) || !Array.isArray(page.direct_links)) {
            continue;
        }
        const pageUrl = typeof page.url === "string" && page.url !== "" ? page.url : page.submitted_url;
        for (const link of page.direct_links) {
            if (!isPlainObject(link) || typeof link.link_id !== "string" || typeof link.url !== "string") {
                continue;
            }
            const identity = canonicalIdentity(link.url);
            if (identity === null) {
                continue;
            }
            const key = `${identity}|${link.link_id}`;
            if (!available.has(key)) {
                available.set(key, {link_id: link.link_id, url: link.url, source_url: pageUrl});
            }
        }
    }

    const selection = [];
    const seenLinkIds = new Set();
    const seenIdentities = new Set();
    for (const item of selected) {
        if (!isPlainObject(item)) {
            throw new PilotError("invalid_selected_link", "each selected link must be an object", {exitCode: 2});
        }
        const linkId = typeof item.link_id === "string" ? item.link_id : null;
        if (linkId === null || !SELECTED_LINK_ID_PATTERN.test(linkId)) {
            throw new PilotError("invalid_selected_link", `link_id ${linkId} does not match the stable link-N format`, {exitCode: 2});
        }
        const parsed = parseResultUrl(item.url);
        if (!parsed.ok) {
            throw new PilotError("invalid_selected_link", `selected link ${linkId} url is invalid: ${parsed.message}`, {exitCode: 2});
        }
        if (!hostAllowed(parsed.parsed.hostname, bankIdentityObj)) {
            throw new PilotError("invalid_selected_link", `selected link ${linkId} host ${parsed.parsed.hostname} is not allowed for ${bankIdentityObj.institution_id}`, {exitCode: 2});
        }
        const identity = canonicalIdentity(parsed.parsed.href);
        if (identity === null) {
            throw new PilotError("invalid_selected_link", `selected link ${linkId} url cannot be canonicalized`, {exitCode: 2});
        }
        if (seenLinkIds.has(linkId)) {
            throw new PilotError("invalid_selected_link", `selected link ${linkId} was provided twice`, {exitCode: 2});
        }
        if (seenIdentities.has(identity)) {
            throw new PilotError("invalid_selected_link", `selected link ${linkId} collides with an earlier selected url`, {exitCode: 2});
        }
        const key = `${identity}|${linkId}`;
        const existing = available.get(key);
        if (existing === undefined) {
            throw new PilotError("invalid_selected_link", `selected link ${linkId} does not exist among the source pages' direct links`, {exitCode: 2});
        }
        seenLinkIds.add(linkId);
        seenIdentities.add(identity);
        selection.push({link_id: linkId, url: existing.url, identity, source_url: existing.source_url});
    }

    const estimatedCostUsd = validateBudget(selection.length, maxCostUsd);

    if (!dryRun && (typeof apiKey !== "string" || apiKey.trim() === "")) {
        throw new PilotError("missing_api_key", "PARALLEL_API_KEY is required for a live run", {exitCode: 20});
    }

    const limits = {
        endpoint: ENDPOINT,
        client_model: CLIENT_MODEL,
        max_urls_per_request: MAX_URLS_PER_REQUEST,
        timeout_ms: timeoutMs,
        max_response_bytes: maxResponseBytes,
        excerpt_chars: excerptChars,
        full_content_chars: fullContentChars,
        max_chars_total_cap: MAX_CHARS_TOTAL_CAP,
        max_cost_usd: maxCostUsd,
        cost_per_url_usd: COST_PER_URL_USD,
        max_selected_links: MAX_SELECTED_LINKS,
        max_direct_links_per_page: MAX_DIRECT_LINKS_PER_PAGE
    };

    const roots = selection.map((item) => ({
        candidate_url: item.url,
        identity: item.identity,
        link_id: item.link_id,
        source_url: item.source_url
    }));
    const startedAt = now();
    let pages;
    let resultErrors = [];
    let apiRequestCount = 0;
    if (dryRun) {
        pages = roots.map((root) => ({
            status: "dry_run",
            url: root.candidate_url,
            submitted_url: root.candidate_url,
            link_id: root.link_id,
            source_url: root.source_url
        }));
    } else {
        const body = buildRequestBody({
            urls: roots.map((root) => root.candidate_url),
            excerptChars,
            fullContentChars
        });
        const outcome = await postExtractBatch({requestBody: body, apiKey, timeoutMs, maxResponseBytes, fetchImpl, now});
        apiRequestCount = 1;
        if (!outcome.ok) {
            pages = roots.map((root) => ({
                status: "error",
                url: root.candidate_url,
                submitted_url: root.candidate_url,
                error: {code: outcome.code, message: outcome.message},
                link_id: root.link_id,
                source_url: root.source_url
            }));
        } else {
            const analyzed = analyzeBatchResponse(roots, outcome.payload, {bank: bankIdentityObj, excerptChars, fullContentChars});
            pages = analyzed.pages.map((page, index) => ({...page, link_id: roots[index].link_id, source_url: roots[index].source_url}));
            resultErrors = analyzed.resultErrors;
        }
    }

    return {
        schema_version: REPORT_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        mode: "selected_links",
        dry_run: dryRun,
        source: {
            bank: bankIdentityObj,
            pages: sourcePages.map((page) =>
                typeof page.url === "string" && page.url !== "" ? page.url : page.submitted_url)
        },
        selected: selection.map((item) => ({link_id: item.link_id, url: item.url, source_url: item.source_url})),
        pages,
        result_errors: resultErrors,
        config: limits,
        summary: {
            selected: selection.length,
            submitted: pages.length,
            extracted: pages.filter((page) => page.status === "ok").length,
            error: pages.filter((page) => page.status === "error" || page.status === "unresolved").length,
            api_request_count: apiRequestCount,
            estimated_cost_usd: estimatedCostUsd,
            elapsed_ms: now() - startedAt
        }
    };
}
