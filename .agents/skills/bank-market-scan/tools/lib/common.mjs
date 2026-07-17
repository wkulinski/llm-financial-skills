import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECT_ROOT = process.env.BANK_MARKET_SCAN_PROJECT_ROOT
    ? path.resolve(process.env.BANK_MARKET_SCAN_PROJECT_ROOT)
    : path.resolve(SKILL_ROOT, '..', '..', '..');
export const DATA_ROOT = path.resolve(PROJECT_ROOT, 'data');

export function bundledPath(...parts) {
    return path.resolve(SKILL_ROOT, ...parts);
}

export function projectPath(...parts) {
    return path.resolve(PROJECT_ROOT, ...parts);
}

export function dataPath(...parts) {
    return path.resolve(DATA_ROOT, ...parts);
}

export const DEFAULT_BFG_URL = 'https://bfg.pl/gwarantowanie-depozytow/podmioty-objete-gwarancjami/';
export const DEFAULT_KNF_URL = 'https://www.knf.gov.pl/podmioty/Podmioty_sektora_bankowego/banki_spoldzielcze';

export async function ensureDir(dir) {
    await fs.mkdir(dir, {recursive: true});
}

export async function pathExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

export async function readJson(p, fallback = undefined) {
    try {
        return JSON.parse(await fs.readFile(p, 'utf8'));
    } catch (err) {
        if (fallback !== undefined && err.code === 'ENOENT') return fallback;
        throw err;
    }
}

export async function writeJson(p, data) {
    await ensureDir(path.dirname(p));
    await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}

export async function writeJsonAtomic(p, data) {
    await ensureDir(path.dirname(p));
    const tempPath = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tempPath, p);
}

