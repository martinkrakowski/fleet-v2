/**
 * DecisionTransportAdapter implements DecisionTransportPort over the existing
 * Waves signed-answer protocol boundary or an explicit owner-recorded local
 * decision file.
 *
 * An answer is read from an injected map or from `<decisionsDir>/<id>.json`.
 * Only an approved answer carrying a valid Ed25519 signature from the configured
 * owner public key is treated as an approval; an unsigned, invalidly signed,
 * absent, unreadable, malformed or grantless answer is reported as
 * `awaiting-decision` and is never upgraded to approval. Declined and awaiting
 * states require no signature. No credential or token is read or surfaced
 * through this adapter.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  DecisionAnswer,
  DecisionAnswerQuery,
  DecisionState,
  DecisionTransportPort,
} from '../../application/ports/out/DecisionTransportPort.out-port.js';
import { verifyDecisionSignature } from './DecisionSignature.adapter.js';
import type { WavesHttpClient } from './WavesHttpClient.adapter.js';

export interface DecisionTransportAdapterOptions {
  /** Directory of owner-recorded decision answers, one file per request. */
  readonly decisionsDir?: string;
  /** Answers recorded in process, taking precedence over files. */
  readonly answers?: Readonly<Record<string, DecisionAnswer>>;
  readonly fileExtension?: string;
  /** Owner Ed25519 public key in base64 format for verifying approved decisions. */
  readonly ownerPublicKey?: string;
  /**
   * A named owner-key refusal resolved by the composition root: when set, no
   * answer may be approved, whatever its signature.
   */
  readonly ownerKeyRefusal?: 'owner-key-env-mismatch' | 'owner-key-unpinned';
  /** Optional Waves HTTP client for fetching decision answers. */
  readonly client?: WavesHttpClient;
}

const DEFAULT_FILE_EXTENSION = '.json';
const DECISION_STATES: readonly string[] = ['approved', 'declined', 'awaiting-decision'];
/** Request ids become file names and HTTP path segments, so they may not carry path structure. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * A dot is a legal id character, but an id made only of dots resolves as a
 * relative path segment in a URL (`/api/v1/decisions/..` becomes `/api/v1/`),
 * so dot-only ids are refused like any other path structure.
 */
function isSafeRequestId(requestId: string): boolean {
  return SAFE_REQUEST_ID.test(requestId) && !/^[.]+$/.test(requestId);
}

const AWAITING: DecisionAnswer = {
  state: 'awaiting-decision',
  decisionRevision: null,
  grantId: null,
};

export class DecisionTransportAdapter implements DecisionTransportPort {
  constructor(private readonly options: DecisionTransportAdapterOptions = {}) {}

  async readDecisionAnswer(query: DecisionAnswerQuery): Promise<DecisionAnswer> {
    const { requestId } = query;
    // A request id that could carry path structure is refused before any
    // transport is consulted: it can never name a decision answer source.
    if (typeof requestId !== 'string' || !isSafeRequestId(requestId)) {
      return { ...AWAITING };
    }
    const injected = this.options.answers?.[requestId];
    if (injected !== undefined) {
      return normalizeAnswer(injected, query, this.options.ownerPublicKey, this.options.ownerKeyRefusal);
    }
    if (this.options.client !== undefined) {
      let candidate: unknown = null;
      try {
        // isSafeRequestId already refused ids with path structure (including
        // dot-only ids such as `..`), so the id cannot redirect the URL.
        const id = encodeURIComponent(requestId);
        const res = await this.options.client.get(`/api/v1/decisions/${id}`);
        if (res.status >= 200 && res.status < 300) {
          candidate = JSON.parse(res.body);
        }
      } catch {
        // network error, timeout, JSON parse error -> candidate remains null
      }
      if (candidate !== null) {
        return normalizeAnswer(candidate, query, this.options.ownerPublicKey, this.options.ownerKeyRefusal);
      }
    }
    const path = this.decisionPath(requestId);
    if (path === null) {
      return { ...AWAITING };
    }
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch {
      // An absent or unreadable answer is awaiting, never an approval.
      return { ...AWAITING };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return { ...AWAITING };
    }
    return normalizeAnswer(parsed, query, this.options.ownerPublicKey, this.options.ownerKeyRefusal);
  }

  private decisionPath(requestId: string): string | null {
    const { decisionsDir } = this.options;
    if (decisionsDir === undefined || decisionsDir.trim().length === 0) {
      return null;
    }
    if (typeof requestId !== 'string' || !isSafeRequestId(requestId)) {
      return null;
    }
    return join(decisionsDir, `${requestId}${this.options.fileExtension ?? DEFAULT_FILE_EXTENSION}`);
  }
}

/** Only a recognised state with a recorded grant is an answer; the rest awaits. */
function normalizeAnswer(
  candidate: unknown,
  query: DecisionAnswerQuery,
  ownerPublicKey?: string,
  ownerKeyRefusal?: 'owner-key-env-mismatch' | 'owner-key-unpinned',
): DecisionAnswer {
  // 1. Hostile-input inspection: own keys only, through descriptors.
  const ownKeys = inspectCandidateOwnKeys(candidate);
  if (ownKeys === null) {
    return { ...AWAITING };
  }
  if (candidateOwnFieldsAreAmbiguous(candidate as object, ownKeys, query)) {
    return { ...AWAITING };
  }
  // 2. Field parsing: state and the bounded optional fields.
  const answer = candidate as Partial<DecisionAnswer> & { signature?: unknown };
  const fields = parseAnswerFields(answer);
  if (fields === null) {
    return { ...AWAITING };
  }
  if (fields.state === 'declined') {
    return { state: fields.state, decisionRevision: fields.decisionRevision, grantId: null };
  }
  if (fields.state === 'approved') {
    // 3. Approval handling: refusal reason, grant, signature verification.
    return approveAnswer(fields, answer, query, ownerPublicKey, ownerKeyRefusal);
  }
  return { state: fields.state, decisionRevision: fields.decisionRevision, grantId: fields.grantId };
}

