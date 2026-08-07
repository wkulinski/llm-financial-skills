import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

import {afterEach, describe, expect, it} from "vitest";

import {buildEvidenceForLiveEntry} from "../../.agents/skills/mortgage-refinancing-scan/lib/evidence.mjs";
import {discoverLiveEntry, fetchLiveEntrySources, rankAdaptiveCandidates} from "../../.agents/skills/mortgage-refinancing-scan/lib/live-research.mjs";
import {normalizeEntrySources} from "../../.agents/skills/mortgage-refinancing-scan/lib/normalization.mjs";
import {hostAllowed} from "../../.agents/skills/mortgage-refinancing-scan/lib/research-runtime.mjs";
import {validateSourceArtifact} from "../../.agents/skills/mortgage-refinancing-scan/lib/run-contract-validate.mjs";
import {initializeRun, loadRun, replayRun, transitionRun} from "../../.agents/skills/mortgage-refinancing-scan/lib/run-lifecycle.mjs";
import {runControlledScan} from "../../.agents/skills/mortgage-refinancing-scan/tools/runner.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const REGISTRY = path.join(ROOT, "tests/fixtures/mortgage-refinancing-scan-phase5-registry.json");
const FIXTURE = path.join(ROOT, "tests/fixtures/mortgage-refinancing-scan-interpretation.json");
const RUNS_ROOT = path.join(ROOT, "data/mortgage-refinancing-scan/work/runs");
const PUBLISHED_ROOT = path.join(ROOT, "data/mortgage-refinancing-scan/published");
const PHASE5_CACHE_ROOT = path.join(ROOT, `data/mortgage-refinancing-scan/cache/phase5-${process.pid}`);
const OBSERVED_AT = "2026-08-06T00:00:00Z";
const activeRuns = new Set();
let sequence = 0;

