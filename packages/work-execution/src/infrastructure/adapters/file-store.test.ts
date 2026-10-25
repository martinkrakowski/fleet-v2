import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FileLockTimeoutError,
  type QuarantineFs,
  StateFileUnreadableError,
  quarantineUnreadable,
  withFileLock,
  writeJsonAtomically,
} from './file-store.js';

/** An explicit one-way latch: the test decides when the holder may proceed. */
function createLatch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('withFileLock', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-file-store-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('handles lock contention between two concurrent saves', async () => {
    const lockPath = path.join(tempDir, 'test.lock');
    const filePath = path.join(tempDir, 'data.json');

    let active = 0;
    let maxActive = 0;
    let firstReleased = false;
    let secondEnteredBeforeRelease = false;

    const firstEntered = createLatch();
    const releaseFirst = createLatch();
    const secondEntered = createLatch();

    // The first save holds the lock until the test explicitly releases it.
    const save1 = withFileLock(lockPath, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await writeJsonAtomically(filePath, { value: 'first' });
      firstEntered.resolve();
      await releaseFirst.promise;
      firstReleased = true;
      active -= 1;
    });

    // The lock is provably held before the second save is even started.
    await firstEntered.promise;

    const save2 = withFileLock(lockPath, async () => {
      if (!firstReleased) {
        secondEnteredBeforeRelease = true;
      }
      active += 1;
      maxActive = Math.max(maxActive, active);
      await writeJsonAtomically(filePath, { value: 'second' });
      secondEntered.resolve();
      active -= 1;
    });

    // Give the blocked second save several retry windows while the lock is
    // still held; a broken lock would enter here and be caught below.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(secondEnteredBeforeRelease).toBe(false);

    releaseFirst.resolve();
    await secondEntered.promise;
    await Promise.all([save1, save2]);

    // Mutual exclusion: at no point were both critical sections active.
    expect(maxActive).toBe(1);

    const finalRaw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(finalRaw) as { value: string };
    expect(parsed.value).toBe('second');
  });

  it('releases lock when the function throws', async () => {
    const lockPath = path.join(tempDir, 'throw.lock');

    await expect(
      withFileLock(lockPath, async () => {
        // Verify lock file exists while executing
        await fs.access(lockPath);
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');

    // Lock file must be unlinked in finally
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('makes the second caller time out with FileLockTimeoutError and leaves the lock file untouched when held by another token', async () => {
    const lockPath = path.join(tempDir, 'held.lock');
    const foreignToken = `12345-foreignhex-${Date.now() - 5000}`;
    await fs.writeFile(lockPath, foreignToken, 'utf8');

    let thrownError: unknown = null;
    try {
      await withFileLock(
        lockPath,
        async () => {
          return 'should not enter';
        },
        { timeoutMs: 50 },
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(FileLockTimeoutError);
    const timeoutError = thrownError as FileLockTimeoutError;
    expect(timeoutError.lockPath).toBe(lockPath);
    expect(timeoutError.message).toContain(lockPath);
    expect(timeoutError.message).toContain('12345');
    expect(timeoutError.message).toContain('Remove the lock only after confirming that pid is gone');

    // The lock file must be left untouched
    const content = await fs.readFile(lockPath, 'utf8');
    expect(content).toBe(foreignToken);
  });

  it('does not unlink the lock file on release when a foreign token is in the file', async () => {
    const lockPath = path.join(tempDir, 'foreign-token.lock');
    const foreignToken = `99999-foreignhex-${Date.now()}`;

    await withFileLock(lockPath, async () => {
      // While lock is held, overwrite the lock file with a foreign token
      await fs.writeFile(lockPath, foreignToken, 'utf8');
    });

    // Release in finally must not unlink the file because the token does not match
    const content = await fs.readFile(lockPath, 'utf8');
    expect(content).toBe(foreignToken);
  });
});

describe('quarantineUnreadable', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-quarantine-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function sha256Of(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  it('keeps a byte-identical copy (0o600) in a 0o700 directory, names both paths, and leaves the original untouched', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const bytes = Buffer.from('{ \u0000 not valid json\n', 'utf8');
    await fs.writeFile(filePath, bytes);

    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.filePath).toBe(filePath);
    expect(error.quarantinePath).not.toBeNull();
    expect(error.message).toContain(filePath);
    expect(error.message).toContain(error.quarantinePath!);
    expect(error.message).toContain("run 'fleet-v2 state check'");

    // The original file is untouched.
    expect(sha256Of(await fs.readFile(filePath))).toBe(sha256Of(bytes));

    // The quarantine copy is byte-identical.
    const quarantinePath = error.quarantinePath!;
    expect(sha256Of(await fs.readFile(quarantinePath))).toBe(sha256Of(bytes));

    // Modes: copy 0o600, directory 0o700.
    expect((await fs.stat(quarantinePath)).mode & 0o777).toBe(0o600);
    const quarantineDir = path.join(tempDir, 'quarantine');
    expect((await fs.stat(quarantineDir)).mode & 0o777).toBe(0o700);
  });

  it('keeps only the 5 newest quarantine copies for a basename after seven failures and keeps the newest among them', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const errors: StateFileUnreadableError[] = [];
    for (let index = 0; index < 7; index += 1) {
      const bytes = Buffer.from(`{ corrupt #${index}`, 'utf8');
      await fs.writeFile(filePath, bytes);
      try {
        await quarantineUnreadable(filePath, 'not valid JSON', bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(StateFileUnreadableError);
        errors.push(error as StateFileUnreadableError);
      }
    }
    expect(errors).toHaveLength(7);
    const copies = (await fs.readdir(path.join(tempDir, 'quarantine'))).sort();
    expect(copies).toHaveLength(5);
    for (const copy of copies) {
      expect(copy.startsWith('attempts.json.')).toBe(true);
    }
    const newestError = errors[6]!;
    expect(newestError.quarantinePath).not.toBeNull();
    expect(copies).toContain(path.basename(newestError.quarantinePath!));
    expect(await fs.readFile(newestError.quarantinePath!, 'utf8')).toBe('{ corrupt #6');
    for (const keptError of errors.slice(2)) {
      expect(copies).toContain(path.basename(keptError.quarantinePath!));
    }
  });

  it('throws with quarantinePath null when the copy itself fails', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const bytes = Buffer.from('{ not valid json', 'utf8');
    const failingFs: QuarantineFs = {
      mkdir: fs.mkdir,
      chmod: fs.chmod,
      writeFile: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
      readdir: fs.readdir,
      rm: fs.rm,
    };
    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes, failingFs);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).toBeNull();
    expect(error.message).toContain('could not be copied');
    expect(error.message).toContain('ENOSPC');
  });

  it('still names the quarantinePath when chmod fails after a successful write', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const bytes = Buffer.from('{ corrupt bytes for chmod failure\n', 'utf8');
    await fs.writeFile(filePath, bytes);

    const chmodFailingFs: QuarantineFs = {
      mkdir: fs.mkdir,
      chmod: async () => {
        throw new Error('EPERM: operation not permitted');
      },
      writeFile: fs.writeFile,
      readdir: fs.readdir,
      rm: fs.rm,
    };

    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes, chmodFailingFs);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).not.toBeNull();
    expect(error.message).toContain(error.quarantinePath!);
    expect(error.message).toContain('; tightening its permissions failed');
    expect(error.message).not.toContain('could not be copied');
    expect(sha256Of(await fs.readFile(error.quarantinePath!))).toBe(sha256Of(bytes));
  });

  it('produces two distinct copies with byte-identical content when two failures happen in the same millisecond', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const bytes1 = Buffer.from('{ reader 1 corrupt payload\n', 'utf8');
    const bytes2 = Buffer.from('{ reader 2 corrupt payload\n', 'utf8');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T02:50:54.123Z'));
    let error1: StateFileUnreadableError | null = null;
    let error2: StateFileUnreadableError | null = null;
    try {
      try {
        await quarantineUnreadable(filePath, 'not valid JSON', bytes1);
      } catch (error) {
        error1 = error as StateFileUnreadableError;
      }
      try {
        await quarantineUnreadable(filePath, 'not valid JSON', bytes2);
      } catch (error) {
        error2 = error as StateFileUnreadableError;
      }
    } finally {
      vi.useRealTimers();
    }

    expect(error1).toBeInstanceOf(StateFileUnreadableError);
    expect(error2).toBeInstanceOf(StateFileUnreadableError);
    expect(error1!.quarantinePath).not.toBeNull();
    expect(error2!.quarantinePath).not.toBeNull();
    expect(error1!.quarantinePath).not.toBe(error2!.quarantinePath);
    expect(path.basename(error1!.quarantinePath!)).toContain('.20261025T025054.123Z-');
    expect(path.basename(error2!.quarantinePath!)).toContain('.20261025T025054.123Z-');

    const copies = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(copies).toHaveLength(2);
    expect(sha256Of(await fs.readFile(error1!.quarantinePath!))).toBe(sha256Of(bytes1));
    expect(sha256Of(await fs.readFile(error2!.quarantinePath!))).toBe(sha256Of(bytes2));
  });

  it('keeps the bytes the reader parsed when the file on disk is replaced between read and quarantine', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const garbageBytes = Buffer.from('{ garbage read by reader before replacement\n', 'utf8');
    await fs.writeFile(filePath, garbageBytes);

    // Reader reads the garbage bytes into a Buffer.
    const readerBytes = await fs.readFile(filePath);

    // Before quarantine writes the copy, the target path is replaced with a valid file.
    const validReplacement = JSON.stringify([{ id: 'att-valid', workOrderId: 'wo-1' }]);
    const replacingFs: QuarantineFs = {
      mkdir: async (dirPath, options) => {
        await fs.writeFile(filePath, validReplacement, 'utf8');
        return await fs.mkdir(dirPath, options);
      },
      chmod: fs.chmod,
      writeFile: fs.writeFile,
      readdir: fs.readdir,
      rm: fs.rm,
    };

    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', readerBytes, replacingFs);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).not.toBeNull();
    // Quarantine copy holds the exact garbage bytes the reader parsed, not the replacement.
    expect(sha256Of(await fs.readFile(error.quarantinePath!))).toBe(sha256Of(garbageBytes));
    expect(path.basename(error.quarantinePath!)).toContain(sha256Of(garbageBytes).slice(0, 12));
    // And the replacement on disk was not touched.
    expect(await fs.readFile(filePath, 'utf8')).toBe(validReplacement);
  });

  it('keeps the copy just written and the four newest others when the clock steps backwards', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    await fs.writeFile(filePath, 'garbage');
    vi.useFakeTimers();
    try {
      const later: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 25, 12, 0, i)));
        try {
          await quarantineUnreadable(filePath, 'not valid JSON', Buffer.from(`later-${i}`));
        } catch (error) {
          later.push((error as { quarantinePath: string }).quarantinePath);
        }
      }
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 25, 11, 0, 0)));
      let earliest = '';
      try {
        await quarantineUnreadable(filePath, 'not valid JSON', Buffer.from('earlier'));
      } catch (error) {
        earliest = (error as { quarantinePath: string }).quarantinePath;
      }
      const kept = (await fs.readdir(path.join(tempDir, 'quarantine'))).map((name) =>
        path.join(tempDir, 'quarantine', name),
      );
      expect(kept).toHaveLength(5);
      expect(kept).toContain(earliest);
      for (const newest of later.slice(2)) {
        expect(kept).toContain(newest);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries every candidate when an rm fails during pruning and reports the failure count', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const quarantineDir = path.join(tempDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true, mode: 0o700 });
    // Pre-seed 6 older quarantine copies so writing 1 more leaves 2 candidates to prune.
    for (let index = 0; index < 6; index += 1) {
      const seededName = `attempts.json.20261025T01000${index}.000Z-${index}.00000000000${index}`;
      await fs.writeFile(path.join(quarantineDir, seededName), `seed-${index}`, 'utf8');
    }

    const attemptedRm: string[] = [];
    const partialRmFs: QuarantineFs = {
      mkdir: fs.mkdir,
      chmod: fs.chmod,
      writeFile: fs.writeFile,
      readdir: fs.readdir,
      rm: async (targetPath, options) => {
        attemptedRm.push(path.basename(targetPath));
        if (attemptedRm.length === 1) {
          throw new Error('EBUSY: first rm failed');
        }
        await fs.rm(targetPath, options);
      },
    };

    const newestBytes = Buffer.from('{ newest failure', 'utf8');
    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', newestBytes, partialRmFs);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).not.toBeNull();
    expect(attemptedRm).toHaveLength(2);
    expect(error.message).toContain('; pruning old copies failed (1)');
    expect(sha256Of(await fs.readFile(error.quarantinePath!))).toBe(sha256Of(newestBytes));
  });

  it('appends -dup1 when wx finds an existing quarantine copy with the same name', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const bytes = Buffer.from('{ collision test', 'utf8');
    let writeAttempts = 0;
    const collidingFs: QuarantineFs = {
      mkdir: fs.mkdir,
      chmod: fs.chmod,
      writeFile: async (targetPath, data, options) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          throw eexist;
        }
        await fs.writeFile(targetPath, data, options);
      },
      readdir: fs.readdir,
      rm: fs.rm,
    };

    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes, collidingFs);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).not.toBeNull();
    expect(error.quarantinePath!.endsWith('-dup1')).toBe(true);
    expect(sha256Of(await fs.readFile(error.quarantinePath!))).toBe(sha256Of(bytes));
  });
});
