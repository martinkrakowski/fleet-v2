import { describe, expect, it } from 'vitest';

import {
  DAEMON_RECORD_VERSION,
  computeCallBudget,
  computeTickDeadlineIso,
  decideDaemonJobLease,
  evaluateDaemonStatusHealth,
  isDaemonPaused,
  mergePassJobId,
  orderDaemonJobs,
  parseDaemonJobId,
  parseDaemonLeaseStateRecord,
  parseDaemonPauseStateRecord,
  nextConsecutiveBudgetExhausted,
  planDaemonTick,
  readDaemonLeaseRecord,
  readDaemonPauseRecord,
  readDaemonStatusRecord,
  resolveRepoLastServedAtIso,
  buildDaemonStatusRecord,
  isValidDaemonLeaseScope,
  tickExitCodeForJobs,
} from '../daemon-tick.js';
import type {
  BuildDaemonStatusInput,
  DaemonJobLeaseDecision,
  DaemonPauseState,
  DaemonRepositoryStatusRecord,
  DaemonStatusRecord,
  DaemonTickPlanInput,
} from '../daemon-tick.js';
import type { ConductorHaltState } from '../conductor-halt.js';

const NOW = '2026-10-31T12:00:00.000Z';
const UNTIL = '2026-10-31T12:02:00.000Z';
const EXPIRED = '2026-10-31T11:59:00.000Z';
const TICK_A = `tick-0${'1'.repeat(25)}`;
const TICK_B = `tick-1${'2'.repeat(25)}`;
const DIGEST_A = '00000000000a';
const DIGEST_B = '00000000000b';
const DIGEST_C = '00000000000c';
const DIGEST_D = '00000000000d';
const CURSOR = `0${'1'.repeat(25)}`;

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

/** Reads a union read result without narrowing boilerplate in every assertion. */
function reasonOf(read: { readonly ok: true } | { readonly ok: false; readonly reason: string }): string {
  return read.ok ? '(ok)' : read.reason;
}
function errorOf(read: { readonly ok: true } | { readonly ok: false; readonly error: string }): string {
  return read.ok ? '(ok)' : read.error;
}

function repoItem(digest: string, lastServedAtIso: string | null): DaemonRepositoryStatusRecord {
  return {
    repoDigest: digest,
    lastServedAtIso,
    queued: 0,
    ready: 0,
    parked: 0,
    headEntryId: null,
    lastMergedHead12: null,
  };
}

function statusRecord(overrides: Record<string, unknown> = {}): DaemonStatusRecord {
  return {
    version: DAEMON_RECORD_VERSION,
    tickId: TICK_A,
    startedAtIso: '2026-10-31T11:00:00.000Z',
    finishedAtIso: '2026-10-31T12:00:00.000Z',
    exitCode: 0,
    paused: false,
    halted: false,
    forgeReachable: true,
    jobs: [],
    repositories: [],
    notifierCursor: null,
    ...overrides,
  } as DaemonStatusRecord;
}

function previousStatus(): DaemonStatusRecord {
  return statusRecord({
    repositories: [
      repoItem(DIGEST_A, null),
      repoItem(DIGEST_B, '2026-10-31T11:00:00.000Z'),
      repoItem(DIGEST_C, '2026-10-31T12:00:00.000Z'),
      repoItem(DIGEST_D, '2026-10-31T14:00:00.000+02:00'),
    ],
  });
}

function clearPause(): DaemonPauseState {
  return { state: 'clear', record: null };
}

function clearHalt(): ConductorHaltState {
  return { state: 'clear', record: null };
}

function planInput(overrides: Partial<DaemonTickPlanInput> = {}): DaemonTickPlanInput {
  return {
    candidates: [],
    previousStatus: null,
    pause: clearPause(),
    halt: clearHalt(),
    forgeReachable: true,
    nowIso: NOW,
    ...overrides,
  };
}

function jobItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: 'notifier',
    outcome: 'completed',
    reasonCode: null,
    leaseFence: 1,
    durationMs: 10,
    nextNotBeforeIso: null,
    consecutiveBudgetExhausted: 0,
    ...overrides,
  };
}

function validStatusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tickId: TICK_A,
    startedAtIso: '2026-10-31T11:00:00.000Z',
    finishedAtIso: '2026-10-31T12:00:00.000Z',
    exitCode: 0,
    paused: false,
    halted: false,
    forgeReachable: true,
    jobs: [jobItem()],
    repositories: [repoItem(DIGEST_A, '2026-10-31T12:00:00.000Z')],
    notifierCursor: CURSOR,
    ...overrides,
  };
}

function leaseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'notifier',
    holderId: TICK_A,
    fence: 1,
    leaseUntilIso: UNTIL,
    ...overrides,
  };
}

describe('job ids and lease scopes', () => {
  it('builds a merge-pass job id only from a 12 lowercase hex digest', () => {
    expect(mergePassJobId(DIGEST_A)).toBe(`merge-pass:${DIGEST_A}`);
    expect(mergePassJobId('00000000000A')).toBeNull();
    expect(mergePassJobId('short')).toBeNull();
  });

  it('parses the three job id shapes and freezes them', () => {
    expect(parseDaemonJobId('notifier')).toEqual({
      kind: 'notifier', jobId: 'notifier', leaseScope: 'notifier', touchesForge: false,
    });
    expect(parseDaemonJobId('replan-digest')).toEqual({
      kind: 'replan-digest', jobId: 'replan-digest', leaseScope: 'replan-digest', touchesForge: false,
    });
    expect(parseDaemonJobId(`merge-pass:${DIGEST_A}`)).toEqual({
      kind: 'merge-pass', jobId: `merge-pass:${DIGEST_A}`, repoDigest: DIGEST_A,
      leaseScope: `merge/${DIGEST_A}`, touchesForge: true,
    });
    expect(Object.isFrozen(parseDaemonJobId('notifier'))).toBe(true);
  });

  it('rejects wrong digests and non-strings', () => {
    expect(parseDaemonJobId('merge-pass:00000000000A')).toBeNull();
    expect(parseDaemonJobId('merge-pass:short')).toBeNull();
    expect(parseDaemonJobId('nope')).toBeNull();
    expect(parseDaemonJobId(42)).toBeNull();
    expect(parseDaemonJobId(undefined)).toBeNull();
  });

  it('accepts the singleton, merge and cloud scopes', () => {
    expect(isValidDaemonLeaseScope('notifier')).toBe(true);
    expect(isValidDaemonLeaseScope('replan-digest')).toBe(true);
    expect(isValidDaemonLeaseScope(`merge/${DIGEST_A}`)).toBe(true);
    expect(isValidDaemonLeaseScope('acme/widgets')).toBe(true);
  });

  it('rejects traversal, dot segments and secret-shaped scopes', () => {
    expect(isValidDaemonLeaseScope('../x')).toBe(false);
    expect(isValidDaemonLeaseScope('foo/..')).toBe(false);
    expect(isValidDaemonLeaseScope('.')).toBe(false);
    expect(isValidDaemonLeaseScope('..')).toBe(false);
    expect(isValidDaemonLeaseScope(`acme/${fakeSecretShape()}`)).toBe(false);
    expect(isValidDaemonLeaseScope(42)).toBe(false);
  });
});

