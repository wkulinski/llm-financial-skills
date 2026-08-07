import fs from "node:fs";
import path from "node:path";
import {setTimeout as sleepTimer} from "node:timers/promises";

import {artifactId, canonicalizeUrl, hostAllowed, makeTelemetryOperation, ResearchError, readJsonIfExists} from "./research-runtime.mjs";
import {materializeArtifact, normalizeHeaders, retryAfterMs} from "./source-fetch.mjs";

const USER_AGENT = "mortgage-refinancing-scan/1.0 (+controlled-live)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUS = (status) => status === 429 || status >= 500;
const OPTIONAL_REDIRECT_FAILURE_THRESHOLD = 2;
const ADAPTIVE_INITIAL_CANDIDATES = 8;
const ADAPTIVE_BATCH_SIZE = 8;
const DEFAULT_HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/**
 * Discover a bounded, deterministic graph from the official registry host.
 * The transport is injectable so normal tests never need network access.
 */
export async function discoverLiveEntry({
    run,
    registryEntry,
    maxRequests = 256,
    observationTime,
    fetchImpl = globalThis.fetch,
    sleep = sleepTimer,
    originDelayMs = 0
}) {
    assertFetch(fetchImpl);
    const entryId = registryEntry?.entry_id;
    const host = [...(registryEntry?.official_hosts ?? [])].sort()[0];
    if (!entryId || !host) {
        throw new ResearchError("required_source_unavailable", "registry entry has no official host", {exitCode: 20});
    }

    const baseUrl = canonicalizeUrl(`https://${host}/`);
    const requestStats = {total: 0, robots: 0, sitemap: 0, homepage: 0};
    const rejected = [];
    const rawCandidates = [];
    const robotsUrl = canonicalizeUrl(new URL("/robots.txt", baseUrl).toString());
    const throttle = createOriginThrottle(originDelayMs, sleep);
    let robots = {
        status: "unavailable",
        robots_url: robotsUrl,
        checked_at: observationTime,
        denied_paths: [],
        allowed_paths: []
    };

    let robotsResponse;
    try {
        robotsResponse = await requestLive({
            url: robotsUrl,
            registryEntry,
            run,
            maxBytes: run.manifest.resource_policy.max_artifact_html_bytes,
            timeoutMs: run.manifest.resource_policy.robots_timeout_ms,
            fetchImpl,
            sleep,
            throttle
        });
        requestStats.total += robotsResponse.request_count;
        requestStats.robots += robotsResponse.request_count;
        if (robotsResponse.status >= 200 && robotsResponse.status < 300) {
            const parsed = parseRobots(robotsResponse.body.toString("utf8"));
            robots = {
                ...robots,
                status: "allow",
                denied_paths: parsed.denied_paths,
                allowed_paths: parsed.allowed_paths,
                sitemap_urls: parsed.sitemap_urls
            };
        } else if (robotsResponse.status !== 404) {
            robots = {...robots, status: "unavailable"};
            rejected.push(rejection(robotsUrl, "required_source_unavailable", `robots.txt returned HTTP ${robotsResponse.status}; continuing without robots policy`, false));
        }
    } catch (error) {
        if (!(error instanceof ResearchError)) throw error;
        robots = {...robots, status: "unavailable"};
        rejected.push(rejection(robotsUrl, error.code, `${error.message}; continuing without robots policy`, false));
    }

    if (robots.status === "deny") {
        const result = {
            schema_version: "1.0.0",
            run_id: run.manifest.run_id,
            entry_id: entryId,
            institution_id: registryEntry.institution_id,
            observed_at: observationTime,
            robots,
            candidates: [],
            rejected: rejected.sort(compareRejections),
            outcome: "required_candidates_rejected",
            stats: {
                candidate_count: 0,
                selected_count: 0,
                rejected_count: rejected.length,
                required_rejected_count: rejected.filter((item) => item.required).length,
                deduplicated: 0,
                max_requests: maxRequests,
                requests: requestStats
            }
        };
        result.artifact_id = artifactId("dsc", {...result, run_id: null});
        return result;
    }

    const addCandidate = (urlValue, tier, source, required = false) => {
        let url;
        try {
            url = canonicalizeUrl(urlValue);
        } catch (error) {
            rejected.push(rejection(urlValue, "invalid_url", error.message, required));
            return;
        }
        const candidate = {
            url,
            tier,
            source,
            sources: [source],
            source_type: sourceTypeForUrl(url),
            required: Boolean(required),
            redirect_chain: [],
            javascript_required: false
        };
        if (!hostAllowed(url, registryEntry)) {
            rejected.push(rejection(url, "official_host_violation", "URL leaves the registry allowlist", required));
            return;
        }
        if (!isAllowedByRobots(url, robots)) {
            rejected.push(rejection(url, "robots_denied", "robots policy denied the candidate path", required));
            return;
        }
        if (url !== baseUrl && !isResearchCandidate(url)) return;
        rawCandidates.push(candidate);
    };

    const sitemapUrls = new Set([
        ...(robots.sitemap_urls ?? []),
        canonicalizeUrl(new URL("/sitemap.xml", baseUrl).toString())
    ]);
    let sitemapCandidates = 0;
    for (const sitemapUrl of [...sitemapUrls].sort()) {
        try {
            const response = await requestLive({
                url: sitemapUrl,
                registryEntry,
                run,
                maxBytes: run.manifest.resource_policy.max_artifact_html_bytes,
                timeoutMs: run.manifest.resource_policy.html_timeout_ms,
                fetchImpl,
                sleep,
                throttle
            });
            requestStats.total += response.request_count;
            requestStats.sitemap += response.request_count;
            if (response.status >= 200 && response.status < 300) {
                const locations = parseSitemap(response.body.toString("utf8"));
                for (const location of locations) {
                    addCandidate(location, 10, "sitemap", false);
                    sitemapCandidates += 1;
                }
            }
        } catch (error) {
            if (error instanceof ResearchError && error.code === "official_host_violation") {
                rejected.push(rejection(sitemapUrl, error.code, error.message, false));
                continue;
            }
            if (!(error instanceof ResearchError)) throw error;
        }
    }

    try {
        const response = await requestLive({
            url: baseUrl,
            registryEntry,
            run,
            maxBytes: run.manifest.resource_policy.max_artifact_html_bytes,
            timeoutMs: run.manifest.resource_policy.html_timeout_ms,
            fetchImpl,
            sleep,
            throttle
        });
        requestStats.total += response.request_count;
        requestStats.homepage += response.request_count;
        if (response.status >= 200 && response.status < 300) {
            addCandidate(baseUrl, 20, "official", sitemapCandidates === 0);
            for (const link of parseLinks(response.body.toString("utf8"), baseUrl)) {
                addCandidate(link, 30, "internal", false);
            }
        }
    } catch (error) {
        if (error instanceof ResearchError && error.code === "official_host_violation") {
            rejected.push(rejection(baseUrl, error.code, error.message, true));
        } else if (!(error instanceof ResearchError)) {
            throw error;
        }
    }

    const deduplicated = new Map();
    for (const candidate of rawCandidates) {
        const current = deduplicated.get(candidate.url);
        if (!current) {
            deduplicated.set(candidate.url, candidate);
            continue;
        }
        current.required ||= candidate.required;
        current.tier = Math.min(current.tier, candidate.tier);
        current.sources = [...new Set([...current.sources, ...candidate.sources])].sort();
    }
    const allCandidates = [...deduplicated.values()]
        .sort(compareCandidates)
        .map((candidate) => ({
            ...candidate,
            candidate_id: artifactId("can", {entry_id: entryId, url: candidate.url, tier: candidate.tier})
        }));
    const limited = allCandidates.slice(0, maxRequests);
    rejected.push(...allCandidates.slice(maxRequests).map((candidate) => rejection(
        candidate.url,
        "discovery_limit",
        `max_discovery_requests_per_institution=${maxRequests}`,
        candidate.required
    )));
    const requiredRejected = rejected.filter((item) => item.required);
    const outcome = limited.length > 0
        ? "candidates_found"
        : requiredRejected.length > 0
            ? "required_candidates_rejected"
            : "no_candidates";
    const result = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        entry_id: entryId,
        institution_id: registryEntry.institution_id,
        observed_at: observationTime,
        robots,
        candidates: limited,
        rejected: rejected.sort(compareRejections),
        outcome,
        stats: {
            candidate_count: allCandidates.length,
            selected_count: limited.length,
            rejected_count: rejected.length,
            required_rejected_count: requiredRejected.length,
            deduplicated: rawCandidates.length - allCandidates.length,
            max_requests: maxRequests,
            requests: requestStats
        }
    };
    result.artifact_id = artifactId("dsc", {...result, run_id: null});
    return result;
}

