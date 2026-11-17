// Lane CO5: read-only reader for the legacy shell merge-train state directory.
import { promises as fs, constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { join } from 'node:path';

import type {
  LegacyTrainChainsRead,
  LegacyTrainEventsRead,
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
  readonly inprogressFileName?: string;
  readonly batchesDirName?: string;
  readonly eventsFileName?: string;
  readonly eventsMaxBytes?: number;
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
  private readonly inprogressFileName: string;
  private readonly batchesDirName: string;
  private readonly eventsFileName: string;
  private readonly eventsMaxBytes: number;

  constructor(options: LegacyTrainStateReadAdapterOptions = {}) {
    this.queueFileName = options.queueFileName ?? 'queue';
    this.parkedFileName = options.parkedFileName ?? 'parked';
    this.chainsDirName = options.chainsDirName ?? 'chains';
    this.batchFileName = options.batchFileName ?? 'batch';
    this.inprogressFileName = options.inprogressFileName ?? 'inprogress';
    this.batchesDirName = options.batchesDirName ?? 'batches';
    this.eventsFileName = options.eventsFileName ?? 'events.jsonl';
    this.eventsMaxBytes = options.eventsMaxBytes ?? 33_554_432;
    const names = [
      this.queueFileName,
      this.parkedFileName,
      this.chainsDirName,
      this.batchFileName,
      this.inprogressFileName,
      this.batchesDirName,
      this.eventsFileName,
    ];
    for (const name of names) {
      assertSafeName(name);
    }
    if (new Set(names).size !== names.length) {
      throw new Error('legacy train state source names must not collide');
    }
    if (
      !Number.isSafeInteger(this.eventsMaxBytes) ||
      this.eventsMaxBytes < 1 ||
      this.eventsMaxBytes > 67_108_864
    ) {
      throw new Error('legacy train state events max bytes must be an integer between 1 and 67108864');
    }
  }

  async readLegacyTrainState(options: LegacyTrainStateReadOptions): Promise<LegacyTrainStateRead> {
    const [queue, parked, chains, batch, inprogress, batchesEnabled] = await Promise.all([
      this.readSourceFile(this.queueFileName, options.stateDir),
      this.readSourceFile(this.parkedFileName, options.stateDir),
      this.readChains(this.chainsDirName, options.stateDir),
      this.readSourceFile(this.batchFileName, options.stateDir),
      this.readSourceFile(this.inprogressFileName, options.stateDir),
      this.readBatchesEnabled(options.stateDir),
    ]);
    return Object.freeze({ queue, parked, chains, batch, inprogress, batchesEnabled });
  }

  /**
   * Read the events log without racing the legacy writer: the open refuses a
   * symlink at the final component (O_NOFOLLOW), the size check uses the stat
   * of the open descriptor, and the read is bounded by `eventsMaxBytes` — so a
   * concurrent append or replacement can never make more than one extra byte
   * past the cap be read.
   */
  async readLegacyTrainEvents(options: LegacyTrainStateReadOptions): Promise<LegacyTrainEventsRead> {
    const eventsPath = join(options.stateDir, this.eventsFileName);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(eventsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { status: 'absent' };
      }
      return { status: 'unreadable' };
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { status: 'unreadable' };
      }
      if (stats.size > this.eventsMaxBytes) {
        return { status: 'too-large' };
      }
      const buffer = await readHandleBytes(handle, this.eventsMaxBytes + 1);
      if (buffer.length > this.eventsMaxBytes) {
        return { status: 'too-large' };
      }
      return { status: 'read', lines: Object.freeze(splitLines(buffer.toString('utf8'))) };
    } catch {
      return { status: 'unreadable' };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Read `batches/enabled`, refusing it the same way an unreadable file is
   * refused today when the `batches` directory COMPONENT itself is not a
   * real directory, or is swapped to something else during the read.
   *
   * Background: `readSourceFile`'s O_NOFOLLOW only protects the final path
   * component (`enabled`). If `batchesDirName` is itself a symlink out of
   * stateDir, the open still traverses it to reach whatever `enabled` sits
   * at the far end. An lstat of the `batches` component on its own, before
   * any descent into it, catches a symlink that is already there when this
   * call starts (`lstatDirectoryIdentity` below) — but Node's `fs` module
   * has no public, stable way to open a path relative to an already-open
   * directory descriptor (no `openat`-style API as of this repo's targeted
   * Node version), so the directory check and the file open are necessarily
   * two separate syscalls. A swap landing in the gap between them — after
   * this method's first check sees a real directory, but before the open
   * inside `readSourceFile` resolves — is not prevented by that check alone;
   * it is only narrowed. `BriefAuthoringAdapter`'s `pathCrossesSymbolicLink`
   * has this exact same residual window for its own intermediate-component
   * checks: it also lstats a path and only afterwards performs a separate
   * open, with no atomicity between the two.
   *
   * To narrow the window as far as this adapter can without an unstable API,
   * the `batches` component is lstat'd again immediately after the read,
   * and its device and inode are compared against the first lstat. A swap
   * left in place afterwards (the likely case: nothing requires an attacker
   * to revert it) shows up as a non-directory on the second lstat; a swap to
   * a different real directory and back shows up as a different inode.
   * Either mismatch discards whatever was just read and reports
   * `unreadable`, so content read during a race in this narrow window never
   * reaches the caller. This cannot stop the one read that happens inside
   * that window from touching the wrong file on disk — it can only stop
   * that file's content from being returned.
   */
  private async readBatchesEnabled(stateDir: string): Promise<LegacyTrainFileRead> {
    const batchesDir = join(stateDir, this.batchesDirName);
    const before = await this.lstatDirectoryIdentity(batchesDir);
    if (before.kind !== 'directory') {
      return before.kind === 'absent' ? { status: 'absent' } : { status: 'unreadable' };
    }
    const result = await this.readSourceFile('enabled', batchesDir);
    const after = await this.lstatDirectoryIdentity(batchesDir);
    if (after.kind !== 'directory' || after.dev !== before.dev || after.ino !== before.ino) {
      return { status: 'unreadable' };
    }
    return result;
  }

  /**
   * lstat a path (never following a symlink) and report whether it is a
   * real directory right now, identified by its device and inode so a later
   * call against the same path can detect whether it still names the same
   * directory.
   */
  private async lstatDirectoryIdentity(
    path: string,
  ): Promise<{ kind: 'absent' } | { kind: 'not-directory' } | { kind: 'directory'; dev: number; ino: number }> {
    let stat: Stats;
    try {
      stat = await fs.lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { kind: 'absent' };
      }
      return { kind: 'not-directory' };
    }
    return stat.isDirectory() ? { kind: 'directory', dev: stat.dev, ino: stat.ino } : { kind: 'not-directory' };
  }

  /**
   * Read a small state file without racing the legacy writer and without ever
   * blocking: the open refuses a symlink at the final component (O_NOFOLLOW)
   * and does not wait on a FIFO (O_NONBLOCK), and the content is only read
   * once the descriptor has been confirmed to be a regular file.
   */
  private async readSourceFile(name: string, stateDir: string): Promise<LegacyTrainFileRead> {
    const path = join(stateDir, name);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { status: 'absent' };
      }
      return { status: 'unreadable' };
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { status: 'unreadable' };
      }
      return { status: 'read', lines: Object.freeze(splitLines((await readHandleBytes(handle)).toString('utf8'))) };
    } catch {
      return { status: 'unreadable' };
    } finally {
      await handle.close().catch(() => undefined);
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

/**
 * Read the whole descriptor into memory in chunks, at most `limit` bytes
 * when a limit is given (an unbounded read to EOF otherwise). The descriptor
 * is expected to be opened with O_NONBLOCK, so a FIFO can never make this wait.
 */
async function readHandleBytes(handle: fs.FileHandle, limit?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const size = limit === undefined ? 65_536 : Math.min(65_536, limit - total);
    if (size <= 0) {
      break;
    }
    const chunk = Buffer.alloc(size);
    const { bytesRead } = await handle.read(chunk, 0, size, total);
    if (bytesRead === 0) {
      break;
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