describe('deterministic tick order', () => {
  const EXPECTED = [
    `merge-pass:${DIGEST_A}`,
    `merge-pass:${DIGEST_B}`,
    `merge-pass:${DIGEST_C}`,
    `merge-pass:${DIGEST_D}`,
    'notifier',
    'replan-digest',
  ];

  it('orders the same way from several shuffled candidate lists', () => {
    const shuffled = [
      ['notifier', `merge-pass:${DIGEST_D}`, `merge-pass:${DIGEST_A}`, 'replan-digest', `merge-pass:${DIGEST_B}`, `merge-pass:${DIGEST_C}`],
      [`merge-pass:${DIGEST_C}`, 'nope', `merge-pass:${DIGEST_A}`, `merge-pass:${DIGEST_B}`, 'notifier', `merge-pass:${DIGEST_A}`, 'replan-digest', `merge-pass:${DIGEST_D}`],
      ['replan-digest', `merge-pass:${DIGEST_B}`, `merge-pass:${DIGEST_D}`, `merge-pass:${DIGEST_C}`, 'notifier', `merge-pass:${DIGEST_A}`],
    ];
    for (const candidates of shuffled) {
      expect(orderDaemonJobs(candidates, previousStatus()).map((job) => job.jobId)).toEqual(EXPECTED);
    }
  });

  it('never-served sorts first and equal instants break by code unit', () => {
    const ordered = orderDaemonJobs(
      [`merge-pass:${DIGEST_D}`, `merge-pass:${DIGEST_C}`, `merge-pass:${DIGEST_B}`, `merge-pass:${DIGEST_A}`],
      previousStatus(),
    );
    // d parses to the same instant as c (14:00+02:00 === 12:00Z); c sorts first by code unit.
    expect(ordered.map((job) => job.jobId)).toEqual([
      `merge-pass:${DIGEST_A}`, `merge-pass:${DIGEST_B}`, `merge-pass:${DIGEST_C}`, `merge-pass:${DIGEST_D}`,
    ]);
  });

  it('applies a job filter and keeps relative order', () => {
    const ordered = orderDaemonJobs(
      ['replan-digest', 'notifier', `merge-pass:${DIGEST_B}`],
      previousStatus(),
      [`merge-pass:${DIGEST_B}`, 'replan-digest'],
    );
    expect(ordered.map((job) => job.jobId)).toEqual([`merge-pass:${DIGEST_B}`, 'replan-digest']);
  });

  it('an empty filter yields an empty list and no filter keeps everything', () => {
    const candidates = ['notifier', `merge-pass:${DIGEST_A}`];
    expect(orderDaemonJobs(candidates, null, [])).toEqual([]);
    expect(orderDaemonJobs(candidates, null)).toHaveLength(2);
  });

  it('a null previous status sorts the digests by code unit', () => {
    const ordered = orderDaemonJobs(
      ['replan-digest', `merge-pass:${DIGEST_D}`, 'notifier', `merge-pass:${DIGEST_A}`, `merge-pass:${DIGEST_C}`, `merge-pass:${DIGEST_B}`],
      null,
    );
    expect(ordered.map((job) => job.jobId)).toEqual(EXPECTED);
  });
});

describe('pause and halt planning', () => {
  it('a paused or unreadable pause plans no entries and exits 0', () => {
    for (const pause of [
      { state: 'paused', record: { version: DAEMON_RECORD_VERSION, paused: true, changedAtIso: NOW } },
      { state: 'unreadable' },
    ] as readonly DaemonPauseState[]) {
      const plan = planDaemonTick(planInput({
        candidates: ['notifier'],
        pause,
        halt: { state: 'halted', record: { version: 1, halted: true, changedAtIso: NOW } },
      }));
      expect(plan.paused).toBe(true);
      expect(plan.halted).toBe(true);
      expect(plan.forgeReachable).toBeNull();
      expect(plan.settleDelayMs).toBe(0);
      expect(plan.entries).toEqual([]);
      expect(tickExitCodeForJobs([])).toBe(0);
    }
  });

  it('a paused or unreadable pause with a clear halt is not halted', () => {
    for (const pause of [
      { state: 'paused', record: { version: DAEMON_RECORD_VERSION, paused: true, changedAtIso: NOW } },
      { state: 'unreadable' },
    ] as readonly DaemonPauseState[]) {
      const plan = planDaemonTick(planInput({ candidates: ['notifier'], pause, halt: clearHalt() }));
      expect(plan.paused).toBe(true);
      expect(plan.halted).toBe(false);
      expect(plan.entries).toEqual([]);
      expect(plan.settleDelayMs).toBe(0);
    }
  });

  it('a halted tick with a clear pause still has its entries', () => {
    for (const halt of [
      { state: 'halted', record: { version: 1, halted: true, changedAtIso: NOW } },
      { state: 'unreadable' },
    ] as readonly ConductorHaltState[]) {
      const plan = planDaemonTick(planInput({
        candidates: [`merge-pass:${DIGEST_A}`, 'notifier'],
        halt,
      }));
      expect(plan.halted).toBe(true);
      expect(plan.paused).toBe(false);
      expect(plan.entries).toHaveLength(2);
      expect(plan.entries.every((entry) => entry.action === 'run')).toBe(true);
    }
  });

  it('forge-unreachable skips only forge-touching jobs', () => {
    const plan = planDaemonTick(planInput({
      candidates: [`merge-pass:${DIGEST_A}`, 'notifier', 'replan-digest'],
      forgeReachable: false,
    }));
    expect(plan.paused).toBe(false);
    expect(plan.forgeReachable).toBe(false);
    expect(plan.entries).toEqual([
      {
        action: 'skip',
        job: parseDaemonJobId(`merge-pass:${DIGEST_A}`),
        outcome: { outcome: 'skipped', reasonCode: 'forge-unreachable' },
      },
      { action: 'run', job: parseDaemonJobId('notifier') },
      { action: 'run', job: parseDaemonJobId('replan-digest') },
    ]);
  });

  it('a skipped pass does not move the repository stamp; a ran pass does', () => {
    const previous = '2026-10-31T11:00:00.000Z';
    expect(resolveRepoLastServedAtIso(previous, null)).toBe(previous);
    expect(resolveRepoLastServedAtIso(null, '2026-10-31T12:30:00.000Z')).toBe('2026-10-31T12:30:00.000Z');
    expect(resolveRepoLastServedAtIso(null, '2026-10-31T14:30:00.000+02:00')).toBe('2026-10-31T12:30:00.000Z');
    expect(resolveRepoLastServedAtIso(previous, 'not-a-time')).toBe(previous);
    expect(resolveRepoLastServedAtIso(null, null)).toBeNull();
  });
});

