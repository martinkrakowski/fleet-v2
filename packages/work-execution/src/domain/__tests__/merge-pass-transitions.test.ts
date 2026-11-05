// DT9c: pure builders and the compare-and-set decision of the merge pass.
import { describe, expect, it } from 'vitest';

import {
  MERGE_NOTIFICATION_EVENTS,
  buildDroppedEntry,
  buildMergedEntry,
  buildParkedEntry,
  buildReadyEntry,
  buildSupersession,
  buildVetoEntry,
  decideMergeTransition,
  dropNotificationEvent,
  mergeNotificationKey,
  parkNotificationEvent,
  sameMergeEntryContent,
} from '../merge-pass-transitions.js';
import { MERGE_QUEUE_ENTRY_VERSION } from '../merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../merge-queue-records.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const HEAD_2 = '0123456789abcdef0123456789abcdef01234599';
const MERGE_OID = 'fedcba9876543210fedcba9876543210fedcba98';
const id = (n: number) => '01JD' + String(n).padStart(22, '0');

function entry(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return {
    version: MERGE_QUEUE_ENTRY_VERSION, entryId: id(1), repository: { owner: 'fleet', repo: 'v2' },
    repoDigest: '0123456789ab', pullRequest: 1, headOid: HEAD, state: 'queued', reason: null, attempt: 0,
    notBeforeIso: null, enqueuedAtIso: '2026-11-01T10:00:00.000Z', enqueuedBy: 'conductor', supersedes: null,
    runId: null, attemptId: null, workOrderId: null, tier: 2, verifiedHeadOid: null, verifiedBy: null,
    policyRevision: null, premergeReceiptHeadOid: null, veto: null, mergeCommitOid: null, mergedAtIso: null,
    revision: 1, ...overrides,
  };
}

const audit = { verifiedHeadOid: HEAD, verifiedBy: 'contexts' as const, policyRevision: 'rev-1', premergeReceiptHeadOid: HEAD };

