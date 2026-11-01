/**
 * `fleet-v2 state check` (lane E1b): a read-only report of every JSON state
 * store the four contexts own — ok, missing, unreadable or invalid record per
 * file, plus each quarantine copy kept for it. The command never writes, locks,
 * creates or quarantines anything.
 */

import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttemptRepositoryAdapter } from '@fleet/work-execution';

import { runCli, type CliIo } from '../index.js';

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'fleet-state-check-'));
  createdDirs.push(directory);
  return directory;
}

function mockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

const ATTEMPT_RECORD = (id: string) => ({
  id,
  workOrderId: 'w1',
  createdAtIso: '2026-10-25T00:00:00.000Z',
  updatedAtIso: '2026-10-25T00:00:00.000Z',
});

const STORE_ORDER = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'lane-runs.json',
  'conductor-driver-lease.json',
  'conductor-halt.json',
  'run-journal.json',
  'telemetry-dispositions.json',
  'conductor-passes.json',
  'assessments.json',
  'knowledge-entries.json',
  'context-selections.json',
  'project-profiles.json',
  'coordination-requests.json',
  'owner-questions.json',
  'orchestrators.json',
  'owner-items.json',
  'attention-items.json',
];

describe('fleet-v2 state', () => {
  beforeEach(() => {
    vi.stubEnv('FLEET_STATE_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exits 2 with no state directory and asks for --state-dir', async () => {
    const { io, stderr } = mockIo();
    const code = await runCli(['state', 'check'], io);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('--state-dir');
  });

  it('rejects missing or unknown subcommands and helps', async () => {
    const { io: noSubcommandIo } = mockIo();
    expect(await runCli(['state'], noSubcommandIo)).toBe(2);

    const { io: bogusIo } = mockIo();
    expect(await runCli(['state', 'bogus'], bogusIo)).toBe(2);

    const { io: extraArgIo } = mockIo();
    expect(await runCli(['state', 'check', '--x'], extraArgIo)).toBe(2);

    const { io: helpIo, stdout } = mockIo();
    expect(await runCli(['state', '--help'], helpIo)).toBe(0);
    expect(stdout.join('')).toContain('Usage: fleet-v2');
  });

  it('reports every store file missing in a fresh directory, exiting 0', async () => {
    const dir = makeTempDir();
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(0);
    const missingLines = stdout.filter((line) => line.endsWith(': missing\n'));
    expect(missingLines).toHaveLength(19);
    for (let index = 0; index < STORE_ORDER.length; index += 1) {
      expect(missingLines[index]).toBe(`${STORE_ORDER[index]}: missing\n`);
    }
    expect(stdout.at(-1)).toBe('state check: all 19 store files readable or missing\n');
  });

  it('reports a valid attempts store as ok', async () => {
    const dir = makeTempDir();
    await fs.writeFile(
      path.join(dir, 'attempts.json'),
      JSON.stringify([ATTEMPT_RECORD('a1'), ATTEMPT_RECORD('a2')]),
    );
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('attempts.json: ok (2 records, schemaVersion 1)\n');
  });

  it('uses singular record for a one-record attempts store', async () => {
    const dir = makeTempDir();
    await fs.writeFile(path.join(dir, 'attempts.json'), JSON.stringify([ATTEMPT_RECORD('a1')]));
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('attempts.json: ok (1 record, schemaVersion 1)\n');
  });

  it('reports an unreadable journal store and exits 1', async () => {
    const dir = makeTempDir();
    await fs.writeFile(path.join(dir, 'journal.json'), '{ nope');
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(1);
    const text = stdout.join('');
    expect(text).toContain('journal.json: unreadable: not valid JSON\n');
    expect(text).toContain('state check: 1 of 19 store files unreadable\n');
    expect(stdout.at(-1)).toBe('nothing was changed; no quarantine copies were found\n');
  });

  it('reports a non-list store as expecting a record list', async () => {
    const dir = makeTempDir();
    await fs.writeFile(path.join(dir, 'work-orders.json'), '{}');
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(1);
    expect(stdout.join('')).toContain('work-orders.json: unreadable: expects a record list\n');
  });

  it('names the invalid record index', async () => {
    const dir = makeTempDir();
    await fs.writeFile(
      path.join(dir, 'reservations.json'),
      JSON.stringify([{ id: 'r1', attemptId: 'a1' }, { id: 'r2' }]),
    );
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(1);
    expect(stdout.join('')).toContain('reservations.json: invalid record 1\n');
  });

  it('refuses a work order with an unparsable baseBranch and accepts a valid one (CB1)', async () => {
    const invalidDir = makeTempDir();
    await fs.writeFile(
      path.join(invalidDir, 'work-orders.json'),
      JSON.stringify([{ id: 'wo-1', revision: 1 }, { id: 'wo-2', revision: 1, baseBranch: 'release' }]),
    );
    const invalid = mockIo();
    const invalidCode = await runCli(['--state-dir', invalidDir, 'state', 'check'], invalid.io);
    expect(invalidCode).toBe(1);
    expect(invalid.stdout.join('')).toContain('work-orders.json: invalid record 1\n');

    const validDir = makeTempDir();
    await fs.writeFile(
      path.join(validDir, 'work-orders.json'),
      JSON.stringify([{ id: 'wo-1', revision: 1, baseBranch: 'chain/example' }]),
    );
    const valid = mockIo();
    const validCode = await runCli(['--state-dir', validDir, 'state', 'check'], valid.io);
    expect(validCode).toBe(0);
    expect(valid.stdout.join('')).toContain('work-orders.json: ok (1 record)\n');
  });

  it('never writes, locks, creates or quarantines anything', async () => {
    const dir = makeTempDir();
    await fs.writeFile(path.join(dir, 'journal.json'), '{ nope');
    const snapshot = async (): Promise<Array<{ rel: string; size: number; mtimeMs: number }>> => {
      const entries = await fs.readdir(dir, { recursive: true });
      const stats = await Promise.all(
        entries.map(async (rel) => ({ rel, stat: await fs.lstat(path.join(dir, rel)) })),
      );
      return stats
        .filter(({ stat }) => !stat.isDirectory())
        .map(({ rel, stat }) => ({ rel, size: stat.size, mtimeMs: stat.mtimeMs }))
        .sort((a, b) => a.rel.localeCompare(b.rel));
    };
    const before = await snapshot();
    const { io } = mockIo();
    await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(await snapshot()).toEqual(before);
    await expect(fs.stat(path.join(dir, 'quarantine'))).rejects.toThrow();
  });

  it('lists a quarantine copy the real reader wrote', async () => {
    const dir = makeTempDir();
    const garbage = '{ nope';
    await fs.writeFile(path.join(dir, 'attempts.json'), garbage);
    await expect(new AttemptRepositoryAdapter({ stateDir: dir }).listAllAttempts()).rejects.toThrow();
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(1);
    const line = stdout.find((text) => text.startsWith('  quarantine attempts.json.'));
    expect(line).toBeDefined();
    expect(line!.endsWith(`unreadable: not valid JSON, ${garbage.length} bytes\n`)).toBe(true);
    expect(stdout[stdout.length - 2]).toBe(
      'nothing was changed; the quarantine copies listed above are kept for recovery\n',
    );
    expect(stdout.at(-1)).toBe(
      'restore one with: fleet-v2 state restore <file> --from <quarantine copy name>\n',
    );
  });

  it('lists only quarantine copies matching a store, and exits 0 when none is bad', async () => {
    const dir = makeTempDir();
    const quarantineDir = path.join(dir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });
    await fs.writeFile(path.join(quarantineDir, 'notes.txt'), 'irrelevant');
    const copyContent = JSON.stringify([ATTEMPT_RECORD('a1'), ATTEMPT_RECORD('a2')]);
    await fs.writeFile(
      path.join(quarantineDir, 'attempts.json.20261025T101500.123Z-0.0123456789ab'),
      copyContent,
    );
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(0);
    const text = stdout.join('');
    expect(text).toContain(
      `  quarantine attempts.json.20261025T101500.123Z-0.0123456789ab: ok (2 records, schemaVersion 1), ${copyContent.length} bytes\n`,
    );
    expect(text).not.toContain('notes.txt');
  });

  it('accepts a state directory that does not exist yet and leaves it that way', async () => {
    const parent = makeTempDir();
    const dir = path.join(parent, 'nope');
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(0);
    expect(stdout[0]).toMatch(/\(does not exist yet\)\n$/);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it('reports a state directory path that is a regular file and exits 1', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'not-a-dir');
    await fs.writeFile(filePath, 'plain file');
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', filePath, 'state', 'check'], io);
    expect(code).toBe(1);
    expect(stdout[0]?.endsWith('(not a directory)\n')).toBe(true);
  });

  function laneRunFixture(runId: string): unknown {
    return {
      version: 1,
      runId,
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
      revision: 1,
      runPolicyRevision: 'policy-example-1',
    };
  }

  function runJournalEntryFixture(entryId: string, runId: string): unknown {
    return {
      version: 1,
      entryId,
      kind: 'conduct',
      key: null,
      runId,
      recordedAtIso: '2026-10-25T00:00:00.000Z',
      mode: null,
      expectedRevision: null,
      mintedId: null,
      outcome: null,
      reasonCode: null,
      detail: null,
      grantId: null,
      state: 'running',
    };
  }

  /** Write all five versioned stores with minimal readable records; when `stamp`, carry schemaVersion 1. */
  async function writeAllVersionedStores(dir: string, stamp: boolean): Promise<void> {
    const stampIf = (record: Record<string, unknown>): unknown => (stamp ? { ...record, schemaVersion: 1 } : record);
    await fs.writeFile(
      path.join(dir, 'attempts.json'),
      JSON.stringify([stampIf(ATTEMPT_RECORD('a1')), stampIf(ATTEMPT_RECORD('a2'))]),
    );
    await fs.writeFile(
      path.join(dir, 'journal.json'),
      JSON.stringify([stampIf({ id: 'je-1', attemptId: 'a' }), stampIf({ id: 'je-2', attemptId: 'a' })]),
    );
    await fs.writeFile(
      path.join(dir, 'reservations.json'),
      JSON.stringify([stampIf({ id: 'rs-1', attemptId: 'a' }), stampIf({ id: 'rs-2', attemptId: 'a' })]),
    );
    await fs.writeFile(
      path.join(dir, 'lane-runs.json'),
      JSON.stringify([
        stampIf(laneRunFixture('run-01JB0000000000000000000000') as Record<string, unknown>),
        stampIf(laneRunFixture('run-01JB0000000000000000000001') as Record<string, unknown>),
      ]),
    );
    await fs.writeFile(
      path.join(dir, 'run-journal.json'),
      JSON.stringify([
        stampIf(runJournalEntryFixture('01JB0000000000000000000001', 'run-01JB0000000000000000000000') as Record<string, unknown>),
        stampIf(runJournalEntryFixture('01JB0000000000000000000002', 'run-01JB0000000000000000000000') as Record<string, unknown>),
      ]),
    );
  }

  it('reports schemaVersion 1 across all five versioned stores whether on-disk records omit or carry it', async () => {
    for (const stamp of [false, true]) {
      const dir = makeTempDir();
      await writeAllVersionedStores(dir, stamp);
      const { io, stdout } = mockIo();
      const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
      expect(code).toBe(0);
      const text = stdout.join('');
      expect(text).toContain('attempts.json: ok (2 records, schemaVersion 1)\n');
      expect(text).toContain('journal.json: ok (2 records, schemaVersion 1)\n');
      expect(text).toContain('reservations.json: ok (2 records, schemaVersion 1)\n');
      expect(text).toContain('lane-runs.json: ok (2 records, schemaVersion 1)\n');
      expect(text).toContain('run-journal.json: ok (2 records, schemaVersion 1)\n');
    }
  });

  it('reports ok (0 records) for an empty versioned store', async () => {
    const dir = makeTempDir();
    await fs.writeFile(path.join(dir, 'attempts.json'), '[]');
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('attempts.json: ok (0 records)\n');
  });

  it('reports unsupported schemaVersion at record <n> with exit 1 and zero writes', async () => {
    const dir = makeTempDir();
    await fs.writeFile(
      path.join(dir, 'attempts.json'),
      JSON.stringify([ATTEMPT_RECORD('a1'), { ...ATTEMPT_RECORD('a2'), schemaVersion: 2 }]),
    );
    const snapshot = async (): Promise<Array<{ rel: string; size: number; mtimeMs: number }>> => {
      const entries = await fs.readdir(dir, { recursive: true });
      const stats = await Promise.all(
        entries.map(async (rel) => ({ rel, stat: await fs.lstat(path.join(dir, rel)) })),
      );
      return stats
        .filter(({ stat }) => !stat.isDirectory())
        .map(({ rel, stat }) => ({ rel, size: stat.size, mtimeMs: stat.mtimeMs }))
        .sort((a, b) => a.rel.localeCompare(b.rel));
    };
    const before = await snapshot();
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(1);
    const text = stdout.join('');
    expect(text).toContain('attempts.json: unsupported schemaVersion at record 1\n');
    expect(text).toContain('state check: 1 of 19 store files unreadable\n');
    expect(await snapshot()).toEqual(before);
    await expect(fs.stat(path.join(dir, 'quarantine'))).rejects.toThrow();
  });
});
