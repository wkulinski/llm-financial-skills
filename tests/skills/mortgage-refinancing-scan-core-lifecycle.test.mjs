import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
    loadRun,
    replayRun
} from '../../.agents/skills/mortgage-refinancing-scan/lib/run-lifecycle.mjs';
import {OriginScheduler} from '../../.agents/skills/mortgage-refinancing-scan/lib/origin-scheduler.mjs';
import {
    validateCheckpoint,
    validateInstitutionRegistrySnapshot,
    validatePointer,
    validatePublicationRecord,
    validateRunManifest,
    validateSnapshot,
    validateTelemetry
} from '../../.agents/skills/mortgage-refinancing-scan/lib/run-contract-validate.mjs';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const REGISTRY = path.join(ROOT, 'tests/fixtures/mortgage-refinancing-scan-registry.json');
const RUNS_ROOT = path.join(ROOT, 'data/mortgage-refinancing-scan/work/runs');
const PUBLISHED_ROOT = path.join(ROOT, 'data/mortgage-refinancing-scan/published');
const TOOLS_ROOT = path.join(ROOT, '.agents/skills/mortgage-refinancing-scan/tools');
const MATRIX_PATH = path.join(ROOT, '.agents/skills/mortgage-refinancing-scan/tests/test-matrix.json');
const SOURCE_ID = `src-${'a'.repeat(24)}`;
let sequence = 0;
let activeRunId;
let pointerBefore;

