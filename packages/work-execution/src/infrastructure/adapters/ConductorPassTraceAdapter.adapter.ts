// @generated adapter scaffold — refined for lane VZ5a.
/**
 * ConductorPassTraceAdapter implements ConductorPassTracePort over a local JSON
 * ring: `<stateDir>/conductor-passes.json`, newest
 * `CONDUCTOR_PASS_TRACE_RING_LENGTH` traces, oldest first in the file.
 * `append` is one file replace under an exclusive lock with an atomic rename
 * (the same precedent as `LaneRunRepositoryAdapter`). A refused trace, an
 * unreadable file or an unknown version writes nothing, so the file's bytes
 * stay identical; no quarantine copy is made from this adapter — `state check`
 * reports the file and the operator decides. The adapter never throws: every
 * failure is a value. Without a `stateDir` the ring lives in memory only, and
 * `readOnly` is honoured only by the append side.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  CONDUCTOR_PASS_TRACE_RING_LENGTH,
  conductorPassTraceOf,
  readConductorPassTrace,
  type ConductorPassTraceInput,
  type ConductorPassTraceLimits,
  type ConductorPassTraceRecord,
} from '../../domain/conductor-pass-trace.js';
import type {
  ConductorPassTraceAppendResult,
  ConductorPassTraceListResult,
  ConductorPassTracePort,
} from '../../application/ports/out/ConductorPassTracePort.out-port.js';
import { withFileLock, writeJsonAtomically } from './file-store.js';

export interface ConductorPassTraceAdapterOptions {
  readonly stateDir?: string;
  readonly fileName?: string;          // default 'conductor-passes.json'
  readonly limits?: ConductorPassTraceLimits; // required for append; the read side omits it
  readonly readOnly?: boolean;         // append answers not-recorded 'read-only' and touches nothing
  readonly lockTimeoutMs?: number;     // default 2000
}

const DEFAULT_FILE_NAME = 'conductor-passes.json';
/** The other work-execution stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  'work-orders.json',
  'attempts.json',
  'journal.json',
  'reservations.json',
  'lane-runs.json',
  'conductor-driver-lease.json',
  'conductor-halt.json',
  'run-journal.json',
  'telemetry-dispositions.json',
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** One locked append's outcome: the ring written, or the reason it was not. */
type LockedAppend =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'not-recorded'; readonly reason: 'store-unreadable' | 'unknown-schema-version' };

/** The ring file's parse outcome: readable traces, or why the ring must not be touched. */
type RingRead =
  | { readonly ok: true; readonly traces: ConductorPassTraceRecord[] }
  | { readonly ok: false; readonly reason: 'store-unreadable' | 'unknown-schema-version' };

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/** Fresh copies: nested objects are copied so callers cannot mutate the ring. */
function copyTrace(trace: ConductorPassTraceRecord): ConductorPassTraceRecord {
  return JSON.parse(JSON.stringify(trace)) as ConductorPassTraceRecord;
}

export class ConductorPassTraceAdapter implements ConductorPassTracePort {
  private readonly inMemoryRing: ConductorPassTraceRecord[] = [];

  constructor(private readonly options: ConductorPassTraceAdapterOptions = {}) {}

  async list(): Promise<ConductorPassTraceListResult> {
    const target = this.statePath;
    if (target === null) {
      return { outcome: 'listed', traces: this.inMemoryRing.map(copyTrace) };
    }
    try {
      const ring = await this.readRing(target);
      return ring.ok
        ? { outcome: 'listed', traces: ring.traces }
        : { outcome: 'unreadable', reason: ring.reason };
    } catch {
      return { outcome: 'unreadable', reason: 'store-unreadable' };
    }
  }

  async append(input: ConductorPassTraceInput): Promise<ConductorPassTraceAppendResult> {
    try {
      if (this.options.readOnly === true) {
        return { outcome: 'not-recorded', reason: 'read-only' };
      }
      if (this.options.limits === undefined) {
        return { outcome: 'not-recorded', reason: 'limits-unset' };
      }
      const built = conductorPassTraceOf(input, this.options.limits);
      if (!built.ok) {
        return {
          outcome: 'not-recorded',
          reason: built.reason === 'unknown-schema-version' ? 'unknown-schema-version' : 'invalid-trace',
        };
      }
      const target = this.statePath;
      if (target === null) {
        this.inMemoryRing.push(built.record);
        if (this.inMemoryRing.length > CONDUCTOR_PASS_TRACE_RING_LENGTH) {
          this.inMemoryRing.splice(0, this.inMemoryRing.length - CONDUCTOR_PASS_TRACE_RING_LENGTH);
        }
        return { outcome: 'recorded', passId: built.record.passId };
      }
      const locked = await withFileLock<LockedAppend>(
        `${target}.lock`,
        async () => {
          const ring = await this.readRing(target);
          if (!ring.ok) {
            return { outcome: 'not-recorded', reason: ring.reason };
          }
          const next = [...ring.traces, built.record].slice(-CONDUCTOR_PASS_TRACE_RING_LENGTH);
          await writeJsonAtomically(target, next);
          return { outcome: 'recorded' };
        },
        { timeoutMs: this.options.lockTimeoutMs ?? 2000 },
      );
      return locked.outcome === 'recorded'
        ? { outcome: 'recorded', passId: built.record.passId }
        : { outcome: 'not-recorded', reason: locked.reason };
    } catch {
      return { outcome: 'not-recorded', reason: 'write-failed' };
    }
  }

  /** Read the ring file; ENOENT is an empty ring, anything else unreadable or unknown-version. */
  private async readRing(target: string): Promise<RingRead> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(target);
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return { ok: true, traces: [] };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      return { ok: false, reason: 'store-unreadable' };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: 'store-unreadable' };
    }
    const traces: ConductorPassTraceRecord[] = [];
    for (const item of parsed) {
      const read = readConductorPassTrace(item);
      if (!read.ok) {
        return read.reason === 'unknown-schema-version'
          ? { ok: false, reason: 'unknown-schema-version' }
          : { ok: false, reason: 'store-unreadable' };
      }
      traces.push(read.record);
    }
    return { ok: true, traces };
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error('ConductorPassTraceAdapter refuses a fileName that collides with another store');
    }
    if (!SAFE_FILE_NAME.test(name) || name === '.' || name === '..') {
      throw new Error('ConductorPassTraceAdapter refuses unsafe state file name');
    }
    return join(stateDir, name);
  }
}
