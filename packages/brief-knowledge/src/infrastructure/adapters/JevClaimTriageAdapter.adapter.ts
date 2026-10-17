// Implemented for lane K5b (decision-kernel plan, 2026-10-16, §5).
/**
 * JevClaimTriageAdapter implements ClaimTriagePort against TypeSafe Jev via
 * OpenRouter `POST /api/alpha/decisions` (model `typesafe/jev-1.14` or its
 * revisions). Advisory only: on any failure it answers `unknown/<reason>` and
 * the consumer keeps capture order — no flag for any candidate.
 *
 * One provider request per batch (plan §5): every request of an attempt
 * carries `contextRef: triage:<attemptId>`, declares only the batch's claim
 * texts (keys `k0..kn`) and the attempt's `pathPrefixes`, and asks two kernel
 * questions per candidate — a `choice` over `lesson`, `policy_proposal`,
 * `instruction`, `status_noise` and a `score` "reusable beyond this attempt"
 * over four levels. "Recorded or not made": one receipt-journal reservation
 * per batch before its request, one settlement before any answer from it is
 * used; a batch whose settlement fails contributes no advice and its
 * reservation still counts, so a paid call is never invisible to the budget.
 *
 * Answer mapping: a chosen class of `policy_proposal` or `instruction` at or
 * above the consumer's confidence threshold maps to the `policy-like` /
 * `instruction-like` triage flag; a refused or unknown answer means no flag.
 * The reuse score is advice for the disposition queue only — a flag never
 * changes a disposition and a score never becomes one.
 *
 * Transport hygiene mirrors JevRankingAdviceAdapter: the key is read by the
 * injected `readKey` (default `readKeyFile`, mode-checked, never logged), one
 * attempt under a single deadline (default 3 s), no redirects, response
 * bodies over 64 KiB or unparsable JSON are a `shape` failure, and neither
 * authorization, request bodies nor response bodies appear in errors.
 */

import type { ChoiceQuestion, ScoreQuestion } from "@fleet/shared";
import {
  validateChoiceAnswer,
  validateScoreAnswer,
  isValidIdOrModel,
} from "@fleet/shared";
import type {
  ClaimTriageAdvice,
  ClaimTriagePort,
  TriageAttemptQuery,
} from "../../application/ports/out/ClaimTriagePort.out-port.js";
import type { KnowledgeTriageFlag } from "../../domain/knowledge-records.js";
import type { DecisionReceiptJournalPort } from "../../application/ports/out/DecisionReceiptJournalPort.out-port.js";
import { CLAIM_TRIAGE_CONSUMER } from "../../application/ports/out/DecisionReceiptJournalPort.out-port.js";
import { buildTriageBatches, triageContextRef } from "./claim-triage-state.js";
import { readKeyFile } from "./JevRankingAdviceAdapter.adapter.js";

const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_JEV_TIMEOUT_MS = 3000;
/** Response bodies larger than this many bytes are refused as a shape failure. */
const MAX_RESPONSE_BODY_BYTES = 65536;

/** Choice criteria ids exactly as the owner-recorded K0 fixture pins them. */
export const TRIAGE_CLASS_OPTIONS: Readonly<Record<string, string>> = {
  lesson: "A reusable technical lesson about the code",
  policy_proposal: "A proposed rule about process, seats, hosts or permissions",
  instruction: "An instruction telling a future worker what to do",
  status_noise: "A status report with no reusable content",
};

/** Reusability levels, least → most reusable (index 0 → 3). */
export const TRIAGE_REUSE_LEVELS: readonly string[] = [
  "not reusable",
  "this attempt only",
  "project reusable",
  "broadly reusable",
];

/** Class id → the escalation flag it attaches (plan §5). */
const FLAG_BY_CLASS: Readonly<Record<string, KnowledgeTriageFlag>> = {
  policy_proposal: "policy-like",
  instruction: "instruction-like",
};

