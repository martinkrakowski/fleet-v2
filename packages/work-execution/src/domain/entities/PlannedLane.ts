// @generated entity stub — refined for lane WB1b.
/**
 * PlannedLane is one stored lane of a lane plan (work-board plan §3.2): the
 * child of `LanePlan`, carrying the lane's status and its former ids as
 * aliases (a dropped lane is kept, never deleted). A planned lane grants
 * nothing and owns no path until it is registered as a work order.
 * Validation returns a result and never throws; hostile or secret-shaped
 * input is refused with a fixed message, never echoed.
 */

import {
  LANE_PLAN_LIMITS,
  PLAN_DECISION_ID_PATTERN,
  PLAN_ID_PATTERN,
  PLAN_PACKAGE_PATTERN,
  PLAN_PROJECT_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
  PLANNED_LANE_MAX_ALIASES,
  PLANNED_LANE_STATUSES,
  PLANNED_LANE_TIERS,
} from '../lane-plan-records.js';
import type {
  PlannedLaneRecord,
  PlannedLaneRef,
  PlannedLaneStatus,
  PlannedLaneTier,
  PullRequestRef,
} from '../lane-plan-records.js';
import {
  planIdError,
  planPathError,
  planTextError,
  pullRequestRefError,
} from '../lane-plan-sidecar.js';

export type PlannedLaneResult =
  | { readonly success: true; readonly value: PlannedLane }
  | { readonly success: false; readonly error: Error; readonly code: 'invalid' };

const RECORD_KEYS: readonly string[] = [
  'laneId',
  'aliases',
  'scope',
  'packages',
  'sharedFiles',
  'tier',
  'after',
  'decisions',
  'status',
  'brief',
  'mergedPr',
];

const AFTER_KEYS: readonly string[] = ['projectId', 'planId', 'laneId'];

export class PlannedLane {
  private constructor(private readonly record: PlannedLaneRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown, path = 'lane'): PlannedLaneResult {
    try {
      return PlannedLane.createUnchecked(input, path);
    } catch {
      return unreadableInputResult();
    }
  }

