// @generated entity stub — refined for lane WB1b.
/**
 * LanePlan is a plan's machine workbook as a stored, versioned aggregate
 * (work-board plan §3.2, §5): keyed (projectId, planId), carrying the plan's
 * revision, the import digest, its lanes as `PlannedLane` children with their
 * status and former ids as aliases (a dropped lane is kept, never deleted),
 * the plan's decisions and exclusive orders, and the import time. A planned
 * lane grants nothing and owns no path until it is registered as a work
 * order. Validation returns a result and never throws; hostile or
 * secret-shaped input is refused with a fixed message, never echoed.
 */

import {
  CANONICAL_ISO_PATTERN,
  LANE_PLAN_LIMITS,
  LANE_PLAN_RECORD_VERSION,
  PLAN_DECISION_ID_PATTERN,
  PLAN_DECISION_STATES,
  PLAN_ID_PATTERN,
  PLAN_PROJECT_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
  SHA256_HEX_PATTERN,
} from '../lane-plan-records.js';
import type {
  ExclusiveOrderSidecar,
  LanePlanRecord,
  LanePlanSidecar,
  PlannedLaneRecord,
  PlanDecisionSidecar,
  PlanDecisionState,
} from '../lane-plan-records.js';
import { planIdError, planPathError, planTextError } from '../lane-plan-sidecar.js';
import { PlannedLane } from './PlannedLane.js';

export type LanePlanResult =
  | { readonly success: true; readonly value: LanePlan }
  | { readonly success: false; readonly error: Error; readonly code: 'invalid' };

const RECORD_KEYS: readonly string[] = [
  'version',
  'projectId',
  'planId',
  'revision',
  'digest',
  'doc',
  'lanes',
  'decisions',
  'exclusiveOrder',
  'importedAtIso',
];

const DECISION_KEYS: readonly string[] = ['id', 'question', 'default', 'state'];
const EXCLUSIVE_KEYS: readonly string[] = ['file', 'lanes'];

