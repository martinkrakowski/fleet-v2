// @generated adapter scaffold — implemented for migration step 2 (hand-written file or orchestrator prose).
/**
 * BriefAuthoringAdapter implements BriefAuthoringPort. It reads a hand-written
 * brief file when one is provided, falls back to orchestrator prose registered
 * per work order, and reports absence explicitly. No provider inference and no
 * synthesis happen here.
 *
 * Lane CO17 adds `authorBriefSession`: one read-only seat session per brief, an
 * argv array through the executor (never a shell) in a checkout pinned at the
 * base commit. Only `<stem>.prompt.md`, `<stem>.answer.md` and a short-lived
 * `<stem>.lock` are written, inside the briefs directory. A repeat returns the
 * recorded answer; concurrent callers serialize on the lock so the seat runs
 * exactly once.
 * Results carry codes only: never a path, the answer or a secret.
 */

import { randomUUID } from 'node:crypto';
import fsSync, { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AuthoredBriefRequest,
  AuthoredBriefResult,
  BriefAuthoringPort,
  BriefAuthorSessionRequest,
  BriefAuthorSessionResult,
  BriefAuthorSessionUnavailableReason,
} from '../../application/ports/out/BriefAuthoringPort.out-port.js';
import type { CommandExecutorPort, CommandRunResult } from '../../application/ports/out/CommandExecutorPort.out-port.js';
import { textContainsSecretShape } from '../../domain/brief-answer.js';

export interface BriefAuthoringAdapterOptions {
  /** Reviewed orchestrator prose keyed by work order id. */
  readonly defaultProseByWorkOrder?: Readonly<Record<string, string>>;
  /** Reviewed seat argv template; contains `{promptFile}` exactly once. */
  readonly seatCommand?: readonly string[];
  /** Seat session budget in ms. Default 900 000, hard cap 3 600 000. */
  readonly timeoutMs?: number;
  /** Largest accepted answer in bytes. Default 262 144. */
  readonly maxAnswerBytes?: number;
  /** The command transport for the pinned-commit check and the seat run. */
  readonly executor?: CommandExecutorPort;
}

const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_TIMEOUT_MS = 3_600_000;
/** Room for the seat's stderr inside the executor's stdout+stderr cap. */
const STDERR_HEADROOM_BYTES = 65_536;
const GIT_TIMEOUT_MS = 30_000;
/** Mirrors the fact pack's prompt cap. */
const MAX_PROMPT_BYTES = 300_000;
/** Largest prompt or answer accepted for one seat session, in UTF-8 bytes. */
const MAX_SESSION_BYTES = 256_000;
const MAX_STEM_LENGTH = 120;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/g;
const ALLOWED_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'promptFile', 'model', 'variant', 'agent', 'workOrderId', 'laneId', 'baseCommit',
]);

/** Hardened read-only git prefix: no network, no hooks, no lazy fetch, no replace refs. */
const GIT_ARGV_PREFIX = [
  'env', 'GIT_NO_LAZY_FETCH=1', 'GIT_ALLOW_PROTOCOL=none', 'GIT_TERMINAL_PROMPT=0',
  'GIT_NO_REPLACE_OBJECTS=1', 'GIT_GRAFT_FILE=/nonexistent/fleet-v2-brief-author-no-grafts',
  'git', '--no-replace-objects',
  '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', '-C',
] as const;

const MISSING = Symbol('missing');

const unavailable = (reason: BriefAuthorSessionUnavailableReason): BriefAuthorSessionResult =>
  ({ outcome: 'unavailable', reason });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Read an own data property: never invokes a getter, never reads a prototype field. */
function readOwnData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
    || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return MISSING;
  }
  return descriptor.value;
}

/**
 * Read an optional own property: absent is `undefined`, but an own accessor
 * descriptor is `MISSING` so it can be refused instead of treated as absent.
 */
function readOptionalOwnData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined
    || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return MISSING;
  }
  return descriptor.value;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function hasDotDotSegment(value: string): boolean {
  return value.split(path.sep).some((segment) => segment === '..');
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._@-]/g, '_');
}

