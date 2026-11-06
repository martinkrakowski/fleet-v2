import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OrchestratorRequest,
  type OrchestratorRequestResult,
} from '../../../domain/entities/OrchestratorRequest.js';
import type { OrchestratorRequestRecord } from '../../../domain/orchestrator-request-records.js';
import type { ChangeSignal, ChangeSignalPort } from '../../../application/ports/out/ChangeSignalPort.out-port.js';
import type { OrchestratorRequestListQuery } from '../../../application/ports/out/OrchestratorRequestRepositoryPort.out-port.js';
import { MAX_ORCHESTRATOR_REQUEST_STORE_RECORDS } from '../../../application/ports/out/OrchestratorRequestRepositoryPort.out-port.js';
import {
  inspectVersionedRecordListBytes,
  StateFileUnknownVersionError,
  withFileLock,
} from '../file-store.js';
import type { OrchestratorRequestRepositoryAdapterOptions } from '../OrchestratorRequestRepositoryAdapter.adapter.js';
import {
  OrchestratorRequestRepositoryAdapter,
  parseOrchestratorRequestStateRecord,
  parseVersionedOrchestratorRequestStateRecord,
} from '../OrchestratorRequestRepositoryAdapter.adapter.js';

const R1 = '01JB0000000000000000000000';
const R2 = '01JB0000000000000000000001';
const R3 = '01JB0000000000000000000002';
const R4 = '01JB0000000000000000000003';

