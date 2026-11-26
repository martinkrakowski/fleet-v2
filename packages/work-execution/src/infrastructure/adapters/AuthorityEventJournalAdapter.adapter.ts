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
 * Cost bounds: every `record` is O(n) in the journal's own line count, with
 * `n <= MAX_AUTHORITY_JOURNAL_EVENTS` (an over-full journal refuses as
 * `unavailable` rather than growing without bound); the event's own shape
 * check is O(1) over its seven fixed keys. Hostile-input rule: the event is
 * read only through its own property descriptors — no getter ever runs — a
 * throwing shape reads as `invalid-event`, and no refusal ever echoes a
 * supplied value. Nothing here throws.
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
 * The most events the journal holds before it refuses as `unavailable`.
 * Matches the FC12A export bound's order; a journal this large means the
 * audit trail needs an export-and-rotate policy, not an unbounded file.
 */
export const MAX_AUTHORITY_JOURNAL_EVENTS = 50_000;

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

/** The event id of one stored journal line, or null for an unreadable line. */
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

export class AuthorityEventJournalAdapter implements AuthorityEventSinkPort {
  private readonly filePath: string | null;
  private readonly lockPath: string | null;
  private readonly memory: string[] = [];

  constructor(options?: AuthorityEventJournalAdapterOptions) {
    this.filePath =
      options?.stateDir === undefined
        ? null
        : path.join(options.stateDir, options?.fileName ?? AUTHORITY_EVENTS_FILE);
    this.lockPath =
      this.filePath === null ? null : `${this.filePath}.lock`;
  }

  async record(event: StopAuthorityEvent): Promise<AuthorityEventSinkResult> {
    if (!isWellFormedStopEvent(event)) {
      return { outcome: 'refused', reason: 'invalid-event' };
    }
    if (this.filePath === null || this.lockPath === null) {
      // In-memory mode: a linear scan over a bounded list is the same
      // idempotency contract as the file's, for a disposable process.
      if (this.memory.length >= MAX_AUTHORITY_JOURNAL_EVENTS) {
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
        if (lines.length >= MAX_AUTHORITY_JOURNAL_EVENTS) {
          return { outcome: 'refused' as const, reason: 'unavailable' as const };
        }
        if (lines.some((line) => eventIdOfLine(line) === event.eventId)) {
          return { outcome: 'recorded' as const };
        }
        await fs.appendFile(this.filePath as string, `${serializeEvent(event)}\n`, 'utf8');
        return { outcome: 'recorded' as const };
      });
    } catch {
      // A failed lock, read or append is an unavailable transport, never a
      // throw and never a partial record.
      return { outcome: 'refused', reason: 'unavailable' };
    }
  }
}
