import { describe, expect, it } from 'vitest';

import {
  DAEMON_EVENT_KEYS,
  DAEMON_EVENT_PROJECTION_VERSION,
  DAEMON_STATUS_EVENT_JOB_ID,
  eventsAfterCursor,
  isValidDaemonEventKey,
  projectJobOutcomeToDaemonEvent,
  projectJournalEntryToDaemonEvent,
  readDaemonEventLine,
  readDaemonEventRecord,
  serializeDaemonEventHeader,
  serializeDaemonEventLine,
} from '../daemon-events.js';
import { mergePassJobId } from '../daemon-tick.js';
import type { DaemonEventRead } from '../daemon-events.js';

const NOW = '2026-10-31T12:00:00.000Z';
const SHIFTED = '2026-10-31T14:00:00.000+02:00';
const EVENT_A = `0${'1'.repeat(25)}`;
const EVENT_B = `1${'2'.repeat(25)}`;
const EVENT_C = `2${'3'.repeat(25)}`;
const TICK = `tick-${EVENT_A}`;
const DIGEST = '0123456789ab';
const ONE_WAY_KEY = `merge/${DIGEST}/42/${DIGEST}/merge-pr`;
const REQUEST_KEY = `request/${EVENT_A}`;
const JOB_MERGE = mergePassJobId(DIGEST) as string;
const QUEUE_ENTRY_ID = EVENT_B;

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

/** Reads a failure reason without narrowing boilerplate in every assertion. */
function reasonOf(read: DaemonEventRead): string {
  return read.ok ? '(ok)' : read.reason;
}

/** A valid v1 event body; overrides win. */
function recordBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: DAEMON_EVENT_PROJECTION_VERSION,
    eventId: EVENT_A,
    tickId: TICK,
    jobId: 'notifier',
    kind: 'intent',
    key: ONE_WAY_KEY,
    entryId: null,
    outcome: null,
    reasonCode: null,
    recordedAtIso: NOW,
    ...overrides,
  };
}

function intentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return recordBody({ kind: 'intent', key: ONE_WAY_KEY, entryId: null, outcome: null, reasonCode: null, ...overrides });
}

function resultBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return recordBody({ kind: 'result', key: ONE_WAY_KEY, entryId: null, outcome: 'completed', reasonCode: null, ...overrides });
}

function jobBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return recordBody({ kind: 'job', jobId: 'replan-digest', key: null, entryId: null, outcome: 'completed', reasonCode: null, ...overrides });
}

function queueBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return recordBody({ kind: 'queue', jobId: JOB_MERGE, key: null, entryId: QUEUE_ENTRY_ID, outcome: 'merged', reasonCode: null, ...overrides });
}

function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return recordBody({ kind: 'status', jobId: DAEMON_STATUS_EVENT_JOB_ID, key: null, entryId: null, outcome: 'paused', reasonCode: null, ...overrides });
}

describe('daemon event header and exact 10-field records', () => {
  it('serializes and reads the v1 header', () => {
    expect(serializeDaemonEventHeader()).toBe('{"version":1}');
    expect(readDaemonEventLine('{"version":1}')).toMatchObject({
      ok: true,
      lineKind: 'header',
      header: { version: 1 },
    });
    expect(readDaemonEventLine('{"version":2}')).toEqual({
      ok: false,
      reason: 'unknown-version',
      error: 'DaemonEventHeader version is not supported',
    });
  });

  it('reads and round-trips one valid line for every kind', () => {
    const cases: Record<string, Record<string, unknown>> = {
      intent: intentBody(),
      result: resultBody(),
      job: jobBody(),
      queue: queueBody(),
      status: statusBody(),
    };
    for (const [kind, body] of Object.entries(cases)) {
      const read = readDaemonEventRecord(body);
      expect(read.ok, kind).toBe(true);
      if (!read.ok) {
        continue;
      }
      expect(read.record.kind).toBe(kind);
      const line = serializeDaemonEventLine(read.record);
      expect(typeof line).toBe('string');
      expect(readDaemonEventLine(line as string)).toMatchObject({
        ok: true,
        lineKind: 'event',
        record: { kind },
      });
    }
  });

  it('accepts status job ids and rejects unknown ones', () => {
    expect(readDaemonEventRecord(statusBody()).ok).toBe(true);
    expect(readDaemonEventRecord(statusBody({ jobId: 'notifier' })).ok).toBe(true);
    expect(reasonOf(readDaemonEventRecord(statusBody({ jobId: 'other' })))).toBe('malformed');
  });

  it('requires a merge-pass job id and an entry id on queue events', () => {
    expect(readDaemonEventRecord(queueBody()).ok).toBe(true);
    expect(reasonOf(readDaemonEventRecord(queueBody({ outcome: 'completed' })))).toBe('malformed');
    expect(reasonOf(readDaemonEventRecord(queueBody({ jobId: 'notifier' })))).toBe('malformed');
    expect(reasonOf(readDaemonEventRecord(queueBody({ entryId: null })))).toBe('malformed');
  });

  it('refuses extra keys, alias keys, a missing key and bad versions', () => {
    expect(reasonOf(readDaemonEventRecord({ ...intentBody(), title: 'x' }))).toBe('malformed');
    expect(reasonOf(readDaemonEventRecord({ ...intentBody(), worktreePath: '/tmp/x' }))).toBe('malformed');
    expect(reasonOf(readDaemonEventRecord({ ...intentBody(), schemaVersion: 1 }))).toBe('malformed');
    expect(reasonOf(readDaemonEventRecord({ ...intentBody(), schemaVersion: 1, version: 2 }))).toBe('malformed');
    const withoutReason = intentBody();
    delete withoutReason.reasonCode;
    expect(reasonOf(readDaemonEventRecord(withoutReason))).toBe('malformed');
    expect(reasonOf(readDaemonEventRecord({ ...intentBody(), version: 2 }))).toBe('unknown-version');
    expect(reasonOf(readDaemonEventRecord({ ...intentBody(), version: 2, title: 'x' }))).toBe('malformed');
  });

  it('serializes keys in the pinned order', () => {
    const record = readDaemonEventRecord(intentBody());
    if (!record.ok) {
      throw new Error('fixture');
    }
    const line = serializeDaemonEventLine(record.record);
    expect(line).not.toBeNull();
    expect(Object.keys(JSON.parse(line as string))).toEqual([...DAEMON_EVENT_KEYS]);
  });

  it('handles invalid JSON lines without echoing input', () => {
    expect(readDaemonEventLine('')).toEqual({
      ok: false,
      reason: 'malformed',
      error: 'DaemonEvent line is not JSON',
    });
    expect(readDaemonEventLine('{oops')).toEqual({
      ok: false,
      reason: 'malformed',
      error: 'DaemonEvent line is not JSON',
    });
    const arrayLine = readDaemonEventLine('[]');
    expect(arrayLine.ok).toBe(false);
    if (!arrayLine.ok) {
      expect(arrayLine.reason).toBe('malformed');
      expect(arrayLine.error).not.toContain('[]');
    }
  });
});

