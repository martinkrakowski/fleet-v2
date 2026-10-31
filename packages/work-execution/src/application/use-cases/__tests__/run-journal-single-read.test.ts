// EX-3a: scans read the run journal once, not once per run.
/**
 * The grouped-read helper `journalsForRuns` and the scans that use it: a
 * counting fake that offers `listForRuns` is called exactly once (and
 * `listForRun` never) for one scan, and the scan's result equals the same run
 * against a fake that only has the per-run `listForRun` fallback.
 */

import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import { ConductorDriverLeaseAdapter } from '../../../infrastructure/adapters/ConductorDriverLeaseAdapter.adapter.js';
import { ConductorHaltAdapter } from '../../../infrastructure/adapters/ConductorHaltAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import type { AdvanceLaneRunPort } from '../../ports/in/AdvanceLaneRunPort.in-port.js';
import type { RunConductorPassResult } from '../../ports/in/RunConductorPassPort.in-port.js';
import { RunConductorPassUseCase } from '../RunConductorPassUseCase.use-case.js';
import { StartLaneRunUseCase } from '../StartLaneRunUseCase.use-case.js';
import type { StartLaneRunDependencies } from '../StartLaneRunUseCase.use-case.js';
import type { StartLaneRunRequest } from '../../ports/in/StartLaneRunPort.in-port.js';
import { workOrderHoldFacts } from '../work-order-hold-facts.js';
import type { RunJournalRunReads } from '../run-journal-reads.js';

const RUN_A = 'run-01JB0000000000000000000000';
const RUN_B = 'run-01JB0000000000000000000001';
const RUN_C = 'run-01JB0000000000000000000002';
const NOW = '2026-10-27T10:00:00.000Z';
const HOLDER = 'driver-example-1';

