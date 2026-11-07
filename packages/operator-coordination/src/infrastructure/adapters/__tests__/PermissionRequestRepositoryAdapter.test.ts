/**
 * Lane T2c unit tests for the in-process memory PermissionRequestRepositoryAdapter:
 * it holds pending requests and their first verdict, never overwrites a
 * decided request, prunes the oldest decided records when the total cap is
 * reached, and lists pending requests only.
 */

import { describe, expect, it } from 'vitest';

import { PermissionRequestRepositoryAdapter } from '../PermissionRequestRepositoryAdapter.adapter.js';
import type { PermissionRequestRecord } from '../../../domain/entities/PermissionRequest.js';

const NOW_ISO = '2026-11-07T12:00:00.000Z';
const FUTURE_ISO = '2099-01-01T00:00:00.000Z';

function pendingRecord(overrides: Partial<PermissionRequestRecord> = {}): PermissionRequestRecord {
  return {
    requestId: 'req-1',
    threadId: 'thread-1',
    toolName: 'bash',
    toolInput: {},
    requestedAtIso: NOW_ISO,
    deadlineAtIso: FUTURE_ISO,
    state: 'pending',
    ...overrides,
  };
}

describe('PermissionRequestRepositoryAdapter', () => {
  it('holds a pending request and its first verdict; a decided request is never overwritten', () => {
    const adapter = new PermissionRequestRepositoryAdapter();

    expect(adapter.record(pendingRecord())).toEqual({ stored: true });
    expect(adapter.find('req-1')).toEqual(pendingRecord());
    expect(adapter.listPending()).toEqual([pendingRecord()]);
    expect(adapter.find('no-such')).toBeUndefined();

    expect(
      adapter.recordVerdict('req-1', { decision: 'allow', actorId: 'actor-a', decidedAtIso: NOW_ISO }),
    ).toEqual({ outcome: 'recorded' });
    expect(
      adapter.recordVerdict('req-1', { decision: 'allow', actorId: 'actor-b', decidedAtIso: NOW_ISO }),
    ).toEqual({ outcome: 'unchanged' });
    expect(
      adapter.recordVerdict('req-1', { decision: 'deny', actorId: 'actor-c', decidedAtIso: NOW_ISO }),
    ).toEqual({ outcome: 'conflict' });

    const stored = adapter.find('req-1');
    expect(stored?.state).toBe('decided');
    expect(stored?.verdict).toEqual({ decision: 'allow', actorId: 'actor-a', decidedAtIso: NOW_ISO });
    expect(adapter.listPending()).toEqual([]);

    // A decided request is never overwritten by a new pending record with the same id.
    expect(adapter.record(pendingRecord({ requestId: 'req-1' }))).toEqual({ stored: false });
    expect(adapter.find('req-1')?.verdict).toEqual({
      decision: 'allow',
      actorId: 'actor-a',
      decidedAtIso: NOW_ISO,
    });
  });

  it('prunes the oldest decided records before refusing a new request', () => {
    const adapter = new PermissionRequestRepositoryAdapter();

    // 100 pending records plus 412 decided records = 512 total (the cap).
    for (let i = 0; i < 100; i += 1) {
      expect(adapter.record(pendingRecord({ requestId: `pending-${i}` })).stored).toBe(true);
    }
    for (let i = 0; i < 412; i += 1) {
      const id = `decided-${i}`;
      expect(adapter.record(pendingRecord({ requestId: id })).stored).toBe(true);
      adapter.recordVerdict(id, { decision: 'allow', actorId: 'actor-a', decidedAtIso: NOW_ISO });
    }
    expect(adapter.listPending()).toHaveLength(100);
    expect(adapter.find('decided-0')).toBeDefined();

    // At the total cap: drop the oldest decided record, then store the new request.
    expect(adapter.record(pendingRecord({ requestId: 'new-1' }))).toEqual({ stored: true });
    expect(adapter.find('decided-0')).toBeUndefined();
    expect(adapter.find('decided-1')).toBeDefined();
    expect(adapter.find('pending-0')).toBeDefined();
    expect(adapter.find('new-1')).toBeDefined();
    expect(adapter.listPending()).toHaveLength(101);
  });

  it('lists the pending requests only', () => {
    const adapter = new PermissionRequestRepositoryAdapter();
    adapter.record(pendingRecord({ requestId: 'pending-a' }));
    adapter.record(pendingRecord({ requestId: 'pending-b' }));
    adapter.record(pendingRecord({ requestId: 'decided-a' }));
    adapter.recordVerdict('decided-a', {
      decision: 'allow',
      actorId: 'actor-a',
      decidedAtIso: NOW_ISO,
    });

    expect(adapter.listPending().map((record) => record.requestId)).toEqual(['pending-a', 'pending-b']);
    expect(adapter.listPending().every((record) => record.verdict === undefined)).toBe(true);
  });

  it('F1b: 128 timed-out requests do not block request 129', () => {
    const adapter = new PermissionRequestRepositoryAdapter();
    for (let i = 0; i < 128; i += 1) {
      const id = `req-${i}`;
      expect(adapter.record(pendingRecord({ requestId: id })).stored).toBe(true);
      expect(adapter.expire(id, 'timed-out', NOW_ISO)).toEqual({ outcome: 'expired' });
    }
    expect(adapter.listPending()).toHaveLength(0);
    expect(adapter.record(pendingRecord({ requestId: 'req-129' }))).toEqual({ stored: true });
    expect(adapter.listPending()).toHaveLength(1);
    expect(adapter.find('req-129')).toBeDefined();
  });

  it('expiring an already-decided request is a no-op', () => {
    const adapter = new PermissionRequestRepositoryAdapter();
    adapter.record(pendingRecord({ requestId: 'req-decided' }));
    adapter.recordVerdict('req-decided', {
      decision: 'allow',
      actorId: 'owner',
      decidedAtIso: NOW_ISO,
    });
    expect(adapter.expire('req-decided', 'timed-out', NOW_ISO)).toEqual({ outcome: 'noop' });
    const stored = adapter.find('req-decided');
    expect(stored?.state).toBe('decided');
    expect(stored?.verdict?.decision).toBe('allow');
  });

  it('a verdict on an expired request gives expired', () => {
    const adapter = new PermissionRequestRepositoryAdapter();
    adapter.record(pendingRecord({ requestId: 'req-expired' }));
    adapter.expire('req-expired', 'timed-out', NOW_ISO);
    expect(
      adapter.recordVerdict('req-expired', {
        decision: 'allow',
        actorId: 'owner',
        decidedAtIso: NOW_ISO,
      }),
    ).toEqual({ outcome: 'expired' });
  });

  it('does not list expired or deadline-passed requests in listPending', () => {
    const nowMs = 1_000_000;
    const adapter = new PermissionRequestRepositoryAdapter({ now: () => nowMs });
    adapter.record(
      pendingRecord({
        requestId: 'req-past',
        deadlineAtIso: new Date(nowMs - 1000).toISOString(),
      }),
    );
    adapter.record(
      pendingRecord({
        requestId: 'req-future',
        deadlineAtIso: new Date(nowMs + 10000).toISOString(),
      }),
    );
    expect(adapter.listPending().map((r) => r.requestId)).toEqual(['req-future']);
  });
});
