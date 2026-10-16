import { describe, expect, it } from 'vitest';
import type {
  ActionJournalEntryRecord,
  AttemptRecord,
  CollectedAttemptArtifacts,
  CommandCompletionReceipt,
  CapacityReservationRecord,
} from '../src/domain/execution-records.js';
import type { AttemptRepositoryPort } from '../src/application/ports/out/AttemptRepositoryPort.out-port.js';
import type {
  ExecutionJournalPort,
  ReserveCapacityAtomicallyRequest,
} from '../src/application/ports/out/ExecutionJournalPort.out-port.js';
import type {
  AttemptArtifactPort,
  CollectCompletedAttemptArtifactsRequest,
  CollectCompletedAttemptArtifactsResult,
} from '../src/application/ports/out/AttemptArtifactPort.out-port.js';
import type { BriefKnowledgePort } from '../src/application/ports/out/BriefKnowledgePort.out-port.js';
import { CollectAttemptArtifactsUseCase } from '../src/application/use-cases/CollectAttemptArtifactsUseCase.use-case.js';
import { PrepareFixAttemptUseCase } from '../src/application/use-cases/PrepareFixAttemptUseCase.use-case.js';
import { InspectAttemptUseCase } from '../src/application/use-cases/InspectAttemptUseCase.use-case.js';

function createMockAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/worktrees/orig',
    baseCommit: 'commit-base-123',
    state: 'ended',
    outcome: 'done',
    briefDigest: 'sha256-brief',
    briefPackagePath: '/briefs/brief.json',
    sessionId: 'session-1',
    completionReceipt: {
      attemptId: 'att-1',
      sessionId: 'session-1',
      endedAtIso: '2026-10-15T10:00:00Z',
      authoritative: true,
      exitStatus: 0,
      stoppedByRequest: false,
    },
    artifacts: null,
    createdAtIso: '2026-10-15T09:00:00Z',
    updatedAtIso: '2026-10-15T10:00:00Z',
    ...overrides,
  };
}

class InMemoryAttemptRepo implements AttemptRepositoryPort {
  readonly store = new Map<string, AttemptRecord>();

  async saveAttempt(record: AttemptRecord): Promise<void> {
    this.store.set(record.id, record);
  }

  async findAttemptById(attemptId: string): Promise<AttemptRecord | null> {
    return this.store.get(attemptId) ?? null;
  }

  async listAttemptsByWorkOrder(workOrderId: string): Promise<readonly AttemptRecord[]> {
    return Array.from(this.store.values()).filter((a) => a.workOrderId === workOrderId);
  }

  async listAllAttempts(): Promise<readonly AttemptRecord[]> {
    return Array.from(this.store.values());
  }
}

class InMemoryJournal implements ExecutionJournalPort {
  readonly entries: ActionJournalEntryRecord[] = [];

  async appendJournalEntry(entry: ActionJournalEntryRecord): Promise<void> {
    this.entries.push(entry);
  }

  async listJournalEntriesForAttempt(attemptId: string): Promise<readonly ActionJournalEntryRecord[]> {
    return this.entries.filter((e) => e.attemptId === attemptId);
  }

  async saveCapacityReservation(): Promise<void> {}
  async listActiveReservations() {
    return [];
  }
  async releaseCapacityReservation(): Promise<boolean> {
    return true;
  }
  async reserveCapacityAtomically(request: ReserveCapacityAtomicallyRequest) {
    const reservation: CapacityReservationRecord = { ...request.record, slotIndex: 0 };
    return { outcome: 'reserved' as const, reservation };
  }
}

class MockArtifactPort implements AttemptArtifactPort {
  lastCollectRequest: CollectCompletedAttemptArtifactsRequest | null = null;

  async verifyIgnoredPaths() {
    return { outcome: 'ignored' as const, checkedPaths: [] };
  }

  async placeFrozenBrief() {
    return { outcome: 'placed' as const, prosePath: '', manifestPath: '' };
  }

