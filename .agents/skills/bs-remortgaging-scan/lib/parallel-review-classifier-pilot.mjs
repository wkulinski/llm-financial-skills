import fs from "node:fs";
import crypto from "node:crypto";
import {spawn} from "node:child_process";

import {
    PilotError,
    formatCliError,
    isPlainObject,
    parseArgs,
    parsePositiveInt
} from "./parallel-search-pilot.mjs";
import {classifyMetadataSkip, normalizeAscii} from "./metadata-prefilter.mjs";

export {PilotError, formatCliError, normalizeAscii, parseArgs, parsePositiveInt};

/**
 * Isolated Luna Max bounded review classifier pilot with one bounded
 * follow-up round.
 *
 * Reads a `parallel-extract-pilot/2.1.0` pack (flat and page-first: one
 * entry per page record), evaluates every page independently and builds
 * deterministic prompts, partitions the global ordered items into consecutive
 * batches of at most `batchPages` items and invokes exactly `opencode run
 * --model openai/gpt-5.6-luna --variant high --format json` once per batch
 * (bounded concurrency, no shell, injectable runner for tests), parses each
 * JSONL event stream, strictly validates every batch response (labels,
 * enums, exact substring quotes bound to a declared `source_id`, exact
 * per-batch page ids, exact_offer claim requirements, needs_more_evidence
 * link requests), merges the batches back into the original global order and
 * emits an atomic JSON classification report with aggregate prompt metadata,
 * per-batch invocation metadata and bank rollups.
 *
 * Round one treats one initial flat Extract page as the product/root source;
 * its `direct_links` are discovery metadata only. Luna may request a bounded
 * follow-up with the `needs_more_evidence` label, non-empty `missing_claims`
 * limited to refinancing/fixed_rate and 1..3 unique `requested_link_ids`
 * that exist on that exact page. The orchestrator performs at most ONE
 * follow-up round: it calls the injectable `followupExtractor` once per
 * requesting page with the bank, the exact source page and the selected link
 * objects, builds one offer item from the root full content plus the
 * successfully fetched page full contents (stable source ids `source-1` for
 * the root, then `source-2..N` in selected order) and runs bounded model
 * batches again only for those items with follow-up disabled. A second-round
 * link request is deterministically finalized as unresolved; a request that
 * cannot be fetched is also unresolved — anchor/context/link URLs are never
 * evidence, so link text can never ground a final claim.
 *
 * Every prompt entry is one flat page record and its only evidentiary text
 * is that same page's stored `content.full_content.text` (round one) or the
 * root/fetched source texts listed for that offer item (round two): the
 * prompt and exact-quote validation are both bound to those sources, so
 * excerpts, keyword-window compaction, bundle markers, link anchors,
 * contexts, URLs and text from other pages can never satisfy or influence a
 * quote. Error/unresolved pages and pages with empty content are unresolved.
 * Only the current 2.1.0 page-first Extract schema is accepted: historical
 * fetch/bundle packs and Extract 1.0.0 packs are rejected on the schema
 * check, with no legacy reader or adaptation.
 *
 * This module is deliberately self-contained: it does not import the run
 * lifecycle, schema registry or transport layers of the existing skill. The
 * default follow-up extractor lazily delegates to the sibling
 * parallel-extract-pilot `runSelectedLinkExtract`; the CLI wires that same
 * extractor explicitly with PARALLEL_API_KEY.
 */

export const REPORT_SCHEMA_VERSION = "parallel-review-classifier-pilot/3.0.0";
export const MODEL_SCHEMA_VERSION = "parallel-review-classification-model/2.0.0";
export const EXTRACT_SOURCE_SCHEMA_VERSION = "parallel-extract-pilot/2.1.0";

export const MODEL = "openai/gpt-5.6-luna";
export const VARIANT = "high";
export const VARIANTS = Object.freeze(["low", "medium", "high", "max"]);

export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_STREAM_BYTES = 2 * 1024 * 1024;
export const MAX_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;

export const MAX_QUOTES_PER_PAGE = 4;

export const DEFAULT_BATCH_PAGES = 5;
export const BATCH_PAGES_MIN = 1;
export const BATCH_PAGES_MAX = 10;
export const DEFAULT_BATCH_CONCURRENCY = 6;
export const MAX_BATCH_ATTEMPTS = 2;
export const BATCH_CONCURRENCY_MIN = 1;
export const BATCH_CONCURRENCY_MAX = 8;

export const LABELS = Object.freeze(["exact_offer", "related_page", "noise", "unresolved", "needs_more_evidence"]);
export const ELIGIBILITY_VALUES = Object.freeze(["yes", "no", "unknown"]);
export const CONFIDENCE_VALUES = Object.freeze(["high", "medium", "low"]);
export const CLAIM_VALUES = Object.freeze(["refinancing", "fixed_rate", "context"]);
export const MISSING_CLAIM_VALUES = Object.freeze(["refinancing", "fixed_rate"]);

export const ROOT_SOURCE_ID = "source-1";
export const MAX_REQUESTED_LINKS = 3;

export function assertVariant(value) {
    if (!VARIANTS.includes(value)) {
        throw new PilotError("invalid_configuration", `variant must be one of ${VARIANTS.join(", ")}`, {exitCode: 2});
    }
}

function sha256Hex(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null) return value;
    }
    return null;
}

export function assertBatchPages(value) {
    if (!Number.isInteger(value) || value < BATCH_PAGES_MIN || value > BATCH_PAGES_MAX) {
        throw new PilotError("invalid_configuration", `batch_pages must be an integer between ${BATCH_PAGES_MIN} and ${BATCH_PAGES_MAX}`, {exitCode: 2});
    }
}

export function parseBatchPages(name, value) {
    const parsed = parsePositiveInt(name, value);
    if (parsed < BATCH_PAGES_MIN || parsed > BATCH_PAGES_MAX) {
        throw new PilotError("invalid_invocation", `--${name} must be between ${BATCH_PAGES_MIN} and ${BATCH_PAGES_MAX}`, {exitCode: 2});
    }
    return parsed;
}

export function assertBatchConcurrency(value) {
    if (!Number.isInteger(value) || value < BATCH_CONCURRENCY_MIN || value > BATCH_CONCURRENCY_MAX) {
        throw new PilotError("invalid_configuration", `batch_concurrency must be an integer between ${BATCH_CONCURRENCY_MIN} and ${BATCH_CONCURRENCY_MAX}`, {exitCode: 2});
    }
}

export function parseBatchConcurrency(name, value) {
    const parsed = parsePositiveInt(name, value);
    if (parsed < BATCH_CONCURRENCY_MIN || parsed > BATCH_CONCURRENCY_MAX) {
        throw new PilotError("invalid_invocation", `--${name} must be between ${BATCH_CONCURRENCY_MIN} and ${BATCH_CONCURRENCY_MAX}`, {exitCode: 2});
    }
    return parsed;
}

/**
 * Strict structural validation of the flat `parallel-extract-pilot/2.1.0`
 * pack: exact schema version, banks[], a stable bank object per record and a
 * pages[] array per bank whose page records carry a status string and a url
 * string. Any malformed, historical fetch/bundle or Extract 1.0.0 pack fails
 * closed on this schema check; the classifier never silently falls back to a
 * legacy shape.
 */
export function validateExtractPack(value) {
    if (!isPlainObject(value)) {
        throw new PilotError("invalid_review_pack", "review pack must be a JSON object", {exitCode: 10});
    }
    if (value.schema_version !== EXTRACT_SOURCE_SCHEMA_VERSION) {
        throw new PilotError("invalid_review_pack", `review pack must have schema_version ${EXTRACT_SOURCE_SCHEMA_VERSION}`, {exitCode: 10});
    }
    if (!Array.isArray(value.banks)) {
        throw new PilotError("invalid_review_pack", "review pack must contain a banks[] array", {exitCode: 10});
    }
    for (const [bankIndex, record] of value.banks.entries()) {
        if (!isPlainObject(record) || !isPlainObject(record.bank)) {
            throw new PilotError("invalid_review_pack", `banks[${bankIndex}] must contain a bank object`, {exitCode: 10});
        }
        if (!Array.isArray(record.pages)) {
            throw new PilotError("invalid_review_pack", `banks[${bankIndex}] must contain a pages[] array`, {exitCode: 10});
        }
        if (!isPlainObject(record.preflight)
            || record.preflight.enabled !== true
            || !Array.isArray(record.preflight.skipped)
            || !Number.isInteger(record.preflight.skipped_candidate_count)
            || record.preflight.skipped_candidate_count !== record.preflight.skipped.length
            || !Number.isInteger(record.preflight.remaining_candidate_count)
            || record.preflight.remaining_candidate_count < 0
            || !["continue", "not_found", "not_run"].includes(record.preflight.outcome)
            || (record.preflight.outcome === "continue"
                && (record.preflight.reason !== null || record.preflight.remaining_candidate_count < 1))
            || (record.preflight.outcome !== "continue"
                && (typeof record.preflight.reason !== "string"
                    || record.preflight.reason.trim() === ""
                    || record.preflight.remaining_candidate_count !== 0))) {
            throw new PilotError("invalid_review_pack", `banks[${bankIndex}] requires a valid preflight object`, {exitCode: 10});
        }
        for (const [skipIndex, skipped] of record.preflight.skipped.entries()) {
            if (!isPlainObject(skipped)
                || typeof skipped.url !== "string"
                || skipped.url.trim() === ""
                || skipped.label !== "noise"
                || typeof skipped.reason !== "string"
                || skipped.reason.trim() === "") {
                throw new PilotError("invalid_review_pack", `banks[${bankIndex}].preflight.skipped[${skipIndex}] is invalid`, {exitCode: 10});
            }
        }
        for (const [pageIndex, page] of record.pages.entries()) {
            if (!isPlainObject(page)) {
                throw new PilotError("invalid_review_pack", `banks[${bankIndex}].pages[${pageIndex}] must be a page object`, {exitCode: 10});
            }
            if (typeof page.status !== "string" || page.status === "") {
                throw new PilotError("invalid_review_pack", `banks[${bankIndex}].pages[${pageIndex}] requires a status string`, {exitCode: 10});
            }
            if (typeof page.url !== "string" || page.url.trim() === "") {
                throw new PilotError("invalid_review_pack", `banks[${bankIndex}].pages[${pageIndex}] requires a url string`, {exitCode: 10});
            }
            if (page.status === "ok" && (!isPlainObject(page.content) || !isPlainObject(page.content.full_content) || typeof page.content.full_content.text !== "string")) {
                throw new PilotError("invalid_review_pack", `banks[${bankIndex}].pages[${pageIndex}] requires content.full_content.text for an ok page`, {exitCode: 10});
            }
        }
    }
    return value;
}

