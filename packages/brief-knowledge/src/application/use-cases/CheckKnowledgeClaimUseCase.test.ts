import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord, KnowledgeTriageFlag } from '../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../domain/value-objects/ContextSelection.vo.js';
import type {
  ClaimVerificationPort,
  VerifyClaimRequest,
  VerifyClaimResult,
} from '../ports/out/ClaimVerificationPort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import { CheckKnowledgeClaimUseCase } from './CheckKnowledgeClaimUseCase.use-case.js';

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

class FakeClaimVerifier implements ClaimVerificationPort {
  lastRequest: VerifyClaimRequest | null = null;
  resultToReturn: VerifyClaimResult = {
    verification: 'supported',
    evidenceRef: 'evidence://test-pass',
  };

  async verifyClaim(request: VerifyClaimRequest): Promise<VerifyClaimResult> {
    this.lastRequest = request;
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
    verification: 'unverified',
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

describe('CheckKnowledgeClaimUseCase', () => {
  it('throws when use case is unconfigured without dependencies', async () => {
    const useCase = new CheckKnowledgeClaimUseCase();
    await expect(
      useCase.execute({
        entryId: 'ke-1',
        checkId: 'chk-1',
        checkerId: 'checker-1',
        procedureName: 'tsc-check',
      }),
    ).rejects.toThrow('Not implemented: CheckKnowledgeClaimUseCase');
  });

  it('rejects when required parameters are missing or blank', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const verifier = new FakeClaimVerifier();
    const useCase = new CheckKnowledgeClaimUseCase({ repo, verifier });

    const missingEntry = await useCase.execute({
      entryId: '   ',
      checkId: 'chk-1',
      checkerId: 'checker-1',
      procedureName: 'tsc-check',
    });
    expect(missingEntry).toEqual({
      outcome: 'rejected',
      reason: 'CheckKnowledgeClaim requires a non-empty entryId',
    });

    const missingCheckId = await useCase.execute({
      entryId: 'ke-1',
      checkId: '',
      checkerId: 'checker-1',
      procedureName: 'tsc-check',
    });
    expect(missingCheckId).toEqual({
      outcome: 'rejected',
      reason: 'CheckKnowledgeClaim requires a non-empty checkId',
    });

    const missingChecker = await useCase.execute({
      entryId: 'ke-1',
      checkId: 'chk-1',
      checkerId: '   ',
      procedureName: 'tsc-check',
    });
    expect(missingChecker).toEqual({
      outcome: 'rejected',
      reason: 'CheckKnowledgeClaim requires a non-empty checkerId',
    });

    const missingProcedure = await useCase.execute({
      entryId: 'ke-1',
      checkId: 'chk-1',
      checkerId: 'checker-1',
      procedureName: '',
    });
    expect(missingProcedure).toEqual({
      outcome: 'rejected',
      reason: 'CheckKnowledgeClaim requires a non-empty procedureName',
    });
  });

  it('returns rejected outcome when entry is not found', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const verifier = new FakeClaimVerifier();
    const useCase = new CheckKnowledgeClaimUseCase({ repo, verifier });

    const result = await useCase.execute({
      entryId: 'ke-missing',
      checkId: 'chk-1',
      checkerId: 'checker-1',
      procedureName: 'tsc-check',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'Knowledge entry not found: ke-missing',
    });
  });

  it('passes claim text to verifier as data and routes check through KnowledgeEntry aggregate', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const verifier = new FakeClaimVerifier();
    verifier.resultToReturn = {
      verification: 'supported',
      evidenceRef: 'evidence://verification-log-42',
    };

    const candidate = createEntryRecord({
      id: 'ke-1',
      claimText: 'Execute test suite before deployment.',
      disposition: 'candidate',
      verification: 'unverified',
      revision: 1,
    });
    await repo.saveEntry(candidate);

    const useCase = new CheckKnowledgeClaimUseCase({ repo, verifier });
    const result = await useCase.execute({
      entryId: 'ke-1',
      checkId: 'chk-100',
      checkerId: 'checker-ci',
      procedureName: 'automated-test',
      targetPath: 'src/index.ts',
      nowIso: '2026-10-15T14:00:00.000Z',
    });

    // Ensure claim text is passed as data to verifier
    expect(verifier.lastRequest).toEqual({
      entryId: 'ke-1',
      claimText: 'Execute test suite before deployment.',
      procedureName: 'automated-test',
      targetPath: 'src/index.ts',
    });

    expect(result.outcome).toBe('checked');
    if (result.outcome === 'checked') {
      expect(result.entry.verification).toBe('supported');
      expect(result.entry.revision).toBe(2);
      expect(result.entry.checks).toHaveLength(1);
      expect(result.entry.checks[0]).toEqual({
        id: 'chk-100',
        entryId: 'ke-1',
        checkerId: 'checker-ci',
        procedureName: 'automated-test',
        verification: 'supported',
        evidenceRef: 'evidence://verification-log-42',
        checkedAtIso: '2026-10-15T14:00:00.000Z',
      });
    }

    const stored = await repo.findEntryById('ke-1');
    expect(stored?.verification).toBe('supported');
    expect(stored?.checks).toHaveLength(1);
  });

  it('applies entity guard: a contradicted check on an accepted entry is rejected', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const verifier = new FakeClaimVerifier();
    verifier.resultToReturn = {
      verification: 'contradicted',
      evidenceRef: 'evidence://contradiction-proof',
    };

    const acceptedKeeper = createEntryRecord({
      id: 'ke-accepted-1',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-lead',
      dispositionReason: 'previously accepted',
      revision: 2,
    });
    await repo.saveEntry(acceptedKeeper);

    const useCase = new CheckKnowledgeClaimUseCase({ repo, verifier });
    const result = await useCase.execute({
      entryId: 'ke-accepted-1',
      checkId: 'chk-fail-1',
      checkerId: 'checker-auditor',
      procedureName: 'verify-contradiction',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain(
        'An accepted keeper requires supported verification; change its disposition first',
      );
    }

    // Ensure repository was not corrupted with an invalid state
    const stored = await repo.findEntryById('ke-accepted-1');
    expect(stored?.verification).toBe('supported');
    expect(stored?.checks).toHaveLength(0);
  });

  it('applies entity guard: a stale check on an accepted entry is rejected', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const verifier = new FakeClaimVerifier();
    verifier.resultToReturn = {
      verification: 'stale',
      evidenceRef: 'evidence://stale-warning',
    };

    const acceptedKeeper = createEntryRecord({
      id: 'ke-accepted-2',
      disposition: 'accepted',
      verification: 'supported',
      checkerId: 'checker-lead',
      dispositionReason: 'previously accepted',
    });
    await repo.saveEntry(acceptedKeeper);

    const useCase = new CheckKnowledgeClaimUseCase({ repo, verifier });
    const result = await useCase.execute({
      entryId: 'ke-accepted-2',
      checkId: 'chk-stale-1',
      checkerId: 'checker-auditor',
      procedureName: 'staleness-detector',
    });

    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toContain(
        'An accepted keeper requires supported verification; change its disposition first',
      );
    }
  });
});
