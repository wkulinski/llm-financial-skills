import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
    CLIENT_MODEL,
    DEFAULT_BATCH_SIZE,
    DEFAULT_EXCERPT_CHARS,
    DEFAULT_FULL_CONTENT_CHARS,
    ENDPOINT,
    MAX_DIRECT_LINKS_PER_PAGE,
    MAX_SELECTED_LINKS,
    REPORT_SCHEMA_VERSION,
    buildExtractQueries,
    buildRequestBody,
    estimateCost,
    runExtractPilot,
    runSelectedLinkExtract,
    validateBudget
} from "../../.agents/skills/bs-remortgaging-scan/lib/parallel-extract-pilot.mjs";
import {
    canonicalIdentity
} from "../../.agents/skills/bs-remortgaging-scan/lib/parallel-search-pilot.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const TOOL = path.join(ROOT, ".agents/skills/bs-remortgaging-scan/tools/parallel-extract-pilot.mjs");

const tmpDirs = new Set();

function sha256Hex(text) {
    return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function candidate(url, title = null, description = null) {
    return {domain_match: true, canonical_url: url, title, description, publish_date: null, excerpts: []};
}

function bankRecord({id, lp, name, hosts, redirectHosts = [], candidates = [], rejections = []}) {
    return {
        bank: {
            institution_id: id,
            lp,
            legal_name: name,
            official_hosts: hosts,
            allowed_redirect_hosts: redirectHosts
        },
        status: "ok",
        http_status: 200,
        latency_ms: 500,
        search_id: "s-1",
        raw_result_count: candidates.length + rejections.length,
        official_result_count: candidates.length,
        duplicate_count: 0,
        rejected_count: rejections.length,
        candidates,
        rejections
    };
}

function sourceFixture() {
    return {
        schema_version: "parallel-search-pilot/1.0.0",
        generated_at: "2026-08-31T00:00:00Z",
        provider: "parallel",
        mode: "basic",
        banks: [
            bankRecord({
                id: "bank_a",
                lp: 1,
                name: "Bank A",
                hosts: ["www.a.pl"],
                redirectHosts: ["a.pl"],
                candidates: [
                    candidate("https://www.a.pl/refinansowanie", "Refinansowanie kredytu hipotecznego w innym banku"),
                    candidate("https://a.pl/kredyt-hipoteczny", "Kredyt hipoteczny stałe oprocentowanie"),
                    candidate("https://www.a.pl/oferta", "Oferta kredytów")
                ]
            }),
            bankRecord({
                id: "bank_b",
                lp: 2,
                name: "Bank B",
                hosts: ["b.pl"],
                candidates: [
                    candidate("https://b.pl/refinansowanie,1", "Refinansowanie hipoteki")
                ]
            })
        ]
    };
}

function manyCandidateBank({id, lp, name, hosts, count}) {
    return bankRecord({
        id,
        lp,
        name,
        hosts,
        candidates: Array.from({length: count}, (_, index) =>
            candidate(`https://${hosts[0].replace(/^www\./u, "")}/refinansowanie-${index}`, "Refinansowanie kredytu hipotecznego w innym banku"))
    });
}

function jsonResponse(payload, {status = 200, headers = {}} = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {"content-type": "application/json", ...headers}
    });
}

/**
 * Product page content with same-host rate/pagination direct links plus
 * noise: duplicate identity, cross-host, mailto, self-link, credentials and
 * a markdown image.
 */
function directLinksContent() {
    return [
        "[Stałe oprocentowanie](https://www.a.pl/oprocentowanie)",
        "<a href=\"https://a.pl/strona-2\">Strona 2</a>",
        "[duplikat](https://www.a.pl/oprocentowanie/)",
        "<a href=\"https://evil.example/tracker\">noise</a>",
        "<a href=\"mailto:kontakt@a.pl\">mail</a>",
        "<a href=\"https://www.a.pl/refinansowanie\">ta sama strona</a>",
        "<a href=\"https://user:pass@a.pl/secret\">creds</a>",
        "[Kalkulator](/kalkulator)",
        "<a href=\"https://a.pl/strona-3\">Strona 3</a>",
        "![obraz](https://www.a.pl/logo.png)"
    ].join(" ");
}

async function sourcePackWithDirectLinks(fullContent, {pageUrl = "https://www.a.pl/refinansowanie", finalUrl = null} = {}) {
    const source = {
        schema_version: "parallel-search-pilot/1.0.0",
        generated_at: "2026-08-31T00:00:00Z",
        provider: "parallel",
        banks: [bankRecord({
            id: "bank_a",
            lp: 1,
            name: "Bank A",
            hosts: ["www.a.pl"],
            redirectHosts: ["a.pl"],
            candidates: [candidate(pageUrl)]
        })]
    };
    const fetchImpl = vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        return jsonResponse({results: body.urls.map((entry) => ({
            url: entry,
            ...(finalUrl !== null && entry === pageUrl ? {final_url: finalUrl} : {}),
            full_content: fullContent,
            excerpts: []
        }))});
    });
    const pack = await runExtractPilot({sourceReport: source, apiKey: "k", fetchImpl});
    return {bank: pack.banks[0].bank, page: pack.banks[0].pages[0]};
}

