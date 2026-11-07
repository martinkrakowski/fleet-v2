import { randomBytes } from 'node:crypto';

import { BRIEF_INPUT_RULE, UNTRUSTED_INPUT_RULE, wrapUntrusted } from '../../domain/untrusted-input.js';
import type { FindingSeverity, ReviewFindingRecord, ReviewUnknownReason } from '../../domain/evidence-records.js';
import { isWholeValuePlaceholder } from '../../domain/placeholder-evidence.js';
import {
  MAX_REVIEW_REPLY_LENGTH,
  MAX_STRUCTURED_FINDINGS,
  MAX_FINDING_SUMMARY_LENGTH,
  containsReviewSecretShape,
  extractSingleTrailingJsonFence,
  isSafeRelativeFilePath,
  validateReviewAnswerObject,
} from '../../domain/review-answer-schema.js';
import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type { ReviewTransportDiagnostic, ReviewUnavailableCode, RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import type { ReviewRunnerRoute } from './ReviewTransportRouter.js';
import { runSpawnOutcome, DEFAULT_MAX_BUFFER_BYTES } from './spawn-run.js';

/**
 * A typed transport failure (KF-14a): the code is one fixed `ReviewUnavailableCode`,
 * never transport or forge text. Every refusal of the opencode review transport throws
 * `ReviewTransportError`; the router throws it for seat and tool refusals, and
 * `IndependentReviewAdapter` maps any other throw to `transport-failed`.
 */
/**
 * True when `error` carries a timeout shape: an `AbortError` name, an
 * `ETIMEDOUT` code, or a timeout phrase in its message. A throwing getter is
 * a non-timeout, never a crash. Defined beside the transport error it
 * classifies and re-exported here for the adapter's callers.
 */
export function isTimeoutError(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null || Array.isArray(error)) {
      return false;
    }
    const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly message?: unknown };
    if (candidate.name === 'AbortError' || candidate.code === 'ETIMEDOUT') {
      return true;
    }
    return typeof candidate.message === 'string' && /timed?\s*out|timeout/i.test(candidate.message);
  } catch {
    return false;
  }
}

export class ReviewTransportError extends Error {
  readonly code: ReviewUnavailableCode;
  /** The bounded transport diagnostic (RV4); absent when the failure carried none. */
  readonly diagnostic?: ReviewTransportDiagnostic;

  constructor(message: string, code: ReviewUnavailableCode, diagnostic?: ReviewTransportDiagnostic) {
    super(message);
    this.name = 'ReviewTransportError';
    this.code = code;
    if (diagnostic !== undefined) {
      this.diagnostic = diagnostic;
    }
  }
}

/** The bound on stderr that leaves the transport (RV4): 2048 bytes. */
export const MAX_TRANSPORT_STDERR_BYTES = 2048;

/** A data read that never throws: a throwing getter reads as `null`. */
function safeRead<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
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

/** The bounded diagnostic of a spawn result; a throwing getter reads as null. */
function spawnDiagnosticOf(result: OcmReviewTransportSpawnResult): ReviewTransportDiagnostic {
  const exitCode = safeRead(() => result.exitCode);
  const timedOut = safeRead(() => result.timedOut === true) === true;
  const stderr = safeRead(() => result.stderr);
  const stdout = safeRead(() => result.stdout);
  // A missing or non-string field reads as null (RV4 round 1): the spawn
  // result shape is not trusted, so only a real string is capped or trimmed.
  return {
    exitCode: exitCode ?? null,
    timedOut,
    stderr: typeof stderr === 'string' ? capUtf8Bytes(stderr, MAX_TRANSPORT_STDERR_BYTES) : null,
    stdoutEmpty: typeof stdout === 'string' ? stdout.trim() === '' : null,
  };
}

/**
 * The diagnostic of a failure that carried no spawn result (a spawn that
 * threw, or a refusal before any spawn): no exit code, the timeout shape, the
 * error class name (never the message), and no stdout reading. Never throws.
 */
export function transportFailureDiagnostic(error: unknown): ReviewTransportDiagnostic {
  // The thrown message is never copied: it may carry a secret or a path, and
  // this package has no screen. Only the error class name travels.
  const name = safeRead(() => {
    const named = (error as { readonly name?: unknown } | null)?.name;
    return typeof named === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(named) ? named : 'Error';
  });
  return {
    exitCode: null,
    timedOut: isTimeoutError(error),
    stderr: capUtf8Bytes(`${name ?? 'Error'}: spawn threw`, MAX_TRANSPORT_STDERR_BYTES),
    stdoutEmpty: null,
  };
}

/** The timed-out classification of a spawn result, read without throwing. */
function spawnTimedOut(result: OcmReviewTransportSpawnResult): boolean {
  if (safeRead(() => result.timedOut === true) === true) {
    return true;
  }
  const exitCode = safeRead(() => result.exitCode);
  const stderr = safeRead(() => result.stderr);
  if (exitCode === null && typeof stderr === 'string') {
    return /timed?\s*out|timeout/i.test(stderr);
  }
  return false;
}

export interface OcmReviewTransportSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set only when the spawn ended because its wall-clock budget ran out. */
  readonly timedOut?: boolean;
}

export type OcmReviewTransportSpawn = (
  file: string,
  args: readonly string[],
  env: Record<string, string>,
  options?: { readonly timeoutMs: number },
) => Promise<OcmReviewTransportSpawnResult>;

export interface OcmReviewTransportOptions {
  readonly ocmRunBin: string;
  readonly remotePort: number;
  readonly remoteHost?: string;
  readonly agent: string; /* 'reviewer' */
  readonly model: string;
  readonly variant?: string;
  /** Absent means 'legacy' (today's behaviour). */
  readonly hostMode?: 'legacy' | 'installation';
  /** Orchestrator-side auth file for ocm-run, installation mode only. */
  readonly authFile?: string;
  /**
   * The resolved review route (KF-14a). A `none` route refuses before any
   * work with the route's code (absent → `route-unresolved`).
   */
  readonly route?: ReviewRunnerRoute;
  /** Wall-clock budget of one review run. */
  readonly timeoutMs?: number;
  readonly resolveReviewDir: (
    request: RunIndependentReviewRequest,
  ) => Promise<string | null> | string | null;
  readonly readHead: (dir: string) => Promise<string | null> | string | null;
  readonly spawn?: OcmReviewTransportSpawn;
  /** Test seam: overrides the per-prompt nonce; production uses defaultNonce(). */
  readonly makeNonce?: () => string;
  /**
   * The base commit the candidate diff is read against. When set together
   * with `readDiff`, a kind review prompt embeds the base..head diff.
   */
  readonly baseCommit?: string;
  /** Read-only diff read through the review location; paired with `baseCommit`. */
  readonly readDiff?: (fromSha: string, toSha: string) => Promise<string | null> | string | null;
}

/** Allowed tools for read-only review proof. Any other tool voids read-only verification. */
export const READ_ONLY_REVIEW_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'glob',
  'list',
]);

