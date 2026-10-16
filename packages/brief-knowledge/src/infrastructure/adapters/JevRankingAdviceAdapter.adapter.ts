// Implemented for lane D2 (decision port plan, 2026-10-16).
/**
 * JevRankingAdviceAdapter implements KnowledgeRankingAdvicePort against
 * TypeSafe Jev via OpenRouter `POST /api/alpha/decisions` (model
 * `typesafe/jev-1.14` or its revisions). Advisory only: on any failure it
 * answers `unknown/<reason>` and the consumer keeps today's deterministic
 * behaviour.
 *
 * Transport hygiene: the key is read by the injected `readKey` (default
 * `readKeyFile`, which requires O_NOFOLLOW, a regular file and mode
 * `& 0o077 === 0`, mirroring WavesHttpClient — re-implemented here, never
 * imported across contexts). One attempt with an AbortController timeout
 * (default 3 s). Non-2xx → `transport`; abort → `timeout`; response text over
 * 64 KiB or unparsable JSON → `shape`; then the strict score validator.
 * Authorization, request bodies and response bodies never appear in thrown
 * errors or returned values.
 *
 * Receipt: the port result type carries no request id or cost, so the per-call
 * receipt (`requestId`, `costUsd`, `servedModel`, `stateSha256`) is exposed on
 * the `lastReceipt` getter for the D4/D5 receipt journal to append after each
 * call; it is `null` until an advised call completes.
 */

import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type {
  AdviseRankingQuery,
  KnowledgeRankingAdvicePort,
  RankingAdvice,
} from '../../application/ports/out/KnowledgeRankingAdvicePort.out-port.js';
import {
  DEFAULT_DECISION_LEVELS,
  validateScoreAnswers,
} from './jev-advice-validator.js';
import {
  buildRankingAdviceState,
  type RankingAdviceStateBuilt,
} from './jev-advice-state.js';

const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_JEV_TIMEOUT_MS = 3000;
/** Response bodies at or beyond this size are refused as a shape failure. */
const MAX_RESPONSE_TEXT_CHARS = 64 * 1024;

export interface JevRankingAdviceAdapterDependencies {
  /** Jev model id sent with every request, e.g. `typesafe/jev-1.14`. */
  readonly model: string;
  /** Path of the mode-600 key file, read at call time by `readKey`. */
  readonly keyFile: string;
  /** Lowest acceptable per-answer confidence. */
  readonly minConfidence: number;
  /** Projects that never get decision calls; they answer not-configured. */
  readonly disabledProjects?: readonly string[];
  /** Injected transport; no default network call happens without it. */
  readonly fetch: typeof fetch;
  /** Injected key reader; defaults to `readKeyFile`. */
  readonly readKey?: (path: string) => Promise<string>;
  readonly timeoutMs?: number;
}

/** Per-call receipt for the D4/D5 decision receipt journal. */
export interface JevDecisionReceipt {
  readonly requestId: string;
  readonly costUsd: number;
  /** Served model id as reported; recorded, never trusted. */
  readonly servedModel: string;
  readonly stateSha256: string;
}

/**
 * Default key reader: opens with O_NOFOLLOW, requires a regular file with
 * mode `& 0o077 === 0`, trims and rejects empty. Errors never include the key
 * or any file content. Modelled on WavesHttpClient's readToken; re-implemented
 * here because context adapters do not import across contexts.
 */
