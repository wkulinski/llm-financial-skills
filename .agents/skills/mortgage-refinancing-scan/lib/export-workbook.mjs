import fs from "node:fs";
import path from "node:path";

import {sha256Hex} from "./canonical-json.mjs";
import {auditPublication} from "./publication-audit.mjs";
import {loadRun} from "./run-lifecycle.mjs";
import {writeXlsx} from "./xlsx.mjs";

const HEADERS = Object.freeze([
    "Lp",
    "Nazwa instytucji",
    "Typ instytucji",
    "Status decyzji",
    "Wynik wpisu",
    "Export ready",
    "Data status",
    "Blokady eksportu",
    "Qualifies",
    "Status przeglądu",
    "Nazwa produktu",
    "Product ID",
    "Variant ID",
    "URL produktu",
    "Typ stałej stopy",
    "Okres stałej stopy (lata)",
    "Oprocentowanie nominalne stałe",
    "RRSO",
    "Prowizja",
    "Maksymalny okres kredytowania (lata)",
    "Data obserwacji",
    "Kody powodów",
    "Liczba evidence",
    "Kod błędu",
    "Opis błędu"
]);

/** Export only the immutable snapshot selected by the finalized run pointer. */
export function exportPublishedWorkbook({runManifestPath, outputPath, cwd = process.cwd()} = {}) {
    const audit = auditPublication({runManifestPath, cwd});
    if (!audit.valid) {
        const error = new Error("published snapshot failed read-only audit");
        error.code = "publication_io_failure";
        error.exitCode = 30;
        error.details = {audit};
        throw error;
    }
    const run = loadRun(runManifestPath, cwd);
    const snapshotPath = path.resolve(cwd, audit.paths.snapshot_path);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    const registry = readRegistry(run);
    const registryByEntry = new Map((registry?.entries ?? []).map((entry) => [entry.entry_id, entry]));
    const sortedEntries = snapshot.entries
        .slice()
        .sort((left, right) => left.lp - right.lp);
    const readyEntries = sortedEntries.filter(entryExportReady);
    const reviewEntries = sortedEntries.filter((entry) => !readyEntries.includes(entry));
    const rows = [HEADERS, ...readyEntries.map((entry) => rowForEntry(entry, registryByEntry.get(entry.entry_id)))];
    const reviewRows = [HEADERS, ...reviewEntries.map((entry) => rowForEntry(entry, registryByEntry.get(entry.entry_id)))];
    const metadata = [
        ["run_id", run.manifest.run_id],
        ["snapshot_sha256", snapshotHash(snapshotPath)],
        ["coverage_status", snapshot.coverage_status],
        ["scope_sha256", snapshot.scope_sha256],
        ["audit_status", audit.status],
        ["source", audit.paths.snapshot_path],
        ["export_ready_row_count", readyEntries.length],
        ["review_row_count", reviewEntries.length]
    ];
    const absoluteOutput = path.resolve(cwd, outputPath);
    writeXlsx(absoluteOutput, [
        {name: "Raport", rows},
        {name: "Review", rows: reviewRows},
        {name: "Metryka", rows: [["Pole", "Wartość"], ...metadata]}
    ]);
    return {
        schema_version: "1.0.0",
        status: "exported",
        run_id: run.manifest.run_id,
        output_path: relative(cwd, absoluteOutput),
        source_snapshot_path: audit.paths.snapshot_path,
        row_count: snapshot.entries.length,
        export_ready_row_count: readyEntries.length,
        review_row_count: reviewEntries.length,
        column_count: HEADERS.length,
        output_sha256: sha256Hex(fs.readFileSync(absoluteOutput)),
        audit_status: audit.status
    };
}

export {HEADERS};

