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
import { checkJsonDuplicateKeys } from './json-duplicate-keys.js';
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
  new RegExp('antigravity' + '-oauth-token'),
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
 * C0 controls (U+0000–U+001F), DEL (U+007F), C1 controls (U+0080–U+009F), and
 * Unicode bidirectional controls (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069).
 */
// eslint-disable-next-line no-control-regex
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

export function containsDisallowedControlCharacters(text: string): boolean {
  return DISALLOWED_CONTROL_CHARS.test(text);
}

/**
 * True only for a safe repo-relative path: a trimmed, non-empty string of at
 * most `MAX_FINDING_FILE_LENGTH` characters with no control character or
 * backslash, no leading `/`, `-`, or `~`, no Windows drive prefix, no URL
 * scheme, and no `.` or `..` path segment, that carries no secret shape and
 * no disallowed control characters.
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
  if (containsDisallowedControlCharacters(value)) {
    return false;
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

function parseVerdict(raw: unknown): 'PASS' | 'FAIL' | null {
  if (typeof raw !== 'string' || !VERDICTS.includes(raw)) {
    return null;
  }
  return raw as 'PASS' | 'FAIL';
}

function isValidFindingLine(line: unknown): line is number | null {
  return line === null || (typeof line === 'number' && Number.isSafeInteger(line) && line >= 1);
}

function isValidFindingSummary(summary: unknown): summary is string {
  if (
    typeof summary !== 'string' ||
    summary.length > MAX_FINDING_SUMMARY_LENGTH ||
    summary.trim().length === 0 ||
    containsDisallowedControlCharacters(summary) ||
    isWholeValuePlaceholder(summary) ||
    containsReviewSecretShape(summary)
  ) {
    return false;
  }
  return true;
}

function validateOneFinding(entry: unknown): ValidatedReviewFinding | null {
  const record = readPlainRecord(entry);
  if (record === null || !hasExactKeys(record, ['severity', 'file', 'line', 'summary'])) {
    return null;
  }
  const severity = record.severity;
  if (typeof severity !== 'string' || !SEVERITIES.includes(severity)) {
    return null;
  }
  const file = record.file;
  if (!isSafeRelativeFilePath(file)) {
    return null;
  }
  const line = record.line;
  if (!isValidFindingLine(line)) {
    return null;
  }
  const summary = record.summary;
  if (!isValidFindingSummary(summary)) {
    return null;
  }
  return { severity: severity as FindingSeverity, file, line, summary };
}

function validateFindingsArray(raw: unknown): ValidatedReviewFinding[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_STRUCTURED_FINDINGS) {
    return null;
  }
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) {
      return null;
    }
  }
  const findings: ValidatedReviewFinding[] = [];
  for (const entry of raw as unknown[]) {
    const finding = validateOneFinding(entry);
    if (finding === null) {
      return null;
    }
    findings.push(finding);
  }
  return findings;
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
    const verdict = parseVerdict(top.verdict);
    if (verdict === null) {
      return { ok: false, reason: 'unparseable-verdict' };
    }
    const findings = validateFindingsArray(top.findings);
    if (findings === null) {
      return { ok: false, reason: 'unparseable-verdict' };
    }
    return {
      ok: true,
      value: { verdict, findings },
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

export const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*)$/;
export const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A trimmed info string that names the json answer block, case-insensitively. */
export const INFO_JSON = /^json(?:$|[^a-z0-9])/i;

interface OpenFenceSpec {
  readonly fence: string;
  readonly info: string;
}

function parseFenceOpen(line: string): OpenFenceSpec | null {
  const match = FENCE_OPEN.exec(line);
  if (match === null) {
    return null;
  }
  const fence = match[1] ?? '';
  const info = (match[2] ?? '').trim();
  if (fence.startsWith('`') && info.includes('`')) {
    // CommonMark §4.5: a backtick fence whose info string carries a
    // backtick cannot open a fence; the line is ordinary text.
    return null;
  }
  return { fence, info };
}

function isFenceClose(line: string, openFence: string): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (match === null) {
    return false;
  }
  const token = match[1] ?? '';
  return token[0] === openFence[0] && token.length >= openFence.length;
}

interface OpenFenceState {
  readonly fence: string;
  readonly info: string;
  readonly openLine: number;
  readonly body: string[];
}

