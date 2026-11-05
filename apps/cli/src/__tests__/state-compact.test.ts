/**
 * `fleet-v2 state compact` (lane EX-3c): the operator half of the attempt-scoped
 * state compaction. The store primitive and the policy have their own tests;
 * these cases cover the command's order of work, its refusals and its output.
 */

import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LaneRunRepositoryAdapter, type LaneRunRecord } from '@fleet/work-execution';

import { runCli, type CliIo } from '../index.js';

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'fleet-state-compact-'));
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

const ATTEMPT = (id: string, state: string, priorAttemptId: string | null = null) => ({
  id,
  workOrderId: 'w1',
  state,
  priorAttemptId,
  createdAtIso: '2026-11-01T00:00:00.000Z',
  updatedAtIso: '2026-11-01T00:00:00.000Z',
});
const JOURNAL_ENTRY = (id: string, attemptId: string, status: string) => ({
  id,
  attemptId,
  workOrderId: 'w1',
  action: 'collect',
  baseCommit: 'c1',
  recordedAtIso: '2026-11-01T00:00:00.000Z',
  status,
  sessionId: null,
  detail: null,
});
const RESERVATION = (id: string, attemptId: string, held: boolean) => ({
  id,
  attemptId,
  hostId: 'h1',
  slotIndex: held ? 1 : 0,
  held,
  seatTool: null,
  reservedAtIso: '2026-11-01T00:00:00.000Z',
  releasedAtIso: held ? null : '2026-11-01T00:00:01.000Z',
});
const LIVE_RUN = {
  version: 1,
  runId: 'run-01J' + '0'.repeat(23),
  workOrderId: 'w1',
  tier: 1,
  seatPlanRef: 'a'.repeat(64),
  cursors: { 'first-pass': null, fix: null, review: null },
  round: 0,
  attemptIds: ['att-done'],
  prNumber: null,
  parked: null,
  parkCount: 0,
  lease: null,
  revision: 1,
  runPolicyRevision: 'policy@1',
};

const asJson = (records: unknown): string => JSON.stringify(records, null, 2) + '\n';

async function seed(dir: string, name: string, records: unknown): Promise<string> {
  const text = typeof records === 'string' ? records : asJson(records);
  await fs.writeFile(path.join(dir, name), text);
  return text;
}

async function seedFinished(dir: string): Promise<{ attempts: string; journal: string; reservations: string }> {
  return {
    attempts: await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected'), ATTEMPT('att-live', 'running')]),
    journal: await seed(dir, 'journal.json', [
      JOURNAL_ENTRY('j-done', 'att-done', 'completed'),
      JOURNAL_ENTRY('j-live', 'att-live', 'intent-recorded'),
    ]),
    reservations: await seed(dir, 'reservations.json', [
      RESERVATION('res-done', 'att-done', false),
      RESERVATION('res-live', 'att-live', true),
    ]),
  };
}

async function idsOf(dir: string, name: string): Promise<string[]> {
  const parsed = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as { id: string }[];
  return parsed.map((record) => record.id);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function compact(
  dir: string,
  extra: string[] = ['--yes'],
  confirm?: (question: string) => Promise<boolean>,
): Promise<{ code: number; out: string; err: string }> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(
    ['--state-dir', dir, 'state', 'compact', ...extra],
    io,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    confirm === undefined ? {} : { confirm },
  );
  return { code, out: stdout.join(''), err: stderr.join('') };
}

