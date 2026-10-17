import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord, KnowledgeTriageFlag } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type {
  KeeperPublicationPort,
  PublishKeeperToShelfRequest,
  PublishKeeperToShelfResult,
} from '../ports/out/KeeperPublicationPort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import { PublishAcceptedKeeperUseCase } from './PublishAcceptedKeeperUseCase.use-case.js';

class InMemoryKnowledgeEntryRepository implements KnowledgeEntryRepositoryPort {
  private readonly entries = new Map<string, KnowledgeEntryRecord>();

  async saveEntry(record: KnowledgeEntryRecord): Promise<void> {
    this.entries.set(record.id, { ...record });
  }

  async findEntryById(entryId: string): Promise<KnowledgeEntryRecord | null> {
    const entry = this.entries.get(entryId);
    return entry ? { ...entry } : null;
  }

  async listEntriesByProject(projectId?: string): Promise<readonly KnowledgeEntryRecord[]> {
    const all = Array.from(this.entries.values());
    if (!projectId) return all;
    return all.filter((entry) => entry.projectId === projectId);
  }

  async listEntriesBySourceAttempt(attemptId: string): Promise<readonly KnowledgeEntryRecord[]> {
    return [...this.entries.values()].filter((entry) => entry.sourceAttemptId === attemptId);
  }

  async setTriageFlag(_entryId: string, _flag: KnowledgeTriageFlag): Promise<void> {}

  async saveContextSelections(_attemptId: string, _selections: readonly ContextSelectionProps[]): Promise<void> {}

  async listContextSelections(_attemptId: string): Promise<readonly ContextSelectionProps[]> {
    return [];
  }
}

class FakeKeeperPublisher implements KeeperPublicationPort {
  readonly publishedEntries: KnowledgeEntryRecord[] = [];
  resultToReturn: PublishKeeperToShelfResult = {
    outcome: 'published',
    externalRef: 'shelf://mock-export/1',
  };

  async publishKeeperToShelf(request: PublishKeeperToShelfRequest): Promise<PublishKeeperToShelfResult> {
    this.publishedEntries.push(request.entry);
    return this.resultToReturn;
  }
}

function createEntryRecord(overrides: Partial<KnowledgeEntryRecord> = {}): KnowledgeEntryRecord {
  return {
    id: 'ke-1',
    version: '1.0.0',
    projectId: 'proj-alpha',
    sourceAttemptId: 'att-1',
    sourceCommitSha: 'c0ffee1',
    claimText: 'TypeScript compiler requires rootDir configuration.',
    pathPrefixes: ['tsconfig.json'],
    sharedAcrossProjects: false,
    disposition: 'candidate',
    verification: 'supported',
    checkerId: null,
    dispositionReason: null,
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-15T10:00:00.000Z',
    updatedAtIso: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('PublishAcceptedKeeperUseCase', () => {
  it('throws when use case is unconfigured without dependencies', async () => {
    const useCase = new PublishAcceptedKeeperUseCase();
    await expect(useCase.execute({ entryId: 'ke-1' })).rejects.toThrow(
      'Not implemented: PublishAcceptedKeeperUseCase',
    );
  });

  it('rejects when entryId is missing or blank', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const publisher = new FakeKeeperPublisher();
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });

    const result = await useCase.execute({ entryId: '   ' });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'PublishAcceptedKeeper requires a non-empty entryId',
    });
  });

  it('returns rejected outcome when entry is not found', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const publisher = new FakeKeeperPublisher();
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });

    const result = await useCase.execute({ entryId: 'ke-missing' });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Knowledge entry not found: ke-missing',
    });
  });

  it('work order test: a contradicted keeper is not published', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const publisher = new FakeKeeperPublisher();
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });

    // Contradicted candidate entry
    const contradictedCandidate = createEntryRecord({
      id: 'ke-contra-cand',
      disposition: 'candidate',
      verification: 'contradicted',
    });
    await repo.saveEntry(contradictedCandidate);

    const candResult = await useCase.execute({ entryId: 'ke-contra-cand' });
    expect(candResult).toEqual({
      outcome: 'rejected',
      reason: 'Only accepted keepers may be published',
    });

    // Contradicted entry with accepted disposition (e.g. invalid state)
    const contradictedAccepted = createEntryRecord({
      id: 'ke-contra-acc',
      disposition: 'accepted',
      verification: 'contradicted',
      checkerId: 'checker-1',
    });
    await repo.saveEntry(contradictedAccepted);

    const accResult = await useCase.execute({ entryId: 'ke-contra-acc' });
    expect(accResult).toEqual({
      outcome: 'rejected',
      reason: 'Only supported keepers may be published',
    });

    // Ensure publisher was never called
    expect(publisher.publishedEntries).toHaveLength(0);
  });

  it('refuses to publish unverified or non-accepted entries', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const publisher = new FakeKeeperPublisher();
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });

    const unverifiedCandidate = createEntryRecord({
      id: 'ke-cand-1',
      disposition: 'candidate',
      verification: 'unverified',
    });
    await repo.saveEntry(unverifiedCandidate);

    const result = await useCase.execute({ entryId: 'ke-cand-1' });
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Only accepted keepers may be published',
    });
    expect(publisher.publishedEntries).toHaveLength(0);
  });

  it('refuses to publish superseded keepers', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const publisher = new FakeKeeperPublisher();
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });

    const supersededKeeper = createEntryRecord({
      id: 'ke-old-1',
      disposition: 'superseded',
      verification: 'supported',
      checkerId: 'checker-1',
      supersededById: 'ke-new-1',
    });
    await repo.saveEntry(supersededKeeper);

    const result = await useCase.execute({ entryId: 'ke-old-1' });
    expect(result.outcome).toBe('rejected');
    expect(publisher.publishedEntries).toHaveLength(0);
  });

  it('publishes valid accepted keeper with supported verification', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const publisher = new FakeKeeperPublisher();
    publisher.resultToReturn = {
      outcome: 'published',
      externalRef: 'shelf://shelf-alpha/entry-accepted-1',
    };

    const acceptedKeeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-lead',
      dispositionReason: 'verified by regression suite',
      supersededById: null,
    });
    await repo.saveEntry(acceptedKeeper);

    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });
    const result = await useCase.execute({ entryId: 'ke-accepted-1' });

    expect(result).toEqual({
      outcome: 'published',
      entry: acceptedKeeper,
      externalRef: 'shelf://shelf-alpha/entry-accepted-1',
    });
    expect(publisher.publishedEntries).toHaveLength(1);
    expect(publisher.publishedEntries[0]?.id).toBe('ke-accepted-1');
  });

  it('preserves failed delivery for reconciliation without throwing', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const publisher = new FakeKeeperPublisher();
    publisher.resultToReturn = {
      outcome: 'failed',
      reason: 'Remote shelf connection timed out',
    };

    const acceptedKeeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-lead',
      dispositionReason: 'verified',
      supersededById: null,
    });
    await repo.saveEntry(acceptedKeeper);

    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });
    const result = await useCase.execute({ entryId: 'ke-accepted-1' });

    expect(result).toEqual({
      outcome: 'delivery-failed',
      entry: acceptedKeeper,
      reason: 'Remote shelf connection timed out',
    });
  });
});
