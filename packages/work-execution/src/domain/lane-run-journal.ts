/**
 * The keyed run journal (plan §3.5, §3.8, §3.9): one entry of the run
 * journal — an intent before an external action, its result after, or a
 * conduct entry naming the state the driver entered. Pure: no store, no
 * clock, no id minting; the caller supplies `entryId` and `recordedAtIso`.
 * The whole append decision lives here so both stores (K1b-3) run the same
 * rules under their own guard.
 */

import { containsSecretShape } from '@fleet/shared';
import { parseLaneRunKey, REQUEST_ID_PATTERN } from './lane-run-keys.js';
import type { LaneRunStopKeyMode, ParsedLaneRunKey } from './lane-run-keys.js';
import { LANE_RUN_ID_PATTERN } from './lane-run-records.js';
import type { LaneRunKeyStep } from './lane-run-records.js';
import { LANE_RUN_STATES } from './value-objects/LaneRunState.vo.js';
import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';

export const LANE_RUN_JOURNAL_ENTRY_VERSION = 1 as const;

/** intent: before an external action (or a stop, resume, request or reaper repair); result: after it; conduct: a state the driver entered. */
export const LANE_RUN_JOURNAL_ENTRY_KINDS = ['intent', 'result', 'conduct'] as const;
export type LaneRunJournalEntryKind = (typeof LANE_RUN_JOURNAL_ENTRY_KINDS)[number];

/**
 * A result's outcome. `ambiguous` is the only non-final outcome: a key may collect any number of
 * `ambiguous` results, then at most one final result, and nothing after it.
 */
export const LANE_RUN_JOURNAL_OUTCOMES = [
  'completed', 'refused', 'not-started', 'cancelled-unstarted', 'reconciled', 'overtaken', 'dry-run',
  'ambiguous',
] as const;
export type LaneRunJournalOutcome = (typeof LANE_RUN_JOURNAL_OUTCOMES)[number];

/** A typed reason token on a result (a refusal kind, a park qualifier); never free text. */
export const LANE_RUN_JOURNAL_REASON_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface LaneRunJournalEntryRecord {
  readonly version: typeof LANE_RUN_JOURNAL_ENTRY_VERSION;
  /** A ULID minted by the caller; unique in the journal. */
  readonly entryId: string;
  readonly kind: LaneRunJournalEntryKind;
  /** intent and result: a key parseLaneRunKey accepts; conduct: null. */
  readonly key: string | null;
  /** The run the entry belongs to: the key's run for step, stop and resume keys; null or a run id for request and reaper keys; required for conduct. */
  readonly runId: string | null;
  readonly recordedAtIso: string;
  /** A stop intent: the mode its key names (§3.9.1). Every other entry: null. */
  readonly mode: LaneRunStopKeyMode | null;
  /** A stop or resume intent: the run revision the requester read (§3.8). Every other entry: null. */
  readonly expectedRevision: number | null;
  /** An intent: the id minted for its action before it runs (attempt id, review request id, question key; §3.2), or null. Other kinds: null. */
  readonly mintedId: string | null;
  /** A result: its outcome. Other kinds: null. */
  readonly outcome: LaneRunJournalOutcome | null;
  /** A result: an optional typed reason token. Other kinds: null. */
  readonly reasonCode: string | null;
  /** A result: the policy grant the action consumed, if any (§3.9.1: a consumed grant is named, never reused). Other kinds: null. */
  readonly grantId: string | null;
  /** conduct: the state entered. Other kinds: null. */
  readonly state: LaneRunStateValue | null;
}

export type LaneRunJournalEntryRead =
  | { readonly ok: true; readonly entry: LaneRunJournalEntryRecord }
  | { readonly ok: false; readonly error: string };

export function readLaneRunJournalEntry(input: unknown): LaneRunJournalEntryRead {
  try {
    return readLaneRunJournalEntryUnchecked(input);
  } catch {
    return { ok: false, error: 'LaneRunJournal input could not be read' };
  }
}

const ENTRY_KEYS: readonly string[] = [
  'version',
  'entryId',
  'kind',
  'key',
  'runId',
  'recordedAtIso',
  'mode',
  'expectedRevision',
  'mintedId',
  'outcome',
  'reasonCode',
  'grantId',
  'state',
];

