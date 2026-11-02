/**
 * The idempotency keys of plan §3.2 and §3.8: step keys
 * `<runId>/r<round>/<step>/<seatIndex>[/a<n>][@<head12>][/retry<n>]` (including
 * `reconcile`), the control keys `<runId>/stop@<via>` (graceful) and
 * `<runId>/stop-force@<via>` (force), with via web or cli and the mode read from
 * the key, `<runId>/park/<n>/resume@<via>` (with via web or cli), the request channel's
 * `request/<requestId>`, the reaper's `reaper/<subjectId>/<kind>@<findingId>`,
 * the premerge receipt key `<runId>/r<round>/premerge@<head12>` (KS7a-1, PR #571),
 * and the `merge/` family: `merge/<repoDigest>/<pr>/<head12>/<action>[/r<n>]`
 * for one-way actions with proof-gated retry, and
 * `merge/<repoDigest>/<pr>/<head12>/<action>/a<n>` for two-way actions
 * (daemon-tick plan §3.3).
 * Pure; builders and the parser never throw and never echo input.
 * `parseLaneRunKey(buildX(…))` always returns the same parts, and building a
 * parsed key returns the same string, except a `/r<n>` merge key: its parsed parts
 * carry no retry proof, so rebuilding one is refused by design. K1b's journal refuses
 * a second intent with the same key.
 */

import { containsSecretShape } from '@fleet/shared';
import {
  LANE_RUN_ID_PATTERN,
  LANE_RUN_KEY_ATTEMPT_RULE,
  LANE_RUN_KEY_HEAD_RULE,
  LANE_RUN_KEY_STEPS,
  LANE_RUN_MAX_ATTEMPTS,
  LANE_RUN_ONE_WAY_STEPS,
} from './lane-run-records.js';
import type { LaneRunKeyStep } from './lane-run-records.js';

export const LANE_RUN_KEY_MAX_LENGTH = 256;
export const LANE_RUN_MAX_SEAT_INDEX = 999;
export const LANE_RUN_MAX_RETRY = 9;
export const LANE_RUN_MAX_PARK_ORDINAL = 9999;
export const REQUEST_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/; // the O1b-1 ULID

/** The stop modes a stop key names (plan §3.9.1). Same values as K1-2a's RunStopMode; aliased after both merge. */
export const LANE_RUN_STOP_KEY_MODES = ['graceful', 'force'] as const;
export type LaneRunStopKeyMode = (typeof LANE_RUN_STOP_KEY_MODES)[number];

/** Where a control key came from: the web request channel or the CLI. */
export const LANE_RUN_KEY_VIAS = ['web', 'cli'] as const;
export type LaneRunKeyVia = (typeof LANE_RUN_KEY_VIAS)[number];

/** The reaper's finding kinds (plan §3.9.2). Stored data from K1b on; K10 imports this tuple, it does not redeclare it. */
export const REAPER_FINDING_KINDS = [
  'orphan-session', 'dead-attempt', 'driverless-run', 'leaked-slot', 'stale-stop', 'orphan-worktree',
  'stale-attention',
] as const;
export type ReaperFindingKind = (typeof REAPER_FINDING_KINDS)[number];

/** A record id (attempt, reservation, run, attention item) or `wt-<12 hex>` for a worktree: printable ASCII without `/` or `@`, 1–128 characters. */
export const REAPER_SUBJECT_ID_PATTERN = /^[!-.0-?A-~]{1,128}$/;

/** One-way merge actions (daemon-tick plan §3.3). Stored in merge/ keys; DT1/DT9 share these literals. */
export const MERGE_KEY_ONE_WAY_ACTIONS = ['merge-pr', 'update-branch', 'post-status'] as const;
export type MergeKeyOneWayAction = (typeof MERGE_KEY_ONE_WAY_ACTIONS)[number];

