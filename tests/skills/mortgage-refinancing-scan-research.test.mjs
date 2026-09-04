import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';

import {mergeInstitutionRegistries} from '../../.agents/skills/mortgage-refinancing-scan/lib/institution-list.mjs';
import {buildEvidenceForEntry, buildEvidenceRecord} from '../../.agents/skills/mortgage-refinancing-scan/lib/evidence.mjs';
import {fetchEntrySources} from '../../.agents/skills/mortgage-refinancing-scan/lib/source-fetch.mjs';
import {discoverEntry} from '../../.agents/skills/mortgage-refinancing-scan/lib/source-discovery.mjs';
import {
    normalizeEntrySources,
    normalizeText,
    preflightMorfeusz,
    validateNormalizationArtifact
} from '../../.agents/skills/mortgage-refinancing-scan/lib/normalization.mjs';
import {canonicalJson} from '../../.agents/skills/mortgage-refinancing-scan/lib/canonical-json.mjs';
import {canonicalizeUrl, readEvidenceJsonl, readJson} from '../../.agents/skills/mortgage-refinancing-scan/lib/research-runtime.mjs';
import {validateCheckpoint, validateEvidenceRecord, validateInstitutionRegistrySnapshot, validateSourceArtifact, validateTelemetry} from '../../.agents/skills/mortgage-refinancing-scan/lib/run-contract-validate.mjs';
import {loadRun, replayRun} from '../../.agents/skills/mortgage-refinancing-scan/lib/run-lifecycle.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const TOOLS = path.join(ROOT, '.agents/skills/mortgage-refinancing-scan/tools');
const FIXTURE = path.join(ROOT, 'tests/fixtures/mortgage-refinancing-scan-research.json');
const REGISTRY = path.join(ROOT, 'tests/fixtures/mortgage-refinancing-scan-research-registry.json');
const BFG = path.join(ROOT, 'tests/fixtures/mortgage-refinancing-scan-research-bfg.json');
const KNF = path.join(ROOT, 'tests/fixtures/mortgage-refinancing-scan-research-knf.json');
const RUNS_ROOT = path.join(ROOT, 'data/mortgage-refinancing-scan/work/runs');
const PUBLISHED_ROOT = path.join(ROOT, 'data/mortgage-refinancing-scan/published');
const CACHE_ROOT = path.join(ROOT, `data/mortgage-refinancing-scan/cache/research-${process.pid}`);
process.env.MORTGAGE_REFINANCING_SCAN_TRANSPORT_CACHE_ROOT = `data/mortgage-refinancing-scan/cache/research-${process.pid}/http`;
process.env.MORTGAGE_REFINANCING_SCAN_NORMALIZATION_CACHE_ROOT = `data/mortgage-refinancing-scan/cache/research-${process.pid}/normalized`;
const activeRuns = new Set();
let sequence = 0;