describe('merge-pass builders', () => {
  it('buildReadyEntry records every verification audit field and bumps the revision', () => {
    const built = buildReadyEntry(entry(), audit);
    expect(built).toMatchObject({
      ok: true,
      record: { state: 'ready', verifiedHeadOid: HEAD, verifiedBy: 'contexts', policyRevision: 'rev-1', premergeReceiptHeadOid: HEAD, revision: 2 },
    });
  });

  it('buildReadyEntry keeps an earlier premerge receipt head when none is given', () => {
    const built = buildReadyEntry(entry({ premergeReceiptHeadOid: HEAD_2 }), { ...audit, premergeReceiptHeadOid: null });
    expect(built.ok && built.record.premergeReceiptHeadOid).toBe(HEAD_2);
  });

  it('refuses hostile input without throwing', () => {
    const throwing = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
    for (const bad of [null, undefined, 7, 'x', [], throwing, entry({ state: 'merged', mergeCommitOid: MERGE_OID, mergedAtIso: '2026-11-01T10:00:00.000Z' })]) {
      for (const result of [
        buildReadyEntry(bad, audit),
        buildParkedEntry(bad, { reason: 'checks', nextAttempt: 1, notBeforeIso: null }),
        buildDroppedEntry(bad, 'closed'),
        buildSupersession(bad, HEAD_2, id(2)),
        buildMergedEntry(bad, { mergeCommitOid: MERGE_OID, mergedAtIso: '2026-11-01T11:00:00.000Z' }),
        buildVetoEntry(bad, { outcome: 'merge-safe', confidence: 0.9, mode: 'shadow', decisionReceiptId: null }),
      ]) {
        expect(result.ok).toBe(false);
      }
    }
    expect(buildReadyEntry(entry(), { ...audit, verifiedHeadOid: 'nope' }).ok).toBe(false);
    expect(buildReadyEntry(entry(), { ...audit, policyRevision: 'sk-live-0123456789abcdef0123456789' }).ok).toBe(false);
    expect(buildParkedEntry(entry(), { reason: 'bogus' as never, nextAttempt: 1, notBeforeIso: null }).ok).toBe(false);
    expect(buildParkedEntry(entry(), { reason: 'checks', nextAttempt: 99, notBeforeIso: null }).ok).toBe(false);
    expect(buildDroppedEntry(entry(), 'bogus' as never).ok).toBe(false);
  });

  it('park and drop carry the reason, attempt and notBefore', () => {
    const parked = buildParkedEntry(entry(), { reason: 'checks', nextAttempt: 2, notBeforeIso: '2026-11-01T10:05:00.000Z' });
    expect(parked).toMatchObject({ ok: true, record: { state: 'parked', reason: 'checks', attempt: 2, notBeforeIso: '2026-11-01T10:05:00.000Z', revision: 2 } });
    expect(buildDroppedEntry(entry(), 'forge-error-exhausted')).toMatchObject({ ok: true, record: { state: 'dropped', reason: 'forge-error-exhausted' } });
  });

  it('buildSupersession inherits the position and links the successor', () => {
    const built = buildSupersession(entry({ runId: 'run-01JD00000000000000000000AA' }), HEAD_2, id(2));
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.predecessor).toMatchObject({ state: 'superseded', revision: 2 });
      expect(built.successor).toMatchObject({
        entryId: id(2), supersedes: id(1), headOid: HEAD_2, enqueuedBy: 'update',
        enqueuedAtIso: '2026-11-01T10:00:00.000Z', revision: 1,
      });
    }
    expect(buildSupersession(entry(), HEAD, id(2)).ok).toBe(false); // same head
    expect(buildSupersession(entry(), HEAD_2, 'not-a-ulid').ok).toBe(false);
  });

  it('buildMergedEntry carries every section 3.6 audit field and refuses an unaudited merge', () => {
    const ready = buildReadyEntry(entry(), audit);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    const withVeto = buildVetoEntry(ready.record, { outcome: 'merge-safe', confidence: 0.95, mode: 'shadow', decisionReceiptId: 'receipt-1' });
    expect(withVeto.ok).toBe(true);
    if (!withVeto.ok) return;
    const merged = buildMergedEntry(withVeto.record, { mergeCommitOid: MERGE_OID, mergedAtIso: '2026-11-01T11:00:00.000Z' });
    expect(merged).toMatchObject({
      ok: true,
      record: {
        state: 'merged', policyRevision: 'rev-1', verifiedHeadOid: HEAD, verifiedBy: 'contexts',
        premergeReceiptHeadOid: HEAD, mergeCommitOid: MERGE_OID, mergedAtIso: '2026-11-01T11:00:00.000Z',
        veto: { outcome: 'merge-safe', confidence: 0.95, mode: 'shadow', decisionReceiptId: 'receipt-1' },
      },
    });
    expect(buildMergedEntry(entry(), { mergeCommitOid: MERGE_OID, mergedAtIso: '2026-11-01T11:00:00.000Z' })).toEqual({ ok: false, reason: 'audit-incomplete' });
    expect(buildMergedEntry(withVeto.record, { mergeCommitOid: 'short', mergedAtIso: '2026-11-01T11:00:00.000Z' }).ok).toBe(false);
    expect(buildVetoEntry(entry(), { outcome: 'merge-safe', confidence: 9, mode: 'shadow', decisionReceiptId: null }).ok).toBe(false);
  });

  it('sameMergeEntryContent ignores only the revision', () => {
    expect(sameMergeEntryContent(entry(), entry({ revision: 5 }))).toBe(true);
    expect(sameMergeEntryContent(entry(), entry({ attempt: 1 }))).toBe(false);
  });

  it('notification vocabulary is fixed and keyed per (event, id)', () => {
    expect(MERGE_NOTIFICATION_EVENTS).toContain('forge-error-exhausted');
    expect(mergeNotificationKey('dropped', id(1))).toBe(`dropped:${id(1)}`);
    expect(dropNotificationEvent('forge-error-exhausted')).toBe('forge-error-exhausted');
    expect(dropNotificationEvent('closed')).toBe('dropped');
    expect(parkNotificationEvent('veto-hold')).toBe('veto-hold');
    expect(parkNotificationEvent('threads')).toBe('parked');
  });
});

