import { describe, expect, it } from 'vitest';

import { CollectAttemptArtifactsUseCase } from '../CollectAttemptArtifactsUseCase.use-case.js';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CommandCompletionReceipt,
} from '../../../domain/execution-records.js';
import type { ExecutionJournalPort } from '../../ports/out/ExecutionJournalPort.out-port.js';
import type {
  AttemptArtifactPort,
  SealArtifactManifestRequest,
  SealArtifactManifestResult,
} from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';
import type { CollectAttemptArtifactsRequest } from '../../ports/in/CollectAttemptArtifactsPort.in-port.js';

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
    ...overrides,
  };
}

function receiptFor(): CommandCompletionReceipt {
  return {
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    endedAtIso: '2026-10-24T10:00:00.000Z',
    authoritative: true,
    exitStatus: 0,
    stoppedByRequest: false,
  };
}

function makeJournal(): ExecutionJournalPort & { entries: ActionJournalEntryRecord[] } {
  const entries: ActionJournalEntryRecord[] = [];
  const journal = {
    entries,
    async listJournalEntriesForAttempt() {
      return entries;
    },
    async appendJournalEntry(entry: ActionJournalEntryRecord) {
      entries.push(entry);
    },
    async releaseCapacityReservation() {
      return false;
    },
  } as unknown as ExecutionJournalPort & { entries: ActionJournalEntryRecord[] };
  return journal;
}

interface ArtifactPortFake extends AttemptArtifactPort {
  sealCalls: SealArtifactManifestRequest[];
}

function makeArtifactPort(
  seal?: (request: SealArtifactManifestRequest) => Promise<SealArtifactManifestResult>,
): ArtifactPortFake {
  const sealCalls: SealArtifactManifestRequest[] = [];
  const port: ArtifactPortFake = {
    sealCalls,
    async verifyIgnoredPaths() {
      return { outcome: 'ignored', checkedPaths: [] };
    },
    async placeFrozenBrief() {
      return { outcome: 'placed', prosePath: '.lane/brief.md', manifestPath: '.lane/brief-manifest.json' };
    },
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
  };
  if (seal !== undefined) {
    port.sealArtifactManifest = async (request) => {
      sealCalls.push(request);
      return seal(request);
    };
  }
  return port;
}

describe('CollectAttemptArtifactsUseCase artifact manifest sealing', () => {
  it('records the sealed manifest digest when sealing succeeds', async () => {
    const receipt = receiptFor();
    const repo = makeAttemptRepo();
    repo.attempts.set('attempt-1', storedAttempt({ state: 'ended', completionReceipt: receipt }));
    const journal = makeJournal();
    const artifactPort = makeArtifactPort(async (request) => {
      return {
        outcome: 'sealed',
        manifestPath: '.lane/artifacts-manifest.json',
        manifestSha256: 'f'.repeat(64),
        manifest: {
          schemaVersion: 1,
          attemptId: request.attemptId,
          files: [],
          total: { files: 0, bytes: 0 },
        },
      };
    });
    const useCase = new CollectAttemptArtifactsUseCase({ attemptRepo: repo, journal, artifactPort });
    const request: CollectAttemptArtifactsRequest = {
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      expectedArtifacts: ['docs/a.md'],
      completionReceipt: receipt,
    };
    const result = await useCase.collectAttemptArtifacts(request);
    expect(result).toEqual({
      outcome: 'collected',
      artifacts: expect.objectContaining({ manifestSha256: 'f'.repeat(64) }),
    });
    const stored = repo.attempts.get('attempt-1');
    expect(stored?.state).toBe('collected');
    expect(stored?.artifacts?.manifestSha256).toBe('f'.repeat(64));
    expect(artifactPort.sealCalls).toHaveLength(1);
    expect(artifactPort.sealCalls[0].artifactPaths).toEqual(['docs/a.md']);
    expect(artifactPort.sealCalls[0].worktreePath).toBe('/lanes/attempt-1');
  });

  it('refuses collection when sealing refuses', async () => {
    const receipt = receiptFor();
    const repo = makeAttemptRepo();
    repo.attempts.set('attempt-1', storedAttempt({ state: 'ended', completionReceipt: receipt }));
    const journal = makeJournal();
    const artifactPort = makeArtifactPort(async () => ({ outcome: 'refused', reason: 'gitignore missing' }));
    const useCase = new CollectAttemptArtifactsUseCase({ attemptRepo: repo, journal, artifactPort });
    const request: CollectAttemptArtifactsRequest = {
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      expectedArtifacts: ['docs/a.md'],
      completionReceipt: receipt,
    };
    const result = await useCase.collectAttemptArtifacts(request);
    expect(result).toEqual({ outcome: 'refused', reason: 'Artifact manifest not sealed: gitignore missing' });
    expect(repo.attempts.get('attempt-1')?.state).toBe('ended');
    expect(journal.entries).toEqual([]);
  });

  it('collects without a manifestSha256 when the port does not seal', async () => {
    const receipt = receiptFor();
    const repo = makeAttemptRepo();
    repo.attempts.set('attempt-1', storedAttempt({ state: 'ended', completionReceipt: receipt }));
    const journal = makeJournal();
    const artifactPort = makeArtifactPort();
    const useCase = new CollectAttemptArtifactsUseCase({ attemptRepo: repo, journal, artifactPort });
    const request: CollectAttemptArtifactsRequest = {
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      expectedArtifacts: ['docs/a.md'],
      completionReceipt: receipt,
    };
    const result = await useCase.collectAttemptArtifacts(request);
    expect(result.outcome).toBe('collected');
    if (result.outcome !== 'collected') return;
    expect('manifestSha256' in result.artifacts).toBe(false);
    expect(repo.attempts.get('attempt-1')?.artifacts).not.toHaveProperty('manifestSha256');
  });
});
