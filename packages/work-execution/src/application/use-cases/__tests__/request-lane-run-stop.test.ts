import { describe, expect, it } from 'vitest';

import { LaneRun } from '../../../domain/entities/LaneRun.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { laneRunConductEntry } from '../../../domain/lane-run-step-facts.js';
import { RequestLaneRunStopUseCase } from '../RequestLaneRunStopUseCase.use-case.js';
import type { LaneRunJournalPort } from '../../ports/out/LaneRunJournalPort.out-port.js';
import type { LaneRunRepositoryPort } from '../../ports/out/LaneRunRepositoryPort.out-port.js';

const RUN_A = 'run-01JB0000000000000000000000';
const NOW = '2026-10-27T10:00:00.000Z';

function ulid(seed: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = alphabet[Math.floor(seed / 32 ** i) % 32]! + out;
  }
  return `0${out.slice(1)}`;
}

function runRecord(overrides: Partial<LaneRunRecord> = {}): LaneRunRecord {
  const result = LaneRun.create({
    version: 1,
    runId: RUN_A,
    workOrderId: 'wo-example-1',
    tier: 2,
    seatPlanRef: 'a'.repeat(64),
    cursors: { 'first-pass': 0, fix: null, review: null },
    round: 0,
    attemptIds: ['attempt-example-1'],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 3,
    runPolicyRevision: 'policy-example-1',
    ...overrides,
  });
  if (!result.success) {
    throw new Error('fixture must be a valid LaneRun record');
  }
  return result.value.toRecord();
}

/**
 * An in-memory journal with the K1b stop rules the use case maps its
 * outcomes from: no second stop intent per run, graceful refused after a
 * forced intent, escalation graceful → forced allowed once.
 */
function journal(entries: LaneRunJournalEntryRecord[] = []): LaneRunJournalPort {
  const stopIntentKeys = (): string[] =>
    entries.filter((e) => e.kind === 'intent' && e.key !== null && e.key.includes('/stop')).map((e) => e.key!);
  return {
    async append(entry) {
      const existing = stopIntentKeys();
      const forcedPresent = existing.some((key) => key.endsWith('/stop-force@web') || key.endsWith('/stop-force@cli'));
      if (entry.kind === 'intent' && entry.key !== null && entry.key.includes('/stop')) {
        const key = entry.key;
        const isForced = key.endsWith('/stop-force@web') || key.endsWith('/stop-force@cli');
        if (existing.some((k) => k === key)) {
          return { outcome: 'refused', reason: 'stop-already-requested', detail: null };
        }
        if (isForced) {
          // A second forced intent on a different via is still a repeat.
          if (forcedPresent) {
            return { outcome: 'refused', reason: 'stop-already-requested', detail: null };
          }
        } else if (existing.length > 0) {
          return {
            outcome: 'refused',
            reason: forcedPresent ? 'stop-already-forced' : 'duplicate-key',
            detail: null,
          };
        }
      }
      entries.push({ ...entry });
      return { outcome: 'appended', entry: { ...entry } };
    },
    async listForRun(runId: string) {
      return entries.filter((e) => e.runId === runId);
    },
    async listForKey(key: string) {
      return entries.filter((e) => e.key === key);
    },
  };
}

function repo(runs: readonly LaneRunRecord[]): Pick<LaneRunRepositoryPort, 'get'> {
  return {
    async get(runId: string) {
      return runs.find((run) => run.runId === runId) ?? null;
    },
  };
}

function useCase(runs: readonly LaneRunRecord[], entries: LaneRunJournalEntryRecord[] = []): RequestLaneRunStopUseCase {
  return new RequestLaneRunStopUseCase({ runRepo: repo(runs), runJournal: journal(entries) });
}

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_A,
    mode: 'graceful',
    via: 'web',
    entryId: ulid(1),
    nowIso: NOW,
    ...overrides,
  };
}

