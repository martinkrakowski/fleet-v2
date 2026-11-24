/** GB3a: a refused fix dispatch hands the dirty worktree to the next fix seat unchanged. */
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import { parseLaneRunKey } from '../../../domain/lane-run-keys.js';

/** The scan bound: a journal longer than this is refused (read false), never scanned. */
export const MAX_JOURNAL_SCAN_ENTRIES = 100_000;

/** Keys whose presence on a record is a prototype-polluting shape, never read. */
const POLLUTING_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** The fixed refusal details whose worktree is dirty: uncommitted or untracked. */
export const DIRTY_WORKTREE_DETAILS = ['worktree-uncommitted', 'worktree-untracked'] as const;

export function isDirtyWorktreeDetail(detail: string): boolean {
  return (DIRTY_WORKTREE_DETAILS as readonly string[]).includes(detail);
}

/**
 * True when the run's last final dispatch-step result refused for a dirty
 * worktree. Entries are scanned from the end; ambiguous results never count,
 * so an all-ambiguous dispatch leaves no final result and reads false.
 */
export function lastDispatchLeftDirtyWorktree(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'result' || entry.runId !== runId || entry.outcome === 'ambiguous') {
      continue;
    }
    const parsed = entry.key === null ? null : parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step' || parsed.step !== 'dispatch') {
      continue;
    }
    return entry.reasonCode === 'dispatch-refused' && isDirtyWorktreeDetail(entry.detail ?? '');
  }
  return false;
}

/**
 * Read one own property through its descriptor, so a getter is never invoked
 * and a missing or accessor property reads as absent. Never throws on a
 * well-formed object; a hostile object is the caller's refusal, not an error.
 */
function ownValue(source: object, key: string): { readonly present: boolean; readonly value: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    return { present: false, value: undefined };
  }
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    return { present: false, value: undefined };
  }
  return { present: true, value: descriptor.value };
}

/**
 * A plain record whose own properties are all data properties (no getters) and
 * carry no prototype-polluting key. Only own names are inspected; the
 * prototype is pinned to `Object.prototype` or `null` so no inherited getter
 * can be reached through a read either.
 */
function isPlainGetterFreeRecord(value: unknown): value is Record<string, unknown> {
  // A revoked Proxy throws on every operation, `Array.isArray` included, so
  // even this cheapest probe is guarded: hostile input reads false, never throws.
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return false;
  }
  if (typeof value !== 'object' || value === null || isArray) {
    return false;
  }
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    // A hostile Proxy whose `getPrototypeOf` trap throws is refused, never fatal.
    return false;
  }
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  // `Reflect.ownKeys` also returns symbol keys: a symbol-keyed accessor on an
  // entry is a getter just as much as a string-keyed one, so it must be seen.
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  for (const key of keys) {
    if (typeof key === 'string' && POLLUTING_KEYS.includes(key)) {
      return false;
    }
    // Every own name is checked through its descriptor, so an accessor property
    // (or a name the object will not describe) is rejected before any read.
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return false;
    }
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return false;
    }
  }
  return true;
}

/**
 * True when `Array.prototype` or `Object.prototype` (the only prototypes the
 * journal checks accept) carries an accessor property other than the
 * language's own `Object.prototype.__proto__`. A getter placed on either would
 * be an inherited getter reachable from every journal element; the descriptor
 * reads below never invoke it, but the brief requires such a journal to be
 * refused rather than trusted. Cost: one descriptor read per own key of two
 * built-in prototypes, a constant independent of the journal.
 */