describe("mortgage-refinancing-scan Phase 5 controlled run", () => {
    let pointerBefore;

    afterEach(() => {
        for (const runId of activeRuns) {
            fs.rmSync(path.join(RUNS_ROOT, runId), {recursive: true, force: true});
            fs.rmSync(path.join(PUBLISHED_ROOT, runId), {recursive: true, force: true});
        }
        activeRuns.clear();
        fs.rmSync(PHASE5_CACHE_ROOT, {recursive: true, force: true});
        if (pointerBefore !== undefined) {
            restoreOptional(path.join(PUBLISHED_ROOT, "current.json"), pointerBefore);
        }
        pointerBefore = undefined;
    });

    it("runs an exact offline control scope through FINALIZED with a complete checkpoint", async () => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        const runId = nextRunId("offline");
        const report = await runControlledScan({
            registrySnapshot: REGISTRY,
            runRoot: "data/mortgage-refinancing-scan/work/runs",
            mode: "full",
            live: false,
            runId,
            fixture: FIXTURE,
            cacheRoot: `data/mortgage-refinancing-scan/cache/phase5-${process.pid}/${runId}`
        });
        activeRuns.add(runId);

        expect(report).toMatchObject({
                phase: "6",
            run_id: runId,
            mode: "test",
            status: "FINALIZED",
            scope_count: 6,
            checkpoint: {
                status: "ready",
                coverage_status: "complete",
                technical_error_count: 0
            }
        });
        expect(report.terminal_entry_count).toBe(6);
        expect(report.evidence_count).toBeGreaterThan(0);
        expect(report.publication_pointer).toBe("data/mortgage-refinancing-scan/published/current.json");
        expect(fs.readFileSync(path.join(PUBLISHED_ROOT, runId, "evidence.jsonl"), "utf8").trim()).not.toBe("");
        expect(fs.existsSync(path.join(ROOT, report.run_root, "publication.json"))).toBe(true);
        expect(new Map(report.entry_statuses.map((entry) => [entry.entry_id, entry.decision_status]))).toEqual(new Map([
            ["bank-positive", "qualified"],
            ["bank-own-costs", "explicitly_not_qualified"],
            ["bank-housing-only", "unconfirmed"],
            ["bank-variable", "explicitly_not_qualified"],
            ["bank-split-products", "unconfirmed"],
            ["bank-html-pdf", "qualified"]
        ]));
        expect(replayRun(loadRun(path.join(ROOT, report.manifest_path))).runState).toBe("FINALIZED");
    }, 60_000);

    it("keeps live transport auditable and revalidates a cached body on HTTP 304", async () => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        const registryEntry = {
            entry_id: "live-bank",
            lp: 1,
            institution_id: "live-bank",
            institution_type: "cooperative_bank",
            legal_name: "Live Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const first = createLiveRun(registryEntry);
        const firstDiscovery = await discoverLiveEntry({
            run: first,
            registryEntry,
            observationTime: OBSERVED_AT,
            fetchImpl: fakeLiveFetch
        });
        expect(firstDiscovery.candidates.map((candidate) => candidate.url)).toEqual([
            "https://live.example.test/kredyt-mieszkaniowy",
            "https://live.example.test/"
        ]);
        const firstFetched = await fetchLiveEntrySources({
            run: first,
            entry: registryEntry,
            registryEntry,
            discovery: firstDiscovery,
            observationTime: OBSERVED_AT,
            fetchImpl: fakeLiveFetch
        });
        const product = firstFetched.summary.source_artifacts.find((artifact) => artifact.canonical_url.endsWith("/kredyt-mieszkaniowy"));
        expect(product.cache_status).toBe("miss");
        expect(validateSourceArtifact(product, {manifest: first.manifest, context: first.context}).valid).toBe(true);

        const normalized = await normalizeEntrySources({
            run: first,
            fixtureEntry: registryEntry,
            fetchSummary: firstFetched.summary,
            observationTime: OBSERVED_AT,
            engine: "fixture"
        });
        const evidence = buildEvidenceForLiveEntry({
            run: first,
            entry: registryEntry,
            fetchSummary: firstFetched.summary,
            normalizationSummary: normalized.summary,
            observationTime: OBSERVED_AT
        });
        expect(evidence.failures).toEqual([]);
        expect(evidence.records).toHaveLength(3);
        expect(new Set(evidence.records.map((record) => `${record.product_id}:${record.variant_id}`)).size).toBe(1);
        expect(new Set(evidence.records.map((record) => record.content_sha256)).size).toBe(1);

        const second = createLiveRun(registryEntry);
        const secondDiscovery = await discoverLiveEntry({
            run: second,
            registryEntry,
            observationTime: OBSERVED_AT,
            fetchImpl: fakeLiveFetch
        });
        const secondFetched = await fetchLiveEntrySources({
            run: second,
            entry: registryEntry,
            registryEntry,
            discovery: secondDiscovery,
            observationTime: OBSERVED_AT,
            fetchImpl: fakeLiveFetch
        });
        expect(secondFetched.summary.source_artifacts.find((artifact) => artifact.canonical_url.endsWith("/kredyt-mieszkaniowy"))).toMatchObject({
            cache_status: "revalidated",
            http_status: 304,
            raw_content_sha256: product.raw_content_sha256
        });
    });

    it("throttles sequential live requests for one origin", async () => {
        const registryEntry = {
            entry_id: "throttled-live-bank",
            lp: 1,
            institution_id: "throttled-live-bank",
            institution_type: "cooperative_bank",
            legal_name: "Throttled Live Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const waits = [];
        await discoverLiveEntry({
            run,
            registryEntry,
            observationTime: OBSERVED_AT,
            fetchImpl: fakeLiveFetch,
            originDelayMs: 500,
            sleep: async (milliseconds) => waits.push(milliseconds)
        });
        expect(waits.length).toBeGreaterThan(0);
        expect(waits.every((milliseconds) => milliseconds > 0 && milliseconds <= 500)).toBe(true);
    });

    it("keeps origin throttling across retryable responses and candidate requests", async () => {
        const registryEntry = {
            entry_id: "retry-throttled-live-bank",
            lp: 1,
            institution_id: "retry-throttled-live-bank",
            institution_type: "cooperative_bank",
            legal_name: "Retry Throttled Live Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        let retry = true;
        const waits = [];
        const fetched = await fetchLiveEntrySources({
            run,
            entry: registryEntry,
            registryEntry,
            discovery: {
                artifact_id: "dsc-retry-throttle",
                robots: {status: "allow", robots_url: "https://live.example.test/robots.txt", denied_paths: [], allowed_paths: []},
                candidates: [
                    {url: "https://live.example.test/kredyt-mieszkaniowy", source_type: "official_product_page", required: true, redirect_chain: []},
                    {url: "https://live.example.test/", source_type: "official_product_page", required: false, redirect_chain: []}
                ]
            },
            observationTime: OBSERVED_AT,
            originDelayMs: 500,
            sleep: async (milliseconds) => waits.push(milliseconds),
            fetchImpl: async (url, options) => {
                if (new URL(url).pathname === "/kredyt-mieszkaniowy" && retry) {
                    retry = false;
                    return new Response("", {status: 500});
                }
                return fakeLiveFetch(url, options);
            }
        });
        expect(fetched.summary.source_artifacts).toHaveLength(2);
        expect(waits.some((milliseconds) => milliseconds >= 1000)).toBe(true);
        expect(waits.filter((milliseconds) => milliseconds > 0 && milliseconds <= 500).length).toBeGreaterThanOrEqual(2);
    });

    it("uses the homepage as a hard redirect boundary and a two-candidate threshold elsewhere", async () => {
        const registryEntry = {
            entry_id: "redirect-threshold-bank",
            lp: 1,
            institution_id: "redirect-threshold-bank",
            institution_type: "cooperative_bank",
            legal_name: "Redirect Threshold Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const discovery = (candidates) => ({
            artifact_id: "dsc-redirect-threshold",
            robots: {status: "allow", robots_url: "https://live.example.test/robots.txt", denied_paths: [], allowed_paths: []},
            candidates
        });
        const fetchImpl = async (url) => {
            const pathname = new URL(url).pathname;
            if (pathname.startsWith("/bad-")) {
                return new Response("", {status: 302, headers: {location: "https://outside.example.test/offer"}});
            }
            return new Response("<main>Kredyt mieszkaniowy Spłatę kredytu Oprocentowanie stałe</main>", {
                status: 200,
                headers: {"content-type": "text/html; charset=utf-8"}
            });
        };
        const candidate = (name) => ({
            url: `https://live.example.test/${name}`,
            source_type: "official_product_page",
            required: false,
            redirect_chain: []
        });
        const oneFailure = await fetchLiveEntrySources({
            run,
            entry: registryEntry,
            registryEntry,
            discovery: discovery([candidate("bad-one"), candidate("good-one")]),
            observationTime: OBSERVED_AT,
            fetchImpl
        });
        expect(oneFailure.technicalError).toBeNull();
        expect(oneFailure.summary.source_artifacts).toHaveLength(1);
        const twoFailures = await fetchLiveEntrySources({
            run,
            entry: registryEntry,
            registryEntry,
            discovery: discovery([candidate("bad-one"), candidate("bad-two"), candidate("good-two")]),
            observationTime: OBSERVED_AT,
            fetchImpl
        });
        expect(twoFailures.technicalError).toMatchObject({code: "official_host_violation", required: true});
        expect(twoFailures.summary.source_artifacts).toHaveLength(1);
    });

    it("selects high-value candidates first and defers the long tail after signals are complete", async () => {
        const registryEntry = {
            entry_id: "adaptive-selection-bank",
            lp: 1,
            institution_id: "adaptive-selection-bank",
            institution_type: "cooperative_bank",
            legal_name: "Adaptive Selection Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const candidates = [
            {url: "https://live.example.test/kredyt-mieszkaniowy-refinansowanie-oprocentowanie-stale", source_type: "official_product_page", required: false},
            ...Array.from({length: 9}, (_, index) => ({
                url: `https://live.example.test/kontakt-${index + 1}`,
                source_type: "official_product_page",
                required: false
            }))
        ];
        const order = [];
        const result = await fetchLiveEntrySources({
            run,
            entry: registryEntry,
            registryEntry,
            discovery: {
                artifact_id: "dsc-adaptive-selection",
                robots: {status: "allow", robots_url: "https://live.example.test/robots.txt", denied_paths: [], allowed_paths: []},
                candidates: rankAdaptiveCandidates(candidates)
            },
            observationTime: OBSERVED_AT,
            fetchImpl: async (url) => {
                order.push(url);
                return new Response("<main>Kredyt mieszkaniowy. Spłata kredytu zaciągniętego w innym banku. Oprocentowanie stałe. RRSO 6,70%.</main>", {
                    status: 200,
                    headers: {"content-type": "text/html; charset=utf-8"}
                });
            }
        });
        expect(order[0]).toContain("kredyt-mieszkaniowy-refinansowanie-oprocentowanie-stale");
        expect(order.length).toBe(8);
        expect(result.summary.selection).toMatchObject({
            policy: "adaptive-priority-v1",
            candidate_count: 10,
            fetched_candidate_count: 8,
            deferred_candidate_count: 2,
            stop_reason: "single_source_bundle_signals_complete"
        });
        expect(result.summary.skipped).toHaveLength(2);
    });

    it("does not stop when the three signals are split across source pages", async () => {
        const registryEntry = {
            entry_id: "split-signal-selection-bank",
            lp: 1,
            institution_id: "split-signal-selection-bank",
            institution_type: "cooperative_bank",
            legal_name: "Split Signal Selection Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const candidates = [
            {url: "https://live.example.test/kredyt-mieszkaniowy", source_type: "official_product_page", required: false},
            {url: "https://live.example.test/refinansowanie", source_type: "official_product_page", required: false},
            {url: "https://live.example.test/oprocentowanie-stale", source_type: "official_product_page", required: false},
            ...Array.from({length: 7}, (_, index) => ({url: `https://live.example.test/inne-${index + 1}`, source_type: "official_product_page", required: false}))
        ];
        const result = await fetchLiveEntrySources({
            run,
            entry: registryEntry,
            registryEntry,
            discovery: {
                artifact_id: "dsc-split-signal-selection",
                robots: {status: "allow", robots_url: "https://live.example.test/robots.txt", denied_paths: [], allowed_paths: []},
                candidates: rankAdaptiveCandidates(candidates)
            },
            observationTime: OBSERVED_AT,
            fetchImpl: async (url) => {
                const pathname = new URL(url).pathname;
                const body = pathname.includes("mieszkaniowy")
                    ? "Kredyt mieszkaniowy"
                    : pathname.includes("refinansowanie")
                        ? "Spłata kredytu zaciągniętego w innym banku"
                        : pathname.includes("stale")
                            ? "Oprocentowanie stałe"
                            : "Strona informacyjna";
                return new Response(`<main>${body}</main>`, {status: 200, headers: {"content-type": "text/html; charset=utf-8"}});
            }
        });
        expect(result.summary.selection).toMatchObject({
            candidate_count: 10,
            fetched_candidate_count: 10,
            deferred_candidate_count: 0,
            stop_reason: "candidate_budget_exhausted"
        });
    });

    it("treats an inaccessible robots.txt as unavailable and continues discovery", async () => {
        const registryEntry = {
            entry_id: "robots-bank",
            lp: 1,
            institution_id: "robots-bank",
            institution_type: "cooperative_bank",
            legal_name: "Robots Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const calls = [];
        const result = await discoverLiveEntry({
            run,
            registryEntry,
            observationTime: OBSERVED_AT,
            fetchImpl: async (url) => {
                calls.push(url);
                return new Response("", {status: 403});
            }
        });
        expect(result.robots.status).toBe("unavailable");
        expect(result.candidates).toEqual([]);
        expect(result.rejected).toEqual(expect.arrayContaining([
            expect.objectContaining({reason: "required_source_unavailable", required: false})
        ]));
        expect(calls).toEqual([
            "https://live.example.test/robots.txt",
            "https://live.example.test/sitemap.xml",
            "https://live.example.test/"
        ]);
    });

    it("continues discovery after a malformed robots redirect", async () => {
        const registryEntry = {
            entry_id: "robots-redirect-bank",
            lp: 1,
            institution_id: "robots-redirect-bank",
            institution_type: "cooperative_bank",
            legal_name: "Robots Redirect Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const calls = [];
        const result = await discoverLiveEntry({
            run,
            registryEntry,
            observationTime: OBSERVED_AT,
            fetchImpl: async (url) => {
                calls.push(url);
                if (new URL(url).pathname === "/robots.txt") {
                    return new Response("", {status: 302, headers: {location: "https://not-allowlisted.example.test/robots.txt"}});
                }
                return fakeLiveFetch(url);
            }
        });
        expect(result.robots.status).toBe("unavailable");
        expect(result.candidates.length).toBeGreaterThan(0);
        expect(result.rejected).toEqual(expect.arrayContaining([
            expect.objectContaining({reason: "official_host_violation", required: false})
        ]));
        expect(calls).toContain("https://live.example.test/");
    });

    it("treats a www and non-www host as the same registry origin", () => {
        const registryEntry = {
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"]
        };
        expect(hostAllowed("https://live.example.test/robots.txt", registryEntry)).toBe(true);
        expect(hostAllowed("https://www.live.example.test/robots.txt", registryEntry)).toBe(true);
        expect(hostAllowed("https://not-live.example.test/robots.txt", registryEntry)).toBe(false);
    });

    it("keeps distant live criteria in one provisional source-page identity", async () => {
        const registryEntry = {
            entry_id: "split-live-bank",
            lp: 1,
            institution_id: "split-live-bank",
            institution_type: "cooperative_bank",
            legal_name: "Split Live Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const discovery = await discoverLiveEntry({run, registryEntry, observationTime: OBSERVED_AT, fetchImpl: fakeLiveFetch});
        const fetched = await fetchLiveEntrySources({run, entry: registryEntry, registryEntry, discovery, observationTime: OBSERVED_AT, fetchImpl: longLiveFetch});
        const normalized = await normalizeEntrySources({run, fixtureEntry: registryEntry, fetchSummary: fetched.summary, observationTime: OBSERVED_AT, engine: "fixture"});
        const evidence = buildEvidenceForLiveEntry({run, entry: registryEntry, fetchSummary: fetched.summary, normalizationSummary: normalized.summary, observationTime: OBSERVED_AT});
        expect(evidence.failures).toEqual([]);
        expect(evidence.records.length).toBeGreaterThanOrEqual(2);
        expect(new Set(evidence.records.map((record) => `${record.product_id}:${record.variant_id}`)).size).toBe(1);
    });

    it("keeps separator-delimited live criteria in one provisional source-page identity", async () => {
        const registryEntry = {
            entry_id: "separator-live-bank",
            lp: 1,
            institution_id: "separator-live-bank",
            institution_type: "cooperative_bank",
            legal_name: "Separator Live Bank Spółdzielczy",
            official_hosts: ["live.example.test"],
            allowed_redirect_hosts: ["live.example.test"],
            registry_sources: ["fixture"],
            observed_at: OBSERVED_AT
        };
        const run = createLiveRun(registryEntry);
        const discovery = await discoverLiveEntry({run, registryEntry, observationTime: OBSERVED_AT, fetchImpl: fakeLiveFetch});
        const fetched = await fetchLiveEntrySources({run, entry: registryEntry, registryEntry, discovery, observationTime: OBSERVED_AT, fetchImpl: separatorLiveFetch});
        const normalized = await normalizeEntrySources({run, fixtureEntry: registryEntry, fetchSummary: fetched.summary, observationTime: OBSERVED_AT, engine: "fixture"});
        const evidence = buildEvidenceForLiveEntry({run, entry: registryEntry, fetchSummary: fetched.summary, normalizationSummary: normalized.summary, observationTime: OBSERVED_AT});
        expect(evidence.failures).toEqual([]);
        expect(new Set(evidence.records.map((record) => `${record.product_id}:${record.variant_id}`)).size).toBe(1);
    });

    it("aborts a prepared run instead of leaving a partial live lifecycle", async () => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        const fixturePath = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), "phase5-abort-")), "empty.json");
        fs.writeFileSync(fixturePath, JSON.stringify({network: false, entries: []}));
        const runId = nextRunId("abort");
        const report = await runControlledScan({
            registrySnapshot: REGISTRY,
            runRoot: "data/mortgage-refinancing-scan/work/runs",
            mode: "full",
            live: false,
            runId,
            fixture: fixturePath
        });
        activeRuns.add(runId);
        expect(report).toMatchObject({status: "ABORTED", run_id: runId});
        expect(report.abort_reason).toMatch(/fixture|entry/i);
        expect(report.publication).toBeNull();
        expect(fs.existsSync(path.join(PUBLISHED_ROOT, runId))).toBe(false);
        fs.rmSync(path.dirname(fixturePath), {recursive: true, force: true});
    });

    it("recovers a pointer-write finalize fault as FINALIZED, not ABORTED", async () => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, "current.json"));
        const runId = nextRunId("recover");
        const report = await runControlledScan({
            registrySnapshot: REGISTRY,
            runRoot: "data/mortgage-refinancing-scan/work/runs",
            mode: "full",
            live: false,
            runId,
            fixture: FIXTURE,
            faultAt: "finalize-after-pointer-write",
            cacheRoot: `data/mortgage-refinancing-scan/cache/phase5-${process.pid}/${runId}`
        });
        activeRuns.add(runId);
        expect(report.status).toBe("FINALIZED");
        expect(replayRun(loadRun(path.join(ROOT, report.manifest_path))).runState).toBe("FINALIZED");
        expect(report.publication_pointer).toBe("data/mortgage-refinancing-scan/published/current.json");
    }, 60_000);

    it("keeps the T13 runner agent restricted to the standalone skill and runner CLI", () => {
        const agent = fs.readFileSync(path.join(ROOT, ".opencode/agents/mortgage-refinancing-scan-runner.md"), "utf8");
        expect(agent).toContain("mode: primary");
        expect(agent).toContain("mortgage-refinancing-scan");
        expect(agent).toContain("tools/runner.mjs");
        expect(agent).toContain("edit: deny");
        expect(agent).toContain("task: deny");
        expect(agent).not.toContain(".agents/skills/bank-market-scan");
        expect(agent).not.toContain("bank-market-scan: allow");
    });

    it("preserves Morfeusz analysis spans for repeated Unicode tokens", () => {
        const python = path.join(ROOT, ".venv/bin/python");
        const worker = path.join(ROOT, ".agents/skills/mortgage-refinancing-scan/tools/morfeusz2-worker.py");
        const text = "Spłatę kredytu mieszkaniowego. Spłatę kredytu mieszkaniowego.";
        const result = spawnSync(python, [worker], {
            input: `${JSON.stringify({action: "analyze", text})}\n`,
            encoding: "utf8"
        });
        expect(result.status).toBe(0);
        const payload = JSON.parse(result.stdout);
        expect(payload.tokens.length).toBeGreaterThan(6);
        expect(payload.tokens.every((token) => text.slice(token.start, token.end) === token.surface)).toBe(true);
        const repeated = payload.tokens.filter((token) => token.surface === "Spłatę");
        expect(repeated).toHaveLength(2);
        expect(repeated[1].start).toBeGreaterThan(repeated[0].start);
        expect(repeated[1].analysis_start).toBeGreaterThan(repeated[0].analysis_start);
        expect(repeated.every((token) => token.analysis_end > token.analysis_start)).toBe(true);
    });
});

