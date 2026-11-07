// Lane CO5: read-only reader for the legacy shell merge-train state directory.
import { promises as fs, type Dirent } from 'node:fs';
import { join } from 'node:path';

import type {
  LegacyTrainChainsRead,
  LegacyTrainFileRead,
  LegacyTrainStateRead,
  LegacyTrainStateReadOptions,
  LegacyTrainStateReadPort,
} from '../../application/ports/out/LegacyTrainStateReadPort.out-port.js';

export interface LegacyTrainStateReadAdapterOptions {
  readonly queueFileName?: string;
  readonly parkedFileName?: string;
  readonly chainsDirName?: string;
  readonly batchFileName?: string;
}

/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

function assertSafeName(name: string): void {
  if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('legacy train state file name must be a safe, non-relative name');
  }
}

/**
 * Read the legacy shell merge-train state directory read-only: the queue,
 * parked and batch files and the chains directory. Absence is known,
 * any other read error is `unreadable`, and no path or file content other
 * than the raw lines crosses the port.
 */
export class LegacyTrainStateReadAdapter implements LegacyTrainStateReadPort {
  private readonly queueFileName: string;
  private readonly parkedFileName: string;
  private readonly chainsDirName: string;
  private readonly batchFileName: string;

  constructor(options: LegacyTrainStateReadAdapterOptions = {}) {
    this.queueFileName = options.queueFileName ?? 'queue';
    this.parkedFileName = options.parkedFileName ?? 'parked';
    this.chainsDirName = options.chainsDirName ?? 'chains';
    this.batchFileName = options.batchFileName ?? 'batch';
    const names = [this.queueFileName, this.parkedFileName, this.chainsDirName, this.batchFileName];
    for (const name of names) {
      assertSafeName(name);
    }
    if (new Set(names).size !== names.length) {
      throw new Error('legacy train state source names must not collide');
    }
  }

  async readLegacyTrainState(options: LegacyTrainStateReadOptions): Promise<LegacyTrainStateRead> {
    const [queue, parked, chains, batch] = await Promise.all([
      this.readSourceFile(this.queueFileName, options.stateDir),
      this.readSourceFile(this.parkedFileName, options.stateDir),
      this.readChains(this.chainsDirName, options.stateDir),
      this.readSourceFile(this.batchFileName, options.stateDir),
    ]);
    return Object.freeze({ queue, parked, chains, batch });
  }

  private async readSourceFile(name: string, stateDir: string): Promise<LegacyTrainFileRead> {
    try {
      const text = await fs.readFile(join(stateDir, name), 'utf8');
      return { status: 'read', lines: Object.freeze(splitLines(text)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'absent' };
      }
      return { status: 'unreadable' };
    }
  }

  private async readChains(name: string, stateDir: string): Promise<LegacyTrainChainsRead> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(join(stateDir, name), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'absent' };
      }
      return { status: 'unreadable' };
    }
    const chains = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith('.tsv')) {
        continue;
      }
      const lines = await this.readSourceFile(dirent.name, join(stateDir, name));
      if (lines.status !== 'read') {
        return { status: 'unreadable' };
      }
      chains.push({ name: dirent.name.slice(0, -'.tsv'.length), lines: lines.lines });
    }
    chains.sort((a, b) => a.name.localeCompare(b.name));
    return { status: 'read', chains: Object.freeze(chains) };
  }
}

/** Split on `\n` and drop a single trailing empty piece; every line stays verbatim. */
function splitLines(text: string): string[] {
  const pieces = text.split('\n');
  if (pieces[pieces.length - 1] === '') {
    pieces.pop();
  }
  return pieces;
}
