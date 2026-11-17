// Lane CO5: read-only legacy shell merge-train state reader adapter.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LegacyTrainStateReadAdapter } from './LegacyTrainStateReadAdapter.adapter.js';

const FIRST_HEAD = '0123456789abcdef0123456789abcdef01234567';
const SECOND_HEAD = '0123456789abcdef0123456789abcdef01234568';

const execFileAsync = promisify(execFile);

function lineFor(pullRequest: number, head: string, base = 'main'): string {
  return `${pullRequest} ${head} ${base}`;
}

describe('LegacyTrainStateReadAdapter', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => {})),
    );
  });

  async function makeTempDir(): Promise<string> {
    const directory = await fs.mkdtemp(join(os.tmpdir(), 'legacy-train-'));
    tempDirs.push(directory);
    return directory;
  }

  it('reads the queue, parked and batch files and the chains directory', async () => {
    const dir = await makeTempDir();
    const queueLines = [lineFor(42, FIRST_HEAD), lineFor(7, SECOND_HEAD, 'chain/example-1')];
    const parkedLines = ['parked-1', 'parked-2'];
    const batchLines = ['batch-1'];
    const alphaLines = [lineFor(1, 'a'.repeat(40))];
    const betaLines = [lineFor(2, 'b'.repeat(40))];

    await fs.writeFile(join(dir, 'queue'), `${queueLines.join('\n')}\n`);
    await fs.writeFile(join(dir, 'parked'), `${parkedLines.join('\n')}\n`);
    await fs.writeFile(join(dir, 'batch'), `${batchLines.join('\n')}\n`);
    await fs.mkdir(join(dir, 'chains'));
    await fs.writeFile(join(dir, 'chains', 'alpha.tsv'), `${alphaLines.join('\n')}\n`);
    await fs.writeFile(join(dir, 'chains', 'beta.tsv'), `${betaLines.join('\n')}\n`);

    const adapter = new LegacyTrainStateReadAdapter();
    const result = await adapter.readLegacyTrainState({ stateDir: dir });

    expect(result.queue).toEqual({ status: 'read', lines: queueLines });
    expect(result.parked).toEqual({ status: 'read', lines: parkedLines });
    expect(result.batch).toEqual({ status: 'read', lines: batchLines });
    expect(result.chains).toEqual({
      status: 'read',
      chains: [
        { name: 'alpha', lines: alphaLines },
        { name: 'beta', lines: betaLines },
      ],
    });
  });

  it('known absence for every missing source', async () => {
    const dir = await makeTempDir();
    const adapter = new LegacyTrainStateReadAdapter();
    const result = await adapter.readLegacyTrainState({ stateDir: dir });

    expect(result.queue).toEqual({ status: 'absent' });
    expect(result.parked).toEqual({ status: 'absent' });
    expect(result.chains).toEqual({ status: 'absent' });
    expect(result.batch).toEqual({ status: 'absent' });
  });

  it('reports unreadable instead of throwing', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(join(dir, 'sub'));

    const adapter = new LegacyTrainStateReadAdapter({ queueFileName: 'sub' });
    const result = await adapter.readLegacyTrainState({ stateDir: dir });

    expect(result.queue).toEqual({ status: 'unreadable' });
    expect(result.parked).toEqual({ status: 'absent' });
    expect(result.chains).toEqual({ status: 'absent' });
    expect(result.batch).toEqual({ status: 'absent' });
  });

  it('ignores non-tsv files in the chains directory', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(join(dir, 'chains'));
    await fs.writeFile(join(dir, 'chains', 'notes.txt'), 'not a chain\n');
    await fs.writeFile(join(dir, 'chains', 'alpha.tsv'), `${lineFor(1, 'a'.repeat(40))}\n`);

    const adapter = new LegacyTrainStateReadAdapter();
    const result = await adapter.readLegacyTrainState({ stateDir: dir });

    expect(result.chains).toEqual({
      status: 'read',
      chains: [{ name: 'alpha', lines: [lineFor(1, 'a'.repeat(40))] }],
    });
  });

  it('never writes, locks or deletes', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(join(dir, 'queue'), `${lineFor(42, FIRST_HEAD)}\n`);
    await fs.mkdir(join(dir, 'chains'));
    await fs.writeFile(join(dir, 'chains', 'alpha.tsv'), '1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');

    const before = await fs.readdir(dir);
    const beforeChains = await fs.readdir(join(dir, 'chains'));
    await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });
    const after = await fs.readdir(dir);
    const afterChains = await fs.readdir(join(dir, 'chains'));

    expect(after).toEqual(before);
    expect(afterChains).toEqual(beforeChains);
  });

  it('no path crosses the port', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(join(dir, 'queue'), `${lineFor(42, FIRST_HEAD)}\n`);

    const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

    expect(JSON.stringify(result)).not.toContain(dir);
  });

  it('refuses unsafe file-name options', async () => {
    await expect(() => new LegacyTrainStateReadAdapter({ queueFileName: '../escape' })).toThrow();
    await expect(() => new LegacyTrainStateReadAdapter({ parkedFileName: '.' })).toThrow();
    await expect(() => new LegacyTrainStateReadAdapter({ batchFileName: '..' })).toThrow();
    await expect(() => new LegacyTrainStateReadAdapter({ queueFileName: 'parked' })).toThrow();
  });

  describe('inprogress head', () => {
    it('reads the in-progress head when present', async () => {
      const dir = await makeTempDir();
      const inprogressLines = [lineFor(42, FIRST_HEAD)];
      await fs.writeFile(join(dir, 'inprogress'), `${inprogressLines.join('\n')}\n`);

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.inprogress).toEqual({ status: 'read', lines: inprogressLines });
    });

    it('reports known absence when the in-progress head is missing', async () => {
      const dir = await makeTempDir();

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.inprogress).toEqual({ status: 'absent' });
    });

    it('reports unreadable when the in-progress head is a directory', async () => {
      const dir = await makeTempDir();
      await fs.mkdir(join(dir, 'inprogress'));

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.inprogress).toEqual({ status: 'unreadable' });
    });

    it('reports unreadable instead of following an in-progress symlink that escapes the state directory', async () => {
      const dir = await makeTempDir();
      const outside = await makeTempDir();
      await fs.writeFile(join(outside, 'secret'), 'outside-secret\n');
      await fs.symlink(join(outside, 'secret'), join(dir, 'inprogress'));

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.inprogress).toEqual({ status: 'unreadable' });
      expect(JSON.stringify(result)).not.toContain('outside-secret');
    });

    it('does not hang when the in-progress head is a fifo with no writer', async () => {
      const dir = await makeTempDir();
      await execFileAsync('mkfifo', [join(dir, 'inprogress')]);

      const result = await Promise.race([
        new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read blocked on a fifo')), 2_000)),
      ]);

      expect(result.inprogress).toEqual({ status: 'unreadable' });
    });
  });

  describe('enabled batches', () => {
    it('reads batches/enabled when present', async () => {
      const dir = await makeTempDir();
      const enabledLines = ['example-1', 'example-2'];
      await fs.mkdir(join(dir, 'batches'));
      await fs.writeFile(join(dir, 'batches', 'enabled'), `${enabledLines.join('\n')}\n`);

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.batchesEnabled).toEqual({ status: 'read', lines: enabledLines });
    });

    it('reports known absence when batches/enabled is missing', async () => {
      const dir = await makeTempDir();

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.batchesEnabled).toEqual({ status: 'absent' });
    });

    it('reports known absence when the whole batches directory is missing', async () => {
      const dir = await makeTempDir();

      const result = await new LegacyTrainStateReadAdapter({ batchesDirName: 'batch-buckets' }).readLegacyTrainState({
        stateDir: dir,
      });

      expect(result.batchesEnabled).toEqual({ status: 'absent' });
    });

    it('reports unreadable instead of following an enabled-batches symlink that escapes the state directory', async () => {
      const dir = await makeTempDir();
      const outside = await makeTempDir();
      await fs.writeFile(join(outside, 'secret'), 'outside-secret\n');
      await fs.mkdir(join(dir, 'batches'));
      await fs.symlink(join(outside, 'secret'), join(dir, 'batches', 'enabled'));

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.batchesEnabled).toEqual({ status: 'unreadable' });
      expect(JSON.stringify(result)).not.toContain('outside-secret');
    });

    it('reports unreadable instead of following a batches directory that is itself a symlink out of stateDir', async () => {
      const dir = await makeTempDir();
      const realBatchesHome = await makeTempDir();
      const realBatchesDir = join(realBatchesHome, 'real-batches');
      await fs.mkdir(realBatchesDir);
      const enabledLines = ['escaped-1', 'escaped-2'];
      await fs.writeFile(join(realBatchesDir, 'enabled'), `${enabledLines.join('\n')}\n`);

      // stateDir/batches is a symlink to a real directory elsewhere that
      // itself holds a perfectly normal `enabled` file. Before the fix the
      // existing per-leaf-file O_NOFOLLOW open still traversed this
      // intermediate symlinked directory component and would have returned
      // the escaped content below.
      await fs.symlink(realBatchesDir, join(dir, 'batches'));

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

      expect(result.batchesEnabled).toEqual({ status: 'unreadable' });
      expect(JSON.stringify(result)).not.toContain('escaped-1');
      expect(JSON.stringify(result)).not.toContain('escaped-2');
    });

    it('detects a batches directory swapped to an escaping symlink between the directory check and the read, and discards whatever was read', async () => {
      const dir = await makeTempDir();
      const realBatchesDir = join(dir, 'batches');
      await fs.mkdir(realBatchesDir);
      await fs.writeFile(join(realBatchesDir, 'enabled'), 'real-1\n');

      const outsideHome = await makeTempDir();
      const outsideBatchesDir = join(outsideHome, 'escaped-batches');
      await fs.mkdir(outsideBatchesDir);
      await fs.writeFile(join(outsideBatchesDir, 'enabled'), 'escaped-1\n');

      // Simulate the race the fix narrows: the directory is still real when
      // the FIRST lstat (the "before" check) looks at it, but is replaced
      // with a symlink to an outside directory immediately afterwards —
      // before the open inside readSourceFile resolves. Without the fix,
      // that open would follow the symlink and return the escaped content;
      // this spy reproduces exactly that window by performing the swap as a
      // side effect of the first lstat call for this path, once, then lets
      // every call (including the later "after" check) see the real
      // filesystem state.
      const realLstat = fs.lstat.bind(fs);
      let batchesDirLstatCalls = 0;
      const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (path: Parameters<typeof fs.lstat>[0]) => {
        const stat = await realLstat(path as string);
        if (path === realBatchesDir) {
          batchesDirLstatCalls += 1;
          if (batchesDirLstatCalls === 1) {
            await fs.rm(realBatchesDir, { recursive: true, force: true });
            await fs.symlink(outsideBatchesDir, realBatchesDir);
          }
        }
        return stat;
      });

      try {
        const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

        // The read inside the race window did reach the escaped file (that is
        // the part this fix cannot prevent without an openat-style API), but
        // the post-read directory-identity check catches the swap and the
        // result reports unreadable rather than returning that content.
        expect(result.batchesEnabled).toEqual({ status: 'unreadable' });
        expect(JSON.stringify(result)).not.toContain('escaped-1');
        expect(batchesDirLstatCalls).toBeGreaterThanOrEqual(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('detects a batches directory swapped to a different real directory between the directory check and the read, and discards whatever was read', async () => {
      const dir = await makeTempDir();
      const realBatchesDir = join(dir, 'batches');
      await fs.mkdir(realBatchesDir);
      await fs.writeFile(join(realBatchesDir, 'enabled'), 'real-1\n');

      const swapHome = await makeTempDir();
      const swappedBatchesDir = join(swapHome, 'swapped-batches');
      await fs.mkdir(swappedBatchesDir);
      await fs.writeFile(join(swappedBatchesDir, 'enabled'), 'swapped-real-1\n');

      // This covers the OTHER half of the comparison from the symlink-swap
      // test above: the swap target here is a different REAL directory (not
      // a symlink), with its own normal `enabled` file, so the "after"
      // check sees `kind: 'directory'` just as the "before" check did. Only
      // the device/inode comparison — not the directory-vs-non-directory
      // check — can tell the two directories apart. The spy swaps the path
      // by rename as a side effect of the first lstat call for this path,
      // once, then lets every later call (including the "after" check) see
      // the real filesystem state.
      const realLstat = fs.lstat.bind(fs);
      let batchesDirLstatCalls = 0;
      const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (path: Parameters<typeof fs.lstat>[0]) => {
        const stat = await realLstat(path as string);
        if (path === realBatchesDir) {
          batchesDirLstatCalls += 1;
          if (batchesDirLstatCalls === 1) {
            await fs.rm(realBatchesDir, { recursive: true, force: true });
            await fs.rename(swappedBatchesDir, realBatchesDir);
          }
        }
        return stat;
      });

      try {
        const result = await new LegacyTrainStateReadAdapter().readLegacyTrainState({ stateDir: dir });

        // The swapped-in directory is just as real a directory as the
        // original, so a check that only asked "is this still a directory"
        // would pass it straight through. Only the device/inode comparison
        // tells the two directories apart: removing just the
        // `after.dev !== before.dev || after.ino !== before.ino` half of
        // the guard (leaving `after.kind !== 'directory'` alone) would make
        // this assertion fail, because the swapped-in directory would then
        // satisfy every remaining check and its content would be returned
        // instead of being discarded.
        expect(result.batchesEnabled).toEqual({ status: 'unreadable' });
        expect(JSON.stringify(result)).not.toContain('swapped-real-1');
        expect(batchesDirLstatCalls).toBeGreaterThanOrEqual(2);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('events log', () => {
    it('reads a few event lines exactly', async () => {
      const dir = await makeTempDir();
      const events = ['event-one', 'event-two', 'event-three'];
      await fs.writeFile(join(dir, 'events.jsonl'), `${events.join('\n')}\n`);

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainEvents({ stateDir: dir });

      expect(result).toEqual({ status: 'read', lines: events });
    });

    it('reports known absence when the events log is missing', async () => {
      const dir = await makeTempDir();

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainEvents({ stateDir: dir });

      expect(result).toEqual({ status: 'absent' });
    });

    it('reports unreadable when the events log is a symlink, even to a real file', async () => {
      const dir = await makeTempDir();
      await fs.writeFile(join(dir, 'small-real-file'), 'event-one\n');
      await fs.symlink(join(dir, 'small-real-file'), join(dir, 'events.jsonl'));

      const result = await new LegacyTrainStateReadAdapter().readLegacyTrainEvents({ stateDir: dir });

      expect(result).toEqual({ status: 'unreadable' });
    });

    it('reports too-large without reading when the events log exceeds the byte cap', async () => {
      const dir = await makeTempDir();
      await fs.writeFile(join(dir, 'events.jsonl'), 'event-seventeen!\n');

      const result = await new LegacyTrainStateReadAdapter({ eventsMaxBytes: 16 }).readLegacyTrainEvents({
        stateDir: dir,
      });

      expect(result).toEqual({ status: 'too-large' });
    });

    it('reads an events log of exactly the byte cap', async () => {
      const dir = await makeTempDir();
      const text = 'x'.repeat(16);
      await fs.writeFile(join(dir, 'events.jsonl'), text);

      const result = await new LegacyTrainStateReadAdapter({ eventsMaxBytes: 16 }).readLegacyTrainEvents({
        stateDir: dir,
      });

      expect(result).toEqual({ status: 'read', lines: [text] });
    });

    it('refuses an events file-name option that collides with an existing source', () => {
      expect(() => new LegacyTrainStateReadAdapter({ eventsFileName: 'queue' })).toThrow();
    });
  });
});
