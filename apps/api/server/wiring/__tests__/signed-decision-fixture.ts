/**
 * KEY0c1b: per-package test helper for the signed-answer fixture migration.
 *
 * Every test fixture that seeds an `approved` owner grant builds the answer's
 * canonical payload through `@fleet/operator-coordination`'s exported
 * `canonicalDecisionBytes` builder (DecisionSignature.adapter) and signs it
 * with an ephemeral in-process Ed25519 keypair (`node:crypto`), under the
 * same raw 32-byte base64 `ownerPublicKey` the runtime under test pins. No
 * credential or production key is ever involved: each keypair is generated in
 * this process and thrown away with it.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalDecisionBytes } from '@fleet/operator-coordination';
import type { DecisionAnswerQuery } from '@fleet/operator-coordination';

/** The canonical fields one approved answer is signed over. */
export interface SignedAnswerFields {
  readonly requestId: string;
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
  readonly state: 'approved';
}

/** An in-process Ed25519 keypair; the public key is the raw 32-byte base64 the verifier expects. */
export interface EphemeralOwnerKey {
  readonly ownerPublicKey: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}

/** Generates one ephemeral owner keypair in-process. */
export function ephemeralOwnerKey(): EphemeralOwnerKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    ownerPublicKey: publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(12)
      .toString('base64'),
    privateKey,
  };
}

/** The answer fields signed over for an `approved` recorded owner grant. */
export function approvedAnswerFields(record: {
  readonly id: string;
  readonly projectId: string;
  readonly actionScope: string;
  readonly expectedHeadSha: string | null;
  readonly decisionRevision: string | null;
  readonly grantId: string | null;
}): SignedAnswerFields {
  return {
    requestId: record.id,
    projectId: record.projectId,
    actionScope: record.actionScope,
    expectedHeadSha: record.expectedHeadSha ?? null,
    decisionRevision: record.decisionRevision ?? null,
    grantId: record.grantId ?? null,
    state: 'approved',
  };
}

/** The owner's Ed25519 signature over `canonicalDecisionBytes(fields)`. */
export function signedAnswerSignature(fields: SignedAnswerFields, key: EphemeralOwnerKey): string {
  return sign(null, canonicalDecisionBytes(fields), key.privateKey).toString('base64');
}

/** Writes the owner's signed approved answer to `<stateDir>/decisions/<requestId>.json`. */
export function writeSignedAnswer(
  stateDir: string,
  fields: SignedAnswerFields,
  key: EphemeralOwnerKey,
): void {
  const signature = signedAnswerSignature(fields, key);
  mkdirSync(join(stateDir, 'decisions'), { recursive: true });
  writeFileSync(
    join(stateDir, 'decisions', `${fields.requestId}.json`),
    `${JSON.stringify({ ...fields, signature }, null, 2)}\n`,
  );
}

/**
 * Self-check: the answer reads back as `approved` with the record's `grantId`
 * and `decisionRevision` through the given transport — the `decisionTransport`
 * in the deps of the operator composition's `resolveActionAuthorization` use
 * case. A fixture whose runtime was configured without the pinned key or the
 * right decisions directory fails here, not only when KEY0c2 enforces
 * re-verification.
 */
export async function expectApprovedAnswerReadableThrough(
  transport: {
    readDecisionAnswer(query: DecisionAnswerQuery): Promise<{
      state: string;
      grantId: string | null;
      decisionRevision: string | null;
    }>;
  },
  fields: SignedAnswerFields,
): Promise<void> {
  const answer = await transport.readDecisionAnswer({
    requestId: fields.requestId,
    projectId: fields.projectId,
    actionScope: fields.actionScope,
    expectedHeadSha: fields.expectedHeadSha,
  });
  if (
    answer.state !== 'approved' ||
    answer.grantId !== fields.grantId ||
    answer.decisionRevision !== fields.decisionRevision
  ) {
    throw new Error(
      `signed-decision-fixture self-check failed for request ${fields.requestId}: ` +
        `transport reported ${answer.state} with grantId ${String(answer.grantId)} ` +
        `and decisionRevision ${String(answer.decisionRevision)}`,
    );
  }
}