/**
 * The shell commands the lane server's `reviewer` agent may already run. This
 * allow-list is a defence-in-depth filter of what a reviewer may run, **never**
 * a read-only proof: even a command accepted here voids the review's
 * read-only verification, because the review prompt forbids every shell call.
 */
export const READ_ONLY_REVIEW_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'git',
  'grep',
  'rg',
  'sed',
  'cat',
  'ls',
  'wc',
]);

/** First words that may smuggle a value or spawn anything: never a command word. */
const FORBIDDEN_FIRST_WORDS: ReadonlySet<string> = new Set([
  'env',
  'xargs',
  'find',
  'sh',
  'bash',
  'yarn',
  'node',
  'tee',
]);

/**
 * Characters that make a command non-read-only or unparsable without shell
 * quoting. `~` is not here because a ref word may carry `HEAD~<digits>`; no
 * other word may contain or start with it.
 */
const FORBIDDEN_COMMAND_CHARACTERS: ReadonlySet<string> = new Set([
  ';',
  '&',
  '|',
  '>',
  '<',
  '`',
  '$',
  '(',
  ')',
  '{',
  '}',
  '\\',
  '*',
  '?',
  '[',
]);

/** The kind prompt's statement that the embedded diff is the whole change. */
export const KIND_PROMPT_DIFF_COMPLETE =
  'The embedded diff above is the complete change between the base and the candidate head.';

/** The kind prompt's tools sentence: read-only tools only, never a shell command. */
export const KIND_PROMPT_TOOLS_ONLY =
  'Inspect the candidate head only with the read-only tools (read, grep, glob, list). ' +
  'Do not run any shell command: a bash or shell call voids this review whatever the command.';

/** Longest shell command accepted as read-only proof. */
export const MAX_REVIEW_COMMAND_LENGTH = 1000;

/** Longest `-e` pattern accepted for grep/rg. */
const MAX_REVIEW_PATTERN_LENGTH = 200;

/** Relative path word: no `/`-root, no flag, no `..`, no hidden segment but `.lane/…`. */
const PATH_WORD_PATTERN = /^[A-Za-z0-9._/-]+$/;
const ALLOWED_HIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['.lane']);

/**
 * Pattern word: no leading `-`, no quotes, no shell metacharacters. `=` is
 * refused everywhere so `FOO=bar …` prefixes and `--flag=value` never pass.
 */
const PATTERN_WORD_PATTERN = /^[A-Za-z0-9._/@:%#,+^~-]+$/;

/**
 * Ref word: a sha, `HEAD`, `HEAD~<digits>` or a `<ref>..<ref>` / `<ref>...<ref>`
 * range built only from those atoms. A ref atom carries no `/` and no `.`
 * outside the range dots, so a path operand can never pass as a ref: every
 * other operand must satisfy `isPathWord`.
 */
const REF_ATOM = '(?:HEAD(?:~[0-9]+)?|[0-9a-f]{7,40})';
const REF_WORD_PATTERN = new RegExp(`^(?:${REF_ATOM}|${REF_ATOM}\\.{2,3}${REF_ATOM})$`);

function isPathWord(word: string): boolean {
  if (!PATH_WORD_PATTERN.test(word)) {
    return false;
  }
  if (word.startsWith('/') || word.startsWith('-')) {
    return false;
  }
  if (word.includes('..') || word === '.') {
    return false;
  }
  for (const segment of word.split('/')) {
    if (segment.startsWith('.') && !ALLOWED_HIDDEN_SEGMENTS.has(segment)) {
      return false;
    }
  }
  return true;
}

function isPatternWord(word: string): boolean {
  return word.length > 0 && PATTERN_WORD_PATTERN.test(word);
}

function isRefWord(word: string): boolean {
  return REF_WORD_PATTERN.test(word);
}

const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(['diff', 'log', 'show', 'status']);
const GIT_PLAIN_FLAGS: ReadonlySet<string> = new Set([
  '--stat',
  '--name-only',
  '--name-status',
  '--oneline',
  '-p',
  '-n',
  '--no-color',
  '--no-pager',
]);
const GIT_NUMERIC_FLAG_PATTERN = /^-U[0-9]+$|^-([0-9]+)$/;

function isReadOnlyGitCommand(words: readonly string[]): boolean {
  const subcommand = words[0];
  if (subcommand === undefined || !GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  let sawDoubleDash = false;
  for (const word of words.slice(1)) {
    if (sawDoubleDash) {
      if (!isPathWord(word)) {
        return false;
      }
      continue;
    }
    if (word === '--') {
      sawDoubleDash = true;
      continue;
    }
    if (word.startsWith('-')) {
      if (GIT_PLAIN_FLAGS.has(word) || GIT_NUMERIC_FLAG_PATTERN.test(word)) {
        continue;
      }
      return false;
    }
    if (subcommand !== 'status' && isRefWord(word)) {
      continue;
    }
    if (isPathWord(word)) {
      continue;
    }
    return false;
  }
  return true;
}

const GREP_PLAIN_FLAGS: ReadonlySet<string> = new Set(['-n', '-i', '-l', '-c', '-w', '-F', '--no-color', '-r']);

function isReadOnlyGrepCommand(words: readonly string[], isRipgrep: boolean): boolean {
  let patternSeen = false;
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) {
      return false;
    }
    if (!patternSeen && word.startsWith('-')) {
      // `-f`/`--file` make the next word a pattern FILE (read from anywhere),
      // so any flag word carrying a lowercase `f` is refused outright.
      if (word.includes('f') || word === '--file') {
        return false;
      }
      if (GREP_PLAIN_FLAGS.has(word) || /^-[nilcwFr]+$/.test(word)) {
        index += 1;
        continue;
      }
      if (word === '-e' || (isRipgrep && word === '-g')) {
        const value = words[index + 1];
        if (value === undefined || value.length > MAX_REVIEW_PATTERN_LENGTH || !isPatternWord(value)) {
          return false;
        }
        // `-e` supplies the pattern: every later positional is a FILE and must
        // satisfy the path grammar (`-g` is a ripgrep glob, the pattern follows).
        if (word === '-e') {
          patternSeen = true;
        }
        index += 2;
        continue;
      }
      if (/^-[ABC]$/.test(word)) {
        const value = words[index + 1];
        if (value === undefined || !/^[0-9]+$/.test(value)) {
          return false;
        }
        index += 2;
        continue;
      }
      return false;
    }
    if (!patternSeen) {
      if (!isPatternWord(word)) {
        return false;
      }
      patternSeen = true;
      index += 1;
      continue;
    }
    if (!isPathWord(word)) {
      return false;
    }
    index += 1;
  }
  return patternSeen;
}

const SED_SCRIPT_PATTERN = /^'[0-9]+(?:,[0-9]+)?p'$/;
const LS_FLAGS: ReadonlySet<string> = new Set(['-l', '-a', '-la', '-1']);
const WC_FLAGS: ReadonlySet<string> = new Set(['-l', '-c', '-w']);