function rowForEntry(entry, registryEntry = {}) {
    const result = entry.result ?? {};
    const bundle = result.product_bundle ?? {};
    const offer = result.offer ?? {};
    const context = offer.comparison_context ?? {};
    const status = entry.decision_status;
    return [
        entry.lp,
        registryEntry.legal_name ?? entry.institution_id,
        entry.institution_type,
        status,
        entry.entry_outcome ?? null,
        entryExportReady(entry) ? "TAK" : "NIE",
        entry.data_status ?? (entryExportReady(entry) ? "complete" : "incomplete"),
        (entry.export_blockers ?? (entryExportReady(entry) ? [] : ["missing_nominal_or_rrso"])).join(", "),
        qualifiesText(status),
        reviewStatus(status, entry.entry_outcome),
        bundle.product_name ?? null,
        bundle.product_id ?? null,
        bundle.variant_id ?? null,
        bundle.canonical_product_url ?? null,
        offer.fixed_rate_type ?? null,
        offer.fixed_rate_period_years_exact ?? rangeValue(offer.fixed_rate_period_years_min, offer.fixed_rate_period_years_max),
        exactOrRange(offer.fixed_nominal_rate_exact, offer.fixed_nominal_rate_min, offer.fixed_nominal_rate_max),
        exactOrRange(offer.rrso_exact, offer.rrso_min, offer.rrso_max),
        formatCommission(offer),
        offer.max_loan_term_years ?? null,
        context.observation_date ?? null,
        (result.qualification?.reason_codes ?? []).join(", "),
        evidenceCount(result),
        entry.error_code ?? result.error_code ?? null,
        entry.error_message ?? result.error_message ?? null
    ];
}

function readRegistry(run) {
    const filePath = path.resolve(run.cwd, run.context.registry_snapshot_path);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function snapshotHash(filePath) {
    return sha256Hex(fs.readFileSync(filePath));
}

function exactOrRange(exact, min, max) {
    if (exact !== null && exact !== undefined) return exact;
    return rangeValue(min, max);
}

function rangeValue(min, max) {
    if (min === null || min === undefined) return max ?? null;
    if (max === null || max === undefined) return min;
    return `${min}-${max}`;
}

function formatCommission(offer) {
    const value = exactOrRange(offer.commission_exact, offer.commission_min, offer.commission_max);
    if (value === null || value === undefined) return null;
    return offer.commission_unit === "amount" && offer.commission_currency
        ? `${value} ${offer.commission_currency}`
        : offer.commission_unit === "percent" ? `${value}%` : value;
}

function evidenceCount(result) {
    return new Set(Object.values(result.field_evidence ?? {}).flatMap((ids) => Array.isArray(ids) ? ids : [])).size;
}

function entryExportReady(entry) {
    if (entry.decision_status !== "qualified") return false;
    if (entry.export_ready !== undefined) return entry.export_ready === true;
    const offer = entry.result?.offer;
    if (!offer || !["permanent_fixed", "periodically_fixed"].includes(offer.fixed_rate_type)) return false;
    if (offer.fixed_rate_type === "periodically_fixed"
        && ![offer.fixed_rate_period_years_exact, offer.fixed_rate_period_years_min, offer.fixed_rate_period_years_max]
            .some((value) => typeof value === "number" && value > 0)) return false;
    return [
        offer.fixed_nominal_rate_exact,
        offer.fixed_nominal_rate_min,
        offer.fixed_nominal_rate_max,
        offer.rrso_exact,
        offer.rrso_min,
        offer.rrso_max
    ].some((value) => typeof value === "number" && Number.isFinite(value));
}

function qualifiesText(status) {
    if (status === "qualified") return "TAK";
    if (status === "explicitly_not_qualified") return "NIE";
    return "—";
}

function reviewStatus(status, entryOutcome) {
    if (entryOutcome === "external_source_error") return "blocked_external";
    if (entryOutcome === "internal_error") return "error";
    if (status === "qualified" || status === "explicitly_not_qualified") return "checked";
    if (status === "unconfirmed") return "needs_review";
    if (status === "technical_error") return "error";
    return "unchecked";
}

function relative(cwd, filePath) {
    return path.relative(cwd, filePath).split(path.sep).join("/");
}
