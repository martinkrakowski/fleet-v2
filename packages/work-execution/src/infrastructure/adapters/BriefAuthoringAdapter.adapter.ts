// @generated adapter scaffold — implemented for migration step 2 (hand-written file or orchestrator prose).
/**
 * BriefAuthoringAdapter implements BriefAuthoringPort. It reads a hand-written
 * brief file when one is provided, falls back to orchestrator prose registered
 * per work order, and reports absence explicitly. No provider inference and no
 * synthesis happen here.
 *
 * Lane CO17 adds `authorBriefSession`: one read-only seat session per brief, an
 * argv array through the executor (never a shell) in a checkout pinned at the
 * base commit. Only `<stem>.intent.json`, `.prompt.md` and `.answer.md` are
 * written, inside the briefs directory. A repeat returns the recorded answer;
 * a cut-short session leaves its intent and no answer, so the next call re-runs.
 * Results carry codes only: never a path, the answer or a secret.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  AuthoredBriefRequest,
  AuthoredBriefResult,
  BriefAuthoringPort,
  BriefAuthorSessionRequest,
  BriefAuthorSessionResult,
  BriefAuthorSessionUnavailable,
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
const DEFAULT_MAX_ANSWER_BYTES = 262_144;
/** Room for the seat's stderr inside the executor's stdout+stderr cap. */
const STDERR_HEADROOM_BYTES = 65_536;
const GIT_TIMEOUT_MS = 30_000;
/** Mirrors the fact pack's prompt cap. */
const MAX_PROMPT_BYTES = 300_000;
const MAX_STEM_LENGTH = 120;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
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

const unavailable = (reason: BriefAuthorSessionUnavailable): BriefAuthorSessionResult =>
  ({ outcome: 'unavailable', reason });

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

function resolveTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_TIMEOUT_MS);
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

/** The recorded answer, or null when none exists; rejects when it exists but cannot be read. */
async function readRecordedAnswer(answerPath: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(answerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return null;
    }
    throw new Error('recorded brief answer is unreadable');
  }
  if (text.trim().length === 0) {
    throw new Error('recorded brief answer is unreadable');
  }
  return text;
}

/** Write the answer and read it back; a failed record is removed so it is never reused. */
async function recordAnswer(answerPath: string, answer: string): Promise<boolean> {
  const recorded = await fs.writeFile(answerPath, answer, 'utf8')
    .then(() => fs.readFile(answerPath, 'utf8'))
    .then((text) => text === answer, () => false);
  if (!recorded) {
    await fs.rm(answerPath, { force: true }).catch(() => undefined);
  }
  return recorded;
}

/** Write the intent file once; an existing one is the record of an earlier, unfinished session. */
async function recordIntent(briefsDir: string, intentPath: string, sessionKey: string): Promise<boolean> {
  try {
    await fs.mkdir(briefsDir, { recursive: true });
    const intent = JSON.stringify({ sessionKey, startedAt: new Date().toISOString() });
    await fs.writeFile(intentPath, `${intent}\n`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST';
  }
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
   * that as an unknown outcome, never as an empty brief.
   */
  async authorBriefSession(request: BriefAuthorSessionRequest): Promise<BriefAuthorSessionResult> {
    const { seatCommand, executor } = this.options ?? {};
    if (seatCommand === undefined || executor === undefined) {
      return unavailable('seat-command-not-configured');
    }
    const stem = sessionStem(request);
    if (stem === null) {
      return unavailable('session-command-invalid');
    }
    const base = path.join(request.briefsDir, stem);
    const answerPath = `${base}.answer.md`;
    const recorded = await readRecordedAnswer(answerPath);
    if (recorded !== null) {
      return { outcome: 'answered', answer: recorded };
    }
    const promptPath = `${base}.prompt.md`;
    const argv = renderSeatArgv(seatCommand, {
      promptFile: promptPath, model: request.model, variant: request.variant, agent: request.agent,
      workOrderId: request.workOrderId, laneId: request.laneId, baseCommit: request.baseCommit,
    });
    if (argv === null) return unavailable('session-command-invalid');
    if (!(await recordIntent(request.briefsDir, `${base}.intent.json`, request.sessionKey))) {
      return unavailable('session-failed');
    }
    const pinned = await this.checkPinnedCheckout(executor, request);
    if (pinned !== null) return unavailable(pinned);
    if (!(await fs.writeFile(promptPath, request.prompt, 'utf8').then(() => true, () => false))) {
      return unavailable('session-failed');
    }
    const maxAnswerBytes = this.options?.maxAnswerBytes ?? DEFAULT_MAX_ANSWER_BYTES;
    const run = await executor.run(argv, {
      cwd: request.checkoutPath,
      timeoutMs: resolveTimeout(request.timeoutMs ?? this.options?.timeoutMs),
      maxBufferBytes: maxAnswerBytes + STDERR_HEADROOM_BYTES,
    }).catch(() => null);
    if (run === null || (run.error === undefined && run.exitCode !== 0)) {
      return unavailable('session-failed');
    }
    if (run.error !== undefined) {
      return unavailable(/timeout|maxBufferBytes/.test(run.error) ? 'session-timeout' : 'session-failed');
    }
    if (run.stdout.trim().length === 0) {
      return unavailable('session-empty');
    }
    if (Buffer.byteLength(run.stdout, 'utf8') > maxAnswerBytes) {
      return unavailable('session-output-too-large');
    }
    return (await recordAnswer(answerPath, run.stdout))
      ? { outcome: 'answered', answer: run.stdout }
      : unavailable('session-failed');
  }

  /** One read-only git call: null when the checkout exists and is at the base commit. */
  private async checkPinnedCheckout(
    executor: CommandExecutorPort,
    request: BriefAuthorSessionRequest,
  ): Promise<'checkout-unavailable' | 'checkout-not-pinned' | null> {
    const stat = await fs.stat(request.checkoutPath).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      return 'checkout-unavailable';
    }
    const head = await executor.run(
      [...GIT_ARGV_PREFIX, request.checkoutPath, 'rev-parse', 'HEAD'],
      { cwd: request.checkoutPath, timeoutMs: GIT_TIMEOUT_MS },
    ).catch(() => null);
    if (head === null || head.error !== undefined || head.exitCode !== 0
      || head.stdout.trim() !== request.baseCommit) {
      return 'checkout-not-pinned';
    }
    return null;
  }
}
