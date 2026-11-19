/**
 * KEY1b — `generateOwnerKeyFile` / `deriveOwnerPublicKeyFromFile` adapter
 * tests. Nothing here dispatches or touches the network; every key stays in
 * a throwaway temp directory.
 */

import { sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalDecisionBytes, verifyDecisionSignature } from './DecisionSignature.adapter.js';
import { deriveOwnerPublicKeyFromFile, generateOwnerKeyFile } from './OwnerKey.adapter.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-v2-owner-key-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('generateOwnerKeyFile', () => {
  it('writes the private key with 0600 permissions and returns the public key and installation edit', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    if (!result.ok) {
      throw new Error(`expected success, got ${result.code}`);
    }
    const stat = (await import('node:fs')).statSync(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(result.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(result.installationEdit).toBe(`{ "owner": { "publicKey": "${result.publicKey}" } }`);
    // The PEM on disk is a real Ed25519 private key whose public half matches.
    const derived = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(derived).toEqual({ ok: true, publicKey: result.publicKey });
  });

  it('refuses an existing file and leaves it untouched', async () => {
    const keyPath = join(root, 'existing.pem');
    writeFileSync(keyPath, 'ORIGINAL\n', { mode: 0o600 });
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('already-exists');
    }
    expect(readFileSync(keyPath, 'utf8')).toBe('ORIGINAL\n');
  });

  it('refuses a symlink at the target path', async () => {
    const realFile = join(root, 'real.pem');
    writeFileSync(realFile, 'x');
    const linkPath = join(root, 'link.pem');
    symlinkSync(realFile, linkPath);
    const result = await generateOwnerKeyFile({ outPath: linkPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('already-exists');
    }
    expect(readFileSync(realFile, 'utf8')).toBe('x');
  });

  it('refuses a path inside the state directory', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir);
    const result = await generateOwnerKeyFile({ outPath: join(stateDir, 'owner-key.pem'), stateDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-state-dir');
    }
  });

  it('refuses a path inside the state directory through a symlinked parent', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir);
    const link = join(root, 'state-link');
    symlinkSync(stateDir, link);
    const result = await generateOwnerKeyFile({ outPath: join(link, 'owner-key.pem'), stateDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-state-dir');
    }
  });

  it('refuses a path inside a git repository', async () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const result = await generateOwnerKeyFile({ outPath: join(repo, 'owner-key.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-git-repo');
    }
  });

  it('refuses a path inside a git worktree (.git file)', async () => {
    const worktree = join(root, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n');
    const result = await generateOwnerKeyFile({ outPath: join(worktree, 'owner-key.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-path-git-repo');
    }
  });

  it('refuses a missing parent directory', async () => {
    const result = await generateOwnerKeyFile({ outPath: join(root, 'missing-dir', 'owner-key.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('write-failed');
    }
  });

  it('never includes the private key in the result', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    if (!result.ok) {
      throw new Error(`expected success, got ${result.code}`);
    }
    const pem = readFileSync(keyPath, 'utf8');
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(result)).not.toContain(pem.trim());
  });
});

describe('deriveOwnerPublicKeyFromFile', () => {
  async function makeKey(name = 'owner-key.pem'): Promise<{ keyPath: string; publicBase64: string; privatePem: string }> {
    const keyPath = join(root, name);
    const result = await generateOwnerKeyFile({ outPath: keyPath });
    if (!result.ok) {
      throw new Error(`expected success, got ${result.code}`);
    }
    const privatePem = readFileSync(keyPath, 'utf8');
    return { keyPath, publicBase64: result.publicKey, privatePem };
  }

  it('derives the exact same public key that init printed', async () => {
    const { keyPath, publicBase64 } = await makeKey();
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result).toEqual({ ok: true, publicKey: publicBase64 });
  });

  it('refuses a symlinked key file (O_NOFOLLOW)', async () => {
    const { keyPath } = await makeKey();
    const linkPath = join(root, 'key-link.pem');
    symlinkSync(keyPath, linkPath);
    const result = await deriveOwnerPublicKeyFromFile({ keyPath: linkPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('symlink-refused');
    }
  });

  it('refuses a file with mode 0644', async () => {
    const { keyPath } = await makeKey('open.pem');
    chmodSync(keyPath, 0o644);
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-key-permissions');
    }
  });

  it('refuses a file owned by another uid', async () => {
    const { keyPath } = await makeKey('foreign.pem');
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(12345);
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsafe-key-owner');
    }
  });

  it('refuses a missing key file', async () => {
    const result = await deriveOwnerPublicKeyFromFile({ keyPath: join(root, 'absent.pem') });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unreadable-key');
    }
  });

  it('refuses an oversized key file', async () => {
    const keyPath = join(root, 'huge.pem');
    writeFileSync(keyPath, 'x'.repeat(20000), { mode: 0o600 });
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unreadable-key');
    }
  });

  it('refuses a non-Ed25519 private key', async () => {
    const keyPath = join(root, 'not-ed25519.pem');
    writeFileSync(keyPath, 'not a pem at all\n', { mode: 0o600 });
    const result = await deriveOwnerPublicKeyFromFile({ keyPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-key');
    }
  });

  it('refuses an empty or invalid key path', async () => {
    expect(await deriveOwnerPublicKeyFromFile({ keyPath: '' })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
    expect(await deriveOwnerPublicKeyFromFile({ keyPath: '/a\0b' })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
    expect(await deriveOwnerPublicKeyFromFile({ keyPath: `/${'x'.repeat(5000)}` })).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
  });
});

describe('signing round trip', () => {
  it('a signature made with the generated private key verifies with the printed public key', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const generated = await generateOwnerKeyFile({ outPath: keyPath });
    if (!generated.ok) {
      throw new Error(`expected success, got ${generated.code}`);
    }
    const { createPrivateKey } = await import('node:crypto');
    const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
    const fields = {
      requestId: 'req-1',
      projectId: 'proj-1',
      actionScope: 'forge:tests:run',
      expectedHeadSha: 'a'.repeat(40),
      decisionRevision: null,
      grantId: null,
      state: 'requested',
    };
    const signature = sign(null, canonicalDecisionBytes(fields), privateKey).toString('base64');
    expect(verifyDecisionSignature(fields, signature, generated.publicKey)).toBe(true);
    // A different public key never verifies the same signature.
    expect(verifyDecisionSignature(fields, signature, Buffer.alloc(32, 1).toString('base64'))).toBe(false);
  });

  it('the private key PEM never appears in any adapter result or error', async () => {
    const keyPath = join(root, 'owner-key.pem');
    const generated = await generateOwnerKeyFile({ outPath: keyPath });
    const refused = await generateOwnerKeyFile({ outPath: keyPath });
    const derived = await deriveOwnerPublicKeyFromFile({ keyPath: join(root, 'absent.pem') });
    const pem = readFileSync(keyPath, 'utf8');
    for (const result of [generated, refused, derived]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(pem.trim());
    }
  });
});