/** Two-way merge actions (daemon-tick plan §3.3); keyed with `/a<n>` (1..32). */
export const MERGE_KEY_TWO_WAY_ACTIONS = ['macos-verify', 'veto'] as const;
export type MergeKeyTwoWayAction = (typeof MERGE_KEY_TWO_WAY_ACTIONS)[number];

export const MERGE_KEY_ACTIONS = [
  ...MERGE_KEY_ONE_WAY_ACTIONS,
  ...MERGE_KEY_TWO_WAY_ACTIONS,
] as const;
export type MergeKeyAction = (typeof MERGE_KEY_ACTIONS)[number];

/** Prior final outcomes eligible to mint a proof-gated `/r<n>` retry on a one-way merge key (daemon-tick plan §3.3). */
export const MERGE_KEY_RETRYABLE_OUTCOMES = ['refused', 'not-started'] as const;
export type MergeKeyRetryableOutcome = (typeof MERGE_KEY_RETRYABLE_OUTCOMES)[number];

export const MERGE_KEY_TRANSIENT_REFUSAL_REASON = 'forge-error' as const;

const HEAD12_PATTERN = /^[0-9a-f]{12}$/;
const COMMIT_HEX_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ROUND_SEGMENT_PATTERN = /^r[0-2]$/;
const SEAT_INDEX_TEXT_PATTERN = /^(?:0|[1-9][0-9]{0,2})$/;
const ATTEMPT_SEGMENT_PATTERN = /^a[1-9][0-9]*$/;
const RETRY_SEGMENT_PATTERN = /^retry[1-9]$/;
const PARK_ORDINAL_TEXT_PATTERN = /^[1-9][0-9]*$/;
const MERGE_RETRY_SEGMENT_PATTERN = /^r[1-9]$/;
const MERGE_REASON_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface LaneRunStepKeyParts {
  readonly runId: string;
  readonly round: number;                 // 0..2
  readonly step: LaneRunKeyStep;
  readonly seatIndex: number;             // 0..999, written without leading zeros
  readonly attemptOrdinal: number | null; // 1..32; per LANE_RUN_KEY_ATTEMPT_RULE
  readonly head12: string | null;         // 12 lowercase hex; per LANE_RUN_KEY_HEAD_RULE
  readonly retry: number | null;          // 1..9; only for steps outside LANE_RUN_ONE_WAY_STEPS
}

/**
 * Read-only reconcile proof required to mint `/r<n>` on a one-way merge key (daemon-tick plan §3.3):
 * the prior key settled to a final `refused` with reason `'forge-error'` or a final `'not-started'`,
 * and `postconditionAbsent: true` attests the forge postcondition was observed absent.
 */
export interface MergeKeyRetryProof {
  readonly priorOutcome: string;
  readonly priorReasonCode?: string | null;
  readonly postconditionAbsent: boolean;
}

export interface MergeKeyParts {
  readonly repoDigest: string;            // 12 lowercase hex
  readonly pullRequest: number;           // positive safe integer (>= 1), written without leading zeros
  readonly head12: string;                // 12 lowercase hex
  readonly action: MergeKeyAction;
  readonly attemptOrdinal: number | null; // 1..32 on two-way actions; null on one-way actions
  readonly retry: number | null;          // 1..9 on one-way actions with retryProof; null elsewhere
  readonly retryProof?: MergeKeyRetryProof | null;
}

export interface ParsedMergeKeyParts {
  readonly repoDigest: string;
  readonly pullRequest: number;
  readonly head12: string;
  readonly action: MergeKeyAction;
  readonly attemptOrdinal: number | null;
  readonly retry: number | null;
}

