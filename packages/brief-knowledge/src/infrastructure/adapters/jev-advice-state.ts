// Implemented for lane D2 (decision port plan, 2026-10-16).
/**
 * Builds the advisory ranking decision state from the declared fields only:
 * `taskSummary`, `pathPrefixes` and each candidate's `claimText` (keyed
 * `k0..kn`, mapped back to candidate ids). Nothing else — never
 * `dispositionReason`, `checks` or `reuses` — leaves the host through this
 * state. Before any transport runs, every field is scanned against
 * SECRET_PATTERNS and size caps (8 KiB per field, 32 KiB total); a pattern hit
 * or an over-cap field refuses the state (`redaction-refused`), it is never
 * redacted and sent. The SHA-256 of the exact serialized state string is
 * returned so every answer — live or owner-recorded — is bound to the state
 * it answers.
 */

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { SECRET_PATTERNS } from './KeeperPublicationAdapter.adapter.js';
import { JEV_CRITERIA_LEVELS } from './jev-advice-validator.js';

/** Maximum size of one declared field, in bytes. */
export const MAX_STATE_FIELD_BYTES = 8 * 1024;
/** Maximum total size of all declared fields, in bytes. */
export const MAX_STATE_TOTAL_BYTES = 32 * 1024;

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

function fieldOverCap(name: string, value: string, total: number): RankingAdviceStateRefused | null {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_STATE_FIELD_BYTES) {
    return {
      ok: false,
      reason: 'redaction-refused',
      detail: `field ${name} exceeds the ${MAX_STATE_FIELD_BYTES}-byte cap`,
    };
  }
  if (total + bytes > MAX_STATE_TOTAL_BYTES) {
    return {
      ok: false,
      reason: 'redaction-refused',
      detail: `total declared state exceeds the ${MAX_STATE_TOTAL_BYTES}-byte cap at field ${name}`,
    };
  }
  return null;
}

function fieldMatchesSecretPattern(name: string): RankingAdviceStateRefused {
  return {
    ok: false,
    reason: 'redaction-refused',
    detail: `field ${name} matches a secret pattern`,
  };
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

  let total = 0;
  for (const field of fields) {
    const overCap = fieldOverCap(field.name, field.value, total);
    if (overCap) return overCap;
    total += Buffer.byteLength(field.value, 'utf8');
    if (SECRET_PATTERNS.some((pattern) => pattern.test(field.value))) {
      return fieldMatchesSecretPattern(field.name);
    }
  }

  const keys = req.candidates.map((_, index) => `k${index}`);
  const idsByKey: Record<string, string> = {};
  req.candidates.forEach((candidate, index) => {
    idsByKey[keys[index]] = candidate.id;
  });

  const stateJson = JSON.stringify({
    taskSummary: req.taskSummary,
    pathPrefixes: [...req.pathPrefixes],
    candidates: Object.fromEntries(req.candidates.map((c, i) => [`k${i}`, c.claimText])),
  });
  const stateSha256 = createHash('sha256').update(stateJson, 'utf8').digest('hex');

  return {
    ok: true,
    stateJson,
    stateSha256,
    keys,
    idsByKey,
    criteria: [...JEV_CRITERIA_LEVELS],
  };
}