function ulid(n: number): string {
  return `01JB${String(n).padStart(22, '0')}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The initial queued shape the tests save at revision 1. */
function initialRequest(
  requestId: string,
  overrides: Partial<OrchestratorRequestRecord> = {},
): OrchestratorRequestRecord {
  return {
    requestId,
    revision: 1,
    kind: 'dispatch-attempt',
    projectId: 'example-project',
    target: { attemptId: 'attempt-example-1' },
    requestedBy: { via: 'web', sessionId: 'session-example-1' },
    createdAtIso: '2026-10-27T10:00:00.000Z',
    expiresAtIso: '2026-10-27T10:30:00.000Z',
    updatedAtIso: '2026-10-27T10:00:00.000Z',
    state: 'queued',
    fence: 0,
    claimCount: 0,
    claim: null,
    deferredUntilIso: null,
    reason: null,
    linked: null,
    ...overrides,
  };
}

/** Narrow the domain result union; a genuine failure is a test bug. */
function mustSucceed(result: OrchestratorRequestResult): OrchestratorRequest {
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function claimed(
  record: OrchestratorRequestRecord,
  orchestratorId = 'orch-example-1',
  nowIso = '2026-10-27T10:01:00.000Z',
): OrchestratorRequestRecord {
  return mustSucceed(
    mustSucceed(OrchestratorRequest.create(record)).claim(
      { orchestratorId, expectedRevision: record.revision },
      nowIso,
    ),
  ).toRecord();
}

function renewed(record: OrchestratorRequestRecord, nowIso = '2026-10-27T10:02:00.000Z'): OrchestratorRequestRecord {
  const claim = record.claim!;
  return mustSucceed(
    mustSucceed(OrchestratorRequest.create(record)).renewClaim(
      { orchestratorId: claim.orchestratorId, fence: claim.fence, expectedRevision: record.revision },
      nowIso,
    ),
  ).toRecord();
}

function dispatched(record: OrchestratorRequestRecord): OrchestratorRequestRecord {
  const claim = record.claim!;
  const attemptId = 'attemptId' in record.target ? record.target.attemptId : 'attempt-example-1';
  return mustSucceed(
    mustSucceed(OrchestratorRequest.create(record)).complete(
      { orchestratorId: claim.orchestratorId, fence: claim.fence, expectedRevision: record.revision },
      { attemptId, journalKey: `request/${record.requestId}` },
      '2026-10-27T10:02:30.000Z',
    ),
  ).toRecord();
}

class RecordingChangeSignalPort implements ChangeSignalPort {
  readonly emitted: ChangeSignal[] = [];
  throwOnEmit = false;

  emit(signal: ChangeSignal): void {
    if (this.throwOnEmit) {
      throw new Error('signal emit failed on purpose');
    }
    this.emitted.push(signal);
  }
}

describe('OrchestratorRequestRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-orchestrator-request-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('never throws on malformed runtime inputs, sparse arrays, unknown enums, or throwing getters across save, get, list, and state parsers', async () => {
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });

    expect(await adapter.save(null as unknown as OrchestratorRequestRecord, 0)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: null,
    });
    expect(await adapter.save('nope' as unknown as OrchestratorRequestRecord, 0)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: null,
    });
    expect(await adapter.save(initialRequest(R1), Number.NaN)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: null,
    });
    expect(await adapter.save(initialRequest(R1), 1.5)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: null,
    });
    expect(await adapter.save(initialRequest(R1), -1)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: null,
    });
    expect(await adapter.save(initialRequest(R2), 0, { lockTimeoutMs: 0 } as never)).toMatchObject({
      outcome: 'refused',
      code: 'invalid-input',
    });
    expect(await adapter.save(initialRequest(R2), 0, { lockTimeoutMs: 61_000 } as never)).toMatchObject({
      outcome: 'refused',
      code: 'invalid-input',
    });
    expect(await adapter.save(initialRequest(R2), 0, { unexpected: 1 } as never)).toMatchObject({
      outcome: 'refused',
      code: 'invalid-input',
    });
    expect(await adapter.save(initialRequest(R2), 0, [] as never)).toMatchObject({
      outcome: 'refused',
      code: 'invalid-input',
    });
    expect(await adapter.save(initialRequest(R2, { revision: 2 }), 0)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: R2,
    });

    expect(await adapter.get(null as unknown as string)).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(await adapter.get('short')).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(await adapter.get(123 as unknown as string)).toEqual({ outcome: 'refused', code: 'invalid-input' });

    expect(await adapter.list({ state: 'bogus' } as never)).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(await adapter.list({ kind: 'bogus' } as never)).toEqual({ outcome: 'refused', code: 'invalid-input' });
    const sparseStates: string[] = [];
    sparseStates[1] = 'queued';
    expect(await adapter.list({ states: sparseStates } as never)).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(await adapter.list({ states: ['queued', 'bogus'] } as never)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
    });
    expect(await adapter.list({ limit: 0 })).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(await adapter.list({ limit: 1001 })).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(await adapter.list({ projectId: '' })).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(await adapter.list(null as unknown as OrchestratorRequestListQuery)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
    });

    const hostileRecord: Record<string, unknown> = {};
    Object.defineProperty(hostileRecord, 'requestId', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(await adapter.save(hostileRecord as unknown as OrchestratorRequestRecord, 0)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: null,
    });

    const hostileQuery: Record<string, unknown> = {};
    Object.defineProperty(hostileQuery, 'projectId', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(await adapter.list(hostileQuery as unknown as OrchestratorRequestListQuery)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
    });

    const hostileOptions: Record<string, unknown> = {};
    Object.defineProperty(hostileOptions, 'lockTimeoutMs', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    expect(await adapter.save(initialRequest(R1), 0, hostileOptions as never)).toEqual({
      outcome: 'refused',
      code: 'invalid-input',
      requestId: null,
    });

    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    expect(parseVersionedOrchestratorRequestStateRecord(throwingProxy)).toEqual({ status: 'invalid' });
    expect(parseOrchestratorRequestStateRecord(throwingProxy)).toBeUndefined();
    expect(parseVersionedOrchestratorRequestStateRecord(null)).toEqual({ status: 'invalid' });
    expect(parseOrchestratorRequestStateRecord('x')).toBeUndefined();
  });

  it('guards save with lockTimeoutMs and leaves prior store state intact when a lock times out', async () => {
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(initialRequest(R1), 0);
    const storePath = path.join(tempDir, 'orchestrator-requests.json');
    const lockPath = `${storePath}.lock`;
    const before = await fs.readFile(storePath, 'utf8');

    await withFileLock(lockPath, async () => {
      const result = await adapter.save(claimed(initialRequest(R1)), 1, { lockTimeoutMs: 50 });
      expect(result).toEqual({ outcome: 'refused', code: 'lock-timeout', requestId: R1 });
    });

    expect(await fs.readFile(storePath, 'utf8')).toBe(before);
    expect((await adapter.get(R1))!.outcome).toBe('found');
  });

  it('is idempotent on crash-retry of identical creation or transition and refuses competing CAS writes with revision-conflict', async () => {
    const storePath = path.join(tempDir, 'orchestrator-requests.json');
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });

    expect(await adapter.save(initialRequest(R1), 0)).toMatchObject({ outcome: 'saved' });

    expect(await adapter.save(initialRequest(R1), 0)).toEqual({ outcome: 'unchanged', request: initialRequest(R1) });

    const next = claimed(initialRequest(R1));
    const transitioned = await adapter.save(next, 1);
    expect(transitioned).toMatchObject({ outcome: 'saved' });
    expect((transitioned as { request: OrchestratorRequestRecord }).request.revision).toBe(2);

    expect(await adapter.save(next, 1)).toEqual({ outcome: 'unchanged', request: next });

    await adapter.save(initialRequest(R2), 0);
    const rival = initialRequest(R2, { target: { attemptId: 'attempt-example-2' } });
    expect(await adapter.save(rival, 0)).toEqual({
      outcome: 'refused',
      code: 'revision-conflict',
      requestId: R2,
      currentRevision: 1,
      attemptedRevision: 1,
    });

    const parsed = JSON.parse(await fs.readFile(storePath, 'utf8')) as Array<{ requestId: string; revision: number }>;
    expect(parsed.filter((item) => item.requestId === R1)).toHaveLength(1);
    expect(parsed.filter((item) => item.requestId === R2)).toHaveLength(1);
  });

  it('reports unreadable files, duplicate ids, unknown schemaVersion, and I/O read failures as unknown without returning empty or missing', async () => {
    const storePath = path.join(tempDir, 'orchestrator-requests.json');
    const quarantineDir = path.join(tempDir, 'quarantine');
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });

    expect(await adapter.get(R1)).toEqual({ outcome: 'missing' });
    expect(await adapter.list()).toEqual({ outcome: 'ok', requests: [], truncated: false });

    await fs.writeFile(storePath, '{ nope');
    expect(await adapter.get(R1)).toEqual({ outcome: 'unknown', code: 'unreadable-store' });
    expect(await adapter.list()).toEqual({ outcome: 'unknown', code: 'unreadable-store' });
    expect((await fs.readdir(quarantineDir)).length).toBeGreaterThan(0);

    await fs.rm(quarantineDir, { recursive: true, force: true });
    await fs.writeFile(storePath, '{}');
    expect(await adapter.list()).toEqual({ outcome: 'unknown', code: 'unreadable-store' });

    await fs.rm(quarantineDir, { recursive: true, force: true });
    await fs.writeFile(storePath, JSON.stringify([{ nope: true }]));
    expect(await adapter.list()).toEqual({ outcome: 'unknown', code: 'unreadable-store' });

    await fs.rm(quarantineDir, { recursive: true, force: true });
    await fs.writeFile(
      storePath,
      JSON.stringify([
        initialRequest(R1),
        { ...initialRequest(R1), updatedAtIso: '2026-10-27T10:00:01.000Z' },
      ]),
    );
    expect(await adapter.list()).toEqual({ outcome: 'unknown', code: 'unreadable-store' });

    await fs.rm(quarantineDir, { recursive: true, force: true });
    await fs.writeFile(storePath, JSON.stringify([{ ...initialRequest(R1), schemaVersion: 2 }]));
    expect(await adapter.list()).toEqual({ outcome: 'unknown', code: 'unknown-schema-version' });
    expect(await adapter.get(R1)).toEqual({ outcome: 'unknown', code: 'unknown-schema-version' });
    expect(await fileExists(quarantineDir)).toBe(false);

    await fs.rm(storePath, { force: true });
    await fs.mkdir(storePath);
    expect(await adapter.list()).toEqual({ outcome: 'unknown', code: 'io-error', errorCode: 'EISDIR' });
  });

  it('echoes neither filesystem paths nor secret-shaped input values in any refusal, unknown outcome, or unknown-version error', async () => {
    const secret = ['gh', 'p_', 'A'.repeat(36)].join('');
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });

    const refused = await adapter.save(initialRequest(R1, { projectId: secret }), 0);
    expect(refused).toEqual({ outcome: 'refused', code: 'invalid-input', requestId: null });
    expect(JSON.stringify(refused)).not.toContain(secret);
    expect(JSON.stringify(refused)).not.toContain(tempDir);

    const refusedList = await adapter.list({ projectId: secret });
    expect(refusedList).toEqual({ outcome: 'refused', code: 'invalid-input' });
    expect(JSON.stringify(refusedList)).not.toContain(secret);

    const hidden = new StateFileUnknownVersionError(path.join(tempDir, 'orchestrator-requests.json'), 0);
    expect(hidden.message).not.toContain(tempDir);
    expect(hidden.message).not.toContain(secret);
    expect(hidden.detail).toContain('unknown-schema-version');
  });

  it('bounds store byte/record inspection and truncates list results at limit', async () => {
    const parse = (raw: unknown) => parseVersionedOrchestratorRequestStateRecord(raw);
    const bytes = Buffer.from(JSON.stringify([initialRequest(R1)]));
    const oversized = inspectVersionedRecordListBytes(bytes, parse, { maxBytes: 10 });
    expect(oversized).toEqual({ status: 'unreadable', detail: 'store exceeds maximum byte size', recordIndex: null });

    const many = Array.from({ length: MAX_ORCHESTRATOR_REQUEST_STORE_RECORDS + 1 }, (_, index) =>
      initialRequest(ulid(index)),
    );
    const tooMany = inspectVersionedRecordListBytes(Buffer.from(JSON.stringify(many)), parse, {
      maxRecords: MAX_ORCHESTRATOR_REQUEST_STORE_RECORDS,
    });
    expect(tooMany).toEqual({ status: 'unreadable', detail: 'store exceeds maximum record count', recordIndex: null });

    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });
    for (let index = 0; index < 5; index += 1) {
      await adapter.save(initialRequest(ulid(index)), 0);
    }
    const truncated = await adapter.list({ limit: 2 });
    if (truncated.outcome !== 'ok') {
      throw new Error('unexpected');
    }
    expect(truncated.requests).toHaveLength(2);
    expect(truncated.truncated).toBe(true);
    const full = await adapter.list();
    if (full.outcome !== 'ok') {
      throw new Error('unexpected');
    }
    expect(full.requests).toHaveLength(5);
    expect(full.truncated).toBe(false);
  });

  it('persists schemaVersion 1 to orchestrator-requests.json, accepts omitted schemaVersion as 1, and round-trips with a fresh adapter', async () => {
    const storePath = path.join(tempDir, 'orchestrator-requests.json');
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(initialRequest(R1), 0);
    await adapter.save(initialRequest(R2), 0);

    const parsed = JSON.parse(await fs.readFile(storePath, 'utf8')) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    for (const entry of parsed) {
      expect(entry.schemaVersion).toBe(1);
    }
    expect((parsed[0] as { requestId: string }).requestId).toBe(R1);

    const other = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });
    expect(await other.get(R1)).toEqual({ outcome: 'found', request: initialRequest(R1) });
    expect((await other.list())!).toMatchObject({ outcome: 'ok', truncated: false });

    await fs.writeFile(storePath, JSON.stringify([initialRequest(R1)]));
    expect(parseVersionedOrchestratorRequestStateRecord(initialRequest(R1))).toEqual({
      status: 'ok',
      record: initialRequest(R1),
      schemaVersion: 1,
    });
    expect(await other.get(R1)).toEqual({ outcome: 'found', request: initialRequest(R1) });
  });

  it('returns defensive copies from save, get, and list so caller mutation cannot alter stored target, claim, or outcome links', async () => {
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });
    const saved = await adapter.save(initialRequest(R1), 0);
    if (saved.outcome !== 'saved') {
      throw new Error('unexpected');
    }
    (saved.request.target as { attemptId: string }).attemptId = 'tampered';
    (saved.request.requestedBy as { sessionId: string }).sessionId = 'tampered';

    const transitioned = await adapter.save(claimed(initialRequest(R1)), 1);
    if (transitioned.outcome !== 'saved') {
      throw new Error('unexpected');
    }
    (transitioned.request.claim as { orchestratorId: string }).orchestratorId = 'tampered';

    const got = await adapter.get(R1);
    if (got.outcome !== 'found') {
      throw new Error('unexpected');
    }
    expect(got.request.target).toEqual({ attemptId: 'attempt-example-1' });
    expect(got.request.requestedBy.sessionId).toBe('session-example-1');
    expect(got.request.claim!.orchestratorId).toBe('orch-example-1');

    const listed = await adapter.list();
    if (listed.outcome !== 'ok') {
      throw new Error('unexpected');
    }
    (listed.requests[0]!.claim as { orchestratorId: string }).orchestratorId = 'tampered-list';
    const after = await adapter.get(R1);
    if (after.outcome !== 'found') {
      throw new Error('unexpected');
    }
    expect(after.request.claim!.orchestratorId).toBe('orch-example-1');
  });

  it('sorts list results by createdAtIso then requestId and combines projectId, state, states, and kind filters', async () => {
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });

    await adapter.save(
      initialRequest(R1, {
        createdAtIso: '2026-10-27T10:00:00.000Z',
        expiresAtIso: '2026-10-27T10:30:00.000Z',
      }),
      0,
    );
    await adapter.save(
      initialRequest(R2, {
        createdAtIso: '2026-10-27T09:00:00.000Z',
        expiresAtIso: '2026-10-27T09:30:00.000Z',
      }),
      0,
    );
    await adapter.save(
      initialRequest(R3, {
        kind: 'prepare-fix',
        target: { attemptId: 'attempt-example-3' },
        projectId: 'other-project',
        createdAtIso: '2026-10-27T10:00:00.000Z',
        expiresAtIso: '2026-10-27T10:30:00.000Z',
      }),
      0,
    );
    const r4Base = initialRequest(R4, {
      kind: 'resume-run',
      target: { runId: 'run-example-4' },
      createdAtIso: '2026-10-27T08:00:00.000Z',
      expiresAtIso: '2026-10-27T08:30:00.000Z',
    });
    await adapter.save(r4Base, 0);
    await adapter.save(
      {
        ...r4Base,
        revision: 2,
        state: 'deferred',
        claim: null,
        deferredUntilIso: '2026-10-27T08:20:00.000Z',
        reason: { reasonKind: 'policy', detail: null },
        updatedAtIso: '2026-10-27T08:05:00.000Z',
      },
      1,
    );
    await adapter.save(claimed(initialRequest(R3, { kind: 'prepare-fix', target: { attemptId: 'attempt-example-3' }, projectId: 'other-project' })), 1);

    const ids = (result: Awaited<ReturnType<OrchestratorRequestRepositoryAdapter['list']>>): string[] => {
      if (result.outcome !== 'ok') {
        throw new Error('unexpected');
      }
      return result.requests.map((request) => request.requestId);
    };

    expect(ids(await adapter.list())).toEqual([R4, R2, R1, R3]);
    expect(ids(await adapter.list({ projectId: 'example-project' }))).toEqual([R4, R2, R1]);
    expect(ids(await adapter.list({ state: 'queued' }))).toEqual([R2, R1]);
    expect(ids(await adapter.list({ states: ['queued', 'claimed'] }))).toEqual([R2, R1, R3]);
    expect(ids(await adapter.list({ state: 'deferred' }))).toEqual([R4]);
    expect(ids(await adapter.list({ kind: 'dispatch-attempt' }))).toEqual([R2, R1]);
    expect(
      ids(await adapter.list({ projectId: 'example-project', states: ['queued'], kind: 'dispatch-attempt' })),
    ).toEqual([R2, R1]);
  });

  it('emits request change signals on open and every state transition, emits nothing on claim lease renewal or unchanged retry, and survives throwing signal ports', async () => {
    const signalPort = new RecordingChangeSignalPort();
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir, changeSignal: signalPort });

    await adapter.save(initialRequest(R1), 0);
    expect(signalPort.emitted.map((signal) => signal.kind)).toEqual(['request']);
    expect(signalPort.emitted.at(-1)!.id).toBe(R1);
    expect(signalPort.emitted.at(-1)!.stateFile).toBe(path.resolve(path.join(tempDir, 'orchestrator-requests.json')));

    const next = claimed(initialRequest(R1));
    await adapter.save(next, 1);
    expect(signalPort.emitted.at(-1)!.kind).toBe('request');

    await adapter.save(renewed(next), 2);
    expect(signalPort.emitted).toHaveLength(2);

    await adapter.save(initialRequest(R1), 0);
    expect(signalPort.emitted).toHaveLength(2);

    await adapter.save(dispatched(renewed(next)), 3);
    expect(signalPort.emitted).toHaveLength(3);

    const throwingPort = new RecordingChangeSignalPort();
    throwingPort.throwOnEmit = true;
    const throwingAdapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir, changeSignal: throwingPort });
    const result = await throwingAdapter.save(initialRequest(R2), 0);
    expect(result.outcome).toBe('saved');
    expect(throwingAdapter.signalEmitFailures).toBe(1);
  });

  it('refuses mutating immutable creation fields, decreasing fence or claimCount, or transitioning out of a terminal state', async () => {
    const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(initialRequest(R1), 0);
    const next = claimed(initialRequest(R1));
    await adapter.save(next, 1);

    const refused = async (record: OrchestratorRequestRecord): Promise<void> => {
      expect(await adapter.save(record, 2)).toMatchObject({
        outcome: 'refused',
        code: 'immutable-field-changed',
      });
    };

    await refused({ ...next, revision: 3, kind: 'prepare-fix', target: { attemptId: 'attempt-example-2' } });
    await refused({ ...next, revision: 3, projectId: 'other-project' });
    await refused({ ...next, revision: 3, target: { attemptId: 'attempt-example-9' } });
    await refused({ ...next, revision: 3, requestedBy: { via: 'web', sessionId: 'other-session' } });
    await refused({
      ...next,
      revision: 3,
      createdAtIso: '2026-10-27T10:05:00.000Z',
      expiresAtIso: '2026-10-27T10:35:00.000Z',
      updatedAtIso: '2026-10-27T10:06:00.000Z',
    });
    await refused({ ...next, revision: 3, expiresAtIso: '2026-10-27T10:20:00.000Z' });
    await refused({ ...next, revision: 3, state: 'queued', fence: 0, claimCount: 0, claim: null });

    const done = dispatched(next);
    expect(await adapter.save(done, 2)).toMatchObject({ outcome: 'saved' });
    expect(
      await adapter.save({ ...done, revision: 4, updatedAtIso: '2026-10-27T10:06:00.000Z' }, 3),
    ).toEqual({ outcome: 'refused', code: 'terminal-state', requestId: R1 });
  });

  it('honors readOnly mode by refusing saves without locking and reporting unreadable files as unknown without quarantining', async () => {
    const storePath = path.join(tempDir, 'orchestrator-requests.json');
    await fs.writeFile(storePath, '{ nope');
    const readOnly = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir, readOnly: true });

    const before = await fs.readdir(tempDir);
    expect(await readOnly.save(initialRequest(R1), 0)).toEqual({
      outcome: 'refused',
      code: 'read-only',
      requestId: null,
    });
    expect(await fs.readdir(tempDir)).toEqual(before);

    expect(await readOnly.list()).toEqual({ outcome: 'unknown', code: 'unreadable-store' });
    expect(await readOnly.get(R1)).toEqual({ outcome: 'unknown', code: 'unreadable-store' });
    expect(await fileExists(path.join(tempDir, 'quarantine'))).toBe(false);
  });

  it('refuses colliding or unsafe store file names with invalid-store-config', async () => {
    for (const fileName of ['owner-questions.json', '../x.json', '.', '..', 'a/b.json']) {
      const adapter = new OrchestratorRequestRepositoryAdapter({ stateDir: tempDir, fileName });
      expect(await adapter.save(initialRequest(R1), 0)).toEqual({
        outcome: 'refused',
        code: 'invalid-store-config',
        requestId: null,
      });
      expect(await adapter.get(R1)).toEqual({ outcome: 'refused', code: 'invalid-store-config' });
      expect(await adapter.list()).toEqual({ outcome: 'refused', code: 'invalid-store-config' });
    }

    const nonStringStateDir = new OrchestratorRequestRepositoryAdapter({ stateDir: 42 as unknown as string });
    expect(await nonStringStateDir.save(initialRequest(R1), 0)).toEqual({
      outcome: 'refused',
      code: 'invalid-store-config',
      requestId: null,
    });

    const hostileOptionsProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    const hostile = new OrchestratorRequestRepositoryAdapter(
      hostileOptionsProxy as unknown as OrchestratorRequestRepositoryAdapterOptions,
    );
    expect(await hostile.save(initialRequest(R1), 0)).toEqual({
      outcome: 'refused',
      code: 'invalid-store-config',
      requestId: null,
    });
  });
});