export async function readKeyFile(path: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isEloop(error)) {
      throw new Error(`Decision key file at ${path} must be a regular file, not a symlink`);
    }
    throw new Error(`Decision key file inaccessible at ${path}: ${errorMessage(error)}`);
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Decision key file at ${path} must be a regular file`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `Decision key file at ${path} has invalid mode 0o${(stat.mode & 0o777).toString(8)}; group and other permissions must be 0`,
      );
    }
    const raw = await handle.readFile('utf8');
    const key = raw.trim();
    if (key.length === 0) {
      throw new Error(`Decision key file at ${path} is empty`);
    }
    return key;
  } finally {
    await handle.close();
  }
}

function isEloop(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ELOOP'
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class JevRankingAdviceAdapter implements KnowledgeRankingAdvicePort {
  private readonly model: string;
  private readonly keyFile: string;
  private readonly minConfidence: number;
  private readonly disabledProjects: readonly string[];
  private readonly fetchFn: typeof fetch;
  private readonly readKey: (path: string) => Promise<string>;
  private readonly timeoutMs: number;
  private lastReceiptValue: JevDecisionReceipt | null = null;

  constructor(deps: JevRankingAdviceAdapterDependencies) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('JevRankingAdviceAdapter requires dependencies');
    }
    if (typeof deps.model !== 'string' || deps.model.length === 0) {
      throw new Error('JevRankingAdviceAdapter requires a model id');
    }
    if (typeof deps.keyFile !== 'string' || deps.keyFile.length === 0) {
      throw new Error('JevRankingAdviceAdapter requires a keyFile path');
    }
    if (!Number.isFinite(deps.minConfidence)) {
      throw new Error('JevRankingAdviceAdapter requires a finite minConfidence');
    }
    if (typeof deps.fetch !== 'function') {
      throw new Error('JevRankingAdviceAdapter requires an injected fetch');
    }
    this.model = deps.model;
    this.keyFile = deps.keyFile;
    this.minConfidence = deps.minConfidence;
    this.disabledProjects = deps.disabledProjects ?? [];
    this.fetchFn = deps.fetch;
    this.readKey = deps.readKey ?? readKeyFile;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  }

  /** Receipt of the last advised call, for the decision receipt journal. */
  get lastReceipt(): JevDecisionReceipt | null {
    return this.lastReceiptValue;
  }

  async adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice> {
    if (this.disabledProjects.includes(req.projectId)) {
      return { status: 'unknown', reason: 'not-configured' };
    }

    const state = buildRankingAdviceState(req);
    if (!state.ok) {
      // Refused state means no fetch: nothing leaves the host.
      return { status: 'unknown', reason: 'redaction-refused' };
    }

    let key: string;
    try {
      key = await this.readKey(this.keyFile);
    } catch {
      // Key errors never carry the key or file content.
      return { status: 'unknown', reason: 'not-configured' };
    }

    const body = JSON.stringify({
      model: this.model,
      state: state.stateJson,
      questions: buildScoreQuestions(state),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(JEV_DECISIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      return { status: 'unknown', reason: isAbortError(error) ? 'timeout' : 'transport' };
    } finally {
      clearTimeout(timer);
    }

    if (!(response as { ok?: boolean }).ok) {
      // HTTP status only; never the body.
      return { status: 'unknown', reason: 'transport' };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return { status: 'unknown', reason: 'transport' };
    }
    if (text.length > MAX_RESPONSE_TEXT_CHARS) {
      return { status: 'unknown', reason: 'shape' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { status: 'unknown', reason: 'shape' };
    }

    const validated = validateScoreAnswers(
      parsed,
      state.keys,
      DEFAULT_DECISION_LEVELS,
      this.minConfidence,
    );
    if (!validated.ok) {
      return { status: 'unknown', reason: validated.reason };
    }

    const scores: Record<string, number> = {};
    for (const key of state.keys) {
      scores[state.idsByKey[key]] = validated.scores[key];
    }

    this.lastReceiptValue = extractReceipt(parsed, state.stateSha256);
    return {
      status: 'advised',
      scores,
      model: validated.model,
      confidence: validated.confidence,
    };
  }
}

/** One `score` question per candidate key, matching the recorded request. */
function buildScoreQuestions(state: RankingAdviceStateBuilt): Record<
  string,
  { type: 'score'; instructions: string; criteria: readonly string[] }
> {
  const questions: Record<
    string,
    { type: 'score'; instructions: string; criteria: readonly string[] }
  > = {};
  for (const key of state.keys) {
    questions[key] = {
      type: 'score',
      instructions: `How relevant is candidate ${key} to the task?`,
      criteria: state.criteria,
    };
  }
  return questions;
}

/** Extract the receipt fields without trusting or re-serving the body. */
function extractReceipt(parsed: unknown, stateSha256: string): JevDecisionReceipt {
  const requestId = isPlainObject(parsed) && typeof parsed.id === 'string' ? parsed.id : '';
  const usage = isPlainObject(parsed) && isPlainObject(parsed.usage) ? parsed.usage : {};
  const costUsd = typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : 0;
  const servedModel =
    isPlainObject(parsed) && typeof parsed.model === 'string' ? parsed.model : '';
  return { requestId, costUsd, servedModel, stateSha256 };
}