describe('merge keys, code and secret rules', () => {
  it('accepts valid event keys', () => {
    const base = `merge/${DIGEST}/42/${DIGEST}`;
    expect(isValidDaemonEventKey(ONE_WAY_KEY)).toBe(true);
    expect(isValidDaemonEventKey(`${base}/update-branch`)).toBe(true);
    expect(isValidDaemonEventKey(`${base}/post-status`)).toBe(true);
    expect(isValidDaemonEventKey(`${base}/merge-pr/r1`)).toBe(true);
    expect(isValidDaemonEventKey(`${base}/merge-pr/r9`)).toBe(true);
    expect(isValidDaemonEventKey(`${base}/veto/a1`)).toBe(true);
    expect(isValidDaemonEventKey(`${base}/veto/a32`)).toBe(true);
    expect(isValidDaemonEventKey(`${base}/macos-verify/a10`)).toBe(true);
    expect(isValidDaemonEventKey(REQUEST_KEY)).toBe(true);
  });

  it('rejects out-of-range retries, attempts and secret shapes', () => {
    const base = `merge/${DIGEST}/42/${DIGEST}`;
    expect(isValidDaemonEventKey(`${base}/merge-pr/r0`)).toBe(false);
    expect(isValidDaemonEventKey(`${base}/merge-pr/r10`)).toBe(false);
    expect(isValidDaemonEventKey(`${base}/veto/a33`)).toBe(false);
    expect(isValidDaemonEventKey(`${base}/veto`)).toBe(false);
    expect(isValidDaemonEventKey(`${base}/macos-verify`)).toBe(false);
    expect(isValidDaemonEventKey(`${base}/merge-pr/a1`)).toBe(false);
    expect(isValidDaemonEventKey('x'.repeat(257))).toBe(false);
    expect(isValidDaemonEventKey(fakeSecretShape())).toBe(false);
  });

  it('rejects invalid result reason codes', () => {
    expect(reasonOf(readDaemonEventRecord(resultBody({ reasonCode: 'not a code' })))).toBe('malformed');
  });

  it('normalizes zoned instants and refuses impossible calendar dates', () => {
    const shifted = readDaemonEventRecord(intentBody({ recordedAtIso: SHIFTED }));
    expect(shifted.ok).toBe(true);
    if (shifted.ok) {
      expect(shifted.record.recordedAtIso).toBe(NOW);
    }
    expect(reasonOf(readDaemonEventRecord(intentBody({ recordedAtIso: '2026-02-31T00:00:00.000Z' })))).toBe('malformed');
  });

  it('never runs getters and never echoes hostile input', () => {
    const throwingGetter = {
      ...intentBody(),
      get recordedAtIso() {
        throw new Error('boom');
      },
    };
    const sentinelGetter = {
      ...intentBody(),
      get recordedAtIso() {
        return 'getter-sentinel-value';
      },
    };
    expect(readDaemonEventRecord(throwingGetter)).toEqual({
      ok: false,
      reason: 'malformed',
      error: 'DaemonEvent is malformed',
    });
    expect(readDaemonEventRecord(sentinelGetter)).toEqual({
      ok: false,
      reason: 'malformed',
      error: 'DaemonEvent is malformed',
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownkeys');
        },
      },
    );
    expect(readDaemonEventRecord(proxy)).toEqual({
      ok: false,
      reason: 'malformed',
      error: 'DaemonEvent is malformed',
    });
  });
});

