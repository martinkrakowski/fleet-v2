/**
 * RV4: the screen applied to transport stderr before it is archived. The
 * archive content must never carry a secret match or an absolute path: every
 * secret-pattern match (the shared six and the lane-diff canonical seventeen)
 * becomes `[redacted]`, every absolute-path token becomes `[path]`, and the
 * result is capped at 2048 bytes. Pure; total — a throw returns `null`, never
 * `''` and never a crash.
 */

import { LANE_DIFF_SECRET_PATTERNS, SECRET_PATTERNS } from '@fleet/shared';

const REDACTED = '[redacted]';
const PATH_TOKEN = '[path]';
const MAX_SCREEN_BYTES = 2048;
const ABSOLUTE_PATH_TOKEN_PATTERN = /\/\S+/g;

/** Replace every match of `pattern` in `text` with `replacement`, never throwing. */
function replaceAll(pattern: RegExp, text: string, replacement: string): string {
  try {
    const global = pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, pattern.flags + 'g');
    return text.replace(global, replacement);
  } catch {
    return text;
  }
}

/** Cap a string at `maxBytes` UTF-8 bytes without throwing. */
function capUtf8Bytes(text: string, maxBytes: number): string {
  try {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
      return text;
    }
    return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  } catch {
    return text.slice(0, maxBytes);
  }
}

/**
 * The screened transport text: secret patterns and absolute paths replaced,
 * capped at 2048 bytes. `null` when the input is not a string or any step
 * throws — never `''` and never a thrown error.
 */
export function screenTransportText(text: string): string | null {
  try {
    if (typeof text !== 'string') {
      return null;
    }
    let screened = text;
    for (const pattern of SECRET_PATTERNS) {
      screened = replaceAll(pattern, screened, REDACTED);
    }
    for (const entry of LANE_DIFF_SECRET_PATTERNS) {
      screened = replaceAll(entry.regex, screened, REDACTED);
    }
    screened = screened.replace(ABSOLUTE_PATH_TOKEN_PATTERN, PATH_TOKEN);
    return capUtf8Bytes(screened, MAX_SCREEN_BYTES);
  } catch {
    return null;
  }
}
