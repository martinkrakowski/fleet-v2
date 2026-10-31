import { randomBytes } from 'node:crypto';

import { BRIEF_INPUT_RULE, UNTRUSTED_INPUT_RULE, wrapUntrusted } from '../../domain/untrusted-input.js';
import type { FindingSeverity, ReviewFindingRecord } from '../../domain/evidence-records.js';
import type { EvidenceResultValue } from '../../domain/value-objects/EvidenceResult.vo.js';
import type { ReviewUnavailableCode, RunIndependentReviewRequest } from '../../application/ports/out/IndependentReviewPort.out-port.js';
import type { IndependentReviewTransportResult } from './IndependentReviewAdapter.adapter.js';
import type { ReviewRunnerRoute } from './ReviewTransportRouter.js';
import { runSpawnOutcome, DEFAULT_MAX_BUFFER_BYTES } from './spawn-run.js';

/**
 * A typed transport failure (KF-14a): the code is one fixed `ReviewUnavailableCode`,
 * never transport or forge text. Every refusal of the opencode review transport throws
 * `ReviewTransportError`; the router throws it for seat and tool refusals, and
 * `IndependentReviewAdapter` maps any other throw to `transport-failed`.
 */
export class ReviewTransportError extends Error {
  readonly code: ReviewUnavailableCode;

  constructor(message: string, code: ReviewUnavailableCode) {
    super(message);
    this.name = 'ReviewTransportError';
    this.code = code;
  }
}

export interface OcmReviewTransportSpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
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
 * The shell commands the lane server's `reviewer` agent may already run, so a
 * strictly read-only shell command is read-only proof by design. The proof
 * grammar below is an allow-list, never a deny-list: read-only commands can
 * still write or execute, so anything not shaped exactly like the forms here
 * is refused.
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
 * True only for a shell command the lane server's `reviewer` agent may run as
 * read-only proof: `git diff|log|show|status`, `grep`, `rg`, `sed -n`, `cat`,
 * `ls` and `wc` in the strict shapes above. Pure and fail-closed: anything
 * unparsable, over-long, carrying a shell metacharacter, an assignment, an
 * unknown flag or an unsafe path is refused.
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

/**
 * The shell command a bash/shell tool event carries, read from the PART's
 * input placements only (`part.input.command` and `part.state.input.command`);
 * null when no placement holds one or when the placements disagree. An
 * event-level `input` is never read, so a passing placement cannot hide a
 * failing one.
 */
function extractShellCommand(record: Record<string, unknown>): string | null {
  const part = isPlainRecord(record.part) ? record.part : null;
  if (part === null) {
    return null;
  }
  const state = isPlainRecord(part.state) ? part.state : null;
  const commands: string[] = [];
  for (const input of [part.input, state?.input]) {
    if (isPlainRecord(input) && typeof input.command === 'string') {
      commands.push(input.command);
    }
  }
  if (commands.length === 0) {
    return null;
  }
  return commands.every((command) => command === commands[0]) ? commands[0] : null;
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

const VERDICT_PATTERN = /^VERDICT: (PASS|FAIL)$/;
const FINDING_PATTERN = /^FINDING: (blocker|major|minor|nit) (\S+?)(?::(\d+))? (.+)$/;
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
  'When your review is complete, format your response according to the following reply contract:\n\n' +
  '- For each finding, output a line matching:\n' +
  '  FINDING: <blocker|major|minor|nit> <filePath>[:<line>] <summary>\n' +
  '  Use "-" for filePath if the finding is not tied to a specific file.\n' +
  '- Conclude with exactly one verdict line matching:\n' +
  '  VERDICT: PASS\n' +
  '  or\n' +
  '  VERDICT: FAIL';

/**
 * Failure-mode checklist every conductor review prompt carries (§3.3). The
 * CLI transport reuses it, so both transports ask the same items.
 */
export const REVIEW_CHECKLIST: string = [
  'Check every item below and report a FINDING for each item that fails:',
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
          'Does the change satisfy every work-order item of the brief? Report a FINDING for each item the change does not satisfy.',
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
}

/** Every finding line of `text`, numbered in order. */
function parseFindingLines(text: string): ReviewFindingRecord[] {
  const findings: ReviewFindingRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const findingMatch = FINDING_PATTERN.exec(rawLine.trim());
    if (findingMatch !== null) {
      findings.push({
        findingId: `review-${findings.length + 1}`,
        severity: findingMatch[1] as FindingSeverity,
        summary: findingMatch[4].trim(),
        filePath: findingMatch[2] === '-' ? null : findingMatch[2],
        line: findingMatch[3] === undefined ? null : Number.parseInt(findingMatch[3], 10),
        state: 'unresolved',
        dispositionReason: null,
        dispositionEvidenceRef: null,
      });
    }
  }
  return findings;
}

/** The verdict on the last non-empty line of `verdictText`, or null when that line carries none. */
function lastLineVerdict(verdictText: string): 'PASS' | 'FAIL' | null {
  const lastNonEmptyLine = verdictText
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim() !== '');
  if (lastNonEmptyLine === undefined) {
    return null;
  }
  const verdictMatch = VERDICT_PATTERN.exec(lastNonEmptyLine);
  return verdictMatch === null ? null : (verdictMatch[1] as 'PASS' | 'FAIL');
}

