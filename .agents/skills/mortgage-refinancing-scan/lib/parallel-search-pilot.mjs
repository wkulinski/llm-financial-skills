import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Isolated Parallel Search discovery pilot.
 *
 * Runs at most one POST https://api.parallel.ai/v1/search per sampled bank,
 * filters and canonicalizes result URLs locally, and emits a JSON report that
 * is meant for manual discovery review. This module is deliberately
 * self-contained: it does not import the run lifecycle, schema registry or
 * transport layers of the existing skill.
 */

export const ENDPOINT = "https://api.parallel.ai/v1/search";
export const MODES = Object.freeze(["turbo", "basic", "advanced"]);
export const DEFAULT_MODE = "basic";
export const COST_PER_1000_REQUESTS_USD = Object.freeze({turbo: 1, basic: 5, advanced: 5});
export const MAX_QUERIES_PER_BANK = 5;
export const QUERY_COUNT = 4;

export const DEFAULT_LIMIT = 20;
export const DEFAULT_OFFSET = 0;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_COST_USD = 1.0;
export const DEFAULT_MAX_CHARS_TOTAL = 10_000;
export const DEFAULT_MAX_CHARS_PER_RESULT = 1_000;

export const REPORT_SCHEMA_VERSION = "parallel-search-pilot/1.0.0";
export const SAMPLE_STRATEGY = "even_spread_over_sorted_lp";

export class PilotError extends Error {
    constructor(code, message, {exitCode = 20, details = undefined, cause = undefined} = {}) {
        super(message, cause === undefined ? undefined : {cause});
        this.name = "PilotError";
        this.code = code;
        this.exitCode = exitCode;
        this.details = details;
    }
}

export function formatCliError(error) {
    return {
        error: {
            code: error?.code ?? "fatal_pilot_error",
            message: error?.message ?? String(error),
            ...(error?.details === undefined ? {} : {details: error.details})
        }
    };
}

export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDomainLike(hostname) {
    return hostname.includes(".") && !/^[\d.:[\]]+$/u.test(hostname);
}

function normalizeHost(value) {
    return String(value).trim().toLowerCase().replace(/[.]$/u, "");
}

/**
 * Accept either the real base registry (`institutions[]` with
 * institution_id/lp/name/website_url/base_list_status) or the skill merged
 * registry (`entries[]` with legal_name/official_hosts/allowed_redirect_hosts).
 * Active entries keep official hosts only when the official domain is usable.
 */
export function normalizeRegistry(value) {
    if (!isPlainObject(value)) {
        throw new PilotError("invalid_registry", "registry must be a JSON object", {exitCode: 10});
    }
    if (Array.isArray(value.institutions)) {
        return value.institutions.map((item, index) => normalizeInstitution(item, index));
    }
    if (Array.isArray(value.entries)) {
        return value.entries.map((item, index) => normalizeRegistryEntry(item, index));
    }
    throw new PilotError("invalid_registry", "registry must contain an institutions[] or entries[] array", {exitCode: 10});
}

function normalizeInstitution(item, index) {
    if (!isPlainObject(item)) {
        throw new PilotError("invalid_registry", `institutions[${index}] is not an object`, {exitCode: 10});
    }
    const institutionId = item.institution_id;
    const lp = Number(item.lp);
    const name = item.name;
    if (typeof institutionId !== "string" || institutionId === "") {
        throw new PilotError("invalid_registry", `institutions[${index}] requires a non-empty institution_id`, {exitCode: 10});
    }
    if (!Number.isInteger(lp) || lp < 1) {
        throw new PilotError("invalid_registry", `institutions[${index}] requires a positive integer lp`, {exitCode: 10});
    }
    const active = item.base_list_status === undefined || item.base_list_status === "active";
    let officialHosts = [];
    let websiteUrl = null;
    if (active && typeof item.website_url === "string" && item.website_url.trim() !== "") {
        try {
            const url = new URL(item.website_url);
            const hostname = url.hostname.toLowerCase();
            if ((url.protocol === "http:" || url.protocol === "https:") && isDomainLike(hostname)) {
                officialHosts = [hostname];
                websiteUrl = item.website_url;
            }
        } catch {
            // Unusable website_url means the entry is not eligible for sampling.
        }
    }
    return {
        institution_id: institutionId,
        lp,
        legal_name: typeof name === "string" && name.trim() !== "" ? name : institutionId,
        official_hosts: officialHosts,
        allowed_redirect_hosts: [],
        website_url: websiteUrl,
        active,
        source_shape: "institutions"
    };
}

