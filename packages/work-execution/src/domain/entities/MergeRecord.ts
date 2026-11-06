// @generated entity stub — refined for lane WB5a.
/**
 * MergeRecord is a merge's one durable fact as a stored, versioned record
 * (work-board plan §3.4 "Merges and forge observations"): keyed
 * (repository, number), holding the first merge fact and never replacing it.
 * Two invariants:
 * - The first merge fact is kept: `headSha` and `mergedAtIso` are written once
 *   and never replaced, removed or shortened by a later read; a differing
 *   later read is kept out of the record and reported as an integrity finding.
 * - `merger` moves at most once, one way: `unknown` → `fleet`, never back, and
 *   only from the fleet path's typed journal entry.
 * Validation returns a result and never throws; hostile or secret-shaped input
 * is refused with a fixed message, never echoed.
 */

import { readPlainRecord } from '@fleet/shared';
import type { PlainRecordFailureReason } from '@fleet/shared';

import { CANONICAL_ISO_PATTERN } from '../lane-plan-records.js';
import { isPlanSecretShaped, pullRequestRefError } from '../lane-plan-sidecar.js';

export const MERGE_RECORD_SCHEMA_VERSION = 1 as const;
export const MERGE_RECORD_SOURCES = ['forge-observation', 'fleet-forge-action'] as const;
export type MergeRecordSource = (typeof MERGE_RECORD_SOURCES)[number];
export const MERGE_RECORD_MERGERS = ['fleet', 'unknown'] as const;
export type MergeRecordMerger = (typeof MERGE_RECORD_MERGERS)[number];

export interface MergeRecordRecord {
  readonly schemaVersion: typeof MERGE_RECORD_SCHEMA_VERSION;
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly mergedAtIso: string;
  readonly firstSeenAtIso: string;
  readonly source: MergeRecordSource;
  readonly merger: MergeRecordMerger;
  readonly actionRef?: string;   // omitted (not null) when unknown
}

export interface MergeRecordIntegrityFinding {
  readonly repository: string;
  readonly number: number;
  readonly differingFields: readonly ('head-sha' | 'merged-at')[];
  readonly expectedHeadSha: string;
  readonly observedHeadSha: string;
  readonly expectedMergedAtIso: string;
  readonly observedMergedAtIso: string;
}

export type MergeRecordResult =
  | { readonly success: true; readonly value: MergeRecord }
  | { readonly success: false; readonly error: Error; readonly code: 'invalid' };

const MERGE_HEAD_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The source/merger pairing invariant: `fleet-forge-action` requires
 * `merger: 'fleet'` and `forge-observation` requires `merger: 'unknown'`.
 */
function mergeSourceMergerAgree(source: MergeRecordSource, merger: MergeRecordMerger): boolean {
  return (source === 'fleet-forge-action' && merger === 'fleet') ||
    (source === 'forge-observation' && merger === 'unknown');
}

/**
 * Canonical UTC check that never throws: a value can match the canonical ISO
 * shape and still name an impossible calendar date (for example a 30 February),
 * on which `toISOString()` throws a RangeError. Such a value is refused, not
 * propagated as a thrown error.
 */
function isCanonicalIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function hasForbiddenControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint !== undefined && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f))) {
      return true;
    }
  }
  return false;
}

const RECORD_SCHEMA: Parameters<typeof readPlainRecord>[1] = {
  schemaVersion: { kind: 'integer', min: 1, max: MERGE_RECORD_SCHEMA_VERSION, optional: true },
  repository: { kind: 'string', maxLength: 200 },
  number: { kind: 'integer', min: 1, max: 999999999 },
  headSha: { kind: 'string', maxLength: 64 },
  mergedAtIso: { kind: 'string', maxLength: 32 },
  firstSeenAtIso: { kind: 'string', maxLength: 32 },
  source: { kind: 'literal', values: MERGE_RECORD_SOURCES },
  merger: { kind: 'literal', values: MERGE_RECORD_MERGERS },
  actionRef: { kind: 'string', maxLength: 128, optional: true },
};

