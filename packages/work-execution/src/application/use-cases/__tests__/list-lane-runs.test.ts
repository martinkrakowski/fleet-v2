// ListLaneRunsUseCase tests — VZ2.
/**
 * The read-only schedule view lists the live runs in creation order with
 * their held slots, package keys and admission counts, never carries a lease
 * holder, ssh alias, port, transport or worktree path, and uses only the
 * dependencies' read methods.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunConductEntry, laneRunIntentEntry } from '../../../domain/lane-run-step-facts.js';
import { buildLaneRunStepKey } from '../../../domain/lane-run-keys.js';
import type {
  AttemptRecord,
  CapacityReservationRecord,
  WorkOrderRecord,
} from '../../../domain/execution-records.js';
import type { ConductorDriverLeasePort } from '../../ports/out/ConductorDriverLeasePort.out-port.js';
import type { ConductorHaltPort } from '../../ports/out/ConductorHaltPort.out-port.js';
import type { ConductorPassTracePort } from '../../ports/out/ConductorPassTracePort.out-port.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { WorkOrderRepositoryPort } from '../../ports/out/WorkOrderRepositoryPort.out-port.js';
import { conductorPassTraceOf } from '../../../domain/conductor-pass-trace.js';
import type { ConductorPassTraceRecord } from '../../../domain/conductor-pass-trace.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { ExecutionJournalAdapter } from '../../../infrastructure/adapters/ExecutionJournalAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';
import { ListLaneRunsUseCase } from '../ListLaneRunsUseCase.use-case.js';

const RUN_ID = 'run-01JB0000000000000000000000';
const RUN_ID_2 = 'run-01JB0000000000000000000001';
const ATTEMPT_ID = 'attempt-live-1';
const NOW = '2026-10-27T10:00:00.000Z';
const LEASE_UNTIL = '2026-10-27T10:05:00.000Z';
const ENTRY_1 = '01JB0000000000000000000001';
const HOLDER = 'driver-secret-1';
const WO_ID = 'wo-acme-repo';

const BASE_RECORD = {
  version: 1,
  runId: RUN_ID,
  workOrderId: WO_ID,
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: [ATTEMPT_ID],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, ...overrides });
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

const WORK_ORDER: WorkOrderRecord = {
  id: WO_ID,
  projectId: 'project-acme',
  taskId: 'task-1',
  laneId: 'lane-1',
  repository: 'acme/repo',
  baseCommit: 'a'.repeat(40),
  ownedPaths: ['packages/a/x.ts'],
  policyRevision: 'policy-example-1',
  prerequisiteWorkOrderIds: [],
  state: 'approved',
  revision: 1,
  createdAtIso: NOW,
  updatedAtIso: NOW,
};

const RESERVATION: CapacityReservationRecord = {
  id: 'res-live-1',
  attemptId: ATTEMPT_ID,
  hostId: 'host-id-sol',
  slotIndex: 0,
  held: true,
  seatTool: 'opencode',
  hostName: 'sol',
  hostKind: 'opencode',
  transport: 'ssh',
  sshAlias: 'alias-secret',
  port: 4166,
  worktreePath: '/srv/wt/run-1',
  reservedAtIso: NOW,
  releasedAtIso: null,
};

function makeHarness(passTrace?: Pick<ConductorPassTracePort, 'list'>) {
  const laneRunRepository = new LaneRunRepositoryAdapter();
  const laneRunJournal = new LaneRunJournalAdapter();
  const halt = new ConductorHaltAdapter();
  const driverLease = new ConductorDriverLeaseAdapter();
  const attemptRepo = new AttemptRepositoryAdapter();
  const executionJournal = new ExecutionJournalAdapter();
  const workOrderRepo = new WorkOrderRepositoryAdapter();
  const useCase = new ListLaneRunsUseCase({
    runRepo: laneRunRepository,
    runJournal: laneRunJournal,
    halt,
    driverLease,
    attemptRepo,
    executionJournal,
    workOrderRepo,
    ...(passTrace === undefined ? {} : { passTrace }),
  });
  return { laneRunRepository, laneRunJournal, halt, driverLease, attemptRepo, executionJournal, workOrderRepo, useCase };
}

/** A valid pass-trace record with the given cap, for the schedule cap reads. */
function traceWithCap(maxActiveRuns: number): ConductorPassTraceRecord {
  const read = conductorPassTraceOf(
    {
      passId: 'pass-1',
      nowIso: NOW,
      holderId: 'driver-secret-1',
      halted: false,
      progressed: true,
      runs: [],
      attention: [],
    },
    { maxActiveRuns, passConcurrency: 1, dispatchStaggerMs: 20000 },
  );
  expect(read.ok).toBe(true);
  if (!read.ok) {
    throw new Error('fixture must be a valid trace');
  }
  return read.record;
}