function isReadOnlyListCommand(command: string, words: readonly string[]): boolean {
  const flags: ReadonlySet<string> | null =
    command === 'ls' ? LS_FLAGS : command === 'wc' ? WC_FLAGS : null;
  const paths: string[] = [];
  for (const word of words) {
    if (flags !== null && paths.length === 0 && word.startsWith('-')) {
      if (!flags.has(word)) {
        return false;
      }
      continue;
    }
    if (!isPathWord(word)) {
      return false;
    }
    paths.push(word);
  }
  return paths.length > 0;
}

/**
 * True only for a shell command the lane server's `reviewer` agent may run:
 * `git diff|log|show|status`, `grep`, `rg`, `sed -n`, `cat`, `ls` and `wc` in
 * the strict shapes above. Pure and fail-closed: anything unparsable,
 * over-long, carrying a shell metacharacter, an assignment, an unknown flag
 * or an unsafe path is refused. This is a defence-in-depth filter of what a
 * reviewer may run, never a read-only proof: even a command accepted here
 * voids the review's read-only verification.
 */
export function isReadOnlyReviewCommand(command: unknown): boolean {
  if (typeof command !== 'string') {
    return false;
  }
  if (command.length === 0 || command.length > MAX_REVIEW_COMMAND_LENGTH) {
    return false;
  }
  for (const character of command) {
    if (character === '\n' || character === '\t' || character === '\0') {
      return false;
    }
    if (FORBIDDEN_COMMAND_CHARACTERS.has(character)) {
      return false;
    }
  }
  if (command !== command.trim() || command.includes('  ')) {
    return false;
  }
  const words = command.split(' ');
  if (words.some((word) => word === '' || word.includes('='))) {
    return false;
  }
  const first = words[0];
  if (first === undefined || FORBIDDEN_FIRST_WORDS.has(first) || !READ_ONLY_REVIEW_SHELL_COMMANDS.has(first)) {
    return false;
  }
  const rest = words.slice(1);
  switch (first) {
    case 'git':
      return isReadOnlyGitCommand(rest);
    case 'grep':
      return isReadOnlyGrepCommand(rest, false);
    case 'rg':
      return isReadOnlyGrepCommand(rest, true);
    case 'sed':
      return (
        rest.length === 3 &&
        rest[0] === '-n' &&
        rest[1] !== undefined &&
        SED_SCRIPT_PATTERN.test(rest[1]) &&
        rest[2] !== undefined &&
        isPathWord(rest[2])
      );
    case 'cat':
    case 'ls':
    case 'wc':
      return isReadOnlyListCommand(first, rest);
    default:
      return false;
  }
}

/** Recognised event types for review runner stream. Any unrecognised event voids read-only. */
export const RECOGNISED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'step_start',
  'step-start',
  'step_finish',
  'step-finish',
  'text',
  'tool',
  'tool_use',
  'tool_call',
]);

/** Allowed part types for review runner stream parts. Any other part.type voids read-only. */
export const ALLOWED_PART_TYPES: ReadonlySet<string> = new Set([
  'text',
  'tool',
  'step-start',
  'step_start',
  'step-finish',
  'step_finish',
]);

/** Process environment variables that a reviewer subprocess may inherit. */
export const REVIEWER_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
];

const FINDING_PATTERN = /^FINDING: ([A-Za-z][\w-]*) (\S+?)(?::(\d+))? (.+)$/i;

/**
 * RV3: reviewer severity words that are not the four declared ones but mean
 * one of them. Anything else is not guessed at: a finding with an unrecognised
 * severity makes the whole reply unparseable (never silently dropped).
 */
const SEVERITY_SYNONYMS: Readonly<Record<string, FindingSeverity>> = {
  blocker: 'blocker',
  major: 'major',
  minor: 'minor',
  nit: 'nit',
  critical: 'blocker',
  severe: 'blocker',
  high: 'major',
  medium: 'major',
  low: 'minor',
  info: 'nit',
  trivial: 'nit',
};

function normalizeSeverity(word: string): FindingSeverity | null {
  const key = word.toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_SYNONYMS, key) ? (SEVERITY_SYNONYMS[key] as FindingSeverity) : null;
}

const FILE_REFERENCE = /[\w./-]+\.\w+:\d+/;
const LIST_OR_NUMBER_MARKER = /^(?:[-*+•>]\s+|\d+[.)]\s+)/;
const SEVERITY_TOKEN_SKELETONS: ReadonlySet<string> = new Set([
  'blocker', 'critical', 'major', 'high', 'severe', 'medium', 'minor', 'low', 'nit', 'info', 'trivial',
]);
/** Cyrillic and Greek letters that render like ASCII ones, folded before a severity-word check. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  'а': 'a', 'с': 'c', 'е': 'e', 'о': 'o', 'р': 'p', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'ӏ': 'l', 'ᴎ': 'n',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'κ': 'k', 'τ': 't', 'η': 'n', 'μ': 'm', 'β': 'b', 'χ': 'x', 'υ': 'u',
};

/** Every markdown emphasis or code character anywhere in the line is removed, whitespace collapsed, then trimmed. */
function normaliseFindingLine(line: string): string {
  return line.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
}

/** True when `token` (punctuation trimmed) is a severity word, spelled with ASCII or look-alike letters. */
function isSeverityToken(token: string): boolean {
  const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const folded = [...bare.toLowerCase()].map((ch) => LOOKALIKES[ch] ?? ch).join('');
  return SEVERITY_TOKEN_SKELETONS.has(folded) || folded === 'sev' || folded === 'severity';
}

/**
 * RV3 (Luna rounds 2-3): true when a line that no finding pattern fully parsed
 * still looks like a finding, so the whole reply is refused rather than the
 * line skipped. The line is normalised first (markdown characters removed
 * everywhere, so `maj**or**` is `major`). It is finding-shaped only when it
 * starts with `FINDING`, or with a list or number marker followed by a
 * severity word as the first word, or (no marker) carries a `path:line`
 * reference after a leading severity word. A `path:line` reference alone never
 * makes prose finding-shaped.
 */
function looksLikeUnparsedFinding(trimmedLine: string): boolean {
  // Every shape check runs on the normalised line. A bare `*` bullet is the
  // one marker normalisation would erase, so it is read first.
  const normalised = normaliseFindingLine(trimmedLine);
  const starBullet = /^\*\s+/.exec(trimmedLine);
  const marker = starBullet ?? LIST_OR_NUMBER_MARKER.exec(normalised);
  const body = marker === null ? normalised : normaliseFindingLine(starBullet !== null ? trimmedLine.slice(marker[0].length) : normalised.slice(marker[0].length));
  if (/^FINDING\b/i.test(body) || /^FINDING\b/i.test(normalised)) {
    return true;
  }
  const firstWord = body.split(' ')[0] ?? '';
  if (isSeverityToken(firstWord)) {
    return marker !== null || FILE_REFERENCE.test(trimmedLine);
  }
  // The numbered shape: `N. path:line - severity. summary`.
  const afterTarget = /^\S+ [-–—] (\S+)/.exec(body);
  return marker !== null && afterTarget !== null && isSeverityToken(afterTarget[1] ?? '');
}

/** The findings parsed from a reply, and whether any finding line carried an unrecognised severity. */
interface ParsedFindingLines {
  readonly findings: ReviewFindingRecord[];
  readonly invalid: boolean;
}
export const MAX_RAW_OUTPUT_LENGTH = 20000;

