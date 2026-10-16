import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import { DecideKnowledgeDispositionUseCase } from './DecideKnowledgeDispositionUseCase.use-case.js';

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

describe('DecideKnowledgeDispositionUseCase', () => {
  it('throws when use case is unconfigured without dependencies', async () => {
    const useCase = new DecideKnowledgeDispositionUseCase();
    await expect(
      useCase.execute({
        entryId: 'ke-1',
        disposition: 'accepted',
        checkerId: 'checker-1',
        reason: 'Valid claim',
      }),
    ).rejects.toThrow('Not implemented: DecideKnowledgeDispositionUseCase');
  });

  it('rejects when required parameters are missing or blank', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const missingEntry = await useCase.execute({
      entryId: '   ',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Valid claim',
    });
    expect(missingEntry).toEqual({
      outcome: 'rejected',
      reason: 'DecideKnowledgeDisposition requires a non-empty entryId',
    });

    const missingChecker = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: '',
      reason: 'Valid claim',
    });
    expect(missingChecker).toEqual({
      outcome: 'rejected',
      reason: 'DecideKnowledgeDisposition requires a non-empty checkerId',
    });

    const missingReason = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: '   ',
    });
    expect(missingReason).toEqual({
      outcome: 'rejected',
      reason: 'DecideKnowledgeDisposition requires a non-empty reason',
    });
  });

  it('returns rejected outcome when entry is not found', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.execute({
      entryId: 'ke-nonexistent',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Valid claim',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Knowledge entry not found: ke-nonexistent',
    });
  });

  it('routes disposition decision through KnowledgeEntry entity and persists updated record', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const candidate = createEntryRecord({
      id: 'ke-1',
      disposition: 'candidate',
      verification: 'supported',
      revision: 1,
    });
    await repo.saveEntry(candidate);

    const useCase = new DecideKnowledgeDispositionUseCase({ repo });
    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-lead',
      reason: 'Verified by integration check',
      nowIso: '2026-10-15T12:00:00.000Z',
    });

    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') {
      expect(result.entry.disposition).toBe('accepted');
      expect(result.entry.checkerId).toBe('checker-lead');
      expect(result.entry.dispositionReason).toBe('Verified by integration check');
      expect(result.entry.revision).toBe(2);
      expect(result.entry.updatedAtIso).toBe('2026-10-15T12:00:00.000Z');
    }

    const saved = await repo.findEntryById('ke-1');
    expect(saved?.disposition).toBe('accepted');
    expect(saved?.revision).toBe(2);
  });

  it('applies entity guard: a superseded entry cannot be re-accepted', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const superseded = createEntryRecord({
      id: 'ke-old-1',
      disposition: 'superseded',
      verification: 'supported',
      checkerId: 'checker-1',
      supersededById: 'ke-newer-1',
      dispositionReason: 'superseded earlier',
    });
    await repo.saveEntry(superseded);

    const useCase = new DecideKnowledgeDispositionUseCase({ repo });
    const result = await useCase.execute({
      entryId: 'ke-old-1',
      disposition: 'accepted',
      checkerId: 'checker-2',
      reason: 'Attempting to re-accept superseded entry',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('Superseded content is excluded from retrieval and cannot be re-accepted');
    }
  });

  it('applies entity guard: an unverified claim cannot become accepted', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const unverified = createEntryRecord({
      id: 'ke-unverified-1',
      disposition: 'candidate',
      verification: 'unverified',
    });
    await repo.saveEntry(unverified);

    const useCase = new DecideKnowledgeDispositionUseCase({ repo });
    const result = await useCase.execute({
      entryId: 'ke-unverified-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Attempting to accept unverified claim',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('An unverified claim cannot become accepted');
    }
  });

  it('never accepts policy proposals', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const candidate = createEntryRecord({
      id: 'ke-policy-1',
      disposition: 'candidate',
      verification: 'supported',
      claimText: 'Change permissions for the deploy seat',
    });
    await repo.saveEntry(candidate);

    const useCase = new DecideKnowledgeDispositionUseCase({ repo });
    const result = await useCase.execute({
      entryId: 'ke-policy-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Attempting to accept policy proposal',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'A policy proposal never becomes an accepted keeper; coordinate it as policy',
    });
  });

  it('applies entity guard: a policy proposal never becomes an accepted keeper', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const proposal = createEntryRecord({
      id: 'ke-proposal-1',
      claimText: 'General compiler guidance',
      disposition: 'policy-proposal',
      verification: 'supported',
    });
    await repo.saveEntry(proposal);

    const useCase = new DecideKnowledgeDispositionUseCase({ repo });
    const result = await useCase.execute({
      entryId: 'ke-proposal-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Attempting to accept policy proposal',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('A policy proposal never becomes an accepted keeper; coordinate it as policy');
    }
  });

  it('applies entity guard: cannot use decideDisposition to set disposition to superseded', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const candidate = createEntryRecord({
      id: 'ke-1',
      disposition: 'candidate',
      verification: 'supported',
    });
    await repo.saveEntry(candidate);

    const useCase = new DecideKnowledgeDispositionUseCase({ repo });
    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'superseded',
      checkerId: 'checker-1',
      reason: 'Supersede directly',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('Use supersedeBy to link the newer entry that replaces this one');
    }
  });
});
