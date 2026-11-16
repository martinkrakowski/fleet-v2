import { describe, expect, it } from 'vitest';

import {
  LANE_USAGE_LOG_COST_BASES,
  LANE_USAGE_LOG_MAX_FILE_BYTES,
  LANE_USAGE_LOG_MAX_ROWS,
  LANE_USAGE_LOG_SCHEMA_VERSION,
  buildLaneUsageLogRow,
  parseLaneUsageLogRow,
  serializeLaneUsageLogHeader,
  serializeLaneUsageLogRow,
  worktreeNameFromPath,
  type LaneUsageLogRow,
} from '../lane-usage-log.js';
import type { AttemptRecord, AttemptUsageRecord } from '../execution-records.js';

function meteredUsage(overrides: Partial<AttemptUsageRecord> = {}): AttemptUsageRecord {
  return {
    source: 'opencode-db',
    readAtIso: '2026-11-16T09:00:00.000Z',
    sessionId: 'session-1',
    steps: 42,
    wallSeconds: 305,
    runnerMinutes: 6,
    tokensInput: 1000,
    tokensOutput: 200,
    tokensReasoning: 50,
    tokensCacheRead: 300,
    tokensCacheWrite: 400,
    costUsd: 0.1234,
    model: 'openai/gpt-6-luna',
    agent: 'implementer',
    reason: null,
    ...overrides,
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    workOrderId: 'wo-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: '/lanes/run-1/attempt-1',
    baseCommit: 'abc123',
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: null,
    runner: { kind: 'opencode', remotePort: 4097, host: 'lane-host', hostName: 'lane-host', agent: 'implementer', model: 'openai/gpt-6-luna', variant: null },
    usage: meteredUsage(),
    stopReason: 'none',
    createdAtIso: '2026-11-16T08:00:00.000Z',
    updatedAtIso: '2026-11-16T09:00:00.000Z',
    ...overrides,
  };
}

const NOW_ISO = '2026-11-16T09:05:00.000Z';

function build(overrides: Partial<AttemptRecord> = {}, runId: string | null = 'run-1') {
  return buildLaneUsageLogRow({ attempt: attempt(overrides), runId, nowIso: NOW_ISO });
}

// Synthetic, deliberately non-credential fixtures: each string matches one
// legacy secret *shape* only, so the secret-shape refusals are exercised.
// None of them is a real token; they are assembled from parts to say so.
const SECRET_SHAPED = {
  githubToken: ['ghp', '_0123456789abcdefghijklmn'].join(''),
  awsAccessKey: ['AKIA', '0123456789ABCDEF'].join(''),
  openaiKey: ['sk', '-0123456789abcdefghijklmn'].join(''),
  slackToken: ['xoxb', '-0123456789ab'].join(''),
};

