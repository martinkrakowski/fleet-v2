import { describe, expect, it } from 'vitest';

import { KnowledgeCheck } from '../entities/KnowledgeCheck.js';
import { KnowledgeEntry } from '../entities/KnowledgeEntry.js';
import { KnowledgeReuse } from '../entities/KnowledgeReuse.js';
import type { KnowledgeEntryRecord } from '../knowledge-records.js';
import { ContextSelection } from '../value-objects/ContextSelection.vo.js';
import { KNOWLEDGE_DISPOSITIONS, KnowledgeDisposition } from '../value-objects/KnowledgeDisposition.vo.js';
import { KNOWLEDGE_REUSE_OUTCOMES, KnowledgeReuseOutcome } from '../value-objects/KnowledgeReuseOutcome.vo.js';
import { KnowledgeScope } from '../value-objects/KnowledgeScope.vo.js';
import { KNOWLEDGE_VERIFICATIONS, KnowledgeVerification } from '../value-objects/KnowledgeVerification.vo.js';
import { RetrievalBudget } from '../value-objects/RetrievalBudget.vo.js';

function makeEntryRecord(overrides: Partial<KnowledgeEntryRecord> = {}): KnowledgeEntryRecord {
  return {
    id: 'entry-1',
    version: 'v1',
    projectId: 'project-1',
    sourceAttemptId: 'attempt-1',
    sourceCommitSha: 'abc1234',
    claimText: 'Run yarn typecheck before dispatch.',
    pathPrefixes: ['packages/brief-knowledge'],
    sharedAcrossProjects: false,
    disposition: 'candidate',
    verification: 'unverified',
    checkerId: null,
    dispositionReason: null,
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 0,
    createdAtIso: '2026-10-15T00:00:00.000Z',
    updatedAtIso: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeCheckRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'check-1',
    entryId: 'entry-1',
    checkerId: 'orchestrator-1',
    procedureName: 'run-typecheck',
    verification: 'supported',
    evidenceRef: 'runs/attempt-1/typecheck.log',
    checkedAtIso: '2026-10-15T01:00:00.000Z',
    ...overrides,
  };
}

describe('KnowledgeDisposition', () => {
  it('accepts every declared enum value', () => {
    for (const value of KNOWLEDGE_DISPOSITIONS) {
      const created = KnowledgeDisposition.create(value);
      expect(created.success).toBe(true);
      expect(created.value?.getValue()).toBe(value);
    }
  });

  it('rejects values outside the enum', () => {
    expect(KnowledgeDisposition.create('promoted').success).toBe(false);
    expect(KnowledgeDisposition.create(42).success).toBe(false);
    expect(KnowledgeDisposition.create(null).success).toBe(false);
  });

  it('marks only accepted as a retrievable keeper', () => {
    expect(KnowledgeDisposition.create('accepted').value?.isRetrievableKeeper()).toBe(true);
    expect(KnowledgeDisposition.create('candidate').value?.isRetrievableKeeper()).toBe(false);
    expect(KnowledgeDisposition.create('policy-proposal').value?.isRetrievableKeeper()).toBe(false);
  });

  it('compares by value', () => {
    const left = KnowledgeDisposition.create('accepted').value;
    const right = KnowledgeDisposition.create('accepted').value;
    const other = KnowledgeDisposition.create('deferred').value;
    expect(left?.equals(right as KnowledgeDisposition)).toBe(true);
    expect(left?.equals(other as KnowledgeDisposition)).toBe(false);
  });
});

describe('KnowledgeVerification', () => {
  it('accepts every declared enum value', () => {
    for (const value of KNOWLEDGE_VERIFICATIONS) {
      expect(KnowledgeVerification.create(value).success).toBe(true);
    }
  });

  it('rejects values outside the enum', () => {
    expect(KnowledgeVerification.create('probably-fine').success).toBe(false);
    expect(KnowledgeVerification.create(undefined).success).toBe(false);
  });

  it('treats only supported as accepted-grade evidence', () => {
    expect(KnowledgeVerification.create('supported').value?.isSupported()).toBe(true);
    expect(KnowledgeVerification.create('unverified').value?.isSupported()).toBe(false);
  });
});

describe('KnowledgeReuseOutcome', () => {
  it('accepts every declared enum value', () => {
    for (const value of KNOWLEDGE_REUSE_OUTCOMES) {
      expect(KnowledgeReuseOutcome.create(value).success).toBe(true);
    }
  });

  it('rejects values outside the enum', () => {
    expect(KnowledgeReuseOutcome.create('saved-the-day').success).toBe(false);
  });

  it('does not count inclusion as demonstrated benefit', () => {
    expect(KnowledgeReuseOutcome.create('helped').value?.demonstratesBenefit()).toBe(true);
    expect(KnowledgeReuseOutcome.create('included').value?.demonstratesBenefit()).toBe(false);
  });
});

