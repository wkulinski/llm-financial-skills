import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {canonicalJson, sha256Hex} from "./canonical-json.mjs";
import {
    LifecycleError,
    loadRun,
    replayRun,
    updateEntry
} from "./run-lifecycle.mjs";

const ENTRY_ERROR_CODES = new Set([
    "required_source_unavailable",
    "request_timeout_after_retries",
    "robots_denied",
    "official_host_violation",
    "evidence_mismatch"
]);

const STAGE_ORDER = Object.freeze([
    "discovery",
    "fetched",
    "normalized",
    "evidence_ready"
]);

export class ResearchError extends Error {
    constructor(code, message, {exitCode = 20, details = undefined, cause = undefined} = {}) {
        super(message, cause === undefined ? undefined : {cause});
        this.name = "ResearchError";
        this.code = code;
        this.exitCode = exitCode;
        this.details = details;
    }
}

export {ENTRY_ERROR_CODES, STAGE_ORDER};
export {replayRun};

/**
 * Parse the deliberately small, strict CLI surface shared by research tools.
 * Unknown, duplicate and valueless options are invocation errors rather than
 * guesses about a caller's intent.
 */
export function parseArgs(argv, valueOptions, required = ["run-manifest"]) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith("--")) {
            throw new ResearchError("invalid_invocation", `unexpected argument ${token}`, {exitCode: 2});
        }
        const name = token.slice(2);
        if (!valueOptions.has(name)) {
            throw new ResearchError("invalid_invocation", `unknown option --${name}`, {exitCode: 2});
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new ResearchError("invalid_invocation", `option --${name} requires a value`, {exitCode: 2});
        }
        if (Object.hasOwn(result, name)) {
            throw new ResearchError("invalid_invocation", `option --${name} was provided twice`, {exitCode: 2});
        }
        result[name] = value;
        index += 1;
    }
    for (const name of required) {
        if (!result[name]) {
            throw new ResearchError("invalid_invocation", `--${name} is required`, {exitCode: 2});
        }
    }
    return result;
}

export function formatCliError(error) {
    return {
        error: {
            code: error?.code ?? "fatal_run_error",
            message: error?.message ?? String(error),
            ...(error?.details === undefined ? {} : {details: error.details})
        }
    };
}

export function loadResearchRun(manifestPath) {
    try {
        return loadRun(manifestPath);
    } catch (error) {
        if (error instanceof LifecycleError) {
            throw error;
        }
        throw new ResearchError("schema_mismatch", "research stage could not load the run manifest", {
            exitCode: 10,
            cause: error
        });
    }
}

export function requireOffline(run, stage) {
    if (run.manifest.live !== false) {
        throw new ResearchError(
            "live_mode_not_supported",
            `${stage} fixture mode requires manifest live=false; live transport is not implemented in Phase 3`,
            {exitCode: 20}
        );
    }
}

export function requireRunning(run, stage) {
    const projection = replayRun(run);
    if (projection.runState !== "RUNNING") {
        throw new ResearchError(
            "stage_requires_running",
            `${stage} requires a RUNNING run, got ${projection.runState}`,
            {exitCode: 10}
        );
    }
    return projection;
}

export function readJson(filePath, label = path.basename(filePath)) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw new ResearchError("invalid_json", `${label} cannot be read as JSON`, {
            exitCode: 10,
            details: {path: filePath},
            cause: error
        });
    }
}

export function readFixture(fixturePath, label = "fixture") {
    const fixture = readJson(path.resolve(fixturePath), label);
    if (!isPlainObject(fixture) || fixture.network === true || fixture.requires_network === true) {
        throw new ResearchError(
            "fixture_network_forbidden",
            `${label} must be an offline fixture and must not require network access`,
            {exitCode: 10}
        );
    }
    return fixture;
}

export function getFixtureEntries(fixture) {
    if (!Array.isArray(fixture?.entries)) {
        throw new ResearchError("fixture_entries_missing", "fixture must contain an entries array", {exitCode: 10});
    }
    return fixture.entries;
}

