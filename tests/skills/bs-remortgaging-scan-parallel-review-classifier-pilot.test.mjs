import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {spawnSync} from "node:child_process";

import {afterEach, describe, expect, it, vi} from "vitest";

vi.mock("node:child_process", async () => {
    const actual = await vi.importActual("node:child_process");
    return {...actual, spawn: vi.fn()};
});

import {spawn} from "node:child_process";

import {
    DEFAULT_BATCH_CONCURRENCY,
    DEFAULT_BATCH_PAGES,
    EXTRACT_SOURCE_SCHEMA_VERSION,
    DEFAULT_TIMEOUT_MS,
    MAX_STREAM_BYTES,
    MODEL,
    MODEL_SCHEMA_VERSION,
    PilotError,
    REPORT_SCHEMA_VERSION,
    VARIANT,
    VARIANTS,
    aggregatePromptSha256,
    buildBatches,
    buildExtractPromptEntries,
    buildPrompt,
    defaultRunner,
    extractJsonPayload,
    parseModelJsonl,
    partitionEntries,
    resolveGroundedQuote,
    rollupBanks,
    runClassifier,
    validateExtractPack,
    validateModelResponse
} from "../../.agents/skills/bs-remortgaging-scan/lib/parallel-review-classifier-pilot.mjs";
import {
    ENDPOINT as SEARCH_ENDPOINT,
    REPORT_SCHEMA_VERSION as SEARCH_REPORT_SCHEMA_VERSION,
    runPilot as runSearchPilot
} from "../../.agents/skills/bs-remortgaging-scan/lib/parallel-search-pilot.mjs";
import {
    ENDPOINT as EXTRACT_ENDPOINT,
    REPORT_SCHEMA_VERSION as EXTRACT_REPORT_SCHEMA_VERSION,
    runExtractPilot
} from "../../.agents/skills/bs-remortgaging-scan/lib/parallel-extract-pilot.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const TOOL = path.join(ROOT, ".agents/skills/bs-remortgaging-scan/tools/parallel-review-classifier-pilot.mjs");

const tmpDirs = new Set();

function packFixture() {
    return extractPackFixture();
}

function extractPackFixture() {
    return {
        schema_version: EXTRACT_SOURCE_SCHEMA_VERSION,
        generated_at: "2026-08-31T00:00:00Z",
        dry_run: false,
        source_report: {path: "/tmp/search.json", sha256: "s", schema_version: "parallel-search-pilot/1.0.0"},
        config: {},
        summary: {},
        banks: [{
            bank: {institution_id: "bank_flat", legal_name: "Bank Flat", official_hosts: ["flat.pl"], allowed_redirect_hosts: []},
            preflight: {
                enabled: true,
                skipped_candidate_count: 0,
                skipped: [],
                remaining_candidate_count: 4,
                outcome: "continue",
                reason: null
            },
            pages: [
                {
                    status: "ok",
                    url: "https://flat.pl/kredyt-mieszkaniowy",
                    submitted_url: "https://flat.pl/kredyt-mieszkaniowy",
                    title: "Kredyt mieszkaniowy",
                    publish_date: null,
                    warnings: [],
                    content: {
                        full_content: {
                            text: "Kredyt pozwala na spłatę kredytu mieszkaniowego w innym banku. Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy.",
                            original_chars: 111,
                            stored_chars: 111,
                            truncated: false,
                            sha256: "h1"
                        },
                        excerpts: {
                            items: ["spłata kredytu mieszkaniowego"],
                            original_chars: 29,
                            stored_chars: 29,
                            truncated: false,
                            sha256: "e1"
                        }
                    },
                    direct_links: [{
                        link_id: "link-1",
                        url: "https://flat.pl/oprocentowanie",
                        anchor_text: "Oprocentowanie okresowo-stałe",
                        context: "Okresowo stałe oprocentowanie kredytu mieszkaniowego."
                    }]
                },
                {
                    status: "ok",
                    url: "https://flat.pl/pozyczka",
                    submitted_url: "https://flat.pl/pozyczka",
                    title: "Pożyczka",
                    publish_date: null,
                    warnings: [],
                    content: {
                        full_content: {
                            text: "Pożyczka hipoteczna na dowolny cel.",
                            original_chars: 34,
                            stored_chars: 34,
                            truncated: false,
                            sha256: "h2"
                        },
                        excerpts: {
                            items: ["okresowo stałe oprocentowanie"],
                            original_chars: 29,
                            stored_chars: 29,
                            truncated: false,
                            sha256: "e2"
                        }
                    }
                },
                {
                    status: "error",
                    url: "https://flat.pl/nieudana",
                    submitted_url: "https://flat.pl/nieudana",
                    error: {code: "http_error", message: "HTTP 500"}
                },
                {
                    status: "ok",
                    url: "https://flat.pl/konto",
                    submitted_url: "https://flat.pl/konto",
                    title: "Konto osobiste",
                    content: {
                        full_content: {
                            text: "Konto osobiste dla klientów indywidualnych.",
                            original_chars: 44,
                            stored_chars: 44,
                            truncated: false,
                            sha256: "h3"
                        },
                        excerpts: {
                            items: ["okresowo stałe oprocentowanie"],
                            original_chars: 29,
                            stored_chars: 29,
                            truncated: false,
                            sha256: "e3"
                        }
                    }
                }
            ]
        }]
    };
}

function modelResponse(promptMeta) {
    return flatModelResponse(promptMeta, {
        "p1-1": {
            label: "exact_offer",
            refinancing_eligibility: "yes",
            periodic_fixed_rate: "yes",
            confidence: "high",
            evidence: [
                {claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"},
                {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
            ],
            rationale: "Strona banku pozwala spłacić kredyt mieszkaniowy z innego banku i oferuje okresowo stałe oprocentowanie."
        },
        "p1-2": {
            label: "related_page",
            refinancing_eligibility: "unknown",
            periodic_fixed_rate: "unknown",
            confidence: "medium",
            rationale: "Ogólny kredyt hipoteczny bez potwierdzonego refinansowania i stałej stopy."
        },
        "p1-3": {
            label: "unresolved",
            refinancing_eligibility: "unknown",
            periodic_fixed_rate: "unknown",
            confidence: "low",
            rationale: "Fetch failed, brak treści do klasyfikacji."
        },
        "p1-4": {
            label: "noise",
            refinancing_eligibility: "no",
            periodic_fixed_rate: "no",
            confidence: "medium",
            rationale: "Produkty niezwiązane z kredytami hipotecznymi."
        }
    });
}

function textEvent(text) {
    return {type: "text", part: {type: "text", text}};
}

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {"content-type": "application/json"}
    });
}

/**
 * Model response for a flat Extract prompt: every page defaults to
 * unresolved; per-page overrides may replace any page entry.
 */
function flatModelResponse(promptMeta, overrides = {}) {
    return {
        schema_version: MODEL_SCHEMA_VERSION,
        pages: promptMeta.pages.map((meta) => ({
            page_id: meta.page_id,
            label: "unresolved",
            refinancing_eligibility: "unknown",
            periodic_fixed_rate: "unknown",
            confidence: "low",
            evidence: [],
            missing_claims: [],
            requested_link_ids: [],
            rationale: "No content available.",
            ...(overrides[meta.page_id] ?? {})
        }))
    };
}

function singlePageFollowupPack() {
    const pack = structuredClone(extractPackFixture());
    pack.banks[0].pages = [pack.banks[0].pages[0]];
    const rootText = "Oferta umożliwia spłatę kredytu mieszkaniowego w innym banku.";
    pack.banks[0].pages[0].content.full_content = {
        text: rootText,
        original_chars: rootText.length,
        stored_chars: rootText.length,
        truncated: false,
        sha256: "root-followup"
    };
    return pack;
}

function needsMoreResponse(pageId = "p1-1", requestedLinkIds = ["link-1"]) {
    return {
        schema_version: MODEL_SCHEMA_VERSION,
        pages: [{
            page_id: pageId,
            label: "needs_more_evidence",
            refinancing_eligibility: "yes",
            periodic_fixed_rate: "unknown",
            confidence: "medium",
            evidence: [],
            missing_claims: ["fixed_rate"],
            requested_link_ids: requestedLinkIds,
            rationale: "The product page establishes refinancing, but the linked rate document must be read."
        }]
    };
}

function finalFollowupExactResponse(pageId = "p1-1") {
    return {
        schema_version: MODEL_SCHEMA_VERSION,
        pages: [{
            page_id: pageId,
            label: "exact_offer",
            refinancing_eligibility: "yes",
            periodic_fixed_rate: "yes",
            confidence: "high",
            evidence: [
                {claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"},
                {claim: "fixed_rate", source_id: "source-2", quote: "Stała stopa obowiązuje przez pierwszych 60 miesięcy"}
            ],
            missing_claims: [],
            requested_link_ids: [],
            rationale: "The root and its directly linked rate document establish both criteria."
        }]
    };
}

function stepFinish() {
    return {type: "step_finish", step: {sessionID: "sess-abc", tokens: {input: 100, output: 50, total: 150}, cost: 0.0123}};
}

function jsonlFor(response) {
    return [
        JSON.stringify({type: "step_start", step: {}}),
        JSON.stringify(textEvent(JSON.stringify(response))),
        JSON.stringify(stepFinish())
    ].join("\n") + "\n";
}

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.unref = vi.fn();
    return child;
}

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tmpDirs) {
        fs.rmSync(dir, {recursive: true, force: true});
    }
    tmpDirs.clear();
});

