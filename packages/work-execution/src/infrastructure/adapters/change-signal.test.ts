import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../domain/execution-records.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import { AttemptRepositoryAdapter } from './AttemptRepositoryAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from './WorkOrderRepositoryAdapter.adapter.js';
import { ExecutionJournalAdapter } from './ExecutionJournalAdapter.adapter.js';
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
    this.lockHeldAtEmit.length = 0;
  }
}

class ThrowingChangeSignalPort implements ChangeSignalPort {
  emit(_signal: ChangeSignal): void {
    throw new Error('signal emit failed');
  }
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/tmp/worktree-1',
    baseCommit: 'commit-1',
    state: 'dispatching',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeWorkOrder(overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    id: 'wo-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'org/repo',
    baseCommit: 'commit-1',
    ownedPaths: [],
    policyRevision: 'pol-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 0,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeReservation(overrides: Partial<CapacityReservationRecord> = {}): CapacityReservationRecord {
  return {
    id: 'res-1',
    attemptId: 'att-1',
    hostId: 'host-1',
    slotIndex: 0,
    held: true,
    seatTool: 'opencode',
    reservedAtIso: '2026-10-15T10:00:00.000Z',
    releasedAtIso: null,
    ...overrides,
  };
}

describe('change signals: AttemptRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-attempt-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('saveAttempt emits one signal per successful save with kind, id, stateFile and written.size; before null then previous written ino', async () => {
    const target = path.resolve(path.join(tempDir, 'attempts.json'));
    const signals = new RecordingChangeSignalPort(`${target}.lock`);
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });

    await adapter.saveAttempt(makeAttempt({ id: 'att-a' }));
    expect(signals.signals).toHaveLength(1);
    const first = signals.signals[0]!;
    expect(first.kind).toBe('attempt');
    expect(first.id).toBe('att-a');
    expect(first.stateFile).toBe(target);
    expect(first.written?.size).toBe((await fs.stat(target)).size);
    expect(first.before).toBeNull();

    await adapter.saveAttempt(makeAttempt({ id: 'att-a', revision: 1 }));
    expect(signals.signals).toHaveLength(2);
    const second = signals.signals[1]!;
    expect(second.kind).toBe('attempt');
    expect(second.id).toBe('att-a');
    expect(second.stateFile).toBe(target);
    expect(second.before).not.toBeNull();
    expect(second.before!.ino).toBe(first.written!.ino);
    expect(signals.lockHeldAtEmit.every((held) => held === false)).toBe(true);
  });

  it('saveAttempt reads before inside the lock and emits after releasing it, even when it waited on a foreign lock', async () => {
    const target = path.join(tempDir, 'attempts.json');
    const lockPath = `${target}.lock`;
    const signals = new RecordingChangeSignalPort(lockPath);
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    await adapter.saveAttempt(makeAttempt());
    const first = signals.signals[0]!;

    await fs.writeFile(lockPath, 'held-by-test', 'utf8');
    const pending = adapter.saveAttempt(makeAttempt({ revision: 1 }));
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

  it('saveAttempt emits nothing when the save throws on an unreadable file', async () => {
    await fs.writeFile(path.join(tempDir, 'attempts.json'), '{ not valid json', 'utf8');
    const signals = new RecordingChangeSignalPort();
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    await expect(adapter.saveAttempt(makeAttempt())).rejects.toThrow(StateFileUnreadableError);
    expect(signals.signals).toHaveLength(0);
  });

  it('an emitter that throws does not fail the save, the record is on disk, and signalEmitFailures is 1', async () => {
    const adapter = new AttemptRepositoryAdapter({
      stateDir: tempDir,
      changeSignal: new ThrowingChangeSignalPort(),
    });
    await expect(adapter.saveAttempt(makeAttempt())).resolves.toBeUndefined();
    expect(await adapter.findAttemptById('att-1')).not.toBeNull();
    expect(adapter.signalEmitFailures).toBe(1);
    const onDisk = JSON.parse(await fs.readFile(path.join(tempDir, 'attempts.json'), 'utf8')) as unknown[];
    expect(onDisk.some((record) => (record as { id?: string }).id === 'att-1')).toBe(true);
  });

  it('a burst of 20 sequential saves yields 20 signals in order', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    for (let i = 0; i < 20; i += 1) {
      await adapter.saveAttempt(makeAttempt({ id: `att-${i}` }));
    }
    expect(signals.signals).toHaveLength(20);
    expect(signals.signals.map((signal) => signal.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `att-${i}`),
    );
  });

  it('in-memory mode emits with null stateFile, null before and null written', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new AttemptRepositoryAdapter({ changeSignal: signals });
    await adapter.saveAttempt(makeAttempt());
    expect(signals.signals).toHaveLength(1);
    expect(signals.signals[0]).toMatchObject({ stateFile: null, before: null, written: null });
  });

  it('clear() resets lockHeldAtEmit', async () => {
    const target = path.resolve(path.join(tempDir, 'attempts.json'));
    const signals = new RecordingChangeSignalPort(`${target}.lock`);
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });

    await adapter.saveAttempt(makeAttempt());
    signals.clear();
    expect(signals.signals).toHaveLength(0);
    expect(signals.lockHeldAtEmit).toHaveLength(0);
  });
});