function normalizeRegistryEntry(item, index) {
    if (!isPlainObject(item)) {
        throw new PilotError("invalid_registry", `entries[${index}] is not an object`, {exitCode: 10});
    }
    const institutionId = item.institution_id ?? item.entry_id;
    const lp = Number(item.lp);
    if (typeof institutionId !== "string" || institutionId === "") {
        throw new PilotError("invalid_registry", `entries[${index}] requires a non-empty institution_id or entry_id`, {exitCode: 10});
    }
    if (!Number.isInteger(lp) || lp < 1) {
        throw new PilotError("invalid_registry", `entries[${index}] requires a positive integer lp`, {exitCode: 10});
    }
    const officialHosts = Array.isArray(item.official_hosts)
        ? item.official_hosts.map(normalizeHost).filter(Boolean)
        : [];
    const allowedRedirectHosts = Array.isArray(item.allowed_redirect_hosts)
        ? item.allowed_redirect_hosts.map(normalizeHost).filter(Boolean)
        : [];
    return {
        institution_id: institutionId,
        lp,
        legal_name: typeof item.legal_name === "string" && item.legal_name.trim() !== "" ? item.legal_name : institutionId,
        official_hosts: [...new Set(officialHosts)].sort(),
        allowed_redirect_hosts: [...new Set(allowedRedirectHosts)].sort(),
        active: item.base_list_status === undefined || item.base_list_status === "active",
        source_shape: "entries"
    };
}

/** Active entries with at least one usable official host. */
export function eligibleEntries(entries) {
    return entries.filter((entry) => entry.active && entry.official_hosts.length > 0);
}

/**
 * Deterministic even spread over the entries sorted by lp (stable tie-break by
 * institution_id). `offset` drops the first `offset` sorted eligible entries
 * before spreading, so consecutive pilot runs keep the spread property.
 */
export function selectSample(entries, {limit = DEFAULT_LIMIT, offset = DEFAULT_OFFSET} = {}) {
    assertPositiveInt("limit", limit);
    assertNonNegativeInt("offset", offset);
    const sorted = [...entries].sort((left, right) =>
        left.lp - right.lp || left.institution_id.localeCompare(right.institution_id));
    const rest = sorted.slice(Math.min(offset, sorted.length));
    if (rest.length === 0 || limit <= 1) {
        return rest.length === 0 ? [] : rest.slice(0, limit);
    }
    if (rest.length <= limit) {
        return rest;
    }
    const indices = [];
    for (let i = 0; i < limit; i += 1) {
        indices.push(Math.round((i * (rest.length - 1)) / (limit - 1)));
    }
    return indices.map((index) => rest[index]);
}

function assertPositiveInt(name, value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new PilotError("invalid_configuration", `${name} must be a positive integer`, {exitCode: 2});
    }
}

function assertNonNegativeInt(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new PilotError("invalid_configuration", `${name} must be a non-negative integer`, {exitCode: 2});
    }
}

export function assertMode(mode) {
    if (!MODES.includes(mode)) {
        throw new PilotError("invalid_configuration", `mode must be one of ${MODES.join(", ")}`, {exitCode: 2});
    }
    return mode;
}