const ID_MAX_BYTES = 256;
const LEASE_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function readLaneRunJournalEntryUnchecked(input: unknown): LaneRunJournalEntryRead {
  const snapshot = readPlainObject(input, ENTRY_KEYS);
  if (snapshot === null) {
    return { ok: false, error: 'LaneRunJournal entry must be a record with exactly the entry keys' };
  }
  const headError = entryHeadError(snapshot);
  if (headError !== null) {
    return { ok: false, error: headError };
  }
  const kind = snapshot.kind as LaneRunJournalEntryKind;
  const key = snapshot.key;
  const keyError = entryKeyError(kind, key);
  if (keyError !== null) {
    return { ok: false, error: keyError };
  }
  const parsedKey = kind === 'conduct' ? null : parseLaneRunKey(key);
  const runIdError = entryRunIdError(kind, parsedKey, snapshot.runId);
  if (runIdError !== null) {
    return { ok: false, error: runIdError };
  }
  const modeError = entryModeError(kind, parsedKey, snapshot.mode);
  if (modeError !== null) {
    return { ok: false, error: modeError };
  }
  const expectedRevisionError = entryExpectedRevisionError(kind, parsedKey, snapshot.expectedRevision);
  if (expectedRevisionError !== null) {
    return { ok: false, error: expectedRevisionError };
  }
  const mintedIdError = entryMintedIdError(kind, snapshot.mintedId);
  if (mintedIdError !== null) {
    return { ok: false, error: mintedIdError };
  }
  const outcomeError = entryOutcomeError(kind, snapshot.outcome);
  if (outcomeError !== null) {
    return { ok: false, error: outcomeError };
  }
  const reasonCodeError = entryReasonCodeError(kind, snapshot.reasonCode);
  if (reasonCodeError !== null) {
    return { ok: false, error: reasonCodeError };
  }
  const grantIdError = entryGrantIdError(kind, snapshot.grantId);
  if (grantIdError !== null) {
    return { ok: false, error: grantIdError };
  }
  const stateError = entryStateError(kind, snapshot.state);
  if (stateError !== null) {
    return { ok: false, error: stateError };
  }
  const entry: LaneRunJournalEntryRecord = Object.freeze({
    version: LANE_RUN_JOURNAL_ENTRY_VERSION,
    entryId: snapshot.entryId as string,
    kind,
    key: key as string | null,
    runId: snapshot.runId as string | null,
    recordedAtIso: new Date(snapshot.recordedAtIso as string).toISOString(),
    mode: snapshot.mode as LaneRunStopKeyMode | null,
    expectedRevision: snapshot.expectedRevision as number | null,
    mintedId: snapshot.mintedId as string | null,
    outcome: snapshot.outcome as LaneRunJournalOutcome | null,
    reasonCode: snapshot.reasonCode as string | null,
    grantId: snapshot.grantId as string | null,
    state: snapshot.state as LaneRunStateValue | null,
  });
  return { ok: true, entry };
}

function entryHeadError(snapshot: Record<string, unknown>): string | null {
  if (snapshot.version !== LANE_RUN_JOURNAL_ENTRY_VERSION) {
    return 'LaneRunJournal version must be 1';
  }
  if (typeof snapshot.entryId !== 'string' || !REQUEST_ID_PATTERN.test(snapshot.entryId)) {
    return 'LaneRunJournal entryId must be a ULID';
  }
  if (!LANE_RUN_JOURNAL_ENTRY_KINDS.includes(snapshot.kind as LaneRunJournalEntryKind)) {
    return 'LaneRunJournal kind must be intent, result or conduct';
  }
  if (
    typeof snapshot.recordedAtIso !== 'string' ||
    !LEASE_ISO_PATTERN.test(snapshot.recordedAtIso) ||
    !isCalendarDateTime(snapshot.recordedAtIso) ||
    Number.isNaN(Date.parse(snapshot.recordedAtIso))
  ) {
    return 'LaneRunJournal recordedAtIso must be an ISO-8601 time with a zone';
  }
  return null;
}

function entryKeyError(kind: LaneRunJournalEntryKind, key: unknown): string | null {
  if (kind === 'conduct') {
    if (key !== null) {
      return 'LaneRunJournal key must be a run journal key for intents and results and null for conduct';
    }
    return null;
  }
  if (parseLaneRunKey(key) === null) {
    return 'LaneRunJournal key must be a run journal key for intents and results and null for conduct';
  }
  return null;
}

function entryRunIdError(
  kind: LaneRunJournalEntryKind,
  parsedKey: ParsedLaneRunKey | null,
  runId: unknown,
): string | null {
  if (parsedKey !== null) {
    if (parsedKey.kind === 'step' || parsedKey.kind === 'stop' || parsedKey.kind === 'resume') {
      if (runId !== parsedKey.runId) {
        return 'LaneRunJournal runId does not match its key';
      }
      return null;
    }
    if (runId !== null && (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId))) {
      return 'LaneRunJournal runId does not match its key';
    }
    return null;
  }
  if (kind === 'conduct' && (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId))) {
    return 'LaneRunJournal runId does not match its key';
  }
  return null;
}

