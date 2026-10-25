import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describeRecordListStore,
  FileLockTimeoutError,
  inspectRecordListBytes,
  keepQuarantineCopy,
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
    expect(error.message).toContain(
      'restore it from that copy or repair it by hand; no command reads or writes this store until then',
    );

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
      readFile: fs.readFile,
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
      readFile: fs.readFile,
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
      readFile: fs.readFile,
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
      readFile: fs.readFile,
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
      readFile: fs.readFile,
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

  it('writes one copy and names it in both errors when two failures have identical bytes', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const bytes = Buffer.from('{ unchanged corrupt payload\n', 'utf8');
    await fs.writeFile(filePath, bytes);

    let error1: StateFileUnreadableError | null = null;
    let error2: StateFileUnreadableError | null = null;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes);
    } catch (error) {
      error1 = error as StateFileUnreadableError;
    }
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes);
    } catch (error) {
      error2 = error as StateFileUnreadableError;
    }

    expect(error1).toBeInstanceOf(StateFileUnreadableError);
    expect(error2).toBeInstanceOf(StateFileUnreadableError);
    expect(error1!.quarantinePath).not.toBeNull();
    expect(error2!.quarantinePath).toBe(error1!.quarantinePath);
    expect(error1!.message).toContain(error1!.quarantinePath!);
    expect(error2!.message).toContain(error1!.quarantinePath!);

    const copies = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(copies).toHaveLength(1);
    expect(sha256Of(await fs.readFile(error1!.quarantinePath!))).toBe(sha256Of(bytes));
  });

  it('writes two copies when two failures have different bytes', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const bytes1 = Buffer.from('{ corrupt payload first\n', 'utf8');
    const bytes2 = Buffer.from('{ corrupt payload second\n', 'utf8');

    let error1: StateFileUnreadableError | null = null;
    let error2: StateFileUnreadableError | null = null;
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

    expect(error1).toBeInstanceOf(StateFileUnreadableError);
    expect(error2).toBeInstanceOf(StateFileUnreadableError);
    expect(error1!.quarantinePath).not.toBeNull();
    expect(error2!.quarantinePath).not.toBeNull();
    expect(error1!.quarantinePath).not.toBe(error2!.quarantinePath);

    const copies = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(copies).toHaveLength(2);
    expect(sha256Of(await fs.readFile(error1!.quarantinePath!))).toBe(sha256Of(bytes1));
    expect(sha256Of(await fs.readFile(error2!.quarantinePath!))).toBe(sha256Of(bytes2));
  });

  it('does not reuse a matching-name entry with truncated contents, writes a new copy equal to bytes, and leaves the truncated file unchanged', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const quarantineDir = path.join(tempDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true, mode: 0o700 });

    const bytes = Buffer.from('{ corrupt payload whose earlier write failed midway\n', 'utf8');
    const digest = sha256Of(bytes).slice(0, 12);
    const truncatedName = `attempts.json.20261025T010000.000Z-0.${digest}`;
    const truncatedPath = path.join(quarantineDir, truncatedName);
    const truncatedBytes = bytes.subarray(0, 8);
    await fs.writeFile(truncatedPath, truncatedBytes);

    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).not.toBeNull();
    expect(error.quarantinePath).not.toBe(truncatedPath);
    expect(Buffer.from(await fs.readFile(error.quarantinePath!)).equals(bytes)).toBe(true);
    expect(Buffer.from(await fs.readFile(truncatedPath)).equals(truncatedBytes)).toBe(true);

    const copies = await fs.readdir(quarantineDir);
    expect(copies).toContain(truncatedName);
    expect(copies).toContain(path.basename(error.quarantinePath!));
  });

  it('skips a matching-name entry whose readFile throws without reusing or deleting it', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const quarantineDir = path.join(tempDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true, mode: 0o700 });

    const bytes = Buffer.from('{ corrupt payload with unreadable existing candidate\n', 'utf8');
    const digest = sha256Of(bytes).slice(0, 12);
    const unreadableName = `attempts.json.20261025T010000.000Z-0.${digest}`;
    const unreadablePath = path.join(quarantineDir, unreadableName);
    await fs.writeFile(unreadablePath, bytes);

    const removedPaths: string[] = [];
    const readFailingFs: QuarantineFs = {
      mkdir: fs.mkdir,
      chmod: fs.chmod,
      readFile: async (targetPath) => {
        if (targetPath === unreadablePath) {
          throw new Error('EACCES: permission denied');
        }
        return await fs.readFile(targetPath);
      },
      writeFile: fs.writeFile,
      readdir: fs.readdir,
      rm: async (targetPath, options) => {
        removedPaths.push(targetPath);
        await fs.rm(targetPath, options);
      },
    };

    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes, readFailingFs);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).not.toBeNull();
    expect(error.quarantinePath).not.toBe(unreadablePath);
    expect(removedPaths).not.toContain(unreadablePath);
    expect(Buffer.from(await fs.readFile(error.quarantinePath!)).equals(bytes)).toBe(true);
    expect(Buffer.from(await fs.readFile(unreadablePath)).equals(bytes)).toBe(true);
  });

  it('reuses a matching-name entry with equal contents without writing a new file, even after an earlier matching-name entry failed verification', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    const quarantineDir = path.join(tempDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true, mode: 0o700 });

    const bytes = Buffer.from('{ corrupt payload already quarantined intact\n', 'utf8');
    const digest = sha256Of(bytes).slice(0, 12);
    const truncatedName = `attempts.json.20261025T010000.000Z-0.${digest}`;
    const truncatedPath = path.join(quarantineDir, truncatedName);
    await fs.writeFile(truncatedPath, bytes.subarray(0, 5));

    const validName = `attempts.json.20261025T010001.000Z-1.${digest}`;
    const validPath = path.join(quarantineDir, validName);
    await fs.writeFile(validPath, bytes);

    let writeCalled = false;
    const trackingFs: QuarantineFs = {
      mkdir: fs.mkdir,
      chmod: fs.chmod,
      readFile: fs.readFile,
      writeFile: async (targetPath, data, options) => {
        writeCalled = true;
        await fs.writeFile(targetPath, data, options);
      },
      readdir: async () => [truncatedName, validName],
      rm: fs.rm,
    };

    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON', bytes, trackingFs);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).toBe(validPath);
    expect(writeCalled).toBe(false);
    const copies = (await fs.readdir(quarantineDir)).sort();
    expect(copies).toEqual([truncatedName, validName]);
  });
});

