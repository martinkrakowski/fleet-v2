import { describe, expect, it } from 'vitest';

import {
  AttemptRevisionConflictError,
  nextAttemptRevision,
  type AttemptRepositoryPort,
} from '../AttemptRepositoryPort.out-port.js';
import type { AttemptRecord } from '../../../../domain/execution-records.js';

/**
 * The shared contract suite for AttemptRepositoryPort. It runs against the
 * real adapter and the shared in-memory fake, so the fake cannot drift from
 * the adapter. Holds no `.test.ts` suffix: the runners that import it collect
 * it.
 */
export function describeAttemptRepositoryContract(
  label: string,
  createPort: () => AttemptRepositoryPort,
): void {
  describe(`AttemptRepositoryPort contract (${label})`, () => {
    it('reads a saved attempt back', async () => {
      const port = createPort();
      const written = makeAttempt();
      await port.saveAttempt(written);

      const found = await port.findAttemptById('att-1');
      expect(found?.id).toBe(written.id);
      expect(found?.workOrderId).toBe(written.workOrderId);
      expect(found?.state).toBe(written.state);
      expect(found?.createdAtIso).toBe(written.createdAtIso);
      expect(found?.updatedAtIso).toBe(written.updatedAtIso);
    });

    it('an unknown attempt reads as null', async () => {
      const port = createPort();
      expect(await port.findAttemptById('att-absent')).toBeNull();
    });

    it('a save built on the stored revision is stored', async () => {
      const port = createPort();
      await port.saveAttempt(makeAttempt());
      const found = (await port.findAttemptById('att-1'))!;

      await port.saveAttempt({
        ...found,
        state: 'running',
        revision: nextAttemptRevision(found),
      });

      const updated = (await port.findAttemptById('att-1'))!;
      expect(updated.state).toBe('running');
      expect(updated.revision).toBe(1);
    });

    it('a stale revision is refused', async () => {
      const port = createPort();
      await port.saveAttempt(makeAttempt());
      const found = (await port.findAttemptById('att-1'))!;

      await expect(
        port.saveAttempt({ ...found, state: 'cancelled', revision: 0 }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AttemptRevisionConflictError &&
          error.attemptId === 'att-1' &&
          error.expectedRevision === 0 &&
          error.actualRevision === 0,
      );
    });

    it('an identity change is refused before the revision check', async () => {
      const port = createPort();
      await port.saveAttempt(makeAttempt());
      const found = (await port.findAttemptById('att-1'))!;

      await expect(
        port.saveAttempt({ ...found, workOrderId: 'wo-other', revision: 1 }),
      ).rejects.toThrow('Immutable attempt identity changed for att-1: workOrderId');

      const stored = (await port.findAttemptById('att-1'))!;
      expect(stored.workOrderId).toBe('wo-1');
      expect(stored.revision).toBe(0);
    });

    it('one work order\'s attempts, in creation order', async () => {
      const port = createPort();
      await port.saveAttempt(
        makeAttempt({ id: 'att-c', workOrderId: 'wo-1', createdAtIso: '2026-10-15T10:02:00.000Z' }),
      );
      await port.saveAttempt(
        makeAttempt({ id: 'att-a', workOrderId: 'wo-1', createdAtIso: '2026-10-15T10:00:00.000Z' }),
      );
      await port.saveAttempt(
        makeAttempt({ id: 'att-b', workOrderId: 'wo-2', createdAtIso: '2026-10-15T10:01:00.000Z' }),
      );

      const workOrderAttempts = await port.listAttemptsByWorkOrder('wo-1');
      expect(workOrderAttempts.map((attempt) => attempt.id)).toEqual(['att-a', 'att-c']);
      expect(await port.listAttemptsByWorkOrder('wo-absent')).toEqual([]);
    });

    it('every attempt, newest update first', async () => {
      const port = createPort();
      await port.saveAttempt(
        makeAttempt({ id: 'att-c', workOrderId: 'wo-1', updatedAtIso: '2026-10-15T10:02:00.000Z' }),
      );
      await port.saveAttempt(
        makeAttempt({ id: 'att-b', workOrderId: 'wo-2', updatedAtIso: '2026-10-15T10:01:00.000Z' }),
      );
      await port.saveAttempt(
        makeAttempt({ id: 'att-a', workOrderId: 'wo-1', updatedAtIso: '2026-10-15T10:00:00.000Z' }),
      );

      const all = await port.listAllAttempts();
      expect(all.map((attempt) => attempt.id)).toEqual(['att-c', 'att-b', 'att-a']);
    });

    it('D6: an absent version reads as 1', async () => {
      const port = createPort();
      await port.saveAttempt(makeAttempt({ schemaVersion: undefined, revision: undefined }));

      const found = (await port.findAttemptById('att-1'))!;
      expect(found.schemaVersion).toBe(1);
      expect(found.revision).toBe(0);
    });
  });
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
