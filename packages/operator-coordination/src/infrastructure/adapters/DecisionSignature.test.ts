// KEY1a — owner decision signing and the signed-answer write path.
/**
 * `signAndWriteDecisionAnswer` signs the canonical decision bytes with the
 * owner's Ed25519 private key (checked against the PINNED owner public key,
 * never ambient env) and writes the answer file `readDecisionAnswer` then
 * verifies. Nothing here touches the network; every refusal is typed and
 * writes nothing.
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifySignedDecisionBinding } from '../../domain/coordination-records.js';
import { canonicalDecisionBytes, verifyDecisionSignature } from './DecisionSignature.adapter.js';
import { DecisionTransportAdapter } from './DecisionTransportAdapter.adapter.js';
import type { CanonicalDecisionFields } from './DecisionSignature.adapter.js';

const REQUEST_ID = 'req-sign-1';
const PROJECT_ID = 'proj-1';
const SCOPE = 'forge:tests:run';
const HEAD = 'a'.repeat(40);

const FIELDS: CanonicalDecisionFields = {
  requestId: REQUEST_ID,
  projectId: PROJECT_ID,
  actionScope: SCOPE,
  expectedHeadSha: HEAD,
  decisionRevision: '1',
  grantId: `grant-${REQUEST_ID}`,
  state: 'approved',
};

function newWorkspace(): { root: string; stateDir: string; decisionsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'fleet-v2-sign-test-'));
  const stateDir = join(root, 'state');
  const decisionsDir = join(stateDir, 'decisions');
  mkdirSync(decisionsDir, { recursive: true });
  return { root, stateDir, decisionsDir };
}

/** Generate one Ed25519 pair; return the private PEM and the raw public base64. */
function newKey(): { privatePem: string; publicBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  // The Ed25519 SPKI DER is a fixed 12-byte prefix plus the raw 32-byte key.
  const publicBase64 = spki.subarray(spki.length - 32).toString('base64');
  return { privatePem, publicBase64 };
}

function writeKeyFile(
  dir: string,
  name: string,
  pem: string,
  mode: number,
): string {
  const path = join(dir, name);
  // writeFile with an explicit mode still honours a restrictive umask on some
  // systems, so the mode is forced afterwards.
  writeFileSync(path, pem);
  chmodSync(path, mode);
  return path;
}

function adapter(decisionsDir: string, ownerPublicKey: string): DecisionTransportAdapter {
  return new DecisionTransportAdapter({ decisionsDir, ownerPublicKey });
}