function readSourceFile(inputPath) {
    try {
        return JSON.parse(fs.readFileSync(inputPath, "utf8"));
    } catch (error) {
        throw new PilotError("invalid_review_pack", `review pack ${inputPath} cannot be read as JSON`, {
            exitCode: 10,
            details: {path: inputPath},
            cause: error
        });
    }
}

function loadSource(inputPath, sourceReport) {
    if (sourceReport !== undefined) {
        validateExtractPack(sourceReport);
        return {
            report: sourceReport,
            path: inputPath ?? null,
            sha256: sha256Hex(Buffer.from(JSON.stringify(sourceReport), "utf8"))
        };
    }
    if (typeof inputPath !== "string" || inputPath === "") {
        throw new PilotError("invalid_review_pack", "input review pack is required", {exitCode: 10});
    }
    const report = readSourceFile(inputPath);
    validateExtractPack(report);
    return {report, path: inputPath, sha256: sha256Hex(fs.readFileSync(inputPath))};
}

function buildPromptText(entries) {
    const followupRound = entries.some((entry) => Array.isArray(entry.sources) && entry.sources.length > 0);
    const lines = [];
    lines.push("You are Luna High, a strict classifier for a mortgage refinancing review scan.");
    lines.push("");
    lines.push("Task: classify each offer-root item below into exactly one label using ONLY its metadata and permitted EVIDENCE TEXT. Do not use tools, do not browse, do not rely on outside knowledge, do not invent content.");
    lines.push("");
    lines.push("Output contract:");
    lines.push(`- Reply with a single JSON document only: {"schema_version": "${MODEL_SCHEMA_VERSION}", "pages": [...]}`);
    lines.push("- No markdown, no code fences, no commentary before or after the JSON.");
    lines.push(`- pages[] must contain exactly ${entries.length} entries using exactly the page ids listed below (each id exactly once).`);
    lines.push('- Every page entry must be exactly: {"page_id": string, "label": "exact_offer"|"related_page"|"noise"|"unresolved"|"needs_more_evidence", "refinancing_eligibility": "yes"|"no"|"unknown", "periodic_fixed_rate": "yes"|"no"|"unknown", "confidence": "high"|"medium"|"low", "evidence": [{"claim": "refinancing"|"fixed_rate"|"context", "quote": string, "source_id": string}, ...], "missing_claims": ["refinancing"|"fixed_rate"], "requested_link_ids": [string], "rationale": string}');
    lines.push(`- evidence[] must contain 0 to ${MAX_QUOTES_PER_PAGE} items; every evidence item must carry "source_id".`);
    lines.push("- missing_claims[] must be empty unless the label is needs_more_evidence.");
    lines.push("- requested_link_ids[] must be empty unless the label is needs_more_evidence.");
    lines.push("");
    lines.push("Label definitions (strict):");
    lines.push("- exact_offer: the official page evidence establishes BOTH (A) a consumer residential mortgage/housing credit can repay or refinance debt from a housing/mortgage credit in another bank, AND (B) the same offer or directly applicable evidence includes a periodically fixed or fixed rate for that housing/mortgage credit. Criterion (B) is satisfied when the page text contains explicit rate terms (for example: 'oprocentowanie okresowo-stałe', 'stała stopa procentowa', 'okresowo stałe', 'RRSO', a percentage with 'stałe'). A named rate category that implies a fixed or periodically fixed rate (for example: 'Oprocentowanie okresowo-stałe' as a section heading, menu item, or subpage link) satisfies (B) ONLY when it appears on the same official mortgage/housing product page that establishes (A); on a homepage, generic offer listing, news or other non-product page it is not sufficient evidence on its own. Both (A) and (B) must be supported by exact quotes.");
    lines.push("- related_page: official content concerns mortgage/housing/refinancing/rate but does not establish both (A) and (B) for the same consumer offer; includes generic mortgage pages, old news, business credit, pricing tables, account transfer.");
    lines.push("- noise: unrelated product or page with no material support for (A) or (B).");
    lines.push("- unresolved: fetch failed, the page has no body text, or the combined sources do not establish a decision.");
    lines.push("- needs_more_evidence: the current official product page is the offer root but its EVIDENCE TEXT lacks a required claim (refinancing or fixed_rate) and a DIRECT LINK listed for THIS page should be read to supply it. Request that link instead of guessing. Never infer a claim from link anchor text or link context: anchors, contexts and link URLs are metadata, not evidence.");
    lines.push("");
    lines.push("Evidence rules:");
    lines.push("- The refinancing quote for exact_offer must itself explicitly establish refinancing evidence: it describes refinancing or transfer of a mortgage/housing loan (for example: 'refinansowanie kredytu hipotecznego', 'przeniesienie kredytu mieszkaniowego'), or it describes repayment of mortgage/housing credit or debt explicitly tied to another bank or external financial institution (for example: 'w innym banku', 'z innego banku', 'przez inny bank'). Generic repayment text without such explicit refinancing/transfer or another-bank context does not satisfy criterion (A).");
    lines.push("- Every quote must be copied character-for-character as one contiguous exact substring of ONE permitted source's EVIDENCE TEXT below. Never quote the title/URL metadata, a link anchor, a link URL or link context, paraphrase, translate, normalize punctuation or merge fragments or content from another source.");
    lines.push('- Each evidence item must carry "source_id": the id of the exact source its quote comes from.');
    if (followupRound) {
        lines.push("- Only the source ids listed in that page's SOURCES section are permitted sources.");
    } else {
        lines.push('- In this round only "source-1" (this page\'s EVIDENCE TEXT) is a permitted source.');
    }
    lines.push("- Before returning JSON, verify each quote by locating the identical character sequence in its source's supplied EVIDENCE TEXT. If no safe exact quote exists, omit it and do not use exact_offer.");
    lines.push('- exact_offer requires at least one evidence item with claim "refinancing" AND at least one with claim "fixed_rate", both with substring-valid quotes, and refinancing_eligibility and periodic_fixed_rate both "yes".');
    lines.push("- For related_page, noise, unresolved and needs_more_evidence, evidence MUST be an empty array. Verbatim quote validation is reserved for exact_offer decisions.");
    lines.push('- refinancing_eligibility is "yes" only when the item\'s permitted evidence sources establish (A); periodic_fixed_rate is "yes" when those sources establish (B), including explicit rate terms, or a named rate category on the same official mortgage/housing product page that establishes (A). A named rate category on a homepage, generic offer listing, news or other non-product page is not sufficient on its own.');
    lines.push('- needs_more_evidence: missing_claims must be non-empty and list ONLY the claims ("refinancing"/"fixed_rate") that THIS page\'s EVIDENCE TEXT does not establish and that a listed DIRECT LINK should supply; requested_link_ids must contain 1 to 3 unique link ids that all exist in THIS page\'s DIRECT LINKS section and must be empty for every other label.');
    lines.push("- Request a direct link only when the current official product page lacks a required claim and a listed direct link should be read; never infer the claim from anchor or context text.");
    if (followupRound) {
        lines.push("");
        lines.push("Follow-up round: each page below is one explicitly linked offer combining the root product page and the direct documents fetched in the previous round. Follow-up is DISABLED: do not request additional links. requested_link_ids must be empty and needs_more_evidence is not permitted; if the combined sources are insufficient, reply \"unresolved\".");
    }
    lines.push("");
    lines.push(`PAGE_COUNT: ${entries.length}`);
    lines.push(`PAGE_IDS: ${entries.map((entry) => entry.page_id).join(", ")}`);
    lines.push("");
    for (const entry of entries) {
        lines.push(`### page ${entry.page_id}`);
        lines.push(`bank: ${entry.bank.institution_id ?? "unknown"} (${entry.bank.legal_name ?? "unknown"})`);
        lines.push(`url: ${entry.url ?? "unknown"}`);
        lines.push(`title: ${entry.title ?? "(none)"}`);
        lines.push(`fetch: ${entry.status}${entry.http_status !== null ? ` (http ${entry.http_status})` : ""}${entry.error !== null ? ` error: ${entry.error.code}` : ""}`);
        if (followupRound) {
            lines.push("SOURCES:");
            for (const source of entry.sources) {
                lines.push(`- ${source.source_id}: ${source.relationship === "root" ? "root product page" : `direct link ${source.link_id ?? "?"}`} ${source.url ?? "unknown"} (EVIDENCE TEXT below)`);
            }
            for (const source of entry.sources) {
                lines.push(`EVIDENCE TEXT (${source.source_id}):`);
                lines.push(source.text === "" ? "(no body text available)" : source.text);
                lines.push("");
            }
        } else {
            if (Array.isArray(entry.direct_links) && entry.direct_links.length > 0) {
                lines.push("DIRECT LINKS (metadata only — never quote anchor text, context or link URLs):");
                for (const link of entry.direct_links) {
                    lines.push(`- ${link.link_id}: anchor ${JSON.stringify(link.anchor_text ?? "")} context ${JSON.stringify(link.context ?? "")} url ${link.url}`);
                }
            } else {
                lines.push("DIRECT LINKS: (none)");
            }
            lines.push("EVIDENCE TEXT:");
            lines.push(entry.evidence === "" ? "(no body text available)" : entry.evidence);
            lines.push("");
        }
    }
    return lines.join("\n");
}