/** Substitute placeholders into the template; null when the template or a value is unsafe. */
function renderSeatArgv(
  template: readonly string[],
  values: Readonly<Record<string, string | undefined>>,
): string[] | null {
  if (!Array.isArray(template) || template.length === 0 || template.some((part) => typeof part !== 'string')
    || template[0].includes('{')) {
    return null;
  }
  let promptFileCount = 0;
  const argv: string[] = [];
  for (const part of template) {
    let invalid = false;
    const rendered = part.replace(PLACEHOLDER_PATTERN, (_match: string, name: string) => {
      const value = values[name];
      if (!ALLOWED_PLACEHOLDERS.has(name) || value === undefined || value.length === 0
        || hasControlCharacter(value) || value.startsWith('-')) {
        invalid = true;
        return '';
      }
      if (name === 'promptFile') {
        promptFileCount += 1;
      }
      return value;
    });
    if (invalid || rendered.includes('{') || rendered.includes('}')) {
      return null;
    }
    argv.push(rendered);
  }
  return promptFileCount === 1 ? argv : null;
}

/**
 * Validate the seat command template before it is rendered. Returns a refusal
 * reason when the command is missing or unsafe, and null when it can run.
 */
function validateSessionCommand(
  seatCommand: readonly string[] | undefined,
): 'session-command-missing' | 'session-command-invalid' | null {
  if (seatCommand === undefined || seatCommand.length === 0) {
    return 'session-command-missing';
  }
  // Control characters are refused anywhere in the command, not only in the
  // binary: any literal argv element could reach the seat executor.
  if (seatCommand.some((part) => typeof part !== 'string' || hasControlCharacter(part))) {
    return 'session-command-invalid';
  }
  const binary = seatCommand[0];
  if (typeof binary !== 'string' || binary.length === 0 || hasControlCharacter(binary)
    || !path.isAbsolute(binary) || hasDotDotSegment(binary)) {
    return 'session-command-invalid';
  }
  return null;
}

function resolveTimeout(requested: number | undefined, configured?: number): number {
  const candidate = requested !== undefined ? requested : configured;
  if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(candidate, MAX_TIMEOUT_MS);
}

const DEFAULT_LOCK_MAX_WAIT_MS = 1_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;
export const CROSS_HOST_FACTOR = 6;

export interface LockPayload {
  readonly pid?: number;
  readonly host?: string;
  readonly ts?: number;
  readonly token?: string;
}

export interface LockFsOps {
  writeFileSync(
    filePath: string,
    data: string,
    options?: { readonly encoding?: BufferEncoding; readonly mode?: number; readonly flag?: string },
  ): void;
  readFileSync(filePath: string, encoding: BufferEncoding): string;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(filePath: string): void;
}

export interface AcquireLockOptions {
  readonly now?: number;
  readonly pid?: number;
  readonly currentHost?: string;
  readonly token?: string;
  readonly fsOps?: LockFsOps;
  /** Bound on guard attempts and the pause between them; defaults are for production. */
  readonly guardAttempts?: number;
  readonly guardRetryMs?: number;
}

export type AcquireLockResult =
  | { readonly owned: true; readonly token: string; readonly payload: string }
  | { readonly owned: false };

export function createLockPayload(
  ts: number = Date.now(),
  pid: number | undefined = process.pid,
  host: string | undefined = os.hostname(),
  token: string = randomUUID(),
): string {
  return JSON.stringify({
    ...(pid !== undefined ? { pid } : {}),
    ...(host !== undefined ? { host } : {}),
    ts,
    token,
  });
}

export function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return null;
    }
    const rawPid = readOptionalOwnData(parsed, 'pid');
    const pid = typeof rawPid === 'number' && Number.isSafeInteger(rawPid) && rawPid > 0
      ? rawPid
      : undefined;
    const rawHost = readOptionalOwnData(parsed, 'host');
    const host = typeof rawHost === 'string' && rawHost.trim().length > 0
      ? rawHost.trim()
      : undefined;
    const rawTs = readOptionalOwnData(parsed, 'ts');
    const ts = typeof rawTs === 'number' && Number.isFinite(rawTs)
      ? rawTs
      : undefined;
    const rawToken = readOptionalOwnData(parsed, 'token');
    const token = typeof rawToken === 'string' && rawToken.length > 0
      ? rawToken
      : undefined;
    return { pid, host, ts, token };
  } catch {
    return null;
  }
}

function isPidNotAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

