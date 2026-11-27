/**
 * FC17F: pure expand-contract migration checker. Given a candidate migration
 * list and a required `isProxy` detector, either accept the plan (every
 * destructive step is scheduled strictly after its code-cutoff release) or
 * refuse with a typed result naming the offending migration and step.
 *
 * Domain-only: no port, no adapter, no persistence, no clock read, no
 * randomness, no I/O, no `console`. Hostile inputs are read through the
 * shared `snapshotPlainData` (one pass, zero Proxy traps, zero getters) and
 * the descriptor-based `readExactPlainRecord`, so no getter and no Proxy
 * `get` trap ever runs. No rejected input value is ever echoed into a
 * refusal.
 */

import { snapshotPlainData, type IsProxy } from '@fleet/shared';

import { readExactPlainRecord } from './plain-record-reads.js';

/** Hard cap on how many migrations a single check may carry. */
export const MAX_MIGRATIONS = 256;

/** Hard cap on how many steps a single migration may carry. */
export const MAX_STEPS_PER_MIGRATION = 64;

/** Snapshot limits sized to this unit's domain (see the FC17F brief). */
const EXPAND_CONTRACT_LIMITS = {
  maxDepth: 6,
  maxKeys: 16,
  maxArrayLength: MAX_MIGRATIONS,
  maxNodes: 70_000,
  maxStringLength: 256,
} as const;

/** A step that only adds structure or data and can never break old code. */
export type AdditiveStepClass =
  | 'create-table'
  | 'add-column'
  | 'add-index'
  | 'backfill'
  | 'widen-type';

/** A step that removes or reshapes structure and must wait for the cutoff. */
export type DestructiveStepClass =
  | 'drop'
  | 'rename'
  | 'type-narrowing'
  | 'add-not-null-without-default';

/** Any recognised migration step class. */
export type MigrationStepKind = AdditiveStepClass | DestructiveStepClass;

const ADDITIVE_CLASSES: ReadonlySet<string> = new Set<AdditiveStepClass>([
  'create-table',
  'add-column',
  'add-index',
  'backfill',
  'widen-type',
]);

const DESTRUCTIVE_CLASSES: ReadonlySet<string> = new Set<DestructiveStepClass>([
  'drop',
  'rename',
  'type-narrowing',
  'add-not-null-without-default',
]);

/** One migration step: what it does, to what, and when its code cutoff is. */
export interface ExpandContractStep {
  readonly kind: MigrationStepKind;
  readonly target: string;
  readonly codeCutoffRelease: number;
}

/** One migration: the release it ships in and its ordered steps. */
export interface ExpandContractMigration {
  readonly release: number;
  readonly steps: readonly ExpandContractStep[];
}

/** Every typed refusal reason the checker can return. */
export type ExpandContractRefusalReason =
  | 'invalid-migrations-list'
  | 'too-many-migrations'
  | 'invalid-migration-record'
  | 'too-many-steps'
  | 'invalid-migration-step'
  | 'unknown-migration-step'
  | 'destructive-before-or-at-cutoff';

/** Typed outcome: a counted pass, or a refusal naming the offending record. */
export type ExpandContractCheckResult =
  | { readonly ok: true; readonly checkedMigrations: number; readonly checkedSteps: number }
  | {
    readonly ok: false;
    readonly reason: ExpandContractRefusalReason;
    readonly migrationIndex?: number;
    readonly stepIndex?: number;
    readonly violationClass?: DestructiveStepClass;
  };

const INVALID_MIGRATIONS_LIST: ExpandContractCheckResult = {
  ok: false,
  reason: 'invalid-migrations-list',
};

/** A non-negative safe integer release number. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Map a snapshot refusal to the typed check result using the FC17F path
 * table. The snapshot path always starts at the root array, so every
 * non-null path is `[i]`, `[i].steps`, or `[i].steps[j]...`.
 */
function mapSnapshotRefusal(reason: string, path: string | null): ExpandContractCheckResult {
  if (path === null) {
    // `too-many-items` at the root is the O(1) length refusal for the
    // migration list itself; every other root refusal (including
    // `detector-threw` for a missing or non-function `isProxy`) is an
    // invalid list.
    return reason === 'too-many-items'
      ? { ok: false, reason: 'too-many-migrations' }
      : INVALID_MIGRATIONS_LIST;
  }
  const stepsExact = /^\[(\d+)\]\.steps$/.exec(path);
  if (stepsExact !== null && reason === 'too-many-items') {
    return { ok: false, reason: 'too-many-steps', migrationIndex: Number(stepsExact[1]) };
  }
  const stepElement = /^\[(\d+)\]\.steps\[(\d+)\]/.exec(path);
  if (stepElement !== null) {
    return {
      ok: false,
      reason: 'invalid-migration-step',
      migrationIndex: Number(stepElement[1]),
      stepIndex: Number(stepElement[2]),
    };
  }
  const migration = /^\[(\d+)\]/.exec(path);
  if (migration !== null) {
    return {
      ok: false,
      reason: 'invalid-migration-record',
      migrationIndex: Number(migration[1]),
    };
  }
  return INVALID_MIGRATIONS_LIST;
}

