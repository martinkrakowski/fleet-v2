// DT9c: pure builders and the compare-and-set decision of the merge pass.
import { describe, expect, it } from 'vitest';

import {
  MERGE_NOTIFICATION_EVENTS,
  buildDroppedEntry,
  buildMergedEntry,
  buildParkedEntry,
  buildReadyEntry,
  buildReleasedParkEntry,
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

    // An independently enqueued head is adopted and takes the earlier position and the link.
    const raced = entry({ entryId: id(8), headOid: HEAD_2, enqueuedAtIso: '2026-11-01T11:00:00.000Z', enqueuedBy: 'cli' });
    const adopted = decideMergeTransition([stored, raced], command);
    expect(adopted).toMatchObject({
      outcome: 'applied',
      successor: { entryId: id(8), enqueuedAtIso: '2026-11-01T10:00:00.000Z', supersedes: id(1), enqueuedBy: 'cli', revision: 2 },
    });
    expect(adopted.outcome === 'applied' && adopted.entries).toHaveLength(2);

    // The adopted entry inherits the predecessor's run links and the higher tier; a rival run is refused.
    const linked = entry({ runId: 'run-01JD00000000000000000000AA', tier: 1 });
    const linkedBuilt = buildSupersession(linked, HEAD_2, id(2));
    if (!linkedBuilt.ok) throw new Error('fixture');
    const linkedCommand = { entryId: id(1), expectedRevision: 1, next: linkedBuilt.predecessor, successor: linkedBuilt.successor };
    const inherit = decideMergeTransition([linked, raced], linkedCommand);
    expect(inherit).toMatchObject({ outcome: 'applied', successor: { entryId: id(8), runId: linked.runId, tier: 2 } });
    const rival = entry({ entryId: id(9), headOid: HEAD_2, runId: 'run-01JD00000000000000000000BB' });
    expect(decideMergeTransition([linked, rival], linkedCommand).outcome).toBe('refused');

    // A successor needs a superseded predecessor and a matching link.
    expect(decideMergeTransition([stored], { ...command, next: parked }).outcome).toBe('refused');
    expect(decideMergeTransition([stored], { ...command, successor: { ...built.successor, supersedes: id(5) } }).outcome).toBe('refused');
    expect(decideMergeTransition([stored], { ...command, successor: null }).outcome).toBe('refused');
    // A successor must inherit the position, origin and run links of its predecessor.
    for (const wrong of [
      { enqueuedAtIso: '2026-11-01T12:00:00.000Z' },
      { enqueuedBy: 'cli' as const },
      { runId: 'run-01JD00000000000000000000AA' },
      { tier: 0 as const },
    ]) {
      const bad = decideMergeTransition([stored], { ...command, successor: { ...built.successor, ...wrong } });
      expect(bad).toEqual({ outcome: 'refused', reason: 'invalid-successor' });
    }
    expect(decideMergeTransition([stored, entry({ entryId: id(2), pullRequest: 4, headOid: HEAD_2 })], command).outcome).toBe('refused'); // id collision
  });
});

// SW2a1: the shadow-park release transition (SH24a). At `cutover switch` an
// ordinary parked entry goes back to `queued`; a `veto-hold` never persists
// under shadow and is never released.

function parked(overrides: Partial<MergeQueueEntryRecord> = {}): MergeQueueEntryRecord {
  return entry({ state: 'parked', reason: 'checks', attempt: 2, notBeforeIso: '2026-11-05T12:00:00.000Z', ...overrides });
}

/** A transparent proxy whose `get` trap is counted and never expected to run. */
function getCounterProxy(target: MergeQueueEntryRecord): { value: unknown; gets: () => number } {
  let count = 0;
  const proxied = new Proxy(target, {
    get(t, key, recv) {
      count += 1;
      return Reflect.get(t, key, recv);
    },
  });
  return { value: proxied, gets: () => count };
}

/** `base` plus the polluting own keys `__proto__`, `constructor` and `prototype` (via JSON.parse). */
function withPollutingKeys(base: MergeQueueEntryRecord): unknown {
  const inner = JSON.stringify(base).slice(1, -1);
  return JSON.parse(`{"__proto__":{},"constructor":1,"prototype":1,${inner}}`);
}