/** Default wall-clock budget for one review run when the caller gives no timeout. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractTextPart(record: Record<string, unknown>): string | null {
  if (record.type !== 'text') {
    return null;
  }
  const part = isPlainRecord(record.part) ? record.part : null;
  if (part !== null) {
    if (part.type !== undefined && part.type !== 'text') {
      return null;
    }
    if (typeof part.text === 'string') {
      return part.text;
    }
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  return null;
}

function isStepStart(record: Record<string, unknown>): boolean {
  if (record.type === 'step_start' || record.type === 'step-start') {
    return true;
  }
  const part = isPlainRecord(record.part) ? record.part : null;
  if (part !== null && (part.type === 'step_start' || part.type === 'step-start')) {
    return true;
  }
  return false;
}

function isToolEvent(record: Record<string, unknown>): boolean {
  if (record.type === 'tool' || record.type === 'tool_use' || record.type === 'tool_call') {
    return true;
  }
  const part = isPlainRecord(record.part) ? record.part : null;
  if (part !== null) {
    if (part.type === 'tool' || part.type === 'tool_use' || part.type === 'tool_call') {
      return true;
    }
    if (part.tool !== undefined) {
      return true;
    }
  }
  return false;
}

/** A non-blank tool name from a `tool` field (a string or `{ name }`), else null. */
function toolNameOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  if (isPlainRecord(value) && typeof value.name === 'string' && value.name.trim() !== '') {
    return value.name.trim();
  }
  return null;
}

/**
 * The tool name an event carries, read from EVERY placement (`part.tool`,
 * `part.name`, `record.tool`, `record.name`); null when none holds one or
 * when the placements disagree, so a `read` in one field cannot hide a
 * `bash` in another (KF-14e Luna pass).
 */
function extractToolName(record: Record<string, unknown>): string | null {
  const part = isPlainRecord(record.part) ? record.part : null;
  const names: string[] = [];
  for (const candidate of [part?.tool, part?.name, record.tool, record.name]) {
    const name = toolNameOf(candidate);
    if (name !== null) {
      names.push(name);
    }
  }
  if (names.length === 0) {
    return null;
  }
  return names.every((name) => name === names[0]) ? names[0] : null;
}

// Lane-written text is a prompt-injection surface: any future embedded
// lane-written text (a full diff, file contents) must go through
// `wrapUntrusted` with a per-prompt nonce, never pasted in directly.
export const REVIEW_REPLY_CONTRACT: string =
  'When your review is complete, end your reply with exactly ONE fenced ```json block, placed at the very end of your reply:\n\n' +
  '```json\n' +
  '{"verdict":"PASS"|"FAIL","findings":[{"severity":"blocker"|"major"|"minor"|"nit","file":"<repo-relative path>","line":<positive int or null>,"summary":"<= 300 chars"}]}\n' +
  '```\n\n' +
  'Reply-contract rules:\n' +
  '- Place this single ```json block at the very end of the reply, with no text after the closing fence and no other ```json block anywhere in the reply.\n' +
  '- Use "findings":[] when there are no findings (at most 100 entries).\n' +
  '- Include exact keys only: "verdict" and "findings" at the top level, and "severity", "file", "line", "summary" on each finding.\n' +
  '- "file" must be a safe repo-relative path (no leading "/", "-", "~", or "..").\n' +
  '- "line" must be a positive integer or null.\n' +
  '- "summary" must be non-empty, at most 300 characters, and free of secrets.\n' +
  '- Do not emit free-text VERDICT: or FINDING: lines: the outcome is read only from the validated ```json block.';

/**
 * Failure-mode checklist every conductor review prompt carries (§3.3). The
 * CLI transport reuses it, so both transports ask the same items.
 */
export const REVIEW_CHECKLIST: string = [
  'Check every item below and report each item that fails as a finding:',
  '(a) the change does what the brief asks, nothing more (scope drift);',
  '(b) claimed checks really pass, or are not claimed;',
  '(c) imports, APIs and files that do not exist;',
  '(d) state cleared on every exit path;',
  '(e) permissive defaults and fail-open branches;',
  '(f) the architecture rules: the domain is pure, ports live in application, I/O lives in infrastructure;',
  '(g) each finding names a concrete failure scenario.',
].join('\n');

/** Byte cap for the diff embedded in a kind review prompt. */
export const MAX_OCM_EMBEDDED_DIFF_BYTES = 120_000;

/** The fixed reason a review is refused because the diff under review could not be read. */
export const DIFF_UNAVAILABLE_REASON = 'diff-unavailable';
/** The fixed reason a review is refused because the diff under review exceeded the embedding limit. */
export const DIFF_TRUNCATED_REASON = 'diff-truncated';

export type DiffEmbedding =
  | { readonly kind: 'embedded'; readonly diff: string }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Pure classification of a read diff before a review is sent. A throw, a
 * null, a non-string or a blank read means the change could not be seen; a
 * diff over the embedding cap means the review would judge only part of the
 * change. Either way the review is refused (`unknown`), never sent.
 */
export function classifyDiffForEmbedding(diff: string | null): DiffEmbedding {
  if (typeof diff !== 'string' || diff.trim() === '') {
    return { kind: 'refused', reason: DIFF_UNAVAILABLE_REASON };
  }
  if (Buffer.byteLength(diff, 'utf8') > MAX_OCM_EMBEDDED_DIFF_BYTES) {
    return { kind: 'refused', reason: DIFF_TRUNCATED_REASON };
  }
  return { kind: 'embedded', diff };
}

export function buildReviewPrompt(
  request: RunIndependentReviewRequest,
  nonce: string,
  embeddedDiff?: string | null,
  diffUnavailable?: boolean,
): string {
  if (request.kind === undefined) {
    return buildManualReviewPrompt(request, nonce);
  }
  return buildKindReviewPrompt(request, nonce, embeddedDiff, diffUnavailable);
}

/** The prompt a manual review (no kind) receives; byte-for-byte the pre-kind text. */
function buildManualReviewPrompt(request: RunIndependentReviewRequest, nonce: string): string {
  const sections: string[] = [
    `Independent read-only code review for attempt "${request.attemptId}" at candidate head "${request.candidateHeadSha}".`,
    'This review session is strictly read-only. Do not edit, create, delete, or modify any files.',
    UNTRUSTED_INPUT_RULE,
  ];

  if (typeof request.diffSummary === 'string' && request.diffSummary.trim() !== '') {
    const wrappedDiffSummary = wrapUntrusted({
      label: 'diff summary',
      text: request.diffSummary.trim(),
      nonce,
    });
    sections.push(`Diff summary:\n${wrappedDiffSummary}`);
  }

  sections.push('Inspect the code changes and candidate head using read-only tools (read, grep, glob, list).\n' + REVIEW_REPLY_CONTRACT);

  return sections.join('\n\n');
}

/**
 * The prompt a conductor review (a request with `kind`) receives: the header
 * names the kind, a brief-check carries the frozen brief wrapped as untrusted,
 * and code-review and pre-merge carry the failure-mode checklist.
 */
