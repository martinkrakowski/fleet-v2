/**
 * Pure parser for the legacy shell merge train's own events log: one JSON
 * object per line, with the keys `at`, `kind`, `outcome`, `pr`, `headOid` and
 * `detail`. Nothing free-text ever crosses out of this parser: `detail` is
 * mapped to a closed code by exact pattern matching and is never echoed, and a
 * secret-shaped line is reported without its content. Every refusal is a typed
 * result; the parser never throws.
 *
 * Cost bound: linear in the capped input — at most `SHELL_EVENTS_MAX_LINES`
 * lines, each read a constant number of times, with at most
 * `SHELL_EVENT_MAX_LINE_LENGTH` characters of each line actually read for
 * ordinary parsing (JSON.parse and field validation).
 *
 * The secret-shape check runs under its OWN, much larger bound,
 * `SHELL_EVENT_SECRET_SCAN_MAX_LENGTH`: the brief requires every
 * secret-shaped raw line to be counted in `secretShapedLines`, with no
 * exception for length, so the scan must reach further than the ordinary
 * line-length cap to still catch a secret shape in a merely-oversized (but
 * not extreme) line — the scan's cost is bounded to that larger prefix,
 * never the full raw string, so an arbitrarily long raw line still costs no
 * more to scan than that fixed ceiling. A secret shape that appears only
 * beyond `SHELL_EVENT_SECRET_SCAN_MAX_LENGTH` characters — far past any
 * practically-sized line, since no legitimate shell log line approaches 1
 * MiB and every registered secret pattern is short — is not detected; that
 * is the one bound this parser leaves generously capped rather than fully
 * unbounded.
 */
import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';

import { isMergeHex40 } from './merge-queue-records.js';
import { isCalendarDateTime } from './plain-record-reads.js';

export const SHELL_TRAIN_EVENT_KINDS = [
  'enqueue', 'intent', 'result', 'park', 'unpark', 'head-moved', 'retry', 'batch', 'skip', 'maint',
  'jev-shadow',
] as const;
export type ShellTrainEventKind = (typeof SHELL_TRAIN_EVENT_KINDS)[number];

export const SHELL_DETAIL_CODES = [
  'none', 'premerge-carried', 'premerge-reposted', 'premerge-not-carried', 'batch-member',
  'head-moved-from', 'other',
] as const;
export type ShellDetailCode = (typeof SHELL_DETAIL_CODES)[number];

/** The line cap; a longer list is refused before any element is read. */
export const SHELL_EVENTS_MAX_LINES = 200_000;
/**
 * The per-line cap governing ORDINARY line-length validity: a raw line
 * longer than this is an unknown line, never read further for JSON parsing
 * or field validation. Distinct from, and unrelated to,
 * `SHELL_EVENT_SECRET_SCAN_MAX_LENGTH` below, which bounds a different
 * concern (the secret-shape scan's cost) and does not change what this
 * constant governs.
 */
export const SHELL_EVENT_MAX_LINE_LENGTH = 4_096;
/**
 * The cost bound for the secret-shape scan SPECIFICALLY — distinct from,
 * and far larger than, `SHELL_EVENT_MAX_LINE_LENGTH` above. The brief
 * requires every secret-shaped raw line to increment `secretShapedLines`,
 * with no exception for length, so the scan must reach further than the
 * ordinary line-length cap to catch a secret shape in a merely-oversized
 * (but not extreme) line. 1 MiB is generous relative to any legitimate
 * shell log line and to the short, fixed shape of every registered secret
 * pattern, so a real secret is always found well within this bound when
 * present at all. It still bounds the worst-case regex cost to a fixed
 * ceiling rather than leaving it fully unbounded: a line longer than this
 * gets a bounded, not unbounded, amount of scanning before being correctly
 * reported as unknown regardless.
 */
export const SHELL_EVENT_SECRET_SCAN_MAX_LENGTH = 1_048_576;

export interface ShellTrainEvent {
  readonly line: number;
  readonly atIso: string;
  readonly kind: ShellTrainEventKind;
  readonly outcome: string;
  readonly pullRequest: number | null;
  readonly headOid: string | null;
  readonly detailCode: ShellDetailCode;
  readonly fromHeadOid: string | null;
}

export type ShellTrainEventsParse =
  | { readonly ok: false; readonly reason: 'not-a-list' | 'too-many-lines' }
  | {
      readonly ok: true;
      readonly events: readonly ShellTrainEvent[];
      /** Indices of lines that are not a recognizable event. */
      readonly unknownLines: readonly number[];
      /** How many of those lines matched a secret-shape registry (counted once). */
      readonly secretShapedLines: number;
    };