describe('fleet-v2 state compact', () => {
  beforeEach(() => {
    vi.stubEnv('FLEET_STATE_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('compacts the three stores and keeps the live records', async () => {
    const dir = makeTempDir();
    const original = await seedFinished(dir);
    const result = await compact(dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain('compacted attempts.json: 2 -> 1 records\n');
    expect(result.out).toContain('compacted journal.json: 2 -> 1 records\n');
    expect(result.out).toContain('compacted reservations.json: 2 -> 1 records\n');
    expect(result.out).toContain('state compact: 3 of 3 stores compacted\n');
    expect(result.out).toContain('state check after compaction: all 27 store files readable or missing\n');
    expect(await idsOf(dir, 'attempts.json')).toEqual(['att-live']);
    expect(await idsOf(dir, 'journal.json')).toEqual(['j-live']);
    expect(await idsOf(dir, 'reservations.json')).toEqual(['res-live']);
    const copies = await fs.readdir(path.join(dir, 'quarantine'));
    expect(copies).toHaveLength(3);
    const copyBytes = await Promise.all(copies.map((name) => fs.readFile(path.join(dir, 'quarantine', name), 'utf8')));
    expect(copyBytes.sort()).toEqual([original.attempts, original.journal, original.reservations].sort());
  });

  it('keeps an attempt a live lane run lists', async () => {
    const dir = makeTempDir();
    const attempts = await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    await seed(dir, 'lane-runs.json', [LIVE_RUN]);
    const result = await compact(dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain('state compact: nothing to compact\n');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('refuses and writes nothing when a store is unreadable', async () => {
    const dir = makeTempDir();
    const attempts = await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    await seed(dir, 'journal.json', '{ nope');
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused: journal.json is not readable');
    expect(result.out).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('refuses when a store holds an unsupported schemaVersion', async () => {
    const dir = makeTempDir();
    const attempts = await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    await seed(dir, 'reservations.json', [{ ...RESERVATION('res-1', 'att-done', false), schemaVersion: 99 }]);
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused');
    expect(result.out).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('refuses when the lane runs cannot be read', async () => {
    const dir = makeTempDir();
    const attempts = await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    await seed(dir, 'lane-runs.json', '{ nope');
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused');
    expect(result.out).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('declines and writes nothing', async () => {
    const dir = makeTempDir();
    const attempts = await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    await seed(dir, 'journal.json', []);
    await seed(dir, 'reservations.json', []);
    const confirm = vi.fn().mockResolvedValue(false);
    const result = await compact(dir, [], confirm);
    expect(result.code).toBe(1);
    expect(result.out).toContain('nothing changed');
    expect(confirm).toHaveBeenCalledWith(
      'compact the attempt-scoped stores (attempts.json, journal.json, reservations.json)? [y/N]',
    );
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('treats a confirmation that throws as a decline', async () => {
    const dir = makeTempDir();
    const attempts = await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    const confirm = vi.fn().mockRejectedValue(new Error('stdin closed'));
    const result = await compact(dir, [], confirm);
    expect(result.code).toBe(1);
    expect(result.out).toContain('nothing changed');
    expect(result.err).not.toContain('stdin closed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(attempts);
  });

  it('compacts after a confirmation that returns true', async () => {
    const dir = makeTempDir();
    await seedFinished(dir);
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await compact(dir, [], confirm);
    expect(result.code).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await idsOf(dir, 'attempts.json')).toEqual(['att-live']);
  });

  it('has nothing to compact when every attempt is live', async () => {
    const dir = makeTempDir();
    const attempts = await seed(dir, 'attempts.json', [ATTEMPT('att-live', 'running')]);
    await seed(dir, 'journal.json', []);
    await seed(dir, 'reservations.json', []);
    const result = await compact(dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain('state compact: nothing to compact\n');
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(attempts);
  });

  it('has nothing to compact in an empty state directory', async () => {
    const dir = makeTempDir();
    const result = await compact(dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain('state compact: nothing to compact\n');
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('is idempotent: a second run finds nothing to compact', async () => {
    const dir = makeTempDir();
    await seedFinished(dir);
    expect((await compact(dir)).code).toBe(0);
    const after = await fs.readFile(path.join(dir, 'attempts.json'), 'utf8');
    const second = await compact(dir);
    expect(second.code).toBe(0);
    expect(second.out).toContain('state compact: nothing to compact\n');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(after);
  });

  it('recovers from a crashed earlier compaction that left a partial .compacted file', async () => {
    const dir = makeTempDir();
    await seedFinished(dir);
    await fs.writeFile(path.join(dir, 'attempts.json.compacted'), '[ half written');
    const result = await compact(dir);
    expect(result.code).toBe(0);
    expect(await idsOf(dir, 'attempts.json')).toEqual(['att-live']);
    expect(await exists(path.join(dir, 'attempts.json.compacted'))).toBe(false);
    expect(result.out).toContain('state check after compaction: all 27 store files readable or missing\n');
  });

  it('keeps an attempt a kept attempt names as its prior attempt', async () => {
    const dir = makeTempDir();
    await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected'), ATTEMPT('att-next', 'running', 'att-done')]);
    const result = await compact(dir);
    expect(result.code).toBe(0);
    expect(result.out).toContain('state compact: nothing to compact\n');
    expect(await idsOf(dir, 'attempts.json')).toEqual(['att-done', 'att-next']);
  });

  it('refuses a store that is a symlink and never follows it out of the state directory', async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const outsideFile = path.join(outside, 'attempts.json');
    const text = asJson([ATTEMPT('att-done', 'collected')]);
    await fs.writeFile(outsideFile, text);
    await fs.symlink(outsideFile, path.join(dir, 'attempts.json'));
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused: attempts.json is a link');
    expect(result.out).toContain('nothing changed');
    expect(await fs.readFile(outsideFile, 'utf8')).toBe(text);
    expect(await exists(path.join(outside, 'quarantine'))).toBe(false);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('refuses before state check reads any other store that is a symlink', async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const outsideFile = path.join(outside, 'work-orders.json');
    await fs.writeFile(outsideFile, '[]\n');
    await fs.symlink(outsideFile, path.join(dir, 'work-orders.json'));
    const original = await seedFinished(dir);
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused: work-orders.json is a link');
    expect(result.out).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(original.attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('refuses when a parent directory of a store, such as daemon, is a link', async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    await fs.writeFile(path.join(outside, 'status.json'), '{}\n');
    await fs.symlink(outside, path.join(dir, 'daemon'));
    const original = await seedFinished(dir);
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused: daemon is a link');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(original.attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('compacts when a directory-backed store such as daemon/leases exists', async () => {
    const dir = makeTempDir();
    await fs.mkdir(path.join(dir, 'daemon', 'leases'), { recursive: true });
    await seedFinished(dir);
    const result = await compact(dir);
    expect(result.code).toBe(0);
    expect(await idsOf(dir, 'attempts.json')).toEqual(['att-live']);
  });

  it('refuses when the quarantine directory is a symlink and writes nothing', async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    const original = await seedFinished(dir);
    await fs.symlink(outside, path.join(dir, 'quarantine'));
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused: the quarantine directory is not a real directory');
    expect(result.out).toContain('nothing changed');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(original.attempts);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses when a .compacted temp name is a directory and keeps no quarantine copy', async () => {
    const dir = makeTempDir();
    const original = await seedFinished(dir);
    await fs.mkdir(path.join(dir, 'attempts.json.compacted'));
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('attempts.json.compacted is a directory');
    expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(original.attempts);
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('refuses a store above the size bound without reading it', async () => {
    const dir = makeTempDir();
    await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    await fs.truncate(path.join(dir, 'journal.json'), 65 * 1024 * 1024).catch(async () => {
      await fs.writeFile(path.join(dir, 'journal.json'), '');
      await fs.truncate(path.join(dir, 'journal.json'), 65 * 1024 * 1024);
    });
    const result = await compact(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('state compact refused: journal.json is too large to compact');
    expect(result.out).toContain('nothing changed');
    expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
  });

  it('refuses when a lane run starts listing a removable attempt after the plan was made', async () => {
    const dir = makeTempDir();
    const original = await seedFinished(dir);
    const list = vi
      .spyOn(LaneRunRepositoryAdapter.prototype, 'list')
      .mockResolvedValueOnce([])
      .mockResolvedValue([LIVE_RUN as unknown as LaneRunRecord]);
    try {
      const result = await compact(dir);
      expect(result.code).toBe(1);
      expect(result.err).toContain('state compact refused: the lane runs changed while the plan was being made');
      expect(result.out).toContain('nothing changed');
      expect(await fs.readFile(path.join(dir, 'attempts.json'), 'utf8')).toBe(original.attempts);
      expect(await exists(path.join(dir, 'quarantine'))).toBe(false);
    } finally {
      list.mockRestore();
    }
  });

  it('prints ids, counts and fixed reasons only: no record text, secrets or state-directory paths', async () => {
    const dir = makeTempDir();
    const secret = 'ghp_' + 'A'.repeat(36);
    await seed(dir, 'attempts.json', [ATTEMPT('att-done', 'collected')]);
    await seed(dir, 'journal.json', [{ ...JOURNAL_ENTRY('j-done', 'att-done', 'completed'), detail: secret }]);
    await fs.mkdir(path.join(dir, 'quarantine'));
    const ok = await compact(dir);
    expect(ok.out + ok.err).not.toContain(secret);
    expect(ok.out + ok.err).not.toContain(dir);
    const bad = makeTempDir();
    await seed(bad, 'attempts.json', `[{"id": "${secret}", "state": ` );
    const refused = await compact(bad);
    expect(refused.code).toBe(1);
    expect(refused.out + refused.err).not.toContain(secret);
    expect(refused.out + refused.err).not.toContain(bad);
  });

  it('reports usage errors with exit 2', async () => {
    const dir = makeTempDir();
    const unknown = await compact(dir, ['--bogus']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Unknown state compact option: --bogus');
    const { io } = mockIo();
    const code = await runCli(['state', 'compact'], io, undefined, undefined, undefined, undefined, undefined, undefined, {});
    expect(code).toBe(2);
  });
});