function buildKindReviewPrompt(
  request: RunIndependentReviewRequest,
  nonce: string,
  embeddedDiff?: string | null,
  diffUnavailable?: boolean,
): string {
  const sections: string[] = [
    `Independent read-only ${request.kind} review for attempt "${request.attemptId}" at candidate head "${request.candidateHeadSha}".`,
    'This review session is strictly read-only. Do not edit, create, delete, or modify any files.',
    UNTRUSTED_INPUT_RULE,
  ];

  if (typeof request.diffSummary === 'string' && request.diffSummary.trim() !== '') {
    const wrappedDiffSummary = wrapUntrusted({
      label: 'diff summary',
      text: request.diffSummary.trim(),
      nonce,
    });
    sections.push(`Diff summary:\n${wrappedDiffSummary}`);
  }

  if (request.kind === 'brief-check') {
    if (typeof request.briefText === 'string' && request.briefText.trim() !== '') {
      const wrappedBrief = wrapUntrusted({
        label: 'brief',
        text: request.briefText,
        nonce,
      });
      sections.push(
        `${BRIEF_INPUT_RULE}\n\nBrief:\n${wrappedBrief}\n\n` +
          'Does the change satisfy every work-order item of the brief? Report each item the change does not satisfy as a finding.',
      );
    } else {
      throw new ReviewTransportError('a brief-check review requires the brief text', 'transport-failed');
    }
  } else {
    sections.push(REVIEW_CHECKLIST);
  }

  let diffEmbedded = false;
  if (typeof embeddedDiff === 'string' && embeddedDiff.trim() !== '') {
    if (Buffer.byteLength(embeddedDiff, 'utf8') > MAX_OCM_EMBEDDED_DIFF_BYTES) {
      sections.push('The diff was too large to embed; the read-only tools still work against the candidate head.');
    } else {
      const wrappedDiff = wrapUntrusted({
        label: 'diff',
        text: embeddedDiff,
        nonce,
      });
      sections.push(`Diff:\n${wrappedDiff}`);
      diffEmbedded = true;
    }
  } else if (diffUnavailable === true) {
    sections.push('The diff was not available; the read-only tools still work against the candidate head.');
  }

  // KF-14f: the prompt never invites the shell. A reviewer that ran one anyway
  // voided its proof on any flag outside the grammar (the first forge-github
  // run parked twice on `not-read-only`); the grammar stays as the safety net.
  sections.push(
    (diffEmbedded ? KIND_PROMPT_DIFF_COMPLETE + ' ' : '') +
      KIND_PROMPT_TOOLS_ONLY + '\n' + REVIEW_REPLY_CONTRACT,
  );

  return sections.join('\n\n');
}

export interface ParsedReviewReply {
  readonly result: EvidenceResultValue;
  readonly findings: ReviewFindingRecord[];
  /** Fixed cause code when `result === 'unknown'`; absent otherwise. */
  readonly unknownReason?: ReviewUnknownReason;
}

/** Bound on how many findings one reply may contribute. */
export const MAX_PARSED_FINDINGS = 1000;
/** Bound on one finding line; a longer line is skipped, never parsed. */
export const MAX_FINDING_LINE_LENGTH = 8192;

/**
 * The untrusted-block markers the prompt wraps lane-written text in. An echoed
 * block (the reviewer repeating the diff or brief it was given) is data, so
 * neither its markers nor its body may ever contribute a finding.
 */
const UNTRUSTED_OPEN_PATTERN = /^<<<UNTRUSTED nonce=([0-9a-f]{16,64}) label="[^"]*">>>$/;

/**
 * Every line of `text` that is not inside an echoed `<<<UNTRUSTED ...>>>`
 * block (open marker to its matching close, or to EOF when it never closes)
 * or inside a fenced diff block. Linear over the line count; the scan never
 * backtracks.
 */
export function stripUntrustedEchoBlocks(text: string): string {
  return scanUntrustedEchoBlocks(text).stripped;
}

/**
 * The stripped text plus whether an untrusted block or diff fence was opened
 * and never closed. An unclosed block is a malformed answer: callers refuse it
 * (no verdict is read) rather than trusting whatever the strip left.
 */
function scanUntrustedEchoBlocks(text: string): { readonly stripped: string; readonly unclosed: boolean } {
  const kept: string[] = [];
  let openNonce: string | null = null;
  let fenceToken: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (openNonce !== null) {
      if (line.trim() === `<<<END UNTRUSTED nonce=${openNonce}>>>`) {
        openNonce = null;
      }
      continue;
    }
    if (fenceToken !== null) {
      if (line.trim() === fenceToken) {
        fenceToken = null;
      }
      continue;
    }
    const openMatch = UNTRUSTED_OPEN_PATTERN.exec(line.trim());
    if (openMatch !== null) {
      openNonce = openMatch[1] ?? null;
      continue;
    }
    const fenceMatch = /^(```|~~~)diff\s*$/.exec(line.trim());
    if (fenceMatch !== null) {
      fenceToken = fenceMatch[1] ?? null;
      continue;
    }
    kept.push(line);
  }
  return { stripped: kept.join('\n'), unclosed: openNonce !== null || fenceToken !== null };
}

/**
 * One numbered finding line (`N. \`path:line\` — **severity**. summary` and
 * its documented variants: em/en/ASCII dash, bolded or plain severity, `. `,
 * `: ` or whitespace before the summary, chained extra backticked paths joined
 * by `, `, `, and ` or ` and `). Null when the line carries no numbered
 * finding. Linear: no nested quantifiers, no backtracking.
 */
function parseNumberedFindingLine(trimmedLine: string): {
  readonly firstTarget: string;
  readonly extraTargets: string;
  readonly severity: FindingSeverity | null;
  readonly summaryText: string;
} | null {
  const prefixMatch = /^(\d+)\.\s+(.*)$/.exec(trimmedLine);
  if (prefixMatch === null) {
    return null;
  }
  const remainder = prefixMatch[2] ?? '';
  if (!remainder.startsWith('`')) {
    return null;
  }
  const firstMatch = /^`([^`\s]+)`/.exec(remainder);
  if (firstMatch === null) {
    return null;
  }
  const firstTarget = firstMatch[1] ?? '';
  let index = firstMatch[0].length;
  let extraTargets = '';
  for (;;) {
    const chainMatch = /^(?:\s*,\s*|\s*,\s+and\s+|\s+and\s+)`([^`\s]+)`/.exec(remainder.slice(index));
    if (chainMatch === null) {
      break;
    }
    extraTargets += chainMatch[0];
    index += chainMatch[0].length;
  }
  const tail = remainder.slice(index);
  const tailMatch = /^\s+(?:—|–|-)\s+(?:\*\*([A-Za-z][\w-]*)\*\*|(blocker|major|minor|nit|critical|high))(?:\.\s+|:\s+|\s+)(.+)$/i.exec(tail);
  if (tailMatch === null) {
    return null;
  }
  return {
    firstTarget,
    extraTargets: extraTargets.trim(),
    severity: normalizeSeverity(tailMatch[1] ?? tailMatch[2] ?? ''),
    summaryText: tailMatch[3] ?? '',
  };
}

