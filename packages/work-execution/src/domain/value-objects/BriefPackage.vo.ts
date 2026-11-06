// Value object refined for CO28b — typed frozen inputs and a versioned digest.
/**
 * BriefPackage is an immutable value object for one frozen brief package:
 * identity-bound paths, digests and revision references. The digest is
 * integrity, not truth; the package owns at least one path. The package
 * carries the acceptance spec its gate runs. CO28b: the brief's five frozen
 * inputs (execution limits, selected context versions, owner decision
 * references, seat plan and PR notes) are carried as typed, validated,
 * immutable fields, and a versioned manifest reader still accepts the legacy
 * prose-only (`schemaVersion: 1` or absent) packages.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { AcceptanceSpec } from './AcceptanceSpec.vo.js';
import { ExecutionLimits } from './ExecutionLimits.vo.js';
import { SeatPlan } from './SeatPlan.vo.js';
import {
  INITIAL_RECORD_SCHEMA_VERSION,
  isAcceptedRecordSchemaVersion,
  isPlainRecordObject,
  readRecordSchemaVersion,
} from '../record-schema-version.js';
import { snapshotPlainDataRecord } from '../plain-record-reads.js';

export const BRIEF_PACKAGE_SCHEMA_VERSION = 2 as const;
export const BRIEF_PACKAGE_MAX_PROSE_BYTES = 65_536;
export const BRIEF_PACKAGE_MAX_MANIFEST_BYTES = 262_144;
export const BRIEF_PACKAGE_MAX_SCALAR_CHARS = 512;
export const BRIEF_PACKAGE_MAX_PATH_CHARS = 256;
export const BRIEF_PACKAGE_MAX_OWNED_PATHS = 256;
export const BRIEF_PACKAGE_MAX_CONTEXT_VERSIONS = 128;
export const BRIEF_PACKAGE_MAX_DECISION_REFS = 128;
export const BRIEF_PACKAGE_MAX_RESOURCE_BOUNDS = 32;
export const BRIEF_PACKAGE_MAX_RESOURCE_KEY_CHARS = 128;
export const BRIEF_PACKAGE_MAX_RESOURCE_VALUE_CHARS = 1024;
export const BRIEF_PACKAGE_MAX_STEP_LIMIT = 100_000;
export const BRIEF_PACKAGE_MAX_TIME_LIMIT_SECONDS = 604_800;
export const BRIEF_PACKAGE_MAX_PR_NOTE_CHARS = 4000;

export interface BriefSelectedContextVersion {
  readonly knowledgeEntryId: string;
  readonly version: string;
}

export interface BriefPrNotes {
  readonly hardToUndo: string;
  readonly assumptions: string;
  readonly challengeThis: string;
}

export interface BriefFrozenInputs {
  readonly limits?: ExecutionLimits | null;
  readonly selectedContextVersions?: readonly BriefSelectedContextVersion[] | null;
  readonly ownerDecisionReferences?: readonly string[] | null;
  readonly seatPlan?: SeatPlan | null;
  readonly prNotes?: BriefPrNotes | null;
}

export type BriefPackageRefusalCode =
  | 'non-object'
  | 'invalid-field'
  | 'missing-owned-paths'
  | 'invalid-owned-path'
  | 'missing-acceptance-spec'
  | 'invalid-limits'
  | 'invalid-context-versions'
  | 'invalid-owner-decisions'
  | 'invalid-seat-plan'
  | 'invalid-pr-notes'
  | 'unknown-schema-version'
  | 'malformed'
  | 'unreadable'
  | 'digest-mismatch'
  | 'oversized'
  | 'secret-shaped';

export type BriefPackageCreateResult =
  | { readonly success: true; readonly value: BriefPackage }
  | { readonly success: false; readonly code: BriefPackageRefusalCode; readonly error: Error };

export interface BriefPackageProps {
  readonly attemptId: string;
  readonly briefDigest: string;
  readonly prosePath: string;
  readonly manifestPath: string;
  readonly baseCommit: string;
  readonly policyRevision: string;
  readonly independentReviewer: string;
  readonly ownedPaths: readonly string[];
  readonly acceptanceSpec: AcceptanceSpec;
  readonly schemaVersion?: number;
  readonly limits?: ExecutionLimits | null;
  readonly selectedContextVersions?: readonly BriefSelectedContextVersion[] | null;
  readonly ownerDecisionReferences?: readonly string[] | null;
  readonly seatPlan?: SeatPlan | null;
  readonly prNotes?: BriefPrNotes | null;
}

/** True when the text matches any registered secret shape; never says which. */
export function hasSecretShape(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((entry) => entry.regex.test(text));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Proxy-trap-safe plain-record read: `snapshotPlainDataRecord` is
 * getter-safe, but inspecting any object — through `getPrototypeOf`,
 * `Reflect.ownKeys` or `Object.getOwnPropertyDescriptor` — exercises the
 * corresponding traps of a Proxy in front of it, and a hostile trap can
 * answer inconsistently between calls. Reading the record twice and refusing
 * anything that does not answer identically both times (same keys, same
 * `Object.is` values) means a trap can never feed one value into validation
 * and a different value into the frozen result; a trap that throws surfaces
 * through the enclosing guards as a typed refusal, never as an escape.
 */
function snapshotsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
  );
}

function stableSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecordObject(value)) {
    return null;
  }
  const first = snapshotPlainDataRecord(value);
  if (first === null) {
    return null;
  }
  const second = snapshotPlainDataRecord(value);
  if (second === null || !snapshotsEqual(first, second)) {
    return null;
  }
  return first;
}

/** Validates one bounded identifier-like string; the refusal code or null. */
function scalarError(value: unknown, maxChars: number): BriefPackageRefusalCode | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) {
    return 'invalid-field';
  }
  if (value.length > maxChars) {
    return 'oversized';
  }
  if (hasSecretShape(value)) {
    return 'secret-shaped';
  }
  return null;
}

