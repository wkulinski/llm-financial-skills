import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";

import {canonicalJson, sha256Hex} from "./canonical-json.mjs";
import {
    artifactId,
    atomicWriteJson,
    extractTextDetails,
    makeTelemetryOperation,
    readJsonIfExists,
    ResearchError,
    runLocalPath
} from "./research-runtime.mjs";

const DEFAULT_POLICY = "utf8-text-v2";
const DEFAULT_LOCALE = "C.UTF-8";
const FIXTURE_VERSION = "2.1.0-fixture";

/**
 * Normalize all source artifacts for an entry. The default engine is an
 * explicit Morfeusz 2 worker. The fixture engine is available only when the
 * caller opts into offline test mode; it is not a production fallback.
 */
export async function normalizeEntrySources({run, fixtureEntry, fetchSummary, observationTime, engine = "morfeusz2", workerPath = undefined, pythonCommand = "python3"}) {
    const startedAt = Date.now();
    const engineInfo = await preflightMorfeusz({engine, workerPath, pythonCommand});
    const artifacts = [];
    let downloadedBytes = 0;
    for (const sourceArtifact of fetchSummary.source_artifacts) {
        const binaryPath = path.resolve(run.cwd, sourceArtifact.run_local_path);
        let content;
        try {
            content = fs.readFileSync(binaryPath);
        } catch (error) {
            throw new ResearchError("required_source_unavailable", `source artifact ${sourceArtifact.artifact_id} cannot be read`, {exitCode: 20, cause: error});
        }
        if (sha256Hex(content) !== sourceArtifact.raw_content_sha256) {
            throw new ResearchError("evidence_mismatch", `source artifact ${sourceArtifact.artifact_id} content hash mismatch`, {exitCode: 20});
        }
        downloadedBytes += content.length;
        const extracted = await extractTextDetails(content, sourceArtifact.content_type);
        const extractedText = extracted.text;
        const normalized = await normalizeText(extractedText, {
            engine,
            engineVersion: engineInfo.version,
            workerPath,
            pythonCommand
        });
        const cacheKey = sha256Hex(canonicalJson({
            content_sha256: sourceArtifact.raw_content_sha256,
            normalization_version: normalized.normalization_version,
            locale: DEFAULT_LOCALE,
            policy: DEFAULT_POLICY
        }));
        const cachePath = path.resolve(run.cwd, run.context.normalization_cache_root, `${cacheKey}.json`);
        const cached = readJsonIfExists(cachePath);
        const cacheHit = Boolean(cached
            && cached.cache_key === cacheKey
            && cached.normalization_version === normalized.normalization_version
            && validateNormalizationArtifact(cached, {contentSha256: sourceArtifact.raw_content_sha256}));
        const payload = cacheHit ? cached : {
            schema_version: "1.0.0",
            content_sha256: sourceArtifact.raw_content_sha256,
            source_artifact_id: null,
            normalization_version: normalized.normalization_version,
            locale: DEFAULT_LOCALE,
            policy: DEFAULT_POLICY,
            extraction_backend: extracted.extractor,
            text_encoding: extracted.encoding,
            extracted_text: extractedText,
            tokens: normalized.tokens,
            normalized_text: normalized.tokens.map((token) => token.lemma).join(" "),
            cache_key: cacheKey
        };
        if (!cacheHit) {
            atomicWriteJson(cachePath, payload);
        }
        const normalizationArtifactId = artifactId("nrm", {
            run_id: run.manifest.run_id,
            entry_id: fixtureEntry.entry_id,
            source_artifact_id: sourceArtifact.artifact_id,
            cache_key: cacheKey
        });
        const runPayload = {
            ...payload,
            run_id: run.manifest.run_id,
            entry_id: fixtureEntry.entry_id,
            source_artifact_id: sourceArtifact.artifact_id,
            normalization_id: normalizationArtifactId,
            cache_status: cacheHit ? "hit" : "miss",
            observed_at: observationTime
        };
        validateNormalizationArtifact(runPayload, {
            contentSha256: sourceArtifact.raw_content_sha256,
            runId: run.manifest.run_id,
            entryId: fixtureEntry.entry_id,
            sourceArtifactId: sourceArtifact.artifact_id
        });
        const runPath = path.resolve(run.cwd, run.context.artifact_root, "normalization", fixtureEntry.entry_id, `${normalizationArtifactId}.json`);
        atomicWriteJson(runPath, runPayload);
        artifacts.push({
            artifact_id: normalizationArtifactId,
            source_artifact_id: sourceArtifact.artifact_id,
            normalization_version: runPayload.normalization_version,
            cache_status: runPayload.cache_status,
            run_local_path: runLocalPath(run, runPath),
            content_sha256: sourceArtifact.raw_content_sha256,
            token_count: runPayload.tokens.length
        });
    }
    const summary = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        entry_id: fixtureEntry.entry_id,
        institution_id: fixtureEntry.institution_id,
        observed_at: observationTime,
        normalization_version: `morfeusz-2:${engineInfo.version}`,
        artifacts: artifacts.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id)),
        stats: {
            source_count: artifacts.length,
            token_count: artifacts.reduce((sum, artifact) => sum + artifact.token_count, 0),
            elapsed_ms: Math.max(0, Date.now() - startedAt),
            source_bytes: downloadedBytes
        }
    };
    const summaryArtifactId = artifactId("nrm", {
        entry_id: summary.entry_id,
        normalization_version: summary.normalization_version,
        artifacts: summary.artifacts
    });
    summary.artifact_id = summaryArtifactId;
    return {
        summary,
        artifactId: summaryArtifactId,
        artifacts,
        metrics: makeTelemetryOperation({
            operationId: `normalize:${run.manifest.run_id}:${fixtureEntry.entry_id}`,
            stage: "normalized",
            entry: fixtureEntry,
            durationMs: summary.stats.elapsed_ms,
            bytes: {downloaded: downloadedBytes, reused_from_cache: artifacts.filter((artifact) => artifact.cache_status === "hit").reduce((sum, artifact) => sum + 0, 0)},
            cache: {
                misses: artifacts.filter((artifact) => artifact.cache_status === "miss").length,
                revalidated_not_modified: 0,
                refetched: 0,
                hit_rate: artifacts.length === 0 ? 0 : artifacts.filter((artifact) => artifact.cache_status === "hit").length / artifacts.length
            }
        })
    };
}

