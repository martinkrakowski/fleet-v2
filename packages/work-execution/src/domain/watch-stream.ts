/**
 * A pure watch-stream line redactor and bounded ring buffer.
 *
 * Watch output that is about to leave the host must be redacted against the
 * canonical secret-shape registry before it is stored or read back, and the
 * buffer holding it must be bounded in lines, bytes and age so a runaway
 * command cannot grow memory without limit. No input value is ever echoed
 * into a refusal, and no matched secret text is ever returned or logged:
 * every matched span is replaced by `[REDACTED:<rule name>]`.
 *
 * Domain code is pure: there is no `node:*` import, no I/O, and no clock
 * access — `nowMs` is always an argument. Because the trusted hostile-input
 * helper `snapshotPlainData` needs a proxy detector and the domain cannot
 * import `node:util/types`, both reading functions require a mandatory
 * `isProxy: IsProxy` parameter (no default); callers in infrastructure and
 * tests pass the real `types.isProxy` from `node:util/types`.
 */

import {
  LANE_DIFF_SECRET_PATTERNS,
  snapshotPlainData,
  type IsProxy,
  type NamedSecretPattern,
  type PlainDataLimits,
} from '@fleet/shared';

/** The hard bounds of every watch buffer, shared by append and read. */
export const WATCH_BUFFER_LIMITS = Object.freeze({
  maxBytes: 524_288,
  maxLines: 2000,
  maxAgeMs: 86_400_000,
  maxLineChars: 16_384,
} as const);

/**
 * Global copies of the registry regexes, precompiled once at module load in
 * exact `LANE_DIFF_SECRET_PATTERNS` order so every match on a line is found
 * (the registry's own regexes carry no `g` flag). The order matters: where
 * two rules match the same span (an OpenRouter key is also an OpenAI-style
 * key) the FIRST registry rule names the redaction.
 */
const COMPILED_SECRET_PATTERNS: readonly NamedSecretPattern[] =
  LANE_DIFF_SECRET_PATTERNS.map((entry) => ({
    name: entry.name,
    regex: new RegExp(entry.regex.source, 'g'),
  }));

/** One kept line of watch output: its position, redacted text and byte size. */
export interface WatchEntry {
  readonly seq: number;
  readonly text: string;
  readonly bytes: number;
  readonly atMs: number;
}

/** The bounded ring buffer of redacted watch output. */
export interface WatchBuffer {
  readonly entries: readonly WatchEntry[];
  readonly totalBytes: number;
  readonly lastSeq: number;
}

export type RedactWatchLineResult =
  | {
      readonly ok: true;
      readonly line: string;
      readonly redacted: boolean;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: 'non-string' };

export type DetectorRefusal = { readonly ok: false; readonly reason: 'invalid-detector' };

export type ReadWatchBufferResult =
  | { readonly ok: true; readonly buffer: WatchBuffer }
  | DetectorRefusal
  | { readonly ok: false; readonly reason: 'invalid-buffer' };

export type ReadLinesArrayResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | DetectorRefusal
  | { readonly ok: false; readonly reason: 'invalid-lines' | 'non-string-line' };

export type AppendWatchLinesResult =
  | { readonly ok: true; readonly buffer: WatchBuffer }
  | DetectorRefusal
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-buffer'
        | 'invalid-lines'
        | 'non-string-line'
        | 'invalid-timestamp';
    };

export type ReadWatchLinesAfterResult =
  | { readonly ok: true; readonly lines: readonly string[]; readonly nextCursor: number }
  | DetectorRefusal
  | {
      readonly ok: false;
      readonly reason: 'invalid-buffer' | 'invalid-cursor' | 'invalid-timestamp' | 'cursor-expired';
    };

/**
 * Snapshot bounds for an untrusted `lines` batch: one array node plus at most
 * `maxLines` string elements at depth 2, each element at most `maxBytes`
 * characters (a longer element is refused by the snapshot before any scan).
 * `maxKeys: 0` refuses any object root (an array-like is never a valid batch);
 * `maxArrayLength` enforces the line cap before walking.
 */
const LINES_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 2,
  maxKeys: 0,
  maxArrayLength: WATCH_BUFFER_LIMITS.maxLines,
  maxNodes: WATCH_BUFFER_LIMITS.maxLines + 1,
  maxStringLength: WATCH_BUFFER_LIMITS.maxBytes,
});