describe('wake settle', () => {
  function settlePlan(overrides: Record<string, unknown> = {}): number {
    return planDaemonTick(planInput({
      candidates: ['notifier'],
      previousStatus: statusRecord({ finishedAtIso: '2026-10-31T12:00:00.000Z' }),
      ...overrides,
    })).settleDelayMs;
  }

  it('settles when the previous status finished more than three intervals ago', () => {
    expect(settlePlan({ nowIso: '2026-10-31T12:03:00.001Z' })).toBe(20_000);
  });

  it('exactly three intervals is not stale', () => {
    expect(settlePlan({ nowIso: '2026-10-31T12:03:00.000Z' })).toBe(0);
  });

  it('a stale now with no runnable entry settles immediately', () => {
    expect(settlePlan({
      nowIso: '2026-10-31T12:03:00.001Z',
      candidates: [`merge-pass:${DIGEST_A}`],
      forgeReachable: false,
    })).toBe(0);
  });

  it('a stale now while paused settles immediately', () => {
    expect(settlePlan({
      nowIso: '2026-10-31T12:03:00.001Z',
      pause: { state: 'paused', record: null },
    })).toBe(0);
  });
});

/** The refusal outcome when the decision refused, else null: keeps assertions narrowing-free. */
function refusalOutcomeOf(decision: DaemonJobLeaseDecision): { readonly outcome: string; readonly reasonCode: string } | null {
  return decision.action === 'refuse' ? decision.outcome : null;
}

describe('lease decision', () => {
  function acquireRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { holderId: TICK_A, observedFence: 0, leaseUntilIso: UNTIL, nowIso: NOW, ...overrides };
  }

  it('skips lease-held when a live holder owns the lease', () => {
    const current = { holderId: TICK_B, fence: 3, leaseUntilIso: UNTIL };
    const decision = decideDaemonJobLease(current, acquireRequest({ observedFence: 3 }) as never, 'notifier');
    expect(decision).toEqual({
      action: 'skip',
      outcome: { outcome: 'skipped', reasonCode: 'lease-held' },
    });
  });

  it('acquires an expired lease and returns a stored record', () => {
    for (const scope of ['notifier', `merge/${'0123456789ab'}`]) {
      const current = { holderId: TICK_B, fence: 3, leaseUntilIso: EXPIRED };
      const decision = decideDaemonJobLease(
        current,
        acquireRequest({ observedFence: 3 }) as never,
        scope,
      );
      expect(decision.action).toBe('acquired');
      if (decision.action === 'acquired') {
        expect(decision.lease).toEqual({
          version: DAEMON_RECORD_VERSION,
          scope,
          holderId: TICK_A,
          fence: 4,
          leaseUntilIso: UNTIL,
        });
        expect(Object.isFrozen(decision.lease)).toBe(true);
      }
    }
  });

  it('a null current acquires fence 1 and refuses a stale observed fence', () => {
    const acquired = decideDaemonJobLease(null, acquireRequest() as never, 'notifier');
    expect(acquired).toEqual({
      action: 'acquired',
      lease: {
        version: DAEMON_RECORD_VERSION, scope: 'notifier', holderId: TICK_A, fence: 1, leaseUntilIso: UNTIL,
      },
    });
    const moved = decideDaemonJobLease(null, acquireRequest({ observedFence: 1 }) as never, 'notifier');
    expect(moved).toEqual({
      action: 'skip',
      outcome: { outcome: 'skipped', reasonCode: 'lease-moved' },
    });
  });

  it('refuses non-tick holders and invalid scopes', () => {
    const driverRequest = acquireRequest({ holderId: 'driver-example-1' }) as never;
    expect(decideDaemonJobLease(null, driverRequest, 'notifier')).toEqual({
      action: 'refuse',
      outcome: { outcome: 'refused', reasonCode: 'invalid-lease-request' },
    });
    const refusedOutcome = { outcome: 'refused', reasonCode: 'invalid-lease-request' };
    expect(refusalOutcomeOf(decideDaemonJobLease(null, acquireRequest() as never, '../x'))).toEqual(refusedOutcome);
    expect(refusalOutcomeOf(decideDaemonJobLease(null, acquireRequest() as never, 'nope'))).toEqual(refusedOutcome);
  });

  it('never throws on a throwing getter in the request or in the current lease', () => {
    const throwingRequest = Object.defineProperty({}, 'holderId', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const refused = decideDaemonJobLease(null, throwingRequest as never, 'notifier');
    expect(JSON.stringify(refused)).not.toContain('boom');
    expect(refused).toEqual({ action: 'refuse', outcome: { outcome: 'refused', reasonCode: 'invalid-lease-request' } });
    const throwingCurrent = {
      get holderId(): string {
        throw new Error('boom');
      },
    };
    const refusedCurrent = decideDaemonJobLease(throwingCurrent as never, acquireRequest() as never, 'notifier');
    expect(JSON.stringify(refusedCurrent)).not.toContain('boom');
    expect(refusedCurrent).toEqual({ action: 'refuse', outcome: { outcome: 'refused', reasonCode: 'invalid-lease-request' } });
  });
});