describe('change signals: WorkOrderRepositoryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-order-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('saveWorkOrder emits one signal per successful save with kind, id, stateFile and written.size; before null then previous written ino', async () => {
    const target = path.resolve(path.join(tempDir, 'work-orders.json'));
    const signals = new RecordingChangeSignalPort(`${target}.lock`);
    const adapter = new WorkOrderRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });

    await adapter.saveWorkOrder(makeWorkOrder());
    expect(signals.signals).toHaveLength(1);
    const first = signals.signals[0]!;
    expect(first.kind).toBe('work-order');
    expect(first.id).toBe('wo-1');
    expect(first.stateFile).toBe(target);
    expect(first.written?.size).toBe((await fs.stat(target)).size);
    expect(first.before).toBeNull();

    await adapter.saveWorkOrder(makeWorkOrder({ revision: 1 }));
    expect(signals.signals).toHaveLength(2);
    const second = signals.signals[1]!;
    expect(second.kind).toBe('work-order');
    expect(second.id).toBe('wo-1');
    expect(second.before).not.toBeNull();
    expect(second.before!.ino).toBe(first.written!.ino);
    expect(signals.lockHeldAtEmit.length).toBeGreaterThan(0);
    expect(signals.lockHeldAtEmit.every((held) => held === false)).toBe(true);
  });

  it('saveWorkOrder emits nothing when the save throws on an unreadable file', async () => {
    await fs.writeFile(path.join(tempDir, 'work-orders.json'), '{ not valid json', 'utf8');
    const signals = new RecordingChangeSignalPort();
    const adapter = new WorkOrderRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    await expect(adapter.saveWorkOrder(makeWorkOrder())).rejects.toThrow(StateFileUnreadableError);
    expect(signals.signals).toHaveLength(0);
  });
});

describe('change signals: ExecutionJournalAdapter saveCapacityReservation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-reserve-save-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('saveCapacityReservation emits one signal per successful save with kind, id, stateFile and written.size; before null then previous written ino', async () => {
    const target = path.resolve(path.join(tempDir, 'reservations.json'));
    const signals = new RecordingChangeSignalPort(`${target}.lock`);
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });

    await adapter.saveCapacityReservation(makeReservation());
    expect(signals.signals).toHaveLength(1);
    const first = signals.signals[0]!;
    expect(first.kind).toBe('capacity');
    expect(first.id).toBe('res-1');
    expect(first.stateFile).toBe(target);
    expect(first.written?.size).toBe((await fs.stat(target)).size);
    expect(first.before).toBeNull();

    await adapter.saveCapacityReservation(makeReservation({ id: 'res-2', attemptId: 'att-2' }));
    expect(signals.signals).toHaveLength(2);
    const second = signals.signals[1]!;
    expect(second.kind).toBe('capacity');
    expect(second.id).toBe('res-2');
    expect(second.before).not.toBeNull();
    expect(second.before!.ino).toBe(first.written!.ino);
    expect(signals.lockHeldAtEmit.length).toBeGreaterThan(0);
    expect(signals.lockHeldAtEmit.every((held) => held === false)).toBe(true);
  });

  it('saveCapacityReservation emits nothing when the save throws on an unreadable file', async () => {
    await fs.writeFile(path.join(tempDir, 'reservations.json'), '{ not valid json', 'utf8');
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    await expect(adapter.saveCapacityReservation(makeReservation())).rejects.toThrow(
      StateFileUnreadableError,
    );
    expect(signals.signals).toHaveLength(0);
  });
});