const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const OUTCOME_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const BATCH_PATTERN = /^batch #[0-9]{1,9}$/;
const FROM_HEAD_PATTERN = /^from ([0-9a-f]{40})$/;
const PR_MAXIMUM = 1_000_000_000;
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['at', 'kind', 'outcome', 'pr', 'headOid', 'detail']);
const REQUIRED_KEYS: readonly string[] = ['at', 'kind', 'outcome', 'pr'];

/**
 * A genuine array (never an array-like or a Proxy standing in for one), with a
 * plain data `length`. The length is read from its own descriptor, so no `get`
 * trap or getter runs and the count check happens before a single element is
 * touched. `'not-a-list'` for anything that is not a real array (or whose
 * length is not a plain non-negative integer); `'too-many-lines'` for a real
 * array whose plain length exceeds the cap; otherwise the length.
 */
function realArrayLength(
  value: unknown,
): { readonly reason: 'not-a-list' | 'too-many-lines' } | { readonly length: number } {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return { reason: 'not-a-list' };
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return { reason: 'not-a-list' };
  }
  if (lengthDescriptor.value > SHELL_EVENTS_MAX_LINES) {
    return { reason: 'too-many-lines' };
  }
  return { length: lengthDescriptor.value };
}

/** The own data-property element at `index`; undefined for a hole or an accessor. */
function ownElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Both secret-shape registries, as the comparators check them: the short
 * registry misses shapes such as `github_pat_` that the lane-diff registry
 * names. A secret-shaped line is counted, never echoed.
 */
function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** One event read out of a parsed record via own data descriptors, or null. */
function readEvent(line: number, root: Record<string, unknown>): ShellTrainEvent | null {
  const at = ownDataField(root, 'at');
  const kind = ownDataField(root, 'kind');
  const outcome = ownDataField(root, 'outcome');
  const pr = ownDataField(root, 'pr');
  const headOid = ownDataField(root, 'headOid');
  const detail = ownDataField(root, 'detail');

  if (typeof at !== 'string' || !AT_PATTERN.test(at) || !isCalendarDateTime(at)) {
    return null;
  }
  if (!isEventKind(kind)) {
    return null;
  }
  if (typeof outcome !== 'string' || !OUTCOME_PATTERN.test(outcome)) {
    return null;
  }
  if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 0 || pr > PR_MAXIMUM) {
    return null;
  }
  // Absent, null or '' means no PR head; anything else must be 40 lowercase hex.
  let headOidValue: string | null;
  if (headOid === undefined || headOid === null || headOid === '') {
    headOidValue = null;
  } else if (isMergeHex40(headOid)) {
    headOidValue = headOid;
  } else {
    return null;
  }

  const detailResult = readDetailCode(kind, detail);
  if (detailResult === null) {
    return null;
  }

  return Object.freeze({
    line,
    atIso: at,
    kind,
    outcome: outcome.toLowerCase(),
    pullRequest: pr === 0 ? null : pr,
    headOid: headOidValue,
    detailCode: detailResult.detailCode,
    fromHeadOid: detailResult.fromHeadOid,
  });
}

function isEventKind(value: unknown): value is ShellTrainEventKind {
  return typeof value === 'string' && (SHELL_TRAIN_EVENT_KINDS as readonly string[]).includes(value);
}

type DetailResult = { readonly detailCode: ShellDetailCode; readonly fromHeadOid: string | null };

/**
 * Map the raw `detail` text to a closed code by exact pattern matching. The
 * text itself is never returned. The `from <40hex>` shape is special-cased
 * only for `kind === 'head-moved'`; every other kind falls through to `other`.
 */
function readDetailCode(kind: ShellTrainEventKind, detail: unknown): DetailResult | null {
  if (detail === undefined || detail === '') {
    return { detailCode: 'none', fromHeadOid: null };
  }
  if (typeof detail !== 'string') {
    return null;
  }
  if (detail.startsWith('premerge carried (success)')) {
    return { detailCode: 'premerge-carried', fromHeadOid: null };
  }
  if (detail.startsWith('premerge re-posted')) {
    return { detailCode: 'premerge-reposted', fromHeadOid: null };
  }
  if (detail.startsWith('not carried: ')) {
    return { detailCode: 'premerge-not-carried', fromHeadOid: null };
  }
  if (BATCH_PATTERN.test(detail)) {
    return { detailCode: 'batch-member', fromHeadOid: null };
  }
  if (kind === 'head-moved') {
    const match = FROM_HEAD_PATTERN.exec(detail);
    if (match !== null) {
      return { detailCode: 'head-moved-from', fromHeadOid: match[1] ?? null };
    }
  }
  return { detailCode: 'other', fromHeadOid: null };
}

