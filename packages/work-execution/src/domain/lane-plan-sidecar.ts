/**
 * The plan sidecar: a `<plan>.workbook.json` file parsed into a typed, normalized
 * `LanePlanSidecar` or path-named errors. Everything here is pure: no filesystem,
 * no clock, no hashing (WB4a hashes the canonical JSON in infrastructure).
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import {
  LANE_PLAN_LIMITS,
  LANE_PLAN_SIDECAR_SCHEMA_VERSION,
  PLAN_DECISION_ID_PATTERN,
  PLAN_DECISION_STATES,
  PLAN_ID_PATTERN,
  PLAN_PACKAGE_PATTERN,
  PLAN_PROJECT_ID_PATTERN,
  PLANNED_LANE_ID_PATTERN,
  PLANNED_LANE_STATUSES,
  PLANNED_LANE_TIERS,
} from './lane-plan-records.js';
import type {
  ExclusiveOrderSidecar,
  LanePlanSidecar,
  PlannedLaneRef,
  PlannedLaneSidecar,
  PlannedLaneStatus,
  PlannedLaneTier,
  PlanDecisionSidecar,
  PlanDecisionState,
  PullRequestRef,
} from './lane-plan-records.js';

export type LanePlanSidecarResult =
  | { readonly ok: true; readonly sidecar: LanePlanSidecar }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validate the JSON.parse result of a sidecar file. Never throws; errors name paths, never values. */
export function parseLanePlanSidecar(input: unknown): LanePlanSidecarResult {
  try {
    return parseLanePlanSidecarUnchecked(input);
  } catch {
    return { ok: false, errors: ['sidecar: input could not be read'] };
  }
}

/** The bytes WB4a hashes: fixed key order, defaults filled, list order kept, no whitespace. */
export function canonicalLanePlanSidecarJson(sidecar: LanePlanSidecar): string {
  return JSON.stringify({
    schemaVersion: sidecar.schemaVersion,
    projectId: sidecar.projectId,
    planId: sidecar.planId,
    revision: sidecar.revision,
    doc: sidecar.doc,
    lanes: sidecar.lanes.map((lane) => ({
      laneId: lane.laneId,
      renamedFrom: lane.renamedFrom,
      scope: lane.scope,
      packages: lane.packages,
      sharedFiles: lane.sharedFiles,
      tier: lane.tier,
      after: lane.after.map((ref) => ({
        projectId: ref.projectId,
        planId: ref.planId,
        laneId: ref.laneId,
      })),
      decisions: lane.decisions,
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
      lanes: entry.lanes,
    })),
  });
}

/** True when a string matches containsSecretShape or any LANE_DIFF_SECRET_PATTERNS regex. */
export function isPlanSecretShaped(text: string): boolean {
  if (containsSecretShape(text)) {
    return true;
  }
  for (const pattern of LANE_DIFF_SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      return true;
    }
  }
  return false;
}

/** Field checks reused by WB1b; each returns `<path>: <reason>` or null. */
export function planTextError(path: string, value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') {
    return `${path}: must be a string`;
  }
  if (isPlanSecretShaped(value)) {
    return `${path}: contains a secret-shaped value and was refused`;
  }
  if (value.trim().length === 0 || utf8Bytes(value) > maxBytes) {
    return `${path}: must be plain text of at most ${maxBytes} bytes`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint !== undefined && isForbiddenTextCodePoint(codePoint)) {
      return `${path}: must be plain text of at most ${maxBytes} bytes`;
    }
  }
  return null;
}

export function planPathError(path: string, value: unknown): string | null {
  const textError = planTextError(path, value, LANE_PLAN_LIMITS.pathBytes);
  if (textError !== null) {
    return textError;
  }
  const text = value as string;
  if (text.includes('\\') || /\s/.test(text)) {
    return `${path}: must be a relative path`;
  }
  if (text.startsWith('/')) {
    return `${path}: must be a relative path`;
  }
  for (const segment of text.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return `${path}: must be a relative path`;
    }
  }
  return null;
}

export function planIdError(path: string, value: unknown, pattern: RegExp, idWord: string): string | null {
  if (typeof value !== 'string') {
    return `${path}: must be a string`;
  }
  if (isPlanSecretShaped(value)) {
    return `${path}: contains a secret-shaped value and was refused`;
  }
  if (!pattern.test(value)) {
    return `${path}: must be a ${idWord}`;
  }
  return null;
}

