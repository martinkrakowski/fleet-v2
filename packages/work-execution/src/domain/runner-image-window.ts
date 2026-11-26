/**
 * Pure compatibility-window decider for runner images (rolling upgrade guard).
 * A run may only be placed on a host whose runner image version parses to
 * `<major>.<minor>` and lies inside the supported `[min, max]` window. Every
 * reader validates through own property descriptors, so no getter ever runs.
 * Pure: no clock, no I/O, never throws, never mutates an input, never echoes a
 * refused value.
 */

import { isPlainRecordObject } from './record-schema-version.js';

/** A runner image version as two non-negative safe integers. */
export interface RunnerImageVersion {
  readonly major: number;
  readonly minor: number;
}

/** The inclusive supported window for runner image versions, `min <= max`. */
export interface CompatibilityWindow {
  readonly min: RunnerImageVersion;
  readonly max: RunnerImageVersion;
}

/** Why an image is not schedulable. */
export type ImageSchedulableRejectionReason = 'below-window' | 'above-window' | 'invalid-input';

export type ImageSchedulableDecision =
  | { readonly schedulable: true }
  | { readonly schedulable: false; readonly reason: ImageSchedulableRejectionReason };

/** Why a version string was refused. */
export type RunnerImageVersionParseError =
  | 'invalid-type'
  | 'too-long'
  | 'control-character'
  | 'invalid-format';

export type RunnerImageVersionParseResult =
  | { readonly ok: true; readonly version: RunnerImageVersion }
  | { readonly ok: false; readonly reason: RunnerImageVersionParseError };

const MAX_TEXT_LENGTH = 32;
/** \u0000-\u001f plus \u007f: every ASCII control character. Built at runtime
 * from char codes so no literal control character appears in source. */
const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}]`,
);
/** One segment: `0` or `[1-9][0-9]{0,5}` — no sign, no leading zero, at most 6 digits. */
const SEGMENT_PATTERN = /^(?:0|[1-9][0-9]{0,5})$/;

const VERSION_KEYS = ['major', 'minor'] as const;

/**
 * Parse a runner image version string of the exact form `<major>.<minor>`.
 * Cost bound: the `text.length > 32` pre-gate is O(1) and bounds every
 * subsequent scan to at most 32 characters, so the whole call is O(1) time
 * and space. Never throws.
 */
export function parseRunnerImageVersion(text: unknown): RunnerImageVersionParseResult {
  if (typeof text !== 'string') {
    return { ok: false, reason: 'invalid-type' };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  if (CONTROL_CHARACTER_PATTERN.test(text)) {
    return { ok: false, reason: 'control-character' };
  }
  const dot = text.indexOf('.');
  if (dot < 0) {
    return { ok: false, reason: 'invalid-format' };
  }
  const majorText = text.slice(0, dot);
  const minorText = text.slice(dot + 1);
  if (!SEGMENT_PATTERN.test(majorText) || !SEGMENT_PATTERN.test(minorText)) {
    return { ok: false, reason: 'invalid-format' };
  }
  if (minorText.includes('.')) {
    return { ok: false, reason: 'invalid-format' };
  }
  const major = Number(majorText);
  const minor = Number(minorText);
  return { ok: true, version: { major, minor } };
}

/**
 * Decide whether `imageVersion` may run on a host whose runner image must sit
 * inside `window`. Any unknown, missing, malformed or inverted input is
 * `'invalid-input'`; a valid version outside the window is `'below-window'`
 * or `'above-window'`. Cost bound: O(1) for valid two-key objects —
 * `Reflect.ownKeys` is the one unavoidable engine-level O(K) enumeration and
 * its count is checked immediately, before any descriptor read. Never throws
 * (throwing Proxy traps are caught) and never runs a getter.
 */
export function decideImageSchedulable(window: unknown, imageVersion: unknown): ImageSchedulableDecision {
  try {
    return decideImageSchedulableUnchecked(window, imageVersion);
  } catch {
    return { schedulable: false, reason: 'invalid-input' };
  }
}

function decideImageSchedulableUnchecked(
  window: unknown,
  imageVersion: unknown,
): ImageSchedulableDecision {
  const min = readVersionField(window, 'min');
  const max = readVersionField(window, 'max');
  if (min === null || max === null) {
    return { schedulable: false, reason: 'invalid-input' };
  }
  const version = readRunnerImageVersion(imageVersion);
  if (version === null) {
    return { schedulable: false, reason: 'invalid-input' };
  }
  if (compareVersions(min, max) > 0) {
    return { schedulable: false, reason: 'invalid-input' };
  }
  if (compareVersions(version, min) < 0) {
    return { schedulable: false, reason: 'below-window' };
  }
  if (compareVersions(version, max) > 0) {
    return { schedulable: false, reason: 'above-window' };
  }
  return { schedulable: true };
}

/** Compare `major`, then `minor`: negative when `a < b`, positive when `a > b`, 0 when equal. */
function compareVersions(a: RunnerImageVersion, b: RunnerImageVersion): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  return 0;
}

/** Read `window.min` / `window.max` as a version record through descriptors. */
function readVersionField(window: unknown, key: 'min' | 'max'): RunnerImageVersion | null {
  if (!isPlainRecordObject(window)) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(window);
  if (ownKeys.length !== 2) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(window, key);
  if (descriptor === undefined || !descriptor.enumerable) {
    return null;
  }
  return readRunnerImageVersion(descriptor.value);
}

/** Read `{ major, minor }` exactly, through descriptors, without running any getter. */
function readRunnerImageVersion(value: unknown): RunnerImageVersion | null {
  if (!isPlainRecordObject(value)) {
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== VERSION_KEYS.length) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !VERSION_KEYS.includes(key as (typeof VERSION_KEYS)[number])) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      return null;
    }
    out[key] = descriptor.value;
  }
  const major = out.major;
  const minor = out.minor;
  if (!isNonNegativeSafeInteger(major) || !isNonNegativeSafeInteger(minor)) {
    return null;
  }
  return { major, minor };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