export interface JevClaimTriageAdapterDependencies {
  /** Jev model id sent with every request, e.g. `typesafe/jev-1.14`. */
  readonly model: string;
  /** Path of the mode-600 key file, read at call time by `readKey`. */
  readonly keyFile: string;
  /** Lowest acceptable per-answer confidence (the consumer's threshold). */
  readonly minConfidence: number;
  /** Durable receipt journal; one reservation and settlement per batch. */
  readonly journal: DecisionReceiptJournalPort;
  /** Provider identifier recorded on every settled receipt. */
  readonly provider?: string;
  /** Cost assumed per batch request when no settled cost arrives. */
  readonly assumedCostUsd: number;
  /** Month-to-date budget the journal enforces, in USD. */
  readonly monthlyBudgetUsd: number;
  /** This consumer's own sub-budget, in USD; omit when it has none. */
  readonly consumerBudgetUsd?: number;
  /** Injected transport; no default network call happens without it. */
  readonly fetch: typeof fetch;
  /** Injected key reader; defaults to `readKeyFile`. */
  readonly readKey?: (path: string) => Promise<string>;
  readonly timeoutMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class JevClaimTriageAdapter implements ClaimTriagePort {
  private readonly model: string;
  private readonly keyFile: string;
  private readonly minConfidence: number;
  private readonly journal: DecisionReceiptJournalPort;
  private readonly provider: string;
  private readonly assumedCostUsd: number;
  private readonly monthlyBudgetUsd: number;
  private readonly consumerBudgetUsd: number | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly readKey: (path: string) => Promise<string>;
  private readonly timeoutMs: number;

  constructor(deps: JevClaimTriageAdapterDependencies) {
    if (!deps || typeof deps !== "object") {
      throw new Error("JevClaimTriageAdapter requires dependencies");
    }
    if (typeof deps.model !== "string" || deps.model.length === 0) {
      throw new Error("JevClaimTriageAdapter requires a model id");
    }
    if (typeof deps.keyFile !== "string" || deps.keyFile.length === 0) {
      throw new Error("JevClaimTriageAdapter requires a keyFile path");
    }
    if (!Number.isFinite(deps.minConfidence)) {
      throw new Error("JevClaimTriageAdapter requires a finite minConfidence");
    }
    if (!deps.journal || typeof deps.journal !== "object") {
      throw new Error("JevClaimTriageAdapter requires a receipt journal");
    }
    if (typeof deps.fetch !== "function") {
      throw new Error("JevClaimTriageAdapter requires an injected fetch");
    }
    this.model = deps.model;
    this.keyFile = deps.keyFile;
    this.minConfidence = deps.minConfidence;
    this.journal = deps.journal;
    this.provider = deps.provider ?? "jev";
    this.assumedCostUsd = deps.assumedCostUsd;
    this.monthlyBudgetUsd = deps.monthlyBudgetUsd;
    this.consumerBudgetUsd = deps.consumerBudgetUsd;
    this.fetchFn = deps.fetch;
    this.readKey = deps.readKey ?? readKeyFile;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  }

  async triageAttempt(query: TriageAttemptQuery): Promise<ClaimTriageAdvice> {
    try {
      return await this.triageAttemptInner(query);
    } catch {
      // The port never throws: any unexpected error is an opaque transport
      // failure. Errors never carry keys, claim text or response content.
      return { status: "unknown", reason: "transport" };
    }
  }

  private async triageAttemptInner(
    query: TriageAttemptQuery,
  ): Promise<ClaimTriageAdvice> {
    // A non-finite threshold is a configuration error, never a low-confidence
    // answer: the kernel's gate would accept everything, so it is refused
    // before any state is built and before any key is read or fetch is made.
    if (!Number.isFinite(this.minConfidence)) {
      return { status: "unknown", reason: "not-configured" };
    }
    if (
      !query ||
      typeof query !== "object" ||
      typeof query.attemptId !== "string"
    ) {
      return { status: "unknown", reason: "not-configured" };
    }

    const contextRef = triageContextRef(query.attemptId);
    const batches = buildTriageBatches(
      Array.isArray(query.pathPrefixes) ? query.pathPrefixes : [],
      Array.isArray(query.candidates) ? query.candidates : [],
    );
    if (!batches.ok) {
      // Refused declared state means no request: nothing leaves the host.
      return { status: "unknown", reason: "redaction-refused", contextRef };
    }

    // Nothing was sent for this attempt: no flag for anyone, still candidates.
    if (batches.batches.length === 0) {
      return { status: "advised", contextRef, flags: {}, scores: {} };
    }

    const flags: Record<string, KnowledgeTriageFlag> = {};
    const scores: Record<string, number> = {};
    let firstFailure: {
      reason:
        | "budget"
        | "not-configured"
        | "timeout"
        | "transport"
        | "shape"
        | "low-confidence";
    } | null = null;

    for (const batch of batches.batches) {
      const reserved = await this.reserveBatch(batch.stateSha256);
      if (!reserved.ok) {
        // The batch is never sent; its candidates get no flag. A budget
        // refusal applies to every later batch too (spend only grows).
        firstFailure ??= { reason: reserved.reason };
        break;
      }
      const outcome = await this.callBatch(
        reserved.reservationId,
        contextRef,
        batch,
      );
      if (outcome.advice) {
        Object.assign(flags, outcome.advice.flags);
        Object.assign(scores, outcome.advice.scores);
      } else {
        firstFailure ??= { reason: outcome.reason };
        if (outcome.stopBatches) {
          break;
        }
      }
    }

    if (Object.keys(flags).length === 0 && Object.keys(scores).length === 0) {
      return {
        status: "unknown",
        ...(firstFailure !== null
          ? { reason: firstFailure.reason }
          : { reason: "shape" as const }),
        contextRef,
      };
    }
    return { status: "advised", contextRef, flags, scores };
  }

  /** Reserve this batch's budget; a refusal or a throwing journal refuses it. */
  private async reserveBatch(
    stateSha256: string,
  ): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; reason: "budget" | "not-configured" }
  > {
    try {
      const reserved = await this.journal.reserve({
        consumer: CLAIM_TRIAGE_CONSUMER,
        assumedCostUsd: this.assumedCostUsd,
        monthlyBudgetUsd: this.monthlyBudgetUsd,
        ...(this.consumerBudgetUsd === undefined
          ? {}
          : { consumerBudgetUsd: this.consumerBudgetUsd }),
        stateSha256,
      });
      if (!reserved.ok) {
        return {
          ok: false,
          reason:
            reserved.reason === "budget-exhausted"
              ? "budget"
              : "not-configured",
        };
      }
      return { ok: true, reservationId: reserved.reservationId };
    } catch {
      // A throwing journal is not a usable durable store: nothing is made.
      return { ok: false, reason: "not-configured" };
    }
  }