describe('LaneUsageLogRow building', () => {
  it('builds a metered row for an opencode attempt with usage', () => {
    const row = build();
    expect(row).toEqual({
      schemaVersion: 1,
      attemptId: 'attempt-1',
      workOrderId: 'wo-1',
      runId: 'run-1',
      worktreeName: 'attempt-1',
      kind: 'initial',
      fixNumber: 0,
      outcome: 'done',
      stopReason: 'none',
      runnerKind: 'opencode',
      billing: 'metered',
      seatRole: null,
      model: 'openai/gpt-6-luna',
      agent: 'implementer',
      source: 'opencode-db',
      steps: 42,
      wallSeconds: 305,
      runnerMinutes: 6,
      tokensInput: 1000,
      tokensOutput: 200,
      tokensReasoning: 50,
      tokensCacheRead: 300,
      tokensCacheWrite: 400,
      costUsd: 0.1234,
      costBasis: 'metered',
      recordedAtIso: NOW_ISO,
      reason: null,
    });
  });

  it('builds a plan-estimate row for an agy attempt without usage', () => {
    const row = build({
      runner: { kind: 'agy', remotePort: null, host: null, hostName: null, agent: null, model: 'agy/gemini', variant: null },
      usage: null,
      outcome: 'no-commit',
      stopReason: 'no-commit',
    }, null);
    expect(row?.billing).toBe('plan');
    expect(row?.costBasis).toBe('unknown');
    expect(row?.runId).toBeNull();
    expect(row?.source).toBe('unavailable');
    expect(row?.costUsd).toBeNull();
    expect(row?.runnerMinutes).toBeNull();
  });

  it('derives costBasis plan-estimate for an agy attempt with a cost', () => {
    const row = build({
      runner: { kind: 'agy', remotePort: null, host: null, hostName: null, agent: null, model: 'agy/gemini', variant: null },
      usage: meteredUsage({ costUsd: 0.5 }),
    });
    expect(row?.billing).toBe('plan');
    expect(row?.costBasis).toBe('plan-estimate');
  });

  it('writes one unavailable usage row with unknown cost basis when usage read fails', () => {
    const row = build({
      usage: {
        source: 'unavailable',
        readAtIso: NOW_ISO,
        sessionId: null,
        steps: null,
        wallSeconds: null,
        runnerMinutes: null,
        tokensInput: null,
        tokensOutput: null,
        tokensReasoning: null,
        tokensCacheRead: null,
        tokensCacheWrite: null,
        costUsd: null,
        model: null,
        agent: null,
        reason: 'usage read failed',
      },
    });
    expect(row?.source).toBe('unavailable');
    expect(row?.costBasis).toBe('unknown');
    expect(row?.reason).toBeNull();
    expect(row?.steps).toBeNull();
  });

  it('never carries the usage reason text, even benign diagnostic detail', () => {
    const row = build({
      usage: meteredUsage({ reason: 'opencode db missing: stderr line one\nstderr line two' }),
    });
    expect(row?.reason).toBeNull();
  });

  it('carries seatRole from the seat selection', () => {
    const row = build({
      seatSelection: {
        role: 'first-pass',
        seatIndex: 0,
        seatId: 'seat-1',
        model: 'openai/gpt-6-luna',
        tool: 'opencode', agent: null,
        variant: null,
      },
    });
    expect(row?.seatRole).toBe('first-pass');
  });

  it('derives runnerMinutes from wallSeconds when the record lacks the field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { runnerMinutes, ...rest } = meteredUsage();
    const row = build({ usage: rest as AttemptUsageRecord });
    expect(row?.runnerMinutes).toBe(6);
  });

  it('nulls a hostile model id instead of carrying it', () => {
    const row = build({ usage: meteredUsage({ model: 'http://host:4097/x#frag' }) });
    expect(row?.model).toBeNull();
  });
});

