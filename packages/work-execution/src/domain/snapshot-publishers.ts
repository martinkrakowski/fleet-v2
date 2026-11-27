/**
 * Pure, token-only snapshot builders for the lanes board's `running`, `train`
 * and `parks` sections (lanes-board plan §4, §5.1, §5.3, §5.4). A builder reads
 * already-gathered facts and returns the `SectionSnapshotPush` a publisher would
 * push; it never reads a store, never writes state, never performs I/O and never
 * throws. Time enters only through `pushedAtIso`.
 *
 * Hostile input: every builder reads its untrusted input through
 * `snapshotPlainData` (the injected `isProxy` runs BEFORE any reflection, so no
 * Proxy trap and no getter ever runs) bounded by this unit's own limits. The
 * length of every array is gated in O(1) before any key enumeration; the single
 * `Reflect.ownKeys` per record is bounded by `maxKeys`. Own keys `__proto__`,
 * `constructor` and `prototype` are refused on every record. A refusal carries a
 * reason code only, never an input value.
 */

import { snapshotPlainData } from '@fleet/shared';
import type { IsProxy, PlainDataLimits } from '@fleet/shared';
import { LANE_RUN_PARK_REASONS } from './lane-run-records.js';
import {
  MERGE_PARK_REASONS,
  MERGE_QUEUE_ENTRY_STATES,
  MERGE_QUEUE_TERMINAL_STATES,
} from './merge-queue-records.js';
import { readBoundedDenseArray } from './plain-record-reads.js';
import { parseSnapshotPush } from './snapshot-sections.js';
import type { SectionSnapshotPush } from './snapshot-sections.js';
import { parseTimeMs } from './work-board-facts.js';

export const SNAPSHOT_PUBLISHER_MAX_RECORDS = 500;
export const SNAPSHOT_PUBLISHER_MAX_TOKENS = 1000;

export const SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 6,
  maxKeys: 32,
  maxArrayLength: SNAPSHOT_PUBLISHER_MAX_RECORDS,
  maxNodes: 8192,
  maxStringLength: 256,
});

export const PUBLISHER_SECTIONS = ['running', 'train', 'parks'] as const;
export type PublisherSection = (typeof PUBLISHER_SECTIONS)[number];

export type SnapshotBuildFailureReason =
  | 'invalid-input'
  | 'invalid-revision'
  | 'invalid-pushed-at'
  | 'budget-exhausted'
  | 'secret-shaped'
  | 'tokens-not-tokens';

export type SnapshotBuildResult =
  | { readonly ok: true; readonly push: SectionSnapshotPush }
  | { readonly ok: false; readonly reason: SnapshotBuildFailureReason };

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SnapshotBuildFailureReason };

interface Envelope {
  readonly revision: number;
  readonly pushedAtIso: string;
  readonly body: Readonly<Record<string, unknown>>;
}

interface RepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

function fail(reason: SnapshotBuildFailureReason): { readonly ok: false; readonly reason: SnapshotBuildFailureReason } {
  return { ok: false, reason };
}

