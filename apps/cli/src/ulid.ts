/**
 * A ULID minter for the conductor's journal entry ids and run/attempt ids:
 * 48-bit milliseconds then 80 random bits, Crockford base32, 26 characters
 * (`REQUEST_ID_PATTERN`, the O1b-1 ULID shape). The composition root mints;
 * the clock and the random source are injectable for tests.
 */

import { randomBytes } from 'node:crypto';

/** Crockford base32 without I, L, O and U. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const MAX_TIME_MS = 2 ** 48 - 1;

/** A ULID: 48-bit milliseconds then 80 random bits, Crockford base32, 26 characters. */
export function newUlid(
  nowMs: number = Date.now(),
  random: (size: number) => Uint8Array = (size) => randomBytes(size),
): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIME_MS) {
    throw new RangeError(`newUlid: nowMs must be a safe integer in 0 .. ${MAX_TIME_MS}`);
  }
  let value = 0n;
  for (const byte of random(10)) {
    value = (value << 8n) | BigInt(byte);
  }
  // The 48-bit time sits in the top bits, above the 80 random ones.
  value |= BigInt(nowMs) << 80n;
  let out = '';
  for (let shift = 125n; shift >= 0n; shift -= 5n) {
    out += ENCODING[Number((value >> shift) & 31n)];
  }
  return out;
}
