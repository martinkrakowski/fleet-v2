/**
 * ChainRepositoryAdapter implements ChainRepositoryPort over a per-project
 * chain store (cutover plan CO7b). With a `stateDir` every chain is one JSON
 * file `<stateDir>/chains/<sha256(owner/repo/chain)>.json` holding a single
 * ChainRecord v1; without one the records live in process memory only.
 *
 * Guarantees, each covered by a test:
 *  - never throws on runtime input: every failure is a typed refusal with a
 *    fixed reason code; no input value, path or file content is echoed;
 *  - compare-and-set on the record revision, serialised by one exclusive
 *    store lock, so two writers never both win;
 *  - writes are atomic (unique temp file, fsync, rename, directory fsync); a
 *    torn or partial file reads as `unreadable`, never as a record, and is
 *    never overwritten by an intent; temp files a crash left behind are
 *    removed by the next write under the lock;
 *  - an unreadable, oversized, mismatched or unknown-version record is
 *    `unreadable`, never `not-found`; nothing is quarantined or deleted;
 *  - the state directory is resolved once at construction; a symlinked
 *    `chains` directory is refused and record files are opened with
 *    O_NOFOLLOW, so no link leads out of the state directory;
 *  - reads are size-bounded and the record count is capped.
 * A stale store lock (crashed holder) fails closed as `store-busy`.
 * Accepted residual (owner-confirmed): the lock is released by name, so a
 * hostile same-user process that swaps `.store.lock` between the release check
 * and the unlink can let a third writer in. That process could rewrite the
 * records directly anyway; the store guards accidents and cooperating writers.
 * Follow-up: fd-based locking if Node gains it, or a native helper.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, mkdirSync, promises as fs, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ChainIntentCommand,
  ChainOutcomeCommand,
  ChainReadCommand,
  ChainRecordDecision,
  ChainRecordRead,
  ChainRepositoryPort,
} from '../../application/ports/out/ChainRepositoryPort.out-port.js';
import {
  applyChainOutcome,
  isChainActionKey,
  isChainReasonCode,
  parseChainName,
  parseChainRepository,
  readChainRecord,
} from '../../domain/chain-records.js';
import type { ChainRecord, ChainRepositoryRef } from '../../domain/chain-records.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';

export interface ChainRepositoryAdapterOptions {
  /** When set, records persist under `<stateDir>/chains`; otherwise in memory. */
  readonly stateDir?: string;
  /** Every write refuses with `read-only`; reads still work. */
  readonly readOnly?: boolean;
  /**
   * Off Linux there is no `/proc/self/fd` to pin the directory, so a persistent
   * store refuses to run unless this is set; the path is then re-verified before
   * and after each operation, which narrows but cannot close a swap race.
   */
  readonly allowUnanchoredPaths?: boolean;
  /** Test seam: the exclusive-lock wait cap in milliseconds (default 5000). */
  readonly lockTimeoutMs?: number;
}

/** A stored record is a few hundred bytes; anything past this is not one. */
export const CHAIN_RECORD_MAX_BYTES = 8192;
/** The most chain records one project store holds. */
export const CHAIN_RECORD_MAX_COUNT = 1000;

const CHAINS_DIR = 'chains';
const LOCK_FILE = '.store.lock';
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DIR_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

type Refusal =
  | 'invalid-deadline'
  | 'deadline-expired'
  | 'invalid-record'
  | 'invalid-request'
  | 'read-only'
  | 'store-unavailable'
  | 'store-busy'
  | 'record-unreadable'
  | 'chain-exists'
  | 'chain-not-found'
  | 'action-key-mismatch'
  | 'stale-revision'
  | 'record-limit'
  | 'write-failed'
  | 'internal-error';

function refused(reason: Refusal): ChainRecordDecision {
  return { outcome: 'refused', reason };
}

function unreadable(reason: string): ChainRecordRead {
  return { status: 'unreadable', reason };
}

