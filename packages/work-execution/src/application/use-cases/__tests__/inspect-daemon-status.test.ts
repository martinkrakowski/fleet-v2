// DT10b: the read-only daemon status check.
import { describe, expect, it } from 'vitest';

import { InspectDaemonStatusUseCase } from '../InspectDaemonStatusUseCase.use-case.js';
import type { InspectDaemonStatusDependencies } from '../InspectDaemonStatusUseCase.use-case.js';
import type { DaemonStatusFileRead } from '../../ports/out/DaemonStatusPort.out-port.js';
import type { MergePolicyAnswer } from '../../ports/out/MergePolicyPort.out-port.js';
import {
  buildDaemonStatusRecord,
  type DaemonJobStatusRecord,
  type DaemonStatusRecord,
} from '../../../domain/daemon-tick.js';

const TICK = `tick-0${'1'.repeat(25)}`;
const FINISHED = '2026-11-01T12:00:00.000Z';
const FRESH_NOW = '2026-11-01T12:02:00.000Z'; // 120 s after: within 3 x 60 s
const STALE_NOW = '2026-11-01T12:03:01.000Z'; // 181 s after: beyond 3 x 60 s

function job(overrides: Partial<DaemonJobStatusRecord> = {}): DaemonJobStatusRecord {
  return {
    jobId: 'merge-pass:00000000000a',
    outcome: 'completed',
    reasonCode: null,
    leaseFence: 1,
    durationMs: 10,
    nextNotBeforeIso: null,
    consecutiveBudgetExhausted: 0,
    ...overrides,
  };
}

function statusRecord(jobs: readonly DaemonJobStatusRecord[] = [job()]): DaemonStatusRecord {
  const built = buildDaemonStatusRecord({
    tickId: TICK,
    startedAtIso: FINISHED,
    finishedAtIso: FINISHED,
    paused: false,
    halted: false,
    forgeReachable: true,
    jobs,
    repositories: [],
    notifierCursor: null,
  });
  if (!built.ok) {
    throw new Error('fixture status must build');
  }
  return built.record;
}

function known(intervalSeconds: number): MergePolicyAnswer {
  return {
    outcome: 'known',
    policyRevision: 'abcdef012345',
    repositories: [],
    daemon: { intervalSeconds, budgetSeconds: 45, settleSeconds: 20 },
  };
}

function make(
  read: () => Promise<DaemonStatusFileRead> | DaemonStatusFileRead,
  policy?: () => Promise<MergePolicyAnswer> | MergePolicyAnswer,
): InspectDaemonStatusUseCase {
  const deps: InspectDaemonStatusDependencies = {
    status: { read: async () => read() },
    ...(policy === undefined ? {} : { policy: { readMergePolicy: async () => policy() } }),
  };
  return new InspectDaemonStatusUseCase(deps);
}