function isOneOf(list: readonly string[], value: unknown): value is string {
  return typeof value === 'string' && list.includes(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The record's own enumerable keys must be exactly `required` plus any of
 * `optional`; a forbidden key, a foreign key or a missing required key is null.
 * One `Reflect.ownKeys` over a record whose key count `snapshotPlainData`
 * already bounded by `maxKeys`; the values are plain data, never getters.
 */
function readKeyed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.includes(key)) {
      return null;
    }
    if (!required.includes(key) && !optional.includes(key)) {
      return null;
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      return null;
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function readRecords(value: unknown): readonly unknown[] | null {
  const dense = readBoundedDenseArray(value, SNAPSHOT_PUBLISHER_MAX_RECORDS);
  return dense === null ? null : dense.array;
}

function readRepository(value: unknown): RepositoryRef | null {
  const record = readKeyed(value, ['owner', 'repo'], []);
  if (record === null || !isNonEmptyString(record.owner) || !isNonEmptyString(record.repo)) {
    return null;
  }
  return { owner: record.owner, repo: record.repo };
}

function mapSnapshotRefusal(reason: string, path: string | null): SnapshotBuildFailureReason {
  // A non-finite or negative-zero revision is a revision refusal; the path names the key only.
  if (path === 'revision' && (reason === 'non-finite-number' || reason === 'negative-zero')) {
    return 'invalid-revision';
  }
  if (reason === 'too-many-items' || reason === 'too-many-nodes') {
    return 'budget-exhausted';
  }
  return 'invalid-input';
}

function readEnvelope(input: unknown, isProxy: IsProxy, bodyKeys: readonly string[]): Parsed<Envelope> {
  const snapshot = snapshotPlainData(input, isProxy, SNAPSHOT_PUBLISHER_PLAIN_DATA_LIMITS);
  if (!snapshot.ok) {
    return fail(mapSnapshotRefusal(snapshot.reason, snapshot.path));
  }
  const record = readKeyed(snapshot.value, ['revision', 'pushedAtIso', ...bodyKeys], []);
  if (record === null) {
    return fail('invalid-input');
  }
  const revision = record.revision;
  if (typeof revision !== 'number') {
    return fail('invalid-input');
  }
  if (!isPositiveSafeInteger(revision)) {
    return fail('invalid-revision');
  }
  const pushedAtIso = record.pushedAtIso;
  if (typeof pushedAtIso !== 'string') {
    return fail('invalid-input');
  }
  if (parseTimeMs(pushedAtIso) === null) {
    return fail('invalid-pushed-at');
  }
  const body: Record<string, unknown> = {};
  for (const key of bodyKeys) {
    body[key] = record[key];
  }
  return { ok: true, value: { revision, pushedAtIso, body } };
}

function finalize(
  section: PublisherSection,
  envelope: Envelope,
  tokens: readonly string[],
): SnapshotBuildResult {
  const unique = [...new Set(tokens)];
  if (unique.length > SNAPSHOT_PUBLISHER_MAX_TOKENS) {
    return fail('budget-exhausted');
  }
  const parsed = parseSnapshotPush({
    section,
    revision: envelope.revision,
    tokens: unique,
    pushedAtIso: envelope.pushedAtIso,
  });
  if (!parsed.ok) {
    switch (parsed.reason) {
      case 'secret-shaped':
      case 'tokens-not-tokens':
      case 'invalid-revision':
      case 'invalid-pushed-at':
        return fail(parsed.reason);
      default:
        return fail('invalid-input');
    }
  }
  return {
    ok: true,
    push: Object.freeze({
      section: parsed.push.section,
      revision: parsed.push.revision,
      tokens: Object.freeze([...parsed.push.tokens]),
      pushedAtIso: parsed.push.pushedAtIso,
    }),
  };
}

function runningTokens(records: readonly unknown[]): Parsed<string[]> {
  const tokens: string[] = [];
  for (const raw of records) {
    const session = readKeyed(raw, ['sessionId', 'projectId'], ['seatRole', 'seatModel']);
    if (session === null || !isNonEmptyString(session.sessionId) || !isNonEmptyString(session.projectId)) {
      return fail('invalid-input');
    }
    const hasRole = Object.hasOwn(session, 'seatRole');
    const hasModel = Object.hasOwn(session, 'seatModel');
    if (hasRole !== hasModel) {
      return fail('invalid-input');
    }
    tokens.push(`session:${session.sessionId}`, `project:${session.projectId}`);
    if (hasRole) {
      if (!isNonEmptyString(session.seatRole) || !isNonEmptyString(session.seatModel)) {
        return fail('invalid-input');
      }
      tokens.push(`seat:${session.seatRole}:${session.seatModel}`);
    }
  }
  return { ok: true, value: tokens };
}

function trainTokens(records: readonly unknown[]): Parsed<string[]> {
  const tokens: string[] = [];
  for (const raw of records) {
    const entry = readKeyed(raw, ['repository', 'pullRequest', 'state'], []);
    if (entry === null) {
      return fail('invalid-input');
    }
    const repository = readRepository(entry.repository);
    if (
      repository === null ||
      !isPositiveSafeInteger(entry.pullRequest) ||
      !isOneOf(MERGE_QUEUE_ENTRY_STATES, entry.state)
    ) {
      return fail('invalid-input');
    }
    if (isOneOf(MERGE_QUEUE_TERMINAL_STATES, entry.state)) {
      continue; // only live entries are on the train
    }
    tokens.push(`queue:${repository.owner}.${repository.repo}:${entry.pullRequest}:${entry.state}`);
  }
  return { ok: true, value: tokens };
}

function parkedRunTokens(records: readonly unknown[]): Parsed<string[]> {
  const tokens: string[] = [];
  for (const raw of records) {
    const run = readKeyed(raw, ['runId', 'reason'], []);
    if (run === null || !isNonEmptyString(run.runId) || !isOneOf(LANE_RUN_PARK_REASONS, run.reason)) {
      return fail('invalid-input');
    }
    tokens.push(`park-run:${run.runId}:${run.reason}`);
  }
  return { ok: true, value: tokens };
}

function parkedEntryTokens(records: readonly unknown[]): Parsed<string[]> {
  const tokens: string[] = [];
  for (const raw of records) {
    const entry = readKeyed(raw, ['repository', 'pullRequest', 'reason'], []);
    if (entry === null) {
      return fail('invalid-input');
    }
    const repository = readRepository(entry.repository);
    if (
      repository === null ||
      !isPositiveSafeInteger(entry.pullRequest) ||
      !isOneOf(MERGE_PARK_REASONS, entry.reason)
    ) {
      return fail('invalid-input');
    }
    tokens.push(`park-pr:${repository.owner}.${repository.repo}:${entry.pullRequest}:${entry.reason}`);
  }
  return { ok: true, value: tokens };
}

/**
 * `{ revision, pushedAtIso, sessions }` where each session is
 * `{ sessionId, projectId, seatRole?, seatModel? }` (seatRole and seatModel
 * together or not at all) → tokens `session:<id>`, `project:<id>`,
 * `seat:<role>:<model>`. Confirmed running comes from lane-server session
 * lists only.
 */
export function buildRunningSnapshotPush(input: unknown, isProxy: IsProxy): SnapshotBuildResult {
  try {
    const envelope = readEnvelope(input, isProxy, ['sessions']);
    if (!envelope.ok) {
      return fail(envelope.reason);
    }
    const sessions = readRecords(envelope.value.body.sessions);
    if (sessions === null) {
      return fail('invalid-input');
    }
    const tokens = runningTokens(sessions);
    if (!tokens.ok) {
      return fail(tokens.reason);
    }
    return finalize('running', envelope.value, tokens.value);
  } catch {
    return fail('invalid-input');
  }
}

/**
 * `{ revision, pushedAtIso, entries }` where each entry is
 * `{ repository: { owner, repo }, pullRequest, state }` → tokens
 * `queue:<owner>.<repo>:<pr>:<state>` for live entries (terminal states are skipped).
 */
export function buildTrainSnapshotPush(input: unknown, isProxy: IsProxy): SnapshotBuildResult {
  try {
    const envelope = readEnvelope(input, isProxy, ['entries']);
    if (!envelope.ok) {
      return fail(envelope.reason);
    }
    const entries = readRecords(envelope.value.body.entries);
    if (entries === null) {
      return fail('invalid-input');
    }
    const tokens = trainTokens(entries);
    if (!tokens.ok) {
      return fail(tokens.reason);
    }
    return finalize('train', envelope.value, tokens.value);
  } catch {
    return fail('invalid-input');
  }
}

/**
 * `{ revision, pushedAtIso, parkedRuns, parkedEntries }` where a parked run is
 * `{ runId, reason }` and a parked entry is `{ repository: { owner, repo },
 * pullRequest, reason }` → tokens `park-run:<runId>:<reason>` and
 * `park-pr:<owner>.<repo>:<pr>:<reason>`.
 */
export function buildParksSnapshotPush(input: unknown, isProxy: IsProxy): SnapshotBuildResult {
  try {
    const envelope = readEnvelope(input, isProxy, ['parkedRuns', 'parkedEntries']);
    if (!envelope.ok) {
      return fail(envelope.reason);
    }
    const runs = readRecords(envelope.value.body.parkedRuns);
    const entries = readRecords(envelope.value.body.parkedEntries);
    if (runs === null || entries === null) {
      return fail('invalid-input');
    }
    const runTokens = parkedRunTokens(runs);
    if (!runTokens.ok) {
      return fail(runTokens.reason);
    }
    const entryTokens = parkedEntryTokens(entries);
    if (!entryTokens.ok) {
      return fail(entryTokens.reason);
    }
    return finalize('parks', envelope.value, [...runTokens.value, ...entryTokens.value]);
  } catch {
    return fail('invalid-input');
  }
}
