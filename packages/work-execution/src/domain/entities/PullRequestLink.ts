// @generated entity stub — refined for lane WB1b.
/**
 * PullRequestLink is a pull request's one lane as a stored, versioned record
 * (work-board plan §3.2 "PR links are unique"): keyed (repository, number),
 * naming exactly one lane — the work order's own lane in its project, with
 * `planId` null for a lane with no plan. The same link again is a no-op and a
 * link to a different lane is refused (pr-already-linked). Validation returns
 * a result and never throws; hostile or secret-shaped input is refused with a
 * fixed message, never echoed.
 */

import { isCalendarDateTime, readExactPlainRecord } from '../plain-record-reads.js';
import {
  CANONICAL_ISO_PATTERN,
  PLAN_ID_PATTERN,
  PLAN_PROJECT_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
  PULL_REQUEST_LINK_CONFLICT_SCHEMA_VERSION,
  PULL_REQUEST_LINK_RECORD_VERSION,
  PULL_REQUEST_LINK_SOURCES,
} from '../lane-plan-records.js';
import type {
  PullRequestLinkConflictLane,
  PullRequestLinkConflictRecord,
  PullRequestLinkRecord,
  PullRequestLinkSource,
  PlanPullRequestRef,
} from '../lane-plan-records.js';
import { isPlanSecretShaped, planIdError, pullRequestRefError } from '../lane-plan-sidecar.js';

export type PullRequestLinkResult =
  | { readonly success: true; readonly value: PullRequestLink }
  | { readonly success: false; readonly error: Error; readonly code: 'invalid' };

const RECORD_KEYS: readonly string[] = [
  'version',
  'repository',
  'number',
  'projectId',
  'planId',
  'laneId',
  'source',
  'linkedAtIso',
];

export class PullRequestLink {
  private constructor(private readonly record: PullRequestLinkRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): PullRequestLinkResult {
    try {
      return PullRequestLink.createUnchecked(input);
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
  private static createUnchecked(input: unknown): PullRequestLinkResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('PullRequestLink requires a record');
    }
    const inputPrototype = Object.getPrototypeOf(input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return invalid('PullRequestLink requires a record');
    }
    const recordInput = readExactPlainRecord(input, RECORD_KEYS);
    if (recordInput === null) {
      return invalid('PullRequestLink must have exactly its record fields');
    }

    if (recordInput.version !== PULL_REQUEST_LINK_RECORD_VERSION) {
      return invalid('PullRequestLink version must be 1');
    }

    // The stored form keeps `repository` and `number` at the record's root;
    // WB1a's pair validator is reused on that pair.
    const refSnapshot = { repository: recordInput.repository, number: recordInput.number };
    const refError = pullRequestRefError('', refSnapshot);
    if (refError !== null) {
      return invalid(`PullRequestLink ${refError.replace(/^\./, '')}`);
    }
    const projectIdError = planIdError('projectId', recordInput.projectId, PLAN_PROJECT_ID_PATTERN, 'project id');
    if (projectIdError !== null) {
      return invalid(`PullRequestLink ${projectIdError}`);
    }
    if (recordInput.planId !== null) {
      const planIdCheck = planIdError('planId', recordInput.planId, PLAN_ID_PATTERN, 'plan id');
      if (planIdCheck !== null) {
        return invalid(`PullRequestLink ${planIdCheck}`);
      }
    }
    const laneIdError = planIdError('laneId', recordInput.laneId, PLANNED_LANE_ID_PATTERN, 'lane id');
    if (laneIdError !== null) {
      return invalid(`PullRequestLink ${laneIdError}`);
    }
    if (!PULL_REQUEST_LINK_SOURCES.includes(recordInput.source as PullRequestLinkSource)) {
      return invalid('PullRequestLink source must be one of fleet-forge-action, run, sidecar, cli');
    }
    if (
      typeof recordInput.linkedAtIso !== 'string' ||
      isPlanSecretShaped(recordInput.linkedAtIso) ||
      !CANONICAL_ISO_PATTERN.test(recordInput.linkedAtIso) ||
      new Date(recordInput.linkedAtIso).toISOString() !== recordInput.linkedAtIso
    ) {
      return invalid('PullRequestLink linkedAtIso must be a canonical UTC timestamp');
    }

    const record: PullRequestLinkRecord = Object.freeze({
      version: PULL_REQUEST_LINK_RECORD_VERSION,
      repository: recordInput.repository as string,
      number: recordInput.number as number,
      projectId: recordInput.projectId as string,
      planId: recordInput.planId as string | null,
      laneId: recordInput.laneId as string,
      source: recordInput.source as PullRequestLinkSource,
      linkedAtIso: recordInput.linkedAtIso as string,
    });
    return { success: true, value: new PullRequestLink(record) };
  }

