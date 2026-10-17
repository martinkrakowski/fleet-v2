import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord, KnowledgeTriageFlag } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import type {
  AppendDecisionOutcome,
  DecisionCallReceipt,
  DecisionJournalSnapshot,
  DecisionReceiptJournalPort,
  ReadDecisionJournalQuery,
  ReserveDecisionQuery,
  ReserveDecisionResult,
} from '../ports/out/DecisionReceiptJournalPort.out-port.js';
import { CLAIM_TRIAGE_CONSUMER } from '../ports/out/DecisionReceiptJournalPort.out-port.js';
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

  async listEntriesBySourceAttempt(attemptId: string): Promise<readonly KnowledgeEntryRecord[]> {
    return [...this.entries.values()].filter((entry) => entry.sourceAttemptId === attemptId);
  }

  async setTriageFlag(_entryId: string, _flag: KnowledgeTriageFlag): Promise<void> {}

  async saveContextSelections(_attemptId: string, _selections: readonly ContextSelectionProps[]): Promise<void> {}

  async listContextSelections(_attemptId: string): Promise<readonly ContextSelectionProps[]> {
    return [];
  }
}

/** Records every appended outcome; optionally simulates a journal failure. */
class StubDecisionJournal implements DecisionReceiptJournalPort {
  readonly outcomes: AppendDecisionOutcome[] = [];

  constructor(private readonly failAppend = false) {}

  async reserve(_query: ReserveDecisionQuery): Promise<ReserveDecisionResult> {
    return { ok: false, reason: 'not-configured' };
  }

  async settle(_reservationId: string, _receipt: DecisionCallReceipt): Promise<void> {}

  async monthSpendUsd(_monthUtc: Date): Promise<number> {
    return 0;
  }

  async appendOutcome(outcome: AppendDecisionOutcome): Promise<void> {
    if (this.failAppend) {
      throw new Error('outcome journal offline');
    }
    this.outcomes.push(outcome);
  }