describe('ListLaneRunsUseCase (VZ2)', () => {
  it('throws Not implemented when unconfigured', async () => {
    const useCase = new ListLaneRunsUseCase();
    await expect(useCase.listLaneRuns({ nowIso: NOW })).rejects.toThrow(
      'Not implemented: ListLaneRunsUseCase',
    );
  });

  it('rejects a non-plain request and an invalid nowIso', async () => {
    const { useCase } = makeHarness();
    await expect(useCase.listLaneRuns({ nowIso: 'not-a-time' })).resolves.toEqual({
      outcome: 'rejected',
      reason: 'invalid-request',
    });
    await expect(useCase.listLaneRuns(null as never)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'invalid-request',
    });
  });

  it('lists only the live run with its slot, package keys and admission', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.laneRunRepository.create(runRecord({ runId: RUN_ID_2, attemptIds: ['attempt-stopped-1'] }));
    await h.laneRunJournal.append(laneRunConductEntry(ENTRY_1, RUN_ID_2, 'stopped', NOW));
    await h.workOrderRepo.saveWorkOrder(WORK_ORDER);
    await h.executionJournal.saveCapacityReservation(RESERVATION);

    const result = await h.useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.schedule.rows).toHaveLength(1);
    expect(result.schedule.rows[0]).toMatchObject({
      runId: RUN_ID,
      placement: 'running',
      slot: { hostName: 'sol', slotIndex: 0 },
      packageKeys: ['packages/a'],
    });
    expect(result.schedule.admission).toEqual({ active: 1, inFlight: 0, maxActiveRuns: null });
    expect(result.schedule.caps).toBeNull();
  });

  it('redacts lease and reservation secrets and fields', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    expect(
      await h.laneRunRepository.acquireLease(RUN_ID, {
        holderId: HOLDER,
        observedFence: 0,
        leaseUntilIso: LEASE_UNTIL,
        nowIso: NOW,
      }),
    ).toMatchObject({ outcome: 'saved' });
    await h.workOrderRepo.saveWorkOrder(WORK_ORDER);
    await h.executionJournal.saveCapacityReservation(RESERVATION);

    const result = await h.useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.schedule.rows).toHaveLength(1);
    expect(result.schedule.rows[0].runId).toBe(RUN_ID);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['alias-secret', '4166', '/srv/wt/run-1', 'holderId', 'sshAlias', 'transport', 'worktreePath', HOLDER]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('reflects a halted marker in halt and placement', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    await h.workOrderRepo.saveWorkOrder(WORK_ORDER);
    await h.executionJournal.saveCapacityReservation(RESERVATION);
    expect(await h.halt.set({ halted: true, nowIso: NOW })).toMatchObject({ outcome: 'changed' });

    const result = await h.useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.schedule.halt).toBe('halted');
    expect(result.schedule.rows[0].placement).toBe('halted');
  });

  it('includes a dispatch session-start mark from the journals', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    const key = buildLaneRunStepKey({
      runId: RUN_ID,
      round: 0,
      step: 'dispatch',
      seatIndex: 0,
      attemptOrdinal: 1,
      head12: null,
      retry: null,
    });
    expect(key.ok).toBe(true);
    if (!key.ok) {
      return;
    }
    await h.laneRunJournal.append(laneRunIntentEntry(ENTRY_1, RUN_ID, key.key, null, NOW));

    const result = await h.useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.sessionStarts).toHaveLength(1);
    expect(result.sessionStarts[0]).toMatchObject({
      runId: RUN_ID,
      step: 'dispatch',
      gapMs: null,
      underStagger: null,
    });
    expect(result.truncated).toBe(false);
  });

  it('uses only the read methods of its dependencies', async () => {
    let listForRunsCalls = 0;
    let listForRunCalls = 0;
    const useCase = new ListLaneRunsUseCase({
      runRepo: {
        list: async () => [] as readonly LaneRunRecord[],
      } satisfies Pick<LaneRunRepositoryPort, 'list'>,
      runJournal: {
        listForRuns: async () => {
          listForRunsCalls += 1;
          return new Map<string, readonly LaneRunJournalEntryRecord[]>();
        },
        listForRun: async () => {
          listForRunCalls += 1;
          return [] as readonly LaneRunJournalEntryRecord[];
        },
      } satisfies Pick<LaneRunJournalPort, 'listForRun' | 'listForRuns'>,
      halt: {
        read: async () => ({ state: 'clear' as const, record: null }),
      } satisfies Pick<ConductorHaltPort, 'read'>,
      driverLease: {
        read: async () => null,
      } satisfies Pick<ConductorDriverLeasePort, 'read'>,
      attemptRepo: {
        listAllAttempts: async () => [] as readonly AttemptRecord[],
      } satisfies Pick<AttemptRepositoryPort, 'listAllAttempts'>,
      executionJournal: {
        listActiveReservations: async () => [] as readonly CapacityReservationRecord[],
      } satisfies Pick<ExecutionJournalPort, 'listActiveReservations'>,
      workOrderRepo: {
        listWorkOrdersByProject: async () => [] as readonly WorkOrderRecord[],
      } satisfies Pick<WorkOrderRepositoryPort, 'listWorkOrdersByProject'>,
    });

    const result = await useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    expect(listForRunsCalls).toBe(1);
    expect(listForRunCalls).toBe(0);
  });
});

