import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaneScorecardRow } from '../../../application/ports/out/LaneScorecardPort.out-port.js';
import { LaneScorecardFileAdapter } from '../LaneScorecardFileAdapter.adapter.js';

const HEADER = '{"schemaVersion":1}';

function row(runId: string, overrides: Partial<LaneScorecardRow> = {}): LaneScorecardRow {
  return {
    runId,
    workOrderId: 'wo-example-1',
    tier: 2,
    finalState: 'merged',
    fixRounds: 1,
    attemptCount: 2,
    parkCount: 0,
    prNumber: 42,
    firstPassCompleted: false,
    reviewFindings: { blocker: 0, major: 1, minor: 2, nit: 3 },
    verificationResult: 'pass',
    durationMs: 120000,
    ...overrides,
  };
}

const RUN_A = 'run-01JB0000000000000000000001';
const RUN_B = 'run-01JB0000000000000000000002';
const RUN_C = 'run-01JB0000000000000000000003';

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lane-scorecard-'));
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

function scorecardFile(): string {
  return path.join(stateDir, 'scorecard', 'scorecard.jsonl');
}

describe('LaneScorecardFileAdapter', () => {
  it('appends one row behind the version header', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    expect(await adapter.append(row(RUN_A))).toEqual({ outcome: 'appended' });
    const lines = (await fs.readFile(scorecardFile(), 'utf8')).split('\n');
    expect(lines[0]).toBe(HEADER);
    expect(JSON.parse(lines[1]!)).toEqual(row(RUN_A));
    expect(lines[2]).toBe('');
    expect(lines).toHaveLength(3);
  });

  it('refuses a duplicate run id', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await adapter.append(row(RUN_A));
    expect(await adapter.append(row(RUN_A, { fixRounds: 2 }))).toEqual({ outcome: 'refused', reason: 'duplicate-run' });
    const read = await adapter.read();
    expect(read).toEqual({ outcome: 'read', rows: [row(RUN_A)], problems: [] });
  });

  it('reads rows in append order', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await adapter.append(row(RUN_B));
    await adapter.append(row(RUN_A));
    await adapter.append(row(RUN_C, { prNumber: null, durationMs: null }));
    const read = await adapter.read();
    expect(read.outcome).toBe('read');
    if (read.outcome === 'read') {
      expect(read.rows.map((stored) => stored.runId)).toEqual([RUN_B, RUN_A, RUN_C]);
      expect(read.rows[2]).toEqual(row(RUN_C, { prNumber: null, durationMs: null }));
      expect(read.problems).toEqual([]);
    }
  });

  it('reports a malformed line by line number', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await adapter.append(row(RUN_A));
    await adapter.append(row(RUN_B));
    await adapter.append(row(RUN_C));
    const lines = (await fs.readFile(scorecardFile(), 'utf8')).split('\n');
    lines[2] = '{"runId": not json';
    await fs.writeFile(scorecardFile(), lines.join('\n'), 'utf8');
    expect(await adapter.read()).toEqual({
      outcome: 'read',
      rows: [row(RUN_A), row(RUN_C)],
      problems: [{ lineNumber: 3, reason: 'malformed-line' }],
    });
  });

  it('reports a row with a wrong shape as a malformed line', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await adapter.append(row(RUN_A));
    const extra = JSON.stringify({ ...row(RUN_B), note: 'free text' });
    const wrongType = JSON.stringify({ ...row(RUN_C), attemptCount: -1 });
    await fs.appendFile(scorecardFile(), `${extra}\n${wrongType}\n[]\n\n`, 'utf8');
    const read = await adapter.read();
    expect(read).toEqual({
      outcome: 'read',
      rows: [row(RUN_A)],
      problems: [
        { lineNumber: 3, reason: 'malformed-line' },
        { lineNumber: 4, reason: 'malformed-line' },
        { lineNumber: 5, reason: 'malformed-line' },
        { lineNumber: 6, reason: 'malformed-line' },
      ],
    });
  });

  it('refuses an append over a file with a malformed line', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await adapter.append(row(RUN_A));
    // A damaged line that still carries a run id is not a row: an append that
    // ignored it could record the same run twice. The store refuses instead.
    const damaged = JSON.stringify({ ...row(RUN_B), attemptCount: 'two' });
    await fs.appendFile(scorecardFile(), `${damaged}\n`, 'utf8');
    expect(await adapter.append(row(RUN_B))).toEqual({ outcome: 'refused', reason: 'unreadable-store' });
    const read = await adapter.read();
    expect(read.outcome === 'read' ? read.problems : []).toEqual([
      { lineNumber: 3, reason: 'malformed-line' },
    ]);
    // The file is unchanged: the repairable damage stays named, not appended over.
    const lines = (await fs.readFile(scorecardFile(), 'utf8')).split('\n');
    expect(lines).toHaveLength(4);
  });

  it('reports an unknown schema version as unreadable', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await fs.mkdir(path.dirname(scorecardFile()), { recursive: true });
    await fs.writeFile(scorecardFile(), `{"schemaVersion":2}\n${JSON.stringify(row(RUN_A))}\n`, 'utf8');
    expect(await adapter.read()).toEqual({ outcome: 'unreadable', reason: 'unknown-schema-version' });
    expect(await adapter.append(row(RUN_B))).toEqual({ outcome: 'refused', reason: 'unknown-schema-version' });
    expect(await fs.readFile(scorecardFile(), 'utf8')).toBe(`{"schemaVersion":2}\n${JSON.stringify(row(RUN_A))}\n`);
  });

  it('reads an absent file as known absence', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    expect(await adapter.read()).toEqual({ outcome: 'absent' });
  });

  it('reports an unreadable file as unreadable', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await fs.mkdir(scorecardFile(), { recursive: true });
    expect(await adapter.read()).toEqual({ outcome: 'unreadable', reason: 'io-error' });
    expect(await adapter.append(row(RUN_A))).toEqual({ outcome: 'refused', reason: 'unreadable-store' });
  });

  it('writes atomically under the lock', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await adapter.append(row(RUN_A));
    await adapter.append(row(RUN_B));
    const before = await fs.readFile(scorecardFile(), 'utf8');
    expect(await adapter.append(row(RUN_B))).toEqual({ outcome: 'refused', reason: 'duplicate-run' });
    expect(await fs.readFile(scorecardFile(), 'utf8')).toBe(before);
    expect((await fs.readdir(path.dirname(scorecardFile()))).sort()).toEqual(['scorecard.jsonl']);
  });

  it('refuses a final line that lost its line feed instead of joining the new row to it', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await adapter.append(row(RUN_A));
    await fs.appendFile(scorecardFile(), '{"runId":"trunc', 'utf8');
    // The truncated tail is a malformed line (line 3), so the append refuses
    // rather than rewriting the file with the damage still inside it: the
    // damaged line may already carry the run id the row would record.
    expect(await adapter.append(row(RUN_B))).toEqual({ outcome: 'refused', reason: 'unreadable-store' });
    expect(await adapter.read()).toEqual({
      outcome: 'read',
      rows: [row(RUN_A)],
      problems: [{ lineNumber: 3, reason: 'malformed-line' }],
    });
  });

  it('refuses to append when the lock is held', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir, lockTimeoutMs: 60 });
    await adapter.append(row(RUN_A));
    const before = await fs.readFile(scorecardFile(), 'utf8');
    await fs.writeFile(`${scorecardFile()}.lock`, 'held-by-the-test', 'utf8');
    expect(await adapter.append(row(RUN_B))).toEqual({ outcome: 'refused', reason: 'lock-busy' });
    expect(await fs.readFile(scorecardFile(), 'utf8')).toBe(before);
    expect(await fs.readFile(`${scorecardFile()}.lock`, 'utf8')).toBe('held-by-the-test');
  });

  it('refuses a file over the size bound', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await fs.mkdir(path.dirname(scorecardFile()), { recursive: true });
    await fs.writeFile(scorecardFile(), `${HEADER}\n${'x'.repeat(4 * 1024 * 1024)}\n`, 'utf8');
    expect(await adapter.read()).toEqual({ outcome: 'unreadable', reason: 'too-large' });
    expect(await adapter.append(row(RUN_A))).toEqual({ outcome: 'refused', reason: 'too-large' });
  });

  it('refuses to append when the store already holds 20000 rows', async () => {
    const adapter = new LaneScorecardFileAdapter({ stateDir });
    await fs.mkdir(path.dirname(scorecardFile()), { recursive: true });
    const line = `${JSON.stringify(row(RUN_A))}\n`;
    await fs.writeFile(scorecardFile(), `${HEADER}\n${line.repeat(20_000)}`, 'utf8');
    expect(await adapter.append(row(RUN_B))).toEqual({ outcome: 'refused', reason: 'too-large' });
  });

  it('refuses an unsafe file name at construction', () => {
    for (const fileName of ['', '.', '..', '../x', 'a/b', 'a b', 'x'.repeat(129)]) {
      expect(() => new LaneScorecardFileAdapter({ stateDir, fileName })).toThrow();
    }
    expect(() => new LaneScorecardFileAdapter({ stateDir, fileName: 'other.jsonl' })).not.toThrow();
  });

  it('holds rows in memory without a state directory', async () => {
    const adapter = new LaneScorecardFileAdapter();
    expect(await adapter.read()).toEqual({ outcome: 'absent' });
    expect(await adapter.append(row(RUN_A))).toEqual({ outcome: 'appended' });
    expect(await adapter.append(row(RUN_A))).toEqual({ outcome: 'refused', reason: 'duplicate-run' });
    expect(await adapter.read()).toEqual({ outcome: 'read', rows: [row(RUN_A)], problems: [] });
  });
});