  async readJournal(query: ReadDecisionJournalQuery): Promise<DecisionJournalSnapshot> {
    return {
      receipts: [],
      outcomes: this.outcomes.filter((outcome) => outcome.consumer === query.consumer),
      skippedLines: 0,
    };
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

describe('DecideKnowledgeDispositionUseCase triage flag and override reason', () => {
  it('accepts an unflagged candidate without an overrideReason', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-1', verification: 'supported' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
    });

    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') {
      expect(result.entry.triageFlag).toBeUndefined();
      expect(result.entry.overrideReason).toBeUndefined();
    }
  });

  it('requires a non-empty overrideReason only when a flagged candidate is accepted', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      createEntryRecord({ id: 'ke-flagged', verification: 'supported', triageFlag: 'instruction-like' }),
    );
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const withoutOverride = await useCase.execute({
      entryId: 'ke-flagged',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
    });
    expect(withoutOverride).toEqual({
      outcome: 'rejected',
      reason: 'A triage-flagged candidate cannot be accepted without a non-empty overrideReason',
    });

    const blankOverride = await useCase.execute({
      entryId: 'ke-flagged',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
      overrideReason: '   ',
    });
    expect(blankOverride).toEqual({
      outcome: 'rejected',
      reason: 'A triage-flagged candidate cannot be accepted without a non-empty overrideReason',
    });

    // A flagged entry dispositioned to anything but accepted needs none.
    const deferred = await useCase.execute({
      entryId: 'ke-flagged',
      disposition: 'deferred',
      checkerId: 'checker-1',
      reason: 'Awaiting a host-side check',
    });
    expect(deferred.outcome).toBe('decided');
  });

  it('records the overrideReason on the accepted, flagged entry', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      createEntryRecord({ id: 'ke-flagged', verification: 'supported', triageFlag: 'policy-like' }),
    );
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.execute({
      entryId: 'ke-flagged',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
      overrideReason: 'Re-checked with the owner; the flagged wording is a lesson, not a rule',
      nowIso: '2026-10-17T10:00:00.000Z',
    });

    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') {
      expect(result.entry.disposition).toBe('accepted');
      expect(result.entry.triageFlag).toBe('policy-like');
      expect(result.entry.overrideReason).toBe(
        'Re-checked with the owner; the flagged wording is a lesson, not a rule',
      );
    }
    const saved = await repo.findEntryById('ke-flagged');
    expect(saved?.overrideReason).toBe(
      'Re-checked with the owner; the flagged wording is a lesson, not a rule',
    );
  });

  it('never lets the overrideReason substitute for the policy proposal guard', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      createEntryRecord({
        id: 'ke-policy-flagged',
        claimText: 'Change the permissions for the deploy seat',
        verification: 'supported',
        triageFlag: 'policy-like',
      }),
    );
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    // The regex refusal runs before the flag check and stands on its own.
    const withoutOverride = await useCase.execute({
      entryId: 'ke-policy-flagged',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
    });
    expect(withoutOverride).toEqual({
      outcome: 'rejected',
      reason: 'A policy proposal never becomes an accepted keeper; coordinate it as policy',
    });

    const withOverride = await useCase.execute({
      entryId: 'ke-policy-flagged',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
      overrideReason: 'The owner approved this wording',
    });
    expect(withOverride).toEqual({
      outcome: 'rejected',
      reason: 'A policy proposal never becomes an accepted keeper; coordinate it as policy',
    });
  });

  it('never lets the overrideReason substitute for the non-empty reason', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      createEntryRecord({ id: 'ke-1', verification: 'supported', triageFlag: 'instruction-like' }),
    );
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: '   ',
      overrideReason: 'The owner approved this wording',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'DecideKnowledgeDisposition requires a non-empty reason',
    });
  });

  it('refuses an overrideReason longer than 1024 characters', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-1' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'deferred',
      checkerId: 'checker-1',
      reason: 'Awaiting a host-side check',
      overrideReason: 'x'.repeat(1025),
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'DecideKnowledgeDisposition requires an overrideReason of at most 1024 characters',
    });
  });

  it('refuses a credential-shaped overrideReason instead of redacting it', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-1' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    // Assembled from fragments so this test file itself matches no pattern.
    const fakeApiKey = ['sk', '-', 'x9y8z7'.repeat(4)].join('');
    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'deferred',
      checkerId: 'checker-1',
      reason: 'Awaiting a host-side check',
      overrideReason: `pasted ${fakeApiKey} into the reason`,
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'DecideKnowledgeDisposition refuses an overrideReason with a credential shape',
    });
    const saved = await repo.findEntryById('ke-1');
    expect(saved?.overrideReason).toBeUndefined();
  });

  it('does not record an overrideReason outside a flagged acceptance', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-plain', verification: 'supported' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.execute({
      entryId: 'ke-plain',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
      overrideReason: 'Not needed for an unflagged candidate',
    });

    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') {
      expect(result.entry.overrideReason).toBeUndefined();
    }
    const saved = await repo.findEntryById('ke-plain');
    expect(saved?.overrideReason).toBeUndefined();
  });
});

describe('DecideKnowledgeDispositionUseCase triage outcome line', () => {
  it('appends a triage outcome after a decided disposition', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const journal = new StubDecisionJournal();
    await repo.saveEntry(createEntryRecord({ id: 'ke-1', verification: 'supported' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo, journal });

    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
      nowIso: '2026-10-17T10:00:00.000Z',
    });

    expect(result.outcome).toBe('decided');
    expect(journal.outcomes).toHaveLength(1);
    expect(journal.outcomes[0]).toEqual({
      consumer: CLAIM_TRIAGE_CONSUMER,
      contextRef: 'triage:att-1',
      kind: 'triage-disposition',
      value: ['ke-1', 'accepted'],
      at: '2026-10-17T10:00:00.000Z',
    });
  });

  it('appends no outcome when the disposition is refused', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const journal = new StubDecisionJournal();
    // An unverified claim cannot become accepted, so the disposition is
    // refused and no outcome line is written for it.
    await repo.saveEntry(createEntryRecord({ id: 'ke-1', verification: 'unverified' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo, journal });

    await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
    });

    expect(journal.outcomes).toHaveLength(0);
  });

  it('keeps the disposition decided when the outcome write fails', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const journal = new StubDecisionJournal(true);
    await repo.saveEntry(createEntryRecord({ id: 'ke-1', verification: 'supported' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo, journal });

    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
    });

    expect(result.outcome).toBe('decided');
    const saved = await repo.findEntryById('ke-1');
    expect(saved?.disposition).toBe('accepted');
  });

  it('decides without a journal at all', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(createEntryRecord({ id: 'ke-1', verification: 'supported' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.execute({
      entryId: 'ke-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'Verified by integration check',
    });

    expect(result.outcome).toBe('decided');
  });
});