  /**
   * One provider request for one batch: ask, validate, settle, then — only
   * when the settlement succeeded — hand the batch's advice back.
   */
  private async callBatch(
    reservationId: string,
    contextRef: string,
    batch: {
      readonly stateJson: string;
      readonly keys: readonly string[];
      readonly idsByKey: Readonly<Record<string, string>>;
    },
  ): Promise<
    | {
        advice: {
          flags: Readonly<Record<string, KnowledgeTriageFlag>>;
          scores: Readonly<Record<string, number>>;
        };
      }
    | {
        advice: null;
        reason:
          | "not-configured"
          | "timeout"
          | "transport"
          | "shape"
          | "low-confidence";
        stopBatches: boolean;
      }
  > {
    const startedAt = Date.now();
    const read = await this.request(batch.stateJson);
    // One deadline covers the whole call: a clock that moved backwards never
    // records a negative latency.
    const latencyMs = Math.max(0, Date.now() - startedAt);

    // The batch asked both questions; the receipt records that even when
    // the transport failed, so the month-to-date spend stays honest.
    const questionKinds: ReadonlyArray<"choice" | "score"> = [
      "choice",
      "score",
    ];

    if (!read.ok) {
      // The reservation still counts: a failed call is paid for, so it is
      // settled as estimated with the transport reason — a reservation is
      // never left pending.
      try {
        await this.journal.settle(reservationId, {
          consumer: CLAIM_TRIAGE_CONSUMER,
          contextRef,
          provider: this.provider,
          model: this.model,
          costUsd: undefined,
          questionKinds,
          latencyMs,
          lexicalOrder: [],
          decidedOrder: [],
          unknownReason: read.reason,
        });
      } catch {
        // The settlement cannot be recorded; the reservation still counts.
      }
      return { advice: null, reason: read.reason, stopBatches: true };
    }

    const validated = this.validateBatch(read.parsed, batch.keys);
    const hadAdvice = validated.flags.length > 0 || validated.scores.length > 0;

    try {
      await this.journal.settle(reservationId, {
        consumer: CLAIM_TRIAGE_CONSUMER,
        contextRef,
        provider: this.provider,
        model: validated.model || this.model,
        ...(validated.requestId ? { requestId: validated.requestId } : {}),
        costUsd: validated.costUsd,
        questionKinds: hadAdvice
          ? ["choice", "score"]
          : validated.questionKindsAsked,
        ...(validated.minConfidenceObserved !== undefined
          ? { minConfidenceObserved: validated.minConfidenceObserved }
          : {}),
        latencyMs,
        // A triage line orders nothing: the ranking budget never mistakes a
        // triage call for a reordering.
        lexicalOrder: [],
        decidedOrder: [],
        ...(hadAdvice
          ? {}
          : {
              unknownReason: validated.bodyUnusable
                ? "shape"
                : "low-confidence",
            }),
      });
    } catch {
      // The answer is not used when the settlement cannot be recorded; the
      // reservation still counts, so a paid call stays visible to the budget.
      return { advice: null, reason: "not-configured", stopBatches: false };
    }

    if (!hadAdvice) {
      // Per-candidate refusals end here: this batch simply advises nothing.
      return {
        advice: null,
        reason: validated.bodyUnusable ? "shape" : "low-confidence",
        stopBatches: false,
      };
    }
    // Map the batch's question keys back to the candidate ids they stand
    // for; a key the batch did not declare is dropped, never guessed.
    const flagsById: Record<string, KnowledgeTriageFlag> = {};
    for (const [key, flag] of validated.flags) {
      const id = batch.idsByKey[key];
      if (id !== undefined) {
        flagsById[id] = flag;
      }
    }
    const scoresById: Record<string, number> = {};
    for (const [key, score] of validated.scores) {
      const id = batch.idsByKey[key];
      if (id !== undefined) {
        scoresById[id] = score;
      }
    }
    return { advice: { flags: flagsById, scores: scoresById } };
  }