/**
 * The copied values of a dense array: every index from `0` to `length - 1`
 * must hold an enumerable data property, read through its descriptor (so no
 * `get` trap or getter ever runs) and read twice (so a hostile trap cannot
 * show one value to validation and hand a different one to the package).
 * `null` for anything else — sparse arrays, accessor indices, non-arrays.
 */
function denseArrayValues(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) {
      return null;
    }
    const confirmed = Object.getOwnPropertyDescriptor(value, index);
    if (confirmed === undefined || !Object.is(confirmed.value, descriptor.value)) {
      return null;
    }
    out.push(descriptor.value);
  }
  return out;
}

/** Validates one execution-limits instance and clones it with sorted resourceBounds keys. */
function validateLimitsInstance(value: unknown): { ok: true; limits: ExecutionLimits } | { ok: false; code: BriefPackageRefusalCode } {
  if (!(value instanceof ExecutionLimits)) {
    return { ok: false, code: 'invalid-limits' };
  }
  const stepLimit = value.getStepLimit();
  const timeLimitSeconds = value.getTimeLimitSeconds();
  if (
    !Number.isSafeInteger(stepLimit) ||
    stepLimit < 1 ||
    stepLimit > BRIEF_PACKAGE_MAX_STEP_LIMIT ||
    !Number.isSafeInteger(timeLimitSeconds) ||
    timeLimitSeconds < 1 ||
    timeLimitSeconds > BRIEF_PACKAGE_MAX_TIME_LIMIT_SECONDS
  ) {
    return { ok: false, code: 'invalid-limits' };
  }
  const bounds = value.getResourceBounds();
  if (bounds === null || typeof bounds !== 'object' || Array.isArray(bounds)) {
    return { ok: false, code: 'invalid-limits' };
  }
  const snapshot = stableSnapshot(bounds);
  if (snapshot === null) {
    return { ok: false, code: 'invalid-limits' };
  }
  const keys = Object.keys(snapshot);
  if (keys.length > BRIEF_PACKAGE_MAX_RESOURCE_BOUNDS) {
    return { ok: false, code: 'oversized' };
  }
  const sorted: Record<string, string> = {};
  for (const key of keys.sort()) {
    if (key.trim().length === 0 || key.length > BRIEF_PACKAGE_MAX_RESOURCE_KEY_CHARS) {
      return { ok: false, code: 'invalid-limits' };
    }
    const entry = snapshot[key];
    if (typeof entry !== 'string' || entry.includes('\u0000')) {
      return { ok: false, code: 'invalid-limits' };
    }
    if (entry.length > BRIEF_PACKAGE_MAX_RESOURCE_VALUE_CHARS) {
      return { ok: false, code: 'oversized' };
    }
    if (hasSecretShape(key) || hasSecretShape(entry)) {
      return { ok: false, code: 'secret-shaped' };
    }
    sorted[key] = entry;
  }
  const created = ExecutionLimits.create({ stepLimit, timeLimitSeconds, resourceBounds: sorted });
  if (!created.success || created.value === undefined) {
    return { ok: false, code: 'invalid-limits' };
  }
  return { ok: true, limits: created.value };
}

/** Validates the selected context versions and returns a deep-frozen clone. */
function validateContextVersions(value: unknown): { ok: true; versions: readonly BriefSelectedContextVersion[] } | { ok: false; code: BriefPackageRefusalCode } {
  const entries = denseArrayValues(value);
  if (entries === null) {
    return { ok: false, code: 'invalid-context-versions' };
  }
  if (entries.length > BRIEF_PACKAGE_MAX_CONTEXT_VERSIONS) {
    return { ok: false, code: 'oversized' };
  }
  const versions: BriefSelectedContextVersion[] = [];
  for (const entry of entries) {
    const snapshot = stableSnapshot(entry);
    if (snapshot === null || Object.keys(snapshot).length !== 2 || !Object.hasOwn(snapshot, 'knowledgeEntryId') || !Object.hasOwn(snapshot, 'version')) {
      return { ok: false, code: 'invalid-context-versions' };
    }
    const idError = scalarError(snapshot.knowledgeEntryId, BRIEF_PACKAGE_MAX_PATH_CHARS);
    if (idError !== null) {
      return { ok: false, code: idError };
    }
    const versionError = scalarError(snapshot.version, BRIEF_PACKAGE_MAX_PATH_CHARS);
    if (versionError !== null) {
      return { ok: false, code: versionError };
    }
    versions.push(Object.freeze({
      knowledgeEntryId: (snapshot.knowledgeEntryId as string).trim(),
      version: (snapshot.version as string).trim(),
    }));
  }
  return { ok: true, versions: Object.freeze(versions) };
}

/** Validates the owner decision references and returns a frozen clone. */
function validateDecisionRefs(value: unknown): { ok: true; refs: readonly string[] } | { ok: false; code: BriefPackageRefusalCode } {
  const entries = denseArrayValues(value);
  if (entries === null) {
    return { ok: false, code: 'invalid-owner-decisions' };
  }
  if (entries.length > BRIEF_PACKAGE_MAX_DECISION_REFS) {
    return { ok: false, code: 'oversized' };
  }
  const refs: string[] = [];
  for (const entry of entries) {
    const entryError = scalarError(entry, BRIEF_PACKAGE_MAX_PATH_CHARS);
    if (entryError !== null) {
      return { ok: false, code: entryError };
    }
    refs.push((entry as string).trim());
  }
  return { ok: true, refs: Object.freeze(refs) };
}

