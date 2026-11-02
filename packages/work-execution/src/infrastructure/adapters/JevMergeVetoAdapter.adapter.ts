// Implemented for lane DT-V2 (Jev veto decision, 2026-10-31).
/**
 * JevMergeVetoAdapter implements MergeVetoPort against TypeSafe Jev via
 * OpenRouter `POST /api/alpha/decisions` (model `typesafe/jev-1.14` or its
 * revisions). Advisory only, additive only: on any failure it answers
 * `unknown/<reason>` and the merge proceeds exactly as the scripted policy
 * decides — a `hold-for-human` answer at or above the configured
 * `holdConfidence` is the only outcome that can ever affect a merge, and the
 * hold decision itself stays with the merge-pass decider (DT9); this adapter
 * reports the answer, confidence, mode and decision receipt id only.
 *
 * One question, keyed `merge`, of type `choice` over `merge-safe` and
 * `hold-for-human`. The head binding lives in the request and the receipt's
 * contextRef only — the verified head oid is never part of the declared state
 * that leaves the host (correction 3).
 *
 * "Recorded or not made": an atomic journal `reserve` under the UTC month
 * lock checks spend against the monthly budget and durably appends the
 * reservation before a reservation id is returned; every call is settled by
 * that id before its answer is used. A failed settlement leaves the
 * reservation standing and the answer unused (`unknown/not-configured`), so a
 * paid call is never invisible to the budget (decision-port plan :104-111).
 *
 * Transport hygiene mirrors JevRankingAdviceAdapter: the key is read by the
 * injected `readKey` (default `readKeyFile`, which requires O_NOFOLLOW, a
 * regular file and mode `& 0o077 === 0`, re-implemented here, never imported
 * across contexts). One attempt with a single AbortController deadline (default
 * 3 s), no redirects; non-2xx → `transport`; abort → `timeout`; response
 * bodies over 64 KiB or unparsable JSON → `shape`. Authorization, request
 * bodies and response bodies never appear in thrown errors or returned values.
 */

import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {
  ChoiceQuestion,
  DecisionCallReceipt,
} from '@fleet/shared';
import {
  buildDecisionState,
  postJevDecision,
  toJevQuestion,
  validateChoiceAnswer,
} from '@fleet/shared';
import type {
  MergeVetoAdvice,
  MergeVetoPort,
  MergeVetoRequest,
  MergeVetoUnknownReason,
} from '../../application/ports/out/MergeVetoPort.out-port.js';

/** Consumer discriminator for the receipt journal. */
export const MERGE_VETO_CONSUMER = 'merge-veto';

/** Provider identifier recorded on every settled receipt. */
const MERGE_VETO_PROVIDER = 'jev';

/** Choice criteria ids, exactly the decided veto question's two options. */
const MERGE_VETO_OPTIONS: Readonly<Record<string, string>> = {
  'merge-safe': 'The PR is a routine, reversible change; merging is safe.',
  'hold-for-human': 'A hold trigger applies; a human should look before the merge.',
};

/** Hold triggers verbatim from the decision doc (2026-10-31, lines 52-57). */
const MERGE_VETO_INSTRUCTIONS = [
  '- a one-way door named in "Hard to undo" on a Tier 2 PR;',
  '- a reviewer finding closed without a code change;',
  '- more than one fix round;',
  "- changed paths outside the title's scope;",
  '- a head that changed after the last review.',
].join('\n');

/** The one kernel `choice` question this adapter asks, keyed `merge`. */
const MERGE_VETO_QUESTION: ChoiceQuestion = {
  kind: 'choice',
  instructions: MERGE_VETO_INSTRUCTIONS,
  options: MERGE_VETO_OPTIONS,
};

export interface JevMergeVetoAdapterDependencies {
  /** Jev model id sent with every request, e.g. `typesafe/jev-1.14`. */
  readonly model: string;
  /** Path of the mode-600 key file, read at call time by `readKey`. */
  readonly keyFile: string;
  /** 0.8 per D-JV4; doubles as minConfidence for the choice answer. */
  readonly holdConfidence: number;
  /** Month-to-date budget the journal enforces, in USD. */
  readonly monthlyBudgetUsd: number;
  /** Cost assumed per call when no settled cost arrives, in USD. */
  readonly assumedCostPerCallUsd: number;
  /** Projects that never get a veto call; they answer not-configured. */
  readonly disabledProjects?: readonly string[];
  /** Injected transport; no default network call happens without it. */
  readonly fetch: typeof fetch;
  /** Injected key reader; defaults to `readKeyFile`. */
  readonly readKey?: (path: string) => Promise<string>;
  /** Durable receipt journal; absent → not-configured (invariant 5). */
  readonly journal?: MergeVetoDecisionJournal;
  readonly timeoutMs?: number;
  /** Injected clock; tests always inject. */
  readonly now?: () => number;
  /** Injected sha-256; tests always inject. */
  readonly hash?: (state: string) => string;
}

