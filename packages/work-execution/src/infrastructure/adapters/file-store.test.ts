import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileLockTimeoutError,
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
      await quarantineUnreadable(filePath, 'not valid JSON');
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

  it('keeps only the 5 newest quarantine copies for a basename after a sixth failure', async () => {
    const filePath = path.join(tempDir, 'attempts.json');
    for (let index = 0; index < 6; index += 1) {
      await fs.writeFile(filePath, `{ corrupt #${index}`, 'utf8');
      await expect(quarantineUnreadable(filePath, 'not valid JSON')).rejects.toBeInstanceOf(
        StateFileUnreadableError,
      );
    }
    const copies = await fs.readdir(path.join(tempDir, 'quarantine'));
    expect(copies).toHaveLength(5);
    for (const copy of copies) {
      expect(copy.startsWith('attempts.json.')).toBe(true);
    }
  });

  it('throws with quarantinePath null when the copy itself fails', async () => {
    // The parent directory does not exist, so reading/copying fails.
    const filePath = path.join(tempDir, 'missing', 'attempts.json');
    let caught: unknown;
    try {
      await quarantineUnreadable(filePath, 'not valid JSON');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateFileUnreadableError);
    const error = caught as StateFileUnreadableError;
    expect(error.quarantinePath).toBeNull();
    expect(error.message).toContain('could not be copied');
  });
});