  /** The transport for one batch request, with the ranking adapter's hygiene. */
  private async request(
    stateJson: string,
  ): Promise<
    | { ok: true; parsed: unknown }
    | {
        ok: false;
        reason: "not-configured" | "timeout" | "transport" | "shape";
      }
  > {
    let key: string;
    try {
      key = await this.readKey(this.keyFile);
    } catch {
      // Key errors never carry the key or file content.
      return { ok: false, reason: "not-configured" };
    }

    const body = JSON.stringify({
      model: this.model,
      state: stateJson,
      questions: buildTriageQuestions(stateJson),
    });

    // One deadline covers the fetch AND the body read; the timer is cleared
    // only after the body is fully read (or the attempt has already failed).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(JEV_DECISIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });

      if (!(response as { ok?: boolean }).ok) {
        // HTTP status only; never the body. Release the connection.
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "transport" };
      }

      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader !== null) {
        const contentLength = Number(contentLengthHeader);
        if (
          Number.isFinite(contentLength) &&
          contentLength > MAX_RESPONSE_BODY_BYTES
        ) {
          // Refuse before reading a single byte of an oversized body.
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, reason: "shape" };
        }
      }

      const stream = response.body;
      if (!stream) {
        return { ok: false, reason: "transport" };
      }
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let received = 0;
      let text = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_RESPONSE_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, reason: "shape" };
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        return {
          ok: false,
          reason: isAbortError(error) ? "timeout" : "transport",
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, reason: "shape" };
      }
      return { ok: true, parsed };
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "transport" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validate one batch's answer body against the asked questions with the
   * kernel's per-answer validators. Shape first, gate second, per candidate:
   * one malformed or low-confidence answer silences only its own candidate.
   * No body content ever appears in any returned value.
   */
  private validateBatch(
    parsed: unknown,
    keys: readonly string[],
  ): {
    flags: Array<[string, KnowledgeTriageFlag]>;
    scores: Array<[string, number]>;
    model: string;
    requestId: string;
    costUsd: number | undefined;
    minConfidenceObserved: number | undefined;
    questionKindsAsked: ReadonlyArray<"choice" | "score">;
    bodyUnusable: boolean;
  } {
    if (!isPlainObject(parsed)) {
      return emptyValidation(["choice", "score"], true);
    }
    // The receipt is bound to the paid call even when validation fails.
    const model = isValidIdOrModel(parsed.model) ? parsed.model : "";
    const requestId =
      parsed.id !== undefined && isValidIdOrModel(parsed.id)
        ? String(parsed.id)
        : "";
    const usage = isPlainObject(parsed.usage) ? parsed.usage : {};
    // Absent or non-finite cost stays undefined, never 0: the journal would
    // otherwise record a real paid cost of zero.
    const costUsd =
      typeof usage.cost === "number" && Number.isFinite(usage.cost)
        ? usage.cost
        : undefined;

    const answers = parsed.answers;
    if (!isPlainObject(answers)) {
      return emptyValidation(["choice", "score"], true);
    }

    const flags: Array<[string, KnowledgeTriageFlag]> = [];
    const scores: Array<[string, number]> = [];
    let confidence = Number.POSITIVE_INFINITY;
    let sawChoice = false;
    let sawScore = false;
    let shapeFailure = false;

    for (const key of keys) {
      const classQuestion: ChoiceQuestion = {
        kind: "choice",
        instructions: `Classify candidate claim ${key}.`,
        options: TRIAGE_CLASS_OPTIONS,
      };
      // Shape first, gate second, per candidate: the kernel's validator
      // applies the consumer threshold itself, and one refused answer
      // silences only its own candidate — no flag, no score.
      const classAnswer = validateChoiceAnswer(
        answers[key],
        classQuestion,
        this.minConfidence,
      );
      sawChoice = true;
      const reuseQuestion: ScoreQuestion = {
        kind: "score",
        instructions: `How reusable is candidate ${key} beyond this attempt?`,
        levels: TRIAGE_REUSE_LEVELS,
      };
      const reuseAnswer = validateScoreAnswer(
        answers[`${key}-reuse`],
        reuseQuestion,
        this.minConfidence,
      );
      sawScore = true;
      if (!classAnswer.ok || !reuseAnswer.ok) {
        if (
          (classAnswer.ok === false && classAnswer.reason === "shape") ||
          (reuseAnswer.ok === false && reuseAnswer.reason === "shape")
        ) {
          shapeFailure = true;
        }
        continue;
      }
      confidence = Math.min(
        confidence,
        classAnswer.confidence,
        reuseAnswer.confidence,
      );
      // `lesson` and `status_noise` attach nothing by design; the chosen
      // class `policy_proposal`/`instruction` is the kernel's own answer, so
      // the threshold it gated is the consumer's.
      const chosenClass = classAnswer.choice;
      if (chosenClass !== undefined) {
        const flag = FLAG_BY_CLASS[chosenClass];
        if (flag !== undefined) {
          flags.push([key, flag]);
        }
      }
      const reuseScore = reuseAnswer.value;
      if (reuseScore !== undefined) {
        scores.push([key, reuseScore]);
      }
    }

    const observed =
      confidence === Number.POSITIVE_INFINITY
        ? undefined
        : Math.max(0, confidence);
    return {
      flags,
      scores,
      model,
      requestId,
      costUsd,
      minConfidenceObserved: observed,
      questionKindsAsked: [
        ...(sawChoice ? (["choice"] as const) : []),
        ...(sawScore ? (["score"] as const) : []),
      ],
      bodyUnusable: shapeFailure,
    };
  }
}