/** What the journal needs to reserve this month's budget for one call. */
export interface MergeVetoReserveQuery {
  /** Consumer discriminator the pending spend is attributed to. */
  readonly consumer: typeof MERGE_VETO_CONSUMER;
  /** Cost assumed for this call when no settled cost arrives. */
  readonly assumedCostUsd: number;
  /** Month-to-date budget the journal enforces, in USD. */
  readonly monthlyBudgetUsd: number;
  /** SHA-256 of the declared state that will be sent. */
  readonly stateSha256: string;
}

export type MergeVetoReserveResult =
  | { readonly ok: true; readonly reservationId: string }
  | { readonly ok: false; readonly reason: 'budget' | 'not-configured' };

/**
 * Fields the caller declares for a settled merge-veto receipt; the adapter
 * supplies costUsd (falling back to assumedCostPerCallUsd), estimated, and at.
 */
export interface MergeVetoSettledReceipt extends DecisionCallReceipt {
  readonly consumer: typeof MERGE_VETO_CONSUMER;
}

/**
 * The atomic budget-and-append journal this adapter settles by reservation id.
 * Correction 1: no separate `monthSpendUsd`/`budgetAllows`/`appendEntry`
 * calls — `reserve` checks spend against the monthly budget under the UTC
 * month lock and durably appends the reservation before returning its id.
 */
export interface MergeVetoDecisionJournal {
  /**
   * Reserve this month's budget for one call: refuses with `budget` when the
   * spend plus the assumed cost would reach the budget (no fetch happens),
   * and with `not-configured` when the reservation cannot be made durable.
   */
  reserve(query: MergeVetoReserveQuery): Promise<MergeVetoReserveResult>;
  /**
   * Settle one reservation by id. Returns false when the settlement could not
   * be made durable; the reservation then stands and the answer is unused
   * (`unknown/not-configured`).
   */
  settle(reservationId: string, receipt: MergeVetoSettledReceipt): Promise<boolean>;
}

/**
 * Default key reader: opens with O_NOFOLLOW, requires a regular file with
 * mode `& 0o077 === 0`, trims and rejects empty. Errors never include the key
 * or any file content. Re-implemented here (never imported across contexts)
 * from the JevRankingAdviceAdapter pattern.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `answers.merge` wire answer, read defensively; absent → `shape`. */
function readMergeAnswer(parsed: unknown): unknown {
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const answers = parsed.answers;
  if (!isPlainObject(answers)) {
    return undefined;
  }
  return answers.merge;
}

/** Truncate to `capBytes` UTF-8 bytes on a code-point boundary. */
function capUtf8(text: string, capBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= capBytes) {
    return text;
  }
  let end = capBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Receipt contextRef: the head binding lives here, never in the state. */
function vetoContextRef(request: MergeVetoRequest): string {
  return `merge-veto:${request.repository.owner}/${request.repository.repo}#${request.pullRequestNumber}@${request.verifiedHeadOid.slice(0, 12)}`;
}

function vetoContextRefSafe(request: MergeVetoRequest): string {
  try {
    return vetoContextRef(request);
  } catch {
    const owner = request.repository?.owner ?? 'unknown';
    const repo = request.repository?.repo ?? 'unknown';
    const pr = request.pullRequestNumber ?? 0;
    const oid = typeof request.verifiedHeadOid === 'string' ? request.verifiedHeadOid.slice(0, 12) : 'unknown';
    return `merge-veto:${owner}/${repo}#${pr}@${oid}`;
  }
}

function isDeadlineExceeded(deadlineMs: number, nowMs: number): boolean {
  return !Number.isFinite(deadlineMs) || nowMs >= deadlineMs;
}

function isValidMergeChoice(choice: unknown): choice is 'merge-safe' | 'hold-for-human' {
  return choice === 'merge-safe' || choice === 'hold-for-human';
}

function extractRequestId(rawId: string): string | undefined {
  return rawId === '' ? undefined : rawId;
}