/**
 * Build the global ordered page entries for the whole review pack. This is a
 * page-first alias to the flat Extract adapter: the classifier only accepts
 * `parallel-extract-pilot/2.1.0` packs, so every entry is one flat page
 * record and legacy fetch/bundle shapes are rejected on the schema check.
 */
export function buildPromptEntries(pack) {
    return buildExtractPromptEntries(pack);
}

/**
 * Conservative deterministic page pre-filter. Pages that can never carry a
 * qualifying offer are skipped before any model call:
 *
 * - fetch-error / unresolved / empty-content pages are fixed to `unresolved`
 *   (the validator would force that label anyway);
 * - pages whose title and URL are both free of any credit/rate vocabulary and
 *   match an explicit non-product stem (bank boilerplate: about, contact,
 *   login, help, sitemap, corporate info, agricultural pages, application PDF
 *   forms, test pages) are fixed to `noise`;
 * - explicit non-mortgage credit combinations (for example account-transfer,
 *   BLIK, agricultural, consumer, business or current-account vocabulary)
 *   are fixed to `noise` even when generic credit vocabulary is present.
 *
 * Generic credit/rate vocabulary alone is never enough to skip a page. Mortgage
 * markers (`hipotec`, `mieszkaniow`) always protect it; an explicit
 * non-mortgage combination is required for the deterministic downgrade.
 *
 * Matching uses ASCII-normalized substring stems, not word-boundary regexes:
 * URLs never carry Polish diacritics (wladze-banku, pozyczka-hipoteczna) and
 * Polish inflections vary, so a stem like "wniosk" covers wniosek/wniosku/
 * wnioski while "wladz" covers wladze/wladzy. The normalization also maps
 * title diacritics (O Banku -> o banku) so both title and URL match the same
 * ASCII stem set.
 *
 * @returns {{modelEntries: object[], skippedEntries: Array<{entry, label, reason}>}}
 */
export function prefilterPages(entries) {
    const modelEntries = [];
    const skippedEntries = [];
    for (const entry of entries) {
        const skip = classifyPrefilterSkip(entry);
        if (skip === null) {
            modelEntries.push(entry);
        } else {
            skippedEntries.push({entry, label: skip.label, reason: skip.reason});
        }
    }
    return {modelEntries, skippedEntries};
}

function classifyPrefilterSkip(entry) {
    if (entry.status !== "ok" || typeof entry.evidence !== "string" || entry.evidence.trim() === "") {
        return {label: "unresolved", reason: "no_fetchable_content"};
    }
    return classifyMetadataSkip(entry, {phase: "post_extract"});
}

/**
 * Build the global ordered page entries of a flat `parallel-extract-pilot/2.1.0`
 * pack: exactly one entry per page record (never per bundle), in bank order
 * then page order, with a stable `p<bank>-<page>` page id.
 *
 * Every page is classified independently and the only evidentiary text is
 * that page's stored `content.full_content.text`: ok pages with a non-empty
 * string carry the full stored content as their evidence, while
 * error/unresolved/dry-run pages and ok pages with empty content carry no
 * evidence at all. Excerpts and text from other pages are never part of an
 * extract entry, so strict quote validation can only ever ground a quote
 * inside the same page's full content. Text that merely reached the extract
 * full-content cap but is non-empty stays classifiable; no truncation-limit
 * heuristic is applied.
 *
 * `direct_links` carries the page's official direct link records as
 * discovery metadata only (sanitized to stable link_id/url pairs), and
 * `bank_record`/`page_record` keep the exact source pack records so the
 * follow-up orchestrator can hand the exact page to the extractor. None of
 * these fields is ever part of a quote source.
 */
export function buildExtractPromptEntries(pack) {
    validateExtractPack(pack);
    const entries = [];
    for (const [bankIndex, bankRecord] of pack.banks.entries()) {
        const bank = bankRecord.bank ?? {};
        const bankIdentity = {
            institution_id: typeof bank.institution_id === "string" ? bank.institution_id : null,
            legal_name: typeof bank.legal_name === "string" && bank.legal_name.trim() !== "" ? bank.legal_name : bank.institution_id ?? null
        };
        const pages = Array.isArray(bankRecord.pages) ? bankRecord.pages : [];
        for (const [pageIndex, page] of pages.entries()) {
            const pageId = `p${bankIndex + 1}-${pageIndex + 1}`;
            const fullContent = page?.content?.full_content;
            const fullText = fullContent?.text;
            const contentAvailable = page?.status === "ok"
                && typeof fullText === "string"
                && fullText.trim() !== "";
            const directLinks = [];
            const seenLinkIds = new Set();
            for (const link of Array.isArray(page?.direct_links) ? page.direct_links : []) {
                if (!isPlainObject(link) || typeof link.link_id !== "string" || link.link_id === "" || typeof link.url !== "string" || link.url === "") {
                    continue;
                }
                if (seenLinkIds.has(link.link_id)) continue;
                seenLinkIds.add(link.link_id);
                directLinks.push({
                    link_id: link.link_id,
                    url: link.url,
                    anchor_text: typeof link.anchor_text === "string" ? link.anchor_text : null,
                    context: typeof link.context === "string" ? link.context : null
                });
            }
            entries.push({
                page_id: pageId,
                bank: bankIdentity,
                url: page?.url ?? page?.submitted_url ?? null,
                title: typeof page?.title === "string" ? page.title : null,
                description: typeof page?.description === "string" ? page.description : null,
                status: page?.status ?? "unknown",
                http_status: null,
                error: page?.status === "ok"
                    ? null
                    : {code: page?.error?.code ?? "page_unresolved", message: page?.error?.message ?? null},
                full_content: isPlainObject(fullContent)
                    ? {
                        original_chars: Number.isInteger(fullContent?.original_chars) ? fullContent.original_chars : null,
                        stored_chars: Number.isInteger(fullContent?.stored_chars) ? fullContent.stored_chars : (typeof fullText === "string" ? fullText.length : 0),
                        truncated: fullContent?.truncated === true,
                        sha256: typeof fullContent?.sha256 === "string" ? fullContent.sha256 : null
                    }
                    : null,
                evidence: contentAvailable ? fullText : "",
                direct_links: directLinks,
                bank_record: bankRecord,
                page_record: page
            });
        }
    }
    return entries;
}

/**
 * Build ONE round-two offer entry for a requesting root page: the root's
 * full content stays the only `source-1` text, then every successfully
 * fetched direct document is appended in selected order as `source-2..N`
 * with its own url and link id. Failed, unresolved and empty fetched pages
 * are never part of the sources. A second-round link request is converted to
 * unresolved by the orchestrator. The returned entry keeps the root's
 * sanitized `direct_links` only as validation context for requested link ids.
 */