describe("parallel-extract-pilot flat page-first extract pilot", () => {
    afterEach(() => {
        for (const dir of tmpDirs) {
            fs.rmSync(dir, {recursive: true, force: true});
        }
        tmpDirs.clear();
    });

    it("shares one canonical identity with Search for result mapping", () => {
        expect(canonicalIdentity("https://www.a.pl/x")).toBe(canonicalIdentity("https://a.pl/x"));
        expect(canonicalIdentity("https://a.pl/x")).toBe(canonicalIdentity("https://a.pl/x/"));
        expect(canonicalIdentity("https://a.pl/x,y")).toBe(canonicalIdentity("https://a.pl/x%2Cy"));
        expect(canonicalIdentity("https://a.pl:443/x")).toBe(canonicalIdentity("https://a.pl/x"));
        expect(canonicalIdentity("https://a.pl/x#frag")).toBe(canonicalIdentity("https://a.pl/x"));
        expect(canonicalIdentity("https://a.pl/x?a=1&b=2")).toBe(canonicalIdentity("https://a.pl/x?b=2&a=1"));
        expect(canonicalIdentity("http://a.pl/x")).toBe(canonicalIdentity("https://a.pl/x"));
        expect(canonicalIdentity("https://a.pl/x")).not.toBe(canonicalIdentity("https://a.pl/y"));
        expect(canonicalIdentity("https://a.pl/x")).not.toBe(canonicalIdentity("https://b.pl/x"));
        expect(canonicalIdentity("not a url")).toBeNull();
    });

    it("builds a bounded extract request body with the Luna model and nested advanced settings", () => {
        const body = buildRequestBody({
            urls: ["https://a.pl/1", "https://a.pl/2", "https://a.pl/3"],
            excerptChars: 1000,
            fullContentChars: 4000
        });
        expect(body.objective).toMatch(/refinansowania kredytu hipotecznego/);
        expect(body.objective).toMatch(/gotówkowe/);
        expect(body.objective).toMatch(/konta/);
        expect(body.search_queries).toHaveLength(3);
        expect(body.client_model).toBe(CLIENT_MODEL);
        expect(body.max_chars_total).toBe(3000);
        expect(body.advanced_settings.excerpt_settings.max_chars_per_result).toBe(1000);
        expect(body.advanced_settings.full_content.max_chars_per_result).toBe(4000);
        expect(body.urls).toEqual(["https://a.pl/1", "https://a.pl/2", "https://a.pl/3"]);

        const full = buildRequestBody({urls: Array.from({length: 20}, (_, index) => `https://a.pl/${index}`)});
        expect(full.urls).toHaveLength(20);
        expect(full.max_chars_total).toBe(20 * DEFAULT_EXCERPT_CHARS);

        expect(() => buildRequestBody({urls: []})).toThrow();
        expect(() => buildRequestBody({urls: Array.from({length: 21}, (_, index) => `https://a.pl/${index}`)})).toThrow();
        expect(buildExtractQueries()).toHaveLength(3);
    });

    it("submits every accepted candidate in Search order without top-k or scoring and emits one flat page per identity", async () => {
        const source = {
            ...sourceFixture(),
            banks: [bankRecord({
                id: "bank_all",
                lp: 1,
                name: "Bank All",
                hosts: ["all.pl"],
                candidates: [
                    candidate("https://all.pl/refinansowanie"),
                    candidate("https://all.pl/kredyt-hipoteczny"),
                    candidate("https://all.pl/stale-oprocentowanie"),
                    candidate("https://all.pl/przeniesienie"),
                    candidate("https://all.pl/oferta"),
                    candidate("https://all.pl/regulamin")
                ]
            })]
        };
        const expectedUrls = [
            "https://all.pl/refinansowanie",
            "https://all.pl/kredyt-hipoteczny",
            "https://all.pl/stale-oprocentowanie",
            "https://all.pl/przeniesienie",
            "https://all.pl/oferta"
        ];
        const fetchImpl = vi.fn(async (url, init) => {
            expect(url).toBe(ENDPOINT);
            const body = JSON.parse(init.body);
            expect(body.urls).toEqual(expectedUrls);
            return jsonResponse({results: body.urls.map((entry, index) => ({
                url: index === 0 ? "https://www.all.pl/refinansowanie" : entry,
                full_content: `content:${entry}`,
                excerpts: []
            }))});
        });

        const pack = await runExtractPilot({sourceReport: source, apiKey: "test-key", fetchImpl});

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const bank = pack.banks[0];
        expect(bank.submitted_urls).toEqual(expectedUrls);
        expect(bank.pages).toHaveLength(5);
        expect(bank.pages.map((page) => page.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
        expect(bank.preflight).toMatchObject({
            enabled: true,
            skipped_candidate_count: 1,
            remaining_candidate_count: 5,
            outcome: "continue",
            reason: null
        });
        expect(bank.preflight.skipped).toEqual([expect.objectContaining({
            url: "https://all.pl/regulamin",
            label: "noise",
            reason: "non_product_boilerplate"
        })]);
        expect(bank.pages[0].url).toBe("https://www.all.pl/refinansowanie");
        expect(bank.pages[0].submitted_url).toBe("https://all.pl/refinansowanie");
        expect(pack.summary).toMatchObject({
            bank_count: 1,
            submitted: 5,
            preflight_excluded: 1,
            not_found_bank_count: 0,
            extracted: 5,
            error: 0,
            api_request_count: 1,
            estimated_cost_usd: 0.005
        });
        expect(typeof pack.summary.elapsed_ms).toBe("number");
    });

    it("runs metadata preflight before Extract and reports homepage-only banks as not_found", async () => {
        const source = {
            ...sourceFixture(),
            banks: [
                bankRecord({
                    id: "bank_homepage_only",
                    lp: 1,
                    name: "Bank Homepage Only",
                    hosts: ["home.pl"],
                    candidates: [candidate("https://home.pl/", "Bank Homepage Only")]
                }),
                bankRecord({
                    id: "bank_mixed",
                    lp: 2,
                    name: "Bank Mixed",
                    hosts: ["mixed.pl"],
                    candidates: [
                        candidate("https://mixed.pl/", "Bank Mixed"),
                        candidate("https://mixed.pl/kredyt-mieszkaniowy", "Kredyt mieszkaniowy")
                    ]
                })
            ]
        };
        const fetchImpl = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            expect(body.urls).toEqual(["https://mixed.pl/kredyt-mieszkaniowy"]);
            return jsonResponse({results: body.urls.map((url) => ({url, full_content: "product", excerpts: []}))});
        });

        const pack = await runExtractPilot({sourceReport: source, apiKey: "key", fetchImpl});

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(pack.preflight).toMatchObject({
            enabled: true,
            skipped_candidate_count: 2,
            not_found_bank_count: 1
        });
        expect(pack.summary).toMatchObject({
            submitted: 1,
            preflight_excluded: 2,
            not_found_bank_count: 1,
            extracted: 1,
            error: 0,
            api_request_count: 1,
            estimated_cost_usd: 0.001
        });

        expect(pack.banks[0]).toMatchObject({
            submitted_urls: [],
            pages: [],
            preflight: {
                skipped_candidate_count: 1,
                remaining_candidate_count: 0,
                outcome: "not_found",
                reason: "homepage_only"
            }
        });
        expect(pack.banks[0].preflight.skipped[0]).toMatchObject({
            url: "https://home.pl/",
            label: "noise",
            reason: "homepage_not_product_page"
        });
        expect(pack.banks[1].preflight).toMatchObject({
            skipped_candidate_count: 1,
            remaining_candidate_count: 1,
            outcome: "continue",
            reason: null
        });
        expect(pack.banks[1].preflight.skipped[0]).toMatchObject({
            url: "https://mixed.pl/",
            label: "noise",
            reason: "homepage_not_product_page"
        });
    });

    it("does not require an API key or call Extract when preflight removes every candidate", async () => {
        const source = {
            ...sourceFixture(),
            banks: [bankRecord({
                id: "bank_homepage_only",
                lp: 1,
                name: "Bank Homepage Only",
                hosts: ["home.pl"],
                candidates: [candidate("https://home.pl/")]
            })]
        };
        const fetchImpl = vi.fn();

        const pack = await runExtractPilot({sourceReport: source, fetchImpl});

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(pack.summary).toMatchObject({
            submitted: 0,
            preflight_excluded: 1,
            not_found_bank_count: 1,
            extracted: 0,
            error: 0,
            api_request_count: 0,
            estimated_cost_usd: 0
        });
        expect(pack.banks[0].preflight).toMatchObject({outcome: "not_found", reason: "homepage_only"});
    });

    it("does not start Extract for a Search bank that is not available", async () => {
        const source = {
            ...sourceFixture(),
            banks: [bankRecord({
                id: "bank_search_error",
                lp: 1,
                name: "Bank Search Error",
                hosts: ["error.pl"],
                candidates: [candidate("https://error.pl/kredyt-hipoteczny")]
            })]
        };
        source.banks[0].status = "error";
        source.banks[0].candidates = [candidate("https://error.pl/kredyt-hipoteczny")];
        const fetchImpl = vi.fn();

        const pack = await runExtractPilot({sourceReport: source, apiKey: "key", fetchImpl});

        expect(fetchImpl).not.toHaveBeenCalled();
        expect(pack.banks[0]).toMatchObject({
            submitted_urls: [],
            pages: [],
            preflight: {outcome: "not_run", reason: "search_not_available"}
        });
    });

    it("applies safe metadata noise rules before Extract while protecting mortgage paths", async () => {
        const source = {
            ...sourceFixture(),
            banks: [bankRecord({
                id: "bank_metadata",
                lp: 1,
                name: "Bank Metadata",
                hosts: ["metadata.pl"],
                candidates: [
                    candidate("https://metadata.pl/kredyt-w-rachunku-biezacym", "Kredyt w rachunku bieżącym"),
                    candidate("https://metadata.pl/formularze/kwestionariusz.pdf", "Kwestionariusz kredytowy"),
                    candidate("https://metadata.pl/uslugi/operacja", null, "Usługa BLIK"),
                    candidate("https://metadata.pl/rolnicy/kredyt-1", "Kredyt 1"),
                    candidate("https://metadata.pl/kredyt-hipoteczny", "Kredyt hipoteczny")
                ]
            })]
        };
        const fetchImpl = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            expect(body.urls).toEqual([
                "https://metadata.pl/kredyt-hipoteczny"
            ]);
            return jsonResponse({results: body.urls.map((url) => ({url, full_content: "content", excerpts: []}))});
        });

        const pack = await runExtractPilot({sourceReport: source, apiKey: "key", fetchImpl});

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(pack.banks[0].preflight.skipped_candidate_count).toBe(4);
        expect(pack.banks[0].preflight.skipped.map((item) => item.reason)).toEqual([
            "non_mortgage_credit_product",
            "non_mortgage_credit_product",
            "non_product_boilerplate",
            "non_mortgage_credit_product"
        ]);
        expect(pack.banks[0].preflight.remaining_candidate_count).toBe(1);
        expect(pack.summary.preflight_excluded).toBe(4);
        expect(pack.summary.submitted).toBe(1);
    });

    it("maps http/https, www/bare and comma/%2C result variants to the correct page in submitted order and bounds content", async () => {
        const longFullContent = "F".repeat(25_000);
        const fetchImpl = vi.fn(async (url, init) => {
            expect(url).toBe(ENDPOINT);
            const body = JSON.parse(init.body);
            if (body.urls.includes("https://b.pl/refinansowanie,1")) {
                return jsonResponse({results: [
                    {url: "https://b.pl/refinansowanie%2C1", full_content: "Bank B treść", excerpts: []}
                ]});
            }
            return jsonResponse({results: [
                {url: "https://www.a.pl/oferta/", full_content: "Oferta treść", excerpts: ["x".repeat(6000)]},
                {url: "https://a.pl/refinansowanie", full_content: longFullContent, excerpts: ["spłata kredytu w innym banku"]},
                {url: "https://www.a.pl/kredyt-hipoteczny", full_content: "Kredyt hipoteczny treść", excerpts: ["stałe oprocentowanie"]}
            ]});
        });

        const pack = await runExtractPilot({
            sourceReport: sourceFixture(),
            inputPath: "var/agent/cache/bs-remortgaging-scan/parallel-search-pilot/live-20-basic-domain-filtered.json",
            apiKey: "test-key-123",
            fetchImpl
        });

        expect(pack.schema_version).toBe(REPORT_SCHEMA_VERSION);
        expect(pack.dry_run).toBe(false);
        expect(pack.source_report).toEqual({
            path: "var/agent/cache/bs-remortgaging-scan/parallel-search-pilot/live-20-basic-domain-filtered.json",
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            schema_version: "parallel-search-pilot/1.0.0"
        });
        expect(pack.summary).toMatchObject({
            bank_count: 2,
            submitted: 4,
            extracted: 4,
            error: 0,
            api_request_count: 2,
            estimated_cost_usd: 0.004
        });
        expect(typeof pack.summary.elapsed_ms).toBe("number");

        const bankA = pack.banks[0];
        expect(bankA.bank.institution_id).toBe("bank_a");
        expect(bankA.submitted_urls).toHaveLength(3);
        expect(bankA.result_errors).toEqual([]);
        expect(bankA.pages).toHaveLength(3);

        const page0 = bankA.pages[0];
        expect(page0.status).toBe("ok");
        expect(page0.submitted_url).toBe("https://www.a.pl/refinansowanie");
        expect(page0.url).toBe("https://a.pl/refinansowanie");
        expect(page0.content.full_content.original_chars).toBe(25_000);
        expect(page0.content.full_content.truncated).toBe(true);
        expect(page0.content.full_content.text).toHaveLength(DEFAULT_FULL_CONTENT_CHARS);
        expect(page0.content.full_content.stored_chars).toBe(DEFAULT_FULL_CONTENT_CHARS);
        expect(page0.content.full_content.sha256).toBe(sha256Hex(longFullContent));

        const page1 = bankA.pages[1];
        expect(page1.submitted_url).toBe("https://a.pl/kredyt-hipoteczny");
        expect(page1.url).toBe("https://www.a.pl/kredyt-hipoteczny");
        expect(page1.content.full_content.truncated).toBe(false);

        const page2 = bankA.pages[2];
        expect(page2.submitted_url).toBe("https://www.a.pl/oferta");
        expect(page2.url).toBe("https://www.a.pl/oferta/");
        expect(page2.content.excerpts.original_chars).toBe(6000);
        expect(page2.content.excerpts.truncated).toBe(true);
        expect(page2.content.excerpts.items[0]).toHaveLength(DEFAULT_EXCERPT_CHARS);
        expect(page2.content.excerpts.sha256).toBe(sha256Hex(JSON.stringify(["x".repeat(6000)])));

        const bankB = pack.banks[1];
        expect(bankB.pages).toHaveLength(1);
        expect(bankB.pages[0].url).toBe("https://b.pl/refinansowanie%2C1");
        expect(bankB.pages[0].content.full_content.text).toBe("Bank B treść");
        expect(bankB.pages[0].content.full_content.truncated).toBe(false);

        const serialized = JSON.stringify(pack);
        expect(serialized).not.toContain("test-key-123");
        expect(serialized).not.toContain("x-api-key");
        expect(serialized).not.toContain("authorization");
    });

    it("rejects invalid, credential, cross-host, duplicate and legacy-shaped candidates before Extract", async () => {
        const source = {
            ...sourceFixture(),
            banks: [bankRecord({
                id: "bank_guard",
                lp: 1,
                name: "Bank Guard",
                hosts: ["guard.pl"],
                candidates: [
                    candidate("https://guard.pl/first"),
                    candidate("https://www.guard.pl/first/"),
                    {domain_match: true, canonical_url: "https://evil.example/not-official"},
                    {domain_match: true, canonical_url: "https://user:pass@guard.pl/secret"},
                    {domain_match: true, canonical_url: "not a url"},
                    {domain_match: true, candidate_url: "https://guard.pl/legacy"}
                ]
            })]
        };
        const fetchImpl = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            expect(body.urls).toEqual(["https://guard.pl/first"]);
            return jsonResponse({results: [{url: "https://www.guard.pl/first", full_content: "guard", excerpts: []}]});
        });

        const pack = await runExtractPilot({sourceReport: source, apiKey: "k", fetchImpl});
        const bank = pack.banks[0];
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(bank.submitted_urls).toEqual(["https://guard.pl/first"]);
        expect(bank.pages).toHaveLength(1);
        expect(bank.pages[0].submitted_url).toBe("https://guard.pl/first");
        expect(bank.result_errors.map((error) => error.code)).toEqual(expect.arrayContaining([
            "duplicate_candidate_identity",
            "cross_host_candidate",
            "invalid_candidate_url"
        ]));
        expect(bank.result_errors.some((error) => error.message.includes("credentials"))).toBe(true);
        expect(pack.summary.submitted).toBe(1);
    });

    it("records explicit errors for cross-host, duplicate and unknown results and unresolved pages", async () => {
        const fetchImpl = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            if (body.urls.includes("https://b.pl/refinansowanie,1")) {
                return jsonResponse({results: [
                    {url: "https://b.pl/refinansowanie,1", full_content: "B", excerpts: []}
                ]});
            }
            return jsonResponse({results: [
                {url: "https://www.a.pl/refinansowanie", full_content: "A", excerpts: []},
                {url: "https://a.pl/refinansowanie", full_content: "A dup", excerpts: []},
                {url: "https://evil.example/x", full_content: "evil", excerpts: []},
                {url: "https://www.a.pl/nieznane", full_content: "?", excerpts: []},
                {url: "https://a.pl/kredyt-hipoteczny", full_content: "B", excerpts: []}
            ]});
        });

        const pack = await runExtractPilot({
            sourceReport: sourceFixture(),
            apiKey: "k",
            fetchImpl
        });

        const bankA = pack.banks[0];
        expect(bankA.pages).toHaveLength(3);
        expect(bankA.pages.filter((page) => page.status === "ok")).toHaveLength(2);
        const codes = bankA.result_errors.map((error) => error.code);
        expect(codes).toEqual(expect.arrayContaining(["duplicate_result", "cross_host_result", "unknown_result"]));
        expect(bankA.result_errors.some((error) => error.result_url === "https://evil.example/x")).toBe(true);

        const oferta = bankA.pages.find((page) => page.submitted_url === "https://www.a.pl/oferta");
        expect(oferta.status).toBe("unresolved");
        expect(oferta.error.code).toBe("unresolved_root");
        expect(oferta.url).toBe("https://www.a.pl/oferta");

        expect(pack.summary.extracted).toBe(3);
        expect(pack.summary.error).toBe(1);
    });

    it("splits pages into sequential bounded batches with correct headers and body limits", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const calls = [];
        const fetchImpl = vi.fn(async (url, init) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            calls.push({url, init});
            const body = JSON.parse(init.body);
            const results = body.urls.map((entry) => ({url: entry, full_content: `content:${entry}`, excerpts: []}));
            const response = jsonResponse({results});
            inFlight -= 1;
            return response;
        });

        const pack = await runExtractPilot({
            sourceReport: sourceFixture(),
            batchSize: 2,
            excerptChars: 999,
            fullContentChars: 1234,
            apiKey: "sekret-abc",
            fetchImpl
        });

        expect(maxInFlight).toBe(1);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(pack.summary.api_request_count).toBe(3);
        expect(pack.summary.extracted).toBe(4);
        expect(pack.summary.submitted).toBe(4);

        for (const {url, init} of calls) {
            expect(url).toBe(ENDPOINT);
            expect(init.method).toBe("POST");
            expect(init.headers["content-type"]).toBe("application/json");
            expect(init.headers["x-api-key"]).toBe("sekret-abc");
            const body = JSON.parse(init.body);
            expect(body.client_model).toBe("gpt-5.6-luna");
            expect(body.search_queries).toHaveLength(3);
            expect(body.advanced_settings.excerpt_settings.max_chars_per_result).toBe(999);
            expect(body.advanced_settings.full_content.max_chars_per_result).toBe(1234);
            expect(body.urls.length).toBeLessThanOrEqual(2);
            expect(body.max_chars_total).toBe(body.urls.length * 999);
        }
        expect(JSON.parse(calls[0].init.body).urls).toEqual([
            "https://www.a.pl/refinansowanie",
            "https://a.pl/kredyt-hipoteczny"
        ]);

        const serialized = JSON.stringify(pack);
        expect(serialized).not.toContain("sekret-abc");
        expect(serialized).not.toContain("x-api-key");
    });

    it("emits a flat pack without child/parent/bundle structures or child/expansion counters", async () => {
        const fetchImpl = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            return jsonResponse({results: body.urls.map((entry) => ({url: entry, full_content: "x", excerpts: []}))});
        });

        const pack = await runExtractPilot({sourceReport: sourceFixture(), apiKey: "k", fetchImpl});

        for (const bank of pack.banks) {
            expect(bank.pages).toBeDefined();
            expect(bank.bundles).toBeUndefined();
            expect(bank.selected).toBeUndefined();
            expect(bank.child_submitted_urls).toBeUndefined();
            expect(bank.child_result_errors).toBeUndefined();
            for (const page of bank.pages) {
                expect(page.relationship).toBeUndefined();
                expect(page.parent_url).toBeUndefined();
            }
        }
        expect(pack.summary).not.toHaveProperty("root_count");
        expect(pack.summary).not.toHaveProperty("root_api_request_count");
        expect(pack.summary).not.toHaveProperty("expansion_api_request_count");
        expect(pack.summary).not.toHaveProperty("child_selected");
        expect(pack.summary).not.toHaveProperty("child_extracted");
        expect(pack.summary).not.toHaveProperty("child_error");
        const serialized = JSON.stringify(pack);
        expect(serialized).not.toContain("selected_child_links");
        expect(serialized).not.toContain("relationship");
        expect(serialized).not.toContain("bundle");
        expect(serialized).not.toContain("expansion");
    });

    it("guards estimated cost before any request, including dry-run", async () => {
        const fetchMock = vi.fn();
        await expect(runExtractPilot({
            sourceReport: sourceFixture(),
            maxCostUsd: 0.002,
            apiKey: "k",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "budget_guard_exceeded", exitCode: 11});
        expect(fetchMock).not.toHaveBeenCalled();

        await expect(runExtractPilot({
            sourceReport: sourceFixture(),
            maxCostUsd: 0.002,
            dryRun: true,
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "budget_guard_exceeded", exitCode: 11});
        expect(fetchMock).not.toHaveBeenCalled();

        expect(estimateCost(4)).toBe(0.004);
        expect(estimateCost(1000)).toBe(1);
        expect(validateBudget(3, 0.005)).toBe(0.003);
    });

    it("maps controlled API error codes for auth, rate limit, server, timeout and network errors", async () => {
        let callIndex = 0;
        const fetchImpl = vi.fn(async () => {
            const current = callIndex;
            callIndex += 1;
            if (current === 0) {
                return new Response("nope", {status: 401, headers: {"content-type": "application/json"}});
            }
            if (current === 1) {
                return new Response("nope", {status: 429, headers: {"content-type": "application/json"}});
            }
            if (current === 2) {
                return new Response("nope", {status: 500, headers: {"content-type": "application/json"}});
            }
            if (current === 3) {
                const error = new Error("aborted");
                error.name = "AbortError";
                throw error;
            }
            const error = new Error("ECONNREFUSED");
            throw error;
        });

        const source = {
            schema_version: "parallel-search-pilot/1.0.0",
            generated_at: "2026-08-31T00:00:00Z",
            provider: "parallel",
            banks: [
                manyCandidateBank({id: "bank_a", lp: 1, name: "Bank A", hosts: ["www.a.pl"], count: 5}),
                manyCandidateBank({id: "bank_b", lp: 2, name: "Bank B", hosts: ["b.pl"], count: 1}),
                manyCandidateBank({id: "bank_c", lp: 3, name: "Bank C", hosts: ["c.pl"], count: 1})
            ]
        };

        const pack = await runExtractPilot({
            sourceReport: source,
            batchSize: 2,
            concurrency: 1,
            apiKey: "k",
            fetchImpl
        });

        expect(fetchImpl).toHaveBeenCalledTimes(5);
        expect(pack.summary.api_request_count).toBe(5);
        expect(pack.summary.extracted).toBe(0);
        expect(pack.summary.error).toBe(7);

        const bankA = pack.banks[0];
        expect(bankA.pages.map((page) => page.error.code)).toEqual([
            "auth_error",
            "auth_error",
            "rate_limited",
            "rate_limited",
            "server_error"
        ]);
        expect(pack.banks[1].pages[0].error.code).toBe("request_timeout");
        expect(pack.banks[2].pages[0].error.code).toBe("network_error");
        expect(bankA.pages.every((page) => page.status === "error")).toBe(true);
    });

    it("enforces response byte guards and rejects malformed JSON or schema", async () => {
        let callIndex = 0;
        const fetchImpl = vi.fn(async () => {
            const current = callIndex;
            callIndex += 1;
            if (current === 0) {
                return new Response("tiny", {
                    status: 200,
                    headers: {"content-type": "application/json", "content-length": "999999999"}
                });
            }
            if (current === 1) {
                return new Response(JSON.stringify({results: []}).padEnd(5000, " "), {
                    status: 200,
                    headers: {"content-type": "application/json"}
                });
            }
            if (current === 2) {
                return new Response("not json at all", {status: 200, headers: {"content-type": "application/json"}});
            }
            return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
        });

        const source = {
            schema_version: "parallel-search-pilot/1.0.0",
            generated_at: "2026-08-31T00:00:00Z",
            provider: "parallel",
            banks: [
                manyCandidateBank({id: "bank_a", lp: 1, name: "Bank A", hosts: ["www.a.pl"], count: 4})
            ]
        };

        const pack = await runExtractPilot({
            sourceReport: source,
            batchSize: 1,
            maxResponseBytes: 1024,
            apiKey: "k",
            fetchImpl
        });

        expect(pack.banks[0].pages.map((page) => page.error.code)).toEqual([
            "response_too_large",
            "response_too_large",
            "invalid_json_response",
            "invalid_response_schema"
        ]);
        expect(pack.summary.error).toBe(4);
        expect(pack.summary.extracted).toBe(0);
    });

    it("runs dry-run without a key and without touching the network", async () => {
        const fetchMock = vi.fn();
        const pack = await runExtractPilot({
            sourceReport: sourceFixture(),
            dryRun: true,
            fetchImpl: fetchMock
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(pack.dry_run).toBe(true);
        expect(pack.summary).toMatchObject({
            bank_count: 2,
            submitted: 4,
            extracted: 0,
            error: 0,
            api_request_count: 0,
            estimated_cost_usd: 0.004
        });
        expect(typeof pack.summary.elapsed_ms).toBe("number");
        expect(pack.banks[0].pages).toHaveLength(3);
        expect(pack.banks[0].pages.every((page) => page.status === "dry_run")).toBe(true);
        expect(pack.banks[0].pages.every((page) => page.url.startsWith("https://"))).toBe(true);
        expect(pack.banks[1].pages[0].status).toBe("dry_run");
        expect(pack.config).toMatchObject({
            endpoint: ENDPOINT,
            client_model: CLIENT_MODEL,
            max_urls_per_request: 20,
            batch_size: DEFAULT_BATCH_SIZE,
            timeout_ms: 120_000,
            max_response_bytes: 8 * 1024 * 1024,
            excerpt_chars: DEFAULT_EXCERPT_CHARS,
            full_content_chars: DEFAULT_FULL_CONTENT_CHARS,
            max_cost_usd: 1,
            cost_per_url_usd: 0.001
        });
    });

    it("requires the API key for a live run and validates configuration and source", async () => {
        const fetchMock = vi.fn();
        await expect(runExtractPilot({sourceReport: sourceFixture(), fetchImpl: fetchMock}))
            .rejects.toMatchObject({code: "missing_api_key", exitCode: 20});
        expect(fetchMock).not.toHaveBeenCalled();

        await expect(runExtractPilot({sourceReport: {...sourceFixture(), schema_version: "parallel-search-pilot/9.0.0"}, dryRun: true}))
            .rejects.toMatchObject({code: "invalid_source_report", exitCode: 10});

        await expect(runExtractPilot({sourceReport: sourceFixture(), batchSize: 21, dryRun: true}))
            .rejects.toMatchObject({code: "invalid_configuration", exitCode: 2});

        await expect(runExtractPilot({dryRun: true})).rejects.toMatchObject({code: "invalid_source_report", exitCode: 10});
    });

    it("exposes the CLI for dry-run packs and guards budget, config, report and key errors", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-extract-"));
        tmpDirs.add(tmpDir);
        const inputPath = path.join(tmpDir, "report.json");
        fs.writeFileSync(inputPath, JSON.stringify(sourceFixture()));

        const dryRun = spawnSync(process.execPath, [
            TOOL,
            "--input", inputPath,
            "--output", path.join(tmpDir, "pack.json"),
            "--dry-run"
        ], {encoding: "utf8"});
        expect(dryRun.status).toBe(0);
        expect(JSON.parse(dryRun.stdout).status).toBe("dry_run");
        expect(JSON.parse(dryRun.stdout).submitted).toBe(4);
        expect(JSON.parse(dryRun.stdout).preflight_excluded).toBe(0);
        expect(JSON.parse(dryRun.stdout).not_found_bank_count).toBe(0);
        expect(JSON.parse(dryRun.stdout).estimated_cost_usd).toBe(0.004);
        const pack = JSON.parse(fs.readFileSync(path.join(tmpDir, "pack.json"), "utf8"));
        expect(pack.schema_version).toBe(REPORT_SCHEMA_VERSION);
        expect(pack.dry_run).toBe(true);
        expect(pack.source_report.path).toBe(inputPath);
        expect(pack.summary.submitted).toBe(4);
        expect(fs.statSync(path.join(tmpDir, "pack.json")).mode & 0o777).toBe(0o600);

        const guarded = spawnSync(process.execPath, [
            TOOL,
            "--input", inputPath,
            "--output", path.join(tmpDir, "guarded.json"),
            "--max-cost-usd", "0.001",
            "--dry-run"
        ], {encoding: "utf8"});
        expect(guarded.status).toBe(11);
        expect(guarded.stderr).toContain("budget_guard_exceeded");
        expect(fs.existsSync(path.join(tmpDir, "guarded.json"))).toBe(false);

        const badBatch = spawnSync(process.execPath, [
            TOOL, "--input", inputPath, "--batch-size", "21", "--dry-run"
        ], {encoding: "utf8"});
        expect(badBatch.status).toBe(2);
        expect(badBatch.stderr).toContain("batch_size");

        const unknownOption = spawnSync(process.execPath, [
            TOOL, "--input", inputPath, "--removed-option", "3", "--dry-run"
        ], {encoding: "utf8"});
        expect(unknownOption.status).toBe(2);
        expect(unknownOption.stderr).toContain("unknown option");

        const missingInput = spawnSync(process.execPath, [TOOL, "--dry-run"], {encoding: "utf8"});
        expect(missingInput.status).toBe(2);
        expect(missingInput.stderr).toContain("--input is required");

        const badReport = spawnSync(process.execPath, [
            TOOL, "--input", path.join(tmpDir, "nope.json"), "--dry-run"
        ], {encoding: "utf8"});
        expect(badReport.status).toBe(10);
        expect(badReport.stderr).toContain("invalid_source_report");

        const env = {...process.env};
        delete env.PARALLEL_API_KEY;
        const noKey = spawnSync(process.execPath, [
            TOOL, "--input", inputPath, "--output", path.join(tmpDir, "live.json")
        ], {encoding: "utf8", env});
        expect(noKey.status).toBe(20);
        expect(noKey.stderr).toContain("missing_api_key");
        expect(fs.existsSync(path.join(tmpDir, "live.json"))).toBe(false);
    });
});

describe("parallel-extract-pilot direct official links", () => {
    it("exposes only safe deduplicated same-host direct links with stable link ids and metadata", async () => {
        const pageUrl = "https://www.a.pl/refinansowanie";
        const {bank, page} = await sourcePackWithDirectLinks(directLinksContent(), {finalUrl: "https://www.a.pl/refinansowanie/"});

        expect(bank.institution_id).toBe("bank_a");
        expect(page.status).toBe("ok");
        expect(page.final_url).toBe("https://www.a.pl/refinansowanie/");
        expect(page.direct_links.map((link) => link.link_id)).toEqual(["link-1", "link-2", "link-3", "link-4"]);
        expect(page.direct_links.map((link) => link.url)).toEqual([
            "https://www.a.pl/oprocentowanie",
            "https://a.pl/strona-2",
            "https://www.a.pl/kalkulator",
            "https://a.pl/strona-3"
        ]);
        expect(page.direct_links[0].anchor_text).toBe("Stałe oprocentowanie");
        expect(page.direct_links[2].anchor_text).toBe("Kalkulator");
        for (const link of page.direct_links) {
            expect(link.url).toMatch(/^https?:\/\//u);
            expect(new URL(link.url).hostname).toMatch(/(^|\.)a\.pl$/u);
            expect(typeof link.anchor_text).toBe("string");
            expect(typeof link.context).toBe("string");
            expect(link.context).not.toMatch(/\s{2,}/u);
            expect(link.context.length).toBeLessThanOrEqual(240);
        }
        expect(page.direct_links[0].context).toContain("oprocentowanie");
        // noise and self links never leak into the bounded list
        const urls = page.direct_links.map((link) => link.url);
        expect(urls).not.toContain("https://evil.example/tracker");
        expect(urls).not.toContain("https://www.a.pl/refinansowanie");
        expect(urls).not.toContain("https://user:pass@a.pl/secret");
        expect(urls).not.toContain("https://www.a.pl/logo.png");
        expect(urls.filter((url) => url.includes("oprocentowanie"))).toHaveLength(1);
    });

    it("caps the direct link list at MAX_DIRECT_LINKS_PER_PAGE in source order", async () => {
        const fullContent = Array.from({length: 150}, (_, index) =>
            `[link ${index}](https://www.a.pl/podstrona-${index})`).join(" ");
        const {page} = await sourcePackWithDirectLinks(fullContent);

        expect(MAX_DIRECT_LINKS_PER_PAGE).toBe(100);
        expect(page.direct_links).toHaveLength(MAX_DIRECT_LINKS_PER_PAGE);
        expect(page.direct_links[0].link_id).toBe("link-1");
        expect(page.direct_links[0].url).toBe("https://www.a.pl/podstrona-0");
        expect(page.direct_links[MAX_DIRECT_LINKS_PER_PAGE - 1].link_id).toBe("link-100");
    });

    it("uses the actual href attribute instead of a later attribute containing href-like text", async () => {
        const html = '<a href="https://www.a.pl/wlasciwy" data-note="href=\'https://www.a.pl/bledny\'">Właściwy dokument</a>';
        const {page} = await sourcePackWithDirectLinks(html);

        expect(page.direct_links).toEqual([expect.objectContaining({
            link_id: "link-1",
            url: "https://www.a.pl/wlasciwy",
            anchor_text: "Właściwy dokument"
        })]);
    });

    it("rejects a result whose final_url redirects to a disallowed host", async () => {
        const pageUrl = "https://www.a.pl/refinansowanie";
        const source = {
            schema_version: "parallel-search-pilot/1.0.0",
            generated_at: "2026-08-31T00:00:00Z",
            provider: "parallel",
            banks: [bankRecord({
                id: "bank_a",
                lp: 1,
                name: "Bank A",
                hosts: ["www.a.pl"],
                redirectHosts: ["a.pl"],
                candidates: [candidate(pageUrl)]
            })]
        };
        const fetchImpl = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            return jsonResponse({results: [
                {url: pageUrl, final_url: "https://evil.example/redirect", full_content: "x", excerpts: []}
            ]});
        });
        const pack = await runExtractPilot({sourceReport: source, apiKey: "k", fetchImpl});

        const bankRecordOut = pack.banks[0];
        expect(bankRecordOut.pages[0].status).toBe("unresolved");
        expect(bankRecordOut.result_errors.map((error) => error.code)).toContain("cross_host_final_url");
        expect(bankRecordOut.result_errors[0].result_url).toBe(pageUrl);
        expect(pack.summary.extracted).toBe(0);
        expect(pack.summary.error).toBe(1);
    });
});