function emptyValidation(
  questionKindsAsked: ReadonlyArray<"choice" | "score">,
  bodyUnusable: boolean,
): {
  flags: Array<[string, KnowledgeTriageFlag]>;
  scores: Array<[string, number]>;
  model: string;
  requestId: string;
  costUsd: number | undefined;
  minConfidenceObserved: number | undefined;
  questionKindsAsked: ReadonlyArray<"choice" | "score">;
  bodyUnusable: boolean;
} {
  return {
    flags: [],
    scores: [],
    model: "",
    requestId: "",
    costUsd: undefined,
    minConfidenceObserved: undefined,
    questionKindsAsked,
    bodyUnusable,
  };
}

/**
 * The questions of one batch request, derived from the exact state that is
 * sent: one `choice` and one `score` question per candidate key. The state's
 * key order is read back out of the serialized record the request carries.
 */
function buildTriageQuestions(
  stateJson: string,
): Record<
  string,
  | {
      type: "choice";
      instructions: string;
      criteria: Readonly<Record<string, string>>;
    }
  | { type: "score"; instructions: string; levels: readonly string[] }
> {
  const questions: Record<
    string,
    | {
        type: "choice";
        instructions: string;
        criteria: Readonly<Record<string, string>>;
      }
    | { type: "score"; instructions: string; levels: readonly string[] }
  > = {};
  let keys: string[] = [];
  try {
    const parsed: unknown = JSON.parse(stateJson);
    if (isPlainObject(parsed) && isPlainObject(parsed.claims)) {
      keys = Object.keys(parsed.claims);
    }
  } catch {
    // An unparsable state is a construction error; an empty question set
    // simply yields a shape failure at the provider without ever sending.
    keys = [];
  }
  for (const key of keys) {
    questions[key] = {
      type: "choice",
      instructions: `Classify candidate claim ${key}.`,
      criteria: { ...TRIAGE_CLASS_OPTIONS },
    };
    questions[`${key}-reuse`] = {
      type: "score",
      instructions: `How reusable is candidate ${key} beyond this attempt?`,
      levels: [...TRIAGE_REUSE_LEVELS],
    };
  }
  return questions;
}