export function buildOfferEntry({entry, fetchedPages}) {
    const okFetched = Array.isArray(fetchedPages)
        ? fetchedPages.filter((page) => page?.status === "ok"
            && typeof page?.content?.full_content?.text === "string"
            && page.content.full_content.text.trim() !== "")
        : [];
    const sources = [
        {
            source_id: ROOT_SOURCE_ID,
            url: entry.url ?? null,
            relationship: "root",
            text: entry.evidence
        },
        ...okFetched.map((page, index) => ({
            source_id: `source-${index + 2}`,
            url: typeof page.url === "string" && page.url !== "" ? page.url : (typeof page.submitted_url === "string" ? page.submitted_url : null),
            relationship: "direct_link",
            link_id: typeof page.link_id === "string" ? page.link_id : null,
            text: page.content.full_content.text
        }))
    ];
    return {
        page_id: entry.page_id,
        bank: entry.bank,
        url: entry.url,
        title: entry.title,
        status: "ok",
        http_status: null,
        error: null,
        full_content: entry.full_content,
        evidence: entry.evidence,
        sources,
        direct_links: entry.direct_links ?? []
    };
}

/**
 * Build ONE prompt for all pages of the review pack plus the deterministic
 * per-page metadata needed to validate the model response (page ids, full
 * stored evidence, hashes and audit character counts).
 */
export function buildPrompt(pack) {
    const entries = buildPromptEntries(pack);
    const prompt = buildPromptText(entries);
    return {
        prompt,
        prompt_sha256: sha256Hex(Buffer.from(prompt, "utf8")),
        prompt_chars: prompt.length,
        page_count: entries.length,
        pages: entries
    };
}

/**
 * Deterministic consecutive partition of the global ordered page entries
 * into batches of at most `batchPages` entries (the last batch may be
 * smaller). Identical input always yields identical batches.
 */
export function partitionEntries(entries, {batchPages = DEFAULT_BATCH_PAGES} = {}) {
    assertBatchPages(batchPages);
    const batches = [];
    for (let index = 0; index < entries.length; index += batchPages) {
        batches.push(entries.slice(index, index + batchPages));
    }
    return batches;
}

/**
 * Build the ordered batch list: each batch carries its own strict prompt
 * (only that batch's page ids), prompt sha256/char counts and the page
 * entries used as validation context.
 */
export function buildBatches(entries, {batchPages = DEFAULT_BATCH_PAGES} = {}) {
    return partitionEntries(entries, {batchPages}).map((batchEntries, index) => {
        const prompt = buildPromptText(batchEntries);
        return {
            batch_index: index,
            page_count: batchEntries.length,
            page_ids: batchEntries.map((entry) => entry.page_id),
            pages: batchEntries,
            prompt,
            prompt_sha256: sha256Hex(Buffer.from(prompt, "utf8")),
            prompt_chars: prompt.length
        };
    });
}

/**
 * Aggregate prompt fingerprint: sha256 over the concatenation of the ordered
 * per-batch prompt sha256 hex digests.
 */
export function aggregatePromptSha256(batches) {
    return sha256Hex(Buffer.from(batches.map((batch) => batch.prompt_sha256).join(""), "utf8"));
}

/**
 * Strip an optional deterministic ```json fence around the model payload.
 * Any other markdown fence is rejected.
 */
