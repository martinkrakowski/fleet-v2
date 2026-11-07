/**
 * RV5 (F153): the strict, hand-written schema of one structured review
 * answer. A reviewer reply must carry exactly ONE fenced ```json block,
 * placed last, whose object validates against the schema below; every other
 * reply shape (free text, several json blocks, schema violations) refuses to
 * `unparseable-verdict`. Pure domain: no I/O, no cross-context imports — the
 * plain-record reader and the secret-pattern screen are mirrored locally
 * (this context carries no workspace dependency, like `evidence-records.ts`
 * mirrors `CHAIN_NAME_PATTERN`).
 */

import type { FindingSeverity } from './evidence-records.js';
import { isWholeValuePlaceholder } from './placeholder-evidence.js';

/** At most this many findings one structured answer may carry. */
export const MAX_STRUCTURED_FINDINGS = 100;
/** At most this many characters one finding summary may carry. */
export const MAX_FINDING_SUMMARY_LENGTH = 300;
/** At most this many characters one finding file path may carry. */
export const MAX_FINDING_FILE_LENGTH = 500;
/** At most this many characters one whole review reply may carry. */
export const MAX_REVIEW_REPLY_LENGTH = 512_000;

/**
 * A plain-record snapshot of one runtime value: own enumerable string data
 * properties only, copied onto a null-prototype frozen record. No getter ever
 * runs twice, no prototype field is read, `__proto__` stays an own key, and a
 * hostile Proxy or throwing getter reads as `null`, never an exception.
 */
export function readPlainRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      return null;
    }
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      // The read stays inside the try: a throwing getter is `null`.
      const value = (raw as Record<string, unknown>)[key];
      Object.defineProperty(out, key, {
        value,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The shared secret-shape registry mirrored locally (contexts never import
 * across): the legacy six `SECRET_PATTERNS` of `@fleet/shared` and all 17
 * `LANE_DIFF_SECRET_PATTERNS`, each regex character-for-character. The
 * matched text is never reported — only whether a shape appears.
 */
const REVIEW_SECRET_PATTERNS: readonly RegExp[] = [
  // The legacy six (SECRET_PATTERNS order).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  // The canonical 17 (LANE_DIFF_SECRET_PATTERNS order).
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /ya29\.[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /sk-or-v1-[0-9a-f]{20,}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /ssh-(rsa|ed25519|dss|ecdsa) AAAA[A-Za-z0-9+/]{20,}/,
  /OPENCODE_SERVER_PASSWORD[ \t\v\f\r]*=[ \t\v\f\r]*[^ \t\v\f\r]+/,
  /antigravity-oauth-token/,
  /\/home\/[a-z]+\/\.(ssh|config\/gh|gemini|aws|docker\/config\.json)/,
  /[Pp]assword[ \t\v\f\r]*[:=][ \t\v\f\r]*["'][^"']{6,}["']/,
  /[Tt]oken[ \t\v\f\r]*[:=][ \t\v\f\r]*["'][A-Za-z0-9_./+=-]{16,}["']/,
  /https?:\/\/[^/:@ \t\v\f\r]+:[^/@ \t\v\f\r]{6,}@/,
];

/**
 * True when any mirrored secret pattern matches `text`, raw or with every
 * whitespace run collapsed, so a spaced-out token cannot slip past. A
 * non-string is a match (refuse what cannot be read). Never returns or logs
 * the matched text.
 */
export function containsReviewSecretShape(text: unknown): boolean {
  if (typeof text !== 'string') {
    return true;
  }
  const collapsed = text.replace(/\s+/g, '');
  return REVIEW_SECRET_PATTERNS.some(
    (pattern) => pattern.test(text) || pattern.test(collapsed),
  );
}

/**
 * True only for a safe repo-relative path: a trimmed, non-empty string of at
 * most `MAX_FINDING_FILE_LENGTH` characters with no control character or
 * backslash, no leading `/`, `-`, or `~`, no Windows drive prefix, no URL
 * scheme, and no `.` or `..` path segment, that carries no secret shape.
 */
export function isSafeRelativeFilePath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length < 1 || value.length > MAX_FINDING_FILE_LENGTH) {
    return false;
  }
  if (value.trim() !== value) {
    return false;
  }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  if (value.includes('\\')) {
    return false;
  }
  if (value.startsWith('/') || value.startsWith('-') || value.startsWith('~')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value) || value.includes('://')) {
    return false;
  }
  const segments = value.split('/');
  if (!segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')) {
    return false;
  }
  return !containsReviewSecretShape(value);
}

/** One schema-valid finding entry of a structured answer. */
export interface ValidatedReviewFinding {
  readonly severity: FindingSeverity;
  readonly file: string;
  readonly line: number | null;
  readonly summary: string;
}

const SEVERITIES: readonly string[] = ['blocker', 'major', 'minor', 'nit'];
const VERDICTS: readonly string[] = ['PASS', 'FAIL'];

/** Exact own-key set equality over a plain-record snapshot. */
function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => key in record);
}

/**
 * Validate one parsed answer object. Never throws: every runtime shape (a
 * throwing getter, a sparse array, a hostile Proxy, a wrong type) reads as
 * `{ ok: false, reason: 'unparseable-verdict' }`.
 */