  /** Fresh plain record. */
  toRecord(): PullRequestLinkRecord {
    return {
      version: this.record.version,
      repository: this.record.repository,
      number: this.record.number,
      projectId: this.record.projectId,
      planId: this.record.planId,
      laneId: this.record.laneId,
      source: this.record.source,
      linkedAtIso: this.record.linkedAtIso,
    };
  }

  /** `<repository>#<number>`: the store key of a pull request (one link per key). */
  getKey(): string {
    return pullRequestLinkKey({ repository: this.record.repository, number: this.record.number });
  }

  getRepository(): string {
    return this.record.repository;
  }

  getNumber(): number {
    return this.record.number;
  }

  getProjectId(): string {
    return this.record.projectId;
  }

  getPlanId(): string | null {
    return this.record.planId;
  }

  getLaneId(): string {
    return this.record.laneId;
  }

  getSource(): PullRequestLinkSource {
    return this.record.source;
  }

  getLinkedAtIso(): string {
    return this.record.linkedAtIso;
  }
}

/**
 * The ASCII lower-case of a repository string: GitHub owner and repository
 * names are ASCII, so only ASCII letters ever change case.
 */
function asciiLowerRepository(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Whether two repository strings name the same repository on the canonical key. */
function sameRepositoryKey(left: string, right: string): boolean {
  return asciiLowerRepository(left) === asciiLowerRepository(right);
}

/** `<repository>#<number>` on the canonical key: the store key of a pull request (one link per key), ASCII-lower-cased so a pre-WB5b3 mixed-case stored link is still found (WB5b3). */
export function pullRequestLinkKey(ref: PlanPullRequestRef): string {
  return `${asciiLowerRepository(ref.repository)}#${ref.number}`;
}

/**
 * What recording `incoming` does, given the stored link for the same key (or null):
 * 'create' when none is stored; 'no-op' when the stored link names the same PR and the same lane
 * (projectId, planId, laneId), whatever its source or time; otherwise 'pr-already-linked'.
 */
export function decidePullRequestLink(
  existing: PullRequestLinkRecord | null,
  incoming: PullRequestLinkRecord,
): 'create' | 'no-op' | 'pr-already-linked' {
  if (existing === null) {
    return 'create';
  }
  const sameLane =
    // The repository comparison is on the canonical key (WB5b3): a stored
    // mixed-case link and a lower-case sighting are the same pull request.
    sameRepositoryKey(existing.repository, incoming.repository) &&
    existing.number === incoming.number &&
    existing.projectId === incoming.projectId &&
    existing.planId === incoming.planId &&
    existing.laneId === incoming.laneId;
  return sameLane ? 'no-op' : 'pr-already-linked';
}

function invalid(message: string): PullRequestLinkResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

/** The upper bound of a pull-request number, shared with the merge record's bound. */
const MAX_CONFLICT_PULL_REQUEST_NUMBER = 999_999_999;

const CONFLICT_RECORD_KEYS: readonly string[] = [
  'schemaVersion',
  'repository',
  'number',
  'linkedLane',
  'refusedLane',
  'recordedAtIso',
];

const CONFLICT_LANE_KEYS: readonly string[] = ['projectId', 'planId', 'laneId'];

export type PullRequestLinkConflictRead =
  | { readonly success: true; readonly record: PullRequestLinkConflictRecord }
  | { readonly success: false; readonly message: string };

/**
 * Read one stored pull-request link conflict. Every field is read through its
 * own property descriptor, so no getter ever runs; a sparse array, a class
 * instance, an extra key, a malformed lane tuple or an impossible timestamp
 * is refused with a fixed message and never a throw.
 */
export function readPullRequestLinkConflictRecord(input: unknown): PullRequestLinkConflictRead {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { success: false, message: 'PullRequestLinkConflict requires a record' };
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return { success: false, message: 'PullRequestLinkConflict requires a plain record' };
    }
    const fields = readExactPlainRecord(input, CONFLICT_RECORD_KEYS);
    if (fields === null) {
      return { success: false, message: 'PullRequestLinkConflict must have exactly its record fields' };
    }
    // Absent schemaVersion reads as 1 (D6).
    if (fields.schemaVersion !== undefined && fields.schemaVersion !== PULL_REQUEST_LINK_CONFLICT_SCHEMA_VERSION) {
      return { success: false, message: 'PullRequestLinkConflict schemaVersion must be 1' };
    }
    const refSnapshot = { repository: fields.repository, number: fields.number };
    const refError = pullRequestRefError('', refSnapshot);
    if (refError !== null) {
      return { success: false, message: `PullRequestLinkConflict ${refError.replace(/^\./, '')}` };
    }
    if ((fields.number as number) > MAX_CONFLICT_PULL_REQUEST_NUMBER) {
      return { success: false, message: 'PullRequestLinkConflict number: must be a positive integer' };
    }
    const linkedLane = readConflictLane(fields.linkedLane);
    if (typeof linkedLane === 'string') {
      return { success: false, message: `PullRequestLinkConflict linkedLane${linkedLane}` };
    }
    const refusedLane = readConflictLane(fields.refusedLane);
    if (typeof refusedLane === 'string') {
      return { success: false, message: `PullRequestLinkConflict refusedLane${refusedLane}` };
    }
    if (
      linkedLane.projectId === refusedLane.projectId &&
      linkedLane.planId === refusedLane.planId &&
      linkedLane.laneId === refusedLane.laneId
    ) {
      return { success: false, message: 'PullRequestLinkConflict lanes must differ' };
    }
    const recordedAtIso = fields.recordedAtIso;
    if (
      typeof recordedAtIso !== 'string' ||
      isPlanSecretShaped(recordedAtIso) ||
      !CANONICAL_ISO_PATTERN.test(recordedAtIso) ||
      !isCalendarDateTime(recordedAtIso) ||
      new Date(recordedAtIso).toISOString() !== recordedAtIso
    ) {
      return { success: false, message: 'PullRequestLinkConflict recordedAtIso must be a canonical UTC timestamp' };
    }
    const record: PullRequestLinkConflictRecord = Object.freeze({
      schemaVersion: PULL_REQUEST_LINK_CONFLICT_SCHEMA_VERSION,
      repository: fields.repository as string,
      number: fields.number as number,
      linkedLane,
      refusedLane,
      recordedAtIso,
    });
    return { success: true, record };
  } catch {
    return { success: false, message: 'PullRequestLinkConflict input could not be read' };
  }
}

