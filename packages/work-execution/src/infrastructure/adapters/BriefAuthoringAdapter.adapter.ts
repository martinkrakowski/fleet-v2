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

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  AuthoredBriefRequest,
  AuthoredBriefResult,
  BriefAuthoringPort,
  BriefAuthorSessionRequest,
  BriefAuthorSessionResult,
  BriefAuthorSessionUnavailableReason,
} from '../../application/ports/out/BriefAuthoringPort.out-port.js';
import type { CommandExecutorPort } from '../../application/ports/out/CommandExecutorPort.out-port.js';

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

const DEFAULT_LOCK_MAX_WAIT_MS = 15_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 25;
const UNPARSEABLE_LOCK_GRACE_MS = 50;

interface ParsedLockMetadata {
  readonly pid: number | undefined;
  readonly time: number | undefined;
  readonly expiresAt: number | undefined;
}

function parseLockMetadata(raw: string): ParsedLockMetadata {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { pid: undefined, time: undefined, expiresAt: undefined };
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isPlainObject(parsed)) {
        const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : undefined;
        const rawTime = typeof parsed.time === 'number'
          ? parsed.time
          : typeof parsed.timestamp === 'number'
            ? parsed.timestamp
            : typeof parsed.createdAt === 'number'
              ? parsed.createdAt
              : undefined;
        const time = rawTime !== undefined && Number.isFinite(rawTime) ? rawTime : undefined;
        const expiresAt = typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)
          ? parsed.expiresAt
          : undefined;
        return { pid, time, expiresAt };
      }
    } catch {
      return { pid: undefined, time: undefined, expiresAt: undefined };
    }
  }
  const tokenMatch = /^(\d+)-[0-9a-fA-F]+-(\d+)$/.exec(trimmed);
  if (tokenMatch !== null) {
    const pid = Number(tokenMatch[1]);
    const time = Number(tokenMatch[2]);
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
      time: Number.isFinite(time) ? time : undefined,
      expiresAt: undefined,
    };
  }
  const pairMatch = /^(\d+):(\d+)$/.exec(trimmed);
  if (pairMatch !== null) {
    const pid = Number(pairMatch[1]);
    const time = Number(pairMatch[2]);
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
      time: Number.isFinite(time) ? time : undefined,
      expiresAt: undefined,
    };
  }
  const pidOnlyMatch = /^(\d+)$/.exec(trimmed);
  if (pidOnlyMatch !== null) {
    const pid = Number(pidOnlyMatch[1]);
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
      time: undefined,
      expiresAt: undefined,
    };
  }
  return { pid: undefined, time: undefined, expiresAt: undefined };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

function isLockStale(
  raw: string,
  stat: { readonly mtimeMs: number },
  staleAfterMs: number,
  now: number,
): boolean {
  const { pid, time, expiresAt } = parseLockMetadata(raw);
  if (expiresAt !== undefined && now >= expiresAt) {
    return true;
  }
  const timestampAge = time !== undefined ? Math.max(0, now - time) : 0;
  const mtimeAge = Math.max(0, now - stat.mtimeMs);
  const ageMs = Math.max(timestampAge, mtimeAge);
  if (ageMs >= staleAfterMs) {
    return true;
  }
  if (pid !== undefined) {
    return !isProcessAlive(pid);
  }
  return ageMs >= UNPARSEABLE_LOCK_GRACE_MS;
}

/**
 * Atomically replace a verified stale lock file by writing our token to a
 * private sibling file, re-verifying the stale lock's inode and content,
 * renaming over the lock path, and confirming ownership after one poll window.
 */