/**
 * Snapshot bounds for an untrusted `buffer`: root (1) + 3 fields + up to
 * `maxLines` entry objects + 4 fields each, so `maxLines * 5 + 10` nodes
 * bounds the whole shape; depth 4 covers root -> entries -> entry -> field.
 */
const BUFFER_SNAPSHOT_LIMITS: PlainDataLimits = Object.freeze({
  maxDepth: 4,
  maxKeys: 4,
  maxArrayLength: WATCH_BUFFER_LIMITS.maxLines,
  maxNodes: WATCH_BUFFER_LIMITS.maxLines * 5 + 10,
  maxStringLength: WATCH_BUFFER_LIMITS.maxLineChars,
});

const BUFFER_KEYS: readonly string[] = ['entries', 'totalBytes', 'lastSeq'];
const ENTRY_KEYS: readonly string[] = ['seq', 'text', 'bytes', 'atMs'];

/** Whether the number is a usable non-negative integer timestamp or counter. */
function isIndex(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Whether `nowMs` is a valid wall-clock reading: a finite, non-negative integer
 * (`-0` is refused by the `Object.is` check, `NaN` and the infinities by the
 * `isInteger` check). Cost: `O(1)` primitive checks, no property access.
 */
function isTimestamp(nowMs: unknown): nowMs is number {
  return isIndex(nowMs) && !Object.is(nowMs, -0);
}

/**
 * Whether the integer is a valid cursor: a non-negative integer that does not
 * run ahead of what the buffer has emitted. Cost: `O(1)` primitive checks.
 */
function isCursor(cursor: unknown, lastSeq: number): cursor is number {
  return (
    isIndex(cursor) && !Object.is(cursor, -0) && Number.isFinite(cursor) && cursor <= lastSeq
  );
}

/** A fresh refusal per call so a shared instance can never be mutated. */
function refusal<T extends string>(reason: T): { ok: false; reason: T } {
  return Object.freeze({ ok: false as const, reason });
}

/**
 * Redacts every secret shape in a line. The line is first truncated to
 * `maxLineChars`, then every compiled pattern is scanned against the ORIGINAL
 * truncated line; overlapping match spans are merged and each merged span is
 * replaced by the name of the first registry rule that matched inside it.
 *
 * Cost bound: `O(1)` type check before any property or method access,
 * `O(maxLineChars)` truncation, `O(maxLineChars * P)` span collection over the
 * `P` compiled patterns, `O(S log S)` span sort and `O(S)` merge and rebuild
 * where `S <= maxLineChars * P` is itself bounded by `maxLineChars`.
 */
export function redactWatchLine(line: unknown): RedactWatchLineResult {
  // O(1) type check before any property or method access: a hostile object
  // with a throwing getter is refused without invoking anything.
  if (typeof line !== 'string') {
    return refusal('non-string');
  }
  const truncated = line.length > WATCH_BUFFER_LIMITS.maxLineChars;
  const subject = truncated ? line.slice(0, WATCH_BUFFER_LIMITS.maxLineChars) : line;

  interface Span {
    start: number;
    end: number;
    patternIndex: number;
  }
  const spans: Span[] = [];
  for (let index = 0; index < COMPILED_SECRET_PATTERNS.length; index += 1) {
    const pattern = COMPILED_SECRET_PATTERNS[index]!;
    pattern.regex.lastIndex = 0;
    for (;;) {
      const match = pattern.regex.exec(subject);
      if (match === null) {
        break;
      }
      if (match[0]!.length > 0) {
        spans.push({ start: match.index, end: match.index + match[0]!.length, patternIndex: index });
      } else {
        // Defensive bound: no registry rule matches the empty string, but a
        // zero-length match would spin the exec loop forever.
        pattern.regex.lastIndex += 1;
      }
      if (pattern.regex.lastIndex >= subject.length) {
        break;
      }
    }
  }

  if (spans.length === 0) {
    return Object.freeze({ ok: true as const, line: subject, redacted: false, truncated });
  }

  spans.sort((a, b) => a.start - b.start || a.patternIndex - b.patternIndex);
  // Merge overlapping spans (`next.start < current.end`), keeping the widest
  // end and the FIRST registry rule that matched inside the merged span; the
  // while-loop cascades so a span bridging two earlier merged spans is folded
  // into one cover.
  const merged: Span[] = [];
  for (const span of spans) {
    let current = span;
    while (merged.length > 0) {
      const last = merged[merged.length - 1]!;
      if (current.start >= last.end) {
        break;
      }
      merged.pop();
      current = {
        start: last.start,
        end: Math.max(last.end, current.end),
        patternIndex: Math.min(last.patternIndex, current.patternIndex),
      };
    }
    merged.push(current);
  }

  // Redaction can expand a span (a 20-char key becomes a longer marker), so
  // the rebuild runs against a budget of maxLineChars: plain text is clipped
  // at the budget, but a marker is emitted whole or not at all (output stops
  // at the first marker that does not fit), so a marker is never cut short
  // and no matched text can ever follow a dropped marker.
  const budget = WATCH_BUFFER_LIMITS.maxLineChars;
  let rebuilt = '';
  let previous = 0;
  let stopped = false;
  for (const span of merged) {
    const plain = subject.slice(previous, span.start);
    if (rebuilt.length + plain.length > budget) {
      rebuilt += plain.slice(0, budget - rebuilt.length);
      stopped = true;
      break;
    }
    rebuilt += plain;
    const marker = `[REDACTED:${LANE_DIFF_SECRET_PATTERNS[span.patternIndex]!.name}]`;
    if (rebuilt.length + marker.length > budget) {
      stopped = true;
      break;
    }
    rebuilt += marker;
    previous = span.end;
  }
  if (!stopped) {
    const tail = subject.slice(previous);
    rebuilt += tail.slice(0, Math.max(0, budget - rebuilt.length));
  }
  const finalLine = rebuilt;
  return Object.freeze({
    ok: true as const,
    line: finalLine,
    redacted: true,
    truncated,
  });
}

/**
 * Returns a fresh, frozen empty `WatchBuffer`. Cost: `O(1)` allocation and
 * freeze.
 */
export function emptyWatchBuffer(): WatchBuffer {
  return Object.freeze({
    entries: Object.freeze([]),
    totalBytes: 0,
    lastSeq: 0,
  });
}

/**
 * Validates an untrusted watch buffer without touching any of its references
 * directly: the snapshot reads everything through property descriptors, so
 * getters are never run, Proxies are never trapped, and `__proto__` own keys,
 * extra keys, non-plain prototypes and sparse arrays are typed refusals.
 *
 * Every entry's claimed `bytes` is re-derived from its `text` with a UTF-8
 * encoding and `totalBytes` from the re-derived per-entry bytes: a structurally
 * valid buffer whose claimed sizes understate its real byte weight (for
 * example long lines carrying `bytes: 0`) is refused instead of being allowed
 * to bypass the `maxBytes` cap on append or read.
 *
 * Cost bound: `O(1)` detector check; `O(own keys), one enumeration` for the
 * top-level record plus `O(M)` entry validation inside `snapshotPlainData`,
 * bounded by `M <= maxLines` (2000) and `maxNodes`; `O(M * maxLineChars)`
 * UTF-8 re-derivation of the claimed byte sizes.
 */
export function readWatchBuffer(buffer: unknown, isProxy: IsProxy): ReadWatchBufferResult {
  if (typeof isProxy !== 'function') {
    return refusal('invalid-detector');
  }
  const snap = snapshotPlainData(buffer, isProxy, BUFFER_SNAPSHOT_LIMITS);
  if (!snap.ok) {
    // A throwing detector is a detector problem, not a buffer problem: it
    // surfaces as 'detector-threw' on the value, or as 'invalid-limits' when
    // the detector throws while the snapshot vetoes our (constant, valid)
    // limits object before it ever reaches the value.
    if (snap.reason === 'detector-threw' || snap.reason === 'invalid-limits') {
      return refusal('invalid-detector');
    }
    return refusal('invalid-buffer');
  }
  const value = snap.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refusal('invalid-buffer');
  }
  // One enumeration: exactly the 3 required keys, no extras, no symbol key
  // (the snapshot already refused symbols and non-enumerables).
  const keys = Object.keys(value);
  if (keys.length !== BUFFER_KEYS.length) {
    return refusal('invalid-buffer');
  }
  for (const key of keys) {
    if (!BUFFER_KEYS.includes(key)) {
      return refusal('invalid-buffer');
    }
  }
  const record = value as Record<string, unknown>;
  const entries = record['entries'];
  if (!Array.isArray(entries)) {
    return refusal('invalid-buffer');
  }
  let byteSum = 0;
  const rederived: WatchEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return refusal('invalid-buffer');
    }
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== ENTRY_KEYS.length) {
      return refusal('invalid-buffer');
    }
    for (const key of entryKeys) {
      if (!ENTRY_KEYS.includes(key)) {
        return refusal('invalid-buffer');
      }
    }
    const fields = entry as Record<string, unknown>;
    if (!isIndex(fields['seq']) || !isIndex(fields['atMs'])) {
      return refusal('invalid-buffer');
    }
    if (typeof fields['text'] !== 'string') {
      return refusal('invalid-buffer');
    }
    // The claimed byte size must match the text it stands for: re-derive the
    // UTF-8 length instead of trusting the caller's `bytes`.
    const text = fields['text'];
    const realBytes = new TextEncoder().encode(text).byteLength;
    if (!isIndex(fields['bytes']) || fields['bytes'] !== realBytes) {
      return refusal('invalid-buffer');
    }
    byteSum += realBytes;
    rederived.push(
      Object.freeze({
        seq: fields['seq'],
        text,
        bytes: realBytes,
        atMs: fields['atMs'],
      }),
    );
  }
  if (!isIndex(record['totalBytes']) || !isIndex(record['lastSeq'])) {
    return refusal('invalid-buffer');
  }
  // The claimed total must match the sum of the re-derived entry sizes, and
  // the whole buffer must actually fit the caps: a buffer already over
  // maxBytes (or over maxLines) must be refused on read, not silently
  // tolerated until the next append happens to trim it.
  if (record['totalBytes'] !== byteSum) {
    return refusal('invalid-buffer');
  }
  if (entries.length > WATCH_BUFFER_LIMITS.maxLines || byteSum > WATCH_BUFFER_LIMITS.maxBytes) {
    return refusal('invalid-buffer');
  }
  // Entry positions must be ordered and consistent with lastSeq: append
  // assigns consecutive 1-based seqs, so the kept entries must run
  // consecutively up to lastSeq (older entries having been evicted from the
  // front). A buffer with seqs [2, 1] or a lastSeq that disagrees with the
  // entry positions would make the read cursor arithmetic slice by the wrong
  // positions, so it is refused here.
  const lastSeq = record['lastSeq'] as number;
  if (entries.length > lastSeq) {
    return refusal('invalid-buffer');
  }
  const firstSeq = lastSeq - entries.length + 1;
  for (let index = 0; index < entries.length; index += 1) {
    if (rederived[index]!.seq !== firstSeq + index) {
      return refusal('invalid-buffer');
    }
    // Timestamps must not run backwards: age eviction removes a prefix, which
    // is only sound when entries are ordered by time.
    if (index > 0 && rederived[index]!.atMs < rederived[index - 1]!.atMs) {
      return refusal('invalid-buffer');
    }
  }
  return Object.freeze({
    ok: true as const,
    buffer: Object.freeze({
      entries: Object.freeze(rederived),
      totalBytes: byteSum,
      lastSeq,
    }),
  });
}