describe('worktreeNameFromPath', () => {
  it('extracts only the final segment from a parent path', () => {
    expect(worktreeNameFromPath('/lanes/run-1/wt-9')).toBe('wt-9');
    expect(worktreeNameFromPath('/a/b/c/deep-name/')).toBe('deep-name');
    expect(worktreeNameFromPath('C:\\lanes\\wt-2')).toBe('wt-2');
    expect(worktreeNameFromPath('wt-3')).toBe('wt-3');
    expect(worktreeNameFromPath('/a/')).toBe('a');
  });

  it('refuses parent segments, dot segments, control characters and secret shapes', () => {
    expect(worktreeNameFromPath('/a/..')).toBeNull();
    expect(worktreeNameFromPath('/a/.')).toBeNull();
    expect(worktreeNameFromPath('/a/wt\n1')).toBeNull();
    expect(worktreeNameFromPath('/a/wt\u0000')).toBeNull();
    expect(worktreeNameFromPath(`/a/${SECRET_SHAPED.githubToken}`)).toBeNull();
  });

  it('refuses non-string and empty input', () => {
    expect(worktreeNameFromPath(null)).toBeNull();
    expect(worktreeNameFromPath(undefined)).toBeNull();
    expect(worktreeNameFromPath(42)).toBeNull();
    expect(worktreeNameFromPath('')).toBeNull();
    expect(worktreeNameFromPath('//')).toBeNull();
  });

  it('stays bounded on an enormous input without splitting it', () => {
    // A megabyte of parent directories must cost a bounded scan, not a split
    // of the whole string, and must still yield the final segment.
    const deep = `/a${'/b'.repeat(500_000)}/wt-deep`;
    expect(worktreeNameFromPath(deep)).toBe('wt-deep');
    // A single over-long segment is refused, however short the prefix is.
    expect(worktreeNameFromPath(`/a/${'x'.repeat(100_000)}`)).toBeNull();
    expect(worktreeNameFromPath('x'.repeat(1_000_000))).toBeNull();
  });

  it('refuses a 513-character final segment and accepts the 512-character one', () => {
    // The whole scan shares one budget of MAX_TEXT_LENGTH + 1 examined
    // characters, so a segment one character over the limit is refused even
    // when a separator sits right before it.
    expect(worktreeNameFromPath(`/a/${'x'.repeat(513)}`)).toBeNull();
    expect(worktreeNameFromPath(`wt-${'x'.repeat(509)}`)).toBe(`wt-${'x'.repeat(509)}`);
    expect(worktreeNameFromPath(`/a/${'x'.repeat(512)}`)).toBe('x'.repeat(512));
  });

  it('refuses a long trailing separator run instead of scanning it to its start', () => {
    // Skipping trailing separators shares the same bounded budget as the
    // rest of the scan: a run far longer than the window is refused, never
    // walked character by character to its beginning.
    expect(worktreeNameFromPath(`/a/wt${'/'.repeat(100_000)}`)).toBeNull();
    // A run of separators *before* the final segment costs nothing: the
    // backwards scan reaches the segment first.
    expect(worktreeNameFromPath(`/${'/'.repeat(100_000)}wt`)).toBe('wt');
    // A short trailing run still yields the final segment.
    expect(worktreeNameFromPath('/a/wt///')).toBe('wt');
  });
});

describe('buildLaneUsageLogRow refusals', () => {
  it('returns null on null, undefined and non-object input', () => {
    expect(buildLaneUsageLogRow(null as never)).toBeNull();
    expect(buildLaneUsageLogRow(undefined as never)).toBeNull();
    expect(buildLaneUsageLogRow('attempt' as never)).toBeNull();
    expect(buildLaneUsageLogRow([] as never)).toBeNull();
  });

  it('returns null on a null attempt', () => {
    expect(buildLaneUsageLogRow({ attempt: null as never, nowIso: NOW_ISO })).toBeNull();
  });

  it('returns null without invoking or propagating a throwing getter', () => {
    let calls = 0;
    const hostile = attempt();
    Object.defineProperty(hostile, 'worktreePath', {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error('getter boom');
      },
    });
    expect(buildLaneUsageLogRow({ attempt: hostile, nowIso: NOW_ISO })).toBeNull();
    expect(calls).toBe(1);
  });

  it('returns null on an invalid recordedAtIso', () => {
    expect(buildLaneUsageLogRow({ attempt: attempt(), nowIso: 'not-a-date' })).toBeNull();
    expect(buildLaneUsageLogRow({ attempt: attempt(), nowIso: '2026-02-31T09:00:00.000Z' })).toBeNull();
    expect(buildLaneUsageLogRow({ attempt: attempt(), nowIso: 42 as never })).toBeNull();
  });

  it('returns null on a secret-shaped attempt id, work order id or run id', () => {
    expect(build({ id: SECRET_SHAPED.openaiKey } as Partial<AttemptRecord>)).toBeNull();
    expect(build({ workOrderId: SECRET_SHAPED.slackToken } as Partial<AttemptRecord>)).toBeNull();
    expect(buildLaneUsageLogRow({
      attempt: attempt(),
      runId: SECRET_SHAPED.githubToken,
      nowIso: NOW_ISO,
    })).toBeNull();
  });

  it('returns null on an unknown kind, a negative fixNumber or a control character', () => {
    expect(build({ kind: 'weird' } as unknown as Partial<AttemptRecord>)).toBeNull();
    expect(build({ fixNumber: -1 })).toBeNull();
    expect(build({ id: 'a\nb' })).toBeNull();
  });
});

