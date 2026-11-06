/**
 * WB2c (`deriveLaneWaits`): the single-lane waits-for view over a derived
 * `WorkBoard` (waits-for-view plan §3.2, §3.7, §3.8). Pure domain: never
 * throws, never runs a getter (a Proxy's prototype/descriptor traps can still
 * run, and a throwing trap is a refusal), never mutates inputs, never
 * touches filesystem/network/subprocess/clock. All inputs are validated
 * through own property descriptors; malformed input returns a typed refusal
 * (`'invalid-board' | 'invalid-ref' | 'invalid-options' | 'lane-not-on-board'`)
 * and refuses echoing any offending value, secret shape or host/filesystem
 * path. All graph walks are iterative (explicit stacks/loops), bounded by the
 * 200-distinct-lane node cap.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { isPlainRecordObject } from './record-schema-version.js';
import {
  BOARD_SOURCES,
  BOARD_TEXT_MAX_BYTES,
  SOURCE_READING_REASONS,
  WORK_BOARD_SCHEMA_VERSION,
  formatLaneRef,
  parseTimeMs,
  sameLaneRef,
} from './work-board-facts.js';
import type {
  BoardPlannedLaneStatus,
  BoardPlanFact,
  BoardSource,
  LaneRef,
  SourceReading,
} from './work-board-facts.js';
import type {
  BoardLaneCard,
  BoardLaneColumn,
  BoardPlacement,
  ClearedBy,
  GuardState,
  LaneGlance,
  WaitGuard,
  WaitReason,
  WaitSubject,
} from './work-board.js';

// --- Bounds ---------------------------------------------------------------

export const DEFAULT_LANE_WAITS_NODE_CAP = 200;
export const MAX_LANE_WAITS_NODE_CAP = 200;
export const MAX_LANE_WAITS_BOARD_LANES = 10_000;
export const MAX_LANE_WAITS_GUARDS_PER_LANE = 500;
export const MAX_LANE_WAITS_PLANS = 1_000;
export const MAX_LANE_WAITS_ID_BYTES = 256;

// Internal (non-exported) sanitizing bounds for other dense collections.
const MAX_LANE_WAITS_SOURCES = 10_000;
const MAX_LANE_WAITS_PR_LINKS = 1_000;
const MAX_LANE_WAITS_BADGES = 1_000;
const MAX_LANE_WAITS_WAITING_ON = 1_000;
const MAX_LANE_WAITS_AFTER = 512;
const MAX_LANE_WAITS_EXCLUSIVE_ORDERS = 512;

// --- Public types (waits-for-view plan §3.2) -------------------------------

export type LaneWaitsVerdict = 'blocked' | 'unchecked-only' | 'ready';
export type NoWaitsReason = 'started' | 'done' | 'dropped' | 'deferred';

export type ChainHead =
  | { readonly kind: 'started' }
  | { readonly kind: 'waiting-on-owner'; readonly itemId: string }
  | { readonly kind: 'blocked-by-resource'; readonly reason: WaitReason; readonly subject: WaitSubject }
  | { readonly kind: 'unchecked-only' }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'unresolved' }
  | { readonly kind: 'cycle'; readonly path: readonly LaneRef[] }
  | { readonly kind: 'cap' };

export interface WaitChainStep {
  readonly lane: LaneGlance;
  readonly via: WaitReason;
  readonly ownerAction: boolean;
  readonly otherBlockedDependencies: number;
}

export interface WaitChain {
  readonly lanes: readonly WaitChainStep[];
  readonly head: ChainHead;
  readonly length: number;
  readonly atLeast: boolean;
}

export type WaitNodeStop = 'expanded' | 'leaf' | 'deduplicated' | 'cycle' | 'cap';

export interface WaitNodeChild {
  readonly guard: WaitGuard;
  readonly node: WaitNode | null;
  readonly stop: WaitNodeStop;
}

export interface WaitNode {
  readonly lane: LaneGlance;
  readonly children: readonly WaitNodeChild[];
}

export interface LaneWaits {
  readonly lane: LaneGlance;
  readonly verdict: LaneWaitsVerdict;
  readonly summary: string;
  readonly counts: { readonly blocked: number; readonly unknown: number; readonly clear: number };
  readonly firstBlocker: WaitGuard | null;
  readonly guards: readonly WaitGuard[];
  readonly chains: readonly WaitChain[];
  readonly sources: readonly SourceReading[];
  readonly truncated: { readonly nodeCap: boolean };
  readonly tree: WaitNode;
}

export interface LaneWaitsOptions {
  readonly nodeCap?: number;
  readonly plans?: readonly BoardPlanFact[];
}

export interface LaneWaitsView {
  readonly card: BoardLaneCard;
  readonly lane: LaneGlance;
  readonly waits: LaneWaits | null;
  readonly noWaits: NoWaitsReason | null;
  readonly unblocks: readonly LaneGlance[];
  readonly readAtIso: string;
  readonly sources: readonly SourceReading[];
}

export type LaneWaitsRefusalReason = 'invalid-board' | 'invalid-ref' | 'invalid-options' | 'lane-not-on-board';

export type DeriveLaneWaitsResult =
  | ({ readonly ok: true } & LaneWaitsView)
  | { readonly ok: false; readonly reason: 'invalid-board' | 'invalid-ref' | 'invalid-options' }
  | { readonly ok: false; readonly reason: 'lane-not-on-board'; readonly ref: LaneRef; readonly readAtIso: string };

// --- The one row order and summary wording (§3.2) --------------------------

const WAIT_REASON_ORDER: readonly WaitReason[] = [
  'after-not-done', 'after-unresolved', 'after-dropped',
  'package-occupied', 'shared-file-held', 'exclusive-order', 'owner-decision',
  'project-lane-cap', 'capacity', 'seat', 'brief', 'cycle-in-records',
];

const BOARD_LANE_COLUMN_VALUES: readonly BoardLaneColumn[] = [
  'done', 'in-flight', 'queued', 'waiting', 'dropped', 'deferred', 'unresolved', 'not-read',
];

const BOARD_PLACEMENT_VALUES: readonly BoardPlacement[] = [
  'done', 'waiting', 'in-flight', 'queued', 'dropped', 'deferred',
];

const PLACEMENT_BASE_SOURCES: Record<BoardPlacement, readonly BoardSource[]> = {
  done: ['work-orders', 'pr-links', 'merge-records'],
  waiting: ['work-orders', 'pr-links', 'merge-records', 'owner-items', 'questions'],
  'in-flight': ['work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'owner-items', 'questions', 'review-evidence'],
  queued: ['plans', 'work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'merge-records', 'owner-items', 'questions'],
  dropped: ['plans', 'work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'merge-records', 'owner-items', 'questions'],
  deferred: ['plans', 'work-orders', 'attempts', 'runs', 'declarations', 'pr-links', 'merge-records', 'owner-items', 'questions'],
};

const DEPENDENCY_REASONS: readonly WaitReason[] = [
  'after-not-done', 'exclusive-order', 'after-dropped', 'after-unresolved',
];

function waitReasonRank(reason: WaitReason): number {
  const index = WAIT_REASON_ORDER.indexOf(reason);
  return index === -1 ? WAIT_REASON_ORDER.length : index;
}

function isBlockedDependencyRow(row: WaitGuard): boolean {
  return row.state === 'blocked' && DEPENDENCY_REASONS.includes(row.reason);
}

function countBlockedDependencyRows(rows: readonly WaitGuard[]): number {
  let count = 0;
  for (const row of rows) {
    if (isBlockedDependencyRow(row)) count += 1;
  }
  return count;
}

// --- Descriptor-safe reads --------------------------------------------------

type PropRead = { ok: true; present: boolean; value?: unknown } | { ok: false };

function requiredProp(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
    return undefined;
  }
  return descriptor.value;
}

function optionalProp(value: Record<string, unknown>, key: string): PropRead {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { ok: true, present: false };
  if (!descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return { ok: false };
  return { ok: true, present: true, value: descriptor.value };
}

function denseArray(value: unknown, bound: number): value is unknown[] {
  if (!Array.isArray(value)) return false;
  if (value.length > bound) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      return false;
    }
  }
  return true;
}

function isForbiddenTextCodePoint(codePoint: number): boolean {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  if (codePoint === 0x2028 || codePoint === 0x2029) return true;
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return true;
  return false;
}

/** Plain display text: a non-secret-shaped string with no control characters. */
function acceptableText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (containsSecretShape(value)) return false;
  for (const pattern of LANE_DIFF_SECRET_PATTERNS) {
    if (pattern.regex.test(value)) return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (isForbiddenTextCodePoint(codePoint)) return false;
    if (codePoint > 0xffff) index += 1;
  }
  return true;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** An id: non-empty plain text, bounded UTF-8, no whitespace; optionally no `/` or `..`. */
function validId(value: unknown, forbidSlashDotDot: boolean): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (!acceptableText(value)) return false;
  if (/\s/.test(value)) return false;
  if (utf8Bytes(value) > MAX_LANE_WAITS_ID_BYTES) return false;
  if (forbidSlashDotDot && (value.includes('/') || value.includes('..'))) return false;
  return true;
}

/** A non-empty relative repository path (never absolute, home, drive-letter, file:// or traversing). */
function relativeRepoPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (!acceptableText(value)) return false;
  if (utf8Bytes(value) > BOARD_TEXT_MAX_BYTES) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.startsWith('file://')) return false;
  for (const segment of value.split('/')) {
    if (segment === '..') return false;
  }
  return true;
}

// --- Value validators -------------------------------------------------------

