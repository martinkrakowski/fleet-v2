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
 * rotates it, crash-safely and self-healing, under the same lock, using
 * only no-clobber `fs.link`, `fs.unlink` and exclusive (`wx`) create (never
 * `fs.rename`, which could clobber an archive created concurrently):
 *
 *  1. the new event is staged in full in `<live>.next` (exclusive create);
 *  2. the live file is hard-linked to `<stem>.<next>.jsonl` (an `EEXIST`
 *     name is skipped within a bounded `MAX_ROTATION_ATTEMPTS`, driven by
 *     an attempt counter so an archive number at the top of the
 *     safe-integer range cannot spin forever); an archive that is already
 *     a hard link to the live file (an earlier rotation that stopped
 *     before step 3) is reused, never duplicated;
 *  3. the live path is unlinked;
 *  4. the staged file is hard-linked to the live path and then unlinked.
 *
 * The live path is therefore never partially written: it is either the
 * complete prior journal or, between steps 3 and 4, absent while the staged
 * file holds the complete new journal. There is no best-effort restore to
 * fail. Every later `record` first heals what a crash or a failed step left
 * behind: a staged file with no live file is promoted to the live path; a
 * staged file next to a live file (a rotation that stopped before step 3,
 * or after step 4) is removed, and an archive that shares the live file's
 * inode is reused by the retry. A failed rotation refuses as `unavailable`
 * and loses no event. An `eventId` that has rotated
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

  /** The staging path of a rotation's fresh live file. */
  private stagePath(): string {
    return `${this.filePath as string}.next`;
  }

  /**
   * Heal what an interrupted rotation left behind, before anything is read.
   * A staged file with no live file is the complete new journal of a
   * rotation that stopped between unlink and promotion: it is promoted. A
   * staged file beside a live file is a rotation that stopped earlier (the
   * live file is still the whole prior journal) or later (the staged file
   * is already the live file's other name): it is removed. Answers false
   * when the state cannot be healed, so the caller refuses.
   */
  private async heal(): Promise<boolean> {
    const live = this.filePath as string;
    const staged = this.stagePath();
    try {
      await fs.lstat(staged);
    } catch (error) {
      return (error as { code?: unknown } | null)?.code === 'ENOENT';
    }
    try {
      let liveExists = true;
      try {
        await fs.lstat(live);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'ENOENT') {
          return false;
        }
        liveExists = false;
      }
      if (liveExists) {
        await fs.unlink(staged);
        return true;
      }
      // Promote only a complete staged journal (one well-formed final line).
      // An incomplete one cannot come from an interrupted rotation, which
      // stages in full before it retires the live file; it is discarded, so
      // the journal can never stay wedged on it.
      const content = await fs.readFile(staged, 'utf8');
      if (!content.endsWith('\n') || eventIdOfLine(content.trimEnd().split('\n').pop()) === null) {
        await fs.unlink(staged);
        return true;
      }
      await fs.link(staged, live);
      await fs.unlink(staged);
      return true;
    } catch {
      return false;
    }
  }

  /** True when both paths are the same file (a hard link of each other). */
  private async sameFile(a: string, b: string): Promise<boolean> {
    try {
      const [first, second] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
      return first.dev === second.dev && first.ino === second.ino;
    } catch {
      return false;
    }
  }

  /**
   * Rotate the full live journal to `<stem>.<n>.jsonl` inside `stateDir`
   * and leave a fresh live file holding `line`: see the header for the four
   * steps. The next number comes from the existing archive names (strictly
   * `^<stem>.(\d+).jsonl$`, canonical safe integers). Any failure refuses
   * as `unavailable`; the live file is only ever unlinked once the staged
   * replacement is complete and the archive is a link of the live file.
   */
  private async rotate(line: string): Promise<boolean> {
    // `this.filePath` is non-null whenever rotation is reachable; the cast
    // is local and only avoids re-narrowing across closures.
    const filePath = this.filePath as string;
    const staged = this.stagePath();
    const directory = path.dirname(filePath);
    const stem = path.basename(filePath).replace(/\.jsonl$/, '');
    const archivePattern = new RegExp(
      `^${escapeRegExp(stem)}\\.(\\d+)\\.jsonl$`,
    );
    try {
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
      // 1. Stage the complete fresh live file. A failure removes whatever
      // was staged (a leftover is also removed by the next `heal`).
      try {
        await fs.writeFile(staged, line, { encoding: 'utf8', flag: 'wx' });
      } catch {
        await fs.unlink(staged).catch(() => undefined);
        return false;
      }
      // 2. Archive: reuse a link of the live file left by an earlier
      // attempt, otherwise link the next unused number. The loop is driven
      // by an explicit attempt counter, not by the candidate number: at the
      // top of the safe-integer range (an archive named
      // `<stem>.9007199254740991.jsonl`) `n += 1` no longer changes `n`, so
      // incrementing `n` in the loop header could spin forever. A candidate
      // at or past `Number.MAX_SAFE_INTEGER` is refused instead of retried.
      let archived = false;
      if (maxExisting > 0) {
        archived = await this.sameFile(filePath, path.join(directory, `${stem}.${maxExisting}.jsonl`));
      }
      let n = maxExisting;
      for (let attempt = 0; !archived && attempt < MAX_ROTATION_ATTEMPTS; attempt += 1) {
        if (n >= Number.MAX_SAFE_INTEGER) {
          break;
        }
        n += 1;
        try {
          await fs.link(filePath, path.join(directory, `${stem}.${n}.jsonl`));
          archived = true;
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code !== 'EEXIST') {
            break;
          }
        }
      }
      if (!archived) {
        await fs.unlink(staged).catch(() => undefined);
        return false;
      }
      // 3. Retire the live path, 4. promote the staged file. A failure here
      // leaves the staged file for the next `heal`/`rotate`; nothing is lost.
      await fs.unlink(filePath);
      await fs.link(staged, filePath);
      await fs.unlink(staged).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
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
        if (!(await this.heal())) {
          return { outcome: 'refused' as const, reason: 'unavailable' as const };
        }
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
        const line = `${serializeEvent(event)}\n`;
        if (lines.length >= this.maxEvents) {
          return (await this.rotate(line))
            ? { outcome: 'recorded' as const }
            : { outcome: 'refused' as const, reason: 'unavailable' as const };
        }
        await fs.appendFile(this.filePath as string, line, 'utf8');
        return { outcome: 'recorded' as const };
      });
    } catch {
      // A failed lock, read, rotation or append is an unavailable transport,
      // never a throw and never a partial record.
      return { outcome: 'refused', reason: 'unavailable' };
    }
  }
}