/**
 * Fetch live candidates and materialize the existing strict SourceArtifact
 * contract. Cache validators are sent only when a matching body is present.
 */
export async function fetchLiveEntrySources({
    run,
    entry,
    registryEntry,
    discovery,
    observationTime,
    fetchImpl = globalThis.fetch,
    sleep = sleepTimer,
    originDelayMs = 0
}) {
    assertFetch(fetchImpl);
    const startedAt = Date.now();
    const entryValue = entry ?? registryEntry;
    const maxAttempts = run.manifest.resource_policy.max_attempts;
    const maxSourceBytes = run.manifest.resource_policy.max_source_bytes_per_institution;
    const artifacts = [];
    const skipped = [];
    const errors = [];
    const metrics = emptyMetrics();
    const throttle = createOriginThrottle(originDelayMs, sleep);
    const deadlineAt = Date.now() + run.manifest.resource_policy.institution_deadline_ms;
    let totalBytes = 0;

    const rankedCandidates = rankAdaptiveCandidates(discovery.candidates ?? []);
    const requiredCount = rankedCandidates.filter((candidate) => candidate.required).length;
    const initialBatchSize = Math.max(ADAPTIVE_INITIAL_CANDIDATES, requiredCount);
    let cursor = 0;
    let rounds = 0;
    let stopReason = rankedCandidates.length === 0 ? "no_candidates" : "candidate_budget_exhausted";
    const fetchedCandidates = [];
    while (cursor < rankedCandidates.length) {
        const batchSize = rounds === 0 ? initialBatchSize : ADAPTIVE_BATCH_SIZE;
        const batch = rankedCandidates.slice(cursor, cursor + batchSize);
        cursor += batch.length;
        rounds += 1;
        let deadlineExceeded = false;
        for (const candidate of batch) {
            if (Date.now() >= deadlineAt) {
                errors.push({
                    code: "required_source_unavailable",
                    message: `institution deadline exceeded before fetching ${candidate.url}`,
                    required: candidate.required
                });
                metrics.errorCount += 1;
                deadlineExceeded = true;
                break;
            }
            const result = await fetchLiveCandidate({
                run,
                candidate: {...candidate, entry_id: entryValue.entry_id},
                registryEntry,
                robots: discovery.robots,
                observationTime,
                maxAttempts,
                maxBytes: Math.max(0, Math.min(maxSourceBytes, maxSourceBytes - totalBytes)),
                deadlineAt,
                fetchImpl,
                sleep,
                throttle
            });
            fetchedCandidates.push(candidate);
            mergeMetrics(metrics, result.metrics);
            if (result.artifact) {
                artifacts.push(result.artifact);
                totalBytes += result.artifact.raw_content_bytes;
            }
            if (result.skipped) skipped.push(result.skipped);
            if (result.error) errors.push(result.error);
        }
        if (deadlineExceeded) {
            stopReason = "institution_deadline";
            cursor = rankedCandidates.length;
            break;
        }
        const signalCoverage = sourceSignalCoverage(run, artifacts, fetchedCandidates);
        if (signalCoverage.complete_bundle) {
            stopReason = "single_source_bundle_signals_complete";
            break;
        }
        if (errors.filter((error) => error.required === false && error.code === "official_host_violation").length >= OPTIONAL_REDIRECT_FAILURE_THRESHOLD) {
            stopReason = "optional_redirect_threshold";
            break;
        }
    }
    for (const candidate of rankedCandidates.slice(cursor)) {
        skipped.push({url: candidate.url, outcome: "adaptive_deferred", required: false});
    }

    const requiredError = errors.find((error) => error.required !== false);
    const optionalRedirectFailures = errors.filter((error) => error.required === false && error.code === "official_host_violation");
    const thresholdError = optionalRedirectFailures.length >= OPTIONAL_REDIRECT_FAILURE_THRESHOLD
        ? {
            code: "official_host_violation",
            message: `${optionalRedirectFailures.length} independent optional candidates left the official host allowlist`,
            required: true
        }
        : null;
    const noUsableSourcesError = artifacts.length === 0 && (discovery.candidates ?? []).length > 0
        ? {
            code: "required_source_unavailable",
            message: "no usable source artifact remained after fetching discovered candidates",
            required: true
        }
        : null;
    const technicalError = requiredError ?? thresholdError ?? noUsableSourcesError;
    metrics.technicalErrorCount = technicalError ? 1 : 0;
    metrics.cache.hit_rate = cacheHitRate(metrics.cache);
    const summary = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        entry_id: entryValue.entry_id,
        institution_id: entryValue.institution_id ?? registryEntry.institution_id,
        observed_at: observationTime,
        discovery_artifact_id: discovery.artifact_id,
        source_artifacts: artifacts.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
        skipped: skipped.sort((left, right) => left.url.localeCompare(right.url)),
        selection: {
            policy: "adaptive-priority-v1",
            candidate_count: rankedCandidates.length,
            fetched_candidate_count: Math.min(cursor, rankedCandidates.length),
            deferred_candidate_count: Math.max(0, rankedCandidates.length - cursor),
            rounds,
            stop_reason: stopReason
        },
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
            entry: entryValue,
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

export function rankAdaptiveCandidates(candidates) {
    return [...candidates]
        .map((candidate, index) => ({candidate, index, score: candidatePriority(candidate)}))
        .sort((left, right) => right.score - left.score || Boolean(right.candidate.required) - Boolean(left.candidate.required) || left.candidate.url.localeCompare(right.candidate.url) || left.index - right.index)
        .map(({candidate}) => candidate);
}

function candidatePriority(candidate) {
    const url = String(candidate.url ?? "").toLowerCase();
    const pathScore = ["kredyt", "mieszk", "hipotec", "refinans", "spłat", "oprocent", "taryf", "ofert", "wibor", "stał"].reduce((score, term) => score + (url.includes(term) ? 8 : 0), 0);
    const lowValuePenalty = ["privacy", "polityka", "cookies", "karier", "reklamac", "rodo", "kontakt"].some((term) => url.includes(term)) ? 18 : 0;
    const pdfBonus = String(candidate.source_type ?? "").includes("pdf") ? 10 : 0;
    return (candidate.required ? 100 : 0) + pathScore + pdfBonus - lowValuePenalty;
}

function sourceSignalCoverage(run, artifacts, candidates = []) {
    const sourceTexts = [];
    for (const artifact of artifacts) {
        if (String(artifact.content_type ?? "").toLowerCase().includes("pdf")) continue;
        try {
            const text = `${artifact.canonical_url ?? ""} ${fs.readFileSync(path.resolve(run.cwd, artifact.run_local_path), "utf8")}`.toLowerCase();
            sourceTexts.push(text);
        } catch {
            // The normalization stage remains the source of truth for bytes;
            // adaptive selection only uses best-effort text signals.
        }
    }
    sourceTexts.push(...candidates.map((candidate) => candidate.url.toLowerCase()));
    return {
        complete_bundle: sourceTexts.some((text) => hasAllBundleSignals(text))
    };
}

function hasAllBundleSignals(text) {
    return /kredyt[\s\p{P}\p{S}]*mieszk|kredyt[\s\p{P}\p{S}]*hipotec/u.test(text)
        && /refinans|spłat[\s\p{P}\p{S}]*kredyt|innym[\s\p{P}\p{S}]*bank/u.test(text)
        && /oprocentowan[\s\p{P}\p{S}]*stał|stał[\s\p{P}\p{S}]*oprocent|oprocent.*stale|stale.*oprocent/u.test(text)
        && /rrso|oprocentowan[^\d]{0,32}\d[\d,.]*\s*%|nominaln[^\d]{0,32}\d[\d,.]*\s*%/u.test(text);
}

async function fetchLiveCandidate({run, candidate, registryEntry, robots, observationTime, maxAttempts, maxBytes, deadlineAt, fetchImpl, sleep, throttle}) {
    const metrics = emptyCandidateMetrics();
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (Date.now() >= deadlineAt) {
            lastError = {code: "required_source_unavailable", message: `institution deadline exceeded for ${candidate.url}`, required: candidate.required};
            break;
        }
        metrics.attempts = attempt;
        try {
            const cached = findCachedTransport(run, candidate.url);
            const response = await requestLive({
                url: candidate.url,
                registryEntry,
                run,
                maxBytes,
                timeoutMs: Math.min(
                    deadlineAt - Date.now(),
                    candidate.url.toLowerCase().endsWith(".pdf")
                    ? run.manifest.resource_policy.pdf_timeout_ms
                    : run.manifest.resource_policy.html_timeout_ms
                ),
                conditional: cached,
                fetchImpl,
                sleep,
                throttle
            });
            metrics.requests.total += response.request_count;
            const status = response.status;
            if (status === 429) metrics.requests.http_429 += 1;
            if (status >= 500) metrics.requests.http_5xx += 1;
            if (RETRYABLE_STATUS(status)) {
                metrics.retryableErrorCount += 1;
                lastError = {code: "required_source_unavailable", message: `retry budget exhausted for ${candidate.url} after HTTP ${status}`, required: candidate.required};
                if (attempt < maxAttempts) {
                    metrics.requests.retried += 1;
                    metrics.retryAfterMs = Math.max(metrics.retryAfterMs, retryAfterMs(response.headers));
                    await sleep(retryDelayMs(attempt, response.headers, run.manifest.resource_policy.retry_after_cap_ms));
                    continue;
                }
                break;
            }
            if (status === 404) {
                if (candidate.required) {
                    lastError = {code: "required_source_unavailable", message: `required candidate ${candidate.url} returned HTTP 404`, required: true};
                    break;
                }
                return {skipped: {url: candidate.url, outcome: "candidate_not_found", status, required: false}, metrics};
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
                        response: {...response, body: response.body},
                        registryEntry,
                        robots,
                        observationTime,
                        maxBytes,
                        status,
                        metrics
                    });
                    return {artifact, metrics};
                } catch (error) {
                    if (!(error instanceof ResearchError)) throw error;
                    lastError = {code: error.code, message: error.message, required: candidate.required};
                    break;
                }
            }
            lastError = {code: "required_source_unavailable", message: `unsupported HTTP status ${status} for ${candidate.url}`, required: candidate.required};
            break;
        } catch (error) {
            if (!(error instanceof ResearchError)) throw error;
            if (![
                "request_timeout_after_retries",
                "required_source_unavailable",
                "official_host_violation"
            ].includes(error.code)) throw error;
            metrics.requests.total += 1;
            if (error.code === "request_timeout_after_retries") metrics.requests.timeouts += 1;
            if (error.code !== "official_host_violation") metrics.retryableErrorCount += 1;
            lastError = {code: error.code, message: error.message, required: candidate.required};
            if (error.code === "official_host_violation") break;
            if (attempt < maxAttempts) {
                metrics.requests.retried += 1;
                await sleep(retryDelayMs(attempt, {}, run.manifest.resource_policy.retry_after_cap_ms));
                continue;
            }
            break;
        }
    }
    metrics.errorCount += lastError ? 1 : 0;
    return {error: lastError ?? {code: "required_source_unavailable", message: `no response for ${candidate.url}`, required: candidate.required}, metrics};
}