/** Bare (www-stripped) official domain used by the site: operator. */
export function officialDomain(bank) {
    const host = normalizeHost(bank.official_hosts[0] ?? "");
    return host.startsWith("www.") ? host.slice(4) : host;
}

/** Three Polish site:domain queries focused on mortgage refinancing intent. */
export function buildSearchQueries(bank) {
    const domain = officialDomain(bank);
    const site = `site:${domain}`;
    return [
        `${site} refinansowanie kredytu hipotecznego`,
        `${site} spłata kredytu hipotecznego w innym banku`,
        `${site} przeniesienie kredytu hipotecznego`
    ];
}

export function buildRequestBody(bank, {mode = DEFAULT_MODE, maxCharsTotal = DEFAULT_MAX_CHARS_TOTAL, maxCharsPerResult = DEFAULT_MAX_CHARS_PER_RESULT} = {}) {
    assertMode(mode);
    const searchQueries = buildSearchQueries(bank);
    if (searchQueries.length > MAX_QUERIES_PER_BANK) {
        throw new PilotError("invalid_configuration", `search_queries must not exceed ${MAX_QUERIES_PER_BANK}`, {exitCode: 2});
    }
    return {
        objective: `Znajdź na oficjalnej stronie ${bank.legal_name} oferty kredytu hipotecznego lub mieszkaniowego z oprocentowaniem stałym lub okresowo stałym, które umożliwiają refinansowanie albo przeniesienie kredytu hipotecznego lub mieszkaniowego z innego banku bądź spłatę takiego kredytu zaciągniętego w innym banku.`,
        search_queries: searchQueries,
        mode,
        max_chars_total: maxCharsTotal,
        advanced_settings: {
            source_policy: {
                include_domains: [officialDomain(bank)]
            },
            excerpt_settings: {
                max_chars_per_result: maxCharsPerResult
            }
        }
    };
}

export function costPerRequestUsd(mode) {
    assertMode(mode);
    return COST_PER_1000_REQUESTS_USD[mode] / 1000;
}

export function estimateCost(count, mode) {
    return Number((count * costPerRequestUsd(mode)).toFixed(6));
}

export function validateBudget(count, mode, maxCostUsd) {
    assertMode(mode);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
        throw new PilotError("invalid_configuration", "max_cost_usd must be a positive number", {exitCode: 2});
    }
    const estimate = estimateCost(count, mode);
    if (estimate > maxCostUsd) {
        throw new PilotError("budget_guard_exceeded", `estimated cost ${estimate} USD exceeds max_cost_usd ${maxCostUsd} USD`, {
            exitCode: 11,
            details: {estimated_cost_usd: estimate, max_cost_usd: maxCostUsd, request_count: count, mode}
        });
    }
    return estimate;
}

/**
 * Canonicalize a result URL: accept http and https and normalize transport to
 * https, lowercase host, strip fragment and default port (80/443), sort query
 * parameters, normalize empty path to "/". Returns {ok: false, reason} for
 * URLs that cannot be used as candidates.
 */
export function canonicalizeResultUrl(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return {ok: false, reason: "missing_url"};
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        return {ok: false, reason: "invalid_url"};
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return {ok: false, reason: "unsupported_protocol"};
    }
    if (url.username !== "" || url.password !== "") {
        return {ok: false, reason: "url_with_credentials"};
    }
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    if (url.port === "443" || url.port === "80") {
        url.port = "";
    }
    url.hash = "";
    const parameters = [...url.searchParams.entries()]
        .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = "";
    for (const [key, parameter] of parameters) {
        url.searchParams.append(key, parameter);
    }
    if (url.pathname === "") {
        url.pathname = "/";
    }
    return {ok: true, url: url.toString(), host: url.hostname};
}

/**
 * Canonical identity shared by Search (candidate dedupe) and Extract
 * (result mapping): bare (www-stripped) host, default-port-normalized,
 * percent-decoded path segments, trailing slash stripped, fragment ignored,
 * sorted query parameters. http and https URLs with the same identity are
 * equal. Returns null for unparseable URLs.
 */