/**
 * STALE(payload): a lock is stale ONLY when BOTH hold:
 * - age = now - payload.ts >= staleAfterMs, AND
 * - the owner is established-not-alive:
 *   * if payload.host === current host AND payload.pid is a number:
 *     not alive iff `process.kill(pid, 0)` throws ESRCH (EPERM means alive).
 *   * otherwise (different host, or pid missing): require the long threshold
 *     `staleAfterMs * CROSS_HOST_FACTOR`.
 */
export function isLockStale(
  payloadOrRaw: LockPayload | string | null,
  staleAfterMs: number,
  now: number = Date.now(),
  currentHost: string = os.hostname(),
): boolean {
  const payload = typeof payloadOrRaw === 'string'
    ? parseLockPayload(payloadOrRaw)
    : payloadOrRaw;
  if (payload === null || typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) {
    return false;
  }
  const age = now - payload.ts;
  if (age < staleAfterMs) {
    return false;
  }
  if (
    payload.host === currentHost &&
    typeof payload.pid === 'number' &&
    Number.isSafeInteger(payload.pid) &&
    payload.pid > 0
  ) {
    return isPidNotAlive(payload.pid);
  }
  return age >= staleAfterMs * CROSS_HOST_FACTOR;
}

// LOCK INVARIANT: no operation creates, deletes or replaces the lock file
// without holding the guard (`<lock>.guard`, an exclusive-create file). Acquire
// (first-time create and stale takeover) and release are each a short
// read-then-write run entirely under the guard; the stale lock is deleted, never
// moved aside or renamed over, so there is no restore step to race. The guard is
// held for a few local file calls only and never across the seat session.
// Ownership is reported only after re-reading the lock and finding the caller's
// own token. Any doubt means "not acquired".

/**
 * Age past which a guard whose holder cannot be shown alive is considered left
 * behind by a dead process. A live holder runs only a handful of local file
 * calls (microseconds to milliseconds, no network or subprocess), so it cannot
 * come near this bound; a same-host holder whose pid is alive is never broken
 * at any age (isLockStale), and a cross-host guard needs six times the bound.
 */
export const GUARD_STALE_AFTER_MS = 10_000;
const GUARD_ATTEMPTS = 20;
const RELEASE_GUARD_ATTEMPTS = 200;
const GUARD_RETRY_MS = 5;

interface GuardTiming {
  readonly now: number;
  readonly pid: number | undefined;
  readonly currentHost: string;
  readonly attempts: number;
  readonly retryMs: number;
}

/** Unlink a file, ignoring every failure. */
function bestEffortUnlink(fsOps: LockFsOps, filePath: string): void {
  try {
    fsOps.unlinkSync(filePath);
  } catch {
    // Nothing more to do for this caller.
  }
}