/** A data property of `value` without running a getter or a Proxy trap. */
function own(value: unknown, key: string): unknown {
  try {
    if (typeof value !== 'object' || value === null) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  try {
    const code = own(error, 'code');
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

interface ChainIdentity {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  readonly key: string;
}

function identityOf(repositoryValue: unknown, chainNameValue: unknown): ChainIdentity | undefined {
  const repository = parseChainRepository(repositoryValue);
  const chainName = parseChainName(chainNameValue);
  if (repository === undefined || chainName === undefined) return undefined;
  const key = createHash('sha256').update(`${repository.owner}/${repository.repo}/${chainName}`).digest('hex');
  return { repository, chainName, key };
}

function freshDeadline(value: unknown): 'ok' | 'invalid-deadline' | 'deadline-expired' {
  if (typeof value !== 'string' || !isZonedIsoDateTime(value)) return 'invalid-deadline';
  return Date.parse(value) > Date.now() ? 'ok' : 'deadline-expired';
}

/** Storage seen from inside the exclusive section. */
interface Section {
  read(id: ChainIdentity): Promise<ChainRecordRead>;
  count(): Promise<number>;
  write(record: ChainRecord, id: ChainIdentity): Promise<void>;
}

class StoreUnavailableError extends Error {}
class StoreBusyError extends Error {}

export class ChainRepositoryAdapter implements ChainRepositoryPort {
  private readonly memory = new Map<string, ChainRecord>();
  private memoryTail: Promise<unknown> = Promise.resolve();
  /** The physical state directory, resolved once; null when unusable. */
  private readonly root: { readonly path: string; readonly dev: number; readonly ino: number } | null;
  private readonly allowUnanchored: boolean;
  private readonly persistent: boolean;
  private readonly readOnly: boolean;
  private readonly lockTimeoutMs: number;

  constructor(options: ChainRepositoryAdapterOptions = {}) {
    const stateDir = own(options, 'stateDir');
    this.readOnly = own(options, 'readOnly') === true;
    const lockMs = own(options, 'lockTimeoutMs');
    this.lockTimeoutMs =
      typeof lockMs === 'number' && Number.isFinite(lockMs) && lockMs > 0 ? lockMs : DEFAULT_LOCK_TIMEOUT_MS;
    this.allowUnanchored = own(options, 'allowUnanchoredPaths') === true;
    this.persistent = stateDir !== undefined;
    this.root = typeof stateDir === 'string' ? ChainRepositoryAdapter.resolveRoot(stateDir, this.readOnly) : null;
  }

  private static resolveRoot(
    stateDir: string,
    readOnly: boolean,
  ): { readonly path: string; readonly dev: number; readonly ino: number } | null {
    try {
      if (stateDir.trim().length === 0 || stateDir.includes('\0')) return null;
      if (!readOnly) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const physical = realpathSync(stateDir);
      const stat = statSync(physical);
      return stat.isDirectory() ? { path: physical, dev: stat.dev, ino: stat.ino } : null;
    } catch {
      return null;
    }
  }

  async recordChainIntent(command: ChainIntentCommand): Promise<ChainRecordDecision> {
    try {
      const deadline = freshDeadline(own(command, 'deadlineIso'));
      if (deadline !== 'ok') return refused(deadline);
      const decoded = readChainRecord(own(command, 'record'));
      if (!decoded.ok) return refused('invalid-record');
      const record = decoded.record;
      if (record.state !== 'intent-recorded' || record.revision !== 1 || record.reason !== null) {
        return refused('invalid-record');
      }
      const id = identityOf(record.repository, record.chainName);
      if (id === undefined) return refused('invalid-record');
      if (this.readOnly) return refused('read-only');
      return await this.exclusive(own(command, 'deadlineIso') as string, async (section) => {
        const current = await section.read(id);
        if (current.status === 'unreadable') return refused('record-unreadable');
        if (current.status === 'ok') {
          return current.record.actionKey === record.actionKey
            ? ({ outcome: 'already-recorded' } as const)
            : refused('chain-exists');
        }
        if ((await section.count()) >= CHAIN_RECORD_MAX_COUNT) return refused('record-limit');
        await section.write(record, id);
        return { outcome: 'recorded' } as const;
      });
    } catch (error) {
      return this.refusalFor(error);
    }
  }

  async recordChainOutcome(command: ChainOutcomeCommand): Promise<ChainRecordDecision> {
    try {
      const deadline = freshDeadline(own(command, 'deadlineIso'));
      if (deadline !== 'ok') return refused(deadline);
      const id = identityOf(own(command, 'repository'), own(command, 'chainName'));
      const actionKey = own(command, 'actionKey');
      const expectedRevision = own(command, 'expectedRevision');
      const state = own(command, 'state');
      const reason = own(command, 'reason');
      if (id === undefined || !isChainActionKey(actionKey)) return refused('invalid-request');
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        return refused('invalid-request');
      }
      if (state !== 'started' && state !== 'refused') return refused('invalid-request');
      if (state === 'started' ? reason !== null : !isChainReasonCode(reason)) return refused('invalid-request');
      if (this.readOnly) return refused('read-only');
      return await this.exclusive(own(command, 'deadlineIso') as string, async (section) => {
        const current = await section.read(id);
        if (current.status === 'unreadable') return refused('record-unreadable');
        if (current.status === 'not-found') return refused('chain-not-found');
        if (current.record.actionKey !== actionKey) return refused('action-key-mismatch');
        if (current.record.revision !== expectedRevision || current.record.state !== 'intent-recorded') {
          return refused('stale-revision');
        }
        const next = applyChainOutcome(current.record, { state, reason: state === 'started' ? null : (reason as string) });
        const check = readChainRecord(next);
        if (!check.ok) return refused('invalid-record');
        await section.write(check.record, id);
        return { outcome: 'recorded' } as const;
      });
    } catch (error) {
      return this.refusalFor(error);
    }
  }

  async readChain(command: ChainReadCommand): Promise<ChainRecordRead> {
    try {
      if (freshDeadline(own(command, 'deadlineIso')) !== 'ok') return unreadable('invalid-deadline');
      const id = identityOf(own(command, 'repository'), own(command, 'chainName'));
      if (id === undefined) return unreadable('invalid-request');
      if (!this.persistent) return this.readMemory(id);
      const read = await this.withChainsDir(false, (dir) => this.readFile(dir, id));
      return read === 'absent' ? { status: 'not-found' } : read;
    } catch {
      return unreadable('store-unavailable');
    }
  }

  // ---------- exclusive section ----------

  private refusalFor(error: unknown): ChainRecordDecision {
    if (error instanceof StoreUnavailableError) return refused('store-unavailable');
    if (error instanceof StoreBusyError) return refused('store-busy');
    return refused('internal-error');
  }

  private async exclusive(
    deadlineIso: string,
    run: (section: Section) => Promise<ChainRecordDecision>,
  ): Promise<ChainRecordDecision> {
    if (!this.persistent) {
      const result = this.memoryTail.then(() => run(this.memorySection()));
      this.memoryTail = result.catch(() => undefined);
      return result;
    }
    const remaining = Math.max(1, Date.parse(deadlineIso) - Date.now());
    const timeoutMs = Math.min(this.lockTimeoutMs, remaining);
    const decided = await this.withChainsDir(true, async (dir) => {
      return this.withStoreLock(join(dir, LOCK_FILE), timeoutMs, async () => {
        if (freshDeadline(deadlineIso) !== 'ok') return refused('deadline-expired');
        await this.removeOrphanTemps(dir);
        return run(this.fileSection(dir));
      });
    });
    if (decided === 'absent') throw new StoreUnavailableError();
    return decided;
  }

  /**
   * The exclusive store lock: a file created with O_EXCL and O_NOFOLLOW whose
   * content is never read, so a planted link or device is never followed. A
   * lock left by a crashed holder fails closed as store-busy until removed by
   * the operator. Released only when the path still is the file this call made.
   */
  private async withStoreLock<T>(lockPath: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let handle: fs.FileHandle | undefined;
    for (;;) {
      try {
        handle = await fs.open(
          lockPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw new StoreUnavailableError();
        if (Date.now() - started >= timeoutMs) throw new StoreBusyError();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      const mine = await handle.stat();
      try {
        return await run();
      } finally {
        const now = await fs.lstat(lockPath).catch(() => null);
        if (now !== null && now.isFile() && now.ino === mine.ino && now.dev === mine.dev) {
          await fs.unlink(lockPath).catch(() => undefined);
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  // ---------- memory ----------

  private memorySection(): Section {
    return {
      read: async (id) => this.readMemory(id),
      count: async () => this.memory.size,
      write: async (record, id) => {
        this.memory.set(id.key, record);
      },
    };
  }

  private readMemory(id: ChainIdentity): ChainRecordRead {
    const record = this.memory.get(id.key);
    return record === undefined ? { status: 'not-found' } : { status: 'ok', record };
  }

  // ---------- files ----------

  /**
   * Open the state root (checked against the device and inode pinned at
   * construction) and the `chains` directory under it, neither through a link,
   * and run `use` against a path anchored to the open handle. On Linux the
   * anchor is `/proc/self/fd/<n>`, so swapping either directory for a link or
   * another directory after the check cannot redirect any later operation. Off
   * Linux the store refuses to run unless `allowUnanchoredPaths` is set.
   * 'absent' when `chains` does not exist and `create` is false. Unusable
   * stores throw StoreUnavailableError.
   */
  private async withChainsDir<T>(create: boolean, use: (dir: string) => Promise<T>): Promise<T | 'absent'> {
    if (this.root === null) throw new StoreUnavailableError();
    const anchored = process.platform === 'linux';
    if (!anchored && !this.allowUnanchored) throw new StoreUnavailableError();
    const rootHandle = await this.openPinnedRoot(this.root);
    let chainsHandle: fs.FileHandle | 'absent' | undefined;
    try {
      const named = join(anchored ? `/proc/self/fd/${rootHandle.fd}` : this.root.path, CHAINS_DIR);
      chainsHandle = await ChainRepositoryAdapter.openChains(named, create);
      if (chainsHandle === 'absent') return 'absent';
      if (anchored) return await use(`/proc/self/fd/${chainsHandle.fd}`);
      const pinned = chainsHandle;
      const verify = async (): Promise<void> => {
        const [now, held] = await Promise.all([fs.lstat(named), pinned.stat()]);
        if (now.isSymbolicLink() || now.ino !== held.ino || now.dev !== held.dev) throw new StoreUnavailableError();
      };
      await verify();
      const result = await use(named);
      await verify();
      return result;
    } finally {
      if (chainsHandle !== undefined && chainsHandle !== 'absent') await chainsHandle.close().catch(() => undefined);
      await rootHandle.close().catch(() => undefined);
    }
  }

  /** Open the state root without following a link and check it is the directory pinned at construction. */
  private async openPinnedRoot(root: { readonly path: string; readonly dev: number; readonly ino: number }): Promise<fs.FileHandle> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(root.path, DIR_FLAGS);
    } catch {
      throw new StoreUnavailableError();
    }
    const stat = await handle.stat().catch(() => null);
    if (stat === null || !stat.isDirectory() || stat.dev !== root.dev || stat.ino !== root.ino) {
      await handle.close().catch(() => undefined);
      throw new StoreUnavailableError();
    }
    return handle;
  }

  /** Open (creating when asked) the `chains` directory without following a link. */
  private static async openChains(named: string, create: boolean): Promise<fs.FileHandle | 'absent'> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(named, DIR_FLAGS);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new StoreUnavailableError();
      if (!create) return 'absent';
      try {
        await fs.mkdir(named, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw new StoreUnavailableError();
      }
      try {
        handle = await fs.open(named, DIR_FLAGS);
      } catch {
        throw new StoreUnavailableError();
      }
    }
    if (!(await handle.stat().catch(() => null))?.isDirectory()) {
      await handle.close().catch(() => undefined);
      throw new StoreUnavailableError();
    }
    return handle;
  }

  private fileSection(dir: string): Section {
    return {
      read: (id) => this.readFile(dir, id),
      count: async () => (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).length,
      write: (record, id) => this.writeFile(dir, id, record),
    };
  }

  private async readFile(dir: string, id: ChainIdentity): Promise<ChainRecordRead> {
    const target = join(dir, `${id.key}.json`);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return { status: 'not-found' };
      if (code === 'ELOOP') return unreadable('symlink-refused');
      return unreadable('store-unavailable');
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return unreadable('not-a-regular-file');
      if (stat.size > CHAIN_RECORD_MAX_BYTES) return unreadable('record-too-large');
      const buffer = Buffer.alloc(CHAIN_RECORD_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > CHAIN_RECORD_MAX_BYTES) return unreadable('record-too-large');
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
      } catch {
        return unreadable('not-valid-json');
      }
      const decoded = readChainRecord(parsed);
      if (!decoded.ok) return unreadable(decoded.reason);
      const record = decoded.record;
      if (
        record.repository.owner !== id.repository.owner ||
        record.repository.repo !== id.repository.repo ||
        record.chainName !== id.chainName
      ) {
        return unreadable('identity-mismatch');
      }
      return { status: 'ok', record };
    } catch {
      return unreadable('store-unavailable');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async writeFile(dir: string, id: ChainIdentity, record: ChainRecord): Promise<void> {
    const body = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(body, 'utf8') > CHAIN_RECORD_MAX_BYTES) throw new Error('record-too-large');
    const target = join(dir, `${id.key}.json`);
    const temp = join(dir, `${id.key}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      const dirHandle = await fs.open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // directory fsync is best effort; the rename already happened
    }
  }

  /** Under the exclusive lock no writer is mid-write, so every temp file is an orphan of a crash. */
  private async removeOrphanTemps(dir: string): Promise<void> {
    try {
      for (const name of await fs.readdir(dir)) {
        if (name.endsWith('.tmp')) await fs.rm(join(dir, name), { force: true });
      }
    } catch {
      // best effort; an orphan never reads as a record
    }
  }
}
