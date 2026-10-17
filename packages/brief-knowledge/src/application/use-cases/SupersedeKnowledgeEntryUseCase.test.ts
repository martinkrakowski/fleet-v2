import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord, KnowledgeTriageFlag } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import { SupersedeKnowledgeEntryUseCase } from './SupersedeKnowledgeEntryUseCase.use-case.js';

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

describe('SupersedeKnowledgeEntryUseCase', () => {
  it('throws when use case is unconfigured without dependencies', async () => {
    const useCase = new SupersedeKnowledgeEntryUseCase();
    await expect(
      useCase.execute({
        olderEntryId: 'ke-1',
        newerEntryId: 'ke-2',
        checkerId: 'checker-1',
        reason: 'Superseded',
      }),
    ).rejects.toThrow('Not implemented: SupersedeKnowledgeEntryUseCase');
  });

  it('rejects when required parameters are missing or blank', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });

    const missingOlder = await useCase.execute({
      olderEntryId: '   ',
      newerEntryId: 'ke-2',
      checkerId: 'checker-1',
      reason: 'Superseded',
    });
    expect(missingOlder).toEqual({
      outcome: 'rejected',
      reason: 'SupersedeKnowledgeEntry requires a non-empty olderEntryId',
    });

    const missingNewer = await useCase.execute({
      olderEntryId: 'ke-1',
      newerEntryId: '',
      checkerId: 'checker-1',
      reason: 'Superseded',
    });
    expect(missingNewer).toEqual({
      outcome: 'rejected',
      reason: 'SupersedeKnowledgeEntry requires a non-empty newerEntryId',
    });

    const missingChecker = await useCase.execute({
      olderEntryId: 'ke-1',
      newerEntryId: 'ke-2',
      checkerId: '',
      reason: 'Superseded',
    });
    expect(missingChecker).toEqual({
      outcome: 'rejected',
      reason: 'SupersedeKnowledgeEntry requires a non-empty checkerId',
    });

    const missingReason = await useCase.execute({
      olderEntryId: 'ke-1',
      newerEntryId: 'ke-2',
      checkerId: 'checker-1',
      reason: '   ',
    });
    expect(missingReason).toEqual({
      outcome: 'rejected',
      reason: 'SupersedeKnowledgeEntry requires a non-empty reason',
    });
  });

  it('rejects when olderEntryId and newerEntryId are identical', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });

    const result = await useCase.execute({
      olderEntryId: 'ke-same',
      newerEntryId: 'ke-same',
      checkerId: 'checker-1',
      reason: 'Self supersession',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'SupersedeKnowledgeEntry requires distinct olderEntryId and newerEntryId',
    });
  });

  it('rejects when older or newer entry is not found', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const newer = createEntryRecord({
      id: 'ke-newer',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-1',
      dispositionReason: 'verified',
    });
    await repo.saveEntry(newer);

    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });

    const missingOlder = await useCase.execute({
      olderEntryId: 'ke-nonexistent',
      newerEntryId: 'ke-newer',
      checkerId: 'checker-1',
      reason: 'Supersede',
    });
    expect(missingOlder).toEqual({
      outcome: 'rejected',
      reason: 'Knowledge entry not found: ke-nonexistent',
    });

    const older = createEntryRecord({ id: 'ke-older', disposition: 'candidate' });
    await repo.saveEntry(older);

    const missingNewer = await useCase.execute({
      olderEntryId: 'ke-older',
      newerEntryId: 'ke-ghost',
      checkerId: 'checker-1',
      reason: 'Supersede',
    });
    expect(missingNewer).toEqual({
      outcome: 'rejected',
      reason: 'Knowledge entry not found: ke-ghost',
    });
  });

  it('rejects when newer entry is not accepted', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const older = createEntryRecord({ id: 'ke-older', disposition: 'candidate' });
    const newer = createEntryRecord({ id: 'ke-newer', disposition: 'candidate' });
    await repo.saveEntry(older);
    await repo.saveEntry(newer);

    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });
    const result = await useCase.execute({
      olderEntryId: 'ke-older',
      newerEntryId: 'ke-newer',
      checkerId: 'checker-1',
      reason: 'Supersede by unaccepted candidate',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Only accepted entries may supersede an older entry',
    });
  });

  it('applies entity guard: an already superseded entry cannot be superseded again', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const older = createEntryRecord({
      id: 'ke-older-1',
      disposition: 'superseded',
      verification: 'supported',
      checkerId: 'checker-1',
      supersededById: 'ke-first-replacement',
      dispositionReason: 'previously superseded',
    });
    const newer = createEntryRecord({
      id: 'ke-newer-2',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-2',
      dispositionReason: 'accepted keeper',
    });
    await repo.saveEntry(older);
    await repo.saveEntry(newer);

    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });
    const result = await useCase.execute({
      olderEntryId: 'ke-older-1',
      newerEntryId: 'ke-newer-2',
      checkerId: 'checker-lead',
      reason: 'Attempting second supersession',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain('Entry is already superseded by ke-first-replacement');
    }
  });

  it('routes supersession through KnowledgeEntry aggregate and persists updated record', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const older = createEntryRecord({
      id: 'ke-older',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-prev',
      dispositionReason: 'initially accepted',
      revision: 2,
    });
    const newer = createEntryRecord({
      id: 'ke-newer',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-new',
      dispositionReason: 'newer accepted replacement',
      revision: 1,
    });
    await repo.saveEntry(older);
    await repo.saveEntry(newer);

    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });
    const result = await useCase.execute({
      olderEntryId: 'ke-older',
      newerEntryId: 'ke-newer',
      checkerId: 'checker-super',
      reason: 'Updated with corrected configuration',
      nowIso: '2026-10-15T15:00:00.000Z',
    });

    expect(result.outcome).toBe('superseded');
    if (result.outcome === 'superseded') {
      expect(result.olderEntry.disposition).toBe('superseded');
      expect(result.olderEntry.supersededById).toBe('ke-newer');
      expect(result.olderEntry.checkerId).toBe('checker-super');
      expect(result.olderEntry.dispositionReason).toBe('Updated with corrected configuration');
      expect(result.olderEntry.revision).toBe(3);
      expect(result.olderEntry.updatedAtIso).toBe('2026-10-15T15:00:00.000Z');
      expect(result.newerEntry.id).toBe('ke-newer');
    }

    const saved = await repo.findEntryById('ke-older');
    expect(saved?.disposition).toBe('superseded');
    expect(saved?.supersededById).toBe('ke-newer');
  });
});
