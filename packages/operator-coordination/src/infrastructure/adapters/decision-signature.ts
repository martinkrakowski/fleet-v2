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
    const rawKey = Buffer.from(publicKeyBase64, 'base64');
    if (rawKey.length !== 32) {
      return false;
    }
    const sig = Buffer.from(signatureBase64, 'base64');
    if (sig.length !== 64) {
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
