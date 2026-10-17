import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import type { KnowledgeTriageFlag } from '../../domain/knowledge-records.js';
import { ListCandidateClaimsUseCase } from './ListCandidateClaimsUseCase.use-case.js';

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

describe('ListCandidateClaimsUseCase', () => {
  it('throws when use case is unconfigured without dependencies', async () => {
    const useCase = new ListCandidateClaimsUseCase();
    await expect(useCase.execute({ attemptId: 'att-1' })).rejects.toThrow(
      'Not implemented: ListCandidateClaimsUseCase',
    );
  });

  it('rejects a blank attemptId', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new ListCandidateClaimsUseCase({ repo });

    const result = await useCase.execute({ attemptId: '   ' });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'ListCandidateClaims requires a non-empty attemptId',
    });
  });

  it('rejects a score map with a non-finite or non-numeric value', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new ListCandidateClaimsUseCase({ repo });

    const notNumber = await useCase.execute({
      attemptId: 'att-1',
      scores: { 'ke-1': 'high' } as unknown as Record<string, number>,
    });
    expect(notNumber).toEqual({
      outcome: 'rejected',
      reason: 'ListCandidateClaims requires scores to be a map of candidate id to finite number',
    });

    const notFinite = await useCase.execute({ attemptId: 'att-1', scores: { 'ke-1': Number.NaN } });
    expect(notFinite).toEqual({
      outcome: 'rejected',
      reason: 'ListCandidateClaims requires scores to be a map of candidate id to finite number',
    });
  });

  it('lists the attempt candidates in id order without scores', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-b' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-a' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-c' }));
    const useCase = new ListCandidateClaimsUseCase({ repo });

    const result = await useCase.execute({ attemptId: 'att-1' });

    expect(result.outcome).toBe('listed');
    if (result.outcome === 'listed') {
      expect(result.candidates.map((entry) => entry.id)).toEqual(['ke-a', 'ke-b', 'ke-c']);
    }
  });

  it('orders by the score map, higher first, unscored candidates after in id order', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-unscored-2' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-mid' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-unscored-1' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-top' }));
    const useCase = new ListCandidateClaimsUseCase({ repo });

    const result = await useCase.execute({
      attemptId: 'att-1',
      scores: { 'ke-mid': 0.4, 'ke-top': 0.9 },
    });

    expect(result.outcome).toBe('listed');
    if (result.outcome === 'listed') {
      expect(result.candidates.map((entry) => entry.id)).toEqual([
        'ke-top',
        'ke-mid',
        'ke-unscored-1',
        'ke-unscored-2',
      ]);
    }
  });

  it('keeps id order for tied scores', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-b' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-a' }));
    const useCase = new ListCandidateClaimsUseCase({ repo });

    const result = await useCase.execute({ attemptId: 'att-1', scores: { 'ke-a': 0.5, 'ke-b': 0.5 } });

    expect(result.outcome).toBe('listed');
    if (result.outcome === 'listed') {
      expect(result.candidates.map((entry) => entry.id)).toEqual(['ke-a', 'ke-b']);
    }
  });

  it('never drops or truncates entries: every candidate of the attempt is listed', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const ids = Array.from({ length: 25 }, (_, index) => `ke-${String(index).padStart(2, '0')}`);
    for (const id of ids) {
      await repo.saveEntry(createEntryRecord({ id }));
    }
    // Scores for a scattered subset; the rest stay unscored.
    const scores: Record<string, number> = {};
    for (const id of ids.filter((_, index) => index % 5 === 2)) {
      scores[id] = 0.3;
    }
    const useCase = new ListCandidateClaimsUseCase({ repo });

    const result = await useCase.execute({ attemptId: 'att-1', scores });

    expect(result.outcome).toBe('listed');
    if (result.outcome === 'listed') {
      expect(result.candidates).toHaveLength(25);
      expect([...result.candidates.map((entry) => entry.id)].sort()).toEqual(ids);
    }
  });

  it('lists only undecided candidates and only the requested attempt', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-candidate' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-accepted', disposition: 'accepted' }));
    await repo.saveEntry(createEntryRecord({ id: 'ke-other-attempt', sourceAttemptId: 'att-2' }));
    const useCase = new ListCandidateClaimsUseCase({ repo });

    const result = await useCase.execute({ attemptId: 'att-1' });

    expect(result.outcome).toBe('listed');
    if (result.outcome === 'listed') {
      expect(result.candidates.map((entry) => entry.id)).toEqual(['ke-candidate']);
    }
  });
});