function entryModeError(
  kind: LaneRunJournalEntryKind,
  parsedKey: ParsedLaneRunKey | null,
  mode: unknown,
): string | null {
  if (kind === 'intent' && parsedKey !== null && parsedKey.kind === 'stop') {
    if (mode !== parsedKey.mode) {
      return 'LaneRunJournal mode does not match its key';
    }
    return null;
  }
  if (mode !== null) {
    return 'LaneRunJournal mode does not match its key';
  }
  return null;
}

function entryExpectedRevisionError(
  kind: LaneRunJournalEntryKind,
  parsedKey: ParsedLaneRunKey | null,
  expectedRevision: unknown,
): string | null {
  if (kind === 'intent' && parsedKey !== null && (parsedKey.kind === 'stop' || parsedKey.kind === 'resume')) {
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
      return 'LaneRunJournal expectedRevision must be a positive integer on stop and resume intents and null elsewhere';
    }
    return null;
  }
  if (expectedRevision !== null) {
    return 'LaneRunJournal expectedRevision must be a positive integer on stop and resume intents and null elsewhere';
  }
  return null;
}

function entryMintedIdError(kind: LaneRunJournalEntryKind, mintedId: unknown): string | null {
  if (kind === 'intent') {
    if (mintedId !== null) {
      return idError('mintedId', mintedId);
    }
    return null;
  }
  if (mintedId !== null) {
    return 'LaneRunJournal mintedId must be null except on an intent';
  }
  return null;
}

function entryOutcomeError(kind: LaneRunJournalEntryKind, outcome: unknown): string | null {
  if (kind === 'result') {
    if (!LANE_RUN_JOURNAL_OUTCOMES.includes(outcome as LaneRunJournalOutcome)) {
      return 'LaneRunJournal outcome must be a known outcome on a result and null elsewhere';
    }
    return null;
  }
  if (outcome !== null) {
    return 'LaneRunJournal outcome must be a known outcome on a result and null elsewhere';
  }
  return null;
}

function entryReasonCodeError(kind: LaneRunJournalEntryKind, reasonCode: unknown): string | null {
  if (kind === 'result') {
    if (reasonCode !== null && (typeof reasonCode !== 'string' || !LANE_RUN_JOURNAL_REASON_CODE_PATTERN.test(reasonCode))) {
      return 'LaneRunJournal reasonCode must be null or a lowercase token on a result';
    }
    return null;
  }
  if (reasonCode !== null) {
    return 'LaneRunJournal reasonCode must be null or a lowercase token on a result';
  }
  return null;
}

function entryGrantIdError(kind: LaneRunJournalEntryKind, grantId: unknown): string | null {
  if (kind === 'result') {
    if (grantId !== null) {
      return idError('grantId', grantId);
    }
    return null;
  }
  if (grantId !== null) {
    return 'LaneRunJournal grantId must be null except on a result';
  }
  return null;
}

function entryStateError(kind: LaneRunJournalEntryKind, state: unknown): string | null {
  if (kind === 'conduct') {
    if (typeof state !== 'string' || !LANE_RUN_STATES.includes(state as LaneRunStateValue)) {
      return 'LaneRunJournal state must be a lane run state on conduct and null elsewhere';
    }
    return null;
  }
  if (state !== null) {
    return 'LaneRunJournal state must be a lane run state on conduct and null elsewhere';
  }
  return null;
}

export const LANE_RUN_JOURNAL_REFUSALS = [
  'stop-mode-mismatch', 'invalid-entry', 'duplicate-entry-id', 'stop-already-requested',
  'stop-already-forced', 'duplicate-key', 'result-without-intent', 'result-after-final',
] as const;
export type LaneRunJournalRefusal = (typeof LANE_RUN_JOURNAL_REFUSALS)[number];

export type LaneRunJournalAppendDecision =
  | { readonly ok: true; readonly entry: LaneRunJournalEntryRecord }
  | { readonly ok: false; readonly reason: LaneRunJournalRefusal; readonly detail: string | null };

