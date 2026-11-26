// @generated adapter scaffold — refined for FC12B fix round 2.
/**
 * AuthorityEventJournalAdapter implements AuthorityEventSinkPort as a local
 * JSONL journal: one stop authority event per line in
 * `<stateDir>/authority-events.jsonl`, appended under the same exclusive
 * file lock the other work-execution stores use. Recording is idempotent on
 * `eventId` — the journal is scanned for the event id before every append,
 * so a repeat of a recorded event writes nothing and answers `recorded`
 * again. With no `stateDir` the journal is in-memory for the process
 * lifetime (an API or CLI run without a durable state directory is
 * disposable, and its audit trail is too).
 *
 * When the durable live journal reaches the configured event cap
 * (`maxEvents`, default `MAX_AUTHORITY_JOURNAL_EVENTS`) the next record
 * rotates it: the live file is hard-linked to
 * `<stem>.<next>.jsonl` inside the state directory and the live path is
 * unlinked, then the new event appends to a fresh live file. Rotation
 * never rewrites prior lines and never uses `fs.rename` (a rename could
 * clobber an archive created concurrently); it retries `EEXIST` within a
 * bounded `MAX_ROTATION_ATTEMPTS` budget. An `eventId` that has rotated
 * into an archive is **not** re-read from archives for idempotency, so a
 * same-key retry after rotation may append once more to the fresh live
 * file; the `eventId` is identical, so downstream consumers de-duplicate.
 * No event is ever dropped or rewritten.
 *
 * Cost bounds: every `record` is O(n) in the live journal's own line
 * count, with `n <= maxEvents` (a full journal rotates instead of growing
 * without bound); archive selection is O(m) in the `stateDir` entry count
 * with a bounded `MAX_ROTATION_ATTEMPTS` retry loop; the event's own shape
 * check is O(1) over its seven fixed keys. Hostile-input rule: the event
 * is read only through its own property descriptors — no getter ever
 * runs — a throwing shape reads as `invalid-event`, and no refusal ever
 * echoes a supplied value. Nothing here throws.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { withFileLock } from './file-store.js';
import type {
  AuthorityEventSinkPort,
  AuthorityEventSinkResult,
} from '../../application/ports/out/AuthorityEventSinkPort.out-port.js';
import {
  authorityEventForStop,
  type StopAuthorityEvent,
} from '../../domain/authority-event-mapping.js';

/** The journal file name inside the state directory. */
export const AUTHORITY_EVENTS_FILE = 'authority-events.jsonl';

/**
 * The default event cap of the live journal: the number of events it holds
 * before the next record rotates it into an archive (FC12E). Also the
 * fallback for any invalid `maxEvents` option.
 */
export const MAX_AUTHORITY_JOURNAL_EVENTS = 50_000;

/** The bounded `fs.link` retry budget when an archive name is taken. */
const MAX_ROTATION_ATTEMPTS = 32;

/** The exactly-seven own keys a stop event carries. */
const EVENT_KEYS: readonly string[] = [
  'eventId',
  'kind',
  'actor',
  'organizationId',
  'atIso',
  'beforeRevision',
  'afterRevision',
];

export interface AuthorityEventJournalAdapterOptions {
  /** Directory for the JSONL journal; in-memory only when omitted. */
  readonly stateDir?: string;
  /** File name inside the state directory; defaults to `authority-events.jsonl`. */
  readonly fileName?: string;
  /**
   * The live journal's event cap before rotation; defaults to
   * `MAX_AUTHORITY_JOURNAL_EVENTS`. A non-positive-safe-integer value
   * (`0`, `-1`, `NaN`, `1.5`, `Infinity` or a non-number) falls back to
   * that default rather than throwing.
   */
  readonly maxEvents?: number;
}

/**
 * The supplier-side field rules (actor pattern, no ASCII control characters,
 * non-empty organization id, zoned ISO time) are the pure mapper's: the four
 * mapped values are read through own descriptors (never a getter) and run
 * through `authorityEventForStop`, so the sink refuses exactly what the mapper
 * refuses. O(1); never throws.
 */
