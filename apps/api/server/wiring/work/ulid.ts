import { randomBytes } from "node:crypto";

/**
 * A ULID minted for run-journal entry ids, on the Crockford base32 alphabet
 * the domain's own `REQUEST_ID_PATTERN` accepts: 10 timestamp characters over
 * `Date.now()` (48 bits, per the ULID spec) followed by 16 characters of
 * 80-bit randomness from 10 `node:crypto` bytes, 26 in total, always matching
 * `/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`. No external package. Throws when a caller
 * passes a non-integer, negative or beyond-48-bit `nowMs` explicitly; the
 * default clock cannot.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 2^48 - 1: the largest timestamp a ULID can carry. */
export const ULID_MAX_TIME_MS = 281_474_976_710_655;

export function newUlid(nowMs: number = Date.now()): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > ULID_MAX_TIME_MS) {
    throw new Error("newUlid: nowMs must be an integer between 0 and 2^48 - 1");
  }
  let id = "";
  let remaining = nowMs;
  for (let i = 0; i < 10; i++) {
    id = ENCODING[remaining % 32]! + id;
    remaining = Math.floor(remaining / 32);
  }
  // 10 bytes = 80 bits = 16 characters of 5 bits.
  let bits = 0n;
  for (const byte of randomBytes(10)) {
    bits = (bits << 8n) | BigInt(byte);
  }
  for (let i = 15; i >= 0; i--) {
    id += ENCODING[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return id;
}
