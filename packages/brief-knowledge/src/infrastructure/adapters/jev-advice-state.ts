// Implemented for lane D2 (decision port plan, 2026-10-16); adopted from the
// decision kernel in lane K2 (2026-10-16_decision-kernel-and-claim-triage, §1).
/**
 * Builds the advisory ranking decision state from the declared fields only:
 * `taskSummary`, `pathPrefixes` and each candidate's `claimText` (keyed
 * `k0..kn`, mapped back to candidate ids). Nothing else — never
 * `dispositionReason`, `checks` or `reuses` — leaves the host through this
 * state. Before any transport runs, the kernel's `buildDecisionState` scans
 * every declared field with `containsSecretShape` and the size caps (8 KiB per
 * field, 32 KiB total); a pattern hit or an over-cap field refuses the state
 * (`redaction-refused`), it is never redacted and sent.
 *
 * The SHA-256 of the exact serialized state string is returned so every answer
 * — live or owner-recorded — is bound to the state it answers. The kernel is
 * pure and has no `node:` import, so `node:crypto`'s SHA-256 is injected as
 * the hasher; the kernel's own flat record is the refusal decision, while the
 * digest that ships is of the exact wire bytes (`taskSummary`,
 * `pathPrefixes`, `candidates` keyed `k0..kn`) recorded with the owner.
 */

import { createHash } from 'node:crypto';
import { buildDecisionState, containsSecretShape } from '@fleet/shared';
import type { DecisionStateCaps } from '@fleet/shared';
import { JEV_CRITERIA_LEVELS } from './jev-advice-validator.js';

/** Maximum size of one declared field, in bytes. */
export const MAX_STATE_FIELD_BYTES = 8 * 1024;
/** Maximum total size of all declared fields, in bytes. */
export const MAX_STATE_TOTAL_BYTES = 32 * 1024;

const STATE_CAPS: DecisionStateCaps = {
  perFieldBytes: MAX_STATE_FIELD_BYTES,
  totalBytes: MAX_STATE_TOTAL_BYTES,
};

/** The hasher injected into the kernel: SHA-256 hex of the exact UTF-8 text. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface RankingAdviceStateCandidate {
  readonly id: string;
  readonly claimText: string;
}

export interface RankingAdviceStateRequest {
  readonly taskSummary: string;
  readonly pathPrefixes: readonly string[];
  readonly candidates: readonly RankingAdviceStateCandidate[];
}

export interface RankingAdviceStateBuilt {
  readonly ok: true;
  /** Exact JSON string sent as the decision `state`. */
  readonly stateJson: string;
  /** SHA-256 hex digest of `stateJson`. */
  readonly stateSha256: string;
  /** Question keys `k0..kn` in candidate order. */
  readonly keys: readonly string[];
  /** Question key → candidate id. */
  readonly idsByKey: Readonly<Record<string, string>>;
  /** Criteria levels, least → most relevant. */
  readonly criteria: readonly string[];
}

export interface RankingAdviceStateRefused {
  readonly ok: false;
  readonly reason: 'redaction-refused';
  /** Internal detail; never sent anywhere and never contains field content. */
  readonly detail: string;
}

export type RankingAdviceState = RankingAdviceStateBuilt | RankingAdviceStateRefused;

/**
 * Name the first declared field that fails the kernel's rules, without
 * repeating any of its content: a field over its own cap, a field matching a
 * secret pattern, or the running total over the total cap. The kernel refuses
 * the whole state; this only explains which declaration to shorten or drop.
 */
function refusalDetail(fields: readonly { name: string; value: string }[]): string {
  const encoder = new TextEncoder();
  let total = 0;
  for (const field of fields) {
    const bytes = encoder.encode(field.value).length;
    if (bytes > MAX_STATE_FIELD_BYTES) {
      return `field ${field.name} exceeds the ${MAX_STATE_FIELD_BYTES}-byte cap`;
    }
    total += bytes;
    if (total > MAX_STATE_TOTAL_BYTES) {
      return `total declared state exceeds the ${MAX_STATE_TOTAL_BYTES}-byte cap at field ${field.name}`;
    }
    if (containsSecretShape(field.value)) {
      return `field ${field.name} matches a secret pattern`;
    }
  }
  return 'declared state matches a secret pattern';
}

