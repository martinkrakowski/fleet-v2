// Layer-local unit tests for the brief-knowledge application use cases.
import { describe, expect, it } from 'vitest';
import type { KnowledgeEntryRecord } from '../../../domain/knowledge-records.js';
import type { ContextSelectionProps } from '../../../domain/value-objects/ContextSelection.vo.js';
import type { KnowledgeReuseOutcomeValue } from '../../../domain/value-objects/KnowledgeReuseOutcome.vo.js';
import type {
  CaptureCompletedAttemptNotesRequest,
  CaptureCompletedAttemptNotesResult,
} from '../../ports/in/CaptureCompletedAttemptNotesPort.in-port.js';
import type { CheckKnowledgeClaimRequest } from '../../ports/in/CheckKnowledgeClaimPort.in-port.js';
import type { DecideKnowledgeDispositionRequest } from '../../ports/in/DecideKnowledgeDispositionPort.in-port.js';
import type { PublishAcceptedKeeperRequest } from '../../ports/in/PublishAcceptedKeeperPort.in-port.js';
import type { ProposeBriefContextRequest } from '../../ports/in/ProposeBriefContextPort.in-port.js';
import type { RecordBriefContextSelectionRequest } from '../../ports/in/RecordContextSelectionPort.in-port.js';
import type { RecordKnowledgeReuseRequest } from '../../ports/in/RecordKnowledgeReusePort.in-port.js';
import type { SupersedeKnowledgeEntryRequest } from '../../ports/in/SupersedeKnowledgeEntryPort.in-port.js';
import type {
  ClaimVerificationPort,
  VerifyClaimRequest,
  VerifyClaimResult,
} from '../../ports/out/ClaimVerificationPort.out-port.js';
import type { KnowledgeEntryRepositoryPort } from '../../ports/out/KnowledgeEntryRepositoryPort.out-port.js';
import type {
  KeeperPublicationPort,
  PublishKeeperToShelfRequest,
  PublishKeeperToShelfResult,
} from '../../ports/out/KeeperPublicationPort.out-port.js';
import { KnowledgeRetrievalAdapter } from '../../../infrastructure/adapters/KnowledgeRetrievalAdapter.adapter.js';
import { CaptureCompletedAttemptNotesUseCase } from '../CaptureCompletedAttemptNotesUseCase.use-case.js';
import { CheckKnowledgeClaimUseCase } from '../CheckKnowledgeClaimUseCase.use-case.js';
import { DecideKnowledgeDispositionUseCase } from '../DecideKnowledgeDispositionUseCase.use-case.js';
import { ProposeBriefContextUseCase } from '../ProposeBriefContextUseCase.use-case.js';
import { PublishAcceptedKeeperUseCase } from '../PublishAcceptedKeeperUseCase.use-case.js';
import { RecordContextSelectionUseCase } from '../RecordContextSelectionUseCase.use-case.js';
import { RecordKnowledgeReuseUseCase } from '../RecordKnowledgeReuseUseCase.use-case.js';
import { SupersedeKnowledgeEntryUseCase } from '../SupersedeKnowledgeEntryUseCase.use-case.js';

class InMemoryKnowledgeEntryRepository implements KnowledgeEntryRepositoryPort {
  readonly entries = new Map<string, KnowledgeEntryRecord>();
  readonly selectionsByAttempt = new Map<string, ContextSelectionProps[]>();
  saveEntryCalls = 0;

  async saveEntry(record: KnowledgeEntryRecord): Promise<void> {
    this.saveEntryCalls += 1;
    this.entries.set(record.id, record);
  }

  async findEntryById(entryId: string): Promise<KnowledgeEntryRecord | null> {
    return this.entries.get(entryId) ?? null;
  }

  async listEntriesByProject(projectId?: string): Promise<readonly KnowledgeEntryRecord[]> {
    const all = [...this.entries.values()];
    return projectId === undefined ? all : all.filter((entry) => entry.projectId === projectId);
  }

  async saveContextSelections(attemptId: string, selections: readonly ContextSelectionProps[]): Promise<void> {
    const existing = this.selectionsByAttempt.get(attemptId) ?? [];
    this.selectionsByAttempt.set(attemptId, [...existing, ...selections]);
  }

  async listContextSelections(attemptId: string): Promise<readonly ContextSelectionProps[]> {
    return this.selectionsByAttempt.get(attemptId) ?? [];
  }
}

class StubClaimVerifier implements ClaimVerificationPort {
  readonly requests: VerifyClaimRequest[] = [];