describe('inspectRecordListBytes', () => {
  const idParser = (raw: unknown): unknown =>
    typeof (raw as { id?: unknown }).id === 'string' ? raw : undefined;

  it('parses a valid two-element list', () => {
    const bytes = Buffer.from('[{"id":"a"},{"id":"b"}]');
    const result = inspectRecordListBytes(bytes, idParser);
    expect(result).toEqual({ status: 'ok', records: [{ id: 'a' }, { id: 'b' }] });
  });

  it('reports non-JSON bytes', () => {
    const bytes = Buffer.from('{ not json');
    const result = inspectRecordListBytes(bytes, idParser);
    expect(result).toEqual({ status: 'unreadable', detail: 'not valid JSON', recordIndex: null });
  });

  it('rejects a non-array document', () => {
    const result = inspectRecordListBytes(Buffer.from('{}'), idParser);
    expect(result).toEqual({ status: 'unreadable', detail: 'expects a record list', recordIndex: null });
  });

  it('reports the index of the first failing record', () => {
    const bytes = Buffer.from('[{"id":"a"},{"x":1}]');
    const result = inspectRecordListBytes(bytes, idParser);
    expect(result).toEqual({ status: 'unreadable', detail: 'record 1 failed validation', recordIndex: 1 });
  });

  it('reports a throwing parser as a failed record', () => {
    const throwingParser = (raw: unknown): unknown => {
      if ((raw as { id?: unknown }).id === 'boom') {
        throw new Error('nope');
      }
      return raw;
    };
    const bytes = Buffer.from('[{"id":"boom"},{"id":"b"}]');
    const result = inspectRecordListBytes(bytes, throwingParser);
    expect(result).toEqual({ status: 'unreadable', detail: 'record 0 failed validation', recordIndex: 0 });
  });
});

