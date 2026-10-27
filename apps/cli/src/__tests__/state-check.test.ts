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
  'assessments.json',
  'knowledge-entries.json',
  'context-selections.json',
  'project-profiles.json',
  'coordination-requests.json',
  'owner-questions.json',
  'orchestrators.json',
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
    expect(missingLines).toHaveLength(13);
    for (let index = 0; index < STORE_ORDER.length; index += 1) {
      expect(missingLines[index]).toBe(`${STORE_ORDER[index]}: missing\n`);
    }
    expect(stdout.at(-1)).toBe('state check: all 13 store files readable or missing\n');
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
    expect(stdout.join('')).toContain('attempts.json: ok (2 records)\n');
  });

  it('uses singular record for a one-record attempts store', async () => {
    const dir = makeTempDir();
    await fs.writeFile(path.join(dir, 'attempts.json'), JSON.stringify([ATTEMPT_RECORD('a1')]));
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('attempts.json: ok (1 record)\n');
  });

  it('reports an unreadable journal store and exits 1', async () => {
    const dir = makeTempDir();
    await fs.writeFile(path.join(dir, 'journal.json'), '{ nope');
    const { io, stdout } = mockIo();
    const code = await runCli(['--state-dir', dir, 'state', 'check'], io);
    expect(code).toBe(1);
    const text = stdout.join('');
    expect(text).toContain('journal.json: unreadable: not valid JSON\n');
    expect(text).toContain('state check: 1 of 13 store files unreadable\n');
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
      `  quarantine attempts.json.20261025T101500.123Z-0.0123456789ab: ok (2 records), ${copyContent.length} bytes\n`,
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
});