function readIfPresent(fsOps: LockFsOps, filePath: string): string | null | 'unreadable' {
  try {
    return fsOps.readFileSync(filePath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'unreadable';
  }
}

function pause(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

/**
 * Runs `section` while holding the guard, or returns null when the guard cannot
 * be taken within the bounded retries (never an error, never state left behind).
 * A guard left by a dead holder is removed only when it is stale and still
 * byte-identical to the copy that was judged stale, and acquisition then starts
 * again from the exclusive create; the breaker holds nothing else meanwhile.
 */
function withGuard<T>(
  lockPath: string,
  fsOps: LockFsOps,
  timing: GuardTiming,
  section: () => T,
): { readonly value: T } | null {
  const guardPath = `${lockPath}.guard`;
  const guardToken = randomUUID();
  const guardPayload = createLockPayload(timing.now, timing.pid, timing.currentHost, guardToken);
  for (let attempt = 0; attempt < timing.attempts; attempt += 1) {
    try {
      fsOps.writeFileSync(guardPath, guardPayload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return null;
      }
      const heldRaw = readIfPresent(fsOps, guardPath);
      if (typeof heldRaw === 'string'
        && isLockStale(parseLockPayload(heldRaw), GUARD_STALE_AFTER_MS, timing.now, timing.currentHost)) {
        if (readIfPresent(fsOps, guardPath) === heldRaw) {
          bestEffortUnlink(fsOps, guardPath);
        }
        continue;
      }
      pause(timing.retryMs);
      continue;
    }
    try {
      return { value: section() };
    } finally {
      const current = readIfPresent(fsOps, guardPath);
      if (typeof current === 'string' && parseLockPayload(current)?.token === guardToken) {
        bestEffortUnlink(fsOps, guardPath);
      }
    }
  }
  return null;
}

function guardTiming(options: AcquireLockOptions | undefined, attempts: number): GuardTiming {
  return {
    now: options?.now ?? Date.now(),
    pid: options !== undefined && 'pid' in options ? options.pid : process.pid,
    currentHost: options?.currentHost ?? os.hostname(),
    attempts: options?.guardAttempts ?? attempts,
    retryMs: options?.guardRetryMs ?? GUARD_RETRY_MS,
  };
}

/**
 * ACQUIRE(lockPath), under the guard:
 * - lock absent: create it with `wx`;
 * - lock present and unreadable or not stale: NOT owned;
 * - lock present and stale (age and owner-not-alive per isLockStale): delete it,
 *   then create ours with `wx`.
 * Ownership is reported only after re-reading the lock and finding our token.
 * The guard being unavailable within the bounded retries is NOT owned.
 */
export function acquireLock(
  lockPath: string,
  staleAfterMs: number,
  options?: AcquireLockOptions,
): AcquireLockResult {
  const fsOps: LockFsOps = options?.fsOps ?? fsSync;
  const timing = guardTiming(options, GUARD_ATTEMPTS);
  const myToken = options?.token ?? randomUUID();
  const payload = createLockPayload(timing.now, timing.pid, timing.currentHost, myToken);

  const underGuard = (): AcquireLockResult => {
    const existing = readIfPresent(fsOps, lockPath);
    if (existing === 'unreadable') {
      return { owned: false };
    }
    if (existing !== null) {
      if (!isLockStale(parseLockPayload(existing), staleAfterMs, timing.now, timing.currentHost)) {
        return { owned: false };
      }
      try {
        fsOps.unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          return { owned: false };
        }
      }
    }
    try {
      fsOps.writeFileSync(lockPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      return { owned: false };
    }
    const written = readIfPresent(fsOps, lockPath);
    if (typeof written === 'string' && parseLockPayload(written)?.token === myToken) {
      return { owned: true, token: myToken, payload };
    }
    if (written === 'unreadable') {
      // Only this caller can have created the file while it holds the guard.
      bestEffortUnlink(fsOps, lockPath);
    }
    return { owned: false };
  };

  return withGuard(lockPath, fsOps, timing, underGuard)?.value ?? { owned: false };
}

/**
 * RELEASE(lockPath, token), under the guard: delete the lock only while it still
 * carries `token`; otherwise leave it. Returns whether this call deleted it.
 */
export function releaseLock(
  lockPath: string,
  token: string,
  options?: AcquireLockOptions,
): boolean {
  const fsOps: LockFsOps = options?.fsOps ?? fsSync;
  const timing = guardTiming(options, RELEASE_GUARD_ATTEMPTS);
  const underGuard = (): boolean => {
    const current = readIfPresent(fsOps, lockPath);
    if (typeof current !== 'string' || parseLockPayload(current)?.token !== token) {
      return false;
    }
    try {
      fsOps.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  };
  return withGuard(lockPath, fsOps, timing, underGuard)?.value ?? false;
}

async function withSessionLock<T>(
  lockPath: string,
  staleAfterMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const maxWaitMs = Math.min(
    DEFAULT_LOCK_MAX_WAIT_MS,
    Math.max(DEFAULT_LOCK_POLL_INTERVAL_MS * 2, staleAfterMs),
  );
  const deadline = Date.now() + maxWaitMs;
  let ownedToken: string;

  for (;;) {
    const stat = await fs.lstat(lockPath).catch(() => null);
    if (stat !== null && (stat.isSymbolicLink() || !stat.isFile())) {
      throw new Error('Lock path is not a regular file');
    }
    const acquired = acquireLock(lockPath, staleAfterMs);
    if (acquired.owned) {
      ownedToken = acquired.token;
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for session lock');
    }
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_LOCK_POLL_INTERVAL_MS));
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockPath, ownedToken);
  }
}

