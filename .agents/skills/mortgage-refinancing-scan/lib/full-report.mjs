import fs from "node:fs";
import path from "node:path";

const DECISION_STATUSES = Object.freeze([
    "qualified",
    "explicitly_not_qualified",
    "unconfirmed",
    "technical_error"
]);

/**
 * Builds the Phase 6 report from the immutable run manifest, projections and
 * published snapshot.  The report is diagnostic/export metadata; it never
 * changes the canonical decision or publication state.
 */
export function buildFullReport({
    run,
    projection,
    checkpoint = null,
    telemetry = null,
    pipelineTelemetry = null,
    snapshot = null,
    publication = null,
    audit = null,
    cwd = run?.cwd ?? process.cwd()
}) {
    if (!run?.manifest || !projection?.entries) throw new TypeError("full report requires a loaded run and projection");
    const snapshotByEntry = new Map((snapshot?.entries ?? []).map((entry) => [entry.entry_id, entry]));
    const evidenceByEntry = readEvidenceByEntry(run);
    const selectionByEntry = readSelectionByEntry(run);
    const entries = [...projection.entries.values()]
        .sort((left, right) => left.lp - right.lp)
        .map((entry) => buildQualityEntry({
            run,
            entry,
            snapshotEntry: snapshotByEntry.get(entry.entry_id),
            evidence: evidenceByEntry.get(entry.entry_id) ?? [],
            selection: selectionByEntry.get(entry.entry_id) ?? null
        }));
    const counts = countDecisions(entries, snapshotByEntry);
    const stageMetrics = telemetry?.stages ?? [];
    const bottlenecks = buildBottlenecks({pipelineTelemetry, stageMetrics, entries});
    const terminalEntryCount = entries.filter((entry) => ["interpreted", "technical_error"].includes(entry.stage)).length;
    const scopeCount = run.manifest.scope.entries.length;

    return {
        schema_version: "1.0.0",
        phase: "6",
        report_type: "full",
        generated_at: new Date().toISOString(),
        run_id: run.manifest.run_id,
        status: projection.runState,
        mode: run.manifest.live ? "live" : "test",
        manifest: {
            path: relative(cwd, run.manifestPath),
            scope_sha256: run.manifest.scope.scope_sha256,
            source_registry_sha256: run.manifest.source_registry_sha256,
            scope_entries: run.manifest.scope.entries
        },
        scope_count: scopeCount,
        coverage_status: checkpoint?.coverage_status ?? null,
        summary: {
            scope_count: scopeCount,
            terminal_entry_count: terminalEntryCount,
            complete: terminalEntryCount === scopeCount,
            qualified_count: counts.qualified,
            explicitly_not_qualified_count: counts.explicitly_not_qualified,
            unconfirmed_count: counts.unconfirmed,
            technical_error_count: counts.technical_error,
            external_source_error_count: counts.external_source_error,
            internal_error_count: counts.internal_error,
            export_ready_count: counts.export_ready,
            export_ready_false_count: counts.export_ready_false,
            coverage_status: checkpoint?.coverage_status ?? null
        },
        metrics: {
            run: telemetry?.run ?? null,
            stages: stageMetrics,
            pipeline: pipelineTelemetry,
            coverage: {
                scope_count: scopeCount,
                terminal_entry_count: terminalEntryCount,
                terminal_ratio: scopeCount === 0 ? 0 : terminalEntryCount / scopeCount,
                status: checkpoint?.coverage_status ?? null
            }
        },
        bottlenecks,
        quality: {
            decision_status_counts: counts,
            per_institution: entries
        },
        publication: {
            status: publication?.status ?? null,
            pointer_path: publication?.pointer_path ?? null,
            snapshot_path: publication?.snapshot_path ?? null,
            audit_status: audit?.status ?? null,
            audit_errors: audit?.errors ?? []
        },
        entries,
        checkpoint,
        evidence_count: entries.reduce((sum, entry) => sum + entry.evidence_count, 0)
    };
}

export function qualifiesForDecision(status) {
    if (status === "qualified") return true;
    if (status === "explicitly_not_qualified") return false;
    return null;
}

export function reviewStatusForDecision(status) {
    if (status === "qualified" || status === "explicitly_not_qualified") return "checked";
    if (status === "unconfirmed") return "needs_review";
    if (status === "technical_error") return "error";
    return "unchecked";
}

