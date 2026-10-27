/**
 * The idempotency keys of plan §3.2 and §3.8: step keys
 * `<runId>/r<round>/<step>/<seatIndex>[/a<n>][@<head12>][/retry<n>]`, the control keys
 * `<runId>/stop@web` and `<runId>/park/<n>/resume@web`, and the request channel's
 * `request/<requestId>`. Pure; builders and the parser never throw and never echo
 * input. `parseLaneRunKey(buildX(…))` always returns the same parts, and building a
 * parsed key returns the same string. K1b's journal refuses a second intent with the
 * same key.
 */

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

const HEAD12_PATTERN = /^[0-9a-f]{12}$/;
const COMMIT_HEX_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ROUND_SEGMENT_PATTERN = /^r[0-2]$/;
const SEAT_INDEX_TEXT_PATTERN = /^(?:0|[1-9][0-9]{0,2})$/;
const ATTEMPT_SEGMENT_PATTERN = /^a[1-9][0-9]*$/;
const RETRY_SEGMENT_PATTERN = /^retry[1-9]$/;
const PARK_ORDINAL_TEXT_PATTERN = /^[1-9][0-9]*$/;

export interface LaneRunStepKeyParts {
  readonly runId: string;
  readonly round: number;                 // 0..2
  readonly step: LaneRunKeyStep;
  readonly seatIndex: number;             // 0..999, written without leading zeros
  readonly attemptOrdinal: number | null; // 1..32; per LANE_RUN_KEY_ATTEMPT_RULE
  readonly head12: string | null;         // 12 lowercase hex; per LANE_RUN_KEY_HEAD_RULE
  readonly retry: number | null;          // 1..9; only for steps outside LANE_RUN_ONE_WAY_STEPS
}

export type ParsedLaneRunKey =
  | ({ readonly kind: 'step' } & LaneRunStepKeyParts)
  | { readonly kind: 'stop'; readonly runId: string; readonly via: 'web' }
  | { readonly kind: 'resume'; readonly runId: string; readonly parkOrdinal: number; readonly via: 'web' }
  | { readonly kind: 'request'; readonly requestId: string };

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

export function laneRunStopKey(runId: string): LaneRunKeyResult {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false, error: 'LaneRun key runId must be run- followed by a ULID' };
  }
  return { ok: true, key: runId + '/stop@web' };
}

export function laneRunResumeKey(runId: string, parkOrdinal: number): LaneRunKeyResult {
  if (typeof runId !== 'string' || !LANE_RUN_ID_PATTERN.test(runId)) {
    return { ok: false, error: 'LaneRun key runId must be run- followed by a ULID' };
  }
  if (!Number.isInteger(parkOrdinal) || parkOrdinal < 1 || parkOrdinal > LANE_RUN_MAX_PARK_ORDINAL) {
    return { ok: false, error: 'LaneRun key park ordinal must be an integer from 1 to 9999' };
  }
  return { ok: true, key: runId + '/park/' + String(parkOrdinal) + '/resume@web' };
}

export function requestKey(requestId: string): LaneRunKeyResult {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, error: 'LaneRun key requestId must be a ULID' };
  }
  return { ok: true, key: 'request/' + requestId };
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

export function parseLaneRunKey(key: unknown): ParsedLaneRunKey | null {
  if (typeof key !== 'string' || key.length > LANE_RUN_KEY_MAX_LENGTH) {
    return null;
  }
  const segments = key.split('/');

  if (segments.length === 2) {
    if (segments[0] === 'request') {
      const built = requestKey(segments[1]);
      return built.ok && built.key === key
        ? { kind: 'request', requestId: segments[1] }
        : null;
    }
    if (segments[1] === 'stop@web') {
      const built = laneRunStopKey(segments[0]);
      return built.ok && built.key === key
        ? { kind: 'stop', runId: segments[0], via: 'web' }
        : null;
    }
    return null;
  }

  if (segments.length === 4 && segments[1] === 'park') {
    if (segments[3] !== 'resume@web' || !PARK_ORDINAL_TEXT_PATTERN.test(segments[2])) {
      return null;
    }
    const parkOrdinal = Number(segments[2]);
    const built = laneRunResumeKey(segments[0], parkOrdinal);
    return built.ok && built.key === key
      ? { kind: 'resume', runId: segments[0], parkOrdinal, via: 'web' }
      : null;
  }

  if (segments.length === 4 || segments.length === 5) {
    return parseStepKeySegments(segments, key);
  }

  return null;
}