/**
 * Validates an untrusted `lines` batch: an array of at most `maxLines`
 * strings. Structural refusals (array-likes, holes, element getters,
 * prototype-polluting keys, Proxies, oversized batches) map to
 * `invalid-lines`; a batch whose element is not a string maps to
 * `non-string-line`.
 *
 * Cost bound: `O(1)` detector check; `O(1)` array `length` pre-gate plus
 * `O(own keys), one enumeration` and `O(maxLines)` element walk inside
 * `snapshotPlainData`, bounded by `WATCH_BUFFER_LIMITS`.
 */
export function readLinesArray(lines: unknown, isProxy: IsProxy): ReadLinesArrayResult {
  if (typeof isProxy !== 'function') {
    return refusal('invalid-detector');
  }
  const snap = snapshotPlainData(lines, isProxy, LINES_SNAPSHOT_LIMITS);
  if (!snap.ok) {
    // A throwing detector is a detector problem, not a batch problem (see
    // readWatchBuffer for why 'invalid-limits' belongs here too).
    if (snap.reason === 'detector-threw' || snap.reason === 'invalid-limits') {
      return refusal('invalid-detector');
    }
    // A value sitting in the batch that cannot be a string is an element type
    // problem (element paths look like `[12]`): unsupported primitives and
    // objects whose shape exceeds the snapshot depth. Structural array
    // refusals (holes, element accessors, non-enumerables, Proxies) and limit
    // overruns stay 'invalid-lines'.
    const elementPath = /^\[\d+\]/.test(snap.path ?? '');
    if (elementPath
      && (snap.reason === 'unsupported-type'
        || snap.reason === 'too-deep'
        || snap.reason === 'not-plain'
        || snap.reason === 'too-many-keys'
        || snap.reason === 'non-finite-number'
        || snap.reason === 'negative-zero')) {
      return refusal('non-string-line');
    }
    return refusal('invalid-lines');
  }
  const value = snap.value;
  if (!Array.isArray(value)) {
    return refusal('invalid-lines');
  }
  for (const element of value) {
    if (typeof element !== 'string') {
      return refusal('non-string-line');
    }
  }
  return Object.freeze({ ok: true as const, lines: Object.freeze(value as string[]) });
}