  /**
   * Body of create. Hostile input (a throwing getter or proxy trap) may throw
   * out of this body; the public wrapper turns that into the fixed failure
   * result, never the exception's message. Only a plain object with exactly
   * the allowed own enumerable string keys is accepted, and every field is
   * read through its own property descriptor so no getter ever runs.
   */
  private static createUnchecked(input: unknown, path: string): PlannedLaneResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid(`PlannedLane ${path}: must be an object`);
    }
    const inputPrototype = Object.getPrototypeOf(input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return invalid(`PlannedLane ${path}: must be an object`);
    }
    const recordInput = readPlainRecord(input, RECORD_KEYS);
    if (recordInput === null) {
      return invalid(`PlannedLane ${path}: must have exactly its record fields`);
    }

    const laneIdError = planIdError(`${path}.laneId`, recordInput.laneId, PLANNED_LANE_ID_PATTERN, 'lane id');
    if (laneIdError !== null) {
      return invalid(`PlannedLane ${laneIdError}`);
    }
    const laneId = recordInput.laneId as string;

    const aliasesRaw = plainArrayCopy(recordInput.aliases);
    if (!Array.isArray(aliasesRaw)) {
      return invalid(`PlannedLane ${path}.aliases: must be a list`);
    }
    if (aliasesRaw.length > PLANNED_LANE_MAX_ALIASES) {
      return invalid(`PlannedLane ${path}.aliases: has too many entries`);
    }
    const aliases: string[] = [];
    const seenAlias = new Set<string>();
    for (let index = 0; index < aliasesRaw.length; index += 1) {
      const idError = planIdError(
        `${path}.aliases[${index}]`,
        aliasesRaw[index],
        PLANNED_LANE_ID_PATTERN,
        'lane id',
      );
      if (idError !== null) {
        return invalid(`PlannedLane ${idError}`);
      }
      const alias = aliasesRaw[index] as string;
      if (alias === laneId) {
        return invalid(`PlannedLane ${path}.aliases[${index}]: names its own lane`);
      }
      if (seenAlias.has(alias)) {
        return invalid(`PlannedLane ${path}.aliases[${index}]: is a duplicate`);
      }
      seenAlias.add(alias);
      aliases.push(alias);
    }

    const scopeError = planTextError(`${path}.scope`, recordInput.scope, LANE_PLAN_LIMITS.scopeBytes);
    if (scopeError !== null) {
      return invalid(`PlannedLane ${scopeError}`);
    }

    const packagesRaw = plainArrayCopy(recordInput.packages);
    if (!Array.isArray(packagesRaw)) {
      return invalid(`PlannedLane ${path}.packages: must be a list`);
    }
    if (packagesRaw.length === 0) {
      return invalid(`PlannedLane ${path}.packages: must not be empty`);
    }
    if (packagesRaw.length > LANE_PLAN_LIMITS.packages) {
      return invalid(`PlannedLane ${path}.packages: has too many entries`);
    }
    const packages: string[] = [];
    const seenPackage = new Set<string>();
    for (let index = 0; index < packagesRaw.length; index += 1) {
      const idError = planIdError(
        `${path}.packages[${index}]`,
        packagesRaw[index],
        PLAN_PACKAGE_PATTERN,
        'package name',
      );
      if (idError !== null) {
        return invalid(`PlannedLane ${idError}`);
      }
      const item = packagesRaw[index] as string;
      if (seenPackage.has(item)) {
        return invalid(`PlannedLane ${path}.packages[${index}]: is a duplicate`);
      }
      seenPackage.add(item);
      packages.push(item);
    }

    const sharedFilesRaw = plainArrayCopy(recordInput.sharedFiles);
    if (!Array.isArray(sharedFilesRaw)) {
      return invalid(`PlannedLane ${path}.sharedFiles: must be a list`);
    }
    if (sharedFilesRaw.length > LANE_PLAN_LIMITS.sharedFiles) {
      return invalid(`PlannedLane ${path}.sharedFiles: has too many entries`);
    }
    const sharedFiles: string[] = [];
    const seenSharedFile = new Set<string>();
    for (let index = 0; index < sharedFilesRaw.length; index += 1) {
      const pathError = planPathError(`${path}.sharedFiles[${index}]`, sharedFilesRaw[index]);
      if (pathError !== null) {
        return invalid(`PlannedLane ${pathError}`);
      }
      const item = sharedFilesRaw[index] as string;
      if (seenSharedFile.has(item)) {
        return invalid(`PlannedLane ${path}.sharedFiles[${index}]: is a duplicate`);
      }
      seenSharedFile.add(item);
      sharedFiles.push(item);
    }

    if (!PLANNED_LANE_TIERS.includes(recordInput.tier as PlannedLaneTier)) {
      return invalid(`PlannedLane ${path}.tier: must be 0, 1 or 2`);
    }
    const tier = recordInput.tier as PlannedLaneTier;

    const afterRaw = plainArrayCopy(recordInput.after);
    if (!Array.isArray(afterRaw)) {
      return invalid(`PlannedLane ${path}.after: must be a list`);
    }
    if (afterRaw.length > LANE_PLAN_LIMITS.after) {
      return invalid(`PlannedLane ${path}.after: has too many entries`);
    }
    const after: PlannedLaneRef[] = [];
    const seenAfter = new Set<string>();
    for (let index = 0; index < afterRaw.length; index += 1) {
      const ref = readLaneRef(afterRaw[index], `${path}.after[${index}]`);
      if (typeof ref === 'string') {
        return invalid(ref);
      }
      const key = `${ref.projectId}/${ref.planId}/${ref.laneId}`;
      if (seenAfter.has(key)) {
        return invalid(`PlannedLane ${path}.after[${index}]: is a duplicate`);
      }
      seenAfter.add(key);
      after.push(Object.freeze(ref));
    }

    const decisionsRaw = plainArrayCopy(recordInput.decisions);
    if (!Array.isArray(decisionsRaw)) {
      return invalid(`PlannedLane ${path}.decisions: must be a list`);
    }
    if (decisionsRaw.length > LANE_PLAN_LIMITS.laneDecisions) {
      return invalid(`PlannedLane ${path}.decisions: has too many entries`);
    }
    const decisions: string[] = [];
    const seenDecision = new Set<string>();
    for (let index = 0; index < decisionsRaw.length; index += 1) {
      const idError = planIdError(
        `${path}.decisions[${index}]`,
        decisionsRaw[index],
        PLAN_DECISION_ID_PATTERN,
        'decision id',
      );
      if (idError !== null) {
        return invalid(`PlannedLane ${idError}`);
      }
      const item = decisionsRaw[index] as string;
      if (seenDecision.has(item)) {
        return invalid(`PlannedLane ${path}.decisions[${index}]: is a duplicate`);
      }
      seenDecision.add(item);
      decisions.push(item);
    }

    if (!PLANNED_LANE_STATUSES.includes(recordInput.status as PlannedLaneStatus)) {
      return invalid(`PlannedLane ${path}.status: must be one of planned, deferred, dropped`);
    }
    const status = recordInput.status as PlannedLaneStatus;

    if (recordInput.brief !== null) {
      const briefError = planPathError(`${path}.brief`, recordInput.brief);
      if (briefError !== null) {
        return invalid(`PlannedLane ${briefError}`);
      }
    }
    const brief = recordInput.brief as string | null;

    let mergedPr: PullRequestRef | null = null;
    if (recordInput.mergedPr !== null) {
      const prError = pullRequestRefError(`${path}.mergedPr`, recordInput.mergedPr);
      if (prError !== null) {
        return invalid(`PlannedLane ${prError}`);
      }
      const pr = recordInput.mergedPr as PullRequestRef;
      mergedPr = { repository: pr.repository, number: pr.number };
    }

    const record: PlannedLaneRecord = Object.freeze({
      laneId,
      aliases: Object.freeze([...aliases]),
      scope: recordInput.scope as string,
      packages: Object.freeze([...packages]),
      sharedFiles: Object.freeze([...sharedFiles]),
      tier,
      after: Object.freeze(after),
      decisions: Object.freeze([...decisions]),
      status,
      brief,
      mergedPr: mergedPr === null ? null : Object.freeze(mergedPr),
    });
    return { success: true, value: new PlannedLane(record) };
  }

  /** Fresh plain record; nested objects are fresh copies. */
  toRecord(): PlannedLaneRecord {
    return {
      laneId: this.record.laneId,
      aliases: [...this.record.aliases],
      scope: this.record.scope,
      packages: [...this.record.packages],
      sharedFiles: [...this.record.sharedFiles],
      tier: this.record.tier,
      after: this.record.after.map((ref) => ({
        projectId: ref.projectId,
        planId: ref.planId,
        laneId: ref.laneId,
      })),
      decisions: [...this.record.decisions],
      status: this.record.status,
      brief: this.record.brief,
      mergedPr: this.record.mergedPr === null
        ? null
        : { repository: this.record.mergedPr.repository, number: this.record.mergedPr.number },
    };
  }

  getLaneId(): string {
    return this.record.laneId;
  }

  /** Fresh copy of the aliases (former ids, oldest first). */
  getAliases(): string[] {
    return [...this.record.aliases];
  }

  getStatus(): PlannedLaneStatus {
    return this.record.status;
  }

  /** True for the lane's current id or any of its aliases. */
  answersTo(id: string): boolean {
    return id === this.record.laneId || this.record.aliases.includes(id);
  }
}