/**
 * Validate one snapped migration record's shape and its steps. Returns either
 * a refusal or the number of steps checked; the caller accumulates the count.
 */
function validateMigration(
  rawMigration: unknown,
  migrationIndex: number,
): ExpandContractCheckResult | { readonly ok: true; readonly checkedSteps: number } {
  const migration = readExactPlainRecord(rawMigration, ['release', 'steps']);
  if (migration === null) {
    return { ok: false, reason: 'invalid-migration-record', migrationIndex };
  }
  if (!isNonNegativeSafeInteger(migration.release)) {
    return { ok: false, reason: 'invalid-migration-record', migrationIndex };
  }
  const steps = migration.steps;
  if (!Array.isArray(steps)) {
    return { ok: false, reason: 'invalid-migration-record', migrationIndex };
  }
  if (steps.length > MAX_STEPS_PER_MIGRATION) {
    return { ok: false, reason: 'too-many-steps', migrationIndex };
  }
  const release = migration.release;
  let checkedSteps = 0;
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const step = readExactPlainRecord(steps[stepIndex], ['kind', 'target', 'codeCutoffRelease']);
    if (step === null) {
      return {
        ok: false,
        reason: 'invalid-migration-step',
        migrationIndex,
        stepIndex,
      };
    }
    const target = step.target;
    if (typeof target !== 'string' || target.length === 0 || target.trim() !== target) {
      return {
        ok: false,
        reason: 'invalid-migration-step',
        migrationIndex,
        stepIndex,
      };
    }
    if (!isNonNegativeSafeInteger(step.codeCutoffRelease)) {
      return {
        ok: false,
        reason: 'invalid-migration-step',
        migrationIndex,
        stepIndex,
      };
    }
    const kind = step.kind;
    if (
      typeof kind !== 'string'
      || (!ADDITIVE_CLASSES.has(kind) && !DESTRUCTIVE_CLASSES.has(kind))
    ) {
      return {
        ok: false,
        reason: 'unknown-migration-step',
        migrationIndex,
        stepIndex,
      };
    }
    checkedSteps += 1;
    // Expand-contract rule: a destructive step is only allowed strictly
    // after its code-cutoff release. At or before the cutoff it would change
    // behaviour for code that is still deployed, so it refuses.
    if (DESTRUCTIVE_CLASSES.has(kind) && release <= step.codeCutoffRelease) {
      return {
        ok: false,
        reason: 'destructive-before-or-at-cutoff',
        migrationIndex,
        stepIndex,
        violationClass: kind as DestructiveStepClass,
      };
    }
  }
  return { ok: true, checkedSteps };
}

/**
 * Pure, synchronous, deterministic check of an expand-contract migration
 * plan. `isProxy` is a required positional parameter with no default value;
 * in production it is `types.isProxy` from `node:util`. Never throws and
 * never echoes a rejected input value.
 */
export function checkExpandContract(
  migrations: unknown,
  isProxy: IsProxy,
): ExpandContractCheckResult {
  try {
    // Single snapshot pass: zero Proxy traps, zero getters, every bound from
    // EXPAND_CONTRACT_LIMITS (the `maxArrayLength` length check runs in O(1)
    // before any `Reflect.ownKeys`).
    const snapshot = snapshotPlainData(migrations, isProxy, EXPAND_CONTRACT_LIMITS);
    if (!snapshot.ok) {
      return mapSnapshotRefusal(snapshot.reason, snapshot.path);
    }
    const snapped = snapshot.value;
    if (!Array.isArray(snapped)) {
      return INVALID_MIGRATIONS_LIST;
    }
    let checkedSteps = 0;
    for (let migrationIndex = 0; migrationIndex < snapped.length; migrationIndex += 1) {
      const outcome = validateMigration(snapped[migrationIndex], migrationIndex);
      if (!outcome.ok) {
        return outcome;
      }
      checkedSteps += outcome.checkedSteps;
    }
    return { ok: true, checkedMigrations: snapped.length, checkedSteps };
  } catch {
    // A revoked or lying Proxy that throws anywhere along the read path is
    // mapped to the typed refusal; a Proxy that lies consistently in every
    // trap is the accepted residual.
    return INVALID_MIGRATIONS_LIST;
  }
}
