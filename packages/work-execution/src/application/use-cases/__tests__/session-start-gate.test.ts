// SessionStartSpacing tests — KF-34a1.
/**
 * The pass's one start gate: every lane session start (a dispatch, a seat
 * pivot, a fix round, a review) is spaced at least the stagger from the last
 * start, seeded from the journal. Pure; only the passed times matter, so no
 * real timers and no wall-clock assertions.
 */

import { describe, expect, it } from 'vitest';

import { SessionStartSpacing } from '../advance-lane-run/session-start-gate.js';

const NOW = '2026-10-27T10:00:00.000Z';

function at(ms: number): string {
  return new Date(Date.parse(NOW) + ms).toISOString();
}

describe('SessionStartSpacing', () => {
  it('the first start is granted', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStart('run-a', NOW)).toEqual({ ok: true });
  });

  it('a second run 5 s later gets retryAfterMs 15 000 and is granted at +20 s', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStart('run-a', NOW)).toEqual({ ok: true });
    const denied = gate.tryStart('run-b', at(5_000));
    expect(denied).toEqual({ ok: false, retryAfterMs: 15_000 });
    expect(gate.tryStart('run-b', at(20_000))).toEqual({ ok: true });
  });

  it('three runs get reservations at +20 s and +40 s in arrival order', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStart('run-a', NOW)).toEqual({ ok: true });
    expect(gate.tryStart('run-b', NOW)).toEqual({ ok: false, retryAfterMs: 20_000 });
    expect(gate.tryStart('run-c', NOW)).toEqual({ ok: false, retryAfterMs: 40_000 });
    expect(gate.tryStart('run-b', at(20_000))).toEqual({ ok: true });
    expect(gate.tryStart('run-c', at(20_000))).toEqual({ ok: false, retryAfterMs: 20_000 });
    expect(gate.tryStart('run-c', at(40_000))).toEqual({ ok: true });
  });

  it('a run holding a reservation is granted exactly once, never re-reserved early', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStart('run-a', NOW)).toEqual({ ok: true });
    expect(gate.tryStart('run-b', NOW)).toEqual({ ok: false, retryAfterMs: 20_000 });
    // Further tries before the slot answer the same turn; the reservation is
    // not extended or replaced.
    expect(gate.tryStart('run-b', at(5_000))).toEqual({ ok: false, retryAfterMs: 15_000 });
    expect(gate.tryStart('run-b', at(10_000))).toEqual({ ok: false, retryAfterMs: 10_000 });
    expect(gate.tryStart('run-b', at(20_000))).toEqual({ ok: true });
    // The reservation is spent; a further start is spaced again.
    expect(gate.tryStart('run-b', at(20_000))).toEqual({ ok: false, retryAfterMs: 20_000 });
  });

  it('a seeded last start 5 s ago makes the first start wait 15 000', () => {
    const gate = new SessionStartSpacing(20_000, at(-5_000));
    expect(gate.tryStart('run-a', NOW)).toEqual({ ok: false, retryAfterMs: 15_000 });
    expect(gate.tryStart('run-a', at(15_000))).toEqual({ ok: true });
  });

  it('pendingMs with no reservation returns 0', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.pendingMs('run-a', NOW)).toBe(0);
    expect(gate.tryStart('run-a', NOW)).toEqual({ ok: true });
    expect(gate.pendingMs('run-b', NOW)).toBe(0);
  });

  it('pendingMs with a reservation returns the ms until the turn', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStart('run-a', NOW)).toEqual({ ok: true });
    expect(gate.tryStart('run-b', at(3_000))).toEqual({ ok: false, retryAfterMs: 17_000 });
    expect(gate.pendingMs('run-b', at(3_000))).toBe(17_000);
    expect(gate.pendingMs('run-b', at(21_000))).toBe(0);
  });

  // CO13: the per-runner-endpoint dispatch stagger on the same gate.
  it('CO13: two starts on the same endpoint inside the interval are spaced', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    const denied = gate.tryStartForEndpoint('run-b', at(5_000), 'opencode:host:4166', null);
    expect(denied).toEqual({ ok: false, retryAfterMs: 15_000 });
    expect(gate.tryStartForEndpoint('run-b', at(20_000), 'opencode:host:4166', null)).toEqual({ ok: true });
  });

  it('fix round 3: a grant holds the endpoint at once, so a sibling asking before any release is spaced', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    expect(gate.tryStartForEndpoint('run-b', at(1_000), 'opencode:host:4166', null)).toEqual({
      ok: false,
      retryAfterMs: 19_000,
    });
  });

  it('fix round 3: a released hold delays no later start on the endpoint', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    gate.releaseStartForEndpoint('run-a');
    expect(gate.tryStartForEndpoint('run-b', at(1_000), 'opencode:host:4166', null)).toEqual({ ok: true });
    // Releasing an unknown run, or the same run twice, changes nothing.
    gate.releaseStartForEndpoint('run-a');
    gate.releaseStartForEndpoint('run-unknown');
    expect(gate.tryStartForEndpoint('run-c', at(2_000), 'opencode:host:4166', null)).toEqual({
      ok: false,
      retryAfterMs: 19_000,
    });
  });

  it('fix round 3: a release restores the earlier start, never an older one', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    expect(gate.tryStartForEndpoint('run-b', at(20_000), 'opencode:host:4166', null)).toEqual({ ok: true });
    gate.releaseStartForEndpoint('run-b');
    // run-a's start at NOW stands: at 10 s it still spaces the endpoint.
    expect(gate.tryStartForEndpoint('run-c', at(25_000), 'opencode:host:4166', null)).toEqual({ ok: true });
    gate.releaseStartForEndpoint('run-c');
    expect(gate.tryStartForEndpoint('run-d', at(10_000), 'opencode:host:4166', null)).toEqual({
      ok: false,
      retryAfterMs: 10_000,
    });
  });

  it('fix round 3: releasing overlapping holds in any order never restores a released start', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    expect(gate.tryStartForEndpoint('run-b', at(20_000), 'opencode:host:4166', null)).toEqual({ ok: true });
    gate.releaseStartForEndpoint('run-a');
    gate.releaseStartForEndpoint('run-b');
    // Neither hold remains, so nothing spaces the endpoint — even for a sibling
    // whose step clock was read earlier (10 s after run-a's released hold).
    expect(gate.tryStartForEndpoint('run-c', at(10_000), 'opencode:host:4166', null)).toEqual({ ok: true });
  });

  it('fix round 3: releasing an older hold never loosens a later hold', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    expect(gate.tryStartForEndpoint('run-b', at(20_000), 'opencode:host:4166', null)).toEqual({ ok: true });
    gate.releaseStartForEndpoint('run-a');
    expect(gate.tryStartForEndpoint('run-c', at(25_000), 'opencode:host:4166', null)).toEqual({
      ok: false,
      retryAfterMs: 15_000,
    });
  });

  it('fix round 3: an earlier start a run kept still spaces the endpoint after its next hold is released', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    // run-a's first start was kept (never released); its next start is granted elsewhere then released.
    expect(gate.tryStartForEndpoint('run-a', at(1_000), 'opencode:host:other', null)).toEqual({ ok: true });
    gate.releaseStartForEndpoint('run-a');
    expect(gate.tryStartForEndpoint('run-b', at(5_000), 'opencode:host:4166', null)).toEqual({
      ok: false,
      retryAfterMs: 15_000,
    });
  });

  it('fix round 3: a malformed durable seed is dropped and never blocks the endpoint', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', 'not-a-date')).toEqual({ ok: true });
  });

  it('CO13: two starts on different endpoints are both granted', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host-a:4166', null)).toEqual({ ok: true });
    expect(gate.tryStartForEndpoint('run-b', NOW, 'opencode:host-b:4166', null)).toEqual({ ok: true });
  });

  it('CO13: the durable seed denies the first start on that endpoint', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', at(-5_000))).toEqual({
      ok: false,
      retryAfterMs: 15_000,
    });
    expect(gate.tryStartForEndpoint('run-a', at(15_000), 'opencode:host:4166', at(-5_000))).toEqual({ ok: true });
  });

  it('CO13: pendingMs returns the endpoint wait for the denied run', () => {
    const gate = new SessionStartSpacing(20_000, null);
    expect(gate.tryStartForEndpoint('run-a', NOW, 'opencode:host:4166', null)).toEqual({ ok: true });
    expect(gate.tryStartForEndpoint('run-b', at(3_000), 'opencode:host:4166', null)).toEqual({
      ok: false,
      retryAfterMs: 17_000,
    });
    expect(gate.pendingMs('run-b', at(3_000))).toBe(17_000);
  });
});
