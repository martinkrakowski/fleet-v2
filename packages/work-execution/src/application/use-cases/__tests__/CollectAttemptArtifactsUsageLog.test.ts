import { describe, expect, it } from 'vitest';

import { CollectAttemptArtifactsUseCase } from '../CollectAttemptArtifactsUseCase.use-case.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  AttemptUsageRecord,
  CommandCompletionReceipt,
} from '../../../domain/execution-records.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type { AttemptArtifactPort } from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { ReadUsageResult, UsagePort } from '../../ports/out/UsagePort.out-port.js';
import type { CollectAttemptArtifactsRequest } from '../../ports/in/CollectAttemptArtifactsPort.in-port.js';
import type { LaneUsageLogRow } from '../../../domain/lane-usage-log.js';

function makeAttemptRepo(): AttemptRepositoryPort & { attempts: Map<string, AttemptRecord> } {
  const attempts = new Map<string, AttemptRecord>();
  return {
    attempts,
    async saveAttempt(record) {
      attempts.set(record.id, record);
    },
    async findAttemptById(attemptId) {
      return attempts.get(attemptId) ?? null;
    },
    async listAttemptsByWorkOrder(workOrderId) {
      return [...attempts.values()].filter((attempt) => attempt.workOrderId === workOrderId);
    },
    async listAllAttempts() {
      return [...attempts.values()];
    },
  };
}

function storedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/run-1/attempt-1',
    baseCommit: 'abc123',
    state: 'ended',
    outcome: null,
    briefDigest: 'digest-1',
    briefPackagePath: '.lane/brief.md',
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: null,
    createdAtIso: '2026-11-16T08:00:00.000Z',
    updatedAtIso: '2026-11-16T08:00:00.000Z',
    ...overrides,
  };
}

function receiptFor(): CommandCompletionReceipt {
  return {
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    endedAtIso: '2026-11-16T10:00:00.000Z',
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
  };
}

function makeJournal(): ExecutionJournalPort {
  const entries: ActionJournalEntryRecord[] = [];
  return {
    async listJournalEntriesForAttempt() {
      return entries;
    },
    async appendJournalEntry(entry: ActionJournalEntryRecord) {
      entries.push(entry);
    },
    async releaseCapacityReservation() {
      return false;
    },
  } as unknown as ExecutionJournalPort;
}

function makeArtifactPort(): AttemptArtifactPort {
  return {
    async collectCompletedAttemptArtifacts() {
      return {
        outcome: 'collected',
        artifacts: {
          headCommit: 'head1',
          commitsSinceBase: ['c1'],
          collectedArtifactPaths: ['docs/a.md'],
          notes: 'missing',
        },
      };
    },
  } as unknown as AttemptArtifactPort;
}

function meteredUsage(): AttemptUsageRecord {
  return {
    source: 'opencode-db',
    readAtIso: '2026-11-16T10:00:00.000Z',
    sessionId: 'session-1',
    steps: 12,
    wallSeconds: 120,
    runnerMinutes: 2,
    tokensInput: 500,
    tokensOutput: 100,
    tokensReasoning: null,
    tokensCacheRead: null,
    tokensCacheWrite: null,
    costUsd: 0.02,
    model: 'openai/gpt-6-luna',
    agent: 'implementer',
    reason: null,
  };
}

function makeUsagePort(
  result: () => Promise<ReadUsageResult>,
): UsagePort & { calls: number } {
  return {
    calls: 0,
    async readUsage(_request) {
      this.calls += 1;
      return result();
    },
  } as UsagePort & { calls: number };
}

function requestFor(): CollectAttemptArtifactsRequest {
  return {
    attemptId: 'attempt-1',
    workOrderId: 'wo-1',
    expectedArtifacts: [],
    completionReceipt: receiptFor(),
  };
}

function makeUsageLog(options: {
  reject?: boolean;
  throw?: boolean;
}): LaneUsageLogPortFake {
  return new LaneUsageLogPortFake(options);
}