  constructor(private readonly result: VerifyClaimResult = { verification: 'supported', evidenceRef: 'stub-evidence' }) {}

  async verifyClaim(request: VerifyClaimRequest): Promise<VerifyClaimResult> {
    this.requests.push(request);
    return this.result;
  }
}

class StubKeeperPublisher implements KeeperPublicationPort {
  readonly requests: PublishKeeperToShelfRequest[] = [];

  constructor(
    private readonly result: PublishKeeperToShelfResult = { outcome: 'published', externalRef: 'shelf-ref-1' },
  ) {}

  async publishKeeperToShelf(request: PublishKeeperToShelfRequest): Promise<PublishKeeperToShelfResult> {
    this.requests.push(request);
    return this.result;
  }
}

function makeEntry(overrides: Partial<KnowledgeEntryRecord> = {}): KnowledgeEntryRecord {
  return {
    id: 'entry-1',
    version: '1.0.0',
    projectId: 'proj-1',
    sourceAttemptId: 'attempt-1',
    sourceCommitSha: 'commit-1',
    claimText: 'Always run the typecheck before committing',
    pathPrefixes: [],
    sharedAcrossProjects: false,
    disposition: 'accepted',
    verification: 'supported',
    checkerId: 'checker-1',
    dispositionReason: 'verified by procedure',
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-15T00:00:00.000Z',
    updatedAtIso: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeCaptureRequest(
  overrides: Partial<CaptureCompletedAttemptNotesRequest> = {},
): CaptureCompletedAttemptNotesRequest {
  return {
    projectId: 'proj-1',
    attemptId: 'attempt-1',
    workOrderId: 'work-1',
    headCommitSha: 'commit-1',
    notesMarkdown: null,
    ...overrides,
  };
}

describe('CaptureCompletedAttemptNotesUseCase', () => {
  it('throws Not implemented without dependencies', async () => {
    const useCase = new CaptureCompletedAttemptNotesUseCase();
    await expect(useCase.execute(makeCaptureRequest())).rejects.toThrow(
      'Not implemented: CaptureCompletedAttemptNotesUseCase',
    );
  });

  it('throws Not implemented for a missing request object', async () => {
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo: new InMemoryKnowledgeEntryRepository() });
    await expect(useCase.execute(undefined as unknown as CaptureCompletedAttemptNotesRequest)).rejects.toThrow(
      'Not implemented: CaptureCompletedAttemptNotesUseCase',
    );
  });

  it('records missing notes without error and without candidates', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo });

    const nullResult = await useCase.captureCompletedAttemptNotes(makeCaptureRequest({ notesMarkdown: null }));
    expect(nullResult).toEqual({ outcome: 'captured', notesStatus: 'missing', candidateEntries: [] });

    const blankResult = await useCase.captureCompletedAttemptNotes(
      makeCaptureRequest({ notesMarkdown: '   \n\t  ' }),
    );
    expect(blankResult).toEqual({ outcome: 'captured', notesStatus: 'missing', candidateEntries: [] });
    expect(repo.entries.size).toBe(0);
  });

  it('parses markdown bullets into bounded candidate entries and saves them', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo });

    const result: CaptureCompletedAttemptNotesResult = await useCase.captureCompletedAttemptNotes(
      makeCaptureRequest({
        notesMarkdown: '- First finding\n* Second finding\nplain line is not a bullet\n-   \n',
        pathPrefixes: ['src/api'],
        nowIso: '2026-10-15T01:00:00.000Z',
      }),
    );

    expect(result).toMatchObject({ outcome: 'captured', notesStatus: 'present' });
    if (result.outcome !== 'captured' || result.notesStatus !== 'present') {
      throw new Error('expected captured notes');
    }
    expect(result.candidateEntries).toHaveLength(2);
    expect(repo.entries.size).toBe(2);

    const [first, second] = result.candidateEntries;
    expect(first.claimText).toBe('First finding');
    expect(second.claimText).toBe('Second finding');
    expect(first.id).not.toBe(second.id);
    for (const entry of [first, second]) {
      expect(entry.projectId).toBe('proj-1');
      expect(entry.sourceAttemptId).toBe('attempt-1');
      expect(entry.sourceCommitSha).toBe('commit-1');
      expect(entry.disposition).toBe('candidate');
      expect(entry.verification).toBe('unverified');
      expect(entry.version).toBe('1.0.0');
      expect(entry.revision).toBe(1);
      expect(entry.pathPrefixes).toEqual(['src/api']);
      expect(entry.createdAtIso).toBe('2026-10-15T01:00:00.000Z');
      expect(repo.entries.get(entry.id)).toEqual(entry);
    }
  });

  it('rejects blank required identity fields', async () => {
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo: new InMemoryKnowledgeEntryRepository() });
    for (const field of ['projectId', 'attemptId', 'workOrderId', 'headCommitSha'] as const) {
      const result = await useCase.captureCompletedAttemptNotes(makeCaptureRequest({ [field]: '   ' }));
      expect(result.outcome).toBe('rejected');
      if (result.outcome === 'rejected') {
        expect(result.reason).toContain(field);
      }
    }
  });
});