export function extractJsonPayload(text) {
    const trimmed = String(text).trim();
    if (trimmed === "") {
        throw new PilotError("invalid_model_json", "model text payload is empty", {exitCode: 12});
    }
    const lines = trimmed.split("\n");
    const first = lines[0].trim();
    if (/^```json\s*$/iu.test(first)) {
        let closing = -1;
        for (let index = 1; index < lines.length; index += 1) {
            const line = lines[index].trim();
            if (/^```/u.test(line)) {
                if (closing !== -1) {
                    throw new PilotError("invalid_model_json", "model payload contains multiple markdown fences", {exitCode: 12});
                }
                if (/^```\s*$/u.test(line)) {
                    closing = index;
                } else {
                    throw new PilotError("invalid_model_json", "model payload contains an unsupported markdown fence", {exitCode: 12});
                }
            }
        }
        if (closing === -1) {
            throw new PilotError("invalid_model_json", "model payload has an unclosed markdown fence", {exitCode: 12});
        }
        return lines.slice(1, closing).join("\n").trim();
    }
    if (/```/u.test(trimmed)) {
        throw new PilotError("invalid_model_json", "model payload contains a markdown fence", {exitCode: 12});
    }
    return trimmed;
}

export function parseModelPayload(text) {
    const candidate = extractJsonPayload(text);
    try {
        return JSON.parse(candidate);
    } catch (error) {
        throw new PilotError("invalid_model_json", "model payload is not valid JSON", {exitCode: 12, cause: error});
    }
}

function extractStepFinishMetadata(event) {
    if (!isPlainObject(event)) {
        return {session_id: null, tokens: null, cost: null};
    }
    const step = isPlainObject(event.step) ? event.step : {};
    const part = isPlainObject(event.part) ? event.part : {};
    return {
        session_id: firstDefined(event.sessionID, event.session_id, part.sessionID, part.session_id, step.sessionID, step.session_id),
        tokens: firstDefined(event.tokens, event.usage, part.tokens, part.usage, step.tokens, step.usage),
        cost: firstDefined(event.cost, event.total_cost, part.cost, part.total_cost, step.cost, step.total_cost)
    };
}

/**
 * Parse the `opencode --format json` JSONL event stream: collect only
 * `type=text` event `part.text`, require exactly one non-empty final text
 * payload, extract session/token/cost metadata from `step_finish`, and ignore
 * every other event type.
 */
export function parseModelJsonl(stdout) {
    const lines = String(stdout)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    const textEvents = [];
    let stepFinishEvent = null;
    for (const line of lines) {
        let event;
        try {
            event = JSON.parse(line);
        } catch (error) {
            throw new PilotError("invalid_model_stream", "opencode JSONL stream contains a non-JSON line", {exitCode: 12, cause: error});
        }
        if (!isPlainObject(event)) {
            throw new PilotError("invalid_model_stream", "opencode JSONL stream contains a non-object event", {exitCode: 12});
        }
        if (event.type === "text") {
            textEvents.push(event);
        } else if (event.type === "step_finish") {
            stepFinishEvent = event;
        }
    }
    if (textEvents.length === 0) {
        throw new PilotError("invalid_model_stream", "opencode JSONL stream contains no text event", {exitCode: 12});
    }
    if (textEvents.length > 1) {
        throw new PilotError("invalid_model_stream", "opencode JSONL stream contains multiple text events", {exitCode: 12});
    }
    const text = textEvents[0]?.part?.text;
    if (typeof text !== "string" || text.trim() === "") {
        throw new PilotError("invalid_model_stream", "opencode text event carries no text payload", {exitCode: 12});
    }
    return {
        payload: parseModelPayload(text),
        metadata: extractStepFinishMetadata(stepFinishEvent)
    };
}

/**
 * Ground a model quote as an exact contiguous source substring. Semantic OCR
 * interpretation belongs to Luna; the deterministic layer does not maintain
 * parallel normalized/source-map representations or repair model quotations.
 */
export function resolveGroundedQuote(source, quote) {
    return typeof source === "string" && typeof quote === "string" && quote !== "" && source.includes(quote)
        ? quote
        : null;
}

/**
 * Strict model response validation: exact schema version, exact page id set
 * (no missing/duplicate/unknown ids), strict enums, 0-4 evidence items with
 * a permitted `source_id` and exact-substring quotes against ONLY that
 * source's sent text, the exact_offer claim/eligibility contract and the
 * bounded needs_more_evidence link-request contract (non-empty
 * missing_claims limited to refinancing/fixed_rate, 1..3 unique
 * requested_link_ids that must exist on that exact page, empty evidence).
 * Every other label must carry empty missing_claims/requested_link_ids and
 * must not request links.
 */
export function validateModelResponse(parsed, promptMeta) {
    if (!isPlainObject(parsed)) {
        throw new PilotError("invalid_model_response", "model response must be a JSON object", {exitCode: 12});
    }
    if (parsed.schema_version !== MODEL_SCHEMA_VERSION) {
        throw new PilotError("invalid_model_response", `model response must have schema_version ${MODEL_SCHEMA_VERSION}`, {exitCode: 12});
    }
    if (!Array.isArray(parsed.pages)) {
        throw new PilotError("invalid_model_response", "model response must contain a pages[] array", {exitCode: 12});
    }
    const expectedIds = promptMeta.pages.map((entry) => entry.page_id);
    const contextByPage = new Map(promptMeta.pages.map((entry) => [entry.page_id, {
        status: entry.status,
        evidence: entry.evidence,
        sources: Array.isArray(entry.sources) && entry.sources.length > 0
            ? entry.sources
            : [{source_id: ROOT_SOURCE_ID, text: entry.evidence}],
        direct_links: Array.isArray(entry.direct_links) ? entry.direct_links : []
    }]));
    if (parsed.pages.length !== expectedIds.length) {
        throw new PilotError("invalid_model_response", `model response must contain exactly ${expectedIds.length} pages, got ${parsed.pages.length}`, {exitCode: 12});
    }
    const seen = new Set();
    for (const page of parsed.pages) {
        if (!isPlainObject(page)) {
            throw new PilotError("invalid_model_response", "every page entry must be a JSON object", {exitCode: 12});
        }
        const pageId = page.page_id;
        if (typeof pageId !== "string" || !expectedIds.includes(pageId)) {
            throw new PilotError("invalid_model_response", `model response contains unknown page_id ${JSON.stringify(pageId)}`, {exitCode: 12});
        }
        if (seen.has(pageId)) {
            throw new PilotError("invalid_model_response", `model response contains duplicate page_id ${pageId}`, {exitCode: 12});
        }
        seen.add(pageId);
        if (!LABELS.includes(page.label)) {
            throw new PilotError("invalid_model_response", `page ${pageId} has invalid label ${JSON.stringify(page.label)}`, {exitCode: 12});
        }
        if (!ELIGIBILITY_VALUES.includes(page.refinancing_eligibility)) {
            throw new PilotError("invalid_model_response", `page ${pageId} has invalid refinancing_eligibility ${JSON.stringify(page.refinancing_eligibility)}`, {exitCode: 12});
        }
        if (!ELIGIBILITY_VALUES.includes(page.periodic_fixed_rate)) {
            throw new PilotError("invalid_model_response", `page ${pageId} has invalid periodic_fixed_rate ${JSON.stringify(page.periodic_fixed_rate)}`, {exitCode: 12});
        }
        if (!CONFIDENCE_VALUES.includes(page.confidence)) {
            throw new PilotError("invalid_model_response", `page ${pageId} has invalid confidence ${JSON.stringify(page.confidence)}`, {exitCode: 12});
        }
        if (typeof page.rationale !== "string" || page.rationale.trim() === "") {
            throw new PilotError("invalid_model_response", `page ${pageId} requires a non-empty rationale string`, {exitCode: 12});
        }
        if (!Array.isArray(page.evidence) || page.evidence.length > MAX_QUOTES_PER_PAGE) {
            throw new PilotError("invalid_model_response", `page ${pageId} evidence must be an array of 0-${MAX_QUOTES_PER_PAGE} items`, {exitCode: 12});
        }
        const context = contextByPage.get(pageId);
        if ((context.status !== "ok" || context.evidence === "") && page.label !== "unresolved") {
            throw new PilotError("invalid_model_response", `page ${pageId} without successful non-empty fetch evidence must be unresolved`, {exitCode: 12});
        }
        const sourceById = new Map(context.sources.map((source) => [source.source_id, source.text]));
        for (const item of page.evidence) {
            if (!isPlainObject(item) || !CLAIM_VALUES.includes(item.claim)) {
                throw new PilotError("invalid_model_response", `page ${pageId} has an evidence item with invalid claim`, {exitCode: 12});
            }
            if (typeof item.quote !== "string" || item.quote === "") {
                throw new PilotError("invalid_model_response", `page ${pageId} has an evidence item without a quote`, {exitCode: 12});
            }
            if (typeof item.source_id !== "string" || !sourceById.has(item.source_id)) {
                throw new PilotError("invalid_model_response", `page ${pageId} evidence source_id ${JSON.stringify(item.source_id)} is not among the permitted sources`, {exitCode: 12});
            }
            const groundedQuote = resolveGroundedQuote(sourceById.get(item.source_id), item.quote);
            if (groundedQuote === null) {
                throw new PilotError("invalid_model_response", `page ${pageId} quote is not an exact substring of one permitted source`, {exitCode: 12});
            }
        }
        if (page.label === "needs_more_evidence") {
            if (page.evidence.length !== 0) {
                throw new PilotError("invalid_model_response", `needs_more_evidence page ${pageId} must have an empty evidence array`, {exitCode: 12});
            }
            if (!Array.isArray(page.missing_claims) || page.missing_claims.length === 0) {
                throw new PilotError("invalid_model_response", `needs_more_evidence page ${pageId} requires non-empty missing_claims`, {exitCode: 12});
            }
            for (const claim of page.missing_claims) {
                if (!MISSING_CLAIM_VALUES.includes(claim)) {
                    throw new PilotError("invalid_model_response", `page ${pageId} has invalid missing_claim ${JSON.stringify(claim)}`, {exitCode: 12});
                }
            }
            if (new Set(page.missing_claims).size !== page.missing_claims.length) {
                throw new PilotError("invalid_model_response", `page ${pageId} has duplicate missing_claims`, {exitCode: 12});
            }
            if (!Array.isArray(page.requested_link_ids) || page.requested_link_ids.length < 1 || page.requested_link_ids.length > MAX_REQUESTED_LINKS) {
                throw new PilotError("invalid_model_response", `needs_more_evidence page ${pageId} must request between 1 and ${MAX_REQUESTED_LINKS} links`, {exitCode: 12});
            }
            const linkIds = new Set(context.direct_links.map((link) => link.link_id));
            for (const linkId of page.requested_link_ids) {
                if (typeof linkId !== "string" || linkId === "") {
                    throw new PilotError("invalid_model_response", `page ${pageId} requested link id must be a non-empty string`, {exitCode: 12});
                }
                if (!linkIds.has(linkId)) {
                    throw new PilotError("invalid_model_response", `page ${pageId} requests link id ${linkId} which does not exist on this page`, {exitCode: 12});
                }
            }
            if (new Set(page.requested_link_ids).size !== page.requested_link_ids.length) {
                throw new PilotError("invalid_model_response", `page ${pageId} has duplicate requested link ids`, {exitCode: 12});
            }
        } else {
            if (!Array.isArray(page.missing_claims) || page.missing_claims.length !== 0) {
                throw new PilotError("invalid_model_response", `only needs_more_evidence pages may list missing_claims`, {exitCode: 12});
            }
            if (!Array.isArray(page.requested_link_ids) || page.requested_link_ids.length !== 0) {
                throw new PilotError("invalid_model_response", `only needs_more_evidence pages may request links`, {exitCode: 12});
            }
        }
        if (page.label === "exact_offer") {
            const hasRefinancingQuote = page.evidence.some((item) => item.claim === "refinancing");
            const hasFixedRateQuote = page.evidence.some((item) => item.claim === "fixed_rate");
            if (!hasRefinancingQuote || !hasFixedRateQuote) {
                throw new PilotError("invalid_model_response", `exact_offer page ${pageId} requires at least one refinancing quote and one fixed_rate quote`, {exitCode: 12});
            }
            if (page.refinancing_eligibility !== "yes" || page.periodic_fixed_rate !== "yes") {
                throw new PilotError("invalid_model_response", `exact_offer page ${pageId} requires refinancing_eligibility and periodic_fixed_rate both yes`, {exitCode: 12});
            }
        } else if (page.evidence.length !== 0) {
            throw new PilotError("invalid_model_response", `non-exact page ${pageId} must have an empty evidence array`, {exitCode: 12});
        }
    }
    for (const pageId of expectedIds) {
        if (!seen.has(pageId)) {
            throw new PilotError("invalid_model_response", `model response is missing page ${pageId}`, {exitCode: 12});
        }
    }
    return parsed.pages;
}

/**
 * Deterministic bank rollup from classified pages: exact_offer if any page is
 * exact_offer, else related_page if any related_page, else not_found when the
 * upstream Search preflight found no dedicated candidate, else unresolved if
 * any unresolved page exists, else noise.
 */
export function rollupBanks(reportPages, sourceBanks = []) {
    const bankOrder = [];
    const pagesByBank = new Map();
    const identityByBank = new Map();
    const preflightByBank = new Map();
    for (const sourceRecord of sourceBanks) {
        const bank = sourceRecord?.bank ?? sourceRecord ?? {};
        const key = bank.institution_id ?? bank.legal_name ?? "unknown";
        if (pagesByBank.has(key)) continue;
        pagesByBank.set(key, []);
        identityByBank.set(key, {
            institution_id: bank.institution_id ?? null,
            legal_name: bank.legal_name ?? bank.institution_id ?? null
        });
        preflightByBank.set(key, sourceRecord?.preflight ?? null);
        bankOrder.push(key);
    }
    for (const page of reportPages) {
        const bank = page.bank ?? {};
        const key = bank.institution_id ?? bank.legal_name ?? "unknown";
        if (!pagesByBank.has(key)) {
            pagesByBank.set(key, []);
            identityByBank.set(key, {
                institution_id: bank.institution_id ?? null,
                legal_name: bank.legal_name ?? null
            });
            preflightByBank.set(key, null);
            bankOrder.push(key);
        }
        pagesByBank.get(key).push(page);
    }
    return bankOrder.map((key) => {
        const group = pagesByBank.get(key);
        const preflight = preflightByBank.get(key);
        const label = group.length === 0
            ? (preflight?.outcome === "not_found" ? "not_found" : "unresolved")
            : group.some((page) => page.label === "exact_offer")
            ? "exact_offer"
            : group.some((page) => page.label === "related_page")
                ? "related_page"
                : preflight?.outcome === "not_found"
                    ? "not_found"
                : group.some((page) => page.label === "unresolved")
                    ? "unresolved"
                    : "noise";
        return {
            bank: {
                institution_id: identityByBank.get(key)?.institution_id ?? group[0]?.bank?.institution_id ?? null,
                legal_name: identityByBank.get(key)?.legal_name ?? group[0]?.bank?.legal_name ?? null
            },
            label,
            pages: group.map((page) => ({
                page_id: page.page_id,
                url: page.url,
                label: page.label
            }))
        };
    });
}

function buildSourcePreflightSummary(sourceBanks) {
    const skipped = [];
    for (const sourceRecord of sourceBanks) {
        const bank = sourceRecord?.bank ?? {};
        for (const item of sourceRecord?.preflight?.skipped ?? []) {
            skipped.push({
                bank: {
                    institution_id: bank.institution_id ?? null,
                    legal_name: bank.legal_name ?? null
                },
                ...item
            });
        }
    }
    return {
        enabled: sourceBanks.some((record) => record?.preflight?.enabled === true),
        skipped_candidate_count: skipped.length,
        not_found_bank_count: sourceBanks.filter((record) => record?.preflight?.outcome === "not_found").length,
        skipped
    };
}

function countBankOutcomes(banks) {
    const counts = {};
    for (const bank of banks) {
        counts[bank.label] = (counts[bank.label] ?? 0) + 1;
    }
    return counts;
}

/**
 * Build the final report. `promptMeta` carries the global ordered page
 * entries, `batches` the ordered batch prompts, `batchMeta` the aggregate
 * prompt metadata and `batchResults` the per-batch validated model pages plus
 * invocation metadata. Merged pages are re-ordered into the original global
 * page order and every global page id is asserted exactly once (live runs).
 * `followup` carries the at-most-one follow-up round: the per-request
 * selected/fetched links and outcomes plus the round-two prompt/invocation
 * metadata; every page that went through follow-up reports `round: 2` with
 * its source provenance and requested link ids, while all other pages keep
 * their first-round decision. Dry-run reports keep zero classifications and
 * expose an inspection manifest with every batch prompt plus the per-page
 * direct links and source mapping.
 */
export function buildReport({source, promptMeta, batches, batchMeta, batchResults, dryRun, model = MODEL, variant = VARIANT, followup = null, skipped = []}) {
    const counts = {exact_offer: 0, related_page: 0, noise: 0, unresolved: 0};
    const reportPages = [];
    const sourcePreflight = buildSourcePreflightSummary(source.report.banks);
    if (!dryRun) {
        const merged = new Map();
        for (const batchResult of batchResults) {
            for (const page of batchResult.pages) {
                merged.set(page.page_id, page);
            }
        }
        if (merged.size !== promptMeta.page_count) {
            throw new PilotError("invalid_model_response", `merged classification set must contain exactly ${promptMeta.page_count} pages, got ${merged.size}`, {exitCode: 12});
        }
        for (const entry of promptMeta.pages) {
            const followupDecision = followup?.decisions?.get(entry.page_id);
            const page = followupDecision?.page ?? merged.get(entry.page_id);
            if (page === undefined) {
                throw new PilotError("invalid_model_response", `merged classification set is missing page ${entry.page_id}`, {exitCode: 12});
            }
            reportPages.push({
                page_id: entry.page_id,
                bank: entry.bank,
                url: entry.url,
                label: page.label,
                refinancing_eligibility: page.refinancing_eligibility,
                periodic_fixed_rate: page.periodic_fixed_rate,
                confidence: page.confidence,
                evidence: page.evidence,
                rationale: page.rationale,
                round: followupDecision === undefined ? 1 : 2,
                sources: followupDecision === undefined
                    ? [{source_id: ROOT_SOURCE_ID, url: entry.url, relationship: "root", link_id: null}]
                    : followupDecision.sources,
                requested_link_ids: followupDecision === undefined ? [] : followupDecision.requested_link_ids
            });
            counts[page.label] += 1;
        }
        for (const skippedItem of skipped) {
            const entry = skippedItem.entry;
            reportPages.push({
                page_id: entry.page_id,
                bank: entry.bank,
                url: entry.url,
                label: skippedItem.label,
                refinancing_eligibility: "unknown",
                periodic_fixed_rate: "unknown",
                confidence: null,
                evidence: [],
                rationale: skippedItem.reason,
                round: 0,
                sources: [{source_id: ROOT_SOURCE_ID, url: entry.url, relationship: "root", link_id: null}],
                requested_link_ids: [],
                skipped: true,
                skip_reason: skippedItem.reason
            });
            counts[skippedItem.label] += 1;
        }
    }
    const banks = dryRun ? [] : rollupBanks(reportPages, source.report.banks);
    const sourcePageCount = promptMeta.page_count + skipped.length;
    const report = {
        schema_version: REPORT_SCHEMA_VERSION,
        generated_at: new Date().toISOString(),
        dry_run: dryRun,
        source_pack: {
            path: source.path,
            sha256: source.sha256,
            schema_version: source.report.schema_version,
            bank_count: source.report.banks.length,
            page_count: sourcePageCount,
            candidate_count: sourcePageCount + sourcePreflight.skipped_candidate_count,
            preflight_excluded_count: sourcePreflight.skipped_candidate_count
        },
        model: {model, variant},
        prompt: {
            total_chars: batchMeta.total_chars,
            aggregate_sha256: batchMeta.aggregate_sha256,
            page_count: promptMeta.page_count,
            batch_count: batches.length,
            batch_pages: batchMeta.batch_pages,
            batch_concurrency: batchMeta.batch_concurrency,
            session_reuse: batchMeta.session_reuse ?? false,
            run_dir: batchMeta.run_dir ?? null
        },
        invocations: dryRun
            ? []
            : batchResults.map((result) => ({
                round: 1,
                batch_index: result.batch_index,
                prompt_sha256: result.prompt_sha256,
                prompt_chars: result.prompt_chars,
                page_count: result.page_count,
                session_id: result.invocation.session_id,
                tokens: result.invocation.tokens,
                cost: result.invocation.cost,
                elapsed_ms: result.invocation.elapsed_ms,
                attempt_count: result.invocation.attempt_count,
                attempts: result.invocation.attempts
            })),
        followup: followup === null
            ? null
            : {
                round: 2,
                requested: followup.requests.map((request) => ({
                    page_id: request.page_id,
                    requested_link_ids: request.requested_link_ids,
                    selected: request.selected,
                    fetched: request.fetched,
                    extractor_error: request.extractor_error,
                    outcome: request.outcome
                })),
                prompt: followup.batchMeta === null
                    ? null
                    : {
                        total_chars: followup.batchMeta.total_chars,
                        aggregate_sha256: followup.batchMeta.aggregate_sha256,
                        page_count: followup.promptMeta.page_count,
                        batch_count: followup.batches.length,
                        batch_pages: followup.batchMeta.batch_pages,
                        batch_concurrency: followup.batchMeta.batch_concurrency
                    },
                invocations: followup.batchResults === null
                    ? []
                    : followup.batchResults.map((result) => ({
                        round: 2,
                        batch_index: result.batch_index,
                        prompt_sha256: result.prompt_sha256,
                        prompt_chars: result.prompt_chars,
                        page_count: result.page_count,
                        session_id: result.invocation.session_id,
                        tokens: result.invocation.tokens,
                        cost: result.invocation.cost,
                        elapsed_ms: result.invocation.elapsed_ms,
                        attempt_count: result.invocation.attempt_count,
                        attempts: result.invocation.attempts
                    }))
            },
        preflight: sourcePreflight,
        summary: {page_count: reportPages.length, ...counts, bank_outcome_counts: countBankOutcomes(banks)},
        prefilter: dryRun
            ? {enabled: true, skipped_page_count: skipped.length, skipped: skipped.map((item) => ({page_id: item.entry.page_id, url: item.entry.url, label: item.label, reason: item.reason}))}
            : {enabled: true, skipped_page_count: skipped.length, skipped: skipped.map((item) => ({page_id: item.entry.page_id, url: item.entry.url, label: item.label, reason: item.reason}))},
        banks,
        pages: reportPages
    };
    if (dryRun) {
        report.dry_run_manifest = {
            prompt: batches[0]?.prompt ?? "",
            pages: promptMeta.pages.map((entry) => ({
                page_id: entry.page_id,
                bank: entry.bank,
                url: entry.url,
                title: entry.title,
                status: entry.status,
                http_status: entry.http_status,
                error: entry.error,
                full_content: entry.full_content,
                evidence: entry.evidence,
                direct_links: entry.direct_links ?? [],
                sources: (entry.sources ?? [{source_id: ROOT_SOURCE_ID, url: entry.url, relationship: "root"}]).map((source) => ({
                    source_id: source.source_id,
                    url: source.url,
                    relationship: source.relationship,
                    link_id: source.link_id ?? null
                }))
            })),
            batches: batches.map((batch) => ({
                batch_index: batch.batch_index,
                page_count: batch.page_count,
                page_ids: batch.page_ids,
                prompt_sha256: batch.prompt_sha256,
                prompt_chars: batch.prompt_chars,
                prompt: batch.prompt
            }))
        };
    }
    return report;
}

/**
 * Default runner: spawn `opencode` with an argv array (no shell), bounded
 * stdout (overflow kills the child), bounded stderr diagnostics, timeout and
 * nonzero-exit handling. Resolves `{stdout, stderr}` or rejects a PilotError.
 */
export function defaultRunner(argv, {timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_STREAM_BYTES} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn("opencode", argv, {stdio: ["ignore", "pipe", "pipe"]});
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutOverflow = false;
        let settled = false;
        let killTimer = null;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGTERM");
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref?.();
            killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
            reject(new PilotError("model_timeout", `opencode run exceeded the ${timeoutMs} ms timeout`, {exitCode: 20}));
        }, Math.max(1, timeoutMs));
        child.stdout.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxBytes) {
                stdoutOverflow = true;
                child.kill("SIGKILL");
                return;
            }
            if (!stdoutOverflow) {
                stdoutChunks.push(chunk);
            }
        });
        child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= MAX_STDERR_DIAGNOSTIC_BYTES) {
                stderrChunks.push(chunk);
            }
        });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new PilotError("model_spawn_failed", `cannot spawn opencode: ${error?.message ?? String(error)}`, {exitCode: 20}));
        });
        child.on("close", (code, signal) => {
            if (killTimer !== null) clearTimeout(killTimer);
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (stdoutOverflow) {
                reject(new PilotError("model_output_overflow", `opencode stdout exceeded the ${maxBytes} byte limit`, {exitCode: 20}));
                return;
            }
            if (code !== 0) {
                reject(new PilotError("model_invocation_failed", `opencode run exited with code ${code}`, {
                    exitCode: 20,
                    details: {
                        exit_code: code,
                        signal,
                        stderr_diagnostic: Buffer.concat(stderrChunks).toString("utf8").slice(-2000)
                    }
                }));
                return;
            }
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                stderr: Buffer.concat(stderrChunks).toString("utf8")
            });
        });
    });
}