export function canonicalIdentity(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    const bare = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
    let pathname = parsed.pathname
        .split("/")
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .join("/");
    if (pathname.length > 1 && pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
    }
    const parameters = [...parsed.searchParams.entries()]
        .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
    return `${bare}${pathname}?${parameters}`;
}

/**
 * Host equivalence for official and allowed redirect hosts, including
 * www/non-www variants (mirrors the skill's hostAllowed semantics).
 */
export function hostAllowed(host, bank) {
    const allowed = new Set([
        ...(bank.official_hosts ?? []),
        ...(bank.allowed_redirect_hosts ?? [])
    ].flatMap(hostVariants));
    return allowed.has(String(host).toLowerCase());
}

function hostVariants(host) {
    const normalized = normalizeHost(host);
    if (!normalized) return [];
    if (!isDomainLike(normalized)) return [normalized];
    const bare = normalized.startsWith("www.") ? normalized.slice(4) : normalized;
    return [...new Set([normalized, bare, `www.${bare}`])];
}

/** Read and normalize a registry from a JSON file or an already parsed object. */
export function loadRegistry(input) {
    const value = typeof input === "string"
        ? readJsonFile(input, "registry")
        : input;
    return normalizeRegistry(value);
}

export function readJsonFile(filePath, label = path.basename(filePath)) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new PilotError("invalid_registry", `${label} cannot be read as JSON`, {
            exitCode: 10,
            details: {path: filePath},
            cause: error
        });
    }
}

/**
 * Execute the pilot. `fetchImpl` is injectable for tests; defaults to the
 * Node 22 global fetch. Dry-run never touches the network and never requires
 * an API key.
 */
export async function runPilot(options) {
    const {
        registryPath = null,
        registry = undefined,
        limit = DEFAULT_LIMIT,
        offset = DEFAULT_OFFSET,
        concurrency = DEFAULT_CONCURRENCY,
        mode = DEFAULT_MODE,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxCostUsd = DEFAULT_MAX_COST_USD,
        dryRun = false,
        apiKey = undefined,
        fetchImpl = globalThis.fetch
    } = options ?? {};
    assertMode(mode);
    assertPositiveInt("concurrency", concurrency);
    assertPositiveInt("timeout_ms", timeoutMs);

    const entries = loadRegistry(registry ?? registryPath);
    const eligible = eligibleEntries(entries);
    const sample = selectSample(eligible, {limit, offset});
    if (sample.length === 0) {
        throw new PilotError("empty_sample", "no active institutions with a usable official domain after applying limit/offset", {
            exitCode: 12,
            details: {registry_path: registryPath, limit, offset, eligible_count: eligible.length}
        });
    }

    const estimatedCostUsd = estimateCost(sample.length, mode);
    validateBudget(sample.length, mode, maxCostUsd);

    if (!dryRun && (typeof apiKey !== "string" || apiKey.trim() === "")) {
        throw new PilotError("missing_api_key", "PARALLEL_API_KEY is required for a live run", {exitCode: 20});
    }

    const bankResults = dryRun
        ? sample.map((bank) => runBankDry(bank, {mode}))
        : await runBankPool(sample, {concurrency, mode, timeoutMs, apiKey, fetchImpl});

    return buildReport({
        registryPath,
        entries,
        eligible,
        sample,
        bankResults,
        mode,
        limit,
        offset,
        concurrency,
        timeoutMs,
        maxCostUsd,
        estimatedCostUsd,
        dryRun
    });
}

function runBankDry(bank, {mode}) {
    return {
        bank: bankRecord(bank),
        status: "dry_run",
        http_status: null,
        latency_ms: 0,
        search_id: null,
        queries: buildSearchQueries(bank),
        raw_result_count: 0,
        official_result_count: 0,
        duplicate_count: 0,
        rejected_count: 0,
        rejections: [],
        candidates: []
    };
}