function validateLaneRef(value: unknown): LaneRef | null {
  if (!isPlainRecordObject(value)) return null;
  const kind = requiredProp(value, 'kind');
  if (kind === 'plan') {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 4) return null;
    for (const key of keys) {
      if (typeof key !== 'string' || (key !== 'kind' && key !== 'projectId' && key !== 'planId' && key !== 'laneId')) {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        return null;
      }
    }
    const projectId = requiredProp(value, 'projectId');
    const planId = requiredProp(value, 'planId');
    const laneId = requiredProp(value, 'laneId');
    if (!validId(projectId, true) || !validId(planId, true) || !validId(laneId, true)) return null;
    return { kind: 'plan', projectId, planId, laneId };
  }
  if (kind === 'work-order') {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3) return null;
    for (const key of keys) {
      if (typeof key !== 'string' || (key !== 'kind' && key !== 'projectId' && key !== 'workOrderId')) {
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
        return null;
      }
    }
    const projectId = requiredProp(value, 'projectId');
    const workOrderId = requiredProp(value, 'workOrderId');
    if (!validId(projectId, true) || !validId(workOrderId, false)) return null;
    return { kind: 'work-order', projectId, workOrderId };
  }
  return null;
}

function validateSourceReading(value: unknown): SourceReading | null {
  if (!isPlainRecordObject(value)) return null;
  const source = requiredProp(value, 'source');
  const status = requiredProp(value, 'status');
  const repository = requiredProp(value, 'repository');
  const readAtIso = requiredProp(value, 'readAtIso');
  if (typeof source !== 'string' || !(BOARD_SOURCES as readonly string[]).includes(source)) return null;
  if (status !== 'read' && status !== 'not-read') return null;
  if (repository !== null && !acceptableText(repository)) return null;
  if (readAtIso !== null && (typeof readAtIso !== 'string' || parseTimeMs(readAtIso) === null)) return null;
  const reasonRead = optionalProp(value, 'reason');
  if (!reasonRead.ok) return null;
  let reason: SourceReading['reason'];
  if (reasonRead.present) {
    if (!(SOURCE_READING_REASONS as readonly string[]).includes(reasonRead.value as string)) return null;
    reason = reasonRead.value as SourceReading['reason'];
  }
  return reason !== undefined
    ? { source: source as BoardSource, repository: repository as string | null, readAtIso: readAtIso as string | null, status, reason }
    : { source: source as BoardSource, repository: repository as string | null, readAtIso: readAtIso as string | null, status };
}

function validateEmbeddedPr(value: unknown): NonNullable<LaneGlance['pr']> | null {
  if (!isPlainRecordObject(value)) return null;
  const repository = requiredProp(value, 'repository');
  const number = requiredProp(value, 'number');
  const state = requiredProp(value, 'state');
  const stale = requiredProp(value, 'stale');
  if (typeof repository !== 'string' || !acceptableText(repository)) return null;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  if (state !== 'open' && state !== 'closed' && state !== 'merged') return null;
  if (typeof stale !== 'boolean') return null;
  const asOf = optionalProp(value, 'asOfIso');
  if (!asOf.ok) return null;
  if (asOf.present && asOf.value !== null && typeof asOf.value !== 'string') return null;
  return asOf.present && asOf.value !== null
    ? { repository, number, state, stale, asOfIso: asOf.value as string }
    : { repository, number, state, stale };
}

function validateLaneGlance(value: unknown): LaneGlance | null {
  if (!isPlainRecordObject(value)) return null;
  const laneRef = validateLaneRef(requiredProp(value, 'ref'));
  if (laneRef === null) return null;
  const label = requiredProp(value, 'label');
  if (!acceptableText(label)) return null;
  const column = requiredProp(value, 'column');
  if (typeof column !== 'string' || !(BOARD_LANE_COLUMN_VALUES as readonly string[]).includes(column)) return null;

  const step = optionalProp(value, 'step');
  if (!step.ok) return null;
  let stepValue: string | undefined;
  if (step.present) {
    if (!acceptableText(step.value)) return null;
    stepValue = step.value;
  }

  const pr = optionalProp(value, 'pr');
  if (!pr.ok) return null;
  let validPr: NonNullable<LaneGlance['pr']> | null = null;
  if (pr.present) {
    validPr = validateEmbeddedPr(pr.value);
    if (validPr === null) return null;
  }

  const declared = optionalProp(value, 'declared');
  if (!declared.ok) return null;
  let declaredValue: { atIso: string; lapsed: boolean } | null = null;
  if (declared.present) {
    if (!isPlainRecordObject(declared.value)) return null;
    const atIso = requiredProp(declared.value, 'atIso');
    const lapsed = requiredProp(declared.value, 'lapsed');
    if (typeof atIso !== 'string' || typeof lapsed !== 'boolean') return null;
    declaredValue = { atIso, lapsed };
  }

  const waitingOn = optionalProp(value, 'waitingOn');
  if (!waitingOn.ok) return null;
  let waitingValue: { itemId: string; itemKind: 'merge' | 'decision' | 'secret'; subject: string } | null = null;
  if (waitingOn.present) {
    if (!isPlainRecordObject(waitingOn.value)) return null;
    const itemId = requiredProp(waitingOn.value, 'itemId');
    const itemKind = requiredProp(waitingOn.value, 'itemKind');
    const subject = requiredProp(waitingOn.value, 'subject');
    if (typeof itemId !== 'string' || !acceptableText(itemId)) return null;
    if (itemKind !== 'merge' && itemKind !== 'decision' && itemKind !== 'secret') return null;
    if (typeof subject !== 'string' || !acceptableText(subject)) return null;
    waitingValue = { itemId, itemKind, subject };
  }

  return {
    ref: laneRef,
    label,
    column: column as BoardLaneColumn,
    ...(stepValue !== undefined ? { step: stepValue } : {}),
    ...(validPr !== null ? { pr: validPr } : {}),
    ...(declaredValue !== null ? { declared: declaredValue } : {}),
    ...(waitingValue !== null ? { waitingOn: waitingValue } : {}),
  };
}

function validateWaitSubject(value: unknown): WaitSubject | null {
  if (!isPlainRecordObject(value)) return null;
  const kind = requiredProp(value, 'kind');
  switch (kind) {
    case 'lane': {
      const lane = validateLaneGlance(requiredProp(value, 'lane'));
      if (lane === null) return null;
      return { kind: 'lane', lane };
    }
    case 'package': {
      const name = requiredProp(value, 'name');
      if (!acceptableText(name)) return null;
      const heldByValue = requiredProp(value, 'heldBy');
      if (heldByValue === null) return { kind: 'package', name, heldBy: null };
      const heldBy = validateLaneGlance(heldByValue);
      if (heldBy === null) return null;
      return { kind: 'package', name, heldBy };
    }
    case 'shared-file': {
      const path = requiredProp(value, 'path');
      if (!relativeRepoPath(path)) return null;
      const heldBy = validateLaneGlance(requiredProp(value, 'heldBy'));
      if (heldBy === null) return null;
      return { kind: 'shared-file', path, heldBy };
    }
    case 'project-slots': {
      const projectId = requiredProp(value, 'projectId');
      const held = requiredProp(value, 'held');
      const cap = requiredProp(value, 'cap');
      if (!validId(projectId, true)) return null;
      if (typeof held !== 'number' || typeof cap !== 'number') return null;
      return { kind: 'project-slots', projectId, held, cap };
    }
    case 'capacity': {
      const held = requiredProp(value, 'held');
      const budget = requiredProp(value, 'budget');
      if (typeof held !== 'number' || typeof budget !== 'number') return null;
      return { kind: 'capacity', held, budget };
    }
    case 'seat': {
      const role = requiredProp(value, 'role');
      if (role !== null && !acceptableText(role)) return null;
      return { kind: 'seat', role: role as string | null };
    }
    case 'brief': {
      const path = requiredProp(value, 'path');
      if (!relativeRepoPath(path)) return null;
      const sha256 = optionalProp(value, 'sha256');
      const readAt = optionalProp(value, 'readAtIso');
      const lastFailed = optionalProp(value, 'lastFailedAtIso');
      if (!sha256.ok || !readAt.ok || !lastFailed.ok) return null;
      if (sha256.present && (typeof sha256.value !== 'string' || !acceptableText(sha256.value))) return null;
      if (readAt.present && typeof readAt.value !== 'string') return null;
      if (lastFailed.present && typeof lastFailed.value !== 'string') return null;
      return {
        kind: 'brief',
        path,
        ...(sha256.present ? { sha256: sha256.value as string } : {}),
        ...(readAt.present ? { readAtIso: readAt.value as string } : {}),
        ...(lastFailed.present ? { lastFailedAtIso: lastFailed.value as string } : {}),
      };
    }
    case 'owner-item': {
      const itemId = requiredProp(value, 'itemId');
      const itemKind = requiredProp(value, 'itemKind');
      const subject = requiredProp(value, 'subject');
      const sinceIso = requiredProp(value, 'sinceIso');
      if (!validId(itemId, false)) return null;
      if (itemKind !== 'merge' && itemKind !== 'decision' && itemKind !== 'secret') return null;
      if (!acceptableText(subject)) return null;
      if (typeof sinceIso !== 'string' || !acceptableText(sinceIso) || parseTimeMs(sinceIso) === null) return null;
      return { kind: 'owner-item', itemId, itemKind, subject, sinceIso };
    }
    case 'plan-decision': {
      const projectId = requiredProp(value, 'projectId');
      const planId = requiredProp(value, 'planId');
      const decisionId = requiredProp(value, 'decisionId');
      if (!validId(projectId, true) || !validId(planId, true) || !validId(decisionId, false)) return null;
      return { kind: 'plan-decision', projectId, planId, decisionId };
    }
    case 'plan': {
      const projectId = requiredProp(value, 'projectId');
      const planId = requiredProp(value, 'planId');
      if (!validId(projectId, true) || !validId(planId, true)) return null;
      return { kind: 'plan', projectId, planId };
    }
    case 'cycle': {
      const path = requiredProp(value, 'path');
      if (!denseArray(path, MAX_LANE_WAITS_BOARD_LANES)) return null;
      const refs: LaneRef[] = [];
      for (const item of path) {
        const ref = validateLaneRef(item);
        if (ref === null) return null;
        refs.push(ref);
      }
      return { kind: 'cycle', path: refs };
    }
    default:
      return null;
  }
}

