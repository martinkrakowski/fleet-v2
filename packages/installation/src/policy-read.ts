/**
 * Shared readers for installation policy blocks (OT4a, K2, SR2). Pure and internal: not exported from the
 * package root. A record is read only through its own data properties, so a getter never runs.
 */

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function readOwnDataProperty(record: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

export function hasUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      return true;
    }
  }
  return false;
}

/** An integer within the inclusive bounds, else undefined. */
export function readBoundedInteger(
  value: unknown,
  bounds: Readonly<{ min: number; max: number }>,
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < bounds.min || value > bounds.max) {
    return undefined;
  }
  return value;
}