export class LanePlan {
  private constructor(private readonly record: LanePlanRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): LanePlanResult {
    try {
      return LanePlan.createUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  /**
   * Builds a first import's stored record from WB1a's validated sidecar
   * (`renamedFrom` becomes the lane's one alias) and validates it, so every
   * rule of `create` also holds for a first import. Never throws.
   */
  static fromSidecar(
    sidecar: LanePlanSidecar,
    meta: { digest: string; importedAtIso: string },
  ): LanePlanResult {
    try {
      const record: LanePlanRecord = {
        version: LANE_PLAN_RECORD_VERSION,
        projectId: sidecar.projectId,
        planId: sidecar.planId,
        revision: sidecar.revision,
        digest: meta.digest,
        doc: sidecar.doc,
        lanes: sidecar.lanes.map((lane) => ({
          laneId: lane.laneId,
          aliases: lane.renamedFrom === null ? [] : [lane.renamedFrom],
          scope: lane.scope,
          packages: [...lane.packages],
          sharedFiles: [...lane.sharedFiles],
          tier: lane.tier,
          after: lane.after.map((ref) => ({
            projectId: ref.projectId,
            planId: ref.planId,
            laneId: ref.laneId,
          })),
          decisions: [...lane.decisions],
          status: lane.status,
          brief: lane.brief,
          mergedPr: lane.mergedPr === null
            ? null
            : { repository: lane.mergedPr.repository, number: lane.mergedPr.number },
        })),
        decisions: sidecar.decisions.map((decision) => ({
          id: decision.id,
          question: decision.question,
          default: decision.default,
          state: decision.state,
        })),
        exclusiveOrder: sidecar.exclusiveOrder.map((entry) => ({
          file: entry.file,
          lanes: [...entry.lanes],
        })),
        importedAtIso: meta.importedAtIso,
      };
      return LanePlan.create(record);
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
  private static createUnchecked(input: unknown): LanePlanResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('LanePlan requires a record');
    }
    const inputPrototype = Object.getPrototypeOf(input);
    if (inputPrototype !== Object.prototype && inputPrototype !== null) {
      return invalid('LanePlan requires a record');
    }
    const recordInput = readPlainRecord(input, RECORD_KEYS);
    if (recordInput === null) {
      return invalid('LanePlan must have exactly its record fields');
    }

    if (recordInput.version !== LANE_PLAN_RECORD_VERSION) {
      return invalid('LanePlan version must be 1');
    }
    const projectIdError = planIdError('projectId', recordInput.projectId, PLAN_PROJECT_ID_PATTERN, 'project id');
    if (projectIdError !== null) {
      return invalid(`LanePlan ${projectIdError}`);
    }
    const planIdCheck = planIdError('planId', recordInput.planId, PLAN_ID_PATTERN, 'plan id');
    if (planIdCheck !== null) {
      return invalid(`LanePlan ${planIdCheck}`);
    }
    if (!Number.isSafeInteger(recordInput.revision) || (recordInput.revision as number) < 1) {
      return invalid('LanePlan revision must be a positive integer');
    }
    const revision = recordInput.revision as number;
    if (typeof recordInput.digest !== 'string' || !SHA256_HEX_PATTERN.test(recordInput.digest)) {
      return invalid('LanePlan digest must be a sha256 hex digest');
    }
    const docError = planPathError('doc', recordInput.doc);
    if (docError !== null) {
      return invalid(`LanePlan ${docError}`);
    }

    const lanesRaw = plainArrayCopy(recordInput.lanes);
    if (!Array.isArray(lanesRaw)) {
      return invalid('LanePlan lanes: must be a list');
    }
    if (lanesRaw.length === 0) {
      return invalid('LanePlan lanes: must not be empty');
    }
    if (lanesRaw.length > LANE_PLAN_LIMITS.lanes) {
      return invalid('LanePlan lanes: has too many entries');
    }
    const lanes: PlannedLane[] = [];
    for (let index = 0; index < lanesRaw.length; index += 1) {
      const laneResult = PlannedLane.create(lanesRaw[index], `lanes[${index}]`);
      if (!laneResult.success) {
        return { success: false, error: laneResult.error, code: 'invalid' };
      }
      lanes.push(laneResult.value);
    }

    const decisions = readDecisions(recordInput.decisions);
    if (typeof decisions === 'string') {
      return invalid(decisions);
    }
    const exclusiveOrder = readExclusiveOrders(recordInput.exclusiveOrder);
    if (typeof exclusiveOrder === 'string') {
      return invalid(exclusiveOrder);
    }

    if (
      typeof recordInput.importedAtIso !== 'string' ||
      !CANONICAL_ISO_PATTERN.test(recordInput.importedAtIso) ||
      new Date(recordInput.importedAtIso).toISOString() !== recordInput.importedAtIso
    ) {
      return invalid('LanePlan importedAtIso must be a canonical UTC timestamp');
    }
    const importedAtIso = recordInput.importedAtIso;

    const crossError = crossReferenceError(
      recordInput.projectId as string,
      recordInput.planId as string,
      lanes,
      decisions,
      exclusiveOrder,
    );
    if (crossError !== null) {
      return invalid(crossError);
    }

    const record: LanePlanRecord = Object.freeze({
      version: LANE_PLAN_RECORD_VERSION,
      projectId: recordInput.projectId as string,
      planId: recordInput.planId as string,
      revision,
      digest: recordInput.digest as string,
      doc: recordInput.doc as string,
      lanes: Object.freeze(lanes.map((lane) => {
        const laneRecord = lane.toRecord();
        deepFreezeValue(laneRecord);
        return laneRecord;
      })),
      decisions: Object.freeze(decisions),
      exclusiveOrder: Object.freeze(exclusiveOrder),
      importedAtIso,
    });
    return { success: true, value: new LanePlan(record) };
  }

  /** Fresh plain record; nested objects and lists are fresh copies. */
  toRecord(): LanePlanRecord {
    return {
      version: this.record.version,
      projectId: this.record.projectId,
      planId: this.record.planId,
      revision: this.record.revision,
      digest: this.record.digest,
      doc: this.record.doc,
      lanes: this.record.lanes.map((lane) => ({
        laneId: lane.laneId,
        aliases: [...lane.aliases],
        scope: lane.scope,
        packages: [...lane.packages],
        sharedFiles: [...lane.sharedFiles],
        tier: lane.tier,
        after: lane.after.map((ref) => ({
          projectId: ref.projectId,
          planId: ref.planId,
          laneId: ref.laneId,
        })),
        decisions: [...lane.decisions],
        status: lane.status,
        brief: lane.brief,
        mergedPr: lane.mergedPr === null
          ? null
          : { repository: lane.mergedPr.repository, number: lane.mergedPr.number },
      })),
      decisions: this.record.decisions.map((decision) => ({
        id: decision.id,
        question: decision.question,
        default: decision.default,
        state: decision.state,
      })),
      exclusiveOrder: this.record.exclusiveOrder.map((entry) => ({
        file: entry.file,
        lanes: [...entry.lanes],
      })),
      importedAtIso: this.record.importedAtIso,
    };
  }

  getProjectId(): string {
    return this.record.projectId;
  }

  getPlanId(): string {
    return this.record.planId;
  }

  getRevision(): number {
    return this.record.revision;
  }

  getDigest(): string {
    return this.record.digest;
  }

  /** The lane with this current id or alias, or null; a fresh copy. */
  findLane(id: string): PlannedLaneRecord | null {
    const lane = this.record.lanes.find((candidate) => candidate.laneId === id || candidate.aliases.includes(id));
    if (lane === undefined) {
      return null;
    }
    return {
      laneId: lane.laneId,
      aliases: [...lane.aliases],
      scope: lane.scope,
      packages: [...lane.packages],
      sharedFiles: [...lane.sharedFiles],
      tier: lane.tier,
      after: lane.after.map((ref) => ({
        projectId: ref.projectId,
        planId: ref.planId,
        laneId: ref.laneId,
      })),
      decisions: [...lane.decisions],
      status: lane.status,
      brief: lane.brief,
      mergedPr: lane.mergedPr === null
        ? null
        : { repository: lane.mergedPr.repository, number: lane.mergedPr.number },
    };
  }

  /** The current lane id for an id or alias, or null. */
  resolveLaneId(id: string): string | null {
    const lane = this.record.lanes.find((candidate) => candidate.laneId === id || candidate.aliases.includes(id));
    return lane === undefined ? null : lane.laneId;
  }
}

function invalid(message: string): LanePlanResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

function unreadableInputResult(): LanePlanResult {
  return { success: false, error: new Error('LanePlan input could not be read'), code: 'invalid' };
}

function deepFreezeValue(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeValue(item);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    deepFreezeValue((value as Record<string, unknown>)[key]);
  }
}

function readDecisions(value: unknown): PlanDecisionSidecar[] | string {
  const list = plainArrayCopy(value);
  if (!Array.isArray(list)) {
    return 'LanePlan decisions: must be a list';
  }
  if (list.length > LANE_PLAN_LIMITS.decisions) {
    return 'LanePlan decisions: has too many entries';
  }
  const decisions: PlanDecisionSidecar[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const base = `decisions[${index}]`;
    const snapshot = readPlainRecord(list[index], DECISION_KEYS);
    if (snapshot === null) {
      return `LanePlan ${base}: must be a decision record`;
    }
    const idError = planIdError(`${base}.id`, snapshot.id, PLAN_DECISION_ID_PATTERN, 'decision id');
    if (idError !== null) {
      return `LanePlan ${idError}`;
    }
    const questionError = planTextError(`${base}.question`, snapshot.question, LANE_PLAN_LIMITS.questionBytes);
    if (questionError !== null) {
      return `LanePlan ${questionError}`;
    }
    const defaultError = planTextError(`${base}.default`, snapshot.default, LANE_PLAN_LIMITS.defaultBytes);
    if (defaultError !== null) {
      return `LanePlan ${defaultError}`;
    }
    if (!PLAN_DECISION_STATES.includes(snapshot.state as PlanDecisionState)) {
      return `LanePlan ${base}.state: must be one of open, decided`;
    }
    decisions.push({
      id: snapshot.id as string,
      question: snapshot.question as string,
      default: snapshot.default as string,
      state: snapshot.state as PlanDecisionState,
    });
  }
  return decisions;
}

function readExclusiveOrders(value: unknown): ExclusiveOrderSidecar[] | string {
  const list = plainArrayCopy(value);
  if (!Array.isArray(list)) {
    return 'LanePlan exclusiveOrder: must be a list';
  }
  if (list.length > LANE_PLAN_LIMITS.exclusiveOrders) {
    return 'LanePlan exclusiveOrder: has too many entries';
  }
  const entries: ExclusiveOrderSidecar[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const base = `exclusiveOrder[${index}]`;
    const snapshot = readPlainRecord(list[index], EXCLUSIVE_KEYS);
    if (snapshot === null) {
      return `LanePlan ${base}: must be an exclusive order record`;
    }
    const fileError = planPathError(`${base}.file`, snapshot.file);
    if (fileError !== null) {
      return `LanePlan ${fileError}`;
    }
    const lanesRaw = plainArrayCopy(snapshot.lanes);
    if (!Array.isArray(lanesRaw)) {
      return `LanePlan ${base}.lanes: must be a list`;
    }
    if (lanesRaw.length < 2) {
      return `LanePlan ${base}.lanes: must name at least two lanes`;
    }
    if (lanesRaw.length > LANE_PLAN_LIMITS.exclusiveOrderLanes) {
      return `LanePlan ${base}.lanes: has too many entries`;
    }
    const lanes: string[] = [];
    const seen = new Set<string>();
    for (let laneIndex = 0; laneIndex < lanesRaw.length; laneIndex += 1) {
      const idError = planIdError(
        `${base}.lanes[${laneIndex}]`,
        lanesRaw[laneIndex],
        PLANNED_LANE_ID_PATTERN,
        'lane id',
      );
      if (idError !== null) {
        return `LanePlan ${idError}`;
      }
      const item = lanesRaw[laneIndex] as string;
      if (seen.has(item)) {
        return `LanePlan ${base}.lanes[${laneIndex}]: is a duplicate`;
      }
      seen.add(item);
      lanes.push(item);
    }
    entries.push({ file: snapshot.file as string, lanes });
  }
  return entries;
}

/**
 * The plan-wide cross-references: unique lane ids and aliases, same-plan
 * `after` references naming a current lane (an alias does not count; dropped
 * lanes do), lane decisions naming plan decisions, exclusive orders naming
 * current lanes and distinct files, and one merged PR per lane at most.
 */
function crossReferenceError(
  projectId: string,
  planId: string,
  lanes: PlannedLane[],
  decisions: PlanDecisionSidecar[],
  exclusiveOrder: ExclusiveOrderSidecar[],
): string | null {
  const laneIds = new Set<string>();
  for (let index = 0; index < lanes.length; index += 1) {
    const laneId = lanes[index].getLaneId();
    if (laneIds.has(laneId)) {
      return `LanePlan lanes[${index}].laneId: is a duplicate`;
    }
    laneIds.add(laneId);
  }
  const seenAlias = new Set<string>();
  for (let index = 0; index < lanes.length; index += 1) {
    const aliases = lanes[index].getAliases();
    for (let aliasIndex = 0; aliasIndex < aliases.length; aliasIndex += 1) {
      const alias = aliases[aliasIndex];
      if (laneIds.has(alias) || seenAlias.has(alias)) {
        return `LanePlan lanes[${index}].aliases[${aliasIndex}]: is a duplicate`;
      }
      seenAlias.add(alias);
    }
  }
  const decisionIds = new Set<string>();
  for (let index = 0; index < decisions.length; index += 1) {
    const id = decisions[index].id;
    if (decisionIds.has(id)) {
      return `LanePlan decisions[${index}].id: is a duplicate`;
    }
    decisionIds.add(id);
  }
  const seenMergedPr = new Set<string>();
  const laneRecords = lanes.map((lane) => lane.toRecord());
  for (let index = 0; index < laneRecords.length; index += 1) {
    const lane = laneRecords[index];
    for (let afterIndex = 0; afterIndex < lane.after.length; afterIndex += 1) {
      const ref = lane.after[afterIndex];
      if (ref.projectId === projectId && ref.planId === planId) {
        if (ref.laneId === lane.laneId) {
          return `LanePlan lanes[${index}].after[${afterIndex}]: names its own lane`;
        }
        if (!laneIds.has(ref.laneId)) {
          return `LanePlan lanes[${index}].after[${afterIndex}]: names no lane in this plan`;
        }
      }
    }
    for (let decisionIndex = 0; decisionIndex < lane.decisions.length; decisionIndex += 1) {
      if (!decisionIds.has(lane.decisions[decisionIndex])) {
        return `LanePlan lanes[${index}].decisions[${decisionIndex}]: names no decision in this plan`;
      }
    }
    if (lane.mergedPr !== null) {
      const key = `${lane.mergedPr.repository}|${lane.mergedPr.number}`;
      if (seenMergedPr.has(key)) {
        return `LanePlan lanes[${index}].mergedPr: is a duplicate`;
      }
      seenMergedPr.add(key);
    }
  }
  const seenFile = new Set<string>();
  for (let index = 0; index < exclusiveOrder.length; index += 1) {
    const entry = exclusiveOrder[index];
    if (seenFile.has(entry.file)) {
      return `LanePlan exclusiveOrder[${index}].file: is a duplicate`;
    }
    seenFile.add(entry.file);
    for (let laneIndex = 0; laneIndex < entry.lanes.length; laneIndex += 1) {
      if (!laneIds.has(entry.lanes[laneIndex])) {
        return `LanePlan exclusiveOrder[${index}].lanes[${laneIndex}]: names no lane in this plan`;
      }
    }
  }
  return null;
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