function validateClearedBy(value: unknown): ClearedBy | null {
  if (!isPlainRecordObject(value)) return null;
  const kind = requiredProp(value, 'kind');
  switch (kind) {
    case 'done': {
      const subject = validateLaneRef(requiredProp(value, 'subject'));
      if (subject === null) return null;
      return { kind: 'done', subject };
    }
    case 'holder-ends': {
      const lane = validateLaneRef(requiredProp(value, 'lane'));
      if (lane === null) return null;
      const what = requiredProp(value, 'what');
      if (what !== 'package' && what !== 'shared-file') return null;
      return { kind: 'holder-ends', lane, what };
    }
    case 'owner': {
      const itemId = requiredProp(value, 'itemId');
      if (typeof itemId !== 'string' || !acceptableText(itemId)) return null;
      return { kind: 'owner', itemId };
    }
    case 'release': {
      const what = requiredProp(value, 'what');
      if (what !== 'project-slot' && what !== 'capacity') return null;
      return { kind: 'release', what };
    }
    case 'record': {
      const what = requiredProp(value, 'what');
      if (what !== 'seat-probe' && what !== 'brief-read' && what !== 'forge-sync' && what !== 'plan-import' && what !== 'declaration-renewal') {
        return null;
      }
      return { kind: 'record', what };
    }
    case 'edit': {
      const what = requiredProp(value, 'what');
      if (what !== 'after' && what !== 'exclusive-order') return null;
      return { kind: 'edit', what };
    }
    case 'read': {
      const source = requiredProp(value, 'source');
      if (typeof source !== 'string' || !(BOARD_SOURCES as readonly string[]).includes(source)) return null;
      return { kind: 'read', source: source as BoardSource };
    }
    case 'integrity': {
      const what = requiredProp(value, 'what');
      if (what !== 'cycle') return null;
      return { kind: 'integrity', what };
    }
    default:
      return null;
  }
}

function validateWaitGuard(value: unknown): WaitGuard | null {
  if (!isPlainRecordObject(value)) return null;
  const reason = requiredProp(value, 'reason');
  const state = requiredProp(value, 'state');
  const subject = validateWaitSubject(requiredProp(value, 'subject'));
  const clearedBy = validateClearedBy(requiredProp(value, 'clearedBy'));
  const clearedByText = requiredProp(value, 'clearedByText');
  const sources = requiredProp(value, 'sources');
  const unreadBeside = requiredProp(value, 'unreadBeside');
  if (typeof reason !== 'string' || !(WAIT_REASON_ORDER as readonly string[]).includes(reason)) return null;
  if (state !== 'blocked' && state !== 'unknown' && state !== 'clear') return null;
  if (subject === null || clearedBy === null) return null;
  if (!acceptableText(clearedByText)) return null;
  if (!denseArray(sources, MAX_LANE_WAITS_SOURCES)) return null;
  if (!denseArray(unreadBeside, MAX_LANE_WAITS_SOURCES)) return null;
  const srcs: SourceReading[] = [];
  for (const source of sources) {
    const reading = validateSourceReading(source);
    if (reading === null) return null;
    srcs.push(reading);
  }
  const unread: BoardSource[] = [];
  for (const source of unreadBeside) {
    if (typeof source !== 'string' || !(BOARD_SOURCES as readonly string[]).includes(source)) return null;
    unread.push(source as BoardSource);
  }
  return {
    reason: reason as WaitReason,
    state: state as GuardState,
    subject,
    clearedBy,
    clearedByText,
    sources: srcs,
    unreadBeside: unread,
  };
}

interface ValidPr {
  readonly repository: string;
  readonly number: number;
  readonly state: 'open' | 'closed' | 'merged' | 'not-observed' | 'not-read';
  readonly asOfIso: string | null;
  readonly stale: boolean;
}

function validatePr(value: unknown): ValidPr | null {
  if (!isPlainRecordObject(value)) return null;
  const repository = requiredProp(value, 'repository');
  const number = requiredProp(value, 'number');
  const state = requiredProp(value, 'state');
  const stale = requiredProp(value, 'stale');
  if (typeof repository !== 'string' || !acceptableText(repository)) return null;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  if (state !== 'open' && state !== 'closed' && state !== 'merged' && state !== 'not-observed' && state !== 'not-read') return null;
  if (typeof stale !== 'boolean') return null;
  const asOf = optionalProp(value, 'asOfIso');
  if (!asOf.ok) return null;
  if (asOf.present && asOf.value !== null && typeof asOf.value !== 'string') return null;
  return {
    repository,
    number,
    state,
    asOfIso: asOf.present ? (asOf.value as string | null) : null,
    stale,
  };
}

interface ValidCard {
  readonly key: string;
  readonly ref: LaneRef;
  readonly label: string;
  readonly placement: BoardPlacement;
  readonly stepText: string | null;
  readonly pullRequests: readonly ValidPr[];
  readonly declarationBadges: readonly { readonly atIso: string; readonly lapsed: boolean }[];
  readonly waitingOn: readonly { readonly id: string; readonly kind: 'merge' | 'decision' | 'secret'; readonly subject: string | null; readonly sinceIso: string }[];
  readonly waitsOn: readonly WaitGuard[];
  readonly notRead: readonly SourceReading[];
  /** The card rebuilt from validated fields; the caller's object is never echoed. */
  readonly card: BoardLaneCard;
}

function validateCard(value: unknown): ValidCard | null {
  if (!isPlainRecordObject(value)) return null;
  const key = requiredProp(value, 'key');
  const ref = validateLaneRef(requiredProp(value, 'ref'));
  if (ref === null) return null;
  if (typeof key !== 'string' || key !== formatLaneRef(ref)) return null;
  const label = requiredProp(value, 'label');
  if (!acceptableText(label)) return null;
  const placement = requiredProp(value, 'placement');
  if (typeof placement !== 'string' || !(BOARD_PLACEMENT_VALUES as readonly string[]).includes(placement)) return null;
  const stepText = requiredProp(value, 'stepText');
  if (stepText !== null && !acceptableText(stepText)) return null;

  const pullRequests = requiredProp(value, 'pullRequests');
  if (!denseArray(pullRequests, MAX_LANE_WAITS_PR_LINKS)) return null;
  const prs: ValidPr[] = [];
  for (const pr of pullRequests) {
    const valid = validatePr(pr);
    if (valid === null) return null;
    prs.push(valid);
  }

  const badges = requiredProp(value, 'badges');
  if (!denseArray(badges, MAX_LANE_WAITS_BADGES)) return null;
  const declarations: Array<{ atIso: string; lapsed: boolean }> = [];
  for (const badge of badges) {
    if (!isPlainRecordObject(badge)) return null;
    const kind = requiredProp(badge, 'kind');
    if (typeof kind !== 'string') return null;
    if (kind === 'declaration') {
      const atIso = requiredProp(badge, 'declaredAtIso');
      const lapsed = requiredProp(badge, 'lapsed');
      if (typeof atIso !== 'string' || typeof lapsed !== 'boolean') return null;
      declarations.push({ atIso, lapsed });
    }
  }

  const waitingOn = requiredProp(value, 'waitingOn');
  if (!denseArray(waitingOn, MAX_LANE_WAITS_WAITING_ON)) return null;
  const waiting: Array<{ id: string; kind: 'merge' | 'decision' | 'secret'; subject: string | null; sinceIso: string }> = [];
  for (const entry of waitingOn) {
    if (!isPlainRecordObject(entry)) return null;
    const id = requiredProp(entry, 'id');
    const kind = requiredProp(entry, 'kind');
    const subject = requiredProp(entry, 'subject');
    const sinceIso = requiredProp(entry, 'sinceIso');
    if (typeof id !== 'string' || !acceptableText(id)) return null;
    if (kind !== 'merge' && kind !== 'decision' && kind !== 'secret') return null;
    if (subject !== null && !acceptableText(subject)) return null;
    if (typeof sinceIso !== 'string' || !acceptableText(sinceIso) || parseTimeMs(sinceIso) === null) return null;
    waiting.push({ id, kind, subject: subject as string | null, sinceIso });
  }

  const waitsOn = requiredProp(value, 'waitsOn');
  if (!denseArray(waitsOn, MAX_LANE_WAITS_GUARDS_PER_LANE)) return null;
  const guards: WaitGuard[] = [];
  for (const guard of waitsOn) {
    const valid = validateWaitGuard(guard);
    if (valid === null) return null;
    guards.push(valid);
  }

  const notRead = requiredProp(value, 'notRead');
  if (!denseArray(notRead, MAX_LANE_WAITS_SOURCES)) return null;
  const readings: SourceReading[] = [];
  for (const reading of notRead) {
    const valid = validateSourceReading(reading);
    if (valid === null) return null;
    readings.push(valid);
  }

  const rebuiltCard = rebuildCard(value, {
    key, ref, label, placement: placement as BoardPlacement, stepText: stepText as string | null,
    waitsOn: guards, notRead: readings,
  });
  if (rebuiltCard === null) return null;

  return {
    key,
    ref,
    label,
    placement: placement as BoardPlacement,
    stepText: stepText as string | null,
    pullRequests: prs,
    declarationBadges: declarations,
    waitingOn: waiting,
    waitsOn: guards,
    notRead: readings,
    card: rebuiltCard,
  };
}

// --- Rebuilt card and board envelope ----------------------------------------

const SAFE_COPY_MAX_DEPTH = 8;
const SAFE_COPY_MAX_NODES = 5_000;
const SAFE_COPY_ENVELOPE_MAX_NODES = 200_000;
const PLAN_STATUS_VALUES: readonly string[] = ['planned', 'deferred', 'dropped', 'not-imported', 'no-plan'];

/** A string with no secret shape (display text rules are stricter and apply to named fields). */
function secretFreeString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (containsSecretShape(value)) return false;
  for (const pattern of LANE_DIFF_SECRET_PATTERNS) {
    if (pattern.regex.test(value)) return false;
  }
  return true;
}