function createLiveRun(registryEntry) {
    const snapshot = {
        schema_version: "1.0.0",
        snapshot_id: `phase5-live-${registryEntry.entry_id}`,
        source_kind: "fixture",
        observed_at: OBSERVED_AT,
        entries: [registryEntry]
    };
    const snapshotPath = path.join(ROOT, "data/mortgage-refinancing-scan/work", `${registryEntry.entry_id}-snapshot.json`);
    fs.mkdirSync(path.dirname(snapshotPath), {recursive: true});
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    const runId = nextRunId("live");
    const init = initializeRun({
        registrySnapshotPath: snapshotPath,
        mode: "full",
        live: true,
        runRoot: "data/mortgage-refinancing-scan/work/runs",
        runId,
        cwd: ROOT
    });
    activeRuns.add(runId);
    const run = loadRun(path.join(ROOT, init.manifest_path));
    transitionRun(run, "RUNNING");
    fs.rmSync(snapshotPath, {force: true});
    const loaded = loadRun(run.manifestPath);
    loaded.context.transport_cache_root = `data/mortgage-refinancing-scan/cache/phase5-${process.pid}/live/http`;
    loaded.context.normalization_cache_root = `data/mortgage-refinancing-scan/cache/phase5-${process.pid}/live/normalized`;
    return loaded;
}

