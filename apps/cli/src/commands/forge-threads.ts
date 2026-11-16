/** The `forge threads` subcommands: list, reply and resolve over the operator review thread helper. */

import { statSync, readFileSync } from 'node:fs';

import { firstPositional, CliUsageError } from './payload.js';
import type { CommandHandler, Payload } from './payload.js';

/**
 * The optional `pullRequestNumber`: absent stays absent; a present value must
 * be a positive safe integer (a number, or its plain decimal string from a
 * flag). Anything else is a usage error and no request is made.
 */
export function strictPullRequestNumber(p: Payload): number | undefined {
  const value = p['pullRequestNumber'];
  if (value === undefined) {
    return undefined;
  }
  let parsed = Number.NaN;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    parsed = Number(value);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CliUsageError('forge pullRequestNumber must be a positive integer');
  }
  return parsed;
}

const SUBCOMMANDS = new Set(['list', 'reply', 'resolve']);
const REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_+/=-]{1,256}$/;
const MAX_BODY_FILE_BYTES = 32000;
const MAX_BODY_CHARS = 8000;

/** A validated `forge threads` request; nothing here is forge-sourced. */
interface ValidThreadsRequest {
  readonly sub: 'list' | 'reply' | 'resolve';
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly threadId: string | null;
  readonly body: string | null;
}

/** The flag keys each subcommand accepts; anything else is a usage error. */
function allowedKeys(sub: string): ReadonlySet<string> {
  const keys = new Set(['positional', 'repository', 'pullRequestNumber']);
  if (sub === 'reply' || sub === 'resolve') {
    keys.add('threadId');
  }
  if (sub === 'reply') {
    keys.add('bodyFile');
  }
  return keys;
}

/** The `owner/repo` flag, split into its two segments. */
function repositorySegments(value: unknown): { owner: string; repo: string } {
  if (typeof value !== 'string') {
    throw new CliUsageError('forge threads: --repository must be owner/repo');
  }
  const match = REPOSITORY_PATTERN.exec(value);
  if (match === null || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') {
    throw new CliUsageError('forge threads: --repository must be owner/repo');
  }
  return { owner: match[1], repo: match[2] };
}

/** The `--thread-id` flag of reply and resolve. */
function threadIdOf(payload: Payload): string {
  const value = payload['threadId'];
  if (typeof value !== 'string' || !THREAD_ID_PATTERN.test(value)) {
    throw new CliUsageError('forge threads: --thread-id must be 1 to 256 id characters');
  }
  return value;
}

/**
 * Read and sanitize the reply body: a regular file of at most 32000 bytes,
 * tabs become spaces and control characters are removed before the text is
 * sent to the forge.
 */
function readReplyBody(path: string): string {
  let raw: string;
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size < 1 || stats.size > MAX_BODY_FILE_BYTES) {
      throw new Error('size');
    }
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new CliUsageError('forge threads reply: --body-file must be a readable regular file of at most 32000 bytes');
  }
  const withoutTabs = raw.replaceAll('\t', ' ');
  // The control characters are the point: forge text never carries them.
  // eslint-disable-next-line no-control-regex
  const stripped = withoutTabs.replaceAll(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
  if (stripped.trim().length === 0 || stripped.length > MAX_BODY_CHARS) {
    throw new CliUsageError(
      'forge threads reply: the body must be 1 to 8000 characters after control characters are removed',
    );
  }
  return stripped;
}

/** Every check runs, in order, before any port call; each failure is a usage error. */
function validate(payload: Payload): ValidThreadsRequest {
  const sub = firstPositional(payload);
  if (!SUBCOMMANDS.has(sub)) {
    throw new CliUsageError("forge threads: the subcommand must be 'list', 'reply' or 'resolve'");
  }
  const positionals = payload['positional'];
  if (!Array.isArray(positionals) || positionals.length !== 1) {
    throw new CliUsageError('forge threads: exactly one subcommand argument is allowed');
  }
  for (const key of Object.keys(payload)) {
    if (!allowedKeys(sub).has(key)) {
      throw new CliUsageError('forge threads: an unknown flag or option was given');
    }
  }
  const { owner, repo } = repositorySegments(payload['repository']);
  const pullRequestNumber = strictPullRequestNumber(payload);
  if (pullRequestNumber === undefined) {
    throw new CliUsageError('forge threads: --pull-request-number is required');
  }
  let threadId: string | null = null;
  if (sub === 'reply' || sub === 'resolve') {
    threadId = threadIdOf(payload);
  }
  let body: string | null = null;
  if (sub === 'reply') {
    const bodyFile = payload['bodyFile'];
    if (typeof bodyFile !== 'string' || bodyFile.trim().length === 0) {
      throw new CliUsageError('forge threads reply: --body-file must be a readable regular file of at most 32000 bytes');
    }
    body = readReplyBody(bodyFile);
  }
  return { sub: sub as ValidThreadsRequest['sub'], owner, repo, pullRequestNumber, threadId, body };
}

/** Forge text is printed only after tabs became spaces and control characters were dropped. */
function printable(value: string, max: number): string {
  const withoutTabs = value.replaceAll('\t', ' ');
  // The control characters are the point: printed forge text never carries them.
  // eslint-disable-next-line no-control-regex
  return withoutTabs.replaceAll(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);
}

const MALFORMED = { outcome: 'unknown', reason: 'malformed-port-response' } as const;
const REFUSAL_CODES: ReadonlySet<string> = new Set(['invalid-input', 'thread-not-found', 'thread-not-on-pull-request']);
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'unconfigured',
  'unreadable',
  'budget-exhausted',
  'forge-error',
  'timeout',
]);