async function runBankPool(items, {concurrency, mode, timeoutMs, apiKey, fetchImpl}) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await runBankLive(items[index], {mode, timeoutMs, apiKey, fetchImpl});
        }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
    return results;
}

async function runBankLive(bank, {mode, timeoutMs, apiKey, fetchImpl}) {
    const body = buildRequestBody(bank, {mode});
    const startedAt = Date.now();
    let response;
    try {
        response = await fetchImpl(ENDPOINT, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": apiKey
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return {
            bank: bankRecord(bank),
            status: "error",
            http_status: null,
            latency_ms: latencyMs,
            search_id: null,
            queries: buildSearchQueries(bank),
            error: {
                code: timedOut ? "request_timeout" : "network_error",
                message: String(error?.message ?? error).slice(0, 512)
            }
        };
    }
    const latencyMs = Date.now() - startedAt;
    const text = await response.text().catch(() => "");
    if (!response.ok) {
        return {
            bank: bankRecord(bank),
            status: "error",
            http_status: response.status,
            latency_ms: latencyMs,
            search_id: null,
            queries: buildSearchQueries(bank),
            error: {
                code: "http_error",
                message: `HTTP ${response.status}: ${text.trim().slice(0, 512)}`
            }
        };
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return {
            bank: bankRecord(bank),
            status: "error",
            http_status: response.status,
            latency_ms: latencyMs,
            search_id: null,
            queries: buildSearchQueries(bank),
            error: {code: "invalid_json_response", message: "response body is not valid JSON"}
        };
    }
    return analyzeResults(bank, payload, {latencyMs, httpStatus: response.status});
}

function analyzeResults(bank, payload, {latencyMs, httpStatus}) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const queries = buildSearchQueries(bank);
    const seen = new Set();
    const candidates = [];
    const rejections = [];
    let duplicateCount = 0;
    let officialCount = 0;
    for (const result of results) {
        const rawUrl = result?.url;
        const canonical = canonicalizeResultUrl(rawUrl);
        if (!canonical.ok) {
            rejections.push({url: typeof rawUrl === "string" ? rawUrl : null, reason: canonical.reason});
            continue;
        }
        if (!hostAllowed(canonical.host, bank)) {
            rejections.push({url: canonical.url, reason: "cross_host_url"});
            continue;
        }
        const identity = canonicalIdentity(canonical.url);
        if (seen.has(identity)) {
            duplicateCount += 1;
            rejections.push({url: canonical.url, reason: "duplicate_canonical_identity"});
            continue;
        }
        seen.add(identity);
        officialCount += 1;
        candidates.push({
            domain_match: true,
            canonical_url: canonical.url,
            title: typeof result?.title === "string" ? result.title : null,
            publish_date: typeof result?.publish_date === "string" ? result.publish_date : null,
            excerpts: Array.isArray(result?.excerpts) ? result.excerpts : []
        });
    }
    const record = {
        bank: bankRecord(bank),
        status: "ok",
        http_status: httpStatus,
        latency_ms: latencyMs,
        search_id: typeof payload?.search_id === "string" ? payload.search_id : null,
        queries,
        raw_result_count: results.length,
        official_result_count: officialCount,
        duplicate_count: duplicateCount,
        rejected_count: rejections.length,
        rejections,
        candidates
    };
    if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) {
        record.warnings = payload.warnings;
    }
    return record;
}

function bankRecord(bank) {
    return {
        institution_id: bank.institution_id,
        lp: bank.lp,
        legal_name: bank.legal_name,
        official_hosts: [...bank.official_hosts],
        allowed_redirect_hosts: [...bank.allowed_redirect_hosts]
    };
}

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    return sorted[Math.round(p * (sorted.length - 1))];
}

