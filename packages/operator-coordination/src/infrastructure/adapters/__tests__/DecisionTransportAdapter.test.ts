import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalDecisionBytes } from '../DecisionSignature.adapter.js';
import { DecisionTransportAdapter } from '../DecisionTransportAdapter.adapter.js';
import type { DecisionAnswerQuery } from '../../../application/ports/out/DecisionTransportPort.out-port.js';

function createOwnerKeyPair(): { publicKeyBase64: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    publicKeyBase64: raw32.toString('base64'),
    privateKey,
  };
}

function signDecision(
  fields: {
    requestId: string;
    projectId: string;
    actionScope: string;
    expectedHeadSha: string | null;
    decisionRevision: string | null;
    grantId: string | null;
    state: string;
  },
  privateKey: KeyObject,
): string {
  const bytes = canonicalDecisionBytes(fields);
  return sign(null, bytes, privateKey).toString('base64');
}

describe('DecisionTransportAdapter signature verification', () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-decisions-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const query: DecisionAnswerQuery = {
    requestId: 'req-1',
    projectId: 'proj-1',
    actionScope: 'forge:merge-pr',
    expectedHeadSha: 'sha-commit-1',
  };

  it('valid signed approval -> approved', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'approved',
      decisionRevision: 'rev-1',
      grantId: 'grant-1',
    });
  });

  it('unsigned approved via injected answers -> awaiting', async () => {
    const { publicKeyBase64 } = createOwnerKeyPair();
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('unsigned via decisionsDir file -> awaiting', async () => {
    const { publicKeyBase64 } = createOwnerKeyPair();
    const decisionsDir = await makeTempDir();
    await writeFile(
      join(decisionsDir, 'req-1.json'),
      JSON.stringify({
        state: 'approved',
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
      }),
      'utf8',
    );
    const adapter = new DecisionTransportAdapter({
      decisionsDir,
      ownerPublicKey: publicKeyBase64,
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('valid signed approval via decisionsDir file -> approved', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const decisionsDir = await makeTempDir();
    await writeFile(
      join(decisionsDir, 'req-1.json'),
      JSON.stringify({
        state: 'approved',
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        signature,
      }),
      'utf8',
    );
    const adapter = new DecisionTransportAdapter({
      decisionsDir,
      ownerPublicKey: publicKeyBase64,
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'approved',
      decisionRevision: 'rev-1',
      grantId: 'grant-1',
    });
  });

  it('signature made for another requestId -> awaiting', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        requestId: 'req-2',
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('signature made for another decisionRevision -> awaiting', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        decisionRevision: 'rev-different',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('signature made for another grantId -> awaiting', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        decisionRevision: 'rev-1',
        grantId: 'grant-different',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('signature made for another actionScope -> awaiting', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        actionScope: 'other:scope',
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('signature made for another expectedHeadSha -> awaiting', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        expectedHeadSha: 'sha-different-commit',
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('signature made for another projectId -> awaiting', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        projectId: 'proj-different',
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('no ownerPublicKey configured + signed answer -> awaiting', async () => {
    const { privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      // ownerPublicKey omitted
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('key of 31 bytes -> awaiting', async () => {
    const { privateKey } = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const keyOf31Bytes = Buffer.alloc(31).toString('base64');
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: keyOf31Bytes,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('garbage signature -> awaiting', async () => {
    const { publicKeyBase64 } = createOwnerKeyPair();
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature: 'this-is-not-a-valid-ed25519-signature-in-base64',
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('signed by a different key -> awaiting', async () => {
    const key1 = createOwnerKeyPair();
    const key2 = createOwnerKeyPair();
    const signature = signDecision(
      {
        ...query,
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      key2.privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: key1.publicKeyBase64,
      answers: {
        'req-1': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'awaiting-decision',
      decisionRevision: null,
      grantId: null,
    });
  });

  it('declined needs no signature', async () => {
    const adapter = new DecisionTransportAdapter({
      answers: {
        'req-1': {
          state: 'declined',
          decisionRevision: 'rev-declined',
          grantId: 'grant-ignored',
        },
      },
    });
    const result = await adapter.readDecisionAnswer(query);
    expect(result).toEqual({
      state: 'declined',
      decisionRevision: 'rev-declined',
      grantId: null,
    });
  });

  it('supports null expectedHeadSha when correctly signed', async () => {
    const { publicKeyBase64, privateKey } = createOwnerKeyPair();
    const nullHeadQuery: DecisionAnswerQuery = {
      requestId: 'req-relay',
      projectId: 'proj-1',
      actionScope: 'relay:notice',
      expectedHeadSha: null,
    };
    const signature = signDecision(
      {
        ...nullHeadQuery,
        decisionRevision: 'rev-1',
        grantId: 'grant-1',
        state: 'approved',
      },
      privateKey,
    );
    const adapter = new DecisionTransportAdapter({
      ownerPublicKey: publicKeyBase64,
      answers: {
        'req-relay': {
          state: 'approved',
          decisionRevision: 'rev-1',
          grantId: 'grant-1',
          signature,
        },
      },
    });
    const result = await adapter.readDecisionAnswer(nullHeadQuery);
    expect(result).toEqual({
      state: 'approved',
      decisionRevision: 'rev-1',
      grantId: 'grant-1',
    });
  });
});

describe("verifyDecisionSignature canonical base64", () => {
  it("refuses a valid signature written in a non-canonical base64 form", async () => {
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const { canonicalDecisionBytes: bytesOf, verifyDecisionSignature } = await import(
      "../DecisionSignature.adapter.js"
    );
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64");
    const fields = {
      requestId: "req-1",
      projectId: "proj-1",
      actionScope: "forge:merge-pr",
      expectedHeadSha: "a".repeat(40),
      decisionRevision: "r1",
      grantId: "g1",
      state: "approved",
    };
    const signature = sign(null, bytesOf(fields), privateKey).toString("base64");
    expect(verifyDecisionSignature(fields, signature, raw)).toBe(true);
    const urlAlphabet = signature.replace(/\+/g, "-").replace(/\//g, "_");
    const withSpace = `${signature.slice(0, 10)} ${signature.slice(10)}`;
    const unpadded = signature.replace(/=+$/, "");
    for (const variant of [withSpace, unpadded, ...(urlAlphabet !== signature ? [urlAlphabet] : [])]) {
      expect(verifyDecisionSignature(fields, variant, raw)).toBe(false);
    }
    expect(verifyDecisionSignature(fields, signature, ` ${raw}`)).toBe(false);
  });
});