function hasValidatedFields(event: object): boolean {
  try {
    const read = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(event, key);
      return descriptor !== undefined && descriptor.get === undefined && descriptor.set === undefined
        ? descriptor.value
        : undefined;
    };
    return authorityEventForStop({
      eventId: read('eventId'),
      actor: read('actor'),
      organizationId: read('organizationId'),
      atIso: read('atIso'),
    }).ok;
  } catch {
    return false;
  }
}

/**
 * A bounded structural check of one event, read through its own property
 * descriptors so no getter ever runs. The journal only accepts the
 * stop-only shape this port documents: the seven keys, `kind: 'stop'`,
 * bounded non-empty strings for `eventId`/`actor`/`atIso`, a string or
 * `null` for `organizationId` and both revisions, and `null` for both
 * revisions (a stop event never carries them). O(1); never throws.
 */
function isWellFormedStopEvent(event: unknown): event is StopAuthorityEvent {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return false;
  }
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(event);
  } catch {
    return false;
  }
  if (ownKeys.length !== EVENT_KEYS.length || !ownKeys.every((key) => typeof key === 'string' && EVENT_KEYS.includes(key))) {
    return false;
  }
  const text = (key: string, maxLength: number): boolean => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(event, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return false;
      }
      const value = descriptor.value;
      return (
        typeof value === 'string' && value.length > 0 && value.length <= maxLength
      );
    } catch {
      return false;
    }
  };
  const nullableText = (key: string): boolean => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(event, key);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return false;
      }
      const value = descriptor.value;
      return value === null || (typeof value === 'string' && value.length <= 128);
    } catch {
      return false;
    }
  };
  if (!hasValidatedFields(event)) {
    return false;
  }
  return (
    text('eventId', 128) &&
    text('actor', 128) &&
    text('atIso', 64) &&
    (() => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(event, 'kind');
        return descriptor !== undefined && descriptor.value === 'stop';
      } catch {
        return false;
      }
    })() &&
    nullableText('organizationId') &&
    Object.getOwnPropertyDescriptor(event, 'beforeRevision')?.value === null &&
    Object.getOwnPropertyDescriptor(event, 'afterRevision')?.value === null
  );
}

/** One serialized journal line: fixed key order, one event, always one line. */
function serializeEvent(event: StopAuthorityEvent): string {
  return JSON.stringify({
    eventId: event.eventId,
    kind: event.kind,
    actor: event.actor,
    organizationId: event.organizationId,
    atIso: event.atIso,
    beforeRevision: event.beforeRevision,
    afterRevision: event.afterRevision,
  });
}

/**
 * The event id of one stored journal line, or null for an unreadable line.
 */
function eventIdOfLine(line: unknown): string | null {
  if (typeof line !== 'string' || line.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(parsed, 'eventId');
    return typeof descriptor?.value === 'string' ? descriptor.value : null;
  } catch {
    return null;
  }
}

