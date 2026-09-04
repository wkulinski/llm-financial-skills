import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
    ENDPOINT,
    buildSearchQueries,
    canonicalIdentity,
    canonicalizeResultUrl,
    eligibleEntries,
    estimateCost,
    hostAllowed,
    normalizeRegistry,
    runPilot,
    selectSample
} from "../../.agents/skills/bs-remortgaging-scan/lib/parallel-search-pilot.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const TOOL = path.join(ROOT, ".agents/skills/bs-remortgaging-scan/tools/parallel-search-pilot.mjs");

const tmpDirs = new Set();

function institutionsRegistry() {
    return {
        schema_version: "1.0.0",
        generated_at: "2026-08-30T00:00:00Z",
        institutions: [
            {institution_id: "bank_1", lp: 1, name: "Bank Pierwszy", website_url: "https://www.bank1.pl/", base_list_status: "active"},
            {institution_id: "bank_2", lp: 2, name: "Bank Drugi", website_url: "http://bank2.pl/", base_list_status: "active"},
            {institution_id: "bank_3", lp: 3, name: "Bank Trzeci", website_url: "https://bank3.pl/", base_list_status: "inactive"},
            {institution_id: "bank_4", lp: 4, name: "Bank Czwarty", website_url: "", base_list_status: "active"},
            {institution_id: "bank_5", lp: 5, name: "Bank Piąty", website_url: "https://bank5.pl/", base_list_status: "active"},
            {institution_id: "bank_6", lp: 6, name: "Bank Szósty", website_url: "https://bank6.pl/", base_list_status: "active"},
            {institution_id: "bank_7", lp: 7, name: "Bank Siódmy", website_url: "https://bank7.pl/", base_list_status: "active"},
            {institution_id: "bank_8", lp: 8, name: "Bank Ósmy", website_url: "https://bank8.pl/", base_list_status: "active"},
            {institution_id: "bank_9", lp: 9, name: "Bank Dziewiąty", website_url: "https://bank9.pl/", base_list_status: "active"}
        ]
    };
}

function eligibleInstitutions() {
    return eligibleEntries(normalizeRegistry(institutionsRegistry()));
}

function mockSearchFetch() {
    return vi.fn(async (_url, _init) => {
        const body = JSON.parse(_init.body);
        const domain = body.search_queries[0].match(/^site:([^ ]+)/u)[1];
        if (domain === "bank1.pl") {
            return new Response(JSON.stringify({
                search_id: "s-1",
                results: [
                    {url: "https://www.bank1.pl/refinansowanie?b=2&a=1#top", title: "Refinansowanie", description: "Spłata kredytu z innego banku", publish_date: "2026-07-01", excerpts: ["fragment A"]},
                    {url: "https://bank1.pl/refinansowanie?a=1&b=2", title: "Refinansowanie bez www", publish_date: "2026-07-01", excerpts: ["fragment A"]},
                    {url: "https://bank1.pl/refinansowanie?b=2&a=1#glowna", title: "Refinansowanie dup", publish_date: "2026-07-01", excerpts: ["fragment A"]},
                    {url: "http://www.bank1.pl/refinansowanie?a=1&b=2", title: "Refinansowanie po http", publish_date: "2026-07-01", excerpts: ["fragment A"]},
                    {url: "http://evil.example/nieoficjalny", title: "Nieoficjalny", publish_date: null, excerpts: []},
                    {url: "https://bank1.pl/stale-oprocentowanie", title: "Stałe oprocentowanie", publish_date: "2026-07-02", excerpts: ["fragment B", "fragment C"]}
                ]
            }), {status: 200});
        }
        if (domain === "bank6.pl") {
            return new Response(JSON.stringify({
                search_id: "s-6",
                results: [
                    {url: "https://bank6.pl/refinansowanie", title: "R", publish_date: null, excerpts: []},
                    {url: "https://bank6.pl/refinansowanie", title: "R dup", publish_date: null, excerpts: []}
                ]
            }), {status: 200});
        }
        return new Response(JSON.stringify({
            search_id: "s-9",
            warnings: ["low result count"],
            results: []
        }), {status: 200});
    });
}