describe('mortgage-refinancing-scan Phase 3 research vertical slice', () => {
    beforeAll(() => {
        if (fs.existsSync(RUNS_ROOT)) {
            for (const entry of fs.readdirSync(RUNS_ROOT, {withFileTypes: true})) {
                if (entry.isDirectory()) {
                    fs.rmSync(path.join(RUNS_ROOT, entry.name), {recursive: true, force: true});
                }
            }
        }
        fs.rmSync(CACHE_ROOT, {recursive: true, force: true});
    });

    afterAll(() => {
        for (const runId of activeRuns) {
            fs.rmSync(path.join(RUNS_ROOT, runId), {recursive: true, force: true});
            fs.rmSync(path.join(PUBLISHED_ROOT, runId), {recursive: true, force: true});
        }
        activeRuns.clear();
        fs.rmSync(CACHE_ROOT, {recursive: true, force: true});
    });

    afterEach(() => {
        for (const runId of activeRuns) {
            fs.rmSync(path.join(RUNS_ROOT, runId), {recursive: true, force: true});
            fs.rmSync(path.join(PUBLISHED_ROOT, runId), {recursive: true, force: true});
        }
        activeRuns.clear();
        fs.rmSync(CACHE_ROOT, {recursive: true, force: true});
    });

    it('covers T03: merges BFG and KNF, rejects duplicates and conflicts, and audits the run registry', () => {
        const bfg = readJson(BFG);
        const knf = readJson(KNF);
        const merged = mergeInstitutionRegistries({bfg, knf});
        expect(validateInstitutionRegistrySnapshot(merged).valid).toBe(true);
        expect(merged.entries).toHaveLength(11);
        expect(merged.entries[0].registry_sources).toEqual(['bfg', 'knf']);
        expect(merged.entries[0].allowed_redirect_hosts).toEqual(['cdn.positive.example.test', 'positive.example.test']);

        const conflict = structuredClone(knf);
        conflict.entries[0].legal_name = 'Conflicting Bank';
        expect(() => mergeInstitutionRegistries({bfg, knf: conflict})).toThrow(/inconsistent/);

        const duplicate = structuredClone(bfg);
        duplicate.entries.push(structuredClone(duplicate.entries[0]));
        expect(() => mergeInstitutionRegistries({bfg: duplicate, knf})).toThrow(/duplicate/);

        const init = createRun();
        const audited = runTool('institution-list.mjs', [
            '--run-manifest', init.manifestPath,
            '--bfg', BFG,
            '--knf', KNF
        ]);
        expect(audited.status).toBe('passed');
        expect(fs.existsSync(path.join(init.runRoot, 'artifacts/institution-list/registry-validation.json'))).toBe(true);
    });

    it('covers T04: discovers canonical candidates and keeps robots/host/JS rejections auditable', () => {
        const init = createRunningRun();
        const discovery = runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE]);
        const byEntry = new Map(discovery.results.map((result) => [result.entry_id, result]));
        expect(byEntry.get('bank-positive').status).toBe('discovered');
        expect(byEntry.get('bank-robots').status).toBe('technical_error');
        expect(byEntry.get('bank-redirect').status).toBe('technical_error');
        const positive = readJson(path.join(init.runRoot, 'artifacts/discovery/bank-positive.json'));
        expect(positive.candidates.map((candidate) => candidate.url)).toEqual([
            'https://positive.example.test/kredyt-mieszkaniowy',
            'https://positive.example.test/taryfa.pdf'
        ]);
        expect(positive.candidates.map((candidate) => candidate.url)).toEqual(
            [...positive.candidates.map((candidate) => candidate.url)].sort()
        );
        expect(positive.stats.deduplicated).toBe(1);
        expect(positive.rejected).toEqual(expect.arrayContaining([
            expect.objectContaining({reason: 'javascript_required', url: 'https://positive.example.test/js-shell'})
        ]));
        const redirect = readJson(path.join(init.runRoot, 'artifacts/discovery/bank-redirect.json'));
        expect(redirect.rejected).toEqual(expect.arrayContaining([
            expect.objectContaining({reason: 'official_host_violation', required: true})
        ]));
        const robotsState = readJson(path.join(init.runRoot, 'entries/bank-robots/state.json'));
        expect(robotsState).toMatchObject({stage: 'technical_error', decision_status: null, entry_outcome: 'external_source_error', error_code: 'robots_denied'});
        expect(canonicalizeUrl('https://POSITIVE.example.test:443/kredyt#fragment?x=1')).toBe('https://positive.example.test/kredyt');
    });

    it('covers T05: writes validated artifacts, retries fixture errors, and revalidates a 304 cache', async () => {
        const first = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', first.manifestPath, '--fixture', FIXTURE]);
        const fetched = runTool('source-fetch.mjs', ['--run-manifest', first.manifestPath, '--fixture', FIXTURE]);
        expect(fetched.results.find((result) => result.entry_id === 'bank-positive').status).toBe('fetched');
        const firstRun = loadRun(first.manifestPath);
        const firstSummary = readJson(path.join(first.runRoot, 'artifacts/fetch/bank-positive.json'));
        const firstArtifact = firstSummary.source_artifacts.find((artifact) => artifact.canonical_url.endsWith('/kredyt-mieszkaniowy'));
        expect(validateSourceArtifact(firstArtifact, {manifest: firstRun.manifest, context: firstRun.context}).valid).toBe(true);
        expect(fs.existsSync(path.resolve(ROOT, firstArtifact.run_local_path))).toBe(true);

        const errorSummary = readJson(path.join(first.runRoot, 'artifacts/fetch/bank-errors.json'));
        expect(errorSummary.metrics.requests.http_429).toBe(1);
        expect(errorSummary.metrics.requests.retried).toBeGreaterThanOrEqual(1);
        expect(errorSummary.metrics.requests.http_5xx).toBe(2);
        expect(errorSummary.metrics.requests.timeouts).toBe(2);
        expect(errorSummary.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['required_source_unavailable', 'request_timeout_after_retries']));
        expect(errorSummary.errors.map((error) => error.message).join(' ')).toMatch(/HTTP 401/);
        expect(errorSummary.errors.map((error) => error.message).join(' ')).toMatch(/HTTP 403/);

        const revalidationFixture = path.join(first.runRoot, 'revalidation-fixture.json');
        const fixture = readJson(FIXTURE);
        const positive = fixture.entries.find((entry) => entry.entry_id === 'bank-positive');
        for (const source of positive.sources) {
            source.responses = [{status: 304, headers: source.headers ?? {}}];
            delete source.status;
            delete source.body;
        }
        fs.writeFileSync(revalidationFixture, `${JSON.stringify(fixture, null, 2)}\n`);

        const second = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', second.manifestPath, '--fixture', revalidationFixture, '--entry-id', 'bank-positive']);
        runTool('source-fetch.mjs', ['--run-manifest', second.manifestPath, '--fixture', revalidationFixture, '--entry-id', 'bank-positive']);
        const secondSummary = readJson(path.join(second.runRoot, 'artifacts/fetch/bank-positive.json'));
        expect(secondSummary.source_artifacts.every((artifact) => artifact.cache_status === 'revalidated' && artifact.http_status === 304)).toBe(true);
        expect(secondSummary.source_artifacts.map((artifact) => artifact.raw_content_sha256)).toEqual(
            firstSummary.source_artifacts.map((artifact) => artifact.raw_content_sha256)
        );

        const limitedRun = loadRun(first.manifestPath);
        limitedRun.manifest.resource_policy.max_artifact_html_bytes = 4;
        const fixtureEntry = readJson(FIXTURE).entries.find((entry) => entry.entry_id === 'bank-positive');
        const registry = readJson(path.join(first.runRoot, 'registry.json'));
        const limited = await fetchEntrySources({
            run: limitedRun,
            fixtureEntry,
            registryEntry: registry.entries.find((entry) => entry.entry_id === 'bank-positive'),
            discovery: readJson(path.join(first.runRoot, 'artifacts/discovery/bank-positive.json')),
            observationTime: '2026-08-06T00:00:00Z'
        });
        expect(limited.technicalError?.code).toBe('required_source_unavailable');
    });

    it('covers T06: normalizes UTF-8 deterministically, preserves offsets, and refuses missing Morfeusz 2', async () => {
        const init = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-html-pdf']);
        runTool('source-fetch.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-html-pdf']);
        const normalized = runTool('normalize.mjs', [
            '--run-manifest', init.manifestPath,
            '--fixture', FIXTURE,
            '--entry-id', 'bank-html-pdf',
            '--engine', 'fixture'
        ]);
        expect(normalized.results[0].status).toBe('normalized');
        const summary = readJson(path.join(init.runRoot, 'artifacts/normalization/bank-html-pdf.json'));
        const artifacts = summary.artifacts.map((item) => readJson(path.resolve(ROOT, item.run_local_path)));
        expect(artifacts.every((artifact) => validateNormalizationArtifact(artifact))).toBe(true);
        expect(artifacts.every((artifact) => artifact.normalization_version === 'morfeusz-2:2.1.0-fixture')).toBe(true);
        const htmlArtifact = artifacts.find((artifact) => artifact.extracted_text.includes('Kredyt mieszkaniowy'));
        expect(htmlArtifact).toBeDefined();
        expect(artifacts.every((artifact) => artifact.tokens.every((token) => artifact.extracted_text.slice(token.start, token.end) === token.surface))).toBe(true);

        const first = await normalizeText('Spłatę kredytu mieszkaniowego — UTF-8', {engine: 'fixture'});
        const second = await normalizeText('Spłatę kredytu mieszkaniowego — UTF-8', {engine: 'fixture'});
        expect(second).toEqual(first);
        await expect(preflightMorfeusz({engine: 'morfeusz2', pythonCommand: 'command-that-does-not-exist'})).rejects.toMatchObject({code: 'dependency_missing'});
        const missingRun = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', missingRun.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-html-pdf']);
        runTool('source-fetch.mjs', ['--run-manifest', missingRun.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-html-pdf']);
        const missing = runTool('normalize.mjs', [
            '--run-manifest', missingRun.manifestPath,
            '--fixture', FIXTURE,
            '--entry-id', 'bank-html-pdf',
            '--python-command', 'command-that-does-not-exist'
        ], 20);
        expect(missing.error.code).toBe('dependency_missing');
    });

    it('covers T07: emits source-bound deterministic evidence and blocks mismatched excerpts', () => {
        const init = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE]);
        runTool('source-fetch.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE]);
        runTool('normalize.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--engine', 'fixture']);
        const evidenced = runTool('evidence.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE]);
        expect(evidenced.results.find((result) => result.entry_id === 'bank-positive')).toMatchObject({status: 'evidence_ready', evidence_count: 3});
        const run = loadRun(init.manifestPath);
        const records = readEvidenceJsonl(run.context.evidence_path);
        expect(records.length).toBeGreaterThanOrEqual(13);
        for (const record of records) {
            const fetchSummary = readJson(path.join(init.runRoot, 'artifacts/fetch', `${record.entry_id}.json`));
            const source = fetchSummary.source_artifacts.find((artifact) => artifact.artifact_id === record.source_artifact_id);
            expect(validateEvidenceRecord(record, {manifest: run.manifest, sourceArtifact: source}).valid).toBe(true);
        }
        const positiveRecords = records.filter((record) => record.entry_id === 'bank-positive');
        expect(new Set(positiveRecords.map((record) => `${record.product_id}:${record.variant_id}`)).size).toBe(1);
        const splitRecords = records.filter((record) => record.entry_id === 'bank-split-products');
        expect(new Set(splitRecords.map((record) => record.product_id)).size).toBe(2);

        const fixtureEntry = readJson(FIXTURE).entries.find((entry) => entry.entry_id === 'bank-positive');
        const fetchSummary = readJson(path.join(init.runRoot, 'artifacts/fetch/bank-positive.json'));
        const normalizationSummary = readJson(path.join(init.runRoot, 'artifacts/normalization/bank-positive.json'));
        const sourceByUrl = new Map(fetchSummary.source_artifacts.map((artifact) => [artifact.canonical_url, artifact]));
        const normalizationBySource = new Map(normalizationSummary.artifacts.map((artifact) => [artifact.source_artifact_id, readJson(path.resolve(ROOT, artifact.run_local_path))]));
        expect(() => buildEvidenceRecord({
            run,
            fixtureEntry,
            match: {...fixtureEntry.evidence[0], excerpt: 'Nieistniejący fragment'},
            sourceByUrl,
            normalizationBySource,
            observationTime: '2026-08-06T00:00:00Z'
        })).toThrow(/not present/);
    });

    it('stabilizes deterministic replay when discovery, source and evidence input order changes', () => {
        const fixture = readJson(FIXTURE);
        const registry = readJson(REGISTRY);
        const originalEntry = fixture.entries.find((entry) => entry.entry_id === 'bank-positive');
        const registryEntry = registry.entries.find((entry) => entry.entry_id === 'bank-positive');
        const shuffledEntry = structuredClone(originalEntry);
        for (const field of ['sitemap', 'candidates', 'sources', 'evidence']) {
            shuffledEntry[field].reverse();
        }
        const firstDiscovery = discoverEntry({
            fixtureEntry: originalEntry,
            registryEntry,
            maxRequests: 256,
            observationTime: fixture.observed_at
        });
        const secondDiscovery = discoverEntry({
            fixtureEntry: shuffledEntry,
            registryEntry,
            maxRequests: 256,
            observationTime: fixture.observed_at
        });
        expect(canonicalJson(discoveryReplayProjection(firstDiscovery))).toBe(canonicalJson(discoveryReplayProjection(secondDiscovery)));

        const firstRun = createRunningRun();
        const secondRun = createRunningRun();
        const shuffledFixturePath = path.join(secondRun.runRoot, 'shuffled-research-fixture.json');
        const shuffledFixture = structuredClone(fixture);
        const shuffledFixtureEntry = shuffledFixture.entries.find((entry) => entry.entry_id === 'bank-positive');
        for (const field of ['sitemap', 'candidates', 'sources', 'evidence']) {
            shuffledFixtureEntry[field].reverse();
        }
        fs.writeFileSync(shuffledFixturePath, `${JSON.stringify(shuffledFixture, null, 2)}\n`);
        runPositiveEvidence(firstRun, FIXTURE);
        runPositiveEvidence(secondRun, shuffledFixturePath);
        const firstRecords = readEvidenceJsonl(loadRun(firstRun.manifestPath).context.evidence_path);
        const secondRecords = readEvidenceJsonl(loadRun(secondRun.manifestPath).context.evidence_path);
        expect(canonicalJson(stableEvidenceProjection(firstRecords))).toBe(canonicalJson(stableEvidenceProjection(secondRecords)));
    });

    it('stabilizes tamper detection for source bytes, normalization cache and evidence', async () => {
        const init = createRunningRun();
        runPositiveEvidence(init, FIXTURE);
        const run = loadRun(init.manifestPath);
        const fetchSummary = readJson(path.join(init.runRoot, 'artifacts/fetch/bank-positive.json'));
        const sourceArtifact = fetchSummary.source_artifacts.find((artifact) => artifact.canonical_url.endsWith('/kredyt-mieszkaniowy'));
        const sourcePath = path.resolve(ROOT, sourceArtifact.run_local_path);
        const originalBytes = fs.readFileSync(sourcePath);
        fs.writeFileSync(sourcePath, Buffer.alloc(originalBytes.length, 0x58));
        const normalizationSummary = readJson(path.join(init.runRoot, 'artifacts/normalization/bank-positive.json'));
        await expect(normalizeEntrySources({
            run,
            fixtureEntry: readJson(FIXTURE).entries.find((entry) => entry.entry_id === 'bank-positive'),
            fetchSummary,
            observationTime: '2026-08-06T00:00:00Z',
            engine: 'fixture'
        })).rejects.toMatchObject({code: 'evidence_mismatch'});
        fs.writeFileSync(sourcePath, originalBytes);

        const normalizationArtifact = readJson(path.resolve(ROOT, normalizationSummary.artifacts[0].run_local_path));
        const cachePath = path.join(CACHE_ROOT, 'normalized', `${normalizationArtifact.cache_key}.json`);
        const cached = readJson(cachePath);
        cached.tokens[0].end = cached.tokens[0].start;
        fs.writeFileSync(cachePath, `${JSON.stringify(cached, null, 2)}\n`);
        await expect(normalizeEntrySources({
            run,
            fixtureEntry: readJson(FIXTURE).entries.find((entry) => entry.entry_id === 'bank-positive'),
            fetchSummary,
            observationTime: '2026-08-06T00:00:00Z',
            engine: 'fixture'
        })).rejects.toMatchObject({code: 'schema_mismatch'});

        const evidence = readEvidenceJsonl(run.context.evidence_path)[0];
        const sourceForEvidence = fetchSummary.source_artifacts.find((artifact) => artifact.artifact_id === evidence.source_artifact_id);
        const tamperedEvidence = {...evidence, normalized_excerpt: `${evidence.normalized_excerpt} tampered`};
        const validation = validateEvidenceRecord(tamperedEvidence, {manifest: run.manifest, sourceArtifact: sourceForEvidence});
        expect(validation.valid).toBe(false);
        expect(validation.errors.map((error) => error.code)).toContain('evidence_id_mismatch');
    });

    it('stabilizes reruns without duplicate events, source artifacts or evidence records', () => {
        const init = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        const afterDiscovery = fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8');
        runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        expect(fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8')).toBe(afterDiscovery);

        runTool('source-fetch.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        const afterFetch = fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8');
        const firstFetchSummary = readJson(path.join(init.runRoot, 'artifacts/fetch/bank-positive.json'));
        runTool('source-fetch.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        expect(fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8')).toBe(afterFetch);
        expect(readJson(path.join(init.runRoot, 'artifacts/fetch/bank-positive.json')).source_artifacts.map((artifact) => artifact.artifact_id))
            .toEqual(firstFetchSummary.source_artifacts.map((artifact) => artifact.artifact_id));

        runTool('normalize.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive', '--engine', 'fixture']);
        runTool('evidence.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        const afterEvidenceEvents = fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8');
        const afterEvidence = readEvidenceJsonl(loadRun(init.manifestPath).context.evidence_path);
        runTool('normalize.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive', '--engine', 'fixture']);
        runTool('evidence.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        expect(fs.readFileSync(path.join(init.runRoot, 'events.jsonl'), 'utf8')).toBe(afterEvidenceEvents);
        const rerunEvidence = readEvidenceJsonl(loadRun(init.manifestPath).context.evidence_path);
        expect(rerunEvidence).toEqual(afterEvidence);
        expect(new Set(rerunEvidence.map((record) => record.evidence_id)).size).toBe(rerunEvidence.length);
    });

    it('stabilizes checkpoint and telemetry projection after research stages complete', () => {
        const init = createRunningRun();
        runPositiveEvidence(init, FIXTURE);
        const projection = replayRun(loadRun(init.manifestPath));
        for (const entry of projection.entries.values()) {
            if (entry.stage === 'technical_error') continue;
            runTool('run-state.mjs', [
                '--run-manifest', init.manifestPath,
                '--action', 'entry',
                '--entry-id', entry.entry_id,
                '--stage', 'technical_error',
                '--error-code', 'required_source_unavailable',
                '--error-message', 'stabilization terminalization for telemetry',
                '--operation-id', `telemetry-terminal:${entry.entry_id}`
            ]);
        }
        runTool('run-state.mjs', ['--run-manifest', init.manifestPath, '--action', 'transition', '--next-state', 'READY']);
        const run = loadRun(init.manifestPath);
        const checkpoint = readJson(run.checkpointPath);
        const telemetry = readJson(run.metricsPath);
        expect(validateCheckpoint(checkpoint, {manifest: run.manifest}).valid).toBe(true);
        expect(validateTelemetry(telemetry, {manifest: run.manifest, checkpoint}).valid).toBe(true);
        expect(checkpoint).toMatchObject({status: 'ready_with_errors', coverage_status: 'degraded', terminal_entry_count: 11});
        expect(telemetry.run.requests.total).toBeGreaterThan(0);
        expect(telemetry.run.bytes.downloaded).toBeGreaterThan(0);
        expect(telemetry.stages.map((stage) => stage.stage)).toEqual(expect.arrayContaining(['discovery', 'fetched', 'normalized', 'evidence_ready', 'technical_error']));
        expect(telemetry.entries.find((entry) => entry.entry_id === 'bank-positive').requests.total).toBeGreaterThan(0);
    });

    it('stabilizes 304 handling when the cache is missing or validators change', () => {
        const makeRevalidationFixture = (etag) => {
            const fixture = readJson(FIXTURE);
            const positive = fixture.entries.find((entry) => entry.entry_id === 'bank-positive');
            for (const source of positive.sources) {
                source.responses = [{status: 304, headers: {ETag: etag}}];
                delete source.status;
                delete source.body;
            }
            return fixture;
        };

        fs.rmSync(CACHE_ROOT, {recursive: true, force: true});
        const noCache = createRunningRun();
        const noCacheFixture = path.join(noCache.runRoot, 'no-cache-304.json');
        fs.writeFileSync(noCacheFixture, `${JSON.stringify(makeRevalidationFixture('"no-cache"'), null, 2)}\n`);
        runTool('source-discovery.mjs', ['--run-manifest', noCache.manifestPath, '--fixture', noCacheFixture, '--entry-id', 'bank-positive']);
        runTool('source-fetch.mjs', ['--run-manifest', noCache.manifestPath, '--fixture', noCacheFixture, '--entry-id', 'bank-positive']);
        expect(readJson(path.join(noCache.runRoot, 'entries/bank-positive/state.json'))).toMatchObject({stage: 'technical_error', error_code: 'required_source_unavailable'});
        expect(readJson(path.join(noCache.runRoot, 'artifacts/fetch/bank-positive.json')).errors.map((error) => error.message).join(' ')).toMatch(/revalidatable transport cache/);

        const seed = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', seed.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        runTool('source-fetch.mjs', ['--run-manifest', seed.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        const changed = createRunningRun();
        const changedFixture = path.join(changed.runRoot, 'changed-validator-304.json');
        fs.writeFileSync(changedFixture, `${JSON.stringify(makeRevalidationFixture('"changed-validator"'), null, 2)}\n`);
        runTool('source-discovery.mjs', ['--run-manifest', changed.manifestPath, '--fixture', changedFixture, '--entry-id', 'bank-positive']);
        runTool('source-fetch.mjs', ['--run-manifest', changed.manifestPath, '--fixture', changedFixture, '--entry-id', 'bank-positive']);
        expect(readJson(path.join(changed.runRoot, 'entries/bank-positive/state.json'))).toMatchObject({stage: 'technical_error', error_code: 'required_source_unavailable'});
    });

    it('stabilizes the real Morfeusz 2 worker protocol without enabling a fallback', async () => {
        const init = createRun();
        const fakeModuleRoot = path.join(init.runRoot, 'fake-morfeusz');
        const fakeModulePath = path.join(fakeModuleRoot, 'morfeusz2.py');
        const pythonWrapper = path.join(init.runRoot, 'fake-python');
        fs.mkdirSync(fakeModuleRoot, {recursive: true});
        fs.writeFileSync(fakeModulePath, [
            '__version__ = "2.1.0-test"',
            'class Morfeusz:',
            '    def analyse(self, text):',
            '        return [(0, 1, "Kredyt", "kredyt", "subst"), (1, 2, "mieszkaniowy", "mieszkaniowy", "adj")]'
        ].join('\n') + '\n');
        fs.writeFileSync(pythonWrapper, [
            '#!/usr/bin/python3',
            'import os',
            'import sys',
            `os.environ["PYTHONPATH"] = ${JSON.stringify(fakeModuleRoot)} + os.pathsep + os.environ.get("PYTHONPATH", "")`,
            'os.execvp("python3", ["python3", *sys.argv[1:]])'
        ].join('\n') + '\n');
        fs.chmodSync(pythonWrapper, 0o755);

        const workerPath = path.join(TOOLS, 'morfeusz2-worker.py');
        await expect(preflightMorfeusz({engine: 'morfeusz2', workerPath, pythonCommand: pythonWrapper})).resolves.toMatchObject({version: '2.1.0-test'});
        await expect(normalizeText('Kredyt mieszkaniowy', {
            engine: 'morfeusz2',
            workerPath,
            pythonCommand: pythonWrapper
        })).resolves.toMatchObject({
            normalization_version: 'morfeusz-2:2.1.0-test',
            tokens: [
                {surface: 'Kredyt', lemma: 'kredyt', start: 0, end: 6},
                {surface: 'mieszkaniowy', lemma: 'mieszkaniowy', start: 7, end: 19}
            ]
        });
        await expect(preflightMorfeusz({engine: 'morfeusz2', workerPath, pythonCommand: 'missing-python-command'})).rejects.toMatchObject({code: 'dependency_missing'});
    });

    it('keeps publication unchanged when a Phase 3 run is aborted', () => {
        const pointerBeforePath = path.join(PUBLISHED_ROOT, 'current.json');
        const init = createRunningRun();
        runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', FIXTURE, '--entry-id', 'bank-positive']);
        const aborted = runTool('abort.mjs', ['--run-manifest', init.manifestPath, '--error-code', 'dependency_missing', '--reason', 'Phase 3 fixture abort']);
        expect(aborted.status).toBe('ABORTED');
        expect(fs.existsSync(path.join(PUBLISHED_ROOT, init.runId))).toBe(false);
        if (fs.existsSync(pointerBeforePath)) {
            expect(JSON.parse(fs.readFileSync(pointerBeforePath, 'utf8')).run_id).not.toBe(init.runId);
        }
    });
});

