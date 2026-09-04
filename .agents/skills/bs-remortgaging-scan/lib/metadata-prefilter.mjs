/**
 * Deterministic metadata-only filtering shared by the Extract preflight and
 * the classifier's post-Extract backstop. The page body is deliberately not
 * inspected here: only the candidate URL and title/description are used.
 */

const DIACRITICS_MAP = Object.freeze({ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z"});

const PREFILTER_NON_PRODUCT_STEMS = Object.freeze([
    // bank boilerplate / corporate
    "o banku", "wladz", "zarzad", "nadzorcz", "komitet", "karier", "histori",
    "komunikat", "aktualnos", "kalendarz", "status", "reklam",
    // contact / legal / help
    "kontakt", "pomoc", "regulamin", "rodo", "prywatnos", "polityk", "cookies",
    "dostepnos", "mapa strony", "szukaj", "wyszukiwark", "test", "start",
    // banking products that are not mortgage offers
    "bankowosc internetowa", "logowani", "login", "kartosfera", "sorbnet",
    "bmr", "rachunek", "konto", "karta", "limit", "lokat", "oszczednos",
    "platnos", "bezpieczenstw", "ubezpiecz", "emeryt", "inwestycj",
    // customer segments / other
    "rolnik", "przedsiebiorc", "firm", "instytucj", "newsletter",
    // application / document forms
    "kwestionariusz", "wniosk", "taryf", "zalacznik"
]);

const PREFILTER_MORTGAGE_ABSOLUTE_STEMS = Object.freeze([
    "hipotec", "mieszkaniow"
]);

const PREFILTER_CREDIT_STEMS = Object.freeze([
    "kredyt", "pozyczk", "finans", "oprocent", "procent", "rata", "wibor",
    "wiron", "rrso", "refinans", "konsumpcyj", "wakacje", "splat",
    "przeniesieni", "fundusz", "wsparcia"
]);

const PREFILTER_NON_MORTGAGE_CREDIT_STEMS = Object.freeze([
    "rewolwing", "odnawialny", "pomost", "konsumenck", "gotowk", "obrotow",
    "wakacyj", "jubileusz", "karta", "ror", "rolnik", "inwestycj",
    "dla firm", "dla-firm", "dlafirm", "firmy i instytucje", "biznes",
    "przedsiebiorc", "przeniesienie rachunku", "blik", "obrotowy",
    // A form or current-account page can contain generic credit vocabulary.
    "kwestionariusz", "rachun"
]);

/**
 * Both phases use the same deterministic metadata rules. The phase argument
 * exists so callers can make the boundary explicit and extend one phase
 * independently later without duplicating the predicate.
 */
const PRE_EXTRACT_NON_PRODUCT_STEMS = Object.freeze([
    ...PREFILTER_NON_PRODUCT_STEMS,
    "blik",
    "rachun",
    "rolnic"
]);

const PRE_EXTRACT_NON_MORTGAGE_CREDIT_STEMS = Object.freeze([
    ...PREFILTER_NON_MORTGAGE_CREDIT_STEMS,
    "rolnic"
]);

const POST_EXTRACT_NON_PRODUCT_STEMS = Object.freeze([
    ...PRE_EXTRACT_NON_PRODUCT_STEMS
]);

const POST_EXTRACT_NON_MORTGAGE_CREDIT_STEMS = Object.freeze([
    ...PRE_EXTRACT_NON_MORTGAGE_CREDIT_STEMS
]);

/** Map Polish diacritics to ASCII and collapse punctuation to spaces. */
export function normalizeAscii(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/[ąćęłńóśźż]/gu, (ch) => DIACRITICS_MAP[ch] ?? ch)
        .replace(/[^a-z0-9]+/gu, " ")
        .trim();
}

/** Return true only for an absolute HTTP(S) URL whose path is exactly `/`. */
export function isCanonicalHomepage(value) {
    if (typeof value !== "string" || value.trim() === "") return false;
    try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && parsed.pathname === "/";
    } catch {
        return false;
    }
}

function candidateUrl(candidate) {
    for (const value of [candidate?.canonical_url, candidate?.url, candidate?.submitted_url]) {
        if (typeof value === "string" && value.trim() !== "") return value;
    }
    return "";
}

function candidateTitle(candidate) {
    if (typeof candidate?.title === "string" && candidate.title.trim() !== "") return candidate.title;
    if (typeof candidate?.description === "string") return candidate.description;
    if (typeof candidate?.title === "string") return candidate.title;
    return "";
}

/**
 * Classify a candidate using only URL/title metadata.
 *
 * @returns {{label: "noise", reason: string}|null}
 */
export function classifyMetadataSkip(candidate = {}, {phase = "post_extract"} = {}) {
    const url = candidateUrl(candidate);
    if (isCanonicalHomepage(url)) {
        return {label: "noise", reason: "homepage_not_product_page"};
    }

    const normalized = normalizeAscii(`${candidateTitle(candidate)} ${url}`);
    if (PREFILTER_MORTGAGE_ABSOLUTE_STEMS.some((stem) => normalized.includes(stem))) {
        return null;
    }

    const nonProductStems = phase === "pre_extract"
        ? PRE_EXTRACT_NON_PRODUCT_STEMS
        : POST_EXTRACT_NON_PRODUCT_STEMS;
    const nonMortgageCreditStems = phase === "pre_extract"
        ? PRE_EXTRACT_NON_MORTGAGE_CREDIT_STEMS
        : POST_EXTRACT_NON_MORTGAGE_CREDIT_STEMS;
    const hasCreditStem = PREFILTER_CREDIT_STEMS.some((stem) => normalized.includes(stem));
    if (hasCreditStem) {
        return nonMortgageCreditStems.some((stem) => normalized.includes(stem))
            ? {label: "noise", reason: "non_mortgage_credit_product"}
            : null;
    }
    return nonProductStems.some((stem) => normalized.includes(stem))
        ? {label: "noise", reason: "non_product_boilerplate"}
        : null;
}