describe('builders and cursor', () => {
  it('rejects conduct entries and projects intent entries', () => {
    const conduct = projectJournalEntryToDaemonEvent({
      eventId: EVENT_A,
      tickId: TICK,
      jobId: 'notifier',
      journalEntry: { kind: 'conduct', key: null, outcome: null, reasonCode: null, recordedAtIso: NOW },
    });
    expect(conduct).toEqual({ ok: false, reason: 'malformed', error: 'DaemonEvent is malformed' });

    const intent = projectJournalEntryToDaemonEvent({
      eventId: EVENT_A,
      tickId: TICK,
      jobId: 'notifier',
      journalEntry: { kind: 'intent', key: ONE_WAY_KEY, outcome: null, reasonCode: null, recordedAtIso: NOW },
    });
    expect(intent.ok).toBe(true);
    if (intent.ok) {
      expect(intent.record.kind).toBe('intent');
      expect(intent.record.outcome).toBeNull();
      expect(intent.record.reasonCode).toBeNull();
      expect(intent.record.key).toBe(ONE_WAY_KEY);
    }
  });

  it('projects result entries with their outcome', () => {
    const result = projectJournalEntryToDaemonEvent({
      eventId: EVENT_A,
      tickId: TICK,
      jobId: 'notifier',
      journalEntry: { kind: 'result', key: ONE_WAY_KEY, outcome: 'completed', reasonCode: null, recordedAtIso: NOW },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.kind).toBe('result');
      expect(result.record.outcome).toBe('completed');
    }
  });

  it('projects job outcomes into job lines', () => {
    const skipped = projectJobOutcomeToDaemonEvent({
      eventId: EVENT_A,
      tickId: TICK,
      jobId: 'notifier',
      jobOutcome: { outcome: 'skipped', reasonCode: 'lease-held' },
      recordedAtIso: NOW,
    });
    expect(skipped.ok).toBe(true);
    if (skipped.ok) {
      expect(skipped.record.kind).toBe('job');
      expect(skipped.record.reasonCode).toBe('lease-held');
    }

    const exhausted = projectJobOutcomeToDaemonEvent({
      eventId: EVENT_A,
      tickId: TICK,
      jobId: 'notifier',
      jobOutcome: { outcome: 'budget-exhausted', progressed: false },
      recordedAtIso: NOW,
    });
    expect(exhausted.ok).toBe(true);
    if (exhausted.ok) {
      expect(exhausted.record.outcome).toBe('budget-exhausted');
      expect(exhausted.record.reasonCode).toBeNull();
    }

    const refused = projectJobOutcomeToDaemonEvent({
      eventId: EVENT_A,
      tickId: TICK,
      jobId: 'notifier',
      jobOutcome: { outcome: 'refused', reasonCode: '' },
      recordedAtIso: NOW,
    });
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toBe('malformed');
  });

  it('slices events after a cursor without mutating the input', () => {
    const a = readDaemonEventRecord(intentBody({ eventId: EVENT_A }));
    const b = readDaemonEventRecord(intentBody({ eventId: EVENT_B }));
    const c = readDaemonEventRecord(intentBody({ eventId: EVENT_C }));
    if (!a.ok || !b.ok || !c.ok) {
      throw new Error('fixture');
    }
    const records = [a.record, b.record, c.record];

    const all = eventsAfterCursor(records, null);
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.events.map((event) => event.eventId)).toEqual([EVENT_A, EVENT_B, EVENT_C]);
      expect(all.nextCursor).toBe(EVENT_C);
    }

    const afterA = eventsAfterCursor(records, EVENT_A);
    expect(afterA.ok).toBe(true);
    if (afterA.ok) {
      expect(afterA.events.map((event) => event.eventId)).toEqual([EVENT_B, EVENT_C]);
      expect(afterA.nextCursor).toBe(EVENT_C);
    }

    const afterC = eventsAfterCursor(records, EVENT_C);
    expect(afterC.ok).toBe(true);
    if (afterC.ok) {
      expect(afterC.events).toEqual([]);
      expect(afterC.nextCursor).toBe(EVENT_C);
    }

    const absent = `0${'9'.repeat(25)}`;
    expect(eventsAfterCursor(records, absent)).toEqual({ ok: false, reason: 'cursor-not-found' });
    expect(eventsAfterCursor(records, 'not-a-ulid')).toEqual({ ok: false, reason: 'invalid-cursor' });
    expect(records).toHaveLength(3);
  });
});