function fakeLiveFetch(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.pathname === "/robots.txt") {
        return Promise.resolve(new Response("User-agent: *\nAllow: /\nSitemap: https://live.example.test/sitemap.xml\n", {
            status: 200,
            headers: {"content-type": "text/plain; charset=utf-8"}
        }));
    }
    if (parsed.pathname === "/sitemap.xml") {
        return Promise.resolve(new Response("<urlset><url><loc>https://live.example.test/kredyt-mieszkaniowy</loc></url></urlset>", {
            status: 200,
            headers: {"content-type": "application/xml"}
        }));
    }
    if (parsed.pathname === "/kredyt-mieszkaniowy") {
        const conditional = options.headers?.["if-none-match"] ?? options.headers?.["If-None-Match"];
        if (conditional === '"live-v1"') {
            return Promise.resolve(new Response(null, {status: 304, headers: {ETag: '"live-v1"'}}));
        }
        return Promise.resolve(new Response(
            "<main>Kredyt mieszkaniowy Spłatę kredytu mieszkaniowego zaciągniętego w innym banku Oprocentowanie okresowo stałe przez 5 lat</main>",
            {status: 200, headers: {"content-type": "text/html; charset=utf-8", ETag: '"live-v1"'}}
        ));
    }
    return Promise.resolve(new Response(
        '<html><body><a href="/kredyt-mieszkaniowy">Oferta</a></body></html>',
        {status: 200, headers: {"content-type": "text/html; charset=utf-8"}}
    ));
}