/**
 * Deep-copies plain data through own data descriptors only: scalars, dense
 * arrays and plain records, with every string free of secret shapes. Returns
 * `undefined` for anything else (a getter, a symbol key, a function, a cycle
 * past the depth bound, an oversized tree), so nothing unchecked is echoed.
 */
function safeCopy(value: unknown, depth: number, budget: { n: number; max: number }): unknown {
  budget.n += 1;
  if (budget.n > budget.max || depth > SAFE_COPY_MAX_DEPTH) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return secretFreeString(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (!denseArray(value, budget.max)) return undefined;
    const out: unknown[] = [];
    for (const item of value) {
      const copy = safeCopy(item, depth + 1, budget);
      if (copy === undefined) return undefined;
      out.push(copy);
    }
    return out;
  }
  if (!isPlainRecordObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || !secretFreeString(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      return undefined;
    }
    const copy = safeCopy(descriptor.value, depth + 1, budget);
    if (copy === undefined) return undefined;
    out[key] = copy;
  }
  return out;
}

function safeCopyField(value: unknown, max = SAFE_COPY_MAX_NODES): unknown {
  return safeCopy(value, 0, { n: 0, max });
}

function stringList(value: unknown): string[] | null {
  if (!denseArray(value, MAX_LANE_WAITS_BOARD_LANES)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!secretFreeString(item)) return null;
    out.push(item);
  }
  return out;
}

interface ValidatedCardParts {
  readonly key: string;
  readonly ref: LaneRef;
  readonly label: string;
  readonly placement: BoardPlacement;
  readonly stepText: string | null;
  readonly waitsOn: readonly WaitGuard[];
  readonly notRead: readonly SourceReading[];
}

/**
 * Rebuilds a `BoardLaneCard` from validated or deep-copied fields so the
 * result never carries the caller's object (or an unchecked field of it).
 */
function rebuildCard(value: Record<string, unknown>, parts: ValidatedCardParts): BoardLaneCard | null {
  const projectId = requiredProp(value, 'projectId');
  if (!validId(projectId, true)) return null;
  const planId = requiredProp(value, 'planId');
  if (planId !== null && !validId(planId, true)) return null;
  const planStatus = requiredProp(value, 'planStatus');
  if (typeof planStatus !== 'string' || !PLAN_STATUS_VALUES.includes(planStatus)) return null;
  const tier = requiredProp(value, 'tier');
  if (tier !== null && tier !== 0 && tier !== 1 && tier !== 2) return null;
  const scope = requiredProp(value, 'scope');
  if (scope !== null && !secretFreeString(scope)) return null;
  const packages = stringList(requiredProp(value, 'packages'));
  const workOrderIds = stringList(requiredProp(value, 'workOrderIds'));
  if (packages === null || workOrderIds === null) return null;
  const started = requiredProp(value, 'started');
  if (typeof started !== 'boolean') return null;
  const round = requiredProp(value, 'round');
  if (round !== null && (typeof round !== 'number' || !Number.isFinite(round))) return null;
  const summary = requiredProp(value, 'summary');
  if (!secretFreeString(summary)) return null;
  const countsRaw = requiredProp(value, 'waitCounts');
  if (!isPlainRecordObject(countsRaw)) return null;
  const blocked = requiredProp(countsRaw, 'blocked');
  const unknown = requiredProp(countsRaw, 'unknown');
  const clear = requiredProp(countsRaw, 'clear');
  for (const n of [blocked, unknown, clear]) {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
  }
  const firstBlockerRaw = requiredProp(value, 'firstBlocker');
  let firstBlocker: WaitGuard | null = null;
  if (firstBlockerRaw !== null) {
    firstBlocker = validateWaitGuard(firstBlockerRaw);
    if (firstBlocker === null) return null;
  }

  const structured: Record<string, unknown> = {};
  for (const name of ['done', 'step', 'seat', 'reviewCounts'] as const) {
    const raw = requiredProp(value, name);
    if (raw === null) {
      structured[name] = null;
      continue;
    }
    const copy = safeCopyField(raw);
    if (copy === undefined || copy === null || typeof copy !== 'object' || Array.isArray(copy)) return null;
    structured[name] = copy;
  }
  const lists: Record<string, unknown[]> = {};
  for (const name of ['waitingOn', 'pullRequests', 'badges'] as const) {
    const raw = requiredProp(value, name);
    if (!denseArray(raw, MAX_LANE_WAITS_BOARD_LANES)) return null;
    const copy = safeCopyField(raw);
    if (!Array.isArray(copy)) return null;
    lists[name] = copy;
  }

  return {
    key: parts.key,
    ref: parts.ref,
    label: parts.label,
    projectId,
    planId: planId as string | null,
    planStatus: planStatus as BoardLaneCard['planStatus'],
    tier: tier as BoardLaneCard['tier'],
    scope: scope as string | null,
    packages,
    workOrderIds,
    started,
    placement: parts.placement,
    done: structured.done as BoardLaneCard['done'],
    waitingOn: lists.waitingOn as unknown as BoardLaneCard['waitingOn'],
    notRead: [...parts.notRead],
    step: structured.step as BoardLaneCard['step'],
    stepText: parts.stepText,
    seat: structured.seat as BoardLaneCard['seat'],
    round: round as number | null,
    pullRequests: lists.pullRequests as unknown as BoardLaneCard['pullRequests'],
    reviewCounts: structured.reviewCounts as BoardLaneCard['reviewCounts'],
    badges: lists.badges as unknown as BoardLaneCard['badges'],
    waitsOn: [...parts.waitsOn],
    waitCounts: { blocked: blocked as number, unknown: unknown as number, clear: clear as number },
    firstBlocker,
    summary,
  };
}

function validPolicy(value: unknown): boolean {
  if (!isPlainRecordObject(value)) return false;
  for (const name of ['forgeStaleMinutes', 'declarationTtlMinutes', 'doneWindowDays']) {
    const n = requiredProp(value, name);
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false;
  }
  return true;
}

function validReadingList(value: unknown): boolean {
  if (!denseArray(value, MAX_LANE_WAITS_SOURCES)) return false;
  return value.every((reading) => validateSourceReading(reading) !== null);
}

/** Every required `WorkBoard` field beyond the lanes and sources: policy, cutoff, complete, columns, owner items. */
function validBoardEnvelope(value: Record<string, unknown>): boolean {
  if (!validPolicy(requiredProp(value, 'policy'))) return false;
  const cutoff = requiredProp(value, 'doneCutoffIso');
  if (typeof cutoff !== 'string' || parseTimeMs(cutoff) === null) return false;
  if (typeof requiredProp(value, 'complete') !== 'boolean') return false;
  const columns = requiredProp(value, 'columns');
  if (!isPlainRecordObject(columns)) return false;
  const done = requiredProp(columns, 'done');
  const waiting = requiredProp(columns, 'waiting');
  const inFlight = requiredProp(columns, 'inFlight');
  const queued = requiredProp(columns, 'queued');
  if (!isPlainRecordObject(done) || !isPlainRecordObject(waiting) || !isPlainRecordObject(inFlight) || !isPlainRecordObject(queued)) {
    return false;
  }
  const hidden = requiredProp(done, 'hiddenByWindow');
  if (typeof hidden !== 'number' || !Number.isSafeInteger(hidden) || hidden < 0) return false;
  for (const entries of [requiredProp(done, 'entries'), requiredProp(waiting, 'entries')]) {
    if (!denseArray(entries, MAX_LANE_WAITS_BOARD_LANES) || !Array.isArray(safeCopyField(entries, SAFE_COPY_ENVELOPE_MAX_NODES))) return false;
  }
  for (const keys of [requiredProp(inFlight, 'keys'), requiredProp(queued, 'keys')]) {
    if (stringList(keys) === null) return false;
  }
  for (const column of [done, waiting, inFlight, queued]) {
    if (!validReadingList(requiredProp(column, 'notRead'))) return false;
  }
  const ownerItems = requiredProp(value, 'ownerItems');
  return denseArray(ownerItems, MAX_LANE_WAITS_BOARD_LANES) && Array.isArray(safeCopyField(ownerItems, SAFE_COPY_ENVELOPE_MAX_NODES));
}

function validateBoard(value: unknown): ValidBoard | null {
  if (!isPlainRecordObject(value)) return null;
  const schemaVersion = requiredProp(value, 'schemaVersion');
  if (schemaVersion !== WORK_BOARD_SCHEMA_VERSION) return null;
  if (!validBoardEnvelope(value)) return null;
  const readAtIso = requiredProp(value, 'readAtIso');
  if (typeof readAtIso !== 'string' || parseTimeMs(readAtIso) === null) return null;
  const sourcesRaw = requiredProp(value, 'sources');
  if (!denseArray(sourcesRaw, MAX_LANE_WAITS_SOURCES)) return null;
  const sources: SourceReading[] = [];
  let plansReading: SourceReading | null = null;
  for (const source of sourcesRaw) {
    const reading = validateSourceReading(source);
    if (reading === null) return null;
    sources.push(reading);
    if (reading.source === 'plans' && plansReading === null) plansReading = reading;
  }
  const lanesRaw = requiredProp(value, 'lanes');
  if (!denseArray(lanesRaw, MAX_LANE_WAITS_BOARD_LANES)) return null;
  const lanes: ValidCard[] = [];
  const byKey = new Map<string, ValidCard>();
  for (const lane of lanesRaw) {
    const card = validateCard(lane);
    if (card === null) return null;
    if (byKey.has(card.key)) return null;
    byKey.set(card.key, card);
    lanes.push(card);
  }
  return { readAtIso, sources, lanes, byKey, plansReading };
}

interface ValidPlanLane {
  readonly laneId: string;
  readonly aliases: readonly string[];
  readonly status: BoardPlannedLaneStatus;
  readonly after: readonly { readonly projectId: string; readonly planId: string; readonly laneId: string }[];
}

interface ValidExclusiveOrder {
  readonly file: string;
  readonly lanes: readonly string[];
}

