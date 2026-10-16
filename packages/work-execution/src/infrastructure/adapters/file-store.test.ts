import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withFileLock, writeJsonAtomically } from './file-store.js';

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
    const order: number[] = [];

    // Start two concurrent saves attempting to acquire the same lock
    const save1 = withFileLock(lockPath, async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push(2);
      await writeJsonAtomically(filePath, { value: 'first' });
    });

    const save2 = withFileLock(lockPath, async () => {
      order.push(3);
      await writeJsonAtomically(filePath, { value: 'second' });
    });

    await Promise.all([save1, save2]);

    // save1 must completely finish (1, 2) before save2 can enter (3)
    expect(order).toEqual([1, 2, 3]);

    const finalRaw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(finalRaw) as { value: string };
    expect(parsed.value).toBe('second');
  });

  it('recovers from a stale lock older than 60 seconds', async () => {
    const lockPath = path.join(tempDir, 'stale.lock');

    // Create a stale lock file written 70 seconds ago
    const stalePayload = JSON.stringify({ pid: 999999, time: Date.now() - 70_000 });
    await fs.writeFile(lockPath, stalePayload, 'utf8');

    let executed = false;
    const result = await withFileLock(lockPath, async () => {
      executed = true;
      return 'acquired';
    });

    expect(executed).toBe(true);
    expect(result).toBe('acquired');

    // Lock must be released after completion
    await expect(fs.access(lockPath)).rejects.toThrow();
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

  it('handles two contenders on a stale lock with Promise.all so exactly one is inside fn at a time', async () => {
    const lockPath = path.join(tempDir, 'stale-contenders.lock');

    // Create a stale lock file written 70 seconds ago
    const staleToken = `99999-0123456789abcdef-${Date.now() - 70_000}`;
    await fs.writeFile(lockPath, staleToken, 'utf8');
    const past = (Date.now() - 70_000) / 1000;
    await fs.utimes(lockPath, past, past);

    let activeCount = 0;
    let maxActiveCount = 0;

    const contender = async () => {
      return withFileLock(lockPath, async () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 60));
        activeCount -= 1;
        return true;
      });
    };

    const results = await Promise.all([contender(), contender()]);
    expect(results).toEqual([true, true]);
    expect(maxActiveCount).toBe(1);
    expect(activeCount).toBe(0);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('does not delete the new holder lock when an old holder whose lock was taken over releases', async () => {
    const lockPath = path.join(tempDir, 'takeover-release.lock');

    let releaseHolderA: () => void = () => {};
    const pauseHolderA = new Promise<void>((resolve) => {
      releaseHolderA = resolve;
    });

    let holderAStarted: () => void = () => {};
    const waitForHolderA = new Promise<void>((resolve) => {
      holderAStarted = resolve;
    });

    const promiseA = withFileLock(lockPath, async () => {
      holderAStarted();
      await pauseHolderA;
    });

    await waitForHolderA;
    const tokenA = await fs.readFile(lockPath, 'utf8');

    // Make the lock stale so holder B can take it over
    const staleTokenA = `${tokenA.slice(0, tokenA.lastIndexOf('-'))}-${Date.now() - 70_000}`;
    await fs.writeFile(lockPath, staleTokenA, 'utf8');
    const past = (Date.now() - 70_000) / 1000;
    await fs.utimes(lockPath, past, past);

    let holderBStarted: () => void = () => {};
    const waitForHolderB = new Promise<void>((resolve) => {
      holderBStarted = resolve;
    });

    let releaseHolderB: () => void = () => {};
    const pauseHolderB = new Promise<void>((resolve) => {
      releaseHolderB = resolve;
    });

    const promiseB = withFileLock(lockPath, async () => {
      holderBStarted();
      await pauseHolderB;
    });

    await waitForHolderB;
    const tokenB = await fs.readFile(lockPath, 'utf8');
    expect(tokenB).not.toBe(tokenA);
    expect(tokenB).not.toBe(staleTokenA);

    // Holder A completes its fn and executes finally
    releaseHolderA();
    await promiseA;

    // Holder A must NOT have deleted Holder B's lock!
    const lockAfterARelease = await fs.readFile(lockPath, 'utf8');
    expect(lockAfterARelease).toBe(tokenB);

    // Holder B completes its fn and releases its lock
    releaseHolderB();
    await promiseB;

    // Lock file is unlinked by Holder B
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