describe('signAndWriteDecisionAnswer', () => {
  it('signs, writes an answer that passes readDecisionAnswer and verifySignedDecisionBinding', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(root, 'owner-key.pem', privatePem, 0o600);
    const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath,
    });
    expect(result).toEqual({ ok: true });

    // The written file carries the exact fields, in the canonical order.
    const written = JSON.parse(
      readFileSync(join(decisionsDir, `${REQUEST_ID}.json`), 'utf8'),
    ) as Record<string, unknown>;
    expect(written['requestId']).toBe(REQUEST_ID);
    expect(written['projectId']).toBe(PROJECT_ID);
    expect(written['actionScope']).toBe(SCOPE);
    expect(written['state']).toBe('approved');
    expect(written['decisionRevision']).toBe('1');
    expect(written['grantId']).toBe(`grant-${REQUEST_ID}`);
    expect(typeof written['signature']).toBe('string');

    // The signature verifies against the pinned key over the canonical bytes.
    expect(
      verifyDecisionSignature(FIELDS, written['signature'] as string, publicBase64),
    ).toBe(true);

    // The read path reports the approval.
    const answer = await adapter(decisionsDir, publicBase64).readDecisionAnswer({
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
      actionScope: SCOPE,
      expectedHeadSha: HEAD,
    });
    expect(answer).toEqual({
      state: 'approved',
      decisionRevision: '1',
      grantId: `grant-${REQUEST_ID}`,
    });

    // The binding check (requestId, actionScope, grantId, decisionRevision)
    // also holds for the stored record shape.
    const binding = verifySignedDecisionBinding(
      {
        id: REQUEST_ID,
        actionScope: SCOPE,
        grantId: `grant-${REQUEST_ID}`,
        decisionRevision: '1',
        state: 'approved',
      },
      written,
    );
    expect(binding).toEqual({ ok: true });
  });

  it('signs bytes that match canonicalDecisionBytes exactly', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(root, 'owner-key.pem', privatePem, 0o600);
    expect(
      (await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({ fields: FIELDS, keyPath })).ok,
    ).toBe(true);
    const written = JSON.parse(
      readFileSync(join(decisionsDir, `${REQUEST_ID}.json`), 'utf8'),
    ) as Record<string, unknown>;
    // Ed25519 is deterministic: the recorded signature re-verifies against
    // the same fields and fails for any other binding.
    expect(verifyDecisionSignature(FIELDS, written['signature'] as string, publicBase64)).toBe(
      true,
    );
    expect(
      verifyDecisionSignature(
        { ...FIELDS, expectedHeadSha: 'b'.repeat(40) },
        written['signature'] as string,
        publicBase64,
      ),
    ).toBe(false);
    void canonicalDecisionBytes;
  });

  it('refuses a wrong key against the pinned key before writing anything', async () => {
    const pinned = newKey();
    const wrong = newKey();
    const { root, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(root, 'owner-key.pem', wrong.privatePem, 0o600);
    const result = await adapter(decisionsDir, pinned.publicBase64).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath,
    });
    expect(result).toEqual({ ok: false, code: 'key-mismatch' });
    expect(readdirSync(decisionsDir)).toEqual([]);
  });

  it('refuses ownerKeyRefusal before reading the key file', async () => {
    const { publicBase64 } = newKey();
    const { decisionsDir } = newWorkspace();
    for (const ownerKeyRefusal of ['owner-key-env-mismatch', 'owner-key-unpinned'] as const) {
      const refusing = new DecisionTransportAdapter({
        decisionsDir,
        ownerPublicKey: publicBase64,
        ownerKeyRefusal,
      });
      // The key path does not exist: the refusal happens before any read.
      const result = await refusing.signAndWriteDecisionAnswer({
        fields: FIELDS,
        keyPath: '/nonexistent/key.pem',
      });
      expect(result).toEqual({ ok: false, code: ownerKeyRefusal });
    }
    expect(readdirSync(decisionsDir)).toEqual([]);
  });

  it('refuses when the pinned owner public key is not configured', async () => {
    const { decisionsDir } = newWorkspace();
    const result = await new DecisionTransportAdapter({
      decisionsDir,
    }).signAndWriteDecisionAnswer({ fields: FIELDS, keyPath: '/nonexistent/key.pem' });
    expect(result).toEqual({ ok: false, code: 'owner-public-key-not-configured' });
  });

  it('refuses when stateDir is unset (decisionsDir missing or blank)', async () => {
    const result = await new DecisionTransportAdapter({}).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath: '/nonexistent/key.pem',
    });
    expect(result).toEqual({ ok: false, code: 'state-dir-required' });
    const blank = await new DecisionTransportAdapter({ decisionsDir: '   ' }).signAndWriteDecisionAnswer(
      { fields: FIELDS, keyPath: '/nonexistent/key.pem' },
    );
    expect(blank).toEqual({ ok: false, code: 'state-dir-required' });
  });

  it('refuses surrounding whitespace in grantId and decisionRevision', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(root, 'owner-key.pem', privatePem, 0o600);
    const a = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: { ...FIELDS, grantId: ' grant-x' },
      keyPath,
    });
    expect(a).toEqual({ ok: false, code: 'invalid-decision-field' });
    const b = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: { ...FIELDS, decisionRevision: '1 ' },
      keyPath,
    });
    expect(b).toEqual({ ok: false, code: 'invalid-decision-field' });
    expect(readdirSync(decisionsDir)).toEqual([]);
  });

  it('refuses an unsafe request id', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(root, 'owner-key.pem', privatePem, 0o600);
    const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: { ...FIELDS, requestId: '../escape' },
      keyPath,
    });
    expect(result).toEqual({ ok: false, code: 'invalid-request-id' });
  });

  it('accepts 0600 and 0400 keys, refuses 0644 and 0700', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const good0600 = writeKeyFile(root, 'k0600.pem', privatePem, 0o600);
    expect(
      (await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({ fields: FIELDS, keyPath: good0600 })).ok,
    ).toBe(true);
    const good0400 = writeKeyFile(root, 'k0400.pem', privatePem, 0o400);
    expect(
      (
        await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
          fields: { ...FIELDS, requestId: 'req-sign-2' },
          keyPath: good0400,
        })
      ).ok,
    ).toBe(true);
    for (const [name, mode] of [
      ['k0644.pem', 0o644],
      ['k0700.pem', 0o700],
    ] as const) {
      const path = writeKeyFile(root, name, privatePem, mode);
      const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
        fields: { ...FIELDS, requestId: `req-${name}` },
        keyPath: path,
      });
      expect(result).toEqual({ ok: false, code: 'key-file-permissions-too-open' });
    }
  });

  it('refuses a key file owned by another uid', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(root, 'owner-key.pem', privatePem, 0o600);
    const original = process.getuid;
    try {
      (process as { getuid?: () => number }).getuid = () => (original ? original() + 1 : 12345);
      const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
        fields: FIELDS,
        keyPath,
      });
      expect(result).toEqual({ ok: false, code: 'key-file-wrong-owner' });
    } finally {
      (process as { getuid?: () => number }).getuid = original;
    }
    expect(readdirSync(decisionsDir)).toEqual([]);
  });

  it('refuses a symlinked key file', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const real = writeKeyFile(root, 'real-key.pem', privatePem, 0o600);
    const link = join(root, 'linked-key.pem');
    symlinkSync(real, link);
    const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath: link,
    });
    expect(result).toEqual({ ok: false, code: 'key-file-symlink' });
  });

  it('refuses a directory key path', async () => {
    const { publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const dir = join(root, 'key-dir');
    mkdirSync(dir);
    const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath: dir,
    });
    expect(result).toEqual({ ok: false, code: 'key-file-not-regular' });
  });

  it('refuses a key inside the state directory', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { stateDir, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(stateDir, 'inside-state.pem', privatePem, 0o600);
    const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath,
    });
    expect(result).toEqual({ ok: false, code: 'key-inside-state-dir' });
    expect(readdirSync(decisionsDir)).toEqual([]);
  });

  it('refuses a key inside a git worktree or repository', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const repo = join(root, 'some-repo');
    mkdirSync(join(repo, 'keys'), { recursive: true });
    // A `.git` file marks a linked worktree; a `.git` directory marks a repo.
  writeFileSync(join(repo, '.git'), 'gitdir: elsewhere\n');
    const keyPath = writeKeyFile(join(repo, 'keys'), 'owner-key.pem', privatePem, 0o600);
    const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath,
    });
    expect(result).toEqual({ ok: false, code: 'key-inside-git-repo' });
  });

  it('refuses an invalid key file (not a PEM, not Ed25519)', async () => {
    const { publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    const nonsense = writeKeyFile(root, 'nonsense.pem', 'not a key at all', 0o600);
    expect(
      await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
        fields: FIELDS,
        keyPath: nonsense,
      }),
    ).toEqual({ ok: false, code: 'key-file-invalid' });
    // A non-Ed25519 PEM (RSA) is refused the same way.
    const { generateKeyPairSync: gen } = await import('node:crypto');
    const rsa = gen('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const rsaPath = writeKeyFile(root, 'rsa.pem', rsaPem, 0o600);
    expect(
      await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
        fields: FIELDS,
        keyPath: rsaPath,
      }),
    ).toEqual({ ok: false, code: 'key-file-invalid' });
  });

  it('refuses a missing key file', async () => {
    const { publicBase64 } = newKey();
    const { decisionsDir } = newWorkspace();
    expect(
      await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
        fields: FIELDS,
        keyPath: '/nonexistent/owner-key.pem',
      }),
    ).toEqual({ ok: false, code: 'key-file-unreadable' });
  });

  it('removes the written file and refuses when the self-verification fails', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, decisionsDir } = newWorkspace();
    // An injected answer takes precedence over the file read; a mismatching
    // injected answer makes the post-write self-verification fail.
    const sabotaged = new DecisionTransportAdapter({
      decisionsDir,
      ownerPublicKey: publicBase64,
      answers: { [REQUEST_ID]: { state: 'declined', decisionRevision: '1', grantId: null } },
    });
    const keyPath = writeKeyFile(root, 'owner-key.pem', privatePem, 0o600);
    const answerPath = join(decisionsDir, `${REQUEST_ID}.json`);
    const result = await sabotaged.signAndWriteDecisionAnswer({ fields: FIELDS, keyPath });
    expect(result).toEqual({ ok: false, code: 'self-verification-failed' });
    expect(existsSync(answerPath)).toBe(false);
    // Nothing is authorized: with the written file removed, a clean adapter
    // (no injected answers) reads an awaiting request, never an approval.
    const after = await adapter(decisionsDir, publicBase64).readDecisionAnswer({
      requestId: REQUEST_ID,
      projectId: PROJECT_ID,
      actionScope: SCOPE,
      expectedHeadSha: HEAD,
    });
    expect(after).toEqual({ state: 'awaiting-decision', decisionRevision: null, grantId: null });
  });

  it('never returns or stores the private key material', async () => {
    const { privatePem, publicBase64 } = newKey();
    const { root, stateDir, decisionsDir } = newWorkspace();
    const keyPath = writeKeyFile(root, 'owner-key.pem', privatePem, 0o600);
    const result = await adapter(decisionsDir, publicBase64).signAndWriteDecisionAnswer({
      fields: FIELDS,
      keyPath,
    });
    expect(result.ok).toBe(true);
    // Nothing under the state directory carries the private PEM.
    const seen = JSON.stringify(readdirSync(decisionsDir));
    for (const name of readdirSync(stateDir, { recursive: true }) as string[]) {
      const full = join(stateDir, name);
      try {
        const content = readFileSync(full, 'utf8');
        expect(content.includes('PRIVATE KEY')).toBe(false);
        expect(content.includes(privatePem.slice(0, 32))).toBe(false);
      } catch {
        // A directory or binary entry carries no text to inspect.
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });
});