function resolveServedModel(servedModel: string, fallbackModel: string): string {
  return servedModel !== '' ? servedModel : fallbackModel;
}

function defaultHash(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

export class JevMergeVetoAdapter implements MergeVetoPort {
  private readonly model: string;
  private readonly keyFile: string;
  private readonly holdConfidence: number;
  private readonly monthlyBudgetUsd: number;
  private readonly assumedCostPerCallUsd: number;
  private readonly disabledProjects: readonly string[];
  private readonly fetchFn: typeof fetch;
  private readonly readKey: (path: string) => Promise<string>;
  private readonly journal: MergeVetoDecisionJournal | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly now: () => number;
  private readonly hash: (state: string) => string;

  constructor(deps: JevMergeVetoAdapterDependencies) {
    if (!deps || typeof deps !== 'object') {
      throw new Error('JevMergeVetoAdapter requires dependencies');
    }
    if (typeof deps.model !== 'string' || deps.model.length === 0) {
      throw new Error('JevMergeVetoAdapter requires a model id');
    }
    if (typeof deps.keyFile !== 'string' || deps.keyFile.length === 0) {
      throw new Error('JevMergeVetoAdapter requires a keyFile path');
    }
    if (!Number.isFinite(deps.holdConfidence)) {
      throw new Error('JevMergeVetoAdapter requires a finite holdConfidence');
    }
    if (!Number.isFinite(deps.monthlyBudgetUsd)) {
      throw new Error('JevMergeVetoAdapter requires a finite monthlyBudgetUsd');
    }
    if (!Number.isFinite(deps.assumedCostPerCallUsd)) {
      throw new Error('JevMergeVetoAdapter requires a finite assumedCostPerCallUsd');
    }
    if (typeof deps.fetch !== 'function') {
      throw new Error('JevMergeVetoAdapter requires an injected fetch');
    }
    this.model = deps.model;
    this.keyFile = deps.keyFile;
    this.holdConfidence = deps.holdConfidence;
    this.monthlyBudgetUsd = deps.monthlyBudgetUsd;
    this.assumedCostPerCallUsd = deps.assumedCostPerCallUsd;
    this.disabledProjects = deps.disabledProjects ?? [];
    this.fetchFn = deps.fetch;
    this.readKey = deps.readKey ?? readKeyFile;
    this.journal = deps.journal;
    this.timeoutMs = deps.timeoutMs;
    this.now = deps.now ?? (() => Date.now());
    this.hash = deps.hash ?? defaultHash;
  }

  async adviseMergeVeto(request: MergeVetoRequest): Promise<MergeVetoAdvice> {
    try {
      return await this.adviseMergeVetoInner(request);
    } catch {
      // The port never throws: any unexpected error is an opaque transport
      // failure. Errors never carry keys, state or response content.
      return { status: 'unknown', reason: 'transport' };
    }
  }

  private checkPreflight(
    request: MergeVetoRequest,
    deadlineMs: number,
    initialNowMs: number,
  ): MergeVetoUnknownReason | null {
    if (!Number.isFinite(this.holdConfidence)) {
      return 'not-configured';
    }
    if (isDeadlineExceeded(deadlineMs, initialNowMs)) {
      return 'deadline';
    }
    if (Math.min(this.timeoutMs ?? 3000, deadlineMs - initialNowMs) <= 0) {
      return 'deadline';
    }
    if (this.disabledProjects.includes(`${request.repository.owner}/${request.repository.repo}`)) {
      return 'not-configured';
    }
    if (!this.journal) {
      return 'not-configured';
    }
    return null;
  }

  private async adviseMergeVetoInner(request: MergeVetoRequest): Promise<MergeVetoAdvice> {
    const deadlineMs = Date.parse(request.deadlineIso);
    const initialNowMs = this.now();
    const preflight = this.checkPreflight(request, deadlineMs, initialNowMs);
    if (preflight !== null) {
      return { status: 'unknown', reason: preflight };
    }

    const state = this.buildState(request);
    if (!state.ok) {
      // Refused state means no key read and no fetch: nothing leaves the host.
      return { status: 'unknown', reason: 'redaction-refused' };
    }

    let key: string;
    try {
      key = await this.readKey(this.keyFile);
    } catch {
      // Key errors never carry the key or file content.
      return { status: 'unknown', reason: 'not-configured' };
    }

    const reserved = await this.reserve(state.stateSha256);
    if (!reserved.ok) {
      return { status: 'unknown', reason: reserved.reason };
    }

    const reservationId = reserved.reservationId;
    let callStartMs = 0;
    try {
      const contextRef = vetoContextRef(request);
      const preFetchNowMs = this.now();
      if (isDeadlineExceeded(deadlineMs, preFetchNowMs)) {
        return await this.finishDeadlineAfterReserve(reservationId, contextRef);
      }
      const timeoutMs = Math.min(
        this.timeoutMs ?? 3000,
        deadlineMs - preFetchNowMs,
      );

      callStartMs = this.now();
      const result = await postJevDecision({
        fetch: this.fetchFn,
        key,
        model: this.model,
        stateJson: state.stateJson,
        questions: { merge: toJevQuestion(MERGE_VETO_QUESTION) },
        stateSha256: state.stateSha256,
        timeoutMs,
      });
      const latencyMs = Math.max(0, this.now() - callStartMs);

      if (!result.ok) {
        return await this.finishClientFailureAfterReserve(
          reservationId,
          contextRef,
          result.reason,
          latencyMs,
        );
      }

      const validated = validateChoiceAnswer(
        readMergeAnswer(result.parsed),
        MERGE_VETO_QUESTION,
        this.holdConfidence,
      );
      const requestId = extractRequestId(result.receipt.requestId);
      const reportedCost = result.receipt.costUsd;
      const servedModel = resolveServedModel(result.receipt.servedModel, this.model);

      if (!validated.ok) {
        return await this.finishValidationFailureAfterReserve(
          reservationId,
          contextRef,
          servedModel,
          validated.reason,
          latencyMs,
          reportedCost,
          requestId,
        );
      }

      if (!isValidMergeChoice(validated.choice)) {
        return await this.finishValidationFailureAfterReserve(
          reservationId,
          contextRef,
          servedModel,
          'shape',
          latencyMs,
          reportedCost,
          requestId,
        );
      }

      return await this.finishAnswerAfterReserve(
        reservationId,
        contextRef,
        servedModel,
        validated.choice,
        validated.confidence,
        request.mode,
        latencyMs,
        reportedCost,
        requestId,
      );
    } catch {
      return await this.finishTransportErrorAfterReserve(
        reservationId,
        vetoContextRefSafe(request),
        callStartMs,
      );
    }
  }

  /** Declared PR metadata only; never the diff, contents, brief or head oid. */
  private buildState(
    request: MergeVetoRequest,
  ):
    | { ok: true; stateJson: string; stateSha256: string }
    | { ok: false } {
    const fields = request.state;
    const built = buildDecisionState(
      {
        tier: fields.tier,
        title: fields.title,
        changedPaths: fields.changedPaths,
        additions: String(fields.additions),
        deletions: String(fields.deletions),
        hardToUndo: capUtf8(fields.hardToUndo, 1024),
        fixRounds: String(fields.fixRounds),
        reviewerFamilies: fields.reviewerFamilies,
        replyResolvedThreads: String(fields.replyResolvedThreads),
        majorBlockerFindings: String(fields.majorBlockerFindings),
        headChangedAfterReview: fields.headChangedAfterReview ? 'true' : 'false',
      },
      { perFieldBytes: 8192, totalBytes: 32768 },
      this.hash,
    );
    if (!built.ok) {
      return { ok: false };
    }
    return { ok: true, stateJson: built.stateJson, stateSha256: built.stateSha256 };
  }

  /** Atomic budget check + durable append; a throwing journal is not usable. */
  private async reserve(stateSha256: string): Promise<MergeVetoReserveResult> {
    const journal = this.journal;
    if (!journal) {
      return { ok: false, reason: 'not-configured' };
    }
    try {
      return await journal.reserve({
        consumer: MERGE_VETO_CONSUMER,
        assumedCostUsd: this.assumedCostPerCallUsd,
        monthlyBudgetUsd: this.monthlyBudgetUsd,
        stateSha256,
      });
    } catch {
      return { ok: false, reason: 'not-configured' };
    }
  }

  private async settleReservation(
    reservationId: string,
    receipt: MergeVetoSettledReceipt,
  ): Promise<boolean> {
    const journal = this.journal;
    if (!journal) {
      return false;
    }
    try {
      return await journal.settle(reservationId, receipt);
    } catch {
      return false;
    }
  }

  /** The reservation stands: settled as estimated with the deadline reason. */
  private async finishDeadlineAfterReserve(
    reservationId: string,
    contextRef: string,
  ): Promise<MergeVetoAdvice> {
    const settled = await this.settleReservation(reservationId, {
      consumer: MERGE_VETO_CONSUMER,
      contextRef,
      provider: MERGE_VETO_PROVIDER,
      model: this.model,
      costUsd: this.assumedCostPerCallUsd,
      estimated: true,
      questionKinds: ['choice'],
      unknownReason: 'deadline',
      latencyMs: 0,
      at: new Date(this.now()).toISOString(),
    });
    if (!settled) {
      return { status: 'unknown', reason: 'not-configured' };
    }
    return { status: 'unknown', reason: 'deadline' };
  }

  /** The reservation stands: settled as estimated with client failure reason. */
  private async finishClientFailureAfterReserve(
    reservationId: string,
    contextRef: string,
    reason: MergeVetoUnknownReason,
    latencyMs: number,
  ): Promise<MergeVetoAdvice> {
    const settled = await this.settleReservation(reservationId, {
      consumer: MERGE_VETO_CONSUMER,
      contextRef,
      provider: MERGE_VETO_PROVIDER,
      model: this.model,
      costUsd: this.assumedCostPerCallUsd,
      estimated: true,
      questionKinds: ['choice'],
      unknownReason: reason,
      latencyMs,
      at: new Date(this.now()).toISOString(),
    });
    if (!settled) {
      return { status: 'unknown', reason: 'not-configured' };
    }
    return { status: 'unknown', reason };
  }

  /** The reservation stands: settled as estimated with unexpected transport error. */
  private async finishTransportErrorAfterReserve(
    reservationId: string,
    contextRef: string,
    callStartMs: number,
  ): Promise<MergeVetoAdvice> {
    const latencyMs = callStartMs > 0 ? Math.max(0, this.now() - callStartMs) : 0;
    const settled = await this.settleReservation(reservationId, {
      consumer: MERGE_VETO_CONSUMER,
      contextRef,
      provider: MERGE_VETO_PROVIDER,
      model: this.model,
      costUsd: this.assumedCostPerCallUsd,
      estimated: true,
      questionKinds: ['choice'],
      unknownReason: 'transport',
      latencyMs,
      at: new Date(this.now()).toISOString(),
    });
    if (!settled) {
      return { status: 'unknown', reason: 'not-configured' };
    }
    return { status: 'unknown', reason: 'transport' };
  }

  /** Settle after validation failure or shape violation. */
  private async finishValidationFailureAfterReserve(
    reservationId: string,
    contextRef: string,
    servedModel: string,
    reason: MergeVetoUnknownReason,
    latencyMs: number,
    reportedCost?: number,
    requestId?: string,
  ): Promise<MergeVetoAdvice> {
    const costUsd = reportedCost ?? this.assumedCostPerCallUsd;
    const estimated = reportedCost === undefined;
    const receipt: MergeVetoSettledReceipt = {
      consumer: MERGE_VETO_CONSUMER,
      contextRef,
      provider: MERGE_VETO_PROVIDER,
      model: servedModel,
      costUsd,
      estimated,
      questionKinds: ['choice'],
      unknownReason: reason,
      latencyMs,
      at: new Date(this.now()).toISOString(),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    const settled = await this.settleReservation(reservationId, receipt);
    if (!settled) {
      return { status: 'unknown', reason: 'not-configured' };
    }
    return { status: 'unknown', reason };
  }

  /** Settle after successful choice validation. */
  private async finishAnswerAfterReserve(
    reservationId: string,
    contextRef: string,
    servedModel: string,
    choice: 'merge-safe' | 'hold-for-human',
    confidence: number,
    mode: 'shadow' | 'live',
    latencyMs: number,
    reportedCost?: number,
    requestId?: string,
  ): Promise<MergeVetoAdvice> {
    const costUsd = reportedCost ?? this.assumedCostPerCallUsd;
    const estimated = reportedCost === undefined;
    const receipt: MergeVetoSettledReceipt = {
      consumer: MERGE_VETO_CONSUMER,
      contextRef,
      provider: MERGE_VETO_PROVIDER,
      model: servedModel,
      costUsd,
      estimated,
      questionKinds: ['choice'],
      minConfidenceObserved: confidence,
      latencyMs,
      at: new Date(this.now()).toISOString(),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    const settled = await this.settleReservation(reservationId, receipt);
    if (!settled) {
      return { status: 'unknown', reason: 'not-configured' };
    }
    return {
      status: 'answered',
      choice,
      confidence,
      mode,
      ...(requestId !== undefined ? { decisionReceiptId: requestId } : {}),
    };
  }
}