describe('change signals: ExecutionJournalAdapter reserveCapacityAtomically', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-reserve-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reserveCapacityAtomically emits one capacity signal per successful reservation', async () => {
    const target = path.resolve(path.join(tempDir, 'reservations.json'));
    const signals = new RecordingChangeSignalPort(`${target}.lock`);
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });

    const firstResult = await adapter.reserveCapacityAtomically({
      attemptId: 'att-a',
      maxSlots: 5,
      record: makeReservation({ id: 'res-a', attemptId: 'att-a' }),
    });
    expect(firstResult.outcome).toBe('reserved');
    expect(signals.signals).toHaveLength(1);
    const first = signals.signals[0]!;
    expect(first.kind).toBe('capacity');
    expect(first.id).toBe('res-a');
    expect(first.stateFile).toBe(target);
    expect(first.written?.size).toBe((await fs.stat(target)).size);
    expect(first.before).toBeNull();

    const secondResult = await adapter.reserveCapacityAtomically({
      attemptId: 'att-b',
      maxSlots: 5,
      record: makeReservation({ id: 'res-b', attemptId: 'att-b' }),
    });
    expect(secondResult.outcome).toBe('reserved');
    expect(signals.signals).toHaveLength(2);
    const second = signals.signals[1]!;
    expect(second.kind).toBe('capacity');
    expect(second.id).toBe('res-b');
    expect(second.stateFile).toBe(target);
    expect(second.before).not.toBeNull();
    expect(second.before!.ino).toBe(first.written!.ino);
    expect(signals.lockHeldAtEmit.length).toBeGreaterThan(0);
    expect(signals.lockHeldAtEmit.every((held) => held === false)).toBe(true);
  });

  it('reserveCapacityAtomically emits nothing when the read throws on an unreadable file', async () => {
    await fs.writeFile(path.join(tempDir, 'reservations.json'), '{ not valid json', 'utf8');
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    await expect(
      adapter.reserveCapacityAtomically({
        attemptId: 'att-a',
        maxSlots: 1,
        record: makeReservation(),
      }),
    ).rejects.toThrow(StateFileUnreadableError);
    expect(signals.signals).toHaveLength(0);
  });

  it('reserveCapacityAtomically emits nothing for a refused no-free-slot outcome', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    const result = await adapter.reserveCapacityAtomically({
      attemptId: 'att-a',
      maxSlots: 0,
      record: makeReservation(),
    });
    expect(result.outcome).toBe('no-free-slot');
    expect(signals.signals).toHaveLength(0);
  });

  it('reserveCapacityAtomically emits nothing for a refused busy-worktree outcome', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ changeSignal: signals });
    const result = await adapter.reserveCapacityAtomically({
      attemptId: 'att-a',
      maxSlots: 1,
      record: makeReservation(),
      checkBusyWorktree: async () => ({ outcome: 'busy-worktree', blockingAttemptId: 'att-x' }),
    });
    expect(result.outcome).toBe('busy-worktree');
    expect(signals.signals).toHaveLength(0);
  });

  it('reserveCapacityAtomically emits nothing for a duplicate-attempt outcome', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });

    const firstResult = await adapter.reserveCapacityAtomically({
      attemptId: 'att-a',
      maxSlots: 5,
      record: makeReservation({ id: 'res-a', attemptId: 'att-a' }),
    });
    expect(firstResult.outcome).toBe('reserved');
    expect(signals.signals).toHaveLength(1);

    const secondResult = await adapter.reserveCapacityAtomically({
      attemptId: 'att-a',
      maxSlots: 5,
      record: makeReservation({ id: 'res-a2', attemptId: 'att-a' }),
    });
    expect(secondResult.outcome).toBe('duplicate-attempt');
    expect(signals.signals).toHaveLength(1);
  });
});