/**
 * Build the decision state from declared fields only. Returns either the
 * built state with its digest and key mapping or a refusal. Never throws and
 * never includes field content in any returned value.
 */
export function buildRankingAdviceState(req: RankingAdviceStateRequest): RankingAdviceState {
  if (!req || typeof req !== 'object') {
    return {
      ok: false,
      reason: 'redaction-refused',
      detail: 'ranking advice request is missing',
    };
  }
  if (typeof req.taskSummary !== 'string') {
    return { ok: false, reason: 'redaction-refused', detail: 'taskSummary is not a string' };
  }
  if (!Array.isArray(req.pathPrefixes) || req.pathPrefixes.some((p) => typeof p !== 'string')) {
    return { ok: false, reason: 'redaction-refused', detail: 'pathPrefixes is not a string array' };
  }
  if (
    !Array.isArray(req.candidates) ||
    req.candidates.some(
      (c) =>
        !c ||
        typeof c !== 'object' ||
        typeof c.id !== 'string' ||
        c.id.length === 0 ||
        typeof c.claimText !== 'string',
    )
  ) {
    return {
      ok: false,
      reason: 'redaction-refused',
      detail: 'candidates are not {id, claimText} records',
    };
  }

  // Declared fields only: taskSummary, pathPrefixes, each candidate claimText.
  const fields: Array<{ name: string; value: string }> = [
    { name: 'taskSummary', value: req.taskSummary },
  ];
  req.pathPrefixes.forEach((prefix, index) => {
    fields.push({ name: `pathPrefixes[${index}]`, value: prefix });
  });
  req.candidates.forEach((candidate, index) => {
    fields.push({ name: `candidates.k${index}`, value: candidate.claimText });
  });
  const declared: Record<string, string> = {};
  for (const field of fields) {
    declared[field.name] = field.value;
  }

  // The kernel decides whether any of this may leave the host.
  if (!buildDecisionState(declared, STATE_CAPS, sha256Hex).ok) {
    return {
      ok: false,
      reason: 'redaction-refused',
      detail: refusalDetail(fields),
    };
  }

  const keys = req.candidates.map((_, index) => `k${index}`);
  const idsByKey: Record<string, string> = {};
  const claimByKey: Record<string, string> = {};
  req.candidates.forEach((candidate, index) => {
    idsByKey[keys[index]] = candidate.id;
    claimByKey[keys[index]] = candidate.claimText;
  });

  const stateJson = JSON.stringify({
    taskSummary: req.taskSummary,
    pathPrefixes: [...req.pathPrefixes],
    candidates: claimByKey,
  });

  return {
    ok: true,
    stateJson,
    stateSha256: sha256Hex(stateJson),
    keys,
    idsByKey,
    criteria: [...JEV_CRITERIA_LEVELS],
  };
}

/** Inputs a ranking `contextRef` is derived from; the lane is optional. */
export interface RankingContextRefRequest {
  /** The lane the brief is for, e.g. `lane-d5b`; absent scopes unscoped. */
  readonly laneId?: string;
  readonly taskSummary: string;
  readonly candidates: readonly RankingAdviceStateCandidate[];
}

/**
 * `ranking:<laneId>:<sha256>` — the stable per-consumer reference a receipt,
 * its outcome line and a recorded selection all join on (plan §3). The digest
 * covers the sorted candidate entry ids and the task summary, so the same
 * inputs always produce the same reference regardless of the order the
 * candidates were retrieved in, and two lanes never collide.
 */
export function rankingContextRef(req: RankingContextRefRequest): string {
  const lane =
    typeof req.laneId === 'string' && req.laneId.trim().length > 0
      ? req.laneId.trim()
      : 'unscoped';
  const candidateIds = req.candidates.map((candidate) => candidate.id).sort();
  const digest = sha256Hex(JSON.stringify({ candidateIds, taskSummary: req.taskSummary }));
  return `ranking:${lane}:${digest}`;
}