const BASE_RECORD = {
  version: 1,
  runId: RUN_A,
  workOrderId: 'wo-example-1',
  tier: 2,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': 0, fix: null, review: null },
  round: 0,
  attemptIds: ['attempt-example-1'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy-example-1',
};

function runRecord(runId: string, workOrderId = 'wo-example-1'): LaneRunRecord {
  const result = LaneRun.create({ ...BASE_RECORD, runId, workOrderId });
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

function entry(runId: string, overrides: Partial<LaneRunJournalEntryRecord> = {}): LaneRunJournalEntryRecord {
  return {
    version: 1,
    entryId: '01JB0000000000000000000099',
    kind: 'conduct',
    key: null,
    runId,
    recordedAtIso: NOW,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state: 'running',
    ...overrides,
  };
}

/** One live run and one terminal (`merged`) run's journal. */
function journalEntries(): ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]> {
  return new Map([
    [RUN_A, [entry(RUN_A)]],
    [RUN_B, [entry(RUN_B, { entryId: '01JB0000000000000000000098', state: 'merged' })]],
    [RUN_C, [entry(RUN_C, { entryId: '01JB0000000000000000000097' })]],
  ]);
}

interface CountingJournal extends RunJournalRunReads {
  readonly listForRunCalls: { value: number };
  readonly listForRunsCalls: { value: number };
}

/** A journal fake that counts both read shapes; it returns the same entries either way. */
function countingJournal(entries: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>): CountingJournal {
  const listForRunCalls = { value: 0 };
  const listForRunsCalls = { value: 0 };
  return {
    listForRunCalls,
    listForRunsCalls,
    listForRun: async (runId: string) => {
      listForRunCalls.value += 1;
      return entries.get(runId) ?? [];
    },
    listForRuns: async (runIds: readonly string[]) => {
      listForRunsCalls.value += 1;
      return new Map(runIds.map((runId) => [runId, entries.get(runId) ?? []]));
    },
  };
}

/** The same journal fake without `listForRuns`: the per-run fallback. */
function fallbackJournal(entries: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>): RunJournalRunReads {
  return {
    listForRun: async (runId: string) => entries.get(runId) ?? [],
  };
}

describe('EX-3a: scans read the run journal once', () => {
  describe('RunConductorPassUseCase', () => {
    it('one pass over three runs calls listForRuns once and listForRun never; the result equals the fallback pass', async () => {
      const entries = journalEntries();
      const advance: AdvanceLaneRunPort = {
        advanceLaneRun: async () => ({ outcome: 'done' }),
      };

      const counting = countingJournal(entries);
      // Seed the repo the counting pass reads.
      const repo = new LaneRunRepositoryAdapter();
      for (const runId of [RUN_A, RUN_B, RUN_C]) {
        await repo.create(runRecord(runId));
      }
      const groupedPass = new RunConductorPassUseCase({
        driverLease: new ConductorDriverLeaseAdapter(),
        runRepo: repo,
        runJournal: counting,
        halt: new ConductorHaltAdapter(),
        resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
        advance,
        now: () => NOW,
      });
      const groupedResult: RunConductorPassResult = await groupedPass.runPass({ holderId: HOLDER, nowIso: NOW });
      // Release the leases the pass holds, so the fallback pass starts clean.
      await groupedPass.releaseLeases({ holderId: HOLDER, nowIso: NOW });

      expect(counting.listForRunsCalls.value).toBe(1);
      expect(counting.listForRunCalls.value).toBe(0);
      expect(groupedResult).toMatchObject({ outcome: 'completed' });
      // One terminal (`merged`) run is filtered out; the two live runs advanced.
      if (groupedResult.outcome === 'completed') {
        expect(groupedResult.runs.map((run) => run.runId).sort()).toEqual([RUN_A, RUN_C]);
      }

      const fallbackPass = new RunConductorPassUseCase({
        driverLease: new ConductorDriverLeaseAdapter(),
        runRepo: repo,
        runJournal: fallbackJournal(entries),
        halt: new ConductorHaltAdapter(),
        resume: { applyPendingResume: async () => ({ outcome: 'none' }) },
        advance,
        now: () => NOW,
      });
      const fallbackResult = await fallbackPass.runPass({ holderId: HOLDER, nowIso: NOW });
      expect(fallbackResult).toEqual(groupedResult);
    });
  });

  describe('StartLaneRunUseCase (activeJournalStatesOf)', () => {
    it('the other-runs scan calls listForRuns once and listForRun never; the refusal equals the fallback scan', async () => {
      const entries = journalEntries();
      const request = {
        // A run id the repo does not hold, so the scan of the other runs runs.
        runId: 'run-01JB0000000000000000000003',
        attemptId: 'attempt-example-1',
        tier: 2 as const,
        runPolicyRevision: 'policy-example-1',
        brief: { workOrderId: 'wo-example-1', projectId: 'project-example-1' },
        nowIso: NOW,
      } as unknown as StartLaneRunRequest;

      const counting = countingJournal(entries);
      const repo = new LaneRunRepositoryAdapter();
      for (const runId of [RUN_A, RUN_B, RUN_C]) {
        await repo.create(runRecord(runId));
      }
      const deps = (runJournal: RunJournalRunReads): StartLaneRunDependencies =>
        ({
          runRepo: repo,
          workOrderRepo: {
            findWorkOrderById: async () => ({
              id: 'wo-example-1',
              state: 'approved',
            }),
          },
          runJournal,
          profileRead: { readProjectProfile: async () => null },
        }) as unknown as StartLaneRunDependencies;

      const groupedResult = await new StartLaneRunUseCase(deps(counting)).startLaneRun(request);
      expect(counting.listForRunsCalls.value).toBe(1);
      expect(counting.listForRunCalls.value).toBe(0);
      expect(groupedResult).toMatchObject({ outcome: 'refused', reason: 'run-active-for-work-order' });

      const fallbackResult = await new StartLaneRunUseCase(deps(fallbackJournal(entries))).startLaneRun(request);
      expect(fallbackResult).toEqual(groupedResult);
    });
  });

  describe('workOrderHoldFacts', () => {
    it('the runs-of-a-work-order scan calls listForRuns once and listForRun never; the facts equal the fallback scan', async () => {
      const entries = journalEntries();
      const repo = new LaneRunRepositoryAdapter();
      for (const runId of [RUN_A, RUN_B, RUN_C]) {
        await repo.create(runRecord(runId));
      }

      const counting = countingJournal(entries);
      const grouped = await workOrderHoldFacts(
        {
          runRepo: repo,
          runJournal: counting,
          executionJournal: { listActiveReservations: async () => [] },
        },
        'wo-example-1',
        ['attempt-example-1'],
        null,
      );
      expect(counting.listForRunsCalls.value).toBe(1);
      expect(counting.listForRunCalls.value).toBe(0);
      // RUN_B is terminal `merged`; the other two runs still hold the order.
      expect(grouped).toEqual({
        heldAttemptIds: [],
        nonTerminalRunIds: [RUN_A, RUN_C],
        mergedRunIds: [RUN_B],
      });

      const fallback = await workOrderHoldFacts(
        {
          runRepo: repo,
          runJournal: fallbackJournal(entries),
          executionJournal: { listActiveReservations: async () => [] },
        },
        'wo-example-1',
        ['attempt-example-1'],
        null,
      );
      expect(fallback).toEqual(grouped);
    });
  });
});
