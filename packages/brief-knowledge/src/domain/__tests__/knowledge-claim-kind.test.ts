import { describe, expect, it } from 'vitest';

import { KnowledgeEntry } from '../entities/KnowledgeEntry.js';
import type { KnowledgeEntryRecord } from '../knowledge-records.js';
import { KNOWLEDGE_CLAIM_KINDS } from '../knowledge-records.js';

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

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('KnowledgeEntry claimKind', () => {
  it('reads a record without a claim kind as a fact', () => {
    const entry = KnowledgeEntry.fromRecord(makeEntryRecord());
    expect(entry.getClaimKind()).toBe('fact');
    expect(entry.isFailedClaim()).toBe(false);
    expect(entry.toRecord().claimKind).toBeUndefined();
  });

  it('accepts every declared claim kind', () => {
    for (const kind of KNOWLEDGE_CLAIM_KINDS) {
      const entry = KnowledgeEntry.fromRecord(makeEntryRecord({ claimKind: kind }));
      expect(entry.getClaimKind()).toBe(kind);
    }
  });

  it('refuses a claim kind outside the enum', () => {
    expect(() =>
      KnowledgeEntry.fromRecord(makeEntryRecord({ claimKind: 'proved' } as never)),
    ).toThrow(/claimKind/);
    expect(() => KnowledgeEntry.fromRecord(makeEntryRecord({ claimKind: 42 } as never))).toThrow(/claimKind/);
    expect(() => KnowledgeEntry.fromRecord(makeEntryRecord({ claimKind: null } as never))).toThrow(/claimKind/);
    expect(() =>
      KnowledgeEntry.fromRecord(makeEntryRecord({ claimKind: 'proved' } as never)),
    ).toThrow(/fact, observed, failed/);
  });

  it('caps the claim text of a failed claim at 300 characters', () => {
    const atCap = KnowledgeEntry.fromRecord(
      makeEntryRecord({ claimKind: 'failed', claimText: 'x'.repeat(300) }),
    );
    expect(atCap.isFailedClaim()).toBe(true);

    const overCap = 'y'.repeat(301);
    const message = thrownMessage(() =>
      KnowledgeEntry.fromRecord(makeEntryRecord({ claimKind: 'failed', claimText: overCap })),
    );
    expect(message).toMatch(/claimText/);
    expect(message).not.toContain(overCap);
  });

  it('does not cap the claim text of a fact or observed claim', () => {
    const fact = KnowledgeEntry.fromRecord(
      makeEntryRecord({ claimKind: 'fact', claimText: 'f'.repeat(1000) }),
    );
    const observed = KnowledgeEntry.fromRecord(
      makeEntryRecord({ claimKind: 'observed', claimText: 'o'.repeat(1000) }),
    );
    expect(fact.getClaimKind()).toBe('fact');
    expect(observed.getClaimKind()).toBe('observed');
  });

  it('keeps the attribution and the keeper path of a failed claim', () => {
    const record = makeEntryRecord({ claimKind: 'failed', claimText: 'x'.repeat(300) });
    const entry = KnowledgeEntry.fromRecord(record);

    // Attribution survives the round-trip unchanged.
    expect(entry.toRecord()).toEqual(record);
    expect(entry.toRecord().sourceAttemptId).toBe('attempt-1');
    expect(entry.toRecord().sourceCommitSha).toBe('abc1234');
    expect(entry.toRecord().checkerId).toBeNull();

    // An unverified failed claim cannot become accepted.
    expect(() =>
      entry.decideDisposition({
        disposition: 'accepted',
        checkerId: 'orchestrator-1',
        reason: 'looks right',
        nowIso: '2026-10-15T03:00:00.000Z',
      }),
    ).toThrow(/unverified claim cannot become accepted/);

    // A supported check moves the unverified failed claim to supported…
    entry.applyCheck({
      id: 'check-1',
      entryId: record.id,
      checkerId: 'orchestrator-1',
      procedureName: 'yarn typecheck',
      verification: 'supported',
      evidenceRef: 'evidence/typecheck.log',
      checkedAtIso: '2026-10-15T02:00:00.000Z',
    });
    expect(entry.getVerification()).toBe('supported');
    expect(entry.getChecks()).toHaveLength(1);

    // …and with a checker identity it becomes a retrievable keeper.
    const decided = entry.decideDisposition({
      disposition: 'accepted',
      checkerId: 'orchestrator-1',
      reason: 'tried and disproved by the check run',
      nowIso: '2026-10-15T03:00:00.000Z',
    });
    expect(KnowledgeEntry.fromRecord(decided).isRetrievableKeeper()).toBe(true);
  });
});