export class MergeRecord {
  private constructor(private readonly record: MergeRecordRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): MergeRecordResult {
    try {
      const read = readMergeRecordRecord(input);
      if (!read.ok) {
        return invalid(read.message);
      }
      // A fresh record must come in with a source/merger pair that agrees; a
      // stored record may legitimately have been upgraded (unknown → fleet), so
      // this invariant is enforced here, not by the shared reader.
      if (!mergeSourceMergerAgree(read.record.source, read.record.merger)) {
        return invalid('MergeRecord source and merger disagree');
      }
      return { success: true, value: new MergeRecord(read.record) };
    } catch {
      return invalid('MergeRecord input could not be read');
    }
  }

  /** Fresh plain record. */
  toRecord(): MergeRecordRecord {
    return {
      schemaVersion: this.record.schemaVersion,
      repository: this.record.repository,
      number: this.record.number,
      headSha: this.record.headSha,
      mergedAtIso: this.record.mergedAtIso,
      firstSeenAtIso: this.record.firstSeenAtIso,
      source: this.record.source,
      merger: this.record.merger,
      ...(this.record.actionRef !== undefined ? { actionRef: this.record.actionRef } : {}),
    };
  }

  /** `<repository>#<number>`: the store key of a merge record (one per key). */
  getKey(): string {
    return `${this.record.repository}#${this.record.number}`;
  }

  getRepository(): string {
    return this.record.repository;
  }

  getNumber(): number {
    return this.record.number;
  }

  getMerger(): MergeRecordMerger {
    return this.record.merger;
  }

  getSource(): MergeRecordSource {
    return this.record.source;
  }

  getMergedAtIso(): string {
    return this.record.mergedAtIso;
  }

  getFirstSeenAtIso(): string {
    return this.record.firstSeenAtIso;
  }

  getHeadSha(): string {
    return this.record.headSha;
  }
}

function readMergeRecordRecord(
  input: unknown,
): { readonly ok: true; readonly record: MergeRecordRecord } | { readonly ok: false; readonly message: string } {
  const read = readPlainRecord(input, RECORD_SCHEMA);
  if (!read.ok) {
    return { ok: false, message: plainRecordFailureMessage(read.reason) };
  }

  const fields = read.value;
  const repository = fields.repository;
  const number = fields.number;

  const refError = pullRequestRefError('merge', { repository, number });
  if (refError !== null) {
    return { ok: false, message: `MergeRecord ${refError}` };
  }
  if (typeof repository !== 'string' || typeof number !== 'number') {
    return { ok: false, message: 'MergeRecord requires a record' };
  }

  const headSha = fields.headSha;
  if (typeof headSha !== 'string' || !MERGE_HEAD_SHA_PATTERN.test(headSha)) {
    return { ok: false, message: 'MergeRecord headSha: must be a lowercase sha' };
  }

  const mergedAtIso = fields.mergedAtIso;
  if (
    typeof mergedAtIso !== 'string' ||
    !CANONICAL_ISO_PATTERN.test(mergedAtIso) ||
    !isCanonicalIsoTimestamp(mergedAtIso)
  ) {
    return { ok: false, message: 'MergeRecord mergedAtIso: must be a canonical UTC timestamp' };
  }

  const firstSeenAtIso = fields.firstSeenAtIso;
  if (
    typeof firstSeenAtIso !== 'string' ||
    !CANONICAL_ISO_PATTERN.test(firstSeenAtIso) ||
    !isCanonicalIsoTimestamp(firstSeenAtIso)
  ) {
    return { ok: false, message: 'MergeRecord firstSeenAtIso: must be a canonical UTC timestamp' };
  }

  const source = fields.source;
  const merger = fields.merger;
  if (source !== 'forge-observation' && source !== 'fleet-forge-action') {
    return { ok: false, message: 'MergeRecord source: must be one of forge-observation, fleet-forge-action' };
  }
  if (merger !== 'fleet' && merger !== 'unknown') {
    return { ok: false, message: 'MergeRecord merger: must be one of fleet, unknown' };
  }

  let actionRefValue: string | undefined;
  const actionRef = fields.actionRef;
  if (actionRef !== undefined) {
    if (
      typeof actionRef !== 'string' ||
      actionRef.length > 128 ||
      hasForbiddenControlCharacter(actionRef) ||
      isPlanSecretShaped(actionRef)
    ) {
      return { ok: false, message: 'MergeRecord actionRef: must be plain text of at most 128 characters' };
    }
    actionRefValue = actionRef;
  }

  const record: MergeRecordRecord = {
    schemaVersion: MERGE_RECORD_SCHEMA_VERSION,
    repository,
    number,
    headSha,
    mergedAtIso,
    firstSeenAtIso,
    source,
    merger,
    ...(actionRefValue !== undefined ? { actionRef: actionRefValue } : {}),
  };

  return { ok: true, record: Object.freeze(record) };
}