function invalid(message: string): PlannedLaneResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

function unreadableInputResult(): PlannedLaneResult {
  return { success: false, error: new Error('PlannedLane input could not be read'), code: 'invalid' };
}

/** A resolved `{ projectId, planId, laneId }` or its fixed error message. */
function readLaneRef(value: unknown, path: string): PlannedLaneRef | string {
  const snapshot = readPlainRecord(value, AFTER_KEYS);
  if (snapshot === null) {
    return `PlannedLane ${path}: must be a resolved lane reference object`;
  }
  const projectIdError = planIdError(`${path}.projectId`, snapshot.projectId, PLAN_PROJECT_ID_PATTERN, 'project id');
  if (projectIdError !== null) {
    return `PlannedLane ${projectIdError}`;
  }
  const planIdCheck = planIdErrorValue(`${path}.planId`, snapshot.planId);
  if (planIdCheck !== null) {
    return `PlannedLane ${planIdCheck}`;
  }
  const laneIdError = planIdError(`${path}.laneId`, snapshot.laneId, PLANNED_LANE_ID_PATTERN, 'lane id');
  if (laneIdError !== null) {
    return `PlannedLane ${laneIdError}`;
  }
  return {
    projectId: snapshot.projectId as string,
    planId: snapshot.planId as string,
    laneId: snapshot.laneId as string,
  };
}

function planIdErrorValue(path: string, value: unknown): string | null {
  return planIdError(path, value, PLAN_ID_PATTERN, 'plan id');
}

/** A plain object with exactly the given own enumerable string keys, read through descriptors. */
function readPlainRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
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
    if (!descriptor?.enumerable) {
      return null;
    }
    out[key] = descriptor.value;
  }
  return out;
}

/** A fresh plain array copied by index (no iterator, no species); a non-array is returned unchanged. */
function plainArrayCopy(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    copy.push(descriptor === undefined ? undefined : descriptor.value);
  }
  return copy;
}