/** The safe file stem for a valid request, or null; the key must match the ids and commit. */
function sessionStem(request: BriefAuthorSessionRequest): string | null {
  const { sessionKey, workOrderId, laneId, baseCommit, checkoutPath, briefsDir, prompt, model } = request;
  if (![sessionKey, workOrderId, laneId, checkoutPath, briefsDir, prompt, model].every(isNonEmpty)
    || !COMMIT_PATTERN.test(baseCommit) || !path.isAbsolute(briefsDir)
    || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES
    || sessionKey !== `brief-author/${workOrderId}/${laneId}@${baseCommit.slice(0, 12)}`) {
    return null;
  }
  const stem = `brief-author__${safeSegment(workOrderId)}__${safeSegment(laneId)}@${baseCommit.slice(0, 12)}`;
  return stem.length > MAX_STEM_LENGTH ? null : stem;
}

/** True when the path is a symlink; a link may point outside the briefs directory. */
async function isSymbolicLink(filePath: string): Promise<boolean> {
  return fs.lstat(filePath).then((stat) => stat.isSymbolicLink(), () => false);
}

/**
 * Read a regular file without following a symlink at the final component. The
 * open itself refuses a link (O_NOFOLLOW), so a link planted between an earlier
 * lstat and this read cannot redirect the read outside the briefs directory.
 */
async function readFileNoFollow(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Create or truncate a file for writing; the open refuses a symlink at the final component (O_NOFOLLOW). */
async function writeFileNoFollow(filePath: string, data: string): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    await handle.writeFile(data, 'utf8');
  } finally {
    await handle.close();
  }
}

/**
 * True when the briefs directory is a safe absolute path: no dot-dot segment,
 * and every existing component is a real directory, never a symlink. The first
 * missing component ends the walk because nothing below it exists yet. The
 * directory is created if it does not exist. Each component is inspected with
 * lstat from the root down and never followed.
 */
async function ensureSafeDirectory(briefsDir: string): Promise<boolean> {
  if (!path.isAbsolute(briefsDir) || hasDotDotSegment(briefsDir)) {
    return false;
  }
  const segments = briefsDir.split(path.sep).filter((segment) => segment.length > 0);
  let current = path.parse(briefsDir).root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return false;
      }
      break;
    }
  }
  try {
    await fs.mkdir(briefsDir, { recursive: true });
  } catch {
    return false;
  }
  return true;
}

/**
 * The recorded answer, `null` when none exists (ENOENT), `'unreadable'` when a
 * path is present at `answerPath` but cannot be read or is empty/non-regular,
 * or `'too-large'` when the recorded answer exceeds the answer limit. The
 * caller separately refuses a symlinked answer file, which may point outside the
 * briefs directory.
 */
async function readRecordedAnswer(
  answerPath: string,
  maxAnswerBytes: number,
): Promise<string | null | 'too-large' | 'unreadable'> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(answerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return 'unreadable';
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return 'unreadable';
  }
  let text: string;
  try {
    text = await readFileNoFollow(answerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    return 'unreadable';
  }
  if (text.trim().length === 0) {
    return 'unreadable';
  }
  return Buffer.byteLength(text, 'utf8') > maxAnswerBytes ? 'too-large' : text;
}

/** Write the answer and read it back; a failed record is removed so it is never reused. */
async function recordAnswer(answerPath: string, answer: string): Promise<boolean> {
  if (await isSymbolicLink(answerPath)) {
    return false;
  }
  const recorded = await writeFileNoFollow(answerPath, answer)
    .then(() => readFileNoFollow(answerPath))
    .then((text) => text === answer, () => false);
  if (!recorded) {
    await fs.rm(answerPath, { force: true }).catch(() => undefined);
  }
  return recorded;
}

interface SessionFields {
  readonly workOrderId: string;
  readonly laneId: string;
  readonly checkoutPath: string;
  readonly briefsDir: string;
  readonly baseCommit: string;
  readonly prompt: string;
  readonly model: string;
  readonly sessionKey: string;
  readonly variant: string | undefined;
  readonly agent: string | undefined;
  readonly timeoutMs: number | undefined;
}

interface SeatPlan {
  readonly fields: SessionFields;
  readonly argv: readonly string[];
  readonly timeout: number;
  readonly maxAnswerBytes: number;
  readonly answerPath: string;
  readonly promptPath: string;
}

type ParsedSession =
  | { readonly fields: SessionFields }
  | { readonly refusal: BriefAuthorSessionResult };

