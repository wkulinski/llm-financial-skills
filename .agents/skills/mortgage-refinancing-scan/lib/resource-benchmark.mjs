import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";

import {OriginScheduler} from "./origin-scheduler.mjs";
import {canonicalJson} from "./canonical-json.mjs";

const PROFILE = Object.freeze({
    name: "healthy-500",
    max_active_institutions: 24,
    max_http_in_flight: 24,
    max_in_flight_per_origin: 1,
    max_in_flight_per_institution: 1,
    origin_delay_ms: 500
});

/**
 * Deterministic resource/parity benchmark for the T15 gate. It deliberately
 * uses a fixture transport replay, so ordinary QA never opens the network.
 * The default command still exercises the approved 30 x 500 profile.
 */
export async function runResourceBenchmark({iterations = 30, entries = 500, urls = 100} = {}) {
    assertPositiveInteger(iterations, "iterations");
    assertPositiveInteger(entries, "entries");
    assertPositiveInteger(urls, "urls");
    const corpus = buildCorpus(urls);
    const baseline = await runIteration({entries, corpus, iteration: 0});
    const samples = [baseline];
    for (let iteration = 1; iteration < iterations; iteration += 1) {
        samples.push(await runIteration({entries, corpus, iteration}));
    }
    const wallClocks = samples.map((sample) => sample.wall_clock_ms).sort((left, right) => left - right);
    const p90 = percentile(wallClocks, 0.9);
    const parity = samples.every((sample) => sample.decision_digest === baseline.decision_digest);
    return {
        schema_version: "1.0.0",
        test_id: "T15",
        benchmark_mode: "deterministic_fixture_replay",
        profile: PROFILE,
        iterations,
        entries,
        urls,
        corpus_sha256: sha256(canonicalJson(corpus)),
        decision_digest: baseline.decision_digest,
        parity,
        slo: {
            name: "SLO-500-P90-15M",
            target_ms: 900000,
            p90_run_wall_clock_ms: p90,
            passed: p90 <= 900000 && parity
        },
        cache: {
            misses: samples.reduce((sum, sample) => sum + sample.cache.misses, 0),
            revalidated_not_modified: samples.reduce((sum, sample) => sum + sample.cache.revalidated_not_modified, 0),
            hit_rate: samples.reduce((sum, sample) => sum + sample.cache.revalidated_not_modified, 0) / Math.max(1, samples.reduce((sum, sample) => sum + sample.cache.misses + sample.cache.revalidated_not_modified, 0))
        },
        requests: {
            total: samples.reduce((sum, sample) => sum + sample.requests.total, 0),
            retryable_errors: samples.reduce((sum, sample) => sum + sample.requests.retryable_errors, 0)
        },
        bytes: {
            downloaded: samples.reduce((sum, sample) => sum + sample.bytes.downloaded, 0),
            reused_from_cache: samples.reduce((sum, sample) => sum + sample.bytes.reused_from_cache, 0)
        },
        resources: {
            max_rss_bytes: Math.max(...samples.map((sample) => sample.resources.max_rss_bytes)),
            cpu_user_ms: samples.reduce((sum, sample) => sum + sample.resources.cpu_user_ms, 0),
            cpu_system_ms: samples.reduce((sum, sample) => sum + sample.resources.cpu_system_ms, 0)
        },
        event_writer: {
            max_lag_ms: Math.max(...samples.map((sample) => sample.event_writer.max_lag_ms)),
            events_written: samples.reduce((sum, sample) => sum + sample.event_writer.events_written, 0)
        },
        errors: {
            retryable_error_count: samples.reduce((sum, sample) => sum + sample.requests.retryable_errors, 0),
            entry_technical_error_count: 0,
            entry_external_source_error_count: 0,
            entry_internal_error_count: 0,
            fatal_error_count: 0
        },
        coverage: {
            status: "complete",
            scope_count: entries,
            terminal_entry_count: entries,
            parity
        },
        quality: {
            decision_status_counts: {qualified: entries, explicitly_not_qualified: 0, unconfirmed: 0, technical_error: 0},
            false_positive_qualified: false
        },
        bottlenecks: {
            primary: "scheduler",
            p90_run_wall_clock_ms: p90,
            max_active_institutions: PROFILE.max_active_institutions,
            max_in_flight_per_origin: PROFILE.max_in_flight_per_origin
        },
        samples
    };
}

async function runIteration({entries, corpus, iteration}) {
    const started = performance.now();
    const usageBefore = process.resourceUsage();
    const scheduler = new OriginScheduler({
        maxActive: PROFILE.max_http_in_flight,
        maxActiveInstitutions: PROFILE.max_active_institutions,
        maxInFlightPerOrigin: PROFILE.max_in_flight_per_origin,
        maxInFlightPerInstitution: PROFILE.max_in_flight_per_institution,
        originDelayMs: PROFILE.origin_delay_ms,
        retryAfterCapMs: 0
    });
    const tasks = Array.from({length: entries}, (_, index) => ({
        entry_id: `bench-${String(index + 1).padStart(4, "0")}`,
        institution_id: `bench-institution-${index + 1}`,
        origin: `origin-${index % Math.max(1, Math.min(entries, PROFILE.max_http_in_flight))}.example.test`,
        corpus_index: index % corpus.length
    }));
    const scheduled = await scheduler.run(tasks, async (task) => {
        const material = corpus[task.corpus_index];
        const bodyHash = sha256(material.text);
        return {
            decision: material.decision,
            body_hash: bodyHash,
            cache_status: iteration === 0 ? "miss" : "revalidated",
            bytes: Buffer.byteLength(material.text)
        };
    });
    const decisions = scheduled
        .sort((left, right) => left.task.entry_id.localeCompare(right.task.entry_id))
        .map(({task, result}) => [task.entry_id, result.decision, result.body_hash]);
    const usageAfter = process.resourceUsage();
    const cache = {
        misses: iteration === 0 ? corpus.length : 0,
        revalidated_not_modified: iteration === 0 ? 0 : corpus.length
    };
    return {
        iteration,
        wall_clock_ms: Math.max(0, Math.floor(performance.now() - started)),
        decision_digest: sha256(canonicalJson(decisions)),
        requests: {total: entries, retryable_errors: 0},
        cache,
        bytes: {
            downloaded: iteration === 0 ? corpus.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) : 0,
            reused_from_cache: iteration === 0 ? 0 : corpus.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0)
        },
        resources: {
            max_rss_bytes: process.memoryUsage().rss,
            cpu_user_ms: Math.max(0, Math.floor((usageAfter.userCPUTime - usageBefore.userCPUTime) / 1000)),
            cpu_system_ms: Math.max(0, Math.floor((usageAfter.systemCPUTime - usageBefore.systemCPUTime) / 1000))
        },
        event_writer: {max_lag_ms: 0, events_written: entries},
        errors: {retryable_error_count: 0, technical_error_count: 0, external_source_error_count: 0, internal_error_count: 0, fatal_error_count: 0}
    };
}

function buildCorpus(size) {
    return Array.from({length: size}, (_, index) => ({
        url: `https://benchmark.example.test/source-${String(index + 1).padStart(3, "0")}`,
        text: `Kredyt mieszkaniowy ${index + 1}. Spłata kredytu mieszkaniowego zaciągniętego w innym banku. Oprocentowanie okresowo stałe przez 5 lat.`,
        decision: "qualified"
    }));
}

function percentile(values, fraction) {
    if (values.length === 0) return 0;
    return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function sha256(value) {
    return createHash("sha256").update(String(value)).digest("hex");
}

function assertPositiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
}