function buildQualityEntry({run, entry, snapshotEntry, evidence, selection}) {
    const result = snapshotEntry?.result ?? readInterpretationArtifact(run, entry.entry_id);
    const decisionStatus = entry.decision_status ?? snapshotEntry?.decision_status ?? result?.decision_status ?? null;
    const entryOutcome = entry.entry_outcome ?? snapshotEntry?.entry_outcome ?? (decisionStatus ? "business_decision" : null);
    const exportReady = entry.export_ready ?? snapshotEntry?.export_ready ?? result?.export_ready ?? false;
    const dataStatus = entry.data_status ?? snapshotEntry?.data_status ?? result?.data_status ?? "incomplete";
    const exportBlockers = entry.export_blockers ?? snapshotEntry?.export_blockers ?? result?.export_blockers ?? [];
    const flags = [];
    if (entryOutcome === "external_source_error") flags.push("external_source_error");
    if (entryOutcome === "internal_error") flags.push("internal_error");
    if (decisionStatus === "unconfirmed") flags.push("needs_review");
    if (decisionStatus && decisionStatus !== "technical_error" && !result) flags.push("missing_interpretation_result");
    if (evidence.length === 0 && !["external_source_error", "internal_error"].includes(entryOutcome)) flags.push("no_evidence");
    const fieldEvidence = result?.field_evidence ?? {};
    const resultEvidence = [...new Set(Object.values(fieldEvidence).flatMap((ids) => Array.isArray(ids) ? ids : []))];
    const evidenceCount = Math.max(evidence.length, resultEvidence.length);
    return {
        entry_id: entry.entry_id,
        lp: entry.lp,
        institution_id: entry.institution_id,
        stage: entry.stage,
        entry_outcome: entryOutcome,
        export_ready: exportReady,
        data_status: dataStatus,
        export_blockers: exportBlockers,
        decision_status: decisionStatus,
        qualifies: qualifiesForDecision(decisionStatus),
        review_status: entryOutcome === "external_source_error"
            ? "blocked_external"
            : entryOutcome === "internal_error" ? "error" : reviewStatusForDecision(decisionStatus),
        criterion_status: result?.criterion_status ?? null,
        product_bundle: result?.product_bundle ?? null,
        offer: result?.offer ?? null,
        reason_codes: result?.qualification?.reason_codes ?? [],
        warnings: result?.warnings ?? [],
        evidence_count: evidenceCount,
        evidence_ids: resultEvidence.length > 0 ? resultEvidence.sort() : evidence.map((item) => item.evidence_id).sort(),
        source_selection: selection,
        error_code: entry.error_code ?? result?.error_code ?? null,
        error_message: entry.error_message ?? result?.error_message ?? null,
        elapsed_ms: entry.elapsed_ms ?? 0,
        quality_flags: [...new Set(flags)].sort()
    };
}

function countDecisions(entries, snapshotByEntry = new Map()) {
    const result = Object.fromEntries(DECISION_STATUSES.map((status) => [status, 0]));
    result.external_source_error = 0;
    result.internal_error = 0;
    result.export_ready = 0;
    result.export_ready_false = 0;
    for (const entry of entries) {
        if (Object.hasOwn(result, entry.decision_status)) result[entry.decision_status] += 1;
        if (entry.entry_outcome === "external_source_error") result.external_source_error += 1;
        if (entry.entry_outcome === "internal_error") result.internal_error += 1;
        if (snapshotByEntry.get(entry.entry_id)?.export_ready === true) result.export_ready += 1;
        else result.export_ready_false += 1;
    }
    return result;
}

function buildBottlenecks({pipelineTelemetry, stageMetrics, entries}) {
    const pipelineStages = pipelineTelemetry?.stages ?? [];
    const stages = pipelineStages.length > 0 ? pipelineStages : stageMetrics;
    const total = stages.reduce((sum, stage) => sum + Number(stage.wall_clock_ms ?? 0), 0);
    const rankedStages = stages
        .map((stage) => ({
            stage: stage.stage,
            wall_clock_ms: Number(stage.wall_clock_ms ?? 0),
            queue_wait_ms: Number(stage.queue_wait_ms ?? 0),
            p95_ms: Number(stage.p95_ms ?? 0),
            share: total === 0 ? 0 : Number(stage.wall_clock_ms ?? 0) / total
        }))
        .sort((left, right) => right.wall_clock_ms - left.wall_clock_ms || left.stage.localeCompare(right.stage));
    const slowEntries = [...entries]
        .sort((left, right) => right.elapsed_ms - left.elapsed_ms || left.lp - right.lp)
        .slice(0, 10)
        .map((entry) => ({
            entry_id: entry.entry_id,
            institution_id: entry.institution_id,
            elapsed_ms: entry.elapsed_ms,
            decision_status: entry.decision_status,
            error_code: entry.error_code
        }));
    return {
        primary_stage: rankedStages[0]?.stage ?? null,
        stages: rankedStages,
        slow_entries: slowEntries
    };
}

function readInterpretationArtifact(run, entryId) {
    const filePath = path.join(run.runRoot, "artifacts", "interpretation", `${entryId}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

function readEvidenceByEntry(run) {
    const filePath = path.join(run.runRoot, "evidence.jsonl");
    const result = new Map();
    if (!fs.existsSync(filePath)) return result;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean)) {
        try {
            const record = JSON.parse(line);
            const records = result.get(record.entry_id) ?? [];
            records.push(record);
            result.set(record.entry_id, records);
        } catch {
            // The publication audit is responsible for reporting malformed JSON.
        }
    }
    return result;
}

function readSelectionByEntry(run) {
    const result = new Map();
    const directory = path.join(run.runRoot, "artifacts", "fetch");
    if (!fs.existsSync(directory)) return result;
    for (const name of fs.readdirSync(directory).filter((file) => file.endsWith(".json"))) {
        try {
            const summary = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
            if (summary.entry_id && summary.selection) result.set(summary.entry_id, summary.selection);
        } catch {
            // The audit path reports malformed fetch summaries separately.
        }
    }
    return result;
}

function relative(cwd, filePath) {
    return path.relative(cwd, filePath).split(path.sep).join("/");
}
