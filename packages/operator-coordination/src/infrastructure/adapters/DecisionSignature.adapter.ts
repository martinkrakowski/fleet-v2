import { createPublicKey, verify } from 'node:crypto';

export interface CanonicalDecisionFields {
  readonly requestId: string;
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
  readonly state: string;
}

/** Canonical base64 only: no whitespace, no URL alphabet, correct padding. */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeCanonicalBase64(value: string, expectedLength: number): Buffer | null {
  if (!CANONICAL_BASE64.test(value) || value.length % 4 !== 0) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== value) {
    return null;
  }
  return decoded;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Returns the UTF-8 bytes of JSON.stringify of an object with exactly:
 * { requestId, projectId, actionScope, expectedHeadSha, decisionRevision, grantId, state }
 * in that exact order (null kept as null).
 */
export function canonicalDecisionBytes(fields: CanonicalDecisionFields): Buffer {
  const canonical = {
    requestId: fields.requestId,
    projectId: fields.projectId,
    actionScope: fields.actionScope,
    expectedHeadSha: fields.expectedHeadSha ?? null,
    decisionRevision: fields.decisionRevision ?? null,
    grantId: fields.grantId ?? null,
    state: fields.state,
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

/**
 * Verifies an Ed25519 signature over canonical decision bytes using the raw 32-byte
 * owner public key (base64). Raw key must decode to exactly 32 bytes and signature
 * to exactly 64 bytes. Any throw or mismatch returns false.
 */
export function verifyDecisionSignature(
  fields: CanonicalDecisionFields,
  signatureBase64: unknown,
  publicKeyBase64: string,
): boolean {
  try {
    if (typeof signatureBase64 !== 'string' || typeof publicKeyBase64 !== 'string') {
      return false;
    }
    const rawKey = decodeCanonicalBase64(publicKeyBase64, 32);
    if (rawKey === null) {
      return false;
    }
    const sig = decodeCanonicalBase64(signatureBase64, 64);
    if (sig === null) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    const bytes = canonicalDecisionBytes(fields);
    return verify(null, bytes, key, sig);
  } catch {
    return false;
  }
}
