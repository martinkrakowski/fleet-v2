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

export interface DecisionTransportAdapterOptions {
  /** Directory of owner-recorded decision answers, one file per request. */
  readonly decisionsDir?: string;
  /** Answers recorded in process, taking precedence over files. */
  readonly answers?: Readonly<Record<string, DecisionAnswer>>;
  readonly fileExtension?: string;
  /** Owner Ed25519 public key in base64 format for verifying approved decisions. */
  readonly ownerPublicKey?: string;
}

const DEFAULT_FILE_EXTENSION = '.json';
const DECISION_STATES: readonly string[] = ['approved', 'declined', 'awaiting-decision'];
/** Request ids become file names, so they may not carry path structure. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

const AWAITING: DecisionAnswer = {
  state: 'awaiting-decision',
  decisionRevision: null,
  grantId: null,
};

export class DecisionTransportAdapter implements DecisionTransportPort {
  constructor(private readonly options: DecisionTransportAdapterOptions = {}) {}

  async readDecisionAnswer(query: DecisionAnswerQuery): Promise<DecisionAnswer> {
    const { requestId } = query;
    const injected = this.options.answers?.[requestId];
    if (injected !== undefined) {
      return normalizeAnswer(injected, query, this.options.ownerPublicKey);
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
    return normalizeAnswer(parsed, query, this.options.ownerPublicKey);
  }

  private decisionPath(requestId: string): string | null {
    const { decisionsDir } = this.options;
    if (decisionsDir === undefined || decisionsDir.trim().length === 0) {
      return null;
    }
    if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) {
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
): DecisionAnswer {
  if (typeof candidate !== 'object' || candidate === null) {
    return { ...AWAITING };
  }
  const answer = candidate as Partial<DecisionAnswer> & { signature?: unknown };
  if (typeof answer.state !== 'string' || !DECISION_STATES.includes(answer.state)) {
    return { ...AWAITING };
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
  if (state === 'approved' && grantId === null) {
    // An approval without a recorded grant authorizes nothing.
    return { ...AWAITING };
  }
  if (state === 'declined') {
    return { state, decisionRevision, grantId: null };
  }
  if (state === 'approved') {
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
        decisionRevision,
        grantId,
        state,
      },
      answer.signature.trim(),
      ownerPublicKey.trim(),
    );
    if (!verified) {
      return { ...AWAITING };
    }
  }
  return { state, decisionRevision, grantId };
}
