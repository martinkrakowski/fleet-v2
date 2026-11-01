/**
 * `fleet-v2 state restore` (lane E1b-3b): replaces a missing or unreadable
 * store file with a quarantine copy of the same store after confirmation,
 * under the store's lock, keeping the replaced bytes as a quarantine copy.
 * CLI only (owner decision D4): no API route reaches it.
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
  const directory = mkdtempSync(path.join(tmpdir(), 'fleet-state-restore-'));
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

const COPY_NAME = 'attempts.json.20261025T101500.123Z-0.0123456789ab';
const GARBAGE = '{ nope';
const TWO_ATTEMPTS = JSON.stringify([ATTEMPT_RECORD('a1'), ATTEMPT_RECORD('a2')]);

async function writeGarbageFixture(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
  await fs.writeFile(path.join(dir, 'attempts.json'), GARBAGE);
  await fs.writeFile(path.join(dir, 'quarantine', COPY_NAME), TWO_ATTEMPTS);
}

describe('fleet-v2 state restore', () => {
  beforeEach(() => {
    vi.stubEnv('FLEET_STATE_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('--yes restores from the copy, keeps the garbage and lists two attempts', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const { io } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME, '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(0);
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(TWO_ATTEMPTS);
    const listing = (await fs.readdir(path.join(dir, 'quarantine'))).sort((a, b) =>
      a.localeCompare(b),
    );
    expect(listing).toHaveLength(2);
    expect(listing).toContain(COPY_NAME);
    const garbageCopy = listing.find((name) => name !== COPY_NAME)!;
    expect(await fs.readFile(path.join(dir, 'quarantine', garbageCopy), 'utf8')).toBe(GARBAGE);
    expect(await new AttemptRepositoryAdapter({ stateDir: dir }).listAllAttempts()).toHaveLength(2);
    expect(await fs.readFile(path.join(dir, 'quarantine', COPY_NAME), 'utf8')).toBe(TWO_ATTEMPTS);
  });

  it('declines interactively when confirm returns false and changes nothing', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const confirm = vi.fn().mockResolvedValue(false);
    const { io, stdout } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { confirm },
    );
    expect(code).toBe(1);
    expect(stdout.join('')).toContain('nothing changed');
    expect(confirm).toHaveBeenCalledWith(`restore attempts.json from ${COPY_NAME}? [y/N]`);
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(GARBAGE);
    expect(await fs.readdir(path.join(dir, 'quarantine'))).toEqual([COPY_NAME]);
  });

  it('restores when confirm returns true and prints both record counts', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const confirm = vi.fn().mockResolvedValue(true);
    const { io, stdout } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { confirm },
    );
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('records:   unreadable -> 2');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(TWO_ATTEMPTS);
  });

  it('refuses a readable current store and changes nothing', async () => {
    const dir = makeTempDir();
    await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'attempts.json'), TWO_ATTEMPTS);
    await fs.writeFile(path.join(dir, 'quarantine', COPY_NAME), TWO_ATTEMPTS);
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME, '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain(
      'attempts.json is readable (2 records); state restore replaces only a missing or unreadable store',
    );
    expect(stdout.join('')).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(TWO_ATTEMPTS);
    expect(await fs.readdir(path.join(dir, 'quarantine'))).toEqual([COPY_NAME]);
  });

  it('refuses an unknown-version current store even with --yes and leaves store and quarantine unchanged', async () => {
    const dir = makeTempDir();
    const unknownVersionStore = JSON.stringify([
      { ...ATTEMPT_RECORD('a1'), schemaVersion: 2 },
      ATTEMPT_RECORD('a2'),
    ]);
    await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'attempts.json'), unknownVersionStore);
    await fs.writeFile(path.join(dir, 'quarantine', COPY_NAME), TWO_ATTEMPTS);
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME, '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain(
      'attempts.json has an unsupported schemaVersion; state restore replaces only a missing or unreadable store',
    );
    expect(stdout.join('')).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(unknownVersionStore);
    expect(await fs.readdir(path.join(dir, 'quarantine'))).toEqual([COPY_NAME]);
  });

  it('refuses an invalid candidate and changes nothing', async () => {
    const dir = makeTempDir();
    await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'attempts.json'), GARBAGE);
    await fs.writeFile(path.join(dir, 'quarantine', COPY_NAME), '{}');
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME, '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain(`candidate ${COPY_NAME}: unreadable: expects a record list`);
    expect(stdout.join('')).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(GARBAGE);
    expect(await fs.readdir(path.join(dir, 'quarantine'))).toEqual([COPY_NAME]);
  });

  it('exits 2 for an unknown store file', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const { io } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'nope.json', '--from', COPY_NAME],
      io,
    );
    expect(code).toBe(2);
  });

  it('exits 2 for a path instead of a store basename', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const { io } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', '../attempts.json', '--from', COPY_NAME],
      io,
    );
    expect(code).toBe(2);
  });

  it('exits 2 when --from is missing', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const { io } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json'],
      io,
    );
    expect(code).toBe(2);
  });

  it('exits 2 for two positionals', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const { io } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', 'journal.json', '--from', COPY_NAME],
      io,
    );
    expect(code).toBe(2);
  });

  it('refuses a valid-named copy file in the state dir root', async () => {
    const dir = makeTempDir();
    await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'attempts.json'), GARBAGE);
    await fs.writeFile(path.join(dir, COPY_NAME), TWO_ATTEMPTS);
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', path.join(dir, COPY_NAME), '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--from must name a file directly inside');
    expect(stdout.join('')).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(GARBAGE);
  });

  it('refuses a symlink quarantine copy pointing outside', async () => {
    const dir = makeTempDir();
    await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'attempts.json'), GARBAGE);
    const outside = path.join(dir, 'outside.txt');
    await fs.writeFile(outside, 'out');
    const linkName = 'attempts.json.20261025T101501.123Z-1.0123456789ab';
    await fs.symlink(outside, path.join(dir, 'quarantine', linkName));
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', linkName, '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain(`${linkName} is a symbolic link`);
    expect(stdout.join('')).toContain('nothing changed');
  });

  it('refuses a journal quarantine copy for attempts.json', async () => {
    const dir = makeTempDir();
    await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'attempts.json'), GARBAGE);
    const journalName = 'journal.json.20261025T101500.123Z-0.0123456789ab';
    await fs.writeFile(path.join(dir, 'quarantine', journalName), '[]');
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', journalName, '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain(`${journalName} is not a quarantine copy of attempts.json`);
    expect(stdout.join('')).toContain('nothing changed');
  });

  it('restores a missing store and reports there was no previous file', async () => {
    const dir = makeTempDir();
    await fs.mkdir(path.join(dir, 'quarantine'), { recursive: true });
    await fs.writeFile(path.join(dir, 'quarantine', COPY_NAME), TWO_ATTEMPTS);
    const { io, stdout } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME, '--yes'],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
    );
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('there was no previous file');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(TWO_ATTEMPTS);
  });

  it('CAS fails when the store changes during confirmation', async () => {
    const dir = makeTempDir();
    await writeGarbageFixture(dir);
    const otherGarbage = '{ other garbage';
    const confirm = vi.fn().mockImplementation(async () => {
      await fs.writeFile(path.join(dir, 'attempts.json'), otherGarbage);
      return true;
    });
    const { io, stdout, stderr } = mockIo();
    const code = await runCli(
      ['--state-dir', dir, 'state', 'restore', 'attempts.json', '--from', COPY_NAME],
      io,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { confirm },
    );
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('the store changed since it was inspected');
    expect(stdout.join('')).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(otherGarbage);
  });

  it('exits 2 without a state directory', async () => {
    const { io, stderr } = mockIo();
    const code = await runCli(['state', 'restore', 'attempts.json', '--from', COPY_NAME], io);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('state restore needs a state directory');
  });
});