export function validateReviewAnswerObject(raw: unknown):
  | { readonly ok: true; readonly value: { readonly verdict: 'PASS' | 'FAIL'; readonly findings: readonly ValidatedReviewFinding[] } }
  | { readonly ok: false; readonly reason: 'unparseable-verdict' } {
  try {
    const top = readPlainRecord(raw);
    if (top === null || !hasExactKeys(top, ['verdict', 'findings'])) {
      return { ok: false, reason: 'unparseable-verdict' };
    }
    const verdict = top.verdict;
    if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) {
      return { ok: false, reason: 'unparseable-verdict' };
    }
    const findingsRaw = top.findings;
    if (!Array.isArray(findingsRaw) || findingsRaw.length > MAX_STRUCTURED_FINDINGS) {
      return { ok: false, reason: 'unparseable-verdict' };
    }
    for (let index = 0; index < findingsRaw.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(findingsRaw, index)) {
        return { ok: false, reason: 'unparseable-verdict' };
      }
    }
    const findings: ValidatedReviewFinding[] = [];
    for (const entry of findingsRaw as unknown[]) {
      const record = readPlainRecord(entry);
      if (record === null || !hasExactKeys(record, ['severity', 'file', 'line', 'summary'])) {
        return { ok: false, reason: 'unparseable-verdict' };
      }
      const severity = record.severity;
      if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
        return { ok: false, reason: 'unparseable-verdict' };
      }
      const file = record.file;
      if (!isSafeRelativeFilePath(file)) {
        return { ok: false, reason: 'unparseable-verdict' };
      }
      const line = record.line;
      const lineOk =
        line === null ||
        (typeof line === 'number' && Number.isSafeInteger(line) && line >= 1);
      if (!lineOk) {
        return { ok: false, reason: 'unparseable-verdict' };
      }
      const summary = record.summary;
      if (
        typeof summary !== 'string' ||
        summary.length > MAX_FINDING_SUMMARY_LENGTH ||
        summary.includes('\0') ||
        summary.trim().length === 0 ||
        isWholeValuePlaceholder(summary) ||
        containsReviewSecretShape(summary)
      ) {
        return { ok: false, reason: 'unparseable-verdict' };
      }
      findings.push({ severity: severity as FindingSeverity, file, line, summary });
    }
    return {
      ok: true,
      value: { verdict: verdict as 'PASS' | 'FAIL', findings },
    };
  } catch {
    return { ok: false, reason: 'unparseable-verdict' };
  }
}

/** One scanned fenced code block of a stripped reply. */
interface ScannedFence {
  readonly fence: string;
  readonly info: string;
  /** Index of the opening line in the line split. */
  readonly openLine: number;
  /** Index of the closing line, or null when the fence never closes. */
  readonly endLine: number | null;
  /** The lines strictly between the fences, joined with `\n`. */
  readonly body: string;
}

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*)$/;
const FENCE_CLOSE = /^[ \t]{0,3}([`~]+)[ \t]*$/;
/** A trimmed info string that names the json answer block, case-insensitively. */
const INFO_JSON = /^json(?:$|[^a-z0-9])/i;

/**
 * Extract the single trailing fenced ```json block of a stripped reply
 * (linear over the lines, no backtracking regex):
 *
 * - `{ kind: 'none' }` — no json-named fence at all;
 * - `{ kind: 'invalid' }` — an unclosed fence, more than one json fence, a
 *   json fence whose info string is not exactly `json`, or any text after
 *   the closing fence of the single json fence;
 * - `{ kind: 'single', jsonText }` — exactly one ```json fence placed last.
 */
export function extractSingleTrailingJsonFence(
  strippedText: string,
): { kind: 'none' } | { kind: 'invalid' } | { kind: 'single'; jsonText: string } {
  const lines = strippedText.split(/\r?\n/);
  const fences: ScannedFence[] = [];
  let open: { fence: string; info: string; openLine: number; body: string[] } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (open !== null) {
      const closeMatch = FENCE_CLOSE.exec(line);
      if (closeMatch !== null && (closeMatch[1] ?? '').startsWith(open.fence)) {
        const body = open.body.join('\n');
        fences.push({
          fence: open.fence,
          info: open.info,
          openLine: open.openLine,
          endLine: index,
          body,
        });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const openMatch = FENCE_OPEN.exec(line);
    if (openMatch === null) {
      continue;
    }
    const fenceToken = openMatch[1] ?? '';
    const info = openMatch[2] ?? '';
    if (fenceToken.startsWith('`') && info.includes('`')) {
      // CommonMark §4.5: a backtick fence whose info string carries a
      // backtick cannot open a fence; the line is ordinary text.
      continue;
    }
    open = { fence: fenceToken, info, openLine: index, body: [] };
  }
  if (open !== null) {
    return { kind: 'invalid' };
  }
  const jsonFences = fences.filter((fence) => INFO_JSON.test(fence.info.trim()));
  if (jsonFences.length === 0) {
    return { kind: 'none' };
  }
  if (jsonFences.length > 1) {
    return { kind: 'invalid' };
  }
  const fence = jsonFences[0]!;
  if (fence.endLine === null || fence.info !== 'json') {
    return { kind: 'invalid' };
  }
  for (let index = fence.endLine + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== '') {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'single', jsonText: fence.body };
}
