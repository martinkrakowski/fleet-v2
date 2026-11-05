// @generated adapter scaffold — implemented for lane KS2b (local transactional store).
/**
 * GateReceiptReuseAdapter implements GateReceiptReusePort (local-transactional-store).
 *
 * Layout: one small JSON file per key, `<stateDir>/gate-receipts/<sha256 of the
 * canonical key>.json`; in memory when `stateDir` is omitted. A receipt is
 * written once per key by hard-linking a fully written temp file into place
 * (`link` fails when the name exists), so a reader sees a whole receipt or
 * none, a crash leaves only an ignorable `.tmp` file, and two writers cannot
 * overwrite each other. No lock is held, so no lock can be left behind by a
 * crash. A stored file is trusted only after it is re-read, size-checked,
 * parsed, version-checked and found to carry the very key it was looked up
 * by; anything else is a miss ("re-run"), never a pass.
 *
 * Guards: neither method throws and each is bounded by a deadline; a symlink
 * as the state directory, the store directory or a receipt file is never
 * followed; a receipt file over 4 KiB or a store over `maxRecords` receipts is
 * refused; a secret-shaped key or reference is refused before anything is
 * written and is never echoed (results carry fixed reasons only).
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import type {
  FindGateReceiptResult,
  GateReceiptReusePort,
  GateReceiptReuseVerdict,
  RecordGateReceiptRefusalReason,
  RecordGateReceiptRequest,
  RecordGateReceiptResult,
} from '../../application/ports/out/GateReceiptReusePort.out-port.js';
import {
  gateReceiptKeysEqual,
  readGateReceiptKeyRecord,
  type GateReceiptKey,
} from '../../domain/gate-receipt-key.js';
import { isPlainRecordObject } from '../../domain/record-schema-version.js';

export const GATE_RECEIPT_STORE_DIRECTORY = 'gate-receipts';
export const GATE_RECEIPT_RECORD_VERSION = 1 as const;
export const GATE_RECEIPT_MAX_FILE_BYTES = 4096;
export const GATE_RECEIPT_DEFAULT_MAX_RECORDS = 2000;
export const GATE_RECEIPT_HARD_MAX_RECORDS = 100_000;
export const GATE_RECEIPT_DEFAULT_DEADLINE_MS = 5000;
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
const MAX_TEMP_SWEEP = 100;
const MAX_FOREIGN_ENTRIES = 1000;
const MAX_RECEIPT_REF_LENGTH = 200;
const RECEIPT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@#+=-]*$/;
const RECORD_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;

export interface GateReceiptReuseAdapterOptions {
  /** Directory for file-backed receipts; in memory only when omitted. */
  readonly stateDir?: string;
  /** Every write is refused with `store-read-only`. */
  readonly readOnly?: boolean;
  /** Most receipts the store holds (default 2000); past it a new key is refused with `store-full`. */
  readonly maxRecords?: number;
  /** Deadline of one call in milliseconds (default 5000); past it the call is a miss or a refusal. */
  readonly deadlineMs?: number;
}

interface StoredReceipt {
  readonly verdict: GateReceiptReuseVerdict;
  readonly receiptRef: string;
}

type ReadKeyResult =
  | { readonly ok: true; readonly key: GateReceiptKey }
  | { readonly ok: false; readonly reason: 'key-unreadable' | 'key-version-unknown' };

type StoredRead =
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly receipt: StoredReceipt }
  | { readonly status: 'unreadable' }
  | { readonly status: 'version-unknown' }
  | { readonly status: 'failed' };

class StoreFailure extends Error {
  constructor(readonly reason: 'store-unreadable' | 'store-failed') {
    super(reason);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** The key re-read through the domain's validator (version, shapes, secret check); a copy, never the caller's object. */
function readKey(input: unknown): ReadKeyResult {
  try {
    const read = readGateReceiptKeyRecord(input);
    if (read.ok) {
      return { ok: true, key: read.record };
    }
    return { ok: false, reason: read.reason === 'stored-key-version-unknown' ? 'key-version-unknown' : 'key-unreadable' };
  } catch {
    return { ok: false, reason: 'key-unreadable' };
  }
}

function readVerdict(value: unknown): GateReceiptReuseVerdict | undefined {
  return value === 'pass' || value === 'fail' ? value : undefined;
}

function readReceiptRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_RECEIPT_REF_LENGTH) {
    return undefined;
  }
  if (!RECEIPT_REF_PATTERN.test(value) || isSecretShaped(value)) {
    return undefined;
  }
  return value;
}