/** Deep-scans a plain data structure for NUL, oversized or secret-shaped strings. */
function deepScanError(value: unknown, maxChars: number): BriefPackageRefusalCode | null {
  if (typeof value === 'string') {
    if (value.includes('\u0000')) {
      return 'invalid-field';
    }
    if (value.length > maxChars) {
      return 'oversized';
    }
    if (hasSecretShape(value)) {
      return 'secret-shaped';
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const entryError = deepScanError(entry, maxChars);
      if (entryError !== null) {
        return entryError;
      }
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    const snapshot = stableSnapshot(value);
    if (snapshot === null) {
      return 'malformed';
    }
    for (const [key, entry] of Object.entries(snapshot)) {
      const keyError = deepScanError(key, maxChars);
      if (keyError !== null) {
        return keyError;
      }
      const entryError = deepScanError(entry, maxChars);
      if (entryError !== null) {
        return entryError;
      }
    }
  }
  return null;
}

/** Validates one seat plan instance and returns the re-validated clone. */
function validateSeatPlanValue(value: unknown): { ok: true; plan: SeatPlan } | { ok: false; code: BriefPackageRefusalCode } {
  if (!(value instanceof SeatPlan)) {
    return { ok: false, code: 'invalid-seat-plan' };
  }
  const recreated = SeatPlan.create(value.toJSON());
  if (!recreated.success || recreated.value === undefined) {
    return { ok: false, code: 'invalid-seat-plan' };
  }
  const scanError = deepScanError(recreated.value.toJSON(), BRIEF_PACKAGE_MAX_SCALAR_CHARS);
  if (scanError !== null) {
    return { ok: false, code: scanError };
  }
  return { ok: true, plan: recreated.value };
}

/** Validates one PR-notes record and returns a frozen clone. */
function validatePrNotes(value: unknown): { ok: true; notes: BriefPrNotes } | { ok: false; code: BriefPackageRefusalCode } {
  const snapshot = stableSnapshot(value);
  if (
    snapshot === null ||
    Object.keys(snapshot).length !== 3 ||
    !Object.hasOwn(snapshot, 'hardToUndo') ||
    !Object.hasOwn(snapshot, 'assumptions') ||
    !Object.hasOwn(snapshot, 'challengeThis')
  ) {
    return { ok: false, code: 'invalid-pr-notes' };
  }
  const notes: Record<string, string> = {};
  for (const key of ['hardToUndo', 'assumptions', 'challengeThis'] as const) {
    const entry = snapshot[key];
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return { ok: false, code: 'invalid-pr-notes' };
    }
    if (entry.length > BRIEF_PACKAGE_MAX_PR_NOTE_CHARS) {
      return { ok: false, code: 'oversized' };
    }
    if (hasSecretShape(entry)) {
      return { ok: false, code: 'secret-shaped' };
    }
    notes[key] = entry;
  }
  return { ok: true, notes: Object.freeze({ hardToUndo: notes.hardToUndo, assumptions: notes.assumptions, challengeThis: notes.challengeThis }) };
}

const STRING_FIELDS: readonly (keyof BriefPackageProps)[] = [
  'attemptId',
  'briefDigest',
  'prosePath',
  'manifestPath',
  'baseCommit',
  'policyRevision',
  'independentReviewer',
];

const FROZEN_INPUT_KEYS: readonly (keyof BriefFrozenInputs)[] = [
  'limits',
  'selectedContextVersions',
  'ownerDecisionReferences',
  'seatPlan',
  'prNotes',
];

export class BriefPackage {
  private constructor(private readonly props: BriefPackageProps) {
    // Value is immutable after construction.
  }

  static create(rawProps: unknown): BriefPackageCreateResult {
    try {
      return BriefPackage.createUnchecked(rawProps);
    } catch {
      return { success: false, code: 'malformed', error: new Error('BriefPackage input is malformed') };
    }
  }

  private static createUnchecked(rawProps: unknown): BriefPackageCreateResult {
    const snapshot = stableSnapshot(rawProps);
    if (snapshot === null) {
      return {
        success: false,
        code: 'non-object',
        error: new Error('BriefPackage input must be a plain object'),
      };
    }

    let schemaVersion: number;
    // The snapshot already refuses accessor and non-enumerable properties, so
    // the schema version is read from it rather than through another trap on
    // the raw input.
    const hasSchemaVersionKey = Object.hasOwn(snapshot, 'schemaVersion');
    if (!hasSchemaVersionKey) {
      const hasStructured = FROZEN_INPUT_KEYS.some((key) => snapshot[key] !== undefined && snapshot[key] !== null);
      schemaVersion = hasStructured ? BRIEF_PACKAGE_SCHEMA_VERSION : INITIAL_RECORD_SCHEMA_VERSION;
    } else {
      const declared = snapshot.schemaVersion;
      if (!isAcceptedRecordSchemaVersion(declared, BRIEF_PACKAGE_SCHEMA_VERSION)) {
        return {
          success: false,
          code: 'unknown-schema-version',
          error: new Error('BriefPackage schemaVersion is outside the accepted window'),
        };
      }
      schemaVersion = declared as number;
    }

    for (const field of STRING_FIELDS) {
      const maxChars = field === 'prosePath' || field === 'manifestPath' ? BRIEF_PACKAGE_MAX_PATH_CHARS : BRIEF_PACKAGE_MAX_SCALAR_CHARS;
      const value = snapshot[field];
      if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000')) {
        return { success: false, code: 'invalid-field', error: new Error(`BriefPackage requires a non-empty ${String(field)}`) };
      }
      if (value.length > maxChars) {
        return { success: false, code: 'oversized', error: new Error(`BriefPackage ${String(field)} is over its size bound`) };
      }
      if (hasSecretShape(value)) {
        return { success: false, code: 'secret-shaped', error: new Error(`BriefPackage ${String(field)} contains a secret-shaped value and was refused`) };
      }
    }