/**
 * The own data property named `key`, read from its descriptor so no getter
 * ever runs; undefined when absent or accessor-backed.
 */
function ownDataField(root: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(root, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * The parsed record as a plain object of own data properties, or null. The key
 * set must be a subset of the six allowed keys and include the four required
 * ones; a symbol key, an accessor, a planted `__proto__`, `constructor` or
 * `prototype` own key is refused here.
 */
function readPlainRecord(root: unknown): Record<string, unknown> | null {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return null;
  }
  if (Object.getPrototypeOf(root) !== Object.prototype && Object.getPrototypeOf(root) !== null) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(root);
  let requiredSeen = 0;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !ALLOWED_KEYS.has(key)) {
      return null;
    }
    if (!('value' in descriptors[key])) {
      return null;
    }
    if (REQUIRED_KEYS.includes(key)) {
      requiredSeen += 1;
    }
  }
  if (requiredSeen !== REQUIRED_KEYS.length) {
    return null;
  }
  return root as Record<string, unknown>;
}

export function parseShellTrainEvents(input: unknown): ShellTrainEventsParse {
  try {
    const lengthResult = realArrayLength(input);
    if ('reason' in lengthResult) {
      return { ok: false, reason: lengthResult.reason };
    }
    const length = lengthResult.length;

    const events: ShellTrainEvent[] = [];
    const unknownLines: number[] = [];
    let secretShapedLines = 0;
    const list = input as readonly unknown[];

    for (let index = 0; index < length; index += 1) {
      const raw = ownElement(list, index);
      if (typeof raw !== 'string') {
        unknownLines.push(index);
        continue;
      }
      // Secret-shape detection runs before, and independently of, the length
      // check below: every secret-shaped raw line is counted in
      // `secretShapedLines`, whether or not it is ALSO over the length cap.
      // The scan itself is bounded to the first
      // SHELL_EVENT_SECRET_SCAN_MAX_LENGTH characters (not the full raw
      // string, and NOT the much smaller SHELL_EVENT_MAX_LINE_LENGTH, which
      // governs ordinary line-length validity in the check right after this
      // one and is a separate concern from the secret-shape scan's cost
      // bound): a line that is over the ordinary length cap but still
      // within the secret-scan bound is correctly detected as secret-shaped
      // here, before the length check reports it as unknown for its own,
      // independent reason — while the regex cost of getting there never
      // grows past SHELL_EVENT_SECRET_SCAN_MAX_LENGTH, however long the
      // actual raw line is.
      const secretShapeScanInput =
        raw.length > SHELL_EVENT_SECRET_SCAN_MAX_LENGTH
          ? raw.slice(0, SHELL_EVENT_SECRET_SCAN_MAX_LENGTH)
          : raw;
      if (isSecretShaped(secretShapeScanInput)) {
        unknownLines.push(index);
        secretShapedLines += 1;
        continue;
      }
      if (raw.length > SHELL_EVENT_MAX_LINE_LENGTH) {
        unknownLines.push(index);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        unknownLines.push(index);
        continue;
      }
      const root = readPlainRecord(parsed);
      const event = root === null ? null : readEvent(index, root);
      if (event === null) {
        unknownLines.push(index);
        continue;
      }
      events.push(event);
    }

    return Object.freeze({
      ok: true,
      events: Object.freeze(events),
      unknownLines: Object.freeze(unknownLines),
      secretShapedLines,
    });
  } catch {
    // Any unexpected throw from a hostile input (for example a Proxy whose
    // getPrototypeOf trap throws, surfaced by realArrayLength's own
    // defensive check above) must never escape this boundary: the contract
    // is to take `unknown` and never throw. Reuse 'not-a-list' rather than
    // inventing a new reason code — the same catch-all shape this package
    // already uses for a hostile throw (see readSuppliedKey/
    // readGateReceiptKeyComponents in gate-receipt-key.ts and the
    // detectStalls wrapper in stall-rules.ts) — because an input that throws
    // before a single line can be read never behaved like a readable array
    // in the first place, which is exactly what 'not-a-list' already means.
    return { ok: false, reason: 'not-a-list' };
  }
}
