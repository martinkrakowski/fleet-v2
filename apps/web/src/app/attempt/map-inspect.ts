/**
 * Pure mapping from the `GET /v1/attempts/:id` envelope to the typed inspect
 * view. The found attempt extends the shared recorded wire with the detail
 * fields only the inspect read carries.
 */

import {
  isRecord,
  parseRecordedAttempt,
  type RecordedAttemptWire,
} from "../../lib/attempt-wire";

export interface RecordedCompletion {
  readonly endedAtIso: string;
  readonly exitStatus: number | null;
  readonly authoritative: boolean;
  readonly stoppedByRequest: boolean;
}

export interface AttemptDetail extends RecordedAttemptWire {
  readonly baseCommit: string;
  readonly briefDigest: string | null;
  /** Absent on older records; null reads "not recorded". */
  readonly stopReason: string | null;
  readonly reviewerSeat: string | null;
  /** null means unknown (absent on the record), never an empty list. */
  readonly ownerDecisionReferences: readonly string[] | null;
  readonly completion: RecordedCompletion | null;
}

export type InspectView =
  | { readonly outcome: "found"; readonly attempt: AttemptDetail }
  | { readonly outcome: "not-found"; readonly attemptId: string }
  | {
      readonly outcome: "unknown";
      readonly attemptId: string;
      readonly reason: string;
    };

function parseAttemptDetail(value: unknown): AttemptDetail | null {
  const base = parseRecordedAttempt(value);
  if (!base) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const baseCommit = value.baseCommit;
  if (typeof baseCommit !== "string") {
    return null;
  }

  const briefDigest = value.briefDigest;
  if (briefDigest !== null && typeof briefDigest !== "string") {
    return null;
  }

  const stopReason = value.stopReason;
  if (
    stopReason !== undefined &&
    stopReason !== null &&
    typeof stopReason !== "string"
  ) {
    return null;
  }

  const reviewerSeat = value.reviewerSeat;
  if (
    reviewerSeat !== undefined &&
    reviewerSeat !== null &&
    typeof reviewerSeat !== "string"
  ) {
    return null;
  }

  const references = value.ownerDecisionReferences;
  let ownerDecisionReferences: readonly string[] | null = null;
  if (references !== undefined && references !== null) {
    if (
      !Array.isArray(references) ||
      !references.every((reference) => typeof reference === "string")
    ) {
      return null;
    }
    ownerDecisionReferences = references;
  }

  const receipt = value.completionReceipt;
  let completion: RecordedCompletion | null = null;
  if (receipt !== undefined && receipt !== null) {
    if (!isRecord(receipt)) {
      return null;
    }
    if (typeof receipt.endedAtIso !== "string") {
      return null;
    }
    if (typeof receipt.exitStatus !== "number" && receipt.exitStatus !== null) {
      return null;
    }
    if (typeof receipt.authoritative !== "boolean") {
      return null;
    }
    if (typeof receipt.stoppedByRequest !== "boolean") {
      return null;
    }
    completion = {
      endedAtIso: receipt.endedAtIso,
      exitStatus: receipt.exitStatus,
      authoritative: receipt.authoritative,
      stoppedByRequest: receipt.stoppedByRequest,
    };
  }

  return {
    ...base,
    baseCommit,
    briefDigest,
    stopReason: stopReason ?? null,
    reviewerSeat: reviewerSeat ?? null,
    ownerDecisionReferences,
    completion,
  };
}

export function parseInspectEnvelope(payload: unknown): InspectView | null {
  if (!isRecord(payload) || payload.code !== "OK") {
    return null;
  }
  const result = payload.result;
  if (!isRecord(result)) {
    return null;
  }
  if (result.outcome === "found") {
    const attempt = parseAttemptDetail(result.attempt);
    if (!attempt) {
      return null;
    }
    return { outcome: "found", attempt };
  }
  if (result.outcome === "not-found") {
    if (typeof result.attemptId !== "string") {
      return null;
    }
    return { outcome: "not-found", attemptId: result.attemptId };
  }
  if (result.outcome === "unknown") {
    if (
      typeof result.attemptId !== "string" ||
      typeof result.reason !== "string"
    ) {
      return null;
    }
    return {
      outcome: "unknown",
      attemptId: result.attemptId,
      reason: result.reason,
    };
  }
  return null;
}