async function requestLive({url, registryEntry, run, maxBytes, timeoutMs, conditional = null, fetchImpl, sleep, throttle = null}) {
    let currentUrl = canonicalizeUrl(url);
    const redirectChain = [];
    let requestCount = 0;
    for (let redirectCount = 0; redirectCount <= run.manifest.resource_policy.max_redirects; redirectCount += 1) {
        if (!hostAllowed(currentUrl, registryEntry, {redirectChain})) {
            throw new ResearchError("official_host_violation", `request leaves the official allowlist for ${currentUrl}`, {exitCode: 20});
        }
        await throttle?.beforeRequest();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
        const headers = {
            "user-agent": USER_AGENT,
            accept: DEFAULT_HTML_ACCEPT,
            "accept-encoding": "identity"
        };
        if (conditional?.etag) headers["if-none-match"] = conditional.etag;
        if (conditional?.last_modified) headers["if-modified-since"] = conditional.last_modified;
        let response;
        requestCount += 1;
        try {
            response = await fetchImpl(currentUrl, {method: "GET", headers, redirect: "manual", signal: controller.signal});
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new ResearchError("request_timeout_after_retries", `timeout fetching ${currentUrl}`, {exitCode: 20, cause: error});
            }
            throw new ResearchError("required_source_unavailable", `request failed for ${currentUrl}: ${error.message ?? String(error)}`, {exitCode: 20, cause: error});
        } finally {
            clearTimeout(timeout);
            throttle?.afterRequest();
        }
        const headersObject = headersToObject(response.headers);
        if (REDIRECT_STATUSES.has(Number(response.status))) {
            const location = headersObject.location;
            if (!location) throw new ResearchError("required_source_unavailable", `redirect without Location for ${currentUrl}`, {exitCode: 20});
            const nextUrl = canonicalizeUrl(new URL(location, currentUrl).toString());
            redirectChain.push(nextUrl);
            if (!hostAllowed(nextUrl, registryEntry, {redirectChain})) {
                throw new ResearchError("official_host_violation", `redirect chain leaves the official allowlist for ${currentUrl}`, {exitCode: 20});
            }
            currentUrl = nextUrl;
            continue;
        }
        const contentType = headersObject["content-type"] ?? "text/html; charset=utf-8";
        const limit = Math.max(0, Math.min(maxBytes, String(contentType).toLowerCase().includes("pdf")
            ? run.manifest.resource_policy.max_artifact_pdf_bytes
            : run.manifest.resource_policy.max_artifact_html_bytes));
        const body = Number(response.status) === 304
            ? Buffer.alloc(0)
            : await readResponseBody(response, limit);
        return {
            status: Number(response.status),
            headers: headersObject,
            body,
            redirect_chain: redirectChain,
            request_count: requestCount,
            final_url: currentUrl
        };
    }
    await sleep(0);
    throw new ResearchError("required_source_unavailable", `redirect limit exceeded for ${url}`, {exitCode: 20});
}