/** Escape a literal file-name stem for exact use inside a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class AuthorityEventJournalAdapter implements AuthorityEventSinkPort {
  private readonly filePath: string | null;
  private readonly lockPath: string | null;
  private readonly maxEvents: number;
  private readonly memory: string[] = [];

  constructor(options?: AuthorityEventJournalAdapterOptions) {
    this.maxEvents =
      typeof options?.maxEvents === 'number' &&
      Number.isSafeInteger(options.maxEvents) &&
      options.maxEvents > 0
        ? options.maxEvents
        : MAX_AUTHORITY_JOURNAL_EVENTS;
    this.filePath =
      options?.stateDir === undefined
        ? null
        : path.join(options.stateDir, options?.fileName ?? AUTHORITY_EVENTS_FILE);
    this.lockPath =
      this.filePath === null ? null : `${this.filePath}.lock`;
  }

  /**
   * Rotate the full live journal to `<stem>.<n>.jsonl` inside `stateDir`:
   * pick the next unused positive integer from existing archive names
   * (strictly `^<stem>.(\d+).jsonl$`, canonical safe integers), then
   * hard-link the live file to the archive and unlink the live path —
   * `fs.link` + `fs.unlink`, never `fs.rename` or a `wx` reservation,
   * because a rename would clobber an archive another worker created
   * between the scan and the link. `EEXIST` from `fs.link` increments the
   * candidate number and retries within `MAX_ROTATION_ATTEMPTS`; any other
   * failure leaves the live file intact and refuses as `unavailable`.
   */
  private async rotate(): Promise<'ok' | 'refused'> {
    // `this.filePath` is non-null whenever rotation is reachable; the cast
    // is local and only avoids re-narrowing across closures.
    const filePath = this.filePath as string;
    const directory = path.dirname(filePath);
    const stem = path.basename(filePath).replace(/\.jsonl$/, '');
    const archivePattern = new RegExp(
      `^${escapeRegExp(stem)}\\.(\\d+)\\.jsonl$`,
    );
    const entries = await fs.readdir(directory);
    let maxExisting = 0;
    for (const entry of entries) {
      const match = archivePattern.exec(entry);
      if (match === null) {
        continue;
      }
      const n = Number(match[1]);
      if (!Number.isSafeInteger(n) || n <= 0 || !/^(0|[1-9]\d*)$/.test(match[1])) {
        continue;
      }
      maxExisting = Math.max(maxExisting, n);
    }
    for (let n = maxExisting + 1; n <= maxExisting + MAX_ROTATION_ATTEMPTS; n += 1) {
      const archivePath = path.join(directory, `${stem}.${n}.jsonl`);
      try {
        await fs.link(filePath, archivePath);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'EEXIST') {
          continue;
        }
        return 'refused';
      }
      try {
        await fs.unlink(filePath);
      } catch {
        return 'refused';
      }
      return 'ok';
    }
    return 'refused';
  }

  async record(event: StopAuthorityEvent): Promise<AuthorityEventSinkResult> {
    if (!isWellFormedStopEvent(event)) {
      return { outcome: 'refused', reason: 'invalid-event' };
    }
    if (this.filePath === null || this.lockPath === null) {
      // In-memory mode: a linear scan over a bounded list is the same
      // idempotency contract as the file's, for a disposable process.
      if (this.memory.length >= this.maxEvents) {
        return { outcome: 'refused', reason: 'unavailable' };
      }
      const line = serializeEvent(event);
      if (this.memory.some((existing) => eventIdOfLine(existing) === event.eventId)) {
        return { outcome: 'recorded' };
      }
      this.memory.push(line);
      return { outcome: 'recorded' };
    }
    try {
      return await withFileLock(this.lockPath, async () => {
        let content: string;
        try {
          content = await fs.readFile(this.filePath as string, 'utf8');
        } catch (error) {
          // Only a missing journal is an empty one. Any other read failure
          // (permissions, a directory, an I/O error) cannot prove the event
          // is not already recorded, so it refuses rather than appending.
          if ((error as { code?: unknown } | null)?.code !== 'ENOENT') {
            return { outcome: 'refused' as const, reason: 'unavailable' as const };
          }
          content = '';
        }
        const lines = content.length === 0 ? [] : content.split('\n').filter((line) => line.length > 0);
        // Idempotency is checked against the live file first: a repeat of an
        // event still in the live journal answers `recorded` without
        // rotating. An `eventId` that already rotated into an archive is NOT
        // re-read from archives, so a same-key retry after rotation appends
        // once more to the fresh live file; the `eventId` is identical, so
        // downstream consumers de-duplicate. No event is ever dropped or
        // rewritten.
        if (lines.some((line) => eventIdOfLine(line) === event.eventId)) {
          return { outcome: 'recorded' as const };
        }
        if (lines.length >= this.maxEvents) {
          const rotated = await this.rotate();
          if (rotated !== 'ok') {
            return { outcome: 'refused' as const, reason: 'unavailable' as const };
          }
        }
        await fs.appendFile(this.filePath as string, `${serializeEvent(event)}\n`, 'utf8');
        return { outcome: 'recorded' as const };
      });
    } catch {
      // A failed lock, read, rotation or append is an unavailable transport,
      // never a throw and never a partial record.
      return { outcome: 'refused', reason: 'unavailable' };
    }
  }
}