/** Reads the request through own data descriptors and refuses anything malformed, before any I/O. */
function parseSessionFields(request: BriefAuthorSessionRequest): ParsedSession {
  const refuse = (reason: Parameters<typeof unavailable>[0]): ParsedSession => ({ refusal: unavailable(reason) });
  // A non-plain object or any accessor is refused before any field is read.
  if (!isPlainObject(request)) {
    return refuse('session-command-invalid');
  }
  const record = request as Record<string, unknown>;
  const workOrderId = readOwnData(record, 'workOrderId');
  const laneId = readOwnData(record, 'laneId');
  const checkoutPath = readOwnData(record, 'checkoutPath');
  const briefsDir = readOwnData(record, 'briefsDir');
  const baseCommit = readOwnData(record, 'baseCommit');
  const prompt = readOwnData(record, 'prompt');
  const model = readOwnData(record, 'model');
  const variant = readOptionalOwnData(record, 'variant');
  const agent = readOptionalOwnData(record, 'agent');
  const sessionKey = readOwnData(record, 'sessionKey');
  const timeoutMs = readOwnData(record, 'timeoutMs');

  for (const field of [workOrderId, laneId, checkoutPath, briefsDir, baseCommit, prompt, model, sessionKey]) {
    if (field === MISSING || typeof field !== 'string') {
      return refuse('session-command-invalid');
    }
  }

  // Commit and ids: a malformed commit or id is not pinned to a known revision.
  if (!COMMIT_PATTERN.test(baseCommit as string)
    || !SAFE_ID_PATTERN.test(workOrderId as string) || workOrderId === '.' || workOrderId === '..'
    || !SAFE_ID_PATTERN.test(laneId as string) || laneId === '.' || laneId === '..') {
    return refuse('checkout-not-pinned');
  }

  // Checkout path: absolute, no dot-dot, no control characters.
  if (hasControlCharacter(checkoutPath as string)
    || !path.isAbsolute(checkoutPath as string)
    || hasDotDotSegment(checkoutPath as string)) {
    return refuse('checkout-unreadable');
  }

  // Briefs directory: no control characters, absolute, no dot-dot.
  // The directory walk is verified later via ensureSafeDirectory.
  if (hasControlCharacter(briefsDir as string)
    || !path.isAbsolute(briefsDir as string)
    || hasDotDotSegment(briefsDir as string)) {
    return refuse('briefs-dir-invalid');
  }

  // Prompt and model (and optional variant/agent).
  if ((prompt as string).trim().length === 0) {
    return refuse('session-empty');
  }
  if (Buffer.byteLength(prompt as string, 'utf8') > MAX_SESSION_BYTES) {
    return refuse('session-oversized');
  }
  if (hasControlCharacter(model as string) || (model as string).trim().length === 0) {
    return refuse('session-command-invalid');
  }
  for (const optional of [variant, agent]) {
    // An own accessor descriptor reads as MISSING here: it must be refused,
    // never silently treated as an absent optional field.
    if (optional === undefined) {
      continue;
    }
    if (optional === MISSING || typeof optional !== 'string' || hasControlCharacter(optional)
      || optional.trim().length === 0) {
      return refuse('session-command-invalid');
    }
  }

  return {
    fields: {
      workOrderId: workOrderId as string, laneId: laneId as string, checkoutPath: checkoutPath as string,
      briefsDir: briefsDir as string, baseCommit: baseCommit as string, prompt: prompt as string,
      model: model as string, sessionKey: sessionKey as string,
      variant: variant === MISSING || variant === undefined ? undefined : (variant as string),
      agent: agent === MISSING || agent === undefined ? undefined : (agent as string),
      timeoutMs: timeoutMs === MISSING || timeoutMs === undefined ? undefined : (timeoutMs as number),
    },
  };
}

/** The replayed result for a recorded answer, a refusal for an unusable one, or null when none is recorded. */
async function replayRecordedAnswer(
  answerPath: string,
  maxAnswerBytes: number,
  sessionKey: string,
): Promise<BriefAuthorSessionResult | null> {
  if (await isSymbolicLink(answerPath)) {
    return unavailable('briefs-dir-invalid');
  }
  // A present-but-unreadable answer file is refused without running the seat or touching the file.
  const recorded = await readRecordedAnswer(answerPath, maxAnswerBytes);
  if (recorded === 'unreadable') {
    return unavailable('session-failed');
  }
  if (recorded === 'too-large') {
    return unavailable('session-oversized');
  }
  if (recorded !== null) {
    return { outcome: 'answered', rawAnswer: recorded, sessionKey, answerPath, cached: true };
  }
  return null;
}