describe('InspectDaemonStatusUseCase (DT10b)', () => {
  it('a fresh status is healthy with exit 0, including nine consecutive budget-exhausted ticks', async () => {
    const record = statusRecord([job({ outcome: 'budget-exhausted', consecutiveBudgetExhausted: 9 })]);
    const result = await make(() => ({ status: 'ok', record })).inspectStatus({ nowIso: FRESH_NOW });

    expect(result).toMatchObject({ outcome: 'ok', exitCode: 0, reasonCode: null });
    expect(result.health?.healthy).toBe(true);
  });

  it('a status older than three intervals is stale, from the request interval or the policy interval', async () => {
    const record = statusRecord();
    const fromRequest = await make(() => ({ status: 'ok', record })).inspectStatus({ nowIso: STALE_NOW });
    expect(fromRequest).toMatchObject({ outcome: 'ok', exitCode: 1, reasonCode: 'stale' });

    const widened = await make(() => ({ status: 'ok', record })).inspectStatus({
      nowIso: STALE_NOW,
      intervalSeconds: 120,
    });
    expect(widened).toMatchObject({ outcome: 'ok', exitCode: 0 });

    const fromPolicy = await make(
      () => ({ status: 'ok', record }),
      () => known(120),
    ).inspectStatus({ nowIso: STALE_NOW });
    expect(fromPolicy).toMatchObject({ outcome: 'ok', exitCode: 0 });

    const narrowPolicy = await make(
      () => ({ status: 'ok', record }),
      () => known(10),
    ).inspectStatus({ nowIso: FRESH_NOW });
    expect(narrowPolicy).toMatchObject({ outcome: 'ok', exitCode: 1, reasonCode: 'stale' });
  });

  it('names refused and starved jobs and exits 1', async () => {
    const record = statusRecord([
      job({ jobId: 'merge-pass:00000000000a', outcome: 'refused', reasonCode: 'merge-pass-refused' }),
      job({ jobId: 'merge-pass:00000000000b', outcome: 'budget-exhausted', consecutiveBudgetExhausted: 10 }),
    ]);
    const result = await make(() => ({ status: 'ok', record })).inspectStatus({ nowIso: FRESH_NOW });

    expect(result).toMatchObject({ outcome: 'ok', exitCode: 1 });
    expect(result.health?.healthy).toBe(false);
    expect(result.health?.refusedJobIds).toEqual(['merge-pass:00000000000a']);
    expect(result.health?.starvedJobIds).toEqual(['merge-pass:00000000000b']);
    expect(result.health?.reasons).toEqual(['job-refused', 'starved']);
  });

  it('a missing status is its own non-zero outcome', async () => {
    const result = await make(() => ({ status: 'missing' })).inspectStatus({ nowIso: FRESH_NOW });
    expect(result).toEqual({
      outcome: 'missing',
      exitCode: 1,
      status: null,
      health: null,
      reasonCode: 'status-missing',
    });
  });

  it('treats missing, corrupt, unknown-version or throwing status and policy reads as non-zero refusals, never healthy', async () => {
    const record = statusRecord();
    const secretPath = '/srv/private/state/daemon/status.json';
    const cases: Array<[string, InspectDaemonStatusUseCase, string]> = [
      ['unreadable status', make(() => ({ status: 'unreadable' })), 'status-unreadable'],
      [
        'throwing status read (unknown version carries a path)',
        make(() => {
          throw new Error(`unknown version in ${secretPath}`);
        }),
        'status-unreadable',
      ],
      ['malformed container', make(() => null as unknown as DaemonStatusFileRead), 'status-unreadable'],
      [
        'ok container with a corrupt record',
        make(() => ({ status: 'ok', record: { version: 1 } as unknown as DaemonStatusRecord })),
        'status-unreadable',
      ],
      [
        'unknown policy',
        make(
          () => ({ status: 'ok', record }),
          () => ({ outcome: 'unknown', reason: 'installation-invalid' }),
        ),
        'policy-unreadable',
      ],
      [
        'throwing policy',
        make(
          () => ({ status: 'ok', record }),
          () => {
            throw new Error(`cannot read ${secretPath}`);
          },
        ),
        'policy-unreadable',
      ],
      [
        'policy with a bad interval',
        make(
          () => ({ status: 'ok', record }),
          () => known(0),
        ),
        'policy-unreadable',
      ],
    ];
    for (const [label, useCase, reasonCode] of cases) {
      const result = await useCase.inspectStatus({ nowIso: FRESH_NOW });
      expect(result, label).toMatchObject({ outcome: 'refused', exitCode: 1, reasonCode });
      expect(JSON.stringify(result), label).not.toContain(secretPath);
    }
  });

  it('returns typed refusals and never throws on null, non-object, bad fields, unknown enum values, sparse arrays or throwing getters', async () => {
    const record = statusRecord();
    const useCase = make(() => ({ status: 'ok', record }));
    const bad = (value: unknown) => useCase.inspectStatus(value as never);

    expect(await bad(null)).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-request' });
    expect(await bad(undefined)).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-request' });
    expect(await bad('now')).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-request' });
    expect(await bad([FRESH_NOW])).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-request' });
    // eslint-disable-next-line no-sparse-arrays
    expect(await bad([, ,])).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-request' });
    expect(await bad({})).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-clock' });
    expect(await bad({ nowIso: 42 })).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-clock' });
    expect(await bad({ nowIso: 'tomorrow' })).toMatchObject({ outcome: 'refused', reasonCode: 'invalid-clock' });
    for (const intervalSeconds of [0, 3601, 1.5, Number.NaN, '60', null, {}, []]) {
      expect(await bad({ nowIso: FRESH_NOW, intervalSeconds })).toMatchObject({
        outcome: 'refused',
        reasonCode: 'invalid-interval',
      });
    }
    const hostile = {
      get nowIso(): string {
        throw new Error('getter exploded');
      },
    };
    expect(await bad(hostile)).toMatchObject({ outcome: 'refused', exitCode: 1 });
  });

  it('never reads a clock that cannot be evaluated as healthy: a future clock still yields a typed result', async () => {
    const record = statusRecord();
    const result = await make(() => ({ status: 'ok', record })).inspectStatus({ nowIso: '2020-01-01T00:00:00.000Z' });
    expect(result.outcome).toBe('ok');
  });
});