  async collectCompletedAttemptArtifacts(
    request: CollectCompletedAttemptArtifactsRequest,
  ): Promise<CollectCompletedAttemptArtifactsResult> {
    this.lastCollectRequest = request;
    const artifacts: CollectedAttemptArtifacts = {
      headCommit: 'commit-head-456',
      commitsSinceBase: ['commit-head-456'],
      collectedArtifactPaths: ['/out/patch.diff'],
      notes: 'present',
    };
    return { outcome: 'collected', artifacts };
  }
}

class MockBriefKnowledgePort implements BriefKnowledgePort {
  async requestBriefContextProposals() {
    return { outcome: 'proposed' as const, proposals: [] };
  }
  async recordContextSelection() {
    return { outcome: 'recorded' as const };
  }
  async forwardCompletedAttemptNotes() {
    return { outcome: 'forwarded' as const };
  }
}

describe('CollectAttemptArtifactsUseCase hardening', () => {
  it('refuses worktreePath that does not match attempt', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const mock = createMockAttempt();
    await attemptRepo.saveAttempt(mock);
    const journal = new InMemoryJournal();
    const artifactPort = new MockArtifactPort();
    const briefKnowledge = new MockBriefKnowledgePort();

    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort,
      briefKnowledge,
    });

    const result = await useCase.collectAttemptArtifacts({
      attemptId: mock.id,
      workOrderId: mock.workOrderId,
      expectedArtifacts: ['/out/patch.diff'],
      completionReceipt: mock.completionReceipt!,
      worktreePath: '/worktrees/different',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('worktreePath differs from recorded attempt');
    }
    expect(artifactPort.lastCollectRequest).toBeNull();
  });

  it('refuses baseCommit that does not match attempt', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const mock = createMockAttempt();
    await attemptRepo.saveAttempt(mock);
    const journal = new InMemoryJournal();
    const artifactPort = new MockArtifactPort();
    const briefKnowledge = new MockBriefKnowledgePort();

    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort,
      briefKnowledge,
    });

    const result = await useCase.collectAttemptArtifacts({
      attemptId: mock.id,
      workOrderId: mock.workOrderId,
      expectedArtifacts: ['/out/patch.diff'],
      completionReceipt: mock.completionReceipt!,
      baseCommit: 'wrong-base-commit',
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('baseCommit differs from recorded attempt');
    }
    expect(artifactPort.lastCollectRequest).toBeNull();
  });

  it('succeeds and resolves worktreePath and baseCommit from attempt when omitted', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const mock = createMockAttempt();
    await attemptRepo.saveAttempt(mock);
    const journal = new InMemoryJournal();
    const artifactPort = new MockArtifactPort();
    const briefKnowledge = new MockBriefKnowledgePort();

    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort,
      briefKnowledge,
    });

    const result = await useCase.collectAttemptArtifacts({
      attemptId: mock.id,
      workOrderId: mock.workOrderId,
      expectedArtifacts: ['/out/patch.diff'],
      completionReceipt: mock.completionReceipt!,
    });

    expect(result.outcome).toBe('collected');
    expect(artifactPort.lastCollectRequest).not.toBeNull();
    expect(artifactPort.lastCollectRequest?.worktreePath).toBe(mock.worktreePath);
    expect(artifactPort.lastCollectRequest?.baseCommit).toBe(mock.baseCommit);
  });

  it('succeeds when provided worktreePath and baseCommit match attempt', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const mock = createMockAttempt();
    await attemptRepo.saveAttempt(mock);
    const journal = new InMemoryJournal();
    const artifactPort = new MockArtifactPort();
    const briefKnowledge = new MockBriefKnowledgePort();

    const useCase = new CollectAttemptArtifactsUseCase({
      attemptRepo,
      journal,
      artifactPort,
      briefKnowledge,
    });

    const result = await useCase.collectAttemptArtifacts({
      attemptId: mock.id,
      workOrderId: mock.workOrderId,
      expectedArtifacts: ['/out/patch.diff'],
      completionReceipt: mock.completionReceipt!,
      worktreePath: mock.worktreePath,
      baseCommit: mock.baseCommit,
    });

    expect(result.outcome).toBe('collected');
    expect(artifactPort.lastCollectRequest?.worktreePath).toBe(mock.worktreePath);
    expect(artifactPort.lastCollectRequest?.baseCommit).toBe(mock.baseCommit);
  });
});

