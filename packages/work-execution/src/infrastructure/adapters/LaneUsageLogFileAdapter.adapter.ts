// Infrastructure adapter for lane OG14.
/**
 * LaneUsageLogFileAdapter implements LaneUsageLogPort over
 * `<stateDir>/telemetry/lane-usage.jsonl`: versioned JSONL whose first line
 * is `{"schemaVersion":1}` and whose every later line is one
 * `LaneUsageLogRow`. Every append takes `<file>.lock`, reads the file under
 * it, refuses an `attemptId` it already holds and rewrites the whole file
 * with an atomic rename, so a crash leaves either the old file or the new
 * one. The store's row and byte budgets are enforced on every append. A read
 * reports a line it cannot parse by its line number and never turns it into
 * a row. Without a `stateDir` the rows are held in memory only. No result
 * carries a path, a file content or an error message, and the adapter never
 * logs or throws.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  LANE_USAGE_LOG_MAX_FILE_BYTES,
  LANE_USAGE_LOG_MAX_ROWS,
  parseLaneUsageLogRow,
  serializeLaneUsageLogHeader,
  serializeLaneUsageLogRow,
  type LaneUsageLogRow,
} from '../../domain/lane-usage-log.js';
import type {
  LaneUsageLogAppendResult,
  LaneUsageLogPort,
  LaneUsageLogReadResult,
} from '../../application/ports/out/LaneUsageLogPort.out-port.js';
import { FileLockTimeoutError, withFileLock, writeBytesAtomically } from './file-store.js';

export interface LaneUsageLogFileAdapterOptions {
  /** When set, the rows persist under `<stateDir>/telemetry/`; without it they are held in memory. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** The lock give-up of every append. */
  readonly lockTimeoutMs?: number;
  /** Budget overrides; the domain constants are the defaults. */
  readonly maxRows?: number;
  readonly maxFileBytes?: number;
}

const DEFAULT_FILE_NAME = 'lane-usage.jsonl';
const DIRECTORY_NAME = 'telemetry';
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const HEADER_LINE = '{"schemaVersion":1}';

type ParsedFile =
  | { readonly kind: 'invalid-header' }
  | { readonly kind: 'parsed'; readonly rows: readonly LaneUsageLogRow[]; readonly dataLineCount: number; readonly endsWithLineFeed: boolean };

type FileBytes =
  | { readonly kind: 'absent' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'bytes'; readonly bytes: Buffer };

/** The first unreadable data line names itself; `null` when every line parses. */
function parseFile(bytes: Buffer): ParsedFile | { readonly kind: 'malformed-row'; readonly lineNumber: number } {
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  if (lines[0] !== HEADER_LINE) {
    return { kind: 'invalid-header' };
  }
  const endsWithLineFeed = lines[lines.length - 1] === '';
  const dataLines = endsWithLineFeed ? lines.slice(1, -1) : lines.slice(1);
  const rows: LaneUsageLogRow[] = [];
  for (let index = 0; index < dataLines.length; index += 1) {
    let row: LaneUsageLogRow | null = null;
    try {
      row = parseLaneUsageLogRow(JSON.parse(dataLines[index]));
    } catch {
      row = null;
    }
    if (row === null) {
      return { kind: 'malformed-row', lineNumber: index + 2 };
    }
    rows.push(row);
  }
  return { kind: 'parsed', rows, dataLineCount: dataLines.length, endsWithLineFeed };
}

export class LaneUsageLogFileAdapter implements LaneUsageLogPort {
  private readonly target: string | null;
  private readonly lockTimeoutMs: number;
  private readonly maxRows: number;
  private readonly maxFileBytes: number;
  private readonly memoryRows: LaneUsageLogRow[] = [];
  private memoryBytes = 0;

