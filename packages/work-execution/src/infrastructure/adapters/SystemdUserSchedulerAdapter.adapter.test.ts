import {
  existsSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  DAEMON_SERVICE_UNIT_KEY,
  DAEMON_TIMER_UNIT_KEY,
  SHADOW_INTAKE_SERVICE_UNIT_KEY,
  SHADOW_INTAKE_TIMER_UNIT_KEY,
  SHADOW_RECORD_DAY_SERVICE_UNIT_KEY,
  SHADOW_RECORD_DAY_TIMER_UNIT_KEY,
} from '../../application/ports/out/DaemonSchedulerPort.out-port.js';
import { SystemdUserSchedulerAdapter } from './SystemdUserSchedulerAdapter.adapter.js';

const SERVICE_TEXT = '[Service]\nType=oneshot\n';
const TIMER_TEXT = '[Timer]\nOnBootSec=60s\n';
const SHADOW_SERVICE_TEXT = '[Service]\nType=oneshot\nExecStart=x\n';
const SHADOW_TIMER_TEXT = '[Timer]\nOnBootSec=120s\n';

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'fleet-daemon-adapter-'));
  createdDirs.push(directory);
  return directory;
}

describe('SystemdUserSchedulerAdapter', () => {
  it('writes then reads back both unit files', async () => {
    const dir = makeTempDir();
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'written', timer: 'written' });
    expect(readFileSync(path.join(dir, DAEMON_SERVICE_UNIT_KEY), 'utf8')).toBe(
      SERVICE_TEXT,
    );
    expect(readFileSync(path.join(dir, DAEMON_TIMER_UNIT_KEY), 'utf8')).toBe(
      TIMER_TEXT,
    );
    await expect(
      adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'unchanged', timer: 'unchanged' });
    await expect(
      adapter.read({ service: 'different', timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'differs', timer: 'unchanged' });
  });

  it('reports unchanged on a second write of equal bytes', async () => {
    const dir = makeTempDir();
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    await adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT });
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'unchanged', timer: 'unchanged' });
  });

  it('remove deletes only the two unit files and leaves a sibling', async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'sibling.txt'), 'keep', 'utf8');
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    await adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT });
    await expect(adapter.remove()).resolves.toEqual({
      service: 'absent',
      timer: 'absent',
      shadowIntake: { service: 'absent', timer: 'absent' },
      shadowRecordDay: { service: 'absent', timer: 'absent' },
    });
    expect(existsSync(path.join(dir, DAEMON_SERVICE_UNIT_KEY))).toBe(false);
    expect(existsSync(path.join(dir, DAEMON_TIMER_UNIT_KEY))).toBe(false);
    expect(readFileSync(path.join(dir, 'sibling.txt'), 'utf8')).toBe('keep');
  });

  it('remove of a missing file is absent', async () => {
    const dir = makeTempDir();
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    await expect(adapter.remove()).resolves.toEqual({
      service: 'absent',
      timer: 'absent',
      shadowIntake: { service: 'absent', timer: 'absent' },
      shadowRecordDay: { service: 'absent', timer: 'absent' },
    });
  });

  it('a symlink target is unreadable and the outside file is unchanged', async () => {
    const dir = makeTempDir();
    const outside = path.join(dir, 'outside');
    writeFileSync(outside, 'outside-content', 'utf8');
    symlinkSync(outside, path.join(dir, DAEMON_SERVICE_UNIT_KEY));
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'unreadable', timer: 'written' });
    await expect(
      adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'unreadable', timer: 'unchanged' });
    await expect(adapter.remove()).resolves.toEqual({
      service: 'unreadable',
      timer: 'absent',
      shadowIntake: { service: 'absent', timer: 'absent' },
      shadowRecordDay: { service: 'absent', timer: 'absent' },
    });
    expect(readFileSync(outside, 'utf8')).toBe('outside-content');
  });

  it('a symlink already at the temp name is never written through', async () => {
    const dir = makeTempDir();
    const outside = path.join(dir, 'outside');
    writeFileSync(outside, 'outside-content', 'utf8');
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    // Pin the temp name the adapter builds so the symlink can be placed there.
    const dateNow = vi
      .spyOn(Date, 'now')
      .mockReturnValue(1_700_000_000_000);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const expectedTemp = path.join(
      dir,
      `${DAEMON_SERVICE_UNIT_KEY}.tmp-1700000000000-i`,
    );
    try {
      symlinkSync(outside, expectedTemp);
      await expect(
        adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
      ).resolves.toEqual({ service: 'unreadable', timer: 'written' });
      expect(readFileSync(outside, 'utf8')).toBe('outside-content');
      expect(existsSync(path.join(dir, DAEMON_SERVICE_UNIT_KEY))).toBe(false);
    } finally {
      dateNow.mockRestore();
      random.mockRestore();
    }
  });

  it('read does not follow a symlink swapped in after the lstat check', async () => {
    const dir = makeTempDir();
    const outside = path.join(dir, 'outside');
    writeFileSync(outside, 'outside-content', 'utf8');
    const target = path.join(dir, DAEMON_SERVICE_UNIT_KEY);
    symlinkSync(outside, target);
    // Fake a passing lstat while the real name is a symlink: the read must
    // still refuse instead of following whatever the name points at.
    const realLstat = fsPromises.lstat.bind(fsPromises);
    const fakeStat = { isFile: () => true, isDirectory: () => false };
    const lstat = vi
      .spyOn(fsPromises, 'lstat')
      .mockImplementation(async (candidate: Parameters<typeof realLstat>[0]) =>
        candidate === target
          ? (fakeStat as never)
          : realLstat(candidate),
      );
    try {
      const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
      await expect(
        adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
      ).resolves.toEqual({ service: 'unreadable', timer: 'absent' });
      expect(readFileSync(outside, 'utf8')).toBe('outside-content');
    } finally {
      lstat.mockRestore();
    }
  });

  it('a missing unitDir is unreadable and is not created', async () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'missing-units');
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: missing });
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'unreadable', timer: 'unreadable' });
    await expect(
      adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'unreadable', timer: 'unreadable' });
    await expect(adapter.remove()).resolves.toEqual({
      service: 'unreadable',
      timer: 'unreadable',
      shadowIntake: { service: 'unreadable', timer: 'unreadable' },
      shadowRecordDay: { service: 'unreadable', timer: 'unreadable' },
    });
    expect(existsSync(missing)).toBe(false);
  });

  it('returns unreadable for all 6 units when unitDir is missing or a symlink (OD7a2)', async () => {
    const dir = makeTempDir();
    const missing = path.join(dir, 'missing-units');
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: missing });
    const allPairs = {
      service: SERVICE_TEXT,
      timer: TIMER_TEXT,
      shadowIntake: { service: SHADOW_SERVICE_TEXT, timer: SHADOW_TIMER_TEXT },
      shadowRecordDay: { service: SHADOW_SERVICE_TEXT, timer: SHADOW_TIMER_TEXT },
    };
    await expect(adapter.write(allPairs)).resolves.toEqual({
      service: 'unreadable',
      timer: 'unreadable',
      shadowIntake: { service: 'unreadable', timer: 'unreadable' },
      shadowRecordDay: { service: 'unreadable', timer: 'unreadable' },
    });
    await expect(adapter.read(allPairs)).resolves.toEqual({
      service: 'unreadable',
      timer: 'unreadable',
      shadowIntake: { service: 'unreadable', timer: 'unreadable' },
      shadowRecordDay: { service: 'unreadable', timer: 'unreadable' },
    });
    // A symlinked unitDir is equally unusable.
    const symlinked = path.join(dir, 'symlinked-units');
    symlinkSync(missing, symlinked);
    const symlinkAdapter = new SystemdUserSchedulerAdapter({ unitDir: symlinked });
    await expect(symlinkAdapter.remove()).resolves.toEqual({
      service: 'unreadable',
      timer: 'unreadable',
      shadowIntake: { service: 'unreadable', timer: 'unreadable' },
      shadowRecordDay: { service: 'unreadable', timer: 'unreadable' },
    });
  });

  it('shadow intake units (OD7a1) write, read back and remove with the daemon units', async () => {
    const dir = makeTempDir();
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    const shadowIntake = {
      service: SHADOW_SERVICE_TEXT,
      timer: SHADOW_TIMER_TEXT,
    };
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT, shadowIntake }),
    ).resolves.toEqual({
      service: 'written',
      timer: 'written',
      shadowIntake: { service: 'written', timer: 'written' },
    });
    expect(
      readFileSync(path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY), 'utf8'),
    ).toBe(SHADOW_SERVICE_TEXT);
    expect(
      readFileSync(path.join(dir, SHADOW_INTAKE_TIMER_UNIT_KEY), 'utf8'),
    ).toBe(SHADOW_TIMER_TEXT);
    await expect(
      adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT, shadowIntake }),
    ).resolves.toEqual({
      service: 'unchanged',
      timer: 'unchanged',
      shadowIntake: { service: 'unchanged', timer: 'unchanged' },
    });
    await expect(adapter.remove()).resolves.toEqual({
      service: 'absent',
      timer: 'absent',
      shadowIntake: { service: 'absent', timer: 'absent' },
      shadowRecordDay: { service: 'absent', timer: 'absent' },
    });
    expect(existsSync(path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY))).toBe(false);
    expect(existsSync(path.join(dir, SHADOW_INTAKE_TIMER_UNIT_KEY))).toBe(false);
  });

  it('read and write without shadowIntake never touch the intake units', async () => {
    const dir = makeTempDir();
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    writeFileSync(
      path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY),
      SHADOW_SERVICE_TEXT,
      'utf8',
    );
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'written', timer: 'written' });
    expect(readFileSync(path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY), 'utf8')).toBe(
      SHADOW_SERVICE_TEXT,
    );
    await expect(
      adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT }),
    ).resolves.toEqual({ service: 'unchanged', timer: 'unchanged' });
  });

  // OD7a2 fix round: the shadowRecordDay pair is handled independently of
  // shadowIntake — a render may carry it without any intake units.
  it('read and write handle shadowRecordDay with no shadowIntake', async () => {
    const dir = makeTempDir();
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    const shadowRecordDay = {
      service: SHADOW_SERVICE_TEXT,
      timer: SHADOW_TIMER_TEXT,
    };
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT, shadowRecordDay }),
    ).resolves.toEqual({
      service: 'written',
      timer: 'written',
      shadowRecordDay: { service: 'written', timer: 'written' },
    });
    expect(existsSync(path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY))).toBe(false);
    expect(existsSync(path.join(dir, SHADOW_INTAKE_TIMER_UNIT_KEY))).toBe(false);
    await expect(
      adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT, shadowRecordDay }),
    ).resolves.toEqual({
      service: 'unchanged',
      timer: 'unchanged',
      shadowRecordDay: { service: 'unchanged', timer: 'unchanged' },
    });
  });

  it('a symlink at a shadow intake unit is unreadable and never followed (OD7a1)', async () => {
    const dir = makeTempDir();
    const outside = path.join(dir, 'outside');
    writeFileSync(outside, 'outside-content', 'utf8');
    symlinkSync(outside, path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY));
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    const shadowIntake = {
      service: SHADOW_SERVICE_TEXT,
      timer: SHADOW_TIMER_TEXT,
    };
    await expect(
      adapter.write({ service: SERVICE_TEXT, timer: TIMER_TEXT, shadowIntake }),
    ).resolves.toEqual({
      service: 'written',
      timer: 'written',
      shadowIntake: { service: 'unreadable', timer: 'written' },
    });
    await expect(
      adapter.read({ service: SERVICE_TEXT, timer: TIMER_TEXT, shadowIntake }),
    ).resolves.toEqual({
      service: 'unchanged',
      timer: 'unchanged',
      shadowIntake: { service: 'unreadable', timer: 'unchanged' },
    });
    await expect(adapter.remove()).resolves.toEqual({
      service: 'absent',
      timer: 'absent',
      shadowIntake: { service: 'unreadable', timer: 'absent' },
      shadowRecordDay: { service: 'absent', timer: 'absent' },
    });
    expect(readFileSync(outside, 'utf8')).toBe('outside-content');
  });

  it('remove clears the intake units even though remove takes no shadowIntake input (OD7a1)', async () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY),
      SHADOW_SERVICE_TEXT,
      'utf8',
    );
    writeFileSync(
      path.join(dir, SHADOW_INTAKE_TIMER_UNIT_KEY),
      SHADOW_TIMER_TEXT,
      'utf8',
    );
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    // No daemon units exist at all: still exactly one remove call.
    await expect(adapter.remove()).resolves.toEqual({
      service: 'absent',
      timer: 'absent',
      shadowIntake: { service: 'absent', timer: 'absent' },
      shadowRecordDay: { service: 'absent', timer: 'absent' },
    });
    expect(existsSync(path.join(dir, SHADOW_INTAKE_SERVICE_UNIT_KEY))).toBe(false);
    expect(existsSync(path.join(dir, SHADOW_INTAKE_TIMER_UNIT_KEY))).toBe(false);
  });

  it('remove clears the record-day units too, even when shadow is off (OD7a2)', async () => {
    const dir = makeTempDir();
    const adapter = new SystemdUserSchedulerAdapter({ unitDir: dir });
    writeFileSync(
      path.join(dir, SHADOW_RECORD_DAY_SERVICE_UNIT_KEY),
      SHADOW_SERVICE_TEXT,
      'utf8',
    );
    writeFileSync(
      path.join(dir, SHADOW_RECORD_DAY_TIMER_UNIT_KEY),
      SHADOW_TIMER_TEXT,
      'utf8',
    );
    await expect(adapter.remove()).resolves.toEqual({
      service: 'absent',
      timer: 'absent',
      shadowIntake: { service: 'absent', timer: 'absent' },
      shadowRecordDay: { service: 'absent', timer: 'absent' },
    });
    expect(existsSync(path.join(dir, SHADOW_RECORD_DAY_SERVICE_UNIT_KEY))).toBe(false);
    expect(existsSync(path.join(dir, SHADOW_RECORD_DAY_TIMER_UNIT_KEY))).toBe(false);
  });
});
