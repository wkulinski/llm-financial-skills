import fs from "node:fs";
import path from "node:path";

import {canonicalJson, sha256Hex} from "./canonical-json.mjs";
import {validateSourceArtifact} from "./run-contract-validate.mjs";
import {
    artifactId,
    atomicWriteBuffer,
    atomicWriteJson,
    bodyBuffer,
    canonicalizeUrl,
    hostAllowed,
    isPlainObject,
    makeTelemetryOperation,
    readJsonIfExists,
    ResearchError,
    runLocalPath,
    recordResearchTelemetry
} from "./research-runtime.mjs";

export const RETRYABLE_STATUS = (status) => status === 429 || status >= 500;

/**
 * Execute fixture-backed fetches for one exact-scope entry. The function never
 * opens a network connection; all response attempts come from the fixture.
 */
export async function fetchEntrySources({run, fixtureEntry, registryEntry, discovery, observationTime}) {
    const startedAt = Date.now();
    const maxAttempts = run.manifest.resource_policy.max_attempts;
    const maxBytes = run.manifest.resource_policy.max_source_bytes_per_institution;
    const sourceIndex = indexSources(fixtureEntry.sources ?? fixtureEntry.source_artifacts ?? []);
    const artifacts = [];
    const skipped = [];
    const errors = [];
    const metrics = {
        requests: {total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0},
        cache: {misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0},
        bytes: {downloaded: 0, reused_from_cache: 0},
        retryableErrorCount: 0,
        technicalErrorCount: 0,
        errorCount: 0,
        attempts: 1,
        retryAfterMs: 0
    };
    let totalBytes = 0;

    for (const candidate of discovery.candidates) {
        const entryCandidate = {...candidate, entry_id: fixtureEntry.entry_id};
        const source = sourceIndex.get(candidate.url);
        if (!source) {
            const missing = {
                url: candidate.url,
                outcome: "source_unavailable",
                required: candidate.required
            };
            skipped.push(missing);
            if (candidate.required) {
                errors.push({code: "required_source_unavailable", message: `fixture has no response for ${candidate.url}`});
            }
            continue;
        }
        const result = await fetchCandidate({
            run,
            source,
            candidate: entryCandidate,
            registryEntry,
            robots: discovery.robots,
            observationTime,
            maxAttempts,
            maxBytes: Math.min(maxBytes, maxBytes - totalBytes)
        });
        metrics.requests.total += result.metrics.requests.total;
        metrics.requests.retried += result.metrics.requests.retried;
        metrics.requests.timeouts += result.metrics.requests.timeouts;
        metrics.requests.http_429 += result.metrics.requests.http_429;
        metrics.requests.http_5xx += result.metrics.requests.http_5xx;
        metrics.cache.misses += result.metrics.cache.misses;
        metrics.cache.revalidated_not_modified += result.metrics.cache.revalidated_not_modified;
        metrics.cache.refetched += result.metrics.cache.refetched;
        metrics.bytes.downloaded += result.metrics.bytes.downloaded;
        metrics.bytes.reused_from_cache += result.metrics.bytes.reused_from_cache;
        metrics.retryableErrorCount += result.metrics.retryableErrorCount;
        metrics.errorCount += result.metrics.errorCount;
        metrics.attempts = Math.max(metrics.attempts, result.metrics.attempts);
        metrics.retryAfterMs = Math.max(metrics.retryAfterMs, result.metrics.retryAfterMs);
        if (result.artifact) {
            totalBytes += result.artifact.raw_content_bytes;
            artifacts.push(result.artifact);
        }
        if (result.skipped) skipped.push(result.skipped);
        if (result.error) errors.push(result.error);
    }

    const technicalError = errors.find((error) => error.required !== false);
    if (technicalError) {
        metrics.technicalErrorCount = 1;
    }
    metrics.cache.hit_rate = metrics.cache.misses + metrics.cache.revalidated_not_modified + metrics.cache.refetched === 0
        ? 0
        : metrics.cache.revalidated_not_modified / (metrics.cache.misses + metrics.cache.revalidated_not_modified + metrics.cache.refetched);
    const summary = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        entry_id: fixtureEntry.entry_id,
        institution_id: fixtureEntry.institution_id ?? registryEntry.institution_id,
        observed_at: observationTime,
        discovery_artifact_id: discovery.artifact_id,
        source_artifacts: artifacts.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
        skipped: skipped.sort((left, right) => left.url.localeCompare(right.url)),
        errors: errors.sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message)),
        stats: {
            source_count: artifacts.length,
            skipped_count: skipped.length,
            error_count: errors.length,
            total_bytes: totalBytes,
            elapsed_ms: Math.max(0, Date.now() - startedAt)
        },
        metrics
    };
    const summaryArtifactId = artifactId("fch", {
        entry_id: summary.entry_id,
        discovery_artifact_id: summary.discovery_artifact_id,
        source_artifacts: summary.source_artifacts.map((artifact) => artifact.artifact_id),
        skipped: summary.skipped,
        errors: summary.errors
    });
    summary.artifact_id = summaryArtifactId;
    return {
        summary,
        artifactId: summaryArtifactId,
        artifacts,
        technicalError,
        metrics: makeTelemetryOperation({
            operationId: `fetch:${run.manifest.run_id}:${summary.entry_id}`,
            stage: "fetched",
            entry: {entry_id: summary.entry_id, institution_id: summary.institution_id},
            durationMs: summary.stats.elapsed_ms,
            requests: metrics.requests,
            cache: metrics.cache,
            bytes: metrics.bytes,
            attempts: metrics.attempts,
            errorCount: metrics.errorCount,
            retryableErrorCount: metrics.retryableErrorCount,
            technicalErrorCount: metrics.technicalErrorCount,
            errorCode: technicalError?.code ?? null
        }),
        retryAfterMs: metrics.retryAfterMs
    };
}