export type ParsedLaneRunKey =
  | ({ readonly kind: 'step' } & LaneRunStepKeyParts)
  | {
      readonly kind: 'stop';
      readonly runId: string;
      readonly via: LaneRunKeyVia;
      readonly mode: LaneRunStopKeyMode;
    }
  | { readonly kind: 'resume'; readonly runId: string; readonly parkOrdinal: number; readonly via: LaneRunKeyVia }
  | { readonly kind: 'request'; readonly requestId: string }
  | {
      readonly kind: 'premerge';
      readonly runId: string;
      readonly round: number;
      readonly head12: string;
    }
  | ({ readonly kind: 'merge' } & ParsedMergeKeyParts)
  | {
      readonly kind: 'reaper';
      readonly subjectId: string;
      readonly findingKind: ReaperFindingKind;
      readonly findingId: string;
    };

export type LaneRunKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly error: string };

/** First 12 characters of a lowercase 40- or 64-hex commit id; anything else → null. */
export function head12Of(commit: unknown): string | null {
  if (typeof commit !== 'string' || !COMMIT_HEX_PATTERN.test(commit)) {
    return null;
  }
  return commit.slice(0, 12);
}

function stepKeyError(parts: LaneRunStepKeyParts): string | null {
  const { runId, round, step, seatIndex, attemptOrdinal, head12, retry } = parts;
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return 'LaneRun key runId must be run- followed by a ULID';
  }
  if (!Number.isInteger(round) || round < 0 || round > 2) {
    return 'LaneRun key round must be 0, 1 or 2';
  }
  if (!LANE_RUN_KEY_STEPS.includes(step)) {
    return 'LaneRun key step is not a known step';
  }
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > LANE_RUN_MAX_SEAT_INDEX) {
    return 'LaneRun key seatIndex must be an integer from 0 to 999';
  }
  if (
    attemptOrdinal !== null &&
    (!Number.isInteger(attemptOrdinal) || attemptOrdinal < 1 || attemptOrdinal > LANE_RUN_MAX_ATTEMPTS)
  ) {
    return 'LaneRun key attemptOrdinal must be an integer from 1 to 32';
  }
  const attemptRule = LANE_RUN_KEY_ATTEMPT_RULE[step];
  const hasAttempt = attemptOrdinal !== null;
  if ((attemptRule === 'absent' && hasAttempt) || (attemptRule === 'required' && !hasAttempt)) {
    return 'LaneRun key attemptOrdinal does not match its step';
  }
  if (head12 !== null && (typeof head12 !== 'string' || !HEAD12_PATTERN.test(head12))) {
    return 'LaneRun key head must be 12 lowercase hex characters';
  }
  const headRule = LANE_RUN_KEY_HEAD_RULE[step];
  const hasHead = head12 !== null;
  if ((headRule === 'absent' && hasHead) || (headRule === 'required' && !hasHead)) {
    return 'LaneRun key head does not match its step';
  }
  if (retry !== null && (!Number.isInteger(retry) || retry < 1 || retry > LANE_RUN_MAX_RETRY)) {
    return 'LaneRun key retry must be an integer from 1 to 9';
  }
  if (retry !== null && (LANE_RUN_ONE_WAY_STEPS as readonly LaneRunKeyStep[]).includes(step)) {
    return 'LaneRun key retry is not allowed for a one-way step';
  }
  return null;
}