function canonicalKey(key: GateReceiptKey): string {
  return JSON.stringify([
    key.schemaVersion,
    key.predicateId,
    key.treeHash,
    key.predicateDefinitionDigest,
    key.toolchainVersions.node,
    key.toolchainVersions.yarn,
    key.toolchainVersions.hexagen,
    key.toolchainVersions.turbo,
    key.declaredEnvironmentDigest,
  ]);
}

function keyDigest(key: GateReceiptKey): string {
  return createHash('sha256').update(canonicalKey(key)).digest('hex');
}

function ownValue(record: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor === undefined || !('value' in descriptor) ? undefined : descriptor.value;
}

/** Parse one stored file's text into the receipt it holds for exactly `key`; never throws. */
function parseStoredReceipt(text: string, key: GateReceiptKey): StoredRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'unreadable' };
  }
  if (!isPlainRecordObject(parsed)) {
    return { status: 'unreadable' };
  }
  const stored = readGateReceiptKeyRecord(parsed);
  if (!stored.ok) {
    return { status: stored.reason === 'stored-key-version-unknown' ? 'version-unknown' : 'unreadable' };
  }
  // The file must be the very key it was looked up by, not a misplaced or copied file.
  if (!gateReceiptKeysEqual(stored.record, key)) {
    return { status: 'unreadable' };
  }
  const verdict = readVerdict(ownValue(parsed, 'verdict'));
  const receiptRef = readReceiptRef(ownValue(parsed, 'receiptRef'));
  if (verdict === undefined || receiptRef === undefined) {
    return { status: 'unreadable' };
  }
  return { status: 'ok', receipt: { verdict, receiptRef } };
}

function serializeReceipt(key: GateReceiptKey, receipt: StoredReceipt): string {
  return `${JSON.stringify({
    schemaVersion: GATE_RECEIPT_RECORD_VERSION,
    predicateId: key.predicateId,
    treeHash: key.treeHash,
    predicateDefinitionDigest: key.predicateDefinitionDigest,
    toolchainVersions: {
      node: key.toolchainVersions.node,
      yarn: key.toolchainVersions.yarn,
      hexagen: key.toolchainVersions.hexagen,
      turbo: key.toolchainVersions.turbo,
    },
    declaredEnvironmentDigest: key.declaredEnvironmentDigest,
    verdict: receipt.verdict,
    receiptRef: receipt.receiptRef,
  })}\n`;
}

