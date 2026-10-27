import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OrchestratorSession,
  type OrchestratorSessionResult,
} from '../../../domain/entities/OrchestratorSession.js';
import type { OrchestratorSessionRecord } from '../../../domain/orchestrator-session-records.js';
import { OrchestratorSessionRevisionConflictError } from '../../../application/ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type { ChangeSignal, ChangeSignalPort } from '../../../application/ports/out/ChangeSignalPort.out-port.js';
import { StateFileUnreadableError } from '../file-store.js';
import {
  OrchestratorSessionRepositoryAdapter,
  parseOrchestratorSessionStateRecord,
} from '../OrchestratorSessionRepositoryAdapter.adapter.js';

/** O1a's VALID shape; overrides are spread last so tests can tweak one field. */
function session(overrides: Partial<OrchestratorSessionRecord> = {}): OrchestratorSessionRecord {
  return {
    orchestratorId: 'orch-example-1',
    cliKind: 'claude-code',
    model: 'example-provider/example-model',
    host: 'example-host',
    projects: ['example-project'],
    claims: ['dispatch-attempt', 'prepare-fix'],
    scopes: ['message', 'orchestrate'],
    startedAtIso: '2026-10-27T10:00:00.000Z',
    lastHeartbeatIso: '2026-10-27T10:00:30.000Z',
    leaseUntilIso: '2026-10-27T10:02:00.000Z',
    lastPolledRequestsAtIso: null,
    status: 'active',
    ...overrides,
  };
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

/** Narrow the domain result union; a genuine failure is a test bug. */
function mustSucceed(result: OrchestratorSessionResult): OrchestratorSession {
  if (!result.success) {
    throw new Error(result.error.message);
  }
  return result.value;
}

describe('OrchestratorSessionRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-orchestrator-session-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips saves in memory with revision arithmetic and conflict errors', async () => {
    const adapter = new OrchestratorSessionRepositoryAdapter();
    const stored = await adapter.save(session(), 0);
    expect(stored).toEqual({ revision: 1, session: session() });
    expect(await adapter.get('orch-example-1')).toEqual(stored);

    const second = await adapter.save(session(), 1);
    expect(second.revision).toBe(2);

    try {
      await adapter.save(session(), 0);
      throw new Error('expected a revision conflict');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(OrchestratorSessionRevisionConflictError);
      const conflict = error as OrchestratorSessionRevisionConflictError;
      expect(conflict.orchestratorId).toBe('orch-example-1');
      expect(conflict.attemptedRevision).toBe(1);
      expect(conflict.message).not.toContain('orch-example-1');
      expect(conflict.message).not.toContain('example-host');
    }

    expect(await adapter.get('missing')).toBeNull();
  });

  it('returns fresh copies that cannot mutate the store', async () => {
    const adapter = new OrchestratorSessionRepositoryAdapter();
    await adapter.save(session(), 0);
    const listed = await adapter.list();
    (listed[0]!.session.projects as string[]).push('tampered');
    (listed[0]!.session.claims as string[]).push('resume-run');
    (listed[0]!.session.scopes as string[]).push('tail');
    const after = await adapter.get('orch-example-1');
    expect(after?.session.projects).toEqual(['example-project']);
    expect(after?.session.claims).toEqual(['dispatch-attempt', 'prepare-fix']);
    expect(after?.session.scopes).toEqual(['message', 'orchestrate']);
  });

  it('persists to orchestrators.json and reads it back with a fresh adapter', async () => {
    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(session(), 0);

    const filePath = path.join(tempDir, 'orchestrators.json');
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Array<{
      revision: number;
      session: OrchestratorSessionRecord;
    }>;
    expect(parsed).toEqual([{ revision: 1, session: session() }]);

    const other = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir });
    expect(await other.get('orch-example-1')).toEqual({ revision: 1, session: session() });

    const entries = await fs.readdir(tempDir);
    expect(entries.filter((name) => name.endsWith('.tmp') || name.endsWith('.lock'))).toEqual([]);
  });

  it('lists sorted by startedAtIso then id, and filters by status', async () => {
    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir });
    await adapter.save(
      session({ orchestratorId: 'orch-example-1', startedAtIso: '2026-10-27T10:00:00.000Z' }),
      0,
    );
    await adapter.save(
      session({ orchestratorId: 'orch-example-2', startedAtIso: '2026-10-27T09:00:00.000Z' }),
      0,
    );
    await adapter.save(
      session({
        orchestratorId: 'orch-example-3',
        startedAtIso: '2026-10-27T08:00:00.000Z',
        status: 'retired',
      }),
      0,
    );

    const listed = await adapter.list();
    expect(listed.map((stored) => stored.session.orchestratorId)).toEqual([
      'orch-example-3',
      'orch-example-2',
      'orch-example-1',
    ]);
    const retired = await adapter.list({ status: 'retired' });
    expect(retired.map((stored) => stored.session.orchestratorId)).toEqual(['orch-example-3']);
  });

  it('emits orchestrator for a new session and heartbeat for lease/poll renewals', async () => {
    const signalPort = new RecordingChangeSignalPort();
    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir, changeSignal: signalPort });

    await adapter.save(session(), 0);
    let signal = signalPort.emitted.at(-1)!;
    expect(signal.kind).toBe('orchestrator');
    expect(signal.id).toBe('orch-example-1');
    expect(signal.stateFile).toBe(path.resolve(path.join(tempDir, 'orchestrators.json')));
    expect(signal.before).toBeNull();
    expect(signal.written).not.toBeNull();

    let current = (await adapter.get('orch-example-1'))!;
    const renewed = mustSucceed(mustSucceed(OrchestratorSession.create(current.session)).renewLease('2026-10-27T10:05:00.000Z')).toRecord();
    await adapter.save(renewed, current.revision);
    signal = signalPort.emitted.at(-1)!;
    expect(signal.kind).toBe('heartbeat');

    current = (await adapter.get('orch-example-1'))!;
    const polled = mustSucceed(mustSucceed(OrchestratorSession.create(current.session)).recordRequestsPoll('2026-10-27T10:06:00.000Z')).toRecord();
    await adapter.save(polled, current.revision);
    signal = signalPort.emitted.at(-1)!;
    expect(signal.kind).toBe('heartbeat');

    current = (await adapter.get('orch-example-1'))!;
    const retired = mustSucceed(mustSucceed(OrchestratorSession.create(current.session)).retire('2026-10-27T10:07:00.000Z')).toRecord();
    await adapter.save(retired, current.revision);
    signal = signalPort.emitted.at(-1)!;
    expect(signal.kind).toBe('orchestrator');
  });

  it('emits orchestrator when claims or host change', async () => {
    const signalPort = new RecordingChangeSignalPort();
    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir, changeSignal: signalPort });
    const base = session({ orchestratorId: 'orch-example-2', startedAtIso: '2026-10-27T09:00:00.000Z' });
    await adapter.save(base, 0);

    let current = (await adapter.get('orch-example-2'))!;
    await adapter.save({ ...base, claims: ['dispatch-attempt'] }, current.revision);
    expect(signalPort.emitted.at(-1)!.kind).toBe('orchestrator');

    current = (await adapter.get('orch-example-2'))!;
    await adapter.save({ ...base, host: 'another-host' }, current.revision);
    expect(signalPort.emitted.at(-1)!.kind).toBe('orchestrator');
  });

  it('emits the same kinds in memory with stateFile null', async () => {
    const signalPort = new RecordingChangeSignalPort();
    const adapter = new OrchestratorSessionRepositoryAdapter({ changeSignal: signalPort });

    await adapter.save(session(), 0);
    let signal = signalPort.emitted.at(-1)!;
    expect(signal.kind).toBe('orchestrator');
    expect(signal.stateFile).toBeNull();

    const current = (await adapter.get('orch-example-1'))!;
    const renewed = mustSucceed(mustSucceed(OrchestratorSession.create(current.session)).renewLease('2026-10-27T10:05:00.000Z')).toRecord();
    await adapter.save(renewed, current.revision);
    signal = signalPort.emitted.at(-1)!;
    expect(signal.kind).toBe('heartbeat');
    expect(signal.stateFile).toBeNull();
  });

  it('keeps the save successful when a signal port throws', async () => {
    const signalPort = new RecordingChangeSignalPort();
    signalPort.throwOnEmit = true;
    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir, changeSignal: signalPort });

    await adapter.save(session({ orchestratorId: 'orch-throw' }), 0);
    expect(adapter.signalEmitFailures).toBe(1);
    expect((await adapter.get('orch-throw'))?.revision).toBe(1);
  });

  it('parses only plain { revision, session } entries and never throws', () => {
    expect(parseOrchestratorSessionStateRecord(null)).toBeUndefined();
    expect(parseOrchestratorSessionStateRecord([])).toBeUndefined();
    expect(parseOrchestratorSessionStateRecord({ revision: 1 })).toBeUndefined();
    expect(parseOrchestratorSessionStateRecord({ revision: 0, session: session() })).toBeUndefined();
    expect(parseOrchestratorSessionStateRecord({ revision: 1, session: session(), extra: 1 })).toBeUndefined();
    expect(
      parseOrchestratorSessionStateRecord({ revision: 1, session: { ...session(), status: 'expired' } }),
    ).toBeUndefined();

    const withThrowingGetter: Record<string, unknown> = {};
    Object.defineProperty(withThrowingGetter, 'revision', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    Object.defineProperty(withThrowingGetter, 'session', { value: session(), enumerable: true });
    expect(parseOrchestratorSessionStateRecord(withThrowingGetter)).toBeUndefined();

    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(parseOrchestratorSessionStateRecord(throwingProxy)).toBeUndefined();

    expect(parseOrchestratorSessionStateRecord({ revision: 1, session: session() })).toEqual({
      revision: 1,
      session: session(),
    });
  });

  it('quarantines a file holding one invalid entry', async () => {
    await fs.writeFile(
      path.join(tempDir, 'orchestrators.json'),
      JSON.stringify([{ revision: 1 }]),
      'utf8',
    );
    const adapter = new OrchestratorSessionRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.list()).rejects.toBeInstanceOf(StateFileUnreadableError);
    const quarantineDir = path.join(tempDir, 'quarantine');
    const entries = await fs.readdir(quarantineDir);
    expect(entries).toHaveLength(1);
  });

  it('refuses file names that collide with another store or are unsafe', async () => {
    const colliding = new OrchestratorSessionRepositoryAdapter({
      stateDir: tempDir,
      fileName: 'owner-questions.json',
    });
    await expect(colliding.list()).rejects.toThrow(/collides with another store/);

    const escaping = new OrchestratorSessionRepositoryAdapter({
      stateDir: tempDir,
      fileName: '../x.json',
    });
    await expect(escaping.list()).rejects.toThrow(/unsafe state file name/);
  });

  it('refuses an expected revision whose successor would not be a safe integer', async () => {
    const adapter = new OrchestratorSessionRepositoryAdapter();
    await expect(adapter.save(session(), Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      /expected revision must be a non-negative integer/,
    );
  });
});