/**
 * Wrap any per-batch failure into a controlled error carrying `batch_index`
 * (and the original details) but never any raw prompt text.
 */
function wrapBatchError(error, batchIndex) {
    return new PilotError(
        error?.code ?? "batch_failed",
        error?.message ?? String(error),
        {
            exitCode: error?.exitCode ?? 20,
            details: {batch_index: batchIndex, ...(error?.details ?? {})},
            cause: error
        }
    );
}

function aggregateAttemptTokens(attempts) {
    const totals = {total: 0, input: 0, output: 0, reasoning: 0, cache: {write: 0, read: 0}};
    for (const attempt of attempts) {
        const tokens = attempt.tokens;
        if (!isPlainObject(tokens)) continue;
        totals.total += Number(tokens.total) || 0;
        totals.input += Number(tokens.input) || 0;
        totals.output += Number(tokens.output) || 0;
        totals.reasoning += Number(tokens.reasoning) || 0;
        totals.cache.write += Number(tokens.cache?.write) || 0;
        totals.cache.read += Number(tokens.cache?.read) || 0;
    }
    return totals;
}

/**
 * Invoke one batch: exact Luna Max argv with the batch prompt as the final
 * argument, parse the JSONL stream and validate the response against this
 * batch's exact page ids and source evidence. Any failure is wrapped with the
 * batch index.
 */
