/**
 * The base branch a work order and its lane run work against (lane CB1).
 * The only accepted values are the string `main` or a `chain/<name>` where
 * the name is one or more segments of `[a-z0-9]+` separated by a single `-`,
 * at most 200 characters in total. Parsing is strict: no trim, no case fold,
 * no extra slash, no leading, trailing or doubled dash. An unparsable value
 * is `undefined`, never a default; the resolvers, not the parser, substitute
 * `main` for an absent key.
 */

import { containsSecretShape } from '@fleet/shared';

import { isPlainRecordObject } from './record-schema-version.js';

export const DEFAULT_BASE_BRANCH = 'main' as const;

/** A declared base branch: `main`, or a chain name under `chain/`. */
export type BaseBranchValue = typeof DEFAULT_BASE_BRANCH | `chain/${string}`;

/**
 * The fixed sentence every refusing caller uses (the entity name prefixes it);
 * the supplied value is never echoed.
 */
export const BASE_BRANCH_INVALID_MESSAGE = 'baseBranch must be main or chain/<lowercase-dashes>';

const MAIN_PATTERN = /^main$/;
const CHAIN_PATTERN = /^chain\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LENGTH = 200;

/**
 * Classify a value as a declared base branch; anything else — a non-string,
 * an empty string, a wrong case, a doubled or trailing dash, a second slash,
 * an over-long name — is `undefined`, never a default.
 */
export function parseBaseBranch(value: unknown): BaseBranchValue | undefined {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) {
    return undefined;
  }
  if (MAIN_PATTERN.test(value) || CHAIN_PATTERN.test(value)) {
    return value as BaseBranchValue;
  }
  return undefined;
}

/**
 * The resolved base branch of a stored record: its own `baseBranch` when it
 * parses, `main` otherwise. Own property only: an inherited `baseBranch` (a
 * polluted prototype) never labels a record.
 */
function resolveBaseBranchOf(record: { readonly baseBranch?: unknown }): BaseBranchValue {
  if (!Object.hasOwn(record, 'baseBranch')) {
    return DEFAULT_BASE_BRANCH;
  }
  return parseBaseBranch(record.baseBranch) ?? DEFAULT_BASE_BRANCH;
}

/**
 * The resolved base branch of a stored work order: its own `baseBranch` when
 * it is a safe branch name, `main` otherwise. Own property only: an inherited
 * `baseBranch` (a polluted prototype) never labels a record.
 */
export function resolveWorkOrderBaseBranch(record: { readonly baseBranch?: unknown }): string {
  if (!Object.hasOwn(record, 'baseBranch')) {
    return DEFAULT_BASE_BRANCH;
  }
  const value: unknown = record.baseBranch;
  return isSafeWorkOrderBranchName(value) ? value : DEFAULT_BASE_BRANCH;
}

/** The lane run's resolved base branch; absent or unparsable reads as `main`. */
export function resolveLaneRunBaseBranch(record: { readonly baseBranch?: unknown }): BaseBranchValue {
  return resolveBaseBranchOf(record);
}

/**
 * A branch name safe to use as a work order base branch. Bounded to 200 code
 * units, plain git-ref characters only, no leading `-` or `/`, no trailing
 * `/`, `.` or `.lock`, no `..` or `//`, and free of secret shapes. The length
 * bound is checked before the regex and the secret scan so an over-long input
 * is refused in O(1) instead of being scanned.
 */
const SAFE_WORK_ORDER_BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/;

export function isSafeWorkOrderBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) {
    return false;
  }
  if (!SAFE_WORK_ORDER_BRANCH_PATTERN.test(value)) {
    return false;
  }
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) {
    return false;
  }
  if (value.includes('..') || value.includes('//')) {
    return false;
  }
  return !containsSecretShape(value);
}

export type ProfileDefaultBranchResult =
  | { readonly ok: true; readonly baseBranch: string }
  | { readonly ok: false; readonly reason: 'malformed-profile' | 'unsupported-profile-base' };

const FORBIDDEN_PROFILE_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/**
 * Resolve a project profile's `defaultBranch` into a work order base branch.
 * Nothing throws and no accessor ever runs: the profile is validated as a
 * plain record with no prototype-polluting own keys, and `defaultBranch` is
 * read only through its own property descriptor. An absent, `undefined` or
 * `null` `defaultBranch` falls back to `main`; a non-safe value is a malformed
 * profile, and a safe value that is not `main` or `chain/<name>` is refused
 * with a typed reason — the rest of the system (LaneRun, WorkspacePort,
 * StartLaneRunUseCase, PlanRelaunchUseCase) supports only those two shapes
 * until slice RP1b, so a `staging` base is refused here rather than persisted
 * and later silently coerced to `main`.
 */
export function resolveProfileDefaultBranch(profile: unknown): ProfileDefaultBranchResult {
  try {
    if (!isPlainRecordObject(profile)) {
      return { ok: false, reason: 'malformed-profile' };
    }
    for (const key of FORBIDDEN_PROFILE_KEYS) {
      if (Object.getOwnPropertyDescriptor(profile, key) !== undefined) {
        return { ok: false, reason: 'malformed-profile' };
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(profile, 'defaultBranch');
    if (descriptor === undefined) {
      return { ok: true, baseBranch: DEFAULT_BASE_BRANCH };
    }
    if (!('value' in descriptor)) {
      return { ok: false, reason: 'malformed-profile' };
    }
    if (descriptor.value === undefined || descriptor.value === null) {
      return { ok: true, baseBranch: DEFAULT_BASE_BRANCH };
    }
    if (isSafeWorkOrderBranchName(descriptor.value)) {
      // RP1: only `main` and `chain/<name>` have downstream support; a safe
      // but unsupported declared branch (for example `staging`) is refused
      // here so it is never persisted and never coerced to `main` later.
      const parsed = parseBaseBranch(descriptor.value);
      if (parsed === undefined) {
        return { ok: false, reason: 'unsupported-profile-base' };
      }
      return { ok: true, baseBranch: parsed };
    }
    return { ok: false, reason: 'malformed-profile' };
  } catch {
    return { ok: false, reason: 'malformed-profile' };
  }
}