describe('CheckKnowledgeClaimUseCase', () => {
  it('throws Not implemented without dependencies', async () => {
    const useCase = new CheckKnowledgeClaimUseCase();
    await expect(
      useCase.execute({ checkId: 'check-1', entryId: 'entry-1', checkerId: 'c', procedureName: 'p' }),
    ).rejects.toThrow('Not implemented: CheckKnowledgeClaimUseCase');
  });

  it('records the check, updates verification and revision, and saves the entry', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const entry = makeEntry({ disposition: 'candidate', verification: 'unverified' });
    await repo.saveEntry(entry);
    const verifier = new StubClaimVerifier({
      verification: 'supported',
      evidenceRef: 'evidence-1',
    });
    const useCase = new CheckKnowledgeClaimUseCase({ repo, verifier });

    const request: CheckKnowledgeClaimRequest = {
      checkId: 'check-1',
      entryId: 'entry-1',
      checkerId: 'checker-9',
      procedureName: 'inspect-source-path',
      targetPath: 'src/api/cache.ts',
      nowIso: '2026-10-15T02:00:00.000Z',
    };
    const result = await useCase.checkKnowledgeClaim(request);

    expect(result.outcome).toBe('checked');
    if (result.outcome !== 'checked') {
      throw new Error('expected checked outcome');
    }
    expect(verifier.requests[0]).toEqual({
      entryId: 'entry-1',
      claimText: entry.claimText,
      procedureName: 'inspect-source-path',
      targetPath: 'src/api/cache.ts',
    });
    expect(result.check).toEqual({
      id: 'check-1',
      entryId: 'entry-1',
      checkerId: 'checker-9',
      procedureName: 'inspect-source-path',
      verification: 'supported',
      evidenceRef: 'evidence-1',
      checkedAtIso: '2026-10-15T02:00:00.000Z',
    });
    expect(result.entry.verification).toBe('supported');
    expect(result.entry.checks).toHaveLength(1);
    expect(result.entry.checks[0]).toEqual(result.check);
    expect(result.entry.revision).toBe(2);
    expect(repo.entries.get('entry-1')).toEqual(result.entry);
  });

  it('records contradicted verdicts from the verifier', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ disposition: 'candidate', verification: 'unverified' }));
    const verifier = new StubClaimVerifier({ verification: 'contradicted', evidenceRef: 'evidence-2' });
    const useCase = new CheckKnowledgeClaimUseCase({ repo, verifier });

    const result = await useCase.checkKnowledgeClaim({
      checkId: 'check-2',
      entryId: 'entry-1',
      checkerId: 'checker-1',
      procedureName: 'inspect-source-path',
    });

    expect(result.outcome).toBe('checked');
    if (result.outcome === 'checked') {
      expect(result.entry.verification).toBe('contradicted');
    }
  });

  it('rejects unknown entries', async () => {
    const useCase = new CheckKnowledgeClaimUseCase({
      repo: new InMemoryKnowledgeEntryRepository(),
      verifier: new StubClaimVerifier(),
    });
    const result = await useCase.checkKnowledgeClaim({
      checkId: 'check-1',
      entryId: 'missing',
      checkerId: 'checker-1',
      procedureName: 'inspect-source-path',
    });
    expect(result).toMatchObject({ outcome: 'rejected' });
  });
});