/** The target `path[:line]` (a `-` is no file; a line range keeps its first number), split into filePath and line. */
function targetOf(firstTarget: string): { readonly filePath: string | null; readonly line: number | null } {
  const match = /^(.+?)(?::(\d+)(?:[-–]\d+)?)?$/.exec(firstTarget);
  const rawPath = match?.[1] ?? '';
  const filePath = rawPath === '-' ? null : rawPath;
  const rawLine = match?.[2];
  const parsedLine = rawLine === undefined ? null : Number.parseInt(rawLine, 10);
  const line =
    parsedLine !== null && Number.isSafeInteger(parsedLine) && parsedLine >= 1 ? parsedLine : null;
  return { filePath, line };
}

/** Every finding line of `text`, numbered in order. */
function parseFindingLines(text: string): ParsedFindingLines {
  const findings: ReviewFindingRecord[] = [];
  let invalid = false;
  // Echoed untrusted blocks (a repeated diff or brief) and fenced diff blocks
  // are data the reviewer was handed, never its findings: they are stripped
  // before any line is parsed.
  const stripped = stripUntrustedEchoBlocks(text);
  for (const rawLine of stripped.split(/\r?\n/)) {
    if (findings.length >= MAX_PARSED_FINDINGS) {
      break;
    }
    // A pathological single line stays bounded: overlong lines are skipped.
    if (rawLine.length > MAX_FINDING_LINE_LENGTH) {
      continue;
    }
    const trimmedLine = rawLine.trim();
    const findingMatch = FINDING_PATTERN.exec(trimmedLine);
    if (findingMatch !== null) {
      const findingSeverity = normalizeSeverity(findingMatch[1]);
      if (findingSeverity === null) {
        invalid = true;
        continue;
      }
      findings.push({
        findingId: `review-${findings.length + 1}`,
        severity: findingSeverity,
        summary: findingMatch[4].trim(),
        filePath: findingMatch[2] === '-' ? null : findingMatch[2],
        line: findingMatch[3] === undefined ? null : Number.parseInt(findingMatch[3], 10),
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      });
      continue;
    }
    const numbered = parseNumberedFindingLine(trimmedLine);
    if (numbered !== null) {
      if (numbered.severity === null) {
        invalid = true;
        continue;
      }
      const { filePath, line } = targetOf(numbered.firstTarget);
      const summary =
        numbered.extraTargets === ''
          ? numbered.summaryText.trim()
          : `${numbered.extraTargets} — ${numbered.summaryText.trim()}`;
      findings.push({
        findingId: `review-${findings.length + 1}`,
        severity: numbered.severity,
        summary,
        filePath,
        line,
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      });
      continue;
    }
    if (looksLikeUnparsedFinding(trimmedLine)) {
      invalid = true;
    }
  }
  return { findings, invalid };
}

/**
 * The verdict on the last non-empty line of the whole joined answer, or null
 * when that line carries none. The argument is always the whole answer (every
 * text part joined in order), never a single part or a pre-extracted verdict
 * snippet.
 *
 * Removed with RV5 (F153): free-text `VERDICT:` matching is gone. The outcome
 * is read only from a single schema-valid trailing ```json block, so both
 * parsers below delegate to one structured parse.
 */

/** Bounded diagnostic findings of a free-text-only reply (RV5): each entry is screened, capped, and renumbered. */
function boundedFallbackFindings(parsed: ParsedFindingLines): ReviewFindingRecord[] {
  const findings: ReviewFindingRecord[] = [];
  for (const finding of parsed.findings) {
    if (findings.length >= MAX_STRUCTURED_FINDINGS) {
      break;
    }
    const summary = finding.summary;
    if (summary.length > MAX_FINDING_SUMMARY_LENGTH) {
      continue;
    }
    if (isWholeValuePlaceholder(summary) || containsReviewSecretShape(summary)) {
      continue;
    }
    if (finding.filePath !== null && !isSafeRelativeFilePath(finding.filePath)) {
      continue;
    }
    findings.push({ ...finding, findingId: `review-${findings.length + 1}` });
  }
  return findings;
}

/**
 * The one shared structured parser (RV5, F153): the outcome comes only from a
 * single schema-valid trailing ```json block outside every echoed untrusted
 * / diff block. Blank replies are `empty`; free text, several json blocks,
 * schema violations, oversized replies and malformed json all refuse to
 * `unparseable-verdict` — free text never parses to `pass` or `fail`, it only
 * contributes bounded diagnostic findings onto the `unknown` result. The
 * second parameter (`_ignoredVerdictText`) has no effect on the parse; it is
 * kept only so existing callers compile.
 */
function parseStructuredReviewReply(text: string, _ignoredVerdictText?: string): ParsedReviewReply {
  const UNPARSEABLE: ParsedReviewReply = {
    result: 'unknown',
    findings: [],
    unknownReason: 'unparseable-verdict',
  };
  if (
    typeof text !== 'string' ||
    (_ignoredVerdictText !== undefined && typeof _ignoredVerdictText !== 'string') ||
    text.length > MAX_REVIEW_REPLY_LENGTH
  ) {
    return UNPARSEABLE;
  }
  if (text.trim() === '') {
    return { result: 'unknown', findings: [], unknownReason: 'empty' };
  }
  // RV2: an echoed untrusted block (the reviewer repeating the diff or brief)
  // or a fenced diff block is data, so any ```json block inside it is
  // stripped before fence extraction and therefore ignored. An unclosed
  // block anywhere is a malformed answer.
  const scanned = scanUntrustedEchoBlocks(text);
  if (scanned.unclosed) {
    return UNPARSEABLE;
  }
  const fence = extractSingleTrailingJsonFence(scanned.stripped);
  if (fence.kind === 'none') {
    // Free text with zero json blocks: keep the parsed finding lines only as
    // bounded, screened diagnostics on an `unknown` result. Free text never
    // yields `pass` or `fail`.
    return {
      result: 'unknown',
      findings: boundedFallbackFindings(parseFindingLines(scanned.stripped)),
      unknownReason: 'unparseable-verdict',
    };
  }
  if (fence.kind === 'invalid') {
    return UNPARSEABLE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence.jsonText);
  } catch {
    return UNPARSEABLE;
  }
  const validated = validateReviewAnswerObject(parsed);
  if (!validated.ok) {
    return UNPARSEABLE;
  }
  const findings: ReviewFindingRecord[] = validated.value.findings.map(
    (entry, index): ReviewFindingRecord => ({
      findingId: `review-${index + 1}`,
      severity: entry.severity,
      summary: entry.summary.trim(),
      filePath: entry.file,
      line: entry.line,
      state: 'unresolved',
      dispositionReason: null,
      dispositionEvidenceRef: null,
    }),
  );
  // Severities decide first, then the verdict: a blocker or major fails even
  // on a PASS verdict; minors/nits ride a pass even on a FAIL verdict; a
  // FAIL with zero findings stays unknown.
  if (findings.some((finding) => finding.severity === 'blocker' || finding.severity === 'major')) {
    return { result: 'fail', findings };
  }
  if (findings.length > 0) {
    return { result: 'pass', findings };
  }
  if (validated.value.verdict === 'PASS') {
    return { result: 'pass', findings: [] };
  }
  return { result: 'unknown', findings: [], unknownReason: 'no-findings-on-fail' };
}