    const ownedPaths = denseArrayValues(snapshot.ownedPaths);
    if (ownedPaths === null) {
      return { success: false, code: 'invalid-owned-path', error: new Error('BriefPackage requires owned paths') };
    }
    if (ownedPaths.length === 0) {
      return { success: false, code: 'missing-owned-paths', error: new Error('BriefPackage requires at least one owned path') };
    }
    if (ownedPaths.length > BRIEF_PACKAGE_MAX_OWNED_PATHS) {
      return { success: false, code: 'oversized', error: new Error('BriefPackage owned paths are over their size bound') };
    }
    for (const path of ownedPaths) {
      if (typeof path !== 'string' || path.trim().length === 0 || path.includes('\u0000')) {
        return { success: false, code: 'invalid-owned-path', error: new Error('BriefPackage owned paths must be non-empty strings') };
      }
      if (path.length > BRIEF_PACKAGE_MAX_PATH_CHARS) {
        return { success: false, code: 'oversized', error: new Error('BriefPackage owned paths are over their size bound') };
      }
      if (hasSecretShape(path)) {
        return { success: false, code: 'secret-shaped', error: new Error('BriefPackage owned paths contain a secret-shaped value and were refused') };
      }
    }

    if (!(snapshot.acceptanceSpec instanceof AcceptanceSpec)) {
      return { success: false, code: 'missing-acceptance-spec', error: new Error('BriefPackage requires an acceptance spec') };
    }

    let limits: ExecutionLimits | null = null;
    if (snapshot.limits !== undefined && snapshot.limits !== null) {
      const checked = validateLimitsInstance(snapshot.limits);
      if (!checked.ok) {
        return { success: false, code: checked.code, error: new Error('BriefPackage limits are invalid') };
      }
      limits = checked.limits;
    }

    let selectedContextVersions: readonly BriefSelectedContextVersion[] | null = null;
    if (snapshot.selectedContextVersions !== undefined && snapshot.selectedContextVersions !== null) {
      const checked = validateContextVersions(snapshot.selectedContextVersions);
      if (!checked.ok) {
        return { success: false, code: checked.code, error: new Error('BriefPackage selected context versions are invalid') };
      }
      selectedContextVersions = checked.versions;
    }

    let ownerDecisionReferences: readonly string[] | null = null;
    if (snapshot.ownerDecisionReferences !== undefined && snapshot.ownerDecisionReferences !== null) {
      const checked = validateDecisionRefs(snapshot.ownerDecisionReferences);
      if (!checked.ok) {
        return { success: false, code: checked.code, error: new Error('BriefPackage owner decision references are invalid') };
      }
      ownerDecisionReferences = checked.refs;
    }

    let seatPlan: SeatPlan | null = null;
    if (snapshot.seatPlan !== undefined && snapshot.seatPlan !== null) {
      const checked = validateSeatPlanValue(snapshot.seatPlan);
      if (!checked.ok) {
        return { success: false, code: checked.code, error: new Error('BriefPackage seat plan is invalid') };
      }
      seatPlan = checked.plan;
    }

    let prNotes: BriefPrNotes | null = null;
    if (snapshot.prNotes !== undefined && snapshot.prNotes !== null) {
      const checked = validatePrNotes(snapshot.prNotes);
      if (!checked.ok) {
        return { success: false, code: checked.code, error: new Error('BriefPackage PR notes are invalid') };
      }
      prNotes = checked.notes;
    }