function longLiveFetch(url, options = {}) {
    if (new URL(url).pathname === "/kredyt-mieszkaniowy") {
        const filler = "neutralny opis oferty bez kryterium ".repeat(15);
        return Promise.resolve(new Response(
            `<main>${filler}Kredyt mieszkaniowy${filler}Spłatę kredytu${filler}Oprocentowanie stałe${filler}</main>`,
            {status: 200, headers: {"content-type": "text/html; charset=utf-8"}}
        ));
    }
    return fakeLiveFetch(url, options);
}

function separatorLiveFetch(url, options = {}) {
    if (new URL(url).pathname === "/kredyt-mieszkaniowy") {
        return Promise.resolve(new Response(
            "<main>Kredyt mieszkaniowy | Spłatę kredytu | Oprocentowanie stałe</main>",
            {status: 200, headers: {"content-type": "text/html; charset=utf-8"}}
        ));
    }
    return fakeLiveFetch(url, options);
}

function nextRunId(label) {
    sequence += 1;
    return `run-20260806T15${String(sequence).padStart(4, "0")}Z-phase5${label}${process.pid}`;
}

function readOptional(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function restoreOptional(filePath, content) {
    if (content === null || content === undefined) {
        fs.rmSync(filePath, {force: true});
        return;
    }
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(filePath, content, "utf8");
}