describe('decideMergeTransition', () => {
  const stored = entry();
  const parked = (() => {
    const built = buildParkedEntry(stored, { reason: 'checks', nextAttempt: 1, notBeforeIso: null });
    if (!built.ok) throw new Error('fixture');
    return built.record;
  })();

  it('applies on the expected revision', () => {
    const decision = decideMergeTransition([stored], { entryId: id(1), expectedRevision: 1, next: parked, successor: null });
    expect(decision).toMatchObject({ outcome: 'applied', record: { state: 'parked', revision: 2 }, successor: null });
  });

  it('refuses a stale revision, an unknown entry and a terminal entry', () => {
    expect(decideMergeTransition([entry({ revision: 2 })], { entryId: id(1), expectedRevision: 1, next: parked, successor: null })).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    expect(decideMergeTransition([stored], { entryId: id(9), expectedRevision: 1, next: parked, successor: null })).toEqual({ outcome: 'refused', reason: 'unknown-entry' });
    const dropped = entry({ state: 'dropped', reason: 'closed' });
    expect(decideMergeTransition([dropped], { entryId: id(1), expectedRevision: 1, next: parked, successor: null })).toEqual({ outcome: 'refused', reason: 'terminal-entry' });
  });

  it('refuses a next record that changes identity or skips a revision', () => {
    expect(decideMergeTransition([stored], { entryId: id(1), expectedRevision: 1, next: { ...parked, headOid: HEAD_2 }, successor: null }).outcome).toBe('refused');
    expect(decideMergeTransition([stored], { entryId: id(1), expectedRevision: 1, next: { ...parked, revision: 3 }, successor: null }).outcome).toBe('refused');
    expect(decideMergeTransition([stored], { entryId: id(1), expectedRevision: 1, next: { junk: true } as never, successor: null }).outcome).toBe('refused');
    expect(decideMergeTransition(null as never, { entryId: id(1), expectedRevision: 1, next: parked, successor: null }).outcome).toBe('refused');
  });

  it('appends the successor with the superseded predecessor, once', () => {
    const built = buildSupersession(stored, HEAD_2, id(2));
    if (!built.ok) throw new Error('fixture');
    const command = { entryId: id(1), expectedRevision: 1, next: built.predecessor, successor: built.successor };
    const first = decideMergeTransition([stored], command);
    expect(first.outcome === 'applied' && first.entries).toHaveLength(2);

    // A live entry of the successor's identity already exists (a retry that minted a new id): not appended twice.
    const existing = entry({ entryId: id(7), headOid: HEAD_2, supersedes: id(1), enqueuedBy: 'update' });
    const replay = decideMergeTransition([stored, existing], command);
    expect(replay).toMatchObject({ outcome: 'applied', successor: { entryId: id(7) } });
    expect(replay.outcome === 'applied' && replay.entries).toHaveLength(2);

    // A successor needs a superseded predecessor and a matching link.
    expect(decideMergeTransition([stored], { ...command, next: parked }).outcome).toBe('refused');
    expect(decideMergeTransition([stored], { ...command, successor: { ...built.successor, supersedes: id(5) } }).outcome).toBe('refused');
    expect(decideMergeTransition([stored], { ...command, successor: null }).outcome).toBe('refused');
    expect(decideMergeTransition([stored, entry({ entryId: id(2), pullRequest: 4, headOid: HEAD_2 })], command).outcome).toBe('refused'); // id collision
  });
});