describe('DecideKnowledgeDispositionUseCase', () => {
  it('throws Not implemented without dependencies', async () => {
    const useCase = new DecideKnowledgeDispositionUseCase();
    await expect(
      useCase.execute({ entryId: 'entry-1', disposition: 'accepted', checkerId: 'c', reason: 'r' }),
    ).rejects.toThrow('Not implemented: DecideKnowledgeDispositionUseCase');
  });

  it('rejects accepting an unverified claim', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const entry = makeEntry({ disposition: 'candidate', verification: 'unverified' });
    await repo.saveEntry(entry);
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const request: DecideKnowledgeDispositionRequest = {
      entryId: 'entry-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'looks good',
    };
    const result = await useCase.decideKnowledgeDisposition(request);

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'An unverified claim cannot become accepted; run a supported check first',
    });
    expect(repo.entries.get('entry-1')?.disposition).toBe('candidate');
    expect(repo.entries.get('entry-1')?.revision).toBe(1);
  });

  it('never accepts policy proposals', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      makeEntry({
        claimText: 'Change permissions for the deploy seat',
        disposition: 'candidate',
        verification: 'supported',
      }),
    );
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.decideKnowledgeDisposition({
      entryId: 'entry-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'approved',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'A policy proposal never becomes an accepted keeper; coordinate it as policy',
    });
  });

  it('applies entity guard: a policy proposal entry is never accepted', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      makeEntry({
        claimText: 'General compiler guidance',
        disposition: 'policy-proposal',
        verification: 'supported',
      }),
    );
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.decideKnowledgeDisposition({
      entryId: 'entry-1',
      disposition: 'accepted',
      checkerId: 'checker-1',
      reason: 'approved',
    });

    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'A policy proposal never becomes an accepted keeper; coordinate it as policy',
    });
  });

  it('accepts a supported non-policy claim with checker attribution', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ disposition: 'candidate', verification: 'supported' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.decideKnowledgeDisposition({
      entryId: 'entry-1',
      disposition: 'accepted',
      checkerId: 'checker-7',
      reason: 'verified by procedure',
      nowIso: '2026-10-15T03:00:00.000Z',
    });

    expect(result.outcome).toBe('decided');
    if (result.outcome !== 'decided') {
      throw new Error('expected decided outcome');
    }
    expect(result.entry.disposition).toBe('accepted');
    expect(result.entry.checkerId).toBe('checker-7');
    expect(result.entry.dispositionReason).toBe('verified by procedure');
    expect(result.entry.revision).toBe(2);
    expect(result.entry.updatedAtIso).toBe('2026-10-15T03:00:00.000Z');
    expect(repo.entries.get('entry-1')).toEqual(result.entry);
  });

  it('records a rejection disposition on an unverified candidate', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ disposition: 'candidate', verification: 'unverified' }));
    const useCase = new DecideKnowledgeDispositionUseCase({ repo });

    const result = await useCase.decideKnowledgeDisposition({
      entryId: 'entry-1',
      disposition: 'rejected',
      checkerId: 'checker-7',
      reason: 'duplicated elsewhere',
    });

    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') {
      expect(result.entry.disposition).toBe('rejected');
    }
  });

  it('rejects unknown entries and invalid dispositions', async () => {
    const useCase = new DecideKnowledgeDispositionUseCase({ repo: new InMemoryKnowledgeEntryRepository() });
    const unknown = await useCase.decideKnowledgeDisposition({
      entryId: 'missing',
      disposition: 'accepted',
      checkerId: 'c',
      reason: 'r',
    });
    expect(unknown.outcome).toBe('rejected');

    const invalid = await useCase.decideKnowledgeDisposition({
      entryId: 'entry-1',
      disposition: 'bogus' as never,
      checkerId: 'c',
      reason: 'r',
    });
    expect(invalid.outcome).toBe('rejected');
  });
});

describe('PublishAcceptedKeeperUseCase', () => {
  it('throws Not implemented without dependencies', async () => {
    const useCase = new PublishAcceptedKeeperUseCase();
    await expect(useCase.execute({ entryId: 'entry-1' })).rejects.toThrow(
      'Not implemented: PublishAcceptedKeeperUseCase',
    );
  });

  it('publishes an accepted, non-superseded keeper', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const entry = makeEntry();
    await repo.saveEntry(entry);
    const publisher = new StubKeeperPublisher();
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });

    const request: PublishAcceptedKeeperRequest = { entryId: 'entry-1' };
    const result = await useCase.publishAcceptedKeeper(request);

    expect(result).toEqual({ outcome: 'published', entry, externalRef: 'shelf-ref-1' });
    expect(publisher.requests[0]?.entry.id).toBe('entry-1');
  });

  it('preserves failed delivery without throwing', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const entry = makeEntry();
    await repo.saveEntry(entry);
    const publisher = new StubKeeperPublisher({ outcome: 'failed', reason: 'shelf offline' });
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher });

    const result = await useCase.publishAcceptedKeeper({ entryId: 'entry-1' });

    expect(result).toEqual({ outcome: 'delivery-failed', entry, reason: 'shelf offline' });
  });

  it('rejects entries that are not accepted', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ disposition: 'candidate' }));
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher: new StubKeeperPublisher() });

    const result = await useCase.publishAcceptedKeeper({ entryId: 'entry-1' });
    expect(result).toMatchObject({ outcome: 'rejected' });
  });

  it('rejects superseded keepers', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ supersededById: 'entry-2' }));
    const useCase = new PublishAcceptedKeeperUseCase({ repo, publisher: new StubKeeperPublisher() });

    const result = await useCase.publishAcceptedKeeper({ entryId: 'entry-1' });
    expect(result.outcome).toBe('rejected');
  });

  it('rejects unknown entries', async () => {
    const useCase = new PublishAcceptedKeeperUseCase({
      repo: new InMemoryKnowledgeEntryRepository(),
      publisher: new StubKeeperPublisher(),
    });
    const result = await useCase.publishAcceptedKeeper({ entryId: 'missing' });
    expect(result.outcome).toBe('rejected');
  });
});