/** Pure: `existing` is the whole journal in append order (already validated). Never throws. */
export function prepareLaneRunJournalAppend(
  existing: readonly LaneRunJournalEntryRecord[],
  input: unknown,
): LaneRunJournalAppendDecision {
  // 1. Stop mode first, before validation, so a mismatched stop gets its typed reason.
  if (stopModeMismatchOf(input)) {
    return { ok: false, reason: 'stop-mode-mismatch', detail: null };
  }

  // 2. Validation.
  const read = readLaneRunJournalEntry(input);
  if (!read.ok) {
    return { ok: false, reason: 'invalid-entry', detail: read.error };
  }
  const entry = read.entry;

  // 3. Entry id uniqueness.
  for (const existingEntry of existing) {
    if (existingEntry.entryId === entry.entryId) {
      return { ok: false, reason: 'duplicate-entry-id', detail: null };
    }
  }

  // 4. Stop intents: the per-run strongest-stop refusal, before the key check.
  if (entry.kind === 'intent' && entry.mode !== null) {
    const refusal = stopIntentRefusal(existing, entry);
    if (refusal !== null) {
      return { ok: false, reason: refusal, detail: null };
    }
  }

  // 5. Any other intent: the same key already present.
  if (entry.kind === 'intent' && entry.mode === null) {
    for (const existingEntry of existing) {
      if (existingEntry.kind === 'intent' && existingEntry.key === entry.key) {
        return { ok: false, reason: 'duplicate-key', detail: null };
      }
    }
  }

  // 6. Result: needs its intent, the same run, and nothing after a final result.
  if (entry.kind === 'result') {
    const refusal = resultRefusal(existing, entry);
    if (refusal !== null) {
      return refusal;
    }
  }

  // 7. Conduct: no further check. 8. Append.
  return { ok: true, entry };
}

function stopModeMismatchOf(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  let kind: unknown;
  let key: unknown;
  let mode: unknown;
  try {
    const readField = (name: string): unknown => {
      const descriptor = Reflect.getOwnPropertyDescriptor(input, name);
      return descriptor === undefined ? undefined : descriptor.value;
    };
    kind = readField('kind');
    key = readField('key');
    mode = readField('mode');
  } catch {
    return false;
  }
  if (kind !== 'intent' || typeof key !== 'string') {
    return false;
  }
  const parsed = parseLaneRunKey(key);
  return parsed !== null && parsed.kind === 'stop' && mode !== parsed.mode;
}

function strongestStopMode(existing: readonly LaneRunJournalEntryRecord[], runId: string | null): LaneRunStopKeyMode | null {
  let strongest: LaneRunStopKeyMode | null = null;
  for (const existingEntry of existing) {
    if (existingEntry.kind === 'intent' && existingEntry.mode !== null && existingEntry.runId === runId) {
      if (existingEntry.mode === 'force') {
        strongest = 'force';
      } else if (strongest !== 'force') {
        strongest = 'graceful';
      }
    }
  }
  return strongest;
}

function stopIntentRefusal(
  existing: readonly LaneRunJournalEntryRecord[],
  entry: LaneRunJournalEntryRecord,
): LaneRunJournalRefusal | null {
  const strongest = strongestStopMode(existing, entry.runId);
  if (entry.mode === 'force') {
    return strongest === 'force' ? 'stop-already-requested' : null;
  }
  if (entry.mode === 'graceful') {
    if (strongest === 'force') {
      return 'stop-already-forced';
    }
    if (strongest === 'graceful') {
      return 'stop-already-requested';
    }
  }
  return null;
}

function resultRefusal(
  existing: readonly LaneRunJournalEntryRecord[],
  entry: LaneRunJournalEntryRecord,
): { readonly ok: false; readonly reason: LaneRunJournalRefusal; readonly detail: string | null } | null {
  let intent: LaneRunJournalEntryRecord | null = null;
  for (const existingEntry of existing) {
    if (existingEntry.kind === 'intent' && existingEntry.key === entry.key) {
      intent = existingEntry;
      break;
    }
  }
  if (intent === null) {
    return { ok: false, reason: 'result-without-intent', detail: null };
  }
  if (intent.runId !== entry.runId) {
    return { ok: false, reason: 'invalid-entry', detail: 'LaneRunJournal result runId must equal its intent\'s' };
  }
  for (const existingEntry of existing) {
    if (existingEntry.kind === 'result' && existingEntry.key === entry.key && existingEntry.outcome !== 'ambiguous') {
      return { ok: false, reason: 'result-after-final', detail: null };
    }
  }
  return null;
}

export interface LaneRunJournalStopFacts {
  readonly stopMode: LaneRunStopKeyMode | null;     // strongest over the run's stop intents; null when none
  readonly stopRequestedAtIso: string | null;       // recordedAtIso of the run's first stop intent
}