function sharedPrototypesCarryAccessor(): boolean {
  for (const proto of [Array.prototype, Object.prototype] as const) {
    let keys: readonly (string | symbol)[];
    try {
      keys = Reflect.ownKeys(proto);
    } catch {
      return true;
    }
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(proto, key);
      } catch {
        return true;
      }
      if (descriptor === undefined) {
        return true;
      }
      const isAccessor = descriptor.get !== undefined || descriptor.set !== undefined;
      if (isAccessor && !(proto === Object.prototype && key === '__proto__')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * CB3: true when the run's latest final stop/dispatch/collect result is a
 * `stop-timeout` stop result — the killed seat left its worktree dirty and no
 * later dispatch or collect has picked the worktree up. The next fix attempt
 * then receives `allowUncommittedHandover: true` instead of being refused
 * `worktree-uncommitted` and reset.
 *
 * Hostile inputs (null, undefined, a non-array, an array-like, a sparse hole,
 * an over-long journal, a getter, a prototype-polluting key, a non-string or
 * empty run id) read `false`; every property is read through its descriptor so
 * a getter is never invoked, and a `Proxy` that lies consistently in every
 * trap is an accepted residual.
 */
export function lastStopLeftTimedOutSeat(
  entries: readonly LaneRunJournalEntryRecord[],
  runId: string,
): boolean {
  // A revoked Proxy throws even on `Array.isArray`; that is hostile input,
  // refused here rather than fatal.
  let isArray: boolean;
  try {
    isArray = Array.isArray(entries);
  } catch {
    return false;
  }
  if (!isArray || typeof runId !== 'string' || runId.length === 0) {
    return false;
  }
  if (sharedPrototypesCarryAccessor()) {
    return false;
  }
  const length = ownValue(entries, 'length');
  if (
    !length.present ||
    typeof length.value !== 'number' ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > MAX_JOURNAL_SCAN_ENTRIES
  ) {
    return false;
  }
  let entryKeys: readonly (string | symbol)[];
  try {
    // The journal array itself is untrusted: its prototype is pinned to
    // `Array.prototype` or `null` so no inherited getter can be reached, and a
    // trap that throws is hostile input, refused here rather than fatal later.
    const proto = Object.getPrototypeOf(entries);
    if (proto !== Array.prototype && proto !== null) {
      return false;
    }
    // `Reflect.ownKeys` also returns symbol keys: a symbol-keyed accessor on
    // the journal array is a getter just as much as a string-keyed one.
    entryKeys = Reflect.ownKeys(entries);
  } catch {
    // A Proxy whose getPrototypeOf or ownKeys trap throws is refused, never fatal.
    return false;
  }
  for (const key of entryKeys) {
    if (typeof key === 'string' && key !== 'length' && POLLUTING_KEYS.includes(key)) {
      return false;
    }
    // Every own key of the array is checked through its descriptor, so an
    // accessor property (a symbol-keyed getter included) is rejected before
    // any read — the array itself is getter-free, not just its elements.
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(entries, key);
    } catch {
      return false;
    }
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return false;
    }
  }
  // Pre-validation pass: a sparse hole, a getter, or a non-plain element
  // anywhere in the journal is hostile input, wherever the reverse scan would
  // otherwise have stopped, so every element is checked up front.
  for (let index = 0; index < (length.value as number); index += 1) {
    const element = ownValue(entries, String(index));
    if (!element.present || !isPlainGetterFreeRecord(element.value)) {
      return false;
    }
  }
  for (let index = (length.value as number) - 1; index >= 0; index -= 1) {
    // A descriptor read never invokes a getter and detects a sparse hole.
    const element = ownValue(entries, String(index));
    if (!element.present || !isPlainGetterFreeRecord(element.value)) {
      return false;
    }
    const entry = element.value as unknown as LaneRunJournalEntryRecord;
    const kind = ownValue(entry, 'kind');
    const entryRunId = ownValue(entry, 'runId');
    const outcome = ownValue(entry, 'outcome');
    if (
      !kind.present || kind.value !== 'result' ||
      !entryRunId.present || entryRunId.value !== runId ||
      (outcome.present && outcome.value === 'ambiguous')
    ) {
      continue;
    }
    const key = ownValue(entry, 'key');
    const parsed = !key.present || key.value === null ? null : parseLaneRunKey(key.value);
    if (parsed === null || parsed.kind !== 'step') {
      continue;
    }
    if (parsed.step === 'stop') {
      const reasonCode = ownValue(entry, 'reasonCode');
      return reasonCode.present && reasonCode.value === 'stop-timeout';
    }
    if (parsed.step === 'dispatch') {
      // A later completed dispatch cleared the condition; a non-completed one
      // (refused, not-started, ...) is ignored and the scan continues.
      const dispatchOutcome = outcome.present ? outcome.value : null;
      if (dispatchOutcome === 'completed') {
        return false;
      }
      continue;
    }
    if (parsed.step === 'collect') {
      return false;
    }
  }
  return false;
}
