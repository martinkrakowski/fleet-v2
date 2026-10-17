import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord, KnowledgeTriageFlag } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import type {
  AppendDecisionOutcome,
  DecisionJournalSnapshot,
  DecisionReceiptJournalPort,
  ReadDecisionJournalQuery,
  ReserveDecisionQuery,
  ReserveDecisionResult,
} from '../ports/out/DecisionReceiptJournalPort.out-port.js';
import { RecordContextSelectionUseCase } from './RecordContextSelectionUseCase.use-case.js';

class InMemoryKnowledgeEntryRepository implements KnowledgeEntryRepositoryPort {
  private readonly entries = new Map<string, KnowledgeEntryRecord>();
  private readonly selections = new Map<string, ContextSelectionProps[]>();

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

  async saveContextSelections(attemptId: string, selections: readonly ContextSelectionProps[]): Promise<void> {
    this.selections.set(attemptId, [...selections]);
  }

  async listContextSelections(attemptId: string): Promise<readonly ContextSelectionProps[]> {
    return this.selections.get(attemptId) ?? [];
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

/**
 * Journal stub honouring the port's outcome contract (K4): an outcome for a
 * reference with no settled receipt is skipped silently, and the use case's
 * swallowed-throw path is exercised through `failAppend`.
 */
class RecordingSelectionJournal implements DecisionReceiptJournalPort {
  readonly appended: AppendDecisionOutcome[] = [];
  appendCalls = 0;

  constructor(
    private readonly settledContextRefs: readonly string[] = [],
    private readonly failAppend = false,
  ) {}

  async reserve(_query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    return { ok: false, reason: 'not-configured' };
  }

  async settle(): Promise<void> {}

  async monthSpendUsd(): Promise<number> {
    return 0;
  }

  async appendOutcome(outcome: AppendDecisionOutcome): Promise<void> {
    this.appendCalls += 1;
    // No settled receipt for this reference: skipped silently, per the port.
    if (!this.settledContextRefs.includes(outcome.contextRef)) {
      return;
    }
    if (this.failAppend) {
      throw new Error('outcome journal offline');
    }
    this.appended.push(outcome);
  }

  async readJournal(query: ReadDecisionJournalQuery): Promise<DecisionJournalSnapshot> {
    return {
      receipts: [],
      outcomes: this.appended.filter((outcome) => outcome.consumer === query.consumer),
    };
  }
}

describe('RecordContextSelectionUseCase', () => {
  it('throws when use case is unconfigured without dependencies', async () => {
    const useCase = new RecordContextSelectionUseCase();
    await expect(
      useCase.execute({
        attemptId: 'att-1',
        selections: [
          {
            proposalId: 'prop-1',
            knowledgeEntryId: 'ke-1',
            version: '1.0.0',
            accepted: true,
            decisionBecause: 'Directly applies to migration step',
          },
        ],
      }),
    ).rejects.toThrow('Not implemented: RecordContextSelectionUseCase');
  });

  it('rejects when attemptId is missing or blank', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new RecordContextSelectionUseCase({ repo });

    const result = await useCase.execute({
      attemptId: '   ',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Directly applies',
        },
      ],
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'RecordContextSelection requires a non-empty attemptId',
    });
  });