function scanFences(lines: readonly string[]): {
  readonly fences: readonly ScannedFence[];
  readonly unclosed: boolean;
} {
  const fences: ScannedFence[] = [];
  let open: OpenFenceState | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (open !== null) {
      if (isFenceClose(line, open.fence)) {
        fences.push({
          fence: open.fence,
          info: open.info,
          openLine: open.openLine,
          endLine: index,
          body: open.body.join('\n'),
        });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const parsedOpen = parseFenceOpen(line);
    if (parsedOpen !== null) {
      open = {
        fence: parsedOpen.fence,
        info: parsedOpen.info,
        openLine: index,
        body: [],
      };
    }
  }
  if (open !== null) {
    const glued = tryCloseGluedTrailingJsonFence(open);
    if (glued !== null) {
      fences.push(glued);
      return { fences, unclosed: false };
    }
  }
  return { fences, unclosed: open !== null };
}

/**
 * Close a trailing backtick `INFO_JSON` fence whose closing ```` ``` ````
 * markers are glued to the end of the last non-blank body line (for example
 * `{"verdict":"FAIL",...}````). Succeeds only when the fence is a backtick
 * fence named `json`-ish, the last non-blank body line ends with a backtick
 * run at least as long as the opening fence, and that run is not the entire
 * (trimmed) line — a standalone indented fence-close line is not glued
 * content. Returns `null` when any condition fails, so the fence stays
 * unclosed and the caller refuses.
 */
function tryCloseGluedTrailingJsonFence(open: OpenFenceState): ScannedFence | null {
  if (!open.fence.startsWith('`') || !INFO_JSON.test(open.info.trim())) {
    return null;
  }
  let lastNonBlankIndex = -1;
  for (let index = open.body.length - 1; index >= 0; index -= 1) {
    if ((open.body[index] ?? '').trim() !== '') {
      lastNonBlankIndex = index;
      break;
    }
  }
  if (lastNonBlankIndex < 0) {
    return null;
  }
  const trimmedEnd = (open.body[lastNonBlankIndex] ?? '').replace(/[ \t]+$/, '');
  let closeLen = 0;
  for (let index = trimmedEnd.length - 1; index >= 0 && trimmedEnd[index] === '`'; index -= 1) {
    closeLen += 1;
  }
  if (closeLen < open.fence.length) {
    return null;
  }
  const before = trimmedEnd.slice(0, trimmedEnd.length - closeLen);
  if (before.trim() === '') {
    return null;
  }
  const body = [...open.body.slice(0, lastNonBlankIndex), before].join('\n');
  return {
    fence: open.fence,
    info: open.info,
    openLine: open.openLine,
    endLine: open.openLine + lastNonBlankIndex + 1,
    body,
  };
}

function hasTrailingNonBlankLines(lines: readonly string[], startLine: number): boolean {
  for (let index = startLine; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() !== '') {
      return true;
    }
  }
  return false;
}

function checkTrailingRegion(
  lines: readonly string[],
  fence: ScannedFence,
): { kind: 'invalid' } | { kind: 'single'; jsonText: string } {
  if (fence.endLine === null || fence.info.trim() !== 'json') {
    return { kind: 'invalid' };
  }
  if (hasTrailingNonBlankLines(lines, fence.endLine + 1)) {
    return { kind: 'invalid' };
  }
  return { kind: 'single', jsonText: fence.body };
}

/**
 * Extract the single trailing fenced ```json block of a stripped reply
 * (linear over the lines, no backtracking regex):
 *
 * - `{ kind: 'none' }` — no json-named fence at all;
 * - `{ kind: 'invalid' }` — an unclosed fence, any json fence before the
 *   last fence, a last fence whose info string is not exactly `json`, or
 *   any non-blank text after the closing fence of the single json fence;
 * - `{ kind: 'single', jsonText }` — exactly one ```json fence placed last.
 */
export function extractSingleTrailingJsonFence(
  strippedText: string,
): { kind: 'none' } | { kind: 'invalid' } | { kind: 'single'; jsonText: string } {
  if (typeof strippedText !== 'string' || strippedText.length > MAX_REVIEW_REPLY_LENGTH) {
    return { kind: 'invalid' };
  }
  const lines = strippedText.split(/\r?\n/);
  const { fences, unclosed } = scanFences(lines);
  if (unclosed) {
    return { kind: 'invalid' };
  }
  if (fences.length === 0) {
    return { kind: 'none' };
  }
  const jsonBeforeLast = fences.slice(0, -1).filter((fence) => INFO_JSON.test(fence.info.trim()));
  if (jsonBeforeLast.length > 0) {
    return { kind: 'invalid' };
  }
  const lastFence = fences[fences.length - 1]!;
  if (!INFO_JSON.test(lastFence.info.trim())) {
    return { kind: 'none' };
  }
  return checkTrailingRegion(lines, lastFence);
}

/**
 * The fixed unreadability labels of one refused review answer (CB7). Each
 * label names exactly one shape of a reply that cannot carry a verdict; the
 * label is a fixed token, never reviewer text.
 */
export const UNREADABLE_REVIEW_ANSWER_LABELS = [
  'empty',
  'no-json',
  'no-fence',
  'multiple-fences',
  'duplicate-keys',
  'extra-keys',
  'bad-verdict-word',
  'bad-findings',
  'truncated',
  'other',
] as const;
export type UnreadableReviewAnswerLabel = (typeof UNREADABLE_REVIEW_ANSWER_LABELS)[number];

/**
 * The untrusted-block marker the review prompt wraps lane-written text in. An
 * echoed `<<<UNTRUSTED ...>>>` block is data: its body never contributes a
 * fence or a finding.
 */
const UNTRUSTED_OPEN_PATTERN = /^<<<UNTRUSTED nonce=([0-9a-f]{16,64}) label="[^"]*">>>$/;

