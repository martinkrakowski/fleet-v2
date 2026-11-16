import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LANE_USAGE_LOG_SCHEMA_VERSION,
  buildLaneUsageLogRow,
  serializeLaneUsageLogRow,
  type LaneUsageLogRow,
} from '../../../domain/lane-usage-log.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import { LaneUsageLogFileAdapter } from '../LaneUsageLogFileAdapter.adapter.js';

const NOW_ISO = '2026-11-16T09:05:00.000Z';

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
    briefDigest: null,
    briefPackagePath: null,
    sessionId: null,
    completionReceipt: null,
    artifacts: null,
    runner: { kind: 'opencode', remotePort: null, host: null, hostName: null, agent: null, model: null, variant: null },
    usage: {
      source: 'opencode-db',
      readAtIso: NOW_ISO,
      sessionId: null,
      steps: 3,
      wallSeconds: 60,
      runnerMinutes: 1,
      tokensInput: 10,
      tokensOutput: 5,
      tokensReasoning: null,
      tokensCacheRead: null,
      tokensCacheWrite: null,
      costUsd: 0.01,
      model: 'openai/gpt-6-luna',
      agent: null,
      reason: null,
    },
    createdAtIso: NOW_ISO,
    updatedAtIso: NOW_ISO,
    ...overrides,
  };
}

function row(id = 'attempt-1', overrides: Partial<AttemptRecord> = {}): LaneUsageLogRow {
  const built = buildLaneUsageLogRow({
    attempt: attempt({ id, ...overrides }),
    nowIso: NOW_ISO,
  });
  if (built === null) {
    throw new Error('test row must build');
  }
  return built;
}