describe('describeRecordListStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-desc-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const parser = (raw: unknown): unknown =>
    typeof (raw as { id?: unknown }).id === 'string' ? raw : undefined;

  const d = describeRecordListStore('x.json', parser);

  it('recognizes quarantine copy names of its own store only', () => {
    const own = 'x.json.20261025T101500.123Z-0.0123456789ab';
    expect(d.isQuarantineCopyName(own)).toBe(true);
    expect(d.isQuarantineCopyName('y.json.20261025T101500.123Z-0.0123456789ab')).toBe(false);
    expect(d.isQuarantineCopyName('../x.json.20261025T101500.123Z-0.0123456789ab')).toBe(false);
    expect(d.isQuarantineCopyName('x.json')).toBe(false);
  });

  it('reports a missing store file without creating a quarantine directory', async () => {
    const check = await d.check(tempDir);
    expect(check.result).toEqual({ status: 'missing' });
    expect(check.quarantineCopies).toEqual([]);
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('checks the store file and quarantine copies sorted by name', async () => {
    await fs.writeFile(path.join(tempDir, 'x.json'), '[{"id":"a"},{"id":"b"}]');
    const quarantineDir = path.join(tempDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });
    const validName = 'x.json.20261025T101500.123Z-0.0123456789ab';
    const garbageName = 'x.json.20261025T101501.123Z-1.0123456789ab';
    const linkName = 'x.json.20261025T101502.123Z-2.0123456789ab';
    await fs.writeFile(path.join(quarantineDir, validName), '[{"id":"a"}]');
    await fs.writeFile(path.join(quarantineDir, garbageName), '{ garbage');
    await fs.symlink('target', path.join(quarantineDir, linkName));

    const check = await d.check(tempDir);
    expect(check.result).toEqual({ status: 'ok', recordCount: 2 });
    expect(check.quarantineCopies.map((copy) => copy.name)).toEqual([validName, garbageName, linkName]);
    const [validCheck, garbageCheck, linkCheck] = check.quarantineCopies;
    expect(validCheck?.result).toEqual({ status: 'ok', recordCount: 1 });
    expect(garbageCheck?.result).toMatchObject({ status: 'unreadable' });
    expect(linkCheck?.result).toEqual({ status: 'read-error', code: 'not a regular file' });
  });

  it('is read-only: check changes no file metadata and creates no quarantine directory', async () => {
    await fs.writeFile(path.join(tempDir, 'x.json'), '{ garbage');
    const snapshot = async (): Promise<Array<{ name: string; size: number; mtimeMs: number }>> => {
      const names = await fs.readdir(tempDir, { recursive: true });
      const stats = await Promise.all(names.map((name) => fs.lstat(path.join(tempDir, name))));
      return names.map((name, index) => ({
        name,
        size: stats[index]!.size,
        mtimeMs: stats[index]!.mtimeMs,
      }));
    };
    const before = await snapshot();
    await d.check(tempDir);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(await fs.readdir(tempDir)).not.toContain('quarantine');
  });
});