/**
 * Appends redacted lines to a watch buffer, evicting expired and overflowed
 * entries, and returns a NEW frozen buffer (the input is never mutated).
 *
 * Cost bound: `O(1)` detector and timestamp checks; snapshot costs as in
 * `readWatchBuffer`/`readLinesArray`; `O(N * maxLineChars * P)` redaction over
 * at most `N <= maxLines` lines; `O(M + N)` eviction where `M <= maxLines`.
 */
export function appendWatchLines(
  buffer: unknown,
  lines: unknown,
  nowMs: unknown,
  isProxy: IsProxy,
): AppendWatchLinesResult {
  if (typeof isProxy !== 'function') {
    return refusal('invalid-detector');
  }
  if (!isTimestamp(nowMs)) {
    return refusal('invalid-timestamp');
  }
  const bufferRead = readWatchBuffer(buffer, isProxy);
  if (!bufferRead.ok) {
    return bufferRead.reason === 'invalid-detector'
      ? refusal('invalid-detector')
      : refusal('invalid-buffer');
  }
  const linesRead = readLinesArray(lines, isProxy);
  if (!linesRead.ok) {
    return linesRead.reason === 'invalid-detector'
      ? refusal('invalid-detector')
      : refusal(linesRead.reason);
  }

  // A clock reading earlier than the newest kept entry would break the time
  // order that age eviction relies on, so it is refused as a timestamp.
  const newest = bufferRead.buffer.entries[bufferRead.buffer.entries.length - 1];
  if (newest !== undefined && nowMs < newest.atMs) {
    return refusal('invalid-timestamp');
  }

  // Evict entries older than maxAgeMs before appending (entries stamped in
  // the future are not older, so they stay until time passes them).
  const oldestAllowed = nowMs - WATCH_BUFFER_LIMITS.maxAgeMs;
  // Entries already in a caller-supplied buffer may carry text that never
  // passed the append-time redaction: re-redact every kept entry (and
  // re-derive its byte size) so the returned buffer never stores a secret.
  const kept: WatchEntry[] = [];
  let totalBytes = 0;
  for (const entry of bufferRead.buffer.entries) {
    if (entry.atMs < oldestAllowed) {
      continue;
    }
    const redaction = redactWatchLine(entry.text);
    if (!redaction.ok) {
      return refusal('invalid-buffer');
    }
    const bytes = new TextEncoder().encode(redaction.line).byteLength;
    kept.push(Object.freeze({ seq: entry.seq, text: redaction.line, bytes, atMs: entry.atMs }));
    totalBytes += bytes;
  }

  // A sequence counter that cannot advance exactly by the batch size would
  // repeat a seq and let a cursor skip lines: refuse instead of wrapping.
  if (bufferRead.buffer.lastSeq + linesRead.lines.length > Number.MAX_SAFE_INTEGER) {
    return refusal('invalid-buffer');
  }

  let lastSeq = bufferRead.buffer.lastSeq;
  const appended: WatchEntry[] = [];
  for (const text of linesRead.lines) {
    const redaction = redactWatchLine(text);
    // Unreachable in practice: readLinesArray already proved every element a
    // string; the guard keeps the type narrow without trusting it blindly.
    if (!redaction.ok) {
      return refusal('non-string-line');
    }
    lastSeq += 1;
    appended.push(
      Object.freeze({
        seq: lastSeq,
        text: redaction.line,
        bytes: new TextEncoder().encode(redaction.line).byteLength,
        atMs: nowMs,
      }),
    );
  }

  const entries = kept.concat(appended);
  totalBytes += appended.reduce((sum, entry) => sum + entry.bytes, 0);

  // Enforce the caps by dropping the OLDEST entries (array front).
  while (entries.length > WATCH_BUFFER_LIMITS.maxLines) {
    totalBytes -= entries[0]!.bytes;
    entries.shift();
  }
  while (totalBytes > WATCH_BUFFER_LIMITS.maxBytes && entries.length > 0) {
    totalBytes -= entries[0]!.bytes;
    entries.shift();
  }

  return Object.freeze({
    ok: true as const,
    buffer: Object.freeze({
      entries: Object.freeze(entries),
      totalBytes,
      lastSeq,
    }),
  });
}