async function runOneBatch(batch, {runner, timeoutMs, variant, model = MODEL, sessionId = null, runDir = null}) {
    const argv = ["run", "--model", model, "--variant", variant, "--format", "json"];
    if (runDir !== null) {
        argv.push("--dir", runDir);
    }
    if (sessionId !== null) {
        argv.push("-s", sessionId);
    }
    argv.push(batch.prompt);
    const batchStartedAt = Date.now();
    const attempts = [];
    for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt += 1) {
        const attemptStartedAt = Date.now();
        let result;
        try {
            result = await runner(argv, {timeoutMs, maxBytes: MAX_STREAM_BYTES});
        } catch (error) {
            throw wrapBatchError(error, batch.batch_index);
        }
        let metadata;
        try {
            const parsed = parseModelJsonl(result.stdout);
            metadata = parsed.metadata;
            const pages = validateModelResponse(parsed.payload, {pages: batch.pages});
            attempts.push({
                attempt,
                status: "ok",
                session_id: metadata.session_id,
                tokens: metadata.tokens,
                cost: metadata.cost,
                elapsed_ms: Date.now() - attemptStartedAt
            });
            return {
                batch_index: batch.batch_index,
                prompt_sha256: batch.prompt_sha256,
                prompt_chars: batch.prompt_chars,
                page_count: batch.page_count,
                pages,
                invocation: {
                    session_id: metadata.session_id,
                    tokens: aggregateAttemptTokens(attempts),
                    cost: attempts.reduce((sum, item) => sum + (item.cost ?? 0), 0),
                    elapsed_ms: Date.now() - batchStartedAt,
                    attempt_count: attempts.length,
                    attempts
                }
            };
        } catch (error) {
            attempts.push({
                attempt,
                status: "invalid_model_contract",
                session_id: metadata?.session_id ?? null,
                tokens: metadata?.tokens ?? null,
                cost: metadata?.cost ?? 0,
                elapsed_ms: Date.now() - attemptStartedAt,
                error_code: error?.code ?? "invalid_model_response",
                error_message: error?.message ?? String(error)
            });
            const retryable = error?.code === "invalid_model_response"
                || error?.code === "invalid_model_stream"
                || error?.code === "invalid_model_json";
            if (!retryable || attempt === MAX_BATCH_ATTEMPTS) {
                throw wrapBatchError(error, batch.batch_index);
            }
        }
    }
    throw new PilotError("batch_failed", `batch ${batch.batch_index} exhausted model attempts`, {exitCode: 20});
}

/**
 * Maximum batches per reused session. Bounds context accumulation: the 3rd
 * batch in a session timed out at 180s on real packs (~120k chars of
 * history), while the 2nd completes fine. Two batches per session halves
 * session-startup cost without hitting the accumulation wall.
 */
export const SESSION_REUSE_MAX_BATCHES = 2;

/**
 * Execute all batches with bounded concurrency (`batchConcurrency` workers),
 * each batch respecting the per-batch timeout. Results are stored by batch
 * index; a failure in any batch rejects the whole run.
 *
 * With `sessionReuse` enabled, batches are partitioned into `batchConcurrency`
 * shards; each shard reuses opencode sessions with at most
 * `SESSION_REUSE_MAX_BATCHES` batches per session (first batch spawns it,
 * the next resumes it via `-s`), amortizing session-startup cost while
 * keeping context bounded. A failed resumed batch falls back to a fresh
 * session and the shard continues there, so one bad follow-up never poisons
 * the remaining batches.
 */
async function runBatches(batches, {runner, timeoutMs, batchConcurrency, variant, model = MODEL, sessionReuse = false, runDir = null}) {
    if (!sessionReuse) {
        const results = new Array(batches.length);
        let next = 0;
        async function worker() {
            while (next < batches.length) {
                const index = next;
                next += 1;
                results[index] = await runOneBatch(batches[index], {runner, timeoutMs, variant, model, runDir});
            }
        }
        await Promise.all(Array.from({length: Math.min(batchConcurrency, batches.length)}, worker));
        return results;
    }
    const shardCount = Math.min(batchConcurrency, batches.length);
    const shards = Array.from({length: shardCount}, (_, shard) =>
        batches.filter((_, index) => index % shardCount === shard));
    const results = new Array(batches.length);
    await Promise.all(shards.map(async (shardBatches) => {
        let sessionId = null;
        let inSessionCount = 0;
        for (const batch of shardBatches) {
            if (inSessionCount >= SESSION_REUSE_MAX_BATCHES) {
                sessionId = null;
                inSessionCount = 0;
            }
            try {
                const result = await runOneBatch(batch, {runner, timeoutMs, variant, model, sessionId, runDir});
                sessionId = result.invocation.session_id ?? sessionId;
                inSessionCount += 1;
                results[batch.batch_index] = result;
            } catch (error) {
                if (sessionId === null) {
                    throw error;
                }
                const result = await runOneBatch(batch, {runner, timeoutMs, variant, model, sessionId: null, runDir});
                sessionId = result.invocation.session_id ?? null;
                inSessionCount = 1;
                results[batch.batch_index] = result;
            }
        }
    }));
    return results;
}

/**
 * Default follow-up extractor: lazily delegates to the sibling
 * parallel-extract-pilot `runSelectedLinkExtract`, adapting the classifier's
 * single `sourcePage` to the extractor's `sourcePages` array. The CLI wires
 * the same extractor explicitly so the key is only needed when Luna actually
 * requests follow-up.
 */
async function defaultFollowupExtractor({bank, sourcePage, selected, apiKey, dryRun, timeoutMs}) {
    const {runSelectedLinkExtract} = await import("./parallel-extract-pilot.mjs");
    return runSelectedLinkExtract({bank, sourcePages: [sourcePage], selected, apiKey, dryRun, timeoutMs});
}