describe('ProposeBriefContextUseCase', () => {
  const retrieval = new KnowledgeRetrievalAdapter();

  async function seedProposeRepo(): Promise<InMemoryKnowledgeEntryRepository> {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      makeEntry({
        id: 'keeper-1',
        claimText: 'Cache API responses with an in-memory layer to speed up requests',
        pathPrefixes: ['src/api'],
      }),
    );
    await repo.saveEntry(
      makeEntry({ id: 'candidate-1', claimText: 'Cache API responses', disposition: 'candidate', verification: 'unverified' }),
    );
    await repo.saveEntry(makeEntry({ id: 'rejected-1', claimText: 'Cache API responses', disposition: 'rejected' }));
    await repo.saveEntry(
      makeEntry({
        id: 'superseded-1',
        claimText: 'Cache API responses',
        disposition: 'accepted',
        supersededById: 'keeper-1',
      }),
    );
    await repo.saveEntry(
      makeEntry({
        id: 'accepted-unverified-1',
        claimText: 'Cache API responses',
        disposition: 'accepted',
        verification: 'unverified',
      }),
    );
    await repo.saveEntry(
      makeEntry({
        id: 'policy-1',
        claimText: 'Change permissions for the deploy seat',
        disposition: 'policy-proposal',
      }),
    );
    await repo.saveEntry(
      makeEntry({
        id: 'shared-1',
        projectId: 'proj-2',
        sharedAcrossProjects: true,
        claimText: 'Rotate the API client token nightly',
      }),
    );
    await repo.saveEntry(
      makeEntry({ id: 'foreign-1', projectId: 'proj-2', sharedAcrossProjects: false, claimText: 'Cache API responses' }),
    );
    return repo;
  }

  function makeProposeRequest(overrides: Partial<ProposeBriefContextRequest> = {}): ProposeBriefContextRequest {
    return {
      projectId: 'proj-1',
      laneId: 'lane-1',
      taskSummary: 'Cache API responses for faster requests',
      ...overrides,
    };
  }

  it('throws Not implemented without dependencies', async () => {
    const useCase = new ProposeBriefContextUseCase();
    await expect(useCase.execute(makeProposeRequest())).rejects.toThrow(
      'Not implemented: ProposeBriefContextUseCase',
    );
  });

  it('proposes only accepted, supported, non-superseded keepers in scope', async () => {
    const repo = await seedProposeRepo();
    const useCase = new ProposeBriefContextUseCase({ repo, retrieval });

    const result = await useCase.proposeBriefContext(makeProposeRequest({ pathPrefixes: ['src/api'] }));

    expect(result.outcome).toBe('proposed');
    if (result.outcome !== 'proposed') {
      throw new Error('expected proposed outcome');
    }
    const proposedIds = result.proposals.map((proposal) => proposal.knowledgeEntryId);
    expect(proposedIds).toContain('keeper-1');
    expect(proposedIds).toContain('shared-1');
    for (const excluded of [
      'candidate-1',
      'rejected-1',
      'superseded-1',
      'accepted-unverified-1',
      'policy-1',
      'foreign-1',
    ]) {
      expect(proposedIds).not.toContain(excluded);
    }
    for (const proposal of result.proposals) {
      expect(proposal.proposalId).toMatch(/^bkp-/);
      expect(proposal.proposedBecause.length).toBeGreaterThan(0);
      expect(proposal.claimText.length).toBeGreaterThan(0);
      expect(proposal.version).toBe('1.0.0');
    }
  });

  it('ranks the strongest lexical and path match first', async () => {
    const repo = await seedProposeRepo();
    await repo.saveEntry(
      makeEntry({ id: 'keeper-2', claimText: 'Rotate the API client token nightly', pathPrefixes: ['docs'] }),
    );
    const useCase = new ProposeBriefContextUseCase({ repo, retrieval });

    const result = await useCase.proposeBriefContext(makeProposeRequest({ pathPrefixes: ['src/api'] }));

    expect(result.outcome).toBe('proposed');
    if (result.outcome !== 'proposed') {
      throw new Error('expected proposed outcome');
    }
    expect(result.proposals[0]?.knowledgeEntryId).toBe('keeper-1');
  });

  it('enforces the maxEntries bound', async () => {
    const repo = await seedProposeRepo();
    const useCase = new ProposeBriefContextUseCase({ repo, retrieval });

    const result = await useCase.proposeBriefContext(makeProposeRequest({ maxEntries: 1 }));

    expect(result.outcome).toBe('proposed');
    if (result.outcome === 'proposed') {
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0]?.knowledgeEntryId).toBe('keeper-1');
    }
  });

  it('enforces the maxTotalChars budget', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(
      makeEntry({
        id: 'keeper-long',
        claimText: 'Cache API responses', // 19 chars, ranks first (3/6 tokens)
      }),
    );
    await repo.saveEntry(
      makeEntry({
        id: 'keeper-short',
        claimText: 'Cache responses', // 15 chars, ranks second (2/6 tokens)
      }),
    );
    const useCase = new ProposeBriefContextUseCase({ repo, retrieval });

    const unconstrained = await useCase.proposeBriefContext(makeProposeRequest());
    expect(unconstrained.outcome).toBe('proposed');
    if (unconstrained.outcome === 'proposed') {
      expect(unconstrained.proposals.map((p) => p.knowledgeEntryId)).toEqual(['keeper-long', 'keeper-short']);
    }

    const budgeted = await useCase.proposeBriefContext(makeProposeRequest({ maxTotalChars: 16 }));
    expect(budgeted.outcome).toBe('proposed');
    if (budgeted.outcome === 'proposed') {
      expect(budgeted.proposals.map((p) => p.knowledgeEntryId)).toEqual(['keeper-short']);
    }
  });

  it('rejects non-positive retrieval bounds', async () => {
    const repo = await seedProposeRepo();
    const useCase = new ProposeBriefContextUseCase({ repo, retrieval });

    const zeroEntries = await useCase.proposeBriefContext(makeProposeRequest({ maxEntries: 0 }));
    expect(zeroEntries).toMatchObject({ outcome: 'rejected' });

    const zeroChars = await useCase.proposeBriefContext(makeProposeRequest({ maxTotalChars: 0 }));
    expect(zeroChars).toMatchObject({ outcome: 'rejected' });
  });

  it('rejects blank required fields', async () => {
    const repo = await seedProposeRepo();
    const useCase = new ProposeBriefContextUseCase({ repo, retrieval });
    expect((await useCase.proposeBriefContext(makeProposeRequest({ projectId: ' ' }))).outcome).toBe('rejected');
    expect((await useCase.proposeBriefContext(makeProposeRequest({ laneId: '' }))).outcome).toBe('rejected');
    expect((await useCase.proposeBriefContext(makeProposeRequest({ taskSummary: '' }))).outcome).toBe('rejected');
  });
});