describe('change signals: ExecutionJournalAdapter releaseCapacityReservation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-change-signal-release-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('releaseCapacityReservation emits one capacity signal when it releases a held reservation', async () => {
    const target = path.resolve(path.join(tempDir, 'reservations.json'));
    const signals = new RecordingChangeSignalPort(`${target}.lock`);
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });

    const reserveResult = await adapter.reserveCapacityAtomically({
      attemptId: 'att-a',
      maxSlots: 1,
      record: makeReservation({ id: 'res-a', attemptId: 'att-a' }),
    });
    expect(reserveResult.outcome).toBe('reserved');
    const reserveWritten = signals.signals[0]!.written;
    expect(reserveWritten).not.toBeNull();
    signals.clear();

    const released = await adapter.releaseCapacityReservation('att-a', '2026-10-15T11:00:00.000Z');
    expect(released).toBe(true);
    expect(signals.signals).toHaveLength(1);
    const signal = signals.signals[0]!;
    expect(signal.kind).toBe('capacity');
    expect(signal.id).toBe('res-a');
    expect(signal.stateFile).toBe(target);
    expect(signal.written?.size).toBe((await fs.stat(target)).size);
    expect(signal.before).not.toBeNull();
    expect(signal.before?.ino).toBe(reserveWritten?.ino);
    expect(signal.before?.size).toBe(reserveWritten?.size);
    expect(signals.lockHeldAtEmit.length).toBeGreaterThan(0);
    expect(signals.lockHeldAtEmit.every((held) => held === false)).toBe(true);
  });

  it('releaseCapacityReservation emits nothing when the read throws on an unreadable file', async () => {
    await fs.writeFile(path.join(tempDir, 'reservations.json'), '{ not valid json', 'utf8');
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    await expect(
      adapter.releaseCapacityReservation('att-a', '2026-10-15T11:00:00.000Z'),
    ).rejects.toThrow(StateFileUnreadableError);
    expect(signals.signals).toHaveLength(0);
  });

  it('releaseCapacityReservation emits nothing when it returns false', async () => {
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    const released = await adapter.releaseCapacityReservation('att-none', '2026-10-15T11:00:00.000Z');
    expect(released).toBe(false);
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
      name: 'saveWorkOrder',
      lockPath: 'work-orders.json.lock',
      run: async (stateDir: string): Promise<void> => {
        const adapter = new WorkOrderRepositoryAdapter({
          stateDir,
          changeSignal: new ThrowingChangeSignalPort(),
        });
        await expect(adapter.saveWorkOrder(makeWorkOrder())).resolves.toBeUndefined();
        expect(adapter.signalEmitFailures).toBe(1);
      },
    },
    {
      name: 'saveCapacityReservation',
      lockPath: 'reservations.json.lock',
      run: async (stateDir: string): Promise<void> => {
        const adapter = new ExecutionJournalAdapter({
          stateDir,
          changeSignal: new ThrowingChangeSignalPort(),
        });
        await expect(adapter.saveCapacityReservation(makeReservation())).resolves.toBeUndefined();
        expect(adapter.signalEmitFailures).toBe(1);
      },
    },
    {
      name: 'reserveCapacityAtomically',
      lockPath: 'reservations.json.lock',
      run: async (stateDir: string): Promise<void> => {
        const adapter = new ExecutionJournalAdapter({
          stateDir,
          changeSignal: new ThrowingChangeSignalPort(),
        });
        const result = await adapter.reserveCapacityAtomically({
          attemptId: 'att-a',
          maxSlots: 5,
          record: makeReservation({ id: 'res-a', attemptId: 'att-a' }),
        });
        expect(result.outcome).toBe('reserved');
        expect(adapter.signalEmitFailures).toBe(1);
      },
    },
    {
      name: 'releaseCapacityReservation',
      lockPath: 'reservations.json.lock',
      run: async (stateDir: string): Promise<void> => {
        const adapter = new ExecutionJournalAdapter({
          stateDir,
          changeSignal: new ThrowingChangeSignalPort(),
        });
        const reserveResult = await adapter.reserveCapacityAtomically({
          attemptId: 'att-a',
          maxSlots: 1,
          record: makeReservation({ id: 'res-a', attemptId: 'att-a' }),
        });
        expect(reserveResult.outcome).toBe('reserved');
        await expect(
          adapter.releaseCapacityReservation('att-a', '2026-10-15T11:00:00.000Z'),
        ).resolves.toBe(true);
        expect(adapter.signalEmitFailures).toBe(2);
      },
    },
  ])('$name', async ({ lockPath, run }) => {
    await run(tempDir);
    expect(existsSync(path.join(tempDir, lockPath))).toBe(false);
  });
});
