import {performance} from "node:perf_hooks";

import {OriginScheduler} from "./origin-scheduler.mjs";

const DEFAULT_STAGES = Object.freeze([
    "discovery",
    "fetched",
    "normalized",
    "evidence_ready",
    "interpreted"
]);

/**
 * Runs one bounded pipeline per institution.  The scheduler keeps independent
 * origins in flight while serialising work for the same origin and institution.
 * Each pipeline advances in the fixed stage order, so stages from different
 * institutions overlap without creating an unbounded task graph.
 */
export async function runBoundedPipeline({
    runId,
    tasks,
    stages = DEFAULT_STAGES,
    resourcePolicy,
    worker
}) {
    assertTasks(tasks);
    assertStages(stages);
    if (typeof worker !== "function") throw new TypeError("pipeline worker must be a function");

    const policy = resourcePolicy ?? {};
    const maxActiveInstitutions = positive(policy.max_active_institutions ?? 24, "max_active_institutions");
    const maxHttpInFlight = positive(policy.max_http_in_flight ?? maxActiveInstitutions, "max_http_in_flight");
    const scheduler = new OriginScheduler({
        maxActive: Math.min(maxHttpInFlight, maxActiveInstitutions),
        maxActiveInstitutions,
        maxInFlightPerOrigin: positive(policy.max_in_flight_per_origin ?? 1, "max_in_flight_per_origin"),
        maxInFlightPerInstitution: positive(policy.max_in_flight_per_institution ?? 1, "max_in_flight_per_institution"),
        originDelayMs: nonNegative(policy.origin_delay_ms ?? 500, "origin_delay_ms"),
        retryAfterCapMs: nonNegative(policy.retry_after_cap_ms ?? 60_000, "retry_after_cap_ms")
    });
    const startedAt = performance.now();
    const startedIso = new Date().toISOString();
    const usageBefore = process.resourceUsage();
    const stageStats = new Map(stages.map((stage) => [stage, createStageStats(stage)]));
    let active = 0;
    let activePeak = 0;

    const planned = tasks
        .map((task, index) => ({...task, __pipeline_index: index, __queued_at: performance.now()}))
        .sort(compareTasks);
    const scheduled = await scheduler.run(planned, async (task) => {
        active += 1;
        activePeak = Math.max(activePeak, active);
        const entryStartedAt = performance.now();
        const entry = {
            entry_id: task.entry_id,
            institution_id: task.institution_id,
            origin: originOf(task),
            status: "running",
            stages: [],
            fatal_error: null,
            terminal: false
        };
        try {
            for (let index = 0; index < stages.length; index += 1) {
                const stage = stages[index];
                const stat = stageStats.get(stage);
                const stageReadyAt = index === 0
                    ? Number(task.__queued_at)
                    : Number(entry.stages[index - 1]?.finished_at_ms ?? entryStartedAt);
                const stageStartedAt = performance.now();
                stat.tasks += 1;
                stat.active_peak = Math.max(stat.active_peak, active);
                stat.queue_wait_ms += Math.max(0, Math.floor(stageStartedAt - stageReadyAt));
                let stageResult;
                try {
                    stageResult = await worker(stage, task);
                } catch (error) {
                    stageResult = {
                        fatal_error: serialiseError(error),
                        status: "fatal_error"
                    };
                }
                const finishedAt = performance.now();
                const duration = Math.max(0, Math.floor(finishedAt - stageStartedAt));
                const stageRecord = {
                    stage,
                    status: stageResult?.status ?? "completed",
                    duration_ms: duration,
                    finished_at_ms: finishedAt,
                    terminal: Boolean(stageResult?.terminal),
                    error_code: stageResult?.error_code ?? stageResult?.fatal_error?.code ?? null
                };
                entry.stages.push(stageRecord);
                stat.completed += 1;
                stat.wall_clock_ms += duration;
                stat.durations.push(duration);
                if (stageResult?.fatal_error) {
                    stat.errors += 1;
                    entry.status = "fatal_error";
                    entry.fatal_error = stageResult.fatal_error;
                    break;
                }
                if (stageResult?.status === "technical_error" || stageResult?.terminal) {
                    if (stageResult?.status === "technical_error") {
                        stat.technical_errors += 1;
                    }
                    entry.status = stageResult?.status ?? "terminal";
                    entry.terminal = true;
                    break;
                }
            }
            if (entry.status === "running") {
                entry.status = "completed";
                entry.terminal = true;
            }
        } finally {
            entry.wall_clock_ms = Math.max(0, Math.floor(performance.now() - entryStartedAt));
            active -= 1;
        }
        return {
            ...entry,
            task: stripInternalTask(task),
            retryAfterMs: 0
        };
    });

    const finishedAt = performance.now();
    const usageAfter = process.resourceUsage();
    const results = scheduled
        .map(({result}) => result)
        .sort(compareResults);
    const telemetry = {
        schema_version: "1.0.0",
        run_id: runId,
        mode: "bounded_pipeline",
        started_at: startedIso,
        finished_at: new Date().toISOString(),
        wall_clock_ms: Math.max(0, Math.floor(finishedAt - startedAt)),
        concurrency: {
            max_active_institutions: maxActiveInstitutions,
            max_http_in_flight: maxHttpInFlight,
            max_in_flight_per_origin: Number(policy.max_in_flight_per_origin ?? 1),
            max_in_flight_per_institution: Number(policy.max_in_flight_per_institution ?? 1),
            origin_delay_ms: Number(policy.origin_delay_ms ?? 500),
            active_peak: activePeak
        },
        resources: {
            cpu_user_ms: Math.max(0, Math.floor((usageAfter.userCPUTime - usageBefore.userCPUTime) / 1000)),
            cpu_system_ms: Math.max(0, Math.floor((usageAfter.systemCPUTime - usageBefore.systemCPUTime) / 1000)),
            max_rss_bytes: process.memoryUsage().rss
        },
        stages: stages.map((stage) => finishStageStats(stageStats.get(stage))),
        entries: results.map((entry) => ({
            entry_id: entry.entry_id,
            institution_id: entry.institution_id,
            origin: entry.origin,
            status: entry.status,
            wall_clock_ms: entry.wall_clock_ms,
            stages: entry.stages.map(({stage, status, duration_ms, error_code}) => ({stage, status, duration_ms, error_code})),
            error_code: entry.fatal_error?.code ?? entry.stages.find((item) => item.error_code)?.error_code ?? null
        })),
        errors: {
            fatal_count: results.filter((entry) => entry.status === "fatal_error").length,
            technical_error_count: results.filter((entry) => entry.status === "technical_error").length
        }
    };
    return {results, telemetry};
}