describe('buildReleasedParkEntry', () => {
  it('releases a parked entry to queued, keeping attempt and clearing reason and notBefore', () => {
    const built = buildReleasedParkEntry(parked());
    expect(built).toMatchObject({
      ok: true,
      record: {
        state: 'queued',
        reason: null,
        notBeforeIso: null,
        attempt: 2,
        entryId: parked().entryId,
        headOid: HEAD,
        revision: 2,
      },
    });
  });

  it('refuses a terminal entry as terminal-entry', () => {
    expect(
      buildReleasedParkEntry(parked({ state: 'merged', mergeCommitOid: MERGE_OID, mergedAtIso: '2026-11-01T10:00:00.000Z' })),
    ).toEqual({ ok: false, reason: 'terminal-entry' });
    expect(buildReleasedParkEntry(parked({ state: 'dropped', reason: 'closed' }))).toEqual({
      ok: false,
      reason: 'terminal-entry',
    });
    expect(buildReleasedParkEntry(parked({ state: 'superseded', reason: null, notBeforeIso: null }))).toEqual({
      ok: false,
      reason: 'terminal-entry',
    });
  });

  it('refuses a non-parked entry or a veto-hold park as invalid-input', () => {
    expect(buildReleasedParkEntry(entry())).toEqual({ ok: false, reason: 'invalid-input' });
    expect(buildReleasedParkEntry(entry({ state: 'ready' }))).toEqual({ ok: false, reason: 'invalid-input' });
    expect(buildReleasedParkEntry(parked({ reason: 'veto-hold' }))).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses malformed records as invalid-entry without throwing', () => {
    const sparse: unknown[] = [];
    sparse[3] = 'x';
    for (const bad of [
      null,
      undefined,
      7,
      'x',
      true,
      { not: 'an entry' },
      sparse,
      { length: 1, 0: 'x' },
      { length: 2 ** 32 - 1, 0: 'x' },
      new Array(2 ** 32 - 1),
      withPollutingKeys(parked()),
    ]) {
      expect(buildReleasedParkEntry(bad)).toEqual({ ok: false, reason: 'invalid-entry' });
    }
  });

  it('refuses a getter on the entry as invalid-entry without ever running it', () => {
    // The descriptor walk reads the accessor's own descriptor and refuses it
    // from there; the structured-clone probe runs only after the entry is
    // proved plain and bounded, so the getter is never invoked at all.
    let count = 0;
    const target = parked();
    const copy = { ...target };
    Object.defineProperty(copy, 'state', {
      enumerable: true,
      get() {
        count += 1;
        return target.state;
      },
    });
    expect(buildReleasedParkEntry(copy)).toEqual({ ok: false, reason: 'invalid-entry' });
    expect(count).toBe(0);
  });

  it('refuses a non-enumerable getter on the entry without running it as invalid-entry', () => {
    // A non-enumerable accessor is refused by the descriptor walk (the key
    // must be an enumerable data property), so the getter is never run.
    let count = 0;
    const target = parked();
    const copy = { ...target };
    Object.defineProperty(copy, 'state', {
      enumerable: false,
      get() {
        count += 1;
        return target.state;
      },
    });
    expect(buildReleasedParkEntry(copy)).toEqual({ ok: false, reason: 'invalid-entry' });
    expect(count).toBe(0);
  });

  it('refuses a proxy entry with no get trap run as invalid-entry', () => {
    const proxied = getCounterProxy(parked());
    expect(buildReleasedParkEntry(proxied.value)).toEqual({ ok: false, reason: 'invalid-entry' });
    expect(proxied.gets()).toBe(0);
  });

  it('refuses a recording Proxy as invalid-entry, asserting only that its get trap never ran', () => {
    // The shape/descriptor validation runs first; the structured-clone probe
    // then refuses the Proxy (full trap-free refusal arrives with the shared
    // snapshotPlainData (PX1) adoption) — the assertions below check exactly
    // that no `get` trap ran, so no value can be read through the Proxy.
    const calls: string[] = [];
    const traps = [
      'apply', 'construct', 'defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'getPrototypeOf',
      'has', 'isExtensible', 'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf',
    ];
    const handler: Record<string, (...args: unknown[]) => unknown> = {};
    for (const trap of traps) {
      handler[trap] = (...args: unknown[]) => {
        calls.push(trap);
        return (Reflect as unknown as Record<string, (...args: unknown[]) => unknown>)[trap](...args);
      };
    }
    const proxied = new Proxy(parked() as unknown as object, handler as ProxyHandler<object>);
    expect(buildReleasedParkEntry(proxied)).toEqual({ ok: false, reason: 'invalid-entry' });
    expect(calls).not.toContain('get');
  });

  it('returns the typed refusal, never a throw, for a throwing-trap Proxy and a revoked Proxy', () => {
    const throwingHandler: Record<string, () => never> = {};
    for (const trap of [
      'apply', 'construct', 'defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'getPrototypeOf',
      'has', 'isExtensible', 'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf',
    ]) {
      throwingHandler[trap] = () => {
        throw new Error('trap');
      };
    }
    for (const hostile of [
      new Proxy(parked() as unknown as object, throwingHandler as ProxyHandler<object>),
      (() => {
        const { proxy, revoke } = Proxy.revocable(parked() as unknown as object, {});
        revoke();
        return proxy;
      })(),
    ]) {
      expect(buildReleasedParkEntry(hostile)).toEqual({ ok: false, reason: 'invalid-entry' });
    }
  });

  it('a constant verdict or an identity echo would fail: invalid refused, valid shaped', () => {
    // A constant `{ ok: true }` verdict fails the refused assertions.
    expect(buildReleasedParkEntry(parked({ reason: 'veto-hold' })).ok).toBe(false);
    expect(buildReleasedParkEntry(null).ok).toBe(false);
    // An identity echo (returning the entry) fails the shaped-success assertions.
    expect(buildReleasedParkEntry(parked())).not.toEqual(parked());
    expect(buildReleasedParkEntry(parked()).ok).toBe(true);
  });
});