describe('parseLaneUsageLogRow', () => {
  it('round-trips a built row', () => {
    const row = build();
    const parsed = parseLaneUsageLogRow(JSON.parse(serializeLaneUsageLogRow(row as LaneUsageLogRow) as string));
    expect(parsed).toEqual(row);
  });

  it('returns null for an array input, null, and primitives', () => {
    expect(parseLaneUsageLogRow([])).toBeNull();
    expect(parseLaneUsageLogRow(null)).toBeNull();
    expect(parseLaneUsageLogRow(undefined)).toBeNull();
    expect(parseLaneUsageLogRow('row')).toBeNull();
    expect(parseLaneUsageLogRow(42)).toBeNull();
  });

  it('returns null on missing keys, extra keys, or non-finite and negative numbers', () => {
    const row = build() as LaneUsageLogRow;
    const full = { ...row };
    const withMissing = { ...full } as Record<string, unknown>;
    delete withMissing.model;
    expect(parseLaneUsageLogRow(withMissing)).toBeNull();
    expect(parseLaneUsageLogRow({ ...full, extra: 1 })).toBeNull();
    expect(parseLaneUsageLogRow({ ...full, steps: -1 })).toBeNull();
    expect(parseLaneUsageLogRow({ ...full, costUsd: Number.NaN })).toBeNull();
    expect(parseLaneUsageLogRow({ ...full, tokensInput: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('returns null on a wrong primitive type or wrong enum value', () => {
    const row = build() as LaneUsageLogRow;
    expect(parseLaneUsageLogRow({ ...row, schemaVersion: 2 })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, kind: 'fixx' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, fixNumber: '0' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, costBasis: 'metered-extra' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, source: 'elsewhere' })).toBeNull();
  });

  it('returns null on a non-canonical recordedAtIso, a worktreeName with a separator or a secret shape', () => {
    const row = build() as LaneUsageLogRow;
    expect(parseLaneUsageLogRow({ ...row, recordedAtIso: '2026-11-16 09:00:00' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, worktreeName: 'a/b' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, worktreeName: 'wt\u0000' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, worktreeName: '..' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, model: SECRET_SHAPED.awsAccessKey })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, reason: 'line\nbreak' })).toBeNull();
  });

  it('returns null on an inconsistent costBasis for its billing and cost', () => {
    const row = build() as LaneUsageLogRow;
    // metered billing with a cost must derive costBasis 'metered'.
    expect(parseLaneUsageLogRow({ ...row, billing: 'metered', costUsd: 0.01, costBasis: 'plan-estimate' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, billing: 'metered', costUsd: 0.01, costBasis: 'unknown' })).toBeNull();
    // no cost must always derive 'unknown'.
    expect(parseLaneUsageLogRow({ ...row, billing: 'metered', costUsd: null, costBasis: 'metered' })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, billing: 'plan', costUsd: null, costBasis: 'plan-estimate' })).toBeNull();
    // plan billing with a cost must derive 'plan-estimate'.
    expect(parseLaneUsageLogRow({ ...row, billing: 'plan', costUsd: 0.01, costBasis: 'metered' })).toBeNull();
    // each consistent combination still parses.
    expect(parseLaneUsageLogRow({ ...row, billing: 'metered', costUsd: 0.01, costBasis: 'metered' })).not.toBeNull();
    expect(parseLaneUsageLogRow({ ...row, billing: 'plan', costUsd: 0.01, costBasis: 'plan-estimate' })).not.toBeNull();
    expect(parseLaneUsageLogRow({ ...row, billing: 'plan', costUsd: null, costBasis: 'unknown' })).not.toBeNull();
  });

  it('returns null on a worktreeName longer than the text bound', () => {
    const row = build() as LaneUsageLogRow;
    expect(parseLaneUsageLogRow({ ...row, worktreeName: 'a'.repeat(512) })).not.toBeNull();
    expect(parseLaneUsageLogRow({ ...row, worktreeName: 'a'.repeat(513) })).toBeNull();
    expect(parseLaneUsageLogRow({ ...row, worktreeName: 'a'.repeat(100_000) })).toBeNull();
  });

  it('returns null without invoking or propagating a throwing getter', () => {
    let calls = 0;
    const hostile: Record<string, unknown> = {};
    for (const key of ['schemaVersion', 'attemptId', 'workOrderId', 'runId', 'worktreeName', 'kind', 'fixNumber', 'outcome', 'stopReason', 'runnerKind', 'billing', 'seatRole', 'model', 'agent', 'source', 'steps', 'wallSeconds', 'runnerMinutes', 'tokensInput', 'tokensOutput', 'tokensReasoning', 'tokensCacheRead', 'tokensCacheWrite', 'costUsd', 'costBasis', 'recordedAtIso', 'reason']) {
      Object.defineProperty(hostile, key, {
        enumerable: true,
        get() {
          calls += 1;
          return undefined;
        },
      });
    }
    expect(parseLaneUsageLogRow(hostile)).toBeNull();
    expect(calls).toBe(0);
  });

  it('returns null on a hostile object with a lying prototype-polluting key', () => {
    const row = build() as LaneUsageLogRow;
    const polluted = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
    polluted.extra = { __proto__: { polluted: true }, constructor: 'x', prototype: 'y' };
    expect(parseLaneUsageLogRow(polluted)).toBeNull();
  });
});