describe('KnowledgeScope', () => {
  it('requires a non-empty projectId', () => {
    expect(KnowledgeScope.create({ projectId: '', pathPrefixes: [], sharedAcrossProjects: false }).success).toBe(false);
    expect(KnowledgeScope.create({ projectId: '   ', pathPrefixes: [], sharedAcrossProjects: false }).success).toBe(
      false,
    );
  });

  it('creates an immutable copy of its props', () => {
    const props = { projectId: 'project-1', pathPrefixes: ['packages/x'], sharedAcrossProjects: true };
    const scope = KnowledgeScope.create(props).value as KnowledgeScope;
    expect(scope.getProjectId()).toBe('project-1');
    expect(scope.getPathPrefixes()).toEqual(['packages/x']);
    expect(scope.isSharedAcrossProjects()).toBe(true);
  });

  it('applies to the owning project and, when shared, to others', () => {
    const owned = KnowledgeScope.create({
      projectId: 'project-1',
      pathPrefixes: [],
      sharedAcrossProjects: false,
    }).value as KnowledgeScope;
    expect(owned.appliesToProject('project-1')).toBe(true);
    expect(owned.appliesToProject('project-2')).toBe(false);

    const shared = KnowledgeScope.create({
      projectId: 'project-1',
      pathPrefixes: [],
      sharedAcrossProjects: true,
    }).value as KnowledgeScope;
    expect(shared.appliesToProject('project-2')).toBe(true);
  });

  it('compares by value', () => {
    const left = KnowledgeScope.create({ projectId: 'p', pathPrefixes: ['a'], sharedAcrossProjects: false })
      .value as KnowledgeScope;
    const right = KnowledgeScope.create({ projectId: 'p', pathPrefixes: ['a'], sharedAcrossProjects: false })
      .value as KnowledgeScope;
    expect(left.equals(right)).toBe(true);
  });
});

