import {
    artifactId,
    canonicalizeUrl,
    hostAllowed,
    isPlainObject,
    pathAllowedByRobots,
    ResearchError
} from "./research-runtime.mjs";

const TIER_ORDER = Object.freeze({sitemap: 10, official: 20, internal: 30, fixture: 40});

/**
 * Discover only deterministic candidates from the fixture's official graph.
 * The output retains every rejection for auditability; rejected candidates
 * never become fetch/evidence inputs.
 */
export function discoverEntry({fixtureEntry, registryEntry, maxRequests = 256, observationTime}) {
    if (!isPlainObject(fixtureEntry)) {
        throw new ResearchError("required_source_unavailable", "fixture entry is missing", {exitCode: 20});
    }
    const robots = normalizeRobots(fixtureEntry.robots);
    const rawCandidates = [];
    const rejected = [];
    const addCandidate = (raw, defaultTier, source = "fixture") => {
        const candidate = normalizeCandidate(raw, defaultTier, source);
        try {
            candidate.url = canonicalizeUrl(candidate.url);
        } catch (error) {
            rejected.push(rejection(candidate.url ?? String(raw?.url ?? raw), "invalid_url", error.message));
            return;
        }
        if (!hostAllowed(candidate.url, registryEntry, {redirectChain: candidate.redirect_chain})) {
            rejected.push(rejection(candidate.url, "official_host_violation", "URL or redirect leaves the registry allowlist", candidate.required));
            return;
        }
        if (!pathAllowedByRobots(candidate.url, robots)) {
            rejected.push(rejection(candidate.url, "robots_denied", "robots policy denied the candidate path", candidate.required));
            return;
        }
        if (candidate.javascript_required) {
            rejected.push(rejection(candidate.url, "javascript_required", "candidate is a browser-rendered shell", candidate.required));
            return;
        }
        rawCandidates.push(candidate);
    };

    for (const candidate of fixtureEntry.sitemap ?? fixtureEntry.sitemap_urls ?? []) {
        addCandidate(candidate, "sitemap", "sitemap");
    }
    for (const candidate of fixtureEntry.seed_urls ?? fixtureEntry.official_urls ?? []) {
        addCandidate(candidate, "official", "official");
    }
    for (const candidate of fixtureEntry.links ?? fixtureEntry.internal_links ?? []) {
        addCandidate(candidate, "internal", "internal");
    }
    for (const candidate of fixtureEntry.candidates ?? []) {
        addCandidate(candidate, "fixture", "fixture");
    }

    const deduplicated = new Map();
    for (const candidate of rawCandidates) {
        const existing = deduplicated.get(candidate.url);
        if (!existing) {
            deduplicated.set(candidate.url, candidate);
            continue;
        }
        existing.required ||= candidate.required;
        existing.tier = Math.min(existing.tier, candidate.tier);
        existing.sources = [...new Set([...existing.sources, ...candidate.sources])].sort();
        existing.redirect_chain = [...new Set([...existing.redirect_chain, ...candidate.redirect_chain])].sort();
    }

    const allCandidates = [...deduplicated.values()]
        .sort(compareCandidates)
        .map((candidate) => ({
            ...candidate,
            candidate_id: artifactId("can", {
                entry_id: fixtureEntry.entry_id,
                url: candidate.url,
                tier: candidate.tier
            })
        }));
    const limited = allCandidates.slice(0, maxRequests);
    const overflow = allCandidates.slice(maxRequests).map((candidate) => rejection(
        candidate.url,
        "discovery_limit",
        `max_discovery_requests_per_institution=${maxRequests}`,
        candidate.required
    ));
    rejected.push(...overflow);
    const requiredRejected = rejected.filter((item) => item.required);
    const outcome = limited.length > 0
        ? "candidates_found"
        : requiredRejected.length > 0
            ? "required_candidates_rejected"
            : "no_candidates";
    return {
        schema_version: "1.0.0",
        run_id: null,
        entry_id: fixtureEntry.entry_id,
        institution_id: fixtureEntry.institution_id ?? registryEntry.institution_id,
        observed_at: observationTime,
        robots,
        candidates: limited,
        rejected: rejected.sort(compareRejections),
        outcome,
        stats: {
            candidate_count: allCandidates.length,
            selected_count: limited.length,
            rejected_count: rejected.length,
            required_rejected_count: requiredRejected.length,
            deduplicated: rawCandidates.length - allCandidates.length,
            max_requests: maxRequests
        }
    };
}

export function discoveryArtifactId(discovery) {
    const identity = {...discovery, run_id: null};
    return artifactId("dsc", identity);
}

export function validateDiscoveryFixture(fixtureEntry) {
    if (!isPlainObject(fixtureEntry)) {
        throw new ResearchError("schema_mismatch", "discovery fixture entry must be an object", {exitCode: 10});
    }
    if (fixtureEntry.robots !== undefined && !isPlainObject(fixtureEntry.robots)) {
        throw new ResearchError("schema_mismatch", "robots fixture must be an object", {exitCode: 10});
    }
    for (const field of ["sitemap", "sitemap_urls", "seed_urls", "official_urls", "links", "internal_links", "candidates"]) {
        if (fixtureEntry[field] !== undefined && !Array.isArray(fixtureEntry[field])) {
            throw new ResearchError("schema_mismatch", `${field} must be an array`, {exitCode: 10});
        }
    }
    return true;
}

function normalizeCandidate(raw, defaultTier, source) {
    const value = typeof raw === "string" ? {url: raw} : raw;
    if (!isPlainObject(value) || typeof value.url !== "string") {
        throw new ResearchError("schema_mismatch", "discovery candidate must contain a URL", {exitCode: 10});
    }
    const tier = typeof value.tier === "number"
        ? value.tier
        : TIER_ORDER[value.tier] ?? TIER_ORDER[defaultTier] ?? TIER_ORDER.fixture;
    return {
        url: value.url,
        tier,
        source,
        sources: [source],
        source_type: value.source_type ?? "official_product_page",
        required: Boolean(value.required),
        redirect_chain: Array.isArray(value.redirect_chain) ? [...value.redirect_chain] : [],
        javascript_required: Boolean(value.javascript_required || value.js_shell)
    };
}

function normalizeRobots(value) {
    if (value === undefined) {
        return {status: "allow", robots_url: null, checked_at: null, denied_paths: [], allowed_paths: []};
    }
    if (!isPlainObject(value) || !["allow", "deny", "unavailable"].includes(value.status)) {
        throw new ResearchError("schema_mismatch", "robots status must be allow, deny or unavailable", {exitCode: 10});
    }
    return {
        status: value.status,
        robots_url: value.robots_url ?? null,
        checked_at: value.checked_at ?? null,
        denied_paths: [...(value.denied_paths ?? [])].sort(),
        allowed_paths: [...(value.allowed_paths ?? [])].sort()
    };
}

function rejection(url, reason, message, required = false) {
    return {url: typeof url === "string" ? url : String(url), reason, message, required: Boolean(required)};
}

function compareCandidates(left, right) {
    return left.tier - right.tier || left.url.localeCompare(right.url);
}

function compareRejections(left, right) {
    return left.url.localeCompare(right.url) || left.reason.localeCompare(right.reason);
}