/** The printed reply failure carries mayHavePosted; it is decided before the mutation starts. */
function withMayHavePosted(base: object, mayHavePosted: boolean): object {
  return { ...base, mayHavePosted };
}

function failureProjection(sub: ValidThreadsRequest['sub'], result: Record<string, unknown>): object {
  if (result['outcome'] === 'refused') {
    const code = result['code'];
    const printed = typeof code === 'string' && REFUSAL_CODES.has(code) ? code : 'unrecognised';
    const base = { outcome: 'refused', code: printed };
    return sub === 'reply' ? withMayHavePosted(base, false) : base;
  }
  const reason = result['reason'];
  const printed = typeof reason === 'string' && UNAVAILABLE_REASONS.has(reason) ? reason : 'unrecognised';
  const base = { outcome: 'unavailable', reason: printed };
  if (sub !== 'reply') {
    return base;
  }
  return withMayHavePosted(base, printed !== 'unconfigured' && printed !== 'budget-exhausted');
}

/** The handler's own port-method-missing answer; reply adds mayHavePosted: false. */
function missingMethod(sub: ValidThreadsRequest['sub']): object {
  const base = { outcome: 'unavailable', reason: 'port-method-missing' };
  return sub === 'reply' ? withMayHavePosted(base, false) : base;
}

function malformed(sub: ValidThreadsRequest['sub']): object {
  return sub === 'reply' ? withMayHavePosted(MALFORMED, true) : MALFORMED;
}

/** One listed thread as typed fields; any wrong type makes the whole answer malformed. */
function listedThread(value: unknown): { threadId: string; isResolved: boolean; path: string; line: number | null; author: string | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const threadId = record['threadId'];
  const isResolved = record['isResolved'];
  const path = record['path'];
  const line = record['line'];
  const author = record['author'];
  if (typeof threadId !== 'string' || typeof isResolved !== 'boolean' || typeof path !== 'string') {
    return null;
  }
  if (line !== null && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0)) {
    return null;
  }
  if (author !== null && typeof author !== 'string') {
    return null;
  }
  return { threadId, isResolved, path, line, author };
}

function projectList(threads: unknown): object {
  if (!Array.isArray(threads)) {
    return MALFORMED;
  }
  const count = threads.length;
  if (count > 5000) {
    return MALFORMED;
  }
  const printed: object[] = [];
  let unresolvedCount = 0;
  for (let i = 0; i < count; i++) {
    const entry = listedThread(threads[i]);
    if (entry === null) {
      return MALFORMED;
    }
    if (!entry.isResolved) {
      unresolvedCount += 1;
    }
    printed.push({
      threadId: printable(entry.threadId, 256),
      isResolved: entry.isResolved,
      path: printable(entry.path, 400),
      line: entry.line,
      author: entry.author === null ? null : printable(entry.author, 100),
    });
  }
  return { outcome: 'ok', count, unresolvedCount, threads: printed };
}

/** The handler never returns the port's own object; it projects fields it has checked. */
function project(sub: ValidThreadsRequest['sub'], result: unknown, threadId: string): object {
  try {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      return malformed(sub);
    }
    const outcome = (result as Record<string, unknown>)['outcome'];
    if (outcome === 'ok') {
      if (sub === 'list') {
        return projectList((result as Record<string, unknown>)['threads']);
      }
      if (sub === 'reply') {
        const commentId = (result as Record<string, unknown>)['commentId'];
        if (typeof commentId !== 'string' || commentId.length < 1) {
          return malformed(sub);
        }
        return { outcome: 'ok', threadId, commentId: printable(commentId, 256) };
      }
      if ((result as Record<string, unknown>)['isResolved'] !== true) {
        return malformed(sub);
      }
      return { outcome: 'ok', threadId, isResolved: true };
    }
    if (outcome === 'refused' || outcome === 'unavailable') {
      return failureProjection(sub, result as Record<string, unknown>);
    }
    return malformed(sub);
  } catch {
    return malformed(sub);
  }
}

const METHOD_NAMES: Readonly<Record<string, string>> = {
  list: 'listReviewThreads',
  reply: 'replyToReviewThread',
  resolve: 'resolveReviewThread',
};

export const forgeThreadsHandler: CommandHandler = async (payload, rt) => {
  const valid = validate(payload);
  const helper: unknown = rt.execution.reviewThreadHelper;
  const method =
    typeof helper === 'object' && helper !== null
      ? (helper as Record<string, unknown>)[METHOD_NAMES[valid.sub]]
      : undefined;
  if (typeof method !== 'function') {
    return missingMethod(valid.sub);
  }
  const deadlineIso = new Date(Date.now() + 120_000).toISOString();
  const base = {
    repository: { owner: valid.owner, repo: valid.repo },
    pullRequestNumber: valid.pullRequestNumber,
    deadlineIso,
  };
  const request =
    valid.sub === 'list'
      ? base
      : valid.sub === 'reply'
        ? { ...base, threadId: valid.threadId, body: valid.body }
        : { ...base, threadId: valid.threadId };
  let result: unknown;
  try {
    // Exactly one call; a reply is never retried (a second call posts a second comment).
    result = await (method as (r: unknown) => Promise<unknown>).call(helper, request);
  } catch {
    return malformed(valid.sub);
  }
  return project(valid.sub, result, valid.threadId ?? '');
};