/** Findings from every line of `text`; the verdict only from the last non-empty line of `verdictText`. */
export function parseReviewReply(text: string, verdictText: string): ParsedReviewReply {
  const findings = parseFindingLines(text);
  const verdict = lastLineVerdict(verdictText);
  let result: EvidenceResultValue = 'unknown';
  if (verdict === 'PASS') {
    result = findings.some((f) => f.severity === 'blocker') ? 'fail' : 'pass';
  } else if (verdict === 'FAIL') {
    result = 'fail';
  }
  return { result, findings };
}

/**
 * Strict verdict validation for conductor replies (a request with `kind`):
 * PASS with any blocker or major finding is a fail, a FAIL with zero findings
 * is unknown (the run parks ambiguous rather than starting a fix round
 * without findings), and a missing verdict is unknown. Manual reviews keep
 * `parseReviewReply` unchanged.
 */
export function parseReviewReplyStrict(text: string, verdictText: string): ParsedReviewReply {
  const findings = parseFindingLines(text);
  const verdict = lastLineVerdict(verdictText);
  let result: EvidenceResultValue = 'unknown';
  if (verdict === 'PASS') {
    result = findings.some((f) => f.severity === 'blocker' || f.severity === 'major') ? 'fail' : 'pass';
  } else if (verdict === 'FAIL' && findings.length > 0) {
    result = 'fail';
  }
  return { result, findings };
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
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr !== '' ? outcome.stderr : outcome.error ?? '',
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

    // 4. Build argv and sanitized environment. A kind review embeds the
    // base..head diff read after the pre-review head read, so the reviewer
    // does not need a shell to see the change.
    const nonce = (options.makeNonce ?? defaultNonce)();
    let embeddedDiff: string | null = null;
    let diffUnavailable = false;
    if (request.kind !== undefined && options.baseCommit !== undefined && options.readDiff !== undefined) {
      // A failed diff read never aborts the review: the prompt carries the
      // "diff not available" note next to the tools sentence and the tools
      // still work against the candidate head.
      let diff: string | null = null;
      try {
        const read = await options.readDiff(options.baseCommit, request.candidateHeadSha);
        if (typeof read === 'string' && read.trim() !== '') {
          diff = read;
        }
      } catch {
        diff = null;
      }
      embeddedDiff = diff;
      diffUnavailable = diff === null;
    }
    const prompt = buildReviewPrompt(request, nonce, embeddedDiff, diffUnavailable);
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
    const env = buildReviewerEnv(options);

    // 5. Spawn runner process; non-zero or null exit throws
    const spawnFn = options.spawn ?? defaultSpawn;
    const spawnResult = await spawnFn(options.ocmRunBin, argv, env, {
      timeoutMs: options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    });
    if (spawnResult.exitCode !== 0) {
      throw new ReviewTransportError(
        `reviewer process failed with exit code ${String(spawnResult.exitCode)}: ${spawnResult.stderr || spawnResult.stdout}`,
        'transport-failed',
      );
    }

    // 6. Parse stdout JSON lines for text and tool parts
    let readOnlyVoided = false;
    let hasStepStart = false;
    const textParts: string[] = [];
    const toolNames: string[] = [];
    for (const rawLine of spawnResult.stdout.split(/\r?\n/)) {
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
          if (READ_ONLY_REVIEW_TOOLS.has(toolName)) {
            // already read-only proof
          } else if (toolName === 'bash' || toolName === 'shell') {
            // The lane server's reviewer agent denies bash except a read-only
            // command list, so a strictly read-only command is proof by
            // design; anything else (or no readable command) voids.
            const command = extractShellCommand(parsed);
            if (command === null || !isReadOnlyReviewCommand(command)) {
              readOnlyVoided = true;
            }
          } else {
            readOnlyVoided = true;
          }
        }
      }

      const textPart = extractTextPart(parsed);
      if (textPart !== null) {
        textParts.push(textPart);
      }
    }

    // 7. Verify head after review and compute readOnlyVerified
    const after = await options.readHead(dir);
    const readOnlyVerified =
      !readOnlyVoided &&
      hasStepStart &&
      before === request.candidateHeadSha &&
      after === request.candidateHeadSha;

    // 8. Parse verdict, findings, and rawOutput
    // Each text part is a whole message part; a part that does not end in a newline must not glue its last line onto the next part's first.
    const finalText = textParts.join('\n');
    const lastText = textParts.at(-1) ?? '';
    // A conductor request (a kind) is validated strictly; a manual request keeps today's parse.
    const { result, findings } =
      request.kind !== undefined
        ? parseReviewReplyStrict(finalText, lastText)
        : parseReviewReply(finalText, lastText);

    const rawOutput =
      finalText.length > MAX_RAW_OUTPUT_LENGTH ? finalText.slice(-MAX_RAW_OUTPUT_LENGTH) : finalText;

    return {
      rawOutput,
      readOnlyVerified,
      result,
      findings,
      completedAtIso: new Date().toISOString(),
    };
  };
}