function createOriginThrottle(delayMs, sleep) {
    if (!Number.isInteger(delayMs) || delayMs < 0) {
        throw new ResearchError("schema_mismatch", "originDelayMs must be a non-negative integer", {exitCode: 10});
    }
    let readyAt = 0;
    return {
        async beforeRequest() {
            const waitMs = Math.max(0, readyAt - Date.now());
            if (waitMs > 0) await sleep(waitMs);
        },
        afterRequest() {
            readyAt = Date.now() + delayMs;
        }
    };
}

async function readResponseBody(response, maxBytes) {
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
                    await reader.cancel();
                    throw new ResearchError("required_source_unavailable", `source exceeds the configured byte limit (${maxBytes})`, {exitCode: 20});
                }
                chunks.push(Buffer.from(value));
            }
        } finally {
            reader.releaseLock?.();
        }
        return Buffer.concat(chunks, size);
    }
    const value = response.body instanceof Buffer
        ? response.body
        : Buffer.from(await response.arrayBuffer());
    if (value.length > maxBytes) {
        throw new ResearchError("required_source_unavailable", `source exceeds the configured byte limit (${maxBytes})`, {exitCode: 20});
    }
    return value;
}

function findCachedTransport(run, url) {
    const root = path.resolve(run.cwd, run.context.transport_cache_root);
    if (!fs.existsSync(root)) return null;
    const matches = [];
    for (const item of fs.readdirSync(root, {withFileTypes: true})) {
        if (!item.isDirectory()) continue;
        const metadataPath = path.join(root, item.name, "metadata.json");
        const bodyPath = path.join(root, item.name, "body.bin");
        const metadata = readJsonIfExists(metadataPath);
        if (metadata?.url === url && fs.existsSync(bodyPath)) {
            matches.push({metadata, mtime: fs.statSync(metadataPath).mtimeMs});
        }
    }
    matches.sort((left, right) => right.mtime - left.mtime);
    return matches[0]?.metadata ?? null;
}