export function buildLaneRunStepKey(parts: LaneRunStepKeyParts): LaneRunKeyResult {
  try {
    // Read the input once into a snapshot: refuse a value that is not a plain
    // object (null, arrays, non-objects, or a prototype other than
    // Object.prototype or null).
    if (typeof parts !== 'object' || parts === null || Array.isArray(parts)) {
      return { ok: false, error: 'LaneRun key parts must be a plain object' };
    }
    const proto = Object.getPrototypeOf(parts);
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, error: 'LaneRun key parts must be a plain object' };
    }

    // Read each expected own key through Reflect.getOwnPropertyDescriptor(...).value,
    // so no getter runs. A missing key reads as undefined.
    const read = (key: string): unknown => {
      const descriptor = Reflect.getOwnPropertyDescriptor(parts, key);
      return descriptor === undefined ? undefined : descriptor.value;
    };
    const snapshot = {
      runId: read('runId'),
      round: read('round'),
      step: read('step'),
      seatIndex: read('seatIndex'),
      attemptOrdinal: read('attemptOrdinal'),
      head12: read('head12'),
      retry: read('retry'),
    };

    // The premerge step has no seat-index key shape: its key is built by
    // laneRunPremergeKey instead (`<runId>/r<round>/premerge@<head12>`).
    if (snapshot.step === 'premerge') {
      return { ok: false, error: 'LaneRun key step premerge has no seat index' };
    }

    // Validate only the snapshot.
    const error = stepKeyError(snapshot as LaneRunStepKeyParts);
    if (error !== null) {
      return { ok: false, error };
    }

    const runId = snapshot.runId as string;
    const round = snapshot.round as number;
    const step = snapshot.step as LaneRunKeyStep;
    const seatIndex = snapshot.seatIndex as number;
    const attemptOrdinal = snapshot.attemptOrdinal as number | null;
    const head12 = snapshot.head12 as string | null;
    const retry = snapshot.retry as number | null;
    let key = runId + '/r' + round + '/' + step + '/' + seatIndex;
    if (attemptOrdinal !== null) {
      key += '/a' + attemptOrdinal;
    }
    if (head12 !== null) {
      key += '@' + head12;
    }
    if (retry !== null) {
      key += '/retry' + retry;
    }
    return { ok: true, key };
  } catch {
    // A throwing Proxy trap (or hostile descriptor) must never escape: return the
    // builder's invalid result with a fixed reason that echoes no value.
    return { ok: false, error: 'LaneRun key parts must be a plain object' };
  }
}

export function laneRunStopKey(runId: string, via: LaneRunKeyVia = 'web'): LaneRunKeyResult {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false, error: 'LaneRun key runId must be run- followed by a ULID' };
  }
  if (!LANE_RUN_KEY_VIAS.includes(via)) {
    return { ok: false, error: 'LaneRun key via must be web or cli' };
  }
  return { ok: true, key: runId + '/stop@' + via };
}

export function laneRunStopForceKey(runId: string, via: LaneRunKeyVia): LaneRunKeyResult {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false, error: 'LaneRun key runId must be run- followed by a ULID' };
  }
  if (!LANE_RUN_KEY_VIAS.includes(via)) {
    return { ok: false, error: 'LaneRun key via must be web or cli' };
  }
  return { ok: true, key: runId + '/stop-force@' + via };
}

/** The mode a parsed stop key names; null for any other key or a malformed one. */
export function stopModeOfKey(key: unknown): LaneRunStopKeyMode | null {
  const parsed = parseLaneRunKey(key);
  if (parsed === null || parsed.kind !== 'stop') {
    return null;
  }
  return parsed.mode;
}

export function reaperRepairKey(subjectId: string, kind: ReaperFindingKind, findingId: string): LaneRunKeyResult {
  if (typeof subjectId !== 'string' || !REAPER_SUBJECT_ID_PATTERN.test(subjectId)) {
    return { ok: false, error: 'LaneRun key reaper subject must be an id without / or @ of at most 128 characters' };
  }
  if (containsSecretShape(subjectId)) {
    return { ok: false, error: 'LaneRun key reaper subject contains a secret-shaped value and was refused' };
  }
  if (!REAPER_FINDING_KINDS.includes(kind)) {
    return { ok: false, error: 'LaneRun key reaper kind is not a known finding kind' };
  }
  if (typeof findingId !== 'string' || !REQUEST_ID_PATTERN.test(findingId)) {
    return { ok: false, error: 'LaneRun key reaper findingId must be a ULID' };
  }
  return { ok: true, key: 'reaper/' + subjectId + '/' + kind + '@' + findingId };
}

