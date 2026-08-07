import {canonicalJson, canonicalSha256} from "./canonical-json.mjs";
import {validateInstitutionRegistrySnapshot} from "./run-contract-validate.mjs";
import {
    artifactId,
    atomicWriteJson,
    isPlainObject,
    readJson,
    ResearchError
} from "./research-runtime.mjs";

/**
 * Merge the primary BFG registry with the KNF control snapshot. Both sources
 * are required to describe the same exact cooperative-bank scope; a conflict
 * is never silently resolved by choosing one source.
 */
export function mergeInstitutionRegistries({bfg, knf, observedAt = undefined}) {
    const bfgEntries = sourceEntries(bfg, "bfg");
    const knfEntries = sourceEntries(knf, "knf");
    const bfgById = indexUnique(bfgEntries, "bfg");
    const knfById = indexUnique(knfEntries, "knf");
    const errors = [];

    for (const [institutionId, bfgEntry] of bfgById) {
        const knfEntry = knfById.get(institutionId);
        if (!knfEntry) {
            errors.push(`registry_missing_in_knf:${institutionId}`);
            continue;
        }
        for (const field of ["entry_id", "lp", "institution_id", "institution_type", "legal_name", "official_hosts", "allowed_redirect_hosts"]) {
            if (canonicalJson(bfgEntry[field]) !== canonicalJson(knfEntry[field])) {
                errors.push(`registry_conflict:${institutionId}:${field}`);
            }
        }
    }
    for (const institutionId of knfById.keys()) {
        if (!bfgById.has(institutionId)) {
            errors.push(`registry_missing_in_bfg:${institutionId}`);
        }
    }
    if (errors.length > 0) {
        throw new ResearchError("schema_mismatch", "BFG and KNF registry snapshots are inconsistent", {
            exitCode: 10,
            details: {errors: [...new Set(errors)].sort()}
        });
    }

    const entries = [...bfgById.values()]
        .map((entry) => ({
            ...entry,
            registry_sources: ["bfg", "knf"],
            observed_at: observedAt ?? entry.observed_at
        }))
        .sort((left, right) => left.lp - right.lp);
    const snapshot = {
        schema_version: "1.0.0",
        snapshot_id: `registry-${canonicalSha256({source_kind: "bfg_knf", entries}).slice(0, 24)}`,
        source_kind: "bfg_knf",
        observed_at: observedAt ?? entries[0]?.observed_at,
        entries
    };
    const validation = validateInstitutionRegistrySnapshot(snapshot);
    if (!validation.valid) {
        throw new ResearchError("schema_mismatch", "merged registry does not satisfy the registry contract", {
            exitCode: 10,
            details: {errors: validation.errors}
        });
    }
    return snapshot;
}

/**
 * Validate the registry copied by run-init and write a run-local audit record.
 * This stage does not mutate the immutable manifest or any global registry.
 */
export function auditRunRegistry(run, {bfg, knf, outputPath, observedAt = undefined}) {
    const merged = mergeInstitutionRegistries({bfg, knf, observedAt});
    const runRegistry = readJson(`${run.runRoot}/registry.json`, "run registry snapshot");
    const runValidation = validateInstitutionRegistrySnapshot(runRegistry);
    if (!runValidation.valid || canonicalSha256(runRegistry) !== run.manifest.source_registry_sha256) {
        throw new ResearchError("schema_mismatch", "run-local registry snapshot is invalid or changed", {
            exitCode: 10,
            details: {errors: runValidation.errors}
        });
    }
    if (canonicalSha256(merged.entries) !== canonicalSha256(runRegistry.entries)) {
        throw new ResearchError("schema_mismatch", "BFG/KNF registry does not match the immutable run snapshot", {
            exitCode: 10,
            details: {
                expected: canonicalSha256(runRegistry.entries),
                received: canonicalSha256(merged.entries)
            }
        });
    }
    const audit = {
        schema_version: "1.0.0",
        run_id: run.manifest.run_id,
        source_registry_sha256: run.manifest.source_registry_sha256,
        registry_artifact_id: artifactId("reg", run.manifest.source_registry_sha256),
        entry_count: runRegistry.entries.length,
        entries: runRegistry.entries.map((entry) => ({
            entry_id: entry.entry_id,
            institution_id: entry.institution_id,
            official_hosts: entry.official_hosts,
            allowed_redirect_hosts: entry.allowed_redirect_hosts
        })),
        validation: "passed"
    };
    atomicWriteJson(outputPath, audit);
    return {audit, artifactId: audit.registry_artifact_id};
}

function sourceEntries(source, sourceName) {
    const entries = Array.isArray(source) ? source : source?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new ResearchError("schema_mismatch", `${sourceName} registry must contain a non-empty entries array`, {exitCode: 10});
    }
    return entries.map((entry, index) => normalizeEntry(entry, sourceName, index));
}

function normalizeEntry(entry, sourceName, index) {
    if (!isPlainObject(entry)) {
        throw new ResearchError("schema_mismatch", `${sourceName} registry entry ${index} is not an object`, {exitCode: 10});
    }
    const required = [
        "entry_id",
        "lp",
        "institution_id",
        "institution_type",
        "legal_name",
        "official_hosts",
        "allowed_redirect_hosts",
        "observed_at"
    ];
    for (const field of required) {
        if (entry[field] === undefined) {
            throw new ResearchError("schema_mismatch", `${sourceName} registry entry ${index} is missing ${field}`, {exitCode: 10});
        }
    }
    return {
        entry_id: entry.entry_id,
        lp: entry.lp,
        institution_id: entry.institution_id,
        institution_type: entry.institution_type,
        legal_name: entry.legal_name,
        official_hosts: [...entry.official_hosts].sort(),
        allowed_redirect_hosts: [...entry.allowed_redirect_hosts].sort(),
        observed_at: entry.observed_at
    };
}

function indexUnique(entries, sourceName) {
    const indexed = new Map();
    for (const entry of entries) {
        if (indexed.has(entry.institution_id)) {
            throw new ResearchError("schema_mismatch", `${sourceName} registry contains duplicate ${entry.institution_id}`, {
                exitCode: 10,
                details: {source: sourceName, institution_id: entry.institution_id}
            });
        }
        indexed.set(entry.institution_id, entry);
    }
    return indexed;
}
