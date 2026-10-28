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

import {
  CANONICAL_ISO_PATTERN,
  PLAN_ID_PATTERN,
  PLAN_PROJECT_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
  PULL_REQUEST_LINK_RECORD_VERSION,
  PULL_REQUEST_LINK_SOURCES,
} from '../lane-plan-records.js';
import type {
  PullRequestLinkRecord,
  PullRequestLinkSource,
  PullRequestRef,
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
    const recordInput = readPlainRecord(input, RECORD_KEYS);
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

/** `<repository>#<number>`: the store key of a pull request (one link per key). */
export function pullRequestLinkKey(ref: PullRequestRef): string {
  return `${ref.repository}#${ref.number}`;
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
    existing.repository === incoming.repository &&
    existing.number === incoming.number &&
    existing.projectId === incoming.projectId &&
    existing.planId === incoming.planId &&
    existing.laneId === incoming.laneId;
  return sameLane ? 'no-op' : 'pr-already-linked';
}

function invalid(message: string): PullRequestLinkResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

function unreadableInputResult(): PullRequestLinkResult {
  return {
    success: false,
    error: new Error('PullRequestLink input could not be read'),
    code: 'invalid',
  };
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
