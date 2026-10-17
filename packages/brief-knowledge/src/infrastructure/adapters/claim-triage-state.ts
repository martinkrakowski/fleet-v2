// Implemented for lane K5b (decision-kernel plan, 2026-10-16, §5).
/**
 * Builds the candidate-claim triage decision states for one attempt: each
 * candidate's `claimText` (keyed `k0..kn` within its batch, mapped back to
 * candidate ids) and the attempt's `pathPrefixes` — nothing else. Before any
 * transport runs, the kernel's `buildDecisionState` scans every declared
 * field with `containsSecretShape` and the size caps (8 KiB per field,
 * 32 KiB total); a pattern hit or an overflow refuses the state
 * (`redaction-refused`), it is never redacted and sent.
 *
 * The kernel is pure and has no `node:` import, so `node:crypto`'s SHA-256
 * is injected as the hasher. As in `jev-advice-state.ts`, the kernel's flat
 * record is only the refusal decision; the digest that ships is of the exact
 * wire bytes (`claims` keyed `k0..kn`, `pathPrefixes`) — the same nested
 * shape the owner-recorded K0 fixture pins.
 *
 * Batching (plan §5): capture caps the candidate count (50) but not the
 * length, so the attempt's usable claims are grouped into as few batches as
 * the 32 KiB total cap allows — one reservation and one provider request per
 * batch. A claim that fails the shared secret-shape scan is never sent and
 * its candidate gets no flag; a single claim over 8 KiB is left out of
 * triage entirely (no flag, still a candidate), never truncated.
 */

import { createHash } from "node:crypto";
import { buildDecisionState, containsSecretShape } from "@fleet/shared";
import type { DecisionStateCaps } from "@fleet/shared";

/** Maximum size of one declared field, in bytes (plan §5). */
export const MAX_TRIAGE_FIELD_BYTES = 8 * 1024;
/** Maximum total size of all declared fields of one request, in bytes. */
export const MAX_TRIAGE_TOTAL_BYTES = 32 * 1024;

const STATE_CAPS: DecisionStateCaps = {
  perFieldBytes: MAX_TRIAGE_FIELD_BYTES,
  totalBytes: MAX_TRIAGE_TOTAL_BYTES,
};

/** The hasher injected into the kernel: SHA-256 hex of the exact UTF-8 text. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** UTF-8 byte length of one string. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface TriageStateCandidate {
  readonly id: string;
  readonly claimText: string;
}

/** One batch: the exact state of one provider request and its key mapping. */
export interface TriageBatch {
  /** Exact JSON string sent as the decision `state` for this batch. */
  readonly stateJson: string;
  /** SHA-256 hex digest of `stateJson`. */
  readonly stateSha256: string;
  /** Question keys `k0..kn` in batch order. */
  readonly keys: readonly string[];
  /** Question key → candidate id. */
  readonly idsByKey: Readonly<Record<string, string>>;
  /** Candidates included in this batch, in batch order. */
  readonly candidates: readonly TriageStateCandidate[];
}

export interface TriageBatchesBuilt {
  readonly ok: true;
  readonly batches: readonly TriageBatch[];
  /** Candidate ids left out of triage (secret-shaped or over 8 KiB). */
  readonly excludedIds: readonly string[];
}

export interface TriageBatchesRefused {
  readonly ok: false;
  readonly reason: "redaction-refused";
}

export type TriageBatches = TriageBatchesBuilt | TriageBatchesRefused;

/**
 * Group the attempt's usable claims into batches that fit the caps. Returns
 * `redaction-refused` only when the declared `pathPrefixes` themselves fail
 * the kernel (a prefix is declared state too); every unusable claim is
 * excluded by id, never redacted and never truncated. Batching is greedy:
 * a claim joins the current batch while the batch's claim total stays within
 * the total cap less the prefixes, otherwise a new batch starts. An
 * over-8 KiB claim is never placed (its batch would refuse as a whole and
 * silence every other claim in it).
 */
