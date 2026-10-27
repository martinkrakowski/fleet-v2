import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LaneRunJournalAdapter } from '../LaneRunJournalAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../LaneRunRepositoryAdapter.adapter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dot-names-'));
  tempDirs.push(dir);
  return dir;
}

describe('state stores refuse dot file names', () => {
  for (const fileName of ['.', '..']) {
    it(`refuses ${JSON.stringify(fileName)}`, async () => {
      const tempDir = await makeTempDir();

      await expect(
        new LaneRunJournalAdapter({ stateDir: tempDir, fileName }).listForRun(
          'run-01JB0000000000000000000000',
        ),
      ).rejects.toThrow(/refuses unsafe state file name/);
      await expect(
        new LaneRunRepositoryAdapter({ stateDir: tempDir, fileName }).list(),
      ).rejects.toThrow(/refuses unsafe state file name/);
    });
  }
});