/**
 * The seat's stdout when it is a usable answer, otherwise the refusal. The raw
 * answer is untrusted text: the secret-shape screen runs here, before anything
 * is persisted, so a secret-shaped answer is never written into the briefs
 * directory and a later attempt runs the seat again.
 */
function acceptedSeatStdout(
  run: CommandRunResult | null,
  maxAnswerBytes: number,
): string | BriefAuthorSessionResult {
  if (run === null || typeof run.exitCode !== 'number' || typeof run.stdout !== 'string') {
    return unavailable('session-failed');
  }
  // A timed-out run is never a success, even when it otherwise carries an exit code, stdout and no error.
  if (run.error !== undefined || run.exitCode !== 0
    || (run as { timedOut?: unknown }).timedOut === true) {
    return unavailable('session-failed');
  }
  if (run.stdout.trim().length === 0) {
    return unavailable('session-empty');
  }
  if (Buffer.byteLength(run.stdout, 'utf8') > maxAnswerBytes) {
    return unavailable('session-oversized');
  }
  if (textContainsSecretShape(run.stdout)) {
    return unavailable('session-failed');
  }
  return run.stdout;
}

export class BriefAuthoringAdapter implements BriefAuthoringPort {
  constructor(private readonly options?: BriefAuthoringAdapterOptions) {}

  async authorBrief(request: AuthoredBriefRequest): Promise<AuthoredBriefResult> {
    if (request.handWrittenBriefPath !== null) {
      let content: string;
      try {
        content = await fs.readFile(request.handWrittenBriefPath, 'utf8');
      } catch {
        return {
          outcome: 'unavailable',
          reason: `Hand-written brief file is missing or unreadable: ${request.handWrittenBriefPath}`,
        };
      }
      if (content.trim() === '') {
        return {
          outcome: 'unavailable',
          reason: `Hand-written brief file is empty: ${request.handWrittenBriefPath}`,
        };
      }
      return {
        outcome: 'authored',
        brief: { proseMarkdown: content, provenance: 'hand-written-file' },
      };
    }

    const orchestratorProse = this.options?.defaultProseByWorkOrder?.[request.workOrderId];
    if (orchestratorProse !== undefined && orchestratorProse.trim() !== '') {
      return {
        outcome: 'authored',
        brief: { proseMarkdown: orchestratorProse, provenance: 'orchestrator' },
      };
    }

    return {
      outcome: 'unavailable',
      reason: 'No hand-written brief path or orchestrator brief provided',
    };
  }

  /**
   * A recorded answer that cannot be read back rejects: the use case reports
   * that as an unavailable outcome, never as an empty brief.
   */
  async authorBriefSession(request: BriefAuthorSessionRequest): Promise<BriefAuthorSessionResult> {
    try {
      return await this.runAuthorBriefSession(request);
    } catch {
      return unavailable('session-failed');
    }
  }