describe('ListLaneRunsUseCase (VZ5b pass traces)', () => {
  it('reads the newest pass trace cap into caps and admission', async () => {
    const h = makeHarness({
      list: async () => ({
        outcome: 'listed',
        traces: [traceWithCap(1), traceWithCap(3)],
      }),
    });
    await h.laneRunRepository.create(runRecord());
    const result = await h.useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.schedule.trace).toBe('recorded');
    expect(result.schedule.caps?.maxActiveRuns).toBe(3);
    expect(result.schedule.admission.maxActiveRuns).toBe(3);
  });

  it('reports an unreadable unknown-version trace without caps', async () => {
    const h = makeHarness({
      list: async () => ({ outcome: 'unreadable', reason: 'unknown-schema-version' }),
    });
    await h.laneRunRepository.create(runRecord());
    const result = await h.useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.schedule.trace).toBe('unreadable');
    expect(result.schedule.caps).toBeNull();
    expect(result.schedule.admission.maxActiveRuns).toBeNull();
  });

  it('keeps trace none when no passTrace dependency is given', async () => {
    const h = makeHarness();
    await h.laneRunRepository.create(runRecord());
    const result = await h.useCase.listLaneRuns({ nowIso: NOW });
    expect(result.outcome).toBe('listed');
    if (result.outcome !== 'listed') {
      return;
    }
    expect(result.schedule.trace).toBe('none');
    expect(result.schedule.caps).toBeNull();
  });
});
