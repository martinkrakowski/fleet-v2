/**
 * The closed-code fact a crashed start leaves in the start-incomplete ledger.
 * The ledger stores only the closed code — never the prepare detail, a path, a
 * credential, or the prepare message. Pure: never throws, never runs a getter,
 * never echoes an input value.
 */

import { LANE_RUN_ID_PATTERN } from './lane-run-records.js';
import { isCalendarDateTime, readExactPlainRecord } from './plain-record-reads.js';

export const START_INCOMPLETE_STEP_VALUES = ['reserve', 'worktree', 'brief', 'attempt', 'run'] as const;
export type StartIncompleteStep = (typeof START_INCOMPLETE_STEP_VALUES)[number];

/** The fixed reason codes an `incomplete` may carry, never a host's text. */
export type StartIncompleteReasonCode =
  | 'worktree-path-exists-other'
  | 'worktree-branch-exists-other'
  | 'worktree-git-refused'
  | 'worktree-unknown'
  | 'base-tip-unknown'
  | 'no-clone-on-host'
  | 'brief-rejected'
  | 'brief-acceptance-spec-shell'
  | 'attempt-differs'
  | 'attempt-save-failed'
  | 'run-exists'
  | 'reservation-incomplete'
  | 'attempt-incomplete';

const REASON_CODES: readonly StartIncompleteReasonCode[] = [
  'worktree-path-exists-other',
  'worktree-branch-exists-other',
  'worktree-git-refused',
  'worktree-unknown',
  'base-tip-unknown',
  'no-clone-on-host',
  'brief-rejected',
  'brief-acceptance-spec-shell',
  'attempt-differs',
  'attempt-save-failed',
  'run-exists',
  'reservation-incomplete',
  'attempt-incomplete',
];

export interface StartIncompleteFact {
  readonly attemptId: string;
  readonly runId: string;
  readonly step: StartIncompleteStep;
  readonly reasonCode: StartIncompleteReasonCode;
  readonly recordedAtIso: string;
}

const FACT_KEYS: readonly string[] = ['attemptId', 'runId', 'step', 'reasonCode', 'recordedAtIso'];

/** `attempt-` followed by a short, key-safe id; a ULID in production. */
export const ATTEMPT_ID_PATTERN = /^attempt-[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

/** An upper bound on any string field, checked by `.length` before pattern or scan. */
const MAX_FIELD_LENGTH = 256;

export type StartIncompleteFactRead =
  | { readonly ok: true; readonly fact: StartIncompleteFact }
  | { readonly ok: false; readonly code: 'invalid' };

/**
 * Read one fact. Exact own keys `attemptId`, `runId`, `step`, `reasonCode`,
 * `recordedAtIso`; a getter is never invoked (the own descriptor is read, so a
 * getter has no value and the fact is invalid); a hostile proxy, an array-like
 * object, a `__proto__` own key, extra or symbol keys, a non-plain prototype,
 * and any throwing read are all an invalid typed result, never a named error.
 */
export function readStartIncompleteFact(value: unknown): StartIncompleteFactRead {
  try {
    const rec = readExactPlainRecord(value, FACT_KEYS);
    if (rec === null) {
      return { ok: false, code: 'invalid' };
    }
    const attemptId = rec['attemptId'];
    const runId = rec['runId'];
    const step = rec['step'];
    const reasonCode = rec['reasonCode'];
    const recordedAtIso = rec['recordedAtIso'];
    if (
      typeof attemptId !== 'string' ||
      attemptId.length > MAX_FIELD_LENGTH ||
      !ATTEMPT_ID_PATTERN.test(attemptId)
    ) {
      return { ok: false, code: 'invalid' };
    }
    if (
      typeof runId !== 'string' ||
      runId.length > MAX_FIELD_LENGTH ||
      !LANE_RUN_ID_PATTERN.test(runId)
    ) {
      return { ok: false, code: 'invalid' };
    }
    if (
      typeof step !== 'string' ||
      !START_INCOMPLETE_STEP_VALUES.includes(step as StartIncompleteStep)
    ) {
      return { ok: false, code: 'invalid' };
    }
    if (
      typeof reasonCode !== 'string' ||
      !REASON_CODES.includes(reasonCode as StartIncompleteReasonCode)
    ) {
      return { ok: false, code: 'invalid' };
    }
    if (typeof recordedAtIso !== 'string' || recordedAtIso.length > MAX_FIELD_LENGTH || !isCalendarDateTime(recordedAtIso)) {
      return { ok: false, code: 'invalid' };
    }
    return {
      ok: true,
      fact: {
        attemptId,
        runId,
        step: step as StartIncompleteStep,
        reasonCode: reasonCode as StartIncompleteReasonCode,
        recordedAtIso,
      },
    };
  } catch {
    return { ok: false, code: 'invalid' };
  }
}

/** One attempt's ledger is capped at this many facts. */
export const START_INCOMPLETE_MAX_FACTS_PER_ATTEMPT = 16;

export type StartIncompleteFactListRead =
  | { readonly ok: true; readonly facts: readonly StartIncompleteFact[] }
  | { readonly ok: false; readonly code: 'invalid' };

/**
 * Read a list of facts. A non-array value (including a plain string) is refused
 * and never iterated; an array hole, a bad element, or a list longer than 16
 * elements refuses the whole list without reading past the 16th.
 */
export function readStartIncompleteFactList(value: unknown): StartIncompleteFactListRead {
  try {
    if (!Array.isArray(value)) {
      return { ok: false, code: 'invalid' };
    }
    if (value.length > START_INCOMPLETE_MAX_FACTS_PER_ATTEMPT) {
      return { ok: false, code: 'invalid' };
    }
    const facts: StartIncompleteFact[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return { ok: false, code: 'invalid' };
      }
      const parsed = readStartIncompleteFact(value[index]);
      if (!parsed.ok) {
        return { ok: false, code: 'invalid' };
      }
      facts.push(parsed.fact);
    }
    return { ok: true, facts };
  } catch {
    return { ok: false, code: 'invalid' };
  }
}

/**
 * Map a use-case `reason` string to its closed code. Returns the code when the
 * string is exactly a code, or exactly a code plus `: ` plus a suffix; the
 * suffix is discarded. Any other string returns null. Longest matching code
 * wins.
 */
export function startIncompleteReasonCode(reason: string): StartIncompleteReasonCode | null {
  if (typeof reason !== 'string') {
    return null;
  }
  const longestFirst = [...REASON_CODES].sort((left, right) => right.length - left.length);
  for (const code of longestFirst) {
    if (reason === code) {
      return code;
    }
    if (reason.length > code.length && reason.startsWith(code + ': ')) {
      return code;
    }
  }
  return null;
}

/** The single-line summary for a crashed-start attention item. */
export function crashedStartNoticeSummary(options: {
  readonly slotIndex: number | null;
  readonly attemptId: string;
  readonly fact: StartIncompleteFact | null;
}): string {
  const slotPhrase = options.slotIndex === null ? 'a capacity slot' : `capacity slot ${options.slotIndex}`;
  if (options.fact === null) {
    return `A lane start crashed and left ${slotPhrase} held for attempt ${options.attemptId}.`;
  }
  const fact = options.fact;
  return (
    `A lane start crashed at step ${fact.step} with reason ${fact.reasonCode} and left ` +
    `${slotPhrase} held for attempt ${options.attemptId}. ` +
    `Resolve with conductor start --abandon --run-id ${fact.runId} --attempt-id ${fact.attemptId}.`
  );
}
