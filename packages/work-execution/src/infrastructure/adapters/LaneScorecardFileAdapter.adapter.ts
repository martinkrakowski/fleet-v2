// @generated adapter scaffold — refined for lane CO19.
/**
 * LaneScorecardFileAdapter implements LaneScorecardPort over
 * `<stateDir>/scorecard/scorecard.jsonl`: versioned JSONL whose first line is
 * `{"schemaVersion":1}` and whose every later line is one row. Every append
 * takes `<file>.lock`, reads the file under it, refuses a run id it already
 * holds and rewrites the whole file with an atomic rename, so a crash leaves
 * either the old file or the new one. A read reports a line it cannot parse by
 * its line number and never turns it into a row. Without a `stateDir` the rows
 * are held in memory only. No result carries a path, a file content or an error
 * message, and the adapter never logs.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  LANE_SCORECARD_FINAL_STATES,
  LANE_SCORECARD_ID_PATTERN,
  LANE_SCORECARD_MAX_FILE_BYTES,
  LANE_SCORECARD_MAX_ROWS,
  LANE_SCORECARD_VERIFICATION_RESULTS,
  type LaneScorecardAppendResult,
  type LaneScorecardFinalState,
  type LaneScorecardLineProblem,
  type LaneScorecardPort,
  type LaneScorecardReadResult,
  type LaneScorecardRow,
  type LaneScorecardVerificationResult,
} from '../../application/ports/out/LaneScorecardPort.out-port.js';
import { FileLockTimeoutError, readStoreBytes, withFileLock, writeBytesAtomically } from './file-store.js';

export interface LaneScorecardFileAdapterOptions {
  /** When set, the rows persist under `<stateDir>/scorecard/`; without it they are held in memory. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** The lock give-up of every append. */
  readonly lockTimeoutMs?: number;
}

