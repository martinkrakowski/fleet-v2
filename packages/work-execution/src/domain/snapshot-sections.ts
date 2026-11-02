/**
 * The pure snapshot-section contract (plan §5.3, §5.4): one publisher per
 * section pushes a token-only snapshot that replaces only that section's key
 * in a staged read projection and serves it with its time. Paths, step text
 * and messages cannot be represented as tokens; every retained string passes
 * the shared secret-shape scan. Never throws, never performs I/O; time enters
 * only through `pushedAtIso`. Each rule id below names one test in
 * `__tests__/snapshot-sections.test.ts`.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { parseTimeMs } from './work-board-facts.js';

export const SNAPSHOT_SECTIONS = ['running', 'train', 'parks', 'halt'] as const;
export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number];

/** One pushed section snapshot: tokens only, no paths, no step text, no messages. */
export interface SectionSnapshotPush {
  readonly section: SnapshotSection;
  readonly revision: number; // positive safe integer, increasing per publisher
  readonly tokens: readonly string[]; // each a non-empty string token
  readonly pushedAtIso: string;
}

/** The projection holds at most one entry per section key: its tokens and its time. */
export interface SnapshotProjectionEntry {
  readonly revision: number;
  readonly tokens: readonly string[];
  readonly pushedAtIso: string;
}
export type SnapshotProjection = Readonly<Partial<Record<SnapshotSection, SnapshotProjectionEntry>>>;

export type ParseSnapshotPushResult =
  | { readonly ok: true; readonly push: SectionSnapshotPush }
  | {
      readonly ok: false;
      readonly reason:
        | 'not-an-object'
        | 'unknown-section'
        | 'extra-fields'
        | 'invalid-revision'
        | 'tokens-not-tokens'
        | 'invalid-pushed-at'
        | 'secret-shaped';
    };

export type ApplySnapshotPushResult =
  | { readonly outcome: 'applied' }
  | { readonly outcome: 'refused'; readonly reason: 'non-increasing-revision' };

export type SnapshotSectionReading =
  | { readonly state: 'fresh'; readonly tokens: readonly string[]; readonly pushedAtIso: string }
  | { readonly state: 'stale' | 'never-pushed'; readonly pushedAtIso: null };

/**
 * A snapshot token grammar: a compact identifier of 1–128 characters drawn from
 * letters, digits and the safe separators `-`, `_`, `.`, `:`, never doubled or
 * leading/trailing. Paths (any `/`), step text and messages (whitespace or
 * other punctuation) cannot be expressed.
 */
const SNAPSHOT_TOKEN_PATTERN = /^[A-Za-z0-9]+(?:[-_.:][A-Za-z0-9]+)*$/;
const SNAPSHOT_TOKEN_MAX_LENGTH = 128;

const SNAPSHOT_PUSH_FIELDS: ReadonlySet<string> = new Set(['section', 'revision', 'tokens', 'pushedAtIso']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSnapshotSection(value: unknown): value is SnapshotSection {
  return typeof value === 'string' && (SNAPSHOT_SECTIONS as readonly string[]).includes(value);
}

/** True when a string matches the shared secret-shape check or any LANE_DIFF_SECRET_PATTERNS regex. */
function isSecretShaped(text: string): boolean {
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

function isToken(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SNAPSHOT_TOKEN_MAX_LENGTH &&
    SNAPSHOT_TOKEN_PATTERN.test(value)
  );
}

export function parseSnapshotPush(input: unknown): ParseSnapshotPushResult {
  if (!isPlainObject(input)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const section = input.section;
  if (!isSnapshotSection(section)) {
    return { ok: false, reason: 'unknown-section' };
  }
  for (const key of Object.keys(input)) {
    if (!SNAPSHOT_PUSH_FIELDS.has(key)) {
      return { ok: false, reason: 'extra-fields' };
    }
  }
  const revision = input.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return { ok: false, reason: 'invalid-revision' };
  }
  const rawTokens = input.tokens;
  if (!Array.isArray(rawTokens) || rawTokens.some((token) => !isToken(token))) {
    return { ok: false, reason: 'tokens-not-tokens' };
  }
  const pushedAtIso = input.pushedAtIso;
  if (typeof pushedAtIso !== 'string') {
    return { ok: false, reason: 'invalid-pushed-at' };
  }
  for (const token of rawTokens) {
    if (isSecretShaped(token)) {
      return { ok: false, reason: 'secret-shaped' };
    }
  }
  if (isSecretShaped(pushedAtIso)) {
    return { ok: false, reason: 'secret-shaped' };
  }
  if (parseTimeMs(pushedAtIso) === null) {
    return { ok: false, reason: 'invalid-pushed-at' };
  }
  return { ok: true, push: { section, revision, tokens: [...rawTokens], pushedAtIso } };
}

export function applySnapshotPush(
  projection: SnapshotProjection,
  push: SectionSnapshotPush,
): { next: SnapshotProjection; result: ApplySnapshotPushResult } {
  const current = projection[push.section];
  if (current !== undefined && current.revision >= push.revision) {
    return { next: projection, result: { outcome: 'refused', reason: 'non-increasing-revision' } };
  }
  const next: SnapshotProjection = {
    ...projection,
    [push.section]: {
      revision: push.revision,
      tokens: [...push.tokens],
      pushedAtIso: push.pushedAtIso,
    },
  };
  return { next, result: { outcome: 'applied' } };
}

export function readSnapshotSection(projection: SnapshotProjection, section: SnapshotSection): SnapshotSectionReading {
  const entry = projection[section];
  if (entry !== undefined) {
    return { state: 'fresh', tokens: [...entry.tokens], pushedAtIso: entry.pushedAtIso };
  }
  return { state: 'never-pushed', pushedAtIso: null };
}