const workspaceDirs: string[] = [];

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-lane-usage-'));
  workspaceDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (workspaceDirs.length > 0) {
    const dir = workspaceDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function targetPath(stateDir: string): string {
  return join(stateDir, 'telemetry', 'lane-usage.jsonl');
}

describe('LaneUsageLogFileAdapter', () => {
  it('appends and reads back on disk', async () => {
    const stateDir = await tempStateDir();
    const adapter = new LaneUsageLogFileAdapter({ stateDir });
    expect(await adapter.append(row())).toEqual({ outcome: 'appended' });
    expect(await adapter.read()).toEqual({ outcome: 'read', rows: [row()] });
    const file = await readFile(targetPath(stateDir), 'utf8');
    expect(file.split('\n')[0]).toBe('{"schemaVersion":1}');
    expect(file.trimEnd().split('\n')).toHaveLength(2);
  });

  it('round-trips in memory without a stateDir', async () => {
    const adapter = new LaneUsageLogFileAdapter();
    expect(await adapter.read()).toEqual({ outcome: 'read', rows: [] });
    expect(await adapter.append(row())).toEqual({ outcome: 'appended' });
    expect(await adapter.read()).toEqual({ outcome: 'read', rows: [row()] });
  });

  it('returns duplicate and writes only one row per attemptId', async () => {
    for (const stateDir of [await tempStateDir(), undefined]) {
      const adapter = new LaneUsageLogFileAdapter(stateDir === undefined ? {} : { stateDir });
      expect(await adapter.append(row())).toEqual({ outcome: 'appended' });
      expect(await adapter.append(row())).toEqual({ outcome: 'duplicate' });
      expect(await adapter.read()).toEqual({ outcome: 'read', rows: [row()] });
    }
  });

  it('returns refused invalid-row on null input and hostile rows', async () => {
    const adapter = new LaneUsageLogFileAdapter();
    expect(await adapter.append(null as never)).toEqual({ outcome: 'refused', reason: 'invalid-row' });
    expect(await adapter.append([] as never)).toEqual({ outcome: 'refused', reason: 'invalid-row' });
    expect(await adapter.append({ schemaVersion: 2 } as never)).toEqual({
      outcome: 'refused', reason: 'invalid-row',
    });
  });

  it('returns lock-timeout when file lock cannot be acquired', async () => {
    const stateDir = await tempStateDir();
    const target = targetPath(stateDir);
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    await writeFile(`${target}.lock`, 'held-by-someone-else', 'utf8');
    const adapter = new LaneUsageLogFileAdapter({ stateDir, lockTimeoutMs: 50 });
    expect(await adapter.append(row())).toEqual({ outcome: 'refused', reason: 'lock-timeout' });
  });

  it('returns log-budget-exhausted when max rows or max bytes is reached', async () => {
    const fullRows = new LaneUsageLogFileAdapter({ maxRows: 1 });
    expect(await fullRows.append(row('attempt-1'))).toEqual({ outcome: 'appended' });
    expect(await fullRows.append(row('attempt-2'))).toEqual({
      outcome: 'refused', reason: 'log-budget-exhausted',
    });

    const stateDir = await tempStateDir();
    const rowsAdapter = new LaneUsageLogFileAdapter({ stateDir, maxRows: 1 });
    expect(await rowsAdapter.append(row('attempt-1'))).toEqual({ outcome: 'appended' });
    expect(await rowsAdapter.append(row('attempt-2'))).toEqual({
      outcome: 'refused', reason: 'log-budget-exhausted',
    });

    const bytesStateDir = await tempStateDir();
    const headerBytes = Buffer.byteLength('{"schemaVersion":1}\n', 'utf8');
    const tinyBytes = Buffer.byteLength(serializeLaneUsageLogRow(row()) + '\n', 'utf8');
    const bytesAdapter = new LaneUsageLogFileAdapter({
      stateDir: bytesStateDir, maxFileBytes: headerBytes + tinyBytes, maxRows: 100,
    });
    expect(await bytesAdapter.append(row('attempt-1'))).toEqual({ outcome: 'appended' });
    expect(await bytesAdapter.append(row('attempt-2'))).toEqual({
      outcome: 'refused', reason: 'log-budget-exhausted',
    });
  });

  it('refuses the first append when header and row exceed the byte budget', async () => {
    const stateDir = await tempStateDir();
    const rowBytes = Buffer.byteLength(serializeLaneUsageLogRow(row()) + '\n', 'utf8');
    const adapter = new LaneUsageLogFileAdapter({
      stateDir, maxFileBytes: rowBytes, maxRows: 100,
    });
    expect(await adapter.append(row())).toEqual({ outcome: 'refused', reason: 'log-budget-exhausted' });
    // Nothing was written: the store is still absent.
    await expect(adapter.read()).resolves.toEqual({ outcome: 'read', rows: [] });
  });

  it('refuses an append onto an existing file already larger than the byte budget', async () => {
    const stateDir = await tempStateDir();
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    await writeFile(targetPath(stateDir), `{"schemaVersion":1}\n${'x'.repeat(64)}\n`, 'utf8');
    const adapter = new LaneUsageLogFileAdapter({ stateDir, maxFileBytes: 32, maxRows: 100 });
    expect(await adapter.append(row())).toEqual({ outcome: 'refused', reason: 'log-budget-exhausted' });
  });

  it('enforces the byte budget in memory too', async () => {
    const rowBytes = Buffer.byteLength(serializeLaneUsageLogRow(row()) + '\n', 'utf8');
    const adapter = new LaneUsageLogFileAdapter({ maxFileBytes: rowBytes, maxRows: 100 });
    expect(await adapter.append(row())).toEqual({ outcome: 'appended' });
    expect(await adapter.append(row('attempt-2'))).toEqual({
      outcome: 'refused', reason: 'log-budget-exhausted',
    });
    const tiny = new LaneUsageLogFileAdapter({ maxFileBytes: rowBytes - 1, maxRows: 100 });
    expect(await tiny.append(row())).toEqual({ outcome: 'refused', reason: 'log-budget-exhausted' });
    expect(await tiny.read()).toEqual({ outcome: 'read', rows: [] });
  });

  it('returns store-unreadable when log file cannot be read', async () => {
    const stateDir = await tempStateDir();
    await mkdir(targetPath(stateDir), { recursive: true });
    const adapter = new LaneUsageLogFileAdapter({ stateDir });
    expect(await adapter.read()).toEqual({ outcome: 'unreadable', reason: 'store-unreadable' });
    expect(await adapter.append(row())).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
  });

  it('reports store-unreadable for read and append when the log path is a symlink to a valid log', async () => {
    const stateDir = await tempStateDir();
    const realDir = await tempStateDir();
    const realFile = join(realDir, 'real.jsonl');
    const good = new LaneUsageLogFileAdapter({ stateDir: realDir, fileName: 'real.jsonl' });
    expect(await good.append(row())).toEqual({ outcome: 'appended' });
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    await symlink(realFile, targetPath(stateDir));
    const adapter = new LaneUsageLogFileAdapter({ stateDir });
    expect(await adapter.read()).toEqual({ outcome: 'unreadable', reason: 'store-unreadable' });
    expect(await adapter.append(row('attempt-2'))).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
  });

  it('regression: a read of a file already larger than the byte cap reports store-unreadable (does not prove the grow-after-open bound)', async () => {
    const stateDir = await tempStateDir();
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    await writeFile(targetPath(stateDir), `{"schemaVersion":1}\n${'x'.repeat(64)}\n`, 'utf8');
    const adapter = new LaneUsageLogFileAdapter({ stateDir, maxFileBytes: 32, maxRows: 100 });
    expect(await adapter.read()).toEqual({ outcome: 'unreadable', reason: 'store-unreadable' });
  });

  it('returns unreadable invalid-header on a wrong header line', async () => {
    const stateDir = await tempStateDir();
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    await writeFile(targetPath(stateDir), '{"schemaVersion":2}\n', 'utf8');
    const adapter = new LaneUsageLogFileAdapter({ stateDir });
    expect(await adapter.read()).toEqual({ outcome: 'unreadable', reason: 'invalid-header' });
    expect(await adapter.append(row())).toEqual({ outcome: 'refused', reason: 'store-unreadable' });
  });

  it('returns malformed-row with lineNumber on corrupt JSONL line', async () => {
    const stateDir = await tempStateDir();
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    const goodLine = serializeLaneUsageLogRow(row('attempt-1'));
    const lines = ['{"schemaVersion":1}', goodLine, '{not json', serializeLaneUsageLogRow(row('attempt-2'))];
    await writeFile(targetPath(stateDir), lines.join('\n') + '\n', 'utf8');
    const adapter = new LaneUsageLogFileAdapter({ stateDir });
    expect(await adapter.read()).toEqual({
      outcome: 'unreadable', reason: 'malformed-row', lineNumber: 3,
    });
  });

  it('returns malformed-row with lineNumber for a JSON array line', async () => {
    const stateDir = await tempStateDir();
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    await writeFile(
      targetPath(stateDir),
      ['{"schemaVersion":1}', JSON.stringify([1, 2, 3])].join('\n') + '\n',
      'utf8',
    );
    const adapter = new LaneUsageLogFileAdapter({ stateDir });
    expect(await adapter.read()).toEqual({
      outcome: 'unreadable', reason: 'malformed-row', lineNumber: 2,
    });
  });

  it('returns malformed-row with lineNumber on a valid-JSON row with extra keys', async () => {
    const stateDir = await tempStateDir();
    await mkdir(join(stateDir, 'telemetry'), { recursive: true });
    const padded = JSON.stringify({ ...row('attempt-1'), extra: 'nope' });
    await writeFile(targetPath(stateDir), `{"schemaVersion":1}\n${padded}\n`, 'utf8');
    const adapter = new LaneUsageLogFileAdapter({ stateDir });
    expect(await adapter.read()).toEqual({
      outcome: 'unreadable', reason: 'malformed-row', lineNumber: 2,
    });
  });

  it('carries the pinned schema version', () => {
    expect(LANE_USAGE_LOG_SCHEMA_VERSION).toBe(1);
  });
});