describe('RecordContextSelectionUseCase', () => {
  it('throws Not implemented without dependencies', async () => {
    const useCase = new RecordContextSelectionUseCase();
    await expect(
      useCase.execute({
        attemptId: 'attempt-1',
        selections: [{ proposalId: 'p1', knowledgeEntryId: 'e1', version: '1.0.0', accepted: true }],
      }),
    ).rejects.toThrow('Not implemented: RecordContextSelectionUseCase');
  });

  it('records selections for an attempt in order', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ id: 'keeper-1', disposition: 'accepted', verification: 'supported' }));
    await repo.saveEntry(makeEntry({ id: 'keeper-2', disposition: 'accepted', verification: 'supported' }));
    const useCase = new RecordContextSelectionUseCase({ repo });

    const request: RecordBriefContextSelectionRequest = {
      attemptId: 'attempt-1',
      selections: [
        {
          proposalId: 'bkp-1',
          knowledgeEntryId: 'keeper-1',
          version: '1.0.0',
          accepted: true,
          decisionBecause: 'applies to src/api',
        },
        {
          proposalId: 'bkp-2',
          knowledgeEntryId: 'keeper-2',
          version: '1.0.0',
          accepted: false,
          decisionBecause: 'selected by orchestrator',
        },
      ],
    };
    const result = await useCase.recordContextSelection(request);

    expect(result).toEqual({ outcome: 'recorded', recordedCount: 2 });
    const stored = await repo.listContextSelections('attempt-1');
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual({
      attemptId: 'attempt-1',
      knowledgeEntryId: 'keeper-1',
      version: '1.0.0',
      accepted: true,
      decisionBecause: 'applies to src/api',
    });
    expect(stored[1]).toEqual({
      attemptId: 'attempt-1',
      knowledgeEntryId: 'keeper-2',
      version: '1.0.0',
      accepted: false,
      decisionBecause: 'selected by orchestrator',
    });
  });

  it('rejects a blank attemptId and an empty selection list', async () => {
    const useCase = new RecordContextSelectionUseCase({ repo: new InMemoryKnowledgeEntryRepository() });

    const blankAttempt = await useCase.recordContextSelection({
      attemptId: '  ',
      selections: [{ proposalId: 'p', knowledgeEntryId: 'e', version: '1.0.0', accepted: true }],
    });
    expect(blankAttempt.outcome).toBe('rejected');

    const emptySelections = await useCase.recordContextSelection({ attemptId: 'attempt-1', selections: [] });
    expect(emptySelections).toMatchObject({ outcome: 'rejected' });
  });

  it('rejects invalid selection items', async () => {
    const useCase = new RecordContextSelectionUseCase({ repo: new InMemoryKnowledgeEntryRepository() });

    const result = await useCase.recordContextSelection({
      attemptId: 'attempt-1',
      selections: [{ proposalId: 'p', knowledgeEntryId: 'e', version: '', accepted: true }],
    });
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'ContextSelection requires a non-empty version' });
  });

  it('allows a rejected selection (accepted: false) to reference a candidate or contradicted entry', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ id: 'cand-1', disposition: 'candidate', verification: 'unverified' }));
    await repo.saveEntry(makeEntry({ id: 'contra-1', disposition: 'candidate', verification: 'contradicted' }));
    const useCase = new RecordContextSelectionUseCase({ repo });

    const result = await useCase.recordContextSelection({
      attemptId: 'attempt-1',
      selections: [
        {
          proposalId: 'bkp-1',
          knowledgeEntryId: 'cand-1',
          version: '1.0.0',
          accepted: false,
          decisionBecause: 'Candidate unverified',
        },
        {
          proposalId: 'bkp-2',
          knowledgeEntryId: 'contra-1',
          version: '1.0.0',
          accepted: false,
          decisionBecause: 'Contradicted entry',
        },
      ],
    });

    expect(result).toEqual({ outcome: 'recorded', recordedCount: 2 });
    const stored = await repo.listContextSelections('attempt-1');
    expect(stored).toHaveLength(2);
    expect(stored[0].accepted).toBe(false);
    expect(stored[1].accepted).toBe(false);
  });
});