/**
 * Every line of `text` outside an echoed `<<<UNTRUSTED ...>>>` block, plus
 * whether a block was opened and never closed (an unclosed block is a
 * malformed answer: callers refuse it). Linear over the line count (open
 * marker trimmed, close marker `<<<END UNTRUSTED nonce=<same-nonce>>>`); the
 * one shared scan of the domain classifier and the review transport adapter.
 */
export function scanUntrustedEchoBlocks(
  text: string,
): { readonly stripped: string; readonly unclosed: boolean } {
  const kept: string[] = [];
  let openNonce: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (openNonce !== null) {
      if (line.trim() === `<<<END UNTRUSTED nonce=${openNonce}>>>`) {
        openNonce = null;
      }
      continue;
    }
    const openMatch = UNTRUSTED_OPEN_PATTERN.exec(line.trim());
    if (openMatch !== null) {
      openNonce = openMatch[1] ?? null;
      continue;
    }
    kept.push(line);
  }
  return { stripped: kept.join('\n'), unclosed: openNonce !== null };
}

const TOP_LEVEL_ANSWER_KEYS = ['verdict', 'findings'] as const;
const FINDING_KEYS = ['severity', 'file', 'line', 'summary'] as const;

/** The findings check: whether the shape failure is an unexpected key. */
function findingsLabel(raw: unknown): UnreadableReviewAnswerLabel {
  if (!Array.isArray(raw) || raw.length > MAX_STRUCTURED_FINDINGS) {
    return 'bad-findings';
  }
  for (const entry of raw as unknown[]) {
    const record = readPlainRecord(entry);
    if (record === null) {
      // A non-record entry does not settle the label: a later entry may carry an extra key.
      continue;
    }
    const keys = Object.keys(record);
    if (keys.some((key) => !(FINDING_KEYS as readonly string[]).includes(key))) {
      return 'extra-keys';
    }
  }
  return 'bad-findings';
}

/** The single trailing ```json fence body: schema-level labels only. */
function classifyJsonBody(body: string): UnreadableReviewAnswerLabel {
  if (body.trim() === '') {
    return 'no-json';
  }
  const duplicateKeyCheck = checkJsonDuplicateKeys(body);
  if (!duplicateKeyCheck.ok) {
    if (duplicateKeyCheck.reason === 'duplicate-key') {
      return 'duplicate-keys';
    }
    return duplicateKeyCheck.reason === 'invalid-json' ? 'truncated' : 'other';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'truncated';
  }
  const top = readPlainRecord(parsed);
  if (top === null) {
    return 'other';
  }
  const keys = Object.keys(top);
  if (keys.some((key) => !(TOP_LEVEL_ANSWER_KEYS as readonly string[]).includes(key))) {
    return 'extra-keys';
  }
  if (keys.length !== TOP_LEVEL_ANSWER_KEYS.length) {
    return 'other';
  }
  if (parseVerdict(top.verdict) === null) {
    return 'bad-verdict-word';
  }
  if (validateFindingsArray(top.findings) === null) {
    return findingsLabel(top.findings);
  }
  return 'other';
}

/**
 * Classify one refused review answer (CB7): the single fixed label naming why
 * the reply cannot carry a verdict. Never throws, never returns or logs any
 * part of `text`.
 *
 * Cost bound: `O(1)` for non-strings and oversized inputs (the length refusal
 * runs before any property read, so getters and hostile `Proxy` traps never
 * run); `O(n)` time and space otherwise, with `n <= MAX_REVIEW_REPLY_LENGTH`
 * (512,000 characters) bounding every scan — the untrusted strip, the fence
 * scan, the duplicate-key walk and the schema checks are each linear over the
 * reply or the parsed object, which the cap also bounds.
 */
export function classifyUnreadableReviewAnswer(text: unknown): UnreadableReviewAnswerLabel {
  try {
    if (typeof text !== 'string' || text.length > MAX_REVIEW_REPLY_LENGTH) {
      return 'other';
    }
    if (text.trim() === '') {
      return 'empty';
    }
    const scanned = scanUntrustedEchoBlocks(text);
    if (scanned.unclosed) {
      return 'truncated';
    }
    const stripped = scanned.stripped;
    const lines = stripped.split(/\r?\n/);
    const { fences, unclosed } = scanFences(lines);
    if (unclosed) {
      return 'truncated';
    }
    if (fences.length === 0) {
      const trimmed = stripped.trim();
      return trimmed.includes('{') || trimmed.includes('[') ? 'no-fence' : 'no-json';
    }
    const jsonFences = fences.filter((fence) => INFO_JSON.test(fence.info.trim()));
    if (jsonFences.length > 1) {
      return 'multiple-fences';
    }
    const lastFence = fences[fences.length - 1]!;
    if (!INFO_JSON.test(lastFence.info.trim())) {
      return 'no-fence';
    }
    if (lastFence.endLine === null) {
      return 'truncated';
    }
    if (hasTrailingNonBlankLines(lines, lastFence.endLine + 1)) {
      return 'other';
    }
    return classifyJsonBody(lastFence.body);
  } catch {
    return 'other';
  }
}