/**
 * Reads the redacted lines positioned after `cursor`, silently filtering out
 * entries that age expiry has invalidated (the input buffer is never
 * mutated). A cursor that predates the oldest kept entry — because lines were
 * dropped by the `maxLines`/`maxBytes` caps or by age — is refused as
 * expired rather than silently skipping lines. Every line is redacted again
 * on the way out: a structurally valid caller-supplied buffer may carry text
 * that never passed the append-time redaction, and a read must never return
 * it verbatim.
 *
 * Cost bound: `O(1)` detector, cursor and timestamp checks; `O(own keys), one
 * enumeration` for the buffer plus `O(M)` entry validation inside
 * `snapshotPlainData` bounded by `M <= maxLines` (2000); `O(M)` age filter
 * and slice.
 */
export function readWatchLinesAfter(
  buffer: unknown,
  cursor: unknown,
  nowMs: unknown,
  isProxy: IsProxy,
): ReadWatchLinesAfterResult {
  if (typeof isProxy !== 'function') {
    return refusal('invalid-detector');
  }
  const bufferRead = readWatchBuffer(buffer, isProxy);
  if (!bufferRead.ok) {
    return bufferRead.reason === 'invalid-detector'
      ? refusal('invalid-detector')
      : refusal('invalid-buffer');
  }
  if (!isTimestamp(nowMs)) {
    return refusal('invalid-timestamp');
  }
  if (!isCursor(cursor, bufferRead.buffer.lastSeq)) {
    return refusal('invalid-cursor');
  }

  // Age filter WITHOUT mutating the input buffer's entries: expiry by age is
  // reported through the cursor contract, never by rewriting the record.
  const oldestAllowed = nowMs - WATCH_BUFFER_LIMITS.maxAgeMs;
  const kept = bufferRead.buffer.entries.filter((entry) => entry.atMs >= oldestAllowed);
  const dropped = bufferRead.buffer.lastSeq - kept.length;
  if (cursor < dropped) {
    return refusal('cursor-expired');
  }
  // A caller-supplied buffer may carry secret-shaped text that never passed
  // the append-time redaction; every line is redacted again on the way out so
  // no unredacted text can leave through this read.
  const lines: string[] = [];
  for (const entry of kept.slice(cursor - dropped)) {
    const redaction = redactWatchLine(entry.text);
    // Unreachable in practice: readWatchBuffer already proved the text a
    // string; the guard keeps the type narrow without trusting it blindly.
    if (!redaction.ok) {
      return refusal('invalid-buffer');
    }
    lines.push(redaction.line);
  }
  return Object.freeze({
    ok: true as const,
    lines: Object.freeze(lines),
    nextCursor: bufferRead.buffer.lastSeq,
  });
}