export function buildReport({registryPath, entries, eligible, sample, bankResults, mode, limit, offset, concurrency, timeoutMs, maxCostUsd, estimatedCostUsd, dryRun}) {
    const latencies = bankResults
        .filter((record) => record.status === "ok" && Number.isFinite(record.latency_ms))
        .map((record) => record.latency_ms)
        .sort((left, right) => left - right);
    const statusCounts = {};
    for (const record of bankResults) {
        statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
    }
    const totals = bankResults.reduce((acc, record) => {
        acc.raw += Number(record.raw_result_count ?? 0);
        acc.official += Number(record.official_result_count ?? 0);
        acc.duplicate += Number(record.duplicate_count ?? 0);
        acc.rejected += Number(record.rejected_count ?? 0);
        return acc;
    }, {raw: 0, official: 0, duplicate: 0, rejected: 0});
    return {
        schema_version: REPORT_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        provider: "parallel",
        endpoint: ENDPOINT,
        mode,
        input_registry: {
            path: registryPath,
            institution_count: entries.length,
            eligible_count: eligible.length
        },
        sample: {
            strategy: SAMPLE_STRATEGY,
            limit,
            offset,
            count: bankResults.length,
            selected_lp: bankResults.map((record) => record.bank.lp)
        },
        request_budget: {
            max_requests_per_bank: 1,
            concurrency,
            timeout_ms: timeoutMs,
            max_cost_usd: maxCostUsd,
            estimated_cost_usd: estimatedCostUsd,
            cost_per_1000_requests_usd: COST_PER_1000_REQUESTS_USD
        },
        dry_run: dryRun,
        banks: bankResults,
        summary: {
            status_counts: statusCounts,
            request_count: dryRun ? 0 : bankResults.length,
            raw_result_count: totals.raw,
            official_result_count: totals.official,
            duplicate_count: totals.duplicate,
            rejected_count: totals.rejected,
            p50_latency_ms: percentile(latencies, 0.5),
            p95_latency_ms: percentile(latencies, 0.95)
        }
    };
}

export function parseArgs(argv, {valueOptions, flagOptions, required = []}) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) {
            throw new PilotError("invalid_invocation", `unexpected argument ${token}`, {exitCode: 2});
        }
        const name = token.slice(2);
        if (flagOptions.has(name)) {
            if (Object.hasOwn(result, name)) {
                throw new PilotError("invalid_invocation", `option --${name} was provided twice`, {exitCode: 2});
            }
            result[name] = true;
            continue;
        }
        if (!valueOptions.has(name)) {
            throw new PilotError("invalid_invocation", `unknown option --${name}`, {exitCode: 2});
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new PilotError("invalid_invocation", `option --${name} requires a value`, {exitCode: 2});
        }
        if (Object.hasOwn(result, name)) {
            throw new PilotError("invalid_invocation", `option --${name} was provided twice`, {exitCode: 2});
        }
        result[name] = value;
        index += 1;
    }
    for (const name of required) {
        if (!result[name]) {
            throw new PilotError("invalid_invocation", `--${name} is required`, {exitCode: 2});
        }
    }
    return result;
}

export function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", flag: "wx", mode: 0o600});
        fs.renameSync(temporary, filePath);
    } catch (error) {
        try { fs.rmSync(temporary, {force: true}); } catch { /* best effort */ }
        throw new PilotError("publication_io_failure", `atomic write failed for ${filePath}`, {exitCode: 30, cause: error});
    }
}

export function parsePositiveInt(name, value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new PilotError("invalid_invocation", `--${name} must be a positive integer`, {exitCode: 2});
    }
    return parsed;
}

export function parseNonNegativeInt(name, value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new PilotError("invalid_invocation", `--${name} must be a non-negative integer`, {exitCode: 2});
    }
    return parsed;
}

export function parsePositiveNumber(name, value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new PilotError("invalid_invocation", `--${name} must be a positive number`, {exitCode: 2});
    }
    return parsed;
}