describe('RequestLaneRunStopUseCase', () => {
  it('throws Not implemented when unconfigured', async () => {
    await expect(new RequestLaneRunStopUseCase().requestLaneRunStop(validRequest() as never)).rejects.toThrow(
      'Not implemented: RequestLaneRunStopUseCase',
    );
  });

  it('records a graceful @web stop and a forced @web stop under their keys', async () => {
    const entries: LaneRunJournalEntryRecord[] = [];
    const useCaseForce = useCase([runRecord()], entries);
    const forced = await useCaseForce.requestLaneRunStop(
      validRequest({ mode: 'force', expectedRevision: 3 }) as never,
    );
    expect(forced).toEqual({
      outcome: 'stop-recorded',
      runId: RUN_A,
      mode: 'force',
      key: `${RUN_A}/stop-force@web`,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe(`${RUN_A}/stop-force@web`);
  });

  it('appends <runId>/stop@web for a graceful web stop', async () => {
    const entries: LaneRunJournalEntryRecord[] = [];
    await useCase([runRecord()], entries).requestLaneRunStop(validRequest() as never);
    expect(entries.map((entry) => entry.key)).toEqual([`${RUN_A}/stop@web`]);
  });

  it('is idempotent across repeated graceful and forced stop requests and escalates graceful to forced once', async () => {
    const entries: LaneRunJournalEntryRecord[] = [];
    const stop = useCase([runRecord()], entries);

    // First graceful @cli, then graceful @web: the second is already-requested.
    expect(
      await stop.requestLaneRunStop(validRequest({ via: 'cli', entryId: ulid(2) }) as never),
    ).toMatchObject({ outcome: 'stop-recorded' });
    expect(await stop.requestLaneRunStop(validRequest({ entryId: ulid(3) }) as never)).toEqual({
      outcome: 'already-requested',
      runId: RUN_A,
      mode: 'graceful',
    });
    expect(await stop.requestLaneRunStop(validRequest({ entryId: ulid(4) }) as never)).toEqual({
      outcome: 'already-requested',
      runId: RUN_A,
      mode: 'graceful',
    });
    expect(entries).toHaveLength(1);

    // Escalation to forced appends the forced key exactly once.
    expect(
      await stop.requestLaneRunStop(validRequest({ mode: 'force', entryId: ulid(5) }) as never),
    ).toMatchObject({ outcome: 'stop-recorded', key: `${RUN_A}/stop-force@web` });
    expect(entries.map((entry) => entry.key)).toEqual([`${RUN_A}/stop@cli`, `${RUN_A}/stop-force@web`]);

    // Repeated forced is already-requested.
    expect(
      await stop.requestLaneRunStop(validRequest({ mode: 'force', entryId: ulid(6) }) as never),
    ).toEqual({ outcome: 'already-requested', runId: RUN_A, mode: 'force' });
    expect(entries).toHaveLength(2);

    // Graceful after forced is refused as stop-already-forced.
    expect(await stop.requestLaneRunStop(validRequest({ entryId: ulid(7) }) as never)).toEqual({
      outcome: 'refused',
      reason: 'stop-already-forced',
    });
    expect(entries).toHaveLength(2);
  });

  it('answers not-found on a missing valid runId and stale-revision on a mismatched expectedRevision', async () => {
    const stop = useCase([runRecord()]);
    expect(await stop.requestLaneRunStop(validRequest({ runId: 'run-01JC0000000000000000000000' }) as never)).toEqual({
      outcome: 'not-found',
      runId: 'run-01JC0000000000000000000000',
    });
    expect(await stop.requestLaneRunStop(validRequest({ expectedRevision: 2 }) as never)).toEqual({
      outcome: 'refused',
      reason: 'stale-revision',
    });
  });

  it('refuses run-terminal runs without appending', async () => {
    for (const terminal of ['merged', 'stopped'] as const) {
      const entries: LaneRunJournalEntryRecord[] = [
        laneRunConductEntry(ulid(9), RUN_A, terminal, NOW),
      ];
      const result = await useCase([runRecord()], entries).requestLaneRunStop(validRequest() as never);
      expect(result).toEqual({ outcome: 'refused', reason: 'run-terminal' });
      expect(entries).toHaveLength(1);
    }
  });

  it('accepts a stop for a parked run (parked is not terminal), as `conductor stop` does', async () => {
    const entries: LaneRunJournalEntryRecord[] = [
      laneRunConductEntry(ulid(9), RUN_A, 'parked', NOW),
    ];
    const result = await useCase([runRecord()], entries).requestLaneRunStop(
      validRequest({ mode: 'force', expectedRevision: 3 }) as never,
    );
    expect(result).toMatchObject({ outcome: 'stop-recorded', runId: RUN_A, mode: 'force' });
    expect(entries).toHaveLength(2);
  });

  it('refuses only merged and stopped as run-terminal, never any other state', async () => {
    for (const state of ['ready', 'running', 'fixing', 'awaiting-premerge', 'parked'] as const) {
      const entries: LaneRunJournalEntryRecord[] = [laneRunConductEntry(ulid(9), RUN_A, state, NOW)];
      const result = await useCase([runRecord()], entries).requestLaneRunStop(validRequest() as never);
      expect(result.outcome, state).toBe('stop-recorded');
    }
  });

  it('refuses null, non-object, sparse array, missing or wrong-typed fields, unknown enum values, and throwing getters without throwing', async () => {
    const stop = useCase([runRecord()]);
    const refusing = [
      null,
      undefined,
      'stop',
      42,
      [],
      ['x'],
      // sparse array
      (() => {
        const sparse: unknown[] = new Array(3);
        sparse[1] = 'graceful';
        return sparse;
      })(),
      {},
      validRequest({ runId: 'not-a-run-id' }),
      validRequest({ runId: 42 }),
      validRequest({ mode: 'delete' }),
      validRequest({ mode: null }),
      validRequest({ via: 'fax' }),
      validRequest({ expectedRevision: 0 }),
      validRequest({ expectedRevision: -1 }),
      validRequest({ expectedRevision: 1.5 }),
      validRequest({ expectedRevision: true }),
      validRequest({ expectedRevision: '3' }),
      validRequest({ expectedRevision: null }),
      validRequest({ entryId: 'short' }),
      validRequest({ entryId: null }),
      validRequest({ nowIso: '2026-10-27T10:00:00' }),
      validRequest({ nowIso: 42 }),
      validRequest({ extra: 'field' }),
      validRequest({ via: 'web', mode: undefined, expectedRevision: undefined }),
    ];
    for (const bad of refusing) {
      await expect(stop.requestLaneRunStop(bad as never)).resolves.toEqual({
        outcome: 'refused',
        reason: 'invalid-request',
      });
    }
    const hostile = {
      get runId(): string {
        throw new Error('getter must never run');
      },
      mode: 'graceful',
      via: 'web',
      entryId: ulid(1),
      nowIso: NOW,
    };
    await expect(stop.requestLaneRunStop(hostile as never)).resolves.toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
  });

  it('never echoes secret-shaped or path-shaped runId or entryId values in refusals', async () => {
    const stop = useCase([runRecord()]);
    // Built at runtime so no literal credential pattern ever sits in source.
    const secretRunId = ['ghp', 'x'.repeat(28)].join('_');
    const pathRunId = '../../etc/passwd';
    const secretEntryId = ['sk', 'y'.repeat(30)].join('-');
    const results = [
      await stop.requestLaneRunStop(validRequest({ runId: secretRunId }) as never),
      await stop.requestLaneRunStop(validRequest({ runId: pathRunId }) as never),
      await stop.requestLaneRunStop(validRequest({ entryId: secretEntryId }) as never),
      await stop.requestLaneRunStop(validRequest({ runId: 'run-01JC0000000000000000000000' }) as never),
    ];
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(secretRunId);
      expect(JSON.stringify(result)).not.toContain('passwd');
      expect(JSON.stringify(result)).not.toContain(secretEntryId);
    }
  });
});