/**
 * Read a hostile candidate's own keys through `Reflect.ownKeys`, refusing
 * non-objects, arrays, and throwing traps. Returns `null` when the candidate
 * must be reported as awaiting. KEY0c2: a hostile candidate is inspected
 * through its own property descriptors before any field is read, so an
 * accessor never runs and a proxy trap is never invoked here.
 */
function inspectCandidateOwnKeys(candidate: unknown): PropertyKey[] | null {
  if (typeof candidate !== 'object' || candidate === null) {
    return null;
  }
  try {
    if (Array.isArray(candidate)) {
      return null;
    }
    return Reflect.ownKeys(candidate);
  } catch {
    return null;
  }
}

/**
 * Whether one own key is safe to skip. Returns `false` when the candidate
 * must be reported as awaiting: an accessor property (string OR symbol key —
 * a symbol key never bypasses descriptor inspection), an own
 * `requestId`/`actionScope`/`projectId` value that is present but not a
 * non-empty string (malformed — `null` and other non-strings are refused,
 * never silently dropped), or such a string that names a different
 * request, scope or project than the query. A symbol data key is skipped.
 */
function ownKeyIsBenign(
  candidate: object,
  key: PropertyKey,
  query: DecisionAnswerQuery,
): boolean {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(candidate, key);
  } catch {
    return false;
  }
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    return false;
  }
  if (typeof key !== 'string') {
    return true;
  }
  if (key !== 'requestId' && key !== 'actionScope' && key !== 'projectId') {
    return true;
  }
  // A present identity field must be a bounded non-empty string; `null` or
  // any other non-string is refused as malformed, not treated as absent.
  if (typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
    return false;
  }
  const expected =
    key === 'requestId'
      ? query.requestId
      : key === 'actionScope'
        ? query.actionScope
        : key === 'projectId'
          ? query.projectId
          : undefined;
  return expected === undefined || descriptor.value === expected;
}

/**
 * Whether any of the candidate's own string identity fields names a different
 * request, scope or project than the query: such an answer is ambiguous and
 * is reported as awaiting, never upgraded to an approval.
 */
function candidateOwnFieldsAreAmbiguous(
  candidate: object,
  ownKeys: PropertyKey[],
  query: DecisionAnswerQuery,
): boolean {
  for (const key of ownKeys) {
    if (!ownKeyIsBenign(candidate, key, query)) {
      return true;
    }
  }
  return false;
}

/** The recognised state and the bounded optional fields parsed from one answer. */
interface ParsedAnswerFields {
  readonly state: DecisionState;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
}

/** Parse `state`, `decisionRevision` and `grantId`, or return `null` to await. */
function parseAnswerFields(
  answer: Partial<DecisionAnswer> & { signature?: unknown },
): ParsedAnswerFields | null {
  if (typeof answer.state !== 'string' || !DECISION_STATES.includes(answer.state)) {
    return null;
  }
  const state = answer.state as DecisionState;
  const decisionRevision =
    typeof answer.decisionRevision === 'string' && answer.decisionRevision.trim().length > 0
      ? answer.decisionRevision.trim()
      : null;
  const grantId =
    typeof answer.grantId === 'string' && answer.grantId.trim().length > 0
      ? answer.grantId.trim()
      : null;
  return { state, decisionRevision, grantId };
}

/**
 * Handle one `approved` answer: the pinned-key refusal is checked before the
 * grantless-answer fallback so its named reason is surfaced, not lost to
 * AWAITING; an approval without a recorded grant authorizes nothing; and only
 * a signature that verifies against the pinned owner key is returned as
 * `approved`.
 */
function approveAnswer(
  fields: ParsedAnswerFields,
  answer: Partial<DecisionAnswer> & { signature?: unknown },
  query: DecisionAnswerQuery,
  ownerPublicKey: string | undefined,
  ownerKeyRefusal: 'owner-key-env-mismatch' | 'owner-key-unpinned' | undefined,
): DecisionAnswer {
  if (
    ownerKeyRefusal === 'owner-key-env-mismatch' ||
    ownerKeyRefusal === 'owner-key-unpinned'
  ) {
    return {
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
      refusalReason: ownerKeyRefusal,
    };
  }
  if (fields.grantId === null) {
    return { ...AWAITING };
  }
  if (
    ownerPublicKey === undefined ||
    ownerPublicKey.trim().length === 0 ||
    typeof answer.signature !== 'string' ||
    answer.signature.trim().length === 0
  ) {
    return { ...AWAITING };
  }
  const verified = verifyDecisionSignature(
    {
      requestId: query.requestId,
      projectId: query.projectId,
      actionScope: query.actionScope,
      expectedHeadSha: query.expectedHeadSha,
      decisionRevision: fields.decisionRevision,
      grantId: fields.grantId,
      state: fields.state,
    },
    answer.signature.trim(),
    ownerPublicKey.trim(),
  );
  if (!verified) {
    return { ...AWAITING };
  }
  return { state: fields.state, decisionRevision: fields.decisionRevision, grantId: fields.grantId };
}
