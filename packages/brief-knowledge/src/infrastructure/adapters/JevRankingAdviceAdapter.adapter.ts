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
 * imported across contexts). One attempt with a single AbortController
 * deadline covering both the fetch and the body read (default 3 s), no
 * redirects. Non-2xx → `transport`; abort → `timeout`; response bodies over
 * 64 KiB (by header or by accumulated bytes) or unparsable JSON → `shape`;
 * then the strict score validator. Authorization, request bodies and response
 * bodies never appear in thrown errors or returned values.
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
import { postJevDecision } from '@fleet/shared';
import type { JevDecisionReceipt } from '@fleet/shared';
import {
  DEFAULT_DECISION_LEVELS,
  validateScoreAnswers,
} from './jev-advice-validator.js';
import {
  buildRankingAdviceState,
  type RankingAdviceStateBuilt,
} from './jev-advice-state.js';

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JevRankingAdviceAdapter implements KnowledgeRankingAdvicePort {
  private readonly model: string;
  private readonly keyFile: string;
  private readonly minConfidence: number;
  private readonly disabledProjects: readonly string[];
  private readonly fetchFn: typeof fetch;
  private readonly readKey: (path: string) => Promise<string>;
  private readonly timeoutMs: number | undefined;
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
    this.timeoutMs = deps.timeoutMs;
  }

  /** Receipt of the last advised call, for the decision receipt journal. */
  get lastReceipt(): JevDecisionReceipt | null {
    return this.lastReceiptValue;
  }

  async adviseRanking(req: AdviseRankingQuery): Promise<RankingAdvice> {
    // Every call starts from a clean slate: an unknown call after an advised
    // call must not leave a stale receipt behind.
    this.lastReceiptValue = null;
    try {
      return await this.adviseRankingInner(req);
    } catch {
      // The port never throws: any unexpected error is an opaque transport
      // failure. Errors never carry keys, bodies or response content.
      return { status: 'unknown', reason: 'transport' };
    }
  }

  private async adviseRankingInner(req: AdviseRankingQuery): Promise<RankingAdvice> {
    // A non-finite threshold is a configuration error, never a low-confidence
    // answer: the kernel's gate would accept everything, so it is refused
    // before the state is built and before any key is read or fetch is made.
    if (!Number.isFinite(this.minConfidence)) {
      return { status: 'unknown', reason: 'not-configured' };
    }
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

    const result = await postJevDecision({
      fetch: this.fetchFn,
      key,
      model: this.model,
      stateJson: state.stateJson,
      questions: buildScoreQuestions(state),
      stateSha256: state.stateSha256,
      timeoutMs: this.timeoutMs,
    });

    if (!result.ok) {
      return { status: 'unknown', reason: result.reason };
    }

    // The receipt is set as soon as the body parses as JSON — before
    // validation — so a paid call that fails validation still exposes its
    // cost for the receipt journal.
    this.lastReceiptValue = result.receipt;

    const validated = validateScoreAnswers(
      result.parsed,
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