export function sourceArtifactPath(run, entryId, artifactIdValue) {
    return path.resolve(run.cwd, run.context.artifact_root, "sources", entryId, `${artifactIdValue}.bin`);
}

export function sourceMetadataPath(run, entryId, artifactIdValue) {
    return path.resolve(run.cwd, run.context.artifact_root, "sources", entryId, `${artifactIdValue}.json`);
}

async function fetchCandidate({run, source, candidate, registryEntry, robots, observationTime, maxAttempts, maxBytes}) {
    const sourceUrl = canonicalizeUrl(source.url ?? candidate.url);
    if (sourceUrl !== candidate.url) {
        return {error: {code: "official_host_violation", message: `fixture source URL does not match candidate ${candidate.url}`, required: candidate.required}, metrics: emptyCandidateMetrics()};
    }
    const responses = responseSequence(source);
    const metrics = emptyCandidateMetrics();
    let lastResponse = null;
    let lastError = null;
    for (let index = 0; index < maxAttempts; index += 1) {
        const response = responses[Math.min(index, responses.length - 1)];
        metrics.requests.total += 1;
        metrics.attempts = index + 1;
        lastResponse = response;
        if (response.timeout === true) {
            metrics.requests.timeouts += 1;
            metrics.retryableErrorCount += 1;
            metrics.requests.retried += index > 0 ? 0 : 1;
            lastError = {code: "request_timeout_after_retries", message: `timeout fetching ${candidate.url}`, required: candidate.required};
            if (index + 1 < maxAttempts) continue;
            break;
        }
        const status = Number(response.status ?? 200);
        if (status === 429) metrics.requests.http_429 += 1;
        if (status >= 500) metrics.requests.http_5xx += 1;
        if (RETRYABLE_STATUS(status)) {
            metrics.retryableErrorCount += 1;
            if (index + 1 < maxAttempts) {
                metrics.requests.retried += 1;
                metrics.retryAfterMs = Math.max(metrics.retryAfterMs, retryAfterMs(response.headers));
                continue;
            }
            lastError = {code: "required_source_unavailable", message: `retry budget exhausted for ${candidate.url} after HTTP ${status}`, required: candidate.required};
            break;
        }
        if (status === 404) {
            if (candidate.required) {
                lastError = {code: "required_source_unavailable", message: `required candidate ${candidate.url} returned HTTP 404`, required: true};
                break;
            }
            return {
                skipped: {url: candidate.url, outcome: "candidate_not_found", status, required: candidate.required},
                metrics
            };
        }
        if (status === 401 || status === 403) {
            lastError = {code: "required_source_unavailable", message: `HTTP ${status} denied ${candidate.url}`, required: candidate.required};
            break;
        }
        if (status === 304 || (status >= 200 && status < 300)) {
            try {
                const artifact = materializeArtifact({
                    run,
                    candidate,
                    response,
                    registryEntry,
                    robots,
                    observationTime,
                    maxBytes,
                    status,
                    metrics
                });
                return {artifact, metrics};
            } catch (error) {
                if (error instanceof ResearchError) {
                    lastError = {code: error.code, message: error.message, required: candidate.required};
                    break;
                }
                throw error;
            }
        }
        lastError = {code: "required_source_unavailable", message: `unsupported HTTP status ${status} for ${candidate.url}`, required: candidate.required};
        break;
    }
    metrics.errorCount += lastError ? 1 : 0;
    return {error: lastError ?? {code: "required_source_unavailable", message: `no response for ${candidate.url}`, required: candidate.required}, metrics};
}