export function pipelineStages() {
    return [...DEFAULT_STAGES];
}

function createStageStats(stage) {
    return {
        stage,
        tasks: 0,
        completed: 0,
        errors: 0,
        technical_errors: 0,
        wall_clock_ms: 0,
        queue_wait_ms: 0,
        active_peak: 0,
        durations: []
    };
}

function finishStageStats(stat) {
    const durations = [...stat.durations].sort((left, right) => left - right);
    return {
        stage: stat.stage,
        tasks: stat.tasks,
        completed: stat.completed,
        errors: stat.errors,
        technical_errors: stat.technical_errors,
        wall_clock_ms: stat.wall_clock_ms,
        queue_wait_ms: stat.queue_wait_ms,
        active_peak: stat.active_peak,
        p50_ms: percentile(durations, 0.5),
        p95_ms: percentile(durations, 0.95)
    };
}

function assertTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) throw new TypeError("pipeline tasks must be a non-empty array");
    for (const task of tasks) {
        if (!task || typeof task !== "object" || !task.entry_id) throw new TypeError("pipeline task requires entry_id");
    }
}

function assertStages(stages) {
    if (!Array.isArray(stages) || stages.length === 0) throw new TypeError("pipeline stages must be a non-empty array");
    if (stages.some((stage) => typeof stage !== "string" || stage.length === 0)) throw new TypeError("pipeline stages must be named strings");
}

function originOf(task) {
    return String(task.origin ?? task.official_host ?? "unknown").toLowerCase();
}

function stripInternalTask(task) {
    const result = {...task};
    delete result.__pipeline_index;
    delete result.__queued_at;
    return result;
}

function compareTasks(left, right) {
    return Number(left.lp ?? 0) - Number(right.lp ?? 0) || String(left.entry_id).localeCompare(String(right.entry_id));
}

function compareResults(left, right) {
    return Number(left.task?.lp ?? left.lp ?? 0) - Number(right.task?.lp ?? right.lp ?? 0)
        || String(left.entry_id).localeCompare(String(right.entry_id));
}

function percentile(values, fraction) {
    if (values.length === 0) return 0;
    return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function positive(value, label) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
    return value;
}

function nonNegative(value, label) {
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
    return value;
}

function serialiseError(error) {
    return {
        code: error?.code ?? "publication_io_failure",
        message: String(error?.message ?? error).slice(0, 2048)
    };
}
