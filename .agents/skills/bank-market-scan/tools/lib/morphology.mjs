import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PROJECT_ROOT, SKILL_ROOT, sha256, normalizeText} from './common.mjs';

const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../morphology-worker.py');
const CACHE_VERSION = 1;
const REPOSITORY_ROOT = path.resolve(SKILL_ROOT, '..', '..', '..');
const PROJECT_MORFEUSZ_PYTHON = path.resolve(PROJECT_ROOT, '.venv/bin/python');
const REPOSITORY_MORFEUSZ_PYTHON = path.resolve(REPOSITORY_ROOT, '.venv/bin/python');
export const DEFAULT_MORFEUSZ_PYTHON = existsSync(PROJECT_MORFEUSZ_PYTHON)
    ? PROJECT_MORFEUSZ_PYTHON
    : REPOSITORY_MORFEUSZ_PYTHON;

function cacheKey(kind, text) {
    return `${kind}:${sha256(text)}`;
}

function runWorker(records, pythonCommand) {
    return new Promise((resolve, reject) => {
        const child = spawn(pythonCommand, [workerPath], {stdio: ['pipe', 'pipe', 'pipe']});
        let output = '';
        let errors = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { errors += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(`Morfeusz worker exited ${code}: ${errors.trim()}`));
            try {
                resolve(output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
            } catch (error) {
                reject(new Error(`Morfeusz worker returned invalid JSON: ${error.message}`));
            }
        });
        child.stdin.end(records.map(record => JSON.stringify(record)).join('\n') + '\n');
    });
}

async function readCache(cacheFile) {
    if (!cacheFile) return {version: CACHE_VERSION, records: {}};
    try {
        const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        if (cache.version !== CACHE_VERSION) return {version: CACHE_VERSION, records: {}};
        return cache;
    } catch {
        return {version: CACHE_VERSION, records: {}};
    }
}

async function writeCache(cacheFile, cache) {
    if (!cacheFile) return;
    const temporary = `${cacheFile}.tmp-${process.pid}`;
    await fs.writeFile(temporary, JSON.stringify(cache) + '\n');
    await fs.rename(temporary, cacheFile);
}

function findLemmaPhrase(tokens, keywordTokens) {
    if (!tokens.length || !keywordTokens.length) return null;
    for (let index = 0; index <= tokens.length - keywordTokens.length; index += 1) {
        const matches = keywordTokens.every((token, offset) => tokens[index + offset].lemma === token);
        if (matches) {
            return {
                start: tokens[index].start,
                end: tokens[index + keywordTokens.length - 1].end
            };
        }
    }
    return null;
}

function makeExcerpt(text, start, end, radius = 260) {
    const from = Math.max(0, start - radius);
    const to = Math.min(text.length, end + radius);
    return {source_start: start, text_excerpt: text.slice(from, to)};
}

export async function prepareMorphology(materials, keywordGroups, {pythonCommand = process.env.MORFEUSZ_PYTHON || DEFAULT_MORFEUSZ_PYTHON} = {}) {
    const cacheDir = materials.find(material => material.cache_file)?.cache_file;
    const cacheFile = cacheDir ? path.join(path.dirname(cacheDir), 'morphology-cache.json') : null;
    const cache = await readCache(cacheFile);
    const records = [];
    const materialKeys = new Map();
    const keywordKeys = new Map();

    for (const material of materials) {
        const key = cacheKey('text', material.text);
        materialKeys.set(material.url, key);
        if (!cache.records[key]) records.push({id: key, text: material.text});
    }
    for (const [category, terms] of Object.entries(keywordGroups)) {
        for (const [index, term] of terms.entries()) {
            const key = cacheKey('keyword', term);
            keywordKeys.set(`${category}:${index}`, key);
            if (!cache.records[key]) records.push({id: key, text: term});
        }
    }

    if (records.length) {
        try {
            const results = await runWorker(records, pythonCommand);
            const failed = results.filter(result => result.error || !result.id);
            if (failed.length) {
                throw new Error(`Morfeusz worker failed for ${failed.length} record(s).`);
            }
            for (const result of results) {
                if (result.id) cache.records[result.id] = {
                    lemma_text: result.lemma_text || '',
                    tokens: result.tokens || []
                };
            }
            await writeCache(cacheFile, cache);
        } catch (error) {
            throw new Error(`Morfeusz 2 is required for content analysis. Configure MORFEUSZ_PYTHON or install ${DEFAULT_MORFEUSZ_PYTHON}: ${error.message}`, {cause: error});
        }
    }

    const materialMorphology = new Map();
    for (const material of materials) materialMorphology.set(material.url, cache.records[materialKeys.get(material.url)] || null);
    const keywordMorphology = new Map();
    for (const [key, cacheKeyValue] of keywordKeys) keywordMorphology.set(key, cache.records[cacheKeyValue] || null);
    const missingMaterials = [...materialMorphology.entries()].filter(([, value]) => !value).map(([url]) => url);
    const missingKeywords = [...keywordMorphology.entries()].filter(([, value]) => !value).map(([key]) => key);
    if (missingMaterials.length || missingKeywords.length) {
        throw new Error(`Morfeusz normalization incomplete: missing materials=${missingMaterials.length}, keywords=${missingKeywords.length}.`);
    }
    const cacheHits = materials.length + keywordKeys.size - records.length;

    return {
        available: true,
        error: null,
        materials: materialMorphology,
        keywords: keywordMorphology,
        cache_hits: Math.max(0, cacheHits),
        cache_misses: records.length
    };
}

export function findLemmaMatch(material, morphology, category, keywordIndex) {
    if (!morphology?.available) throw new Error('Morfeusz 2 morphology is unavailable; surface-form fallback is disabled.');
    const materialRecord = morphology.materials.get(material.url);
    const keywordRecord = morphology.keywords.get(`${category}:${keywordIndex}`);
    if (!materialRecord || !keywordRecord) return null;
    const keywordTokens = keywordRecord.tokens.map(token => token.lemma).filter(Boolean);
    const match = findLemmaPhrase(materialRecord.tokens, keywordTokens);
    return match ? {...match, ...makeExcerpt(material.text, match.start, match.end)} : null;
}

export function lemmaText(morphology, material) {
    return morphology?.materials.get(material.url)?.lemma_text || '';
}

export function normalizedLemma(value) {
    return normalizeText(value);
}
