import { randomBytes } from "node:crypto";

/**
 * A ULID minted for run-journal entry ids, on the Crockford base32 alphabet
 * the domain's own `REQUEST_ID_PATTERN` accepts: 10 timestamp characters over
 * `Date.now()` followed by 16 random characters, 26 in total, always matching
 * `/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`. No external package; randomness comes
 * from `node:crypto`. Throws only when a caller passes a negative or
 * non-integer `nowMs` explicitly; the default clock cannot.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newUlid(nowMs: number = Date.now()): string {
  const time = Math.floor(Number(nowMs));
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new Error("newUlid: nowMs must be a non-negative safe integer");
  }
  // 10 characters * 5 bits = 50 bits: every current millisecond timestamp
  // fits, and the leading character stays below 8 as the pattern requires.
  let id = "";
  let remaining = time;
  for (let i = 0; i < 10; i++) {
    id = ENCODING[remaining % 32]! + id;
    remaining = Math.floor(remaining / 32);
  }
  const random = randomBytes(16);
  for (let i = 0; i < 16; i++) {
    id += ENCODING[random[i]! % 32];
  }
  return id;
}