function runPositiveEvidence(init, fixturePath) {
    runTool('source-discovery.mjs', ['--run-manifest', init.manifestPath, '--fixture', fixturePath, '--entry-id', 'bank-positive']);
    runTool('source-fetch.mjs', ['--run-manifest', init.manifestPath, '--fixture', fixturePath, '--entry-id', 'bank-positive']);
    runTool('normalize.mjs', ['--run-manifest', init.manifestPath, '--fixture', fixturePath, '--entry-id', 'bank-positive', '--engine', 'fixture']);
    runTool('evidence.mjs', ['--run-manifest', init.manifestPath, '--fixture', fixturePath, '--entry-id', 'bank-positive']);
}

function discoveryReplayProjection(discovery) {
    return {
        entry_id: discovery.entry_id,
        institution_id: discovery.institution_id,
        robots: discovery.robots,
        candidates: discovery.candidates,
        rejected: discovery.rejected,
        outcome: discovery.outcome,
        stats: discovery.stats
    };
}

function stableEvidenceProjection(records) {
    return records
        .map((record) => ({
            evidence_id: record.evidence_id,
            institution_id: record.institution_id,
            product_id: record.product_id,
            variant_id: record.variant_id,
            field_path: record.field_path,
            url: record.url,
            content_sha256: record.content_sha256,
            excerpt: record.excerpt,
            normalized_excerpt: record.normalized_excerpt,
            source_type: record.source_type,
            source_locator: record.source_locator,
            normalization_version: record.normalization_version
        }))
        .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

function createRun() {
    sequence += 1;
    const runId = `run-20260806T13${String(sequence).padStart(4, '0')}Z-research${sequence.toString(36)}`;
    const manifestPath = path.join(ROOT, 'data/mortgage-refinancing-scan/work/runs', runId, 'manifest.json');
    activeRuns.add(runId);
    const output = runTool('run-init.mjs', [
        '--registry-snapshot', REGISTRY,
        '--mode', 'full',
        '--live', 'false',
        '--run-root', 'data/mortgage-refinancing-scan/work/runs',
        '--run-id', runId
    ]);
    return {runId, manifestPath, runRoot: path.dirname(manifestPath)};
}

function createRunningRun() {
    const init = createRun();
    runTool('run-state.mjs', ['--run-manifest', init.manifestPath, '--action', 'transition', '--next-state', 'RUNNING']);
    return init;
}

function runTool(tool, args, expectedCode = 0) {
    const result = spawnSync(process.execPath, [path.join(TOOLS, tool), ...args], {
        cwd: ROOT,
        encoding: 'utf8'
    });
    expect(result.error, `${tool} process error`).toBeUndefined();
    expect(result.status, `${tool} stderr: ${result.stderr}`).toBe(expectedCode);
    const output = (expectedCode === 0 ? result.stdout : result.stderr).trim();
    return output ? JSON.parse(output) : {};
}