  it('rejects when selections array is empty', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new RecordContextSelectionUseCase({ repo });

    const result = await useCase.execute({
      attemptId: 'att-1',
      selections: [],
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'RecordContextSelection requires at least one selection',
    });
  });

  it('work order test: carries real reason and rejects when decisionBecause is absent or blank (no fabricated reason)', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const acceptedKeeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-1',
      dispositionReason: 'verified',
    });
    await repo.saveEntry(acceptedKeeper);

    const useCase = new RecordContextSelectionUseCase({ repo });

    // Blank decisionBecause
    const blankResult = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: '   ',
        },
      ],
    });

    expect(blankResult).toEqual({
      outcome: 'rejected',
      reason: 'RecordContextSelection requires a non-empty decisionBecause for each selection',
    });

    // Empty decisionBecause
    const emptyResult = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: '',
        },
      ],
    });

    expect(emptyResult).toEqual({
      outcome: 'rejected',
      reason: 'RecordContextSelection requires a non-empty decisionBecause for each selection',
    });
  });

  it('work order test: refuses selecting an entry that is not an accepted keeper', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();

    // 1. Entry does not exist
    const useCase = new RecordContextSelectionUseCase({ repo });
    const missingResult = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-missing',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Reason here',
        },
      ],
    });
    expect(missingResult).toEqual({
      outcome: 'rejected',
      reason: 'Knowledge entry not found: ke-missing',
    });

    // 2. Candidate unverified entry
    const candidateEntry = createEntryRecord({
      id: 'ke-cand-1',
      disposition: 'candidate',
      verification: 'unverified',
    });
    await repo.saveEntry(candidateEntry);

    const candidateResult = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-cand-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Reason here',
        },
      ],
    });
    expect(candidateResult.outcome).toBe('rejected');
    if (candidateResult.outcome === 'rejected') {
      expect(candidateResult.reason).toContain('Only accepted keepers may be selected');
      expect(candidateResult.reason).toContain('ke-cand-1');
    }

    // 3. Contradicted entry
    const contradictedEntry = createEntryRecord({
      id: 'ke-contra-1',
      disposition: 'candidate',
      verification: 'contradicted',
    });
    await repo.saveEntry(contradictedEntry);

    const contradictedResult = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-contra-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Reason here',
        },
      ],
    });
    expect(contradictedResult.outcome).toBe('rejected');
    if (contradictedResult.outcome === 'rejected') {
      expect(contradictedResult.reason).toContain('Only accepted keepers may be selected');
    }

    // 4. Superseded entry
    const supersededEntry = createEntryRecord({
      id: 'ke-old-1',
      disposition: 'superseded',
      verification: 'supported',
      checkerId: 'checker-1',
      supersededById: 'ke-newer-1',
    });
    await repo.saveEntry(supersededEntry);

    const supersededResult = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-old-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Reason here',
        },
      ],
    });
    expect(supersededResult.outcome).toBe('rejected');
    if (supersededResult.outcome === 'rejected') {
      expect(supersededResult.reason).toContain('Only accepted keepers may be selected');
    }
  });

  it('records selection for accepted keeper and retains orchestrator real reason', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const keeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-ci',
      dispositionReason: 'verified by smoke tests',
      supersededById: null,
    });
    await repo.saveEntry(keeper);

    const useCase = new RecordContextSelectionUseCase({ repo });
    const realReason = 'Orchestrator selected this because task requires tsconfig rootDir pattern.';
    const result = await useCase.execute({
      attemptId: 'att-lane-42',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: realReason,
        },
      ],
    });

    expect(result).toEqual({
      outcome: 'recorded',
      recordedCount: 1,
    });

    const recorded = await repo.listContextSelections('att-lane-42');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      attemptId: 'att-lane-42',
      knowledgeEntryId: 'ke-accepted-1',
      version: '1.0.0',
      accepted: true,
      decisionBecause: realReason,
    });
  });

  it('allows a rejected selection (accepted: false) to reference any existing entry', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const candidateEntry = createEntryRecord({
      id: 'ke-cand-unverified',
      disposition: 'candidate',
      verification: 'unverified',
    });
    const contradictedEntry = createEntryRecord({
      id: 'ke-contra',
      disposition: 'candidate',
      verification: 'contradicted',
    });
    const supersededEntry = createEntryRecord({
      id: 'ke-old',
      disposition: 'superseded',
      verification: 'supported',
      supersededById: 'ke-newer',
    });
    await repo.saveEntry(candidateEntry);
    await repo.saveEntry(contradictedEntry);
    await repo.saveEntry(supersededEntry);

    const useCase = new RecordContextSelectionUseCase({ repo });
    const result = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-cand-unverified',
          version: '1.0.0',
          accepted: false,
          decisionBecause: 'Candidate not verified for this attempt',
        },
        {
          proposalId: 'prop-2',
          knowledgeEntryId: 'ke-contra',
          version: '1.0.0',
          accepted: false,
          decisionBecause: 'Contradicted claim rejected by orchestrator',
        },
        {
          proposalId: 'prop-3',
          knowledgeEntryId: 'ke-old',
          version: '1.0.0',
          accepted: false,
          decisionBecause: 'Superseded claim excluded by orchestrator',
        },
      ],
    });

    expect(result).toEqual({ outcome: 'recorded', recordedCount: 3 });
    const recorded = await repo.listContextSelections('att-1');
    expect(recorded).toHaveLength(3);
    expect(recorded[0].accepted).toBe(false);
    expect(recorded[0].knowledgeEntryId).toBe('ke-cand-unverified');
    expect(recorded[1].accepted).toBe(false);
    expect(recorded[1].knowledgeEntryId).toBe('ke-contra');
    expect(recorded[2].accepted).toBe(false);
    expect(recorded[2].knowledgeEntryId).toBe('ke-old');
  });

  it('writes the ranking-selection outcome when a rankingContextRef with a settled receipt is given', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const keeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-ci',
      dispositionReason: 'verified by smoke tests',
      supersededById: null,
    });
    const secondKeeper = createEntryRecord({
      id: 'ke-accepted-2',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-ci',
      dispositionReason: 'verified by smoke tests',
      supersededById: null,
    });
    await repo.saveEntry(keeper);
    await repo.saveEntry(secondKeeper);

    const contextRef = `ranking:lane-k4:${'a'.repeat(64)}`;
    const journal = new RecordingSelectionJournal([contextRef]);
    const useCase = new RecordContextSelectionUseCase({ repo, journal });
    const result = await useCase.execute({
      attemptId: 'att-lane-42',
      rankingContextRef: contextRef,
      nowIso: '2026-10-17T10:00:00.000Z',
      selections: [
        {
          proposalId: 'bkp-ke-accepted-2-2',
          knowledgeEntryId: 'ke-accepted-2',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Highest lexical match after advice',
        },
        {
          proposalId: 'bkp-ke-accepted-1-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Second match',
        },
      ],
    });

    expect(result).toEqual({ outcome: 'recorded', recordedCount: 2 });
    expect(journal.appended).toEqual([
      {
        consumer: 'knowledge-ranking',
        contextRef,
        kind: 'ranking-selection',
        value: ['ke-accepted-2', 'ke-accepted-1'],
        at: '2026-10-17T10:00:00.000Z',
      },
    ]);
  });

  it('skips the outcome when no rankingContextRef is given', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const keeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-ci',
      supersededById: null,
    });
    await repo.saveEntry(keeper);

    const journal = new RecordingSelectionJournal(['ranking:anywhere']);
    const useCase = new RecordContextSelectionUseCase({ repo, journal });
    const result = await useCase.execute({
      attemptId: 'att-1',
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Directly applies',
        },
      ],
    });

    expect(result).toEqual({ outcome: 'recorded', recordedCount: 1 });
    expect(journal.appendCalls).toBe(0);
    expect(journal.appended).toHaveLength(0);
  });

  it('skips the outcome silently when the journal has no settled receipt for the reference', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const keeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-ci',
      supersededById: null,
    });
    await repo.saveEntry(keeper);

    const contextRef = `ranking:lane-k4:${'b'.repeat(64)}`;
    const journal = new RecordingSelectionJournal([]);
    const useCase = new RecordContextSelectionUseCase({ repo, journal });
    const result = await useCase.execute({
      attemptId: 'att-1',
      rankingContextRef: contextRef,
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Directly applies',
        },
      ],
    });

    expect(result).toEqual({ outcome: 'recorded', recordedCount: 1 });
    expect(journal.appendCalls).toBe(1);
    expect(journal.appended).toHaveLength(0);
  });

  it('never fails the recording when appendOutcome throws', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const keeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-ci',
      supersededById: null,
    });
    await repo.saveEntry(keeper);

    const contextRef = `ranking:lane-k4:${'c'.repeat(64)}`;
    const journal = new RecordingSelectionJournal([contextRef], true);
    const useCase = new RecordContextSelectionUseCase({ repo, journal });
    const result = await useCase.execute({
      attemptId: 'att-1',
      rankingContextRef: contextRef,
      selections: [
        {
          proposalId: 'prop-1',
          knowledgeEntryId: 'ke-accepted-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'Directly applies',
        },
      ],
    });

    expect(result).toEqual({ outcome: 'recorded', recordedCount: 1 });
    const recorded = await repo.listContextSelections('att-1');
    expect(recorded).toHaveLength(1);
  });
});