describe('RecordKnowledgeReuseUseCase', () => {
  it('throws Not implemented without dependencies', async () => {
    const useCase = new RecordKnowledgeReuseUseCase();
    await expect(
      useCase.execute({ reuseId: 'r1', entryId: 'e1', attemptId: 'a1', outcome: 'helped' }),
    ).rejects.toThrow('Not implemented: RecordKnowledgeReuseUseCase');
  });

  it('records a reuse with attribution and increments the revision', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const entry = makeEntry();
    await repo.saveEntry(entry);
    const useCase = new RecordKnowledgeReuseUseCase({ repo });

    const request: RecordKnowledgeReuseRequest = {
      reuseId: 'reuse-1',
      entryId: 'entry-1',
      attemptId: 'attempt-9',
      outcome: 'helped',
      evidenceRef: 'evidence-9',
      nowIso: '2026-10-15T04:00:00.000Z',
    };
    const result = await useCase.recordKnowledgeReuse(request);

    expect(result.outcome).toBe('recorded');
    if (result.outcome !== 'recorded') {
      throw new Error('expected recorded outcome');
    }
    expect(result.reuse).toEqual({
      id: 'reuse-1',
      entryId: 'entry-1',
      version: '1.0.0',
      attemptId: 'attempt-9',
      outcome: 'helped',
      evidenceRef: 'evidence-9',
      recordedAtIso: '2026-10-15T04:00:00.000Z',
    });
    expect(result.entry.reuses).toHaveLength(1);
    expect(result.entry.revision).toBe(2);
    expect(repo.entries.get('entry-1')).toEqual(result.entry);
  });

  it('defaults evidenceRef to null', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry());
    const useCase = new RecordKnowledgeReuseUseCase({ repo });

    const result = await useCase.recordKnowledgeReuse({
      reuseId: 'reuse-2',
      entryId: 'entry-1',
      attemptId: 'attempt-9',
      outcome: 'included',
    });
    expect(result.outcome).toBe('recorded');
    if (result.outcome === 'recorded') {
      expect(result.reuse.evidenceRef).toBeNull();
    }
  });

  it('rejects unknown entries and invalid outcomes', async () => {
    const useCase = new RecordKnowledgeReuseUseCase({ repo: new InMemoryKnowledgeEntryRepository() });

    const unknown = await useCase.recordKnowledgeReuse({
      reuseId: 'reuse-1',
      entryId: 'missing',
      attemptId: 'attempt-9',
      outcome: 'helped',
    });
    expect(unknown.outcome).toBe('rejected');

    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry());
    const withRepo = new RecordKnowledgeReuseUseCase({ repo });
    const invalid = await withRepo.recordKnowledgeReuse({
      reuseId: 'reuse-1',
      entryId: 'entry-1',
      attemptId: 'attempt-9',
      outcome: 'bogus' as KnowledgeReuseOutcomeValue,
    });
    expect(invalid.outcome).toBe('rejected');
  });
});