interface ValidPlan {
  readonly projectId: string;
  readonly planId: string;
  readonly lanes: readonly ValidPlanLane[];
  readonly exclusiveOrder: readonly ValidExclusiveOrder[];
}

interface ValidBoard {
  readonly readAtIso: string;
  readonly sources: readonly SourceReading[];
  readonly lanes: readonly ValidCard[];
  readonly byKey: ReadonlyMap<string, ValidCard>;
  readonly plansReading: SourceReading | null;
}

interface ValidOptions {
  readonly nodeCap: number;
  readonly plans: readonly ValidPlan[] | undefined;
}

function validatePlanLane(value: unknown): ValidPlanLane | null {
  if (!isPlainRecordObject(value)) return null;
  const laneId = requiredProp(value, 'laneId');
  if (!validId(laneId, true)) return null;
  const aliases = requiredProp(value, 'aliases');
  if (!denseArray(aliases, MAX_LANE_WAITS_PLANS)) return null;
  const aliasList: string[] = [];
  for (const alias of aliases) {
    if (!acceptableText(alias)) return null;
    aliasList.push(alias);
  }
  const status = requiredProp(value, 'status');
  if (status !== 'planned' && status !== 'deferred' && status !== 'dropped') return null;
  const after = requiredProp(value, 'after');
  if (!denseArray(after, MAX_LANE_WAITS_AFTER)) return null;
  const afterList: Array<{ projectId: string; planId: string; laneId: string }> = [];
  for (const entry of after) {
    if (!isPlainRecordObject(entry)) return null;
    const projectId = requiredProp(entry, 'projectId');
    const planId = requiredProp(entry, 'planId');
    const afterLaneId = requiredProp(entry, 'laneId');
    if (!validId(projectId, true) || !validId(planId, true) || !validId(afterLaneId, true)) return null;
    afterList.push({ projectId, planId, laneId: afterLaneId });
  }
  return { laneId, aliases: aliasList, status: status as BoardPlannedLaneStatus, after: afterList };
}

function validatePlanFact(value: unknown): ValidPlan | null {
  if (!isPlainRecordObject(value)) return null;
  const projectId = requiredProp(value, 'projectId');
  const planId = requiredProp(value, 'planId');
  if (!validId(projectId, true) || !validId(planId, true)) return null;
  const lanes = requiredProp(value, 'lanes');
  if (!denseArray(lanes, MAX_LANE_WAITS_BOARD_LANES)) return null;
  const laneList: ValidPlanLane[] = [];
  for (const lane of lanes) {
    const valid = validatePlanLane(lane);
    if (valid === null) return null;
    laneList.push(valid);
  }
  const exclusiveOrder = requiredProp(value, 'exclusiveOrder');
  if (!denseArray(exclusiveOrder, MAX_LANE_WAITS_EXCLUSIVE_ORDERS)) return null;
  const orderList: ValidExclusiveOrder[] = [];
  for (const entry of exclusiveOrder) {
    if (!isPlainRecordObject(entry)) return null;
    const file = requiredProp(entry, 'file');
    const entryLanes = requiredProp(entry, 'lanes');
    if (!acceptableText(file)) return null;
    if (!denseArray(entryLanes, MAX_LANE_WAITS_PLANS)) return null;
    const laneNames: string[] = [];
    for (const name of entryLanes) {
      if (!acceptableText(name)) return null;
      laneNames.push(name);
    }
    orderList.push({ file, lanes: laneNames });
  }
  return { projectId, planId, lanes: laneList, exclusiveOrder: orderList };
}

function validateOptions(options: unknown): ValidOptions | null {
  if (options === undefined) return { nodeCap: DEFAULT_LANE_WAITS_NODE_CAP, plans: undefined };
  if (!isPlainRecordObject(options)) return null;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || (key !== 'nodeCap' && key !== 'plans')) return null;
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
  }
  let nodeCap = DEFAULT_LANE_WAITS_NODE_CAP;
  let plans: readonly ValidPlan[] | undefined;
  const nodeCapDescriptor = Object.getOwnPropertyDescriptor(options, 'nodeCap');
  if (nodeCapDescriptor !== undefined) {
    const value = nodeCapDescriptor.value;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LANE_WAITS_NODE_CAP) {
      return null;
    }
    nodeCap = value;
  }
  const plansDescriptor = Object.getOwnPropertyDescriptor(options, 'plans');
  if (plansDescriptor !== undefined) {
    const value = plansDescriptor.value;
    if (!denseArray(value, MAX_LANE_WAITS_PLANS)) return null;
    const list: ValidPlan[] = [];
    for (const plan of value) {
      const valid = validatePlanFact(plan);
      if (valid === null) return null;
      list.push(valid);
    }
    plans = list;
  }
  return { nodeCap, plans };
}

// --- Rendering helpers -------------------------------------------------------

function renderIso(iso: string): string {
  const ms = parseTimeMs(iso);
  return ms === null ? iso : new Date(ms).toISOString();
}

function formatColumn(column: BoardLaneColumn): string {
  return column === 'in-flight' ? 'in flight' : column;
}

function formatInlineGlance(glance: LaneGlance): string {
  let text = glance.label + ' (' + formatColumn(glance.column);
  if (glance.step !== undefined) text += ', ' + glance.step;
  return text + ')';
}

function phraseFor(row: WaitGuard): string {
  const subject = row.subject;
  switch (row.reason) {
    case 'after-not-done':
    case 'exclusive-order': {
      if (subject.kind !== 'lane') return row.reason;
      const lane = subject.lane;
      if (row.state === 'unknown') return 'after ' + lane.label + ' not checked';
      let text = 'after ' + lane.label + ' (' + formatColumn(lane.column)
        + (lane.step !== undefined ? ', ' + lane.step : '') + ')';
      const unreadForge = row.sources.find((r) => r.source === 'forge-observation' && r.status === 'not-read');
      if (unreadForge !== undefined) {
        text += unreadForge.readAtIso !== null
          ? '; forge not read since ' + renderIso(unreadForge.readAtIso)
          : '; forge not read';
      }
      return text;
    }
    case 'after-unresolved': {
      if (subject.kind === 'plan') {
        return 'after ' + subject.projectId + '/' + subject.planId + ': predecessor plan not imported';
      }
      return row.reason;
    }
    case 'after-dropped': {
      if (subject.kind === 'lane') return 'after ' + subject.lane.label + ': predecessor dropped';
      return row.reason;
    }
    case 'package-occupied': {
      if (subject.kind !== 'package') return row.reason;
      const name = subject.name || 'unknown';
      if (row.state === 'blocked' && subject.heldBy !== null) {
        return 'package ' + name + ' held by ' + formatInlineGlance(subject.heldBy);
      }
      return 'package ' + name + ' not checked';
    }
    case 'shared-file-held': {
      if (subject.kind !== 'shared-file') return row.reason;
      if (row.state === 'blocked') {
        return 'shared file ' + subject.path + ' held by ' + formatInlineGlance(subject.heldBy);
      }
      return 'shared file ' + subject.path + ' not checked';
    }
    case 'owner-decision': {
      if (subject.kind === 'owner-item') {
        if (row.state === 'unknown') return 'owner decision not checked';
        if (subject.itemKind === 'merge') {
          if (row.clearedByText.startsWith('owner merges ')) {
            return 'merge ' + row.clearedByText.slice('owner merges '.length);
          }
          return 'merge ' + subject.subject;
        }
        if (subject.itemKind === 'secret') return 'secret ' + subject.subject;
        return 'decision ' + subject.subject;
      }
      if (subject.kind === 'plan-decision') {
        if (row.state === 'unknown') return 'owner decision not checked';
        return 'decision ' + subject.decisionId;
      }
      return row.reason;
    }
    case 'project-lane-cap': {
      if (subject.kind !== 'project-slots') return row.reason;
      if (row.state === 'blocked') {
        return 'project ' + subject.projectId + ' lane cap (' + String(subject.held) + ' of ' + String(subject.cap) + ')';
      }
      return 'project ' + subject.projectId + ' lane cap not checked';
    }
    case 'capacity': {
      if (subject.kind !== 'capacity') return row.reason;
      if (row.state === 'blocked') {
        return 'capacity (' + String(subject.held) + ' of ' + String(subject.budget) + ')';
      }
      return 'capacity not checked';
    }
    case 'seat':
      return 'seat not checked';
    case 'brief': {
      if (subject.kind !== 'brief') return row.reason;
      if (row.state === 'blocked') {
        return subject.lastFailedAtIso !== undefined
          ? 'brief read failed at ' + renderIso(subject.lastFailedAtIso)
          : 'brief read failed';
      }
      return subject.readAtIso !== undefined
        ? 'brief not read since ' + renderIso(subject.readAtIso)
        : 'brief not checked';
    }
    case 'cycle-in-records': {
      if (subject.kind === 'cycle') {
        return 'cycle in records (' + subject.path.map(formatLaneRef).join(' -> ') + ')';
      }
      return row.reason;
    }
    default:
      return row.reason;
  }
}

function joinBlocked(rows: readonly WaitGuard[]): string {
  const names = rows.map(phraseFor);
  if (names.length >= 3) {
    return names[0] + '; ' + names[1] + ' and ' + String(names.length - 2) + ' more';
  }
  return names.join('; ');
}

