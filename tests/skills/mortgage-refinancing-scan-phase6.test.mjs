import fs from "node:fs";
import os from "node:os";
import {spawn} from "node:child_process";
import path from "node:path";
import {pathToFileURL} from "node:url";

import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";

import {exportPublishedWorkbook} from "../../.agents/skills/mortgage-refinancing-scan/lib/export-workbook.mjs";
import {auditPublication} from "../../.agents/skills/mortgage-refinancing-scan/lib/publication-audit.mjs";
import {readEvidenceJsonl} from "../../.agents/skills/mortgage-refinancing-scan/lib/research-runtime.mjs";
import {runBoundedPipeline} from "../../.agents/skills/mortgage-refinancing-scan/lib/pipeline.mjs";
import {runResourceBenchmark} from "../../.agents/skills/mortgage-refinancing-scan/lib/resource-benchmark.mjs";
import {runControlledScan} from "../../.agents/skills/mortgage-refinancing-scan/tools/runner.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const REGISTRY = path.join(ROOT, "tests/fixtures/mortgage-refinancing-scan-phase5-registry.json");
const FIXTURE = path.join(ROOT, "tests/fixtures/mortgage-refinancing-scan-interpretation.json");
const RUNS_ROOT = path.join(ROOT, "data/mortgage-refinancing-scan/work/runs");
const PUBLISHED_ROOT = path.join(ROOT, "data/mortgage-refinancing-scan/published");
const activeRuns = new Set();
let pointerBefore;
let sequence = 0;

