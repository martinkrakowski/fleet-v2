import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OwnerQuestionRecord } from '../../domain/owner-question-records.js';
import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { OwnerQuestionRepositoryAdapter } from './OwnerQuestionRepositoryAdapter.adapter.js';
import { ProjectProfileRepositoryAdapter } from './ProjectProfileRepositoryAdapter.adapter.js';
import { StateFileUnreadableError, writeJsonAtomically } from './file-store.js';

class RecordingChangeSignalPort implements ChangeSignalPort {
  readonly signals: ChangeSignal[] = [];
  readonly lockHeldAtEmit: (boolean | null)[] = [];

  private readonly lockPath?: string;

  constructor(lockPath?: string) {
    this.lockPath = lockPath;
  }

  emit(signal: ChangeSignal): void {
    this.signals.push(signal);
    this.lockHeldAtEmit.push(this.lockPath === undefined ? null : existsSync(this.lockPath));
  }

  clear(): void {
    this.signals.length = 0;
  }
}

class ThrowingChangeSignalPort implements ChangeSignalPort {
  emit(_signal: ChangeSignal): void {
    throw new Error('signal emit failed');
  }
}

function makeOwnerQuestion(overrides: Partial<OwnerQuestionRecord> = {}): OwnerQuestionRecord {
  return {
    questionId: 'q-1',
    revision: 1,
    askedBy: 'lane-1',
    title: 'Approve merge?',
    body: 'Should we merge the candidate head?',
    options: [
      { id: 'opt-1', label: 'Yes', consequence: 'merge' },
      { id: 'opt-2', label: 'No', consequence: 'block' },
    ],
    recommendation: { optionId: 'opt-1', because: 'verified' },
    doorKind: 'one-way',
    linkedRequestId: 'req-1',
    blocks: [],
    state: 'open',
    askedAt: '2026-10-15T10:00:00.000Z',
    expiresAt: null,
    answer: null,
    acknowledgement: null,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<ProjectProfileRecord> = {}): ProjectProfileRecord {
  return {
    projectId: 'proj-1',
    displayName: 'Project One',
    repository: 'org/repo-1',
    designatedDispatcherHost: 'host-1',
    policyRevision: 'pol-1',
    maxConcurrentLanes: 2,
    runnerCapabilities: {
      filesystemScope: 'scoped-worktree',
      networkEgressRestricted: true,
    },
    revision: 0,
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    status: 'active',
    defaultBranch: null,
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
    ...overrides,
  };
}

describe('change signals: OwnerQuestionRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-question-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('save emits one question signal per successful save with kind, id, stateFile and written.size; before null then previous written ino', async () => {
    const target = path.resolve(path.join(tempDir, 'owner-questions.json'));
    const signals = new RecordingChangeSignalPort(`${target}.lock`);
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });

    await adapter.save(makeOwnerQuestion(), 0);
    expect(signals.signals).toHaveLength(1);
    const first = signals.signals[0]!;
    expect(first.kind).toBe('question');
    expect(first.id).toBe('q-1');
    expect(first.stateFile).toBe(target);
    expect(first.written?.size).toBe((await fs.stat(target)).size);
    expect(first.before).toBeNull();

    await adapter.save({ ...makeOwnerQuestion(), revision: 2 }, 1);
    expect(signals.signals).toHaveLength(2);
    const second = signals.signals[1]!;
    expect(second.kind).toBe('question');
    expect(second.id).toBe('q-1');
    expect(second.stateFile).toBe(target);
    expect(second.before).not.toBeNull();
    expect(second.before!.ino).toBe(first.written!.ino);
    expect(signals.lockHeldAtEmit.every((held) => held === false)).toBe(true);
  });

  it('save reads before inside the lock and emits after releasing it, even when it waited on a foreign lock', async () => {
    const target = path.join(tempDir, 'owner-questions.json');
    const lockPath = `${target}.lock`;
    const signals = new RecordingChangeSignalPort(lockPath);
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    await adapter.save(makeOwnerQuestion(), 0);
    const first = signals.signals[0]!;

    await fs.writeFile(lockPath, 'held-by-test', 'utf8');
    const pending = adapter.save({ ...makeOwnerQuestion(), revision: 2 }, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await writeJsonAtomically(target, JSON.parse(await fs.readFile(target, 'utf8')));
    const swapped = await fs.stat(target);
    expect(swapped.ino).not.toBe(first.written!.ino);

    await fs.unlink(lockPath);
    await pending;

    const second = signals.signals[1]!;
    expect(second.before?.ino).toBe(swapped.ino);
    expect(signals.lockHeldAtEmit.every((held) => held === false)).toBe(true);
  });

  it('save emits nothing when the save throws on an unreadable file', async () => {
    await fs.writeFile(path.join(tempDir, 'owner-questions.json'), '{ not valid json', 'utf8');
    const signals = new RecordingChangeSignalPort();
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    await expect(adapter.save(makeOwnerQuestion(), 0)).rejects.toThrow(StateFileUnreadableError);
    expect(signals.signals).toHaveLength(0);
  });

  it('an emitter that throws does not fail the save, the record is on disk, and signalEmitFailures is 1', async () => {
    const adapter = new OwnerQuestionRepositoryAdapter({
      stateDir: tempDir,
      changeSignal: new ThrowingChangeSignalPort(),
    });
    await expect(adapter.save(makeOwnerQuestion(), 0)).resolves.toBeUndefined();
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tempDir, 'owner-questions.json'), 'utf8'),
    ) as unknown[];
    expect(onDisk.some((record) => (record as { questionId?: string }).questionId === 'q-1')).toBe(
      true,
    );
    expect(adapter.signalEmitFailures).toBe(1);
  });

  it('a burst of 20 sequential saves yields 20 signals in order', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new OwnerQuestionRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    for (let i = 0; i < 20; i += 1) {
      await adapter.save(makeOwnerQuestion({ questionId: `q-${i}` }), 0);
    }
    expect(signals.signals).toHaveLength(20);
    expect(signals.signals.map((signal) => signal.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `q-${i}`),
    );
  });

  it('in-memory mode emits with null stateFile, null before and null written', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new OwnerQuestionRepositoryAdapter({ changeSignal: signals });
    await adapter.save(makeOwnerQuestion(), 0);
    expect(signals.signals).toHaveLength(1);
    expect(signals.signals[0]).toMatchObject({ stateFile: null, before: null, written: null });
  });
});