function renderLaneWaitsSummary(placement: BoardPlacement, guards: readonly WaitGuard[]): string {
  const blocked = guards.filter((row) => row.state === 'blocked');
  const unknown = guards.filter((row) => row.state === 'unknown');
  const ownerRows = blocked.filter(
    (row): row is WaitGuard & { subject: Extract<WaitSubject, { kind: 'owner-item' }> } =>
      row.reason === 'owner-decision' && row.subject.kind === 'owner-item',
  );

  if (placement === 'waiting' && ownerRows.length > 0) {
    const parts = ownerRows.map((row) => phraseFor(row) + ' (since ' + renderIso(row.subject.sinceIso) + ')');
    let text = 'Waiting on you: ' + parts.join(', ') + '.';
    const ownerSet = new Set<WaitGuard>(ownerRows);
    const others = blocked.filter((row) => !ownerSet.has(row));
    if (others.length > 0) text += ' Also blocked by ' + String(others.length) + ': ' + joinBlocked(others) + '.';
    return text;
  }

  if (blocked.length > 0) {
    let text = 'Blocked by ' + String(blocked.length) + ': ' + joinBlocked(blocked) + '.';
    if (unknown.length > 0) {
      text += ' Unknown ' + String(unknown.length) + ': ' + unknown.map(phraseFor).join('; ') + '.';
    }
    return text;
  }

  if (unknown.length > 0) {
    const hasUnreadSource = unknown.some((row) => row.sources.some((r) => r.status === 'not-read'));
    if (hasUnreadSource) {
      const clauses: string[] = [];
      for (const source of BOARD_SOURCES) {
        let found: SourceReading | null = null;
        for (const row of unknown) {
          for (const reading of row.sources) {
            if (reading.status === 'not-read' && reading.source === source) {
              found = reading;
              break;
            }
          }
          if (found !== null) break;
        }
        if (found !== null) {
          clauses.push(found.source + ' not read' + (found.reason !== undefined ? ' (' + found.reason + ')' : ''));
        }
      }
      return 'Not known: ' + clauses.join('; ') + '; ' + unknown.map(phraseFor).join('; ') + '.';
    }
    return 'Nothing blocks it but unchecked guards: ' + unknown.map(phraseFor).join('; ') + '.';
  }

  return 'Ready.';
}

// --- One row order and glance -------------------------------------------------

function orderWaitGuards(placement: BoardPlacement, rows: readonly WaitGuard[]): WaitGuard[] {
  const owner: WaitGuard[] = [];
  const blocked: WaitGuard[] = [];
  const unknown: WaitGuard[] = [];
  const clear: WaitGuard[] = [];
  for (const row of rows) {
    if (placement === 'waiting' && row.state === 'blocked' && row.reason === 'owner-decision' && row.subject.kind === 'owner-item') {
      owner.push(row);
    } else if (row.state === 'blocked') {
      blocked.push(row);
    } else if (row.state === 'unknown') {
      unknown.push(row);
    } else {
      clear.push(row);
    }
  }
  owner.sort((a, b) => {
    const ta = parseTimeMs((a.subject as Extract<WaitSubject, { kind: 'owner-item' }>).sinceIso) ?? Number.NEGATIVE_INFINITY;
    const tb = parseTimeMs((b.subject as Extract<WaitSubject, { kind: 'owner-item' }>).sinceIso) ?? Number.NEGATIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return (a.subject as Extract<WaitSubject, { kind: 'owner-item' }>).itemId.localeCompare(
      (b.subject as Extract<WaitSubject, { kind: 'owner-item' }>).itemId,
    );
  });
  const byReason = (xs: WaitGuard[]): WaitGuard[] => {
    xs.sort((a, b) => waitReasonRank(a.reason) - waitReasonRank(b.reason));
    return xs;
  };
  return [...owner, ...byReason(blocked), ...byReason(unknown), ...byReason(clear)];
}

function glanceOfCard(card: ValidCard): LaneGlance {
  let endedPr: ValidPr | null = null;
  for (const pr of card.pullRequests) {
    if (pr.state === 'open' || pr.state === 'closed' || pr.state === 'merged') {
      endedPr = pr;
      break;
    }
  }
  let latestDeclaration: { atIso: string; lapsed: boolean } | null = null;
  for (const badge of card.declarationBadges) {
    if (latestDeclaration === null) {
      latestDeclaration = badge;
      continue;
    }
    const a = parseTimeMs(badge.atIso) ?? Number.NEGATIVE_INFINITY;
    const b = parseTimeMs(latestDeclaration.atIso) ?? Number.NEGATIVE_INFINITY;
    if (a > b) latestDeclaration = badge;
  }
  const waiting = card.waitingOn[0];
  const glance: LaneGlance = {
    ref: card.ref,
    label: card.label,
    column: card.placement,
    ...(card.stepText !== null ? { step: card.stepText } : {}),
    ...(endedPr === null ? {} : {
      pr: {
        repository: endedPr.repository,
        number: endedPr.number,
        state: endedPr.state as 'open' | 'closed' | 'merged',
        ...(endedPr.asOfIso === null ? {} : { asOfIso: endedPr.asOfIso }),
        stale: endedPr.stale,
      },
    }),
    ...(latestDeclaration === null ? {} : { declared: { atIso: latestDeclaration.atIso, lapsed: latestDeclaration.lapsed } }),
    ...(waiting === undefined ? {} : {
      waitingOn: { itemId: waiting.id, itemKind: waiting.kind, subject: waiting.subject ?? waiting.id },
    }),
  };
  return glance;
}

function noWaitsFor(placement: BoardPlacement): NoWaitsReason | null {
  switch (placement) {
    case 'in-flight':
      return 'started';
    case 'done':
      return 'done';
    case 'dropped':
      return 'dropped';
    case 'deferred':
      return 'deferred';
    default:
      return null;
  }
}

// --- Unblocks (one level, every column) --------------------------------------

function findPlan(plans: readonly ValidPlan[], projectId: string, planId: string): ValidPlan | null {
  return plans.find((plan) => plan.projectId === projectId && plan.planId === planId) ?? null;
}

function resolvePlanLane(plan: ValidPlan, laneId: string): ValidPlanLane | null {
  const direct = plan.lanes.find((lane) => lane.laneId === laneId);
  if (direct !== undefined) return direct;
  const aliased = plan.lanes.filter((lane) => lane.aliases.includes(laneId));
  return aliased.length === 1 ? aliased[0] : null;
}