export async function preflightMorfeusz({engine = "morfeusz2", workerPath = undefined, pythonCommand = "python3"} = {}) {
    if (engine === "fixture") {
        return {engine, version: FIXTURE_VERSION};
    }
    if (engine !== "morfeusz2") {
        throw new ResearchError("dependency_missing", `unsupported normalization engine ${engine}`, {exitCode: 20});
    }
    const resolvedWorker = workerPath ?? path.resolve(new URL("../tools/morfeusz2-worker.py", import.meta.url).pathname);
    const result = await runWorker({pythonCommand, workerPath: resolvedWorker, payload: {action: "version"}, timeoutMs: 10_000});
    if (typeof result.version !== "string" || !/^\d+\.\d+/.test(result.version)) {
        throw new ResearchError("dependency_missing", "Morfeusz 2 worker did not report a valid version", {exitCode: 20});
    }
    return {engine, version: result.version};
}

export async function normalizeText(text, {engine = "morfeusz2", engineVersion = undefined, workerPath = undefined, pythonCommand = "python3"} = {}) {
    if (typeof text !== "string") {
        throw new ResearchError("schema_mismatch", "normalization input must be UTF-8 text", {exitCode: 10});
    }
    if (engine === "fixture") {
        return {normalization_version: `morfeusz-2:${engineVersion ?? FIXTURE_VERSION}`, tokens: fixtureTokens(text)};
    }
    const resolvedWorker = workerPath ?? path.resolve(new URL("../tools/morfeusz2-worker.py", import.meta.url).pathname);
    const result = await runWorker({pythonCommand, workerPath: resolvedWorker, payload: {action: "analyze", text}, timeoutMs: 30_000});
    const version = engineVersion ?? result.version;
    if (typeof version !== "string") {
        throw new ResearchError("dependency_missing", "Morfeusz 2 worker did not return a version", {exitCode: 20});
    }
    return {
        normalization_version: `morfeusz-2:${version}`,
        tokens: convertCodePointOffsetsToUtf16(result.tokens, text)
    };
}

function convertCodePointOffsetsToUtf16(tokens, text) {
    const codePointOffsets = [0];
    let utf16Offset = 0;
    for (const character of text) {
        utf16Offset += character.length;
        codePointOffsets.push(utf16Offset);
    }
    return (tokens ?? []).map((token) => ({
        ...token,
        start: codePointOffsets[token.start] ?? token.start,
        end: codePointOffsets[token.end] ?? token.end
    }));
}