describe("parallel-search-pilot discovery pilot", () => {
    afterEach(() => {
        for (const dir of tmpDirs) {
            fs.rmSync(dir, {recursive: true, force: true});
        }
        tmpDirs.clear();
    });

    it("selects a deterministic even spread over the sorted lp set of active entries with a valid official domain", () => {
        const eligible = eligibleInstitutions();
        expect(eligible.map((entry) => entry.lp)).toEqual([1, 2, 5, 6, 7, 8, 9]);

        expect(selectSample(eligible, {limit: 3}).map((entry) => entry.lp)).toEqual([1, 6, 9]);
        expect(selectSample(eligible, {limit: 2}).map((entry) => entry.lp)).toEqual([1, 9]);
        expect(selectSample(eligible, {limit: 3, offset: 1}).map((entry) => entry.lp)).toEqual([2, 7, 9]);
        expect(selectSample(eligible, {limit: 20}).map((entry) => entry.lp)).toEqual([1, 2, 5, 6, 7, 8, 9]);
        expect(selectSample(eligible, {limit: 2, offset: 0})).toEqual(selectSample(eligible, {limit: 2}));

        const shuffled = [...eligible].reverse();
        expect(selectSample(shuffled, {limit: 3})).toEqual(selectSample(eligible, {limit: 3}));
    });

    it("normalizes the skill entries[] registry shape with official and redirect hosts", () => {
        const registry = {
            schema_version: "1.0.0",
            entries: [
                {entry_id: "e1", lp: 1, institution_id: "i1", legal_name: "Bank A", official_hosts: ["www.a.pl"], allowed_redirect_hosts: ["a.pl"]},
                {entry_id: "e2", lp: 2, institution_id: "i2", legal_name: "Bank B", official_hosts: [], allowed_redirect_hosts: []},
                {entry_id: "e3", lp: 3, institution_id: "i3", legal_name: "Bank C", official_hosts: ["c.pl"], base_list_status: "inactive"}
            ]
        };
        const entries = normalizeRegistry(registry);
        const eligible = eligibleEntries(entries);
        expect(eligible.map((entry) => entry.institution_id)).toEqual(["i1"]);
        expect(hostAllowed("www.a.pl", eligible[0])).toBe(true);
        expect(hostAllowed("a.pl", eligible[0])).toBe(true);
        expect(hostAllowed("evil.example", eligible[0])).toBe(false);
        expect(selectSample(entries, {limit: 1})[0].institution_id).toBe("i1");
    });

    it("runs exactly one POST per bank with the Parallel body and reports host filtering, canonical dedupe and rejections", async () => {
        const fetchMock = mockSearchFetch();
        const report = await runPilot({
            registry: institutionsRegistry(),
            registryPath: "data/base/institutions.current.json",
            limit: 3,
            concurrency: 2,
            mode: "turbo",
            maxCostUsd: 1,
            apiKey: "sekret-abc-123",
            fetchImpl: fetchMock
        });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const [url, init] of fetchMock.mock.calls) {
            expect(url).toBe(ENDPOINT);
            expect(init.method).toBe("POST");
            expect(init.headers["x-api-key"]).toBe("sekret-abc-123");
            expect(init.headers["content-type"]).toBe("application/json");
            const body = JSON.parse(init.body);
            const domain = body.search_queries[0].match(/^site:([^ ]+)/u)[1];
            expect(body.objective).toMatch(/refinansowanie albo przeniesienie/);
            expect(body.objective).toMatch(/oprocentowaniem stałym lub okresowo stałym/);
            expect(body.search_queries).toHaveLength(3);
            expect(body.mode).toBe("turbo");
            expect(body.max_chars_total).toBe(10000);
            expect(body.advanced_settings.source_policy.include_domains).toEqual([domain]);
            expect(body.advanced_settings.excerpt_settings.max_chars_per_result).toBe(1000);
            expect(body.search_queries.every((query) => query.startsWith("site:"))).toBe(true);
            expect(body.search_queries.join(" ")).toMatch(/refinansowanie/);
            expect(body.search_queries.join(" ")).toMatch(/spłata/);
            expect(body.search_queries.join(" ")).toMatch(/przeniesienie/);
            expect(body.search_queries.join(" ")).not.toMatch(/stałe oprocentowanie/);
        }

        expect(report.sample.count).toBe(3);
        expect(report.sample.selected_lp).toEqual([1, 6, 9]);
        expect(report.sample.strategy).toBe("even_spread_over_sorted_lp");

        const byLp = new Map(report.banks.map((record) => [record.bank.lp, record]));
        const bank1 = byLp.get(1);
        expect(bank1.status).toBe("ok");
        expect(bank1.search_id).toBe("s-1");
        expect(bank1.raw_result_count).toBe(6);
        expect(bank1.official_result_count).toBe(2);
        expect(bank1.duplicate_count).toBe(3);
        expect(bank1.rejected_count).toBe(4);
        expect(bank1.rejections).toEqual([
            {url: "https://bank1.pl/refinansowanie?a=1&b=2", reason: "duplicate_canonical_identity"},
            {url: "https://bank1.pl/refinansowanie?a=1&b=2", reason: "duplicate_canonical_identity"},
            {url: "https://www.bank1.pl/refinansowanie?a=1&b=2", reason: "duplicate_canonical_identity"},
            {url: "https://evil.example/nieoficjalny", reason: "cross_host_url"}
        ]);
        expect(bank1.candidates).toHaveLength(2);
        expect(bank1.candidates.map((candidate) => candidate.canonical_url)).toEqual([
            "https://www.bank1.pl/refinansowanie?a=1&b=2",
            "https://bank1.pl/stale-oprocentowanie"
        ]);
        expect(bank1.candidates.every((candidate) => candidate.domain_match === true)).toBe(true);
        expect(bank1.candidates[0]).toEqual({
            domain_match: true,
            canonical_url: "https://www.bank1.pl/refinansowanie?a=1&b=2",
            title: "Refinansowanie",
            description: "Spłata kredytu z innego banku",
            publish_date: "2026-07-01",
            excerpts: ["fragment A"]
        });

        const bank6 = byLp.get(6);
        expect(bank6.raw_result_count).toBe(2);
        expect(bank6.official_result_count).toBe(1);
        expect(bank6.duplicate_count).toBe(1);
        expect(bank6.candidates).toHaveLength(1);

        const bank9 = byLp.get(9);
        expect(bank9.raw_result_count).toBe(0);
        expect(bank9.official_result_count).toBe(0);
        expect(bank9.warnings).toEqual(["low result count"]);
    });

    it("emits the full report envelope with budget, costs and summary, and never leaks the API key", async () => {
        const fetchMock = mockSearchFetch();
        const report = await runPilot({
            registry: institutionsRegistry(),
            registryPath: "data/base/institutions.current.json",
            limit: 3,
            concurrency: 2,
            mode: "turbo",
            maxCostUsd: 1,
            apiKey: "sekret-abc-123",
            fetchImpl: fetchMock
        });

        expect(report.schema_version).toBe("parallel-search-pilot/1.0.0");
        expect(report.provider).toBe("parallel");
        expect(report.endpoint).toBe(ENDPOINT);
        expect(report.mode).toBe("turbo");
        expect(report.input_registry).toEqual({
            path: "data/base/institutions.current.json",
            institution_count: 9,
            eligible_count: 7
        });
        expect(report.request_budget.max_requests_per_bank).toBe(1);
        expect(report.request_budget.concurrency).toBe(2);
        expect(report.request_budget.timeout_ms).toBe(30000);
        expect(report.request_budget.max_cost_usd).toBe(1);
        expect(report.request_budget.estimated_cost_usd).toBeCloseTo(0.003, 6);
        expect(report.request_budget.cost_per_1000_requests_usd).toEqual({turbo: 1, basic: 5, advanced: 5});
        expect(report.summary.status_counts).toEqual({ok: 3});
        expect(report.summary.request_count).toBe(3);
        expect(report.summary.raw_result_count).toBe(8);
        expect(report.summary.official_result_count).toBe(3);
        expect(report.summary.duplicate_count).toBe(4);
        expect(report.summary.rejected_count).toBe(5);
        expect(typeof report.summary.p50_latency_ms).toBe("number");
        expect(typeof report.summary.p95_latency_ms).toBe("number");
        expect(report.summary.p50_latency_ms).toBeLessThanOrEqual(report.summary.p95_latency_ms);

        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain("sekret-abc-123");
        expect(serialized).not.toContain("x-api-key");
        expect(serialized).not.toContain("authorization");
    });

    it("rejects a live run whose estimated cost exceeds max-cost-usd before any request", async () => {
        const fetchMock = vi.fn();
        await expect(runPilot({
            registry: institutionsRegistry(),
            limit: 7,
            mode: "advanced",
            maxCostUsd: 0.005,
            apiKey: "key",
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "budget_guard_exceeded", exitCode: 11});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("requires the API key for a live run and rejects an empty sample", async () => {
        const fetchMock = vi.fn();
        await expect(runPilot({
            registry: institutionsRegistry(),
            limit: 2,
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "missing_api_key", exitCode: 20});
        expect(fetchMock).not.toHaveBeenCalled();

        await expect(runPilot({
            registry: {institutions: [{institution_id: "x", lp: 1, name: "X", website_url: "", base_list_status: "active"}]},
            limit: 2,
            dryRun: true,
            fetchImpl: fetchMock
        })).rejects.toMatchObject({code: "empty_sample", exitCode: 12});
    });

    it("runs dry-run without a key and without touching the network", async () => {
        const fetchMock = vi.fn();
        const report = await runPilot({
            registry: institutionsRegistry(),
            limit: 3,
            dryRun: true,
            fetchImpl: fetchMock
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(report.dry_run).toBe(true);
        expect(report.summary.request_count).toBe(0);
        expect(report.banks.every((record) => record.status === "dry_run")).toBe(true);
        expect(report.banks[0].queries).toHaveLength(3);
        expect(report.request_budget.estimated_cost_usd).toBeCloseTo(0.015, 6);
    });

    it("canonicalizes result URLs with transport upgrade, fragment stripping, query sorting and www equivalence checks", () => {
        expect(canonicalizeResultUrl("https://BANK1.PL:443/kredyt?b=2&a=1#frag")).toEqual({
            ok: true,
            url: "https://bank1.pl/kredyt?a=1&b=2",
            host: "bank1.pl"
        });
        expect(canonicalizeResultUrl("http://bank1.pl/x")).toEqual({
            ok: true,
            url: "https://bank1.pl/x",
            host: "bank1.pl"
        });
        expect(canonicalizeResultUrl("http://bank1.pl:80/x")).toEqual({
            ok: true,
            url: "https://bank1.pl/x",
            host: "bank1.pl"
        });
        expect(canonicalizeResultUrl("ftp://bank1.pl/x")).toEqual({ok: false, reason: "unsupported_protocol"});
        expect(canonicalizeResultUrl("https://user:pass@bank1.pl/x")).toEqual({ok: false, reason: "url_with_credentials"});
        expect(canonicalizeResultUrl("not a url")).toEqual({ok: false, reason: "invalid_url"});
        expect(canonicalizeResultUrl(undefined)).toEqual({ok: false, reason: "missing_url"});
        expect(hostAllowed("www.bank1.pl", {official_hosts: ["bank1.pl"], allowed_redirect_hosts: []})).toBe(true);
        expect(hostAllowed("bank1.pl", {official_hosts: ["bank1.pl"], allowed_redirect_hosts: []})).toBe(true);
        expect(hostAllowed("evil.example", {official_hosts: ["bank1.pl"], allowed_redirect_hosts: []})).toBe(false);
    });

    it("accepts mixed http/https and www/bare official results as exactly one candidate per shared identity and never promotes third-party/invalid/credential URLs", async () => {
        const fetchMock = vi.fn(async (_url, _init) => new Response(JSON.stringify({
            search_id: "s-mixed",
            results: [
                {url: "http://www.mixed.pl/kredyt?a=1&b=2", title: "http www", publish_date: null, excerpts: []},
                {url: "https://mixed.pl/kredyt?b=2&a=1#top", title: "https bare same identity", publish_date: null, excerpts: []},
                {url: "https://mixed.pl/kredyt/", title: "https bare trailing slash", publish_date: null, excerpts: []},
                {url: "https://user:pass@mixed.pl/secret", title: "credential", publish_date: null, excerpts: []},
                {url: "https://evil.example/kredyt", title: "third party", publish_date: null, excerpts: []},
                {url: "not a url", title: "invalid", publish_date: null, excerpts: []},
                {url: "https://mixed.pl/stale", title: "stale", publish_date: null, excerpts: []}
            ]
        }), {status: 200}));

        expect(canonicalIdentity("http://www.mixed.pl/kredyt?a=1&b=2"))
            .toBe(canonicalIdentity("https://mixed.pl/kredyt?b=2&a=1#top"));

        const report = await runPilot({
            registry: {
                schema_version: "1.0.0",
                entries: [
                    {entry_id: "e1", lp: 1, institution_id: "i1", legal_name: "Bank Mixed", official_hosts: ["mixed.pl"], allowed_redirect_hosts: []}
                ]
            },
            limit: 1,
            mode: "turbo",
            maxCostUsd: 1,
            apiKey: "k",
            fetchImpl: fetchMock
        });
        const bank = report.banks[0];
        expect(bank.raw_result_count).toBe(7);
        expect(bank.candidates.map((candidate) => candidate.canonical_url)).toEqual([
            "https://www.mixed.pl/kredyt?a=1&b=2",
            "https://mixed.pl/kredyt/",
            "https://mixed.pl/stale"
        ]);
        expect(bank.candidates.every((candidate) => candidate.domain_match === true)).toBe(true);
        expect(bank.candidates.every((candidate) => !candidate.canonical_url.includes("evil.example"))).toBe(true);
        expect(bank.duplicate_count).toBe(1);
        expect(bank.rejections).toEqual([
            {url: "https://mixed.pl/kredyt?a=1&b=2", reason: "duplicate_canonical_identity"},
            {url: "https://user:pass@mixed.pl/secret", reason: "url_with_credentials"},
            {url: "https://evil.example/kredyt", reason: "cross_host_url"},
            {url: "not a url", reason: "invalid_url"}
        ]);
    });

    it("computes turbo/basic/advanced costs at $1/1000 and $5/1000", () => {
        expect(estimateCost(1000, "turbo")).toBe(1);
        expect(estimateCost(1000, "basic")).toBe(5);
        expect(estimateCost(1000, "advanced")).toBe(5);
        expect(estimateCost(20, "turbo")).toBeCloseTo(0.02, 6);
    });

    it("builds the three refinancing-focused Polish site:domain queries per bank", () => {
        const bank = {institution_id: "bank_1", lp: 1, legal_name: "Bank Pierwszy", official_hosts: ["www.bank1.pl"], allowed_redirect_hosts: []};
        const queries = buildSearchQueries(bank);
        expect(queries).toEqual([
            "site:bank1.pl refinansowanie kredytu hipotecznego",
            "site:bank1.pl spłata kredytu hipotecznego w innym banku",
            "site:bank1.pl przeniesienie kredytu hipotecznego"
        ]);
    });

    it("exposes the CLI for dry-run reporting and guards budget, registry and mode errors", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-pilot-"));
        tmpDirs.add(tmpDir);
        const registryPath = path.join(tmpDir, "registry.json");
        fs.writeFileSync(registryPath, JSON.stringify(institutionsRegistry()));

        const dryRun = spawnSync(process.execPath, [
            TOOL,
            "--registry", registryPath,
            "--output", path.join(tmpDir, "report.json"),
            "--limit", "2",
            "--dry-run"
        ], {encoding: "utf8"});
        expect(dryRun.status).toBe(0);
        expect(JSON.parse(dryRun.stdout).status).toBe("dry_run");
        expect(JSON.parse(dryRun.stdout).sample_count).toBe(2);
        const report = JSON.parse(fs.readFileSync(path.join(tmpDir, "report.json"), "utf8"));
        expect(report.dry_run).toBe(true);
        expect(report.input_registry.path).toBe(registryPath);

        const guarded = spawnSync(process.execPath, [
            TOOL,
            "--registry", registryPath,
            "--output", path.join(tmpDir, "guarded.json"),
            "--limit", "2",
            "--mode", "advanced",
            "--max-cost-usd", "0.001",
            "--dry-run"
        ], {encoding: "utf8"});
        expect(guarded.status).toBe(11);
        expect(guarded.stderr).toContain("budget_guard_exceeded");
        expect(fs.existsSync(path.join(tmpDir, "guarded.json"))).toBe(false);

        const missing = spawnSync(process.execPath, [
            TOOL,
            "--registry", path.join(tmpDir, "nope.json"),
            "--dry-run"
        ], {encoding: "utf8"});
        expect(missing.status).toBe(10);
        expect(missing.stderr).toContain("invalid_registry");

        const badMode = spawnSync(process.execPath, [
            TOOL,
            "--registry", registryPath,
            "--mode", "speedy",
            "--dry-run"
        ], {encoding: "utf8"});
        expect(badMode.status).toBe(2);
        expect(badMode.stderr).toContain("--mode must be one of");

        const env = {...process.env};
        delete env.PARALLEL_API_KEY;
        const noKey = spawnSync(process.execPath, [
            TOOL,
            "--registry", registryPath,
            "--output", path.join(tmpDir, "live.json"),
            "--limit", "2"
        ], {encoding: "utf8", env});
        expect(noKey.status).toBe(20);
        expect(noKey.stderr).toContain("missing_api_key");
        expect(fs.existsSync(path.join(tmpDir, "live.json"))).toBe(false);
    });
});