describe("mortgage-refinancing-scan Phase 6 full report", () => {
    beforeAll(() => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        if (fs.existsSync(RUNS_ROOT)) {
            for (const entry of fs.readdirSync(RUNS_ROOT, {withFileTypes: true})) {
                if (entry.isDirectory()) {
                    fs.rmSync(path.join(RUNS_ROOT, entry.name), {recursive: true, force: true});
                }
            }
        }
    });

    afterAll(() => {
        for (const runId of activeRuns) {
            fs.rmSync(path.join(RUNS_ROOT, runId), {recursive: true, force: true});
            fs.rmSync(path.join(PUBLISHED_ROOT, runId), {recursive: true, force: true});
        }
        activeRuns.clear();
        if (pointerBefore === null) fs.rmSync(path.join(PUBLISHED_ROOT, "current.json"), {force: true});
        else if (pointerBefore !== undefined) {
            fs.mkdirSync(PUBLISHED_ROOT, {recursive: true});
            fs.writeFileSync(path.join(PUBLISHED_ROOT, "current.json"), pointerBefore);
        }
    });

    afterEach(() => {
        for (const runId of activeRuns) {
            fs.rmSync(path.join(RUNS_ROOT, runId), {recursive: true, force: true});
            fs.rmSync(path.join(PUBLISHED_ROOT, runId), {recursive: true, force: true});
        }
        activeRuns.clear();
        if (pointerBefore === null) fs.rmSync(path.join(PUBLISHED_ROOT, "current.json"), {force: true});
        else if (pointerBefore !== undefined) {
            fs.mkdirSync(PUBLISHED_ROOT, {recursive: true});
            fs.writeFileSync(path.join(PUBLISHED_ROOT, "current.json"), pointerBefore);
        }
        pointerBefore = undefined;
    });

    it("runs the exact scope through the bounded pipeline and emits full quality/telemetry", async () => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        const runId = nextRunId("report");
        const report = await runControlledScan({
            registrySnapshot: REGISTRY,
            runRoot: "data/mortgage-refinancing-scan/work/runs",
            mode: "full",
            live: false,
            runId,
            fixture: FIXTURE,
            cacheRoot: `data/mortgage-refinancing-scan/cache/phase6-${process.pid}/${runId}`
        });
        activeRuns.add(runId);

        expect(report).toMatchObject({
            phase: "6",
            status: "FINALIZED",
            scope_count: 6,
            audit: {status: "passed", valid: true, read_only: true},
            summary: {complete: true, coverage_status: "complete"}
        });
        expect(report.manifest.scope_entries).toHaveLength(6);
        expect(report.pipeline_telemetry_path).toContain("pipeline-telemetry.json");
        expect(report.full_report_path).toContain("full-report.json");
        expect(report.quality.per_institution).toHaveLength(6);
        expect(report.quality.decision_status_counts).toMatchObject({qualified: 2, explicitly_not_qualified: 2, unconfirmed: 2, technical_error: 0});
        expect(report.bottlenecks.primary_stage).toBeTruthy();
        expect(JSON.parse(fs.readFileSync(path.join(ROOT, report.pipeline_telemetry_path), "utf8")).entries).toHaveLength(6);
        expect(fs.existsSync(path.join(ROOT, report.full_report_path))).toBe(true);
    }, 60_000);

    it("exports and audits only the immutable published snapshot", async () => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        const runId = nextRunId("export");
        const report = await runControlledScan({
            registrySnapshot: REGISTRY,
            runRoot: "data/mortgage-refinancing-scan/work/runs",
            mode: "full",
            live: false,
            runId,
            fixture: FIXTURE,
            cacheRoot: `data/mortgage-refinancing-scan/cache/phase6-${process.pid}/${runId}`
        });
        activeRuns.add(runId);
        const manifestPath = path.join(ROOT, report.manifest_path);
        const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mortgage-phase6-export-"));
        const outputPath = path.join(outputRoot, "report.xlsx");
        const exported = exportPublishedWorkbook({runManifestPath: manifestPath, outputPath, cwd: ROOT});
        expect(exported).toMatchObject({status: "exported", row_count: 6, audit_status: "passed"});
        const workbook = fs.readFileSync(outputPath);
        expect(workbook.subarray(0, 2).toString()).toBe("PK");
        expect(workbook.includes(Buffer.from("Kredyt mieszkaniowy"))).toBe(true);
        expect(workbook.includes(Buffer.from("qualified"))).toBe(true);
        expect(workbook.includes(Buffer.from("NIE"))).toBe(true);
        expect(workbook.includes(Buffer.from("needs_review"))).toBe(true);

        const snapshotPath = path.join(PUBLISHED_ROOT, runId, "snapshot.json");
        const originalSnapshot = fs.readFileSync(snapshotPath, "utf8");
        const tampered = JSON.parse(originalSnapshot);
        tampered.entries[0].scope_sha256 = "tampered";
        fs.writeFileSync(snapshotPath, `${JSON.stringify(tampered, null, 2)}\n`);
        const failed = auditPublication({runManifestPath: manifestPath, cwd: ROOT});
        expect(failed).toMatchObject({status: "failed", valid: false, read_only: true});
        expect(failed.errors.map((error) => error.code)).toContain("publication_hash_mismatch");
        const rejectedOutput = path.join(outputRoot, "rejected.xlsx");
        expect(() => exportPublishedWorkbook({runManifestPath: manifestPath, outputPath: rejectedOutput, cwd: ROOT})).toThrow(/published snapshot failed read-only audit/u);
        expect(fs.existsSync(rejectedOutput)).toBe(false);
        fs.writeFileSync(snapshotPath, originalSnapshot);
        fs.rmSync(outputRoot, {recursive: true, force: true});
    }, 60_000);

    it("detects tampering in every audited artifact without repairing it", async () => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        const runId = nextRunId("auditmatrix");
        const report = await runControlledScan({
            registrySnapshot: REGISTRY,
            runRoot: "data/mortgage-refinancing-scan/work/runs",
            mode: "full",
            live: false,
            runId,
            fixture: FIXTURE,
            cacheRoot: `data/mortgage-refinancing-scan/cache/phase6-${process.pid}/${runId}`
        });
        activeRuns.add(runId);
        const runRoot = path.join(ROOT, report.run_root);
        const publishedRoot = path.join(PUBLISHED_ROOT, runId);
        const files = {
            manifest: path.join(runRoot, "manifest.json"),
            checkpoint: path.join(runRoot, "checkpoint.json"),
            telemetry: path.join(runRoot, "metrics.json"),
            snapshot: path.join(publishedRoot, "snapshot.json"),
            evidence: path.join(publishedRoot, "evidence.jsonl"),
            publication: path.join(publishedRoot, "publication.json"),
            pointer: path.join(PUBLISHED_ROOT, "current.json")
        };
        const originals = new Map(Object.values(files).map((filePath) => [filePath, fs.readFileSync(filePath)]));
        const cases = [
            ["manifest", (value) => { value.created_at = "2026-08-06T00:00:01Z"; }],
            ["checkpoint", (value) => { value.scope_count += 1; }],
            ["telemetry", (value) => { value.run_id = "run-tampered-telemetry"; }],
            ["snapshot", (value) => { value.entries[0].decision_status = "unconfirmed"; }],
            ["publication", (value) => { value.coverage_status = "degraded"; }],
            ["pointer", (value) => { value.coverage_status = "degraded"; }]
        ];
        for (const [name, mutate] of cases) {
            const filePath = files[name];
            const tampered = JSON.parse(originals.get(filePath).toString("utf8"));
            mutate(tampered);
            fs.writeFileSync(filePath, `${JSON.stringify(tampered, null, 2)}\n`);
            const tamperedBytes = fs.readFileSync(filePath);
            const failed = auditPublication({runManifestPath: path.join(runRoot, "manifest.json"), cwd: ROOT});
            expect(failed, name).toMatchObject({status: "failed", valid: false, read_only: true});
            expect(failed.errors.length, name).toBeGreaterThan(0);
            expect(fs.readFileSync(filePath), name).toEqual(tamperedBytes);
            fs.writeFileSync(filePath, originals.get(filePath));
        }

        const originalEvidence = originals.get(files.evidence).toString("utf8");
        const evidence = JSON.parse(originalEvidence.trimEnd().split("\n")[0]);
        evidence.excerpt = `${evidence.excerpt} tampered`;
        fs.writeFileSync(files.evidence, `${JSON.stringify(evidence)}\n`);
        const evidenceAudit = auditPublication({runManifestPath: path.join(runRoot, "manifest.json"), cwd: ROOT});
        expect(evidenceAudit).toMatchObject({status: "failed", valid: false, read_only: true});
        expect(evidenceAudit.errors.map((error) => error.code)).toContain("publication_hash_mismatch");
        fs.writeFileSync(files.evidence, originals.get(files.evidence));
        expect(auditPublication({runManifestPath: path.join(runRoot, "manifest.json"), cwd: ROOT})).toMatchObject({status: "passed", valid: true});
    }, 60_000);

    it("keeps same-origin work serial and overlaps independent origins", async () => {
        let active = 0;
        let maxActive = 0;
        let sameOriginOverlap = false;
        const activeOrigins = new Map();
        const result = await runBoundedPipeline({
            runId: "run-20260806T180000Z-phase6pipeline",
            tasks: [
                {entry_id: "bank-a", lp: 1, institution_id: "bank-a", origin: "same.example.test"},
                {entry_id: "bank-b", lp: 2, institution_id: "bank-b", origin: "SAME.example.test"},
                {entry_id: "bank-c", lp: 3, institution_id: "bank-c", origin: "other.example.test"}
            ],
            stages: ["discovery", "interpreted"],
            resourcePolicy: {
                max_active_institutions: 2,
                max_http_in_flight: 2,
                max_in_flight_per_origin: 1,
                max_in_flight_per_institution: 1,
                origin_delay_ms: 0,
                retry_after_cap_ms: 0
            },
            worker: async (stage, task) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                const origin = task.origin.toLowerCase();
                const count = (activeOrigins.get(origin) ?? 0) + 1;
                activeOrigins.set(origin, count);
                if (count > 1) sameOriginOverlap = true;
                await new Promise((resolve) => setTimeout(resolve, 3));
                active -= 1;
                activeOrigins.set(origin, count - 1);
                return {status: stage === "interpreted" ? "interpreted" : "discovered"};
            }
        });
        expect(result.results.every((entry) => entry.status === "completed")).toBe(true);
        expect(maxActive).toBe(2);
        expect(sameOriginOverlap).toBe(false);
        expect(result.telemetry.concurrency.active_peak).toBe(2);
        expect(result.telemetry.stages).toEqual(expect.arrayContaining([
            expect.objectContaining({stage: "discovery", tasks: 3}),
            expect.objectContaining({stage: "interpreted", tasks: 3})
        ]));
    });

    it("keeps deterministic result order while classifying terminal and fatal failures", async () => {
        const result = await runBoundedPipeline({
            runId: "run-20260806T180000Z-phase6failures",
            tasks: [
                {entry_id: "fatal-entry", lp: 3, institution_id: "fatal-entry", origin: "fatal.example.test"},
                {entry_id: "technical-entry", lp: 2, institution_id: "technical-entry", origin: "technical.example.test"},
                {entry_id: "completed-entry", lp: 1, institution_id: "completed-entry", origin: "completed.example.test"}
            ],
            stages: ["discovery", "interpreted"],
            resourcePolicy: {
                max_active_institutions: 3,
                max_http_in_flight: 3,
                max_in_flight_per_origin: 1,
                max_in_flight_per_institution: 1,
                origin_delay_ms: 0,
                retry_after_cap_ms: 0
            },
            worker: async (stage, task) => {
                if (stage === "discovery" && task.entry_id === "fatal-entry") {
                    const error = new Error("synthetic fatal");
                    error.code = "publication_io_failure";
                    throw error;
                }
                if (stage === "discovery" && task.entry_id === "technical-entry") {
                    return {status: "technical_error", terminal: true, error_code: "request_timeout_after_retries"};
                }
                return {status: "completed"};
            }
        });
        expect(result.results.map((entry) => entry.entry_id)).toEqual(["completed-entry", "technical-entry", "fatal-entry"]);
        expect(result.results.map((entry) => entry.status)).toEqual(["completed", "technical_error", "fatal_error"]);
        expect(result.telemetry.entries.map((entry) => entry.entry_id)).toEqual(["completed-entry", "technical-entry", "fatal-entry"]);
        expect(result.telemetry.errors).toEqual({fatal_count: 1, technical_error_count: 1});
    });

    it("reports Phase 6 benchmark coverage, cache reuse, resources and parity", async () => {
        const benchmark = await runResourceBenchmark({iterations: 2, entries: 10, urls: 3});
        expect(benchmark).toMatchObject({
            test_id: "T15",
            parity: true,
            profile: {origin_delay_ms: 500},
            coverage: {status: "complete", scope_count: 10, terminal_entry_count: 10},
            errors: {fatal_error_count: 0, entry_technical_error_count: 0}
        });
        expect(benchmark.cache.revalidated_not_modified).toBeGreaterThan(0);
        expect(benchmark.bytes.reused_from_cache).toBeGreaterThan(0);
        expect(benchmark.resources.max_rss_bytes).toBeGreaterThan(0);
    });

    it("keeps evidence and telemetry writes from concurrent processes", async () => {
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mortgage-phase6-locks-"));
        const evidencePath = path.join(temporaryRoot, "evidence.jsonl");
        const moduleUrl = pathToFileURL(path.join(ROOT, ".agents/skills/mortgage-refinancing-scan/lib/research-runtime.mjs")).href;
        const workers = Array.from({length: 6}, (_, index) => {
            const entryId = `lock-entry-${index + 1}`;
            const source = `
                import {makeTelemetryOperation, recordResearchTelemetry, replaceEvidenceForEntry} from ${JSON.stringify(moduleUrl)};
                const entry = ${JSON.stringify({entry_id: entryId, institution_id: entryId})};
                const run = {runRoot: ${JSON.stringify(temporaryRoot)}, manifest: {run_id: "run-20260806T180000Z-locks"}};
                recordResearchTelemetry(run, makeTelemetryOperation({operationId: "telemetry:" + entry.entry_id, stage: "fetched", entry, durationMs: 1}));
                replaceEvidenceForEntry(${JSON.stringify(evidencePath)}, entry.entry_id, [{entry_id: entry.entry_id, evidence_id: "evidence-" + entry.entry_id}]);
            `;
            return spawnWorker(source);
        });
        try {
            await Promise.all(workers);
            const telemetry = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "research-telemetry.json"), "utf8"));
            expect(telemetry.operations).toHaveLength(6);
            expect(readEvidenceJsonl(evidencePath)).toHaveLength(6);
        } finally {
            fs.rmSync(temporaryRoot, {recursive: true, force: true});
        }
    }, 60_000);
});

function nextRunId(label) {
    sequence += 1;
    return `run-20260806T18${String(sequence).padStart(4, "0")}Z-phase6${label}${process.pid}`;
}

function readOptional(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function spawnWorker(source) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
            cwd: ROOT,
            stdio: ["ignore", "ignore", "pipe"]
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`lock worker exited with ${code}: ${stderr}`));
        });
    });
}