describe('mortgage-refinancing-scan Phase 2 core lifecycle', () => {
    beforeEach(() => {
        pointerBefore = readOptional(path.join(PUBLISHED_ROOT, 'current.json'));
    });

    afterEach(() => {
        if (activeRunId) {
            cleanupRunArtifacts(activeRunId);
        }
        restoreOptional(path.join(PUBLISHED_ROOT, 'current.json'), pointerBefore);
        activeRunId = undefined;
    });

    it('covers T01 and T02: initializes exact scope, retries, projects one checkpoint and repairs a faulted event', () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const registry = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'registry.json'), 'utf8'));
        expect(validateInstitutionRegistrySnapshot(registry).valid).toBe(true);
        expect(validateRunManifest(manifest, {registryEntries: registry.entries}).valid).toBe(true);
        expect(init.status).toBe('PREPARED');
        expect(init.checkpoint_path).toBeNull();
        expect(fs.existsSync(path.join(path.dirname(manifestPath), 'events.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(manifestPath), 'evidence.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(path.dirname(manifestPath), 'entries/bank-001/state.json'))).toBe(true);
        expect(manifest.live).toBe(false);

        runState(manifestPath, ['--action', 'transition', '--next-state', 'RUNNING']);
        const faulted = runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-002', '--stage', 'fetched',
            '--operation-id', 't02-repairable-event', '--fault-at', 'event-after-append'
        ], 20);
        expect(faulted.error.code).toBe('fault_injected');
        const repaired = runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-002', '--stage', 'fetched',
            '--operation-id', 't02-repairable-event'
        ]);
        expect(repaired.status).toBe('RUNNING');
        runState(manifestPath, [
            '--action', 'retry', '--entry-id', 'bank-002', '--operation-id', 't02-bank2-retry'
        ]);
        runState(manifestPath, [
            '--action', 'retry', '--entry-id', 'bank-002', '--operation-id', 't02-bank2-exhausted',
            '--error-code', 'request_timeout_after_retries', '--error-message', 'retry budget exhausted'
        ]);
        runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-001', '--stage', 'fetched',
            '--operation-id', 't02-bank1-fetched', '--output-artifact-ids', SOURCE_ID
        ]);
        runState(manifestPath, [
            '--action', 'retry', '--entry-id', 'bank-001',
            '--operation-id', 't02-bank1-retry'
        ]);
        runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-001', '--stage', 'normalized',
            '--operation-id', 't02-bank1-normalized'
        ]);
        runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-001', '--stage', 'evidence_ready',
            '--operation-id', 't02-bank1-evidence'
        ]);
        runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-001', '--stage', 'interpreted',
            '--decision-status', 'unconfirmed', '--operation-id', 't02-bank1-interpreted'
        ]);
        const batchPath = path.join(path.dirname(manifestPath), 'batch-input.json');
        fs.writeFileSync(batchPath, JSON.stringify([
            {action: 'entry', entry_id: 'bank-003', stage: 'fetched', operation_id: 't02-batch-bank3-fetched', origin: 'other.example.test'},
            {action: 'entry', entry_id: 'bank-003', stage: 'normalized', operation_id: 't02-batch-bank3-normalized', origin: 'other.example.test'}
        ]));
        runState(manifestPath, ['--action', 'batch', '--operations', batchPath]);
        fs.rmSync(batchPath, {force: true});
        runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-003', '--stage', 'evidence_ready',
            '--operation-id', 't02-bank3-evidence'
        ]);
        runState(manifestPath, [
            '--action', 'entry', '--entry-id', 'bank-003', '--stage', 'interpreted',
            '--decision-status', 'explicitly_not_qualified', '--operation-id', 't02-bank3-interpreted'
        ]);
        runState(manifestPath, ['--action', 'transition', '--next-state', 'READY']);

        const run = loadRun(manifestPath);
        const projection = replayRun(run);
        const checkpoint = JSON.parse(fs.readFileSync(run.checkpointPath, 'utf8'));
        const telemetry = JSON.parse(fs.readFileSync(run.metricsPath, 'utf8'));
        expect(projection.runState).toBe('READY');
        expect(projection.events.map((event) => event.sequence)).toEqual(
            Array.from({length: projection.events.length}, (_, index) => index + 1)
        );
        expect(projection.entries.get('bank-001').attempt).toBe(2);
        expect(validateCheckpoint(checkpoint, {manifest}).valid).toBe(true);
        expect(validateTelemetry(telemetry, {manifest, checkpoint}).valid).toBe(true);
        expect(checkpoint).toMatchObject({
            scope_count: 3,
            terminal_entry_count: 3,
            interpreted_count: 2,
            technical_error_count: 1,
            status: 'ready_with_errors',
            coverage_status: 'degraded'
        });
        expect(replayRun(loadRun(manifestPath)).events.filter((event) => event.operation_id === 't02-repairable-event')).toHaveLength(1);
    });

    it('covers T02 scheduler limits across origins and serializes same-origin work', async () => {
        const activeByOrigin = new Map();
        let active = 0;
        let maxActive = 0;
        let sameOriginOverlap = false;
        const scheduler = new OriginScheduler({
            maxActive: 2,
            maxActiveInstitutions: 3,
            maxInFlightPerOrigin: 1,
            maxInFlightPerInstitution: 1,
            originDelayMs: 0,
            retryAfterCapMs: 0
        });
        const tasks = [
            {operation_id: 'a', origin: 'same.test', institution_id: 'bank-a'},
            {operation_id: 'b', origin: 'same.test', institution_id: 'bank-b'},
            {operation_id: 'c', origin: 'other.test', institution_id: 'bank-c'}
        ];
        const result = await scheduler.run(tasks, async (task) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            const originCount = (activeByOrigin.get(task.origin) ?? 0) + 1;
            activeByOrigin.set(task.origin, originCount);
            if (originCount > 1) sameOriginOverlap = true;
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            activeByOrigin.set(task.origin, originCount - 1);
            return {operation_id: task.operation_id};
        });
        expect(result.map(({task}) => task.operation_id)).toEqual(['a', 'b', 'c']);
        expect(maxActive).toBe(2);
        expect(sameOriginOverlap).toBe(false);
    });

    it('caps Retry-After without retaining an origin slot indefinitely', async () => {
        let clock = 0;
        const sleeps = [];
        const startedAt = [];
        const scheduler = new OriginScheduler({
            maxActive: 1,
            maxActiveInstitutions: 2,
            maxInFlightPerOrigin: 1,
            maxInFlightPerInstitution: 1,
            originDelayMs: 0,
            retryAfterCapMs: 50,
            now: () => clock,
            sleep: async (milliseconds) => {
                sleeps.push(milliseconds);
                clock += milliseconds;
            }
        });
        await scheduler.run([
            {operation_id: 'retry-after', origin: 'same.test', institution_id: 'bank-a'},
            {operation_id: 'after-cap', origin: 'same.test', institution_id: 'bank-b'}
        ], async (task) => {
            startedAt.push({operationId: task.operation_id, clock});
            return task.operation_id === 'retry-after' ? {retryAfterMs: 1000} : {};
        });
        expect(startedAt).toEqual([
            {operationId: 'retry-after', clock: 0},
            {operationId: 'after-cap', clock: 50}
        ]);
        expect(sleeps).toEqual([50]);
    });

    it('rejects a partial event record, a sequence gap and a duplicate operation', () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        const run = loadRun(manifestPath);
        const eventsPath = path.join(run.runRoot, 'events.jsonl');
        const original = fs.readFileSync(eventsPath, 'utf8');

        fs.writeFileSync(eventsPath, `${original}{"schema_version":`);
        expect(thrownCode(() => replayRun(run))).toBe('event_log_partial_record');

        fs.writeFileSync(eventsPath, original.replace('"sequence":1', '"sequence":3'));
        expect(thrownCode(() => replayRun(run))).toBe('event_log_sequence_gap');

        fs.writeFileSync(eventsPath, `${original}${original}`);
        expect(thrownCode(() => replayRun(run))).toBe('event_log_duplicate_operation');
    });

    it('rejects tampering with the immutable manifest hash and registry snapshot', () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        const run = loadRun(manifestPath);
        fs.writeFileSync(path.join(run.runRoot, 'manifest.sha256'), `${'0'.repeat(64)}\n`);
        expect(thrownCode(() => loadRun(manifestPath))).toBe('manifest_changed');
        const firstRunId = activeRunId;
        cleanupRunArtifacts(firstRunId);
        activeRunId = undefined;

        const second = createRun();
        const secondManifestPath = path.join(ROOT, second.manifest_path);
        const secondRun = loadRun(secondManifestPath);
        const registryPath = path.join(secondRun.runRoot, 'registry.json');
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        registry.entries[0].legal_name = 'Tampered registry entry';
        fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
        expect(thrownCode(() => loadRun(secondManifestPath))).toBe('registry_snapshot_changed');
    });

    it('repairs an abort interrupted after its event append without duplicating the event', () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        runState(manifestPath, ['--action', 'transition', '--next-state', 'RUNNING']);
        const interrupted = runTool('abort.mjs', [
            '--run-manifest', manifestPath,
            '--error-code', 'dependency_missing',
            '--reason', 'faulted abort',
            '--operation-id', 'abort-repairable',
            '--fault-at', 'event-after-append'
        ], 20);
        expect(interrupted.error.code).toBe('fault_injected');
        const repaired = runTool('abort.mjs', [
            '--run-manifest', manifestPath,
            '--error-code', 'dependency_missing',
            '--reason', 'faulted abort',
            '--operation-id', 'abort-repairable'
        ]);
        expect(repaired.status).toBe('ABORTED');
        const projection = replayRun(loadRun(manifestPath));
        expect(projection.events.filter((event) => event.operation_id === 'abort-repairable')).toHaveLength(1);
        expect(fs.existsSync(path.join(path.dirname(manifestPath), 'abort.json'))).toBe(true);
    });

    it('rejects corrupted snapshot, publication and pointer artifacts during finalize recovery', () => {
        const first = prepareInterruptedPublication('snapshot');
        const snapshotPath = path.join(PUBLISHED_ROOT, activeRunId, 'snapshot.json');
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        snapshot.entries[0].error_message = 'tampered snapshot';
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
        expect(runTool('finalize.mjs', ['--run-manifest', first.manifestPath], 30).error.code).toBe('publication_hash_mismatch');

        const second = prepareInterruptedPublication('publication');
        const publicationPath = path.join(PUBLISHED_ROOT, activeRunId, 'publication.json');
        const publication = JSON.parse(fs.readFileSync(publicationPath, 'utf8'));
        publication.published_at = '2026-08-06T00:00:00Z';
        fs.writeFileSync(publicationPath, `${JSON.stringify(publication, null, 2)}\n`);
        const publicationFailure = runTool('finalize.mjs', ['--run-manifest', second.manifestPath], 30);
        expect(publicationFailure.error.code).toBe('contract_validation_failed');
        expect(publicationFailure.error.details.contract).toBe('pointer');

        const third = prepareInterruptedPublication('pointer');
        const pointerPath = path.join(PUBLISHED_ROOT, 'current.json');
        const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
        pointer.snapshot_sha256 = '0'.repeat(64);
        fs.writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
        const pointerFailure = runTool('finalize.mjs', ['--run-manifest', third.manifestPath], 30);
        expect(pointerFailure.error.code).toBe('contract_validation_failed');
        expect(pointerFailure.error.details.contract).toBe('pointer');
    });

    it('serializes concurrent event writers and keeps batch event order deterministic', async () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        runState(manifestPath, ['--action', 'transition', '--next-state', 'RUNNING']);
        const concurrent = await Promise.all(['bank-001', 'bank-002', 'bank-003'].map((entryId) => runToolAsync('run-state.mjs', [
            '--run-manifest', manifestPath,
            '--action', 'entry',
            '--entry-id', entryId,
            '--stage', 'fetched',
            '--operation-id', `concurrent-${entryId}`
        ])));
        expect(concurrent).toHaveLength(3);
        const run = loadRun(manifestPath);
        const concurrentProjection = replayRun(run);
        expect([...concurrentProjection.entries.values()].every((entry) => entry.stage === 'fetched')).toBe(true);
        expect(concurrentProjection.events.map((event) => event.sequence)).toEqual(
            Array.from({length: concurrentProjection.events.length}, (_, index) => index + 1)
        );

        const batchPath = path.join(run.runRoot, 'deterministic-batch.json');
        fs.writeFileSync(batchPath, JSON.stringify([
            {action: 'entry', entry_id: 'bank-003', stage: 'normalized', operation_id: 'batch-zeta', origin: 'z.example.test'},
            {action: 'entry', entry_id: 'bank-001', stage: 'normalized', operation_id: 'batch-alpha', origin: 'a.example.test'},
            {action: 'entry', entry_id: 'bank-002', stage: 'normalized', operation_id: 'batch-mu', origin: 'm.example.test'}
        ]));
        runState(manifestPath, ['--action', 'batch', '--operations', batchPath]);
        fs.rmSync(batchPath, {force: true});
        const batchEvents = replayRun(loadRun(manifestPath)).events.slice(-3).map((event) => event.operation_id);
        expect(batchEvents).toEqual(['batch-alpha', 'batch-mu', 'batch-zeta']);
    });

    it('covers T09: finalizes an offline run and recovers after pointer replacement', () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        runState(manifestPath, ['--action', 'transition', '--next-state', 'RUNNING']);
        for (const entryId of ['bank-001', 'bank-002', 'bank-003']) {
            runState(manifestPath, [
                '--action', 'entry', '--entry-id', entryId, '--stage', 'technical_error',
                '--error-code', 'required_source_unavailable', '--error-message', 'offline fixture error',
                '--operation-id', `t09-${entryId}-error`
            ]);
        }
        runState(manifestPath, ['--action', 'transition', '--next-state', 'READY']);
        const firstFinalize = runTool('finalize.mjs', ['--run-manifest', manifestPath, '--fault-at', 'finalize-after-pointer-write'], 20);
        expect(firstFinalize.error.code).toBe('fault_injected');
        const run = loadRun(manifestPath);
        expect(replayRun(run).runState).toBe('FINALIZING');
        expect(JSON.parse(fs.readFileSync(path.join(PUBLISHED_ROOT, 'current.json'), 'utf8')).run_id).toBe(activeRunId);

        const recovered = runTool('finalize.mjs', ['--run-manifest', manifestPath]);
        expect(recovered.run.status).toBe('FINALIZED');
        const snapshotPath = path.join(PUBLISHED_ROOT, activeRunId, 'snapshot.json');
        const publicationPath = path.join(PUBLISHED_ROOT, activeRunId, 'publication.json');
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        const publication = JSON.parse(fs.readFileSync(publicationPath, 'utf8'));
        const pointer = JSON.parse(fs.readFileSync(path.join(PUBLISHED_ROOT, 'current.json'), 'utf8'));
        expect(validateSnapshot(snapshot, {manifest: run.manifest}).valid).toBe(true);
        expect(validatePublicationRecord(publication, {manifest: run.manifest, checkpoint: JSON.parse(fs.readFileSync(run.checkpointPath, 'utf8'))}).valid).toBe(true);
        expect(validatePointer(pointer, {
            manifest: run.manifest,
            publicationRecord: publication,
            publicationSha256: sha256File(publicationPath)
        }).valid).toBe(true);
    });

    it('recovers a complete publication directory when finalize stops before pointer replacement', () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        runState(manifestPath, ['--action', 'transition', '--next-state', 'RUNNING']);
        for (const entryId of ['bank-001', 'bank-002', 'bank-003']) {
            runState(manifestPath, [
                '--action', 'entry', '--entry-id', entryId, '--stage', 'technical_error',
                '--error-code', 'required_source_unavailable', '--error-message', 'offline fixture error',
                '--operation-id', `t09-pre-pointer-${entryId}`
            ]);
        }
        runState(manifestPath, ['--action', 'transition', '--next-state', 'READY']);
        const interrupted = runTool('finalize.mjs', [
            '--run-manifest', manifestPath,
            '--fault-at', 'finalize-after-publication-rename'
        ], 20);
        expect(interrupted.error.code).toBe('fault_injected');
        expect(readOptional(path.join(PUBLISHED_ROOT, 'current.json'))).toBe(pointerBefore);
        const recovered = runTool('finalize.mjs', ['--run-manifest', manifestPath]);
        expect(recovered.run.status).toBe('FINALIZED');
        expect(JSON.parse(fs.readFileSync(path.join(PUBLISHED_ROOT, 'current.json'), 'utf8')).run_id).toBe(activeRunId);
    });

    it('covers T10: aborts without changing the publication pointer', () => {
        const init = createRun();
        const manifestPath = path.join(ROOT, init.manifest_path);
        runState(manifestPath, ['--action', 'transition', '--next-state', 'RUNNING']);
        const aborted = runTool('abort.mjs', [
            '--run-manifest', manifestPath,
            '--error-code', 'dependency_missing',
            '--reason', 'offline dependency preflight'
        ]);
        expect(aborted.status).toBe('ABORTED');
        const run = loadRun(manifestPath);
        expect(replayRun(run).runState).toBe('ABORTED');
        expect(JSON.parse(fs.readFileSync(path.join(run.runRoot, 'abort.json'), 'utf8'))).toMatchObject({
            state: 'ABORTED',
            error_code: 'dependency_missing'
        });
        expect(fs.existsSync(path.join(PUBLISHED_ROOT, activeRunId))).toBe(false);
        expect(readOptional(path.join(PUBLISHED_ROOT, 'current.json'))).toBe(pointerBefore);
    });

    it('keeps the Phase 2 test matrix complete for every production entrypoint', () => {
        const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
        const phase2Tests = matrix.tests.filter((test) => ['T01', 'T02', 'T09', 'T10'].includes(test.test_id));
        expect(phase2Tests.map((test) => test.test_id)).toEqual(['T01', 'T02', 'T09', 'T10']);
        for (const test of phase2Tests) {
            expect(fs.existsSync(path.join(ROOT, '.agents/skills/mortgage-refinancing-scan', test.script))).toBe(true);
            expect(test.artifacts.length).toBeGreaterThan(0);
            expect(test.exit_code).toBe(0);
        }
        expect(fs.existsSync(path.join(TOOLS_ROOT, 'run-init.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(TOOLS_ROOT, 'run-state.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(TOOLS_ROOT, 'finalize.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(TOOLS_ROOT, 'abort.mjs'))).toBe(true);
    });
});

function createRun() {
    if (activeRunId) {
        cleanupRunArtifacts(activeRunId);
        activeRunId = undefined;
    }
    sequence += 1;
    activeRunId = `run-20260806T01${String(sequence).padStart(4, '0')}Z-core${sequence.toString(36).padStart(5, '0')}`;
    return runTool('run-init.mjs', [
        '--registry-snapshot', REGISTRY,
        '--mode', 'full',
        '--live', 'false',
        '--run-root', 'data/mortgage-refinancing-scan/work/runs',
        '--run-id', activeRunId
    ]);
}

function prepareInterruptedPublication(label) {
    const init = createRun();
    const manifestPath = path.join(ROOT, init.manifest_path);
    runState(manifestPath, ['--action', 'transition', '--next-state', 'RUNNING']);
    for (const entryId of ['bank-001', 'bank-002', 'bank-003']) {
        runState(manifestPath, [
            '--action', 'entry', '--entry-id', entryId, '--stage', 'technical_error',
            '--error-code', 'required_source_unavailable', '--error-message', 'offline fixture error',
            '--operation-id', `stabilize-${label}-${entryId}`
        ]);
    }
    runState(manifestPath, ['--action', 'transition', '--next-state', 'READY']);
    const interrupted = runTool('finalize.mjs', [
        '--run-manifest', manifestPath,
        '--fault-at', 'finalize-after-pointer-write'
    ], 20);
    expect(interrupted.error.code).toBe('fault_injected');
    return {manifestPath};
}

function cleanupRunArtifacts(runId) {
    fs.rmSync(path.join(RUNS_ROOT, runId), {recursive: true, force: true});
    fs.rmSync(path.join(PUBLISHED_ROOT, runId), {recursive: true, force: true});
    if (fs.existsSync(PUBLISHED_ROOT)) {
        for (const name of fs.readdirSync(PUBLISHED_ROOT, {withFileTypes: true}).filter((entry) => entry.name.startsWith(`.tmp-${runId}-`))) {
            fs.rmSync(path.join(PUBLISHED_ROOT, name.name), {recursive: true, force: true});
        }
    }
}

function runState(manifestPath, args, expectedCode = 0) {
    return runTool('run-state.mjs', ['--run-manifest', manifestPath, ...args], expectedCode);
}

function runTool(tool, args, expectedCode = 0) {
    const result = spawnSync(process.execPath, [path.join(TOOLS_ROOT, tool), ...args], {
        cwd: ROOT,
        encoding: 'utf8'
    });
    expect(result.error, `${tool} process error`).toBeUndefined();
    expect(result.status, `${tool} stderr: ${result.stderr}`).toBe(expectedCode);
    const output = (expectedCode === 0 ? result.stdout : result.stderr).trim();
    return output ? JSON.parse(output) : {};
}

function runToolAsync(tool, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(TOOLS_ROOT, tool), ...args], {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (status) => {
            if (status !== 0) {
                reject(new Error(`${tool} exited ${status}: ${stderr}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function thrownCode(callback) {
    try {
        callback();
    } catch (error) {
        return error.code;
    }
    return null;
}

function readOptional(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function restoreOptional(filePath, content) {
    if (content === null) {
        fs.rmSync(filePath, {force: true});
    } else {
        fs.mkdirSync(path.dirname(filePath), {recursive: true});
        fs.writeFileSync(filePath, content, 'utf8');
    }
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
