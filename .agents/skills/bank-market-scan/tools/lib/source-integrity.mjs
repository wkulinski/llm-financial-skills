import fs from 'node:fs/promises';
import {normalizeUrlIdentity, sha256} from './common.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/i;

export function isCriticalSourceCandidate(candidate = {}) {
    // A blocked category page canonically pointing at a 404 is crawl noise,
    // even when discovery promoted it. Search hits and explicit seeds remain
    // critical because they are intentional evidence sources.
    const unavailable = candidate.available === false || [403, 404].includes(Number(candidate.status));
    const canonical404 = /(?:^|\/)404(?:\.html?)?\/?$/i.test(String(candidate.canonical_url || ''));
    if (unavailable && canonical404 && candidate.selected_seed !== true && candidate.source !== 'search') return false;
    if (candidate.prioritized_candidate === true || candidate.selected_seed === true) return true;
    if (candidate.source === 'search') return true;
    if (candidate.prioritized_candidate === false && candidate.selected_seed !== true) return false;
    if (!Object.hasOwn(candidate, 'prioritized_candidate') && !Object.hasOwn(candidate, 'selected_seed')) return true;
    return Number(candidate.score || 0) > 2;
}

export function sourceBufferIntegrityErrors(candidate, buffer) {
    const errors = [];
    if (SHA256_RE.test(candidate?.content_sha256 || '') && sha256(buffer) !== candidate.content_sha256) {
        errors.push('content_hash_mismatch');
    }
    if (SHA256_RE.test(candidate?.content_sha256 || '') && Number.isInteger(candidate?.content_length) && buffer.length !== candidate.content_length) {
        errors.push('content_length_mismatch');
    }
    return errors;
}

export async function validateCandidateCaches(candidates) {
    const errors = [];
    const owners = new Map();
    for (const candidate of candidates || []) {
        if (!candidate.cache_file) continue;
        const ownerKey = normalizeUrlIdentity(candidate.url);
        const owner = owners.get(candidate.cache_file);
        if (owner && owner !== ownerKey) {
            errors.push({type: 'cache_file_collision', cache_file: candidate.cache_file, urls: [owner, ownerKey]});
        } else {
            owners.set(candidate.cache_file, ownerKey);
        }
        try {
            const buffer = await fs.readFile(candidate.cache_file);
            for (const code of sourceBufferIntegrityErrors(candidate, buffer)) {
                errors.push({type: code, cache_file: candidate.cache_file, url: candidate.url});
            }
        } catch (error) {
            errors.push({type: 'cache_file_unreadable', cache_file: candidate.cache_file, url: candidate.url, error: error.message});
        }
    }
    return errors;
}