export function materializeArtifact({run, candidate, response, registryEntry, robots, observationTime, maxBytes, status, metrics}) {
    const redirectChain = Array.isArray(response.redirect_chain) ? response.redirect_chain.map(canonicalizeUrl) : candidate.redirect_chain;
    if (!hostAllowed(candidate.url, registryEntry, {redirectChain})) {
        throw new ResearchError("official_host_violation", `redirect chain leaves the official allowlist for ${candidate.url}`, {exitCode: 20});
    }
    const headers = normalizeHeaders(response.headers);
    const cacheKey = sha256Hex(canonicalJson({
        url: candidate.url,
        etag: headers.etag ?? null,
        last_modified: headers["last-modified"] ?? null,
        vary: headers.vary ?? null
    }));
    const cacheDirectory = path.resolve(run.cwd, run.context.transport_cache_root, cacheKey);
    const cacheBodyPath = path.join(cacheDirectory, "body.bin");
    const cacheMetadataPath = path.join(cacheDirectory, "metadata.json");
    const cachedMetadata = readJsonIfExists(cacheMetadataPath);
    let body;
    let cacheStatus;
    let cacheLineage;
    let contentType = headers["content-type"] ?? response.content_type ?? "text/html; charset=utf-8";
    let contentEncoding = headers["content-encoding"] ?? response.content_encoding ?? "utf-8";
    if (status === 304) {
        if (!cachedMetadata || !fs.existsSync(cacheBodyPath)) {
            throw new ResearchError("required_source_unavailable", `HTTP 304 has no revalidatable transport cache for ${candidate.url}`, {exitCode: 20});
        }
        body = fs.readFileSync(cacheBodyPath);
        if (body.length > Math.min(
            String(contentType).toLowerCase().includes("pdf")
                ? run.manifest.resource_policy.max_artifact_pdf_bytes
                : run.manifest.resource_policy.max_artifact_html_bytes,
            maxBytes
        )) {
            throw new ResearchError("required_source_unavailable", `revalidated source exceeds the configured byte limit for ${candidate.url}`, {exitCode: 20});
        }
        contentType = cachedMetadata.content_type;
        contentEncoding = cachedMetadata.content_encoding;
        cacheStatus = "revalidated";
        cacheLineage = {
            origin: "revalidated_transport_cache",
            etag: headers.etag ?? cachedMetadata.etag ?? null,
            last_modified: headers["last-modified"] ?? cachedMetadata.last_modified ?? null,
            vary: headers.vary ?? cachedMetadata.vary ?? null,
            revalidated_at: observationTime
        };
        metrics.cache.revalidated_not_modified += 1;
        metrics.bytes.reused_from_cache += body.length;
    } else {
        body = bodyBuffer(response);
        const byteLimit = String(contentType).toLowerCase().includes("pdf")
            ? run.manifest.resource_policy.max_artifact_pdf_bytes
            : run.manifest.resource_policy.max_artifact_html_bytes;
        if (body.length > Math.min(byteLimit, maxBytes)) {
            throw new ResearchError("required_source_unavailable", `source exceeds the configured byte limit for ${candidate.url}`, {exitCode: 20});
        }
        const cacheExists = Boolean(cachedMetadata && fs.existsSync(cacheBodyPath));
        cacheStatus = cacheExists ? "refetched" : "miss";
        cacheLineage = {
            origin: "network",
            etag: headers.etag ?? null,
            last_modified: headers["last-modified"] ?? null,
            vary: headers.vary ?? null,
            revalidated_at: null
        };
        atomicWriteBuffer(cacheBodyPath, body);
        atomicWriteJson(cacheMetadataPath, {
            url: candidate.url,
            content_type: contentType,
            content_encoding: contentEncoding,
            etag: cacheLineage.etag,
            last_modified: cacheLineage.last_modified,
            vary: cacheLineage.vary,
            raw_content_sha256: sha256Hex(body),
            raw_content_bytes: body.length
        });
        if (cacheStatus === "miss") metrics.cache.misses += 1;
        if (cacheStatus === "refetched") metrics.cache.refetched += 1;
        metrics.bytes.downloaded += body.length;
    }
    const rawContentSha256 = sha256Hex(body);
    const artifact = artifactId("src", {
        run_id: run.manifest.run_id,
        entry_id: candidate.entry_id ?? null,
        url: candidate.url,
        raw_content_sha256: rawContentSha256,
        attempt: metrics.attempts,
        cache_status: cacheStatus
    });
    const binaryPath = sourceArtifactPath(run, candidate.entry_id, artifact);
    const metadataPath = sourceMetadataPath(run, candidate.entry_id, artifact);
    atomicWriteBuffer(binaryPath, body);
    const record = {
        schema_version: "1.0.0",
        artifact_id: artifact,
        run_id: run.manifest.run_id,
        entry_id: candidate.entry_id,
        canonical_url: candidate.url,
        source_type: candidate.source_type,
        fetched_at: observationTime,
        raw_content_sha256: rawContentSha256,
        raw_content_bytes: body.length,
        content_type: contentType,
        content_encoding: contentEncoding,
        http_status: status,
        redirect_chain: redirectChain,
        request_response_metadata_sha256: sha256Hex(canonicalJson({
            method: "GET",
            url: candidate.url,
            request_headers: {"user-agent": "mortgage-refinancing-scan/1.0"},
            response_headers: headers,
            status,
            redirect_chain: redirectChain
        })),
        run_local_path: runLocalPath(run, binaryPath),
        robots_policy: {
            status: robots.status,
            robots_url: robots.robots_url ?? null,
            checked_at: robots.checked_at ?? observationTime
        },
        cache_status: cacheStatus,
        cache_key: cacheKey,
        cache_lineage: cacheLineage,
        attempt: metrics.attempts,
        retry_count: Math.max(0, metrics.attempts - 1),
        error: null
    };
    const validation = validateSourceArtifact(record, {manifest: run.manifest, context: run.context});
    if (!validation.valid) {
        throw new ResearchError("evidence_mismatch", "source artifact failed contract validation", {exitCode: 20, details: {errors: validation.errors}});
    }
    atomicWriteJson(metadataPath, record);
    return record;
}

