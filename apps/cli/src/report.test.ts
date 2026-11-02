import { describe, expect, it } from 'vitest';
import type { LaneRunJournalEntryRecord } from '@fleet/work-execution';

import { reportCommand } from './report.js';
import type { FleetCliRuntime } from './composition.js';
import type { CliIo } from './index.js';

interface MockAttentionItem {
  readonly item: {
    readonly kind: 'conductor-park';
    readonly subject: {
      readonly kind: 'run';
      readonly ref: string;
    };
    readonly firstRaisedAtIso: string;
  };
}

function createMockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

function createReportRuntime(
  runs: readonly { readonly runId: string }[],
  entriesByRun: ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>,
  items: readonly MockAttentionItem[] = [],
): FleetCliRuntime {
  return {
    conductor: {
      laneRunRepository: {
        list: async () => runs,
      },
      laneRunJournal: {
        listForRuns: async (_runIds: readonly string[]) => entriesByRun,
      },
    },
    coordination: {
      listAttentionItems: {
        listAttentionItems: async () => ({ items }),
      },
    },
  } as unknown as FleetCliRuntime;
}

describe('reportCommand', () => {
  const fixedNow = new Date('2026-10-15T12:00:00.000Z');
  const runId = 'run-01HZX000000000000000000000';

  it('selects earliest prepare result by recordedAtIso when appended out of order', async () => {
    // First in append order has later timestamp (10:05), second has earlier (10:00).
    const prepareFirstAppended: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000001',
      kind: 'result',
      key: `${runId}/r0/prepare/0`,
      runId,
      recordedAtIso: '2026-10-15T10:05:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: 'completed',
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    const prepareLaterAppended: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000002',
      kind: 'result',
      key: `${runId}/r0/prepare/0`,
      runId,
      recordedAtIso: '2026-10-15T10:00:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: 'completed',
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    const dispatchIntent: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000003',
      kind: 'intent',
      key: `${runId}/r0/dispatch/0`,
      runId,
      recordedAtIso: '2026-10-15T10:10:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };

    const entriesByRun = new Map<string, readonly LaneRunJournalEntryRecord[]>([
      [runId, [prepareFirstAppended, prepareLaterAppended, dispatchIntent]],
    ]);
    const runtime = createReportRuntime([{ runId }], entriesByRun);
    const { io, stdout, stderr } = createMockIo();

    const exitCode = await reportCommand(['weekly'], io, runtime, { now: () => fixedNow });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const doc = JSON.parse(stdout.join(''));
    expect(doc.outcome).toBe('completed');
    expect(doc.admissionWait.status).toBe('measured');
    expect(doc.admissionWait.samples).toBe(1);
    // 10:10:00 minus 10:00:00 = 600,000 ms. If append order were used: 10:10:00 - 10:05:00 = 300,000 ms.
    expect(doc.admissionWait.p95Ms).toBe(600_000);
  });

  it('selects earliest dispatch intent by recordedAtIso when appended out of order', async () => {
    const prepareResult: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000001',
      kind: 'result',
      key: `${runId}/r0/prepare/0`,
      runId,
      recordedAtIso: '2026-10-15T10:00:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: 'completed',
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    // First in append order has later dispatch (10:15), second has earlier (10:10).
    const dispatchFirstAppended: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000002',
      kind: 'intent',
      key: `${runId}/r0/dispatch/0`,
      runId,
      recordedAtIso: '2026-10-15T10:15:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };
    const dispatchLaterAppended: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000003',
      kind: 'intent',
      key: `${runId}/r0/dispatch/0`,
      runId,
      recordedAtIso: '2026-10-15T10:10:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: null,
    };

    const entriesByRun = new Map<string, readonly LaneRunJournalEntryRecord[]>([
      [runId, [prepareResult, dispatchFirstAppended, dispatchLaterAppended]],
    ]);
    const runtime = createReportRuntime([{ runId }], entriesByRun);
    const { io, stdout } = createMockIo();

    const exitCode = await reportCommand(['weekly'], io, runtime, { now: () => fixedNow });

    expect(exitCode).toBe(0);
    const doc = JSON.parse(stdout.join(''));
    expect(doc.admissionWait.status).toBe('measured');
    expect(doc.admissionWait.samples).toBe(1);
    // 10:10:00 minus 10:00:00 = 600,000 ms. If append order were used: 10:15:00 - 10:00:00 = 900,000 ms.
    expect(doc.admissionWait.p95Ms).toBe(600_000);
  });

  it('selects earliest parked conduct entry by recordedAtIso and does not drop valid sample', async () => {
    // First in append order has timestamp after notice raise (10:15), which would yield negative interval.
    // Second in append order has earlier timestamp (10:00), yielding a valid 600,000 ms interval.
    const parkFirstAppended: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000011',
      kind: 'conduct',
      key: null,
      runId,
      recordedAtIso: '2026-10-15T10:15:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: 'parked',
    };
    const parkLaterAppended: LaneRunJournalEntryRecord = {
      version: 1,
      entryId: '01HZX000000000000000000012',
      kind: 'conduct',
      key: null,
      runId,
      recordedAtIso: '2026-10-15T10:00:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: 'parked',
    };

    const attentionItem: MockAttentionItem = {
      item: {
        kind: 'conductor-park',
        subject: {
          kind: 'run',
          ref: runId,
        },
        firstRaisedAtIso: '2026-10-15T10:10:00.000Z',
      },
    };

    const entriesByRun = new Map<string, readonly LaneRunJournalEntryRecord[]>([
      [runId, [parkFirstAppended, parkLaterAppended]],
    ]);
    const runtime = createReportRuntime([{ runId }], entriesByRun, [attentionItem]);
    const { io, stdout } = createMockIo();

    const exitCode = await reportCommand(['weekly'], io, runtime, { now: () => fixedNow });

    expect(exitCode).toBe(0);
    const doc = JSON.parse(stdout.join(''));
    expect(doc.parkToNotify.status).toBe('measured');
    // Without the fix, 10:15:00 yields negative interval (-5 min) and sample is dropped (samples = 0, p95Ms = null).
    expect(doc.parkToNotify.samples).toBe(1);
    expect(doc.parkToNotify.p95Ms).toBe(600_000);
  });

  it('exits 2 on unknown report subcommand with fixed error message', async () => {
    const runtime = createReportRuntime([], new Map());
    const { io, stderr } = createMockIo();

    const exitCode = await reportCommand(['bogus'], io, runtime, { now: () => fixedNow });

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toBe('Unknown report subcommand\n');
  });
});