export function laneRunResumeKey(runId: string, parkOrdinal: number, via: LaneRunKeyVia = 'web'): LaneRunKeyResult {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false, error: 'LaneRun key runId must be run- followed by a ULID' };
  }
  if (!Number.isInteger(parkOrdinal) || parkOrdinal < 1 || parkOrdinal > LANE_RUN_MAX_PARK_ORDINAL) {
    return { ok: false, error: 'LaneRun key park ordinal must be an integer from 1 to 9999' };
  }
  if (!LANE_RUN_KEY_VIAS.includes(via)) {
    return { ok: false, error: 'LaneRun key via must be web or cli' };
  }
  return { ok: true, key: runId + '/park/' + String(parkOrdinal) + '/resume@' + via };
}

export function requestKey(requestId: string): LaneRunKeyResult {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, error: 'LaneRun key requestId must be a ULID' };
  }
  return { ok: true, key: 'request/' + requestId };
}

/**
 * The premerge receipt's key `<runId>/r<round>/premerge@<head12>` (speed plan
 * §3.6.2): no seat index, no attempt ordinal, no retry. Never throws.
 */
export function laneRunPremergeKey(runId: string, round: number, head12: string): LaneRunKeyResult {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false, error: 'LaneRun key runId must be run- followed by a ULID' };
  }
  if (!Number.isInteger(round) || round < 0 || round > 2) {
    return { ok: false, error: 'LaneRun key round must be 0, 1 or 2' };
  }
  if (typeof head12 !== 'string' || !HEAD12_PATTERN.test(head12)) {
    return { ok: false, error: 'LaneRun key head12 must be 12 lowercase hex characters' };
  }
  return { ok: true, key: runId + '/r' + round + '/premerge@' + head12 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readOwnValue(record: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function isOneWayMergeAction(action: MergeKeyAction): action is MergeKeyOneWayAction {
  return (MERGE_KEY_ONE_WAY_ACTIONS as readonly string[]).includes(action);
}

function isBoundedPositiveInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

function isValidOptionalReasonCode(reasonCode: unknown): boolean {
  if (reasonCode === undefined || reasonCode === null) {
    return true;
  }
  return typeof reasonCode === 'string' && MERGE_REASON_CODE_PATTERN.test(reasonCode);
}

function mergeKeyBaseError(parts: ParsedMergeKeyParts): string | null {
  const { repoDigest, pullRequest, head12, action } = parts;
  if (typeof repoDigest !== 'string' || !HEAD12_PATTERN.test(repoDigest)) {
    return 'LaneRun merge key repoDigest must be 12 lowercase hex characters';
  }
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    return 'LaneRun merge key pullRequest must be a positive safe integer';
  }
  if (typeof head12 !== 'string' || !HEAD12_PATTERN.test(head12)) {
    return 'LaneRun merge key head must be 12 lowercase hex characters';
  }
  if (!(MERGE_KEY_ACTIONS as readonly string[]).includes(action)) {
    return 'LaneRun merge key action is not a known merge action';
  }
  return null;
}

function mergeKeyOrdinalsError(parts: ParsedMergeKeyParts): string | null {
  const { action, attemptOrdinal, retry } = parts;
  if (attemptOrdinal !== null && !isBoundedPositiveInt(attemptOrdinal, LANE_RUN_MAX_ATTEMPTS)) {
    return 'LaneRun merge key attemptOrdinal must be an integer from 1 to 32';
  }
  if (retry !== null && !isBoundedPositiveInt(retry, LANE_RUN_MAX_RETRY)) {
    return 'LaneRun merge key retry must be an integer from 1 to 9';
  }
  if (isOneWayMergeAction(action)) {
    if (attemptOrdinal !== null) {
      return 'LaneRun merge key attemptOrdinal is not allowed for a one-way action';
    }
    return null;
  }
  if (attemptOrdinal === null) {
    return 'LaneRun merge key attemptOrdinal is required for a two-way action';
  }
  if (retry !== null) {
    return 'LaneRun merge key retry is not allowed for a two-way action';
  }
  return null;
}

function mergeRetryPriorResultError(priorOutcome: unknown, priorReasonCode: unknown): string | null {
  if (priorOutcome === 'refused') {
    if (priorReasonCode !== MERGE_KEY_TRANSIENT_REFUSAL_REASON) {
      return 'LaneRun merge key retry after refused requires priorReasonCode forge-error';
    }
    return null;
  }
  if (priorOutcome === 'not-started') {
    if (!isValidOptionalReasonCode(priorReasonCode)) {
      return 'LaneRun merge key retry priorReasonCode must be a reason token or null';
    }
    return null;
  }
  return 'LaneRun merge key retry is only allowed after refused forge-error or not-started';
}

function mergeRetryProofError(retry: number | null, rawProof: unknown): string | null {
  if (retry === null) {
    if (rawProof !== undefined && rawProof !== null) {
      return 'LaneRun merge key retryProof is only allowed when retry is set';
    }
    return null;
  }
  if (!isPlainObject(rawProof)) {
    return 'LaneRun merge key retry requires a postcondition-absent proof';
  }
  if (readOwnValue(rawProof, 'postconditionAbsent') !== true) {
    return 'LaneRun merge key retry requires postconditionAbsent to be true';
  }
  return mergeRetryPriorResultError(
    readOwnValue(rawProof, 'priorOutcome'),
    readOwnValue(rawProof, 'priorReasonCode'),
  );
}

function formatMergeKey(parts: ParsedMergeKeyParts): LaneRunKeyResult {
  let key =
    'merge/' +
    parts.repoDigest +
    '/' +
    String(parts.pullRequest) +
    '/' +
    parts.head12 +
    '/' +
    parts.action;
  if (parts.attemptOrdinal !== null) {
    key += '/a' + String(parts.attemptOrdinal);
  }
  if (parts.retry !== null) {
    key += '/r' + String(parts.retry);
  }
  if (key.length > LANE_RUN_KEY_MAX_LENGTH) {
    return { ok: false, error: 'LaneRun merge key exceeds maximum length' };
  }
  return { ok: true, key };
}

export function buildMergeKey(parts: MergeKeyParts): LaneRunKeyResult {
  try {
    if (!isPlainObject(parts)) {
      return { ok: false, error: 'LaneRun merge key parts must be a plain object' };
    }
    const snapshot: ParsedMergeKeyParts = {
      repoDigest: readOwnValue(parts, 'repoDigest') as string,
      pullRequest: readOwnValue(parts, 'pullRequest') as number,
      head12: readOwnValue(parts, 'head12') as string,
      action: readOwnValue(parts, 'action') as MergeKeyAction,
      attemptOrdinal: readOwnValue(parts, 'attemptOrdinal') as number | null,
      retry: readOwnValue(parts, 'retry') as number | null,
    };
    const retryProof = readOwnValue(parts, 'retryProof');
    const error =
      mergeKeyBaseError(snapshot) ??
      mergeKeyOrdinalsError(snapshot) ??
      mergeRetryProofError(snapshot.retry, retryProof);
    if (error !== null) {
      return { ok: false, error };
    }
    return formatMergeKey(snapshot);
  } catch {
    return { ok: false, error: 'LaneRun merge key parts must be a plain object' };
  }
}

function parseStepKeySegments(segments: string[], key: string): ParsedLaneRunKey | null {
  if (!ROUND_SEGMENT_PATTERN.test(segments[1])) {
    return null;
  }
  const round = Number(segments[1].slice(1));
  const step = segments[2] as LaneRunKeyStep;
  if (!LANE_RUN_KEY_STEPS.includes(step)) {
    return null;
  }
  let seatIndex: number;
  let attemptOrdinal: number | null = null;
  let head12: string | null = null;
  let retry: number | null = null;
  if (LANE_RUN_KEY_ATTEMPT_RULE[step] === 'required') {
    if (segments.length !== 5 || !SEAT_INDEX_TEXT_PATTERN.test(segments[3])) {
      return null;
    }
    seatIndex = Number(segments[3]);
    const tail = segments[4];
    const atIndex = tail.indexOf('@');
    const attemptText = atIndex === -1 ? tail : tail.slice(0, atIndex);
    head12 = atIndex === -1 ? null : tail.slice(atIndex + 1);
    if (!ATTEMPT_SEGMENT_PATTERN.test(attemptText)) {
      return null;
    }
    attemptOrdinal = Number(attemptText.slice(1));
  } else {
    const tail = segments[3];
    const atIndex = tail.indexOf('@');
    const seatText = atIndex === -1 ? tail : tail.slice(0, atIndex);
    head12 = atIndex === -1 ? null : tail.slice(atIndex + 1);
    if (!SEAT_INDEX_TEXT_PATTERN.test(seatText)) {
      return null;
    }
    seatIndex = Number(seatText);
    if (segments.length === 5) {
      if (!RETRY_SEGMENT_PATTERN.test(segments[4])) {
        return null;
      }
      retry = Number(segments[4].slice(5));
    }
  }
  const built = buildLaneRunStepKey({ runId: segments[0], round, step, seatIndex, attemptOrdinal, head12, retry });
  if (!built.ok || built.key !== key) {
    return null;
  }
  return { kind: 'step', runId: segments[0], round, step, seatIndex, attemptOrdinal, head12, retry };
}

function parseStopKeySegments(segments: string[], key: string): ParsedLaneRunKey | null {
  const atIndex = segments[1].indexOf('@');
  if (atIndex === -1 || segments[1].indexOf('@', atIndex + 1) !== -1) {
    return null;
  }
  const action = segments[1].slice(0, atIndex);
  const via = segments[1].slice(atIndex + 1);
  if (!LANE_RUN_KEY_VIAS.includes(via as LaneRunKeyVia)) {
    return null;
  }
  let mode: LaneRunStopKeyMode;
  let built: LaneRunKeyResult;
  if (action === 'stop') {
    mode = 'graceful';
    built = laneRunStopKey(segments[0], via as LaneRunKeyVia);
  } else if (action === 'stop-force') {
    mode = 'force';
    built = laneRunStopForceKey(segments[0], via as LaneRunKeyVia);
  } else {
    return null;
  }
  if (!built.ok || built.key !== key) {
    return null;
  }
  return { kind: 'stop', runId: segments[0], via: via as LaneRunKeyVia, mode };
}

/** The three-segment premerge key `<runId>/r<round>/premerge@<head12>`; null for any other shape. */
function parsePremergeKeySegments(segments: string[], key: string): ParsedLaneRunKey | null {
  if (segments[0] === 'reaper') {
    return null;
  }
  if (!ROUND_SEGMENT_PATTERN.test(segments[1])) {
    return null;
  }
  const tail = segments[2];
  const atIndex = tail.indexOf('@');
  if (atIndex === -1 || tail.indexOf('@', atIndex + 1) !== -1) {
    return null;
  }
  if (tail.slice(0, atIndex) !== 'premerge') {
    return null;
  }
  const round = Number(segments[1].slice(1));
  const head12 = tail.slice(atIndex + 1);
  const built = laneRunPremergeKey(segments[0], round, head12);
  if (!built.ok || built.key !== key) {
    return null;
  }
  return { kind: 'premerge', runId: segments[0], round, head12 };
}

function parseReaperKeySegments(segments: string[], key: string): ParsedLaneRunKey | null {
  if (segments[0] !== 'reaper') {
    return null;
  }
  const atIndex = segments[2].indexOf('@');
  if (atIndex === -1 || segments[2].indexOf('@', atIndex + 1) !== -1) {
    return null;
  }
  const kind = segments[2].slice(0, atIndex);
  const findingId = segments[2].slice(atIndex + 1);
  const built = reaperRepairKey(segments[1], kind as ReaperFindingKind, findingId);
  if (!built.ok || built.key !== key) {
    return null;
  }
  return { kind: 'reaper', subjectId: segments[1], findingKind: kind as ReaperFindingKind, findingId };
}

function readMergeTailOrdinals(
  action: MergeKeyAction,
  tail: string | undefined,
): { readonly attemptOrdinal: number | null; readonly retry: number | null } | null {
  if (isOneWayMergeAction(action)) {
    if (tail === undefined) {
      return { attemptOrdinal: null, retry: null };
    }
    if (!MERGE_RETRY_SEGMENT_PATTERN.test(tail)) {
      return null;
    }
    return { attemptOrdinal: null, retry: Number(tail.slice(1)) };
  }
  if (tail === undefined || !ATTEMPT_SEGMENT_PATTERN.test(tail)) {
    return null;
  }
  return { attemptOrdinal: Number(tail.slice(1)), retry: null };
}

function parseMergeKeySegments(segments: string[], key: string): ParsedLaneRunKey | null {
  if (segments.length !== 5 && segments.length !== 6) {
    return null;
  }
  if (!PARK_ORDINAL_TEXT_PATTERN.test(segments[2])) {
    return null;
  }
  const action = segments[4] as MergeKeyAction;
  if (!(MERGE_KEY_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  const ordinals = readMergeTailOrdinals(action, segments[5]);
  if (ordinals === null) {
    return null;
  }
  const parts: ParsedMergeKeyParts = {
    repoDigest: segments[1],
    pullRequest: Number(segments[2]),
    head12: segments[3],
    action,
    attemptOrdinal: ordinals.attemptOrdinal,
    retry: ordinals.retry,
  };
  if (mergeKeyBaseError(parts) !== null || mergeKeyOrdinalsError(parts) !== null) {
    return null;
  }
  const formatted = formatMergeKey(parts);
  if (!formatted.ok || formatted.key !== key) {
    return null;
  }
  return { kind: 'merge', ...parts };
}

function parseRequestKeySegments(segments: string[], key: string): ParsedLaneRunKey | null {
  const built = requestKey(segments[1]);
  if (!built.ok || built.key !== key) {
    return null;
  }
  return { kind: 'request', requestId: segments[1] };
}

function parseResumeKeySegments(segments: string[], key: string): ParsedLaneRunKey | null {
  if (!PARK_ORDINAL_TEXT_PATTERN.test(segments[2])) {
    return null;
  }
  const atIndex = segments[3].indexOf('@');
  if (atIndex === -1 || segments[3].indexOf('@', atIndex + 1) !== -1) {
    return null;
  }
  const action = segments[3].slice(0, atIndex);
  const via = segments[3].slice(atIndex + 1);
  if (action !== 'resume' || !LANE_RUN_KEY_VIAS.includes(via as LaneRunKeyVia)) {
    return null;
  }
  const parkOrdinal = Number(segments[2]);
  const built = laneRunResumeKey(segments[0], parkOrdinal, via as LaneRunKeyVia);
  if (!built.ok || built.key !== key) {
    return null;
  }
  return { kind: 'resume', runId: segments[0], parkOrdinal, via: via as LaneRunKeyVia };
}

export function parseLaneRunKey(key: unknown): ParsedLaneRunKey | null {
  if (typeof key !== 'string' || key.length > LANE_RUN_KEY_MAX_LENGTH) {
    return null;
  }
  const segments = key.split('/');
  if (segments[0] === 'merge') {
    return parseMergeKeySegments(segments, key);
  }
  if (segments.length === 2) {
    if (segments[0] === 'request') {
      return parseRequestKeySegments(segments, key);
    }
    return parseStopKeySegments(segments, key);
  }
  if (segments.length === 3) {
    const premerge = parsePremergeKeySegments(segments, key);
    if (premerge !== null) {
      return premerge;
    }
    return parseReaperKeySegments(segments, key);
  }
  if (segments.length === 4 && segments[1] === 'park') {
    return parseResumeKeySegments(segments, key);
  }
  if (segments.length === 4 || segments.length === 5) {
    return parseStepKeySegments(segments, key);
  }
  return null;
}