/**
 * Findings and outcome both come from `text`, the whole answer (every text
 * part joined in order): one structured parse for every answer shape (RV5).
 * The second parameter (`_ignoredVerdictText`) has no effect on the parse; it
 * is kept only so existing callers compile.
 */
export function parseReviewReply(text: string, _ignoredVerdictText?: string): ParsedReviewReply {
  return parseStructuredReviewReply(text, _ignoredVerdictText);
}

/**
 * Strict parsing for conductor replies (a request with `kind`). Since RV5
 * (F153) this is the same structured parse as `parseReviewReply`: the outcome
 * comes only from a single schema-valid trailing ```json block. The second
 * parameter (`_ignoredVerdictText`) has no effect; it is kept only so
 * existing callers compile.
 */
export function parseReviewReplyStrict(text: string, _ignoredVerdictText?: string): ParsedReviewReply {
  return parseStructuredReviewReply(text, _ignoredVerdictText);
}

export function buildReviewerEnv(
  options: Pick<
    OcmReviewTransportOptions,
    'remotePort' | 'remoteHost' | 'hostMode' | 'authFile'
  >,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of REVIEWER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.OCM_REMOTE_PORT = String(options.remotePort);
  if (options.hostMode === 'installation') {
    // An empty OCM_HOST means a local host is dialled directly. Never read
    // process.env.OCM_HOST in installation mode.
    env.OCM_HOST = options.remoteHost ?? '';
    if (typeof options.authFile === 'string' && options.authFile.trim() !== '') {
      env.OPENCODE_AUTH_FILE = options.authFile.trim();
    }
  } else {
    const host = options.remoteHost ?? (process.env.OCM_HOST?.trim() || undefined);
    if (host !== undefined && host !== '') {
      env.OCM_HOST = host;
    }
  }
  return env;
}

function defaultNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The default review spawn: runs `bin/ocm-run` through `runSpawnOutcome`
 * under the review budget, the review output cap, and a 15 s kill grace.
 * The grace is the time `bin/ocm-run`'s TERM trap needs to abort the
 * server-side session (two HTTP round trips: `ocm_stop`/`ocm_abort`)
 * before the process tree is SIGKILLed; a shorter grace would leave the
 * reviewer session running and the worktree busy (exit 75) for a retry.
 * Limit: with an unresponsive server ocm-run's trap can need more than 15 s (one 8 s curl per call),
 * so SIGKILL may still land before the abort; a hung server cannot be aborted anyway.
 */
export const REVIEW_KILL_GRACE_MS = 15 * 1000;

export async function defaultSpawn(
  file: string,
  args: readonly string[],
  env: Record<string, string>,
  options?: { readonly timeoutMs: number },
  runner: typeof runSpawnOutcome = runSpawnOutcome,
): Promise<OcmReviewTransportSpawnResult> {
  const outcome = await runner(file, args, {
    env,
    timeoutMs: options?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
    killGraceMs: REVIEW_KILL_GRACE_MS,
  });
  const timedOut = outcome.error !== undefined && /timed?\s*out|timeout/i.test(outcome.error);
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr !== '' ? outcome.stderr : outcome.error ?? '',
    ...(timedOut ? { timedOut: true } : {}),
  };
}