describe('serialization', () => {
  it('serializes the versioned header', () => {
    expect(serializeLaneUsageLogHeader()).toBe('{"schemaVersion":1}');
    expect(LANE_USAGE_LOG_SCHEMA_VERSION).toBe(1);
  });

  it('never includes parent paths, host names, tokens, or prompt text in serialized rows', () => {
    const row = build({
      worktreePath: '/secret-host/lanes/run-1/attempt-1',
      runner: { kind: 'opencode', remotePort: 4097, host: 'secret-host-1', hostName: 'secret-host-1', agent: 'implementer', model: 'openai/gpt-6-luna', variant: null },
      usage: meteredUsage({
        sessionId: 'session-1',
        reason: `read failed with token ${SECRET_SHAPED.githubToken}`,
      }),
    });
    const line = serializeLaneUsageLogRow(row as LaneUsageLogRow);
    expect(line).not.toBeNull();
    expect(line).not.toContain('worktreePath');
    expect(line).not.toContain('/secret-host');
    expect(line).not.toContain('secret-host-1');
    expect(line).not.toContain('4097');
    expect(line).not.toContain('session-1');
    expect(line).not.toContain(SECRET_SHAPED.githubToken.slice(0, 8));
    expect(line).not.toContain('briefPackagePath');
    expect(line).not.toContain('manifestPath');
  });

  it('returns null instead of serializing a hostile row', () => {
    expect(serializeLaneUsageLogRow(null as never)).toBeNull();
    expect(serializeLaneUsageLogRow({} as never)).toBeNull();
    expect(serializeLaneUsageLogRow([] as never)).toBeNull();
    expect(serializeLaneUsageLogRow({ ...build(), schemaVersion: 2 } as never)).toBeNull();
  });

  it('pins the store bounds and cost bases', () => {
    expect(LANE_USAGE_LOG_MAX_ROWS).toBe(20_000);
    expect(LANE_USAGE_LOG_MAX_FILE_BYTES).toBe(4 * 1024 * 1024);
    expect(LANE_USAGE_LOG_COST_BASES).toEqual(['metered', 'plan-estimate', 'unknown']);
  });
});