describe('change signals: ProjectProfileRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-profile-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('saveProfile emits one profile signal per successful save with kind, id, stateFile and written.size; before null then previous written ino', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new ProjectProfileRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    const target = path.resolve(path.join(tempDir, 'project-profiles.json'));

    await adapter.saveProfile(makeProfile());
    expect(signals.signals).toHaveLength(1);
    const first = signals.signals[0]!;
    expect(first.kind).toBe('profile');
    expect(first.id).toBe('proj-1');
    expect(first.stateFile).toBe(target);
    expect(first.written?.size).toBe((await fs.stat(target)).size);
    expect(first.before).toBeNull();

    await adapter.saveProfile(makeProfile({ revision: 1 }));
    expect(signals.signals).toHaveLength(2);
    const second = signals.signals[1]!;
    expect(second.kind).toBe('profile');
    expect(second.id).toBe('proj-1');
    expect(second.stateFile).toBe(target);
    expect(second.before).not.toBeNull();
    expect(second.before!.ino).toBe(first.written!.ino);
  });

  it('saveProfile emits nothing when the save throws on an unreadable file', async () => {
    await fs.writeFile(path.join(tempDir, 'project-profiles.json'), '{ not valid json', 'utf8');
    const signals = new RecordingChangeSignalPort();
    const adapter = new ProjectProfileRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    await expect(adapter.saveProfile(makeProfile())).rejects.toThrow(StateFileUnreadableError);
    expect(signals.signals).toHaveLength(0);
  });
});

describe('a throwing emitter never fails a save', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-throwing-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it.each([
    {
      name: 'saveProfile',
      lockPath: 'project-profiles.json.lock',
      run: async (stateDir: string): Promise<void> => {
        const adapter = new ProjectProfileRepositoryAdapter({
          stateDir,
          changeSignal: new ThrowingChangeSignalPort(),
        });
        await expect(adapter.saveProfile(makeProfile())).resolves.toBeUndefined();
        expect(adapter.signalEmitFailures).toBe(1);
      },
    },
  ])('$name', async ({ lockPath, run }) => {
    await run(tempDir);
    expect(existsSync(path.join(tempDir, lockPath))).toBe(false);
  });
});