/**
 * Execute the at-most-one follow-up round for the pages whose first-round
 * decision was `needs_more_evidence`. Every requesting page is handed to the
 * injectable `followupExtractor` once (bank, the exact source page and the
 * selected link objects in requested order); a successful request with every
 * selected document fetched ok is turned into one offer entry (root
 * `source-1` plus fetched `source-2..N`) and classified by the same bounded
 * model batches with follow-up disabled. A request that cannot be fetched,
 * an extractor error or a second-round link request deterministically
 * finalizes that item as unresolved — never a third round and never anchor
 * text as proof.
 */
async function runFollowupRound({entries, round1ByPage, requestedEntries, timeoutMs, runner, batchPages, batchConcurrency, variant, model = MODEL, followupExtractor, apiKey, sessionReuse = false, runDir = null}) {
    const requests = [];
    const decisions = new Map();
    const offerEntries = [];
    for (const entry of requestedEntries) {
        const round1Page = round1ByPage.get(entry.page_id);
        const availableLinks = new Map(entry.direct_links.map((link) => [link.link_id, link]));
        const selected = round1Page.requested_link_ids
            .map((linkId) => availableLinks.get(linkId))
            .filter((link) => link !== undefined)
            .map((link) => ({link_id: link.link_id, url: link.url, source_url: entry.url}));
        const request = {
            page_id: entry.page_id,
            requested_link_ids: [...round1Page.requested_link_ids],
            selected,
            fetched: [],
            extractor_error: null,
            outcome: null
        };
        let extractResult = null;
        try {
            extractResult = await followupExtractor({
                bank: entry.bank_record?.bank ?? {},
                sourcePage: entry.page_record ?? null,
                selected,
                apiKey,
                dryRun: false,
                timeoutMs
            });
        } catch (error) {
            if (error?.code === "missing_api_key") throw error;
            request.extractor_error = {
                code: error?.code ?? "followup_extraction_failed",
                message: error?.message ?? String(error)
            };
        }
        const fetchedPages = Array.isArray(extractResult?.pages) ? extractResult.pages : [];
        request.fetched = fetchedPages.map((page) => ({
            link_id: page?.link_id ?? null,
            url: typeof page?.url === "string" ? page.url : null,
            source_url: typeof page?.source_url === "string" ? page.source_url : null,
            status: page?.status ?? "unknown",
            error: page?.status === "ok" ? null : {
                code: page?.error?.code ?? "followup_fetch_failed",
                message: page?.error?.message ?? null
            }
        }));
        const okFetched = fetchedPages.filter((page) => page?.status === "ok"
            && typeof page?.content?.full_content?.text === "string"
            && page.content.full_content.text.trim() !== "");
        const fetchedLinkIds = okFetched.map((page) => page?.link_id);
        const fetchedSelectionMatches = fetchedLinkIds.length === request.requested_link_ids.length
            && fetchedLinkIds.every((linkId, index) => linkId === request.requested_link_ids[index]);
        if (request.extractor_error !== null || !fetchedSelectionMatches) {
            request.outcome = "fetch_failed";
            decisions.set(entry.page_id, {
                page: {
                    page_id: entry.page_id,
                    label: "unresolved",
                    refinancing_eligibility: "unknown",
                    periodic_fixed_rate: "unknown",
                    confidence: "low",
                    evidence: [],
                    rationale: "Requested direct document could not be fetched; the item is finalized unresolved."
                },
                sources: [{source_id: ROOT_SOURCE_ID, url: entry.url, relationship: "root", link_id: null}],
                requested_link_ids: request.requested_link_ids
            });
            requests.push(request);
            continue;
        }
        offerEntries.push(buildOfferEntry({entry, fetchedPages: okFetched}));
        requests.push(request);
    }

    const followup = {requests, decisions, promptMeta: null, batches: [], batchMeta: null, batchResults: null};
    if (offerEntries.length === 0) {
        return followup;
    }
    const followupPromptMeta = {page_count: offerEntries.length, pages: offerEntries};
    const followupBatches = buildBatches(offerEntries, {batchPages});
    const followupBatchMeta = {
        total_chars: followupBatches.reduce((sum, batch) => sum + batch.prompt_chars, 0),
        aggregate_sha256: aggregatePromptSha256(followupBatches),
        batch_pages: batchPages,
        batch_concurrency: batchConcurrency,
        session_reuse: sessionReuse,
        run_dir: runDir
    };
    const followupBatchResults = await runBatches(followupBatches, {runner, timeoutMs, batchConcurrency, variant, model, sessionReuse, runDir});
    const requestsByPage = new Map(requests.map((request) => [request.page_id, request]));
    for (const batchResult of followupBatchResults) {
        for (const page of batchResult.pages) {
            const request = requestsByPage.get(page.page_id);
            if (page.label === "needs_more_evidence") {
                if (request !== undefined) request.outcome = "second_request";
                page.label = "unresolved";
                page.evidence = [];
                page.rationale = "A second-round link request cannot be honored; the item is finalized unresolved.";
            } else if (request !== undefined) {
                request.outcome = "classified";
            }
            const offerEntry = offerEntries.find((entry) => entry.page_id === page.page_id);
            decisions.set(page.page_id, {
                page,
                sources: offerEntry.sources.map((source) => ({
                    source_id: source.source_id,
                    url: source.url,
                    relationship: source.relationship,
                    link_id: source.link_id ?? null
                })),
                requested_link_ids: request?.requested_link_ids ?? []
            });
        }
    }
    followup.promptMeta = followupPromptMeta;
    followup.batches = followupBatches;
    followup.batchMeta = followupBatchMeta;
    followup.batchResults = followupBatchResults;
    return followup;
}

/**
 * Run the bounded review classifier over deterministic page batches.
 * `sourceReport` may be passed as an already parsed pack object (tests) or
 * loaded from `inputPath`. `runner` is injectable for tests; the default
 * runner spawns `opencode` with the exact Luna Max argv and the batch prompt
 * as the final argument. The timeout applies per batch, not globally.
 * `followupExtractor` is injectable (the default lazily delegates to
 * `runSelectedLinkExtract`); `apiKey` is only passed on to it when Luna
 * actually requests a follow-up. Dry-run never invokes the child or the
 * extractor and returns an inspection manifest instead of classifications.
 */
export async function runClassifier(options) {
    const {
        inputPath = null,
        sourceReport = undefined,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        dryRun = false,
        runner = defaultRunner,
        batchPages = DEFAULT_BATCH_PAGES,
        batchConcurrency = DEFAULT_BATCH_CONCURRENCY,
        variant = VARIANT,
        model = MODEL,
        followupExtractor = defaultFollowupExtractor,
        apiKey = undefined,
        prefilter = true,
        sessionReuse = false,
        runDir = null
    } = options ?? {};
    assertBatchPages(batchPages);
    assertBatchConcurrency(batchConcurrency);
    assertVariant(variant);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new PilotError("invalid_configuration", "timeout_ms must be a positive integer", {exitCode: 2});
    }
    if (typeof followupExtractor !== "function") {
        throw new PilotError("invalid_configuration", "followupExtractor must be a function", {exitCode: 2});
    }
    const source = loadSource(inputPath, sourceReport);
    if (runDir !== null) {
        fs.mkdirSync(runDir, {recursive: true});
    }
    const entries = buildPromptEntries(source.report);
    const {modelEntries, skippedEntries} = prefilter ? prefilterPages(entries) : {modelEntries: entries, skippedEntries: []};
    const promptMeta = {page_count: modelEntries.length, pages: modelEntries};
    const batches = buildBatches(modelEntries, {batchPages});
    const batchMeta = {
        total_chars: batches.reduce((sum, batch) => sum + batch.prompt_chars, 0),
        aggregate_sha256: aggregatePromptSha256(batches),
        batch_pages: batchPages,
        batch_concurrency: batchConcurrency,
        session_reuse: sessionReuse,
        run_dir: runDir
    };
    if (dryRun) {
        return buildReport({source, promptMeta, batches, batchMeta, batchResults: [], dryRun: true, variant, model, skipped: skippedEntries});
    }
    const batchResults = await runBatches(batches, {runner, timeoutMs, batchConcurrency, variant, model, sessionReuse, runDir});
    const round1ByPage = new Map();
    for (const batchResult of batchResults) {
        for (const page of batchResult.pages) {
            round1ByPage.set(page.page_id, page);
        }
    }
    const requestedEntries = modelEntries.filter((entry) => round1ByPage.get(entry.page_id)?.label === "needs_more_evidence");
    let followup = null;
    if (requestedEntries.length > 0) {
        followup = await runFollowupRound({
            entries: modelEntries,
            round1ByPage,
            requestedEntries,
            timeoutMs,
            runner,
            batchPages,
            batchConcurrency,
            variant,
            model,
            followupExtractor,
            apiKey,
            sessionReuse,
            runDir
        });
    }
    return buildReport({source, promptMeta, batches, batchMeta, batchResults, dryRun: false, variant, model, followup, skipped: skippedEntries});
}