/** A valid lane tuple, or the message suffix naming why it was refused. */
function readConflictLane(value: unknown): PullRequestLinkConflictLane | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ': must be an object';
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return ': must be a plain object';
  }
  const fields = readExactPlainRecord(value, CONFLICT_LANE_KEYS);
  if (fields === null) {
    return ': must have exactly projectId, planId and laneId';
  }
  const projectIdError = planIdError('projectId', fields.projectId, PLAN_PROJECT_ID_PATTERN, 'project id');
  if (projectIdError !== null) {
    return `.${projectIdError}`;
  }
  if (fields.planId !== null) {
    const planIdCheck = planIdError('planId', fields.planId, PLAN_ID_PATTERN, 'plan id');
    if (planIdCheck !== null) {
      return `.${planIdCheck}`;
    }
  } else if (fields.planId === undefined) {
    return '.planId: must be a plan id or null';
  }
  const laneIdError = planIdError('laneId', fields.laneId, PLANNED_LANE_ID_PATTERN, 'lane id');
  if (laneIdError !== null) {
    return `.${laneIdError}`;
  }
  return Object.freeze({
    projectId: fields.projectId as string,
    planId: fields.planId as string | null,
    laneId: fields.laneId as string,
  });
}

/**
 * The deterministic store key of a link conflict, keyed on the repository,
 * the number and both lane tuples, so the same conflict is never recorded twice.
 */
export function pullRequestLinkConflictKey(record: PullRequestLinkConflictRecord): string {
  const lane = (lane: PullRequestLinkConflictLane): string =>
    `${lane.projectId}|${lane.planId ?? ''}|${lane.laneId}`;
  return [
    asciiLowerRepository(record.repository),
    String(record.number),
    lane(record.linkedLane),
    lane(record.refusedLane),
  ].join('#');
}

function unreadableInputResult(): PullRequestLinkResult {
  return {
    success: false,
    error: new Error('PullRequestLink input could not be read'),
    code: 'invalid',
  };
}