  constructor(options: LaneUsageLogFileAdapterOptions = {}) {
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
      throw new Error('LaneUsageLogFileAdapter refuses unsafe state file name');
    }
    const { stateDir } = options;
    this.target =
      stateDir === undefined || stateDir.trim().length === 0 ? null : join(stateDir, DIRECTORY_NAME, fileName);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 500;
    this.maxRows = options.maxRows ?? LANE_USAGE_LOG_MAX_ROWS;
    this.maxFileBytes = options.maxFileBytes ?? LANE_USAGE_LOG_MAX_FILE_BYTES;
  }

  async read(): Promise<LaneUsageLogReadResult> {
    if (this.target === null) {
      return { outcome: 'read', rows: [...this.memoryRows] };
    }
    try {
      const file = await this.readBounded(this.target);
      if (file.kind === 'absent') {
        return { outcome: 'read', rows: [] };
      }
      if (file.kind === 'too-large') {
        return { outcome: 'unreadable', reason: 'store-unreadable' };
      }
      const parsed = parseFile(file.bytes);
      if (parsed.kind === 'invalid-header') {
        return { outcome: 'unreadable', reason: 'invalid-header' };
      }
      if (parsed.kind === 'malformed-row') {
        return { outcome: 'unreadable', reason: 'malformed-row', lineNumber: parsed.lineNumber };
      }
      return { outcome: 'read', rows: parsed.rows };
    } catch {
      return { outcome: 'unreadable', reason: 'store-unreadable' };
    }
  }

  async append(row: LaneUsageLogRow): Promise<LaneUsageLogAppendResult> {
    const checked = parseLaneUsageLogRow(row);
    if (checked === null) {
      return { outcome: 'refused', reason: 'invalid-row' };
    }
    if (this.target === null) {
      return this.appendInMemory(checked);
    }
    const target = this.target;
    try {
      return await withFileLock(
        `${target}.lock`,
        async (): Promise<LaneUsageLogAppendResult> => {
          const file = await this.readBounded(target);
          if (file.kind === 'too-large') {
            return { outcome: 'refused', reason: 'log-budget-exhausted' };
          }
          const line = Buffer.from(`${serializeLaneUsageLogRow(checked)}\n`, 'utf8');
          if (file.kind === 'absent') {
            // The first append is budgeted too: the header plus the one row
            // must fit within the byte budget, and at least one row slot
            // must remain.
            const initial = Buffer.concat([Buffer.from(`${serializeLaneUsageLogHeader()}\n`, 'utf8'), line]);
            if (this.maxRows < 1 || initial.length > this.maxFileBytes) {
              return { outcome: 'refused', reason: 'log-budget-exhausted' };
            }
            await writeBytesAtomically(target, initial);
            return { outcome: 'appended' };
          }
          const parsed = parseFile(file.bytes);
          if (parsed.kind === 'invalid-header' || parsed.kind === 'malformed-row') {
            // The damaged line may already hold this attempt id, so nothing
            // is ever appended over a store the adapter cannot fully parse.
            return { outcome: 'refused', reason: 'store-unreadable' };
          }
          if (parsed.rows.some((stored) => stored.attemptId === checked.attemptId)) {
            return { outcome: 'duplicate' };
          }
          const separator = parsed.endsWithLineFeed ? Buffer.alloc(0) : Buffer.from('\n', 'utf8');
          const next = Buffer.concat([file.bytes, separator, line]);
          if (parsed.dataLineCount >= this.maxRows || next.length > this.maxFileBytes) {
            return { outcome: 'refused', reason: 'log-budget-exhausted' };
          }
          await writeBytesAtomically(target, next);
          return { outcome: 'appended' };
        },
        { timeoutMs: this.lockTimeoutMs },
      );
    } catch (error: unknown) {
      if (error instanceof FileLockTimeoutError) {
        return { outcome: 'refused', reason: 'lock-timeout' };
      }
      return { outcome: 'refused', reason: 'store-unreadable' };
    }
  }

  private appendInMemory(row: LaneUsageLogRow): LaneUsageLogAppendResult {
    if (this.memoryRows.some((stored) => stored.attemptId === row.attemptId)) {
      return { outcome: 'duplicate' };
    }
    if (this.memoryRows.length >= this.maxRows) {
      return { outcome: 'refused', reason: 'log-budget-exhausted' };
    }
    // The in-memory store honours the same byte budget as the file: the
    // serialized rows together may never exceed it.
    const serialized = serializeLaneUsageLogRow(row);
    const rowBytes = serialized === null ? Number.POSITIVE_INFINITY : Buffer.byteLength(`${serialized}\n`, 'utf8');
    if (serialized === null || this.memoryBytes + rowBytes > this.maxFileBytes) {
      return { outcome: 'refused', reason: 'log-budget-exhausted' };
    }
    this.memoryRows.push(row);
    this.memoryBytes += rowBytes;
    return { outcome: 'appended' };
  }

  /**
   * The file's bytes within the size bound. The open refuses a symlink
   * (O_NOFOLLOW) and a non-regular file is refused after fstat on the same
   * handle, and the read itself takes at most the cap plus one byte, so a
   * file that grows after the open cannot make it unbounded. A refusal or a
   * filesystem error other than absence throws; callers report it as
   * store-unreadable.
   */
  private async readBounded(target: string): Promise<FileBytes> {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') {
        return { kind: 'absent' };
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error('lane usage log is not a regular file');
      }
      if (stat.size > this.maxFileBytes) {
        return { kind: 'too-large' };
      }
      const limit = this.maxFileBytes + 1;
      const buffer = Buffer.alloc(limit);
      let filled = 0;
      while (filled < limit) {
        const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
        if (bytesRead === 0) {
          break;
        }
        filled += bytesRead;
      }
      if (filled > this.maxFileBytes) {
        return { kind: 'too-large' };
      }
      return { kind: 'bytes', bytes: buffer.subarray(0, filled) };
    } finally {
      await handle.close();
    }
  }
}