export function createOcmReviewTransport(
  options: OcmReviewTransportOptions,
): (request: RunIndependentReviewRequest) => Promise<IndependentReviewTransportResult> {
  return async (request: RunIndependentReviewRequest): Promise<IndependentReviewTransportResult> => {
    // 0. A `none` route refuses before any work (KF-14a): the route's code is
    // the fixed reason; an absent code (an older locator) is route-unresolved.
    if (options.route !== undefined && options.route.kind === 'none') {
      throw new ReviewTransportError(options.route.reason, options.route.code ?? 'route-unresolved');
    }

    // 1. Verify reviewer model matches options.model
    if (request.reviewerModel !== options.model) {
      throw new ReviewTransportError(
        `reviewer model mismatch: request specified "${request.reviewerModel}" but transport configured for "${options.model}"`,
        'transport-failed',
      );
    }

    // 2. Reject options starting with '-'
    if (options.model.startsWith('-') || options.model.trim().startsWith('-')) {
      throw new ReviewTransportError(`invalid model: "${options.model}" starts with "-"`, 'transport-failed');
    }
    if (options.agent.startsWith('-') || options.agent.trim().startsWith('-')) {
      throw new ReviewTransportError(`invalid agent: "${options.agent}" starts with "-"`, 'transport-failed');
    }
    if (
      options.variant !== undefined &&
      (options.variant.startsWith('-') || options.variant.trim().startsWith('-'))
    ) {
      throw new ReviewTransportError(`invalid variant: "${options.variant}" starts with "-"`, 'transport-failed');
    }

    // 3. Resolve review directory and verify before head
    const dir = await options.resolveReviewDir(request);
    if (dir === null || typeof dir !== 'string' || dir.trim() === '') {
      throw new ReviewTransportError(`failed to resolve review directory for attempt ${request.attemptId}`, 'transport-failed');
    }
    if (dir.startsWith('-') || dir.trim().startsWith('-')) {
      throw new ReviewTransportError(`invalid review directory: "${dir}" starts with "-"`, 'transport-failed');
    }
    const before = await options.readHead(dir);
    if (before !== request.candidateHeadSha) {
      throw new ReviewTransportError(
        `head mismatch before review: expected ${request.candidateHeadSha}, found ${String(before)} in ${dir}`,
        'transport-failed',
      );
    }

    // 4. RV4: before the review, prove the worktree is idle with
    // `ocm-run --wait --dir <dir>` under the review budget. `--wait` exits 0
    // when idle (two reads) and 75 when a session still runs past
    // `OCM_WAIT_MAX`; a cut-short wait (a timeout) writes no review intent, so
    // the next pass can dispatch. Exit 75 or `timedOut` is `seat-busy`; any
    // other non-zero exit, an unreadable exit code or a thrown spawn is the
    // existing `transport`/`timeout` code. None of these spawn the review.
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    const reviewEnv = buildReviewerEnv(options);
    const waitSpawnFn = options.spawn ?? defaultSpawn;
    let waitResult: OcmReviewTransportSpawnResult;
    try {
      waitResult = await waitSpawnFn(options.ocmRunBin, ['--wait', '--dir', dir], {
        ...reviewEnv,
        OCM_WAIT_MAX: String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      }, { timeoutMs });
    } catch (error) {
      // RV4: a thrown spawn always classifies as `timeout` or `transport`. Its
      // message is never passed through — it may carry a secret or a path —
      // and a typed ReviewTransportError thrown by the spawn is classified like
      // any other throw, never rethrown with its own code or message.
      throw new ReviewTransportError(
        'reviewer process failed',
        isTimeoutError(error) ? 'timeout' : 'transport',
        transportFailureDiagnostic(error),
      );
    }
    const waitExitCode = safeRead(() => waitResult.exitCode);
    if (waitExitCode === 75 || safeRead(() => waitResult.timedOut === true) === true) {
      throw new ReviewTransportError('review seat busy', 'seat-busy', spawnDiagnosticOf(waitResult));
    }
    if (waitExitCode !== 0) {
      const waitTimedOut = spawnTimedOut(waitResult);
      throw new ReviewTransportError(
        `reviewer process failed with exit code ${String(waitExitCode)}`,
        waitTimedOut ? 'timeout' : 'transport',
        spawnDiagnosticOf(waitResult),
      );
    }

    // 5. Build argv and sanitized environment. A kind review embeds the
    // base..head diff read after the pre-review head read, so the reviewer
    // does not need a shell to see the change.
    const nonce = (options.makeNonce ?? defaultNonce)();
    let embeddedDiff: string | null = null;
    if (request.kind !== undefined) {
      // F68: a kind review with no diff source is refused exactly like an
      // unreadable diff: a review that cannot see the change can still answer
      // PASS, so the transport refuses before the prompt and the spawn.
      if (options.baseCommit === undefined || options.readDiff === undefined) {
        const afterMissing = await options.readHead(dir);
        return {
          rawOutput: DIFF_UNAVAILABLE_REASON,
          readOnlyVerified:
            before === request.candidateHeadSha && afterMissing === request.candidateHeadSha,
          result: 'unknown',
          findings: [],
          completedAtIso: new Date().toISOString(),
        };
      }
      // A thrown read is a missing diff: classify the read result uniformly.
      let read: string | null = null;
      try {
        read = await options.readDiff(options.baseCommit, request.candidateHeadSha);
      } catch {
        read = null;
      }
      const embedding = classifyDiffForEmbedding(read);
      if (embedding.kind === 'refused') {
        // F68: a review that cannot see the change is never a pass. The
        // transport refuses here instead of sending a review that could pass
        // without the diff. `unknown` is the outcome the callers treat as
        // not-accepted, and the fixed reason travels as the raw output.
        const after = await options.readHead(dir);
        return {
          rawOutput: embedding.reason,
          readOnlyVerified: before === request.candidateHeadSha && after === request.candidateHeadSha,
          result: 'unknown',
          findings: [],
          completedAtIso: new Date().toISOString(),
        };
      }
      embeddedDiff = embedding.diff;
    }
    const prompt = buildReviewPrompt(request, nonce, embeddedDiff);
    const argv: string[] = [
      '--dir',
      dir,
      '--agent',
      options.agent,
      '-m',
      options.model,
      ...(options.variant ? ['--variant', options.variant] : []),
      '--format',
      'json',
      prompt,
    ];
    // 6. Spawn runner process; non-zero or null exit throws
    const spawnFn = options.spawn ?? defaultSpawn;
    let spawnResult: OcmReviewTransportSpawnResult;
    try {
      spawnResult = await spawnFn(options.ocmRunBin, argv, reviewEnv, {
        timeoutMs,
      });
    } catch (error) {
      // Every throw from the review spawn is classified: a timeout shape is a
      // `timeout`, anything else a `transport` failure. A typed
      // ReviewTransportError thrown by the spawn does not travel as-is — its
      // message could expose a secret or a path, and its code would bypass the
      // thrown-spawn classification; the fixed message travels instead.
      throw new ReviewTransportError(
        'reviewer process failed',
        isTimeoutError(error) ? 'timeout' : 'transport',
        transportFailureDiagnostic(error),
      );
    }
    const spawnExitCode = safeRead(() => spawnResult.exitCode);
    if (spawnExitCode !== 0) {
      const timedOut = spawnTimedOut(spawnResult);
      const diagnostic = spawnDiagnosticOf(spawnResult);
      if (spawnExitCode === 75 && !timedOut) {
        // RV4: an exit 75 from the review spawn that is not a timeout means the
        // worktree is busy too. The fixed message carries no stderr and no path.
        throw new ReviewTransportError('review seat busy', 'seat-busy', diagnostic);
      }
      throw new ReviewTransportError(
        `reviewer process failed with exit code ${String(spawnExitCode)}`,
        timedOut ? 'timeout' : 'transport',
        diagnostic,
      );
    }

    // 7. Parse stdout JSON lines for text and tool parts
    // A missing or non-string stdout reads as empty; the parse loop never throws.
    const spawnStdout = safeRead(() => spawnResult.stdout);
    let readOnlyVoided = false;
    let hasStepStart = false;
    const textParts: string[] = [];
    const toolNames: string[] = [];
    for (const rawLine of (typeof spawnStdout === 'string' ? spawnStdout : '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        readOnlyVoided = true;
        continue;
      }
      if (!isPlainRecord(parsed)) {
        readOnlyVoided = true;
        continue;
      }

      if (typeof parsed.type !== 'string' || !RECOGNISED_EVENT_TYPES.has(parsed.type)) {
        readOnlyVoided = true;
      }

      if (parsed.part !== undefined) {
        if (!isPlainRecord(parsed.part)) {
          readOnlyVoided = true;
        } else if (
          parsed.part.type !== undefined &&
          (typeof parsed.part.type !== 'string' || !ALLOWED_PART_TYPES.has(parsed.part.type))
        ) {
          readOnlyVoided = true;
        }
      }

      if (isStepStart(parsed)) {
        hasStepStart = true;
      }

      if (isToolEvent(parsed)) {
        const toolName = extractToolName(parsed);
        if (toolName === null) {
          readOnlyVoided = true;
        } else {
          toolNames.push(toolName);
          // F68: the prompt voids any shell call whatever the command, so no
          // command is read: the four read-only tools keep the proof and every
          // other tool (bash and shell included, `git status` included, an
          // unreadable command included) voids it.
          if (!READ_ONLY_REVIEW_TOOLS.has(toolName)) {
            readOnlyVoided = true;
          }
        }
      }

      const textPart = extractTextPart(parsed);
      if (textPart !== null) {
        textParts.push(textPart);
      }
    }

    // 8. Verify head after review and compute readOnlyVerified
    const after = await options.readHead(dir);
    const readOnlyVerified =
      !readOnlyVoided &&
      hasStepStart &&
      before === request.candidateHeadSha &&
      after === request.candidateHeadSha;

    // 9. Parse verdict, findings, and rawOutput
    // Each text part is a whole message part; a part that does not end in a newline must not glue its last line onto the next part's first.
    const finalText = textParts.join('\n');
    // A conductor request (a kind) is validated strictly; a manual request keeps today's parse.
    const { result, findings, unknownReason } =
      request.kind !== undefined
        ? parseReviewReplyStrict(finalText)
        : parseReviewReply(finalText);

    const rawOutput =
      finalText.length > MAX_RAW_OUTPUT_LENGTH ? finalText.slice(-MAX_RAW_OUTPUT_LENGTH) : finalText;

    return {
      rawOutput,
      readOnlyVerified,
      result,
      findings,
      completedAtIso: new Date().toISOString(),
      ...(unknownReason !== undefined ? { unknownReason } : {}),
    };
  };
}