describe('call budget', () => {
  const BASE = { nowIso: NOW, normalTimeoutMs: 30_000 };

  it('gives a call the smaller of the normal timeout and the remainder', () => {
    expect(computeCallBudget({ ...BASE, deadlineIso: '2026-10-31T12:00:02.000Z' })).toEqual({
      allowed: true, timeoutMs: 2_000, remainingMs: 2_000,
    });
    expect(computeCallBudget({ ...BASE, deadlineIso: '2026-10-31T12:00:10.000Z' })).toEqual({
      allowed: true, timeoutMs: 10_000, remainingMs: 10_000,
    });
    expect(computeCallBudget({ ...BASE, normalTimeoutMs: 5_000, deadlineIso: '2026-10-31T12:00:10.000Z' })).toEqual({
      allowed: true, timeoutMs: 5_000, remainingMs: 10_000,
    });
  });

  it('does not start a call with less than two seconds remaining', () => {
    expect(computeCallBudget({ ...BASE, deadlineIso: '2026-10-31T12:00:01.999Z' })).toEqual({
      allowed: false, reason: 'budget-exhausted', remainingMs: 1_999,
    });
    expect(computeCallBudget({ ...BASE, deadlineIso: NOW })).toEqual({
      allowed: false, reason: 'budget-exhausted', remainingMs: 0,
    });
    expect(computeCallBudget({ ...BASE, deadlineIso: '2026-10-31T11:59:59.500Z' })).toEqual({
      allowed: false, reason: 'budget-exhausted', remainingMs: -500,
    });
  });

  it('refuses invalid budget inputs without throwing', () => {
    const invalid = { allowed: false, reason: 'invalid-budget', remainingMs: 0 };
    expect(computeCallBudget({ ...BASE, deadlineIso: '2026-02-31T00:00:00.000Z' })).toEqual(invalid);
    expect(computeCallBudget({ ...BASE, normalTimeoutMs: 0, deadlineIso: UNTIL })).toEqual(invalid);
    expect(computeCallBudget({ ...BASE, normalTimeoutMs: 1.5, deadlineIso: UNTIL })).toEqual(invalid);
  });

  it('bounds the tick deadline by the budget', () => {
    expect(computeTickDeadlineIso(NOW, 45)).toBe('2026-10-31T12:00:45.000Z');
    expect(computeTickDeadlineIso(NOW, 1)).toBe('2026-10-31T12:00:01.000Z');
    expect(computeTickDeadlineIso(NOW, 3_600)).toBe('2026-10-31T13:00:00.000Z');
    expect(computeTickDeadlineIso(NOW, 0)).toBeNull();
    expect(computeTickDeadlineIso(NOW, 3_601)).toBeNull();
    expect(computeTickDeadlineIso(NOW, 1.5)).toBeNull();
    expect(computeTickDeadlineIso('2026-02-31T00:00:00.000Z', 45)).toBeNull();
  });
});

