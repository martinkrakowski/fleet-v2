/**
 * PT1a: the class of a park, the conductor's own answer to "why is this run
 * parked and who must act". It is computed once, when the park is raised, from
 * data the conductor already holds (the park reason and qualifier, the bounded
 * findings view, the screened failing file of the gate and the work order's
 * owned paths), and stored on the park record as `class`. Ids and codes only:
 * never finding text, never a path. Unknown stays unknown: a park the rules do
 * not recognise is `other`, and a record without `class` reads as `other`.
 * Pure: no I/O, never throws.
 */

import type { LaneRunStateValue } from './value-objects/LaneRunState.vo.js';

export const LANE_RUN_PARK_CLASSES = [
  'transport-busy',
  'minor-only-fail',
  'gate-outside-owned',
  'blocker',
  'step-refused',
  'other',
] as const;
export type LaneRunParkClass = (typeof LANE_RUN_PARK_CLASSES)[number];

/** The class a record without one reads as. */
export const DEFAULT_PARK_CLASS: LaneRunParkClass = 'other';

/** A declared class, or `undefined` for anything else (a stored value is never repaired). */
export function parseParkClass(value: unknown): LaneRunParkClass | undefined {
  return typeof value === 'string' && (LANE_RUN_PARK_CLASSES as readonly string[]).includes(value)
    ? (value as LaneRunParkClass)
    : undefined;
}

/** The class of a stored park: its own declared class, else `other`. Own data property only. */
export function parkClassOf(parked: unknown): LaneRunParkClass {
  try {
    if (typeof parked !== 'object' || parked === null) {
      return DEFAULT_PARK_CLASS;
    }
    const descriptor = Object.getOwnPropertyDescriptor(parked, 'class');
    return parseParkClass(descriptor?.value) ?? DEFAULT_PARK_CLASS;
  } catch {
    return DEFAULT_PARK_CLASS;
  }
}

/** What the classifier reads. Every field is a code, an id or a count; none is free text. */
export interface ParkClassInput {
  readonly reason: string;
  readonly qualifier: string | null;
  readonly parkedFrom: LaneRunStateValue;
  /** The bounded findings view at park time: severities only are read. `null`/`undefined`: unread or none. */
  readonly findingSeverities?: readonly string[] | null;
  /** The screened repo-relative file the failing gate check named; null/undefined when unknown. */
  readonly gateFailingFile?: string | null;
  /** The work order's owned paths; null/undefined when the work order could not be read. */
  readonly ownedPaths?: readonly string[] | null;
}

/** Whether `file` is one of `owned` or lies under an owned directory (a trailing slash is allowed). */
export function isOwnedPath(file: string, owned: readonly string[]): boolean {
  return owned.some((path) => {
    const root = path.endsWith('/') ? path.slice(0, -1) : path;
    return root.length > 0 && (file === root || file.startsWith(root + '/'));
  });
}

const REVIEW_STEPS: readonly string[] = ['brief-check', 'code-review'];
const FINDING_PARKS: readonly string[] = ['blocker-after-round-2', 'acceptance-rejected'];

/** The class of a park about to be recorded. Total. */
export function classifyPark(input: ParkClassInput): LaneRunParkClass {
  try {
    const { reason, qualifier } = input;
    if (reason === 'step-refused') {
      return qualifier === 'prepare' || qualifier === 'dispatch' ? 'step-refused' : 'other';
    }
    if (reason === 'review-seat-unavailable') {
      return 'transport-busy';
    }
    if (reason === 'ambiguous' && qualifier !== null && REVIEW_STEPS.includes(qualifier)) {
      return 'transport-busy';
    }
    if (!FINDING_PARKS.includes(reason)) {
      return 'other';
    }
    const file = input.gateFailingFile;
    const owned = input.ownedPaths;
    if (
      reason === 'blocker-after-round-2' &&
      input.parkedFrom === 'gating' &&
      typeof file === 'string' &&
      Array.isArray(owned) &&
      owned.length > 0 &&
      !isOwnedPath(file, owned)
    ) {
      return 'gate-outside-owned';
    }
    const severities = input.findingSeverities;
    if (Array.isArray(severities) && severities.length > 0) {
      if (severities.some((severity) => severity === 'blocker' || severity === 'major')) {
        return 'blocker';
      }
      if (severities.every((severity) => severity === 'minor' || severity === 'nit')) {
        return 'minor-only-fail';
      }
    }
    return 'other';
  } catch {
    return DEFAULT_PARK_CLASS;
  }
}
