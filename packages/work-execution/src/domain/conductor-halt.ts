/**
 * The conductor's halt marker (plan §3.7): one record per state directory,
 * `conductor-halt.json`, that says whether the driver is halted and when the
 * marker last changed. The reader is pure: it never throws, never echoes a
 * value and never reads a clock. An unreadable marker reads as a halt (fail
 * closed); halting never fails on a bad file, lifting does.
 */

import { isCalendarDateTime, readExactPlainRecord } from './plain-record-reads.js';

export const CONDUCTOR_HALT_RECORD_VERSION = 1 as const;

/** The kill switch of a state directory (plan §3.7). */
export interface ConductorHaltRecord {
  readonly version: typeof CONDUCTOR_HALT_RECORD_VERSION;
  readonly halted: boolean;
  /** When the marker last changed; a zoned ISO time, normalised with toISOString(). */
  readonly changedAtIso: string;
}

export type ConductorHaltRead =
  | { readonly ok: true; readonly record: ConductorHaltRecord }
  | { readonly ok: false; readonly error: string };

const HALT_KEYS: readonly string[] = ['version', 'halted', 'changedAtIso'];

const HALT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A zoned, calendar-valid ISO-8601 time: the shape of every halt timestamp. */
export function isZonedIsoDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    HALT_ISO_PATTERN.test(value) &&
    isCalendarDateTime(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Never throws, never echoes: exactly the three keys; version 1; halted a boolean; changedAtIso zoned and calendar-valid. */
export function readConductorHaltRecord(input: unknown): ConductorHaltRead {
  try {
    const snapshot = readExactPlainRecord(input, HALT_KEYS);
    if (snapshot === null) {
      return {
        ok: false,
        error: 'ConductorHalt must be a record with exactly version, halted and changedAtIso',
      };
    }
    if (snapshot.version !== CONDUCTOR_HALT_RECORD_VERSION) {
      return { ok: false, error: 'ConductorHalt version must be 1' };
    }
    if (typeof snapshot.halted !== 'boolean') {
      return { ok: false, error: 'ConductorHalt halted must be a boolean' };
    }
    if (!isZonedIsoDateTime(snapshot.changedAtIso)) {
      return { ok: false, error: 'ConductorHalt changedAtIso must be an ISO-8601 time with a zone' };
    }
    return {
      ok: true,
      record: {
        version: CONDUCTOR_HALT_RECORD_VERSION,
        halted: snapshot.halted,
        changedAtIso: snapshot.changedAtIso,
      },
    };
  } catch {
    return { ok: false, error: 'ConductorHalt input could not be read' };
  }
}

/** What the driver and status read. `unreadable` is a halt (fail closed). */
export type ConductorHaltState =
  | { readonly state: 'clear'; readonly record: ConductorHaltRecord | null }
  | { readonly state: 'halted'; readonly record: ConductorHaltRecord }
  | { readonly state: 'unreadable' };

/** True for `halted` and `unreadable`. */
export function isConductorHalted(state: ConductorHaltState): boolean {
  return state.state === 'halted' || state.state === 'unreadable';
}