describe('ContextSelection', () => {
  it('requires a non-empty decisionBecause', () => {
    const result = ContextSelection.create({
      attemptId: 'attempt-1',
      knowledgeEntryId: 'entry-1',
      version: 'v1',
      accepted: true,
      decisionBecause: '',
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/decisionBecause/);
  });

  it('requires non-empty identity fields', () => {
    expect(
      ContextSelection.create({
        attemptId: '',
        knowledgeEntryId: 'entry-1',
        version: 'v1',
        accepted: true,
        decisionBecause: 'operator chose it',
      }).success,
    ).toBe(false);
    expect(
      ContextSelection.create({
        attemptId: 'attempt-1',
        knowledgeEntryId: 'entry-1',
        version: '',
        accepted: false,
        decisionBecause: 'operator chose it',
      }).success,
    ).toBe(false);
  });

  it('creates a value object with the recorded decision', () => {
    const selection = ContextSelection.create({
      attemptId: 'attempt-1',
      knowledgeEntryId: 'entry-1',
      version: 'v1',
      accepted: true,
      decisionBecause: 'matched the dispatch path',
    }).value as ContextSelection;
    expect(selection.isAccepted()).toBe(true);
    expect(selection.getDecisionBecause()).toBe('matched the dispatch path');
    expect(selection.equals(selection)).toBe(true);
  });
});

describe('RetrievalBudget', () => {
  it('enforces positive integer bounds', () => {
    expect(RetrievalBudget.create({ maxEntries: 0, maxTotalChars: 100 }).success).toBe(false);
    expect(RetrievalBudget.create({ maxEntries: 5, maxTotalChars: 0 }).success).toBe(false);
    expect(RetrievalBudget.create({ maxEntries: -1, maxTotalChars: 100 }).success).toBe(false);
    expect(RetrievalBudget.create({ maxEntries: 1.5, maxTotalChars: 100 }).success).toBe(false);
    expect(RetrievalBudget.create({ maxEntries: 5, maxTotalChars: 4000 }).success).toBe(true);
  });

  it('exposes its bounds', () => {
    const budget = RetrievalBudget.create({ maxEntries: 5, maxTotalChars: 4000 }).value as RetrievalBudget;
    expect(budget.getMaxEntries()).toBe(5);
    expect(budget.getMaxTotalChars()).toBe(4000);
    expect(budget.equals(RetrievalBudget.create({ maxEntries: 5, maxTotalChars: 4000 }).value as RetrievalBudget)).toBe(
      true,
    );
  });
});

describe('KnowledgeCheck', () => {
  it('requires valid verification and evidence', () => {
    expect(() => KnowledgeCheck.fromRecord(makeCheckRecord({ verification: 'guess' }) as never)).toThrow(
      /invalid verification/,
    );
    expect(() => KnowledgeCheck.fromRecord(makeCheckRecord({ evidenceRef: '' }) as never)).toThrow(/evidenceRef/);
    expect(() => KnowledgeCheck.fromRecord(makeCheckRecord({ checkerId: '' }) as never)).toThrow(/checkerId/);
  });

  it('builds from a valid record', () => {
    const check = KnowledgeCheck.fromRecord(makeCheckRecord() as never);
    expect(check.getId()).toBe('check-1');
    expect(check.getVerification()).toBe('supported');
    expect(check.hasEvidence()).toBe(true);
    expect(check.contradictsClaim()).toBe(false);
  });
});

describe('KnowledgeReuse', () => {
  it('requires a valid outcome', () => {
    const base = {
      id: 'reuse-1',
      entryId: 'entry-1',
      version: 'v1',
      attemptId: 'attempt-2',
      outcome: 'beneficial',
      evidenceRef: null,
      recordedAtIso: '2026-10-15T02:00:00.000Z',
    };
    expect(() => KnowledgeReuse.fromRecord(base as never)).toThrow(/invalid outcome/);
  });

  it('requires evidence to be null or a non-empty string', () => {
    const base = {
      id: 'reuse-1',
      entryId: 'entry-1',
      version: 'v1',
      attemptId: 'attempt-2',
      outcome: 'helped',
      evidenceRef: '   ',
      recordedAtIso: '2026-10-15T02:00:00.000Z',
    };
    expect(() => KnowledgeReuse.fromRecord(base as never)).toThrow(/evidenceRef/);
  });

  it('builds from a valid record', () => {
    const reuse = KnowledgeReuse.fromRecord({
      id: 'reuse-1',
      entryId: 'entry-1',
      version: 'v1',
      attemptId: 'attempt-2',
      outcome: 'helped',
      evidenceRef: 'runs/attempt-2/notes.md',
      recordedAtIso: '2026-10-15T02:00:00.000Z',
    });
    expect(reuse.demonstratesBenefit()).toBe(true);
    expect(reuse.hasEvidence()).toBe(true);
  });
});

describe('KnowledgeEntry', () => {
  it('round-trips a valid record', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord());
    expect(entry.getId()).toBe('entry-1');
    expect(entry.getDisposition()).toBe('candidate');
    expect(entry.toRecord()).toEqual(makeEntryRecord());
  });

  it('refuses an accepted record without supported verification', () => {
    expect(() => KnowledgeEntry.fromRecord(makeEntryRecord({ disposition: 'accepted', verification: 'unverified' }))).toThrow(
      /supported verification/,
    );
  });

  it('refuses an accepted record without a checker identity', () => {
    expect(() =>
      KnowledgeEntry.fromRecord(
        makeEntryRecord({ disposition: 'accepted', verification: 'supported', checkerId: null }),
      ),
    ).toThrow(/checker identity/);
  });

  it('refuses a superseded record without a replacement link', () => {
    expect(() => KnowledgeEntry.fromRecord(makeEntryRecord({ disposition: 'superseded', supersededById: null }))).toThrow(
      /newer entry/,
    );
  });

  it('refuses child records belonging to another entry', () => {
    const withForeignCheck = makeEntryRecord({
      checks: [makeCheckRecord({ entryId: 'entry-2' }) as never],
    });
    expect(() => KnowledgeEntry.fromRecord(withForeignCheck)).toThrow(/does not belong/);
  });

  it('cannot accept an unverified claim', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord());
    expect(() =>
      entry.decideDisposition({ disposition: 'accepted', checkerId: 'orchestrator-1', reason: 'looks right', nowIso: '2026-10-15T03:00:00.000Z' }),
    ).toThrow(/unverified claim cannot become accepted/);
    expect(entry.getDisposition()).toBe('candidate');
  });

  it('cannot accept without a checker identity', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord({ verification: 'supported' }));
    expect(() =>
      entry.decideDisposition({ disposition: 'accepted', checkerId: '  ', reason: 'looks right', nowIso: '2026-10-15T03:00:00.000Z' }),
    ).toThrow(/checker identity/);
  });

  it('accepts a supported, checked claim as a retrievable keeper', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord({ verification: 'supported' }));
    const decided = entry.decideDisposition({
      disposition: 'accepted',
      checkerId: 'orchestrator-1',
      reason: 'verified by typecheck run',
      nowIso: '2026-10-15T03:00:00.000Z',
    });
    expect(decided.disposition).toBe('accepted');
    expect(decided.checkerId).toBe('orchestrator-1');
    expect(decided.dispositionReason).toBe('verified by typecheck run');
    expect(decided.revision).toBe(1);
    expect(KnowledgeEntry.fromRecord(decided).isRetrievableKeeper()).toBe(true);
  });

  it('keeps a policy proposal a policy proposal', () => {
    const proposal = KnowledgeEntry.fromRecord(makeEntryRecord({ disposition: 'policy-proposal' }));
    expect(proposal.isPolicyProposal()).toBe(true);
    expect(() =>
      proposal.decideDisposition({
        disposition: 'accepted',
        checkerId: 'orchestrator-1',
        reason: 'policy change',
        nowIso: '2026-10-15T03:00:00.000Z',
      }),
    ).toThrow(/policy proposal never becomes an accepted keeper/);
    expect(proposal.getDisposition()).toBe('policy-proposal');
    expect(proposal.isRetrievableKeeper()).toBe(false);
  });

  it('cannot re-accept superseded content', () => {
    const entry = KnowledgeEntry.fromRecord(
      makeEntryRecord({
        disposition: 'superseded',
        verification: 'supported',
        checkerId: 'orchestrator-1',
        supersededById: 'entry-2',
      }),
    );
    expect(() =>
      entry.decideDisposition({
        disposition: 'accepted',
        checkerId: 'orchestrator-1',
        reason: 'still useful',
        nowIso: '2026-10-15T03:00:00.000Z',
      }),
    ).toThrow(/excluded from retrieval/);
  });

  it('records a check and adopts its verification', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord());
    entry.applyCheck(makeCheckRecord() as never);
    expect(entry.getVerification()).toBe('supported');
    expect(entry.getChecks()).toHaveLength(1);
    expect(entry.toRecord().revision).toBe(1);
  });

  it('does not let a contradicting check silently demote an accepted keeper', () => {
    const entry = KnowledgeEntry.fromRecord(
      makeEntryRecord({ disposition: 'accepted', verification: 'supported', checkerId: 'orchestrator-1' }),
    );
    expect(() =>
      entry.applyCheck(makeCheckRecord({ id: 'check-2', verification: 'contradicted' }) as never),
    ).toThrow(/accepted keeper requires supported verification/);
    expect(entry.getVerification()).toBe('supported');
  });

  it('records a reuse observation', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord());
    entry.recordReuse({
      id: 'reuse-1',
      entryId: 'entry-1',
      version: 'v1',
      attemptId: 'attempt-2',
      outcome: 'helped',
      evidenceRef: 'runs/attempt-2/notes.md',
      recordedAtIso: '2026-10-15T04:00:00.000Z',
    });
    expect(entry.getReuses()).toHaveLength(1);
    expect(entry.toRecord().reuses[0]?.outcome).toBe('helped');
  });

  it('supersedes with a link to the newer entry and leaves retrieval', () => {
    const entry = KnowledgeEntry.fromRecord(
      makeEntryRecord({ disposition: 'accepted', verification: 'supported', checkerId: 'orchestrator-1' }),
    );
    const superseded = entry.supersedeBy({
      newerEntryId: 'entry-2',
      checkerId: 'orchestrator-1',
      reason: 'corrected by a later check',
      nowIso: '2026-10-15T05:00:00.000Z',
    });
    expect(superseded.disposition).toBe('superseded');
    expect(superseded.supersededById).toBe('entry-2');
    expect(KnowledgeEntry.fromRecord(superseded).isRetrievableKeeper()).toBe(false);
    expect(() =>
      entry.supersedeBy({
        newerEntryId: 'entry-3',
        checkerId: 'orchestrator-1',
        reason: 'again',
        nowIso: '2026-10-15T05:01:00.000Z',
      }),
    ).toThrow(/already superseded/);
  });

  it('refuses to supersede itself', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord());
    expect(() =>
      entry.supersedeBy({
        newerEntryId: 'entry-1',
        checkerId: 'orchestrator-1',
        reason: 'self',
        nowIso: '2026-10-15T05:00:00.000Z',
      }),
    ).toThrow(/cannot supersede itself/);
  });
});