export function buildTriageBatches(
  pathPrefixes: readonly string[],
  candidates: readonly TriageStateCandidate[],
): TriageBatches {
  if (
    !Array.isArray(pathPrefixes) ||
    pathPrefixes.some((p) => typeof p !== "string")
  ) {
    return { ok: false, reason: "redaction-refused" };
  }
  if (!Array.isArray(candidates)) {
    return { ok: false, reason: "redaction-refused" };
  }

  // The declared prefixes are declared state: each must pass the shared scan
  // and stay inside the per-field cap, and their total bounds every batch.
  const prefixFields: Record<string, string> = {};
  pathPrefixes.forEach((prefix, index) => {
    prefixFields[`pathPrefixes[${index}]`] = prefix;
  });
  if (!buildDecisionState(prefixFields, STATE_CAPS, sha256Hex).ok) {
    return { ok: false, reason: "redaction-refused" };
  }
  let prefixBytes = 0;
  for (const prefix of pathPrefixes) {
    prefixBytes += utf8Bytes(prefix);
  }
  // Each batch's claims must leave room for the prefixes under the total cap.
  const batchClaimBudget = Math.max(0, MAX_TRIAGE_TOTAL_BYTES - prefixBytes);

  // A claim is usable only when it passes the shared scan and fits a field.
  const usable: TriageStateCandidate[] = [];
  const excludedIds: string[] = [];
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      typeof candidate.claimText !== "string"
    ) {
      return { ok: false, reason: "redaction-refused" };
    }
    if (
      containsSecretShape(candidate.claimText) ||
      utf8Bytes(candidate.claimText) > MAX_TRIAGE_FIELD_BYTES
    ) {
      excludedIds.push(candidate.id);
      continue;
    }
    usable.push(candidate);
  }

  // Greedy packing under the total cap, in capture order. The exact state
  // each request sends is the nested record the K0 fixture pins; the kernel's
  // flat record is the refusal gate, the digest binds the wire bytes.
  const batches: TriageBatch[] = [];
  let current: TriageStateCandidate[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const flat: Record<string, string> = { ...prefixFields };
    current.forEach((candidate, index) => {
      flat[`claims.k${index}`] = candidate.claimText;
    });
    if (!buildDecisionState(flat, STATE_CAPS, sha256Hex).ok) {
      // Unreachable by construction (every member was pre-measured against
      // the same caps with room left for the prefixes), but the kernel's
      // refusal is final: nothing leaves the host.
      current = [];
      currentBytes = 0;
      return;
    }
    const keys = current.map((_, index) => `k${index}`);
    const idsByKey: Record<string, string> = {};
    const claims: Record<string, string> = {};
    current.forEach((candidate, index) => {
      idsByKey[keys[index]] = candidate.id;
      claims[keys[index]] = candidate.claimText;
    });
    const stateJson = JSON.stringify({
      claims,
      pathPrefixes: [...pathPrefixes],
    });
    batches.push({
      stateJson,
      stateSha256: sha256Hex(stateJson),
      keys,
      idsByKey,
      candidates: [...current],
    });
    current = [];
    currentBytes = 0;
  };

  for (const candidate of usable) {
    const claimBytes = utf8Bytes(candidate.claimText);
    if (currentBytes + claimBytes > batchClaimBudget) {
      flush();
    }
    current.push(candidate);
    currentBytes += claimBytes;
  }
  flush();

  return { ok: true, batches, excludedIds };
}

/** An attempt id that needs no substitution: 1–128 chars of `[A-Za-z0-9._-]`. */
const SAFE_ATTEMPT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The attempt segment of a triage `contextRef`. An absent or blank attempt
 * id reads as `unscoped` (the ranking lane's precedent). Every other id that
 * is not 1–128 characters of `[A-Za-z0-9._-]`, or that carries a secret
 * shape, is replaced by the first 16 hex characters of `sha256(attemptId)` —
 * deterministic, so the same attempt always yields the same reference and a
 * raw id can neither forge a second segment nor carry something
 * credential-shaped into the journal.
 */
function attemptSegment(attemptId: unknown): string {
  if (typeof attemptId !== "string") {
    return "unscoped";
  }
  const attempt = attemptId.trim();
  if (attempt.length === 0) {
    return "unscoped";
  }
  return SAFE_ATTEMPT_PATTERN.test(attempt) && !containsSecretShape(attempt)
    ? attempt
    : sha256Hex(attempt).slice(0, 16);
}

/**
 * `triage:<attemptId>` — the fixed per-attempt reference every triage
 * request of an attempt settles under, so the attempt's outcomes join on it
 * and on the candidate id (plan §5). At most 256 characters: a usable
 * attempt id is 1–128 chars and the digested one is 16.
 */
export function triageContextRef(attemptId: string): string {
  return `triage:${attemptSegment(attemptId)}`;
}
