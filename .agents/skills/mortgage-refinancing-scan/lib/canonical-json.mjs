import {createHash} from "node:crypto";

/**
 * Deterministic canonical JSON serialization used for contract hashes.
 *
 * The output follows the JCS (RFC 8785) rules that are relevant for the ordered
 * JSON objects used by this skill: object members are sorted by their UTF-16
 * code unit order, no insignificant whitespace is emitted, array order is
 * preserved and JSON string/number escaping follows the ECMAScript
 * `JSON.stringify` production. Values that JCS cannot represent (undefined,
 * non-finite numbers, functions, symbols, bigints) are rejected instead of
 * being silently dropped.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
    return serialize(value, "");
}

/**
 * Lowercase SHA-256 over UTF-8 bytes.
 *
 * @param {string|Uint8Array} input
 * @returns {string}
 */
export function sha256Hex(input) {
    const hash = createHash("sha256");
    hash.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
    return hash.digest("hex");
}

/**
 * Lowercase SHA-256 over the canonical JSON serialization of a value.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalSha256(value) {
    return sha256Hex(canonicalJson(value));
}

/**
 * Canonical hash of the ordered scope entries of a run manifest.
 *
 * @param {Array<object>} entries
 * @returns {string}
 */
export function scopeSha256(entries) {
    if (!Array.isArray(entries)) {
        throw new TypeError("scope entries must be an array");
    }
    return canonicalSha256(entries);
}

/**
 * Deterministic evidence identifier defined by the data contract:
 * `ev-<sha256(JCS([institution_id, product_id, field_path, url, content_sha256, normalized_excerpt]))[0:24]>`.
 *
 * @param {{institution_id: string, product_id: string, field_path: string, url: string, content_sha256: string, normalized_excerpt: string}} parts
 * @returns {string}
 */
export function computeEvidenceId(parts) {
    const keys = [
        "institution_id",
        "product_id",
        "field_path",
        "url",
        "content_sha256",
        "normalized_excerpt"
    ];
    const material = keys.map((key) => {
        const part = parts?.[key];
        if (typeof part !== "string" || part.length === 0) {
            throw new TypeError(`evidence id part "${key}" must be a non-empty string`);
        }
        return part;
    });
    return `ev-${sha256Hex(canonicalJson(material)).slice(0, 24)}`;
}

function serialize(value, pointer) {
    if (value === null) {
        return "null";
    }
    const type = typeof value;
    if (type === "boolean") {
        return value ? "true" : "false";
    }
    if (type === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError(`non-finite number is not canonicalizable at "${pointer || "/"}"`);
        }
        return JSON.stringify(value);
    }
    if (type === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        const items = [];
        for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) {
                throw new TypeError(`sparse array is not canonicalizable at "${pointer || "/"}"`);
            }
            items.push(serialize(value[index], `${pointer}/${index}`));
        }
        return `[${items.join(",")}]`;
    }
    if (type === "object") {
        const entries = Object.keys(value)
            .sort(compareCodeUnits)
            .map((key) => `${JSON.stringify(key)}:${serialize(value[key], `${pointer}/${key}`)}`);
        return `{${entries.join(",")}}`;
    }
    throw new TypeError(`value of type "${type}" is not canonicalizable at "${pointer || "/"}"`);
}

function compareCodeUnits(left, right) {
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}