describe('status v1 records, versions, exit codes and health', () => {
  it('round-trips a valid body and defaults an absent version to 1', () => {
    const built = buildDaemonStatusRecord(validStatusBody() as unknown as BuildDaemonStatusInput);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.record.version).toBe(DAEMON_RECORD_VERSION);
      expect(built.record.exitCode).toBe(0);
    }
    const withoutVersion: Record<string, unknown> = { ...validStatusBody() };
    delete withoutVersion.version;
    const read = readDaemonStatusRecord(withoutVersion);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.version).toBe(DAEMON_RECORD_VERSION);
      expect(read.record.jobs[0]?.nextNotBeforeIso).toBeNull();
      expect(read.record.repositories[0]?.lastServedAtIso).toBe('2026-10-31T12:00:00.000Z');
    }
  });

  it('refuses unknown versions and extra keys without echoing values', () => {
    const sentinel = 'getter-sentinel-value';
    expect(reasonOf(readDaemonStatusRecord({ ...validStatusBody(), version: 2 }))).toBe('unknown-version');
    expect(errorOf(readDaemonStatusRecord({ ...validStatusBody(), version: 2 }))).toBe('DaemonStatus version is not supported');
    expect(reasonOf(readDaemonStatusRecord({ ...validStatusBody(), schemaVersion: 1 }))).toBe('malformed');
    expect(reasonOf(readDaemonStatusRecord({ ...validStatusBody(), schemaVersion: 2 }))).toBe('malformed');
    expect(reasonOf(readDaemonStatusRecord({ ...validStatusBody(), title: 'x' }))).toBe('malformed');
    expect(reasonOf(readDaemonStatusRecord({ ...validStatusBody(), path: 'x' }))).toBe('malformed');
    const accessor: Record<string, unknown> = {};
    for (const key of Object.keys(validStatusBody())) {
      Object.defineProperty(accessor, key, {
        enumerable: true,
        get() {
          if (key === 'paused') {
            return sentinel;
          }
          throw new Error('boom');
        },
      });
    }
    const read = readDaemonStatusRecord(accessor);
    expect(read.ok).toBe(false);
    expect(reasonOf(read)).toBe('malformed');
    expect(errorOf(read)).not.toContain(sentinel);
    expect(errorOf(read)).not.toContain('boom');
  });

  it('checks the exit code in one direction only', () => {
    expect(readDaemonStatusRecord({ ...validStatusBody(), exitCode: 1 }).ok).toBe(true);
    expect(readDaemonStatusRecord({ ...validStatusBody(), exitCode: 1, jobs: [] }).ok).toBe(true);
    expect(reasonOf(readDaemonStatusRecord({
      ...validStatusBody(),
      exitCode: 0,
      jobs: [jobItem({ jobId: `merge-pass:${DIGEST_A}`, outcome: 'refused', reasonCode: 'x' })],
    }))).toBe('malformed');
    expect(reasonOf(readDaemonStatusRecord({ ...validStatusBody(), exitCode: 2 }))).toBe('malformed');
  });

  it('the builder stamps the exit code from the jobs', () => {
    const refused = buildDaemonStatusRecord(validStatusBody({
      jobs: [jobItem({ jobId: `merge-pass:${DIGEST_A}`, outcome: 'refused', reasonCode: 'x' })],
    }) as unknown as BuildDaemonStatusInput);
    expect(refused.ok).toBe(true);
    if (refused.ok) {
      expect(refused.record.exitCode).toBe(1);
    }
    const budgeted = buildDaemonStatusRecord(validStatusBody({
      jobs: [jobItem({ outcome: 'budget-exhausted' })],
    }) as unknown as BuildDaemonStatusInput);
    expect(budgeted.ok).toBe(true);
    if (budgeted.ok) {
      expect(budgeted.record.exitCode).toBe(0);
    }
  });

  it('refuses secret-shaped reason codes, entry ids and cursors without echoing them', () => {
    const secret = fakeSecretShape();
    const reasonRead = readDaemonStatusRecord({
      ...validStatusBody(),
      jobs: [jobItem({ outcome: 'skipped', reasonCode: secret })],
    });
    expect(reasonOf(reasonRead)).toBe('malformed');
    expect(errorOf(reasonRead)).not.toContain(secret);
    const entryRead = readDaemonStatusRecord({
      ...validStatusBody(),
      repositories: [{ ...repoItem(DIGEST_A, NOW), headEntryId: secret }],
    });
    expect(reasonOf(entryRead)).toBe('malformed');
    expect(errorOf(entryRead)).not.toContain(secret);
    const cursorRead = readDaemonStatusRecord({ ...validStatusBody(), notifierCursor: secret });
    expect(reasonOf(cursorRead)).toBe('malformed');
    expect(errorOf(cursorRead)).not.toContain(secret);
  });

  it('refuses impossible dates', () => {
    expect(reasonOf(readDaemonStatusRecord({ ...validStatusBody(), startedAtIso: '2026-02-31T00:00:00.000Z' }))).toBe('malformed');
  });

  it('counts consecutive budget exhaustion', () => {
    expect(nextConsecutiveBudgetExhausted(9, 'budget-exhausted')).toBe(10);
    expect(nextConsecutiveBudgetExhausted(9, 'skipped')).toBe(9);
    expect(nextConsecutiveBudgetExhausted(9, 'completed')).toBe(0);
    expect(nextConsecutiveBudgetExhausted(9, 'refused')).toBe(0);
    expect(nextConsecutiveBudgetExhausted(-1, 'budget-exhausted')).toBe(1);
  });

  it('reports starvation, staleness, refusals and a bad clock in order', () => {
    const near = readDaemonStatusRecord(validStatusBody({
      jobs: [jobItem({ consecutiveBudgetExhausted: 9 })],
    }));
    expect(near.ok).toBe(true);
    if (near.ok) {
      const health = evaluateDaemonStatusHealth(near.record, NOW);
      expect(health).toEqual({
        healthy: true, exitCode: 0, reasons: [], refusedJobIds: [], starvedJobIds: [],
      });
    }
    const starved = readDaemonStatusRecord(validStatusBody({
      jobs: [jobItem({ consecutiveBudgetExhausted: 10 })],
    }));
    expect(starved.ok).toBe(true);
    if (starved.ok) {
      expect(evaluateDaemonStatusHealth(starved.record, NOW)).toEqual({
        healthy: false, exitCode: 1, reasons: ['starved'], refusedJobIds: [], starvedJobIds: ['notifier'],
      });
    }
    const stale = evaluateDaemonStatusHealth(statusRecord(), '2026-10-31T13:00:00.000Z');
    expect(stale.reasons).toEqual(['stale']);
    expect(stale.exitCode).toBe(1);
    const refusedHealth = readDaemonStatusRecord(validStatusBody({
      exitCode: 1,
      jobs: [jobItem({ jobId: `merge-pass:${DIGEST_A}`, outcome: 'refused', reasonCode: 'x' })],
    }));
    expect(refusedHealth.ok).toBe(true);
    if (refusedHealth.ok) {
      expect(evaluateDaemonStatusHealth(refusedHealth.record, NOW).reasons).toEqual(['job-refused']);
    }
    expect(evaluateDaemonStatusHealth(statusRecord(), 'not-a-time').reasons).toEqual(['invalid-clock']);
  });

  it('freezes the jobs and repositories arrays of an accepted record', () => {
    const read = readDaemonStatusRecord(validStatusBody());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(Object.isFrozen(read.record)).toBe(true);
      expect(Object.isFrozen(read.record.jobs)).toBe(true);
      expect(Object.isFrozen(read.record.repositories)).toBe(true);
      expect(() => (read.record.jobs as unknown as unknown[]).push(jobItem())).toThrow();
      expect(() => (read.record.repositories as unknown as unknown[]).push(repoItem(DIGEST_B, null))).toThrow();
    }
  });

  it('does not read required keys from a polluted Object.prototype', () => {
    const sentinels: ReadonlyArray<[string, unknown]> = [
      ['paused', false],
      ['changedAtIso', NOW],
      ['tickId', TICK_A],
      ['startedAtIso', NOW],
      ['finishedAtIso', NOW],
      ['exitCode', 0],
      ['halted', false],
      ['forgeReachable', true],
      ['jobs', []],
      ['repositories', []],
      ['notifierCursor', null],
    ];
    try {
      for (const [key, value] of sentinels) {
        Object.defineProperty(Object.prototype, key, { value, enumerable: false, configurable: true });
      }
      const pause = readDaemonPauseRecord({});
      expect(pause.ok).toBe(false);
      expect(reasonOf(pause)).toBe('malformed');
      expect(errorOf(pause)).toBe('DaemonPause is malformed');
      const status = readDaemonStatusRecord({});
      expect(status.ok).toBe(false);
      expect(reasonOf(status)).toBe('malformed');
      expect(errorOf(status)).toBe('DaemonStatus is malformed');
    } finally {
      for (const [key] of sentinels) {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
  });
});