describe('PrepareFixAttemptUseCase hardening', () => {
  it('refuses worktreePath that does not match prior attempt', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const prior = createMockAttempt({ id: 'att-prior' });
    await attemptRepo.saveAttempt(prior);

    const useCase = new PrepareFixAttemptUseCase({ attemptRepo });

    const result = await useCase.prepareFixAttempt({
      fixAttemptId: 'att-fix-1',
      workOrderId: prior.workOrderId,
      priorAttemptId: prior.id,
      worktreePath: '/worktrees/different',
      numberedFixes: ['Fix 1'],
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('worktreePath does not match');
    }
  });

  it('refuses baseCommit that does not match prior attempt', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const prior = createMockAttempt({ id: 'att-prior' });
    await attemptRepo.saveAttempt(prior);

    const useCase = new PrepareFixAttemptUseCase({ attemptRepo });

    const result = await useCase.prepareFixAttempt({
      fixAttemptId: 'att-fix-1',
      workOrderId: prior.workOrderId,
      priorAttemptId: prior.id,
      baseCommit: 'different-base',
      numberedFixes: ['Fix 1'],
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.reason).toContain('baseCommit does not match');
    }
  });

  it('succeeds and copies worktreePath and baseCommit from prior attempt when omitted', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const prior = createMockAttempt({ id: 'att-prior' });
    await attemptRepo.saveAttempt(prior);

    const useCase = new PrepareFixAttemptUseCase({ attemptRepo });

    const result = await useCase.prepareFixAttempt({
      fixAttemptId: 'att-fix-1',
      workOrderId: prior.workOrderId,
      priorAttemptId: prior.id,
      numberedFixes: ['Fix 1'],
    });

    expect(result.outcome).toBe('prepared');
    if (result.outcome === 'prepared') {
      expect(result.attempt.worktreePath).toBe(prior.worktreePath);
      expect(result.attempt.baseCommit).toBe(prior.baseCommit);
      expect(result.attempt.kind).toBe('fix');
      expect(result.attempt.fixNumber).toBe(1);
    }
  });

  it('succeeds when provided worktreePath and baseCommit match prior attempt', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const prior = createMockAttempt({ id: 'att-prior' });
    await attemptRepo.saveAttempt(prior);

    const useCase = new PrepareFixAttemptUseCase({ attemptRepo });

    const result = await useCase.prepareFixAttempt({
      fixAttemptId: 'att-fix-1',
      workOrderId: prior.workOrderId,
      priorAttemptId: prior.id,
      worktreePath: prior.worktreePath,
      baseCommit: prior.baseCommit,
      numberedFixes: ['Fix 1'],
    });

    expect(result.outcome).toBe('prepared');
    if (result.outcome === 'prepared') {
      expect(result.attempt.worktreePath).toBe(prior.worktreePath);
      expect(result.attempt.baseCommit).toBe(prior.baseCommit);
    }
  });
});

describe('InspectAttemptUseCase', () => {
  it('throws when unconfigured', async () => {
    const useCase = new InspectAttemptUseCase();
    await expect(useCase.inspectAttempt({ attemptId: 'att-1' })).rejects.toThrow(
      'Not implemented: InspectAttemptUseCase',
    );
  });

  it('returns not-found for non-existent attempt', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const useCase = new InspectAttemptUseCase({ attemptRepo });

    const result = await useCase.inspectAttempt({ attemptId: 'att-missing' });
    expect(result).toEqual({ outcome: 'not-found', attemptId: 'att-missing' });
  });

  it('returns found for existing attempt without mutations', async () => {
    const attemptRepo = new InMemoryAttemptRepo();
    const attempt = createMockAttempt();
    await attemptRepo.saveAttempt(attempt);

    const useCase = new InspectAttemptUseCase({ attemptRepo });

    const result = await useCase.inspectAttempt({ attemptId: attempt.id });
    expect(result).toEqual({ outcome: 'found', attempt });
  });
});
