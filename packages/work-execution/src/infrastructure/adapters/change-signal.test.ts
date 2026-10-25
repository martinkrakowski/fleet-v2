import { promises as fs } from 'node:fs';
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
import { StateFileUnreadableError } from './file-store.js';

class RecordingChangeSignalPort implements ChangeSignalPort {
  readonly signals: ChangeSignal[] = [];

  emit(signal: ChangeSignal): void {
    this.signals.push(signal);
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
    const signals = new RecordingChangeSignalPort();
    const adapter = new AttemptRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    const target = path.resolve(path.join(tempDir, 'attempts.json'));

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
    await expect(adapter.saveAttempt(makeAttempt())).resolves.not.toThrow();
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
    const signals = new RecordingChangeSignalPort();
    const adapter = new WorkOrderRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    const target = path.resolve(path.join(tempDir, 'work-orders.json'));

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
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    const target = path.resolve(path.join(tempDir, 'reservations.json'));

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
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    const target = path.resolve(path.join(tempDir, 'reservations.json'));

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
    const signals = new RecordingChangeSignalPort();
    const adapter = new ExecutionJournalAdapter({ stateDir: tempDir, changeSignal: signals });
    const target = path.resolve(path.join(tempDir, 'reservations.json'));

    const reserveResult = await adapter.reserveCapacityAtomically({
      attemptId: 'att-a',
      maxSlots: 1,
      record: makeReservation({ id: 'res-a', attemptId: 'att-a' }),
    });
    expect(reserveResult.outcome).toBe('reserved');
    signals.clear();

    const released = await adapter.releaseCapacityReservation('att-a', '2026-10-15T11:00:00.000Z');
    expect(released).toBe(true);
    expect(signals.signals).toHaveLength(1);
    const signal = signals.signals[0]!;
    expect(signal.kind).toBe('capacity');
    expect(signal.id).toBe('res-a');
    expect(signal.stateFile).toBe(target);
    expect(signal.written?.size).toBe((await fs.stat(target)).size);
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