const DEFAULT_FILE_NAME = 'scorecard.jsonl';
const DIRECTORY_NAME = 'scorecard';
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const HEADER_LINE = '{"schemaVersion":1}';
const ROW_KEYS = [
  'runId', 'workOrderId', 'tier', 'finalState', 'fixRounds', 'attemptCount', 'parkCount', 'prNumber',
  'firstPassCompleted', 'reviewFindings', 'verificationResult', 'durationMs',
] as const;
const FINDING_KEYS = ['blocker', 'major', 'minor', 'nit'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A row as the store keeps it: exactly the row keys with the right value types,
 * rebuilt in the canonical key order; `null` for anything else. Never throws.
 */
export function parseLaneScorecardRow(value: unknown): LaneScorecardRow | null {
  try {
    if (!isPlainRecord(value) || !hasExactKeys(value, ROW_KEYS)) {
      return null;
    }
    const findings = value.reviewFindings;
    if (!isPlainRecord(findings) || !hasExactKeys(findings, FINDING_KEYS)) {
      return null;
    }
    const { runId, workOrderId, tier, finalState, prNumber, firstPassCompleted, verificationResult, durationMs } = value;
    if (
      typeof runId !== 'string' || !LANE_SCORECARD_ID_PATTERN.test(runId) ||
      typeof workOrderId !== 'string' || !LANE_SCORECARD_ID_PATTERN.test(workOrderId) ||
      (tier !== 1 && tier !== 2) ||
      typeof finalState !== 'string' || !(LANE_SCORECARD_FINAL_STATES as readonly string[]).includes(finalState) ||
      !isCount(value.fixRounds) || !isCount(value.attemptCount) || !isCount(value.parkCount) ||
      (prNumber !== null && !isCount(prNumber)) ||
      typeof firstPassCompleted !== 'boolean' ||
      !isCount(findings.blocker) || !isCount(findings.major) || !isCount(findings.minor) || !isCount(findings.nit) ||
      typeof verificationResult !== 'string' ||
      !(LANE_SCORECARD_VERIFICATION_RESULTS as readonly string[]).includes(verificationResult) ||
      (durationMs !== null && !isCount(durationMs))
    ) {
      return null;
    }
    return {
      runId,
      workOrderId,
      tier,
      finalState: finalState as LaneScorecardFinalState,
      fixRounds: value.fixRounds,
      attemptCount: value.attemptCount,
      parkCount: value.parkCount,
      prNumber,
      firstPassCompleted,
      reviewFindings: {
        blocker: findings.blocker,
        major: findings.major,
        minor: findings.minor,
        nit: findings.nit,
      },
      verificationResult: verificationResult as LaneScorecardVerificationResult,
      durationMs,
    };
  } catch {
    return null;
  }
}

type ParsedFile =
  | { readonly kind: 'unknown-schema-version' }
  | {
      readonly kind: 'parsed';
      readonly rows: readonly LaneScorecardRow[];
      readonly problems: readonly LaneScorecardLineProblem[];
      readonly dataLineCount: number;
      readonly endsWithLineFeed: boolean;
    };

type FileBytes =
  | { readonly kind: 'absent' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'bytes'; readonly bytes: Buffer };

function parseFile(bytes: Buffer): ParsedFile {
  const lines = bytes.toString('utf8').split('\n');
  if (lines[0] !== HEADER_LINE) {
    return { kind: 'unknown-schema-version' };
  }
  const endsWithLineFeed = lines[lines.length - 1] === '';
  const dataLines = endsWithLineFeed ? lines.slice(1, -1) : lines.slice(1);
  const rows: LaneScorecardRow[] = [];
  const problems: LaneScorecardLineProblem[] = [];
  dataLines.forEach((line, index) => {
    let row: LaneScorecardRow | null = null;
    try {
      row = parseLaneScorecardRow(JSON.parse(line));
    } catch {
      row = null;
    }
    if (row === null) {
      problems.push({ lineNumber: index + 2, reason: 'malformed-line' });
    } else {
      rows.push(row);
    }
  });
  return { kind: 'parsed', rows, problems, dataLineCount: dataLines.length, endsWithLineFeed };
}

function rowLine(row: LaneScorecardRow): string {
  return `${JSON.stringify(row)}\n`;
}

export class LaneScorecardFileAdapter implements LaneScorecardPort {
  private readonly target: string | null;
  private readonly lockTimeoutMs: number;
  private readonly memoryRows: LaneScorecardRow[] = [];

  constructor(options: LaneScorecardFileAdapterOptions = {}) {
    const fileName = options.fileName ?? DEFAULT_FILE_NAME;
    if (!SAFE_FILE_NAME.test(fileName) || fileName === '.' || fileName === '..') {
      throw new Error('LaneScorecardFileAdapter refuses unsafe state file name');
    }
    const { stateDir } = options;
    this.target =
      stateDir === undefined || stateDir.trim().length === 0 ? null : join(stateDir, DIRECTORY_NAME, fileName);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 500;
  }

  async read(): Promise<LaneScorecardReadResult> {
    if (this.target === null) {
      return this.memoryRows.length === 0
        ? { outcome: 'absent' }
        : { outcome: 'read', rows: [...this.memoryRows], problems: [] };
    }
    try {
      const file = await this.readBounded(this.target);
      if (file.kind === 'absent') {
        return { outcome: 'absent' };
      }
      if (file.kind === 'too-large') {
        return { outcome: 'unreadable', reason: 'too-large' };
      }
      const parsed = parseFile(file.bytes);
      if (parsed.kind === 'unknown-schema-version') {
        return { outcome: 'unreadable', reason: 'unknown-schema-version' };
      }
      return { outcome: 'read', rows: parsed.rows, problems: parsed.problems };
    } catch {
      return { outcome: 'unreadable', reason: 'io-error' };
    }
  }

  async append(row: LaneScorecardRow): Promise<LaneScorecardAppendResult> {
    const checked = parseLaneScorecardRow(row);
    if (checked === null) {
      throw new Error('LaneScorecardFileAdapter refuses a row that is not a scorecard row');
    }
    if (this.target === null) {
      return this.appendInMemory(checked);
    }
    const target = this.target;
    try {
      return await withFileLock(
        `${target}.lock`,
        async (): Promise<LaneScorecardAppendResult> => {
          const file = await this.readBounded(target);
          if (file.kind === 'too-large') {
            return { outcome: 'refused', reason: 'too-large' };
          }
          const line = Buffer.from(rowLine(checked), 'utf8');
          if (file.kind === 'absent') {
            await writeBytesAtomically(target, Buffer.concat([Buffer.from(`${HEADER_LINE}\n`, 'utf8'), line]));
            return { outcome: 'appended' };
          }
          const parsed = parseFile(file.bytes);
          if (parsed.kind === 'unknown-schema-version') {
            return { outcome: 'refused', reason: 'unknown-schema-version' };
          }
          if (parsed.rows.some((stored) => stored.runId === checked.runId)) {
            return { outcome: 'refused', reason: 'duplicate-run' };
          }
          const separator = parsed.endsWithLineFeed ? Buffer.alloc(0) : Buffer.from('\n', 'utf8');
          const next = Buffer.concat([file.bytes, separator, line]);
          if (parsed.dataLineCount >= LANE_SCORECARD_MAX_ROWS || next.length > LANE_SCORECARD_MAX_FILE_BYTES) {
            return { outcome: 'refused', reason: 'too-large' };
          }
          await writeBytesAtomically(target, next);
          return { outcome: 'appended' };
        },
        { timeoutMs: this.lockTimeoutMs },
      );
    } catch (error: unknown) {
      if (error instanceof FileLockTimeoutError) {
        return { outcome: 'refused', reason: 'lock-busy' };
      }
      return { outcome: 'refused', reason: 'unreadable-store' };
    }
  }

  private appendInMemory(row: LaneScorecardRow): LaneScorecardAppendResult {
    if (this.memoryRows.some((stored) => stored.runId === row.runId)) {
      return { outcome: 'refused', reason: 'duplicate-run' };
    }
    if (this.memoryRows.length >= LANE_SCORECARD_MAX_ROWS) {
      return { outcome: 'refused', reason: 'too-large' };
    }
    this.memoryRows.push(row);
    return { outcome: 'appended' };
  }

  /** The file's bytes within the size bound; a filesystem error other than absence throws. */
  private async readBounded(target: string): Promise<FileBytes> {
    try {
      const stat = await fs.stat(target);
      if (stat.size > LANE_SCORECARD_MAX_FILE_BYTES) {
        return { kind: 'too-large' };
      }
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT') {
        return { kind: 'absent' };
      }
      throw error;
    }
    const bytes = await readStoreBytes(target);
    if (bytes === null) {
      return { kind: 'absent' };
    }
    if (bytes.length > LANE_SCORECARD_MAX_FILE_BYTES) {
      return { kind: 'too-large' };
    }
    return { kind: 'bytes', bytes };
  }
}