describe('SupersedeKnowledgeEntryUseCase', () => {
  it('throws Not implemented without dependencies', async () => {
    const useCase = new SupersedeKnowledgeEntryUseCase();
    await expect(
      useCase.execute({ olderEntryId: 'o', newerEntryId: 'n', checkerId: 'c', reason: 'r' }),
    ).rejects.toThrow('Not implemented: SupersedeKnowledgeEntryUseCase');
  });

  it('marks the older entry superseded and links it to the newer entry', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    const older = makeEntry({ id: 'older-1', disposition: 'accepted', verification: 'supported' });
    const newer = makeEntry({ id: 'newer-1', claimText: 'Cache API responses with a distributed layer' });
    await repo.saveEntry(older);
    await repo.saveEntry(newer);
    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });

    const request: SupersedeKnowledgeEntryRequest = {
      olderEntryId: 'older-1',
      newerEntryId: 'newer-1',
      checkerId: 'checker-3',
      reason: 'replaced by the distributed approach',
      nowIso: '2026-10-15T05:00:00.000Z',
    };
    const result = await useCase.supersedeKnowledgeEntry(request);

    expect(result.outcome).toBe('superseded');
    if (result.outcome !== 'superseded') {
      throw new Error('expected superseded outcome');
    }
    expect(result.olderEntry.disposition).toBe('superseded');
    expect(result.olderEntry.supersededById).toBe('newer-1');
    expect(result.olderEntry.checkerId).toBe('checker-3');
    expect(result.olderEntry.dispositionReason).toBe('replaced by the distributed approach');
    expect(result.olderEntry.revision).toBe(2);
    expect(result.newerEntry).toEqual(newer);
    expect(repo.entries.get('older-1')).toEqual(result.olderEntry);
  });

  it('rejects self-supersession', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry());
    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });

    const result = await useCase.supersedeKnowledgeEntry({
      olderEntryId: 'entry-1',
      newerEntryId: 'entry-1',
      checkerId: 'checker-1',
      reason: 'same entry',
    });
    expect(result.outcome).toBe('rejected');
  });

  it('rejects when the newer entry is not accepted', async () => {
    const repo = new InMemoryKnowledgeEntryRepository();
    await repo.saveEntry(makeEntry({ id: 'older-1' }));
    await repo.saveEntry(makeEntry({ id: 'newer-1', disposition: 'candidate' }));
    const useCase = new SupersedeKnowledgeEntryUseCase({ repo });

    const result = await useCase.supersedeKnowledgeEntry({
      olderEntryId: 'older-1',
      newerEntryId: 'newer-1',
      checkerId: 'checker-1',
      reason: 'replacement',
    });
    expect(result.outcome).toBe('rejected');
  });

  it('rejects unknown entries', async () => {
    const useCase = new SupersedeKnowledgeEntryUseCase({ repo: new InMemoryKnowledgeEntryRepository() });

    const result = await useCase.supersedeKnowledgeEntry({
      olderEntryId: 'missing',
      newerEntryId: 'newer-1',
      checkerId: 'checker-1',
      reason: 'replacement',
    });
    expect(result.outcome).toBe('rejected');
  });
});