export function selectScopeEntries(run, entryId = undefined) {
    const entries = run.manifest.scope.entries;
    if (entryId !== undefined) {
        const entry = entries.find((candidate) => candidate.entry_id === entryId);
        if (!entry) {
            throw new ResearchError("entry_out_of_scope", `${entryId} is not part of the exact run scope`, {exitCode: 10});
        }
        return [entry];
    }
    return [...entries].sort((left, right) => left.lp - right.lp);
}

export function fixtureEntryFor(fixture, scopeEntry) {
    const matches = getFixtureEntries(fixture).filter((entry) => entry.entry_id === scopeEntry.entry_id);
    if (matches.length !== 1) {
        throw new ResearchError(
            matches.length === 0 ? "required_source_unavailable" : "schema_mismatch",
            matches.length === 0
                ? `fixture has no entry ${scopeEntry.entry_id}`
                : `fixture has duplicate entries for ${scopeEntry.entry_id}`,
            {exitCode: matches.length === 0 ? 20 : 10}
        );
    }
    const fixtureEntry = matches[0];
    if (fixtureEntry.institution_id !== undefined && fixtureEntry.institution_id !== scopeEntry.institution_id) {
        throw new ResearchError(
            "schema_mismatch",
            `fixture institution_id for ${scopeEntry.entry_id} does not match the immutable scope`,
            {exitCode: 10}
        );
    }
    return fixtureEntry;
}

export function observationTime(fixture, run) {
    const value = fixture.observed_at ?? run.manifest.created_at;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value)) {
        throw new ResearchError("schema_mismatch", "fixture observed_at must be an RFC 3339 UTC timestamp", {exitCode: 10});
    }
    return value;
}

export function canonicalizeUrl(value) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ResearchError("official_host_violation", "source URL must be a non-empty string", {exitCode: 20});
    }
    let url;
    try {
        url = new URL(value);
    } catch (error) {
        throw new ResearchError("official_host_violation", `invalid source URL ${value}`, {exitCode: 20, cause: error});
    }
    if (url.protocol !== "https:") {
        throw new ResearchError("official_host_violation", `source URL must use https: ${value}`, {exitCode: 20});
    }
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase();
    if (url.port === "443") {
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
    return url.toString();
}

export function hostAllowed(urlValue, registryEntry, {redirectChain = []} = {}) {
    const candidates = [urlValue, ...redirectChain];
    const allowed = new Set([
        ...(registryEntry?.official_hosts ?? []),
        ...(registryEntry?.allowed_redirect_hosts ?? [])
    ].flatMap(hostVariants));
    return candidates.every((value) => {
        try {
            return allowed.has(new URL(value).hostname.toLowerCase());
        } catch {
            return false;
        }
    });
}

function hostVariants(host) {
    const normalized = String(host).trim().toLowerCase().replace(/[.]$/u, "");
    if (!normalized || /^[\d.:[\]]+$/u.test(normalized)) return normalized ? [normalized] : [];
    const bare = normalized.startsWith("www.") ? normalized.slice(4) : normalized;
    return [...new Set([normalized, bare, `www.${bare}`])];
}

export function pathAllowedByRobots(urlValue, robots = {}) {
    if (robots.status === "deny") {
        return false;
    }
    const pathname = new URL(urlValue).pathname;
    const denied = (robots.denied_paths ?? []).some((prefix) => pathname.startsWith(prefix));
    if (denied) {
        return false;
    }
    if (Array.isArray(robots.allowed_paths) && robots.allowed_paths.length > 0) {
        return robots.allowed_paths.some((prefix) => pathname.startsWith(prefix));
    }
    return robots.status !== "unavailable";
}