  private async runAuthorBriefSession(request: BriefAuthorSessionRequest): Promise<BriefAuthorSessionResult> {
    const parsed = parseSessionFields(request);
    if ('refusal' in parsed) {
      return parsed.refusal;
    }
    const fields = parsed.fields;
    const stem = sessionStem(request);
    if (stem === null) {
      return unavailable('session-command-invalid');
    }
    if (!(await ensureSafeDirectory(fields.briefsDir))) {
      return unavailable('briefs-dir-invalid');
    }

    const base = path.join(fields.briefsDir, stem);
    const answerPath = `${base}.answer.md`;
    const promptPath = `${base}.prompt.md`;
    // The session cap is absolute: a configured limit above 256 000 bytes is
    // clamped, because an answer over MAX_SESSION_BYTES must be refused
    // regardless of configuration.
    const configuredAnswerBytes = this.options?.maxAnswerBytes;
    const maxAnswerBytes = typeof configuredAnswerBytes === 'number' && Number.isFinite(configuredAnswerBytes)
      && configuredAnswerBytes > 0
      ? Math.min(configuredAnswerBytes, MAX_SESSION_BYTES)
      : MAX_SESSION_BYTES;

    // A symlinked answer is refused before it could redirect the read outside
    // the briefs directory. A completed session then replays without any seat
    // configuration, executor or checkout check.
    const replay = await replayRecordedAnswer(answerPath, maxAnswerBytes, fields.sessionKey);
    if (replay !== null) {
      return replay;
    }

    const { seatCommand, executor } = this.options ?? {};
    const commandError = validateSessionCommand(seatCommand);
    if (commandError !== null) {
      return unavailable(commandError);
    }
    if (executor === undefined) {
      return unavailable('session-command-missing');
    }

    const argv = renderSeatArgv(seatCommand as readonly string[], {
      promptFile: promptPath, model: fields.model,
      variant: fields.variant, agent: fields.agent,
      workOrderId: fields.workOrderId, laneId: fields.laneId, baseCommit: fields.baseCommit,
    });
    if (argv === null) {
      return unavailable('session-command-invalid');
    }

    const timeout = resolveTimeout(fields.timeoutMs, this.options?.timeoutMs);
    // The session lock serializes concurrent callers for the same stem, so the
    // seat runs at most once and a caller that waits past the default lock
    // budget refuses instead of also running the seat. Only the prompt, answer
    // and lock files are ever written inside the briefs directory — never an
    // intent file.
    const lockPath = `${base}.lock`;
    // A planted symlink at the lock path is refused without attempting the
    // lock: the open could never create a real lock file through it anyway.
    if (await isSymbolicLink(lockPath)) {
      return unavailable('briefs-dir-invalid');
    }
    return withSessionLock<BriefAuthorSessionResult>(
      lockPath,
      timeout,
      () => this.runSeatUnderLock(request, executor, { fields, argv, timeout, maxAnswerBytes, answerPath, promptPath }),
    )
      .catch(() => unavailable('session-failed'));
  }

  /** The seat run itself, executed only while this caller holds the session lock. */
  private async runSeatUnderLock(
    request: BriefAuthorSessionRequest,
    executor: CommandExecutorPort,
    plan: SeatPlan,
  ): Promise<BriefAuthorSessionResult> {
    const { fields, argv, timeout, maxAnswerBytes, answerPath, promptPath } = plan;
    // A concurrent call may have completed the session while this one waited.
    const replay = await replayRecordedAnswer(answerPath, maxAnswerBytes, fields.sessionKey);
    if (replay !== null) {
      return replay;
    }

    const pinned = await this.checkPinnedCheckout(executor, request);
    if (pinned !== null) {
      return unavailable(pinned);
    }

    if (await isSymbolicLink(promptPath)) {
      return unavailable('briefs-dir-invalid');
    }
    if (!(await writeFileNoFollow(promptPath, fields.prompt).then(() => true, () => false))) {
      return unavailable('session-failed');
    }

    const run = await executor.run(argv, {
      cwd: fields.checkoutPath,
      timeoutMs: timeout,
      maxBufferBytes: maxAnswerBytes + STDERR_HEADROOM_BYTES,
    }).catch(() => null);
    const stdout = acceptedSeatStdout(run, maxAnswerBytes);
    if (typeof stdout !== 'string') {
      return stdout;
    }
    return (await recordAnswer(answerPath, stdout))
      ? { outcome: 'answered', rawAnswer: stdout, sessionKey: fields.sessionKey, answerPath, cached: false }
      : unavailable('session-failed');
  }

  /** One read-only git call: null when the checkout exists and is at the base commit. */
  private async checkPinnedCheckout(
    executor: CommandExecutorPort,
    request: BriefAuthorSessionRequest,
  ): Promise<'checkout-unreadable' | 'checkout-not-pinned' | null> {
    const stat = await fs.lstat(request.checkoutPath).catch(() => null);
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) {
      return 'checkout-unreadable';
    }
    const head = await executor.run(
      [...GIT_ARGV_PREFIX, request.checkoutPath, 'rev-parse', '--verify', 'HEAD'],
      { cwd: request.checkoutPath, timeoutMs: GIT_TIMEOUT_MS },
    ).catch(() => null);
    if (head === null || typeof head.exitCode !== 'number' || typeof head.stdout !== 'string') {
      return 'checkout-unreadable';
    }
    if (head.error !== undefined || head.exitCode !== 0 || head.stdout.trim() !== request.baseCommit) {
      return 'checkout-not-pinned';
    }
    return null;
  }
}