function computeUnblocks(board: ValidBoard, target: ValidCard, plans: readonly ValidPlan[] | undefined): LaneGlance[] {
  const collected: Array<{ ref: LaneRef; planLane: ValidPlanLane | null }> = [];

  for (const other of board.lanes) {
    if (other.key === target.key) continue;
    for (const row of other.waitsOn) {
      if (row.reason !== 'after-not-done' && row.reason !== 'exclusive-order' && row.reason !== 'after-dropped') continue;
      if (row.subject.kind !== 'lane') continue;
      if (sameLaneRef(row.subject.lane.ref, target.ref)) {
        collected.push({ ref: other.ref, planLane: null });
        break;
      }
    }
  }

  if (plans !== undefined) {
    for (const plan of plans) {
      for (const lane of plan.lanes) {
        for (const entry of lane.after) {
          const targetPlan = findPlan(plans, entry.projectId, entry.planId);
          if (targetPlan === null) continue;
          const resolved = resolvePlanLane(targetPlan, entry.laneId);
          if (resolved === null) continue;
          const ref: LaneRef = {
            kind: 'plan',
            projectId: targetPlan.projectId,
            planId: targetPlan.planId,
            laneId: resolved.laneId,
          };
          if (sameLaneRef(ref, target.ref)) {
            collected.push({
              ref: { kind: 'plan', projectId: plan.projectId, planId: plan.planId, laneId: lane.laneId },
              planLane: lane,
            });
          }
        }
      }
      if (target.ref.kind === 'plan' && plan.projectId === target.ref.projectId && plan.planId === target.ref.planId) {
        for (const entry of plan.exclusiveOrder) {
          let idx = -1;
          for (let i = 0; i < entry.lanes.length; i += 1) {
            const resolved = resolvePlanLane(plan, entry.lanes[i]);
            if (resolved === null) continue;
            if (sameLaneRef({ kind: 'plan', projectId: plan.projectId, planId: plan.planId, laneId: resolved.laneId }, target.ref)) {
              idx = i;
              break;
            }
          }
          if (idx >= 0) {
            for (let k = idx + 1; k < entry.lanes.length; k += 1) {
              const resolved = resolvePlanLane(plan, entry.lanes[k]);
              if (resolved === null) continue;
              const ref: LaneRef = { kind: 'plan', projectId: plan.projectId, planId: plan.planId, laneId: resolved.laneId };
              if (!sameLaneRef(ref, target.ref)) collected.push({ ref, planLane: resolved });
            }
          }
        }
      }
    }
  }

  const byKey = new Map<string, LaneGlance>();
  for (const item of collected) {
    const key = formatLaneRef(item.ref);
    if (byKey.has(key)) continue;
    const depCard = board.byKey.get(key);
    if (depCard !== undefined) {
      byKey.set(key, glanceOfCard(depCard));
    } else {
      const lane = item.planLane;
      const column: BoardLaneColumn = lane === null
        ? 'unresolved'
        : lane.status === 'dropped' ? 'dropped' : lane.status === 'deferred' ? 'deferred' : 'unresolved';
      const label = lane === null ? (item.ref.kind === 'plan' ? item.ref.laneId : item.ref.workOrderId) : lane.laneId;
      byKey.set(key, { ref: item.ref, label, column });
    }
  }

  const out = [...byKey.values()];
  out.sort((a, b) => {
    const ka = formatLaneRef(a.ref);
    const kb = formatLaneRef(b.ref);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

// --- Chains: iterative walk, visited sets, cap, cycles ------------------------

interface WalkContext {
  readonly closureVisitedKeys: Set<string>;
  readonly detectedCycles: Map<string, LaneRef[]>;
  readonly dagExpandedKeys: Set<string>;
  truncatedNodeCap: boolean;
}

function recordCycle(ctx: WalkContext, cyclePath: readonly LaneRef[]): void {
  const key = cyclePath.map(formatLaneRef).join('->');
  if (!ctx.detectedCycles.has(key)) ctx.detectedCycles.set(key, [...cyclePath]);
}

function detectCycle(ctx: WalkContext, pathKeys: ReadonlySet<string>, pathRefs: readonly LaneRef[], nextRef: LaneRef): ChainHead | null {
  const nextKey = formatLaneRef(nextRef);
  if (!pathKeys.has(nextKey)) return null;
  const repeatIdx = pathRefs.findIndex((r) => formatLaneRef(r) === nextKey);
  const cyclePath = [...pathRefs.slice(repeatIdx), nextRef];
  recordCycle(ctx, cyclePath);
  return { kind: 'cycle', path: cyclePath };
}

function capHit(ctx: WalkContext, nodeCap: number, nextKey: string): boolean {
  if (ctx.closureVisitedKeys.has(nextKey)) return false;
  if (ctx.closureVisitedKeys.size >= nodeCap) {
    ctx.truncatedNodeCap = true;
    return true;
  }
  return false;
}

function walkChain(
  board: ValidBoard,
  target: ValidCard,
  rootDepRow: WaitGuard,
  rootDepCount: number,
  rootGlance: LaneGlance,
  nodeCap: number,
  ctx: WalkContext,
): WaitChain {
  const steps: WaitChainStep[] = [{
    lane: rootGlance,
    via: rootDepRow.reason,
    ownerAction: target.placement === 'waiting',
    otherBlockedDependencies: rootDepCount - 1,
  }];
  const pathKeys = new Set<string>([target.key]);
  const pathRefs: LaneRef[] = [target.ref];
  const chainSources: SourceReading[] = [...target.notRead, ...rootDepRow.sources];
  let currentEdge: WaitGuard = rootDepRow;
  let head: ChainHead = { kind: 'started' };

  loop: while (true) {
    const reason = currentEdge.reason;
    const subject = currentEdge.subject;

    if (reason === 'after-unresolved') {
      if (subject.kind === 'lane') {
        const nextKey = formatLaneRef(subject.lane.ref);
        const cycle = detectCycle(ctx, pathKeys, pathRefs, subject.lane.ref);
        if (cycle !== null) {
          head = cycle;
          break loop;
        }
        if (capHit(ctx, nodeCap, nextKey)) {
          head = { kind: 'cap' };
          break loop;
        }
        ctx.closureVisitedKeys.add(nextKey);
        steps.push({ lane: subject.lane, via: 'after-unresolved', ownerAction: false, otherBlockedDependencies: 0 });
        head = { kind: 'unresolved' };
        break loop;
      }
      head = { kind: 'unresolved' };
      break loop;
    }

    if (reason === 'after-dropped') {
      if (subject.kind !== 'lane') {
        head = { kind: 'unresolved' };
        break loop;
      }
      const droppedGlance = subject.lane;
      const nextKey = formatLaneRef(droppedGlance.ref);
      const cycle = detectCycle(ctx, pathKeys, pathRefs, droppedGlance.ref);
      if (cycle !== null) {
        head = cycle;
        break loop;
      }
      if (capHit(ctx, nodeCap, nextKey)) {
        head = { kind: 'cap' };
        break loop;
      }
      ctx.closureVisitedKeys.add(nextKey);
      steps.push({ lane: droppedGlance, via: 'after-dropped', ownerAction: false, otherBlockedDependencies: 0 });
      head = { kind: 'dropped' };
      break loop;
    }

    if (reason !== 'after-not-done' && reason !== 'exclusive-order') {
      head = { kind: 'unresolved' };
      break loop;
    }
    if (subject.kind !== 'lane') {
      head = { kind: 'unresolved' };
      break loop;
    }

    const nextGlance = subject.lane;
    const nextKey = formatLaneRef(nextGlance.ref);

    const cycle = detectCycle(ctx, pathKeys, pathRefs, nextGlance.ref);
    if (cycle !== null) {
      head = cycle;
      break loop;
    }

    if (capHit(ctx, nodeCap, nextKey)) {
      head = { kind: 'cap' };
      break loop;
    }

    ctx.closureVisitedKeys.add(nextKey);
    pathKeys.add(nextKey);
    pathRefs.push(nextGlance.ref);

    const predCard = board.byKey.get(nextKey);
    if (predCard === undefined || nextGlance.column === 'unresolved') {
      steps.push({ lane: nextGlance, via: reason, ownerAction: false, otherBlockedDependencies: 0 });
      head = { kind: 'unresolved' };
      break loop;
    }
    if (predCard.placement === 'dropped') {
      steps.push({ lane: { ...glanceOfCard(predCard), column: 'dropped' }, via: reason, ownerAction: false, otherBlockedDependencies: 0 });
      head = { kind: 'dropped' };
      break loop;
    }
    if (predCard.placement === 'in-flight' || predCard.placement === 'done' || predCard.placement === 'deferred') {
      for (const reading of predCard.notRead) chainSources.push(reading);
      steps.push({ lane: glanceOfCard(predCard), via: reason, ownerAction: false, otherBlockedDependencies: 0 });
      head = predCard.placement === 'deferred'
        ? { kind: 'blocked-by-resource', reason, subject: currentEdge.subject }
        : { kind: 'started' };
      break loop;
    }
    if (predCard.placement === 'waiting') {
      const predGuards = orderWaitGuards('waiting', predCard.waitsOn);
      for (const reading of predCard.notRead) chainSources.push(reading);
      const firstGuard = predGuards[0];
      if (firstGuard !== undefined) {
        for (const reading of firstGuard.sources) chainSources.push(reading);
      }
      const predBlockedDeps = countBlockedDependencyRows(predGuards);
      let itemId = '';
      const gating = predGuards.find((g) => g.reason === 'owner-decision' && g.subject.kind === 'owner-item');
      if (gating !== undefined && gating.subject.kind === 'owner-item') {
        itemId = gating.subject.itemId;
      } else if (predCard.waitingOn.length > 0) {
        itemId = predCard.waitingOn[0].id;
      }
      steps.push({ lane: glanceOfCard(predCard), via: reason, ownerAction: true, otherBlockedDependencies: predBlockedDeps });
      head = { kind: 'waiting-on-owner', itemId };
      break loop;
    }

    // queued
    const predGuards = orderWaitGuards('queued', predCard.waitsOn);
    for (const reading of predCard.notRead) chainSources.push(reading);
    const predBlockedDeps = countBlockedDependencyRows(predGuards);
    const firstBlocked = predGuards.find((g) => g.state === 'blocked');
    if (firstBlocked === undefined) {
      for (const guard of predGuards) {
        if (guard.state === 'unknown') {
          for (const reading of guard.sources) chainSources.push(reading);
        }
      }
      steps.push({ lane: glanceOfCard(predCard), via: reason, ownerAction: false, otherBlockedDependencies: 0 });
      head = { kind: 'unchecked-only' };
      break loop;
    }
    if (!isBlockedDependencyRow(firstBlocked)) {
      for (const reading of firstBlocked.sources) chainSources.push(reading);
      steps.push({ lane: glanceOfCard(predCard), via: reason, ownerAction: false, otherBlockedDependencies: predBlockedDeps });
      head = { kind: 'blocked-by-resource', reason: firstBlocked.reason, subject: firstBlocked.subject };
      break loop;
    }
    for (const reading of firstBlocked.sources) chainSources.push(reading);
    steps.push({ lane: glanceOfCard(predCard), via: reason, ownerAction: false, otherBlockedDependencies: Math.max(0, predBlockedDeps - 1) });
    currentEdge = firstBlocked;
  }

  const length = steps.length - 1;
  const atLeast = head.kind === 'cap'
    || steps.some((step) => step.otherBlockedDependencies > 0)
    || chainSources.some((reading) => reading.status === 'not-read');
  return { lanes: steps, head, length, atLeast };
}

function buildChains(
  board: ValidBoard,
  target: ValidCard,
  orderedRootGuards: readonly WaitGuard[],
  rootGlance: LaneGlance,
  nodeCap: number,
  ctx: WalkContext,
): WaitChain[] {
  const rootDepRows = orderedRootGuards.filter(isBlockedDependencyRow);
  const chains: WaitChain[] = [];
  for (const row of rootDepRows) {
    chains.push(walkChain(board, target, row, rootDepRows.length, rootGlance, nodeCap, ctx));
  }
  return chains;
}

// --- Tree: DAG-deduplicated, iterative explicit stack ------------------------

function expandableChild(board: ValidBoard, guard: WaitGuard): ValidCard | null {
  if (guard.state !== 'blocked') return null;
  if (guard.reason !== 'after-not-done' && guard.reason !== 'exclusive-order') return null;
  if (guard.subject.kind !== 'lane') return null;
  const childCard = board.byKey.get(formatLaneRef(guard.subject.lane.ref));
  if (childCard === undefined) return null;
  if (childCard.placement !== 'queued' && childCard.placement !== 'waiting') return null;
  return childCard;
}

interface MutableWaitNodeChild {
  guard: WaitGuard;
  node: WaitNode | null;
  stop: WaitNodeStop;
}

interface MutableWaitNode {
  lane: LaneGlance;
  children: MutableWaitNodeChild[];
}

interface TreeFrame {
  readonly card: ValidCard;
  readonly ancestorKeys: Set<string>;
  readonly branchRefs: LaneRef[];
  readonly guards: readonly WaitGuard[];
  nextIndex: number;
  children: MutableWaitNodeChild[];
  result: MutableWaitNode | null;
  parentSlot: { child: MutableWaitNodeChild; parent: TreeFrame } | null;
}

function buildTree(
  board: ValidBoard,
  target: ValidCard,
  orderedRootGuards: readonly WaitGuard[],
  nodeCap: number,
  ctx: WalkContext,
): WaitNode {
  const rootFrame: TreeFrame = {
    card: target,
    ancestorKeys: new Set([target.key]),
    branchRefs: [target.ref],
    guards: orderedRootGuards,
    nextIndex: 0,
    children: [],
    result: null,
    parentSlot: null,
  };
  const stack: TreeFrame[] = [rootFrame];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.result !== null) {
      stack.pop();
      if (frame.parentSlot !== null) frame.parentSlot.child.node = frame.result;
      continue;
    }
    if (frame.nextIndex >= frame.guards.length) {
      frame.result = { lane: glanceOfCard(frame.card), children: frame.children };
      continue;
    }
    const guard = frame.guards[frame.nextIndex];
    frame.nextIndex += 1;
    if (guard.state === 'clear') continue;

    let stop: WaitNodeStop = 'leaf';
    const childCard = expandableChild(board, guard);
    if (childCard !== null) {
      const childKey = childCard.key;
      if (frame.ancestorKeys.has(childKey)) {
        const repeatIdx = frame.branchRefs.findIndex((r) => formatLaneRef(r) === childKey);
        recordCycle(ctx, [...frame.branchRefs.slice(repeatIdx), childCard.ref]);
        stop = 'cycle';
      } else if (ctx.dagExpandedKeys.has(childKey)) {
        stop = 'deduplicated';
      } else if (capHit(ctx, nodeCap, childKey)) {
        stop = 'cap';
      } else {
        ctx.closureVisitedKeys.add(childKey);
        ctx.dagExpandedKeys.add(childKey);
        stop = 'expanded';
        const childFrame: TreeFrame = {
          card: childCard,
          ancestorKeys: new Set(frame.ancestorKeys).add(childKey),
          branchRefs: [...frame.branchRefs, childCard.ref],
          guards: orderWaitGuards(childCard.placement, childCard.waitsOn),
          nextIndex: 0,
          children: [],
          result: null,
          parentSlot: null,
        };
        const entry: MutableWaitNodeChild = { guard, node: null, stop };
        frame.children.push(entry);
        childFrame.parentSlot = { child: entry, parent: frame };
        stack.push(childFrame);
        continue;
      }
    }
    frame.children.push({ guard, node: null, stop });
  }

  return rootFrame.result as WaitNode;
}

// --- Defensive cycle rows and closure sources ----------------------------------

function materializeCycleRows(board: ValidBoard, target: ValidCard, ctx: WalkContext): WaitGuard[] {
  const rows: WaitGuard[] = [];
  const existing = new Set<string>();
  for (const guard of target.waitsOn) {
    if (guard.reason === 'cycle-in-records' && guard.subject.kind === 'cycle') {
      existing.add(guard.subject.path.map(formatLaneRef).join('->'));
    }
  }
  for (const cyclePath of ctx.detectedCycles.values()) {
    const key = cyclePath.map(formatLaneRef).join('->');
    if (existing.has(key)) continue;
    existing.add(key);
    const plansReading = board.plansReading;
    rows.push({
      reason: 'cycle-in-records',
      state: 'blocked',
      subject: { kind: 'cycle', path: [...cyclePath] },
      clearedBy: { kind: 'integrity', what: 'cycle' },
      clearedByText: "fix the plans' after rows; the import refuses new cycles",
      sources: plansReading !== null ? [plansReading] : [],
      unreadBeside: plansReading !== null && plansReading.status === 'not-read' ? ['plans'] : [],
    });
  }
  return rows;
}

function unionClosureSources(
  board: ValidBoard,
  target: ValidCard,
  cards: Iterable<ValidCard>,
  includePlans: boolean,
  targetGuardsOverride?: readonly WaitGuard[],
): SourceReading[] {
  const readings: SourceReading[] = [];
  for (const card of cards) {
    for (const reading of card.notRead) readings.push(reading);
    if (card.placement === 'queued' || card.placement === 'waiting') {
      const guards = card === target && targetGuardsOverride !== undefined ? targetGuardsOverride : card.waitsOn;
      for (const guard of guards) {
        for (const reading of guard.sources) readings.push(reading);
      }
    }
    for (const source of PLACEMENT_BASE_SOURCES[card.placement]) {
      const reading = board.sources.find((r) => r.source === source);
      if (reading !== undefined) readings.push(reading);
    }
    const repos = new Set(card.pullRequests.map((pr) => pr.repository));
    for (const reading of board.sources) {
      if (reading.source === 'forge-observation' && reading.repository !== null && repos.has(reading.repository)) {
        readings.push(reading);
      }
    }
  }
  if (includePlans) {
    const plansReading = board.sources.find((r) => r.source === 'plans');
    if (plansReading !== undefined) readings.push(plansReading);
  }
  const seen = new Map<string, SourceReading>();
  for (const reading of readings) {
    const key = reading.source + '\u0000' + (reading.repository ?? '');
    const current = seen.get(key);
    if (current === undefined) {
      seen.set(key, reading);
      continue;
    }
    if (current.status === 'read' && reading.status === 'not-read') seen.set(key, reading);
  }
  const out = [...seen.values()];
  out.sort((a, b) => {
    const ra = BOARD_SOURCES.indexOf(a.source);
    const rb = BOARD_SOURCES.indexOf(b.source);
    if (ra !== rb) return ra - rb;
    return (a.repository ?? '').localeCompare(b.repository ?? '');
  });
  return out;
}

// --- Entry point ---------------------------------------------------------------

function deriveFromValid(board: ValidBoard, ref: LaneRef, opts: ValidOptions): DeriveLaneWaitsResult {
  let resolvedRef = ref;
  if (ref.kind === 'plan' && opts.plans !== undefined) {
    const plan = findPlan(opts.plans, ref.projectId, ref.planId);
    if (plan !== null) {
      const direct = plan.lanes.find((lane) => lane.laneId === ref.laneId);
      if (direct === undefined) {
        const aliased = plan.lanes.filter((lane) => lane.aliases.includes(ref.laneId));
        if (aliased.length === 1) {
          resolvedRef = { kind: 'plan', projectId: ref.projectId, planId: ref.planId, laneId: aliased[0].laneId };
        }
      }
    }
  }

  const targetKey = formatLaneRef(resolvedRef);
  const target = board.byKey.get(targetKey);
  if (target === undefined) {
    return { ok: false, reason: 'lane-not-on-board', ref: resolvedRef, readAtIso: renderIso(board.readAtIso) };
  }

  const rootGlance = glanceOfCard(target);
  const unblocks = computeUnblocks(board, target, opts.plans);
  const noWaits = noWaitsFor(target.placement);

  if (noWaits !== null) {
    const sources = unionClosureSources(board, target, [target], true);
    return {
      ok: true,
      card: target.card,
      lane: rootGlance,
      waits: null,
      noWaits,
      unblocks,
      readAtIso: renderIso(board.readAtIso),
      sources,
    };
  }

  const ctx: WalkContext = {
    closureVisitedKeys: new Set<string>(),
    detectedCycles: new Map<string, LaneRef[]>(),
    dagExpandedKeys: new Set<string>([target.key]),
    truncatedNodeCap: false,
  };

  const orderedRootGuards = orderWaitGuards(target.placement, target.waitsOn);
  const chains = buildChains(board, target, orderedRootGuards, rootGlance, opts.nodeCap, ctx);
  const rootNode = buildTree(board, target, orderedRootGuards, opts.nodeCap, ctx);

  const addedCycleRows = materializeCycleRows(board, target, ctx);
  let finalGuards = orderedRootGuards;
  let finalTree = rootNode;
  if (addedCycleRows.length > 0) {
    finalGuards = orderWaitGuards(target.placement, [...target.waitsOn, ...addedCycleRows]);
    const childByGuard = new Map<WaitGuard, { node: WaitNode | null; stop: WaitNodeStop }>();
    for (const child of rootNode.children) childByGuard.set(child.guard, { node: child.node, stop: child.stop });
    const cycleRowSet = new Set(addedCycleRows);
    const finalChildren: WaitNodeChild[] = [];
    for (const guard of finalGuards) {
      if (cycleRowSet.has(guard)) {
        finalChildren.push({ guard, node: null, stop: 'leaf' });
      } else {
        const child = childByGuard.get(guard);
        finalChildren.push(child !== undefined ? { guard, node: child.node, stop: child.stop } : { guard, node: null, stop: 'leaf' });
      }
    }
    finalTree = { lane: rootNode.lane, children: finalChildren };
  }

  const counts = { blocked: 0, unknown: 0, clear: 0 };
  for (const guard of finalGuards) counts[guard.state] += 1;
  const firstBlocker = finalGuards[0] !== undefined && finalGuards[0].state === 'blocked' ? finalGuards[0] : null;
  const verdict: LaneWaitsVerdict = counts.blocked > 0 ? 'blocked' : counts.unknown > 0 ? 'unchecked-only' : 'ready';
  const summary = renderLaneWaitsSummary(target.placement, finalGuards);

  const closureCards = new Set<ValidCard>([target]);
  for (const key of ctx.closureVisitedKeys) {
    const card = board.byKey.get(key);
    if (card !== undefined) closureCards.add(card);
  }
  const sources = unionClosureSources(board, target, closureCards, false, finalGuards);

  const waits: LaneWaits = {
    lane: rootGlance,
    verdict,
    summary,
    counts,
    firstBlocker,
    guards: finalGuards,
    chains,
    sources,
    truncated: { nodeCap: ctx.truncatedNodeCap },
    tree: finalTree,
  };

  return {
    ok: true,
    card: target.card,
    lane: rootGlance,
    waits,
    noWaits: null,
    unblocks,
    readAtIso: renderIso(board.readAtIso),
    sources,
  };
}

type RefusalPhase = 'invalid-ref' | 'invalid-options' | 'invalid-board';

/**
 * Derive the single-lane waits-for view over a `WorkBoard` (waits-for-view plan
 * §3.2). Pure; never throws; never runs getters or Proxy traps; malformed or
 * secret-shaped input is refused with a reason code only. `board` and `ref`
 * are validated before any lookup, so malformed input always refuses before
 * `'lane-not-on-board'`.
 */
export function deriveLaneWaits(board: unknown, ref: unknown, options?: unknown): DeriveLaneWaitsResult {
  let phase: RefusalPhase = 'invalid-ref';
  try {
    phase = 'invalid-ref';
    const laneRef = validateLaneRef(ref);
    if (laneRef === null) return { ok: false, reason: 'invalid-ref' };

    phase = 'invalid-options';
    const opts = validateOptions(options);
    if (opts === null) return { ok: false, reason: 'invalid-options' };

    phase = 'invalid-board';
    const validBoard = validateBoard(board);
    if (validBoard === null) return { ok: false, reason: 'invalid-board' };

    return deriveFromValid(validBoard, laneRef, opts);
  } catch {
    return { ok: false, reason: phase };
  }
}