    return {
      success: true,
      value: new BriefPackage({
        attemptId: snapshot.attemptId as string,
        briefDigest: snapshot.briefDigest as string,
        prosePath: snapshot.prosePath as string,
        manifestPath: snapshot.manifestPath as string,
        baseCommit: snapshot.baseCommit as string,
        policyRevision: snapshot.policyRevision as string,
        independentReviewer: snapshot.independentReviewer as string,
        ownedPaths: Object.freeze([...(ownedPaths as string[])]),
        acceptanceSpec: snapshot.acceptanceSpec,
        schemaVersion,
        limits,
        selectedContextVersions,
        ownerDecisionReferences,
        seatPlan,
        prNotes,
      }),
    };
  }

  getAttemptId(): string {
    return this.props.attemptId;
  }

  getBriefDigest(): string {
    return this.props.briefDigest;
  }

  getProsePath(): string {
    return this.props.prosePath;
  }

  getManifestPath(): string {
    return this.props.manifestPath;
  }

  getBaseCommit(): string {
    return this.props.baseCommit;
  }

  getPolicyRevision(): string {
    return this.props.policyRevision;
  }

  getIndependentReviewer(): string {
    return this.props.independentReviewer;
  }

  getOwnedPaths(): readonly string[] {
    return this.props.ownedPaths;
  }

  getAcceptanceSpec(): AcceptanceSpec {
    return this.props.acceptanceSpec;
  }

  getSchemaVersion(): number {
    return this.props.schemaVersion ?? INITIAL_RECORD_SCHEMA_VERSION;
  }

  getLimits(): ExecutionLimits | null {
    const limits = this.props.limits;
    if (limits === null || limits === undefined) {
      return null;
    }
    // Re-validate into a fresh instance: the stored value object's resource
    // bounds are its own mutable record, and no caller may reach them.
    try {
      const checked = validateLimitsInstance(limits);
      return checked.ok ? checked.limits : null;
    } catch {
      return null;
    }
  }

  getSelectedContextVersions(): readonly BriefSelectedContextVersion[] | null {
    return this.props.selectedContextVersions === null || this.props.selectedContextVersions === undefined
      ? null
      : [...this.props.selectedContextVersions];
  }

  getOwnerDecisionReferences(): readonly string[] | null {
    return this.props.ownerDecisionReferences === null || this.props.ownerDecisionReferences === undefined
      ? null
      : [...this.props.ownerDecisionReferences];
  }

  getSeatPlan(): SeatPlan | null {
    const plan = this.props.seatPlan;
    if (plan === null || plan === undefined) {
      return null;
    }
    // Recreate from the serialized form so the stored instance's internal
    // plan data is never handed to a caller.
    try {
      const recreated = SeatPlan.create(plan.toJSON());
      return recreated.success && recreated.value !== undefined ? recreated.value : null;
    } catch {
      return null;
    }
  }

  getPrNotes(): BriefPrNotes | null {
    const notes = this.props.prNotes;
    return notes === null || notes === undefined ? null : { ...notes };
  }

  /** True when any of the five structured frozen inputs is present. */
  hasStructuredFrozenInputs(): boolean {
    const props: unknown = this.props;
    return FROZEN_INPUT_KEYS.some(
      (key) => (props as Record<string, unknown>)[key] !== undefined && (props as Record<string, unknown>)[key] !== null,
    );
  }

  /** A frozen defensive copy; the internal props object is never exposed. */
  getProps(): BriefPackageProps {
    const props = this.props;
    const notes = this.getPrNotes();
    const contextVersions = this.getSelectedContextVersions();
    const decisionRefs = this.getOwnerDecisionReferences();
    return Object.freeze({
      ...props,
      ownedPaths: Object.freeze([...props.ownedPaths]),
      limits: this.getLimits(),
      selectedContextVersions: contextVersions === null ? null : Object.freeze([...contextVersions]),
      ownerDecisionReferences: decisionRefs === null ? null : Object.freeze([...decisionRefs]),
      seatPlan: this.getSeatPlan(),
      prNotes: notes === null ? null : Object.freeze(notes),
    });
  }

  equals(other: BriefPackage | null | undefined): boolean {
    if (!(other instanceof BriefPackage)) {
      return false;
    }
    return (
      this.props.attemptId === other.props.attemptId &&
      this.props.briefDigest === other.props.briefDigest &&
      this.props.prosePath === other.props.prosePath &&
      this.props.manifestPath === other.props.manifestPath &&
      this.props.baseCommit === other.props.baseCommit &&
      this.props.policyRevision === other.props.policyRevision &&
      this.props.independentReviewer === other.props.independentReviewer &&
      this.props.ownedPaths.length === other.props.ownedPaths.length &&
      this.props.ownedPaths.every((path, index) => path === other.props.ownedPaths[index]) &&
      this.props.acceptanceSpec.equals(other.props.acceptanceSpec) &&
      this.getSchemaVersion() === other.getSchemaVersion() &&
      limitsEqual(this.getLimits(), other.getLimits()) &&
      contextVersionsEqual(this.getSelectedContextVersions(), other.getSelectedContextVersions()) &&
      decisionsEqual(this.getOwnerDecisionReferences(), other.getOwnerDecisionReferences()) &&
      seatPlansEqual(this.getSeatPlan(), other.getSeatPlan()) &&
      prNotesEqual(this.getPrNotes(), other.getPrNotes())
    );
  }
}

function limitsEqual(left: ExecutionLimits | null, right: ExecutionLimits | null): boolean {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return left.equals(right);
}

function contextVersionsEqual(
  left: readonly BriefSelectedContextVersion[] | null,
  right: readonly BriefSelectedContextVersion[] | null,
): boolean {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return (
    left.length === right.length &&
    left.every((entry, index) => entry.knowledgeEntryId === right[index].knowledgeEntryId && entry.version === right[index].version)
  );
}