describe('quarantine copy names', () => {
  it('match the writer: quarantineUnreadable names agree with isQuarantineCopyName', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-qnames-'));
    try {
      const d = describeRecordListStore('x.json', (raw: unknown): unknown =>
        typeof (raw as { id?: unknown }).id === 'string' ? raw : undefined,
      );
      let caught: unknown;
      try {
        await quarantineUnreadable(path.join(tempDir, 'x.json'), 'd', Buffer.from('{ garbage'));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StateFileUnreadableError);
      const error = caught as StateFileUnreadableError;
      expect(error.quarantinePath).not.toBeNull();
      expect(d.isQuarantineCopyName(path.basename(error.quarantinePath!))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('keepQuarantineCopy', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-keepq-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reuses an equal copy without writing a new file', async () => {
    const filePath = path.join(tempDir, 'x.json');
    const bytes = Buffer.from('{ garbage', 'utf8');
    await fs.writeFile(filePath, bytes);

    const first = await keepQuarantineCopy(filePath, bytes);
    expect(first.reused).toBe(false);

    const quarantineDir = path.join(tempDir, 'quarantine');
    const before = await fs.readdir(quarantineDir);

    const second = await keepQuarantineCopy(filePath, bytes);
    expect(second.reused).toBe(true);
    expect(second.quarantinePath).toBe(first.quarantinePath);
    expect(await fs.readdir(quarantineDir)).toEqual(before);
  });

  it('keeps the oldest protected copy across seven copies', async () => {
    const filePath = path.join(tempDir, 'x.json');
    await fs.writeFile(filePath, 'garbage');
    const quarantineDir = path.join(tempDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });

    const seedNames = Array.from({ length: 7 }, (_, i) =>
      `x.json.20261025T010000.000Z-${i}.0123456789ab`,
    );
    await Promise.all(
      seedNames.map((name, index) =>
        fs.writeFile(path.join(quarantineDir, name), `{ seed ${index}`, 'utf8'),
      ),
    );
    const oldest = seedNames[0]!;

    await keepQuarantineCopy(filePath, Buffer.from('{ newest', 'utf8'), { protectNames: [oldest] });

    const kept = await fs.readdir(quarantineDir);
    expect(kept).toContain(oldest);
    expect(kept).toHaveLength(6);
  });
});

async function snapshotStateDir(
  dir: string,
  basename = 'x.json',
): Promise<{ storeBytes: Buffer | null; quarantineCopies: Array<{ name: string; sha256: string }> }> {
  let storeBytes: Buffer | null = null;
  try {
    storeBytes = await fs.readFile(path.join(dir, basename));
  } catch {
    storeBytes = null;
  }
  let quarantineCopies: Array<{ name: string; sha256: string }> = [];
  try {
    const entries = await fs.readdir(path.join(dir, 'quarantine'));
    const results = await Promise.all(
      entries.map(async (name) => {
        const full = path.join(dir, 'quarantine', name);
        try {
          const stat = await fs.lstat(full);
          if (!stat.isFile()) {
            return null;
          }
          const bytes = await fs.readFile(full);
          return { name, sha256: createHash('sha256').update(bytes).digest('hex') };
        } catch {
          return null;
        }
      }),
    );
    quarantineCopies = results
      .filter((entry): entry is { name: string; sha256: string } => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    quarantineCopies = [];
  }
  return { storeBytes, quarantineCopies };
}

describe('readQuarantineCopy', () => {
  let stateDir: string;
  let quarantineDir: string;
  const parser = (raw: unknown): unknown =>
    typeof (raw as { id?: unknown }).id === 'string' ? raw : undefined;
  const d = describeRecordListStore('x.json', parser);
  const validName = 'x.json.20261025T101500.123Z-0.0123456789ab';
  const validBytes = Buffer.from('[{"id":"a"}]', 'utf8');

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-rqc-'));
    quarantineDir = path.join(stateDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });
    await fs.writeFile(path.join(quarantineDir, validName), validBytes);
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('reads a bare name inside the quarantine directory', async () => {
    const result = await d.readQuarantineCopy(stateDir, validName);
    expect(result.status).toBe('read');
    if (result.status === 'read') {
      expect(result.name).toBe(validName);
      expect(result.path).toBe(path.join(await fs.realpath(quarantineDir), validName));
      expect(Buffer.from(result.bytes).equals(validBytes)).toBe(true);
    }
  });

  it('reads an absolute path', async () => {
    const result = await d.readQuarantineCopy(stateDir, path.join(quarantineDir, validName));
    expect(result.status).toBe('read');
    if (result.status === 'read') {
      expect(Buffer.from(result.bytes).equals(validBytes)).toBe(true);
    }
  });

  it('refuses a copy of another store', async () => {
    const otherName = 'y.json.20261025T101500.123Z-0.0123456789ab';
    const before = await snapshotStateDir(stateDir);
    const result = await d.readQuarantineCopy(stateDir, otherName);
    expect(result).toEqual({
      status: 'refused',
      reason: `${otherName} is not a quarantine copy of x.json`,
    });
    expect(await snapshotStateDir(stateDir)).toEqual(before);
  });

  it('refuses a valid-named file in the state dir root', async () => {
    const rootFile = path.join(stateDir, validName);
    await fs.writeFile(rootFile, validBytes);
    const before = await snapshotStateDir(stateDir);
    const result = await d.readQuarantineCopy(stateDir, rootFile);
    expect(result.status).toBe('refused');
    expect((result as { reason: string }).reason).toContain('--from must name a file directly inside');
    expect(await snapshotStateDir(stateDir)).toEqual(before);
  });

  it('refuses an absolute path that escapes the quarantine directory', async () => {
    const escaping = path.join(quarantineDir, '..', validName);
    const before = await snapshotStateDir(stateDir);
    const result = await d.readQuarantineCopy(stateDir, escaping);
    expect(result.status).toBe('refused');
    expect((result as { reason: string }).reason).toContain('--from must name a file directly inside');
    expect(await snapshotStateDir(stateDir)).toEqual(before);
  });

  it('refuses a symlink inside quarantine pointing outside', async () => {
    const outsideTarget = path.join(stateDir, 'outside.txt');
    await fs.writeFile(outsideTarget, 'out');
    const linkName = 'x.json.20261025T101501.123Z-1.0123456789ab';
    await fs.symlink(outsideTarget, path.join(quarantineDir, linkName));
    const before = await snapshotStateDir(stateDir);
    const result = await d.readQuarantineCopy(stateDir, linkName);
    expect(result).toEqual({ status: 'refused', reason: `${linkName} is a symbolic link` });
    expect(await snapshotStateDir(stateDir)).toEqual(before);
  });

  it('refuses a missing quarantine directory', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-rqc-empty-'));
    try {
      const before = await snapshotStateDir(emptyDir);
      const result = await d.readQuarantineCopy(emptyDir, validName);
      expect(result).toEqual({
        status: 'refused',
        reason: `${path.join(emptyDir, 'quarantine')} does not exist`,
      });
      expect(await snapshotStateDir(emptyDir)).toEqual(before);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO named as a valid copy', async () => {
    const fifoName = 'x.json.20261025T101501.123Z-1.0123456789ab';
    execFileSync('mkfifo', [path.join(quarantineDir, fifoName)]);
    const before = await snapshotStateDir(stateDir);
    const result = await d.readQuarantineCopy(stateDir, fifoName);
    expect(result).toEqual({ status: 'refused', reason: `${fifoName} is not a regular file` });
    expect(await snapshotStateDir(stateDir)).toEqual(before);
  });

  it('refuses a real file in a subdirectory of quarantine', async () => {
    const subDir = path.join(quarantineDir, 'sub');
    await fs.mkdir(subDir);
    const subName = 'x.json.20261025T101502.123Z-2.0123456789ab';
    await fs.writeFile(path.join(subDir, subName), validBytes);
    const before = await snapshotStateDir(stateDir);
    const result = await d.readQuarantineCopy(stateDir, path.join(subDir, subName));
    expect(result.status).toBe('refused');
    expect((result as { reason: string }).reason).toContain('--from must name a file directly inside');
    expect(await snapshotStateDir(stateDir)).toEqual(before);
  });

  it('refuses a valid copy name that does not exist', async () => {
    const missingName = 'x.json.20261025T101503.123Z-3.0123456789ab';
    const before = await snapshotStateDir(stateDir);
    const result = await d.readQuarantineCopy(stateDir, missingName);
    expect(result).toEqual({
      status: 'refused',
      reason: `${missingName} could not be opened (ENOENT)`,
    });
    expect(await snapshotStateDir(stateDir)).toEqual(before);
  });
});

describe('restore', () => {
  let stateDir: string;
  let filePath: string;
  const parser = (raw: unknown): unknown =>
    typeof (raw as { id?: unknown }).id === 'string' ? raw : undefined;
  const d = describeRecordListStore('x.json', parser);
  const candidate = Buffer.from('[{"id":"a"},{"id":"b"}]', 'utf8');
  const currentGarbage = Buffer.from('{ garbage', 'utf8');

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-e1b-restore-'));
    filePath = path.join(stateDir, 'x.json');
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
  });

  async function snapshot() {
    return snapshotStateDir(stateDir);
  }

  it('restores an unreadable store, keeping the old bytes as a mode-600 copy', async () => {
    await fs.writeFile(filePath, currentGarbage);
    const quarantineDir = path.join(stateDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });
    const candidateName = 'x.json.20261025T010000.000Z-0.0123456789ab';
    const candidatePath = path.join(quarantineDir, candidateName);
    await fs.writeFile(candidatePath, candidate);

    const read = await d.readQuarantineCopy(stateDir, candidateName);
    expect(read.status).toBe('read');
    if (read.status !== 'read') {
      return;
    }

    const before = await snapshot();
    const currentSha = createHash('sha256').update(currentGarbage).digest('hex');

    const outcome = await d.restore({
      stateDir,
      candidate: read.bytes,
      expectedCurrentSha256: currentSha,
      protectNames: [candidateName],
    });
    expect(outcome.status).toBe('restored');
    if (outcome.status !== 'restored') {
      return;
    }
    expect(outcome.recordCount).toBe(2);
    expect(outcome.previousCopyPath).not.toBeNull();
    expect(await fs.readFile(filePath)).toEqual(candidate);

    const previousBytes = await fs.readFile(outcome.previousCopyPath!);
    expect(createHash('sha256').update(previousBytes).digest('hex')).toBe(currentSha);
    expect((await fs.stat(outcome.previousCopyPath!)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(candidatePath)).toEqual(candidate);

    // A new copy of the old bytes was added; the candidate (restored) file exists.
    const after = await snapshot();
    expect(after.quarantineCopies).toHaveLength(before.quarantineCopies.length + 1);
  });

  it('reuses an existing regular quarantine copy of the current unreadable bytes', async () => {
    await fs.writeFile(filePath, currentGarbage);
    let existingCopyPath: string | null = null;
    try {
      await quarantineUnreadable(filePath, 'd', currentGarbage);
    } catch (error) {
      if (error instanceof StateFileUnreadableError) {
        existingCopyPath = error.quarantinePath;
      }
    }
    expect(existingCopyPath).not.toBeNull();
    const currentSha = createHash('sha256').update(currentGarbage).digest('hex');

    const outcome = await d.restore({ stateDir, candidate, expectedCurrentSha256: currentSha });
    expect(outcome).toEqual({
      status: 'restored',
      recordCount: 2,
      previousCopyPath: existingCopyPath,
    });
    expect(await fs.readFile(filePath)).toEqual(candidate);
    expect(await fs.readFile(existingCopyPath!)).toEqual(currentGarbage);
  });

  it('does not reuse a symlink in quarantine pointing at the store file, writing a real copy of the old bytes instead', async () => {
    await fs.writeFile(filePath, currentGarbage);
    const currentSha = createHash('sha256').update(currentGarbage).digest('hex');
    const quarantineDir = path.join(stateDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });
    const symlinkName = `x.json.20261025T010000.000Z-0.${currentSha.slice(0, 12)}`;
    const symlinkPath = path.join(quarantineDir, symlinkName);
    await fs.symlink(filePath, symlinkPath);

    const outcome = await d.restore({ stateDir, candidate, expectedCurrentSha256: currentSha });
    expect(outcome.status).toBe('restored');
    if (outcome.status !== 'restored') {
      return;
    }
    expect(outcome.previousCopyPath).not.toBeNull();
    expect(outcome.previousCopyPath).not.toBe(symlinkPath);
    expect((await fs.lstat(outcome.previousCopyPath!)).isFile()).toBe(true);
    expect(await fs.readFile(outcome.previousCopyPath!)).toEqual(currentGarbage);
    expect(await fs.readFile(filePath)).toEqual(candidate);
  });

  it('restores a missing store with expected null and no previous copy', async () => {
    const outcome = await d.restore({ stateDir, candidate, expectedCurrentSha256: null });
    expect(outcome).toEqual({ status: 'restored', recordCount: 2, previousCopyPath: null });
    expect(await fs.readFile(filePath)).toEqual(candidate);
  });

  it('refuses on sha mismatch and leaves the store and quarantine unchanged', async () => {
    await fs.writeFile(filePath, currentGarbage);
    const before = await snapshot();
    const outcome = await d.restore({ stateDir, candidate, expectedCurrentSha256: '0000000000000000000000000000000000000000000000000000000000000000' });
    expect(outcome).toEqual({
      status: 'refused',
      reason: 'the store changed since it was inspected; run state restore again',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a readable current store', async () => {
    const readable = '[{"id":"existing"}]';
    await fs.writeFile(filePath, readable);
    const before = await snapshot();
    const currentSha = createHash('sha256').update(readable).digest('hex');
    const outcome = await d.restore({ stateDir, candidate, expectedCurrentSha256: currentSha });
    expect(outcome).toEqual({
      status: 'refused',
      reason: 'x.json is readable; state restore replaces only a missing or unreadable store',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an invalid candidate', async () => {
    await fs.writeFile(filePath, currentGarbage);
    const before = await snapshot();
    const currentSha = createHash('sha256').update(currentGarbage).digest('hex');
    const outcome = await d.restore({
      stateDir,
      candidate: Buffer.from('{ invalid', 'utf8'),
      expectedCurrentSha256: currentSha,
    });
    expect(outcome.status).toBe('refused');
    expect((outcome as { reason: string }).reason).toContain('the candidate is unreadable');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects with FileLockTimeoutError under a foreign lock and leaves the file unchanged', async () => {
    await fs.writeFile(filePath, currentGarbage);
    const before = await snapshot();
    const currentSha = createHash('sha256').update(currentGarbage).digest('hex');
    await fs.writeFile(`${filePath}.lock`, '54321-foreignhex-0', 'utf8');
    await expect(
      d.restore({ stateDir, candidate, expectedCurrentSha256: currentSha, lockTimeoutMs: 100 }),
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
    expect(await snapshot()).toEqual(before);
  });

  it('keeps the candidate copy when it is the oldest of seven and protected', async () => {
    await fs.writeFile(filePath, currentGarbage);
    const quarantineDir = path.join(stateDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });

    const seedNames = Array.from({ length: 7 }, (_, i) =>
      `x.json.20261025T010000.000Z-${i}.0123456789ab`,
    );
    await Promise.all(
      seedNames.map((name, index) =>
        fs.writeFile(
          path.join(quarantineDir, name),
          index === 0 ? candidate : Buffer.from(`{ seed ${index}`, 'utf8'),
        ),
      ),
    );
    const candidateName = seedNames[0]!;
    const currentSha = createHash('sha256').update(currentGarbage).digest('hex');

    const outcome = await d.restore({
      stateDir,
      candidate,
      expectedCurrentSha256: currentSha,
      protectNames: [candidateName],
    });
    expect(outcome.status).toBe('restored');
    expect(await fs.readFile(filePath)).toEqual(candidate);
    expect(await fs.readdir(quarantineDir)).toContain(candidateName);
  });

  it('refuses when the current store path is a directory', async () => {
    await fs.mkdir(filePath);
    const quarantineDir = path.join(stateDir, 'quarantine');
    await fs.mkdir(quarantineDir, { recursive: true });
    const before = await snapshot();
    const outcome = await d.restore({ stateDir, candidate, expectedCurrentSha256: null });
    expect(outcome).toEqual({
      status: 'refused',
      reason: 'the current file could not be read (EISDIR)',
    });
    expect((await fs.stat(filePath)).isDirectory()).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a missing store when expectedCurrentSha256 is set and creates nothing', async () => {
    const before = await snapshot();
    const outcome = await d.restore({
      stateDir,
      candidate,
      expectedCurrentSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    expect(outcome).toEqual({
      status: 'refused',
      reason: 'the store changed since it was inspected; run state restore again',
    });
    expect(await snapshot()).toEqual(before);
    await expect(fs.stat(filePath)).rejects.toThrow();
  });
});