class LaneUsageLogPortFake {
  readonly rows: LaneUsageLogRow[] = [];
  private readonly reject: boolean;
  private readonly boom: boolean;
  constructor(options: { reject?: boolean; throw?: boolean } = {}) {
    this.reject = options.reject ?? false;
    this.boom = options.throw ?? false;
  }
  async append(row: LaneUsageLogRow) {
    if (this.boom) {
      throw new Error('usage log boom');
    }
    if (this.reject) {
      return { outcome: 'refused' as const, reason: 'store-unreadable' as const };
    }
    this.rows.push(row);
    return { outcome: 'appended' as const };
  }
}

describe('CollectAttemptArtifactsUseCase lane usage log (OG14)', () => {
  it('writes one metered usage row when a finished attempt is collected', async () => {
    const repo = makeAttemptRepo();
    repo.attempts.set('attempt-1', storedAttempt({
      runner: { kind: 'opencode', remotePort: 4097, host: null, hostName: null, agent: null, model: null, variant: null },
    }));
    const usage = makeUsagePort(async () => ({ outcome: 'read', usage: meteredUsage() }));
    const usageLog = makeUsageLog({});
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: repo,
      journal: makeJournal(),
      artifactPort: makeArtifactPort(),
      usage,
      usageLog,
    });
    const result = await useCase.collectAttemptArtifacts(requestFor());
    expect(result.outcome).toBe('collected');
    expect(usageLog.rows).toHaveLength(1);
    expect(usageLog.rows[0]).toMatchObject({
      schemaVersion: 1,
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      worktreeName: 'attempt-1',
      kind: 'initial',
      outcome: 'done',
      runnerKind: 'opencode',
      billing: 'metered',
      source: 'opencode-db',
      steps: 12,
      runnerMinutes: 2,
      costUsd: 0.02,
      costBasis: 'metered',
    });
  });

  it('writes one unavailable usage row and still collects when usage port throws', async () => {
    const repo = makeAttemptRepo();
    repo.attempts.set('attempt-1', storedAttempt());
    const usage = makeUsagePort(async () => {
      throw new Error('usage read boom');
    });
    const usageLog = makeUsageLog({});
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: repo,
      journal: makeJournal(),
      artifactPort: makeArtifactPort(),
      usage,
      usageLog,
    });
    const result = await useCase.collectAttemptArtifacts(requestFor());
    expect(result.outcome).toBe('collected');
    expect(usageLog.rows).toHaveLength(1);
    expect(usageLog.rows[0]).toMatchObject({
      attemptId: 'attempt-1',
      source: 'unavailable',
      costBasis: 'unknown',
      steps: null,
      costUsd: null,
    });
  });

  it('collects without throwing when usageLog.append is missing, rejects or throws', async () => {
    const logs: Array<LaneUsageLogPortFake | Record<string, never>> = [
      {},
      makeUsageLog({ reject: true }),
      makeUsageLog({ throw: true }),
      new LaneUsageLogPortFake(),
    ];
    for (const usageLog of logs) {
      const repo = makeAttemptRepo();
      repo.attempts.set('attempt-1', storedAttempt());
      const usage = makeUsagePort(async () => ({ outcome: 'read', usage: meteredUsage() }));
      const useCase = new CollectAttemptArtifactsUseCase({
        attemptRepo: repo,
        journal: makeJournal(),
        artifactPort: makeArtifactPort(),
        usage,
        usageLog,
      });
      const result = await useCase.collectAttemptArtifacts(requestFor());
      expect(result.outcome).toBe('collected');
    }
  });

  it('collects without a usage port or usage log at all', async () => {
    const repo = makeAttemptRepo();
    repo.attempts.set('attempt-1', storedAttempt());
    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo: repo,
      journal: makeJournal(),
      artifactPort: makeArtifactPort(),
    });
    const result = await useCase.collectAttemptArtifacts(requestFor());
    expect(result.outcome).toBe('collected');
  });
});
