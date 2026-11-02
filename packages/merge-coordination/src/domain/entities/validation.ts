/**
 * The result shape every merge-coordination validator and the train state
 * machine returns. Nothing in this domain throws on hostile input: a refused
 * value is a result with a reason, never an exception.
 */

export type ValidationOk<T> = { readonly ok: true; readonly value: T };

export type ValidationRefused = { readonly ok: false; readonly reason: string };

export type ValidationResult<T> = ValidationOk<T> | ValidationRefused;

/** Build a refused result with a stable, human-readable reason. */
export function refused<T>(reason: string): ValidationResult<T> {
  return { ok: false, reason };
}

/** Build an accepted result carrying the parsed value. */
export function accepted<T>(value: T): ValidationOk<T> {
  return { ok: true, value };
}

/** A full commit id: 40 lower-case hex characters. */
export const SHA40_PATTERN = /^[0-9a-f]{40}$/;

/** Whether a value is a full, lower-case 40-character hex commit id. */
export function isSha40(value: unknown): value is string {
  return typeof value === 'string' && SHA40_PATTERN.test(value);
}

/** Whether a value is a positive integer (1, 2, 3, ...; never 0 or negative). */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Whether a value is a non-empty plain string. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