function indexSources(sources) {
    if (!Array.isArray(sources)) {
        throw new ResearchError("schema_mismatch", "fixture sources must be an array", {exitCode: 10});
    }
    const index = new Map();
    for (const source of sources) {
        if (!isPlainObject(source) || typeof source.url !== "string") {
            throw new ResearchError("schema_mismatch", "each fixture source must contain a URL", {exitCode: 10});
        }
        const url = canonicalizeUrl(source.url);
        if (index.has(url)) {
            throw new ResearchError("schema_mismatch", `duplicate fixture source ${url}`, {exitCode: 10});
        }
        index.set(url, {...source, url});
    }
    return index;
}

function responseSequence(source) {
    const responses = source.responses ?? [source.response ?? source];
    if (!Array.isArray(responses) || responses.length === 0) {
        throw new ResearchError("schema_mismatch", `source ${source.url} must contain a response`, {exitCode: 10});
    }
    return responses;
}

export function normalizeHeaders(value) {
    if (!isPlainObject(value)) return {};
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !/authorization|cookie|set-cookie|token|secret|password/i.test(key))
        .map(([key, item]) => [key.toLowerCase(), String(item)]));
}

export function retryAfterMs(headers) {
    const normalized = normalizeHeaders(headers);
    const value = normalized["retry-after"];
    if (value === undefined) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function emptyCandidateMetrics() {
    return {
        requests: {total: 0, retried: 0, timeouts: 0, http_429: 0, http_5xx: 0, robots: 0},
        cache: {misses: 0, revalidated_not_modified: 0, refetched: 0, hit_rate: 0},
        bytes: {downloaded: 0, reused_from_cache: 0},
        retryableErrorCount: 0,
        errorCount: 0,
        attempts: 1,
        retryAfterMs: 0
    };
}