export function validateNormalizationArtifact(value, {contentSha256 = undefined, runId = undefined, entryId = undefined, sourceArtifactId = undefined} = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ResearchError("schema_mismatch", "normalization artifact must be an object", {exitCode: 10});
    }
    const required = ["schema_version", "content_sha256", "normalization_version", "locale", "policy", "extracted_text", "tokens", "normalized_text", "cache_key"];
    for (const field of required) {
        if (value[field] === undefined) {
            throw new ResearchError("schema_mismatch", `normalization artifact is missing ${field}`, {exitCode: 10});
        }
    }
    if (!/^morfeusz-2:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.normalization_version)) {
        throw new ResearchError("schema_mismatch", "normalization artifact has an invalid Morfeusz version", {exitCode: 10});
    }
    if (contentSha256 !== undefined && value.content_sha256 !== contentSha256) {
        throw new ResearchError("evidence_mismatch", "normalization content hash does not match source artifact", {exitCode: 20});
    }
    for (const [index, token] of value.tokens.entries()) {
        if (!token || typeof token.surface !== "string" || typeof token.lemma !== "string"
            || !Number.isInteger(token.start) || !Number.isInteger(token.end)
            || token.start < 0 || token.end <= token.start || token.end > value.extracted_text.length
            || value.extracted_text.slice(token.start, token.end) !== token.surface) {
            throw new ResearchError("schema_mismatch", `normalization token ${index} has invalid offsets`, {exitCode: 10});
        }
        if (index > 0 && token.start < value.tokens[index - 1].end) {
            throw new ResearchError("schema_mismatch", "normalization token offsets overlap or are not ordered", {exitCode: 10});
        }
    }
    if (value.run_id !== undefined && runId !== undefined && value.run_id !== runId) {
        throw new ResearchError("evidence_mismatch", "normalization run_id does not match the current run", {exitCode: 20});
    }
    if (value.entry_id !== undefined && entryId !== undefined && value.entry_id !== entryId) {
        throw new ResearchError("evidence_mismatch", "normalization entry_id does not match the current entry", {exitCode: 20});
    }
    if (value.source_artifact_id !== undefined && sourceArtifactId !== undefined && value.source_artifact_id !== sourceArtifactId) {
        throw new ResearchError("evidence_mismatch", "normalization source artifact does not match the current artifact", {exitCode: 20});
    }
    return true;
}

function fixtureTokens(text) {
    const tokens = [];
    const expression = /[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu;
    for (const match of text.matchAll(expression)) {
        const surface = match[0];
        tokens.push({
            surface,
            lemma: fixtureLemma(surface),
            start: match.index,
            end: match.index + surface.length
        });
    }
    return tokens;
}

function fixtureLemma(surface) {
    const lower = surface.toLocaleLowerCase("pl-PL");
    const dictionary = {
        kredytu: "kredyt",
        kredytem: "kredyt",
        kredytów: "kredyt",
        mieszkaniowego: "mieszkaniowy",
        mieszkaniowej: "mieszkaniowy",
        mieszkaniowym: "mieszkaniowy",
        spłatę: "spłata",
        spłata: "spłata",
        spłaty: "spłata",
        zaciągniętego: "zaciągnąć",
        zaciągniętym: "zaciągnąć",
        banku: "bank",
        bankiem: "bank",
        stałe: "stały",
        stała: "stały",
        stałej: "stały",
        oprocentowanie: "oprocentowanie",
        okresowo: "okresowo",
        refinansowanie: "refinansowanie"
    };
    return dictionary[lower] ?? lower;
}

function runWorker({pythonCommand, workerPath, payload, timeoutMs}) {
    return new Promise((resolve, reject) => {
        const child = spawn(pythonCommand, [workerPath], {stdio: ["pipe", "pipe", "pipe"]});
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(reject, new ResearchError("dependency_missing", `Morfeusz 2 worker timed out after ${timeoutMs}ms`, {exitCode: 20}));
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => finish(reject, new ResearchError("dependency_missing", "Morfeusz 2 worker could not be started", {exitCode: 20, cause: error})));
        child.on("close", (code) => {
            if (code !== 0) {
                finish(reject, new ResearchError("dependency_missing", `Morfeusz 2 worker exited ${code}: ${stderr.trim() || "no diagnostic"}`, {exitCode: 20}));
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                finish(resolve, parsed);
            } catch (error) {
                finish(reject, new ResearchError("dependency_missing", "Morfeusz 2 worker returned invalid JSON", {exitCode: 20, cause: error, details: {stderr: stderr.trim()}}));
            }
        });
        child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
}