export function laneRunJournalStopFacts(entries: readonly LaneRunJournalEntryRecord[], runId: string): LaneRunJournalStopFacts {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { stopMode: null, stopRequestedAtIso: null };
  }
  let stopMode: LaneRunStopKeyMode | null = null;
  let stopRequestedAtIso: string | null = null;
  for (const entry of entries) {
    if (entry.kind === 'intent' && entry.mode !== null && entry.runId === runId) {
      if (stopRequestedAtIso === null) {
        stopRequestedAtIso = entry.recordedAtIso;
      }
      if (entry.mode === 'force') {
        stopMode = 'force';
      } else if (stopMode !== 'force') {
        stopMode = 'graceful';
      }
    }
  }
  return { stopMode, stopRequestedAtIso };
}

export interface LaneRunJournalPendingIntent {
  readonly key: string;
  readonly step: LaneRunKeyStep;
  readonly reconciliation: 'unread' | 'ambiguous';
}

/**
 * §3.5: the run's last step-key intent with no final result: `unread` when it has no result,
 * `ambiguous` when its results are all `ambiguous`; null when every step intent has a final result.
 * Control keys (stop, resume, request, reaper) are never pending: they are not external actions.
 */
export function laneRunJournalPendingIntent(entries: readonly LaneRunJournalEntryRecord[], runId: string): LaneRunJournalPendingIntent | null {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return null;
  }
  let pending: LaneRunJournalPendingIntent | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'intent' || entry.runId !== runId || entry.key === null) {
      continue;
    }
    const parsed = parseLaneRunKey(entry.key);
    if (parsed === null || parsed.kind !== 'step') {
      continue;
    }
    let hasFinalResult = false;
    let hasResult = false;
    for (const other of entries) {
      if (other.kind === 'result' && other.key === entry.key) {
        hasResult = true;
        if (other.outcome !== 'ambiguous') {
          hasFinalResult = true;
          break;
        }
      }
    }
    if (hasFinalResult) {
      continue;
    }
    pending = {
      key: entry.key,
      step: parsed.step,
      reconciliation: hasResult ? 'ambiguous' : 'unread',
    };
  }
  return pending;
}

/** The state of the run's last conduct entry; 'ready' when it has none. */
export function laneRunJournalState(entries: readonly LaneRunJournalEntryRecord[], runId: string): LaneRunStateValue {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return 'ready';
  }
  let state: LaneRunStateValue = 'ready';
  for (const entry of entries) {
    if (entry.kind === 'conduct' && entry.runId === runId && entry.state !== null) {
      state = entry.state;
    }
  }
  return state;
}

/**
 * §3.9.1 dispatchResult for one dispatch key: 'none' with no intent; 'not-started' when its final
 * result is 'not-started', 'refused' or 'dry-run'; 'started' otherwise (no result, ambiguous, or any
 * other final outcome).
 */
export function laneRunJournalDispatchResult(entries: readonly LaneRunJournalEntryRecord[], dispatchKey: string): 'none' | 'not-started' | 'started' {
  if (typeof dispatchKey !== 'string' || parseLaneRunKey(dispatchKey) === null) {
    return 'none';
  }
  let hasIntent = false;
  let finalOutcome: LaneRunJournalOutcome | null = null;
  for (const entry of entries) {
    if (entry.key !== dispatchKey) {
      continue;
    }
    if (entry.kind === 'intent') {
      hasIntent = true;
    } else if (entry.kind === 'result' && entry.outcome !== 'ambiguous') {
      finalOutcome = entry.outcome;
    }
  }
  if (!hasIntent) {
    return 'none';
  }
  if (finalOutcome === 'not-started' || finalOutcome === 'refused' || finalOutcome === 'dry-run') {
    return 'not-started';
  }
  return 'started';
}

/**
 * A plain object with exactly the given own enumerable string keys, values
 * read through their own property descriptors (so no getter ever runs).
 * Anything else — a non-object, a prototype outside Object.prototype/null, a
 * missing or extra or non-enumerable key, a symbol key — returns null.
 */
function readPlainObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      return null;
    }
    out[key] = descriptor.value;
  }
  return out;
}

function idError(field: string, value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > ID_MAX_BYTES
  ) {
    return 'LaneRunJournal ' + field + ' must be a non-empty id of at most 256 bytes';
  }
  if (containsSecretShape(value)) {
    return 'LaneRunJournal ' + field + ' contains a secret-shaped value and was refused';
  }
  return null;
}

/**
 * True when the date and time fields name a real calendar instant. Date.parse rolls an impossible
 * date such as 02-31 over into the next month instead of refusing it, so the fields are checked here.
 */
function isCalendarDateTime(iso: string): boolean {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const hour = Number(iso.slice(11, 13));
  const minute = Number(iso.slice(14, 16));
  const second = Number(iso.slice(17, 19));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}