async function tryReclaimStaleLock(
  lockPath: string,
  token: string,
  expectedIno: number,
  expectedContent: string,
  pollIntervalMs: number,
): Promise<boolean> {
  const tempPath = `${lockPath}.${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  try {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    const handle = await fs.open(tempPath, flags, 0o600);
    try {
      await handle.writeFile(token, 'utf8');
    } finally {
      await handle.close();
    }

    const currentStat = await fs.lstat(lockPath).catch(() => null);
    if (currentStat === null || currentStat.isSymbolicLink() || !currentStat.isFile()
      || currentStat.ino !== expectedIno) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      return false;
    }
    const currentContent = await readFileNoFollow(lockPath).catch(() => null);
    if (currentContent === null || currentContent !== expectedContent) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      return false;
    }

    await fs.rename(tempPath, lockPath);
  } catch {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    return false;
  }

  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  const verified = await readFileNoFollow(lockPath).catch(() => null);
  return verified !== null && verified.trim() === token;
}

async function withSessionLock<T>(
  lockPath: string,
  staleAfterMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let token = `${process.pid}-${randomBytes(8).toString('hex')}-${Date.now()}`;
  const deadline = Date.now() + DEFAULT_LOCK_MAX_WAIT_MS;

  for (;;) {
    try {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
      const handle = await fs.open(lockPath, flags, 0o600);
      try {
        await handle.writeFile(token, 'utf8');
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        throw error;
      }
      const stat = await fs.lstat(lockPath).catch(() => null);
      if (stat === null) {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('Lock path is not a regular file');
      }
      const raw = await readFileNoFollow(lockPath).catch(() => null);
      if (raw !== null && isLockStale(raw, stat, staleAfterMs, Date.now())) {
        token = `${process.pid}-${randomBytes(8).toString('hex')}-${Date.now()}`;
        const reclaimed = await tryReclaimStaleLock(
          lockPath,
          token,
          stat.ino,
          raw,
          DEFAULT_LOCK_POLL_INTERVAL_MS,
        );
        if (reclaimed) {
          break;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for session lock');
      }
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_LOCK_POLL_INTERVAL_MS));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await readFileNoFollow(lockPath);
      if (current.trim() === token) {
        await fs.unlink(lockPath);
      }
    } catch {
      // Lock already removed or replaced after timeout.
    }
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
    // The whole request is inspected through own data descriptors: a non-plain
    // object or any accessor is refused before any field is read.
    if (!isPlainObject(request)) {
      return unavailable('session-command-invalid');
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
        return unavailable('session-command-invalid');
      }
    }

    // Commit and ids: a malformed commit or id is not pinned to a known revision.
    if (!COMMIT_PATTERN.test(baseCommit as string)
      || !SAFE_ID_PATTERN.test(workOrderId as string) || workOrderId === '.' || workOrderId === '..'
      || !SAFE_ID_PATTERN.test(laneId as string) || laneId === '.' || laneId === '..') {
      return unavailable('checkout-not-pinned');
    }

    // Checkout path: absolute, no dot-dot, no control characters.
    if (hasControlCharacter(checkoutPath as string)
      || !path.isAbsolute(checkoutPath as string)
      || hasDotDotSegment(checkoutPath as string)) {
      return unavailable('checkout-unreadable');
    }

    // Briefs directory: non-empty, no control characters, absolute, no dot-dot.
    // The directory walk is verified later via ensureSafeDirectory.
    if (hasControlCharacter(briefsDir as string)
      || !path.isAbsolute(briefsDir as string)
      || hasDotDotSegment(briefsDir as string)) {
      return unavailable('briefs-dir-invalid');
    }

    // Prompt and model (and optional variant/agent).
    if ((prompt as string).trim().length === 0) {
      return unavailable('session-empty');
    }
    if (Buffer.byteLength(prompt as string, 'utf8') > MAX_SESSION_BYTES) {
      return unavailable('session-oversized');
    }
    if (hasControlCharacter(model as string) || (model as string).trim().length === 0) {
      return unavailable('session-command-invalid');
    }
    for (const optional of [variant, agent]) {
      // An own accessor descriptor reads as MISSING here: it must be refused,
      // never silently treated as an absent optional field.
      if (optional === undefined) {
        continue;
      }
      if (optional === MISSING || typeof optional !== 'string' || hasControlCharacter(optional)
        || optional.trim().length === 0) {
        return unavailable('session-command-invalid');
      }
    }

    const stem = sessionStem(request);
    if (stem === null) {
      return unavailable('session-command-invalid');
    }
    if (!(await ensureSafeDirectory(briefsDir as string))) {
      return unavailable('briefs-dir-invalid');
    }

    const base = path.join(briefsDir as string, stem);
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
    // the briefs directory.
    if (await isSymbolicLink(answerPath)) {
      return unavailable('briefs-dir-invalid');
    }
    // Recorded outcome first: a completed session replays without any seat
    // configuration, executor or checkout check. A present-but-unreadable
    // answer file is refused without running the seat or touching the file.
    const recorded = await readRecordedAnswer(answerPath, maxAnswerBytes);
    if (recorded === 'unreadable') {
      return unavailable('session-failed');
    }
    if (recorded === 'too-large') {
      return unavailable('session-oversized');
    }
    if (recorded !== null) {
      return { outcome: 'answered', rawAnswer: recorded, sessionKey: sessionKey as string, answerPath, cached: true };
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
      promptFile: promptPath, model: model as string,
      variant: variant === MISSING || variant === undefined ? undefined : (variant as string),
      agent: agent === MISSING || agent === undefined ? undefined : (agent as string),
      workOrderId: workOrderId as string, laneId: laneId as string, baseCommit: baseCommit as string,
    });
    if (argv === null) {
      return unavailable('session-command-invalid');
    }

    const timeout = resolveTimeout(
      timeoutMs === MISSING || timeoutMs === undefined ? undefined : (timeoutMs as number),
      this.options?.timeoutMs,
    );
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
      async () => {
        if (await isSymbolicLink(answerPath)) {
          return unavailable('briefs-dir-invalid');
        }
        // A concurrent call may have completed the session while this one waited.
        const recordedUnderLock = await readRecordedAnswer(answerPath, maxAnswerBytes);
        if (recordedUnderLock === 'unreadable') {
          return unavailable('session-failed');
        }
        if (recordedUnderLock === 'too-large') {
          return unavailable('session-oversized');
        }
        if (recordedUnderLock !== null) {
          return { outcome: 'answered', rawAnswer: recordedUnderLock, sessionKey: sessionKey as string, answerPath, cached: true };
        }

        const pinned = await this.checkPinnedCheckout(executor, request);
        if (pinned !== null) {
          return unavailable(pinned);
        }

        if (await isSymbolicLink(promptPath)) {
          return unavailable('briefs-dir-invalid');
        }
        if (!(await writeFileNoFollow(promptPath, prompt as string).then(() => true, () => false))) {
          return unavailable('session-failed');
        }

        const run = await executor.run(argv, {
          cwd: checkoutPath as string,
          timeoutMs: timeout,
          maxBufferBytes: maxAnswerBytes + STDERR_HEADROOM_BYTES,
        }).catch(() => null);
        if (run === null || typeof run.exitCode !== 'number' || typeof run.stdout !== 'string') {
          return unavailable('session-failed');
        }
        // A timed-out run is never a success, even when it otherwise carries an
        // exit code, stdout and no error.
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
        return (await recordAnswer(answerPath, run.stdout))
          ? { outcome: 'answered', rawAnswer: run.stdout, sessionKey: sessionKey as string, answerPath, cached: false }
          : unavailable('session-failed');
      },
    )
      .catch(() => unavailable('session-failed'));
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
