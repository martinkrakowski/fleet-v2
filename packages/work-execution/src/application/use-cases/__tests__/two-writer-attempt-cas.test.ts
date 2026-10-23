/**
 * Two-writer test for the attempt revision compare-and-swap (M10, L8 wave
 * 2). Two real AttemptRepositoryAdapter instances share one stateDir and stand
 * in for two processes. Reconcile's runner inspectSession is a controllable
 * promise: reconcile parks after its read, stop completes through the second
 * adapter (writing `cancelled`), then reconcile's inspect reports `active`.
 * Reconcile's stale write must conflict, re-read once and refuse, so the
 * final stored state stays `cancelled` and capacity is released exactly once.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CapacityReservationRecord,
} from '../../../domain/execution-records.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
} from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
  RunnerSessionStatus,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ReconcileAttemptUseCase } from '../ReconcileAttemptUseCase.use-case.js';
import { StopAttemptUseCase } from '../StopAttemptUseCase.use-case.js';

const FULL_CAPABILITIES: RunnerIsolationCapabilities = {
  source: 'legacy-asserted',
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
};

const ACTIVE_STATUS: RunnerSessionStatus = {
  runnerReachable: 'reachable',
  workspacePreparation: 'prepared',
  workerCommand: 'active',
  completionReceipt: null,
  artifactsCollected: false,
};

function makeSeedAttempt(): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/attempt-1',
    baseCommit: 'abc123',
    state: 'running',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-10-15T08:00:00.000Z',
    updatedAtIso: '2026-10-15T08:00:00.000Z',
  };
}

function makeTwoWriterJournal(): ExecutionJournalPort & {
  entries: ActionJournalEntryRecord[];
  releaseCount: number;
} {
  const entries: ActionJournalEntryRecord[] = [];
  const reservations = new Map<string, CapacityReservationRecord>();
  const journal = {
    entries,
    releaseCount: 0,
    async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
      entries.push(entry);
    },
    async listJournalEntriesForAttempt(attemptId: string) {
      return entries.filter((entry) => entry.attemptId === attemptId);
    },
    async saveCapacityReservation(reservation: CapacityReservationRecord): Promise<void> {
      reservations.set(reservation.id, reservation);
    },
    async listActiveReservations() {
      return [...reservations.values()].filter((reservation) => reservation.held);
    },
    async releaseCapacityReservation(): Promise<boolean> {
      journal.releaseCount += 1;
      return true;
    },
    async reserveCapacityAtomically(request: ReserveCapacityAtomicallyRequest) {
      const reservation: CapacityReservationRecord = { ...request.record!, slotIndex: 0 };
      reservations.set(reservation.id, reservation);
      return { outcome: 'reserved' as const, reservation };
    },
  };
  return journal;
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('attempt revision CAS two-writer race (reconcile vs stop)', () => {
  it('keeps the cancelled state and releases capacity once when stop wins the race', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-two-writer-'));
    try {
      const adapterA = new AttemptRepositoryAdapter({ stateDir });
      const adapterB = new AttemptRepositoryAdapter({ stateDir });
      await adapterA.saveAttempt(makeSeedAttempt());

      // Reconcile's inspectSession parks until released, then reports active.
      let inspectStarted = false;
      let releaseInspect!: () => void;
      let inspectCount = 0;
      const inspectGate = new Promise<void>((resolve) => {
        releaseInspect = resolve;
      });
      const runnerA: ExecutionRunnerPort = {
        describeCapabilities: () => FULL_CAPABILITIES,
        async startSession() {
          throw new Error('unexpected startSession in two-writer test');
        },
        async inspectSession() {
          inspectStarted = true;
          inspectCount += 1;
          await inspectGate;
          return ACTIVE_STATUS;
        },
        async stopSession() {
          throw new Error('unexpected stopSession in two-writer test');
        },
      };

      const journal = makeTwoWriterJournal();
      const reconcile = new ReconcileAttemptUseCase({
        attemptRepo: adapterA,
        journal,
        runner: runnerA,
      });

      const reconcilePromise = reconcile.reconcileAttempt({ attemptId: 'attempt-1' });
      await waitUntil(() => inspectStarted);

      // While reconcile is parked, stop completes through the second adapter.
      const runnerB: ExecutionRunnerPort = {
        describeCapabilities: () => FULL_CAPABILITIES,
        async startSession() {
          throw new Error('unexpected startSession in two-writer test');
        },
        async inspectSession() {
          throw new Error('unexpected inspectSession in two-writer test');
        },
        async stopSession() {
          return {
            outcome: 'terminated',
            receipt: {
              attemptId: 'attempt-1',
              sessionId: 'session-1',
              endedAtIso: '2026-10-15T08:03:00.000Z',
              authoritative: true,
              exitStatus: 0,
              stoppedByRequest: true,
            },
          };
        },
      };
      const stop = new StopAttemptUseCase({
        attemptRepo: adapterB,
        journal,
        runner: runnerB,
      });
      const stopResult = await stop.stopAttempt({ attemptId: 'attempt-1' });
      expect(stopResult.outcome).toBe('terminated');
      if (stopResult.outcome === 'terminated') {
        expect(stopResult.capacityReleased).toBe(true);
      }
      const stopRevision = stopResult.outcome === 'terminated' ? stopResult.attempt.revision : undefined;

      // Release reconcile's inspect: it now writes a stale `running` (revision
      // 1 over the stored cancelled revision 1), conflicts, re-reads once and
      // refuses without writing or releasing.
      releaseInspect();
      const reconcileResult = await reconcilePromise;

      expect(reconcileResult.outcome).toBe('refused');
      if (reconcileResult.outcome === 'refused') {
        expect(reconcileResult.reason).toBe('Attempt attempt-1 changed to cancelled while reconciling');
      }

      const finalA = await adapterA.findAttemptById('attempt-1');
      const finalB = await adapterB.findAttemptById('attempt-1');
      expect(finalA?.state).toBe('cancelled');
      expect(finalB?.state).toBe('cancelled');
      expect(finalA?.revision).toBe(1);
      expect(finalA?.revision).toBe(stopRevision);
      // inspectSession ran once before the conflict, plus at most once on
      // the post-conflict re-read.
      expect(inspectCount).toBeGreaterThanOrEqual(1);
      expect(inspectCount).toBeLessThanOrEqual(2);
      expect(journal.releaseCount).toBe(1);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