/** Run `work` against a deadline; the late result of an overrun is discarded and never throws. */
async function withDeadline<T>(deadlineMs: number, work: () => Promise<T>, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), deadlineMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class GateReceiptReuseAdapter implements GateReceiptReusePort {
  private readonly memory = new Map<string, StoredReceipt>();
  private readonly maxRecords: number;
  private readonly deadlineMs: number;
  private tempCounter = 0;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options?: GateReceiptReuseAdapterOptions) {
    const maxRecords = options?.maxRecords;
    this.maxRecords =
      typeof maxRecords === 'number' && Number.isSafeInteger(maxRecords) && maxRecords >= 1
        ? Math.min(maxRecords, GATE_RECEIPT_HARD_MAX_RECORDS)
        : GATE_RECEIPT_DEFAULT_MAX_RECORDS;
    const deadlineMs = options?.deadlineMs;
    this.deadlineMs =
      typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && deadlineMs >= 1
        ? deadlineMs
        : GATE_RECEIPT_DEFAULT_DEADLINE_MS;
  }

  async findGateReceipt(key: GateReceiptKey): Promise<FindGateReceiptResult> {
    try {
      const read = readKey(key);
      if (!read.ok) {
        return { outcome: 'miss', reason: read.reason };
      }
      return await withDeadline<FindGateReceiptResult>(
        this.deadlineMs,
        () => this.find(read.key),
        { outcome: 'miss', reason: 'store-timeout' },
      );
    } catch {
      return { outcome: 'miss', reason: 'store-failed' };
    }
  }

  async recordGateReceipt(request: RecordGateReceiptRequest): Promise<RecordGateReceiptResult> {
    try {
      if (!isPlainRecordObject(request)) {
        return { outcome: 'refused', reason: 'key-unreadable' };
      }
      const read = readKey(ownValue(request, 'key'));
      if (!read.ok) {
        return { outcome: 'refused', reason: read.reason };
      }
      const verdict = readVerdict(ownValue(request, 'verdict'));
      if (verdict === undefined) {
        return { outcome: 'refused', reason: 'verdict-unreadable' };
      }
      const receiptRef = readReceiptRef(ownValue(request, 'receiptRef'));
      if (receiptRef === undefined) {
        return { outcome: 'refused', reason: 'receipt-ref-unreadable' };
      }
      if (this.options?.readOnly === true) {
        return { outcome: 'refused', reason: 'store-read-only' };
      }
      return await withDeadline<RecordGateReceiptResult>(
        this.deadlineMs,
        () => this.serialized(() => this.record(read.key, { verdict, receiptRef })),
        { outcome: 'refused', reason: 'store-timeout' },
      );
    } catch {
      return { outcome: 'refused', reason: 'store-failed' };
    }
  }

  /**
   * Writes of one adapter run one at a time, so the receipt count, a repair of an unreadable receipt and
   * the write-once publication cannot interleave inside this process. Between processes the guard is the
   * exclusive `link`; a state directory has one writing driver by the fleet's rule.
   */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(work, work);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async find(key: GateReceiptKey): Promise<FindGateReceiptResult> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const found = this.memory.get(canonicalKey(key));
      return found === undefined
        ? { outcome: 'miss', reason: 'no-stored-receipt' }
        : { outcome: 'hit', verdict: found.verdict, receiptRef: found.receiptRef };
    }
    try {
      const directory = await this.openStoreDirectory(stateDir, false);
      if (directory === null) {
        return { outcome: 'miss', reason: 'no-stored-receipt' };
      }
      const read = await this.readStored(path.join(directory, `${keyDigest(key)}.json`), key);
      switch (read.status) {
        case 'ok':
          return { outcome: 'hit', verdict: read.receipt.verdict, receiptRef: read.receipt.receiptRef };
        case 'absent':
          return { outcome: 'miss', reason: 'no-stored-receipt' };
        case 'unreadable':
          return { outcome: 'miss', reason: 'store-unreadable' };
        case 'version-unknown':
          return { outcome: 'miss', reason: 'store-version-unknown' };
        default:
          return { outcome: 'miss', reason: 'store-failed' };
      }
    } catch (error: unknown) {
      return { outcome: 'miss', reason: error instanceof StoreFailure ? error.reason : 'store-failed' };
    }
  }

  private async record(key: GateReceiptKey, receipt: StoredReceipt): Promise<RecordGateReceiptResult> {
    const stateDir = this.options?.stateDir;
    if (stateDir === undefined) {
      const canonical = canonicalKey(key);
      if (this.memory.has(canonical)) {
        return { outcome: 'already-recorded' };
      }
      if (this.memory.size >= this.maxRecords) {
        return { outcome: 'refused', reason: 'store-full' };
      }
      this.memory.set(canonical, receipt);
      return { outcome: 'recorded' };
    }
    try {
      const directory = await this.openStoreDirectory(stateDir, true);
      if (directory === null) {
        return { outcome: 'refused', reason: 'store-failed' };
      }
      const target = path.join(directory, `${keyDigest(key)}.json`);
      const existing = await this.readStored(target, key);
      if (existing.status === 'ok') {
        return { outcome: 'already-recorded' };
      }
      if (existing.status === 'version-unknown') {
        return { outcome: 'refused', reason: 'store-version-unknown' };
      }
      if (existing.status === 'failed') {
        return { outcome: 'refused', reason: 'store-failed' };
      }
      const replacing = existing.status === 'unreadable';
      if (!replacing && (await this.storeIsFull(directory))) {
        return { outcome: 'refused', reason: 'store-full' };
      }
      return await this.writeOnce(directory, target, key, serializeReceipt(key, receipt), replacing);
    } catch (error: unknown) {
      const reason: RecordGateReceiptRefusalReason =
        error instanceof StoreFailure ? error.reason : 'store-failed';
      return { outcome: 'refused', reason };
    }
  }

  /**
   * The store directory, checked not to be (or sit under) a symlink. `create` makes it when absent;
   * without it an absent store is `null`. Anything that is not a plain directory is a failure.
   */
  private async openStoreDirectory(stateDir: string, create: boolean): Promise<string | null> {
    const stateStat = await this.lstatOrNull(stateDir);
    if (stateStat === null) {
      if (!create) {
        return null;
      }
      await fs.mkdir(stateDir, { recursive: true });
    } else if (!stateStat.isDirectory()) {
      throw new StoreFailure('store-unreadable');
    }
    const directory = path.join(stateDir, GATE_RECEIPT_STORE_DIRECTORY);
    const stat = await this.lstatOrNull(directory);
    if (stat === null) {
      if (!create) {
        return null;
      }
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (error: unknown) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
      }
      const created = await this.lstatOrNull(directory);
      if (created === null || !created.isDirectory()) {
        throw new StoreFailure('store-unreadable');
      }
      return directory;
    }
    if (!stat.isDirectory()) {
      throw new StoreFailure('store-unreadable');
    }
    return directory;
  }

  private async lstatOrNull(target: string): Promise<import('node:fs').Stats | null> {
    try {
      return await fs.lstat(target);
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /** One bounded, symlink-refusing read of the file for `key`. */
  private async readStored(target: string, key: GateReceiptKey): Promise<StoredRead> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        return { status: 'absent' };
      }
      // ELOOP: a symlink is never followed.
      return code === 'ELOOP' ? { status: 'unreadable' } : { status: 'failed' };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > GATE_RECEIPT_MAX_FILE_BYTES) {
        return { status: 'unreadable' };
      }
      const buffer = Buffer.alloc(GATE_RECEIPT_MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > GATE_RECEIPT_MAX_FILE_BYTES) {
        return { status: 'unreadable' };
      }
      return parseStoredReceipt(buffer.subarray(0, bytesRead).toString('utf8'), key);
    } catch {
      return { status: 'failed' };
    } finally {
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Count the stored receipts and sweep stale temp files left by a crashed writer. The directory is walked
   * entry by entry and the walk stops past a fixed bound, so a directory flooded with other names is
   * reported full instead of being read whole.
   */
  private async storeIsFull(directory: string): Promise<boolean> {
    const walkLimit = this.maxRecords + MAX_TEMP_SWEEP + MAX_FOREIGN_ENTRIES;
    const dirHandle = await fs.opendir(directory);
    let records = 0;
    let walked = 0;
    let swept = 0;
    try {
      for await (const entry of dirHandle) {
        walked += 1;
        if (walked > walkLimit) {
          return true;
        }
        const name = entry.name;
        if (RECORD_FILE_PATTERN.test(name)) {
          records += 1;
        } else if (name.endsWith('.tmp') && swept < MAX_TEMP_SWEEP) {
          swept += 1;
          try {
            const stat = await fs.lstat(path.join(directory, name));
            if (stat.isFile() && Date.now() - stat.mtimeMs > STALE_TEMP_AGE_MS) {
              await fs.rm(path.join(directory, name), { force: true });
            }
          } catch {
            // best effort
          }
        }
      }
    } finally {
      try {
        await dirHandle.close();
      } catch {
        // already closed by the iterator
      }
    }
    return records >= this.maxRecords;
  }

  /**
   * Write `content` as a whole file first, then publish it under `target` in one step: `link` when the name
   * is free (it fails if anyone published first), a file already found unreadable is removed first.
   */
  private async writeOnce(
    directory: string,
    target: string,
    key: GateReceiptKey,
    content: string,
    replacing: boolean,
  ): Promise<RecordGateReceiptResult> {
    this.tempCounter += 1;
    const temp = path.join(
      directory,
      `${path.basename(target, '.json')}.${process.pid}-${this.tempCounter}-${randomBytes(6).toString('hex')}.tmp`,
    );
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(
        temp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      if (replacing) {
        // Replace an unreadable file only by removing it and then publishing exclusively, so two writers
        // repairing one key cannot both win: the second link finds the name taken. The file is read again
        // right before removal, so a receipt another writer has just published is never removed.
        const again = await this.readStored(target, key);
        if (again.status === 'ok') {
          return { outcome: 'already-recorded' };
        }
        if (again.status === 'version-unknown') {
          return { outcome: 'refused', reason: 'store-version-unknown' };
        }
        if (again.status === 'unreadable') {
          const stat = await this.lstatOrNull(target);
          if (stat !== null && !stat.isFile()) {
            // A symlink or directory in the receipt's place is left alone.
            return { outcome: 'refused', reason: 'store-unreadable' };
          }
          await fs.rm(target, { force: true });
        }
      }
      try {
        await fs.link(temp, target);
      } catch (error: unknown) {
        if (errorCode(error) === 'EEXIST') {
          return { outcome: 'already-recorded' };
        }
        throw error;
      }
      return { outcome: 'recorded' };
    } catch {
      return { outcome: 'refused', reason: 'store-failed' };
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
      }
      try {
        await fs.rm(temp, { force: true });
      } catch {
        // ignore
      }
    }
  }
}
