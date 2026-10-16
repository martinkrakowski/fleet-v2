import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import { CaptureCompletedAttemptNotesUseCase } from './CaptureCompletedAttemptNotesUseCase.use-case.js';

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

describe('CaptureCompletedAttemptNotesUseCase', () => {
  it('throws when use case is unconfigured without dependencies', async () => {
    const useCase = new CaptureCompletedAttemptNotesUseCase();
    await expect(
      useCase.execute({
        projectId: 'proj-1',
        attemptId: 'att-1',
        workOrderId: 'wo-1',
        headCommitSha: 'a1b2c3d',
        notesMarkdown: '- Note claim',
      }),
    ).rejects.toThrow('Not implemented: CaptureCompletedAttemptNotesUseCase');
  });

  it('rejects when required parameters are missing or blank', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo });

    const missingProject = await useCase.execute({
      projectId: '   ',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      headCommitSha: 'a1b2c3d',
      notesMarkdown: '- Note claim',
    });
    expect(missingProject).toEqual({
      outcome: 'rejected',
      reason: 'CaptureCompletedAttemptNotes requires a non-empty projectId',
    });

    const missingAttempt = await useCase.execute({
      projectId: 'proj-1',
      attemptId: '',
      workOrderId: 'wo-1',
      headCommitSha: 'a1b2c3d',
      notesMarkdown: '- Note claim',
    });
    expect(missingAttempt).toEqual({
      outcome: 'rejected',
      reason: 'CaptureCompletedAttemptNotes requires a non-empty attemptId',
    });

    const missingWorkOrder = await useCase.execute({
      projectId: 'proj-1',
      attemptId: 'att-1',
      workOrderId: '  ',
      headCommitSha: 'a1b2c3d',
      notesMarkdown: '- Note claim',
    });
    expect(missingWorkOrder).toEqual({
      outcome: 'rejected',
      reason: 'CaptureCompletedAttemptNotes requires a non-empty workOrderId',
    });

    const missingSha = await useCase.execute({
      projectId: 'proj-1',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      headCommitSha: '',
      notesMarkdown: '- Note claim',
    });
    expect(missingSha).toEqual({
      outcome: 'rejected',
      reason: 'CaptureCompletedAttemptNotes requires a non-empty headCommitSha',
    });
  });

  it('returns captured outcome with missing status when notes markdown is null or empty', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo });

    const resultNull = await useCase.execute({
      projectId: 'proj-1',
      attemptId: 'att-1',
      workOrderId: 'wo-1',
      headCommitSha: 'a1b2c3d',
      notesMarkdown: null,
    });
    expect(resultNull).toEqual({
      outcome: 'captured',
      notesStatus: 'missing',
      candidateEntries: [],
    });

    const resultBlank = await useCase.execute({
      projectId: 'proj-1',
      attemptId: 'att-2',
      workOrderId: 'wo-1',
      headCommitSha: 'a1b2c3d',
      notesMarkdown: '   \n  \t  \n',
    });
    expect(resultBlank).toEqual({
      outcome: 'captured',
      notesStatus: 'missing',
      candidateEntries: [],
    });
  });

  it('derives stable entry ids from attemptId + 1-based note index without process counter', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo });

    const result = await useCase.execute({
      projectId: 'proj-1',
      attemptId: 'att-alpha',
      workOrderId: 'wo-1',
      headCommitSha: 'a1b2c3d',
      notesMarkdown: [
        '# Notes',
        '- First observation about compiler flags',
        '- Second observation regarding test timeouts',
      ].join('\n'),
      pathPrefixes: ['src/', 'tsconfig.json'],
    });

    expect(result.outcome).toBe('captured');
    if (result.outcome === 'captured') {
      expect(result.notesStatus).toBe('present');
      expect(result.candidateEntries).toHaveLength(2);

      const [entry1, entry2] = result.candidateEntries;
      expect(entry1?.id).toBe('ke-att-alpha-1');
      expect(entry1?.claimText).toBe('First observation about compiler flags');
      expect(entry1?.disposition).toBe('candidate');
      expect(entry1?.verification).toBe('unverified');
      expect(entry1?.sourceAttemptId).toBe('att-alpha');

      expect(entry2?.id).toBe('ke-att-alpha-2');
      expect(entry2?.claimText).toBe('Second observation regarding test timeouts');
      expect(entry2?.disposition).toBe('candidate');
      expect(entry2?.verification).toBe('unverified');
      expect(entry2?.sourceAttemptId).toBe('att-alpha');
    }
  });

  it('work order test: two use-case instances capture for different attempts without collision', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    // Instance 1
    const instanceA = new CaptureCompletedAttemptNotesUseCase({ repo });
    // Instance 2
    const instanceB = new CaptureCompletedAttemptNotesUseCase({ repo });

    const resultA = await instanceA.execute({
      projectId: 'proj-1',
      attemptId: 'att-run-100',
      workOrderId: 'wo-100',
      headCommitSha: 'commit100',
      notesMarkdown: '- First note for run 100\n- Second note for run 100',
    });

    const resultB = await instanceB.execute({
      projectId: 'proj-1',
      attemptId: 'att-run-200',
      workOrderId: 'wo-200',
      headCommitSha: 'commit200',
      notesMarkdown: '- First note for run 200\n- Second note for run 200',
    });

    expect(resultA.outcome).toBe('captured');
    expect(resultB.outcome).toBe('captured');

    if (resultA.outcome === 'captured' && resultB.outcome === 'captured') {
      const idsA = resultA.candidateEntries.map((e) => e.id);
      const idsB = resultB.candidateEntries.map((e) => e.id);

      expect(idsA).toEqual(['ke-att-run-100-1', 'ke-att-run-100-2']);
      expect(idsB).toEqual(['ke-att-run-200-1', 'ke-att-run-200-2']);

      // Ensure no intersection/collision between distinct attempts
      const collision = idsA.filter((id) => idsB.includes(id));
      expect(collision).toHaveLength(0);
    }

    const allStored = await repo.listEntriesByProject('proj-1');
    expect(allStored).toHaveLength(4);
  });

  it('work order test: recapture of the same attempt is refused cleanly (typed), not a mid-loop throw', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase1 = new CaptureCompletedAttemptNotesUseCase({ repo });
    const useCase2 = new CaptureCompletedAttemptNotesUseCase({ repo });

    // Initial capture
    const firstCapture = await useCase1.execute({
      projectId: 'proj-1',
      attemptId: 'att-repeat-1',
      workOrderId: 'wo-1',
      headCommitSha: 'commit-orig',
      notesMarkdown: '- Claim about lane completion',
    });
    expect(firstCapture.outcome).toBe('captured');

    // Attempting recapture of the exact same attempt
    const secondCapture = await useCase2.execute({
      projectId: 'proj-1',
      attemptId: 'att-repeat-1',
      workOrderId: 'wo-1',
      headCommitSha: 'commit-repeat',
      notesMarkdown: '- Claim about lane completion\n- Another claim',
    });

    // Clean typed rejection outcome, not a throw
    expect(secondCapture).toEqual({
      outcome: 'rejected',
      reason: 'Notes for attempt att-repeat-1 have already been captured',
    });

    // Entries in repo remain exactly from the initial capture
    const entries = await repo.listEntriesByProject('proj-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('ke-att-repeat-1-1');
  });
});