describe("prompt building", () => {
    it("contains definitions, exact page ids and complete page evidence", () => {
        const promptMeta = buildPrompt(packFixture());
        expect(promptMeta.page_count).toBe(4);
        expect(promptMeta.pages.map((entry) => entry.page_id)).toEqual(["p1-1", "p1-2", "p1-3", "p1-4"]);
        const {prompt} = promptMeta;
        for (const label of ["exact_offer", "related_page", "noise", "unresolved"]) {
            expect(prompt).toContain(label);
        }
        expect(prompt).toContain(MODEL_SCHEMA_VERSION);
        expect(prompt).toContain("PAGE_COUNT: 4");
        expect(prompt).toContain("PAGE_IDS: p1-1, p1-2, p1-3, p1-4");
        for (const pageId of ["p1-1", "p1-2", "p1-3", "p1-4"]) {
            expect(prompt).toContain(pageId);
        }
        expect(prompt).toContain("Do not use tools");
        expect(prompt).toContain("spłatę kredytu mieszkaniowego w innym banku");
        expect(prompt).toContain("Oprocentowanie okresowo stałe");
        expect(promptMeta.pages[2].evidence).toBe("");
        expect(promptMeta.pages[2].status).toBe("error");
        expect(promptMeta.prompt_sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(promptMeta.prompt_chars).toBe(prompt.length);
    });

    it("builds one independent review item per flat Extract page with the full stored content", () => {
        const pack = extractPackFixture();
        const entries = buildExtractPromptEntries(pack);
        expect(entries).toHaveLength(4);
        expect(entries.map((entry) => entry.page_id)).toEqual(["p1-1", "p1-2", "p1-3", "p1-4"]);
        const fullText = pack.banks[0].pages[0].content.full_content.text;
        expect(entries[0]).toMatchObject({
            page_id: "p1-1",
            status: "ok",
            url: "https://flat.pl/kredyt-mieszkaniowy",
            title: "Kredyt mieszkaniowy",
            full_content: {
                original_chars: 111,
                stored_chars: 111,
                truncated: false,
                sha256: "h1"
            }
        });
        expect(entries[0].evidence).toBe(fullText);
        expect(entries[2].status).toBe("error");
        expect(entries[2].evidence).toBe("");
        expect(entries[2].error).toMatchObject({code: "http_error"});
        expect(entries[3].status).toBe("ok");
        expect(entries[3].evidence).toContain("Konto osobiste");
        const promptMeta = buildPrompt(pack);
        expect(promptMeta.page_count).toBe(4);
        expect(promptMeta.prompt).toContain(fullText);
        expect(promptMeta.prompt).not.toContain("SEARCH EXCERPTS:");
        expect(promptMeta.prompt).not.toContain("ONE item is exactly ONE offer bundle");
        expect(promptMeta.prompt).not.toContain("spłata kredytu mieszkaniowego");
        expect(promptMeta.prompt).not.toContain("okresowo stałe oprocentowanie");
    });

    it("keeps the complete stored full content without an evidence cap or keyword windows", () => {
        const pack = extractPackFixture();
        const longText = "A".repeat(900) + " refinansowanie kredytu hipotecznego w innym banku stałe oprocentowanie " + "B".repeat(900);
        pack.banks[0].pages[0].content.full_content.text = longText;
        pack.banks[0].pages[0].content.full_content.original_chars = longText.length;
        pack.banks[0].pages[0].content.full_content.stored_chars = longText.length;
        const entries = buildExtractPromptEntries(pack);
        expect(entries[0].evidence).toBe(longText);
        expect(entries[0].full_content).toMatchObject({stored_chars: longText.length, truncated: false, sha256: "h1"});
        const promptMeta = buildPrompt(pack);
        expect(promptMeta.prompt).toContain("A".repeat(900));
        expect(promptMeta.prompt).toContain("B".repeat(900));
        expect(promptMeta.prompt).toContain("refinansowanie kredytu hipotecznego w innym banku stałe oprocentowanie");
    });
});

describe("model invocation", () => {
    it("invokes the runner with the exact Luna Max argv and prompt as final argument", async () => {
        const promptMeta = buildPrompt(packFixture());
        const runner = vi.fn(async () => ({stdout: jsonlFor(modelResponse(promptMeta)), stderr: ""}));
        const followupExtractor = vi.fn();
        const report = await runClassifier({batchPages: 4, sourceReport: packFixture(), prefilter: false, runner, followupExtractor});
        expect(runner).toHaveBeenCalledTimes(1);
        const [argv, options] = runner.mock.calls[0];
        expect(argv).toEqual(["run", "--model", MODEL, "--variant", VARIANT, "--format", "json", promptMeta.prompt]);
        expect(argv[argv.length - 1]).toBe(promptMeta.prompt);
        expect(options.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
        expect(options.maxBytes).toBe(MAX_STREAM_BYTES);
        expect(report.model).toEqual({model: MODEL, variant: VARIANT});
        expect(VARIANTS).toEqual(["low", "medium", "high", "max"]);
        expect(followupExtractor).not.toHaveBeenCalled();
        expect(report.followup).toBeNull();
    });

    it("passes an explicitly selected medium variant to the runner and records it", async () => {
        const promptMeta = buildPrompt(packFixture());
        const runner = vi.fn(async () => ({stdout: jsonlFor(modelResponse(promptMeta)), stderr: ""}));

        const report = await runClassifier({batchPages: 4, sourceReport: packFixture(), prefilter: false, runner, variant: "medium"});

        const [argv] = runner.mock.calls[0];
        expect(argv).toEqual(["run", "--model", MODEL, "--variant", "medium", "--format", "json", promptMeta.prompt]);
        expect(report.model).toEqual({model: MODEL, variant: "medium"});
    });

    it("runs one Zlotow-like follow-up and grounds the final offer across root and selected document sources", async () => {
        const pack = singlePageFollowupPack();
        const runner = vi.fn()
            .mockResolvedValueOnce({stdout: jsonlFor(needsMoreResponse()), stderr: ""})
            .mockResolvedValueOnce({stdout: jsonlFor(finalFollowupExactResponse()), stderr: ""});
        const followupExtractor = vi.fn(async ({bank, sourcePage, selected}) => {
            expect(bank.institution_id).toBe("bank_flat");
            expect(sourcePage.url).toBe("https://flat.pl/kredyt-mieszkaniowy");
            expect(selected).toEqual([expect.objectContaining({link_id: "link-1", url: "https://flat.pl/oprocentowanie"})]);
            return {
                pages: [{
                    status: "ok",
                    link_id: "link-1",
                    source_url: sourcePage.url,
                    url: "https://flat.pl/oprocentowanie",
                    content: {full_content: {text: "Stała stopa obowiązuje przez pierwszych 60 miesięcy"}}
                }]
            };
        });

        const report = await runClassifier({batchPages: 4, sourceReport: pack, prefilter: false, runner, followupExtractor, apiKey: "test-key"});

        expect(runner).toHaveBeenCalledTimes(2);
        expect(followupExtractor).toHaveBeenCalledTimes(1);
        expect(runner.mock.calls[0][0].at(-1)).toContain("DIRECT LINKS (metadata only");
        expect(runner.mock.calls[1][0].at(-1)).toContain("Follow-up round");
        expect(runner.mock.calls[1][0].at(-1)).toContain("EVIDENCE TEXT (source-2)");
        expect(report.pages[0]).toMatchObject({
            label: "exact_offer",
            round: 2,
            requested_link_ids: ["link-1"],
            evidence: [
                {claim: "refinancing", source_id: "source-1"},
                {claim: "fixed_rate", source_id: "source-2"}
            ]
        });
        expect(report.followup.requested[0]).toMatchObject({outcome: "classified", requested_link_ids: ["link-1"]});
    });

    it("finalizes a failed follow-up fetch as unresolved without a second model round", async () => {
        const runner = vi.fn().mockResolvedValueOnce({stdout: jsonlFor(needsMoreResponse()), stderr: ""});
        const followupExtractor = vi.fn(async () => ({
            pages: [{status: "error", link_id: "link-1", url: "https://flat.pl/oprocentowanie", error: {code: "http_error", message: "HTTP 500"}}]
        }));

        const report = await runClassifier({batchPages: 4, sourceReport: singlePageFollowupPack(), prefilter: false, runner, followupExtractor});

        expect(runner).toHaveBeenCalledTimes(1);
        expect(followupExtractor).toHaveBeenCalledTimes(1);
        expect(report.pages[0]).toMatchObject({label: "unresolved", round: 2, evidence: []});
        expect(report.followup.requested[0].outcome).toBe("fetch_failed");
        expect(report.followup.invocations).toEqual([]);
    });

    it("does not hide a missing follow-up API key as a successful unresolved classification", async () => {
        const runner = vi.fn().mockResolvedValueOnce({stdout: jsonlFor(needsMoreResponse()), stderr: ""});
        const followupExtractor = vi.fn(async () => {
            throw new PilotError("missing_api_key", "PARALLEL_API_KEY is required for a live run", {exitCode: 20});
        });

        await expect(runClassifier({batchPages: 4, sourceReport: singlePageFollowupPack(), prefilter: false, runner, followupExtractor}))
            .rejects.toMatchObject({code: "missing_api_key", exitCode: 20});
        expect(runner).toHaveBeenCalledTimes(1);
        expect(followupExtractor).toHaveBeenCalledTimes(1);
    });

    it("does not follow a second-round link request and finalizes it as unresolved", async () => {
        const runner = vi.fn()
            .mockResolvedValueOnce({stdout: jsonlFor(needsMoreResponse()), stderr: ""})
            .mockResolvedValueOnce({stdout: jsonlFor(needsMoreResponse()), stderr: ""});
        const followupExtractor = vi.fn(async () => ({
            pages: [{
                status: "ok",
                link_id: "link-1",
                url: "https://flat.pl/oprocentowanie",
                content: {full_content: {text: "Dokument nie rozstrzyga warunków oprocentowania."}}
            }]
        }));

        const report = await runClassifier({batchPages: 4, sourceReport: singlePageFollowupPack(), prefilter: false, runner, followupExtractor});

        expect(runner).toHaveBeenCalledTimes(2);
        expect(followupExtractor).toHaveBeenCalledTimes(1);
        expect(report.pages[0]).toMatchObject({label: "unresolved", round: 2, evidence: []});
        expect(report.followup.requested[0].outcome).toBe("second_request");
    });

    it("retries one batch once after a model-contract failure and records both attempts", async () => {
        const promptMeta = buildPrompt(packFixture());
        const bad = modelResponse(promptMeta);
        bad.pages = bad.pages.map((page) => page.page_id === "p1-1"
            ? {...page, evidence: [{claim: "refinancing", source_id: "source-1", quote: "zmyślony cytat"}]}
            : page);
        const runner = vi.fn()
            .mockResolvedValueOnce({stdout: jsonlFor(bad), stderr: ""})
            .mockResolvedValueOnce({stdout: jsonlFor(modelResponse(promptMeta)), stderr: ""});

        const report = await runClassifier({batchPages: 4, sourceReport: packFixture(), prefilter: false, runner});

        expect(runner).toHaveBeenCalledTimes(2);
        expect(report.invocations[0]).toMatchObject({
            attempt_count: 2,
            attempts: [
                {attempt: 1, status: "invalid_model_contract", error_code: "invalid_model_response"},
                {attempt: 2, status: "ok"}
            ]
        });
    });

    it("defaultRunner spawns opencode with an argv array and no shell", async () => {
        const child = fakeChild();
        vi.mocked(spawn).mockReturnValue(child);
        const promise = defaultRunner(["run", "--format", "json", "PROMPT"], {timeoutMs: 2000, maxBytes: 4096});
        child.stdout.write('{"type":"step_start","step":{}}\n');
        child.stdout.write('{"type":"text","part":{"text":"{}"}}\n');
        child.stdout.end();
        await tick();
        child.emit("close", 0, null);
        const result = await promise;
        expect(spawn).toHaveBeenCalledWith("opencode", ["run", "--format", "json", "PROMPT"], expect.any(Object));
        const options = vi.mocked(spawn).mock.calls[0][2];
        expect(Array.isArray(vi.mocked(spawn).mock.calls[0][1])).toBe(true);
        expect(options.shell).toBeUndefined();
        expect(result.stdout).toContain('"type":"text"');
    });

    it("defaultRunner rejects on nonzero exit, timeout and stdout overflow", async () => {
        const child1 = fakeChild();
        vi.mocked(spawn).mockReturnValueOnce(child1);
        const nonzero = defaultRunner(["run"], {timeoutMs: 2000, maxBytes: 4096});
        child1.stderr.write("boom\n");
        child1.stderr.end();
        await tick();
        child1.emit("close", 1, null);
        await expect(nonzero).rejects.toMatchObject({code: "model_invocation_failed", exitCode: 20});

        const child2 = fakeChild();
        vi.mocked(spawn).mockReturnValueOnce(child2);
        const overflow = defaultRunner(["run"], {timeoutMs: 2000, maxBytes: 1024});
        child2.stdout.write("x".repeat(2048));
        await tick();
        child2.emit("close", null, "SIGKILL");
        await expect(overflow).rejects.toMatchObject({code: "model_output_overflow", exitCode: 20});
        expect(child2.kill).toHaveBeenCalledWith("SIGKILL");

        const child3 = fakeChild();
        vi.mocked(spawn).mockReturnValueOnce(child3);
        const timedOut = defaultRunner(["run"], {timeoutMs: 60, maxBytes: 4096});
        await expect(timedOut).rejects.toMatchObject({code: "model_timeout", exitCode: 20});
        child3.emit("close", null, "SIGTERM");
        expect(child3.kill).toHaveBeenCalledWith("SIGTERM");
        expect(child3.stdout.destroyed).toBe(true);
        expect(child3.stderr.destroyed).toBe(true);
        expect(child3.unref).toHaveBeenCalledTimes(1);
    });
});

describe("Search to Extract to classifier integration", () => {
    it("passes a flat Extract pack with same-page full content without network access", async () => {
        const registry = {
            entries: [{
                institution_id: "bank_pipeline",
                lp: 1,
                legal_name: "Bank Pipeline",
                official_hosts: ["bank.pl"],
                allowed_redirect_hosts: []
            }]
        };
        const searchFetch = vi.fn(async (url, options) => {
            expect(url).toBe(SEARCH_ENDPOINT);
            expect(options.method).toBe("POST");
            expect(JSON.parse(options.body).search_queries).toHaveLength(3);
            return jsonResponse({
                search_id: "search-pipeline-1",
                results: [{
                    url: "https://bank.pl/refinansowanie",
                    title: "Refinansowanie kredytu mieszkaniowego",
                    publish_date: null,
                    excerpts: ["refinansowanie kredytu mieszkaniowego"]
                }]
            });
        });
        const searchReport = await runSearchPilot({
            registry,
            limit: 1,
            apiKey: "search-test-key",
            fetchImpl: searchFetch
        });
        expect(searchReport.schema_version).toBe(SEARCH_REPORT_SCHEMA_VERSION);
        expect(searchFetch).toHaveBeenCalledTimes(1);

        const fullText = "Refinansowanie kredytu mieszkaniowego zaciągniętego w innym banku z okresowo stałym oprocentowaniem przez 60 miesięcy.";
        const extractFetch = vi.fn(async (url, options) => {
            expect(url).toBe(EXTRACT_ENDPOINT);
            expect(options.method).toBe("POST");
            expect(JSON.parse(options.body).urls).toEqual(["https://bank.pl/refinansowanie"]);
            return jsonResponse({
                results: [{
                    url: "https://bank.pl/refinansowanie",
                    title: "Refinansowanie kredytu mieszkaniowego",
                    full_content: fullText,
                    excerpts: ["EXCERPT ONLY TEXT"]
                }]
            });
        });
        const extractPack = await runExtractPilot({
            sourceReport: searchReport,
            apiKey: "extract-test-key",
            fetchImpl: extractFetch
        });
        expect(extractPack.schema_version).toBe(EXTRACT_REPORT_SCHEMA_VERSION);
        expect(extractPack.banks[0].pages[0].content.full_content.text).toBe(fullText);
        expect(extractFetch).toHaveBeenCalledTimes(1);

        const promptMeta = buildPrompt(extractPack);
        expect(promptMeta.prompt).not.toContain("EXCERPT ONLY TEXT");
        const runner = vi.fn(async (argv) => {
            expect(argv.at(-1)).toContain(fullText);
            return {
                stdout: jsonlFor(flatModelResponse(promptMeta, {
                    "p1-1": {
                        label: "exact_offer",
                        refinancing_eligibility: "yes",
                        periodic_fixed_rate: "yes",
                        confidence: "high",
                        evidence: [
                            {claim: "refinancing", source_id: "source-1", quote: "Refinansowanie kredytu mieszkaniowego zaciągniętego w innym banku"},
                            {claim: "fixed_rate", source_id: "source-1", quote: "okresowo stałym oprocentowaniem przez 60 miesięcy"}
                        ],
                        rationale: "The same extracted page establishes refinancing and a fixed rate."
                    }
                })),
                stderr: ""
            };
        });
        const classifierReport = await runClassifier({batchPages: 4, sourceReport: extractPack, prefilter: false, runner});
        expect(classifierReport.schema_version).toBe(REPORT_SCHEMA_VERSION);
        expect(classifierReport.summary).toMatchObject({page_count: 1, exact_offer: 1});
        expect(classifierReport.pages).toEqual([expect.objectContaining({page_id: "p1-1", label: "exact_offer"})]);
        expect(classifierReport.banks).toEqual([{
            bank: {institution_id: "bank_pipeline", legal_name: "Bank Pipeline"},
            label: "exact_offer",
            pages: [{page_id: "p1-1", url: "https://bank.pl/refinansowanie", label: "exact_offer"}]
        }]);
        expect(runner).toHaveBeenCalledTimes(1);
    });
});

describe("JSONL stream parsing", () => {
    it("extracts text payload and step_finish metadata", () => {
        const stdout = jsonlFor({schema_version: MODEL_SCHEMA_VERSION, pages: []});
        const {payload, metadata} = parseModelJsonl(stdout);
        expect(payload).toEqual({schema_version: MODEL_SCHEMA_VERSION, pages: []});
        expect(metadata).toEqual({session_id: "sess-abc", tokens: {input: 100, output: 50, total: 150}, cost: 0.0123});
    });

    it("extracts metadata from the current opencode step_finish part", () => {
        const stdout = [
            JSON.stringify(textEvent(JSON.stringify({schema_version: MODEL_SCHEMA_VERSION, pages: []}))),
            JSON.stringify({
                type: "step_finish",
                sessionID: "sess-current",
                part: {tokens: {input: 12, output: 3, total: 15}, cost: 0.004}
            })
        ].join("\n");
        expect(parseModelJsonl(stdout).metadata).toEqual({
            session_id: "sess-current",
            tokens: {input: 12, output: 3, total: 15},
            cost: 0.004
        });
    });

    it("tolerates a single deterministic ```json fence", () => {
        const stdout = JSON.stringify({type: "text", part: {text: "```json\n{\"a\":1}\n```"}}) + "\n";
        const {payload} = parseModelJsonl(stdout);
        expect(payload).toEqual({a: 1});
    });

    it("rejects malformed lines, missing text, multiple text events and empty payloads", () => {
        expect(() => parseModelJsonl("not json\n")).toThrow(/non-JSON/);
        expect(() => parseModelJsonl(`${JSON.stringify({type: "step_start"})}\n`)).toThrow(/no text event/);
        const two = `${JSON.stringify(textEvent("{}"))}\n${JSON.stringify(textEvent("{}"))}\n`;
        expect(() => parseModelJsonl(two)).toThrow(/multiple text events/);
        expect(() => parseModelJsonl(`${JSON.stringify({type: "text", part: {text: ""}})}\n`)).toThrow(/no text payload/);
    });

    it("rejects invalid JSON and non-deterministic fences", () => {
        expect(() => parseModelJsonl(`${JSON.stringify(textEvent("{oops"))}\n`)).toThrow(/not valid JSON/);
        expect(() => parseModelJsonl(`${JSON.stringify(textEvent("```\n{\"a\":1}\n```"))}\n`)).toThrow(/markdown fence/);
        expect(() => parseModelJsonl(`${JSON.stringify(textEvent("```json\n{\"a\":1}"))}\n`)).toThrow(/unclosed markdown fence/);
        expect(extractJsonPayload('{"a":1}')).toBe('{"a":1}');
    });
});

describe("model response validation", () => {
    it("grounds only exact source substrings without maintaining a second normalized text representation", () => {
        const source = "Oprocentowanie okresowo\n\nstałe przez 60 miesięcy";
        expect(resolveGroundedQuote(source, source)).toBe(source);
        expect(resolveGroundedQuote(source, "Oprocentowanie okresowo stałe przez 60 miesięcy"))
            .toBeNull();
        expect(resolveGroundedQuote(source, "oprocentowanie okresowo stałe"))
            .toBeNull();
    });

    it("does not rewrite OCR spaces or character substitutions during quote grounding", () => {
        const source = "sp ł at ę zad łużen ia z tytu łu kredytu mieszkaniowego udzielonego Wnioskodawcy przez inny bank";
        const normalized = "sp ł atę zad łużen ia z tytu łu kredytu mieszkaniowego udzielonego Wnioskodawcy przez inny bank";
        expect(resolveGroundedQuote(source, source)).toBe(source);
        expect(resolveGroundedQuote(source, normalized)).toBeNull();
        expect(resolveGroundedQuote("in ny bank", "inny bank")).toBeNull();
        expect(resolveGroundedQuote(source, normalized.replace("inny bank", "obcy bank"))).toBeNull();
    });

    it("accepts a fully valid model response", () => {
        const promptMeta = buildPrompt(packFixture());
        const pages = validateModelResponse(modelResponse(promptMeta), promptMeta);
        expect(pages).toHaveLength(4);
    });

    it("accepts only bounded existing unique link ids in a needs_more_evidence response", () => {
        const promptMeta = buildPrompt(singlePageFollowupPack());
        expect(validateModelResponse(needsMoreResponse(), promptMeta)[0]).toMatchObject({
            label: "needs_more_evidence",
            missing_claims: ["fixed_rate"],
            requested_link_ids: ["link-1"]
        });

        expect(() => validateModelResponse(needsMoreResponse("p1-1", ["link-404"]), promptMeta)).toThrow(/does not exist/);
        expect(() => validateModelResponse(needsMoreResponse("p1-1", ["link-1", "link-1"]), promptMeta)).toThrow(/duplicate requested link ids/);

        const manyLinksMeta = buildPrompt(singlePageFollowupPack());
        manyLinksMeta.pages[0].direct_links.push(
            {link_id: "link-2", url: "https://flat.pl/2"},
            {link_id: "link-3", url: "https://flat.pl/3"},
            {link_id: "link-4", url: "https://flat.pl/4"}
        );
        expect(() => validateModelResponse(needsMoreResponse("p1-1", ["link-1", "link-2", "link-3", "link-4"]), manyLinksMeta))
            .toThrow(/between 1 and 3 links/);

        const emptyClaims = needsMoreResponse();
        emptyClaims.pages[0].missing_claims = [];
        expect(() => validateModelResponse(emptyClaims, promptMeta)).toThrow(/non-empty missing_claims/);
    });

    it("does not allow link anchor metadata or an unknown source id to ground exact evidence", () => {
        const promptMeta = buildPrompt(singlePageFollowupPack());
        const anchorOnly = finalFollowupExactResponse();
        anchorOnly.pages[0].evidence[1] = {
            claim: "fixed_rate",
            source_id: "source-1",
            quote: "Oprocentowanie okresowo-stałe"
        };
        expect(() => validateModelResponse(anchorOnly, promptMeta)).toThrow(/not an exact substring/);

        const unknownSource = finalFollowupExactResponse();
        unknownSource.pages[0].evidence[1].source_id = "source-99";
        expect(() => validateModelResponse(unknownSource, promptMeta)).toThrow(/not among the permitted sources/);
    });

    it("rejects missing, duplicate and unknown page ids and wrong counts", () => {
        const promptMeta = buildPrompt(packFixture());
        const good = modelResponse(promptMeta);
        const missing = {...good, pages: good.pages.slice(0, 3)};
        expect(() => validateModelResponse(missing, promptMeta)).toThrow(/exactly 4 pages/);
        const duplicate = {...good, pages: [good.pages[0], good.pages[0], ...good.pages.slice(2)]};
        expect(() => validateModelResponse(duplicate, promptMeta)).toThrow(/duplicate page_id/);
        const unknown = {...good, pages: good.pages.map((page) => page.page_id === "p1-1" ? {...page, page_id: "p9-9"} : page)};
        expect(() => validateModelResponse(unknown, promptMeta)).toThrow(/unknown page_id/);
        const badSchema = {...good, schema_version: "other/1.0.0"};
        expect(() => validateModelResponse(badSchema, promptMeta)).toThrow(/schema_version/);
        expect(() => validateModelResponse([1, 2], promptMeta)).toThrow(/must be a JSON object/);
    });

    it("rejects hallucinated quotes", () => {
        const promptMeta = buildPrompt(packFixture());
        const good = modelResponse(promptMeta);
        const bad = {...good, pages: good.pages.map((page) => page.page_id === "p1-1"
            ? {...page, evidence: [{claim: "refinancing", source_id: "source-1", quote: "zupełnie zmyślony cytat"}]}
            : page)};
        expect(() => validateModelResponse(bad, promptMeta)).toThrow(/not an exact substring/);
    });

    it("rejects invalid enums and malformed evidence", () => {
        const promptMeta = buildPrompt(packFixture());
        const good = modelResponse(promptMeta);
        const badLabel = {...good, pages: good.pages.map((page) => page.page_id === "p1-4" ? {...page, label: "banana"} : page)};
        expect(() => validateModelResponse(badLabel, promptMeta)).toThrow(/invalid label/);
        const badEligibility = {...good, pages: good.pages.map((page) => page.page_id === "p1-4" ? {...page, refinancing_eligibility: "maybe"} : page)};
        expect(() => validateModelResponse(badEligibility, promptMeta)).toThrow(/invalid refinancing_eligibility/);
        const badRate = {...good, pages: good.pages.map((page) => page.page_id === "p1-4" ? {...page, periodic_fixed_rate: "sometimes"} : page)};
        expect(() => validateModelResponse(badRate, promptMeta)).toThrow(/invalid periodic_fixed_rate/);
        const badConfidence = {...good, pages: good.pages.map((page) => page.page_id === "p1-4" ? {...page, confidence: "certain"} : page)};
        expect(() => validateModelResponse(badConfidence, promptMeta)).toThrow(/invalid confidence/);
        const badClaim = {...good, pages: good.pages.map((page) => page.page_id === "p1-4"
            ? {...page, evidence: [{claim: "made_up", source_id: "source-1", quote: "Produkty oszczędnościowe"}]}
            : page)};
        expect(() => validateModelResponse(badClaim, promptMeta)).toThrow(/invalid claim/);
        const tooMany = {...good, pages: good.pages.map((page) => page.page_id === "p1-4"
            ? {...page, evidence: Array.from({length: 5}, () => ({claim: "context", source_id: "source-1", quote: "Produkty oszczędnościowe"}))}
            : page)};
        expect(() => validateModelResponse(tooMany, promptMeta)).toThrow(/0-4 items/);
    });

    it("rejects exact_offer missing either claim or eligibility", () => {
        const promptMeta = buildPrompt(packFixture());
        const good = modelResponse(promptMeta);
        const noRefinancing = {...good, pages: good.pages.map((page) => page.page_id === "p1-1"
            ? {...page, evidence: [{claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}]}
            : page)};
        expect(() => validateModelResponse(noRefinancing, promptMeta)).toThrow(/refinancing quote and one fixed_rate quote/);
        const noFixedRate = {...good, pages: good.pages.map((page) => page.page_id === "p1-1"
            ? {...page, evidence: [{claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"}]}
            : page)};
        expect(() => validateModelResponse(noFixedRate, promptMeta)).toThrow(/refinancing quote and one fixed_rate quote/);
        const noEligibility = {...good, pages: good.pages.map((page) => page.page_id === "p1-1" ? {...page, refinancing_eligibility: "no"} : page)};
        expect(() => validateModelResponse(noEligibility, promptMeta)).toThrow(/both yes/);
    });

    it("does not reinterpret a grounded refinancing claim with deterministic keyword rules", () => {
        const promptMeta = buildPrompt(packFixture());
        const exact = promptMeta.pages.find((page) => page.page_id === "p1-1");
        exact.evidence += " Spłatę kredytu mieszkaniowego przeznaczonego na wyżej wymienione cele.";
        const response = modelResponse(promptMeta);
        response.pages = response.pages.map((page) => page.page_id === "p1-1"
            ? {
                ...page,
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "Spłatę kredytu mieszkaniowego przeznaczonego na wyżej wymienione cele."},
                    {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
                ]
            }
            : page);

        const pages = validateModelResponse(response, promptMeta);
        const classified = pages.find((page) => page.page_id === "p1-1");
        expect(classified).toMatchObject({
            label: "exact_offer",
            refinancing_eligibility: "yes",
            periodic_fixed_rate: "yes",
            evidence: expect.arrayContaining([
                expect.objectContaining({claim: "refinancing", quote: "Spłatę kredytu mieszkaniowego przeznaczonego na wyżej wymienione cele."})
            ])
        });
    });

    it("keeps exact_offer when the refinancing quote explicitly describes refinancing of a mortgage loan without another-bank wording", () => {
        const promptMeta = buildPrompt(packFixture());
        const exact = promptMeta.pages.find((page) => page.page_id === "p1-1");
        exact.evidence += " Refinansowanie kredytu mieszkaniowego oferowane przez nasz bank.";
        const response = modelResponse(promptMeta);
        response.pages = response.pages.map((page) => page.page_id === "p1-1"
            ? {
                ...page,
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "Refinansowanie kredytu mieszkaniowego oferowane przez nasz bank."},
                    {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
                ]
            }
            : page);

        const pages = validateModelResponse(response, promptMeta);
        const exactPage = pages.find((page) => page.page_id === "p1-1");
        expect(exactPage).toMatchObject({
            label: "exact_offer",
            refinancing_eligibility: "yes",
            periodic_fixed_rate: "yes"
        });
    });

    it("keeps exact_offer when the refinancing quote explicitly describes transfer of a housing loan without another-bank wording", () => {
        const promptMeta = buildPrompt(packFixture());
        const exact = promptMeta.pages.find((page) => page.page_id === "p1-1");
        exact.evidence += " Przeniesienie kredytu hipotecznego do naszego banku.";
        const response = modelResponse(promptMeta);
        response.pages = response.pages.map((page) => page.page_id === "p1-1"
            ? {
                ...page,
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "Przeniesienie kredytu hipotecznego do naszego banku."},
                    {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
                ]
            }
            : page);

        const pages = validateModelResponse(response, promptMeta);
        const exactPage = pages.find((page) => page.page_id === "p1-1");
        expect(exactPage).toMatchObject({
            label: "exact_offer",
            refinancing_eligibility: "yes",
            periodic_fixed_rate: "yes"
        });
    });

    it("allows exact_offer from two exact quotes of the same flat Extract page", async () => {
        const pack = extractPackFixture();
        const promptMeta = buildPrompt(pack);
        const response = flatModelResponse(promptMeta, {
            "p1-1": {
                label: "exact_offer",
                refinancing_eligibility: "yes",
                periodic_fixed_rate: "yes",
                confidence: "high",
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"},
                    {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
                ],
                rationale: "The page itself establishes refinancing of mortgage debt at another bank and a periodically fixed rate."
            },
            "p1-2": {
                label: "related_page",
                refinancing_eligibility: "unknown",
                periodic_fixed_rate: "unknown",
                confidence: "medium",
                rationale: "Only a generic mortgage-backed loan."
            }
        });
        expect(validateModelResponse(structuredClone(response), promptMeta).map((page) => page.label))
            .toEqual(["exact_offer", "related_page", "unresolved", "unresolved"]);

        const runner = vi.fn(async () => ({stdout: jsonlFor(response), stderr: ""}));
        const report = await runClassifier({batchPages: 4, sourceReport: pack, prefilter: false, runner});
        expect(report.summary).toMatchObject({page_count: 4, exact_offer: 1, related_page: 1, unresolved: 2});
        expect(report.pages[0]).toMatchObject({page_id: "p1-1", label: "exact_offer"});
        expect(report.banks[0].pages[0]).toMatchObject({page_id: "p1-1", label: "exact_offer"});
    });

    it("rejects quotes grounded in another page, in search excerpts or invented", () => {
        const promptMeta = buildPrompt(extractPackFixture());
        const borrowed = flatModelResponse(promptMeta, {
            "p1-2": {
                label: "exact_offer",
                refinancing_eligibility: "yes",
                periodic_fixed_rate: "yes",
                confidence: "high",
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"},
                    {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
                ],
                rationale: "Borrowed from another page."
            }
        });
        expect(() => validateModelResponse(borrowed, promptMeta)).toThrow(/permitted source/);

        const excerptOnly = flatModelResponse(promptMeta, {
            "p1-2": {
                label: "exact_offer",
                refinancing_eligibility: "yes",
                periodic_fixed_rate: "yes",
                confidence: "high",
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"},
                    {claim: "fixed_rate", source_id: "source-1", quote: "okresowo stałe oprocentowanie"}
                ],
                rationale: "Quoted only from search excerpts."
            }
        });
        expect(() => validateModelResponse(excerptOnly, promptMeta)).toThrow(/permitted source/);

        const fabricated = flatModelResponse(promptMeta, {
            "p1-2": {
                label: "exact_offer",
                refinancing_eligibility: "yes",
                periodic_fixed_rate: "yes",
                confidence: "high",
                evidence: [{claim: "refinancing", source_id: "source-1", quote: "całkowicie zmyślony cytat"}],
                rationale: "Invented."
            }
        });
        expect(() => validateModelResponse(fabricated, promptMeta)).toThrow(/permitted source/);
    });

    it("keeps truncated but non-empty full content classifiable without a limit heuristic", () => {
        const pack = extractPackFixture();
        const text = pack.banks[0].pages[0].content.full_content.text;
        pack.banks[0].pages[0].content.full_content.original_chars = 1_000_000;
        pack.banks[0].pages[0].content.full_content.stored_chars = text.length;
        pack.banks[0].pages[0].content.full_content.truncated = true;
        const promptMeta = buildPrompt(pack);
        const response = flatModelResponse(promptMeta, {
            "p1-1": {
                label: "exact_offer",
                refinancing_eligibility: "yes",
                periodic_fixed_rate: "yes",
                confidence: "high",
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"},
                    {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
                ],
                rationale: "Truncated at the extract cap but still full enough to classify."
            }
        });
        const pages = validateModelResponse(structuredClone(response), promptMeta);
        expect(pages[0].label).toBe("exact_offer");
        expect(pages[0].guard_adjustments).toBeUndefined();
    });

    it("requires failed and empty flat Extract pages to remain unresolved", () => {
        const promptMeta = buildPrompt(extractPackFixture());
        const failed = flatModelResponse(promptMeta, {
            "p1-3": {
                label: "exact_offer",
                refinancing_eligibility: "yes",
                periodic_fixed_rate: "yes",
                confidence: "high",
                evidence: [
                    {claim: "refinancing", source_id: "source-1", quote: "spłatę kredytu mieszkaniowego w innym banku"},
                    {claim: "fixed_rate", source_id: "source-1", quote: "Oprocentowanie okresowo stałe obowiązuje przez 60 miesięcy"}
                ],
                rationale: "No content but classified anyway."
            }
        });
        expect(() => validateModelResponse(failed, promptMeta)).toThrow(/must be unresolved/);

        const emptyPack = extractPackFixture();
        emptyPack.banks[0].pages[1].content.full_content.text = "";
        const emptyMeta = buildPrompt(emptyPack);
        const empty = flatModelResponse(emptyMeta, {
            "p1-2": {
                label: "related_page",
                refinancing_eligibility: "unknown",
                periodic_fixed_rate: "unknown",
                confidence: "medium",
                rationale: "Empty content but classified anyway."
            }
        });
        expect(() => validateModelResponse(empty, emptyMeta)).toThrow(/must be unresolved/);
    });

    it("fails closed for malformed flat Extract packs", () => {
        const noPages = extractPackFixture();
        delete noPages.banks[0].pages;
        expect(() => validateExtractPack(noPages)).toThrow(/pages\[\]/);
        const noPreflight = extractPackFixture();
        delete noPreflight.banks[0].preflight;
        expect(() => validateExtractPack(noPreflight)).toThrow(/preflight/);
        const inconsistentPreflight = extractPackFixture();
        inconsistentPreflight.banks[0].preflight.outcome = "not_found";
        inconsistentPreflight.banks[0].preflight.reason = null;
        inconsistentPreflight.banks[0].preflight.remaining_candidate_count = 0;
        expect(() => validateExtractPack(inconsistentPreflight)).toThrow(/preflight/);
        const noUrl = extractPackFixture();
        delete noUrl.banks[0].pages[0].url;
        expect(() => validateExtractPack(noUrl)).toThrow(/url/);
        const noStatus = extractPackFixture();
        delete noStatus.banks[0].pages[0].status;
        expect(() => validateExtractPack(noStatus)).toThrow(/status/);
        const noContent = extractPackFixture();
        delete noContent.banks[0].pages[0].content;
        expect(() => validateExtractPack(noContent)).toThrow(/full_content/);
    });

    it("rejects historical fetch and Extract 1.0 packs before reading their shape", () => {
        for (const schemaVersion of ["parallel-fetch-pilot/1.0.0", "parallel-extract-pilot/1.0.0"]) {
            expect(() => validateExtractPack({schema_version: schemaVersion, bundles: "legacy-only"}))
                .toThrow(EXTRACT_SOURCE_SCHEMA_VERSION);
        }
    });
});

describe("report building", () => {
    it("rolls up banks deterministically and builds summary counts", async () => {
        const promptMeta = buildPrompt(packFixture());
        const runner = vi.fn(async () => ({stdout: jsonlFor(modelResponse(promptMeta)), stderr: ""}));
        const report = await runClassifier({batchPages: 4, sourceReport: packFixture(), prefilter: false, runner});
        expect(report.summary).toMatchObject({page_count: 4, exact_offer: 1, related_page: 1, noise: 1, unresolved: 1});
        expect(report.banks).toEqual([{
            bank: {institution_id: "bank_flat", legal_name: "Bank Flat"},
            label: "exact_offer",
            pages: [
                {page_id: "p1-1", url: "https://flat.pl/kredyt-mieszkaniowy", label: "exact_offer"},
                {page_id: "p1-2", url: "https://flat.pl/pozyczka", label: "related_page"},
                {page_id: "p1-3", url: "https://flat.pl/nieudana", label: "unresolved"},
                {page_id: "p1-4", url: "https://flat.pl/konto", label: "noise"}
            ]
        }]);
    });

    it("bank rollup precedence: exact_offer > related_page > unresolved > noise", () => {
        const pages = [
            {page_id: "p1", bank: {institution_id: "b1", legal_name: "B1"}, url: "u", label: "related_page"},
            {page_id: "p2", bank: {institution_id: "b1", legal_name: "B1"}, url: "u", label: "unresolved"},
            {page_id: "p3", bank: {institution_id: "b2", legal_name: "B2"}, url: "u", label: "unresolved"},
            {page_id: "p4", bank: {institution_id: "b3", legal_name: "B3"}, url: "u", label: "noise"}
        ];
        expect(rollupBanks(pages).map((entry) => [entry.bank.institution_id, entry.label]))
            .toEqual([["b1", "related_page"], ["b2", "unresolved"], ["b3", "noise"]]);
    });

    it("keeps source banks with no selected pages as unresolved", () => {
        const sourceBanks = [
            {bank: {institution_id: "b0", legal_name: "B0"}},
            {bank: {institution_id: "b1", legal_name: "B1"}}
        ];
        const pages = [{page_id: "p1", bank: {institution_id: "b1", legal_name: "B1"}, url: "u", label: "noise"}];
        expect(rollupBanks(pages, sourceBanks)).toEqual([
            {bank: {institution_id: "b0", legal_name: "B0"}, label: "unresolved", pages: []},
            {bank: {institution_id: "b1", legal_name: "B1"}, label: "noise", pages: [{page_id: "p1", url: "u", label: "noise"}]}
        ]);
    });

    it("rolls up a preflight-only bank as not_found without invoking Luna", async () => {
        const pack = extractPackFixture();
        pack.banks = [{
            bank: pack.banks[0].bank,
            preflight: {
                enabled: true,
                skipped_candidate_count: 1,
                skipped: [{
                    url: "https://flat.pl/",
                    title: "Bank Flat",
                    label: "noise",
                    reason: "homepage_not_product_page"
                }],
                remaining_candidate_count: 0,
                outcome: "not_found",
                reason: "homepage_only"
            },
            pages: []
        }];
        const runner = vi.fn();

        const report = await runClassifier({sourceReport: pack, runner});

        expect(runner).not.toHaveBeenCalled();
        expect(report.preflight).toMatchObject({
            enabled: true,
            skipped_candidate_count: 1,
            not_found_bank_count: 1
        });
        expect(report.source_pack).toMatchObject({
            bank_count: 1,
            page_count: 0,
            candidate_count: 1,
            preflight_excluded_count: 1
        });
        expect(report.summary).toMatchObject({
            page_count: 0,
            bank_outcome_counts: {not_found: 1}
        });
        expect(report.banks).toEqual([{
            bank: {institution_id: "bank_flat", legal_name: "Bank Flat"},
            label: "not_found",
            pages: []
        }]);
    });

    it("records per-batch invocation metadata without duplicating the prompt", async () => {
        const promptMeta = buildPrompt(packFixture());
        const runner = vi.fn(async () => ({stdout: jsonlFor(modelResponse(promptMeta)), stderr: ""}));
        const report = await runClassifier({batchPages: 4, sourceReport: packFixture(), prefilter: false, runner});
        expect(report.invocations).toHaveLength(1);
        expect(report.invocations[0]).toMatchObject({
            batch_index: 0,
            page_count: 4,
            prompt_sha256: promptMeta.prompt_sha256,
            prompt_chars: promptMeta.prompt_chars,
            session_id: "sess-abc",
            tokens: {input: 100, output: 50, total: 150},
            cost: 0.0123
        });
        expect(report.invocations[0].elapsed_ms).toBeGreaterThanOrEqual(0);
        expect(report.prompt).toEqual({
            total_chars: promptMeta.prompt_chars,
            aggregate_sha256: crypto.createHash("sha256").update(promptMeta.prompt_sha256, "utf8").digest("hex"),
            page_count: 4,
            batch_count: 1,
            batch_pages: 4,
            batch_concurrency: DEFAULT_BATCH_CONCURRENCY,
            session_reuse: false,
            run_dir: null
        });
        expect(JSON.stringify(report)).not.toContain("PAGE_COUNT: 4");
        expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
        expect(report.source_pack.bank_count).toBe(1);
        expect(report.source_pack.page_count).toBe(4);
        expect(report.source_pack.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(report.pages[0]).toMatchObject({
            page_id: "p1-1",
            bank: {institution_id: "bank_flat", legal_name: "Bank Flat"},
            url: "https://flat.pl/kredyt-mieszkaniowy",
            label: "exact_offer",
            refinancing_eligibility: "yes",
            periodic_fixed_rate: "yes"
        });
    });

    it("dry run never invokes the child and emits a batch inspection manifest", async () => {
        const runner = vi.fn();
        const report = await runClassifier({batchPages: 4, sourceReport: packFixture(), prefilter: false, dryRun: true, runner});
        expect(runner).not.toHaveBeenCalled();
        expect(report.dry_run).toBe(true);
        expect(report.invocations).toEqual([]);
        expect(report.prompt).toMatchObject({page_count: 4, batch_count: 1, batch_pages: 4, batch_concurrency: DEFAULT_BATCH_CONCURRENCY});
        expect(report.summary).toMatchObject({page_count: 0, exact_offer: 0, related_page: 0, noise: 0, unresolved: 0});
        expect(report.pages).toEqual([]);
        expect(report.banks).toEqual([]);
        expect(typeof report.dry_run_manifest.prompt).toBe("string");
        expect(report.dry_run_manifest.prompt).toContain("PAGE_COUNT: 4");
        expect(report.dry_run_manifest.pages).toHaveLength(4);
        expect(report.dry_run_manifest.pages[0].direct_links).toEqual([
            expect.objectContaining({link_id: "link-1", url: "https://flat.pl/oprocentowanie"})
        ]);
        expect(report.dry_run_manifest.pages[0].sources).toEqual([
            expect.objectContaining({source_id: "source-1", relationship: "root", url: "https://flat.pl/kredyt-mieszkaniowy"})
        ]);
        expect(report.dry_run_manifest.pages[2].evidence).toBe("");
        expect(report.dry_run_manifest.batches).toHaveLength(1);
        expect(report.dry_run_manifest.batches[0].page_ids).toEqual(["p1-1", "p1-2", "p1-3", "p1-4"]);
    });
});

describe("batching", () => {
    it("partitions the global ordered entries deterministically", () => {
        const entries = buildPrompt(packFixture()).pages;
        expect(entries.map((entry) => entry.page_id)).toEqual(["p1-1", "p1-2", "p1-3", "p1-4"]);
        const byTwo = partitionEntries(entries, {batchPages: 2});
        expect(byTwo.map((batch) => batch.map((entry) => entry.page_id)))
            .toEqual([["p1-1", "p1-2"], ["p1-3", "p1-4"]]);
        const byThree = partitionEntries(entries, {batchPages: 3});
        expect(byThree.map((batch) => batch.map((entry) => entry.page_id)))
            .toEqual([["p1-1", "p1-2", "p1-3"], ["p1-4"]]);
        const byFive = partitionEntries(entries, {batchPages: 5});
        expect(byFive).toHaveLength(1);
        expect(byFive[0]).toHaveLength(4);
        expect(partitionEntries(entries, {batchPages: 2})).toEqual(byTwo);
        expect(partitionEntries([], {batchPages: 5})).toEqual([]);
    });

    it("passes exact per-batch prompts containing only that batch's page ids", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 2});
        expect(batches.map((batch) => batch.page_ids)).toEqual([["p1-1", "p1-2"], ["p1-3", "p1-4"]]);
        const argvSeen = [];
        const runner = vi.fn(async (argv, _options) => {
            argvSeen.push(argv);
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlFor(modelResponse({pages: batch.pages})), stderr: ""};
        });
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 2, runner});
        expect(runner).toHaveBeenCalledTimes(2);
        expect(report.prompt).toMatchObject({page_count: 4, batch_count: 2, batch_pages: 2, batch_concurrency: DEFAULT_BATCH_CONCURRENCY});
        for (const [index, argv] of argvSeen.entries()) {
            expect(argv.slice(0, 7)).toEqual(["run", "--model", MODEL, "--variant", VARIANT, "--format", "json"]);
            expect(argv[argv.length - 1]).toBe(batches[index].prompt);
            expect(argv[argv.length - 1]).toContain("PAGE_COUNT: 2");
        }
        const firstPrompt = argvSeen[0][argvSeen[0].length - 1];
        const secondPrompt = argvSeen[1][argvSeen[1].length - 1];
        expect(firstPrompt).toContain("p1-1");
        expect(firstPrompt).toContain("p1-2");
        expect(firstPrompt).not.toContain("p1-3");
        expect(secondPrompt).toContain("p1-3");
        expect(secondPrompt).toContain("p1-4");
        expect(secondPrompt).not.toContain("p1-1");
    });

    it("bounds active batch invocations to batchConcurrency", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 1});
        let active = 0;
        let maxActive = 0;
        const runner = vi.fn(async (argv, _options) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlFor(modelResponse({pages: batch.pages})), stderr: ""};
        });
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 1, batchConcurrency: 2, runner});
        expect(runner).toHaveBeenCalledTimes(4);
        expect(report.summary.page_count).toBe(4);
        expect(maxActive).toBeLessThanOrEqual(2);
        expect(maxActive).toBe(2);

        active = 0;
        maxActive = 0;
        const serial = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 1, batchConcurrency: 1, runner});
        expect(serial.summary.page_count).toBe(4);
        expect(maxActive).toBe(1);
    });

    it("merges batch results back into the original global page order", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 2});
        const batchResponse = new Map(batches.map((batch) => [batch.prompt, modelResponse({pages: batch.pages})]));
        const runner = vi.fn(async (argv, _options) => {
            if (argv[argv.length - 1] === batches[0].prompt) {
                await new Promise((resolve) => setTimeout(resolve, 30)); // batch 0 finishes last
            }
            return {stdout: jsonlFor(batchResponse.get(argv[argv.length - 1])), stderr: ""};
        });
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 2, runner});
        expect(report.pages.map((page) => page.page_id)).toEqual(["p1-1", "p1-2", "p1-3", "p1-4"]);
        expect(report.pages[0].label).toBe("exact_offer");
        expect(report.pages[1].label).toBe("related_page");
        expect(report.pages[2].label).toBe("unresolved");
        expect(report.pages[3].label).toBe("noise");
    });

    it("fails the whole run when any batch fails, reporting batch_index without the prompt", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 2});
        const runner = vi.fn(async (argv, _options) => {
            if (argv[argv.length - 1] === batches[1].prompt) {
                throw new PilotError("model_invocation_failed", "opencode run exited with code 1", {exitCode: 20});
            }
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlFor(modelResponse({pages: batch.pages})), stderr: ""};
        });
        let caught;
        try {
            await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 2, runner});
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(PilotError);
        expect(caught.code).toBe("model_invocation_failed");
        expect(caught.exitCode).toBe(20);
        expect(caught.details.batch_index).toBe(1);
        expect(caught.message).not.toContain("PAGE_COUNT");
        expect(JSON.stringify(caught.details)).not.toContain("PAGE_COUNT");
    });

    it("dry run builds all batches with aggregate metadata and zero classifications", async () => {
        const runner = vi.fn();
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 2});
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, dryRun: true, batchPages: 2, runner});
        expect(runner).not.toHaveBeenCalled();
        expect(report.dry_run).toBe(true);
        expect(report.invocations).toEqual([]);
        expect(report.prompt).toEqual({
            total_chars: batches[0].prompt_chars + batches[1].prompt_chars,
            aggregate_sha256: aggregatePromptSha256(batches),
            page_count: 4,
            batch_count: 2,
            batch_pages: 2,
            batch_concurrency: DEFAULT_BATCH_CONCURRENCY,
            session_reuse: false,
            run_dir: null
        });
        expect(report.summary).toMatchObject({page_count: 0, exact_offer: 0, related_page: 0, noise: 0, unresolved: 0});
        expect(report.pages).toEqual([]);
        expect(report.banks).toEqual([]);
        expect(report.dry_run_manifest.batches).toHaveLength(2);
        expect(report.dry_run_manifest.batches[0].page_ids).toEqual(["p1-1", "p1-2"]);
        expect(report.dry_run_manifest.batches[1].page_ids).toEqual(["p1-3", "p1-4"]);
        expect(report.dry_run_manifest.batches[1].prompt).toContain("PAGE_COUNT: 2");
        expect(report.dry_run_manifest.pages).toHaveLength(4);
    });
});

describe("CLI", () => {
    function tmpDir() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classifier-cli-"));
        tmpDirs.add(dir);
        return dir;
    }

    it("requires --input", () => {
        const result = spawnSync(process.execPath, [TOOL, "--dry-run"], {encoding: "utf8"});
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_invocation");
    });

    it("rejects unknown options", () => {
        const result = spawnSync(process.execPath, [TOOL, "--input", "x", "--wat"], {encoding: "utf8"});
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_invocation");
    });

    it("rejects removed --evidence-chars as an unknown option", () => {
        const dir = tmpDir();
        const packPath = path.join(dir, "pack.json");
        fs.writeFileSync(packPath, JSON.stringify(packFixture()));
        const result = spawnSync(process.execPath, [TOOL, "--input", packPath, "--dry-run", "--evidence-chars", "100"], {encoding: "utf8"});
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_invocation");
        expect(JSON.parse(result.stderr).error.message).toContain("unknown option");
    });

    it("rejects a non-positive --timeout-ms", () => {
        const dir = tmpDir();
        const packPath = path.join(dir, "pack.json");
        fs.writeFileSync(packPath, JSON.stringify(packFixture()));
        const result = spawnSync(process.execPath, [TOOL, "--input", packPath, "--dry-run", "--timeout-ms", "0"], {encoding: "utf8"});
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stderr).error.code).toBe("invalid_invocation");
    });

    it("rejects out-of-range --batch-pages and --batch-concurrency", () => {
        const dir = tmpDir();
        const packPath = path.join(dir, "pack.json");
        fs.writeFileSync(packPath, JSON.stringify(packFixture()));
        for (const extra of [["--batch-pages", "0"], ["--batch-pages", "11"], ["--batch-concurrency", "0"], ["--batch-concurrency", "9"]]) {
            const result = spawnSync(process.execPath, [TOOL, "--input", packPath, "--dry-run", ...extra], {encoding: "utf8"});
            expect(result.status).toBe(2);
            expect(JSON.parse(result.stderr).error.code).toBe("invalid_invocation");
        }
    });

    it("writes a dry-run report with a manifest without invoking a child", () => {
        const dir = tmpDir();
        const packPath = path.join(dir, "pack.json");
        fs.writeFileSync(packPath, JSON.stringify(packFixture()));
        const outPath = path.join(dir, "report.json");
        const result = spawnSync(process.execPath, [TOOL, "--input", packPath, "--dry-run", "--no-prefilter", "--batch-pages", "4", "--output", outPath], {encoding: "utf8"});
        expect(result.status).toBe(0);
        const statusLine = JSON.parse(result.stdout);
        expect(statusLine.status).toBe("dry_run");
        expect(statusLine.prompt_page_count).toBe(4);
        expect(statusLine.batch_count).toBe(1);
        const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
        expect(report.schema_version).toBe(REPORT_SCHEMA_VERSION);
        expect(report.dry_run).toBe(true);
        expect(report.prompt).toMatchObject({page_count: 4, batch_count: 1, batch_pages: 4, batch_concurrency: DEFAULT_BATCH_CONCURRENCY});
        expect(report.dry_run_manifest.prompt).toContain("PAGE_COUNT: 4");
        expect(report.dry_run_manifest.pages).toHaveLength(4);
        const mode = fs.statSync(outPath).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it("prefilters error and non-product pages before any model call (CLI default)", () => {
        const dir = tmpDir();
        const packPath = path.join(dir, "pack.json");
        fs.writeFileSync(packPath, JSON.stringify(packFixture()));
        const outPath = path.join(dir, "report-prefilter.json");
        const result = spawnSync(process.execPath, [TOOL, "--input", packPath, "--dry-run", "--output", outPath], {encoding: "utf8"});
        expect(result.status).toBe(0);
        const statusLine = JSON.parse(result.stdout);
        // 4 pages total: 1 error page -> unresolved skip, 1 "Konto osobiste" page -> noise skip, 2 model pages
        expect(statusLine.prompt_page_count).toBe(2);
        const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
        expect(report.prefilter.enabled).toBe(true);
        expect(report.prefilter.skipped_page_count).toBe(2);
        const skippedLabels = report.prefilter.skipped.map((item) => item.label).sort();
        expect(skippedLabels).toEqual(["noise", "unresolved"]);
        expect(report.prefilter.skipped.find((item) => item.label === "unresolved")).toMatchObject({reason: "no_fetchable_content"});
        expect(report.prefilter.skipped.find((item) => item.label === "noise")).toMatchObject({reason: "non_product_boilerplate"});
        expect(report.prompt.page_count).toBe(2);
    });
});

describe("session reuse", () => {
    function jsonlForSession(response, sessionId) {
        return [
            JSON.stringify({type: "step_start", step: {}}),
            JSON.stringify(textEvent(JSON.stringify(response))),
            JSON.stringify({type: "step_finish", step: {sessionID: sessionId, tokens: {input: 100, output: 50, total: 150}, cost: 0.0123}})
        ].join("\n") + "\n";
    }

    it("threads one session per shard: first batch fresh, rest resumed via -s", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 1});
        let callCount = 0;
        const runner = vi.fn(async (argv) => {
            callCount += 1;
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlForSession(modelResponse({pages: batch.pages}), `sess-${callCount}`), stderr: ""};
        });
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 1, batchConcurrency: 2, sessionReuse: true, runner});
        expect(runner).toHaveBeenCalledTimes(4);
        const callsWithoutSession = runner.mock.calls.filter(([argv]) => !argv.includes("-s"));
        const callsWithSession = runner.mock.calls.filter(([argv]) => argv.includes("-s"));
        // one fresh spawn per shard (2 shards), the rest resume
        expect(callsWithoutSession).toHaveLength(2);
        expect(callsWithSession).toHaveLength(2);
        const returnedSessions = new Set(runner.mock.calls.map((_, index) => `sess-${index + 1}`));
        for (const [argv] of callsWithSession) {
            const sessionFlag = argv[argv.indexOf("-s") + 1];
            expect(returnedSessions.has(sessionFlag)).toBe(true);
        }
        expect(report.prompt.session_reuse).toBe(true);
        expect(report.summary.page_count).toBe(4);
    });

    it("falls back to a fresh session when a resumed batch fails", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 2});
        let callCount = 0;
        const runner = vi.fn(async (argv) => {
            callCount += 1;
            if (callCount === 2) {
                throw new PilotError("model_invocation_failed", "opencode run exited with code 1", {exitCode: 20});
            }
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlForSession(modelResponse({pages: batch.pages}), `sess-${callCount}`), stderr: ""};
        });
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 2, batchConcurrency: 1, sessionReuse: true, runner});
        expect(runner).toHaveBeenCalledTimes(3);
        const [secondArgv] = runner.mock.calls[1];
        expect(secondArgv).toContain("-s");
        expect(secondArgv[secondArgv.indexOf("-s") + 1]).toBe("sess-1");
        const [thirdArgv] = runner.mock.calls[2];
        expect(thirdArgv).not.toContain("-s");
        expect(report.summary.page_count).toBe(4);
        expect(report.pages.map((page) => page.page_id)).toEqual(["p1-1", "p1-2", "p1-3", "p1-4"]);
    });

    it("records session_reuse false by default in dry-run reports", async () => {
        const report = await runClassifier({sourceReport: packFixture(), dryRun: true, runner: vi.fn()});
        expect(report.prompt.session_reuse).toBe(false);
        const reused = await runClassifier({sourceReport: packFixture(), dryRun: true, sessionReuse: true, runner: vi.fn()});
        expect(reused.prompt.session_reuse).toBe(true);
    });

    it("passes --dir to opencode argv and records run_dir when runDir is set", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 4});
        const runner = vi.fn(async (argv) => {
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlForSession(modelResponse({pages: batch.pages}), "sess-dir"), stderr: ""};
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rundir-"));
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 4, runDir: dir, runner});
        expect(runner).toHaveBeenCalledTimes(1);
        const [argv] = runner.mock.calls[0];
        expect(argv).toContain("--dir");
        expect(argv[argv.indexOf("--dir") + 1]).toBe(dir);
        expect(argv[argv.length - 1]).toBe(batches[0].prompt);
        expect(report.prompt.run_dir).toBe(dir);
        expect(fs.existsSync(dir)).toBe(true);
    });

    it("omits --dir from argv and records null run_dir by default", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 4});
        const runner = vi.fn(async (argv) => {
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlForSession(modelResponse({pages: batch.pages}), "sess-def"), stderr: ""};
        });
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 4, runner});
        const [argv] = runner.mock.calls[0];
        expect(argv).not.toContain("--dir");
        expect(report.prompt.run_dir).toBeNull();
    });

    it("rotates to a fresh session after SESSION_REUSE_MAX_BATCHES batches", async () => {
        const entries = buildPrompt(packFixture()).pages;
        const batches = buildBatches(entries, {batchPages: 1});
        let callCount = 0;
        const runner = vi.fn(async (argv) => {
            callCount += 1;
            const batch = batches.find((candidate) => candidate.prompt === argv[argv.length - 1]);
            return {stdout: jsonlForSession(modelResponse({pages: batch.pages}), `sess-${callCount}`), stderr: ""};
        });
        // 4 batches in a single shard: fresh, resume, fresh (cap reset), resume
        const report = await runClassifier({sourceReport: packFixture(), prefilter: false, batchPages: 1, batchConcurrency: 1, sessionReuse: true, runner});
        expect(runner).toHaveBeenCalledTimes(4);
        const withSession = runner.mock.calls.filter(([argv]) => argv.includes("-s"));
        const withoutSession = runner.mock.calls.filter(([argv]) => !argv.includes("-s"));
        expect(withoutSession).toHaveLength(2);
        expect(withSession).toHaveLength(2);
        // 3rd call starts a NEW session (no -s), 4th resumes it (sess-3)
        const [thirdArgv] = runner.mock.calls[2];
        expect(thirdArgv).not.toContain("-s");
        const [fourthArgv] = runner.mock.calls[3];
        expect(fourthArgv[fourthArgv.indexOf("-s") + 1]).toBe("sess-3");
        expect(report.summary.page_count).toBe(4);
    });
});