export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function artifactId(prefix, value) {
    if (!/^[a-z]{2,8}$/.test(prefix)) {
        throw new TypeError(`invalid artifact prefix ${prefix}`);
    }
    return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 24)}`;
}

export function productId(value) {
    return `prd-${sha256Hex(canonicalJson(value)).slice(0, 24)}`;
}

export function variantId(value) {
    return `var-${sha256Hex(canonicalJson(value)).slice(0, 24)}`;
}

export function relativeRepoPath(filePath, cwd = process.cwd()) {
    return path.relative(cwd, filePath).split(path.sep).join("/");
}

export function runLocalPath(run, absolutePath) {
    const relative = relativeRepoPath(absolutePath, run.cwd);
    return relative;
}

export function atomicWriteText(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporary, content, "utf8", {flag: "wx", mode: 0o600});
        fsyncFile(temporary);
        fs.renameSync(temporary, filePath);
        fsyncDirectory(path.dirname(filePath));
    } catch (error) {
        try { fs.rmSync(temporary, {force: true}); } catch { /* best effort */ }
        throw new ResearchError("publication_io_failure", `atomic write failed for ${filePath}`, {exitCode: 30, cause: error});
    }
}

export function atomicWriteJson(filePath, value) {
    atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function atomicWriteBuffer(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporary, value, {flag: "wx", mode: 0o600});
        fsyncFile(temporary);
        fs.renameSync(temporary, filePath);
        fsyncDirectory(path.dirname(filePath));
    } catch (error) {
        try { fs.rmSync(temporary, {force: true}); } catch { /* best effort */ }
        throw new ResearchError("publication_io_failure", `atomic write failed for ${filePath}`, {exitCode: 30, cause: error});
    }
}

export function readJsonIfExists(filePath) {
    return fs.existsSync(filePath) ? readJson(filePath) : null;
}

export function bodyBuffer(response) {
    if (Buffer.isBuffer(response?.body)) {
        return response.body;
    }
    if (response?.body instanceof Uint8Array) {
        return Buffer.from(response.body);
    }
    if (typeof response?.body_base64 === "string") {
        try {
            return Buffer.from(response.body_base64, "base64");
        } catch (error) {
            throw new ResearchError("required_source_unavailable", "fixture body_base64 is invalid", {exitCode: 20, cause: error});
        }
    }
    if (typeof response?.body === "string") {
        return Buffer.from(response.body, "utf8");
    }
    if (response?.body === undefined || response?.body === null) {
        return Buffer.alloc(0);
    }
    throw new ResearchError("schema_mismatch", "fixture response body must be text or base64", {exitCode: 10});
}

export function decodeUtf8(buffer, label = "source") {
    const decoder = new TextDecoder("utf-8", {fatal: true});
    try {
        return decoder.decode(buffer);
    } catch (error) {
        throw new ResearchError("required_source_unavailable", `${label} is not valid UTF-8`, {exitCode: 20, cause: error});
    }
}

export async function extractText(value, contentType = "text/html") {
    return (await extractTextDetails(value, contentType)).text;
}

export async function extractTextDetails(value, contentType = "text/html") {
    const normalizedContentType = String(contentType).toLowerCase();
    const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    if (normalizedContentType.includes("pdf")) {
        try {
            const module = await import("pdf-parse");
            const parsePdf = module.default ?? module;
            const originalLog = console.log;
            const originalWarn = console.warn;
            const originalError = console.error;
            console.log = () => {};
            console.warn = () => {};
            console.error = () => {};
            let parsed;
            try {
                parsed = await parsePdf(buffer);
            } finally {
                console.log = originalLog;
                console.warn = originalWarn;
                console.error = originalError;
            }
            return {
                text: String(parsed.text ?? "").replace(/\s+/gu, " ").trim(),
                encoding: "pdf-text",
                extractor: "pdf-parse"
            };
        } catch (error) {
            throw new ResearchError("required_source_unavailable", "PDF text extraction failed", {exitCode: 20, cause: error});
        }
    }
    const {text, encoding} = decodeTextBuffer(buffer, normalizedContentType);
    if (normalizedContentType.includes("html")) {
        return {
            text: decodeHtmlEntities(text
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
                .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
                .replace(/<[^>]+>/g, " "))
                .replace(/\s+/gu, " ")
                .trim(),
            encoding,
            extractor: "html-text"
        };
    }
    return {text: text.replace(/\s+/gu, " ").trim(), encoding, extractor: "text"};
}

function decodeTextBuffer(buffer, contentType) {
    const declared = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/iu)?.[1]?.toLowerCase() ?? "utf-8";
    const candidates = [...new Set([normalizeCharset(declared), "utf-8", "windows-1250", "iso-8859-2"])];
    let lastError;
    for (const encoding of candidates) {
        try {
            return {text: new TextDecoder(encoding, {fatal: true}).decode(buffer), encoding};
        } catch (error) {
            lastError = error;
        }
    }
    throw new ResearchError("required_source_unavailable", "text source is not decodable with a supported charset", {exitCode: 20, cause: lastError});
}

function normalizeCharset(value) {
    const normalized = String(value).trim().toLowerCase();
    if (["utf8", "utf-8"].includes(normalized)) return "utf-8";
    if (["cp1250", "windows1250", "windows-1250"].includes(normalized)) return "windows-1250";
    if (["iso8859-2", "iso-8859-2", "latin2"].includes(normalized)) return "iso-8859-2";
    return normalized;
}

export function textLocator(text, excerpt) {
    const charStart = text.indexOf(excerpt);
    if (charStart < 0) {
        return null;
    }
    const charEnd = charStart + excerpt.length;
    const lineStart = text.slice(0, charStart).split("\n").length - 1;
    const lineEnd = text.slice(0, charEnd).split("\n").length - 1;
    return {page: null, line_start: lineStart, line_end: lineEnd, char_start: charStart, char_end: charEnd};
}

export function normalizedExcerptFromTokens(tokens, excerpt, text) {
    const locator = textLocator(text, excerpt);
    if (!locator) {
        throw new ResearchError("evidence_mismatch", "evidence excerpt is not present in the extracted source text", {exitCode: 20});
    }
    const selected = tokens.filter((token) => token.start < locator.char_end && token.end > locator.char_start);
    if (selected.length === 0) {
        throw new ResearchError("evidence_mismatch", "evidence excerpt has no normalized token span", {exitCode: 20});
    }
    return {normalizedExcerpt: selected.map((token) => token.lemma).join(" "), locator};
}

export function ensureEntryErrorCode(code) {
    if (!ENTRY_ERROR_CODES.has(code)) {
        throw new ResearchError("schema_mismatch", `${code} is not an EntryRunErrorCode`, {exitCode: 10});
    }
    return code;
}

export function updateEntryError(run, entryId, code, message, operationId, artifactIds = []) {
    ensureEntryErrorCode(code);
    const projection = replayRun(run);
    const entry = projection.entries.get(entryId);
    if (!entry) {
        throw new ResearchError("entry_out_of_scope", `${entryId} is not part of the exact run scope`, {exitCode: 10});
    }
    if (entry.stage === "technical_error") {
        return {idempotent: true, projection};
    }
    return updateEntry(run, {
        entryId,
        stage: "technical_error",
        operationId,
        entryOutcome: externalSourceErrorCodes.has(code) ? "external_source_error" : "internal_error",
        errorCode: code,
        errorMessage: String(message).slice(0, 2048),
        inputArtifactIds: artifactIds,
        outputArtifactIds: []
    });
}

const externalSourceErrorCodes = new Set([
    "required_source_unavailable",
    "request_timeout_after_retries",
    "robots_denied",
    "official_host_violation"
]);

export function writeEvidenceJsonl(filePath, records) {
    return withFileLock(`${filePath}.lock`, () => writeEvidenceJsonlUnlocked(filePath, records));
}

/** Replace one entry's evidence while holding the run-local writer lock. */
export function replaceEvidenceForEntry(filePath, entryId, records) {
    if (typeof entryId !== "string" || entryId.length === 0) {
        throw new ResearchError("schema_mismatch", "evidence entry_id is required", {exitCode: 10});
    }
    return withFileLock(`${filePath}.lock`, () => {
        const existing = readEvidenceJsonl(filePath).filter((record) => record.entry_id !== entryId);
        return writeEvidenceJsonlUnlocked(filePath, [...existing, ...records]);
    });
}

function writeEvidenceJsonlUnlocked(filePath, records) {
    const byId = new Map();
    for (const record of records) {
        const existing = byId.get(record.evidence_id);
        if (existing && canonicalJson(existing) !== canonicalJson(record)) {
            throw new ResearchError("evidence_mismatch", `evidence_id ${record.evidence_id} has conflicting records`, {exitCode: 20});
        }
        byId.set(record.evidence_id, record);
    }
    const lines = [...byId.values()]
        .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id))
        .map((record) => JSON.stringify(record));
    atomicWriteText(filePath, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

export function readEvidenceJsonl(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    const content = fs.readFileSync(filePath, "utf8");
    if (content === "") {
        return [];
    }
    if (!content.endsWith("\n")) {
        throw new ResearchError("evidence_mismatch", "evidence.jsonl is not terminated by a complete record", {exitCode: 20});
    }
    return content.trimEnd().split("\n").map((line, index) => {
        try {
            return JSON.parse(line);
        } catch (error) {
            throw new ResearchError("evidence_mismatch", `evidence.jsonl record ${index + 1} is invalid JSON`, {exitCode: 20, cause: error});
        }
    });
}

export function recordResearchTelemetry(run, operation) {
    const filePath = path.join(run.runRoot, "research-telemetry.json");
    return withFileLock(`${filePath}.lock`, () => {
        const current = readJsonIfExists(filePath) ?? {
            schema_version: "1.0.0",
            run_id: run.manifest.run_id,
            operations: []
        };
        if (current.run_id !== run.manifest.run_id || !Array.isArray(current.operations)) {
            throw new ResearchError("schema_mismatch", "research telemetry is not bound to the current run", {exitCode: 10});
        }
        const existing = current.operations.find((candidate) => candidate.operation_id === operation.operation_id);
        if (existing) {
            if (canonicalJson(existing) !== canonicalJson(operation)) {
                throw new ResearchError("schema_mismatch", `telemetry operation ${operation.operation_id} has conflicting data`, {exitCode: 10});
            }
            return buildResearchTelemetry(current);
        }
        current.operations.push(operation);
        current.operations.sort((left, right) => left.operation_id.localeCompare(right.operation_id));
        atomicWriteJson(filePath, current);
        return buildResearchTelemetry(current);
    });
}

export function buildResearchTelemetry(raw) {
    const operations = raw.operations ?? [];
    const zeroRequests = () => ({total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0});
    const zeroCache = () => ({misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0});
    const zeroBytes = () => ({downloaded: 0, reused_from_cache: 0});
    const run = {
        requests: zeroRequests(),
        cache: zeroCache(),
        bytes: zeroBytes(),
        wall_clock_ms: 0,
        retryable_error_count: 0,
        entry_technical_error_count: 0,
        entry_external_source_error_count: 0,
        entry_internal_error_count: 0,
        fatal_error_count: 0
    };
    const stages = new Map();
    const entries = new Map();
    const add = (target, source) => {
        for (const key of Object.keys(target)) {
            target[key] += Number(source?.[key] ?? 0);
        }
    };
    for (const operation of operations) {
        add(run.requests, operation.requests);
        add(run.cache, operation.cache);
        add(run.bytes, operation.bytes);
        run.wall_clock_ms += Number(operation.duration_ms ?? 0);
        run.retryable_error_count += Number(operation.retryable_error_count ?? 0);
        run.entry_technical_error_count += Number(operation.technical_error_count ?? 0);
        if (Number(operation.technical_error_count ?? 0) > 0) {
            if (externalSourceErrorCodes.has(operation.error_code)) run.entry_external_source_error_count += Number(operation.technical_error_count ?? 0);
            else run.entry_internal_error_count += Number(operation.technical_error_count ?? 0);
        }
        run.fatal_error_count += Number(operation.fatal_error_count ?? 0);
        const stage = stages.get(operation.stage) ?? {
            entry_ids: new Set(),
            wall_clock_ms: 0,
            requests: zeroRequests(),
            bytes: zeroBytes(),
            error_count: 0
        };
        stage.entry_ids.add(operation.entry_id);
        stage.wall_clock_ms += Number(operation.duration_ms ?? 0);
        add(stage.requests, operation.requests);
        add(stage.bytes, operation.bytes);
        stage.error_count += Number(operation.error_count ?? 0);
        stages.set(operation.stage, stage);
        const entry = entries.get(operation.entry_id) ?? {
            entry_id: operation.entry_id,
            institution_id: operation.institution_id,
            final_stage: operation.stage,
            attempts: 1,
            wall_clock_ms: 0,
            requests: zeroRequests(),
            cache: zeroCache(),
            bytes: zeroBytes(),
            error_code: null
        };
        entry.final_stage = stageOrder(operation.stage) >= stageOrder(entry.final_stage) ? operation.stage : entry.final_stage;
        entry.attempts = Math.max(entry.attempts, Number(operation.attempts ?? 1));
        entry.wall_clock_ms += Number(operation.duration_ms ?? 0);
        add(entry.requests, operation.requests);
        add(entry.cache, operation.cache);
        add(entry.bytes, operation.bytes);
        if (operation.error_code) entry.error_code = operation.error_code;
        entries.set(operation.entry_id, entry);
    }
    run.cache.hit_rate = run.cache.misses + run.cache.revalidated_not_modified + run.cache.refetched === 0
        ? 0
        : run.cache.revalidated_not_modified / (run.cache.misses + run.cache.revalidated_not_modified + run.cache.refetched);
    for (const entry of entries.values()) {
        entry.cache.hit_rate = entry.cache.misses + entry.cache.revalidated_not_modified + entry.cache.refetched === 0
            ? 0
            : entry.cache.revalidated_not_modified / (entry.cache.misses + entry.cache.revalidated_not_modified + entry.cache.refetched);
    }
    return {
        run,
        stages: [...stages.entries()].sort(([left], [right]) => stageOrder(left) - stageOrder(right)).map(([stage, value]) => ({
            stage,
            entry_count: value.entry_ids.size,
            wall_clock_ms: value.wall_clock_ms,
            requests: value.requests,
            bytes: value.bytes,
            error_count: value.error_count
        })),
        entries: [...entries.values()].sort((left, right) => left.entry_id.localeCompare(right.entry_id))
    };
}

export function makeTelemetryOperation({operationId, stage, entry, durationMs = 0, requests, cache, bytes, attempts = 1, errorCount = 0, retryableErrorCount = 0, technicalErrorCount = 0, fatalErrorCount = 0, errorCode = null}) {
    return {
        operation_id: operationId,
        stage,
        entry_id: entry.entry_id,
        institution_id: entry.institution_id,
        duration_ms: Math.max(0, Math.floor(durationMs)),
        attempts: Math.max(1, Math.floor(attempts)),
        requests: {...zeroRequests(), ...(requests ?? {})},
        cache: {...zeroCache(), ...(cache ?? {})},
        bytes: {...zeroBytes(), ...(bytes ?? {})},
        error_count: Math.max(0, Math.floor(errorCount)),
        retryable_error_count: Math.max(0, Math.floor(retryableErrorCount)),
        technical_error_count: Math.max(0, Math.floor(technicalErrorCount)),
        fatal_error_count: Math.max(0, Math.floor(fatalErrorCount)),
        error_code: errorCode
    };
}

function zeroRequests() {
    return {total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0};
}

function zeroCache() {
    return {misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0};
}

function zeroBytes() {
    return {downloaded: 0, reused_from_cache: 0};
}

function stageOrder(stage) {
    const index = STAGE_ORDER.indexOf(stage);
    return index < 0 ? STAGE_ORDER.length : index;
}

function decodeHtmlEntities(value) {
    return value
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function fsyncFile(filePath) {
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, "r");
        fs.fsyncSync(descriptor);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
    }
}

function fsyncDirectory(directory) {
    try {
        const descriptor = fs.openSync(directory, "r");
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    } catch {
        // Directory fsync is unavailable on some filesystems used by fixtures.
    }
}

function withFileLock(lockPath, callback) {
    const startedAt = Date.now();
    let descriptor;
    while (descriptor === undefined) {
        try {
            fs.mkdirSync(path.dirname(lockPath), {recursive: true});
            descriptor = fs.openSync(lockPath, "wx", 0o600);
        } catch (error) {
            if (error?.code !== "EEXIST") {
                throw new ResearchError("publication_io_failure", `cannot acquire run-local lock ${lockPath}`, {exitCode: 30, cause: error});
            }
            if (Date.now() - startedAt > 30_000) {
                throw new ResearchError("publication_io_failure", `timed out acquiring run-local lock ${lockPath}`, {exitCode: 30});
            }
            const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(waitBuffer, 0, 0, 5);
        }
    }
    try {
        return callback();
    } finally {
        try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, {force: true}); }
    }
}