export function pullRequestRefError(path: string, value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${path}: must be an object`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return `${path}: must be an object`;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    typeof keys[0] !== 'string' ||
    typeof keys[1] !== 'string' ||
    !keys.includes('repository') ||
    !keys.includes('number')
  ) {
    return `${path}: must be an object`;
  }
  const record = value as Record<string, unknown>;
  const repositoryError = pullRequestRepositoryError(`${path}.repository`, record.repository);
  if (repositoryError !== null) {
    return repositoryError;
  }
  const number = record.number;
  if (!Number.isSafeInteger(number) || (number as number) < 1) {
    return `${path}.number: must be a positive integer`;
  }
  return null;
}

const ROOT_REQUIRED_KEYS = ['schemaVersion', 'projectId', 'planId', 'revision', 'doc', 'lanes'];
const ROOT_OPTIONAL_KEYS = ['decisions', 'exclusiveOrder'];
const LANE_REQUIRED_KEYS = ['laneId', 'scope', 'packages', 'tier', 'after'];
const LANE_OPTIONAL_KEYS = ['renamedFrom', 'sharedFiles', 'decisions', 'status', 'brief', 'mergedPr'];
const DECISION_REQUIRED_KEYS = ['id', 'question', 'default', 'state'];
const EXCLUSIVE_REQUIRED_KEYS = ['file', 'lanes'];

function parseLanePlanSidecarUnchecked(input: unknown): LanePlanSidecarResult {
  const errors: string[] = [];
  const root = readSidecarObject(input, ROOT_REQUIRED_KEYS, ROOT_OPTIONAL_KEYS, 'sidecar', errors);
  if (root === null) {
    return cappedErrors(errors);
  }
  if (hasOwn(root, 'schemaVersion') && root.schemaVersion !== LANE_PLAN_SIDECAR_SCHEMA_VERSION) {
    errors.push('sidecar.schemaVersion: must be 1');
  }
  if (hasOwn(root, 'projectId')) {
    pushIdError(errors, 'sidecar.projectId', root.projectId, PLAN_PROJECT_ID_PATTERN, 'project id');
  }
  if (hasOwn(root, 'planId')) {
    pushIdError(errors, 'sidecar.planId', root.planId, PLAN_ID_PATTERN, 'plan id');
  }
  if (hasOwn(root, 'revision') && (!Number.isSafeInteger(root.revision) || (root.revision as number) < 1)) {
    errors.push('sidecar.revision: must be a positive integer');
  }
  if (hasOwn(root, 'doc')) {
    pushPathError(errors, 'sidecar.doc', root.doc);
  }
  if (hasOwn(root, 'lanes')) {
    checkRootLanes(root, errors);
  }
  if (hasOwn(root, 'decisions')) {
    checkRootDecisions(root, errors);
  }
  if (hasOwn(root, 'exclusiveOrder')) {
    checkRootExclusiveOrder(root, errors);
  }
  if (errors.length > 0) {
    return cappedErrors(errors);
  }
  checkCrossReferences(root, errors);
  if (errors.length > 0) {
    return cappedErrors(errors);
  }
  return { ok: true, sidecar: buildNormalizedSidecar(root) };
}

function checkRootLanes(root: Record<string, unknown>, errors: string[]): void {
  const list = plainArrayCopy(root.lanes);
  if (!Array.isArray(list)) {
    errors.push('sidecar.lanes: must be a list');
    return;
  }
  if (list.length === 0) {
    errors.push('sidecar.lanes: must not be empty');
    return;
  }
  if (list.length > LANE_PLAN_LIMITS.lanes) {
    errors.push('sidecar.lanes: has too many entries');
    return;
  }
  const projectId = root.projectId as string;
  const planId = root.planId as string;
  for (let index = 0; index < list.length; index += 1) {
    const lane = readSidecarObject(list[index], LANE_REQUIRED_KEYS, LANE_OPTIONAL_KEYS, `lanes[${index}]`, errors);
    if (lane !== null) {
      checkLaneShape(index, lane, projectId, planId, errors);
    }
  }
}

function checkRootDecisions(root: Record<string, unknown>, errors: string[]): void {
  const list = plainArrayCopy(root.decisions);
  if (!Array.isArray(list)) {
    errors.push('sidecar.decisions: must be a list');
    return;
  }
  if (list.length > LANE_PLAN_LIMITS.decisions) {
    errors.push('sidecar.decisions: has too many entries');
    return;
  }
  for (let index = 0; index < list.length; index += 1) {
    const decision = readSidecarObject(list[index], DECISION_REQUIRED_KEYS, [], `decisions[${index}]`, errors);
    if (decision !== null) {
      checkDecision(index, decision, errors);
    }
  }
}

function checkRootExclusiveOrder(root: Record<string, unknown>, errors: string[]): void {
  const list = plainArrayCopy(root.exclusiveOrder);
  if (!Array.isArray(list)) {
    errors.push('sidecar.exclusiveOrder: must be a list');
    return;
  }
  if (list.length > LANE_PLAN_LIMITS.exclusiveOrders) {
    errors.push('sidecar.exclusiveOrder: has too many entries');
    return;
  }
  for (let index = 0; index < list.length; index += 1) {
    const entry = readSidecarObject(list[index], EXCLUSIVE_REQUIRED_KEYS, [], `exclusiveOrder[${index}]`, errors);
    if (entry !== null) {
      checkExclusiveOrderEntry(index, entry, errors);
    }
  }
}

/**
 * Reads an object through its own property descriptors so no getter ever runs.
 * Returns a snapshot of the own enumerable string keys that are in `required` or
 * `optional`, pushes `<path>: unknown key` once per other own key, and pushes
 * `<path>.<field>: required` for each missing required key in `required` order.
 */
function readSidecarObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  errors: string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  const allowed = new Set<string>(required);
  for (const key of optional) {
    allowed.add(key);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && allowed.has(key)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && descriptor.enumerable) {
        snapshot[key] = descriptor.value;
        continue;
      }
    }
    errors.push(`${path}: unknown key`);
  }
  for (const key of required) {
    if (!hasOwn(snapshot, key)) {
      errors.push(`${path}.${key}: required`);
    }
  }
  return snapshot;
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

function checkLaneShape(
  laneIndex: number,
  lane: Record<string, unknown>,
  projectId: string,
  planId: string,
  errors: string[],
): void {
  const base = `lanes[${laneIndex}]`;
  if (hasOwn(lane, 'laneId')) {
    pushIdError(errors, `${base}.laneId`, lane.laneId, PLANNED_LANE_ID_PATTERN, 'lane id');
  }
  if (hasOwn(lane, 'renamedFrom') && lane.renamedFrom !== null) {
    pushIdError(errors, `${base}.renamedFrom`, lane.renamedFrom, PLANNED_LANE_ID_PATTERN, 'lane id');
  }
  if (hasOwn(lane, 'scope')) {
    pushTextError(errors, `${base}.scope`, lane.scope, LANE_PLAN_LIMITS.scopeBytes);
  }
  if (hasOwn(lane, 'packages')) {
    checkLanePackages(base, lane.packages, errors);
  }
  if (hasOwn(lane, 'sharedFiles')) {
    checkLaneSharedFiles(base, lane.sharedFiles, errors);
  }
  if (hasOwn(lane, 'tier') && !PLANNED_LANE_TIERS.includes(lane.tier as PlannedLaneTier)) {
    errors.push(`${base}.tier: must be 0, 1 or 2`);
  }
  if (hasOwn(lane, 'after')) {
    checkLaneAfter(base, lane.after, projectId, planId, errors);
  }
  if (hasOwn(lane, 'decisions')) {
    checkLaneDecisions(base, lane.decisions, errors);
  }
  if (hasOwn(lane, 'status') && !PLANNED_LANE_STATUSES.includes(lane.status as PlannedLaneStatus)) {
    errors.push(`${base}.status: must be one of planned, deferred, dropped`);
  }
  if (hasOwn(lane, 'brief') && lane.brief !== null) {
    pushPathError(errors, `${base}.brief`, lane.brief);
  }
  if (hasOwn(lane, 'mergedPr') && lane.mergedPr !== null) {
    checkMergedPr(base, lane.mergedPr, errors);
  }
}

function checkLanePackages(base: string, value: unknown, errors: string[]): void {
  const list = plainArrayCopy(value);
  if (!Array.isArray(list)) {
    errors.push(`${base}.packages: must be a list`);
    return;
  }
  if (list.length === 0) {
    errors.push(`${base}.packages: must not be empty`);
    return;
  }
  if (list.length > LANE_PLAN_LIMITS.packages) {
    errors.push(`${base}.packages: has too many entries`);
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const idError = planIdError(`${base}.packages[${index}]`, list[index], PLAN_PACKAGE_PATTERN, 'package name');
    if (idError !== null) {
      errors.push(idError);
      continue;
    }
    const item = list[index] as string;
    if (seen.has(item)) {
      errors.push(`${base}.packages[${index}]: is a duplicate`);
    } else {
      seen.add(item);
    }
  }
}

function checkLaneSharedFiles(base: string, value: unknown, errors: string[]): void {
  const list = plainArrayCopy(value);
  if (!Array.isArray(list)) {
    errors.push(`${base}.sharedFiles: must be a list`);
    return;
  }
  if (list.length > LANE_PLAN_LIMITS.sharedFiles) {
    errors.push(`${base}.sharedFiles: has too many entries`);
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const pathError = planPathError(`${base}.sharedFiles[${index}]`, list[index]);
    if (pathError !== null) {
      errors.push(pathError);
      continue;
    }
    const item = list[index] as string;
    if (seen.has(item)) {
      errors.push(`${base}.sharedFiles[${index}]: is a duplicate`);
    } else {
      seen.add(item);
    }
  }
}

function checkLaneAfter(
  base: string,
  value: unknown,
  projectId: string,
  planId: string,
  errors: string[],
): void {
  const list = plainArrayCopy(value);
  if (!Array.isArray(list)) {
    errors.push(`${base}.after: must be a list`);
    return;
  }
  if (list.length > LANE_PLAN_LIMITS.after) {
    errors.push(`${base}.after: has too many entries`);
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (typeof item !== 'string') {
      errors.push(`${base}.after[${index}]: must be a string`);
      continue;
    }
    if (isPlanSecretShaped(item)) {
      errors.push(`${base}.after[${index}]: contains a secret-shaped value and was refused`);
      continue;
    }
    const ref = resolveAfterReference(item, projectId, planId);
    if (ref === null) {
      errors.push(`${base}.after[${index}]: must be <laneId>, <planId>/<laneId> or <projectId>/<planId>/<laneId>`);
      continue;
    }
    const key = `${ref.projectId}/${ref.planId}/${ref.laneId}`;
    if (seen.has(key)) {
      errors.push(`${base}.after[${index}]: is a duplicate`);
    } else {
      seen.add(key);
    }
  }
}

function checkLaneDecisions(base: string, value: unknown, errors: string[]): void {
  const list = plainArrayCopy(value);
  if (!Array.isArray(list)) {
    errors.push(`${base}.decisions: must be a list`);
    return;
  }
  if (list.length > LANE_PLAN_LIMITS.laneDecisions) {
    errors.push(`${base}.decisions: has too many entries`);
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    const idError = planIdError(`${base}.decisions[${index}]`, list[index], PLAN_DECISION_ID_PATTERN, 'decision id');
    if (idError !== null) {
      errors.push(idError);
      continue;
    }
    const item = list[index] as string;
    if (seen.has(item)) {
      errors.push(`${base}.decisions[${index}]: is a duplicate`);
    } else {
      seen.add(item);
    }
  }
}

function checkMergedPr(base: string, value: unknown, errors: string[]): void {
  const prPath = `${base}.mergedPr`;
  const snapshot = readSidecarObject(value, ['repository', 'number'], [], prPath, errors);
  if (snapshot === null) {
    return;
  }
  if (hasOwn(snapshot, 'repository')) {
    const repositoryError = pullRequestRepositoryError(`${prPath}.repository`, snapshot.repository);
    if (repositoryError !== null) {
      errors.push(repositoryError);
    }
  }
  if (hasOwn(snapshot, 'number') && (!Number.isSafeInteger(snapshot.number) || (snapshot.number as number) < 1)) {
    errors.push(`${prPath}.number: must be a positive integer`);
  }
}

function checkDecision(decisionIndex: number, decision: Record<string, unknown>, errors: string[]): void {
  const base = `decisions[${decisionIndex}]`;
  if (hasOwn(decision, 'id')) {
    pushIdError(errors, `${base}.id`, decision.id, PLAN_DECISION_ID_PATTERN, 'decision id');
  }
  if (hasOwn(decision, 'question')) {
    pushTextError(errors, `${base}.question`, decision.question, LANE_PLAN_LIMITS.questionBytes);
  }
  if (hasOwn(decision, 'default')) {
    pushTextError(errors, `${base}.default`, decision.default, LANE_PLAN_LIMITS.defaultBytes);
  }
  if (hasOwn(decision, 'state') && !PLAN_DECISION_STATES.includes(decision.state as PlanDecisionState)) {
    errors.push(`${base}.state: must be one of open, decided`);
  }
}

function checkExclusiveOrderEntry(entryIndex: number, entry: Record<string, unknown>, errors: string[]): void {
  const base = `exclusiveOrder[${entryIndex}]`;
  if (hasOwn(entry, 'file')) {
    pushPathError(errors, `${base}.file`, entry.file);
  }
  if (hasOwn(entry, 'lanes')) {
    const list = plainArrayCopy(entry.lanes);
    if (!Array.isArray(list)) {
      errors.push(`${base}.lanes: must be a list`);
      return;
    }
    if (list.length < 2) {
      errors.push(`${base}.lanes: must name at least two lanes`);
      return;
    }
    if (list.length > LANE_PLAN_LIMITS.exclusiveOrderLanes) {
      errors.push(`${base}.lanes: has too many entries`);
      return;
    }
    const seen = new Set<string>();
    for (let index = 0; index < list.length; index += 1) {
      const idError = planIdError(`${base}.lanes[${index}]`, list[index], PLANNED_LANE_ID_PATTERN, 'lane id');
      if (idError !== null) {
        errors.push(idError);
        continue;
      }
      const item = list[index] as string;
      if (seen.has(item)) {
        errors.push(`${base}.lanes[${index}]: is a duplicate`);
      } else {
        seen.add(item);
      }
    }
  }
}

function checkCrossReferences(root: Record<string, unknown>, errors: string[]): void {
  const projectId = root.projectId as string;
  const planId = root.planId as string;
  const lanes = plainArrayCopy(root.lanes) as unknown[];
  const laneById = new Map<string, number>();
  const seenRenamedFrom = new Map<string, number>();
  const seenMergedPr = new Map<string, number>();
  for (let index = 0; index < lanes.length; index += 1) {
    const lane = lanes[index] as Record<string, unknown>;
    const laneId = lane.laneId as string;
    if (laneById.has(laneId)) {
      errors.push(`lanes[${index}].laneId: is a duplicate`);
    } else {
      laneById.set(laneId, index);
    }
  }
  const decisionIds = collectDecisionIds(root);
  for (let index = 0; index < lanes.length; index += 1) {
    const lane = lanes[index] as Record<string, unknown>;
    const laneId = lane.laneId as string;
    if (hasOwn(lane, 'renamedFrom') && lane.renamedFrom !== null) {
      const renamedFrom = lane.renamedFrom as string;
      if (renamedFrom === laneId) {
        errors.push(`lanes[${index}].renamedFrom: names its own lane`);
      } else if (laneById.has(renamedFrom)) {
        errors.push(`lanes[${index}].renamedFrom: names a current lane`);
      } else if (seenRenamedFrom.has(renamedFrom)) {
        errors.push(`lanes[${index}].renamedFrom: is a duplicate`);
      } else {
        seenRenamedFrom.set(renamedFrom, index);
      }
    }
    if (hasOwn(lane, 'after')) {
      const afterList = plainArrayCopy(lane.after) as unknown[];
      for (let afterIndex = 0; afterIndex < afterList.length; afterIndex += 1) {
        const ref = resolveAfterReference(afterList[afterIndex] as string, projectId, planId);
        if (ref === null) {
          continue;
        }
        if (ref.projectId === projectId && ref.planId === planId) {
          if (ref.laneId === laneId) {
            errors.push(`lanes[${index}].after[${afterIndex}]: names its own lane`);
          } else if (!laneById.has(ref.laneId)) {
            errors.push(`lanes[${index}].after[${afterIndex}]: names no lane in this plan`);
          }
        }
      }
    }
    if (hasOwn(lane, 'decisions')) {
      const decisions = plainArrayCopy(lane.decisions) as unknown[];
      for (let decisionIndex = 0; decisionIndex < decisions.length; decisionIndex += 1) {
        if (!decisionIds.has(decisions[decisionIndex] as string)) {
          errors.push(`lanes[${index}].decisions[${decisionIndex}]: names no decision in this plan`);
        }
      }
    }
    if (hasOwn(lane, 'mergedPr') && lane.mergedPr !== null) {
      const pr = lane.mergedPr as Record<string, unknown>;
      const key = `${pr.repository as string}|${pr.number as number}`;
      if (seenMergedPr.has(key)) {
        errors.push(`lanes[${index}].mergedPr: is a duplicate`);
      } else {
        seenMergedPr.set(key, index);
      }
    }
  }
  if (hasOwn(root, 'decisions')) {
    const decisions = plainArrayCopy(root.decisions) as unknown[];
    const seen = new Set<string>();
    for (let index = 0; index < decisions.length; index += 1) {
      const id = (decisions[index] as Record<string, unknown>).id as string;
      if (seen.has(id)) {
        errors.push(`decisions[${index}].id: is a duplicate`);
      } else {
        seen.add(id);
      }
    }
  }
  if (hasOwn(root, 'exclusiveOrder')) {
    const entries = plainArrayCopy(root.exclusiveOrder) as unknown[];
    const seenFiles = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as Record<string, unknown>;
      const file = entry.file as string;
      if (seenFiles.has(file)) {
        errors.push(`exclusiveOrder[${index}].file: is a duplicate`);
      } else {
        seenFiles.add(file);
      }
      const lanesList = plainArrayCopy(entry.lanes) as unknown[];
      for (let lanesIndex = 0; lanesIndex < lanesList.length; lanesIndex += 1) {
        if (!laneById.has(lanesList[lanesIndex] as string)) {
          errors.push(`exclusiveOrder[${index}].lanes[${lanesIndex}]: names no lane in this plan`);
        }
      }
    }
  }
}

function collectDecisionIds(root: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  if (!hasOwn(root, 'decisions')) {
    return ids;
  }
  const decisions = plainArrayCopy(root.decisions) as unknown[];
  for (const raw of decisions) {
    ids.add((raw as Record<string, unknown>).id as string);
  }
  return ids;
}

function buildNormalizedSidecar(root: Record<string, unknown>): LanePlanSidecar {
  const projectId = root.projectId as string;
  const planId = root.planId as string;
  const lanes = (plainArrayCopy(root.lanes) as unknown[]).map((raw) =>
    buildNormalizedLane(raw, projectId, planId),
  );
  const decisions = hasOwn(root, 'decisions')
    ? (plainArrayCopy(root.decisions) as unknown[]).map((raw) => buildNormalizedDecision(raw))
    : [];
  const exclusiveOrder = hasOwn(root, 'exclusiveOrder')
    ? (plainArrayCopy(root.exclusiveOrder) as unknown[]).map((raw) => buildNormalizedExclusiveOrder(raw))
    : [];
  return {
    schemaVersion: LANE_PLAN_SIDECAR_SCHEMA_VERSION,
    projectId,
    planId,
    revision: root.revision as number,
    doc: root.doc as string,
    lanes,
    decisions,
    exclusiveOrder,
  };
}

function buildNormalizedLane(raw: unknown, projectId: string, planId: string): PlannedLaneSidecar {
  const lane = raw as Record<string, unknown>;
  const after = hasOwn(lane, 'after')
    ? (plainArrayCopy(lane.after) as unknown[]).map(
        (item) => resolveAfterReference(item as string, projectId, planId) as PlannedLaneRef,
      )
    : [];
  const mergedPr: PullRequestRef | null =
    lane.mergedPr === undefined || lane.mergedPr === null
      ? null
      : {
          repository: (lane.mergedPr as Record<string, unknown>).repository as string,
          number: (lane.mergedPr as Record<string, unknown>).number as number,
        };
  return {
    laneId: lane.laneId as string,
    renamedFrom: lane.renamedFrom === undefined ? null : (lane.renamedFrom as string | null),
    scope: lane.scope as string,
    packages: hasOwn(lane, 'packages') ? [...(plainArrayCopy(lane.packages) as unknown[])] as string[] : [],
    sharedFiles: hasOwn(lane, 'sharedFiles') ? [...(plainArrayCopy(lane.sharedFiles) as unknown[])] as string[] : [],
    tier: lane.tier as PlannedLaneTier,
    after,
    decisions: hasOwn(lane, 'decisions') ? [...(plainArrayCopy(lane.decisions) as unknown[])] as string[] : [],
    status: (lane.status === undefined ? 'planned' : lane.status) as PlannedLaneStatus,
    brief: lane.brief === undefined ? null : (lane.brief as string | null),
    mergedPr,
  };
}

function buildNormalizedDecision(raw: unknown): PlanDecisionSidecar {
  const decision = raw as Record<string, unknown>;
  return {
    id: decision.id as string,
    question: decision.question as string,
    default: decision.default as string,
    state: decision.state as PlanDecisionState,
  };
}

function buildNormalizedExclusiveOrder(raw: unknown): ExclusiveOrderSidecar {
  const entry = raw as Record<string, unknown>;
  return {
    file: entry.file as string,
    lanes: [...(plainArrayCopy(entry.lanes) as unknown[])] as string[],
  };
}

function cappedErrors(errors: string[]): LanePlanSidecarResult {
  if (errors.length <= LANE_PLAN_LIMITS.errors) {
    return { ok: false, errors };
  }
  return {
    ok: false,
    errors: [...errors.slice(0, LANE_PLAN_LIMITS.errors - 1), 'sidecar: more errors not shown'],
  };
}

function resolveAfterReference(text: string, projectId: string, planId: string): PlannedLaneRef | null {
  const parts = text.split('/');
  if (parts.length === 1) {
    if (!PLANNED_LANE_ID_PATTERN.test(parts[0])) {
      return null;
    }
    return { projectId, planId, laneId: parts[0] };
  }
  if (parts.length === 2) {
    if (!PLAN_ID_PATTERN.test(parts[0]) || !PLANNED_LANE_ID_PATTERN.test(parts[1])) {
      return null;
    }
    return { projectId, planId: parts[0], laneId: parts[1] };
  }
  if (parts.length === 3) {
    if (
      !PLAN_PROJECT_ID_PATTERN.test(parts[0]) ||
      !PLAN_ID_PATTERN.test(parts[1]) ||
      !PLANNED_LANE_ID_PATTERN.test(parts[2])
    ) {
      return null;
    }
    return { projectId: parts[0], planId: parts[1], laneId: parts[2] };
  }
  return null;
}

/** `repo` or `owner/repo`, in a forge's own name characters only: no whitespace, control or bidi code point can pass. */
const PULL_REQUEST_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;

function pullRequestRepositoryError(path: string, value: unknown): string | null {
  if (typeof value !== 'string') {
    return `${path}: must be a string`;
  }
  if (isPlanSecretShaped(value)) {
    return `${path}: contains a secret-shaped value and was refused`;
  }
  if (
    value.length === 0 ||
    utf8Bytes(value) > LANE_PLAN_LIMITS.repositoryBytes ||
    !PULL_REQUEST_REPOSITORY_PATTERN.test(value)
  ) {
    return `${path}: must be a repository name`;
  }
  return null;
}

function pushIdError(errors: string[], path: string, value: unknown, pattern: RegExp, idWord: string): void {
  const error = planIdError(path, value, pattern, idWord);
  if (error !== null) {
    errors.push(error);
  }
}

function pushTextError(errors: string[], path: string, value: unknown, maxBytes: number): void {
  const error = planTextError(path, value, maxBytes);
  if (error !== null) {
    errors.push(error);
  }
}

function pushPathError(errors: string[], path: string, value: unknown): void {
  const error = planPathError(path, value);
  if (error !== null) {
    errors.push(error);
  }
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function isForbiddenTextCodePoint(codePoint: number): boolean {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return true;
  }
  if (codePoint === 0x2028 || codePoint === 0x2029) {
    return true;
  }
  if (codePoint >= 0x202a && codePoint <= 0x202e) {
    return true;
  }
  if (codePoint >= 0x2066 && codePoint <= 0x2069) {
    return true;
  }
  return false;
}