describe("parallel-extract-pilot selected-link extractor", () => {
    it("submits only the selected link URLs and returns link-id-bound source-bound page records", async () => {
        const {bank, page} = await sourcePackWithDirectLinks(directLinksContent());
        const selected = [page.direct_links[1], page.direct_links[3], page.direct_links[0]];

        const selectedFetch = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            expect(body.urls).toEqual([selected[0].url, selected[1].url, selected[2].url]);
            return jsonResponse({results: body.urls.map((entry, index) => ({
                url: index === 0 ? "https://www.a.pl/strona-2/" : entry,
                full_content: `content:${entry}`,
                excerpts: []
            }))});
        });

        const result = await runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected,
            apiKey: "k",
            fetchImpl: selectedFetch
        });

        expect(selectedFetch).toHaveBeenCalledTimes(1);
        expect(result.schema_version).toBe(REPORT_SCHEMA_VERSION);
        expect(result.mode).toBe("selected_links");
        expect(result.dry_run).toBe(false);
        expect(result.source.pages).toEqual(["https://www.a.pl/refinansowanie"]);
        expect(result.selected.map((item) => item.link_id)).toEqual(["link-2", "link-4", "link-1"]);
        expect(result.pages.map((item) => item.link_id)).toEqual(["link-2", "link-4", "link-1"]);
        expect(result.pages.map((item) => item.source_url)).toEqual(["https://www.a.pl/refinansowanie", "https://www.a.pl/refinansowanie", "https://www.a.pl/refinansowanie"]);
        expect(result.pages.map((item) => item.status)).toEqual(["ok", "ok", "ok"]);
        expect(result.pages[0].url).toBe("https://www.a.pl/strona-2/");
        expect(result.pages[0].submitted_url).toBe("https://a.pl/strona-2");
        expect(result.pages[0].content.full_content.text).toBe("content:https://a.pl/strona-2");
        expect(result.pages[2].submitted_url).toBe("https://www.a.pl/oprocentowanie");
        expect(result.summary).toMatchObject({
            selected: 3,
            submitted: 3,
            extracted: 3,
            error: 0,
            api_request_count: 1,
            estimated_cost_usd: 0.003
        });
        expect(typeof result.summary.elapsed_ms).toBe("number");
        expect(JSON.stringify(result)).not.toContain("x-api-key");
    });

    it("fails closed when a selected link result redirects to a disallowed host", async () => {
        const {bank, page} = await sourcePackWithDirectLinks(directLinksContent());
        const selected = [page.direct_links[0], page.direct_links[1]];

        const selectedFetch = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            return jsonResponse({results: [
                {url: "https://www.a.pl/oprocentowanie", final_url: "https://evil.example/redirect", full_content: "x", excerpts: []},
                {url: "https://a.pl/strona-2", full_content: "y", excerpts: []}
            ]});
        });

        const result = await runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected,
            apiKey: "k",
            fetchImpl: selectedFetch
        });

        expect(result.result_errors.map((error) => error.code)).toContain("cross_host_final_url");
        expect(result.pages[0].status).toBe("unresolved");
        expect(result.pages[0].link_id).toBe("link-1");
        expect(result.pages[1].status).toBe("ok");
        expect(result.pages[1].link_id).toBe("link-2");
        expect(result.summary).toMatchObject({selected: 2, submitted: 2, extracted: 1, error: 1});
    });

    it("fails closed for invalid and over-budget selections before any request", async () => {
        const {bank, page} = await sourcePackWithDirectLinks(directLinksContent());
        const valid = page.direct_links[0];
        const fetchMock = vi.fn();

        await expect(runSelectedLinkExtract({bank, sourcePages: [page], selected: [], apiKey: "k", fetchImpl: fetchMock}))
            .rejects.toMatchObject({code: "invalid_configuration", exitCode: 2});
        await expect(runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [...page.direct_links.slice(0, 3), page.direct_links[0]],
            apiKey: "k",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "invalid_configuration", exitCode: 2});
        await expect(runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [{link_id: "link-99", url: valid.url}],
            apiKey: "k",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "invalid_selected_link", exitCode: 2});
        await expect(runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [{link_id: valid.link_id, url: "https://evil.example/x"}],
            apiKey: "k",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "invalid_selected_link", exitCode: 2});
        await expect(runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [{link_id: valid.link_id, url: "https://user:pass@a.pl/x"}],
            apiKey: "k",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "invalid_selected_link", exitCode: 2});
        await expect(runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [{link_id: "bad_id", url: valid.url}],
            apiKey: "k",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "invalid_selected_link", exitCode: 2});
        await expect(runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [{link_id: valid.link_id, url: valid.url}, {link_id: valid.link_id, url: valid.url}],
            apiKey: "k",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "invalid_selected_link", exitCode: 2});
        await expect(runSelectedLinkExtract({bank, sourcePages: [page], selected: [valid], maxCostUsd: 0.0005, apiKey: "k", fetchImpl: fetchMock}))
            .rejects.toMatchObject({code: "budget_guard_exceeded", exitCode: 11});
        await expect(runSelectedLinkExtract({bank, sourcePages: [page], selected: [valid], fetchImpl: fetchMock}))
            .rejects.toMatchObject({code: "missing_api_key", exitCode: 20});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("runs a selected-link dry run without a key and without touching the network", async () => {
        const {bank, page} = await sourcePackWithDirectLinks(directLinksContent());
        const fetchMock = vi.fn();

        const result = await runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [page.direct_links[0], page.direct_links[2]],
            dryRun: true,
            fetchImpl: fetchMock
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.dry_run).toBe(true);
        expect(result.pages).toHaveLength(2);
        expect(result.pages.every((item) => item.status === "dry_run")).toBe(true);
        expect(result.pages.map((item) => item.link_id)).toEqual(["link-1", "link-3"]);
        expect(result.pages.every((item) => item.source_url === "https://www.a.pl/refinansowanie")).toBe(true);
        expect(result.summary).toMatchObject({
            selected: 2,
            submitted: 2,
            extracted: 0,
            error: 0,
            api_request_count: 0
        });
        expect(result.config.max_selected_links).toBe(MAX_SELECTED_LINKS);
        expect(result.config.max_direct_links_per_page).toBe(MAX_DIRECT_LINKS_PER_PAGE);
    });

    it("maps controlled API errors onto selected-link pages carrying link_id", async () => {
        const {bank, page} = await sourcePackWithDirectLinks(directLinksContent());
        const selectedFetch = vi.fn(async () =>
            new Response("nope", {status: 429, headers: {"content-type": "application/json"}}));

        const result = await runSelectedLinkExtract({
            bank,
            sourcePages: [page],
            selected: [page.direct_links[0]],
            apiKey: "k",
            fetchImpl: selectedFetch
        });

        expect(result.pages).toHaveLength(1);
        expect(result.pages[0].status).toBe("error");
        expect(result.pages[0].error.code).toBe("rate_limited");
        expect(result.pages[0].link_id).toBe("link-1");
        expect(result.pages[0].source_url).toBe("https://www.a.pl/refinansowanie");
        expect(result.summary).toMatchObject({submitted: 1, extracted: 0, error: 1, api_request_count: 1});
    });
});