function parseRobots(value) {
    const denied = [];
    const allowed = [];
    const sitemapUrls = [];
    let applies = false;
    for (const rawLine of value.split(/\r?\n/u)) {
        const line = rawLine.replace(/#.*$/u, "").trim();
        if (!line) continue;
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const key = line.slice(0, separator).trim().toLowerCase();
        const item = line.slice(separator + 1).trim();
        if (key === "user-agent") {
            applies = item === "*";
        } else if (applies && key === "disallow" && item) {
            denied.push(item);
        } else if (applies && key === "allow" && item) {
            allowed.push(item);
        } else if (key === "sitemap" && item) {
            try { sitemapUrls.push(canonicalizeUrl(item)); } catch { /* invalid sitemap remains ignored */ }
        }
    }
    return {
        denied_paths: [...new Set(denied)].sort(),
        allowed_paths: [...new Set(allowed)].sort(),
        sitemap_urls: [...new Set(sitemapUrls)].sort()
    };
}

function parseSitemap(value) {
    const locations = [];
    const tagged = /<loc\b[^>]*>([\s\S]*?)<\/loc>/giu;
    for (const match of value.matchAll(tagged)) {
        const location = decodeXml(match[1].trim());
        try { locations.push(canonicalizeUrl(location)); } catch { /* rejected by caller is not a candidate */ }
    }
    if (locations.length === 0) {
        for (const token of value.split(/\s+/u)) {
            if (!/^https:\/\//iu.test(token)) continue;
            try { locations.push(canonicalizeUrl(token)); } catch { /* ignore */ }
        }
    }
    return [...new Set(locations)].sort();
}

function parseLinks(value, baseUrl) {
    const links = [];
    const hrefPattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/giu;
    for (const match of value.matchAll(hrefPattern)) {
        try { links.push(canonicalizeUrl(new URL(decodeXml(match[1]), baseUrl).toString())); } catch { /* non-http or malformed */ }
    }
    return [...new Set(links)].sort();
}

function isAllowedByRobots(url, robots) {
    if (robots.status === "deny") return false;
    // Missing robots is an explicit allow-with-unavailable policy. The
    // status remains visible in every SourceArtifact for audit purposes.
    return robots.status === "unavailable" || robots.status === "allow"
        ? pathAllowedByRobotsLocal(url, robots)
        : false;
}

function pathAllowedByRobotsLocal(urlValue, robots) {
    const pathname = new URL(urlValue).pathname;
    if ((robots.denied_paths ?? []).some((prefix) => pathname.startsWith(prefix))) return false;
    if ((robots.allowed_paths ?? []).length > 0) {
        return robots.allowed_paths.some((prefix) => pathname.startsWith(prefix));
    }
    return true;
}

function sourceTypeForUrl(url) {
    return /\.pdf(?:$|[?#])/iu.test(url) ? "official_pdf" : "official_product_page";
}

function isResearchCandidate(url) {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/[.](?:css|gif|ico|jpeg|jpg|js|map|png|svg|webp|woff2?)(?:$|\/)/u.test(pathname)) return false;
    if (/\.pdf$/u.test(pathname)) return true;
    return /(kredyt|hipotec|mieszk|refinans|spłat|oferta|oprocent|finansow)/u.test(pathname);
}

function compareCandidates(left, right) {
    return left.tier - right.tier || left.url.localeCompare(right.url);
}

function compareRejections(left, right) {
    return left.url.localeCompare(right.url) || left.reason.localeCompare(right.reason);
}

function rejection(url, reason, message, required = false) {
    return {url: typeof url === "string" ? url : String(url), reason, message, required: Boolean(required)};
}

function headersToObject(headers) {
    if (!headers) return {};
    if (typeof headers.entries === "function") return Object.fromEntries(headers.entries());
    return normalizeHeaders(headers);
}

function decodeXml(value) {
    return value
        .replace(/&amp;/giu, "&")
        .replace(/&lt;/giu, "<")
        .replace(/&gt;/giu, ">")
        .replace(/&quot;/giu, '"')
        .replace(/&#39;/giu, "'");
}

function assertFetch(fetchImpl) {
    if (typeof fetchImpl !== "function") {
        throw new ResearchError("dependency_missing", "live mode requires a fetch implementation", {exitCode: 20});
    }
}

function retryDelayMs(attempt, headers, cap) {
    const retryAfter = retryAfterMs(headers);
    if (retryAfter > 0) return Math.min(cap, retryAfter);
    return Math.min(cap, attempt === 1 ? 1000 : 5000);
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

function emptyMetrics() {
    return emptyCandidateMetrics();
}

function mergeMetrics(target, source) {
    for (const key of Object.keys(target.requests)) target.requests[key] += Number(source.requests?.[key] ?? 0);
    for (const key of ["misses", "revalidated_not_modified", "refetched"]) target.cache[key] += Number(source.cache?.[key] ?? 0);
    for (const key of Object.keys(target.bytes)) target.bytes[key] += Number(source.bytes?.[key] ?? 0);
    for (const key of ["retryableErrorCount", "errorCount"]) target[key] += Number(source[key] ?? 0);
    target.attempts = Math.max(target.attempts, Number(source.attempts ?? 1));
    target.retryAfterMs = Math.max(target.retryAfterMs, Number(source.retryAfterMs ?? 0));
}

function cacheHitRate(cache) {
    const total = cache.misses + cache.revalidated_not_modified + cache.refetched;
    return total === 0 ? 0 : cache.revalidated_not_modified / total;
}