export async function readJsonl(p) {
    try {
        const text = await fs.readFile(p, 'utf8');
        return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

export async function appendJsonl(p, rows) {
    await ensureDir(path.dirname(p));
    const lines = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
    await fs.appendFile(p, lines, 'utf8');
}

export async function writeJsonl(p, rows) {
    await ensureDir(path.dirname(p));
    await fs.writeFile(p, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

export function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

function stripCombiningMarks(s) {
    return String(s || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ł/g, 'l')
        .replace(/Ł/g, 'L');
}

export function normalizeText(s) {
    return stripCombiningMarks(s)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .toLowerCase()
        .trim();
}

export function slug(s, max = 80) {
    const n = normalizeText(s).replace(/\s+/g, '-').replace(/^-|-$/g, '');
    return (n || 'unknown').slice(0, max);
}

export function stableInstitutionId(type, name) {
    const prefix = type === 'skok' || /skok/i.test(type || '') ? 'skok' : 'bank_spoldzielczy';
    return `${prefix}_${slug(name, 90).replace(/-/g, '_')}`;
}

export function sha1(s) {
    return crypto.createHash('sha1').update(String(s)).digest('hex');
}

export function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

export function normalizeUrlIdentity(value) {
    try {
        const url = new URL(value);
        url.hash = '';
        if (url.hostname.toLowerCase().startsWith('www.')) {
            url.hostname = url.hostname.slice(4);
        }
        for (const key of [...url.searchParams.keys()]) {
            const normalized = key.toLowerCase();
            if (normalized.startsWith('utm_') || ['gclid', 'fbclid', 'msclkid'].includes(normalized)) {
                url.searchParams.delete(key);
            }
        }
        url.pathname = url.pathname.replace(/\/index\.html?$/i, '/');
        if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
        return url.toString();
    } catch {
        return String(value || '').trim();
    }
}

export function sourceCacheFile(cacheDir, requestedUrl, extension = '.html') {
    const ext = String(extension).startsWith('.') ? extension : `.${extension}`;
    return path.join(cacheDir, `source-${sha256(normalizeUrlIdentity(requestedUrl)).slice(0, 32)}${ext}`);
}

export async function fileSha256(filePath) {
    const buffer = await fs.readFile(filePath);
    return sha256(buffer);
}

export function absolutizeUrl(href, baseUrl) {
    try {
        return new URL(href, baseUrl).toString();
    } catch {
        return null;
    }
}

export function cleanWhitespace(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

export function getDeep(obj, key) {
    if (obj == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    return key.split('.').reduce((acc, part) => acc == null ? undefined : acc[part], obj);
}

export function setDeep(obj, key, value) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts.at(-1)] = value;
}

export function boolToPl(v) {
    if (v === true) return 'TAK';
    if (v === false) return 'NIE';
    return '';
}

export function isProbablyPdfUrl(url) {
    return /\.pdf(?:$|[?#])/i.test(url || '');
}

export async function fetchBuffer(url, {
    timeoutMs = 25000,
    userAgent = 'Mozilla/5.0 bank-market-scan',
    headers = {}
} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {'user-agent': userAgent, ...headers}
        });
        const arrayBuffer = await res.arrayBuffer();
        return {
            ok: res.ok,
            status: res.status,
            statusText: res.statusText,
            contentType: res.headers.get('content-type') || '',
            etag: res.headers.get('etag') || null,
            lastModified: res.headers.get('last-modified') || null,
            buffer: Buffer.from(arrayBuffer),
            finalUrl: res.url
        };
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchText(url, opts = {}) {
    const r = await fetchBuffer(url, opts);
    return {...r, text: r.buffer.toString('utf8')};
}

export function scoreUrl(url, text, keywordGroups) {
    const hay = normalizeText(`${url} ${text}`);
    let score = 0;
    const hits = [];
    for (const [category, words] of Object.entries(keywordGroups)) {
        for (const w of words) {
            const n = normalizeText(w);
            if (hay.includes(n)) {
                score += category === 'product' ? 3 : 2;
                hits.push({category, keyword: w});
            }
        }
    }
    if (/\.pdf(?:$|[?#])/i.test(url)) score += 2;
    if (/tabela|taryfa|oprocent|prowiz|kredyt|mieszk/i.test(url)) score += 2;
    return {score, hits};
}

export function stripWwwHost(hostname) {
    return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

export function registrableDomain(hostname) {
    const host = stripWwwHost(hostname);
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 2) return host;
    const tld = parts.at(-1);
    const sld = parts.at(-2);
    if (tld?.length === 2 && sld?.length <= 3 && parts.length >= 3) {
        return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
}


export function parsePolishDateToIso(value) {
    const raw = cleanWhitespace(value).toLowerCase();
    if (!raw) return null;
    const numeric = raw.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})|(\d{1,2})[-.\/](\d{1,2})[-.\/](\d{4})/);
    if (numeric) {
        if (numeric[1]) return `${numeric[1]}-${numeric[2].padStart(2, '0')}-${numeric[3].padStart(2, '0')}`;
        return `${numeric[6]}-${numeric[5].padStart(2, '0')}-${numeric[4].padStart(2, '0')}`;
    }
    const months = new Map([
        ['stycznia', '01'], ['styczen', '01'], ['styczeń', '01'],
        ['lutego', '02'], ['luty', '02'],
        ['marca', '03'], ['marzec', '03'],
        ['kwietnia', '04'], ['kwiecien', '04'], ['kwiecień', '04'],
        ['maja', '05'], ['maj', '05'],
        ['czerwca', '06'], ['czerwiec', '06'],
        ['lipca', '07'], ['lipiec', '07'],
        ['sierpnia', '08'], ['sierpien', '08'], ['sierpień', '08'],
        ['wrzesnia', '09'], ['września', '09'], ['wrzesien', '09'], ['wrzesień', '09'],
        ['pazdziernika', '10'], ['października', '10'], ['pazdziernik', '10'], ['październik', '10'],
        ['listopada', '11'], ['listopad', '11'],
        ['grudnia', '12'], ['grudzien', '12'], ['grudzień', '12']
    ]);
    const m = raw.match(/(\d{1,2})\s+([\p{L}]+)\s+(\d{4})/u);
    if (!m) return null;
    const month = months.get(m[2]) || months.get(normalizeText(m[2]));
    if (!month) return null;
    return `${m[3]}-${month}-${m[1].padStart(2, '0')}`;
}

export function sourceDateFromText(text) {
    const patterns = [
        /(?:aktualizacj[ai]|aktualne\s+na\s+dzień|stan\s+na)[^\d]{0,80}(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2})/i,
        /(?:aktualizacj[ai]|aktualne\s+na\s+dzień|stan\s+na)[^\d]{0,80}(\d{1,2}\s+[\p{L}]+\s+\d{4})/iu
    ];
    for (const re of patterns) {
        const m = String(text || '').match(re);
        if (m) return parsePolishDateToIso(m[1]);
    }
    return null;
}


export function evidenceCountForField(row, fieldPath) {
    const ev = getDeep(row || {}, `field_evidence.${fieldPath}`);
    return Array.isArray(ev) ? ev.length : 0;
}

export function reasonCodesFor(row, key) {
    const codes = getDeep(row || {}, key);
    return Array.isArray(codes) ? codes.join('; ') : '';
}

export function coerceNumberOrNull(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const normalized = String(value).trim().replace('%', '').replace(',', '.');
    const n = Number(normalized);
    if (!Number.isFinite(n)) return null;
    return /%/.test(String(value)) || n > 1.5 ? n / 100 : n;
}

export function rangeFromLegacy(row, basePath) {
    const exact = getDeep(row || {}, `${basePath}_exact`);
    const min = getDeep(row || {}, `${basePath}_min`);
    const max = getDeep(row || {}, `${basePath}_max`);
    const legacy = getDeep(row || {}, basePath);
    return {
        exact: exact ?? legacy ?? null,
        min: min ?? legacy ?? null,
        max: max ?? legacy ?? null
    };
}

export function formatPercent(v) {
    if (v == null || v === '') return '';
    if (typeof v !== 'number') return String(v);
    return `${(v * 100).toLocaleString('pl-PL', {maximumFractionDigits: 4})}%`;
}

export function isSameWebsite(candidateUrl, baseUrl) {
    return sourceRelation(candidateUrl, baseUrl) === 'same_website';
}

export function sourceRelation(candidateUrl, baseUrl) {
    try {
        const a = new URL(candidateUrl);
        const b = new URL(baseUrl);
        const aHost = stripWwwHost(a.hostname);
        const bHost = stripWwwHost(b.hostname);
        if (aHost === bHost) return 'same_website';
        if (registrableDomain(aHost) === registrableDomain(bHost)) return 'related_host';
        return 'external';
    } catch {
        return 'invalid';
    }
}

export function isRelatedWebsite(candidateUrl, baseUrl) {
    const relation = sourceRelation(candidateUrl, baseUrl);
    return relation === 'same_website' || relation === 'related_host';
}

export function deepMergeDefined(target, patch) {
    if (patch === undefined) return target;
    if (patch === null || Array.isArray(patch) || typeof patch !== 'object') return patch;
    const base = target && typeof target === 'object' && !Array.isArray(target) ? {...target} : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        base[key] = deepMergeDefined(base[key], value);
    }
    return base;
}

export function normalizeWithMap(text) {
    const normalizedChars = [];
    const map = [];
    let lastWasSpace = true;
    const input = String(text || '');
    for (let i = 0; i < input.length; i++) {
        const stripped = stripCombiningMarks(input[i]);
        for (const ch of stripped) {
            const isAlphaNum = /[\p{L}\p{N}]/u.test(ch);
            const out = isAlphaNum ? ch.toLowerCase() : ' ';
            if (out === ' ') {
                if (!lastWasSpace) {
                    normalizedChars.push(' ');
                    map.push(i);
                    lastWasSpace = true;
                }
            } else {
                normalizedChars.push(out);
                map.push(i);
                lastWasSpace = false;
            }
        }
    }
    while (normalizedChars.length && normalizedChars[0] === ' ') {
        normalizedChars.shift();
        map.shift();
    }
    while (normalizedChars.length && normalizedChars.at(-1) === ' ') {
        normalizedChars.pop();
        map.pop();
    }
    return {normalized: normalizedChars.join(''), map};
}

export function findNormalizedSnippet(text, keyword, contextChars = 550) {
    const matches = findAllNormalizedSnippets(text, keyword, contextChars, 1);
    return matches[0] || null;
}

export function findAllNormalizedSnippets(text, keyword, contextChars = 550, limit = 3) {
    const source = String(text || '');
    const {normalized, map} = normalizeWithMap(source);
    const needle = normalizeText(keyword);
    if (!needle) return [];
    const matches = [];
    const seenStarts = new Set();
    let from = 0;
    while (matches.length < limit) {
        const idx = normalized.indexOf(needle, from);
        if (idx < 0) break;
        const sourceStart = map[idx] ?? 0;
        const sourceEnd = (map[Math.min(idx + needle.length - 1, map.length - 1)] ?? sourceStart) + 1;
        from = idx + Math.max(1, needle.length);
        if (seenStarts.has(sourceStart)) continue;
        seenStarts.add(sourceStart);
        const start = Math.max(0, sourceStart - contextChars);
        const end = Math.min(source.length, sourceEnd + contextChars);
        matches.push({
            index: idx,
            source_start: sourceStart,
            source_end: sourceEnd,
            text_excerpt: source.slice(start, end).trim()
        });
    }
    return matches;
}