function decisionsEqual(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function seatPlansEqual(left: SeatPlan | null, right: SeatPlan | null): boolean {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return left.equals(right);
}

function prNotesEqual(left: BriefPrNotes | null, right: BriefPrNotes | null): boolean {
  if (left === null || right === null) {
    return left === null && right === null;
  }
  return (
    left.hardToUndo === right.hardToUndo &&
    left.assumptions === right.assumptions &&
    left.challengeThis === right.challengeThis
  );
}

/**
 * Validates the five frozen inputs with the exact `BriefPackage.create` rules
 * and serializes them as deterministic JSON with a fixed key order. All
 * absent inputs serialize as `null`; when every input is absent the JSON is
 * `null` so prose-only digest semantics stay unchanged.
 */
export function canonicalizeBriefFrozenInputs(
  inputs: BriefFrozenInputs,
): { ok: true; json: string | null } | { ok: false; code: BriefPackageRefusalCode } {
  // Nothing here may throw past the caller: the fields are read through a
  // descriptor-safe snapshot (a throwing getter on `inputs` — top level or
  // nested — becomes a typed `'malformed'` refusal, never an escape), and any
  // hostile value object accessor hit while validating is caught below.
  try {
    return canonicalizeBriefFrozenInputsUnchecked(inputs);
  } catch {
    return { ok: false, code: 'malformed' };
  }
}

function canonicalizeBriefFrozenInputsUnchecked(
  inputs: BriefFrozenInputs,
): { ok: true; json: string | null } | { ok: false; code: BriefPackageRefusalCode } {
  const snapshot = stableSnapshot(inputs);
  if (snapshot === null) {
    return { ok: false, code: 'malformed' };
  }
  if (FROZEN_INPUT_KEYS.every((key) => snapshot[key] === undefined || snapshot[key] === null)) {
    return { ok: true, json: null };
  }

  let limits: ExecutionLimits | null = null;
  if (snapshot.limits !== undefined && snapshot.limits !== null) {
    const checked = validateLimitsInstance(snapshot.limits);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    limits = checked.limits;
  }

  let selectedContextVersions: readonly BriefSelectedContextVersion[] | null = null;
  if (snapshot.selectedContextVersions !== undefined && snapshot.selectedContextVersions !== null) {
    const checked = validateContextVersions(snapshot.selectedContextVersions);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    selectedContextVersions = checked.versions;
  }

  let ownerDecisionReferences: readonly string[] | null = null;
  if (snapshot.ownerDecisionReferences !== undefined && snapshot.ownerDecisionReferences !== null) {
    const checked = validateDecisionRefs(snapshot.ownerDecisionReferences);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    ownerDecisionReferences = checked.refs;
  }

  let seatPlan: SeatPlan | null = null;
  if (snapshot.seatPlan !== undefined && snapshot.seatPlan !== null) {
    const checked = validateSeatPlanValue(snapshot.seatPlan);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    seatPlan = checked.plan;
  }

  let prNotes: BriefPrNotes | null = null;
  if (snapshot.prNotes !== undefined && snapshot.prNotes !== null) {
    const checked = validatePrNotes(snapshot.prNotes);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    prNotes = checked.notes;
  }

  const payload = {
    schemaVersion: BRIEF_PACKAGE_SCHEMA_VERSION,
    limits: limits === null
      ? null
      : {
          stepLimit: limits.getStepLimit(),
          timeLimitSeconds: limits.getTimeLimitSeconds(),
          resourceBounds: sortedCopy(limits.getResourceBounds()),
        },
    selectedContextVersions: selectedContextVersions === null
      ? null
      : selectedContextVersions.map((entry) => ({ knowledgeEntryId: entry.knowledgeEntryId, version: entry.version })),
    ownerDecisionReferences: ownerDecisionReferences === null ? null : [...ownerDecisionReferences],
    seatPlan: seatPlan === null ? null : seatPlan.toJSON(),
    prNotes: prNotes === null ? null : { hardToUndo: prNotes.hardToUndo, assumptions: prNotes.assumptions, challengeThis: prNotes.challengeThis },
  };
  return { ok: true, json: JSON.stringify(payload) };
}

function sortedCopy(record: Readonly<Record<string, string>>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

const DIGEST_SEEDS: readonly number[] = [
  0x811c9dc5, 0x01000193, 0x41c6ce57, 0x9e3779b9, 0xdeadbeef, 0x0badc0de, 0x12345678, 0x7fffffff,
];

function fnv1a32(content: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Pure deterministic fallback digest; production injects SHA-256. */
function fallbackDigest(content: string): string {
  return DIGEST_SEEDS.map((seed) => fnv1a32(content, seed).toString(16).padStart(8, '0')).join('');
}

/** Runs the digest function inside a guard: a throwing digest is `malformed`, never an escape. */
function safeDigest(
  digestFn: (content: string) => string,
  content: string,
): { ok: true; digest: string } | { ok: false } {
  try {
    return { ok: true, digest: digestFn(content) };
  } catch {
    return { ok: false };
  }
}

function proseTextError(value: unknown, maxBytes: number): BriefPackageRefusalCode | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'invalid-field';
  }
  if (byteLength(value) > maxBytes) {
    return 'oversized';
  }
  if (hasSecretShape(value)) {
    return 'secret-shaped';
  }
  return null;
}

/**
 * Computes the digest of one frozen brief package. With `manifestRaw` the
 * digest covers `prose + '\n' + manifestRaw` exactly as the stored worktree
 * verifiers check; with structured `frozenInputs` it covers the canonical
 * JSON of those inputs; with neither it covers the prose alone, keeping the
 * CO28 prose-only digest semantics for packages without structured inputs.
 */
export function computeBriefPackageDigest(
  input: unknown,
  computeDigest?: (content: string) => string,
): { readonly ok: true; readonly briefDigest: string; readonly coversStructuredInputs: boolean } | { readonly ok: false; readonly code: BriefPackageRefusalCode } {
  const digestFn = computeDigest ?? fallbackDigest;
  const snapshot = stableSnapshot(input);
  if (snapshot === null) {
    return { ok: false, code: 'malformed' };
  }
  const allowed = ['prose', 'manifestRaw', 'frozenInputs'];
  for (const key of Object.keys(snapshot)) {
    if (!allowed.includes(key)) {
      return { ok: false, code: 'malformed' };
    }
  }
  const proseError = proseTextError(snapshot.prose, BRIEF_PACKAGE_MAX_PROSE_BYTES);
  if (proseError !== null) {
    return { ok: false, code: proseError };
  }
  const prose = snapshot.prose as string;
  const manifestRaw = snapshot.manifestRaw;
  const frozenInputs = snapshot.frozenInputs;

  if (manifestRaw !== undefined && manifestRaw !== null) {
    if (frozenInputs !== undefined && frozenInputs !== null) {
      return { ok: false, code: 'malformed' };
    }
    if (typeof manifestRaw !== 'string') {
      return { ok: false, code: 'invalid-field' };
    }
    if (byteLength(manifestRaw) > BRIEF_PACKAGE_MAX_MANIFEST_BYTES) {
      return { ok: false, code: 'oversized' };
    }
    if (hasSecretShape(manifestRaw)) {
      return { ok: false, code: 'secret-shaped' };
    }
    const digested = safeDigest(digestFn, prose + '\n' + manifestRaw);
    return digested.ok
      ? { ok: true, briefDigest: digested.digest, coversStructuredInputs: true }
      : { ok: false, code: 'malformed' };
  }

  if (frozenInputs !== undefined && frozenInputs !== null) {
    const canonical = canonicalizeBriefFrozenInputs(frozenInputs as BriefFrozenInputs);
    if (!canonical.ok) {
      return { ok: false, code: canonical.code };
    }
    if (canonical.json !== null) {
      const digested = safeDigest(digestFn, prose + '\n' + canonical.json);
      return digested.ok
        ? { ok: true, briefDigest: digested.digest, coversStructuredInputs: true }
        : { ok: false, code: 'malformed' };
    }
  }

  const proseOnly = safeDigest(digestFn, prose);
  return proseOnly.ok
    ? { ok: true, briefDigest: proseOnly.digest, coversStructuredInputs: false }
    : { ok: false, code: 'malformed' };
}

const READER_ALLOWED_KEYS: readonly string[] = [
  'manifestRaw',
  'prose',
  'expectedBriefDigest',
  'prosePath',
  'manifestPath',
  'attemptId',
  'baseCommit',
  'policyRevision',
  'independentReviewer',
  'ownedPaths',
  'acceptanceSpec',
];

/** Builds `ExecutionLimits` from plain manifest data, or the refusal code. */
function limitsFromPlain(
  stepLimit: unknown,
  timeLimitSeconds: unknown,
  resourceBounds: unknown,
): { ok: true; limits: ExecutionLimits } | { ok: false; code: BriefPackageRefusalCode } {
  if (
    !Number.isSafeInteger(stepLimit) ||
    (stepLimit as number) < 1 ||
    (stepLimit as number) > BRIEF_PACKAGE_MAX_STEP_LIMIT ||
    !Number.isSafeInteger(timeLimitSeconds) ||
    (timeLimitSeconds as number) < 1 ||
    (timeLimitSeconds as number) > BRIEF_PACKAGE_MAX_TIME_LIMIT_SECONDS
  ) {
    return { ok: false, code: 'invalid-limits' };
  }
  const snapshot = stableSnapshot(resourceBounds);
  if (snapshot === null) {
    return { ok: false, code: 'invalid-limits' };
  }
  const keys = Object.keys(snapshot);
  if (keys.length > BRIEF_PACKAGE_MAX_RESOURCE_BOUNDS) {
    return { ok: false, code: 'oversized' };
  }
  const sorted: Record<string, string> = {};
  for (const key of keys.sort()) {
    if (key.trim().length === 0 || key.length > BRIEF_PACKAGE_MAX_RESOURCE_KEY_CHARS) {
      return { ok: false, code: 'invalid-limits' };
    }
    const entry = snapshot[key];
    if (typeof entry !== 'string' || entry.includes('\u0000')) {
      return { ok: false, code: 'invalid-limits' };
    }
    if (entry.length > BRIEF_PACKAGE_MAX_RESOURCE_VALUE_CHARS) {
      return { ok: false, code: 'oversized' };
    }
    if (hasSecretShape(key) || hasSecretShape(entry)) {
      return { ok: false, code: 'secret-shaped' };
    }
    sorted[key] = entry;
  }
  const created = ExecutionLimits.create({
    stepLimit: stepLimit as number,
    timeLimitSeconds: timeLimitSeconds as number,
    resourceBounds: sorted,
  });
  if (!created.success || created.value === undefined) {
    return { ok: false, code: 'invalid-limits' };
  }
  return { ok: true, limits: created.value };
}

/**
 * Reads one stored or prose-only brief package into a `BriefPackage`.
 * Stored manifests at `schemaVersion: 2` (and legacy `schemaVersion: 1` or
 * absent) are accepted; the digest covers `prose + '\n' + manifestRaw` when
 * the caller supplies the prose, and the prose alone in prose-only mode.
 * Pure: never throws, never runs a getter, never echoes a value or path.
 */
export function readBriefPackageManifest(
  input: unknown,
  options?: { readonly currentVersion?: number; readonly computeDigest?: (content: string) => string },
): { readonly ok: true; readonly value: BriefPackage; readonly schemaVersion: number; readonly explicitSchemaVersion: boolean } | { readonly ok: false; readonly code: BriefPackageRefusalCode } {
  try {
    return readBriefPackageManifestUnchecked(input, options);
  } catch {
    return { ok: false, code: 'malformed' };
  }
}

function readBriefPackageManifestUnchecked(
  input: unknown,
  options?: { readonly currentVersion?: number; readonly computeDigest?: (content: string) => string },
): { readonly ok: true; readonly value: BriefPackage; readonly schemaVersion: number; readonly explicitSchemaVersion: boolean } | { readonly ok: false; readonly code: BriefPackageRefusalCode } {
  const digestFn = options?.computeDigest ?? fallbackDigest;
  const snapshot = stableSnapshot(input);
  if (snapshot === null) {
    return { ok: false, code: 'malformed' };
  }
  for (const key of Object.keys(snapshot)) {
    if (!READER_ALLOWED_KEYS.includes(key)) {
      return { ok: false, code: 'malformed' };
    }
  }

  const manifestRaw = snapshot.manifestRaw;

  if (manifestRaw === undefined || manifestRaw === null) {
    const proseError = proseTextError(snapshot.prose, BRIEF_PACKAGE_MAX_PROSE_BYTES);
    if (proseError !== null) {
      return { ok: false, code: proseError };
    }
    const prose = snapshot.prose as string;
    const expected = snapshot.expectedBriefDigest;
    if (typeof expected !== 'string' || expected.trim().length === 0) {
      return { ok: false, code: 'invalid-field' };
    }
    if (digestFn(prose) !== expected) {
      return { ok: false, code: 'digest-mismatch' };
    }
    const created = BriefPackage.create({
      schemaVersion: INITIAL_RECORD_SCHEMA_VERSION,
      attemptId: snapshot.attemptId,
      briefDigest: expected,
      prosePath: snapshot.prosePath ?? '.lane/brief.md',
      manifestPath: snapshot.manifestPath ?? '.lane/brief-manifest.json',
      baseCommit: snapshot.baseCommit,
      policyRevision: snapshot.policyRevision,
      independentReviewer: snapshot.independentReviewer,
      ownedPaths: snapshot.ownedPaths,
      acceptanceSpec: snapshot.acceptanceSpec,
      limits: null,
      selectedContextVersions: null,
      ownerDecisionReferences: null,
      seatPlan: null,
      prNotes: null,
    });
    if (!created.success) {
      return { ok: false, code: created.code };
    }
    return { ok: true, value: created.value, schemaVersion: INITIAL_RECORD_SCHEMA_VERSION, explicitSchemaVersion: false };
  }

  if (typeof manifestRaw !== 'string') {
    return { ok: false, code: 'invalid-field' };
  }
  if (byteLength(manifestRaw) > BRIEF_PACKAGE_MAX_MANIFEST_BYTES) {
    return { ok: false, code: 'oversized' };
  }
  if (hasSecretShape(manifestRaw)) {
    return { ok: false, code: 'secret-shaped' };
  }
  if (manifestRaw.trim().length === 0) {
    return { ok: false, code: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw);
  } catch {
    return { ok: false, code: 'unreadable' };
  }
  const currentVersion = options?.currentVersion ?? BRIEF_PACKAGE_SCHEMA_VERSION;
  const versionRead = readRecordSchemaVersion(parsed, currentVersion);
  if (!versionRead.ok) {
    return { ok: false, code: versionRead.reason };
  }
  const snap = stableSnapshot(parsed);
  if (snap === null) {
    return { ok: false, code: 'malformed' };
  }

  const prose = snapshot.prose;
  const expectedBriefDigest = snapshot.expectedBriefDigest;
  if (prose !== undefined || expectedBriefDigest !== undefined) {
    const proseError = proseTextError(prose, BRIEF_PACKAGE_MAX_PROSE_BYTES);
    if (proseError !== null) {
      return { ok: false, code: proseError };
    }
    if (typeof expectedBriefDigest !== 'string' || expectedBriefDigest.trim().length === 0) {
      return { ok: false, code: 'invalid-field' };
    }
    if (digestFn((prose as string) + '\n' + manifestRaw) !== expectedBriefDigest) {
      return { ok: false, code: 'digest-mismatch' };
    }
  }

  const specCreated = AcceptanceSpec.create(snap.acceptanceSpec);
  if (!specCreated.success || specCreated.value === undefined) {
    return { ok: false, code: 'missing-acceptance-spec' };
  }

  const version = versionRead.schemaVersion;

  let limits: ExecutionLimits | null = null;
  if (snap.stepLimit !== undefined || snap.timeLimitSeconds !== undefined || snap.resourceBounds !== undefined) {
    const checked = limitsFromPlain(snap.stepLimit, snap.timeLimitSeconds, snap.resourceBounds);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    limits = checked.limits;
  } else if (version >= BRIEF_PACKAGE_SCHEMA_VERSION) {
    return { ok: false, code: 'invalid-limits' };
  }

  let selectedContextVersions: readonly BriefSelectedContextVersion[] | null = null;
  const rawContextVersions = snap.selectedKnowledgeVersions !== undefined && snap.selectedKnowledgeVersions !== null
    ? snap.selectedKnowledgeVersions
    : snap.selectedContextVersions;
  if (rawContextVersions !== undefined && rawContextVersions !== null) {
    const checked = validateContextVersions(rawContextVersions);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    selectedContextVersions = checked.versions;
  } else if (version >= BRIEF_PACKAGE_SCHEMA_VERSION) {
    return { ok: false, code: 'invalid-context-versions' };
  }

  let ownerDecisionReferences: readonly string[] | null = null;
  if (snap.ownerDecisionReferences !== undefined && snap.ownerDecisionReferences !== null) {
    const checked = validateDecisionRefs(snap.ownerDecisionReferences);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    ownerDecisionReferences = checked.refs;
  } else if (version >= BRIEF_PACKAGE_SCHEMA_VERSION) {
    return { ok: false, code: 'invalid-owner-decisions' };
  }

  let seatPlan: SeatPlan | null = null;
  if (snap.seatPlan !== undefined && snap.seatPlan !== null) {
    const planCreated = SeatPlan.create(snap.seatPlan);
    if (!planCreated.success || planCreated.value === undefined) {
      return { ok: false, code: 'invalid-seat-plan' };
    }
    const scanError = deepScanError(planCreated.value.toJSON(), BRIEF_PACKAGE_MAX_SCALAR_CHARS);
    if (scanError !== null) {
      return { ok: false, code: scanError };
    }
    seatPlan = planCreated.value;
  }

  let prNotes: BriefPrNotes | null = null;
  if (snap.prNotes !== undefined && snap.prNotes !== null) {
    const checked = validatePrNotes(snap.prNotes);
    if (!checked.ok) {
      return { ok: false, code: checked.code };
    }
    prNotes = checked.notes;
  }

  const created = BriefPackage.create({
    schemaVersion: version,
    attemptId: snapshot.attemptId,
    briefDigest:
      typeof expectedBriefDigest === 'string'
        ? expectedBriefDigest
        : digestFn((typeof prose === 'string' ? prose : '') + '\n' + manifestRaw),
    prosePath: snapshot.prosePath ?? '.lane/brief.md',
    manifestPath: snapshot.manifestPath ?? '.lane/brief-manifest.json',
    baseCommit: snapshot.baseCommit,
    policyRevision: snapshot.policyRevision,
    independentReviewer: snapshot.independentReviewer,
    ownedPaths: snapshot.ownedPaths,
    acceptanceSpec: specCreated.value,
    limits,
    selectedContextVersions,
    ownerDecisionReferences,
    seatPlan,
    prNotes,
  });
  if (!created.success) {
    return { ok: false, code: created.code };
  }
  return { ok: true, value: created.value, schemaVersion: version, explicitSchemaVersion: versionRead.explicit };
}