function plainRecordFailureMessage(reason: PlainRecordFailureReason): string {
  switch (reason) {
    case 'not-an-object':
      return 'MergeRecord requires a record';
    case 'not-plain':
      return 'MergeRecord requires a plain record';
    case 'not-data-property':
      return 'MergeRecord fields must be plain data properties';
    case 'missing-field':
      return 'MergeRecord is missing a required field';
    case 'wrong-type':
      return 'MergeRecord field has the wrong type';
    case 'too-long':
      return 'MergeRecord field is too long';
    case 'out-of-range':
      return 'MergeRecord field is out of range';
    case 'not-a-literal':
      return 'MergeRecord field must be one of its allowed values';
    case 'sparse-array':
      return 'MergeRecord fields must not be sparse';
    case 'too-many-items':
      return 'MergeRecord field has too many items';
    case 'too-deep':
      return 'MergeRecord field is nested too deeply';
    case 'hostile':
    case 'invalid-schema':
      return 'MergeRecord input could not be read';
  }
}

function invalid(message: string): MergeRecordResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

export type MergeRecordOutcome = 'create' | 'unchanged' | 'upgrade-merger' | 'integrity-conflict';

export type MergeRecordDecision =
  | { readonly success: true; readonly outcome: MergeRecordOutcome; readonly record: MergeRecordRecord; readonly finding: MergeRecordIntegrityFinding | null }
  | { readonly success: false; readonly error: Error; readonly code: 'invalid' };

export function decideMergeRecord(stored: unknown, incoming: unknown): MergeRecordDecision {
  const incomingRead = readMergeRecordRecord(incoming);
  if (!incomingRead.ok) {
    return invalidDecision('MergeRecord incoming record could not be read');
  }
  const incomingRecord = incomingRead.record;
  // The incoming record must carry an agreeing source/merger pair, in
  // particular when nothing is stored: a `forge-observation` sighting claiming
  // `merger: 'fleet'` is refused, never recorded. A stored record is exempt —
  // it may legitimately have been upgraded (`unknown` → `fleet`) — but an
  // incoming record is a fresh sighting and must agree.
  if (!mergeSourceMergerAgree(incomingRecord.source, incomingRecord.merger)) {
    return invalidDecision('MergeRecord source and merger disagree');
  }

  let storedRecord: MergeRecordRecord | null = null;
  if (stored !== null && stored !== undefined) {
    const storedRead = readMergeRecordRecord(stored);
    if (!storedRead.ok) {
      return invalidDecision('MergeRecord stored record could not be read');
    }
    storedRecord = storedRead.record;
  }

  if (storedRecord === null) {
    return { success: true, outcome: 'create', record: incomingRecord, finding: null };
  }

  const differingFields: Array<'head-sha' | 'merged-at'> = [];
  if (incomingRecord.headSha !== storedRecord.headSha) {
    differingFields.push('head-sha');
  }
  if (incomingRecord.mergedAtIso !== storedRecord.mergedAtIso) {
    differingFields.push('merged-at');
  }
  if (differingFields.length > 0) {
    return {
      success: true,
      outcome: 'integrity-conflict',
      record: storedRecord,
      finding: {
        repository: storedRecord.repository,
        number: storedRecord.number,
        differingFields,
        expectedHeadSha: storedRecord.headSha,
        observedHeadSha: incomingRecord.headSha,
        expectedMergedAtIso: storedRecord.mergedAtIso,
        observedMergedAtIso: incomingRecord.mergedAtIso,
      },
    };
  }

  if (storedRecord.merger === 'unknown' && incomingRecord.merger === 'fleet') {
    return {
      success: true,
      outcome: 'upgrade-merger',
      record: { ...storedRecord, merger: 'fleet' },
      finding: null,
    };
  }

  return { success: true, outcome: 'unchanged', record: storedRecord, finding: null };
}

function invalidDecision(message: string): MergeRecordDecision {
  return { success: false, error: new Error(message), code: 'invalid' };
}
