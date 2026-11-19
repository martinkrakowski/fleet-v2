/**
 * KEY0c1a test fixture for the work-execution suites: an ephemeral Ed25519
 * owner signer for seeded release owner grants. The keypair is generated
 * in-process with `node:crypto` — no real or production key is ever used —
 * and every approved answer is signed over the exact canonical decision
 * bytes the `DecisionTransportAdapter` re-exports from
 * `@fleet/operator-coordination` verify.
 *
 * A test seeds its `release:*` owner grant, writes the signed answer derived
 * from the record (`writeApprovedAnswer`), spreads `deps` into every
 * `ResolveActionAuthorizationUseCase` and `RecordAuthorizationConsumptionUseCase`
 * construction, and runs `assertApprovedAnswerReadsBackApproved` — a
 * self-check that reads the answer back through a real adapter configured
 * with the pinned ephemeral key and asserts it verifies to `approved` with
 * the record's own grant id and decision revision. Without it a wrong
 * signature would pass unnoticed, because origin/main never reads the answer
 * for an already-approved record.
 */

import { generateKeyPairSync, sign as signWithPrivateKey } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect } from 'vitest';

import type {
  CoordinationRequestRecord,
  DecisionAnswer,
  DecisionTransportPort,
} from '@fleet/operator-coordination';
import {
  canonicalDecisionBytes,
  DecisionTransportAdapter,
} from '@fleet/operator-coordination';

/** The fields of a record an owner answer is derived from and signed over. */
export type SignedDecisionRecord = Pick<
  CoordinationRequestRecord,
  'id' | 'projectId' | 'actionScope' | 'expectedHeadSha' | 'decisionRevision' | 'grantId'
>;

export interface SignedDecisionFixtureOptions {
  /**
   * Directory the answers are recorded in, one file per request id. When
   * omitted the answers are kept in process, so a transport with no
   * `decisionsDir` is still a signed one.
   */
  readonly decisionsDir?: string;
}

export interface SignedDecisionFixture {
  /** The raw 32-byte owner public key, base64, to pin into the adapter. */
  readonly ownerPublicKey: string;
  /** Where the answers were written, when file-backed. */
  readonly decisionsDir: string | undefined;
  /**
   * Spread into the use-case constructions: `{ requestRepo, ...fixture.deps }`.
   * `decisionTransport` typechecks today on the resolve use case only; the
   * consumption use case gains it in the mandatory-transport switch.
   */
  readonly deps: { readonly decisionTransport: DecisionTransportPort };
  /** The signed answer derived from the record, without recording it. */
  signApprovedAnswer(record: SignedDecisionRecord): DecisionAnswer;
  /** Derives the answer from the record and records it for the transport. */
  writeApprovedAnswer(record: SignedDecisionRecord): Promise<void>;
  /**
   * Self-check: reads the answer back through a real adapter pinned to the
   * fixture key and asserts it verifies to `approved` carrying exactly the
   * record's grant id and decision revision.
   */
  assertApprovedAnswerReadsBackApproved(record: SignedDecisionRecord): Promise<void>;
}

export function createSignedDecisionFixture(
  options: SignedDecisionFixtureOptions = {},
): SignedDecisionFixture {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // The SPKI DER wrapper is the fixed 12-byte prefix; the raw key follows.
  const ownerPublicKey = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }))
    .subarray(12)
    .toString('base64');
  const decisionsDir = options.decisionsDir;
  const answers: Record<string, DecisionAnswer> = {};

  const signApprovedAnswer = (record: SignedDecisionRecord): DecisionAnswer => {
    const bytes = canonicalDecisionBytes({
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha ?? null,
      decisionRevision: record.decisionRevision ?? null,
      grantId: record.grantId ?? null,
      state: 'approved',
    });
    return {
      state: 'approved',
      decisionRevision: record.decisionRevision ?? null,
      grantId: record.grantId ?? null,
      signature: signWithPrivateKey(null, bytes, privateKey).toString('base64'),
    };
  };

  const writeApprovedAnswer = async (record: SignedDecisionRecord): Promise<void> => {
    const answer = signApprovedAnswer(record);
    if (decisionsDir === undefined) {
      answers[record.id] = answer;
      return;
    }
    await mkdir(decisionsDir, { recursive: true });
    await writeFile(join(decisionsDir, `${record.id}.json`), JSON.stringify(answer));
  };

  const transport = new DecisionTransportAdapter({
    ownerPublicKey,
    ...(decisionsDir === undefined ? { answers } : { decisionsDir }),
  });

  const assertApprovedAnswerReadsBackApproved = async (
    record: SignedDecisionRecord,
  ): Promise<void> => {
    const answer = await new DecisionTransportAdapter({
      ownerPublicKey,
      ...(decisionsDir === undefined ? { answers } : { decisionsDir }),
    }).readDecisionAnswer({
      requestId: record.id,
      projectId: record.projectId,
      actionScope: record.actionScope,
      expectedHeadSha: record.expectedHeadSha ?? null,
    });
    expect(answer).toEqual({
      state: 'approved',
      decisionRevision: record.decisionRevision ?? null,
      grantId: record.grantId ?? null,
    });
  };

  return {
    ownerPublicKey,
    decisionsDir,
    deps: { decisionTransport: transport },
    signApprovedAnswer,
    writeApprovedAnswer,
    assertApprovedAnswerReadsBackApproved,
  };
}