describe('pause and lease readers', () => {
  it('reads the pause marker with an absent version as version 1', () => {
    const read = readDaemonPauseRecord({ paused: true, changedAtIso: NOW });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record).toEqual({ version: DAEMON_RECORD_VERSION, paused: true, changedAtIso: NOW });
    }
    expect(parseDaemonPauseStateRecord({ paused: true, changedAtIso: NOW })).toEqual({
      version: DAEMON_RECORD_VERSION, paused: true, changedAtIso: NOW,
    });
    expect(parseDaemonPauseStateRecord({ paused: true, changedAtIso: 'junk' })).toBeUndefined();
  });

  it('refuses an unsupported pause version and a schemaVersion alias', () => {
    expect(reasonOf(readDaemonPauseRecord({ version: 2, paused: true, changedAtIso: NOW }))).toBe('unknown-version');
    expect(errorOf(readDaemonPauseRecord({ version: 2, paused: true, changedAtIso: NOW }))).toBe('DaemonPause version is not supported');
    expect(reasonOf(readDaemonPauseRecord({ version: 1, schemaVersion: 1, paused: true, changedAtIso: NOW }))).toBe('malformed');
  });

  it('reads leases for every scope shape with a tick holder', () => {
    for (const scope of [`merge/${'0123456789ab'}`, 'notifier', 'replan-digest', 'acme/widgets']) {
      const read = readDaemonLeaseRecord(leaseBody({ scope }));
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.record).toEqual({
          version: DAEMON_RECORD_VERSION, scope, holderId: TICK_A, fence: 1, leaseUntilIso: UNTIL,
        });
      }
      expect(parseDaemonLeaseStateRecord(leaseBody({ scope }))?.scope).toBe(scope);
    }
  });

  it('refuses dot scopes, bad holders, extra fields and unknown versions', () => {
    for (const scope of ['../x', 'foo/..', '.', '..']) {
      expect(reasonOf(readDaemonLeaseRecord(leaseBody({ scope })))).toBe('malformed');
    }
    expect(reasonOf(readDaemonLeaseRecord(leaseBody({ holderId: 'driver-example-1' })))).toBe('malformed');
    const secret = fakeSecretShape();
    const secretRead = readDaemonLeaseRecord(leaseBody({ scope: `acme/${secret}` }));
    expect(reasonOf(secretRead)).toBe('malformed');
    expect(errorOf(secretRead)).not.toContain(secret);
    expect(reasonOf(readDaemonLeaseRecord({ ...leaseBody(), extra: 1 }))).toBe('malformed');
    expect(reasonOf(readDaemonLeaseRecord(leaseBody({ version: 2 })))).toBe('unknown-version');
    expect(errorOf(readDaemonLeaseRecord(leaseBody({ version: 2 })))).toBe('DaemonLease version is not supported');
    expect(reasonOf(readDaemonLeaseRecord({ ...leaseBody(), schemaVersion: 1 }))).toBe('malformed');
    expect(reasonOf(readDaemonPauseRecord({ ...{ version: 1, paused: true, changedAtIso: NOW }, schemaVersion: 1 }))).toBe('malformed');
  });
});

describe('isDaemonPaused', () => {
  it('is true only for paused and unreadable', () => {
    expect(isDaemonPaused({ state: 'paused', record: { version: DAEMON_RECORD_VERSION, paused: true, changedAtIso: NOW } })).toBe(true);
    expect(isDaemonPaused({ state: 'unreadable' })).toBe(true);
    expect(isDaemonPaused({ state: 'clear', record: null })).toBe(false);
  });
});
